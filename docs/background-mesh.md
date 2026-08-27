# Background mesh

How the textured terrain backdrop in the Potree viewer works, and how to produce
and publish a new one.

## Why

The valley backdrop used to be a point-cloud octree
(`potree/pointclouds/background/`, 77 MB, 5.18 M points, from the 2009 Zeiss DMC
aerial survey at 2.5 m GSD). It was heavy enough that the load call was commented
out and the viewer shipped without a backdrop for a long time.

A textured mesh of the same area renders as solid terrain, looks better at every
zoom level, and costs a fraction of the bandwidth and GPU memory. The yearly
point clouds remain the measurement data — **the mesh is visualization only**: it
is excluded from picking, measurement and clipping.

## What is on S3

Same bucket and endpoint as the point clouds, under a `meshes/` sibling keyed by
year:

```
belvedere-website/potree/meshes/2009/
    metadata.xml     # written by Metashape — the manifest
    model.glb        # the mesh, must be named exactly this
```

Public URL: `https://belvedere-website.nbg1.your-objectstorage.com/potree/meshes/2009/…`

`metadata.xml` **is** the manifest. Metashape already writes the only two fields
the viewer needs, so nothing is hand-authored and nothing can drift out of sync
with the asset:

```xml
<ModelMetadata version="1">
  <SRS>EPSG:7791</SRS>
  <SRSOrigin>410000,5080000,0</SRSOrigin>
</ModelMetadata>
```

CORS is already covered bucket-wide by `enable_cors_s3_buckers.json` — no change
needed for a new mesh.

## How the viewer loads it

One module, [`app/potree/backgroundModel.js`](../app/potree/backgroundModel.js),
with two exports:

```js
createBackgroundModel(potreeViewer, baseUrl, name)  // -> Promise<THREE.Group>
registerInSceneTree(root)                           // sidebar visibility toggle
```

It is wired into [`app/potree/viewer.js`](../app/potree/viewer.js) in two places:

- the `createBackgroundModel(...)` call, started **after** the point-cloud loop
  so the single large GLB fetch does not starve the octree streams;
- `registerInSceneTree(root)` inside the existing `loadGUI` callback — that is
  the only point at which the sidebar's `#jstree_scene` is guaranteed to exist.

The mesh is added to `potreeViewer.scene.scene`. Nothing else changes: the render
loop, `main.js`, `annotations.js` and the year-hotspot controls are untouched
(the latter iterates `scene.pointclouds`, which the mesh is not part of).

The old background-octree line is left commented immediately above the call as
the rollback path.

### Depth interleaving with the point clouds

The mesh occludes, and is occluded by, the point clouds correctly. This is not
accidental — it depends on Potree's render order in the active HQ path
(`libs/potree/potree.js`):

```js
viewer.renderer.clear();
Utils.screenPass.render(viewer.renderer, normalizationMaterial);  // :71011
viewer.renderer.render(viewer.scene.scene, camera);               // :71014  <- the mesh
viewer.renderer.clearDepth();                                     // :71018
```

The renderer runs with `autoClear = false` (`:73272`), and the normalization
shaders write the real point-cloud depth into the default framebuffer via
`gl_FragDepthEXT` (`normalize.fs:58828`, `normalize_and_edl.fs:58895`),
discarding where there are no points. The mesh then depth-tests against it. The
`clearDepth()` *after* `scene.scene` is what makes this intentional rather than a
happy accident.

The EDL fallback (`useHQ = false`) reaches the same result in the opposite order:
it renders `scene.scene` first (`:70674`), then composites the point cloud with a
screen pass (`:70697`) whose `edl.fs` writes `gl_FragDepthEXT = fragDepth`
(`:58986`) and discards where there are no points — so those fragments still
depth-test against the mesh.

> **Caveat, unverified on mobile.** Those normalization shaders declare
> `precision mediump float`. Desktop drivers promote to highp; some mobile GPUs
> do not, which would show up as z-fighting at distance. The material sets
> `polygonOffset` so ties resolve in favour of the points. Not yet tested on a
> phone.

## Coordinate frame

> **Keep vertex positions in the mesh's local frame. Put the origin on the
> object's `position`. Never bake absolute UTM into a vertex buffer.**

The GLB is exported with Metashape's *glTF Y-up convention*, so the axis mapping
is:

