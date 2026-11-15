import { describe, expect, it } from "vitest";
import { scrollEdges } from "../src/core/overflow";

describe("scrollEdges", () => {
  it("has nothing hidden when the content fits", () => {
    expect(scrollEdges(0, 300, 300)).toEqual({ left: false, right: false });
  });

  it("has more on the right before scrolling", () => {
    expect(scrollEdges(0, 300, 500)).toEqual({ left: false, right: true });
  });

  it("has more on both sides in the middle", () => {
    expect(scrollEdges(100, 300, 500)).toEqual({ left: true, right: true });
  });

  it("has more only on the left when scrolled to the end", () => {
    expect(scrollEdges(200, 300, 500)).toEqual({ left: true, right: false });
  });

  it("ignores a fraction of a pixel left at either end", () => {
    // A zoomed screen can stop at 199.5 of 200, or report 0.4 at the start.
    expect(scrollEdges(199.5, 300, 500)).toEqual({ left: true, right: false });
    expect(scrollEdges(0.4, 300, 500)).toEqual({ left: false, right: true });
  });

  it("treats a bounce past either end as that end", () => {
    // Safari's rubber-band scrolling reports -30 before the start and 230 past the end.
    expect(scrollEdges(-30, 300, 500)).toEqual({ left: false, right: true });
    expect(scrollEdges(230, 300, 500)).toEqual({ left: true, right: false });
  });

  describe("right to left", () => {
    // The scroller starts at its right edge; scrolling toward the end makes scrollLeft negative.
    it("has more on the left before scrolling", () => {
      expect(scrollEdges(0, 300, 500, true)).toEqual({ left: true, right: false });
    });

    it("has more on both sides in the middle", () => {
      expect(scrollEdges(-100, 300, 500, true)).toEqual({ left: true, right: true });
    });

    it("has more only on the right when scrolled to the end", () => {
      expect(scrollEdges(-200, 300, 500, true)).toEqual({ left: false, right: true });
    });

    it("treats a bounce past either end as that end", () => {
      expect(scrollEdges(30, 300, 500, true)).toEqual({ left: true, right: false });
      expect(scrollEdges(-230, 300, 500, true)).toEqual({ left: false, right: true });
    });
  });
});
