import { LitElement, html, nothing } from "lit";
import type { TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import { normalizeConfig } from "./config";
import type { CardConfig, NormalizedConfig } from "./config";
import { buildCameraRegistry, frigateSignature } from "./core/cameras";
import type { CameraRegistry } from "./core/cameras";
import { detectCapabilities, hasSource, providerStatus } from "./core/capabilities";
import type { Capabilities } from "./core/capabilities";
import { CATEGORY_COLORS, iconFor } from "./core/categories";
import { findEvent, parseReelParam } from "./core/deeplink";
import { cameraOptions, capList, itemEvents, summarize, visibleRows } from "./core/filters";
import type { FilterState } from "./core/filters";
import { groupTimeline } from "./core/grouping";
import type { BurstSegment, TimelineItem } from "./core/grouping";
import { Loader } from "./core/loader";
import { MediaResolver } from "./core/media";
import { AI_PROVIDERS, mergeEvents } from "./core/merge";
import { nearestItem, stripModel, timeAt } from "./core/strip";
import {
  bandAt,
  bandCounts,
  contextBands,
  historyTransitions,
  inAnyBand,
  mergeTransitions,
} from "./core/context";
import type { ContextBand, Transition } from "./core/context";
import { highestThreat, withFlagged } from "./core/threat";
import {
  browserTimeZone,
  computeRange,
  dayKey,
  dayRange,
  formatDay,
  formatDuration,
  formatTime,
  hourStart,
  shiftDay,
} from "./core/time";
import type { TimeFormatOptions } from "./core/time";
import type { Category } from "./types";
import type { HomeAssistant } from "./ha-types";
import { getLocalize, objectLabel, resolveLanguage } from "./i18n";
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
import "./editor";
import "./ui/player";
import "./ui/preview";
import "./ui/strip";

export type { CardConfig as EventReelCardConfig };

type ProviderType = "entity" | "llmvision" | "event_reel" | "frigate";

/** Overridable clock (epoch seconds), for the dev harness. */
export const clock = { now: () => Date.now() / 1000 };

/** Id of an event's detail region (ids live in the card's shadow root). */
const detailId = (id: string) => `detail-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;

const hasMedia = (e: ReelEvent) =>
  !!(e.camera || e.cameraLabel || e.preview?.length || e.thumbnail?.length || e.clip);

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
  ]);

/** The README's configuration section, linked from the empty state when no source is set up. */
const SETUP_URL = "https://github.com/oddhus/event-reel-card#configuration";

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

  /**
   * History of the context entities over the range, with the state at its start, so a band
   * that was already on starts at the left edge. Bands are decoration: a failure keeps the
   * previous ones and only logs.
   */
  private async _fetchContext(range: TimeRange, now: number) {
    const hass = this._hass;
    // Two bands may watch one entity (an alarm panel's away and night states).
    const entities = [...new Set(this._config?.context.map((c) => c.entity) ?? [])];
    const token = ++this._contextToken;
    if (!hass || !entities.length) {
      this._context = new Map();
      return;
    }
    try {
      const history = await hass.callWS<Record<string, { s: string; lu: number; lc?: number }[]>>({
        type: "history/history_during_period",
        start_time: new Date(range.start * 1000).toISOString(),
        end_time: new Date(Math.min(range.end, now) * 1000).toISOString(),
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

  /** A context entity changed: move the band's edge now rather than on the next refresh. */
  private _liveContext(prev: HomeAssistant, hass: HomeAssistant) {
    if (this._day || !this._config?.context.length) return;
    let changed = false;
    const next = new Map(this._context);
    for (const entity of new Set(this._config.context.map((c) => c.entity))) {
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

  private _time(epoch: number) {
    return formatTime(epoch, this._timeOpts());
  }

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

  private _metaParts(e: ReelEvent): string[] {
    const t = this._localize;
    const parts: string[] = [];
    const cam = this._cameraName(e);
    if (cam) parts.push(cam);
    if (e.end !== undefined && e.end > e.start && (e.camera || e.frigate)) {
      parts.push(formatDuration(e.end - e.start, t));
    } else if (e.frigate && e.end === undefined) {
      parts.push(t("meta.ongoing"));
    }
    if (e.people?.length) parts.push(e.people.join(", "));
    if (e.actor) parts.push(t("meta.by", { actor: e.actor }));
    return parts;
  }

  private _media(e: ReelEvent, icon: string) {
    if (!hasMedia(e) || this._config?.preview === "off") {
      return html`<span class="slot"
        ><span class="disc" style="--c:${CATEGORY_COLORS[e.category]}"
          ><ha-icon .icon=${icon}></ha-icon></span
      ></span>`;
    }
    return html`<span class="slot"
      ><event-reel-preview
        class="thumb"
        .resolver=${this._resolver}
        .thumbnail=${e.thumbnail}
        .preview=${e.preview}
        .mode=${this._config?.preview ?? "visible"}
        .icon=${icon}
      ></event-reel-preview
    ></span>`;
  }

  private _eventRow(
    e: ReelEvent,
    opts: {
      time?: number;
      badge?: string;
      meta?: string[];
      groupId?: string;
      threat?: 1 | 2;
      /** Start times of a group's events, for its band edge. */
      times?: number[];
    } = {},
  ) {
    const t = this._localize;
    const open = !opts.groupId && this._openId === e.id;
    const icon = iconFor(e);
    const threat = opts.threat ?? e.threat;
    // Before the title on wide rows, at the start of the camera/duration line on narrow ones
    // (CSS), so the title stays readable.
    const threatBadge = threat
      ? html`<span class="badge threat-${threat}">${t(`threat.${threat}`)}</span>`
      : nothing;
    const meta = (opts.meta ?? this._metaParts(e)).join(" · ");
    const comfortable = this._config?.density === "comfortable";
    const onClick = opts.groupId
      ? () => this._toggleGroup(opts.groupId!)
      : () => this._toggle(e.id);
    const expanded = opts.groupId ? this._openGroups.has(opts.groupId) : open;
    const band = this._bandMark(opts.times ?? [e.start]);
    return html`
      <button
        class="row ${hasMedia(e) ? "camera" : "plain"} ${this._highlight === e.id && !opts.groupId ? "hl" : ""} ${band.cls}"
        style=${band.style}
        data-id=${opts.groupId ?? e.id}
        aria-expanded=${expanded ? "true" : "false"}
        aria-controls=${open ? detailId(e.id) : nothing}
        @click=${onClick}
      >
        <span class="time">${this._time(opts.time ?? e.start)}</span>
        ${this._media(e, icon)}
        <span class="main">
          <span class="title"
            >${opts.badge ? html`<span class="badge">${opts.badge}</span>` : nothing}${threatBadge}${e.title}${
              e.stateLabel
                ? html`<span class="state">${e.title ? " · " : ""}${e.stateLabel}</span>`
                : nothing
            }</span
          >
          ${comfortable && e.description ? html`<span class="desc">${e.description}</span>` : nothing}
          ${meta || threat ? html`<span class="sub">${threatBadge}${meta}</span>` : nothing}
          ${band.text}
        </span>
        <span class="meta">${meta}</span>
        ${
          e.frigate && e.reviewed === false
            ? html`<span
                class="dot"
                role="img"
                title=${t("meta.unreviewed")}
                aria-label=${t("meta.unreviewed")}
              ></span>`
            : html`<span class="dot-space"></span>`
        }
      </button>
      ${open ? this._detail(e) : nothing}
    `;
  }

  private _detail(e: ReelEvent) {
    const t = this._localize;
    const player = e.frigate || e.clip;
    const override = e.camera ? this._config?.cameras[e.camera]?.clip : undefined;
    const labels = (e.labels ?? []).map((l) => objectLabel(t, l));
    // "AI + Frigate" when AI text was joined to another provider's media.
    const media = e.sources.filter((s) => !AI_PROVIDERS.includes(s));
    const fromAi = media.length < e.sources.length;
    const chips = [
      ...labels,
      ...(fromAi && media.length
        ? [`${t("sources.ai")} + ${media.map((s) => t(`provider.${s}`)).join(" + ")}`]
        : []),
    ];
    return html`
      <div class="detail" id=${detailId(e.id)}>
        ${
          player
            ? html`<event-reel-player
                .resolver=${this._resolver}
                .localize=${t}
                .now=${clock.now}
                .event=${e}
                .padding=${this._config?.frigate.clip_padding ?? [10, 20]}
                .clipMode=${override ?? "auto"}
              ></event-reel-player>`
            : e.thumbnail?.length
              ? html`<event-reel-preview
                  class="still"
                  .resolver=${this._resolver}
                  .thumbnail=${e.thumbnail}
                  mode="still"
                ></event-reel-preview>`
              : nothing
        }
        ${e.description && e.description !== e.title ? html`<p class="desc">${e.description}</p>` : nothing}
        ${
          e.extra?.length
            ? html`<div class="extra">
                <div class="label">${t("detail.more_ai")}</div>
                ${e.extra.map(
                  (x) =>
                    html`<p>
                      <span class="time">${this._time(x.start)}</span> <strong>${x.title}</strong>${
                        x.description ? html` – ${x.description}` : nothing
                      }
                    </p>`,
                )}
              </div>`
            : nothing
        }
        ${
          e.concerns?.length
            ? html`<div class="chips concerns">
                <span class="label">${t("detail.concerns")}:</span>
                ${e.concerns.map((c) => html`<span class="chip">${c}</span>`)}
              </div>`
            : nothing
        }
        ${chips.length ? html`<div class="chips">${chips.map((c) => html`<span class="chip">${c}</span>`)}</div>` : nothing}
        <div class="actions">
          ${
            e.camera
              ? html`<button @click=${() => this._moreInfo(e.camera!)}>
                  ${t("detail.open_camera")}
                </button>`
              : e.entityId
                ? html`<button @click=${() => this._moreInfo(e.entityId!)}>
                    ${t("detail.open_entity")}
                  </button>`
                : nothing
          }
          ${
            e.frigate && e.reviewed === false
              ? html`<button @click=${() => this._markReviewed([e])}>
                  ${t("action.mark_reviewed")}
                </button>`
              : nothing
          }
          <span class="spacer"></span>
          <button @click=${() => this._toggle(e.id)}>${t("detail.close")}</button>
        </div>
      </div>
    `;
  }

  private _segmentsText(segments: BurstSegment[]): string {
    return segments
      .map(
        (s) =>
          (s.name ? `${s.name}: ` : "") +
          s.steps.map((st) => (st.count > 1 ? `${st.label} ×${st.count}` : st.label)).join(" · "),
      )
      .join("; ");
  }

  private _item(item: TimelineItem): TemplateResult {
    const t = this._localize;
    if (item.kind === "event") {
      return html`<div
        class="item ${this._highlight === item.id ? "highlight" : ""}"
        role="listitem"
      >
        ${this._eventRow(item.event)}
      </div>`;
    }

    if (item.kind === "burst") {
      const first = item.events[0];
      const last = item.events[item.events.length - 1];
      const open = this._openGroups.has(item.id);
      const icon = iconFor(last);
      const burstBand = this._bandMark(item.events.map((x) => x.start));
      return html`<div
        class="item ${this._highlight === item.id ? "highlight" : ""}"
        role="listitem"
      >
        <button
          class="row plain ${burstBand.cls}"
          style=${burstBand.style}
          data-id=${item.id}
          aria-expanded=${open ? "true" : "false"}
          @click=${() => this._toggleGroup(item.id)}
        >
          <span class="time">${this._time(item.sortTime)}</span>
          <span class="slot"
            ><span class="disc" style="--c:${CATEGORY_COLORS[first.category]}"
              ><ha-icon .icon=${icon}></ha-icon></span
          ></span>
          <span class="main">
            <span class="title">${this._segmentsText(item.segments)}</span>
            <span class="sub">${this._time(item.start)}–${this._time(item.end)}</span>
            ${burstBand.text}
          </span>
          <span class="meta">${this._time(item.start)}–${this._time(item.end)}</span>
          <span class="dot-space"></span>
        </button>
        ${
          open
            ? html`<div class="steps">
                ${item.events.map(
                  (e) =>
                    html`<div class="step ${e.id === this._linkedEvent ? "highlight" : ""}">
                      <span class="time">${formatTime(e.start, this._timeOpts())}</span>
                      <ha-icon .icon=${iconFor(e)}></ha-icon>
                      <span>${e.title}${e.stateLabel ? ` · ${e.stateLabel}` : ""}</span>
                      ${e.actor ? html`<span class="muted">${t("meta.by", { actor: e.actor })}</span>` : nothing}
                    </div>`,
                )}
              </div>`
            : nothing
        }
      </div>`;
    }

    // Camera group: the newest event stands for the group.
    const newest = item.events[item.events.length - 1];
    const open = this._openGroups.has(item.id);
    const cam = this._cameraName(newest);
    const meta = [cam, `${this._time(item.start)}–${this._time(item.end)}`].filter(
      Boolean,
    ) as string[];
    return html`<div
      class="item group ${this._highlight === item.id ? "highlight" : ""}"
      role="listitem"
    >
      ${this._eventRow(newest, {
        time: item.sortTime,
        badge: t("group.count", { count: item.events.length }),
        threat: highestThreat(item.events),
        times: item.events.map((x) => x.start),
        meta,
        groupId: item.id,
      })}
      ${open ? this._groupChildren(item.events) : nothing}
    </div>`;
  }

  /**
   * An open camera group's events, newest first, capped like the list. The cap never hides
   * an event with a threat level, since the group row shows the highest one.
   */
  private _groupChildren(events: ReelEvent[]) {
    const newestFirst = [...events].reverse();
    const children = withFlagged(
      newestFirst,
      capList(
        newestFirst,
        this._config!.maxEvents,
        () => 1,
        (e) => this._isReached(e),
      ),
    );
    return html`<div class="children">
      ${repeat(
        // Keyed, so an open clip keeps playing when a newer event joins the group.
        children.list,
        (e) => e.id,
        (e) => html`<div class="child">${this._eventRow(e)}</div>`,
      )}
      ${children.hidden ? this._cappedNote(children.hidden) : nothing}
    </div>`;
  }

  private _cappedNote(hidden: number) {
    return html`<p class="capped" role="note">
      ${this._localize("list.capped", { count: hidden, max: this._config!.maxEvents })}
    </p>`;
  }

  private _renderList(items: TimelineItem[]) {
    const tz = this._tz();
    const opts = this._timeOpts();
    // Label days other than the one in view (today, or the day shown).
    const today = this._day ?? dayKey(clock.now(), tz);
    const entries: { key: string; tpl: TemplateResult }[] = [];
    let lastHour: number | undefined;
    let lastDay: string | undefined;
    for (const item of items) {
      const hour = hourStart(item.sortTime, tz);
      if (hour !== lastHour) {
        const day = dayKey(item.sortTime, tz);
        const showDay = day !== lastDay && (lastDay !== undefined || day !== today);
        entries.push({
          key: `sep:${hour}`,
          tpl: html`<div class="sep" role="presentation">
            ${showDay ? html`<span class="day">${formatDay(item.sortTime, opts)}</span>` : nothing}
            <span>${formatTime(hour, opts)}</span>
          </div>`,
        });
        lastHour = hour;
        lastDay = day;
      }
      entries.push({ key: item.id, tpl: this._item(item) });
    }
    return repeat(
      entries,
      (e) => e.key,
      (e) => e.tpl,
    );
  }

  private _warnings() {
    const t = this._localize;
    if (!this._errors.size) return nothing;
    return html`<div class="warnings" role="status">
      ${[...this._errors].map(
        ([type, kind]) =>
          html`<span class="warning"
            ><ha-icon icon="mdi:alert-circle-outline"></ha-icon>${t(
              kind === "missing" ? "warning.missing" : "warning.unavailable",
              { provider: t(`provider.${type}`) },
            )}</span
          >`,
      )}
    </div>`;
  }

  private _toolbar(items: TimelineItem[], filtered: TimelineItem[]) {
    const t = this._localize;
    const cfg = this._config!;
    const unreviewed = filtered
      .flatMap(itemEvents)
      .filter((e) => e.frigate?.reviewId && e.reviewed === false);
    const active = this._filter.categories;
    const counts = cfg.filters ? summarize(items) : [];
    // An active chip stays visible (at 0) so it can be switched off.
    for (const c of active) {
      if (!counts.some((x) => x.category === c)) counts.push({ category: c, count: 0 });
    }
    const cams = cfg.filters ? cameraOptions(items, (key, e) => this._cameraName(e) ?? key) : [];
    const camera = this._filter.camera;
    if (camera && !cams.some((o) => o.key === camera)) {
      cams.push({ key: camera, name: this._cameraNames.get(camera) ?? camera, count: 0 });
    }
    for (const o of cams) this._cameraNames.set(o.key, o.name);
    const showCams = cams.length > 1 || !!camera;
    const picked = this._filter.bands ?? new Set<string>();
    const bandCount = bandCounts(items, this._bands);
    // A band shows when it falls in the view, also with no rows (its color still needs a
    // name), or when it is picked, so it can be switched off.
    const bandChips = cfg.filters
      ? this._bands.filter((b) => b.intervals.length || picked.has(b.key))
      : [];
    if (!counts.length && !showCams && !unreviewed.length && !bandChips.length) return nothing;
    const markLabel = t("action.mark_all_reviewed_n", { count: unreviewed.length });
    return html`<div class="toolbar">
      <div class="chipbar" role="group" aria-label=${t("filter.label")}>
        ${bandChips.map(
          (b) =>
            html`<button
              class="fchip bandchip"
              aria-pressed=${picked.has(b.key) ? "true" : "false"}
              title=${t("filter.band", { label: b.label })}
              style="--c:${b.color}"
              @click=${() => this._toggleBand(b.key)}
            >
              <span class="swatch"></span>
              <span>${b.label}</span>
              <span class="n">${bandCount.get(b.key) ?? 0}</span>
            </button>`,
        )}
        ${counts.map(
          (c) =>
            html`<button
              class="fchip"
              aria-pressed=${active.has(c.category) ? "true" : "false"}
              style="--c:${CATEGORY_COLORS[c.category]}"
              @click=${() => this._toggleCategory(c.category)}
            >
              <ha-icon .icon=${iconFor({ category: c.category })}></ha-icon>
              <span>${t(`category.${c.category}`)}</span>
              <span class="n">${c.count}</span>
            </button>`,
        )}
      </div>
      ${
        showCams
          ? html`<select
              class="camsel"
              aria-label=${t("filter.camera")}
              .value=${live(camera ?? "")}
              @change=${(ev: Event) => this._setCamera((ev.target as HTMLSelectElement).value)}
            >
              <option value="">${t("filter.all_cameras")}</option>
              ${cams.map((o) => html`<option value=${o.key}>${o.name} (${o.count})</option>`)}
            </select>`
          : nothing
      }
      ${
        unreviewed.length
          ? html`<button
              class="markall"
              title=${markLabel}
              aria-label=${markLabel}
              @click=${() => this._markReviewed(unreviewed)}
            >
              <ha-icon icon="mdi:check-all"></ha-icon><span class="n">${unreviewed.length}</span>
            </button>`
          : nothing
      }
    </div>`;
  }

  private _strip(filtered: TimelineItem[]) {
    if (!this._config?.dayStrip || !this._range || !this._loaded) return nothing;
    const model = stripModel(filtered, this._viewRange()!, this._tz(), 6, this._bands);
    const opts = this._timeOpts();
    return html`<event-reel-strip
      .model=${model}
      .labels=${model.marks.map((m) => formatTime(m.epoch, opts))}
      .selected=${this._highlight}
      .cursor=${this._stripCursor}
      .label=${this._localize("strip.label")}
      .valueText=${this._stripValueText(filtered)}
      .live=${!this._day}
      @strip-select=${(ev: CustomEvent<{ position: number; id?: string }>) =>
        this._onStripSelect(ev, filtered)}
    ></event-reel-strip>`;
  }

  /** Without the filter chips, which name the bands, a legend says what the colors mean. */
  private _legend() {
    if (this._config?.filters) return nothing;
    const bands = this._bands.filter((b) => b.intervals.length);
    if (!bands.length) return nothing;
    return html`<div class="legend">
      ${bands.map(
        (b) => html`<span style="--c:${b.color}"><span class="swatch"></span>${b.label}</span>`,
      )}
    </div>`;
  }

  private _stripValueText(items: TimelineItem[]): string {
    const id = this._stripCursor ?? this._highlight;
    const item = items.find((i) => i.id === id);
    if (!item) return "";
    const e = itemEvents(item)[itemEvents(item).length - 1];
    return `${this._time(item.sortTime)} ${e.title}${e.stateLabel ? ` ${e.stateLabel}` : ""}`;
  }

  private _empty() {
    const t = this._localize;
    if (this._caps && !hasSource(this._config!, this._caps)) {
      return html`<div class="empty" role="status">
        <div>${t("empty.setup")}</div>
        <div class="muted">
          ${t("empty.setup_hint")}
          <a href=${SETUP_URL} target="_blank" rel="noopener">${t("empty.setup_link")}</a>
        </div>
      </div>`;
    }
    const range = this._config!.range;
    const text = this._day
      ? this._day === shiftDay(dayKey(clock.now(), this._tz()), -1)
        ? t("empty.yesterday")
        : t("empty.day")
      : range.kind === "today"
        ? t("empty.today")
        : t("empty.rolling", { hours: range.hours });
    const last = this._lastEarlier;
    const opts = this._timeOpts();
    return html`<div class="empty" role="status">
      <div>${text}</div>
      ${
        last
          ? html`<div class="muted">
              ${t("empty.last", { when: `${formatDay(last, opts)} ${formatTime(last, opts)}` })}
            </div>`
          : nothing
      }
    </div>`;
  }

  private _dayNav() {
    if (!this._config?.dayNavigation) return nothing;
    const t = this._localize;
    const tz = this._tz();
    const today = dayKey(clock.now(), tz);
    const day = this._day;
    const range = this._config.range;
    const label = !day
      ? range.kind === "today"
        ? t("nav.today")
        : t("nav.last_hours", { hours: range.hours })
      : day === shiftDay(today, -1)
        ? t("nav.yesterday")
        : formatDay(dayRange(day, tz).start, this._timeOpts());
    // The handlers read the date when clicked: the row may have been drawn before midnight.
    const now = () => dayKey(clock.now(), this._tz());
    return html`<div class="daynav" role="group" aria-label=${t("nav.label")}>
      <span class="daylabel" aria-live="polite">${label}</span>
      ${
        day
          ? html`<button class="linkish today" @click=${() => this._navTo(undefined)}>
              ${t("nav.today")}
            </button>`
          : nothing
      }
      <button
        class="navbtn prev"
        title=${t("nav.previous_day")}
        aria-label=${t("nav.previous_day")}
        @click=${() => this._navTo(shiftDay(this._day ?? now(), -1))}
      >
        <ha-icon icon="mdi:chevron-left"></ha-icon>
      </button>
      <button
        class="navbtn"
        title=${t("nav.next_day")}
        aria-label=${t("nav.next_day")}
        ?disabled=${!day}
        @click=${() => {
          if (!this._day) return;
          const next = shiftDay(this._day, 1);
          void this._navTo(next < now() ? next : undefined);
        }}
      >
        <ha-icon icon="mdi:chevron-right"></ha-icon>
      </button>
    </div>`;
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

  /** A row's band edge and its text for screen readers, by the time the row shows. */
  private _bandMark(times: number[]) {
    const band = bandAt(this._bands, times);
    return band
      ? {
          cls: "inband",
          style: `--band:${band.color}`,
          text: html`<span class="sr-only"> · ${band.label}</span>`,
        }
      : { cls: "", style: "", text: nothing };
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
        ${this._dayNav()} ${this._warnings()}
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
                ${this._toolbar(this._items, filtered)} ${this._strip(filtered)} ${this._legend()}
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
                    ${this._renderList(filtered)}
                  </div>
                  ${shown.hidden ? this._cappedNote(shown.hidden) : nothing}`
              : this._items.length
                ? html`<div class="empty">
                    <button
                      class="linkish"
                      @click=${() => (this._filter = { categories: new Set() })}
                    >
                      ${t("filter.clear")}
                    </button>
                  </div>`
                : this._empty()
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
