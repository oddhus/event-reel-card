// LLM Vision provider (custom integration, optional). Uses the documented
// `llmvision.get_events` service. See PLAN.md §2.1.

import { categoryFromLabel } from "../core/categories";
import { isNestToken } from "../core/cameras";
import type { CameraRegistry } from "../core/cameras";
import { keyFrameRef, nestMedia } from "../core/media";
import { formatLocalDateTime, isoToEpoch } from "../core/time";
import type { HomeAssistant } from "../ha-types";
import type { Category, MediaRef, Provider, ProviderContext, ReelEvent, TimeRange } from "../types";
import { NestTokenResolver } from "./nest";

export interface LlmVisionEvent {
  uid: string;
  title?: string;
  description?: string;
  start: string;
  end?: string;
  key_frame?: string;
  camera_name?: string;
  category?: string;
  label?: string;
}

export interface LlmVisionMapContext {
  cameras: CameraRegistry;
  /** Nest token → device id. */
  nestDevices: Map<string, string>;
  nonCamera: boolean;
  friendlyName(entityId: string): string | undefined;
}

const category = (e: LlmVisionEvent): Category | undefined =>
  categoryFromLabel(e.category) ?? categoryFromLabel(e.label);

export function llmvisionToEvents(raw: LlmVisionEvent[], ctx: LlmVisionMapContext): ReelEvent[] {
  const out: ReelEvent[] = [];
  for (const e of raw) {
    const start = isoToEpoch(e.start);
    if (!e.uid || !Number.isFinite(start)) continue;
    const keyFrame = keyFrameRef(e.key_frame);
    const base: ReelEvent = {
      id: `llmvision:${e.uid}`,
      provider: "llmvision",
      sources: ["llmvision"],
      start,
      title: e.title || "",
      description: e.description || undefined,
      category: category(e) ?? "custom",
      thumbnail: keyFrame ? [keyFrame] : undefined,
      raw: e,
    };
    const cameraName = e.camera_name ?? "";

    if (!cameraName) {
      if (ctx.nonCamera) out.push(base);
      continue;
    }

    if (isNestToken(cameraName)) {
      const deviceId = ctx.nestDevices.get(cameraName);
      const media = deviceId ? nestMedia(deviceId, cameraName) : undefined;
      const thumbnail: MediaRef[] = [];
      if (media) thumbnail.push(media.thumbnail);
      if (keyFrame) thumbnail.push(keyFrame);
      out.push({
        ...base,
        category: category(e) ?? "doorbell",
        camera: deviceId ? ctx.cameras.byDevice(deviceId, "nest") : undefined,
        clip: media?.clip,
        thumbnail: thumbnail.length ? thumbnail : undefined,
      });
      continue;
    }

    const camera = ctx.cameras.resolve(cameraName);
    out.push({
      ...base,
      category: category(e) ?? "motion",
      camera,
      cameraLabel: camera ? undefined : (ctx.friendlyName(cameraName) ?? cameraName),
    });
  }
  return out;
}

interface ServiceResponse {
  response?: { events?: LlmVisionEvent[] };
}

/**
 * Milliseconds the events wait for the Nest lookup. A slower lookup must not hold back every
 * AI event: doorbell rows show without their clip until the lookup answers (`subscribe`).
 */
const NEST_WAIT = 3000;

export function createLlmVisionProvider(nest = new NestTokenResolver()): Provider {
  return {
    type: "llmvision",

    async fetch(range: TimeRange, ctx: ProviderContext): Promise<ReelEvent[]> {
      const cfg = ctx.config.llmvision;
      const tz = ctx.hass.config.time_zone;
      const serviceData: Record<string, unknown> = {
        start: formatLocalDateTime(range.start, tz),
        end: formatLocalDateTime(range.end, tz),
        // More than max_events, since the cap applies after the card's filters, and more still
        // when non-camera events are dropped below.
        limit: cfg.non_camera
          ? Math.max(ctx.config.maxEvents * 2, 500)
          : Math.max(ctx.config.maxEvents * 5, 1000),
        include_no_activity: false,
      };
      if (cfg.categories.length) serviceData.categories = cfg.categories;
      const res = await ctx.hass.callWS<ServiceResponse>({
        type: "call_service",
        domain: "llmvision",
        service: "get_events",
        service_data: serviceData,
        return_response: true,
      });
      const raw = (res.response?.events ?? []).filter((e) => {
        const t = isoToEpoch(e.start);
        return t >= range.start && t <= range.end;
      });

      const tokens = raw.map((e) => e.camera_name ?? "").filter(isNestToken);
      const nestDevices =
        tokens.length && ctx.config.nest.enabled
          ? await nest.resolve(ctx.hass, tokens, NEST_WAIT)
          : new Map<string, string>();

      return llmvisionToEvents(raw, {
        cameras: ctx.cameras,
        nestDevices,
        nonCamera: cfg.non_camera,
        friendlyName: (id) => ctx.hass.states[id]?.attributes.friendly_name,
      });
    },

    // A Nest lookup that answered after the events were returned: fetch again for the clips.
    subscribe: (_ctx, onChange) => nest.onLateAnswer(onChange),
  };
}

/** True when the timeline calendar entity changed in a way that means new events. */
export function timelineChanged(prev: HomeAssistant, next: HomeAssistant): boolean {
  const a = prev.states["calendar.llm_vision_timeline"];
  const b = next.states["calendar.llm_vision_timeline"];
  return !!a && !!b && a !== b && a.last_updated !== b.last_updated;
}

/** Start time of the newest LLM Vision event before `before`, for the empty state. */
export async function latestLlmVisionBefore(
  hass: HomeAssistant,
  before: number,
  nonCamera: boolean,
): Promise<number | undefined> {
  const res = await hass.callWS<ServiceResponse>({
    type: "call_service",
    domain: "llmvision",
    service: "get_events",
    service_data: {
      start: formatLocalDateTime(before - 30 * 86400, hass.config.time_zone),
      end: formatLocalDateTime(before, hass.config.time_zone),
      limit: 50,
      include_no_activity: false,
    },
    return_response: true,
  });
  const starts = (res.response?.events ?? [])
    .filter((e) => nonCamera || e.camera_name)
    .map((e) => isoToEpoch(e.start))
    .filter((t) => Number.isFinite(t) && t < before);
  return starts.length ? Math.max(...starts) : undefined;
}
