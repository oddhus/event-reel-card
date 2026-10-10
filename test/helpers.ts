import type { ReelEvent } from "../src/types";

let seq = 0;

export function ev(partial: Partial<ReelEvent> & { start: number }): ReelEvent {
  seq += 1;
  const provider = partial.provider ?? "entity";
  return {
    id: partial.id ?? `${provider}:${seq}`,
    provider,
    sources: partial.sources ?? [provider],
    title: partial.title ?? `event ${seq}`,
    category: partial.category ?? "custom",
    ...partial,
  };
}

export const iso = (s: string) => Date.parse(s) / 1000;
