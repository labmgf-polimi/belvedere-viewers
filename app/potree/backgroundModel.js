// Textured background mesh layer for the Potree scene.
//
// Replaces the heavy `background` point-cloud octree with a Metashape-exported
// GLB. Visualization only: the mesh is excluded from picking, measurement and
// clipping, and the yearly point clouds remain the measurement data.
//
// NOTE: this module imports the ESM three at libs/three.js/build/three.module.js
// while Potree bundles its own copy inside libs/potree/potree.js. Mixing them is
// safe ONLY because both are exactly r124 (identical constants, duck-typed
// render path). Both must be upgraded together or not at all.

import * as THREE from "./libs/three.js/build/three.module.js";
import { GLTFLoader } from "./libs/three.js/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "./libs/three.js/libs/meshopt_decoder.module.js";

// The project CRS. Metashape writes this into metadata.xml. EPSG:7791 is
// RDN2008 / UTM 32N; the viewer's proj4 string (viewer.js) says +datum=WGS84,
// which PROJ treats as a null transform — numerically identical, different
// datum. Warn on anything else rather than silently mis-georeferencing.
const EXPECTED_SRS = "EPSG:7791";

/**
 * Read the local-frame origin from Metashape's ModelMetadata sidecar.
 *
 * @param {string} url
 * @returns {Promise<THREE.Vector3>}
 */
async function loadOrigin(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`background model: ${url} -> HTTP ${response.status}`);
  }

  const doc = new DOMParser().parseFromString(await response.text(), "text/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error(`background model: ${url} is not valid XML`);
  }

  const srs = doc.querySelector("SRS")?.textContent.trim() ?? "";
  const originText = doc.querySelector("SRSOrigin")?.textContent.trim();
  if (!originText) {
    throw new Error(`background model: ${url} has no <SRSOrigin>`);
  }

  const parts = originText.split(",").map((v) => Number(v.trim()));
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`background model: bad <SRSOrigin> "${originText}"`);
  }

  if (srs !== EXPECTED_SRS) {
    console.warn(
      `background model: SRS is "${srs}", expected ${EXPECTED_SRS}. ` +
        `No reprojection is applied — verify the mesh lines up with the point clouds.`
    );
  }

  return new THREE.Vector3(parts[0], parts[1], parts[2]);
}

/**
 * Turn a loaded glTF material into a flat, unlit backdrop material.
 *
 * Photogrammetric textures already have lighting baked in, and nothing adds a
 * light to Potree's scene, so MeshStandardMaterial would render black.
 */
function applyBackdropMaterial(mesh, maxAnisotropy) {
  const original = mesh.material;
  const map = original.map;

  if (map) {
    // Potree never sets renderer.outputEncoding, so it stays LinearEncoding.
    // GLTFLoader tags base-colour maps sRGBEncoding, which would linearize them
    // on read with no re-encode on output — i.e. far too dark. Passing them
    // through unconverted matches how Potree renders point-cloud RGB.
    map.encoding = THREE.LinearEncoding;

    // The GLB's sampler is minFilter=LINEAR, so GLTFLoader disables mipmaps.
    // Without them a distant backdrop shimmers badly under camera motion.
    map.generateMipmaps = true;
    map.minFilter = THREE.LinearMipmapLinearFilter;
    map.magFilter = THREE.LinearFilter;
    map.anisotropy = maxAnisotropy;
    map.needsUpdate = true;
  }

  mesh.material = new THREE.MeshBasicMaterial({
    map: map,
    // Metashape's triangle winding is not consistent enough for backface
    // culling: at oblique angles FrontSide punches holes through the terrain and
    // leaves dark slivers. The material is unlit, so drawing both sides costs
    // only the lost cull and looks correct from every angle.
    side: THREE.DoubleSide,
    // COLOR_0 multiplies the base colour; Metashape exports it alongside the
    // textures, where it would darken the result by roughly 2.3x.
    vertexColors: false,
    // The HQ normalization shaders read the point-cloud depth through a mediump
    // float. Desktop drivers promote to highp, some mobile GPUs do not; nudging
    // the mesh back resolves ties in favour of the points.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  original.dispose();

  mesh.frustumCulled = true;
  mesh.raycast = () => {}; // backdrop only: invisible to picking and measurement
}

/**
 * Load a background mesh and add it to the Potree scene.
 *
 * `baseUrl` is a directory holding `metadata.xml` and `model.glb`, e.g.
 * `.../potree/meshes/2009`.
 *
 * @param {Potree.Viewer} potreeViewer
 * @param {string} baseUrl
 * @param {string} name  label shown in the sidebar
 * @returns {Promise<THREE.Group>}
 */
export async function createBackgroundModel(potreeViewer, baseUrl, name) {
  const prefix = baseUrl.replace(/\/$/, "");
  const origin = await loadOrigin(`${prefix}/metadata.xml`);

  const root = new THREE.Group();
  root.name = name;
  // The GLB uses the glTF Y-up convention: (x, y, z) = (easting, height,
  // -northing). A +90 deg rotation about X maps it back to Potree's Z-up world.
  root.rotation.x = Math.PI / 2;
  // Vertices stay in the mesh's local frame (~10 km range, ~1 mm float32
  // resolution) and the UTM origin lives on the object. Baking absolute UTM into
  // the vertex buffer would quantize northings to 0.5 m and make them swim as
  // the camera moves. three composes the modelView matrix in float64 on the CPU,
  // so the large translation cancels before the float32 downcast.
  root.position.copy(origin);
  potreeViewer.scene.scene.add(root);

  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);

  const gltf = await loader.loadAsync(`${prefix}/model.glb`);

  const maxAnisotropy = potreeViewer.renderer.capabilities.getMaxAnisotropy();
  gltf.scene.traverse((node) => {
    if (node.isMesh) {
      applyBackdropMaterial(node, maxAnisotropy);
    }
  });
  root.add(gltf.scene);

  warnIfDetached(root, potreeViewer);

  return root;
}

/** Fail loudly when the mesh lands nowhere near the point clouds. */
function warnIfDetached(root, potreeViewer) {
  const pointclouds = potreeViewer.scene.pointclouds;
  if (pointclouds.length === 0) {
    return;
  }

  const meshBox = new THREE.Box3().setFromObject(root);
  const cloudBox = potreeViewer.getBoundingBox();
  if (!meshBox.intersectsBox(cloudBox)) {
    console.error(
      "background model: bounding box does not overlap the point clouds — " +
        "check <SRSOrigin> and the Y-up convention.",
      { mesh: meshBox, pointclouds: cloudBox }
    );
  }
}

/**
 * Add a visibility checkbox for the mesh under the sidebar's "Other" node.
 *
 * Must be called from inside the `loadGUI` callback — that is the only point at
 * which `#jstree_scene` is guaranteed to exist. Potree's generic check/uncheck
 * handlers flip `visible` on whatever object is stored as the node's `data`.
 */
export function registerInSceneTree(root) {
  const tree = $("#jstree_scene");
  if (tree.length === 0) {
    console.warn("background model: scene tree not ready, skipping toggle");
    return;
  }

  const node = tree.jstree(
    "create_node",
    "other",
    {
      text: root.name,
      icon: `${Potree.resourcePath}/icons/triangle.svg`,
      data: root,
    },
    "last",
    false,
    false
  );

  tree.jstree(root.visible ? "check_node" : "uncheck_node", node);
}
