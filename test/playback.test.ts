import { describe, expect, it } from "vitest";
import { stallVerdict } from "../src/core/playback";

// readyState values from the HTML spec.
const HAVE_NOTHING = 0;
const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;
const HAVE_ENOUGH_DATA = 4;

describe("stallVerdict", () => {
  it("keeps waiting while data arrives and the start limit hasn't passed", () => {
    expect(stallVerdict({ native: true, idle: 5, elapsed: 30, readyState: HAVE_METADATA })).toBe(
      "wait",
    );
    expect(stallVerdict({ native: false, idle: 20, elapsed: 40, readyState: HAVE_NOTHING })).toBe(
      "wait",
    );
  });

  it("treats a native player that never got the media as a stall, not a codec problem", () => {
    // Nothing loaded for 13 s: the network, so the camera isn't written off.
    expect(stallVerdict({ native: true, idle: 13, elapsed: 13, readyState: HAVE_NOTHING })).toBe(
      "unavailable",
    );
    // The manifest and init segment arrived, then the first segment stalled.
    expect(stallVerdict({ native: true, idle: 13, elapsed: 20, readyState: HAVE_METADATA })).toBe(
      "unavailable",
    );
    expect(stallVerdict({ native: true, idle: 2, elapsed: 46, readyState: HAVE_METADATA })).toBe(
      "unavailable",
    );
  });

  it("blames the decoder when a native player has the media buffered but won't play it", () => {
    expect(
      stallVerdict({ native: true, idle: 13, elapsed: 20, readyState: HAVE_CURRENT_DATA }),
    ).toBe("codec");
    expect(stallVerdict({ native: true, idle: 1, elapsed: 46, readyState: HAVE_ENOUGH_DATA })).toBe(
      "codec",
    );
  });

  it("never blames the decoder for hls.js, which reports decode errors itself", () => {
    expect(
      stallVerdict({ native: false, idle: 26, elapsed: 30, readyState: HAVE_ENOUGH_DATA }),
    ).toBe("unavailable");
    expect(
      stallVerdict({ native: false, idle: 1, elapsed: 46, readyState: HAVE_ENOUGH_DATA }),
    ).toBe("unavailable");
  });

  it("gives hls.js longer than a native player before calling it a stall", () => {
    expect(stallVerdict({ native: false, idle: 20, elapsed: 20, readyState: HAVE_NOTHING })).toBe(
      "wait",
    );
    expect(stallVerdict({ native: true, idle: 20, elapsed: 20, readyState: HAVE_NOTHING })).toBe(
      "unavailable",
    );
  });
});
