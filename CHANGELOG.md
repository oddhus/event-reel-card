# Changelog

All notable changes to this project are documented here. The project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- A card with nothing to read from (no entities, and no Frigate, Event Reel or LLM Vision)
  now says so and how to set it up, with a link to the setup guide, instead of looking
  like a quiet day.
- Search. The magnifier after the filter chips opens a field that finds events in the range
  shown by their title, AI description, camera, person or who changed a lock. Every word
  must match; case and accents don't matter. A camera group shows only its matching events.
  It comes with the filter chips, so `filters: false` hides it too.

### Fixed

- An integration that finishes loading after the card (a cold start, or Home Assistant
  restarting) is picked up at once. Before, its events waited for the next refresh, up to
  a minute, and on a past day until you navigated.

## [0.4.1] - 2026-10-21

### Fixed

- A clip that stalls on a slow network no longer counts as a recording the device can't
  play. Before, on Safari and iOS (and for Nest clips), one stall kept that camera on the
  preview with the H.265 message until the page was reloaded. Now the card shows "The
  recording isn't available" with a **Try again** button, and the next clip tries full
  quality again. A camera that has media buffered and still won't play, or whose clips
  stall twice in a row, is still treated as one this device can't play.
- When the browser refuses to autoplay a clip (iOS Low Power Mode, say), the player now
  leaves the clip ready to play with a tap instead of giving up on it.
- A Nest clip that fails to load (Home Assistant answers 404 when the clip is gone) now
  shows "The recording isn't available" with **Try again**, instead of the H.265 message.
- The player no longer stays on "Loading clip…" forever when Home Assistant doesn't answer
  a request to sign or resolve a clip; it gives up after 15 seconds and shows the preview.

## [0.4.0] - 2026-10-17

### Added

- Frigate GenAI threat levels show as a badge on the row: "Suspicious" for level 1 and
  "Security concern" for level 2 (and level 3 from Frigate 0.17). A camera group shows the
  highest level among its events and always lists the flagged events when opened. The
  detail lists the concerns the model saw, and keeps Frigate's summary when an LLM Vision
  or Event Reel description joins the review. `hide_unconfirmed` never hides a flagged
  review.

## [0.3.1] - 2026-10-14

### Fixed

- `max_events` now applies after the category and camera filters. Before, the card kept
  the newest events first and filtered after, so a filter could show too few rows, or
  none, while older matches existed. A note under the list says how many older events
  are hidden, and a deep link to an older event still opens it. Event Reel and LLM Vision
  events are fetched up to 500 (or twice `max_events`) for the filters to search. An open
  camera group shows at most `max_events` events too.
- One malformed review from Frigate no longer stops all Frigate events from loading; the
  card skips it.

## [0.3.0] - 2026-10-13

### Added

- AI descriptions from the new companion integration,
  [Event Reel](https://github.com/oddhus/event-reel). It describes Nest doorbell clips and
  any other camera with the AI Task you already have in Home Assistant, such as a local
  Ollama model. The card finds it on its own; `event_reel: false` (or the switch in the
  editor) turns it off. Its events join Frigate reviews on the same camera like LLM Vision
  events, and a doorbell ring described by both Event Reel and LLM Vision is one row.

### Changed

- Durations are translated: Norwegian shows `1 t 5 min` instead of `1h 5m`.
- Who changed a lock (`actor_attribute`) is looked up only for new changes, in the history
  around them, instead of the whole range with attributes on every refresh.
- The card file starts with the license texts of the code it bundles, as those licenses
  require: Lit, hls.js, and the eventemitter3, url-toolkit and SVTA Common Media Library
  code inside hls.js. Earlier builds left them out. This adds about 15 KB (5 KB gzipped).

### Fixed

- An open clip in a camera group keeps playing when a newer event joins the group. Before,
  the clip started over in a new player.
- A lock that bounces no longer gives a change the actor of the next one: unlocked by Alex,
  locked, unlocked by Sam showed Sam for both unlocks.
- Door, lock and presence rows wait at most 3 seconds for the actor lookup. After that they
  show without it, and the actor appears when the lookup answers; before, a lookup that
  never answered left the rows "unavailable".
- LLM Vision events with a description (from `llmvision.create_event`) keep their own row
  instead of joining a burst of door changes, where the description couldn't be read.
- With the "system" time format in your Home Assistant profile, times follow the clock of
  your device's locale, as Home Assistant does. Before, they followed the language.

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
