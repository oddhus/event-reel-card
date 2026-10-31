// Frigate provider (custom integration, optional): review items through the HA Frigate
// integration's websocket API. See PLAN.md §2.2.

import { categoryFromLabel } from "../core/categories";
import type { CameraRegistry } from "../core/cameras";
import { frigateMedia } from "../core/media";
import { objectLabel } from "../i18n";
import type { Localize, Provider, ProviderContext, ReelEvent, TimeRange } from "../types";

export type FrigateReviewMetadata = {
  title?: string;
  shortSummary?: string;
  scene?: string;
  /** Frigate GenAI threat level: 0 normal, 1 suspicious, 2 critical (0.17 also wrote 3). */
  potential_threat_level?: number;
  /** The user's configured "additional concerns" the model observed. */
  other_concerns?: string[] | null;
};

export type FrigateReview = {
  id: string;
  camera: string;
  start_time: number;
  end_time: number | null;
  severity: string;
  thumb_path?: string;
  has_been_reviewed?: boolean;
  data?: {
    objects?: string[];
    sub_labels?: (string | [string, number])[];
    zones?: string[];
    metadata?: FrigateReviewMetadata | null;
  };
};

/**
 * Fetches reviewed and unreviewed items separately and merges them. Frigate 0.18 returns
 * both when `reviewed` is omitted, but older versions default to unreviewed only, and
 * there is no value meaning "all" on every version.
 */
async function getReviews(
  hass: ProviderContext["hass"],
  msg: Record<string, unknown>,
): Promise<FrigateReview[]> {
  const [unreviewed, reviewed] = await Promise.all(
    [false, true].map(async (r) => parseReviews(await hass.callWS({ ...msg, reviewed: r }))),
  );
  const byId = new Map<string, FrigateReview>();
  for (const review of [...unreviewed, ...reviewed]) byId.set(review.id, review);
  return [...byId.values()].sort((a, b) => b.start_time - a.start_time);
}

/** The integration passes Frigate's body through unparsed, so results are JSON strings. */
export function parseWsResult<T>(result: unknown): T {
  return (typeof result === "string" ? JSON.parse(result) : result) as T;
}

type Fields = Record<string, unknown>;
const isObject = (v: unknown): v is Fields => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const texts = (v: unknown) =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && !!s) : undefined;
/** The threat level only when it is an integer 0–3 (Frigate 0.17 allowed 3); else dropped. */
const threatLevel = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 3 ? v : undefined;
/** Frigate's `other_concerns`: null stays null, arrays keep only non-empty strings. */
const concerns = (v: unknown): string[] | null | undefined => (v === null ? null : texts(v));

/** One review with the fields the card reads, or undefined when it lacks an id, camera or start. */
function toReview(r: unknown): FrigateReview | undefined {
  if (!isObject(r)) return undefined;
  const id = text(r.id);
  const camera = text(r.camera);
  const start = r.start_time;
  if (!id || !camera || typeof start !== "number" || !Number.isFinite(start)) return undefined;
  const end = typeof r.end_time === "number" && Number.isFinite(r.end_time) ? r.end_time : null;
  const data = isObject(r.data) ? r.data : {};
  const meta = isObject(data.metadata) ? data.metadata : undefined;
  return {
    id,
    camera,
    start_time: start,
    end_time: end,
    severity: typeof r.severity === "string" ? r.severity : "",
    thumb_path: text(r.thumb_path),
    has_been_reviewed: !!r.has_been_reviewed,
    data: {
      objects: texts(data.objects),
      sub_labels: Array.isArray(data.sub_labels)
        ? data.sub_labels.filter(
            (s): s is string | [string, number] =>
              typeof s === "string" || (Array.isArray(s) && typeof s[0] === "string"),
          )
        : undefined,
      zones: texts(data.zones),
      metadata: meta
        ? {
            title: text(meta.title),
            shortSummary: text(meta.shortSummary),
            scene: text(meta.scene),
            potential_threat_level: threatLevel(meta.potential_threat_level),
            other_concerns: concerns(meta.other_concerns),
          }
        : null,
    },
  };
}

/**
 * Reviews from a `frigate/reviews/get` result. A malformed record is skipped instead of
 * failing the whole provider; an answer that isn't a list (an error body) still fails it.
 */
export function parseReviews(result: unknown): FrigateReview[] {
  const list = parseWsResult<unknown>(result);
  if (!Array.isArray(list)) throw new Error("Frigate returned no review list");
  const reviews = list.map(toReview).filter((r): r is FrigateReview => !!r);
  if (reviews.length < list.length) {
    console.debug(`[event-reel] skipped ${list.length - reviews.length} malformed Frigate reviews`);
  }
  return reviews;
}

const cleanLabel = (label: string) => label.replace(/-verified$/, "");

export type ReviewMapContext = {
  cameras: CameraRegistry;
  localize: Localize;
};

