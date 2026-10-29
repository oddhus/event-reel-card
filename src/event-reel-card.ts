import { LitElement, html, nothing } from "lit";
import { normalizeConfig } from "./config";
import type { CardConfig, NormalizedConfig } from "./config";
import { buildCameraRegistry, frigateSignature } from "./core/cameras";
import type { CameraRegistry } from "./core/cameras";
import { detectCapabilities, providerStatus } from "./core/capabilities";
import type { Capabilities } from "./core/capabilities";
import { findEvent, parseReelParam } from "./core/deeplink";
import { itemEvents, visibleRows } from "./core/filters";
import type { FilterState } from "./core/filters";
import { groupTimeline } from "./core/grouping";
import type { TimelineItem } from "./core/grouping";
import { Loader } from "./core/loader";
import { MediaResolver } from "./core/media";
import { mergeEvents } from "./core/merge";
import { nearestItem, timeAt } from "./core/strip";
import { contextBands, historyTransitions, inAnyBand, mergeTransitions } from "./core/context";
import type { ContextBand, Transition } from "./core/context";
import {
  PRESENCE_GRACE,
  computePresence,
  pastDayTakesLive,
  presenceEntities,
  presenceFetchStart,
} from "./core/presence";
import type { Presence } from "./core/presence";
import { browserTimeZone, computeRange, dayKey, dayRange, shiftDay } from "./core/time";
import type { TimeFormatOptions } from "./core/time";
import type { Category } from "./types";
import type { HomeAssistant } from "./ha-types";
import { getLocalize, resolveLanguage } from "./i18n";
import { createEntityProvider, latestEntityChangeBefore } from "./providers/entity";
import { createEventReelProvider, latestEventReelBefore } from "./providers/eventreel";
import { frigateProvider, latestReviewBefore, markReviewed } from "./providers/frigate";
import {
  createLlmVisionProvider,
  latestLlmVisionBefore,
  timelineChanged,
} from "./providers/llmvision";
import { styles } from "./styles";
import type { Localize, Provider, ProviderContext, ReelEvent, TimeRange } from "./types";
import { cappedNote, renderEmpty, renderList } from "./ui/list";
import {
  renderDayNav,
  renderLegend,
  renderStrip,
  renderToolbar,
  renderWarnings,
} from "./ui/toolbar";
import type { CardView } from "./ui/view";
import "./editor";
import "./ui/player";
import "./ui/preview";
import "./ui/strip";

export type { CardConfig as EventReelCardConfig };

type ProviderType = "entity" | "llmvision" | "event_reel" | "frigate";

/** Overridable clock (epoch seconds), for the dev harness. */
export const clock = { now: () => Date.now() / 1000 };

/** The options that change what is fetched; everything else only needs a recompute. */
const dataKey = (c: NormalizedConfig) =>
  JSON.stringify([
    c.entities,
    c.llmvision,
    c.event_reel,
    { ...c.frigate, show_unmatched: 0, hide_unconfirmed: 0, clip_padding: 0 },
    c.nest,
    c.range,
    c.cameraAliases,
    c.maxEvents,
    c.refreshInterval,
    c.language,
    c.context,
    c.presence,
  ]);

/** Seconds before a provider that hasn't answered is shown as unavailable. */
const FETCH_TIMEOUT = 20;

/** Milliseconds a new view waits for every provider before showing the ones that answered. */
const FIRST_PAINT_WAIT = 1500;

/** Seconds a deep link waits for a slow provider before the card says it wasn't found. */
const LINK_WAIT = 60;

/** Seconds a live state change is kept while waiting for the logbook to return it. */
const LIVE_GRACE = 120;

/** The same state change seen live (from hass) and from the logbook. */
const sameChange = (a: ReelEvent, b: ReelEvent) =>
  a.entityId === b.entityId && a.state === b.state && Math.abs(a.start - b.start) < 2;

export class EventReelCard extends LitElement {
  static override properties = {
    _items: { state: true },
    _openId: { state: true },
    _openGroups: { state: true },
    _errors: { state: true },
    _loaded: { state: true },
    _config: { state: true },
    _filter: { state: true },
    _highlight: { state: true },
    _notice: { state: true },
    _lastEarlier: { state: true },
    _day: { state: true },
    _partial: { state: true },
    _stripCursor: { state: true },
  };

  declare _items: TimelineItem[];
  declare _openId?: string;
  declare _openGroups: Set<string>;
  declare _errors: Map<string, "unavailable" | "missing">;
  declare _loaded: boolean;
  declare _config?: NormalizedConfig;
  declare _filter: FilterState;
  declare _highlight?: string;
  declare _notice?: string;
  /** Time of the newest event before the range, shown when the range is empty. */
  declare _lastEarlier?: number;
  /** The calendar day shown (YYYY-MM-DD); undefined shows the configured range up to now. */
  declare _day?: string;
  /** Some provider hasn't answered yet in this view. */
  declare _partial: boolean;
  /** The row last picked on the day strip; unlike the highlight, it doesn't fade. */
  declare _stripCursor?: string;

