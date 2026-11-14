// Collapses the timeline into compact rows: bursts of state changes ("unlocked · opened ·
// closed · locked"), bounces (the same entity flipping within seconds) and runs of events on
// the same camera. Pure; see PLAN.md §5.3.

import type { ReelEvent } from "../types";

export type BurstStep = {
  label: string;
  /** Number of changes collapsed into this step (bounces). */
  count: number;
  event: ReelEvent;
};

export type BurstSegment = {
  name: string;
  entityId?: string;
  steps: BurstStep[];
};

/** Door, lock or other changes shown on a camera's row (entities with `camera:`, §5.3). */
export type Attachment = {
  /** Oldest first. */
  events: ReelEvent[];
  segments: BurstSegment[];
};

type ItemBase = {
  id: string;
  /** Latest start among the item's events; the list is sorted by this, newest first. */
  sortTime: number;
  start: number;
  end: number;
  /** On a camera row (an event with media or a camera group): the changes attached to it. */
  attached?: Attachment;
};

export type TimelineItem =
  | (ItemBase & { kind: "event"; event: ReelEvent })
  | (ItemBase & { kind: "burst"; events: ReelEvent[]; segments: BurstSegment[] })
  | (ItemBase & { kind: "camera"; camera: string; events: ReelEvent[] });

export type GroupingOptions = {
  /** Seconds between consecutive events that still belong to one group. */
  window: number;
  /** Seconds within which flips of the same entity collapse into one step. */
  bounceWindow?: number;
};

const BURST_EXCLUDED = new Set(["presence", "calendar"]);

/** Key of the camera an event shows media from, mapped or not; undefined for plain events. */
export function mediaKey(e: ReelEvent): string | undefined {
  if (e.camera) return e.camera;
  if (e.frigate) return `frigate:${e.frigate.instance}/${e.frigate.camera}`;
  if (e.cameraLabel) return `label:${e.cameraLabel}`;
  if (e.clip || e.preview?.length || e.thumbnail?.length) return `media:${e.id}`;
  return undefined;
}

/**
 * Only plain state changes go into bursts. Anything with media keeps its own row, and so does
 * an event with a description (an AI event without a camera): a burst step shows only a label.
 */
const isBurstable = (e: ReelEvent) =>
  !mediaKey(e) && !e.description && !BURST_EXCLUDED.has(e.category);

function chain(
  events: ReelEvent[],
  gap: (prev: ReelEvent, next: ReelEvent) => number,
  window: number,
) {
  const chains: ReelEvent[][] = [];
  let current: ReelEvent[] = [];
  for (const e of events) {
    const prev = current[current.length - 1];
    if (prev && gap(prev, e) <= window) current.push(e);
    else {
      if (current.length) chains.push(current);
      current = [e];
    }
  }
  if (current.length) chains.push(current);
  return chains;
}

function stepLabel(e: ReelEvent): string {
  return e.stateLabel ?? e.title;
}

/** Fewest rapid changes of one entity that count as a bounce. A quick open → close is two. */
const MIN_BOUNCE = 3;

function buildSegments(events: ReelEvent[], bounceWindow: number): BurstSegment[] {
  // Runs of consecutive changes of the same entity, each within the bounce window.
  const runs: ReelEvent[][] = [];
  for (const e of events) {
    const run = runs[runs.length - 1];
    const prev = run?.[run.length - 1];
    if (
      prev &&
      e.entityId &&
      prev.entityId === e.entityId &&
      e.start - prev.start <= bounceWindow
    ) {
      run.push(e);
    } else {
      runs.push([e]);
    }
  }

  const steps: BurstStep[] = [];
  for (const run of runs) {
    if (run.length >= MIN_BOUNCE) {
      const last = run[run.length - 1];
      steps.push({ label: stepLabel(last), count: run.length, event: last });
    } else {
      for (const e of run) steps.push({ label: stepLabel(e), count: 1, event: e });
    }
  }

  const segments: BurstSegment[] = [];
  for (const step of steps) {
    const name = step.event.stateLabel !== undefined ? step.event.title : "";
    const last = segments[segments.length - 1];
    if (last?.name === name && name !== "") last.steps.push(step);
    else segments.push({ name, entityId: step.event.entityId, steps: [step] });
  }
  return segments;
}

/** A row of its own for one event. */
export const eventItem = (e: ReelEvent): TimelineItem => ({
  kind: "event",
  id: e.id,
  event: e,
  sortTime: e.start,
  start: e.start,
  end: e.end ?? e.start,
});

