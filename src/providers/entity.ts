// Core provider: state changes and logbook.log entries from HA's logbook (PLAN.md §2.4).
// Needs nothing but Home Assistant core.

import type { EntityConfig } from "../config";
import { categoryForEntity } from "../core/categories";
import type { HassEntity, HomeAssistant } from "../ha-types";
import type { Provider, ProviderContext, ReelEvent, TimeRange } from "../types";

export type LogbookEntry = {
  when: number | string;
  entity_id?: string;
  state?: string;
  name?: string;
  message?: string;
  context_user_id?: string;
  context_entity_id?: string;
  context_name?: string;
  context_event_type?: string;
};

/** Compressed history row (`history/history_during_period`). */
type HistoryRow = {
  s: string;
  a?: Record<string, unknown>;
  lu: number;
  lc?: number;
};

const INVALID = new Set(["unknown", "unavailable"]);

export type EntityHelpers = {
  name(entityId: string): string;
  stateLabel(entityId: string, state: string): string;
  deviceClass(entityId: string): unknown;
  /** Friendly name for a context entity (automation/script), if known. */
  contextName(entityId: string): string | undefined;
};

const toEpoch = (when: number | string) =>
  typeof when === "number" ? when : Date.parse(when) / 1000;

export function eventId(entityId: string, when: number): string {
  return `entity:${entityId}:${when.toFixed(3)}`;
}

function baseEvent(
  cfg: EntityConfig,
  entityId: string,
  when: number,
  helpers: EntityHelpers,
): Omit<ReelEvent, "title"> {
  return {
    id: eventId(entityId, when),
    provider: "entity",
    sources: ["entity"],
    start: when,
    category: cfg.category ?? categoryForEntity(entityId, helpers.deviceClass(entityId)),
    icon: cfg.icon,
    entityId,
  };
}

/** Converts logbook entries to events. Pure. Entries may arrive in any order. */
export function logbookToEvents(
  entries: LogbookEntry[],
  configs: EntityConfig[],
  helpers: EntityHelpers,
): ReelEvent[] {
  const byId = new Map(configs.map((c) => [c.entity, c]));
  const sorted = [...entries]
    .filter((e) => e.entity_id && byId.has(e.entity_id))
    .sort((a, b) => toEpoch(a.when) - toEpoch(b.when));

  const lastState = new Map<string, string>();
  const out: ReelEvent[] = [];

  for (const entry of sorted) {
    const entityId = entry.entity_id!;
    const cfg = byId.get(entityId)!;
    const when = toEpoch(entry.when);
    if (!Number.isFinite(when)) continue;
    const name = cfg.name ?? helpers.name(entityId);

    if (entry.message !== undefined && entry.state === undefined) {
      // A logbook.log entry.
      out.push({
        ...baseEvent(cfg, entityId, when, helpers),
        title: entry.name || name,
        stateLabel: entry.message,
      });
      continue;
    }

    const state = entry.state;
    if (state === undefined) continue;
    const previous = lastState.get(entityId);
    lastState.set(entityId, state);
    if (INVALID.has(state) || (previous !== undefined && INVALID.has(previous))) continue;
    if (previous === state) continue;
    if (cfg.only_states && !cfg.only_states.includes(state)) continue;

    const actor =
      (entry.context_entity_id && helpers.contextName(entry.context_entity_id)) ||
      entry.context_name ||
      undefined;

    out.push({
      ...baseEvent(cfg, entityId, when, helpers),
      title: name,
      state,
      stateLabel: cfg.states?.[state] ?? helpers.stateLabel(entityId, state),
      actor,
    });
  }
  return out;
}

/**
 * Fills `actor` from an attribute (e.g. a lock's `changed_by`) using history rows (sorted by
 * `lu`): the row of the change and the attribute-only updates that follow it, up to the next
 * state change, which someone else may have made. Pure.
 */
export function applyActors(
  events: ReelEvent[],
  history: Record<string, HistoryRow[]>,
  attributeFor: (entityId: string) => string | undefined,
): void {
  for (const e of events) {
    const attr = e.entityId && attributeFor(e.entityId);
    if (!attr || !e.state) continue;
    const rows = history[e.entityId!] ?? [];
    const near = (row: HistoryRow) => row.lu >= e.start - 2 && row.lu <= e.start + 5;
    // The row of this change: the same state, recorded closest to it. A lock that bounces
    // has earlier rows with the same state close by.
    let first = -1;
    rows.forEach((row, i) => {
      if (row.s !== e.state || !near(row)) return;
      if (first < 0 || Math.abs(row.lu - e.start) < Math.abs(rows[first].lu - e.start)) first = i;
    });
    if (first < 0) continue;
    let value: unknown;
    for (const row of rows.slice(first)) {
      if (row.s !== e.state || !near(row)) break;
      const v = row.a?.[attr];
      if (v != null && v !== "") value = v;
    }
    if (value != null) e.actor = String(value);
  }
}

