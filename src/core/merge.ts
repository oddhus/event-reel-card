// Links AI text events (LLM Vision, Event Reel) to media events (Frigate reviews) on the same
// camera, so one real-world moment becomes one row. Pure; see PLAN.md §3.5.

import type { Category, ReelEvent } from "../types";

export type MergeOptions = {
  /** Seconds a text event may precede the media start. */
  before: number;
  /** Seconds a text event may follow the media end. */
  after: number;
  now: number;
  showUnmatched: boolean;
  /** Hide unmatched media on cameras that have an AI producer, after `graceSeconds`. */
  hideUnconfirmed: boolean;
  graceSeconds?: number;
};

/** Providers whose events are AI text about a camera moment. */
export const AI_PROVIDERS = ["llmvision", "event_reel"];

const isText = (e: ReelEvent) => AI_PROVIDERS.includes(e.provider) && !!e.camera;
const isMedia = (e: ReelEvent) => e.provider === "frigate";

const VAGUE: Category[] = ["motion", "custom"];

function mergeGroup(media: ReelEvent, texts: ReelEvent[]): ReelEvent {
  const [first, ...rest] = texts;
  // A text may already carry extra descriptions (the same clip described twice).
  const extra = [
    // A threat level comes with Frigate's own summary, which explains it: keep that text
    // when the AI text replaces it (without a description, the row falls back to it).
    ...(media.threat && media.description && first.description
      ? [{ start: media.start, title: media.title, description: media.description }]
      : []),
    ...(first.extra ?? []),
    ...rest.flatMap((t) => [
      { start: t.start, title: t.title, description: t.description },
      ...(t.extra ?? []),
    ]),
  ];
  return {
    ...media,
    sources: [...new Set([...texts.flatMap((t) => t.sources), ...media.sources])],
    aliases: [...(media.aliases ?? []), ...texts.flatMap((t) => [t.id, ...(t.aliases ?? [])])],
    start: Math.min(media.start, first.start),
    // An AI moment just after the review ended must still be inside the clip.
    end: media.end === undefined ? undefined : Math.max(media.end, ...texts.map((t) => t.start)),
    title: first.title,
    description: first.description ?? media.description,
    extra: extra.length ? extra : undefined,
    category: VAGUE.includes(first.category) ? media.category : first.category,
    thumbnail: [...(media.thumbnail ?? []), ...texts.flatMap((t) => t.thumbnail ?? [])],
    raw: { media: media.raw, texts: texts.map((t) => t.raw) },
  };
}

/**
 * Two AI producers describing the same Nest event share its clip: keep the earliest text as
 * the row and the others as extra text, so a ring described twice is still one row.
 */
function collapseSameClip(texts: ReelEvent[]): ReelEvent[] {
  const byClip = new Map<string, ReelEvent[]>();
  const out: ReelEvent[] = [];
  for (const t of texts) {
    if (!t.clip) {
      out.push(t);
      continue;
    }
    const list = byClip.get(t.clip.path);
    if (list) list.push(t);
    else {
      byClip.set(t.clip.path, [t]);
      out.push(t);
    }
  }
  return out.map((t) => {
    const same = t.clip ? (byClip.get(t.clip.path) ?? []) : [];
    if (same.length < 2) return t;
    const [first, ...rest] = same;
    return {
      ...first,
      sources: [...new Set(same.flatMap((s) => s.sources))],
      aliases: [...(first.aliases ?? []), ...rest.flatMap((r) => [r.id, ...(r.aliases ?? [])])],
      description: first.description ?? rest.find((r) => r.description)?.description,
      // A ring noticed by either producer makes it a doorbell moment.
      category: same.some((s) => s.category === "doorbell") ? "doorbell" : first.category,
      extra: [
        ...(first.extra ?? []),
        ...rest.map((r) => ({ start: r.start, title: r.title, description: r.description })),
      ],
      thumbnail: [...(first.thumbnail ?? []), ...rest.flatMap((r) => r.thumbnail ?? [])],
    };
  });
}

export function mergeEvents(events: ReelEvent[], opts: MergeOptions): ReelEvent[] {
  const texts = collapseSameClip(events.filter(isText).sort((a, b) => a.start - b.start));
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
    // A review Frigate's GenAI flagged is never hidden as unconfirmed.
    if (
      opts.hideUnconfirmed &&
      !m.threat &&
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
