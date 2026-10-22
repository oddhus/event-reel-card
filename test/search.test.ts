import { describe, expect, it } from "vitest";
import { applyFilters, searchAccept, visibleRows } from "../src/core/filters";
import { groupTimeline } from "../src/core/grouping";
import type { TimelineItem } from "../src/core/grouping";
import { countMatches, foldText, matchesTerms, queryTerms, searchItems } from "../src/core/search";
import type { ReelEvent } from "../src/types";
import { ev } from "./helpers";

// The card's text function adds camera names and labels; tests use the plain fields.
const textOf = (e: ReelEvent) =>
  [e.title, e.stateLabel, e.description, e.actor, ...(e.people ?? [])].filter(Boolean).join("\n");

const ids = (items: TimelineItem[]) =>
  items.map((i) =>
    i.kind === "event" ? i.event.id : `${i.kind}:${i.events.map((e) => e.id).join("+")}`,
  );

describe("query terms", () => {
  it("folds case and accents and splits on any whitespace", () => {
    expect(queryTerms("  Café   PÅ\tdøra ")).toEqual(["cafe", "pa", "døra"]);
  });

  it("is empty for a blank or missing query", () => {
    expect(queryTerms("   ")).toEqual([]);
    expect(queryTerms(undefined)).toEqual([]);
  });

  it("keeps letters that don't decompose, such as ø and æ", () => {
    expect(foldText("Kjøkken Æble")).toBe("kjøkken æble");
  });

  it("needs every term, in any order and anywhere in the text", () => {
    expect(matchesTerms("A person carries a Package to the door", ["package", "person"])).toBe(
      true,
    );
    expect(matchesTerms("A person walks by", ["package", "person"])).toBe(false);
    expect(matchesTerms("Leverte en pakke på trappa", ["pa", "trapp"])).toBe(true);
  });
});

describe("searchItems", () => {
  const delivery = ev({
    id: "frigate:1",
    provider: "frigate",
    start: 1000,
    end: 1030,
    camera: "camera.entrance",
    category: "person",
    title: "Person at Entrance",
    description: "A courier leaves a package on the steps",
  });
  const walker = ev({
    id: "frigate:2",
    provider: "frigate",
    start: 1060,
    end: 1080,
    camera: "camera.entrance",
    category: "person",
    title: "Person at Entrance",
    description: "Someone walks past",
  });
  const pickup = ev({
    id: "frigate:3",
    provider: "frigate",
    start: 1110,
    end: 1130,
    camera: "camera.entrance",
    category: "person",
    title: "Person at Entrance",
    description: "Alex picks up the package",
  });
  const unlock = ev({
    id: "entity:1",
    start: 5000,
    title: "Front door",
    stateLabel: "Unlocked",
    category: "lock",
    entityId: "lock.front_door",
    actor: "Keypad",
  });
  const open = ev({
    id: "entity:2",
    start: 5004,
    title: "Front door",
    stateLabel: "Open",
    category: "door",
    entityId: "binary_sensor.front_door",
  });
  const home = ev({
    id: "entity:3",
    start: 9000,
    title: "Sam",
    stateLabel: "Home",
    category: "presence",
    entityId: "person.sam",
  });
  const items = groupTimeline([delivery, walker, pickup, unlock, open, home], { window: 120 });

  it("starts from one camera group, one burst and one presence row", () => {
    expect(ids(items)).toEqual([
      "entity:3",
      "burst:entity:1+entity:2",
      "camera:frigate:1+frigate:2+frigate:3",
    ]);
  });

  it("returns the items unchanged without terms", () => {
    expect(searchItems(items, [], textOf)).toBe(items);
  });

  it("narrows a camera group to its matching events, keeping its id", () => {
    const out = searchItems(items, ["package"], textOf);
    expect(ids(out)).toEqual(["camera:frigate:1+frigate:3"]);
    const group = out[0];
    expect(group.kind).toBe("camera");
    expect(group.id).toBe(items[2].id);
    expect([group.start, group.end, group.sortTime]).toEqual([1000, 1130, 1110]);
  });

  it("turns a camera group with one match into a row of its own", () => {
    const out = searchItems(items, ["courier"], textOf);
    expect(out).toEqual([
      { kind: "event", id: "frigate:1", event: delivery, sortTime: 1000, start: 1000, end: 1030 },
    ]);
  });

  it("keeps a whole burst when one of its steps matches", () => {
    expect(ids(searchItems(items, ["keypad"], textOf))).toEqual(["burst:entity:1+entity:2"]);
  });

  it("matches across fields: a word from the title and one from the description", () => {
    expect(ids(searchItems(items, ["entrance", "alex"], textOf))).toEqual(["frigate:3"]);
  });

  it("drops rows without a match", () => {
    expect(searchItems(items, ["garage"], textOf)).toEqual([]);
  });

  it("keeps rows newest first after a group narrows to an older event", () => {
    const later = ev({
      id: "entity:9",
      start: 1100,
      title: "Package room",
      stateLabel: "Open",
      category: "door",
      entityId: "binary_sensor.package_room",
    });
    // The narrowed group (sortTime 1000) now sorts after the door change at 1100.
    const list = groupTimeline([delivery, walker, later], { window: 10 });
    const out = searchItems(list, ["package"], textOf);
    expect(out.map((i) => i.sortTime)).toEqual([1100, 1000]);
  });
});

