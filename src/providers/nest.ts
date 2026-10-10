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

/** Last path segment of a media-source id, e.g. the token of `media-source://nest/{device}/{token}`. */
const lastSegment = (id: string) => id.slice(id.lastIndexOf("/") + 1);

export class NestTokenResolver {
  private tokens = new Map<string, string>();
  /** Tokens that were still unknown after the browse at the given time. */
  private unknown = new Map<string, number>();
  private fetchedAt = -Infinity;
  private refreshing?: Promise<void>;

  constructor(private readonly now: () => number = () => Date.now() / 1000) {}

  /** Device ids for the given tokens. Browses media source again when a token is new. */
  async resolve(hass: HomeAssistant, tokens: string[]): Promise<Map<string, string>> {
    const now = this.now();
    const worthBrowsing = tokens.some((t) => {
      if (this.tokens.has(t)) return false;
      const seen = this.unknown.get(t);
      return seen === undefined || now - seen > RETRY_UNKNOWN_AFTER;
    });
    if (worthBrowsing && now - this.fetchedAt > REFRESH_AFTER) {
      await this.refresh(hass);
      for (const t of tokens) if (!this.tokens.has(t)) this.unknown.set(t, this.now());
    }
    return this.tokens;
  }

  private refresh(hass: HomeAssistant): Promise<void> {
    this.refreshing ??= (async () => {
      try {
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
      } finally {
        this.fetchedAt = this.now();
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }
}
