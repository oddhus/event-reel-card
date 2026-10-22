// Summary counts and filtering for timeline items (PLAN.md §5.1). Pure.

import type { Category, ReelEvent } from "../types";
import { mediaKey } from "./grouping";
import type { TimelineItem } from "./grouping";
import { queryTerms, searchItems } from "./search";

/** Display order of category chips. */
export const CATEGORY_ORDER: Category[] = [
  "person",
  "doorbell",
  "vehicle",
  "animal",
  "package",
  "motion",
  "door",
  "lock",
  "presence",
  "alarm",
  "calendar",
  "custom",
];

export interface FilterState {
  /** Empty = all categories. */
  categories: Set<Category>;
  /** A camera key from `mediaKey`; undefined = all. */
  camera?: string;
  /** Free text; every word must match (`searchItems`). Empty or undefined = no search. */
  query?: string;
}

/** The searchable text of an event, from the card (it knows camera names and labels). */
export type TextOf = (e: ReelEvent) => string;

/** The camera an event belongs to, for the camera filter; not per-event media keys. */
export function cameraKey(e: ReelEvent): string | undefined {
  const key = mediaKey(e);
  return key && !key.startsWith("media:") ? key : undefined;
}

export function itemEvents(item: TimelineItem): ReelEvent[] {
  return item.kind === "event" ? [item.event] : item.events;
}

/** The category an item is counted under: its newest event's. */
export function primaryCategory(item: TimelineItem): Category {
  const events = itemEvents(item);
  return events[events.length - 1].category;
}

export function itemCategories(item: TimelineItem): Set<Category> {
  return new Set(itemEvents(item).map((e) => e.category));
}

export function itemCameras(item: TimelineItem): Set<string> {
  const keys = new Set<string>();
  for (const e of itemEvents(item)) {
    const key = cameraKey(e);
    if (key) keys.add(key);
  }
  return keys;
}

export interface CategoryCount {
  category: Category;
  count: number;
}

/** Rows containing each category (a lock + door burst counts for both), in display order. */
export function summarize(items: TimelineItem[]): CategoryCount[] {
  const counts = new Map<Category, number>();
  for (const item of items) {
    for (const c of itemCategories(item)) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return CATEGORY_ORDER.filter((c) => counts.has(c)).map((c) => ({
    category: c,
    count: counts.get(c)!,
  }));
}

export interface CameraOption {
  key: string;
  name: string;
  count: number;
}

export function cameraOptions(
  items: TimelineItem[],
  nameFor: (key: string, sample: ReelEvent) => string,
): CameraOption[] {
  const options = new Map<string, CameraOption>();
  for (const item of items) {
    for (const e of itemEvents(item)) {
      const key = cameraKey(e);
      if (!key) continue;
      const o = options.get(key) ?? { key, name: nameFor(key, e), count: 0 };
      o.count += 1;
      options.set(key, o);
    }
  }
  return [...options.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface Capped<T> {
  list: T[];
  /** Events in the entries left out. */
  hidden: number;
}

/**
 * The first entries (newest first) holding at most `max` events, where `size` counts the
 * events of an entry. An entry across the limit is kept whole, and the list reaches as far
 * as the last entry `keep` matches (an open or linked row).
 */
export function capList<T>(
  list: T[],
  max: number,
  size: (entry: T) => number,
  keep?: (entry: T) => boolean,
): Capped<T> {
  let cut = list.length;
  let count = 0;
  for (let i = 0; i < list.length; i++) {
    if (count >= max) {
      cut = i;
      break;
    }
    count += size(list[i]);
  }
  if (keep) {
    for (let i = list.length - 1; i >= cut; i--) {
      if (keep(list[i])) {
        cut = i + 1;
        break;
      }
    }
  }
  if (cut === list.length) return { list, hidden: 0 };
  return {
    list: list.slice(0, cut),
    hidden: list.slice(cut).reduce((n, entry) => n + size(entry), 0),
  };
}

/** Timeline items up to `max` events; a group counts all its events. */
export function capItems(
  items: TimelineItem[],
  max: number,
  keep?: (item: TimelineItem) => boolean,
): Capped<TimelineItem> {
  return capList(items, max, (item) => itemEvents(item).length, keep);
}

/** The events a query may match under the active chips: any event without chips. */
export function searchAccept(state: FilterState): (e: ReelEvent) => boolean {
  const cats = state.categories;
  return cats.size ? (e) => cats.has(e.category) : () => true;
}

export function applyFilters(
  items: TimelineItem[],
  state: FilterState,
  textOf?: TextOf,
): TimelineItem[] {
  const terms = textOf ? queryTerms(state.query) : [];
  if (!state.categories.size && !state.camera && !terms.length) return items;
  const kept = items.filter((item) => {
    if (state.categories.size) {
      const cats = itemCategories(item);
      if (![...state.categories].some((c) => cats.has(c))) return false;
    }
    if (state.camera && !itemCameras(item).has(state.camera)) return false;
    return true;
  });
  return textOf ? searchItems(kept, terms, textOf, searchAccept(state)) : kept;
}

/**
 * The rows the list shows: filtered first, then capped at `max` events, so a filter finds
 * older matches among the fetched events (`max_events`, §5.1).
 */
export function visibleRows(
  items: TimelineItem[],
  state: FilterState,
  max: number,
  keep?: (item: TimelineItem) => boolean,
  textOf?: TextOf,
): Capped<TimelineItem> {
  return capItems(applyFilters(items, state, textOf), max, keep);
}
