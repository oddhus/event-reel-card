// What a clip that hasn't started playing means: a stalled network or a decoder that can't
// play the recording (PLAN.md §5.4). Pure, so the rules can be tested without a browser.

/** Give up when nothing has loaded for this long (a 4K segment can take a while). */
export const IDLE_LIMIT_HLS = 25;
export const IDLE_LIMIT_NATIVE = 12;
/** Give up when playback hasn't started after this long, even if data keeps arriving. */
export const START_LIMIT = 45;

/** `HTMLMediaElement.HAVE_CURRENT_DATA`: media for the current position is buffered. */
const HAVE_CURRENT_DATA = 2;

export type StallVerdict = "wait" | "unavailable" | "codec";

export interface StallState {
  /** A native player (Safari's HLS, a plain MP4) rather than hls.js. */
  native: boolean;
  /** Seconds since anything last loaded. */
  idle: number;
  /** Seconds since the load began. */
  elapsed: number;
  /** The video element's `readyState`. */
  readyState: number;
}

/**
 * A native player that has the media buffered and still doesn't play can't decode it, and
 * says nothing (hls.js reports that as a media error instead). Anything else that times out
 * is a stall: fall back, but let the next attempt try the full clip again.
 */
export function stallVerdict(s: StallState): StallVerdict {
  const idleLimit = s.native ? IDLE_LIMIT_NATIVE : IDLE_LIMIT_HLS;
  if (s.idle <= idleLimit && s.elapsed <= START_LIMIT) return "wait";
  return s.native && s.readyState >= HAVE_CURRENT_DATA ? "codec" : "unavailable";
}
