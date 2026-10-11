# Changelog

All notable changes to this project are documented here. The project uses
[Semantic Versioning](https://semver.org/).

## [0.2.1] - 2026-10-11

### Changed

- `entities` given as a single string (`entities: person.alex`) is now a configuration
  error asking for a list. Before, it was read letter by letter.
- The card file is fully minified: about 478 KB instead of 603 KB (151 KB gzipped).

### Fixed

- The visual editor can set the range in hours again (12, 24 or 48 h). Before, only
  "Today" was accepted, and once it was picked the editor couldn't switch back.
- AI events no longer wait for a slow Nest lookup. Doorbell rows show right away and get
  their clip as soon as the lookup answers; before, a Nest lookup that never answered left
  LLM Vision "unavailable" until the page was reloaded. A failed lookup also keeps the
  clips of doorbell events it already knew.
- Arrow keys on the day strip step on from the last picked row, also after a pause. Before,
  they jumped back to the newest row once the highlight faded.
- With reduced motion or data saving, the player shows the still instead of looping the
  preview while the clip loads.
- With `preview: hover`, focusing a row with the keyboard plays its preview, as hovering
  does, and a hovered or focused preview keeps playing when its row gets newer media.
- `range: today` starts at the first moment of the day where daylight saving time skips
  midnight, instead of an hour into the previous evening.
- A camera group's thumbnail no longer shows an older event's image when a slow request
  answers late.

## [0.2.0] - 2026-10-11

### Added

- Buttons for the previous and next day, with a jump back to today. A past day runs from
  midnight to midnight. Turn them off with `day_navigation: false`.

### Fixed

- A slow source no longer holds up the others: each source shows its events as soon as it
  answers. A source that hasn't answered within 20 seconds gets a warning chip and keeps its
  earlier rows, and its answer still shows up if it arrives later. Before, one source that
  never answered left the card stuck on "Loading…".
- An answer that arrives after the configuration changed (for example while you edit the
  card) is dropped, instead of briefly showing data from the old configuration.

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
