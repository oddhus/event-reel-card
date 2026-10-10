# Event Reel Card: implementation plan

A Home Assistant Lovelace card that shows one compact timeline of the day's events:
door, lock and presence changes, AI-described camera activity (LLM Vision), Frigate
review items with **animated thumbnails** and **the exact video clip**, Nest doorbell
clips, and any other event you want to log.

Status: v0.1.0 released 2026-10-10 (M1–M3 done; §9). Reviews are logged in §12. This
document is the brief for the implementing agent. Private details about the reference install
(entity ids, hosts, camera mapping, deploy steps) live in `CLAUDE.local.md`, which is
gitignored. Read it if it exists, and never copy its contents into tracked files.

---

## 1. Goals

1. **One timeline, many providers.** HA entities/logbook, LLM Vision, Frigate and Nest,
   plus custom events. Adding a provider must not touch the UI code.
2. **Few hard dependencies.** The card needs nothing beyond Home Assistant core. Frigate,
   LLM Vision and Nest are optional providers that add media and descriptions when they
   are present. See §3.8.
3. **Video first.** Camera events get a moving thumbnail. Tapping one plays the exact
   recorded clip inline, with no download needed.
4. **Compact by default.** A full day fits on a phone screen without endless scrolling.
   Door/lock sequences and camera bursts collapse into single rows (§5.3).
   `density: compact | comfortable`.
5. **Easy to configure.** Works out of the box with auto-discovery, has a GUI editor for
   the common options, and supports YAML for everything else.
6. **Frontend only.** No add-on or custom integration of its own. Everything goes through
   APIs Home Assistant already exposes. Distributed through HACS as a "Dashboard"
   (plugin) repository.

**First target:** replace a "last 24 hours" dashboard view on the reference install that
uses `llmvision-card` today (§9, M1).

### Non-goals for v1

- Live camera streams. Other cards (Advanced Camera Card etc.) already do this well.
- Running AI analysis. The card displays results, and producers stay in automations,
  LLM Vision or Frigate GenAI.
- A backend or database of its own.
- Depending on other custom cards.

---

## 2. Verified facts about the data sources

Checked on 2026-10-10 against a real install (HA 2026.x, Frigate 0.18.0, Frigate
integration v5.15.6 (the latest release), LLM Vision v1.7.2, Nest core integration).
Unless noted, every check went **through Home Assistant** (websocket and HTTP proxies),
not to Frigate directly. Items marked **verify** were not tested.

### 2.1 LLM Vision

- Fetch with the documented service (verified):
  ```js
  hass.callWS({ type: "call_service", domain: "llmvision", service: "get_events",
    service_data: { start: "YYYY-MM-DD HH:MM:SS", end: "YYYY-MM-DD HH:MM:SS",
                    limit: 100 /* cameras, categories, labels, include_no_activity */ },
    return_response: true })   // -> { response: { events: [...] } }
  ```
  `llmvision-card` uses an undocumented REST endpoint instead
  (`GET /api/llmvision/timeline/events?start&end&limit&include_no_activity`, where `limit`
  defaults to 10). Prefer the service, which is the public contract.
- Event shape (sample, ids replaced):
  ```json
  {"uid":"5f0e…","title":"Person on the front steps","description":"…",
   "start":"2026-10-08T14:16:26.866834+02:00","end":"2026-10-08T14:17:31.022224+02:00",
   "key_frame":"/media/llmvision/snapshots/example-0.jpg",
   "camera_name":"image.entrance_person", "category":"person", "label":"person"}
  ```
- `camera_name` (from the v1.7.2 source, confirmed in real data):
  - Image analyzer: the first `image_entity` (`image.*` from Frigate, or `camera.*`).
  - Video analyzer: the last path segment of the video path, without `.mp4`. For a Nest
    automation attachment (`/api/nest/event_media/{device_id}/{token}`) this is the
    **Nest event token**, the same token as in the Nest media-source id (verified). That
    gives an exact join to the Nest clip (§2.3).
  - `""` for events from `llmvision.create_event`.
- `key_frame` is a path under `/media/llmvision/snapshots/`. Resolve it the way
  `llmvision-card` does (seen in its source): replace the leading `/media/` with
  `media-source://media_source/local/` and call `media_source/resolve_media`, which
  returns a signed URL.
- "No activity" events: the server drops every event whose title contains "no activity"
  (case-insensitive) unless `include_no_activity: true`. The card needs no filter of its
  own.
- Timing: `start` is when the analyzer was triggered. On the reference data it matches
  the Frigate review start (median 0 s, §2.5). `end` is about start + 60–75 s and has no
  meaning.
- Events from `create_event` (door, lock, presence) have inconsistent `category` and
  `label` (often empty). Don't build on them. Use the entity provider (§2.4) for these.
- Live updates: the `calendar.llm_vision_timeline` entity rewrites its state after every
  timeline write (v1.7.2 source, debounced). Use a change as a refetch hint and keep
  polling as the baseline (**verify** in practice).
- Fallback without the LLM Vision service: the same calendar entity serves the events
  through HA's core calendar API, with `location = "{key_frame},{camera_name}"` (from
  source, **verify**). There is no category in that path.

### 2.2 Frigate (through the HA Frigate integration)

The **instance id** is the camera entity attribute `client_id` (for example `frigate`).
Frigate cameras are `camera.*` entities with `attributes.client_id` and
`attributes.camera_name` (the Frigate camera name).

Websocket commands (all take `instance_id`):

