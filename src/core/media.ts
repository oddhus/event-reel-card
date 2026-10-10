// Media URL builders and the signer/resolver. UI components get playable URLs only through
// here. See PLAN.md §2.2, §3.6.

import type { HomeAssistant } from "../ha-types";
import type { FrigateRef, MediaRef } from "../types";

const enc = encodeURIComponent;

export const frigateMedia = {
  /** Animated review preview (mp4) through the notification proxy. */
  reviewPreview(ref: FrigateRef): MediaRef {
    return {
      kind: "mp4",
      path: `/api/frigate/${enc(ref.instance)}/notifications/${enc(ref.reviewId ?? "")}/review_preview.gif?format=mp4`,
    };
  },

  /** Review still through the clips proxy (normal auth, independent of the notification proxy). */
  reviewThumb(ref: FrigateRef, thumbPath?: string): MediaRef {
    const marker = "/clips/";
    const idx = thumbPath ? thumbPath.indexOf(marker) : -1;
    const rel =
      idx >= 0
        ? thumbPath!.slice(idx + marker.length)
        : `review/thumb-${ref.camera}-${ref.reviewId ?? ""}.webp`;
    return { kind: "image", path: `/api/frigate/${enc(ref.instance)}/clips/${rel}` };
  },

  /** Review still through the notification proxy (fallback). */
  reviewThumbAlt(ref: FrigateRef): MediaRef {
    return {
      kind: "image",
      path: `/api/frigate/${enc(ref.instance)}/notifications/${enc(ref.reviewId ?? "")}/${enc(ref.camera)}/review_thumbnail.webp`,
    };
  },

  /** Exact clip as HLS for a time range. */
  vod(ref: FrigateRef, start: number, end: number): MediaRef {
    return {
      kind: "hls",
      path: `/api/frigate/${enc(ref.instance)}/vod/${enc(ref.camera)}/start/${Math.floor(start)}/end/${Math.ceil(end)}/index.m3u8`,
    };
  },

  /** Full-quality MP4 for download. */
  recording(ref: FrigateRef, start: number, end: number): MediaRef {
    return {
      kind: "mp4",
      path: `/api/frigate/${enc(ref.instance)}/recording/${enc(ref.camera)}/start/${Math.floor(start)}/end/${Math.ceil(end)}`,
    };
  },
};

/** LLM Vision key frame (`/media/llmvision/...`) → media-source id that resolves to a signed URL. */
export function keyFrameRef(path: string | undefined | null): MediaRef | undefined {
  if (!path) return undefined;
  if (/^https?:\/\//i.test(path)) return { kind: "image", path };
  if (path.startsWith("/media/")) {
    return {
      kind: "image",
      path: `media-source://media_source/local/${path.slice("/media/".length)}`,
      resolve: true,
    };
  }
  return { kind: "image", path };
}

export function nestMedia(deviceId: string, token: string) {
  return {
    clip: {
      kind: "mp4",
      path: `media-source://nest/${deviceId}/${token}`,
      resolve: true,
    } as MediaRef,
    thumbnail: {
      kind: "image",
      path: `/api/nest/event_media/${enc(deviceId)}/${enc(token)}/thumbnail`,
    } as MediaRef,
  };
}

export const needsSigning = (path: string) =>
  path.startsWith("/api/") || path.startsWith("/media/");

const SIGN_EXPIRES = 3600;
const RESOLVE_CACHE = 3000;
const HLS_CACHE = 300;

/**
 * Turns MediaRefs into playable URLs: signs HA paths (auth/sign_path) and resolves
 * media-source ids. Caches until shortly before expiry and dedupes concurrent requests.
 */
export class MediaResolver {
  private cache = new Map<string, { url: string; expires: number }>();
  private inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly getHass: () => HomeAssistant | undefined,
    private readonly now: () => number = () => Date.now() / 1000,
  ) {}

  private key(ref: MediaRef) {
    return `${ref.resolve ? "r" : "s"}:${ref.path}`;
  }

  async url(ref: MediaRef): Promise<string> {
    if (!ref.resolve && !needsSigning(ref.path)) return ref.path;
    const key = this.key(ref);
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) return cached.url;
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = this.fetchUrl(ref)
      .then((url) => {
        // Segments of an HLS stream reuse the manifest's signature for the whole playback, so
        // hand out manifest signatures with most of their validity left.
        const ttl = ref.resolve
          ? RESOLVE_CACHE
          : ref.kind === "hls"
            ? HLS_CACHE
            : SIGN_EXPIRES - 60;
        this.cache.set(key, { url, expires: this.now() + ttl });
        return url;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  /** Forget a cached URL, e.g. after a 401 or an expired signature. */
  invalidate(ref: MediaRef): void {
    this.cache.delete(this.key(ref));
  }

  private async fetchUrl(ref: MediaRef): Promise<string> {
    const hass = this.getHass();
    if (!hass) throw new Error("hass not ready");
    if (ref.resolve) {
      const res = await hass.callWS<{ url: string }>({
        type: "media_source/resolve_media",
        media_content_id: ref.path,
        expires: SIGN_EXPIRES,
      });
      return res.url;
    }
    const res = await hass.callWS<{ path: string }>({
      type: "auth/sign_path",
      path: ref.path,
      expires: SIGN_EXPIRES,
    });
    return res.path;
  }
}
