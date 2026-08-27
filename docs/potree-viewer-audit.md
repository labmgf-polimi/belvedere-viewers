# Potree viewer audit — August 2026

A review of the hand-written viewer code in `app/` (`potree/index.php`,
`viewer.js`, `main.js`, `annotations.js`, `backgroundModel.js`, `config.php`).
The vendored `potree/libs/` are upstream and out of scope.

The fixes below were applied in place. The architecture is unchanged: globals
(`potreeViewer`, `cesiumViewer`, `API_BASE`), classic scripts plus two ES
modules, jQuery for DOM work, Potree's own annotation and scene-tree APIs. No
build step was introduced.

## Changes at a glance

| # | File | Problem | Fix |
|---|---|---|---|
| 1 | `potree/annotations.js` | `innerHTML = ""` on `#gcp-chart` deleted `#chart-container` and `#close-btn`; `#close-btn` had no handler at all | Render into `#chart-container`; never touch `#gcp-chart.innerHTML`; button wired in `main.js` |
| 2 | `potree/annotations.js` | New `echarts.init` per click, previous instance never disposed → leaked canvas each time | One instance via `getInstanceByDom(...) ?? init(...)`, refreshed with `setOption(opt, true)`; `resize` listener added |
| 3 | `potree/annotations.js` | One `/velocity/` request **per GNSS point** at load, then the same endpoint again on click | Eager fetch deleted; the single on-click fetch also fills the survey dates |
| 4 | `potree/annotations.js` | `dataView`, `showTitle`, `yAxis: seriesData` in the wrong place → silently ignored | Moved into `toolbox.feature` / onto `toolbox`; bogus key deleted |
| 5 | `potree/annotations.js` | `console.log`s left in; `titleText` interpolated into an HTML string | Logs removed; `$("<span></span>").text(titleText)` |
| 6 | `potree/main.js` | Repeated "Load GNSS Measurements" stacked duplicate annotation sets | `scene.annotations.removeAllChildren()` before adding |
| 7 | `potree/main.js`, `annotations.js` | No `response.ok` check — a 500 became a misleading JSON parse error | Shared `asJson()` guard; chart failures surface in the panel |
| 8 | `potree/index.php` | Year links had **two** click handlers, so every selection ran twice | jQuery `$(".link a").click(...)` duplicate deleted |
| 9 | `potree/index.php`, `viewer.js` | `currentIndex = 0` (1977) while 2023 was the visible cloud; label stuck on "Explore" | `viewer.js` exports `initialYear`; cursor and label seeded from it |
| 10 | `potree/viewer.js` | `scene.view.setView(...)` inside the 13-iteration `forEach` | Moved out, called once |
| 11 | `potree/viewer.js` | Dead block computing `bb` / `minWGS84` / `maxWGS84`, calling `getBoundingBox()` on each of 13 loads | Block deleted |
| 12 | `potree/viewer.js` | proj4 strings and `window.toMap` / `toScene` rebuilt identically per load | Hoisted to module scope |
| 13 | `potree/viewer.js` | `pRight` computed every frame, never used | Deleted |
| 14 | `potree/viewer.js` | `heading: 10` — heading is radians, so ≈573° | `Cesium.Math.toRadians(10)` |
| 15 | `potree/viewer.js` | `backgroundModel.then(...)` called ~50 lines above its `const` declaration | Declaration moved before `loadGUI`; ordering requirement commented |
| 16 | `potree/viewer.js`, `config.php`, `docker-compose.yml` | MapTiler key hardcoded in source | Read from `MAPTILER_KEY` env via `config.php`; empty key skips terrain and warns |
| 17 | `potree/css/style.css` | `#chart-container` had no dimensions (the old throwaway div was sized inline) | `width/height: 100%` added |

Nothing in `potree/backgroundModel.js` needed changing beyond point 15, which
lives in `viewer.js`. The vendored `potree/libs/` were not touched.

## Read this before "fixing" the heights

**`main.js` uses `point.h` (ellipsoidal) on purpose. Do not switch it to
`h_orto`.**

The point clouds are georeferenced in *ellipsoidal* height, so the annotation
Z must be `h`. This is easy to get wrong because `h_orto` is the field that
looks like an elevation, and the error is a clean ~54 m offset that reads as
"the annotations float above the glacier".

