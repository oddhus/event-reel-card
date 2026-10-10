import type { Localize } from "../types";
import { en } from "./en";
import type { Strings } from "./en";
import { nb } from "./nb";

const languages: Record<string, Strings> = { en, nb };

/** Maps a configured or HA language to a supported one (`nb`, `nn`, `no` → `nb`; else `en`). */
export function resolveLanguage(configured: string, haLanguage: string | undefined): string {
  const lang = (
    configured && configured !== "auto" ? configured : haLanguage || "en"
  ).toLowerCase();
  const base = lang.split(/[-_]/)[0];
  if (base === "nb" || base === "nn" || base === "no") return "nb";
  return languages[base] ? base : "en";
}

export function getLocalize(language: string): Localize {
  const strings = languages[language] ?? en;
  return (key, params) => {
    let s: string =
      (strings as Record<string, string>)[key] ?? (en as Record<string, string>)[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
    }
    return s;
  };
}

/** Localized object label with a capitalized fallback for labels without a translation. */
export function objectLabel(localize: Localize, label: string): string {
  const key = `object.${label}`;
  const s = localize(key);
  if (s !== key) return s;
  const plain = label.replace(/_/g, " ");
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}