export const latest = (events: ReelEvent[]) => Math.max(...events.map((e) => e.start));
export const span = (events: ReelEvent[]) => ({
  start: Math.min(...events.map((e) => e.start)),
  end: Math.max(...events.map((e) => e.end ?? e.start)),
});

export function groupTimeline(events: ReelEvent[], opts: GroupingOptions): TimelineItem[] {
  const bounceWindow = opts.bounceWindow ?? 10;
  const ascending = [...events].sort((a, b) => a.start - b.start);
  const items: TimelineItem[] = [];

  const pushBursts = (list: ReelEvent[]) => {
    for (const c of chain(list, (a, b) => b.start - a.start, opts.window)) {
      if (c.length === 1) items.push(eventItem(c[0]));
      else
        items.push({
          kind: "burst",
          id: `burst:${c[0].id}`,
          events: c,
          segments: buildSegments(c, bounceWindow),
          sortTime: latest(c),
          ...span(c),
        });
    }
  };

  // Bursts of state changes (doors, locks, …).
  pushBursts(ascending.filter(isBurstable));

  // Presence flapping groups per person, never across people.
  const presence = new Map<string, ReelEvent[]>();
  for (const e of ascending) {
    if (mediaKey(e) || e.category !== "presence") continue;
    const key = e.entityId ?? e.id;
    const list = presence.get(key) ?? [];
    list.push(e);
    presence.set(key, list);
  }
  for (const list of presence.values()) pushBursts(list);

  // Runs on the same camera (mapped or not).
  const byCamera = new Map<string, ReelEvent[]>();
  for (const e of ascending) {
    const key = mediaKey(e);
    if (!key) continue;
    const list = byCamera.get(key) ?? [];
    list.push(e);
    byCamera.set(key, list);
  }
  for (const [camera, list] of byCamera) {
    for (const c of chain(list, (a, b) => b.start - (a.end ?? a.start), opts.window)) {
      if (c.length === 1) items.push(eventItem(c[0]));
      else
        items.push({
          kind: "camera",
          id: `cam:${c[0].id}`,
          camera,
          events: c,
          sortTime: latest(c),
          ...span(c),
        });
    }
  }

  // Everything else stays a row of its own.
  for (const e of ascending) {
    if (!mediaKey(e) && !isBurstable(e) && e.category !== "presence") items.push(eventItem(e));
  }

  return attachNear(items, opts.window, bounceWindow).sort((a, b) => b.sortTime - a.sortTime);
}

/** Seconds between two spans; 0 when they overlap. */
const gapBetween = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  Math.max(0, a.start - b.end, b.start - a.end);

/** The camera key of a row with media; undefined for plain rows. */
function cameraOf(item: TimelineItem): string | undefined {
  if (item.kind === "camera") return item.camera;
  if (item.kind === "event") return mediaKey(item.event);
  return undefined;
}

/**
 * Moves bursts and single state changes onto the camera row they belong to: every event of
 * the burst names the same `nearCamera`, and a row of that camera lies within `window`
 * seconds of it (the nearest wins). A mixed burst, of two cameras or with an entity that has
 * no `camera:`, keeps a row of its own.
 */
function attachNear(items: TimelineItem[], window: number, bounceWindow: number): TimelineItem[] {
  const hosts = new Map<string, TimelineItem[]>();
  for (const item of items) {
    const key = cameraOf(item);
    if (!key) continue;
    const list = hosts.get(key) ?? [];
    list.push(item);
    hosts.set(key, list);
  }
  if (!hosts.size) return items;

  const joined = new Map<TimelineItem, ReelEvent[]>();
  const moved = new Set<TimelineItem>();
  for (const item of items) {
    if (cameraOf(item)) continue;
    const events = item.kind === "event" ? [item.event] : item.events;
    const near = events[0].nearCamera;
    if (!near || events.some((e) => e.nearCamera !== near)) continue;
    let best: TimelineItem | undefined;
    let bestGap = Infinity;
    for (const host of hosts.get(near) ?? []) {
      const gap = gapBetween(item, host);
      if (gap <= window && gap < bestGap) {
        best = host;
        bestGap = gap;
      }
    }
    if (!best) continue;
    joined.set(best, [...(joined.get(best) ?? []), ...events]);
    moved.add(item);
  }
  if (!moved.size) return items;

  return items
    .filter((item) => !moved.has(item))
    .map((item) => {
      const events = joined.get(item);
      if (!events) return item;
      const sorted = [...events].sort((a, b) => a.start - b.start);
      return {
        ...item,
        attached: { events: sorted, segments: buildSegments(sorted, bounceWindow) },
      };
    });
}