Evidence — the root node of `offline-assets/pointclouds/2023/octree.bin` was
decoded (DEFAULT encoding, 37 B/point, `offset`/`scale` from `metadata.json`)
and compared against measurement id 739:

| | East | North | Z |
|---|---|---|---|
| Measurement 739, `h` (ellipsoidal) | 416334.880 | 5091229.012 | **1956.005** |
| Measurement 739, `h_orto` (orthometric) | 416334.880 | 5091229.012 | 1901.623 |
| Nearest cloud points, 15–35 m away | — | — | **1931 – 1960** |

The cloud surface brackets `h`. `h_orto` would sit ~40–50 m below it. Geoid
undulation in this area is ≈ 54.39 m (backend `context/architecture.md:98`).

Two more things that look wrong but are not:

- The `+proj=utm +zone=32 +datum=WGS84` proj4 string in `viewer.js` versus the
  project's EPSG:7791 is a PROJ **null transform** — numerically identical,
  different datum label. Already explained in `backgroundModel.js:16-20`.
- `backgroundModel.js` imports its own ESM three while Potree bundles a second
  copy. Safe because both are exactly r124; see the note at the top of that
  file. Upgrade both or neither.

## Bugs fixed

### The chart panel destroyed its own scaffolding

`fetchVelocitytData` ran `panelElement.innerHTML = ""` against `#gcp-chart`,
deleting `#chart-container` **and** `#close-btn` from the DOM on the first
annotation click. `#close-btn` also had no click handler anywhere in the repo,
so the "X" was dead UI that CSS styled and nothing wired up.

Now: the chart renders into the existing `#chart-container`, nothing writes to
`#gcp-chart.innerHTML`, and `main.js` wires the close button to hide the panel.
`#chart-container` got explicit `width/height: 100%` in `css/style.css` —
ECharts needs a sized container, which the old throwaway `#movement-chart` div
provided inline.

### ECharts instance leaked on every click

Each click built a fresh `<div id="movement-chart">`, called `echarts.init` on
it, and removed the previous div without ever calling `dispose()` — leaking a
canvas and a registry entry per click.

Now: one instance for the lifetime of the page, via
`echarts.getInstanceByDom(container) ?? echarts.init(container)`, refreshed with
`setOption(option, true)` (the `true` replaces rather than merges, so switching
points does not leave the old series behind). The "no data" path disposes the
instance before writing its message. A `resize` listener was added — the panel
is sized in `%` and ECharts does not follow window resizes on its own.

### One API request per GNSS point, per load

`createAnnotation` fired `GET /surveys/points/<label>/velocity/` for **every**
annotation at creation time, purely to append two dates to the description. The
click handler then fetched the *same* endpoint again. Loading N points cost N
round-trips before the user had clicked anything.

Now: nothing is fetched until an annotation is opened, and the single fetch that
draws the chart also fills in the first/last survey dates. This also removed a
latent temporal-dead-zone hazard where the eager `.then()` assigned
`annotation.description` for a `let annotation` declared further down.

### Duplicate annotations on repeated loads

Clicking "Load GNSS Measurements" twice, or changing year and loading again,
stacked a second full set of annotations on top of the first. The handler now
calls `scene.annotations.removeAllChildren()` first.

### Every year click ran twice

The year links carried two click handlers: a `querySelectorAll(...)
.addEventListener` block and a `$(".link a").click(...)` block, both calling
`handlePointCloudVisibility` + `changeHotspotName` and both hiding `#lists`.
The jQuery duplicate was deleted.

### Prev/next started on the wrong year

`currentIndex = 0` (1977) while the initially visible cloud is 2023, the last
entry — so the first "next" click jumped to 1991, and the label read "Explore"
until the user touched something. `viewer.js` now exports `initialYear`
alongside `pointCloudYears` (the URL list stays the single source of truth) and
`index.php` seeds both the cursor and the label from it.

### Malformed ECharts options

Three keys sat in the wrong place and were silently ignored, so toolbox features
the author had asked for never appeared:

| Was | Should be |
|---|---|
| `dataView` at the option root | inside `toolbox.feature` |
| `showTitle` inside `toolbox.feature` | on `toolbox` |
| `yAxis: seriesData` nested inside `yAxis` | deleted — meaningless |

### `viewer.js` dead code and loop-invariant work

