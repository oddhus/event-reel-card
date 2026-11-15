// Summary counts and filtering for timeline items (PLAN.md §5.1). Pure.

import type { Category, ReelEvent } from "../types";
import { attachment, eventItem, latest, mediaKey, span } from "./grouping";
import type { Attachment, TimelineItem } from "./grouping";

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

export type FilterState = {
  /** Empty = all categories. */
  categories: Set<Category>;
  /** A camera key from `mediaKey`; undefined = all. */
  camera?: string;
  /** Context band entities (§5.6); empty or undefined = no band filter. */
  bands?: Set<string>;
  /** Only Frigate reviews nobody has marked reviewed yet. */
  unreviewed?: boolean;
  /** Only events while nobody was home (§5.10). */
  nobodyHome?: boolean;
};

export type EventTest = (e: ReelEvent) => boolean;

/** A Frigate review nobody has marked reviewed. */
export const isUnreviewed: EventTest = (e) => !!e.frigate?.reviewId && e.reviewed === false;

/** The tests that are set, all of which an event must pass; undefined when none is set. */
export function allOf(...tests: (EventTest | undefined)[]): EventTest | undefined {
  const set = tests.filter((x): x is EventTest => !!x);
  if (!set.length) return undefined;
  return (e) => set.every((test) => test(e));
}

/** Rows with at least one event that passes `test`, for a chip's count. */
export const countRows = (items: TimelineItem[], test: EventTest) =>
  items.filter((item) => itemEvents(item).some(test)).length;

/** The camera an event belongs to, for the camera filter; not per-event media keys. */
export function cameraKey(e: ReelEvent): string | undefined {
  const key = mediaKey(e);
  return key && !key.startsWith("media:") ? key : undefined;
}

/** The row's own events: for a camera row, its media events, not the changes attached to it. */
export function itemEvents(item: TimelineItem): ReelEvent[] {
  return item.kind === "event" ? [item.event] : item.events;
}

/** The door, lock or other changes attached to a camera row (§5.3); empty for other rows. */
export const attachedEvents = (item: TimelineItem): ReelEvent[] => item.attached?.events ?? [];

/** Every event a row shows: its own and the attached ones. */
export const allItemEvents = (item: TimelineItem): ReelEvent[] => [
  ...itemEvents(item),
  ...attachedEvents(item),
];

/** The category an item is counted under: its newest event's. */
export function primaryCategory(item: TimelineItem): Category {
  const events = itemEvents(item);
  return events[events.length - 1].category;
}

/** The categories a row matches, the attached changes' included (Doors finds the camera row). */
export function itemCategories(item: TimelineItem): Set<Category> {
  return new Set(allItemEvents(item).map((e) => e.category));
}

export function itemCameras(item: TimelineItem): Set<string> {
  const keys = new Set<string>();
  for (const e of itemEvents(item)) {
    const key = cameraKey(e);
    if (key) keys.add(key);
  }
  return keys;
}

export type CategoryCount = {
  category: Category;
  count: number;
};

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

export type CameraOption = {
  key: string;
  name: string;
  count: number;
};

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

export type Capped<T> = {
  list: T[];
  /** Events in the entries left out. */
  hidden: number;
};

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

/** Timeline items up to `max` events; a group counts all its events, the attached ones too. */
export function capItems(
  items: TimelineItem[],
  max: number,
  keep?: (item: TimelineItem) => boolean,
): Capped<TimelineItem> {
  return capList(items, max, (item) => allItemEvents(item).length, keep);
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
      // A narrowed group keeps the attached changes that joined one of its remaining events.
      else if (events.length === 1) {
        out.push({ ...eventItem(events[0]), attached: narrowAttachment(item.attached, events) });
      } else if (events.length) {
        out.push({
          ...item,
          events,
          sortTime: latest(events),
          ...span(events),
          attached: narrowAttachment(item.attached, events),
        });
      }
    }
  }
  return out.sort((a, b) => b.sortTime - a.sortTime);
}

/** The attached changes that joined one of `events`; undefined when none did. */
function narrowAttachment(
  attached: Attachment | undefined,
  events: ReelEvent[],
): Attachment | undefined {
  if (!attached) return undefined;
  const ids = new Set(events.map((e) => e.id));
  const keep = attached.events.flatMap((e, i) =>
    ids.has(attached.anchors[i]) ? [{ e, anchor: attached.anchors[i] }] : [],
  );
  if (!keep.length) return undefined;
  return attachment(
    keep.map((k) => k.e),
    keep.map((k) => k.anchor),
  );
}

/**
 * Category and camera keep whole rows. `hit`, the per-event chips (a band, unreviewed,
 * nobody home; the card composes them with `allOf`), narrows camera groups to the events
 * that pass it; with category chips on, the same event must also be in one of those
 * categories, so a group never shows an event of another category. A burst stays whole.
 */
export function applyFilters(
  items: TimelineItem[],
  state: FilterState,
  hit?: EventTest,
): TimelineItem[] {
  if (!state.categories.size && !state.camera && !hit) return items;
  const kept = items.filter((item) => {
    if (state.categories.size) {
      const cats = itemCategories(item);
      if (![...state.categories].some((c) => cats.has(c))) return false;
    }
    if (state.camera && !itemCameras(item).has(state.camera)) return false;
    return true;
  });
  if (!hit) return kept;
  const cats = state.categories;
  // A camera row that a category chip keeps for its attached changes (Doors) narrows by the
  // per-event chips alone; otherwise the same event must pass them and be in a picked
  // category.
  const byAttachment = new Set(
    kept.filter((item) => attachedEvents(item).some((e) => cats.has(e.category))),
  );
  const out: TimelineItem[] = [];
  for (const item of kept) {
    const catOk = (e: ReelEvent) => !cats.size || byAttachment.has(item) || cats.has(e.category);
    out.push(...narrowItems([item], (e) => hit(e) && catOk(e)));
  }
  return out.sort((a, b) => b.sortTime - a.sortTime);
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
  hit?: EventTest,
): Capped<TimelineItem> {
  return capItems(applyFilters(items, state, hit), max, keep);
}
