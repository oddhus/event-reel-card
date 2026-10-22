// Summary counts and filtering for timeline items (PLAN.md §5.1). Pure.

import type { Category, ReelEvent } from "../types";
import { eventItem, latest, mediaKey, span } from "./grouping";
import type { TimelineItem } from "./grouping";

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
  /** Context band entities (§5.6); empty or undefined = no band filter. */
  bands?: Set<string>;
}

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

/**
 * The items with an event that `hit` accepts. A camera group narrows to those events, or to a
 * row of its own when one is left; a burst stays whole, since its steps read as one line.
 * Newest first.
 */
export function narrowItems(items: TimelineItem[], hit: (e: ReelEvent) => boolean): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const item of items) {
    if (item.kind === "event") {
      if (hit(item.event)) out.push(item);
    } else if (item.kind === "burst") {
      if (item.events.some(hit)) out.push(item);
    } else {
      const events = item.events.filter(hit);
      if (events.length === item.events.length) out.push(item);
      else if (events.length === 1) out.push(eventItem(events[0]));
      else if (events.length) {
        out.push({ ...item, events, sortTime: latest(events), ...span(events) });
      }
    }
  }
  return out.sort((a, b) => b.sortTime - a.sortTime);
}

/**
 * Category and camera keep whole rows. `inBand` (from the selected band chips) narrows camera
 * groups to events inside a band; with category chips on, the same event must also be in one
 * of those categories, so a group never shows an event of another category.
 */
export function applyFilters(
  items: TimelineItem[],
  state: FilterState,
  inBand?: (e: ReelEvent) => boolean,
): TimelineItem[] {
  if (!state.categories.size && !state.camera && !inBand) return items;
  const kept = items.filter((item) => {
    if (state.categories.size) {
      const cats = itemCategories(item);
      if (![...state.categories].some((c) => cats.has(c))) return false;
    }
    if (state.camera && !itemCameras(item).has(state.camera)) return false;
    return true;
  });
  if (!inBand) return kept;
  const cats = state.categories;
  return narrowItems(kept, (e) => inBand(e) && (!cats.size || cats.has(e.category)));
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
  inBand?: (e: ReelEvent) => boolean,
): Capped<TimelineItem> {
  return capItems(applyFilters(items, state, inBand), max, keep);
}
