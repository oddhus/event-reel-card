// What a clip that hasn't started playing means: a stalled network or a decoder that can't
// play the recording (PLAN.md §5.4). Pure, so the rules can be tested without a browser.

/** Give up when nothing has loaded for this long (a 4K segment can take a while). */
export const IDLE_LIMIT_HLS = 25;
export const IDLE_LIMIT_NATIVE = 12;
/** Give up when playback hasn't started after this long, even if data keeps arriving. */
export const START_LIMIT = 45;
/** Seconds buffered ahead that a working decoder would have started playing. */
const BUFFERED_ENOUGH = 3;

// `HTMLMediaElement.readyState` values.
const HAVE_METADATA = 1;
const HAVE_FUTURE_DATA = 3;

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
  /** Seconds buffered from the current position on. */
  bufferedAhead: number;
  /** This camera's last clip also stalled after its metadata loaded, and none played since. */
  stalledBefore: boolean;
}

/**
 * A native player that can't decode a recording says nothing (hls.js reports a media error
 * instead). It shows as a stall with media buffered ahead, or as a stall after the metadata
 * loaded that happens again on the same camera before any clip of it plays. Any other
 * timeout is a stall: fall back, but let the next attempt try the full clip again.
 */
export function stallVerdict(s: StallState): StallVerdict {
  const idleLimit = s.native ? IDLE_LIMIT_NATIVE : IDLE_LIMIT_HLS;
  if (s.idle <= idleLimit && s.elapsed <= START_LIMIT) return "wait";
  if (!s.native) return "unavailable";
  if (s.readyState >= HAVE_FUTURE_DATA || s.bufferedAhead >= BUFFERED_ENOUGH) return "codec";
  if (s.readyState >= HAVE_METADATA && s.stalledBefore) return "codec";
  return "unavailable";
}

/** Whether a stall counts as the first strike toward `stalledBefore`. */
export const countsAsStall = (native: boolean, readyState: number) =>
  native && readyState >= HAVE_METADATA;
