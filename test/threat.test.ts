import { describe, expect, it } from "vitest";
import { highestThreat, withFlagged } from "../src/core/threat";
import { ev } from "./helpers";

describe("highestThreat", () => {
  it("returns the highest level for mixed events", () => {
    expect(
      highestThreat([ev({ start: 1, threat: 1 }), ev({ start: 2, threat: 2 }), ev({ start: 3 })]),
    ).toBe(2);
  });

  it("returns 1 when only level 1 is present", () => {
    expect(highestThreat([ev({ start: 1 }), ev({ start: 2, threat: 1 })])).toBe(1);
  });

  it("returns undefined for empty and all-normal input", () => {
    expect(highestThreat([])).toBeUndefined();
    expect(highestThreat([ev({ start: 1 }), ev({ start: 2 })])).toBeUndefined();
  });
});

describe("withFlagged", () => {
  // Newest first, as an open camera group lists its events.
  const e6 = ev({ id: "e6", start: 6 });
  const e5 = ev({ id: "e5", start: 5 });
  const e4 = ev({ id: "e4", start: 4 });
  const e3 = ev({ id: "e3", start: 3, threat: 1 });
  const e2 = ev({ id: "e2", start: 2 });
  const e1 = ev({ id: "e1", start: 1, threat: 2 });
  const list = [e6, e5, e4, e3, e2, e1];

  it("adds the flagged events a cap cut off, in order, and counts only the rest as hidden", () => {
    const out = withFlagged(list, { list: [e6, e5], hidden: 4 });
    expect(out.list.map((e) => e.id)).toEqual(["e6", "e5", "e3", "e1"]);
    expect(out.hidden).toBe(2);
  });

  it("does not repeat a flagged event the cap already shows", () => {
    const out = withFlagged(list, { list: [e6, e5, e4, e3], hidden: 2 });
    expect(out.list.map((e) => e.id)).toEqual(["e6", "e5", "e4", "e3", "e1"]);
    expect(out.hidden).toBe(1);
  });

  it("returns the capped list unchanged when nothing cut off is flagged", () => {
    const plain = [e6, e5, e4];
    const capped = { list: [e6], hidden: 2 };
    expect(withFlagged(plain, capped)).toEqual({ list: [e6], hidden: 2 });
  });
});