  private _hass?: HomeAssistant;
  private _cameras?: CameraRegistry;
  private _caps?: Capabilities;
  private _results = new Map<string, ReelEvent[]>();
  private _live: ReelEvent[] = [];
  private _range?: TimeRange;
  private _resolver = new MediaResolver(() => this._hass);
  private _entity = createEntityProvider();
  private _providers: Provider[] = [
    this._entity,
    createLlmVisionProvider(),
    createEventReelProvider(),
    frigateProvider,
  ];
  private _localize: Localize = getLocalize("en");
  private _language = "en";
  private _started = false;
  private _timer?: number;
  private _debounce = new Map<string, number>();
  private _unsubs: (() => void)[] = [];
  private _subscribed = new Set<string>();
  /** Last rendered object per event id, reused while the content is unchanged. */
  private _stable = new Map<string, { sig: string; event: ReelEvent }>();
  private _loader = new Loader<{ events: ReelEvent[]; range: TimeRange }>(
    {
      result: (type, { events, range }) => this._onResult(type, events, range),
      error: (type, reason) => this._onError(type, reason),
      settled: () => this._schedulePublish(),
      again: (type) => this._refresh([type]),
    },
    FETCH_TIMEOUT * 1000,
  );
  /** The current view hasn't been published yet; the previous items stay up meanwhile. */
  private _waiting = true;
  private _firstPaintDue = false;
  private _firstPaintTimer?: number;
  private _publishQueued = false;
  /** Events marked reviewed here, shown as reviewed until Frigate reports it too. */
  private _reviewed = new Set<string>();
  private _pendingLink?: string;
  /** When the pending link was read (performance.now()). */
  private _linkSince = 0;
  private _handledLink?: string;
  private _lastEarlierAt = -Infinity;
  /** State changes of the context entities in view, oldest first (§5.6). */
  private _context = new Map<string, Transition[]>();
  private _contextToken = 0;
  /** The entities of the last history fetch, which live changes are read for. */
  private _historyIds: string[] = [];
  /** Who was home over the view, from the last render (§5.10). */
  private _presence?: Presence;
  /** `frigateSignature` of the states the registry was built from. */
  private _frigateSig = "";
  /** Sources that appeared after the view started and haven't answered yet. */
  private _appearing = new Set<string>();
  /** The bands of the last render, for the rows' edges. */
  private _bands: ContextBand[] = [];
  private _highlightTimer?: number;
  private _lastStripScroll = 0;
  private _lastStripItem?: string;
  private _hadItems = false;
  private _lastEarlierToken = 0;
  /** Names of cameras seen in the camera menu, for keeping the active one listed. */
  private _cameraNames = new Map<string, string>();
  private _stickyObserver?: ResizeObserver;
  /** A burst member opened by a deep link, highlighted inside the expanded burst. */
  private _linkedEvent?: string;
  /**
   * The last row opened or linked to. The list reaches it past `max_events`, so it doesn't
   * vanish when it closes or newer events push it down; a day switch clears it.
   */
  private _reach?: string;

  constructor() {
    super();
    this._items = [];
    this._openGroups = new Set();
    this._errors = new Map();
    this._loaded = false;
    this._partial = true;
    this._filter = { categories: new Set() };
  }

  // ----- HA card API -----

  setConfig(config: CardConfig): void {
    const prev = this._config;
    const next = normalizeConfig(config);
    this._config = next;
    this._updateLanguage();
    if (!next.filters) this._filter = { categories: new Set() };
    // Band keys are positions in `context`; picked ones mean something else after a change.
    else if (prev && JSON.stringify(prev.context) !== JSON.stringify(next.context)) {
      this._filter = { ...this._filter, bands: undefined };
    }
    const leaveDay = !next.dayNavigation && this._day !== undefined;
    if (leaveDay) this._setDay(undefined);
    if (!this._started) return;
    // The editor calls this on every keystroke; only refetch when the data would differ.
    if (prev && !leaveDay && dataKey(prev) === dataKey(next)) {
      this._recompute();
      this.requestUpdate();
      return;
    }
    this._stop();
    this._results.clear();
    this._live = [];
    this._maybeStart();
  }

  set hass(hass: HomeAssistant) {
    const prev = this._hass;
    this._hass = hass;
    if (this._updateLanguage()) {
      this.requestUpdate();
      // Frigate titles are localized when fetched; fetch them again in the new language.
      if (this._started) this._debouncedRefresh("frigate", 0);
    }
    if (!this._config) return;
    if (!this._started) {
      this._maybeStart();
      return;
    }
    if (!prev) return;
    const frigateChanged = this._frigateCamerasChanged(prev, hass);
    if (prev.entities !== hass.entities || prev.services !== hass.services || frigateChanged) {
      // An integration may show up after the card started (a cold load, HA restarting), or
      // go away: fetch from it, or drop its rows, now rather than on the next refresh.
      const before = this._activeTypes();
      this._buildRegistry();
      const after = this._activeTypes();
      const appeared = after.filter((type) => !before.includes(type));
      const gone = before.filter((type) => !after.includes(type));
      // "Loading…" until a new source answers, rather than "No events" on an empty list.
      for (const type of appeared) this._appearing.add(type);
      for (const type of gone) this._appearing.delete(type); // skipped: no answer comes
      if (appeared.length || gone.length) this._refresh([...appeared, ...gone]);
      // Cameras added or removed while Frigate stays: fetch again, once they settle.
      if (frigateChanged && before.includes("frigate") && after.includes("frigate")) {
        this._debouncedRefresh("frigate", 2000);
      }
      // A person added or restored with `presence: true`: read their history now.
      if (this._range && this._config.presence && !this._config.presence.people.length) {
        const ids = this._historyEntities();
        if (ids.join() !== this._historyIds.join())
          void this._fetchContext(this._range, clock.now());
      }
    }

    this._liveContext(prev, hass);
    const ctx = this._ctx();
    const live = this._entity.live!(prev, hass, ctx);
    if (live.length) {
      this._live = [...this._live, ...live];
      this._recompute();
    }
    if (this._status("llmvision") === "active" && timelineChanged(prev, hass)) {
      this._debouncedRefresh("llmvision", 2000);
    }
  }

