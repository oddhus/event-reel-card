// Model for the day strip: ticks per row, an hourly activity histogram and hour labels over
// the visible range (PLAN.md §5.1). Pure.

import type { Category, TimeRange } from "../types";
import type { ContextBand } from "./context";
import { itemEvents, primaryCategory } from "./filters";
import type { TimelineItem } from "./grouping";
import { hourStart, zonedParts } from "./time";

export type StripTick = {
  id: string;
  /** 0..1 across the range. */
  pos: number;
  category: Category;
};

export type StripModel = {
  ticks: StripTick[];
  /** Event counts per bucket, oldest first. */
  buckets: number[];
  /** Hour marks to label, with position 0..1. */
  marks: { pos: number; epoch: number }[];
  /** Context band spans (§5.6); `lane` is the band's index, for its edge at the top. */
  bands: StripBand[];
};

export type StripBand = {
  lane: number;
  /** 0..1 across the range. */
  pos: number;
  width: number;
  color: string;
};

const clamp = (x: number) => Math.min(1, Math.max(0, x));

export function stripModel(
  items: TimelineItem[],
  range: TimeRange,
  timeZone: string,
  markEveryHours = 6,
  contextBands: ContextBand[] = [],
): StripModel {
  const span = Math.max(1, range.end - range.start);
  const pos = (t: number) => clamp((t - range.start) / span);

  const ticks = items.map((item) => ({
    id: item.id,
    pos: pos(item.sortTime),
    category: primaryCategory(item),
  }));

  const bucketCount = Math.max(1, Math.min(48, Math.round(span / 3600)));
  const buckets = new Array<number>(bucketCount).fill(0);
  for (const item of items) {
    for (const e of itemEvents(item)) {
      const i = Math.min(bucketCount - 1, Math.floor(pos(e.start) * bucketCount));
      buckets[i] += 1;
    }
  }

  // Label local hours divisible by markEveryHours (00, 06, 12, 18 by default). Step by half
  // hours so zones with 30-minute offsets or DST shifts still hit the local hour boundaries.
  const marks: { pos: number; epoch: number }[] = [];
  for (let t = hourStart(range.start, timeZone) + 1800; t < range.end; t += 1800) {
    const p = zonedParts(t, timeZone);
    if (p.minute === 0 && p.hour % markEveryHours === 0) marks.push({ pos: pos(t), epoch: t });
  }

  const bands = contextBands
    .flatMap((b, lane) =>
      b.intervals.map((i) => ({
        lane,
        pos: pos(i.start),
        // An open band runs to the end of the range (now, in the live range).
        width: (i.open ? 1 : pos(i.end)) - pos(i.start),
        color: b.color,
      })),
    )
    .filter((b) => b.width > 0);

  return { ticks, buckets, marks, bands };
}

/** Time at a horizontal position (0..1). */
export function timeAt(position: number, range: TimeRange): number {
  return range.start + clamp(position) * (range.end - range.start);
}

/** The item whose time is nearest to t. */
export function nearestItem(items: TimelineItem[], t: number): TimelineItem | undefined {
  let best: TimelineItem | undefined;
  let bestD = Infinity;
  for (const item of items) {
    const d = t < item.start ? item.start - t : t > item.sortTime ? t - item.sortTime : 0;
    if (d < bestD) {
      best = item;
      bestD = d;
    }
  }
  return best;
}
