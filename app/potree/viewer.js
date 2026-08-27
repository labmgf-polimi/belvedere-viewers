import {
  createBackgroundModel,
  registerInSceneTree,
} from "./backgroundMesh.js";
import * as THREE from "./libs/three.js/build/three.module.js";

// Asset locations. POTREE_ASSETS_BASE is injected by config.php from the
// environment; the two sub-paths are fixed by the bucket layout documented in
// docs/background-mesh.md, so only the base is configurable.
const S3_BASE = `${POTREE_ASSETS_BASE}/pointclouds`;
const S3_MESH_BASE = `${POTREE_ASSETS_BASE}/meshes`;

const pointCloudURLs = [
  { url: `${S3_BASE}/1977/metadata.json`, name: "1977" },
  { url: `${S3_BASE}/1991/metadata.json`, name: "1991" },
  { url: `${S3_BASE}/2001/metadata.json`, name: "2001" },
  { url: `${S3_BASE}/2009/metadata.json`, name: "2009" },
  { url: `${S3_BASE}/2015/metadata.json`, name: "2015" },
  { url: `${S3_BASE}/2016/metadata.json`, name: "2016" },
  { url: `${S3_BASE}/2017/metadata.json`, name: "2017" },
  { url: `${S3_BASE}/2018/metadata.json`, name: "2018" },
  { url: `${S3_BASE}/2019/metadata.json`, name: "2019" },
  { url: `${S3_BASE}/2020/metadata.json`, name: "2020" },
  { url: `${S3_BASE}/2021/metadata.json`, name: "2021" },
  { url: `${S3_BASE}/2022/metadata.json`, name: "2022" },
  { url: `${S3_BASE}/2023/metadata.json`, name: "2023", visible: true },
];

// Survey years, derived from the point clouds above (single source of truth for
// the year list used by the hotspot controls).
export const pointCloudYears = pointCloudURLs.map(({ name }) => name);

// The year shown on startup — the hotspot controls seed their label and their
// prev/next cursor from it, so they must agree with `visible` above.
export const initialYear =
  pointCloudURLs.find(({ visible }) => visible)?.name ?? pointCloudYears[0];

// The point clouds are in the project CRS (EPSG:7791, RDN2008 / UTM 32N).
// `+datum=WGS84` is a PROJ null transform against it — numerically identical.
const POINTCLOUD_PROJECTION =
  "+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs +type=crs";
const MAP_PROJECTION = proj4.defs("WGS84");

// Scene coords -> WGS84 degrees, used by syncCesiumCamera below.
const toMap = proj4(POINTCLOUD_PROJECTION, MAP_PROJECTION);

window.cesiumViewer = new Cesium.Viewer("cesiumContainer", {
  useDefaultRenderLoop: false,
  animation: false,
  baseLayerPicker: false,
  fullscreenButton: false,
  geocoder: false,
  homeButton: false,
  infoBox: false,
  sceneModePicker: false,
  selectionIndicator: false,
  timeline: false,
  navigationHelpButton: false,
  imageryProvider: Cesium.createOpenStreetMapImageryProvider({url: "https://a.tile.openstreetmap.org/",}),
});

// MAPTILER_KEY comes from config.php (MAPTILER_KEY in the environment). Without
// it Cesium falls back to the plain ellipsoid instead of 403-ing on every tile.
if (typeof MAPTILER_KEY === "string" && MAPTILER_KEY !== "") {
  cesiumViewer.terrainProvider = new Cesium.CesiumTerrainProvider({
    url: `https://api.maptiler.com/tiles/terrain-quantized-mesh/?key=${MAPTILER_KEY}`, // get your own key at https://cloud.maptiler.com/
  });
} else {
  console.warn("MAPTILER_KEY is not set — rendering without terrain.");
}


