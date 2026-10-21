import { describe, expect, it } from "vitest";
import { countsAsStall, stallVerdict } from "../src/core/playback";

// readyState values from the HTML spec.
const HAVE_NOTHING = 0;
const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;
const HAVE_FUTURE_DATA = 3;
const HAVE_ENOUGH_DATA = 4;

const base = { native: true, playRefused: false, stalledBefore: false };

describe("stallVerdict", () => {
  it("keeps waiting while data arrives and the start limit hasn't passed", () => {
    expect(stallVerdict({ ...base, idle: 5, elapsed: 30, readyState: HAVE_METADATA })).toBe("wait");
    expect(
      stallVerdict({ ...base, native: false, idle: 20, elapsed: 40, readyState: HAVE_NOTHING }),
    ).toBe("wait");
  });

  it("treats a first native stall as the network, not the codec", () => {
    // Nothing loaded at all.
    expect(stallVerdict({ ...base, idle: 13, elapsed: 13, readyState: HAVE_NOTHING })).toBe(
      "unavailable",
    );
    // The manifest and init segment arrived, then the first segment stalled.
    expect(stallVerdict({ ...base, idle: 13, elapsed: 20, readyState: HAVE_METADATA })).toBe(
      "unavailable",
    );
    // A progressive MP4 that stalled right after its first frame.
    expect(stallVerdict({ ...base, idle: 13, elapsed: 20, readyState: HAVE_CURRENT_DATA })).toBe(
      "unavailable",
    );
  });

  it("blames the decoder when a native player buffered ahead and still won't play", () => {
    expect(stallVerdict({ ...base, idle: 13, elapsed: 20, readyState: HAVE_FUTURE_DATA })).toBe(
      "codec",
    );
    expect(stallVerdict({ ...base, idle: 1, elapsed: 46, readyState: HAVE_ENOUGH_DATA })).toBe(
      "codec",
    );
  });

  it("blames the decoder when the same camera stalls again after its metadata loaded", () => {
    const again = { ...base, stalledBefore: true, idle: 13, elapsed: 20 };
    expect(stallVerdict({ ...again, readyState: HAVE_METADATA })).toBe("codec");
    // Without metadata it's still the network, however often it happens.
    expect(stallVerdict({ ...again, readyState: HAVE_NOTHING })).toBe("unavailable");
  });

  it("doesn't blame the decoder when the browser refused to start playback", () => {
    expect(
      stallVerdict({
        ...base,
        playRefused: true,
        stalledBefore: true,
        idle: 1,
        elapsed: 46,
        readyState: HAVE_ENOUGH_DATA,
      }),
    ).toBe("unavailable");
  });

  it("never blames the decoder for hls.js, which reports decode errors itself", () => {
    const hls = { ...base, native: false, stalledBefore: true, readyState: HAVE_ENOUGH_DATA };
    expect(stallVerdict({ ...hls, idle: 26, elapsed: 30 })).toBe("unavailable");
    expect(stallVerdict({ ...hls, idle: 1, elapsed: 46 })).toBe("unavailable");
  });

  it("gives hls.js longer than a native player before calling it a stall", () => {
    const at20 = { idle: 20, elapsed: 20, readyState: HAVE_NOTHING };
    expect(stallVerdict({ ...base, ...at20, native: false })).toBe("wait");
    expect(stallVerdict({ ...base, ...at20 })).toBe("unavailable");
  });
});

describe("countsAsStall", () => {
  it("counts native stalls that got as far as the metadata", () => {
    expect(countsAsStall(true, HAVE_METADATA)).toBe(true);
    expect(countsAsStall(true, HAVE_NOTHING)).toBe(false);
    expect(countsAsStall(false, HAVE_ENOUGH_DATA)).toBe(false);
  });
});