export function reviewToEvent(
  review: FrigateReview,
  instance: string,
  ctx: ReviewMapContext,
): ReelEvent {
  const ref = { instance, camera: review.camera, reviewId: review.id };
  const key = ctx.cameras.byFrigate(instance, review.camera);
  const cameraName = (key && ctx.cameras.get(key)?.name) || review.camera;
  const labels = [...new Set((review.data?.objects ?? []).map(cleanLabel))];
  const people = (review.data?.sub_labels ?? [])
    .map((s) => (Array.isArray(s) ? s[0] : s))
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  const primary = labels.find((l) => categoryFromLabel(l)) ?? labels[0];
  const meta = review.data?.metadata ?? undefined;
  // 0.18 uses 0–2. 0.17 used 1 minor, 2 moderate, 3 high, so 2 and up is a concern.
  const level = meta?.potential_threat_level ?? 0;
  const threat = level >= 2 ? 2 : level === 1 ? 1 : undefined;
  const concerns = meta?.other_concerns?.length ? meta.other_concerns : undefined;

  const title =
    meta?.title ||
    (primary
      ? ctx.localize("title.object_at_camera", {
          object: objectLabel(ctx.localize, primary),
          camera: cameraName,
        })
      : ctx.localize("title.activity_at_camera", { camera: cameraName }));

  return {
    id: `frigate:${instance}:${review.id}`,
    provider: "frigate",
    sources: ["frigate"],
    aliases: [review.id],
    start: review.start_time,
    end: review.end_time ?? undefined,
    title,
    description: meta?.shortSummary || meta?.scene || undefined,
    category: (primary && categoryFromLabel(primary)) || "motion",
    camera: key,
    cameraLabel: key ? undefined : review.camera,
    thumbnail: [frigateMedia.reviewThumb(ref, review.thumb_path), frigateMedia.reviewThumbAlt(ref)],
    preview: [frigateMedia.reviewPreview(ref)],
    frigate: ref,
    labels,
    people: people.length ? people : undefined,
    threat,
    concerns,
    severity: review.severity === "alert" ? "alert" : "detection",
    reviewed: !!review.has_been_reviewed,
    raw: review,
  };
}

function camerasForInstance(ctx: ProviderContext, instance: string): string[] | undefined {
  const wanted = ctx.config.frigate.cameras;
  if (wanted === "auto") return undefined;
  return wanted
    .map((key) => ctx.cameras.get(ctx.cameras.resolve(key) ?? key)?.frigate)
    .filter((f): f is { instance: string; camera: string } => !!f && f.instance === instance)
    .map((f) => f.camera);
}

export const frigateProvider: Provider = {
  type: "frigate",

  async fetch(range: TimeRange, ctx: ProviderContext): Promise<ReelEvent[]> {
    const severities = new Set(ctx.config.frigate.severity);
    const results = await Promise.all(
      ctx.cameras.frigateInstances().map(async (instance) => {
        const cameras = camerasForInstance(ctx, instance);
        if (cameras && !cameras.length) return [];
        const msg: Record<string, unknown> = {
          type: "frigate/reviews/get",
          instance_id: instance,
          after: range.start,
          before: range.end,
          limit: Math.max(ctx.config.maxEvents * 2, 500),
        };
        if (cameras) msg.cameras = cameras;
        // The API takes one severity; with several, filter below.
        if (severities.size === 1) msg.severity = [...severities][0];
        const reviews = await getReviews(ctx.hass, msg);
        return reviews
          .filter((r) => severities.has(r.severity))
          .map((r) => reviewToEvent(r, instance, ctx));
      }),
    );
    return results.flat();
  },

  subscribe(ctx: ProviderContext, onChange: () => void): () => void {
    const unsubs: Promise<() => unknown>[] = ctx.cameras.frigateInstances().map((instance) =>
      ctx.hass.connection
        .subscribeMessage(() => onChange(), {
          type: "frigate/reviews/subscribe",
          instance_id: instance,
        })
        .catch((err) => {
          console.debug("[event-reel] Frigate review subscription failed", err);
          return () => undefined;
        }),
    );
    return () => {
      for (const u of unsubs) u.then((fn) => Promise.resolve(fn()).catch(() => undefined));
    };
  },
};

/** Marks reviews as viewed in Frigate (any HA user may do this). */
export async function markReviewed(
  hass: ProviderContext["hass"],
  refs: { instance: string; reviewId?: string }[],
): Promise<void> {
  const byInstance = new Map<string, string[]>();
  for (const r of refs) {
    if (!r.reviewId) continue;
    byInstance.set(r.instance, [...(byInstance.get(r.instance) ?? []), r.reviewId]);
  }
  await Promise.all(
    [...byInstance].map(async ([instance, ids]) => {
      const result = parseWsResult<{ success?: boolean; message?: string } | null>(
        await hass.callWS({
          type: "frigate/reviews/viewed",
          instance_id: instance,
          ids,
          viewed: true,
        }),
      );
      if (result?.success === false) throw new Error(result.message || "Frigate refused");
    }),
  );
}

/**
 * Start time of the newest review before `before` that the card would show (same cameras
 * and severities), for the empty state.
 */
export async function latestReviewBefore(
  ctx: ProviderContext,
  before: number,
): Promise<number | undefined> {
  const severities = new Set(ctx.config.frigate.severity);
  const starts = await Promise.all(
    ctx.cameras.frigateInstances().map(async (instance) => {
      const cameras = camerasForInstance(ctx, instance);
      if (cameras && !cameras.length) return undefined;
      // Frigate defaults `after` to 24 h ago, so give it a real window.
      const msg: Record<string, unknown> = {
        type: "frigate/reviews/get",
        instance_id: instance,
        after: before - 30 * 86400,
        before,
        limit: 20,
      };
      if (cameras) msg.cameras = cameras;
      if (severities.size === 1) msg.severity = [...severities][0];
      const reviews = await getReviews(ctx.hass, msg);
      return reviews.find((r) => severities.has(r.severity))?.start_time;
    }),
  );
  const valid = starts.filter((t): t is number => typeof t === "number");
  return valid.length ? Math.max(...valid) : undefined;
}
