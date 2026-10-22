// Free-text search over timeline items (PLAN.md §5.1). Pure.

import type { ReelEvent } from "../types";
import { eventItem, latest, span } from "./grouping";
import type { TimelineItem } from "./grouping";

/** Lower case without accents, so "Cafe" finds "café" and "pa" finds "på". */
export function foldText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The words of a query, folded; empty when there is nothing to search for. */
export function queryTerms(query: string | undefined): string[] {
  return query ? foldText(query).split(/\s+/).filter(Boolean) : [];
}

/** True when the text holds every term, anywhere and in any order. */
export function matchesTerms(text: string, terms: string[]): boolean {
  const folded = foldText(text);
  return terms.every((term) => folded.includes(term));
}

/** Events among these items that match every term (a whole burst may hold others). */
export function countMatches(
  items: TimelineItem[],
  terms: string[],
  textOf: (e: ReelEvent) => string,
  accept: (e: ReelEvent) => boolean = () => true,
): number {
  let n = 0;
  for (const item of items) {
    for (const e of item.kind === "event" ? [item.event] : item.events) {
      if (accept(e) && matchesTerms(textOf(e), terms)) n += 1;
    }
  }
  return n;
}

/**
 * The items with an event that matches every term, where `textOf` gives the searchable text
 * of an event (what its row and detail show). A camera group narrows to its matching events,
 * or to a row of its own when one is left; a burst stays whole, since its steps read as one
 * line. `accept` limits which events can be a match, so a category chip and a query must hold
 * for the same event. Newest first.
 */
export function searchItems(
  items: TimelineItem[],
  terms: string[],
  textOf: (e: ReelEvent) => string,
  accept: (e: ReelEvent) => boolean = () => true,
): TimelineItem[] {
  if (!terms.length) return items;
  const hit = (e: ReelEvent) => accept(e) && matchesTerms(textOf(e), terms);
  const out: TimelineItem[] = [];
  for (const item of items) {
    if (item.kind === "event") {
      if (hit(item.event)) out.push(item);
    } else if (item.kind === "burst") {
      if (item.events.some(hit)) out.push(item);
    } else {
      const events = item.events.filter(hit);
      if (events.length === item.events.length) out.push(item);
      else if (events.length === 1) out.push(eventItem(events[0]));
      else if (events.length) {
        out.push({ ...item, events, sortTime: latest(events), ...span(events) });
      }
    }
  }
  return out.sort((a, b) => b.sortTime - a.sortTime);
}
