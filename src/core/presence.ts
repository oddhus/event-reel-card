// Presence at event time: who was home when each row happened, and whether nobody was
// (PLAN.md §5.10). Pure.

import type { NormalizedPresence } from "../config";
import type { ReelEvent, TimeRange } from "../types";
import { contextIntervals } from "./context";
import type { Interval, Transition } from "./context";

/**
 * Seconds of "nobody home" at each end of an empty period that don't count: phones report
 * leaving and arriving late, so the door and lock around those times aren't flagged.
 */
export const PRESENCE_GRACE = 10 * 60;

const INVALID = new Set(["unknown", "unavailable"]);

export interface Person {
  entity: string;
  name: string;
  /** One or two letters, unique among the people when it can be. */
  initials: string;
}

export interface Presence {
  people: Person[];
  /** Per entity: the intervals at home. */
  home: Map<string, Interval[]>;
  /** Per entity: the time of its first known state; before it, it isn't counted as home. */
  knownFrom: Map<string, number>;
  /** When nobody was home, without the grace at either end. */
  empty: Interval[];
}

/** The range history is fetched over: the grace before the range decides its first minutes. */
export const presenceFetchStart = (range: TimeRange) => range.start - PRESENCE_GRACE;

/**
 * Whether a past day still takes live state changes at `now`: only with presence, until the
 * grace after its end, since someone coming home at 00:05 decides whether the last minutes
 * of yesterday were empty. Context bands end at the day's end and ignore later changes.
 */
export const pastDayTakesLive = (dayEnd: number, now: number, presence: boolean) =>
  presence && now < dayEnd + PRESENCE_GRACE;

/** The people to watch: the configured ones, or every `person` entity for `presence: true`. */
export function presenceEntities(config: NormalizedPresence, stateIds: string[]): string[] {
  if (config.people.length) return config.people.map((p) => p.entity);
  return stateIds.filter((id) => id.startsWith("person.")).sort();
}

const letters = (s: string) => Array.from(s.trim());

/**
 * Short labels for names, unique when the names allow it. Each name has labels from short
 * to long: the first letter; the first and last word's first letters (one word: its first
 * two letters); then one letter more. Names whose labels clash move on to their next one
 * until none clash or they run out.
 */
export function initialsFor(names: string[]): string[] {
  const upper = (s: string) => s.toLocaleUpperCase() || "?";
  const options = names.map((n) => {
    const words = n.trim().split(/\s+/).filter(Boolean);
    const w0 = letters(words[0] ?? "");
    const last = letters(words[words.length - 1] ?? "");
    const list =
      words.length > 1
        ? [w0[0] ?? "", (w0[0] ?? "") + (last[0] ?? ""), (w0[0] ?? "") + last.slice(0, 2).join("")]
        : [w0.slice(0, 1).join(""), w0.slice(0, 2).join(""), w0.slice(0, 3).join("")];
    return list.map(upper);
  });
  const level = names.map(() => 0);
  const label = (i: number) => options[i][level[i]];
  for (;;) {
    const labels = names.map((_, i) => label(i));
    const bump = names
      .map((_, i) => i)
      .filter(
        (i) =>
          labels.some((l, j) => j !== i && l === labels[i]) && level[i] < options[i].length - 1,
      );
    if (!bump.length) return labels;
    for (const i of bump) level[i]++;
  }
}

/**
 * Presence over `range` from each person's state changes, which should start with the state
 * at `presenceFetchStart(range)` and run to `PRESENCE_GRACE` past its end when that has
 * passed. `home` is the state at home (device trackers and persons both use it).
 * `unknown` and `unavailable` keep the previous state, and short trips under five minutes
 * are bridged (as for context bands), so a phone that drops off the network for a moment
 * doesn't empty the house; a short visit home still counts. A person without any known
 * state is left out, unless `listed`: then they may be home all along, and the house is
 * never counted as empty. An entity that doesn't exist (`exists: false`, a typo or a removed
 * person) is left out whatever its history says.
 */
