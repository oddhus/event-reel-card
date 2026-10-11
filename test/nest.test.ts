import { describe, expect, it, vi } from "vitest";
import type { HomeAssistant } from "../src/ha-types";
import { NestTokenResolver } from "../src/providers/nest";

/** Media source with one Nest device that has one event, `tokA`. */
const answer = async (msg: Record<string, unknown>) =>
  msg.media_content_id === "media-source://nest"
    ? {
        media_content_id: "media-source://nest",
        children: [{ media_content_id: "media-source://nest/dev1" }],
      }
    : {
        media_content_id: "media-source://nest/dev1",
        children: [{ media_content_id: "media-source://nest/dev1/tokA" }],
      };

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("NestTokenResolver", () => {
  it("maps tokens to devices and doesn't re-browse for a token that stays unknown", async () => {
    let now = 1000;
    const callWS = vi.fn(answer);
    const hass = { callWS } as unknown as HomeAssistant;
    const resolver = new NestTokenResolver(() => now);

    expect((await resolver.resolve(hass, ["tokA"])).get("tokA")).toBe("dev1");
    expect(callWS).toHaveBeenCalledTimes(2);

    now += 60;
    await resolver.resolve(hass, ["tokA", "gone"]);
    expect(callWS).toHaveBeenCalledTimes(4); // "gone" is new: browse once
    now += 60;
    await resolver.resolve(hass, ["gone"]);
    expect(callWS).toHaveBeenCalledTimes(4); // still unknown: wait
    now += 700;
    await resolver.resolve(hass, ["gone"]);
    expect(callWS).toHaveBeenCalledTimes(6); // retry after the cooldown
  });

  it("stops waiting for a browse that hangs, and replaces it once it's stale", async () => {
    vi.useFakeTimers();
    try {
      let now = 1000;
      const callWS = vi.fn(
        (_msg: Record<string, unknown>): Promise<unknown> => new Promise(() => undefined),
      );
      const hass = { callWS } as unknown as HomeAssistant;
      const resolver = new NestTokenResolver(() => now);

      const first = resolver.resolve(hass, ["tokA"], 3000);
      await vi.advanceTimersByTimeAsync(3000);
      expect((await first).has("tokA")).toBe(false);
      expect(callWS).toHaveBeenCalledTimes(1);

      now += 30; // still within a minute: wait for the same browse, don't send another
      const second = resolver.resolve(hass, ["tokA"], 3000);
      await vi.advanceTimersByTimeAsync(3000);
      expect((await second).has("tokA")).toBe(false);
      expect(callWS).toHaveBeenCalledTimes(1);

      now += 40; // no answer for 70 s: browse again
      callWS.mockImplementation(answer);
      expect((await resolver.resolve(hass, ["tokA"], 3000)).get("tokA")).toBe("dev1");
      expect(callWS).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the tokens it knows when a browse fails", async () => {
    let now = 1000;
    const callWS = vi.fn(answer);
    const hass = { callWS } as unknown as HomeAssistant;
    const resolver = new NestTokenResolver(() => now);
    expect((await resolver.resolve(hass, ["tokA"])).get("tokA")).toBe("dev1");

    now += 60;
    callWS.mockRejectedValue(new Error("browse failed"));
    const map = await resolver.resolve(hass, ["tokA", "tokB"], 3000);
    expect(map.get("tokA")).toBe("dev1");
    expect(map.has("tokB")).toBe(false);
  });

  it("browses again for a token that a browse started before it couldn't have listed", async () => {
    let now = 1000;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const callWS = vi.fn(async (msg: Record<string, unknown>) => {
      await gate;
      return answer(msg); // lists tokA only
    });
    const hass = { callWS } as unknown as HomeAssistant;
    const resolver = new NestTokenResolver(() => now);

    const first = resolver.resolve(hass, ["tokA"]);
    now += 10; // a new doorbell event arrives while that browse runs
    const second = resolver.resolve(hass, ["tokB"]);
    release();
    await Promise.all([first, second]);
    expect(callWS).toHaveBeenCalledTimes(2);

    now += 35; // past the 30 s between browses, but far from the 10 min for unknown tokens
    await resolver.resolve(hass, ["tokB"]);
    expect(callWS).toHaveBeenCalledTimes(4);
  });

  it("tells listeners when a browse finds the tokens after the wait, not before", async () => {
    vi.useFakeTimers();
    try {
      let now = 1000;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const callWS = vi.fn(async (msg: Record<string, unknown>) => {
        await gate;
        return answer(msg);
      });
      const hass = { callWS } as unknown as HomeAssistant;
      const resolver = new NestTokenResolver(() => now);
      const late = vi.fn();
      resolver.onLateAnswer(late);

      const first = resolver.resolve(hass, ["tokA"], 3000);
      await vi.advanceTimersByTimeAsync(3000);
      await first;
      expect(late).not.toHaveBeenCalled();
      release();
      await flush();
      expect(late).toHaveBeenCalledTimes(1);

      // A browse that answers within the wait needs no second fetch.
      now += 60;
      await resolver.resolve(hass, ["gone"], 3000);
      expect(callWS).toHaveBeenCalledTimes(4);
      expect(late).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the answer of a browse that finished after the wait", async () => {
    vi.useFakeTimers();
    try {
      let now = 1000;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const callWS = vi.fn(async (msg: Record<string, unknown>) => {
        await gate;
        return answer(msg);
      });
      const hass = { callWS } as unknown as HomeAssistant;
      const resolver = new NestTokenResolver(() => now);

      const first = resolver.resolve(hass, ["tokA"], 3000);
      await vi.advanceTimersByTimeAsync(3000);
      expect((await first).has("tokA")).toBe(false);

      release();
      await flush();
      now += 5;
      expect((await resolver.resolve(hass, ["tokA"], 3000)).get("tokA")).toBe("dev1");
      expect(callWS).toHaveBeenCalledTimes(2); // the one browse: root and device
    } finally {
      vi.useRealTimers();
    }
  });
});
