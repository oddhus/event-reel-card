// Event Reel integration (custom integration, optional): AI descriptions of camera events.
// Reads its websocket API (`event_reel/events/list`, `event_reel/events/subscribe`).
// See PLAN.md §2.6.

import { categoryFromLabel } from "../core/categories";
import { nestMedia } from "../core/media";
import { isoToEpoch } from "../core/time";
import { objectLabel } from "../i18n";
import type { HomeAssistant } from "../ha-types";
import type { Localize, MediaRef, Provider, ProviderContext, ReelEvent, TimeRange } from "../types";
import type { CameraRegistry } from "../core/cameras";

/** One event as the integration stores it. */
export interface EventReelRecord {
  id: string;
  start: string;
  end?: string | null;
  camera?: string | null;
  title?: string;
  description?: string | null;
  category?: string;
  labels?: string[];
  key_frame?: string | null;
  source?: string;
  /** `video: false` for a Nest camera that sent only a picture (no clip). */
  nest?: { device_id?: string; event_token?: string; video?: boolean } | null;
  analysis?: string;
}

export interface EventReelMapContext {
  cameras: CameraRegistry;
  /** Whether Nest clips may be attached (the card's `nest` toggle). */
  nest: boolean;
  localize: Localize;
  friendlyName(entityId: string): string | undefined;
}

/** A key frame or image: a media-source id resolves to a signed URL, a path is signed. */
function imageRef(path: string | null | undefined): MediaRef | undefined {
  if (!path) return undefined;
  if (path.startsWith("media-source://")) return { kind: "image", path, resolve: true };
  return { kind: "image", path };
}

export function eventReelToEvents(raw: EventReelRecord[], ctx: EventReelMapContext): ReelEvent[] {
  const out: ReelEvent[] = [];
  for (const e of raw) {
    const start = isoToEpoch(e.start);
    if (!e.id || !Number.isFinite(start)) continue;
    const endEpoch = e.end ? isoToEpoch(e.end) : NaN;
    const camera = e.camera ? ctx.cameras.resolve(e.camera) : undefined;
    const cameraName =
      (camera && ctx.cameras.get(camera)?.name) ||
      (e.camera ? (ctx.friendlyName(e.camera) ?? e.camera) : undefined);
    const category = categoryFromLabel(e.category) ?? "custom";

    const nest =
      ctx.nest && e.nest?.device_id && e.nest.event_token
        ? nestMedia(e.nest.device_id, e.nest.event_token)
        : undefined;
    // A camera without clips: its Nest media is a picture, not something to play.
    const clip = e.nest?.video === false ? undefined : nest?.clip;
    const keyFrame = imageRef(e.key_frame);
    const thumbnail = [nest?.thumbnail, keyFrame].filter((m): m is MediaRef => !!m);

    // Without AI text (the AI didn't answer) the row still says what and where.
    const subject = e.labels?.find((l) => categoryFromLabel(l)) ?? category;
    const where = cameraName ?? "";
    const title =
      e.title ||
      (category === "doorbell"
        ? ctx.localize("title.rang_at_camera", { camera: where })
        : ctx.localize("title.object_at_camera", {
            object: objectLabel(ctx.localize, subject),
            camera: where,
          }));

    out.push({
      id: `event_reel:${e.id}`,
      provider: "event_reel",
      sources: ["event_reel"],
      aliases: [e.id],
      start,
      end: Number.isFinite(endEpoch) ? endEpoch : undefined,
      title,
      description: e.description || undefined,
      category,
      camera,
      cameraLabel: camera ? undefined : cameraName,
      thumbnail: thumbnail.length ? thumbnail : undefined,
      clip,
      labels: e.labels?.length ? [...e.labels] : undefined,
      raw: e,
    });
  }
  return out;
}

interface ListResult {
  events?: EventReelRecord[];
}

const isoOf = (epoch: number) => new Date(epoch * 1000).toISOString();

/** The most events the integration returns in one list. */
const MAX_LIMIT = 5000;

/** The integration's services can outlive it (removed, or failed to load). */
const isNotLoaded = (err: unknown) =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === "not_loaded";

export function createEventReelProvider(): Provider {
  return {
    type: "event_reel",

    async fetch(range: TimeRange, ctx: ProviderContext): Promise<ReelEvent[]> {
      let res: ListResult;
      try {
        res = await ctx.hass.callWS<ListResult>({
          type: "event_reel/events/list",
          start_time: isoOf(range.start),
          end_time: isoOf(range.end),
          limit: Math.min(MAX_LIMIT, Math.max(100, Math.round(ctx.config.maxEvents))),
        });
      } catch (err) {
        // Skipped quietly unless the user asked for Event Reel.
        if (isNotLoaded(err) && !ctx.config.event_reel.explicit) return [];
        throw err;
      }
      return eventReelToEvents(res.events ?? [], {
        cameras: ctx.cameras,
        nest: ctx.config.nest.enabled,
        localize: ctx.localize,
        friendlyName: (id) => ctx.hass.states[id]?.attributes.friendly_name,
      });
    },

    subscribe(ctx: ProviderContext, onChange: () => void): () => void {
      const unsub = ctx.hass.connection
        .subscribeMessage(() => onChange(), { type: "event_reel/events/subscribe" })
        .catch((err) => {
          console.debug("[event-reel] Event Reel subscription failed", err);
          return () => undefined;
        });
      return () => {
        unsub.then((fn) => Promise.resolve(fn()).catch(() => undefined));
      };
    },
  };
}

/** Start time of the newest Event Reel event before `before`, for the empty state. */
export async function latestEventReelBefore(
  hass: HomeAssistant,
  before: number,
): Promise<number | undefined> {
  const res = await hass.callWS<ListResult>({
    type: "event_reel/events/list",
    end_time: isoOf(before),
    limit: 1,
  });
  const start = res.events?.[0] ? isoToEpoch(res.events[0].start) : NaN;
  return Number.isFinite(start) && start < before ? start : undefined;
}
