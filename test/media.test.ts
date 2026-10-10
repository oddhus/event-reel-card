import { describe, expect, it, vi } from "vitest";
import { MediaResolver, frigateMedia, keyFrameRef } from "../src/core/media";
import type { HomeAssistant } from "../src/ha-types";

describe("media builders", () => {
  const ref = { instance: "frigate", camera: "entrance", reviewId: "123.4-abc" };

  it("builds VOD and download paths with whole seconds", () => {
    expect(frigateMedia.vod(ref, 1000.7, 1050.2).path).toBe(
      "/api/frigate/frigate/vod/entrance/start/1000/end/1051/index.m3u8",
    );
    expect(frigateMedia.recording(ref, 1000.7, 1050.2).path).toBe(
      "/api/frigate/frigate/recording/entrance/start/1000/end/1051",
    );
  });

  it("derives the review still from thumb_path", () => {
    expect(
      frigateMedia.reviewThumb(ref, "/media/frigate/clips/review/thumb-entrance-123.4-abc.webp")
        .path,
    ).toBe("/api/frigate/frigate/clips/review/thumb-entrance-123.4-abc.webp");
    expect(frigateMedia.reviewThumb(ref).path).toBe(
      "/api/frigate/frigate/clips/review/thumb-entrance-123.4-abc.webp",
    );
  });

  it("turns key frames into media-source ids", () => {
    expect(keyFrameRef("/media/llmvision/snapshots/a.jpg")).toEqual({
      kind: "image",
      path: "media-source://media_source/local/llmvision/snapshots/a.jpg",
      resolve: true,
    });
    expect(keyFrameRef("")).toBeUndefined();
  });
});

describe("MediaResolver", () => {
  function setup() {
    let now = 1000;
    const callWS = vi.fn(async (msg: Record<string, unknown>) => {
      if (msg.type === "auth/sign_path")
        return { path: `${msg.path}?authSig=${callWS.mock.calls.length}` };
      if (msg.type === "media_source/resolve_media")
        return { url: `/resolved?${msg.media_content_id}` };
      throw new Error("unexpected");
    });
    const hass = { callWS } as unknown as HomeAssistant;
    const resolver = new MediaResolver(
      () => hass,
      () => now,
    );
    return { resolver, callWS, advance: (s: number) => (now += s) };
  }

  it("signs /api paths once and reuses the result until shortly before expiry", async () => {
    const { resolver, callWS, advance } = setup();
    const ref = { kind: "image" as const, path: "/api/x" };
    const [a, b] = await Promise.all([resolver.url(ref), resolver.url(ref)]);
    expect(a).toBe(b);
    expect(callWS).toHaveBeenCalledTimes(1);
    advance(3000);
    await resolver.url(ref);
    expect(callWS).toHaveBeenCalledTimes(1);
    advance(600);
    await resolver.url(ref);
    expect(callWS).toHaveBeenCalledTimes(2);
  });

  it("resolves media-source ids and passes other paths through", async () => {
    const { resolver, callWS } = setup();
    expect(await resolver.url({ kind: "image", path: "media-source://x", resolve: true })).toBe(
      "/resolved?media-source://x",
    );
    expect(await resolver.url({ kind: "image", path: "/local/a.png" })).toBe("/local/a.png");
    expect(callWS).toHaveBeenCalledTimes(1);
  });

  it("re-signs after invalidate", async () => {
    const { resolver, callWS } = setup();
    const ref = { kind: "mp4" as const, path: "/api/y?format=mp4" };
    await resolver.url(ref);
    resolver.invalidate(ref);
    await resolver.url(ref);
    expect(callWS).toHaveBeenCalledTimes(2);
    expect(callWS.mock.calls[0][0]).toMatchObject({ path: "/api/y?format=mp4" });
  });
});
