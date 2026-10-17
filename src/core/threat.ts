// Threat levels of Frigate GenAI reviews (§2.2). Pure helpers, no DOM or hass access.

import type { ReelEvent } from "../types";

/** Highest threat level among these events, or undefined when none of them has one. */
export function highestThreat(events: ReelEvent[]): 1 | 2 | undefined {
  let max: 1 | 2 | undefined;
  for (const e of events) {
    if (e.threat && (!max || e.threat > max)) max = e.threat;
  }
  return max;
}

/**
 * A capped prefix of `list` plus the events with a threat level that the cap cut off, in
 * list order, so a cap never hides a flagged event. `hidden` counts what is still left out.
 */
export function withFlagged(
  list: ReelEvent[],
  capped: { list: ReelEvent[]; hidden: number },
): { list: ReelEvent[]; hidden: number } {
  const flagged = list.slice(capped.list.length).filter((e) => e.threat);
  if (!flagged.length) return capped;
  return { list: [...capped.list, ...flagged], hidden: capped.hidden - flagged.length };
}
