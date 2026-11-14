// Nest (core integration). Which Nest device an event token belongs to, through HA media
// source, so LLM Vision doorbell events can play their clip; and, opt-in, the Nest cameras'
// own events as rows, from the history of their `event.*` entities (PLAN.md §2.3).

import { nestMedia } from "../core/media";
import type { HassDevice, HassEntity, HomeAssistant } from "../ha-types";
import type { Category, Localize, Provider, ProviderContext, ReelEvent, TimeRange } from "../types";

type BrowseNode = {
  media_content_id: string;
  title?: string;
  children?: BrowseNode[];
};

const ROOT = "media-source://nest";
/** Minimum seconds between two browses. */
const REFRESH_AFTER = 30;
/** A token still missing after a browse (e.g. an expired event) is retried this rarely. */
const RETRY_UNKNOWN_AFTER = 600;
/** Seconds after which a browse that hasn't answered no longer holds back a new one. */
const BROWSE_STALE = 60;

/** Last path segment of a media-source id, e.g. the token of `media-source://nest/{device}/{token}`. */
const lastSegment = (id: string) => id.slice(id.lastIndexOf("/") + 1);

export class NestTokenResolver {
  private tokens = new Map<string, string>();
  /** Tokens that were still unknown after the browse at the given time. */
  private unknown = new Map<string, number>();
  private fetchedAt = -Infinity;
  private browses = 0;
  private browse?: { id: number; since: number; done: Promise<void> };
  private listeners = new Set<() => void>();

  constructor(private readonly now: () => number = () => Date.now() / 1000) {}

