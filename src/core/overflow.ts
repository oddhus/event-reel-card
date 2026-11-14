// Which ends of a sideways scroller have more content out of view, for an edge fade. Pure.

export type ScrollEdges = { start: boolean; end: boolean };

/** Sub-pixel scroll positions on zoomed or high-DPI screens are ignored. */
const SLACK = 1;

/** `scrollLeft`, `clientWidth` and `scrollWidth` of the scroller, left to right. */
export function scrollEdges(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
): ScrollEdges {
  return {
    start: scrollLeft > SLACK,
    end: scrollLeft + clientWidth < scrollWidth - SLACK,
  };
}
