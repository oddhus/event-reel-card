import { describe, expect, it } from "vitest";
import { scrollEdges } from "../src/core/overflow";

describe("scrollEdges", () => {
  it("has nothing hidden when the content fits", () => {
    expect(scrollEdges(0, 300, 300)).toEqual({ start: false, end: false });
  });

  it("has more at the end before scrolling", () => {
    expect(scrollEdges(0, 300, 500)).toEqual({ start: false, end: true });
  });

  it("has more on both sides in the middle", () => {
    expect(scrollEdges(100, 300, 500)).toEqual({ start: true, end: true });
  });

  it("has more only at the start when scrolled to the end", () => {
    expect(scrollEdges(200, 300, 500)).toEqual({ start: true, end: false });
  });

  it("ignores a fraction of a pixel left at either end", () => {
    // A zoomed screen can stop at 199.5 of 200, or report 0.4 at the start.
    expect(scrollEdges(199.5, 300, 500)).toEqual({ start: true, end: false });
    expect(scrollEdges(0.4, 300, 500)).toEqual({ start: false, end: true });
  });
});