```
gltf.x =  local easting
gltf.y =  height
gltf.z = -local northing
```

The inverse is a +90° rotation about X, `(x,y,z) → (x, −z, y)`. Because
`Object3D.matrix = T · R · S`, one group carrying both gives `world = R·v + O`:

```js
root.rotation.x = Math.PI / 2;           // glTF Y-up -> Potree Z-up
root.position.copy(origin);              // <SRSOrigin> from metadata.xml
```

### Why local coordinates matter

float32 has a 24-bit significand, so `ULP(v) = 2^(floor(log₂v) − 23)`:

| Quantity | Magnitude | ULP |
|---|---|---|
| Absolute northing | 5.09e6 | **0.5 m** |
| Local frame | ≤ 1.35e4 | **0.98 mm** |

Baking absolute UTM into the vertex buffer would fail twice: positions would be
permanently quantized to a 0.5 m grid, *and* the GPU would evaluate the ≈ −5.09e6
view translation in float32, where the catastrophic cancellation changes as the
camera moves — visible swimming.

Keeping vertices local works because three composes
`modelViewMatrix = camera.matrixWorldInverse · object.matrixWorld` on the CPU in
**float64** and only downcasts the product, whose translation `R·(O − camPos)` is
small. This is the same relative-to-centre trick as 3D Tiles' `RTC_CENTER`, and
it is what `PointCloudOctree` already does internally.

### CRS and height

EPSG:7791 (RDN2008 / UTM 32N) vs. the viewer's hard-coded `+datum=WGS84`
(`viewer.js`) are numerically identical — PROJ treats the transform as null — so
**no reprojection is applied**. They are not the same datum, though (~45 cm of
drift since epoch 2008.0), so the loader warns if `<SRS>` is anything other than
EPSG:7791 rather than silently mis-georeferencing.

Z is an absolute height with `SRSOrigin` z = 0, identical to the point clouds.
The backend's ENU frame and its `z_off = 1000` are backend-only concepts and must
not leak into the viewer.

## Material policy

Every setting in `applyBackdropMaterial()` is load-bearing. Changing one without
reading this will break something:

| Setting | Why |
|---|---|
| `MeshBasicMaterial` | Nothing adds a light to Potree's scene, so `MeshStandardMaterial` renders **black**. Photogrammetric textures have lighting baked in anyway. |
| `map.encoding = LinearEncoding` | Potree never sets `renderer.outputEncoding`, so it stays Linear. GLTFLoader tags base-colour maps sRGB, which would linearize on read with no re-encode on output — **far too dark**. |
| `side: DoubleSide` | Metashape's triangle winding is not consistent enough for backface culling. With `FrontSide` the terrain shows holes and dark slivers at oblique angles. Unlit material, so both sides cost only the lost cull. |
| `vertexColors: false` | `COLOR_0` multiplies the base colour. Metashape exports it alongside the textures, where it would darken the result ~2.3×. |
| mipmaps + anisotropy | The GLB's sampler is `minFilter: LINEAR`, so GLTFLoader **disables mipmaps**. Without the override a distant backdrop shimmers badly under camera motion. Needs power-of-two textures — 2048² is fine. |
| `polygonOffset` | Safety margin for the `mediump` depth read described above. |
| `mesh.raycast = () => {}` | Backdrop only — keeps it out of picking, measurement and profiles. |

## Workflow: producing a new mesh

### 1. Build and export in Metashape

1. `Tools → Decimate Model` to the target face count (~1 M is plenty for a
   backdrop).
2. `Workflow → Build Texture` — **after** decimation, because the atlas is
   discarded during the decimate step. Set `Pixel size (m)` to the source GSD
   (see sizing below), or set Texture size / Page count directly.
3. `File → Export → Export Model → Binary glTF (*.glb)`, CRS **EPSG:7791**, with:
   - ☑ export textures, **jpg**
   - ☑ write xml metadata
   - ☑ use glTF Y-up convention
   - ☐ vertex colors — *uncheck*; they are redundant and cost ~2 MB

Confirm the exported coordinate range is local (0–14 km, not 4e5–5e6). If the
writer re-absolutizes, set `Shift = (410000, 5080000, 0)` in the export dialog.

### 2. Size the texture atlas

Texture resolution beyond the source GSD adds bytes, not detail. Size the atlas
so one texel ≈ one GSD cell. With textured area `A`, source GSD `g`, page size
`s`:

```
texels needed = A / g²          pages = ceil(A / (g² · s²))
fixed pages n → s = sqrt(A / (n · g²))
```

Worked example for the 2009 mesh — footprint 4771 × 7235 m = 34.5 km², source
2.5 m GSD:

```
34.5e6 / 2.5²      = 5.52e6 texels
5.52e6 / 2048²     = 1.32   → 2 pages of 2048²
2 × 2048² / 34.5e6 = 2.0 m/texel   ≈ the 2.5 m source
```

Two checks worth keeping:

- **GPU memory** `= n · s² · 4 · 4/3` (RGBA8 + mip chain). For 2 × 2048² that is
  **45 MB**; for 2 × 8192² it would be **716 MB**, on top of the ~150 MB Potree
  already uses for its 3 M-point budget and HQ render targets. It scales as `s²`,
  so every doubling costs 4×.
- **Screen space**: at 60° FOV over 1920 px one pixel subtends 5.45e-4 rad, so at
  3 km it covers ~1.6 m of ground. A 2.0–2.3 m texel is right at that limit for a
  backdrop seen from a few km.

The 2009 mesh was first exported at 2 × 8192² — 0.58 m/texel, 4× oversampled
linearly and 16× in area, for no added detail. Re-baking at 2048² took the file
from 52 MB to 26 MB and texture memory from 716 MB to 45 MB.

### 3. Optional: compress for the web