  get hass(): HomeAssistant | undefined {
    return this._hass;
  }

  getCardSize(): number {
    return 6;
  }

  getGridOptions() {
    return { columns: "full", rows: "auto", min_columns: 6 };
  }

  static getConfigElement(): HTMLElement {
    return document.createElement("event-reel-card-editor");
  }

  /** Suggests locks, door sensors and people that exist on this install. */
  static getStubConfig(hass?: HomeAssistant): Partial<CardConfig> {
    if (!hass) return {};
    const ids = Object.keys(hass.states).sort();
    const pick = (pred: (id: string) => boolean) => ids.filter(pred).slice(0, 3);
    const doorClass = (id: string) =>
      ["door", "garage_door"].includes(String(hass.states[id].attributes.device_class));
    const entities = [
      ...pick((id) => id.startsWith("lock.")),
      ...pick((id) => id.startsWith("binary_sensor.") && doorClass(id)),
      ...pick((id) => id.startsWith("person.")),
    ];
    return entities.length ? { entities } : {};
  }

  // ----- lifecycle -----

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this._onVisibility);
    window.addEventListener("location-changed", this._readDeepLink);
    window.addEventListener("hashchange", this._readDeepLink);
    window.addEventListener("popstate", this._readDeepLink);
    this._readDeepLink();
    this._maybeStart();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("visibilitychange", this._onVisibility);
    window.removeEventListener("location-changed", this._readDeepLink);
    window.removeEventListener("hashchange", this._readDeepLink);
    window.removeEventListener("popstate", this._readDeepLink);
    window.clearTimeout(this._highlightTimer);
    this._stickyObserver?.disconnect();
    this._stickyObserver = undefined;
    this._stop();
  }

  private _onVisibility = () => {
    if (document.visibilityState === "visible" && this._started) this._refresh();
  };

  private _maybeStart() {
    if (this._started || !this.isConnected || !this._hass || !this._config) return;
    this._started = true;
    this._newView();
    this._buildRegistry();
    this._ensureSubscriptions();
    this._timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      // A past day rarely changes (push updates still refresh it); re-render so its label
      // follows the date, such as "Yesterday" after midnight.
      if (this._day) this.requestUpdate();
      else this._refresh();
    }, this._config.refreshInterval * 1000);
    this._refresh();
  }

  private _stop() {
    this._started = false;
    this._loader.reset(); // answers to requests made before this are dropped
    window.clearTimeout(this._firstPaintTimer);
    window.clearInterval(this._timer);
    for (const id of this._debounce.values()) window.clearTimeout(id);
    this._debounce.clear();
    for (const u of this._unsubs) u();
    this._unsubs = [];
    this._subscribed.clear();
  }

  /** Subscribes to push updates for providers that are active now (they may appear late). */
  private _ensureSubscriptions() {
    if (!this._started) return;
    for (const p of this._providers) {
      if (!p.subscribe || this._subscribed.has(p.type)) continue;
      if (this._status(p.type as ProviderType) !== "active") continue;
      this._subscribed.add(p.type);
      this._unsubs.push(p.subscribe(this._ctx(), () => this._debouncedRefresh(p.type, 1500)));
    }
  }

  // ----- data -----

  private _updateLanguage(): boolean {
    const lang = resolveLanguage(
      this._config?.language ?? "auto",
      this._hass?.locale?.language ?? this._hass?.language,
    );
    if (lang === this._language) return false;
    this._language = lang;
    this._localize = getLocalize(lang);
    return true;
  }

  private _tz(): string {
    const server = this._hass?.config?.time_zone;
    if (this._hass?.locale?.time_zone === "local" || !server) return browserTimeZone();
    return server;
  }

  private _timeOpts(): TimeFormatOptions {
    return {
      language: this._hass?.locale?.language || this._language,
      timeZone: this._tz(),
      timeFormat: this._hass?.locale?.time_format,
    };
  }

  private _buildRegistry() {
    if (!this._hass || !this._config) return;
    this._cameras = buildCameraRegistry({
      states: this._hass.states,
      entities: this._hass.entities ?? {},
      aliases: this._config.cameraAliases,
    });
    this._caps = detectCapabilities(this._hass, this._cameras);
    this._frigateSig = frigateSignature(this._hass.states);
  }

  private _ctx(now = clock.now()): ProviderContext {
    if (!this._cameras) this._buildRegistry();
    return {
      hass: this._hass!,
      config: this._config!,
      cameras: this._cameras!,
      localize: this._localize,
      now,
    };
  }

  private _activeTypes(): ProviderType[] {
    return this._providers
      .map((p) => p.type as ProviderType)
      .filter((type) => this._status(type) === "active");
  }

  private _status(type: ProviderType) {
    if (!this._config || !this._caps) return "off" as const;
    return providerStatus(type, this._config, this._caps);
  }

  private _debouncedRefresh(type: string, ms: number) {
    window.clearTimeout(this._debounce.get(type));
    this._debounce.set(
      type,
      window.setTimeout(() => {
        this._debounce.delete(type);
        this._refresh([type]);
      }, ms),
    );
  }

  /** Starts loading every provider (or only some); each one is published as it answers. */
  private _refresh(only?: string[]): void {
    if (!this._hass || !this._config || !this._started) return;
    const now = clock.now();
    this._buildRegistry();
    const range = this._day
      ? dayRange(this._day, this._tz())
      : computeRange(this._config.range, now, this._tz());
    this._range = range;
    const ctx = this._ctx(now);
    for (const p of this._providers) {
      if (only && !only.includes(p.type)) continue;
      const type = p.type as ProviderType;
      const status = this._status(type);
      if (status === "active") {
        this._loader.load(type, async () => ({ events: await p.fetch(range, ctx), range }));
        continue;
      }
      this._results.delete(type);
      const explicit = type !== "entity" && this._config[type].explicit;
      this._setError(type, status === "missing" && explicit ? "missing" : undefined);
      this._loader.skip(type);
    }
    if (!only) void this._fetchContext(range, now);
    this._ensureSubscriptions();
  }

  /** The entities whose history the card reads: the context bands' and the people's. */
  private _historyEntities(): string[] {
    const cfg = this._config;
    if (!cfg) return [];
    // Two bands may watch one entity (an alarm panel's away and night states).
    return [
      ...new Set([
        ...cfg.context.map((c) => c.entity),
        ...(cfg.presence
          ? presenceEntities(cfg.presence, Object.keys(this._hass?.states ?? {}))
          : []),
      ]),
    ];
  }

  /**
   * History of the context and presence entities over the range, with the state at its
   * start, so a band that was already on starts at the left edge. Presence starts its grace
   * earlier (§5.10). Both are decoration: a failure keeps the previous ones and only logs.
   */
  private async _fetchContext(range: TimeRange, now: number) {
    const hass = this._hass;
    const entities = this._historyEntities();
    this._historyIds = entities;
    const token = ++this._contextToken;
    if (!hass || !entities.length) {
      this._context = new Map();
      return;
    }
    // Presence reads the grace on both sides: who just left, and who comes home just after.
    const presence = !!this._config?.presence;
    const start = presence ? presenceFetchStart(range) : range.start;
    const end = Math.min(range.end + (presence ? PRESENCE_GRACE : 0), now);
    try {
      const history = await hass.callWS<Record<string, { s: string; lu: number; lc?: number }[]>>({
        type: "history/history_during_period",
        start_time: new Date(start * 1000).toISOString(),
        end_time: new Date(end * 1000).toISOString(),
        entity_ids: entities,
        include_start_time_state: true,
        minimal_response: true,
        no_attributes: true,
        significant_changes_only: true,
      });
      if (token !== this._contextToken) return; // superseded by a newer view or refresh
      const next = new Map<string, Transition[]>();
      for (const id of entities) {
        const state = hass.states[id];
        const current = state
          ? { state: state.state, at: Date.parse(state.last_changed) / 1000 }
          : undefined;
        // Live changes newer than the answer stay until the next fetch has them.
        next.set(
          id,
          mergeTransitions(
            historyTransitions(history[id] ?? []),
            this._context.get(id) ?? [],
            current,
            range,
            !!this._day,
          ),
        );
      }
      this._context = next;
      this.requestUpdate();
    } catch (err) {
      console.debug("[event-reel] context history unavailable", err);
    }
  }

  /**
   * A context or presence entity changed: move the band's edge, or who is home, now rather
   * than on the next refresh.
   */
  private _liveContext(prev: HomeAssistant, hass: HomeAssistant) {
    if (!this._historyIds.length) return;
    // A past day takes no live changes, except presence's in the grace after its end (§5.10).
    if (
      this._day &&
      (!this._range || !pastDayTakesLive(this._range.end, clock.now(), !!this._config?.presence))
    ) {
      return;
    }
    let changed = false;
    const next = new Map(this._context);
    for (const entity of this._historyIds) {
      const before = prev.states[entity];
      const after = hass.states[entity];
      if (!after || before === after || before?.state === after.state) continue;
      const at = Date.parse(after.last_changed) / 1000;
      next.set(entity, [...(next.get(entity) ?? []), { state: after.state, at }]);
      changed = true;
    }
    if (!changed) return;
    this._context = next;
    this.requestUpdate();
  }

  /**
   * Frigate is found by its cameras' attributes, which arrive in `states` when it loads.
   * Most updates change other entities, so only changed camera states are compared, and the
   * signature is built only when one of them looks different.
   */
  private _frigateCamerasChanged(prev: HomeAssistant, hass: HomeAssistant): boolean {
    if (prev.states === hass.states) return false;
    let suspect = false;
    for (const id in hass.states) {
      if (!id.startsWith("camera.")) continue;
      const a = prev.states[id];
      const b = hass.states[id];
      if (a === b) continue;
      if (
        !a ||
        a.attributes.client_id !== b.attributes.client_id ||
        a.attributes.camera_name !== b.attributes.camera_name
      ) {
        suspect = true;
        break;
      }
    }
    if (!suspect) {
      for (const id in prev.states) {
        if (id.startsWith("camera.") && !(id in hass.states)) {
          suspect = true;
          break;
        }
      }
    }
    return suspect && frigateSignature(hass.states) !== this._frigateSig;
  }

  private _onResult(type: string, events: ReelEvent[], range: TimeRange) {
    this._appearing.delete(type);
    this._results.set(type, events);
    this._setError(type, undefined);
    // Keep live events until the logbook has them (the recorder commits with a delay).
    if (type === "entity" && !this._day) {
      this._live = this._live.filter((e) => {
        const fetched = events.find((f) => sameChange(e, f));
        // A slow actor lookup may not have answered yet: keep the actor the live row showed.
        if (fetched && !fetched.actor && e.actor) fetched.actor = e.actor;
        return e.start > range.end - LIVE_GRACE && !fetched;
      });
    }
  }

  /** A failed or slow provider keeps its last rows and gets a warning chip. */
  private _onError(type: string, reason: unknown) {
    this._appearing.delete(type);
    if (reason === "timeout") {
      console.warn(`[event-reel] ${type} did not answer within ${FETCH_TIMEOUT} s`);
    } else {
      console.warn(`[event-reel] ${type} failed`, reason);
    }
    this._setError(type, "unavailable");
  }

  private _setError(type: string, kind: "unavailable" | "missing" | undefined) {
    if (this._errors.get(type) === kind) return;
    const errors = new Map(this._errors);
    if (kind) errors.set(type, kind);
    else errors.delete(type);
    this._errors = errors;
  }

  /** Starts a new view of the data: earlier answers are dropped, and the first paint waits. */
  private _newView() {
    this._loader.reset();
    this._appearing.clear();
    this._waiting = true;
    this._partial = true;
    this._firstPaintDue = false;
    window.clearTimeout(this._firstPaintTimer);
    this._firstPaintTimer = window.setTimeout(() => {
      this._firstPaintDue = true;
      this._schedulePublish();
    }, FIRST_PAINT_WAIT);
  }

  /** Publishes once per task, so providers that answer together render once. */
  private _schedulePublish() {
    if (this._publishQueued) return;
    this._publishQueued = true;
    queueMicrotask(() => {
      this._publishQueued = false;
      this._publish();
    });
  }

  private _publish() {
    if (!this._started) return;
    const all = this._loader.settledAll(this._providers.map((p) => p.type));
    if (this._waiting) {
      // Wait briefly for every provider, so the list doesn't build up row by row.
      if (!all && !this._firstPaintDue) return;
      this._waiting = false;
      window.clearTimeout(this._firstPaintTimer);
    }
    // A source that appeared late was skipped before, so the loader counts it as settled.
    this._partial = !all || this._appearing.size > 0;
    this._loaded = true;
    this._ensureSubscriptions();
    this._recompute();
    // A pending deep link gives up once every provider has answered, or after a while (a
    // provider that timed out may still answer with the linked event).
    if (!this._loader.pending || performance.now() - this._linkSince > LINK_WAIT * 1000) {
      this._resolveDeepLink(true);
    }
  }

  /** Shows a calendar day (YYYY-MM-DD), or the configured range up to now when undefined. */
  private _showDay(day: string | undefined) {
    if (day === this._day) return;
    this._setDay(day);
    if (!this._started) return;
    this._newView();
    this._refresh();
  }

  /** Switches the day in view and clears what was shown for the previous one. */
  private _setDay(day: string | undefined) {
    this._day = day;
    this._results.clear();
    this._items = [];
    this._loaded = false;
    this._openId = undefined;
    this._openGroups = new Set();
    this._highlight = undefined;
    this._stripCursor = undefined;
    this._linkedEvent = undefined;
    this._reach = undefined;
    this._lastEarlier = undefined;
    this._hadItems = false;
    this._lastEarlierToken++; // drop a lookup made for the previous view
    this._lastEarlierAt = -Infinity;
    this._context = new Map();
    this._contextToken++; // drop a history answer for the previous view
  }

  /** Day navigation: switches the day and keeps keyboard focus in the navigation row. */
  private async _navTo(day: string | undefined) {
    this._showDay(day);
    await this.updateComplete;
    // "Today" is gone and › is disabled after returning to the live range.
    const root = this.renderRoot as ShadowRoot;
    const active = root.activeElement as HTMLButtonElement | null;
    if (!active || active.disabled) root.querySelector<HTMLElement>(".navbtn.prev")?.focus();
  }

  /** The ‹ button. It reads the date when clicked: the row may be from before midnight. */
  private _previousDay() {
    void this._navTo(shiftDay(this._day ?? dayKey(clock.now(), this._tz()), -1));
  }

  /** The › button, back to the live range after yesterday. Like ‹, it reads the date now. */
  private _nextDay() {
    if (!this._day) return;
    const next = shiftDay(this._day, 1);
    void this._navTo(next < dayKey(clock.now(), this._tz()) ? next : undefined);
  }

  private _recompute() {
    if (!this._config || !this._range || this._waiting) return;
    const byId = new Map<string, ReelEvent>();
    for (const list of this._results.values()) for (const e of list) byId.set(e.id, e);
    const fetched = this._results.get("entity") ?? [];
    for (const e of this._live) {
      if (!byId.has(e.id) && !fetched.some((f) => sameChange(e, f))) byId.set(e.id, e);
    }

    const cfg = this._config;
    const now = clock.now();
    const merged = mergeEvents([...byId.values()], {
      before: cfg.merge.before,
      after: cfg.merge.after,
      now,
      showUnmatched: cfg.frigate.show_unmatched,
      hideUnconfirmed: cfg.frigate.hide_unconfirmed,
    });
    const start = this._range.start;
    // A past day ends at midnight; the live range keeps taking live events after its end.
    const end = this._day ? this._range.end : Infinity;
    // Reviews marked here stay marked until Frigate reports them as reviewed too.
    for (const e of merged) if (e.reviewed === true) this._reviewed.delete(e.id);
    const visible = this._stabilize(
      merged
        .map((e) =>
          e.reviewed === false && this._reviewed.has(e.id) ? { ...e, reviewed: true } : e,
        )
        .filter((e) => (e.end ?? e.start) >= start && e.start < end)
        .sort((a, b) => b.start - a.start),
    );
    const items = groupTimeline(visible, { window: cfg.groupingWindow });
    this._keepOpen(visible, items);
    this._items = items;
    this._resolveDeepLink();
    if (items.length) {
      this._lastEarlier = undefined;
      this._hadItems = true;
    } else if (this._loaded && !this._partial && !this._day) {
      if (this._hadItems) this._lastEarlierAt = -Infinity; // rows just aged out: ask again
      this._hadItems = false;
      void this._findLastEarlier();
    }
  }

  /** Finds the newest event before the range, for the empty state (at most every 10 min). */
  private async _findLastEarlier() {
    const hass = this._hass;
    const range = this._range;
    if (!hass || !range || !this._config || clock.now() - this._lastEarlierAt < 600) return;
    this._lastEarlierAt = clock.now();
    const token = ++this._lastEarlierToken;
    const ctx = this._ctx();
    const tasks: Promise<number | undefined>[] = [];
    if (this._status("entity") === "active") {
      tasks.push(latestEntityChangeBefore(ctx, range.start).catch(() => undefined));
    }
    if (this._status("llmvision") === "active") {
      tasks.push(
        latestLlmVisionBefore(hass, range.start, this._config.llmvision.non_camera).catch(
          () => undefined,
        ),
      );
    }
    if (this._status("event_reel") === "active") {
      tasks.push(latestEventReelBefore(hass, range.start).catch(() => undefined));
    }
    if (this._status("frigate") === "active") {
      tasks.push(latestReviewBefore(ctx, range.start).catch(() => undefined));
    }
    const times = (await Promise.all(tasks)).filter((t): t is number => typeof t === "number");
    if (token !== this._lastEarlierToken || this._items.length || this._day) return; // superseded
    this._lastEarlier = times.length ? Math.max(...times) : undefined;
  }

  // ----- deep links -----

  private _readDeepLink = () => {
    const id = parseReelParam(window.location);
    if (!id) {
      // The link was left; the same link can be followed again later.
      this._handledLink = undefined;
      return;
    }
    if (id === this._handledLink) return;
    if (id !== this._pendingLink) this._linkSince = performance.now();
    this._pendingLink = id;
    this._notice = undefined;
    // Links point into the live range; leaving a past day loads it, then resolves the link.
    if (this._day) {
      this._showDay(undefined);
      return;
    }
    this._resolveDeepLink();
    // Not in the loaded data yet (e.g. a notification for a brand-new review): fetch now.
    if (this._pendingLink && this._loaded && this._started) this._refresh();
  };

  /** Drops `reel` from the URL so other views and later visits don't re-open it. */
  private _clearLinkFromUrl() {
    const url = new URL(window.location.href);
    let changed = url.searchParams.has("reel");
    url.searchParams.delete("reel");
    const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
    if (hash.has("reel")) {
      hash.delete("reel");
      url.hash = hash.toString();
      changed = true;
    }
    if (changed) history.replaceState(history.state, "", url.toString());
    this._handledLink = undefined;
  }

  /** Opens the linked event once it is loaded; gives up after a full refresh without it. */
  private _resolveDeepLink(final = false) {
    const id = this._pendingLink;
    if (!id || !this._loaded) return;
    const target = findEvent(this._items.flatMap(itemEvents), id);
    if (!target) {
      if (final) {
        this._pendingLink = undefined;
        this._notice = this._localize("deeplink.not_found");
        this._clearLinkFromUrl();
      }
      return;
    }
    this._pendingLink = undefined;
    this._notice = undefined;
    this._clearLinkFromUrl();
    this._filter = { categories: new Set() };
    this._reach = target.id;
    const container = this._items.find((i) => i.kind !== "event" && i.events.includes(target));
    if (container?.kind === "burst") {
      // Bursts have no detail; expand the burst and point at the step.
      this._openGroups = new Set([...this._openGroups, container.id]);
      this._linkedEvent = target.id;
      void this._scrollTo(container.id, "smooth");
      return;
    }
    this._openId = target.id;
    if (container) this._openGroups = new Set([...this._openGroups, container.id]);
    void this._scrollTo(target.id, "smooth");
  }

  /**
   * Reuses the previous object for events whose content didn't change, so open players and
   * playing previews aren't reset by every refresh.
   */
  private _stabilize(events: ReelEvent[]): ReelEvent[] {
    const next = new Map<string, { sig: string; event: ReelEvent }>();
    const out = events.map((e) => {
      const sig = JSON.stringify(e, (k, v) => (k === "raw" ? undefined : v));
      const prev = this._stable.get(e.id);
      const event = prev && prev.sig === sig ? prev.event : e;
      next.set(e.id, { sig, event });
      return event;
    });
    this._stable = next;
    return out;
  }

  /** Keeps an open detail open when its event merged into another or joined a camera group. */
  private _keepOpen(events: ReelEvent[], items: TimelineItem[]) {
    const id = this._openId;
    if (!id) return;
    const target = events.find((e) => e.id === id) ?? events.find((e) => e.aliases?.includes(id));
    if (!target) return;
    if (target.id !== id) this._openId = target.id;
    const group = items.find((i) => i.kind === "camera" && i.events.includes(target));
    if (group && !this._openGroups.has(group.id)) {
      this._openGroups = new Set([...this._openGroups, group.id]);
    }
  }

  // ----- interaction -----

  private async _scrollTo(id: string, behavior: ScrollBehavior) {
    await this.updateComplete;
    const row = this.renderRoot.querySelector<HTMLElement>(
      `button.row[data-id="${CSS.escape(id)}"]`,
    );
    if (!row) return;
    const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    row.scrollIntoView({ block: "center", behavior: reduced ? "auto" : behavior });
    this._highlight = id;
    this._stripCursor = id; // the strip's arrow keys step on from the row shown last
    window.clearTimeout(this._highlightTimer);
    this._highlightTimer = window.setTimeout(() => (this._highlight = undefined), 2000);
  }

  private _onStripSelect(
    ev: CustomEvent<{ position: number; id?: string }>,
    items: TimelineItem[],
  ) {
    if (!this._range) return;
    const item =
      (ev.detail.id && items.find((i) => i.id === ev.detail.id)) ||
      nearestItem(items, timeAt(ev.detail.position, this._viewRange()!));
    if (!item) return;
    const now = performance.now();
    const recent = now - this._lastStripScroll < 400;
    if (recent && item.id === this._lastStripItem) return;
    this._lastStripScroll = now;
    this._lastStripItem = item.id;
    void this._scrollTo(item.id, recent ? "auto" : "smooth");
  }

  private _toggleCategory(c: Category) {
    const categories = new Set(this._filter.categories);
    if (categories.has(c)) categories.delete(c);
    else categories.add(c);
    this._filter = { ...this._filter, categories };
  }

  private _setCamera(key: string) {
    this._filter = { ...this._filter, camera: key || undefined };
  }

  private async _markReviewed(events: ReelEvent[]) {
    const hass = this._hass;
    const targets = events.filter((e) => e.frigate?.reviewId && e.reviewed === false);
    if (!hass || !targets.length) return;
    for (const e of targets) this._reviewed.add(e.id);
    this._recompute();
    void this._keepFocusAfterMarking(targets.length === 1 ? targets[0].id : undefined);
    try {
      await markReviewed(
        hass,
        targets.map((e) => e.frigate!),
      );
    } catch (err) {
      console.warn("[event-reel] marking reviewed failed", err);
      for (const e of targets) this._reviewed.delete(e.id);
      this._recompute();
      this.dispatchEvent(
        new CustomEvent("hass-notification", {
          detail: { message: this._localize("action.mark_failed") },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  /** The pressed button disappears after marking; keep keyboard focus nearby. */
  private async _keepFocusAfterMarking(eventId?: string) {
    const active = this.renderRoot instanceof ShadowRoot ? this.renderRoot.activeElement : null;
    if (!active) return;
    await this.updateComplete;
    const target =
      (eventId &&
        this.renderRoot.querySelector<HTMLElement>(
          `button.row[data-id="${CSS.escape(eventId)}"]`,
        )) ||
      this.renderRoot.querySelector<HTMLElement>("button.row");
    target?.focus();
  }

  /** Whether `e` is the open row or the last one reached, also after a merge renamed it. */
  private _isReached(e: ReelEvent) {
    return [this._openId, this._reach].some(
      (id) => !!id && (e.id === id || !!e.aliases?.includes(id)),
    );
  }

  private _toggle(id: string) {
    this._openId = this._openId === id ? undefined : id;
    if (this._openId) this._reach = id;
  }

  private _toggleGroup(id: string) {
    const next = new Set(this._openGroups);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this._openGroups = next;
  }

  private _moreInfo(entityId: string) {
    this.dispatchEvent(
      new CustomEvent("hass-more-info", { detail: { entityId }, bubbles: true, composed: true }),
    );
  }

  private _onKeyDown(ev: KeyboardEvent) {
    const rows = [...this.renderRoot.querySelectorAll<HTMLElement>("button.row")];
    const index = rows.indexOf(ev.target as HTMLElement);
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      if (index < 0) return;
      const next = rows[index + (ev.key === "ArrowDown" ? 1 : -1)];
      if (next) {
        ev.preventDefault();
        next.focus();
      }
    } else if (ev.key === "Escape" && this._openId) {
      const id = this._openId;
      this._openId = undefined;
      void this.updateComplete.then(() =>
        this.renderRoot
          .querySelector<HTMLElement>(`button.row[data-id="${CSS.escape(id)}"]`)
          ?.focus(),
      );
    }
  }

  // ----- rendering -----

  private _cameraName(e: ReelEvent): string | undefined {
    if (e.camera) {
      return (
        this._config?.cameras[e.camera]?.name ??
        this._cameras?.get(e.camera)?.name ??
        this._hass?.states[e.camera]?.attributes.friendly_name ??
        e.camera
      );
    }
    return e.cameraLabel;
  }

  /** What the templates in `ui/` read for one render, and the actions their controls call. */
  private _view(): CardView {
    return {
      t: this._localize,
      config: this._config!,
      resolver: this._resolver,
      timeOpts: this._timeOpts(),
      tz: this._tz(),
      now: clock.now,
      day: this._day,
      loaded: this._loaded,
      caps: this._caps,
      errors: this._errors,
      lastEarlier: this._lastEarlier,
      bands: this._bands,
      presence: this._presence,
      filter: this._filter,
      cameraNames: this._cameraNames,
      openId: this._openId,
      openGroups: this._openGroups,
      highlight: this._highlight,
      stripCursor: this._stripCursor,
      linkedEvent: this._linkedEvent,
      viewRange: () => this._viewRange(),
      cameraName: (e) => this._cameraName(e),
      isReached: (e) => this._isReached(e),
      toggle: (id) => this._toggle(id),
      toggleGroup: (id) => this._toggleGroup(id),
      toggleCategory: (c) => this._toggleCategory(c),
      toggleBand: (key) => this._toggleBand(key),
      setCamera: (key) => this._setCamera(key),
      markReviewed: (events) => void this._markReviewed(events),
      moreInfo: (entityId) => this._moreInfo(entityId),
      stripSelect: (ev, items) => this._onStripSelect(ev, items),
      navTo: (day) => void this._navTo(day),
      previousDay: () => this._previousDay(),
      nextDay: () => this._nextDay(),
    };
  }

  /**
   * The range on screen: the live range runs on to now between refreshes, so a band or row
   * that began after the last refresh still has a place on the strip.
   */
  private _viewRange(): TimeRange | undefined {
    const range = this._range;
    if (!range || this._day) return range;
    return { start: range.start, end: Math.max(range.end, clock.now()) };
  }

  /** The context bands over the view; the live range's bands run on to now (§5.6). */
  private _computeBands(): ContextBand[] {
    const cfg = this._config;
    if (!cfg?.context.length || !this._range) return [];
    const now = clock.now();
    const range = this._viewRange()!;
    return contextBands(
      cfg.context,
      this._context,
      range,
      now,
      (id) => this._hass?.states[id]?.attributes.friendly_name ?? id,
    );
  }

  /** Who was home over the view, for the rows (§5.10); undefined when presence is off. */
  private _computePresence(): Presence | undefined {
    const cfg = this._config;
    if (!cfg?.presence || !this._range) return undefined;
    const states = this._hass?.states ?? {};
    const names = new Map(cfg.presence.people.map((p) => [p.entity, p.name]));
    // Every person of the last fetch for `presence: true`, else the configured order.
    const ids = cfg.presence.people.length
      ? [...names.keys()]
      : this._historyIds.filter((id) => id.startsWith("person.")).sort();
    const people = ids.map((id) => ({
      entity: id,
      // Without a friendly name, the object id: every full id would start with "person.".
      name: names.get(id) ?? states[id]?.attributes.friendly_name ?? id.split(".")[1],
      // Someone listed by hand counts even while their state is unknown (§5.10). An id that
      // doesn't exist (a typo, a removed person) doesn't count at all: it would switch the
      // flag off, for good or until its first recorded state.
      listed: names.has(id),
      exists: id in states,
    }));
    return computePresence(people, this._context, this._viewRange()!, clock.now());
  }

  private _toggleBand(key: string) {
    const bands = new Set(this._filter.bands);
    if (bands.has(key)) bands.delete(key);
    else bands.add(key);
    this._filter = { ...this._filter, bands };
  }

  protected override render() {
    if (!this._config) return nothing;
    const t = this._localize;
    this._bands = this._computeBands();
    this._presence = this._computePresence();
    const view = this._view();
    // A picked band the config no longer has is ignored, so it can't hide every row.
    const picked = this._bands.filter((b) => this._filter.bands?.has(b.key));
    const inBand = picked.length ? inAnyBand(picked) : undefined;
    const shown = visibleRows(
      this._items,
      this._filter,
      this._config.maxEvents,
      (item) => itemEvents(item).some((e) => this._isReached(e)),
      inBand,
    );
    const filtered = shown.list;
    // A quiet day still shows its bands: the strip, their chips (at 0) and the legend.
    const showBar =
      this._loaded && (this._items.length > 0 || this._bands.some((b) => b.intervals.length));
    return html`
      <ha-card .header=${this._config.title || undefined}>
        ${renderDayNav(view)} ${renderWarnings(view)}
        ${
          this._notice
            ? html`<div class="notice" role="status">
                <span>${this._notice}</span>
                <button
                  class="linkish"
                  aria-label=${t("detail.close")}
                  @click=${() => (this._notice = undefined)}
                >
                  ✕
                </button>
              </div>`
            : nothing
        }
        ${
          showBar
            ? html`<div class="sticky">
                ${renderToolbar(view, this._items, filtered)} ${renderStrip(view, filtered)}
                ${renderLegend(view)}
              </div>`
            : nothing
        }
        ${
          !this._loaded || (this._partial && !this._items.length)
            ? html`<div class="empty" role="status">${t("loading")}</div>`
            : filtered.length
              ? html`<div
                    class="list ${this._config.density}"
                    role="list"
                    @keydown=${(ev: KeyboardEvent) => this._onKeyDown(ev)}
                  >
                    ${renderList(view, filtered)}
                  </div>
                  ${shown.hidden ? cappedNote(view, shown.hidden) : nothing}`
              : this._items.length
                ? html`<div class="empty">
                    <button
                      class="linkish"
                      @click=${() => (this._filter = { categories: new Set() })}
                    >
                      ${t("filter.clear")}
                    </button>
                  </div>`
                : renderEmpty(view)
        }
      </ha-card>
    `;
  }

  protected override updated() {
    const sticky = this.renderRoot.querySelector<HTMLElement>(".sticky");
    if (!sticky) {
      this.style.removeProperty("--reel-sticky-height");
      return;
    }
    this._stickyObserver ??= new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height ?? 0;
      this.style.setProperty("--reel-sticky-height", `${Math.ceil(h)}px`);
    });
    this._stickyObserver.disconnect();
    this._stickyObserver.observe(sticky);
  }

  static override styles = styles;
}

if (!customElements.get("event-reel-card")) {
  customElements.define("event-reel-card", EventReelCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "event-reel-card",
    name: "Event Reel Card",
    description: "A compact timeline of the day's events with animated camera previews.",
    preview: true,
  });
  console.info(`%c EVENT-REEL-CARD %c v${__VERSION__} `, "background:#03a9f4;color:#fff", "");
}
