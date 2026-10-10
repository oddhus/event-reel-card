// Summary counts and filtering for timeline items (PLAN.md §5.1). Pure.

import type { Category, ReelEvent } from "../types";
import { mediaKey } from "./grouping";
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

export function applyFilters(items: TimelineItem[], state: FilterState): TimelineItem[] {
  if (!state.categories.size && !state.camera) return items;
  return items.filter((item) => {
    if (state.categories.size) {
      const cats = itemCategories(item);
      if (![...state.categories].some((c) => cats.has(c))) return false;
    }
    if (state.camera && !itemCameras(item).has(state.camera)) return false;
    return true;
  });
}
