import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/config";

describe("normalizeConfig", () => {
  it("applies defaults", () => {
    const c = normalizeConfig({ type: "custom:event-reel-card" });
    expect(c.range).toEqual({ kind: "rolling", hours: 24 });
    expect(c.density).toBe("compact");
    expect(c.language).toBe("auto");
    expect(c.llmvision).toMatchObject({ enabled: true, explicit: false, non_camera: true });
    expect(c.frigate).toMatchObject({
      enabled: true,
      explicit: false,
      show_unmatched: true,
      severity: ["alert", "detection"],
      clip_padding: [10, 20],
    });
    expect(c.groupingWindow).toBe(120);
    expect(c.merge).toEqual({ before: 15, after: 30 });
  });

  it("treats true/object as explicit and false as disabled", () => {
    const c = normalizeConfig({
      type: "custom:event-reel-card",
      llmvision: { non_camera: false },
      frigate: false,
      nest: true,
    });
    expect(c.llmvision).toMatchObject({ enabled: true, explicit: true, non_camera: false });
    expect(c.frigate).toMatchObject({ enabled: false, explicit: true });
    expect(c.nest).toEqual({ enabled: true, explicit: true });
  });

  it("normalizes entity shorthands", () => {
    const c = normalizeConfig({
      type: "custom:event-reel-card",
      entities: ["person.alex", { entity: "lock.front_door", actor_attribute: "changed_by" }],
    });
    expect(c.entities).toEqual([
      { entity: "person.alex" },
      { entity: "lock.front_door", actor_attribute: "changed_by" },
    ]);
  });

  it("rejects entity items without an id", () => {
    expect(() => normalizeConfig({ type: "x", entities: [{ name: "x" } as never] })).toThrow(
      /entity id/,
    );
  });
});