  /** Calls `listener` when a browse finds tokens after its caller stopped waiting for it. */
  onLateAnswer(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Device ids for the given tokens. Browses media source again when a token is new, but
   * waits for it at most `waitMs`: a slower browse keeps going and tells `onLateAnswer`
   * listeners when it finds the tokens. A failed browse keeps the tokens found earlier.
   */
  async resolve(
    hass: HomeAssistant,
    tokens: string[],
    waitMs = Infinity,
  ): Promise<Map<string, string>> {
    const now = this.now();
    const wanted = tokens.filter((t) => !this.tokens.has(t));
    const worthBrowsing = wanted.some((t) => {
      const seen = this.unknown.get(t);
      return seen === undefined || now - seen > RETRY_UNKNOWN_AFTER;
    });
    if (!worthBrowsing || now - this.fetchedAt <= REFRESH_AFTER) return this.tokens;

    const browse = this.refresh(hass);
    let gaveUp = false;
    const done = browse.done.then(() => {
      // Only a browse started for this call shows a token is unknown: an older one may
      // have listed the events before this one existed.
      if (browse.since >= now) {
        for (const t of wanted) if (!this.tokens.has(t)) this.unknown.set(t, this.now());
      }
      if (gaveUp && wanted.some((t) => this.tokens.has(t))) {
        for (const listener of this.listeners) listener();
      }
    });
    done.catch(() => undefined); // a browse that fails after the wait is retried later
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<"timeout">((resolve) => {
      if (Number.isFinite(waitMs)) timer = setTimeout(() => resolve("timeout"), waitMs);
    });
    try {
      gaveUp = (await Promise.race([done, waited])) === "timeout";
    } catch (err) {
      console.debug("[event-reel] Nest lookup failed", err);
    } finally {
      clearTimeout(timer);
    }
    return this.tokens;
  }

  private refresh(hass: HomeAssistant): { since: number; done: Promise<void> } {
    const running = this.browse;
    if (running && this.now() - running.since < BROWSE_STALE) return running;
    const id = ++this.browses;
    const done = this.browseAll(hass).finally(() => {
      if (this.browse?.id !== id) return; // replaced after it stalled
      this.fetchedAt = this.now();
      this.browse = undefined;
    });
    this.browse = { id, since: this.now(), done };
    return this.browse;
  }

  private async browseAll(hass: HomeAssistant): Promise<void> {
    const root = await hass.callWS<BrowseNode>({
      type: "media_source/browse_media",
      media_content_id: ROOT,
    });
    for (const device of root.children ?? []) {
      const deviceId = lastSegment(device.media_content_id);
      const node = await hass.callWS<BrowseNode>({
        type: "media_source/browse_media",
        media_content_id: device.media_content_id,
      });
      for (const child of node.children ?? []) {
        this.tokens.set(lastSegment(child.media_content_id), deviceId);
      }
    }
  }
}

// ----- Nest events as rows (§3.2, opt-in with `nest: { events: true }`) -----

/** Compressed history row (`history/history_during_period`). */
export type NestHistoryRow = { s: string; a?: Record<string, unknown>; lu: number };

/** One trigger of a Nest `event.*` entity. */
export type NestHit = { deviceId: string; token: string; type: string; at: number };

/** One visit: the triggers of one Nest session on one device. */
export type NestVisit = {
  deviceId: string;
  /** The token whose clip and thumbnail the row shows. */
  token: string;
  /** Every token of the visit, oldest first; the first names the row. */
  tokens: string[];
  type: string;
  start: number;
  end?: number;
};

/** Which trigger names a visit: a ring over a person over motion over sound. */
const PRIORITY = ["ring", "camera_person", "camera_motion", "camera_sound"];

/**
 * The triggers in an event entity's history. The state of a trigger row is the event's own
 * time; a restart writes the last trigger again with the same state, and the row at the
 * start of the range repeats an earlier one, so rows are kept by event time and token.
 */
export function parseNestHistory(
  rows: NestHistoryRow[],
  deviceId: string,
  range: { start: number; end: number },
): NestHit[] {
  const out: NestHit[] = [];
  for (const row of rows) {
    const at = Date.parse(row.s) / 1000; // "unknown" and "unavailable" give NaN
    const type = row.a?.event_type;
    const token = row.a?.nest_event_id;
    if (!Number.isFinite(at) || at < range.start || at > range.end) continue;
    if (typeof type !== "string" || typeof token !== "string" || !token) continue;
    out.push({ deviceId, token, type, at });
  }
  return out;
}

/** The session of an event token (`["<session>", "<event>"]` in base64), if it has one. */
export function nestSession(token: string): string | undefined {
  try {
    const parts: unknown = JSON.parse(atob(token));
    return Array.isArray(parts) && typeof parts[0] === "string" ? parts[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Joins the triggers of one session on one device into a visit (two rings of one press, say).
 * A ring and the person seen before it have different sessions, so they stay two visits and
 * meet in the camera's row group instead.
 */
export function groupNestHits(hits: NestHit[]): NestVisit[] {
  const seen = new Set<string>();
  const visits = new Map<string, NestHit[]>();
  for (const hit of [...hits].sort((a, b) => a.at - b.at)) {
    if (seen.has(hit.token)) continue;
    seen.add(hit.token);
    const key = `${hit.deviceId}\n${nestSession(hit.token) ?? hit.token}`;
    visits.set(key, [...(visits.get(key) ?? []), hit]);
  }
  const rank = (h: NestHit) => {
    const i = PRIORITY.indexOf(h.type);
    return i === -1 ? PRIORITY.length : i;
  };
  return [...visits.values()].map((list) => {
    const lead = list.reduce((best, h) => (rank(h) < rank(best) ? h : best));
    const last = list[list.length - 1].at;
    return {
      deviceId: lead.deviceId,
      token: lead.token,
      tokens: list.map((h) => h.token),
      type: lead.type,
      start: list[0].at,
      end: last > list[0].at ? last : undefined,
    };
  });
}

const entityCache = new WeakMap<object, Map<string, string>>();

/** The Nest `event.*` entities and their devices; kept while the registry is the same. */
export function nestEventEntities(hass: HomeAssistant): Map<string, string> {
  const cached = entityCache.get(hass.entities);
  if (cached) return cached;
  const out = new Map<string, string>();
  for (const entry of Object.values(hass.entities)) {
    if (entry.platform === "nest" && entry.entity_id.startsWith("event.") && entry.device_id) {
      out.set(entry.entity_id, entry.device_id);
    }
  }
  entityCache.set(hass.entities, out);
  return out;
}

/** The current state of an event entity as a history row: the recorder lags a trigger. */
function currentRow(hass: HomeAssistant, id: string): NestHistoryRow[] {
  const st = hass.states[id] as HassEntity | undefined;
  return st ? [{ s: st.state, a: st.attributes, lu: Date.parse(st.last_updated) / 1000 }] : [];
}

/** The time of the newest Nest event before `before`, for the empty state. */
export function latestNestBefore(hass: HomeAssistant, before: number): number | undefined {
  const times = [...nestEventEntities(hass).keys()]
    .map((id) => Date.parse((hass.states[id] as HassEntity | undefined)?.state ?? "") / 1000)
    .filter((t) => Number.isFinite(t) && t < before);
  return times.length ? Math.max(...times) : undefined;
}

/** True when a Nest event entity triggered, which means a new row. */
export function nestEventsChanged(prev: HomeAssistant, next: HomeAssistant): boolean {
  for (const id of nestEventEntities(next).keys()) {
    const a = prev.states[id] as HassEntity | undefined;
    const b = next.states[id] as HassEntity | undefined;
    if (b && a?.state !== b.state && Number.isFinite(Date.parse(b.state))) return true;
  }
  return false;
}

const CATEGORY: Record<string, Category> = {
  ring: "doorbell",
  camera_person: "person",
  camera_motion: "motion",
  camera_sound: "motion",
};

/** Object labels the detail translates (`object.*`). */
const LABEL: Record<string, string | undefined> = { ring: "chime", camera_person: "person" };

function visitTitle(visit: NestVisit, camera: string, localize: Localize): string {
  switch (visit.type) {
    case "ring":
      return localize("title.rang_at_camera", { camera });
    case "camera_person":
      return localize("title.object_at_camera", { object: localize("object.person"), camera });
    case "camera_sound":
      return localize("title.sound_at_camera", { camera });
    default:
      return localize("title.activity_at_camera", { camera });
  }
}

export function createNestEventProvider(): Provider {
  return {
    type: "nest",
    async fetch(range: TimeRange, ctx: ProviderContext): Promise<ReelEvent[]> {
      const entities = nestEventEntities(ctx.hass);
      if (!entities.size) return [];
      const history = await ctx.hass.callWS<Record<string, NestHistoryRow[]>>({
        type: "history/history_during_period",
        start_time: new Date(range.start * 1000).toISOString(),
        end_time: new Date(range.end * 1000).toISOString(),
        entity_ids: [...entities.keys()],
        minimal_response: false,
        no_attributes: false,
        significant_changes_only: false,
      });
      const hits = [...entities].flatMap(([id, deviceId]) =>
        parseNestHistory([...(history[id] ?? []), ...currentRow(ctx.hass, id)], deviceId, range),
      );
      return groupNestHits(hits).map((visit) => {
        const camera = ctx.cameras.byDevice(visit.deviceId, "nest");
        const device = ctx.hass.devices[visit.deviceId] as HassDevice | undefined;
        // The first name that is set and not empty.
        const name =
          [camera && ctx.cameras.get(camera)?.name, device?.name_by_user, device?.name].find(
            (n): n is string => !!n,
          ) ?? ctx.localize("provider.nest");
        const media = nestMedia(visit.deviceId, visit.token);
        const label = LABEL[visit.type];
        return {
          id: `nest:${visit.tokens[0]}`,
          provider: "nest",
          sources: ["nest"],
          // Every token, so AI text about any trigger of the visit joins this row.
          aliases: visit.tokens,
          start: visit.start,
          end: visit.end,
          title: visitTitle(visit, name, ctx.localize),
          category: CATEGORY[visit.type] ?? "motion",
          camera,
          cameraLabel: camera ? undefined : name,
          thumbnail: [media.thumbnail],
          clip: media.clip,
          labels: label ? [label] : undefined,
          raw: visit,
        };
      });
    },
  };
}