export function computePresence(
  people: { entity: string; name: string; listed?: boolean; exists?: boolean }[],
  transitions: Map<string, Transition[]>,
  range: TimeRange,
  now: number,
): Presence {
  // The grace past the range's end decides its last minutes, as before its start.
  const ext = { start: presenceFetchStart(range), end: range.end + PRESENCE_GRACE };
  const end = Math.min(ext.end, now);
  const known = people.filter(
    (p) =>
      p.exists !== false &&
      (p.listed || (transitions.get(p.entity) ?? []).some((t) => !INVALID.has(t.state))),
  );
  const initials = initialsFor(known.map((p) => p.name));
  const home = new Map<string, Interval[]>();
  const knownFrom = new Map<string, number>();
  // Periods someone was (or may have been) home: before a person's first known state counts.
  const busy: Interval[] = [];
  for (const p of known) {
    const list = transitions.get(p.entity) ?? [];
    // Infinity for a listed person with no known state: never home, never away.
    const from = Math.min(...list.filter((t) => !INVALID.has(t.state)).map((t) => t.at));
    knownFrom.set(p.entity, from);
    const intervals = contextIntervals(list, ["home"], ext, now, 0);
    home.set(p.entity, intervals);
    busy.push(...intervals);
    if (from > ext.start) busy.push({ start: ext.start, end: from });
  }

  const empty: Interval[] = [];
  if (known.length) {
    let cursor = ext.start;
    let covered = false;
    for (const i of busy.sort((a, b) => a.start - b.start)) {
      if (i.start > cursor) empty.push({ start: cursor, end: Math.min(i.start, end) });
      if (i.open) {
        covered = true;
        break;
      }
      cursor = Math.max(cursor, i.end);
    }
    if (!covered && cursor < end) {
      empty.push(end === now ? { start: cursor, end, open: true } : { start: cursor, end });
    }
  }

  return {
    people: known.map((p, i) => ({ ...p, initials: initials[i] })),
    home,
    knownFrom,
    empty: empty
      .filter((i) => i.end > i.start || i.open)
      .map((i) => ({
        ...i,
        // Nobody home since before the fetched range, or still nobody home now: no departure
        // or arrival there to allow for. Nobody home through the grace after a past range's
        // end shrinks to that end.
        start: i.start <= ext.start ? i.start : i.start + PRESENCE_GRACE,
        end: i.open ? i.end : i.end - PRESENCE_GRACE,
      }))
      .filter((i) => i.end > i.start || i.open),
  };
}

const inside = (i: Interval, t: number) => t >= i.start && (!!i.open || t < i.end);

/** The people home at `t`, in config order; one whose state isn't known yet is left out. */
export function homeAt(p: Presence, t: number): Person[] {
  return p.people.filter(
    (person) =>
      t >= p.knownFrom.get(person.entity)! &&
      (p.home.get(person.entity) ?? []).some((i) => inside(i, t)),
  );
}

/**
 * True when nobody was home at the event's start, past the grace at both ends of the empty
 * period. Presence events aren't flagged: someone leaving is what empties the house, and a
 * person shown by another tracker than the one watched, or by an AI source, is the same
 * coming and going.
 */
export function whileNobodyHome(p: Presence, e: ReelEvent): boolean {
  if (!p.people.length) return false;
  if (e.category === "presence") return false;
  if (e.entityId && p.people.some((person) => person.entity === e.entityId)) return false;
  return p.empty.some((i) => inside(i, e.start));
}

/** The people home at any of the events' starts (a group's row), in config order. */
export function homeDuring(p: Presence, events: ReelEvent[]): Person[] {
  const ids = new Set(events.flatMap((e) => homeAt(p, e.start).map((x) => x.entity)));
  return p.people.filter((x) => ids.has(x.entity));
}
