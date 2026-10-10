// Core provider: state changes and logbook.log entries from HA's logbook (PLAN.md §2.4).
// Needs nothing but Home Assistant core.

import type { EntityConfig } from "../config";
import { categoryForEntity } from "../core/categories";
import type { HassEntity, HomeAssistant } from "../ha-types";
import type { Provider, ProviderContext, ReelEvent, TimeRange } from "../types";

export interface LogbookEntry {
  when: number | string;
  entity_id?: string;
  state?: string;
  name?: string;
  message?: string;
  context_user_id?: string;
  context_entity_id?: string;
  context_name?: string;
  context_event_type?: string;
}

/** Compressed history row (`history/history_during_period`). */
interface HistoryRow {
  s: string;
  a?: Record<string, unknown>;
  lu: number;
  lc?: number;
}

const INVALID = new Set(["unknown", "unavailable"]);

export interface EntityHelpers {
  name(entityId: string): string;
  stateLabel(entityId: string, state: string): string;
  deviceClass(entityId: string): unknown;
  /** Friendly name for a context entity (automation/script), if known. */
  contextName(entityId: string): string | undefined;
}

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
 * Fills `actor` from an attribute (e.g. a lock's `changed_by`) using history rows: the last
 * row with the same state at or shortly after the change. Pure.
 */
export function applyActors(
  events: ReelEvent[],
  history: Record<string, HistoryRow[]>,
  attributeFor: (entityId: string) => string | undefined,
): void {
  for (const e of events) {
    const attr = e.entityId && attributeFor(e.entityId);
    if (!attr || !e.state) continue;
    // `lu` covers both the state change and attribute-only updates that may follow it.
    let value: unknown;
    for (const row of history[e.entityId!] ?? []) {
      if (row.lu < e.start - 2) continue;
      if (row.lu > e.start + 5) break;
      const v = row.a?.[attr];
      if (row.s === e.state && v != null && v !== "") value = v;
    }
    if (value != null) e.actor = String(value);
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

const iso = (epoch: number) => new Date(epoch * 1000).toISOString();

export const entityProvider: Provider = {
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

    const withActor = configs.filter((c) => c.actor_attribute).map((c) => c.entity);
    if (withActor.length && events.some((e) => e.entityId && withActor.includes(e.entityId))) {
      try {
        const history = await ctx.hass.callWS<Record<string, HistoryRow[]>>({
          type: "history/history_during_period",
          start_time: iso(range.start),
          end_time: iso(range.end),
          entity_ids: withActor,
          minimal_response: false,
          no_attributes: false,
          significant_changes_only: false,
        });
        const attrs = new Map(configs.map((c) => [c.entity, c.actor_attribute]));
        applyActors(events, history, (id) => attrs.get(id));
      } catch (err) {
        console.debug("[event-reel] actor history unavailable", err);
      }
    }
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
};

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
