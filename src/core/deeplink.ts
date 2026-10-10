// Deep links: `#reel=<id>` or `?reel=<id>` opens one event (PLAN.md §5.7). Pure.

import type { ReelEvent } from "../types";

/** The requested event id from a URL's hash or query, if any. */
export function parseReelParam(loc: { hash: string; search: string }): string | undefined {
  const fromHash = new URLSearchParams(loc.hash.replace(/^#/, "")).get("reel");
  const fromQuery = new URLSearchParams(loc.search).get("reel");
  const value = (fromHash || fromQuery || "").trim();
  return value || undefined;
}

/**
 * Finds an event by our id, a Frigate review id, an LLM Vision uid, or any alias of a merged
 * event.
 */
export function findEvent(events: ReelEvent[], id: string): ReelEvent | undefined {
  const candidates = [id, `llmvision:${id}`];
  return (
    events.find((e) => e.id === id) ??
    events.find((e) => e.aliases?.some((a) => candidates.includes(a))) ??
    events.find((e) => e.id.endsWith(`:${id}`))
  );
}