| Command | Use |
|---|---|
| `frigate/reviews/get` | `cameras`, `labels`, `zones`, `severity` (**one** string), `after`, `before` (float epoch), `limit`, `reviewed`. Verified. |
| `frigate/reviews/subscribe` / `unsubscribe` | Live review updates. `unsubscribe` takes `subscription_id`. Payload shape: **verify** (expected: Frigate MQTT `reviews` message with `type`, `before`, `after`). |
| `frigate/reviews/viewed` | `ids: [...]`, `viewed: bool`. Marks items as reviewed in Frigate. |
| `frigate/events/get` | Object events (faces/sub_labels, has_clip…). |
| `frigate/recordings/get` / `summary` | Recording coverage (for later, §3.5). |

- **The results are JSON strings.** The integration passes Frigate's body through
  unparsed (`decode_json=False`), so do `JSON.parse(result)`.
- Filter several severities client-side, or make one call per severity.

Review item shape (sample, ids replaced):
```json
{"id":"1791450000.123456-abc123","camera":"entrance","start_time":1791450000.12,
 "end_time":1791450049.35,"severity":"alert",
 "thumb_path":"/media/frigate/clips/review/thumb-entrance-1791450000.123456-abc123.webp",
 "data":{"detections":["1791449999.654321-def456"],"objects":["person"],
         "verified_objects":[],"sub_labels":[],"zones":[],"audio":[],
         "thumb_time":1791450000.18,"metadata":null},
 "has_been_reviewed":false}
```
`end_time` is `null` while the activity is ongoing. `data.metadata` holds Frigate GenAI
review summaries (`title`, `scene`, `shortSummary`, `confidence`,
`potential_threat_level`, `other_concerns`) when `review.genai` is enabled in Frigate.
Use them when present.

HTTP media through the integration proxy. `{iid}` is the instance id.

| What | HA path | Status |
|---|---|---|
| Animated review preview (mp4) | `/api/frigate/{iid}/notifications/{review_id}/review_preview.gif?format=mp4` | ✅ 200, `video/mp4`, 88 KB. The query is forwarded. Notification proxy, see below. |
| Animated review preview (gif) | `/api/frigate/{iid}/notifications/{review_id}/review_preview.gif` | 242 KB (measured on Frigate directly) |
| Still review thumbnail | `/api/frigate/{iid}/clips/review/thumb-{camera}-{review_id}.webp` (from `thumb_path`) | Route exists in v5.15.6 (`ReviewClipsProxyView`), normal auth. **Verify.** |
| Still review thumbnail (alt) | `/api/frigate/{iid}/notifications/{review_id}/{camera}/review_thumbnail.webp` | Notification proxy |
| Still object thumbnail | `/api/frigate/{iid}/thumbnail/{event_id}` | 9 KB |
| Animated preview for a time range | `/api/frigate/{iid}/preview/{camera}/start/{s}/end/{e}` | ❌ **404 on v5.15.6.** The route was added on the integration's main branch on 2026-09-24 and is not in a release yet. Feature-detect it (§3.8), never require it. |
| **Exact clip, streamed (HLS)** | `/api/frigate/{iid}/vod/{camera}/start/{s}/end/{e}/index.m3u8` | ✅ Verified end to end, see below |
| Full-quality MP4 download | `/api/frigate/{iid}/recording/{camera}/start/{s}/end/{e}` | ~0.8 MB/s for 4K (75 s ≈ 60 MB). Download only. |

- **Notification proxy.** The `notifications/...` routes are **unauthenticated by
  default** (integration option "notification proxy" enabled, no expiry). A user can
  turn the option off, and then these routes fail even for authenticated requests. So
  sign them anyway, and fall back to the `clips/...` still on error.
- **HLS auth (verified through HA).** Sign the manifest path. Frigate's nginx-vod copies
  the query string (`?authSig=…`) onto the `init` and segment URLs, and the integration's
  segment view accepts a segment when the signed path starts with the segment's
  directory. Signed manifest, init and segments all returned 200. Unsigned manifest and
  segments returned 401. One signed manifest URL therefore works in hls.js and in a
  native `<video src>`, with no Authorization headers.
- `auth/sign_path` returns `{ path }` (the signed path). The signature covers the query
  parameters, so sign the full path including the query.
- **Codecs.** Frigate previews are low-res H.264 and play everywhere. Full recordings can
  be HEVC. The reference 4K HEVC camera's init segment uses the `hev1` sample entry (not
  `hvc1`), which Safari and iOS native HLS are likely to reject. It also runs at about
  6.3 Mbit/s (13.4 MB for a 17 s segment), which is heavy on mobile data. On the
  reference install most camera events come from that camera, so the codec fallback is a
  main path, not an edge case (§5.4).
- Never auto-download the MP4. Download only on an explicit button press.

### 2.3 Nest (core integration, through HA media source)

- `media_source/browse_media` with `media-source://nest` lists the devices. With
  `media-source://nest/{device_id}` it lists events (200+ entries, months back):
  ```json
  {"title":"Person @ 2026-10-08 13:44:55","media_class":"image",
   "media_content_id":"media-source://nest/{device_id}/{token}",
   "thumbnail":"/api/nest/event_media/{device_id}/{token}/thumbnail"}
  ```
- `media_class` is `image` for every event, even when the media is a clip.
  `media_source/resolve_media` returned **`video/mp4`** with a signed URL for a doorbell
  event (verified), so the doorbell does provide clips.
- The token is base64 of a JSON array. It equals LLM Vision's `camera_name` for video
  analyzer events on Nest attachments (§2.1).
- Titles are `"<Type> @ <local timestamp>"` (Doorbell, Person, Motion…). Parsing time and
  type from a localized title is fragile, so the full Nest provider is P2. M1 only uses
  Nest to play clips for LLM Vision doorbell events joined by token.
- Automations also get `trigger.event.data.attachment.video|image` (`/api/nest/event_media/...`).

### 2.4 Entities and logbook (HA core)

