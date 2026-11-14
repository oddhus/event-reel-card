// Which sides of a sideways scroller have more content out of view, for an edge fade. Pure.

export type ScrollEdges = { left: boolean; right: boolean };

/** Sub-pixel scroll positions on zoomed or high-DPI screens are ignored. */
const SLACK = 1;

/**
 * The physical sides with content out of view. In right-to-left text the scroller starts at
 * its right edge and browsers report `scrollLeft` from 0 down to negative values. Safari's
 * rubber-band bounce reports values past either end, which count as that end.
 */
export function scrollEdges(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
  rtl = false,
): ScrollEdges {
  const max = Math.max(0, scrollWidth - clientWidth);
  const scrolled = Math.min(max, Math.max(0, rtl ? -scrollLeft : scrollLeft));
  const before = scrolled > SLACK;
  const after = scrolled + clientWidth < scrollWidth - SLACK;
  return rtl ? { left: after, right: before } : { left: before, right: after };
}
