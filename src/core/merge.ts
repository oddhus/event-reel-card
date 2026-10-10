// Links AI text events (LLM Vision) to media events (Frigate reviews) on the same camera,
// so one real-world moment becomes one row. Pure; see PLAN.md §3.5.

import type { Category, ReelEvent } from "../types";

export interface MergeOptions {
  /** Seconds a text event may precede the media start. */
  before: number;
  /** Seconds a text event may follow the media end. */
  after: number;
  now: number;
  showUnmatched: boolean;
  /** Hide unmatched media on cameras that have an AI producer, after `graceSeconds`. */
  hideUnconfirmed: boolean;
  graceSeconds?: number;
}

const isText = (e: ReelEvent) => e.provider === "llmvision" && !!e.camera;
const isMedia = (e: ReelEvent) => e.provider === "frigate";

const VAGUE: Category[] = ["motion", "custom"];

function mergeGroup(media: ReelEvent, texts: ReelEvent[]): ReelEvent {
  const [first, ...rest] = texts;
  return {
    ...media,
    sources: [...new Set([...first.sources, ...media.sources])],
    aliases: [...(media.aliases ?? []), ...texts.flatMap((t) => [t.id, ...(t.aliases ?? [])])],
    start: Math.min(media.start, first.start),
    // An AI moment just after the review ended must still be inside the clip.
    end: media.end === undefined ? undefined : Math.max(media.end, ...texts.map((t) => t.start)),
    title: first.title,
    description: first.description ?? media.description,
    extra: rest.length
      ? rest.map((t) => ({ start: t.start, title: t.title, description: t.description }))
      : undefined,
    category: VAGUE.includes(first.category) ? media.category : first.category,
    thumbnail: [...(media.thumbnail ?? []), ...texts.flatMap((t) => t.thumbnail ?? [])],
    raw: { media: media.raw, texts: texts.map((t) => t.raw) },
  };
}

export function mergeEvents(events: ReelEvent[], opts: MergeOptions): ReelEvent[] {
  const texts = events.filter(isText).sort((a, b) => a.start - b.start);
  const media = events.filter(isMedia);
  const rest = events.filter((e) => !isText(e) && !isMedia(e));

  const mediaByCamera = new Map<string, ReelEvent[]>();
  for (const m of media) {
    if (!m.camera) continue; // unmapped reviews can't match AI events, but still show below
    const list = mediaByCamera.get(m.camera) ?? [];
    list.push(m);
    mediaByCamera.set(m.camera, list);
  }

  const assigned = new Map<ReelEvent, ReelEvent[]>();
  const unmatchedTexts: ReelEvent[] = [];

  for (const t of texts) {
    let best: ReelEvent | undefined;
    let bestDistance = Infinity;
    for (const m of mediaByCamera.get(t.camera!) ?? []) {
      const end = m.end ?? opts.now;
      if (t.start < m.start - opts.before || t.start > end + opts.after) continue;
      const distance = Math.abs(t.start - m.start);
      if (distance < bestDistance) {
        best = m;
        bestDistance = distance;
      }
    }
    if (best) {
      const list = assigned.get(best) ?? [];
      list.push(t);
      assigned.set(best, list);
    } else {
      unmatchedTexts.push(t);
    }
  }

  const aiCameras = new Set(texts.map((t) => t.camera!));
  const grace = opts.graceSeconds ?? 180;
  const out: ReelEvent[] = [...rest, ...unmatchedTexts];

  for (const m of media) {
    const group = assigned.get(m);
    if (group) {
      out.push(mergeGroup(m, group));
      continue;
    }
    if (!opts.showUnmatched) continue;
    if (
      opts.hideUnconfirmed &&
      !!m.camera &&
      aiCameras.has(m.camera) &&
      (m.end ?? opts.now) < opts.now - grace
    ) {
      continue;
    }
    out.push(m);
  }

  return out;
}