- `logbook/get_events` with `{ start_time, end_time, entity_ids }` returns entries with
  `when`, `entity_id`, `state`, `name`/`message` (for `logbook.log` entries) and, when
  known, `context_user_id`, `context_event_type`, `context_domain`, `context_name`,
  `context_entity_id`.
- Verified: for one day, the logbook held exactly the same 36 door, lock and presence
  changes that an automation had copied into LLM Vision with `create_event`.
- Physical and keypad changes carry no `context_*`. `context_user_id` is a user id.
  Names need the admin-only `config/auth/list`, so show an actor only when it is cheap:
  - an attribute such as a lock's `changed_by` (needs `history/history_during_period`
    with attributes for that entity, **verify**), or
  - the friendly name of `context_entity_id` (the automation or script).
- Drop transitions from or to `unknown`/`unavailable` (restart noise) and attribute-only
  updates.
- Locks can bounce (unlocked → locked → unlocked within seconds, seen in real data).
  Grouping handles it (§5.3).
- Format states with `hass.formatEntityState(stateObj, state)` to get localized state
  names ("Locked", "Låst").
- `history/history_during_period` (minimal response) gives on/off intervals for context
  bands (§5.6).
- Retention follows the recorder (default 10 days). That is fine for a 24 h view but
  limits day navigation.

### 2.5 Reference data profile (anonymized, 6 days)

- About 54 events per day. **77 % are door, lock and presence changes.** The rest are
  camera AI events, mostly from one entrance camera (4K HEVC).
- 93 Frigate reviews, all `alert`, none with GenAI metadata. A camera without AI
  analysis had 26 of them.
- Merge with the §3.5 defaults: 65 of 67 AI events on the entrance camera fell inside a
  review's window. 5 reviews had **two** AI events each (the producer dedupes per camera
  for 90 s and reviews can last longer). 3 reviews had none.
- 6 doorbell AI events (video analyzer on the Nest clip), all joinable by token.

---

## 3. Architecture

### 3.1 Stack

- TypeScript + **Lit 3**, built with **Vite library mode** into a single ES module
  `dist/event-reel-card.js` (inline dynamic imports, no external chunks, so HACS ships
  one file).
- **hls.js** (light build) bundled. Use hls.js when MSE or ManagedMediaSource is
  available. Otherwise use native HLS via `video.src = signedManifest`.
- **Vitest** for unit tests of the pure logic (mapping, merge, grouping, time ranges,
  provider parsers).
- No runtime CDN imports. HA does not reliably share its own Lit with custom cards, so
  bundle it.

### 3.2 Source layout

```
src/
  event-reel-card.ts        # <event-reel-card>: config, lifecycle, layout
  editor.ts                 # getConfigForm() schema (+ custom editor only if needed)
  types.ts                  # ReelEvent, MediaRef, ProviderContext, config types
  config.ts                 # normalise shorthand config → provider configs
  providers/
    registry.ts             # registerProvider(type, factory)
    entity.ts               # core: logbook state changes + logbook.log entries
    llmvision.ts
    frigate.ts
    nest.ts                 # M1: token → clip resolver only; full provider P2
    calendar.ts             # P2: any calendar entity
  core/
    capabilities.ts         # what is installed / which optional routes work (§3.8)
    cameras.ts              # camera registry + auto-mapping (§3.4)
    merge.ts                # link AI/text events to media events (§3.5)
    grouping.ts             # bursts, bounces, camera groups (§5.3)
    media.ts                # sign_path cache, URL builders, fallback chains
    time.ts                 # ranges, day boundaries in HA time zone, formatting
  ui/
    event-row.ts            # compact/comfortable row, group rows
    event-detail.ts         # expanded view: player + text + actions
    reel-preview.ts         # animated thumbnail (IntersectionObserver)
    reel-player.ts          # hls.js / native player, codec fallback
    day-strip.ts            # P1
    filter-chips.ts         # P1
  i18n/ en.ts nb.ts index.ts
  styles.ts
dev/
  index.html, mock-hass.ts  # dev harness (§7)
  fixtures/*.example.json   # anonymised; *.local.json is gitignored
test/
  *.test.ts
```

### 3.3 Data model

```ts
type Category = "person" | "vehicle" | "animal" | "package" | "doorbell" | "motion"
  | "door" | "lock" | "presence" | "alarm" | "calendar" | "custom";

interface MediaRef {
  kind: "hls" | "mp4" | "image" | "gif";
  path: string;              // HA-relative path, unsigned (or a media-source id)
  sign?: boolean;            // default true for /api/*, /media/*
  resolve?: boolean;         // true for media-source ids (resolve_media signs)
}

interface ReelEvent {
  id: string;                // `${provider}:${nativeId}`
  provider: string;          // "entity" | "llmvision" | "frigate" | "nest" | ...
  sources: string[];         // after merge, e.g. ["llmvision","frigate"]
  start: number;             // epoch seconds
  end?: number;              // undefined while ongoing / for instants
  title: string;
  description?: string;
  extra?: { start: number; title: string; description?: string }[];  // more AI texts merged into the same media event
  category: Category;
  icon?: string;             // mdi:… override
  entityId?: string;         // source entity for entity events (grouping, more-info)
  state?: string;            // raw new state for entity events
  camera?: string;           // canonical camera key = HA camera entity id
  thumbnail?: MediaRef[];    // still, in fallback order
  preview?: MediaRef[];      // animated (mp4/gif), in fallback order
  clip?: MediaRef;           // exact video (hls preferred)
  download?: MediaRef;       // mp4
  labels?: string[];         // objects
  people?: string[];         // faces / sub_labels / presence names
  severity?: "alert" | "detection" | "info" | "warning";
  reviewed?: boolean;        // Frigate review state
  actor?: string;            // who/what caused it, when cheaply known (§2.4)
  raw?: unknown;             // original payload for actions/debug
}

interface Provider {
  readonly type: string;
  fetch(range: { start: number; end: number }, ctx: ProviderContext): Promise<ReelEvent[]>;
  subscribe?(ctx: ProviderContext, onChange: () => void): () => void;  // live updates
  actions?(ev: ReelEvent): ReelAction[];  // e.g. "mark reviewed"
}
```

