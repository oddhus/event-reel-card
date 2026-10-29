// Maps the card config to the flat GUI editor form and back, without losing options the form
// doesn't show (per-entity names, provider details, aliases, ...). Pure.

import { normalizeConfig } from "./config";
import type { CardConfig, EntityConfig } from "./config";
import { parseRangeStrict } from "./core/time";

export interface EditorForm {
  title: string;
  density: "compact" | "comfortable";
  range: string;
  preview: "visible" | "hover" | "still" | "off";
  language: string;
  entities: string[];
  filters: boolean;
  day_strip: boolean;
  day_navigation: boolean;
  presence: boolean;
  event_reel_enabled: boolean;
  llmvision_enabled: boolean;
  llmvision_non_camera: boolean;
  frigate_enabled: boolean;
  frigate_show_unmatched: boolean;
  frigate_alerts_only: boolean;
  nest_enabled: boolean;
}

const rangeText = (r: CardConfig["range"]) =>
  r === undefined ? "24h" : typeof r === "number" ? `${r}h` : String(r);

export function configToForm(config: CardConfig): EditorForm {
  const n = normalizeConfig(config);
  return {
    title: n.title,
    density: n.density,
    range: rangeText(config.range),
    preview: n.preview,
    language: n.language,
    entities: n.entities.map((e) => e.entity),
    filters: n.filters,
    day_strip: n.dayStrip,
    day_navigation: n.dayNavigation,
    presence: n.presence !== undefined,
    event_reel_enabled: n.event_reel.enabled,
    llmvision_enabled: n.llmvision.enabled,
    llmvision_non_camera: n.llmvision.non_camera,
    frigate_enabled: n.frigate.enabled,
    frigate_show_unmatched: n.frigate.show_unmatched,
    frigate_alerts_only: n.frigate.severity.length === 1 && n.frigate.severity[0] === "alert",
    nest_enabled: n.nest.enabled,
  };
}

type Obj = Record<string, unknown>;

/** Writes `value` unless it equals the default and the key wasn't set before. */
function setOrDrop(out: Obj, original: Obj, key: string, value: unknown, fallback: unknown) {
  if (value === fallback && !(key in original)) delete out[key];
  else out[key] = value;
}

/**
 * Rebuilds a provider value. `options` maps keys to the desired value, or undefined to remove
 * the key (back to the default). Keeps every other key of an object value.
 */
function provider(
  original: unknown,
  enabled: boolean,
  options: Obj,
  // Required: passing undefined to a defaulted parameter would apply the default.
  initial: unknown,
): unknown {
  const base: Obj = original && typeof original === "object" ? { ...(original as Obj) } : {};
  delete base.enabled;
  for (const [k, v] of Object.entries(options)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  if (!enabled) return Object.keys(base).length ? { ...base, enabled: false } : false;
  if (Object.keys(base).length) return base;
  // Back to "auto" when it started out absent (or null), so no "not installed" warning.
  return original == null || initial == null ? undefined : true;
}

/** The initial config's severity list, unless it was the "alerts only" one (or missing). */
function customSeverity(initial: CardConfig): string[] | undefined {
  const f = initial.frigate;
  const s = f && typeof f === "object" ? f.severity : undefined;
  if (!Array.isArray(s) || (s.length === 1 && s[0] === "alert")) return undefined;
  return s;
}

function putProvider(out: Obj, key: string, value: unknown) {
  if (value === undefined) delete out[key];
  else out[key] = value;
}

/** A range the card understands: `today`, or a positive number of hours (`24`, `12h`). */
export function isValidRange(value: string): boolean {
  return parseRangeStrict(value) !== undefined;
}

/**
 * `initial` is the config the editor was opened with; a custom severity list from it is
 * restored when "alerts only" is switched off again.
 */
export function formToConfig(
  form: EditorForm,
  original: CardConfig,
  initial: CardConfig = original,
): CardConfig {
  const orig = original as unknown as Obj;
  const out: Obj = { ...orig };

  if (form.title) out.title = form.title;
  else delete out.title;
  setOrDrop(out, orig, "density", form.density ?? "compact", "compact");
  const range =
    form.range && isValidRange(form.range) ? form.range.trim() : rangeText(original.range);
  setOrDrop(out, orig, "range", range, "24h");
  setOrDrop(out, orig, "preview", form.preview ?? "visible", "visible");
  setOrDrop(out, orig, "language", form.language || "auto", "auto");
  setOrDrop(out, orig, "filters", form.filters ?? true, true);
  setOrDrop(out, orig, "day_strip", form.day_strip ?? true, true);
  setOrDrop(out, orig, "day_navigation", form.day_navigation ?? true, true);
  // On keeps a list of people written in YAML, also one switched off and on again in this
  // editor; off removes the key, the default.
  const people = [original.presence, initial.presence].find((p) => Array.isArray(p) && p.length);
  if (form.presence) out.presence = people ?? true;
  else delete out.presence;

  // Keep each remaining entity's own options; new ones are plain ids.
  const existing = new Map<string, string | EntityConfig>();
  for (const item of original.entities ?? []) {
    existing.set(typeof item === "string" ? item : item.entity, item);
  }
  const entities = (form.entities ?? []).map((id) => existing.get(id) ?? id);
  if (entities.length || "entities" in orig) out.entities = entities;

  putProvider(
    out,
    "event_reel",
    provider(original.event_reel, form.event_reel_enabled, {}, initial.event_reel),
  );

  const llm = original.llmvision;
  putProvider(
    out,
    "llmvision",
    provider(
      llm,
      form.llmvision_enabled,
      { non_camera: form.llmvision_non_camera ? undefined : false },
      initial.llmvision,
    ),
  );

  const frig = original.frigate;
  const severity = frig && typeof frig === "object" ? frig.severity : undefined;
  const alertsOnly = Array.isArray(severity) && severity.length === 1 && severity[0] === "alert";
  putProvider(
    out,
    "frigate",
    provider(
      frig,
      form.frigate_enabled,
      {
        show_unmatched: form.frigate_show_unmatched ? undefined : false,
        // Only touch severity when the toggle changed it; keep any other custom list.
        ...(form.frigate_alerts_only
          ? { severity: ["alert"] }
          : alertsOnly
            ? { severity: customSeverity(initial) }
            : {}),
      },
      initial.frigate,
    ),
  );

  putProvider(out, "nest", provider(original.nest, form.nest_enabled, {}, initial.nest));

  return out as unknown as CardConfig;
}