- `scene.view.setView(...)` sat **inside** the `pointCloudURLs.forEach`, running
  13 times with identical arguments. Moved out.
- A bare `{ … }` block in the load callback computed `bb`, `minWGS84` and
  `maxWGS84`, used none of them, and called `potreeViewer.getBoundingBox()` —
  which iterates every loaded cloud — on each of the 13 loads. Deleted.
- The two proj4 strings and `window.toMap` / `window.toScene` were rebuilt
  identically on each load. Hoisted to module scope.
- `pRight` in the render loop was computed every frame and never used. Deleted.
- `heading: 10` in the initial Cesium `setView` — heading is in **radians**, so
  this meant ≈573°. Harmless (the render loop overwrites the camera on frame
  one) but wrong; now `Cesium.Math.toRadians(10)`.

### `backgroundModel` was referenced before its declaration

The `loadGUI` callback called `backgroundModel.then(...)` while
`const backgroundModel` was declared ~50 lines below it. This worked *only*
because Potree's `loadGUI` pulls `sidebar.html` through jQuery's async
`.load()`; any synchronous path would have thrown a `ReferenceError`. The
declaration now precedes `loadGUI`, and the ordering requirement is stated in a
comment so it survives the next edit.

### Error handling

None of the fetches checked `response.ok`, so a backend 500 degraded into a
JSON parse error with a misleading message. All three now throw a response-aware
error that the existing `.catch` reports, and failures in the chart path surface
in the panel instead of only the console.

## Security

The MapTiler terrain key was hardcoded in `viewer.js`. It now comes from the
environment through `config.php`, the same route `API_BASE` already used, with
`MAPTILER_KEY` added to `docker-compose.yml`. An empty key skips the terrain
provider and warns, rather than 403-ing on every tile request.

**The old key is still in git history and must be rotated on MapTiler.** Moving
it out of the working tree does not revoke it.

## Known issues, not addressed

- **ECharts is loaded from a public CDN** (`fastly.jsdelivr.net/npm/echarts@5`)
  while every other library is vendored under `potree/libs/`. The viewer is
  therefore not fully offline-capable despite `offline-assets/` existing, and the
  unpinned minor version can break the chart on an upstream release. Vendoring it
  is a small, self-contained change.
- **`offline-assets/meshes/2009/mesh.glb`** does not match the `model.glb` name
  `backgroundModel.js` expects, so the offline mesh copy cannot be used as-is.
- **Cesium constructor API**: `imageryProvider:` and `CesiumTerrainProvider({url})`
  are the pre-1.104 forms. Fine against the vendored Cesium, a blocker for any
  upgrade.
- **`.controls { right: 700px }`** in `css/style.css` hardcodes the sidebar
  width, so the year selector drifts out of place when the sidebar is collapsed
  or the window is narrow.

## Verifying

No test suite exists for the viewers; verification is manual.

```bash
cd belvedere-viewers
API_BASE=http://localhost:8000 MAPTILER_KEY=<key> docker compose up --build
# backend, separate shell:
cd ../belvedere-backend && uv run python manage.py runserver
```

Open `http://localhost:8001/potree/` with the console and Network tab open:

1. Console clean on load — no `ReferenceError`, no `background model: …` error,
   no stray `console.log`.
2. Hotspot label reads `2023` and only the 2023 cloud is visible, with the mesh
   behind it. "next" → `1977` (wraps), "prev" → `2022`.
3. Breakpoint in `handlePointCloudVisibility`, click a year — fires **once**.
4. "Load GNSS Measurements" for 2023: exactly one `/surveys/measurements/`
   request and **zero** `/velocity/` requests. Click it again — the annotation
   count must not double.
5. Annotations hug the point-cloud surface, not ~54 m above or below it. This is
   the regression guard for the height-datum finding above.
6. Click an annotation title: panel opens with the chart and the first/last
   survey dates. Click a second annotation — the chart replaces the first, and
   `echarts.getInstanceByDom(document.getElementById('chart-container'))`
   returns the **same** object both times. `X` closes it; reopening works.
   Resize the window — the chart follows.
7. Stop the Django server and click "Load": one `console.error` naming the
   failed request, no unhandled rejection.
8. Restart with `MAPTILER_KEY` unset: one warning, viewer renders on the plain
   ellipsoid, no 403 flood.
