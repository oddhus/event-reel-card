import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/config";
import type { Transition } from "../src/core/context";
import {
  computePresence,
  homeAt,
  homeDuring,
  initialsFor,
  pastDayTakesLive,
  presenceEntities,
  whileNobodyHome,
} from "../src/core/presence";
import { configToForm, formToConfig } from "../src/editor-model";
import { ev } from "./helpers";

const T0 = 1_800_000_000; // range start
const H = 3600;
const M = 60;
const range = { start: T0, end: T0 + 24 * H };
const after = T0 + 30 * H; // "now", past the range
const tr = (state: string, at: number): Transition => ({ state, at });
const people = [
  { entity: "person.alex", name: "Alex" },
  { entity: "person.sam", name: "Sam" },
];
const names = (list: { name: string }[]) => list.map((p) => p.name);

describe("presence config", () => {
  const presence = (value: unknown) =>
    normalizeConfig({ type: "custom:event-reel-card", presence: value } as never).presence;

  it("is off when left out, false or empty", () => {
    expect(presence(undefined)).toBeUndefined();
    expect(presence(false)).toBeUndefined();
    expect(presence([])).toBeUndefined();
  });

  it("watches every person for true", () => {
    expect(presence(true)).toEqual({ people: [] });
  });

  it("reads ids and names", () => {
    expect(presence(["person.alex", { entity: "device_tracker.sam_phone", name: "Sam" }])).toEqual({
      people: [{ entity: "person.alex" }, { entity: "device_tracker.sam_phone", name: "Sam" }],
    });
  });

  it("drops an empty name, so the friendly name is used", () => {
    expect(
      presence([
        { entity: "person.alex", name: "  " },
        { entity: "person.sam", name: " Sam " },
      ]),
    ).toEqual({
      people: [{ entity: "person.alex" }, { entity: "person.sam", name: "Sam" }],
    });
  });

  it("refuses a malformed id or a plain string", () => {
    expect(() => presence(["Person.Alex"])).toThrow(/presence/);
    expect(() => presence("person.alex")).toThrow(/presence/);
  });

  it("takes every person entity, sorted, for true; the configured ones otherwise", () => {
    const ids = ["person.sam", "light.hall", "device_tracker.phone", "person.alex"];
    expect(presenceEntities({ people: [] }, ids)).toEqual(["person.alex", "person.sam"]);
    expect(presenceEntities({ people: [{ entity: "device_tracker.phone" }] }, ids)).toEqual([
      "device_tracker.phone",
    ]);
  });
});

describe("initials", () => {
  it("uses the first letter when it is unique", () => {
    expect(initialsFor(["Alex", "Sam", "Åse Marie"])).toEqual(["A", "S", "Å"]);
  });

  it("adds the last word's letter for people who share a first letter", () => {
    expect(initialsFor(["Anna Berg", "Anna Dahl", "Sam"])).toEqual(["AB", "AD", "S"]);
  });

  it("falls back to two letters for one-word names that share a first letter", () => {
    expect(initialsFor(["Kari", "Knut"])).toEqual(["KA", "KN"]);
  });

  it("adds a letter when two letters still clash", () => {
    expect(initialsFor(["Kari Nordmann", "Kari Nilsen"])).toEqual(["KNO", "KNI"]);
    expect(initialsFor(["Ola", "Ole"])).toEqual(["OLA", "OLE"]);
  });

  it("checks every label against the others, not only those that clashed first", () => {
    expect(initialsFor(["Anna Berg", "Alex Brown", "Alfred"])).toEqual(["ABE", "ABR", "AL"]);
  });
});