Providers never render anything. A new provider means one file plus one
`registerProvider` call. Expose `window.eventReel.registerProvider` so third-party
scripts can add providers later (P3).

### 3.4 Camera registry and auto-mapping

The canonical camera key is the **HA camera entity id**. The registry is built from
`hass.states`, `hass.entities` (entity registry: `device_id`, `platform`) and
`hass.devices`:

1. **Frigate:** `camera.*` with `attributes.client_id` and `attributes.camera_name` →
   key ↔ (instance id, Frigate camera name).
2. **LLM Vision `camera_name` that is an entity id:**
   - `camera.*` → itself.
   - `image.*` (Frigate object image) → the `camera.*` entity on the **same device**,
     preferring platform `frigate`. **Verify** in the live frontend that `hass.entities`
     exposes `device_id` for these entities.
3. **LLM Vision `camera_name` that is a Nest token** (base64 of a JSON array): find the
   Nest device whose media-source listing contains the token (browse each Nest device
   once, cache, refresh when an unknown token shows up) → that device's `camera.*`.
4. **`camera_aliases`** in config map extra keys (entity ids or LLM Vision identifiers)
   to a canonical one. This covers the same physical camera exposed by two integrations,
   for example a Reolink entity and a Frigate camera.
5. Anything else stays **unmapped**: the row shows the key frame only. Never guess a
   camera, because a wrong guess plays the wrong clip.

Unit test every rule.

### 3.5 Merging (AI text ↔ video)

Goal: one row per real-world moment, with the AI title and description plus the video.

1. Split events into **text events** (LLM Vision with a camera) and **media events**
   (Frigate reviews).
2. For each text event `T` on camera `c` at time `t`, the candidates are media events `M`
   on the same camera where `M.start - 15 s ≤ t ≤ (M.end ?? now) + 30 s`. Pick the
   nearest by `|t - M.start|`. These defaults matched 65 of 67 events on the reference
   data. Make the windows configurable (`merge.before`, `merge.after`).
3. **Many-to-one.** A media event can take several text events. The earliest gives the
   title, description and category. The others go into `extra` and show in the detail.
   Never turn a second AI event into a separate row with a made-up clip.
4. The merged event takes its media/reviewed/severity/labels from `M`. Its start is the
   min and its end the max of the parts. `sources` lists both providers.
5. **Doorbell:** a text event whose `camera_name` is a Nest token gets its clip from
   `media_source/resolve_media` and its still from the Nest `/thumbnail` path.
6. A text event with no match keeps its `key_frame` image. **No synthesized clips in
   M1.** The time-range preview route is not released (§2.2), and a VOD URL built from a
   timestamp can point at missing footage. Later (P2): synthesize VOD after checking
   coverage with `frigate/recordings/get`, and previews once the route ships.
7. A media event with no match is shown (`frigate.show_unmatched: true`, the default).
   Its title is the GenAI `metadata.title` if present, otherwise a localized
   "{Object} at {Camera}". This covers cameras without any AI producer.
8. **Never hide footage because of AI output by default.** "No activity" rows are
   already dropped by LLM Vision (§2.1). Opt-in: `frigate.hide_unconfirmed: true` hides
   unmatched reviews on cameras that have an AI producer, after a 3-minute grace period.
9. The function is pure: `merge(events, cameraRegistry, options) → ReelEvent[]`. Cover
   it heavily with tests, including an anonymized fixture built from the reference
   profile (§2.5).

### 3.6 Media signing (`core/media.ts`)

- `sign(path, expires = 3600)` → `hass.callWS({ type: "auth/sign_path", path, expires })`
  → `.path`. Cache by path until about 60 s before expiry. Batch requests within one
  frame.
- Sign every `/api/` media path, including routes that are unauthenticated today.
- Sign lazily, only when a row becomes visible or a player opens. Re-sign once on
  `error` (expired or 401), then move to the next `MediaRef` in the fallback list.
- Sign the **full path including the query** (for example `?format=mp4`).
- Media-source ids go through `media_source/resolve_media`, which returns its own signed
  URL.

### 3.7 Live updates

- Entities: when a watched entity's state changes in `set hass`, append the event
  straight away (with the §2.4 filters) and reconcile on the next fetch.
- Frigate: `frigate/reviews/subscribe`, then upsert on new/update/end. Unsubscribe with
  the `subscription_id`, and resubscribe after the HA connection reconnects.
- LLM Vision: refetch (debounced to 2 s) when `calendar.llm_vision_timeline` changes.
- Fallback for everything: poll every `refresh_interval` (default 60 s) while the card
  is visible (`document.visibilityState`).

### 3.8 Dependency policy and capability detection

The card has to keep working when other integrations change, are missing, or are
configured differently.

- **Tier 0, HA core APIs:** `hass.states`, `logbook/get_events`,
  `history/history_during_period`, `auth/sign_path`, `media_source/*`, the calendar API.
  The card must be useful with only these (entities, presence, calendars).
- **Tier 1, core integrations:** Nest, reached only through media source.
- **Tier 2, custom integrations:** the Frigate integration and LLM Vision. Optional
  providers.
  - Use only APIs present in their latest **released** version.
  - Prefer documented services over private REST endpoints.
  - Keep each in one provider file with a small parser covered by fixture tests, so a
    change upstream is a one-file fix.
