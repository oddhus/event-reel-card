// Context bands: periods while an entity is in given states, such as away mode or night
// (PLAN.md §5.6). Pure.

import type { NormalizedContext } from "../config";
import type { ReelEvent, TimeRange } from "../types";
import { itemEvents } from "./filters";
import type { TimelineItem } from "./grouping";

/** A state an entity entered at a time (epoch seconds). */
export type Transition = {
  state: string;
  at: number;
};

export type Interval = {
  start: number;
  /** Exclusive; for an open interval, the time it was computed at. */
  end: number;
  /** Still in the state: it covers everything after `start`. */
  open?: boolean;
};

export type ContextBand = {
  /** The band's index in the config, as a string: two bands may watch one entity. */
  key: string;
  entity: string;
  label: string;
  /** A CSS color. */
  color: string;
  intervals: Interval[];
};

/** Off-periods shorter than this join the intervals around them (someone leaving twice). */
export const BRIDGE_GAP = 5 * 60;
/** Closed intervals shorter than this are dropped (a switch flicked by mistake). */
export const MIN_LENGTH = 60;

const INVALID = new Set(["unknown", "unavailable"]);

/** Compressed `history/history_during_period` rows: `lc` is left out when it equals `lu`. */
export function historyTransitions(rows: { s: string; lu: number; lc?: number }[]): Transition[] {
  return rows.map((r) => ({ state: r.s, at: r.lc ?? r.lu })).sort((a, b) => a.at - b.at);
}

/**
 * The fetched history of one entity, with the live changes that came after it. An entity
 * without rows (not changed for longer than the recorder keeps) gets its current state from
 * `current` when that state already held over the range: since before its end in the live
 * range, since before its start on a past day.
 */
export function mergeTransitions(
  fetched: Transition[],
  live: Transition[],
  current: Transition | undefined,
  range: TimeRange,
  past: boolean,
): Transition[] {
  const list = [...fetched];
  if (!list.length && current && current.at <= (past ? range.start : range.end)) {
    list.push(current);
  }
  const last = list[list.length - 1]?.at ?? -Infinity;
  return [...list, ...live.filter((t) => t.at > last)];
}

/**
 * The intervals within `range` while the entity was in one of `states`, oldest first.
 * `transitions` should start with the state at the start of the range. `unknown` and
 * `unavailable` keep the previous state, so an HA restart neither splits nor starts an
 * interval. Gaps under BRIDGE_GAP are bridged, and closed intervals under `minLength` that
 * don't touch the range's edges are dropped. One still in the state at `now` is open.
 */
export function contextIntervals(
  transitions: Transition[],
  states: string[],
  range: TimeRange,
  now: number,
  minLength = MIN_LENGTH,
): Interval[] {
  const end = Math.min(range.end, now);
  const raw: Interval[] = [];
  let since: number | undefined;
  for (const t of [...transitions].sort((a, b) => a.at - b.at)) {
    if (INVALID.has(t.state)) continue;
    const on = states.includes(t.state);
    if (on && since === undefined) since = t.at;
    else if (!on && since !== undefined) {
      raw.push({ start: since, end: t.at });
      since = undefined;
    }
  }
  if (since !== undefined)
    raw.push(end === now ? { start: since, end, open: true } : { start: since, end });

  const clipped = raw
    .map((i) => ({ ...i, start: Math.max(i.start, range.start), end: Math.min(i.end, end) }))
    .filter((i) => i.end > i.start || i.open);

  const joined: Interval[] = [];
  for (const i of clipped) {
    const last = joined[joined.length - 1];
    if (last && i.start - last.end < BRIDGE_GAP) {
      last.end = Math.max(last.end, i.end);
      if (i.open) last.open = true;
    } else joined.push({ ...i });
  }
  return joined.filter(
    (i) => i.open || i.start <= range.start || i.end >= end || i.end - i.start >= minLength,
  );
}

/**
 * HA's theme colors by name; `var(--<name>-color)` follows the theme, with HA's default value
 * for themes (and the dev harness) that don't define it.
 */
const NAMED: Record<string, string> = {
  red: "#f44336",
  pink: "#e91e63",
  purple: "#926bc7",
  "deep-purple": "#6e41ab",
  indigo: "#3f51b5",
  blue: "#2196f3",
  "light-blue": "#03a9f4",
  cyan: "#00bcd4",
  teal: "#009688",
  green: "#4caf50",
  "light-green": "#8bc34a",
  lime: "#cddc39",
  yellow: "#ffeb3b",
  amber: "#ffc107",
  orange: "#ff9800",
  "deep-orange": "#ff6f22",
  brown: "#795548",
  grey: "#9e9e9e",
  "blue-grey": "#607d8b",
  "light-grey": "#bdbdbd",
  "dark-grey": "#606060",
  black: "#000000",
  white: "#ffffff",
  primary: "#03a9f4",
  accent: "#ff9800",
  disabled: "#bdbdbd",
};

const DEFAULT_COLORS = ["indigo", "amber", "teal", "pink"];

const named = (key: string) => `var(--${key}-color, ${NAMED[key]})`;

/** True for a CSS color the browser accepts; outside a browser (tests), a plain-looking one. */
function isCssColor(value: string): boolean {
  // It goes into style attributes: nothing that could end the declaration.
  if (/[;{}<>"'\\]/.test(value)) return false;
  return typeof CSS !== "undefined" && typeof CSS.supports === "function"
    ? CSS.supports("color", value)
    : /^(#[0-9a-f]{3,8}|[a-z-]+\([^()]*\)|[a-z]+)$/i.test(value);
}

/**
 * The CSS color of the band at `index`: an HA color name, any valid CSS color, or the
 * default for that index (also for a value that isn't a color, rather than no color).
 */
export function bandColor(color: string | undefined, index: number): string {
  const fallback = named(DEFAULT_COLORS[index % DEFAULT_COLORS.length]);
  if (!color) return fallback;
  const value = color.trim();
  const key = value.toLowerCase().replace(/[\s_]+/g, "-");
  if (key in NAMED) return named(key);
  return isCssColor(value) ? value : fallback;
}

/** The bands of the configured entities over `range`, in config order. */
export function contextBands(
  config: NormalizedContext[],
  transitions: Map<string, Transition[]>,
  range: TimeRange,
  now: number,
  nameOf: (entity: string) => string,
): ContextBand[] {
  return config.map((c, i) => ({
    key: String(i),
    entity: c.entity,
    label: c.label ?? nameOf(c.entity),
    color: bandColor(c.color, i),
    intervals: contextIntervals(transitions.get(c.entity) ?? [], c.states, range, now),
  }));
}

export function covers(band: ContextBand, t: number): boolean {
  return band.intervals.some((i) => t >= i.start && (i.open || t < i.end));
}

/**
 * The first band (in config order) that covers t, or any of several times: a row's edge
 * takes it when one of its events is inside, as the band chips count and filter rows.
 */
export function bandAt(bands: ContextBand[], t: number | number[]): ContextBand | undefined {
  const times = Array.isArray(t) ? t : [t];
  return bands.find((b) => times.some((x) => covers(b, x)));
}

/** Rows with an event inside each band, for the band chips. */
export function bandCounts(items: TimelineItem[], bands: ContextBand[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const b of bands) {
    counts.set(
      b.key,
      items.filter((item) => itemEvents(item).some((e) => covers(b, e.start))).length,
    );
  }
  return counts;
}

/** True when an event starts inside one of these bands. */
export const inAnyBand = (bands: ContextBand[]) => (e: ReelEvent) =>
  bands.some((b) => covers(b, e.start));