describe("who was home", () => {
  // Both home from before the range; Alex out 08–17, Sam out 09–18.
  const day = new Map([
    ["person.alex", [tr("home", T0 - 600), tr("not_home", T0 + 8 * H), tr("home", T0 + 17 * H)]],
    ["person.sam", [tr("home", T0 - 600), tr("not_home", T0 + 9 * H), tr("home", T0 + 18 * H)]],
  ]);
  const p = computePresence(people, day, range, after);

  it("lists the people home at a time", () => {
    expect(names(homeAt(p, T0 + 2 * H))).toEqual(["Alex", "Sam"]);
    expect(names(homeAt(p, T0 + 8.5 * H))).toEqual(["Sam"]);
    expect(names(homeAt(p, T0 + 12 * H))).toEqual([]);
    expect(names(homeAt(p, T0 + 17.5 * H))).toEqual(["Alex"]);
  });

  it("flags an event while nobody is home, but not within ten minutes of leaving or coming back", () => {
    expect(whileNobodyHome(p, ev({ start: T0 + 12 * H }))).toBe(true);
    expect(whileNobodyHome(p, ev({ start: T0 + 9 * H + 5 * M }))).toBe(false);
    expect(whileNobodyHome(p, ev({ start: T0 + 9 * H + 11 * M }))).toBe(true);
    expect(whileNobodyHome(p, ev({ start: T0 + 17 * H - 5 * M }))).toBe(false);
    expect(whileNobodyHome(p, ev({ start: T0 + 17 * H - 11 * M }))).toBe(true);
    expect(whileNobodyHome(p, ev({ start: T0 + 8.5 * H }))).toBe(false);
  });

  it("doesn't flag a tracked person's own state change", () => {
    expect(whileNobodyHome(p, ev({ start: T0 + 12 * H, entityId: "person.sam" }))).toBe(false);
    expect(whileNobodyHome(p, ev({ start: T0 + 12 * H, entityId: "lock.front" }))).toBe(true);
  });

  it("doesn't flag presence events from another tracker or an AI source", () => {
    const tracker = ev({
      start: T0 + 12 * H,
      entityId: "device_tracker.sam_phone",
      category: "presence",
    });
    const ai = ev({ start: T0 + 12 * H, provider: "llmvision", category: "presence" });
    expect(whileNobodyHome(p, tracker)).toBe(false);
    expect(whileNobodyHome(p, ai)).toBe(false);
  });

  it("gives a group the people home at any of its events", () => {
    const group = [ev({ start: T0 + 8.5 * H }), ev({ start: T0 + 17.5 * H })];
    expect(names(homeDuring(p, group))).toEqual(["Alex", "Sam"]);
  });

  it("keeps someone home through an unavailable state and a trip under five minutes", () => {
    const flaky = new Map([
      [
        "person.alex",
        [
          tr("home", T0 - 600),
          tr("unavailable", T0 + 3 * H),
          tr("home", T0 + 3 * H + 2 * M),
          tr("not_home", T0 + 5 * H),
          tr("home", T0 + 5 * H + 2 * M),
        ],
      ],
    ]);
    const q = computePresence(people.slice(0, 1), flaky, range, after);
    expect(names(homeAt(q, T0 + 3 * H + M))).toEqual(["Alex"]);
    expect(names(homeAt(q, T0 + 5 * H + M))).toEqual(["Alex"]);
    expect(whileNobodyHome(q, ev({ start: T0 + 5 * H + M }))).toBe(false);
  });

  it("flags from the range start when nobody was home before it", () => {
    const away = new Map([
      ["person.alex", [tr("not_home", T0 - 600)]],
      ["person.sam", [tr("not_home", T0 - 3 * H)]],
    ]);
    const q = computePresence(people, away, range, after);
    expect(whileNobodyHome(q, ev({ start: T0 + M }))).toBe(true);
    expect(whileNobodyHome(q, ev({ start: range.end - M }))).toBe(true);
  });

  it("leaves out a person with no known state, and can't say nobody is home before one is known", () => {
    const partial = new Map([
      ["person.alex", [tr("not_home", T0 - 600)]],
      ["person.sam", [tr("unknown", T0 - 600), tr("not_home", T0 + 5 * H)]],
      ["person.kim", [tr("unavailable", T0 - 600)]],
    ]);
    const q = computePresence(
      [...people, { entity: "person.kim", name: "Kim" }],
      partial,
      range,
      after,
    );
    expect(names(q.people)).toEqual(["Alex", "Sam"]);
    expect(whileNobodyHome(q, ev({ start: T0 + 2 * H }))).toBe(false);
    expect(names(homeAt(q, T0 + 2 * H))).toEqual([]);
    expect(whileNobodyHome(q, ev({ start: T0 + 6 * H }))).toBe(true);
  });

  it("never counts the house empty while someone listed by hand has no known state", () => {
    const partial = new Map([
      ["person.alex", [tr("not_home", T0 - 600)]],
      ["person.sam", [tr("unknown", T0 - 600)]],
    ]);
    const listed = people.map((p) => ({ ...p, listed: true }));
    const q = computePresence(listed, partial, range, after);
    expect(whileNobodyHome(q, ev({ start: T0 + 6 * H }))).toBe(false);
    expect(names(homeAt(q, T0 + 6 * H))).toEqual([]);
  });

  it("counts a visit home shorter than a minute", () => {
    const visit = new Map([
      [
        "person.alex",
        [tr("not_home", T0 - 600), tr("home", T0 + 5 * H), tr("not_home", T0 + 5 * H + 30)],
      ],
    ]);
    const q = computePresence(people.slice(0, 1), visit, range, after);
    expect(names(homeAt(q, T0 + 5 * H + 15))).toEqual(["Alex"]);
    expect(whileNobodyHome(q, ev({ start: T0 + 5 * H + 15 }))).toBe(false);
    expect(whileNobodyHome(q, ev({ start: T0 + 4 * H }))).toBe(true);
  });

  it("allows for an arrival just after a past day's end", () => {
    const late = new Map([
      ["person.alex", [tr("not_home", T0 - 600), tr("home", range.end + 2 * M)]],
    ]);
    const q = computePresence(people.slice(0, 1), late, range, after);
    expect(whileNobodyHome(q, ev({ start: range.end - 5 * M }))).toBe(false);
    expect(whileNobodyHome(q, ev({ start: range.end - 20 * M }))).toBe(true);
  });

  it("leaves out an entity that doesn't exist, even with recorded history", () => {
    // Sam was removed; the recorder still has a state from noon.
    const removed = new Map([
      ["person.alex", [tr("not_home", T0 - 600)]],
      ["person.sam", [tr("not_home", T0 + 12 * H)]],
    ]);
    const listed = [
      { ...people[0], listed: true },
      { ...people[1], listed: true, exists: false },
    ];
    const q = computePresence(listed, removed, range, after);
    expect(names(q.people)).toEqual(["Alex"]);
    expect(whileNobodyHome(q, ev({ start: T0 + 6 * H }))).toBe(true);
  });

  it("flags nothing without anyone to watch", () => {
    const q = computePresence(people, new Map(), range, after);
    expect(q.people).toEqual([]);
    expect(whileNobodyHome(q, ev({ start: T0 + H }))).toBe(false);
  });

  it("flags an event right now in the live range once the grace after leaving has passed", () => {
    const now = T0 + 12 * H;
    const live = new Map([
      ["person.alex", [tr("home", T0 - 600), tr("not_home", T0 + 11 * H)]],
      ["person.sam", [tr("not_home", T0 - 600)]],
    ]);
    const q = computePresence(people, live, { start: T0, end: now }, now);
    expect(whileNobodyHome(q, ev({ start: T0 + 11 * H + 5 * M }))).toBe(false);
    expect(whileNobodyHome(q, ev({ start: now - M }))).toBe(true);
    // Someone home through to now: nothing flagged.
    const home = new Map([["person.alex", [tr("home", T0 - 600)]]]);
    const r = computePresence(people, home, { start: T0, end: now }, now);
    expect(whileNobodyHome(r, ev({ start: now - M }))).toBe(false);
  });
});