describe("search with the other filters", () => {
  const garage = ev({
    id: "frigate:g",
    provider: "frigate",
    start: 100,
    end: 120,
    camera: "camera.garage",
    category: "vehicle",
    title: "Car at Garage",
    description: "A delivery van parks",
  });
  const door = ev({
    id: "frigate:d",
    provider: "frigate",
    start: 400,
    end: 420,
    camera: "camera.entrance",
    category: "person",
    title: "Person at Entrance",
    description: "A delivery person rings the bell",
  });
  const items = groupTimeline([garage, door], { window: 60 });

  it("applies the query together with a category", () => {
    const out = applyFilters(
      items,
      { categories: new Set(["vehicle"]), query: "delivery" },
      textOf,
    );
    expect(ids(out)).toEqual(["frigate:g"]);
  });

  it("applies the query together with a camera", () => {
    const out = applyFilters(
      items,
      { categories: new Set(), camera: "camera.entrance", query: "delivery" },
      textOf,
    );
    expect(ids(out)).toEqual(["frigate:d"]);
  });

  it("ignores the query when no text function is given", () => {
    expect(applyFilters(items, { categories: new Set(), query: "nothing" })).toBe(items);
  });

  it("caps after searching, so an older match still shows", () => {
    const newer = Array.from({ length: 5 }, (_, n) =>
      ev({ id: `entity:n${n}`, start: 1000 + n * 600, title: "Hall light", category: "custom" }),
    );
    const list = groupTimeline([garage, ...newer], { window: 60 });
    const r = visibleRows(list, { categories: new Set(), query: "van" }, 2, undefined, textOf);
    expect(ids(r.list)).toEqual(["frigate:g"]);
    expect(r.hidden).toBe(0);
  });
});

describe("search edge cases", () => {
  const a = ev({
    id: "frigate:a",
    provider: "frigate",
    start: 100,
    end: 110,
    camera: "camera.yard",
    category: "person",
    title: "Person at Yard",
    description: "Carries a ladder",
  });
  const b = ev({
    id: "frigate:b",
    provider: "frigate",
    start: 130,
    end: 140,
    camera: "camera.yard",
    category: "person",
    title: "Person at Yard",
    description: "Waters the plants",
  });
  const unlock = ev({
    id: "entity:u",
    start: 500,
    title: "Shed",
    stateLabel: "Unlocked",
    category: "lock",
    entityId: "lock.shed",
  });
  const opened = ev({
    id: "entity:o",
    start: 504,
    title: "Shed door",
    stateLabel: "Open",
    category: "door",
    entityId: "binary_sensor.shed_door",
    actor: "Robin",
  });
  const items = groupTimeline([a, b, unlock, opened], { window: 60 });

  it("keeps a burst whose later step is the only match", () => {
    expect(ids(searchItems(items, ["robin"], textOf))).toEqual(["burst:entity:u+entity:o"]);
  });

  it("drops a group when its words match different events but no single one", () => {
    expect(searchItems(items, ["ladder", "plants"], textOf)).toEqual([]);
  });

  it("counts matching events, not rows, and not a burst's other steps", () => {
    // "yard" matches both events of the camera group (one row); "shed" matches both steps.
    expect(countMatches(items, ["yard"], textOf)).toBe(2);
    expect(countMatches(items, ["robin"], textOf)).toBe(1);
    expect(countMatches(items, ["shed"], textOf)).toBe(2);
    expect(countMatches(items, ["nobody"], textOf)).toBe(0);
  });
});

describe("search under a category chip", () => {
  const person = ev({
    id: "frigate:p",
    provider: "frigate",
    start: 100,
    end: 110,
    camera: "camera.drive",
    category: "person",
    title: "Person at Drive",
    description: "Walks to the mailbox",
  });
  const van = ev({
    id: "frigate:v",
    provider: "frigate",
    start: 130,
    end: 150,
    camera: "camera.drive",
    category: "vehicle",
    title: "Car at Drive",
    description: "A white van stops",
  });
  const items = groupTimeline([person, van], { window: 60 });

  it("needs the chip and the query to hold for the same event", () => {
    expect(ids(items)).toEqual(["camera:frigate:p+frigate:v"]);
    const state = { categories: new Set(["person" as const]), query: "van" };
    expect(applyFilters(items, state, textOf)).toEqual([]);
    expect(countMatches(items, ["van"], textOf, searchAccept(state))).toBe(0);
  });

  it("finds the event of the chosen category in a mixed group", () => {
    const out = applyFilters(
      items,
      { categories: new Set(["vehicle" as const]), query: "drive" },
      textOf,
    );
    expect(ids(out)).toEqual(["frigate:v"]);
  });
});