- **Detection** (`core/capabilities.ts`, at startup):
  - Frigate: any camera with `attributes.client_id`.
  - LLM Vision: `hass.services.llmvision?.get_events`.
  - Nest: `hass.config.components` includes `nest`.
  - Optional routes (the Frigate time-range preview) are probed once per session and
    the result is cached.
- **Degrade, don't fail.** A missing provider is skipped silently when it was
  auto-enabled, with a warning chip when it was explicitly configured. A broken media
  route falls back to the next `MediaRef`: review preview → still → key frame → icon.

---

## 4. Configuration

Use **top-level provider keys** (easier for the GUI editor and for people) and normalize
them into provider configs internally. `true` means "on, with auto-discovery".

```yaml
type: custom:event-reel-card
title: Today's events          # optional; hidden when empty
density: compact               # compact | comfortable
range: 24h                     # 24h (rolling, default) | today | <hours>
preview: visible               # visible | hover | still | off   (animated thumbnails)
max_events: 200
language: auto                 # auto (HA user language) | en | nb

entities:                      # core provider: state changes from the logbook
  - entity: lock.front_door
    actor_attribute: changed_by                 # optional, read from history
  - entity: binary_sensor.front_door
    name: Front door
    icon: mdi:door
    states: { "on": Opened, "off": Closed }     # optional label overrides
    only_states: ["on"]                         # optional
  - person.alex
  - person.sam
llmvision:                     # true | false | object
  non_camera: true             # false = camera events only (use entities: for the rest)
  categories: []               # optional filter
frigate:                       # true | false | object
  cameras: auto                # auto | [camera.x, …]
  severity: [alert, detection] # filtered client-side
  show_unmatched: true
  hide_unconfirmed: false      # §3.5 rule 8
  clip_padding: [10, 20]       # seconds before/after
nest: true                     # M1: doorbell clips for LLM Vision events; full provider P2
calendars:                     # P2: any calendar entity, e.g. a Local Calendar
  - calendar.house_events
camera_aliases:
  camera.backyard_reolink: camera.backyard
cameras:                       # optional per-camera overrides
  camera.entrance: { clip: auto }   # auto | preview (skip full-quality HLS)
grouping:
  window: 120                  # seconds, for activity bursts and camera groups (§5.3)
context:                       # P2: highlight periods (§5.6)
  - entity: input_boolean.away_mode
    state: "on"
    label: Away
    color: red
merge: { before: 15, after: 30 }
```

**Running next to a producer automation:** when an automation already copies door/lock/
presence changes into LLM Vision, set `llmvision.non_camera: false` and list those
entities under `entities:`. Otherwise every change shows twice.

**GUI editor (P1):** `static getConfigForm()` with an ha-form schema covering title,
density, range, preview, on/off toggles for llmvision/frigate/nest, `entities` (an
entity selector with `multiple: true`) and `calendars`. A provider key can be a boolean
or an object. The form must not overwrite an object with a boolean, so advanced
provider options stay YAML only. Register in `window.customCards` with a preview, and
implement `getStubConfig(hass)`, which auto-detects which providers exist.

Sections view: `getGridOptions()` → `{ columns: "full", rows: "auto", min_columns: 6 }`.

### 4.1 Registering your own events (README section)

Document three ways, from easiest to most powerful:

1. **Add the entity to `entities:`.** Every state change shows up, with no automation.
2. **`logbook.log`** from any automation, with `entity_id:` set to an entity listed under
   `entities:`. Gives a custom name and message. Kept as long as the recorder keeps
   data (default 10 days).
3. **A Local Calendar plus `calendar.create_event`** (with the P2 calendar provider):
   persistent and editable in the HA UI. **`llmvision.create_event`** also works when
   `llmvision.non_camera` is true, and it can carry an image.

Include copy-paste automation examples for each.

---

## 5. UI and UX

### 5.1 Layout (top to bottom)

M1:
1. **Header:** optional title.
2. **Event list,** newest first, with sticky hour separators in compact mode.