describe("presence in the editor", () => {
  const base = { type: "custom:event-reel-card" };

  it("is off without the key, and switching it on writes true", () => {
    expect(configToForm(base).presence).toBe(false);
    const on = formToConfig({ ...configToForm(base), presence: true }, base);
    expect(on.presence).toBe(true);
    const off = formToConfig({ ...configToForm(on), presence: false }, on, base);
    expect("presence" in off).toBe(false);
  });

  it("keeps a list of people from YAML, also after switching it off and on", () => {
    const yaml = { ...base, presence: ["person.alex", { entity: "person.sam", name: "Sam" }] };
    expect(configToForm(yaml).presence).toBe(true);
    expect(formToConfig({ ...configToForm(yaml), title: "Home" }, yaml).presence).toEqual(
      yaml.presence,
    );
    const off = formToConfig({ ...configToForm(yaml), presence: false }, yaml, yaml);
    const on = formToConfig({ ...configToForm(off), presence: true }, off, yaml);
    expect(on.presence).toEqual(yaml.presence);
  });
});

describe("live changes on a past day", () => {
  const dayEnd = T0 + 24 * H;

  it("takes them until ten minutes past the day's end, with presence", () => {
    expect(pastDayTakesLive(dayEnd, dayEnd + 2 * M, true)).toBe(true);
    expect(pastDayTakesLive(dayEnd, dayEnd + 9 * M, true)).toBe(true);
    expect(pastDayTakesLive(dayEnd, dayEnd + 10 * M, true)).toBe(false);
    expect(pastDayTakesLive(dayEnd, dayEnd + 3 * H, true)).toBe(false);
  });

  it("never takes them without presence", () => {
    expect(pastDayTakesLive(dayEnd, dayEnd + 2 * M, false)).toBe(false);
  });
});