let cp = new Cesium.Cartesian3(
  4303414.154026048,
  552161.235598733,
  4660771.704035539
);
cesiumViewer.camera.setView({
  destination: cp,
  orientation: {
    heading: Cesium.Math.toRadians(10),
    pitch: -Cesium.Math.PI_OVER_TWO * 0.5,
    roll: 0.0,
  },
});

window.potreeViewer = new Potree.Viewer(
  document.getElementById("potree_render_area"),
  {
    useDefaultRenderLoop: false,
  }
);
potreeViewer.setEDLEnabled(true);
potreeViewer.setFOV(60);
potreeViewer.setPointBudget(3_000_000);
potreeViewer.setMinNodeSize(50);
potreeViewer.loadSettingsFromURL();
potreeViewer.setBackground(null);
potreeViewer.useHQ = true;

potreeViewer.setDescription(`
		Explore the glacier pointclouds over time, load the Ground Control Points annotations and check out the velocity trends by clicking on the target of interest. Best performances on Google Chrome`);

// Load basemap pointcloud — superseded by the background mesh below, kept as the
// rollback path.
// loadPointCloud(`${S3_BASE}/background/metadata.json`, "Background", true);

// Load all point cloud data
pointCloudURLs.forEach(({ url, name, visible }) => {
  loadPointCloud(url, name, visible);
});

// The initial camera placement is the same for every cloud, so it is set once
// rather than on each iteration above.
potreeViewer.scene.view.setView(
  [418775.227, 5092016.318, 4084.847],
  [416658.847, 5090327.441, 2838.766]
);

// Started after the point clouds so the single large GLB fetch does not starve
// the octree streams. Must be declared before `loadGUI`, whose callback awaits
// it: `loadGUI` only happens to be async today (it pulls sidebar.html through
// jQuery's .load()), and a synchronous path would hit the temporal dead zone.
const backgroundMesh = createBackgroundModel(
  potreeViewer,
  `${S3_MESH_BASE}/2009`,
  "Background (2009 aerial)"
).catch((err) => {
  console.error("background model failed to load:", err);
  return null;
});

potreeViewer.loadGUI(() => {
  potreeViewer.setLanguage("en");

  // initAccordion() collapses every section; it has already run by the time
  // this callback fires, so re-opening here sticks. Filters and About stay
  // collapsed — both are long and neither is needed on arrival.
  // $("#menu_appearance").next().show();
  $("#menu_tools").next().show();
  $("#menu_scene").next().show();

  let section = $(
    `<h3 id="menu_meta" class="accordion-header ui-widget"><span>Credits</span></h3><div class="accordion-content ui-widget pv-menu-list"></div>`
  );
  let content = section.last();
  content.html(`
    <div class="pv-menu-list">
        <li><b>Long-term photogrammetric monitoring of the Belvedere glacier</b></li>
        <li>This project aims at a thorough and accurate 4D monitoring of the Belvedere Glacier with photogrammetric approaches, exploiting different spatial (from centimetric to metric) and temporal resolution (from daily to 10-year periods) and with different platforms (UAVs, aerial photogrammetry, terrestrial time-lapse cameras)</li>
        <li>Since 2015, an extensive and continuous monitoring activity was carried out with UAVs-based photogrammetry and in-situ GNSS measurements (Ioli et al, 2022). Every year, fixed-wing UAVs and quadcopters were used to remotely sense the glacier and build high-resolution photogrammetric models in order to estimate annual variations of ice volume and ice flow velocities.</li>
        <li>Moreover, to reconstruct the long-term evolution of the glacier, from 1977 up to now, we used historical images acquired for regional mapping purposes. Historic analog images were digitalized and processed with a modern photogrammetric approach to derive the glacier 3D morphology in 1977, 1991 and 2001 (De Gaetani et al., 2021).</li>
        <li>All the point clouds are available as Open-Data on Zenodo from here <a href="https://zenodo.org/record/7842348" target="_blank">https://zenodo.org/record/7842348</a></li>
        <li>Ioli, F.; Bianchi, A.; Cina, A.; De Michele, C.; Maschio, P.; Passoni, D.; Pinto, L. <i>Mid-Term Monitoring of Glacier’s Variations with UAVs: The Example of the Belvedere Glacier.</i> Remote Sens. 2022, 14, 28. <a href="https://doi.org/10.3390/rs14010028" target="_blank">https://doi.org/10.3390/rs14010028</a></li>
        <li>De Gaetani, C.I.; Ioli, F.; Pinto, L. <i>Aerial and UAV Images for Photogrammetric Analysis of Belvedere Glacier Evolution in the Period 1977–2019.</i> Remote Sens. 2021, 13, 3787. <a href="https://doi.org/10.3390/rs13183787" target="_blank">https://doi.org/10.3390/rs13183787</a></li>
    </div>
    `);
  content.show();
  section.first().click(() => content.slideToggle());
  // Second to last, just above the stock "About" section.
  section.insertBefore($("#menu_about"));

  // The sidebar tree only exists once loadGUI has run; the mesh may still be
  // loading, so register whenever both are ready.
  backgroundMesh.then((root) => root && registerInSceneTree(root));

  // Potree ships with the sidebar collapsed (#potree_render_area starts at
  // left: 0). Open it once on load; the hamburger still toggles it shut.
  potreeViewer.toggleSidebar();
});

