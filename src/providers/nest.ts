// Nest (core integration) through HA media source. M1 only needs one thing from it: which
// Nest device an event token belongs to, so LLM Vision doorbell events can play their clip.

import type { HomeAssistant } from "../ha-types";

interface BrowseNode {
  media_content_id: string;
  title?: string;
  children?: BrowseNode[];
}

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
