import { describe, expect, it } from "vitest";
import { hasSource } from "../src/core/capabilities";
import { normalizeConfig } from "../src/config";

const none = { llmvision: false, event_reel: false, frigate: false, nest: false };
const card = (extra: Record<string, unknown> = {}) =>
  normalizeConfig({ type: "custom:event-reel-card", ...extra });

describe("hasSource", () => {
  it("is false for a bare card on Home Assistant core", () => {
    expect(hasSource(card(), none)).toBe(false);
    // Nest alone only adds doorbell clips to AI events; it brings no events of its own.
    expect(hasSource(card(), { ...none, nest: true })).toBe(false);
  });

  it("is true once entities are listed", () => {
    expect(hasSource(card({ entities: ["lock.front_door"] }), none)).toBe(true);
  });

  it("is true when an optional integration is installed and not switched off", () => {
    expect(hasSource(card(), { ...none, frigate: true })).toBe(true);
    expect(hasSource(card(), { ...none, event_reel: true })).toBe(true);
    expect(hasSource(card(), { ...none, llmvision: true })).toBe(true);
  });

  it("is false when the only installed integration is switched off", () => {
    expect(hasSource(card({ frigate: false }), { ...none, frigate: true })).toBe(false);
    // The editor switches a provider off this way and keeps its options.
    expect(hasSource(card({ frigate: { enabled: false } }), { ...none, frigate: true })).toBe(
      false,
    );
  });

  it("is false when a configured integration isn't installed", () => {
    expect(hasSource(card({ llmvision: true }), none)).toBe(false);
  });
});
