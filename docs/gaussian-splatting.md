# Gaussian splatting viewer

Plan for a photoreal 3D Gaussian Splatting (3DGS) viewer for the Belvedere data,
how to produce the first splat model, and how it relates to the existing Potree
viewer.

Status: **plan, nothing implemented, no splat model exists yet.** Every number
marked *(unverified)* has not been measured on our data.

---

## 1. Decision summary

| | Recommendation |
|---|---|
| Renderer | **Do not write one.** Self-host [`@playcanvas/supersplat-viewer`](https://developer.playcanvas.com/user-manual/gaussian-splatting/viewing/) |
| Where | A **new page**, `app/splat/`, not a layer inside the Potree page |
| Trainer | [LichtFeld Studio](https://github.com/MrNeRF/LichtFeld-Studio) (GPLv3, native, CUDA) |
| Poses | Metashape → `File → Export → Export Cameras → Colmap (*.txt)`. **Do not re-run SfM.** |
| Delivery format | SOG / streamed SOG on the existing Hetzner bucket |
| Endgame | 3D Tiles + `KHR_gaussian_splatting` in a modern CesiumJS — a separate, larger project |

The core constraint is already documented in
[`background-mesh.md`](background-mesh.md#limits-and-when-this-stops-working):
the Potree page runs **three.js r124**, shared with the copy bundled inside
Potree 1.8, and Cesium 1.0 underneath it in a second canvas with **no shared
depth buffer**. Every modern splat renderer needs three ≥ r16x or its own engine,
and a splat of the glacier *contains* the point-cloud footprint, so the
Cesium-underlay trick would put it unconditionally behind the points — occlusion
would break exactly where it matters.

So: **a new viewer, cross-linked to the old one.** Not a new layer.

---

## 2. Viewer survey

Assessed August 2026. All of these are real, maintained, and used in production
somewhere — none of them needs us to implement a sorter.

### Recommended: SuperSplat Viewer (PlayCanvas)

- Open source, `npm i @playcanvas/supersplat-viewer`, or a **single-file HTML
  export** with the scene embedded — no server, no build step.
- Native **SOG** (Spatially Ordered Gaussians): ~15–20× smaller than the raw
  training PLY, and **Streamed SOG** for anything over ~1 M splats, with WebGPU
  where available.
- Comes with [SuperSplat](https://superspl.at/editor), the browser editor —
  crop, delete floaters, set the default camera, add annotations, publish.
  This is the piece that turns a raw training output into something publishable,
  and we would otherwise have to build it.
- Same organisation ships [`splat-transform`](https://github.com/playcanvas/splat-transform),
  the CLI we need for georeferencing and compression (§4.4).

**Why this one:** it is the only option where the *whole chain* — edit, compress,
LOD, host, embed — is one maintained toolset, and where the deliverable can be a
static file on the bucket we already have.

### Alternative: Reall3dViewer

[MIT, three.js-based](https://github.com/reall3d-com/Reall3dViewer). Choose this
instead if measurement inside the splat view is a day-one requirement.

- Built-in **marking and measurement**, GIS basemap integration, preset LOD.
- Reads `.ply`, `.splat`, `.spx`, `.spz`, `.sog`, `.glb`; its own `.spx` claims
  >95% reduction vs PLY.
- Vendor-reported 150 M-splat scene at 60 FPS desktop / 25–40 FPS modern phone
  *(unverified by us)*.

Trade-off: smaller community than PlayCanvas, and no equivalent of the SuperSplat
editor.

### Alternative: Spark (World Labs)

[An advanced 3DGS renderer for three.js](https://sparkjs.dev/). Choose this only
if we end up wanting splats *inside* a custom three.js scene alongside our own
geometry (GNSS markers, stake labels, section planes) rather than a standalone
scene viewer. Reads ply / sogs / spz / splat / ksplat. It is a renderer, not an
application — everything around it is ours to write.

### The geospatial endgame: 3D Tiles

Cesium shipped `KHR_gaussian_splatting` + `KHR_gaussian_splatting_compression_spz`
in **CesiumJS 1.139** (March 2026), then
[hierarchical LOD for splats in 3D Tiles](https://cesium.com/blog/2026/04/27/3d-gaussian-splats-lod/)
(April 2026). The reference dataset is 20 169 photos / 3.7 km² / 3 cm GSD →
**110 M splats**, streamed with LOD. That is our problem, one order of magnitude
larger.

This is where the project should end up, because it is the only option that puts
splats, the yearly point clouds, terrain and the GNSS annotations in **one
depth-correct georeferenced scene**. It is also the option that requires
replacing the frozen Cesium 1.0 + Potree/r124 stack, so it is a separate project,
not a step in this one.

Open-source tiler if we go there without Cesium ion:
[3DGS-PLY-3DTiles-Converter](https://github.com/WilliamLiu-1997/3DGS-PLY-3DTiles-Converter)
(PLY → explicit 3D Tiles, adaptive LOD, SPZ-compressed GLB), which also has a
[three.js `3d-tiles-renderer` plugin](https://github.com/NASA-AMMOS/3DTilesRendererJS)
path if we prefer three.js over Cesium.

### Explicitly not

- **mkkellogg/GaussianSplats3D** — the historically most popular three.js splat
  renderer and the origin of `.ksplat`, but the author has **archived active
  development**. Do not start here in 2026.
- **Writing our own renderer.** The sort is the whole problem: per-frame
  depth-ordering of millions of primitives, done on a worker or in WASM, plus
  spherical-harmonic evaluation and a tile-based blend. Three separate teams have
  solved it. We would spend the project's budget re-deriving it.

---

## 3. Repository and bucket layout

Mirrors the existing mesh convention exactly, so nothing new has to be learned:

```
app/
  splat/
    index.html          # standalone page, own three/engine, no Potree
    splatViewer.js
    libs/supersplat-viewer/
docs/
  gaussian-splatting.md # this file
```

```
belvedere-website/potree/splats/2023/
    metadata.xml        # SRS + SRSOrigin, same schema as meshes/
    scene.sog           # or meta.json + webp payload for unbundled SOG
```

Keep it **under the `potree/` prefix** even though it is not Potree: the bucket's
public-read policy and CORS (`enable_cors_s3_buckers.json`) are already proven
there, and the mesh troubleshooting table records that objects outside that
prefix have failed to be public before.

Reuse `metadata.xml` verbatim from the mesh workflow:

```xml
<ModelMetadata version="1">
  <SRS>EPSG:7791</SRS>
  <SRSOrigin>416000,5090000,2000</SRSOrigin>
</ModelMetadata>
```

The rule from the mesh doc carries over unchanged and is **more** important here,
because splat positions are quantized on top of float32:

> Keep coordinates in a local frame. Put the origin in the sidecar. Never bake
> absolute UTM into the payload.

Absolute northing 5.09e6 has a float32 ULP of **0.5 m**; a local frame of ≤1.4e4
has an ULP of ~1 mm. SOG quantizes positions *within the scene bounding box*, so
an absolute-UTM scene wastes its entire quantization budget on the offset.

---

## 4. Producing the first splat model

### 4.0 Choose a small scene first

Do **not** start with the whole glacier. Start with one UAV block — the tongue,
or the area around the D12 monument — a few hundred images. The full block can
follow once the chain is proven end to end.

### 4.1 Poses: export from Metashape, do not re-run SfM

This is the step that makes the whole thing cheap for us. The Metashape projects
are already aligned, GCP-constrained and georeferenced in EPSG:7791. A 3DGS
trainer needs exactly what a Metashape project already contains: camera
intrinsics, extrinsics, and a sparse point cloud to initialise from.

Agisoft discontinued its `export_for_gaussian_splatting.py` script because
[the functionality moved into Metashape 2.2](https://github.com/agisoft-llc/metashape-scripts/blob/master/src/export_for_gaussian_splatting.py):

> `File → Export → Export Cameras…` and choose **`Colmap (*.txt)`** in
> *Files of type*.

Notes:

- Tick **binary** to also get the undistorted images and a `sparse/0` folder of
  `.bin` files — the exact layout every trainer expects.
- Leave *Transform to pinhole camera model* **ticked** for our normal UAV lenses.
  Untick it only for fisheye, and only if the trainer supports 3DGUT / distorted
  camera models (LichtFeld Studio does).
- **Set a shift in the export dialog** so coordinates come out local, as we
  already do for the mesh (`Shift = 416000, 5090000, 2000`). Confirm the exported
  camera centres are 3–4 digit numbers, not 4e5 / 5e6. Whatever shift is used
  goes verbatim into `<SRSOrigin>`.
- Georeferencing is inherited from the bundle adjustment. There is **no separate
  registration step** and no Helmert fit to do afterwards — this is the whole
  reason to go via Metashape rather than COLMAP.

### 4.2 Train

| Tool | License | Runs on | Use when |
|---|---|---|---|
| **LichtFeld Studio** | GPLv3 | NVIDIA, CC ≥ 7.5, CUDA 12.8+ | **Default choice.** Train + inspect + edit + export in one app; MCMC, bilateral-grid appearance modelling, 3DGUT; exports PLY, **SOG**, **SPZ** and a standalone HTML viewer |
| **gsplat / nerfstudio** | Apache-2.0 | NVIDIA | Scripted / reproducible runs, or when we need to modify the method. ~4× less memory and ~10% faster than the reference INRIA implementation |
| **Brush** | Apache-2.0 | anything with WebGPU | No CUDA available (Mac, AMD). Slower. Consumes COLMAP/nerfstudio poses, does not compute them |
| **Postshot** | commercial | Windows/NVIDIA | Fastest path for someone who does not want a CLI |

Parameters that matter for an aerial glacier block:

- **Spherical-harmonic degree.** Degree 3 costs 45 of the 62 floats per splat.
  For nadir/oblique aerial imagery the view-direction range is narrow, so **SH
  degree 1–2** usually loses little and cuts file size roughly in half. Worth an
  A/B on the first scene.
- **Splat budget.** With MCMC, cap the count explicitly (start at 2–4 M for a
  test block). This is the single knob that controls the deliverable's size.
- **Sky and moving water.** Mask them, or expect floaters. Bright uniform snow is
  the same class of problem — see §7.
- **Appearance modelling.** Our UAV blocks span changing illumination across a
  flight. Bilateral-grid appearance modelling exists precisely for this; turn it
  on.

Training time: hours on a single modern NVIDIA GPU for a few-hundred-image block
*(unverified for our data — measure on the first run and record it here)*.

### 4.3 Clean up

Load the training PLY in [SuperSplat](https://superspl.at/editor) (browser, free)
and: delete floaters and sky, crop to the area of interest, set the default
camera pose, then export. Budget an hour of manual work. Skipping this is the
most common reason a splat looks bad on the web.

### 4.4 Georeference, compress, and place

[`splat-transform`](https://github.com/playcanvas/splat-transform) does
translation / rotation / scaling, filtering, decimation, SH-band stripping,
LOD generation and SOG compression, applying actions in the order given:

```bash
npx --yes @playcanvas/splat-transform \
  cleaned.ply \
  --filter-nan \
  -t 0,0,0 \
  scene.sog
```

Size arithmetic worth doing before generating anything:

| | per splat | 4 M splats |
|---|---|---|
| Raw 3DGS PLY (62 float32 properties, SH3) | 248 B | **≈ 1.0 GB** |
| SH stripped to degree 1 (26 props) | 104 B | ≈ 0.42 GB |
| SOG | — | **≈ 50–70 MB** *(at the quoted 15–20×)* |

Anything past ~1 M splats should be **streamed SOG** (`lod-meta.json` output)
rather than a single bundle — that is the documented threshold in the PlayCanvas
pipeline, and it is where load time stops being acceptable on a phone.

If we later go the 3D Tiles route, the same PLY goes to **SPZ** instead
(~90% smaller than PLY) inside `KHR_gaussian_splatting_compression_spz`.

### 4.5 Publish

```bash
aws s3 cp scene.sog s3://belvedere-website/potree/splats/2023/scene.sog \
  --content-type application/octet-stream \
  --endpoint-url https://nbg1.your-objectstorage.com

aws s3 cp metadata.xml s3://belvedere-website/potree/splats/2023/metadata.xml \
  --content-type application/xml \
  --endpoint-url https://nbg1.your-objectstorage.com
```

```bash
curl -sI -H "Origin: https://viewer.thebelvedereglacier.it" \
  https://belvedere-website.nbg1.your-objectstorage.com/potree/splats/2023/scene.sog \
  | grep -iE "^HTTP|access-control-allow-origin|content-type|content-length"
```

---

## 5. Verification

Same discipline as the background mesh — a splat that is 40 cm off looks
perfectly convincing, which is exactly the danger.

1. **It renders**, in roughly the right place, at a sane frame rate.
2. **Georeferencing.** Place a marker at a known GNSS stake from
   `/surveys/measurements/?year=2023` at `(east − x_off, north − y_off, h − z_off)`
   and confirm it lands on the ice surface. This catches a wrong origin, wrong
   CRS and wrong vertical datum in one shot.
3. **Vertical datum.** `N = h − h_orto ≈ 54.39 m` here. If the splat sits ~54 m
   off, the export used orthometric heights. Re-export; never patch it with a
   code offset.
4. **Cross-check against the point cloud.** Load the same year's Potree cloud in
   the other tab at the same camera pose and compare silhouettes at the tongue
   and at the moraine crests.
5. **Memory and load time** on a mid-range phone, not just the workstation.

### The rule that must not be broken

> **A splat is not a measurement.** It is a view-dependent appearance model.
> No volumes, no DEMs, no elevation differences, no ice-flow vectors from a
> splat. The point clouds remain the measurement data; the splat is
> visualization only, exactly like the background mesh.

Anything derived from a splat that ends up in a paper has to be traced back to
the point cloud or the GNSS measurements.

---

## 6. Integration with the Potree viewer

Three options, in the order they should happen.

### Step 1 — Two pages, one camera (do this first)

`app/splat/index.html` is its own page with its own engine. The Potree page gets
a **"View as photoreal splat"** button that opens it with the current camera
state in the query string; the splat page gets the reverse link.

Potree already parses camera state from the URL (`loadSettingsFromURL()`), so the
handoff is a small shared helper that converts between the Potree camera
(position + pivot, local EPSG:7791 metres) and the splat viewer's camera. Both
scenes use the same local origin from `metadata.xml`, so the conversion is a
translation.

Cost: the viewer page plus a day of glue. Risk: near zero — **nothing in the
Potree page changes except one button.**

### Step 2 — Stop hardcoding the asset list

`app/potree/viewer.js` hardcodes thirteen point-cloud URLs and derives the year
list from them. A second viewer makes that duplication expensive.

The backend already has the right model: `Product3D` (`products_3d`) carries
`bucket`, `object_key`, etag/size and `is_uploaded`. Adding a
`GET /surveys/products3d/` endpoint that lists 3D products per year and kind
(`pointcloud` | `mesh` | `splat`) lets **both** viewers build their year menus
from the database, and makes publishing a new splat a data operation rather than
a code change.

This is the one backend change worth making for this project. It is additive —
existing endpoints and response shapes are untouched.

### Step 3 — One Cesium scene (the real target, separate project)

Convert the point clouds and the splats to **3D Tiles** and run a single modern
CesiumJS app. This is what dissolves the problems the current architecture works
around:

| Current problem | Fixed by |
|---|---|
| Two canvases, no shared depth buffer; Cesium content always behind Potree | One renderer, one depth buffer |
| three.js r124 pinned by Potree 1.8, blocking every modern library | Potree removed from the stack |
| Full texture/point memory regardless of what is on screen | 3D Tiles hierarchical LOD, splats included |
| Manual GLB backdrop with a hand-sized atlas | Cesium World Terrain + our tilesets |

Cost is a rewrite of the 3D viewer, not an increment. Do not start it until
Step 1 has proven that splats are worth it for this data.

---

## 7. What splats actually buy this project

Ordered by how confident I am in each. The first three are the ones worth
building for.

### 7.1 Appearance where geometry fails — snow, ice, and thin things

A textured mesh of a glacier looks like melted plastic: the photogrammetric
texture is baked flat onto a surface that low-texture snow made unreliable in the
first place. Splats represent **view-dependent appearance directly**, so wet ice
keeps its specular response, shadowed crevasse walls keep their depth, and thin
features survive — **ablation stakes, GNSS antennas and tripods, cables, the
sharp lip of a crevasse, boulders on the moraine.** These are the exact features
that both meshing and point rendering handle badly, and they are the features
that make a glacier scene legible to a non-specialist.

Note the important asymmetry: splats still need *poses* from SfM, and low-texture
snow is hard for SfM. Splatting does not rescue an alignment that failed — but
our alignments already succeeded, with GCPs, so we are only changing what we do
*after* the bundle adjustment.

### 7.2 Re-rendering the time-lapse cameras — the most interesting one

`image_index` stores, per camera: an S3 archive of daily images, a 3D `location`,
and a `CameraCalibration` with full intrinsics and extrinsics (including the
custom `METASHAPE` camera model). That means we can render the splat **from the
exact calibrated pose of a real time-lapse camera** and get a synthetic image
that is pixel-comparable to the actual photographs.

Concrete uses:

- **Extrinsic drift monitoring.** Correlate the synthetic render against a real
  frame; a growing misalignment means the camera moved, which is currently only
  detected by eye.
- **Illumination-normalised change detection.** The synthetic image is the scene
  *as it was at survey time*. Differencing it against a real frame isolates what
  changed — fresh snow, an ice fall, a collapse — without the seasonal
  illumination confound that defeats naive frame differencing.
- **Gap filling for outreach.** Render a plausible frame for a day the camera
  missed, clearly labelled as synthetic.
- **Planning.** Render candidate camera positions before anyone carries a
  tripod up the moraine, and check what a proposed site would actually see.

This is the application that is genuinely novel and that our database is already
shaped for. Nobody else has both the calibrated fixed cameras and the annual
photogrammetric blocks.

### 7.3 Communication and outreach

The group has already published on
[strategies for glacier-retreat communication with 3D geovisualization](https://doi.org/10.3390/ijgi14020075).
Splats are, right now, the highest-impact 3D format for a non-technical audience,
and the standalone single-file HTML export means one can be embedded in
`thebelvedereglacier.it` with **no infrastructure at all** — a static file next
to the existing pages.

The obvious piece: a **then/now dissolve** between two years' splats at a fixed
camera. Two SOG scenes, one alpha crossfade, one slider. That single interaction
communicates a decade of retreat better than any of the current views.

### 7.4 Ground-level and field-site capture

Phone video of the D12 monument, a stake installation, or the summer-school field
sites → a splat in minutes, tied to the GNSS network by the surveyed monument
positions. Cheap, and it fills the scale gap between the UAV blocks and the point
measurements.

### 7.5 Marginal — the historic imagery

The 1977 / 1991 / 2001 reconstructions come from scanned analog aerial frames:
few images, wide baselines, no colour. 3DGS is data-hungry and its whole appeal
is view-dependent colour appearance, so a splat from those blocks would likely be
sparse and artefact-ridden. **Do not promise this.** If it is tried at all, try
it last, and treat it as an experiment.

---

## 8. First experiment

One week, one person, one question: *does a splat of this glacier look good
enough to be worth an architecture?*

1. Pick the 2023 UAV block. Subset to 300–600 images over the tongue.
2. Metashape → Export Cameras → Colmap (*.txt), binary, with the local shift.
3. Train in LichtFeld Studio. Cap at 3 M splats, SH degree 2, appearance
   modelling on. Record wall-clock time and VRAM here.
4. Clean in SuperSplat; crop to the tongue.
5. `splat-transform` → `scene.sog`. Record the file size.
6. Publish to `potree/splats/2023/`, open it in a self-hosted SuperSplat viewer.
7. Run the §5 checks. Put a marker on a GNSS stake and photograph the result.

**Definition of done:** a URL, a measured file size, a measured load time on a
phone, and a screenshot of the marker landing on the ice. Then decide about
Step 1 of §6.