const iso = (epoch: number) => new Date(epoch * 1000).toISOString();

/** Milliseconds the rows wait for the actor lookup before they show without actors. */
const ACTOR_WAIT = 3000;
/**
 * Seconds a change must be old when the history is read for the answer to be final: the
 * attribute update may reach the recorder a little after the state change.
 */
const ACTOR_SETTLE = 30;
/** Seconds after which a lookup that hasn't answered no longer holds back a new one. */
const LOOKUP_STALE = 30;

type ActorLookup = {
  since: number;
  done: Promise<void>;
  /** The caller stopped waiting: tell the listeners when it finds actors. */
  late: boolean;
};

type ActorResult = {
  actor?: string;
  /** The change was settled when the history was read, so it isn't asked for again. */
  final: boolean;
};

/**
 * Remembers each change's actor and looks up only changes without a final answer, in the
 * history around them, so a refresh doesn't fetch the whole range with attributes again. A
 * slow lookup doesn't hold back the rows for long: it keeps going and tells `onLateAnswer`
 * listeners when it finds new actors. A failed lookup is tried again on the next fetch, a
 * hanging one after LOOKUP_STALE seconds.
 */
export class ActorResolver {
  /** Keyed by attribute and event id, so a changed `actor_attribute` doesn't reuse actors. */
  private known = new Map<string, ActorResult>();
  private pending = new Map<string, ActorLookup>();
  private listeners = new Set<() => void>();

  constructor(private readonly now: () => number = () => Date.now() / 1000) {}

  onLateAnswer(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Sets `actor` on the events whose entity has an `actor_attribute`, when the attribute
   * names one. Otherwise the event keeps the actor it has (the automation, from the logbook).
   */
  async fill(
    hass: HomeAssistant,
    events: ReelEvent[],
    attributeFor: (entityId: string) => string | undefined,
    waitMs = Infinity,
  ): Promise<void> {
    const targets = events.flatMap((e) => {
      const attr = e.entityId && e.state ? attributeFor(e.entityId) : undefined;
      return attr ? [{ event: e, key: `${attr}|${e.id}` }] : [];
    });
    const keys = new Set(targets.map((t) => t.key));
    const now = this.now();
    // Forget changes that are no longer shown (a new day or range), and stop waiting for
    // lookups that are stale or no longer needed.
    for (const key of this.known.keys()) if (!keys.has(key)) this.known.delete(key);
    for (const [key, lookup] of this.pending) {
      if (!keys.has(key) || now - lookup.since >= LOOKUP_STALE) this.pending.delete(key);
    }

    const missing = targets.filter(
      (t) => !this.known.get(t.key)?.final && !this.pending.has(t.key),
    );
    if (missing.length) this.lookup(hass, missing, attributeFor);
    const lookups = [...new Set(targets.flatMap((t) => this.pending.get(t.key) ?? []))];
    if (lookups.length) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<"timeout">((resolve) => {
        if (Number.isFinite(waitMs)) timer = setTimeout(() => resolve("timeout"), waitMs);
      });
      const result = await Promise.race([Promise.all(lookups.map((l) => l.done)), waited]);
      clearTimeout(timer);
      if (result === "timeout") for (const lookup of lookups) lookup.late = true;
    }
    for (const { event, key } of targets) {
      const actor = this.known.get(key)?.actor;
      if (actor) event.actor = actor;
    }
  }

