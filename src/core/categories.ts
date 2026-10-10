import type { Category, ReelEvent } from "../types";

const LABELS: Record<string, Category> = {
  person: "person",
  face: "person",
  car: "vehicle",
  truck: "vehicle",
  bus: "vehicle",
  motorcycle: "vehicle",
  bicycle: "vehicle",
  boat: "vehicle",
  vehicle: "vehicle",
  license_plate: "vehicle",
  dog: "animal",
  cat: "animal",
  bird: "animal",
  horse: "animal",
  deer: "animal",
  bear: "animal",
  fox: "animal",
  animal: "animal",
  package: "package",
  doorbell: "doorbell",
  door: "door",
  lock: "lock",
  presence: "presence",
  alarm: "alarm",
  motion: "motion",
};

/** Category for a detector label or a free-form category string; undefined when unknown. */
export function categoryFromLabel(label: string | undefined | null): Category | undefined {
  if (!label) return undefined;
  return LABELS[label.toLowerCase().trim()];
}

const DOOR_CLASSES = new Set(["door", "garage_door", "window", "opening"]);

export function categoryForEntity(entityId: string, deviceClass?: unknown): Category {
  const domain = entityId.split(".")[0];
  switch (domain) {
    case "lock":
      return "lock";
    case "person":
    case "device_tracker":
      return "presence";
    case "alarm_control_panel":
      return "alarm";
    case "calendar":
      return "calendar";
    case "binary_sensor":
      if (typeof deviceClass === "string" && DOOR_CLASSES.has(deviceClass)) return "door";
      if (deviceClass === "motion" || deviceClass === "occupancy") return "motion";
      return "custom";
    default:
      return "custom";
  }
}

const CATEGORY_ICONS: Record<Category, string> = {
  person: "mdi:walk",
  vehicle: "mdi:car",
  animal: "mdi:paw",
  package: "mdi:package-variant-closed",
  doorbell: "mdi:doorbell-video",
  motion: "mdi:motion-sensor",
  door: "mdi:door",
  lock: "mdi:lock-outline",
  presence: "mdi:account",
  alarm: "mdi:shield-home",
  calendar: "mdi:calendar",
  custom: "mdi:timeline-clock-outline",
};

export function iconFor(e: Pick<ReelEvent, "icon" | "category" | "state">): string {
  if (e.icon) return e.icon;
  switch (e.category) {
    case "lock":
      if (e.state === "locked") return "mdi:lock";
      if (e.state === "unlocked" || e.state === "open") return "mdi:lock-open-variant";
      if (e.state === "jammed") return "mdi:lock-alert";
      break;
    case "door":
      if (e.state === "on") return "mdi:door-open";
      if (e.state === "off") return "mdi:door-closed";
      break;
    case "presence":
      if (e.state === "home") return "mdi:home-account";
      if (e.state === "not_home") return "mdi:home-export-outline";
      return "mdi:map-marker-account";
  }
  return CATEGORY_ICONS[e.category];
}

/** HA color variables per category (theme-aware). */
export const CATEGORY_COLORS: Record<Category, string> = {
  person: "var(--blue-color, #2196f3)",
  vehicle: "var(--indigo-color, #3f51b5)",
  animal: "var(--brown-color, #795548)",
  package: "var(--amber-color, #ffc107)",
  doorbell: "var(--orange-color, #ff9800)",
  motion: "var(--grey-color, #9e9e9e)",
  door: "var(--teal-color, #009688)",
  lock: "var(--purple-color, #9c27b0)",
  presence: "var(--green-color, #4caf50)",
  alarm: "var(--red-color, #f44336)",
  calendar: "var(--cyan-color, #00bcd4)",
  custom: "var(--grey-color, #9e9e9e)",
};