Metashape emits no compressed glTF, so this step needs
[glTF-Transform](https://gltf-transform.dev/cli). It takes the 2009 mesh from
~26 MB to ~8 MB and requires **no viewer change** — `EXT_meshopt_compression` and
`EXT_texture_webp` are already implemented in the vendored `GLTFLoader`, and the
meshopt decoder is already in the repo.

Needs **Node ≥ 20.10** (the CLI uses `import ... with { type: 'json' }`).

```bash
GT="npx --yes @gltf-transform/cli@latest"   # in zsh use ${=GT}, it does not word-split

${=GT} webp    mesh.glb    1-webp.glb   --quality 85
${=GT} prune   1-webp.glb  2-pruned.glb --keep-attributes false
${=GT} meshopt 2-pruned.glb model.glb   --level high \
               --quantize-position 16 --quantization-volume scene
${=GT} inspect model.glb
```

- `prune --keep-attributes false` (it defaults to *true*) drops `COLOR_0` and
  `NORMAL`. Confirm in `inspect`.
- **`--quantization-volume scene` is not optional.** The default is `mesh`, and a
  Metashape export is several meshes sharing boundaries. Quantized over
  independent volumes their shared vertices land on different grids and open
  visible cracks along the seams.
- `--quantize-position 16` gives a 0.11 m step over a 7 km extent; the default 14
  bits gives 0.44 m, coarse enough to see on terrain.
- Never use `--texture-compress ktx2|etc1s|uastc`. The vendored `KTX2Loader.js`
  calls the deprecated global `MSC_TRANSCODER()` and has no `setTranscoderPath` —
  a dead end, not just missing binaries.

### 4. Upload

The GLB **must** be named `model.glb`, alongside `metadata.xml`:

```bash
aws s3 cp model.glb s3://belvedere-website/potree/meshes/2009/model.glb \
  --content-type model/gltf-binary \
  --endpoint-url https://nbg1.your-objectstorage.com

aws s3 cp metadata.xml s3://belvedere-website/potree/meshes/2009/metadata.xml \
  --content-type application/xml \
  --endpoint-url https://nbg1.your-objectstorage.com
```

Verify it is public and correctly typed:

```bash
curl -sI -H "Origin: https://viewer.thebelvedereglacier.it" \
  https://belvedere-website.nbg1.your-objectstorage.com/potree/meshes/2009/model.glb \
  | grep -iE "^HTTP|access-control-allow-origin|content-type|content-length"
```

Expect `200`, `access-control-allow-origin: https://viewer.thebelvedereglacier.it`,
and `content-type: model/gltf-binary`.

### 5. Point the viewer at it

In `app/potree/viewer.js`:

```js
const backgroundModel = createBackgroundModel(
  potreeViewer,
  `${S3_MESH_BASE}/2009`,
  "Background (2009 aerial)"
).catch((err) => { console.error("background model failed to load:", err); return null; });
```

To swap in a different year, change the prefix and the label. Nothing else moves.

## Adding a second mesh

The layout generalises for free — a 2015 backdrop is `potree/meshes/2015/`. To
show more than one, call `createBackgroundModel` once per mesh and register each
in the scene tree; each gets its own checkbox under **Scene → Other**. Give only
one an initially-visible root if they overlap, otherwise they will z-fight.

## Verification

After publishing a new mesh, check:

1. **It appears**, textured, in roughly the right place, with the yearly point
   clouds sitting inside it.
2. **Georeferencing** — drop a sphere at a known GNSS point
   (`/surveys/measurements/?year=…`) into `scene.scene` at `(east, north, h)` and
   confirm it lands on the mesh surface. This catches a wrong origin, wrong CRS
   *and* wrong vertical datum at once.
3. **Vertical datum** — compute `N = h − h_orto` from the backend for that point.
   If the mesh sits ~`N` off, re-export in the right height system; do not patch
   it with a code offset. *(Still unverified for the 2009 mesh.)*
4. **Occlusion** — orbit until a mesh ridge crosses in front of the glacier:
   points behind must disappear, points in front must survive. Repeat with
   `potreeViewer.useHQ = false` for the EDL path, and ideally on a phone.
5. **Oblique angles** — look from low and outside the footprint. Holes or dark
   slivers mean the material lost `DoubleSide`.
6. **Memory** — `potreeViewer.renderer.info.memory`. Texture memory should be
   ~45 MB for 2 × 2048², not hundreds of MB.
7. **Sidebar** — Scene → Other → the mesh's label; unchecking hides it.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Mesh is black | `MeshStandardMaterial` survived the material swap — there are no lights |
| Mesh is much too dark | `map.encoding` left as `sRGBEncoding`, or `COLOR_0` still applied |
| Holes / dark slivers at oblique angles | `side` reverted to `FrontSide` |
| Shimmering at distance | mipmap override missing; the GLB's sampler disables them |
| Mesh nowhere near the point clouds | wrong `<SRSOrigin>`, or the Y-up rotation is missing — the loader logs an error when the bounding boxes do not overlap |
| Vertices swim when panning at close range | absolute UTM was baked into the vertex buffer |
| Cracks along internal seams | meshopt quantized with the default `--quantization-volume mesh` |
| Nothing loads, CORS error | new object is not public, or was uploaded outside the `potree/` prefix |

## Limits, and when this stops working

The current approach is a single GLB loaded in one fetch. It is comfortable well
past the present asset:

| Tier | Budget |
|---|---|
| Comfortable | ≤ 3 M triangles, ≤ 4 × 2048², ≤ 40 MB |
| Stretched, desktop-first (with meshopt) | ≤ 10 M triangles, ≤ 8 × 2048², ≤ 100 MB |
| **Needs streaming LOD** | > 10 M triangles, or > 256 MB texture memory, or > 150 MB transfer |

The 2009 mesh (1 M triangles, 2 atlases, 26 MB) is firmly in the first tier.

Past the third tier the single-file approach fails for concrete reasons: the
fetched `ArrayBuffer`, the decoded typed arrays and the GPU staging copy all
coexist during upload (an OOM risk on 4 GB devices), the vendored `GLTFLoader`
parses on the main thread so the tab freezes, and with no LOD you pay full
texture memory regardless of how little is on screen.

**3D Tiles is not the answer here.** `3d-tiles-renderer` needs three ≥ 0.167 and
`three-loader-3dtiles` ≥ 0.160; the viewer runs three r124, shared with the copy
bundled inside Potree 1.8, and both must be the same build. Upgrading means
rebuilding a dormant Potree against r167+, crossing the r125 `Geometry` removal,
the r144 alias removal and the r152 colour-management change, plus Potree's
custom renderer and every shader. Loading tiles into the existing Cesium underlay
instead fails on depth — two canvases, no shared depth buffer, so Cesium content
is unconditionally behind everything Potree draws, and the mesh *contains* the
point-cloud footprint, so occlusion would break exactly where it matters.

The realistic next step is a **grid of chunk GLBs** with a few LOD levels and a
per-frame screen-space-error test — roughly 150–200 lines against the existing
r124 `GLTFLoader`, no new dependency. Everything in this document (the coordinate
rule, the material policy, the sidebar node, the depth behaviour, the `viewer.js`
call site) carries over unchanged.