  private lookup(
    hass: HomeAssistant,
    targets: { event: ReelEvent; key: string }[],
    attributeFor: (entityId: string) => string | undefined,
  ) {
    // Copies without the logbook's actor, so only the attribute counts as an answer. The
    // events themselves may already be shown when a late answer arrives.
    const copies = targets.map((t) => ({ event: { ...t.event, actor: undefined }, key: t.key }));
    const events = copies.map((c) => c.event);
    const starts = events.map((e) => e.start);
    const lookup: ActorLookup = { since: this.now(), late: false, done: Promise.resolve() };
    lookup.done = hass
      .callWS<Record<string, HistoryRow[]>>({
        type: "history/history_during_period",
        start_time: iso(Math.min(...starts) - 2),
        end_time: iso(Math.max(...starts) + 5),
        entity_ids: [...new Set(events.map((e) => e.entityId!))],
        minimal_response: false,
        no_attributes: false,
        significant_changes_only: false,
      })
      .then((history) => {
        applyActors(events, history, attributeFor);
        let found = false;
        for (const { event, key } of copies) {
          // A newer lookup for the same change wins; an older one only fills a gap.
          if (this.pending.get(key) !== lookup && this.known.has(key)) continue;
          if (event.actor && this.known.get(key)?.actor !== event.actor) found = true;
          this.known.set(key, {
            actor: event.actor,
            final: event.start < lookup.since - ACTOR_SETTLE,
          });
        }
        if (lookup.late && found) for (const listener of this.listeners) listener();
      })
      .catch((err) => console.debug("[event-reel] actor history unavailable", err))
      .finally(() => {
        for (const { key } of copies) {
          if (this.pending.get(key) === lookup) this.pending.delete(key);
        }
      });
    for (const { key } of copies) this.pending.set(key, lookup);
  }
}

function helpersFor(hass: HomeAssistant): EntityHelpers {
  return {
    name: (id) => hass.states[id]?.attributes.friendly_name ?? id,
    stateLabel: (id, state) => {
      const stateObj = hass.states[id];
      return stateObj && hass.formatEntityState ? hass.formatEntityState(stateObj, state) : state;
    },
    deviceClass: (id) => hass.states[id]?.attributes.device_class,
    contextName: (id) => hass.states[id]?.attributes.friendly_name,
  };
}

export function createEntityProvider(actors = new ActorResolver()): Provider {
  return {
    type: "entity",

    async fetch(range: TimeRange, ctx: ProviderContext): Promise<ReelEvent[]> {
      const configs = ctx.config.entities;
      if (!configs.length) return [];
      const entityIds = configs.map((c) => c.entity);
      const entries = await ctx.hass.callWS<LogbookEntry[]>({
        type: "logbook/get_events",
        start_time: iso(range.start),
        end_time: iso(range.end),
        entity_ids: entityIds,
      });
      const events = logbookToEvents(entries, configs, helpersFor(ctx.hass));

      const attrs = new Map(configs.map((c) => [c.entity, c.actor_attribute]));
      await actors.fill(ctx.hass, events, (id) => attrs.get(id), ACTOR_WAIT);
      return events;
    },

    live(prev: HomeAssistant, next: HomeAssistant, ctx: ProviderContext): ReelEvent[] {
      const out: ReelEvent[] = [];
      const helpers = helpersFor(next);
      for (const cfg of ctx.config.entities) {
        const before: HassEntity | undefined = prev.states[cfg.entity];
        const after: HassEntity | undefined = next.states[cfg.entity];
        if (!before || !after || before.state === after.state) continue;
        if (INVALID.has(before.state) || INVALID.has(after.state)) continue;
        if (cfg.only_states && !cfg.only_states.includes(after.state)) continue;
        const when = Date.parse(after.last_changed) / 1000;
        if (!Number.isFinite(when)) continue;
        const actorAttr = cfg.actor_attribute && after.attributes[cfg.actor_attribute];
        out.push({
          ...baseEvent(cfg, cfg.entity, when, helpers),
          title: cfg.name ?? helpers.name(cfg.entity),
          state: after.state,
          stateLabel: cfg.states?.[after.state] ?? helpers.stateLabel(cfg.entity, after.state),
          actor: actorAttr ? String(actorAttr) : undefined,
        });
      }
      return out;
    },

    // An actor lookup that answered after the rows were returned: fetch again to show it.
    subscribe: (_ctx, onChange) => actors.onLateAnswer(onChange),
  };
}

/** Start time of the newest state change before `before` (last 7 days), for the empty state. */
export async function latestEntityChangeBefore(
  ctx: ProviderContext,
  before: number,
): Promise<number | undefined> {
  const configs = ctx.config.entities;
  if (!configs.length) return undefined;
  const entries = await ctx.hass.callWS<LogbookEntry[]>({
    type: "logbook/get_events",
    start_time: iso(before - 7 * 86400),
    end_time: iso(before),
    entity_ids: configs.map((c) => c.entity),
  });
  const events = logbookToEvents(entries, configs, helpersFor(ctx.hass));
  return events.length ? events[events.length - 1].start : undefined;
}
