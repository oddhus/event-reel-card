import { describe, expect, it } from "vitest";
import { buildCameraRegistry, frigateSignature, isNestToken } from "../src/core/cameras";
import type { HassEntity } from "../src/ha-types";

const state = (entity_id: string, attributes: Record<string, unknown> = {}): HassEntity => ({
  entity_id,
  state: "idle",
  attributes,
  last_changed: "",
  last_updated: "",
});

const registry = buildCameraRegistry({
  states: {
    "camera.entrance": state("camera.entrance", {
      friendly_name: "Entrance",
      client_id: "frigate",
      camera_name: "entrance",
    }),
    "camera.backyard": state("camera.backyard", { client_id: "frigate", camera_name: "backyard" }),
    "camera.backyard_reolink": state("camera.backyard_reolink"),
    "camera.doorbell": state("camera.doorbell", { friendly_name: "Doorbell" }),
    "image.entrance_person": state("image.entrance_person"),
  },
  entities: {
    "camera.entrance": {
      entity_id: "camera.entrance",
      device_id: "dev-entrance",
      platform: "frigate",
    },
    "image.entrance_person": {
      entity_id: "image.entrance_person",
      device_id: "dev-entrance",
      platform: "frigate",
    },
    "camera.backyard_reolink": {
      entity_id: "camera.backyard_reolink",
      device_id: "dev-reolink",
      platform: "reolink",
    },
    "camera.doorbell": {
      entity_id: "camera.doorbell",
      device_id: "nest-device-1",
      platform: "nest",
    },
    "image.orphan": { entity_id: "image.orphan", device_id: "dev-none" },
  },
  aliases: { "camera.backyard_reolink": "camera.backyard" },
});

describe("camera registry", () => {
  it("maps Frigate cameras both ways", () => {
    expect(registry.get("camera.entrance")?.frigate).toEqual({
      instance: "frigate",
      camera: "entrance",
    });
    expect(registry.byFrigate("frigate", "entrance")).toBe("camera.entrance");
    expect(registry.frigateInstances()).toEqual(["frigate"]);
  });

  it("resolves a camera entity to itself", () => {
    expect(registry.resolve("camera.doorbell")).toBe("camera.doorbell");
  });

  it("resolves a Frigate image entity to the camera on the same device", () => {
    expect(registry.resolve("image.entrance_person")).toBe("camera.entrance");
  });

  it("applies aliases before anything else", () => {
    expect(registry.resolve("camera.backyard_reolink")).toBe("camera.backyard");
  });

  it("finds the camera on a device", () => {
    expect(registry.byDevice("nest-device-1", "nest")).toBe("camera.doorbell");
  });

  it("never guesses", () => {
    expect(registry.resolve("image.orphan")).toBeUndefined();
    expect(registry.resolve("sensor.whatever")).toBeUndefined();
    expect(registry.resolve("")).toBeUndefined();
  });
});

describe("isNestToken", () => {
  it("detects base64 JSON arrays", () => {
    expect(isNestToken(btoa(JSON.stringify(["1700000000", "1234567890"])))).toBe(true);
  });

  it("rejects entity ids and other strings", () => {
    expect(isNestToken("image.entrance_person")).toBe(false);
    expect(isNestToken("clip")).toBe(false);
    expect(isNestToken(btoa("hello world"))).toBe(false);
  });
});

describe("aliases on every lookup", () => {
  it("applies an alias to Frigate and device lookups", () => {
    const reg = buildCameraRegistry({
      states: {
        "camera.backyard": state("camera.backyard", {
          client_id: "frigate",
          camera_name: "backyard",
        }),
        "camera.backyard_reolink": state("camera.backyard_reolink"),
      },
      entities: {
        "camera.backyard": { entity_id: "camera.backyard", device_id: "d-f", platform: "frigate" },
      },
      aliases: { "camera.backyard": "camera.backyard_reolink" },
    });
    expect(reg.byFrigate("frigate", "backyard")).toBe("camera.backyard_reolink");
    expect(reg.byDevice("d-f")).toBe("camera.backyard_reolink");
    expect(reg.resolve("camera.backyard")).toBe("camera.backyard_reolink");
  });
});

describe("frigateSignature", () => {
  const cam = (id: string, attributes: Record<string, unknown>) => ({
    entity_id: id,
    state: "idle",
    attributes,
    last_changed: "",
    last_updated: "",
  });

  it("changes when Frigate gives a known camera its attributes (Frigate loading late)", () => {
    const before = { "camera.yard": cam("camera.yard", { friendly_name: "Yard", restored: true }) };
    const after = {
      "camera.yard": cam("camera.yard", { client_id: "frigate", camera_name: "yard" }),
    };
    expect(frigateSignature(before)).toBe("");
    expect(frigateSignature(after)).toBe("camera.yard=frigate/yard");
  });

  it("ignores other entities and other camera attributes, in any order", () => {
    const a = {
      "camera.b": cam("camera.b", { client_id: "frigate", camera_name: "b", motion: "on" }),
      "camera.a": cam("camera.a", { client_id: "frigate", camera_name: "a" }),
      "sensor.x": cam("sensor.x", { client_id: "frigate", camera_name: "x" }),
    };
    const b = {
      "camera.a": cam("camera.a", { client_id: "frigate", camera_name: "a", motion: "off" }),
      "camera.b": cam("camera.b", { client_id: "frigate", camera_name: "b" }),
    };
    expect(frigateSignature(a)).toBe("camera.a=frigate/a,camera.b=frigate/b");
    expect(frigateSignature(b)).toBe(frigateSignature(a));
  });
});
