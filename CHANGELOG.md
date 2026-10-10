# Changelog

All notable changes to this project are documented here. The project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-10

First release.

### Added

- Timeline from Home Assistant entities (logbook), LLM Vision and Frigate, with optional
  Nest doorbell clips.
- Merging of AI descriptions with Frigate reviews on the same camera, many-to-one.
- Compact rows: bursts of door/lock changes, bounce collapsing, per-person presence
  grouping and camera groups.
- Animated previews (at most six playing) with still and key-frame fallbacks.
- Inline HLS player for the exact clip, with ±30 s widening, download, and fallbacks for
  H.265, missing recordings and stalls.
- Category chips, a camera menu and a 24-hour day strip (pointer and keyboard).
- Mark reviewed, for one or all visible Frigate reviews.
- Deep links with `?reel=<id>`.
- Visual editor that keeps YAML-only options, and a stub config for the card picker.
- English and Norwegian (bokmål).
