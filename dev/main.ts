import type { CardConfig } from "../src/config";
import { mountCard, parseSlow } from "./mount";

// URL options:
//   ?now=2026-10-08T21:00:00+02:00   pin the clock
//   ?live=1                          real Frigate reviews and media through the Vite proxy (FRIGATE_URL)
//   ?density=comfortable             row density
//   ?ai=event_reel                   AI text from the Event Reel integration instead of LLM
//                                    Vision (?ai=both: both, the same moments described twice)
//   ?slow=frigate:5,llmvision:hang   delay a source by seconds, or never answer
//                                    (also: entity, nest, history for actors)
//   ?presence=0 / ?context=0         no presence marks / no context bands
//   ?filters=0 / ?max=20             no chip bar / a row cap
const params = new URLSearchParams(location.search);

// Optional private snapshots (gitignored): dev/fixtures/llmvision.local.json, logbook.local.json.
const localFiles = import.meta.glob<{ default: unknown }>("./fixtures/*.local.json", {
  eager: true,
});

const stage = document.getElementById("stage")!;
const dark = document.getElementById("dark") as HTMLInputElement;
const narrow = document.getElementById("narrow") as HTMLInputElement;
const lang = document.getElementById("lang") as HTMLSelectElement;

const config: Partial<CardConfig> = {
  density: (params.get("density") as "compact" | "comfortable") ?? "compact",
  ...(params.get("max") ? { max_events: Number(params.get("max")) } : {}),
  ...(params.get("context") === "0" ? { context: undefined } : {}),
  ...(params.get("filters") === "0" ? { filters: false } : {}),
  ...(params.get("presence") === "0" ? { presence: undefined } : {}),
};

const mounted = await mountCard({
  now: params.get("now") ?? undefined,
  parent: stage,
  config,
  slow: parseSlow(params.get("slow")),
  ai: (params.get("ai") as "llmvision" | "event_reel" | "both" | null) ?? "llmvision",
  language: lang.value,
  dark: dark.checked,
  live: params.get("live") === "1",
  local: (name) => localFiles[`./fixtures/${name}.local.json`]?.default,
});

function apply() {
  document.body.classList.toggle("dark", dark.checked);
  stage.classList.toggle("narrow", narrow.checked);
  mounted.setHass({ language: lang.value, dark: dark.checked });
}

for (const el of [dark, narrow, lang]) el.addEventListener("change", apply);
apply();
