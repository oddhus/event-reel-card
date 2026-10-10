import { describe, expect, it, vi } from "vitest";
import type { HomeAssistant } from "../src/ha-types";
import { NestTokenResolver } from "../src/providers/nest";

describe("NestTokenResolver", () => {
  it("maps tokens to devices and doesn't re-browse for a token that stays unknown", async () => {
    let now = 1000;
    const callWS = vi.fn(async (msg: Record<string, unknown>) =>
      msg.media_content_id === "media-source://nest"
        ? {
            media_content_id: "media-source://nest",
            children: [{ media_content_id: "media-source://nest/dev1" }],
          }
        : {
            media_content_id: "media-source://nest/dev1",
            children: [{ media_content_id: "media-source://nest/dev1/tokA" }],
          },
    );
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
});