function loadPointCloud(url, name, visible = false) {
  Potree.loadPointCloud(url, name, (e) => {
    let pointcloud = e.pointcloud;
    let material = pointcloud.material;
    let scene = potreeViewer.scene;
    material.size = 0.7;
    material.intensityRange = [1, 100];
    material.pointSizeType = Potree.PointSizeType.ADAPTIVE;
    material.shape = Potree.PointShape.CIRCLE;
    material.activeAttributeName = "rgba"; // change this value to "classification" and uncomment the next 2 lines if you desire to show the classified point cloud
    pointcloud.visible = visible;
    scene.addPointCloud(pointcloud);
  });
}

/**
 * Drive the Cesium camera from the Potree camera so the two scenes line up.
 *
 * Potree renders the point clouds, Cesium renders the terrain and basemap
 * behind them; they are separate renderers, so Cesium has to be re-aimed from
 * Potree's camera every frame.
 */
function syncCesiumCamera() {
  const camera = potreeViewer.scene.getActiveCamera();

  const pPos = new THREE.Vector3(0, 0, 0).applyMatrix4(camera.matrixWorld);
  const pUp = new THREE.Vector3(0, 600, 0).applyMatrix4(camera.matrixWorld);
  const pTarget = potreeViewer.scene.view.getPivot();

  // Scene coords (UTM 32N) -> Cesium ECEF.
  const toCes = (pos) =>
    Cesium.Cartesian3.fromDegrees(...toMap.forward([pos.x, pos.y]), pos.z);

  const cPos = toCes(pPos);
  const direction = (target) =>
    Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.subtract(toCes(target), cPos, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    );

  cesiumViewer.camera.setView({
    destination: cPos,
    orientation: { direction: direction(pTarget), up: direction(pUp) },
  });

  // Cesium's PerspectiveFrustum.fov is the horizontal angle when the viewport
  // is wider than it is tall, and the vertical angle otherwise. Potree's fov is
  // always vertical, so only the landscape case needs converting.
  const fovy = Math.PI * (camera.fov / 180);
  cesiumViewer.camera.frustum.fov =
    camera.aspect < 1
      ? fovy
      : Math.atan(Math.tan(0.5 * fovy) * camera.aspect) * 2;
}

function loop(timestamp) {
  requestAnimationFrame(loop);

  potreeViewer.update(potreeViewer.clock.getDelta(), timestamp);
  potreeViewer.render();

  syncCesiumCamera();
  cesiumViewer.render();
}

requestAnimationFrame(loop);
