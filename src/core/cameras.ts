// Camera registry: maps every identifier a provider may use (camera entity, Frigate object
// image, Frigate camera name, Nest device, alias) to one canonical key, the HA camera entity id.
// Pure: built from plain data so it can be unit tested without `hass`.

import type { HassEntity, HassEntityRegistryEntry } from "../ha-types";
import type { FrigateRef } from "../types";

export interface CameraInfo {
  key: string;
  name: string;
  deviceId?: string;
  platform?: string;
  frigate?: Omit<FrigateRef, "reviewId">;
}

export interface CameraRegistryInput {
  states: Record<string, HassEntity>;
  entities: Record<string, HassEntityRegistryEntry>;
  aliases?: Record<string, string>;
}

export interface CameraRegistry {
  get(key: string): CameraInfo | undefined;
  all(): CameraInfo[];
  /** Resolves a camera entity, image entity or alias to a canonical camera key. Never guesses. */
  resolve(id: string): string | undefined;
  /** Canonical key for a Frigate camera of an instance. */
  byFrigate(instance: string, camera: string): string | undefined;
  /** Canonical key for the camera entity on a device (e.g. a Nest device id). */
  byDevice(deviceId: string, preferPlatform?: string): string | undefined;
  /** Frigate instance ids in use. */
  frigateInstances(): string[];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

export function buildCameraRegistry(input: CameraRegistryInput): CameraRegistry {
  const cameras = new Map<string, CameraInfo>();
  const frigateIndex = new Map<string, string>();
  const deviceIndex = new Map<string, CameraInfo[]>();
  const aliases = input.aliases ?? {};

  for (const [entityId, state] of Object.entries(input.states)) {
    if (!entityId.startsWith("camera.")) continue;
    const reg = input.entities[entityId];
    const instance = str(state.attributes.client_id);
    const frigateCamera = str(state.attributes.camera_name);
    const info: CameraInfo = {
      key: entityId,
      name: str(state.attributes.friendly_name) ?? entityId,
      deviceId: reg?.device_id ?? undefined,
      platform: reg?.platform,
      frigate: instance && frigateCamera ? { instance, camera: frigateCamera } : undefined,
    };
    cameras.set(entityId, info);
    if (info.frigate) frigateIndex.set(`${info.frigate.instance}/${info.frigate.camera}`, entityId);
    if (info.deviceId) {
      const list = deviceIndex.get(info.deviceId) ?? [];
      list.push(info);
      deviceIndex.set(info.deviceId, list);
    }
  }

  /** Follows an alias whose target is a camera, so every provider lands on the same key. */
  const canonical = (key: string | undefined): string | undefined => {
    if (!key) return undefined;
    const target = aliases[key];
    return target && (cameras.has(target) || target.startsWith("camera.")) ? target : key;
  };

  const byDevice = (deviceId: string, preferPlatform?: string): string | undefined => {
    const list = deviceIndex.get(deviceId);
    if (!list?.length) return undefined;
    const preferred = preferPlatform && list.find((c) => c.platform === preferPlatform);
    return canonical((preferred || list[0]).key);
  };

  const resolveDirect = (id: string): string | undefined => {
    if (cameras.has(id)) return canonical(id);
    if (id.startsWith("image.")) {
      const deviceId = input.entities[id]?.device_id;
      return deviceId ? byDevice(deviceId, "frigate") : undefined;
    }
    return undefined;
  };

  return {
    get: (key) => cameras.get(key),
    all: () => [...cameras.values()],
    resolve(id) {
      if (!id) return undefined;
      const alias = aliases[id];
      if (alias) return resolveDirect(alias) ?? (alias.startsWith("camera.") ? alias : undefined);
      return resolveDirect(id);
    },
    byFrigate: (instance, camera) => canonical(frigateIndex.get(`${instance}/${camera}`)),
    byDevice,
    frigateInstances: () => [
      ...new Set([...cameras.values()].flatMap((c) => (c.frigate ? [c.frigate.instance] : []))),
    ],
  };
}

/** LLM Vision stores the last path segment of a Nest attachment (base64 of a JSON array) as camera_name. */
export function isNestToken(value: string): boolean {
  if (!value || value.includes(".") || value.length < 8) return false;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return false;
  try {
    const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return decoded.startsWith("[") && decoded.endsWith("]");
  } catch {
    return false;
  }
}