Later:
- **Summary and filter chips (P1):** counts per category ("5 persons · 3 door ·
  1 doorbell"). Tapping one toggles a filter. A camera filter menu sits at the end.
- **Day strip (P1):** a 24 h bar about 28 px high, with one tick per event colored by
  category, faint hourly activity in the background, context bands and a "now" line.
  Tap or drag to scroll the list to that time.
- **"Mark all reviewed" (P1)** in the header when there are unreviewed Frigate items.
- **`‹ date ›` day navigation (P2),** only when `range: today`.

### 5.2 Rows

**Compact (default, about 44 px for camera rows, 32 px for others):**
```
14:16  [▶ 64×36 anim]  Person searching on the front steps     Entrance · 49s  ●
14:20  [ 🔒 ]          Front door: unlocked · opened · closed · locked   14:20–14:22
```
- The time column is fixed width with tabular numerals.
- Camera rows have the animated preview. Non-camera rows have a 28 px icon disc in the
  same slot, so the text lines up.
- The title is one line with an ellipsis. In compact mode the description appears only
  when the row is expanded.
- The right side shows the camera name, duration, a face/person chip, the actor when
  known, and a blue dot when unreviewed.
- Context highlight (P2): a left border colored by the active context band.

**Comfortable:** about 72 px, a 112×63 preview, and a two-line description.

### 5.3 Grouping (`core/grouping.ts`, pure)

Most rows on a real day are door and lock changes (§2.5), so this is the main lever for
a compact view.

- **Activity bursts:** non-camera events that each follow the previous one within
  `grouping.window` (default 120 s) collapse into one row. The row shows a chain of
  states ("Front door: unlocked · opened · closed · locked"), the time range and a
  count. A burst can mix entities (a lock and a door). Presence changes stay separate
  rows.
- **Bounces:** the same entity flipping back and forth within 10 s collapses into its
  last state, with "×n".
- **Camera groups:** consecutive events on the same camera within the window collapse
  into "3× Backyard · 14:02–14:09", with a stacked thumbnail.
- Tap a group to expand it.
- P2: attach a burst to an overlapping camera event ("Person at the entrance · door
  unlocked · opened").

### 5.4 Expanded detail (inline accordion; one open at a time)

- **Player** (16:9, full card width):
  - While the HLS clip loads, loop the preview (or show the still) in the player area.
  - Exact clip `[start - pad, end + pad]` over HLS, autoplay muted, controls,
    `playsinline`. For an ongoing review (`end_time: null`), end the range at now − 5 s.
  - Buttons for "−30 s / +30 s" to widen the window (sign a new VOD range) and for
    fullscreen.
  - **Codec fallback.** Don't decide up front with `MediaSource.isTypeSupported()` and a
    fixed codec string, because the sample entry (`hev1` vs `hvc1`) varies per
    recording. Fall back to the preview mp4 and show "Full quality uses H.265, which
    this device can't play. Download instead." when any of these happen:
    - hls.js reports a fatal or codec error,
    - the video element reports `MEDIA_ERR_SRC_NOT_SUPPORTED`,
    - no video frames are decoded 4 s after playback starts
      (`getVideoPlaybackQuality().totalVideoFrames === 0`), the black-video-with-audio
      case.
    Remember the result per camera for the session. The per-camera `clip: preview`
    override skips HLS entirely.
  - Clip deleted (retention) → "The recording has been deleted".
  - Destroy the hls.js instance when the detail closes or the card disconnects.
- Full title and description, plus any `extra` AI texts. Meta: camera, duration,
  objects, faces, sources ("AI + Frigate"), and the GenAI threat level when present.
- Actions: **Mark reviewed** (Frigate, P1), **Download** (signed MP4 link with
  `download`, P1), **Open camera** or **Open entity** (more-info), prev/next event.
- Accessibility: the row's disclosure button is separate from the action buttons. Never
  nest buttons.
- Keyboard: ↑/↓ move, Enter opens, Esc closes, ←/→ seek.

### 5.5 Animated thumbnails

- Use `<video muted loop playsinline preload="none">` with the review preview mp4. If it
  fails, fall back through the still list (`clips/...` thumbnail, key frame, icon).
- `preview: visible` plays only while the row is visible (IntersectionObserver), with at
  most **6 playing at once** (closest to the viewport centre wins). `hover` plays on
  hover/focus and shows the still otherwise.
- `prefers-reduced-motion` or `navigator.connection.saveData` → behave like `still`.

### 5.6 Context bands (P2)

Fetch history for the `context` entities in the visible range. Compute the intervals
where the state matches. Shade them on the day strip, and color the left border of rows
inside them. Use cases: "someone came while we were away" and "activity at night".

### 5.7 Deep links (P1)

Open a specific event from a URL: `…/dashboard/view#reel=<event id>` or
`?reel=<event id>`, accepting a Frigate review id, an LLM Vision uid or a merged id. The
card scrolls to the event and expands it. This lets mobile notifications link straight
to the clip.

### 5.8 Theming, i18n, a11y

- Use HA CSS variables only: `--primary-text-color`, `--secondary-text-color`,
  `--card-background-color`, `--divider-color`, `--primary-color`, `--state-*-color`,
  `--ha-card-border-radius`. Category colors go in a map and can be overridden with
  `colors:`.
- i18n: `en`, `nb`. `language: auto` picks from `hass.locale.language` (`nb`, `nn` and
  `no` map to `nb`) and falls back to `en`. Format times with `hass.locale` (12/24 h) in
  the **HA time zone** (`hass.config.time_zone`). Day boundaries use that time zone too.
  Rolling ranges are plain epoch arithmetic.
- Rows are buttons with aria labels, focus rings are visible, and players get captions
  when available.

### 5.9 Errors and empty states

- Each provider fails independently. If a provider errors, show a small warning chip
  ("Frigate unavailable") and still render the others.
- A missing integration with an auto-enabled provider is silently skipped. If the
  provider was explicitly configured, show a warning.
- A media fallback is not an error. Log it once to the console.
- Empty range: "No events in the last 24 hours" (or "today"), plus the time of the last
  earlier event.

---

## 6. Feature backlog

| Prio | Feature |
|---|---|
| P0 (M1) | Entity provider, LLM Vision provider, Frigate reviews provider, many-to-one merge, doorbell clips by Nest token, compact rows, grouping (bursts, bounces, camera groups), animated previews with fallback chain, HLS player with codec fallback, rolling 24 h range, nb/en |
| P1 | Mark reviewed (+ mark all), download, filter chips and summary, day strip, deep links, GUI editor and stub config, HACS release |
| P2 | Day navigation, context bands, calendar provider, full Nest provider, bursts attached to camera events, time-range previews and synthesized clips once the Frigate integration releases the preview route (with a recording-coverage check), faces/sub_labels chips and "unknown person only" filter, GenAI threat badge and `scene` fallback, search, presence at event time, "Summarize the day" (off by default) |
| P3 | Multi-camera sync, public provider API (`window.eventReel.registerProvider`), Reolink media-source provider, weekly heatmap |

---

## 7. Development workflow

1. **Real HA first.** From M0, deploy every build to a test view on the reference install
   and check it there. HA auth, signing, the integration proxies and the Companion apps
   can only be verified against real HA. The install-specific steps are in
   `CLAUDE.local.md`.
2. `npm run dev`: Vite dev server serving `dev/index.html`, for fast UI work. It mounts
   the card with a **mock `hass`** (`dev/mock-hass.ts`):
   - `callWS` answers `call_service llmvision.get_events`, `frigate/reviews/get` (as a
     JSON string), `logbook/get_events`, `history/history_during_period`,
     `media_source/*` and `auth/sign_path` from fixtures.
   - A **Vite proxy** maps the HA Frigate proxy paths to a Frigate instance from the env
     var `FRIGATE_URL` (gitignored `.env.local`), so real video plays locally:
     `/api/frigate/{iid}/vod/...` → `${FRIGATE_URL}/vod/...`,
     `/api/frigate/{iid}/notifications/{id}/review_preview.gif` → `${FRIGATE_URL}/api/review/{id}/preview`,
     `/api/frigate/{iid}/clips/...` → `${FRIGATE_URL}/clips/...`, and so on. This does
     not exercise HA auth or signing.
   - Fixtures: commit only anonymized `*.example.json`. Real snapshots go in
     `*.local.json` (gitignored).
3. `npm test`: Vitest unit tests (merge, grouping, cameras, provider parsers, time).
4. `npm run build` → `dist/event-reel-card.js`. `npm run lint` (eslint + tsc
   `--noEmit`).
5. Check: desktop Chrome, Firefox (no HEVC), mobile width 375 px, the HA Companion app
   on Android (and iOS if available), light and dark themes.

---

## 8. Release and HACS

- `hacs.json`: `{ "name": "Event Reel Card", "filename": "event-reel-card.js",
  "render_readme": true, "homeassistant": "<min>" }`. Set the minimum HA version from
  the APIs actually used (`getConfigForm`, `formatEntityState`, `getGridOptions`).
- GitHub Actions:
  - `ci.yml`: on push/PR, run `npm ci && npm run lint && npm test && npm run build`.
  - `release.yml`: on tag `v*`, build and attach `dist/event-reel-card.js` to the GitHub
    release.
- Use SemVer, starting at `v0.1.0`. Keep a `CHANGELOG.md`.
- Test installing the tagged release through HACS, not only a local `dist/` copy.
- The README covers features, a screenshot or GIF (from the dev harness with neutral
  footage, never private camera footage without the owner's OK), install
  (HACS custom repository and manual), the config reference, "Register your own
  events", the dependency tiers (§3.8), and troubleshooting (HEVC, retention, signed
  URLs, the Frigate notification proxy option).

---

## 9. Milestones and acceptance criteria

**Spikes (before or early in M1, about an hour each; record the results in §2)**
- S1. Playback matrix: HEVC (`hev1`) and H.264 VOD through HA on desktop Chrome, Firefox,
  the Android Companion app, and iOS (Companion or Safari) if available. Confirm the
  §5.4 fallback triggers fire.
  *Partly done (2026-10-10):* desktop Chromium plays the 4K HEVC `hev1` clip through the HA
  proxy with hls.js; the first frame takes about 4.5 s on the LAN (first segment ≈13 MB).
  Browsers hold back playback in hidden tabs, so the start timeout pauses while the page
  is hidden. The owner confirmed playback in the Companion app on their phone. Firefox
  and the other mobile platform are still open.
- S2. `frigate/reviews/subscribe` payload shape and behaviour after a reconnect. *From
  source:* the payload is the raw MQTT JSON string; the subscription registers in
  `connection.subscriptions`, so HA's generic unsubscribe works. The card only refetches on
  a message, so the shape doesn't matter.
- S3. The review still through `clips/review/...` via HA. *Done:* loads through HA.
- S4. VOD for an ongoing review (`end_time: null`) and for a review past retention.
- S5. A lock's `changed_by` through `history/history_during_period` with attributes.
  *Done:* all lock changes on the reference install got an actor.
- S6. Whether the LLM Vision calendar entity changes state right after a new event.

**M0. Scaffold**
- package.json, tsconfig, vite config, eslint/prettier, vitest, hacs.json, CI workflow,
  dev harness skeleton.
- Done when: `npm run build` produces a single file, the card renders "Event Reel" in the
  dev harness **and on a test view of the reference install**, and CI is green.

**M1. Replace the 24 h timeline (MVP, all P0 items)**
- Done when, on a test view of the reference install:
  1. The camera AI events for the last 24 h match the existing `llmvision-card`
     (same count and titles).
  2. Door, lock and presence come from `entities:`, with no duplicates
     (`llmvision.non_camera: false`).
  3. An entry sequence (unlock, open, close, lock) shows as one row.
  4. AI events on Frigate cameras attach to their review (reference: at least 65 of 67),
     and a second AI event on the same review attaches to it. The AI event at 14:16:26
     merges with the review 14:15:43–14:16:32 on the same camera (unit test).
  5. Reviews from a camera without AI show as their own rows.
  6. A doorbell AI event plays its Nest clip.
  7. Previews animate. The exact clip plays through the HA proxy on desktop Chrome.
     Where HEVC can't play (Firefox, possibly iOS), the preview plays with a clear
     message and a download option. Tested in the Android Companion app.
  8. A full day is readable at 375 px width. Reduced motion stops the animation. Rows
     open and close by touch and keyboard.
  9. It runs a full day next to the old card without errors.
- Then, **with the owner's approval:** replace the old card in the existing view (keeping
  its header, badges and shortcuts) and turn off the automation that copies door/lock/
  presence into LLM Vision.

**M2. Polish (P1)**
- Mark reviewed, download, filter chips, day strip, deep links, GUI editor.
- Done when: the GUI editor covers the common options without breaking YAML-only
  options, and a deep link from a mobile notification opens the clip.
- *Status (2026-10-10):* implemented.
  - Mark reviewed per event and "mark all" (for the visible rows) via
    `frigate/reviews/viewed`, shown optimistically until Frigate reports it.
  - Category chips (rows per category; a burst matches any category it contains) and a
    camera menu.
  - The day strip with ticks, an hourly histogram and 6-hour marks; tap or drag scrolls to
    the nearest row and highlights it.
  - Deep links `?reel=` / `#reel=` with a review id, an LLM Vision uid or our id; a notice
    when the event isn't in range.
  - The GUI editor is a custom element over `ha-form`, mapped through `editor-model.ts`, so
    per-entity options and other YAML-only keys survive. Providers can be switched off
    with `enabled: false` inside their object, which keeps their options.
  - `getStubConfig` suggests locks, door sensors and people.
  - The empty state shows the time of the last earlier event.
  - In HA 2026.10 the entity pickers read `hass` from a Lit context, so the editor only
    works inside HA's own app tree (the real card editor dialog), not when mounted
    elsewhere.

**M3. Release `v0.1.0`**
- README, CHANGELOG, a11y pass, release workflow, install through a HACS custom
  repository on the reference install from the tagged release.
- *Status (2026-10-10):* local work done. That covers the README (features, dependency
  tiers, install, options, own events, deep links, troubleshooting) with a screenshot of
  generated data, the CHANGELOG, version 0.1.0, an a11y pass, and a release workflow
  that checks the tag against the package version.
- *Released 2026-10-10:* `v0.1.0` is public on GitHub, published as one clean commit.
  CI and the release workflow passed, and the release carries `event-reel-card.js`. It is
  installed through HACS (custom repository) on the reference install, and the HACS file
  matches the release byte for byte. The card replaced the old timeline card in the
  reference install's day view, and the automation that copied door/lock/presence changes
  into LLM Vision is switched off.

**M4+. P2 items.**

---

## 10. Privacy rules (public repository)

- Never commit entity ids, names, hostnames, IPs, tokens, camera footage or fixtures
  from a real home. Use neutral examples (`camera.entrance`, `person.alex`).
- Real-install notes go in `CLAUDE.local.md` and real fixtures in `*.local.json`. Both
  are gitignored.
- Check `git diff --cached` for private data before every commit.

## 11. Open questions

1. Name: "Event Reel Card" (`custom:event-reel-card`). Rename before v0.1.0 if a better
   one comes up.
2. Should the card have a "timeline only" mode (no list, just the day strip plus a
   player) for wall tablets?
3. When the Frigate integration releases the time-range preview route, enable previews
   and synthesized clips for unmatched AI events (P2).

## 12. Review log

**2026-10-10.** Reviewed by Claude (Opus 5.5) and GPT-6-sol (xhigh), with live checks
against the reference install. Changes:
- The time-range preview route is not in the released Frigate integration (404).
  Removed from M1, feature-detected later.
- HLS signing verified end to end through HA. The `hev1` sample entry and the 4K bitrate
  make the codec fallback a main path. The fallback now triggers on real errors instead
  of a fixed `isTypeSupported` probe.
- Frigate websocket results are JSON strings, and `severity` takes one value.
- The notification proxy routes are unauthenticated by default and can be switched off,
  so there is a fallback chain for every media item.
- Merge is many-to-one, with no synthesized clips in M1, and footage is never hidden
  because of AI output by default.
- Door, lock and presence come from the entity provider instead of LLM Vision copies.
  Activity bursts and bounces are grouped.
- Doorbell clips exist, and LLM Vision events join Nest exactly by token.
- The default range is a rolling 24 h. The UI language follows HA (`auto`).
- New dependency policy (§3.8). The card works with HA core alone.
- M1 is now a thin "replace the 24 h timeline" milestone with acceptance criteria. The
  old M1–M3 feature set is spread over M1–M3 by priority.

**2026-10-10, M1 code review.** A fresh Claude (Opus 5.5) context and GPT-6-sol (xhigh)
reviewed the first M1 implementation. Fixed:
- Events keep their object identity across refreshes when unchanged, so an open clip no
  longer restarts and previews keep playing. The player restarts only for a different clip.
- The player invalidates pending loads on disconnect (no orphaned hls.js), has a start
  timeout, treats decode errors as codec failures, re-signs once on 401/403, and falls back
  from the preview to a still. Manifest signatures are cached for 5 minutes only.
- Bursts take only plain state changes; events with media but no mapped camera keep their
  own rows and group by camera label.
- A bounce needs at least 3 rapid flips (a quick open → close stays two steps). Presence
  flapping groups per person.
- Live state changes stay until the logbook returns them. Subscriptions start when a
  provider becomes available. Aliases apply to Frigate and Nest keys. Unknown Nest tokens
  are retried every 10 minutes at most. The merged clip end covers a late AI moment.
  Hour separators stay distinct on the DST fall-back day. One configured severity is sent
  to Frigate.
- Real ids in samples and tests were replaced with synthetic ones. They remain in the git
  history, so squash or rewrite it before the repository goes public.

Not changed: the integration's schema uses `Coerce(float)` for `after`/`before`, so
integer and fractional times both work.

**2026-10-10, M2 code review.** GPT-6-sol (xhigh) and a fresh Claude (Opus 5.5) context
reviewed M2. Fixed:
- Chip counts and active chips. The camera menu can't get stuck hidden, its value follows
  the filter, and per-event media keys are no longer listed as cameras.
- Deep links: they open bursts, refresh on a miss, are removed from the URL afterwards,
  and can be followed again.
- Day strip: it is a keyboard slider, accepts a touch tap or horizontal drag only, and makes
  one selection per frame. Hour marks are correct in half-hour zones. The toolbar and strip
  stick under the HA header.
- Empty state: it queries a real Frigate window, uses the card's filters, includes entities
  and asks again when rows age out.
- Editor: it validates ranges, restores a custom severity list, and returns a provider to
  "auto" when it started out absent. The card only refetches when data options change.
- Mark reviewed: failures are reported, and focus stays near the pressed control.
- Frigate items are fetched as reviewed + unreviewed and merged. Frigate 0.18 returns both
  when `reviewed` is omitted (verified in its source), but older versions default to
  unreviewed only.
