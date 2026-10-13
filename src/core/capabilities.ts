// What is installed, so optional providers can be skipped quietly (PLAN.md §3.8).

import type { NormalizedConfig } from "../config";
import type { HomeAssistant } from "../ha-types";
import type { CameraRegistry } from "./cameras";

export interface Capabilities {
  llmvision: boolean;
  event_reel: boolean;
  frigate: boolean;
  nest: boolean;
}

export function detectCapabilities(hass: HomeAssistant, cameras: CameraRegistry): Capabilities {
  const components = hass.config?.components ?? [];
  return {
    llmvision: !!hass.services?.llmvision?.get_events,
    event_reel: !!hass.services?.event_reel?.get_events,
    frigate: cameras.frigateInstances().length > 0,
    nest: components.includes("nest"),
  };
}

export type ProviderStatus = "active" | "off" | "missing";

/** "missing" is shown as a warning only for providers the user configured explicitly. */
export function providerStatus(
  type: "entity" | "llmvision" | "event_reel" | "frigate",
  config: NormalizedConfig,
  caps: Capabilities,
): ProviderStatus {
  if (type === "entity") return config.entities.length ? "active" : "off";
  const toggle = config[type];
  if (!toggle.enabled) return "off";
  return caps[type] ? "active" : "missing";
}
