// Entry point for the camera viewer: owns the DOM wiring, the image sequence
// state, the timeline (noUiSlider + flatpickr) and playback.
//
// noUiSlider and flatpickr are globals from classic scripts loaded first.

import {
  clearUrlCache,
  fetchCameras,
  fetchCameraImages,
  getPreviewUrl,
} from "./api.js";

const cameraSelect = document.getElementById("camera-select");
const prevBtn = document.getElementById("prev-btn");
const nextBtn = document.getElementById("next-btn");
const playBtn = document.getElementById("play-btn");
const speedSelect = document.getElementById("speed-select");
const dateDisplay = document.getElementById("date-display");
const mainImage = document.getElementById("main-image");
const placeholder = document.getElementById("placeholder");
const spinner = document.getElementById("loading-spinner");
const statusEl = document.getElementById("status");
const sliderYearMin = document.getElementById("slider-year-min");
const sliderYearMax = document.getElementById("slider-year-max");
const sliderEl = document.getElementById("time-slider");

// ── State ────────────────────────────────────────────────────────────────────
let images = []; // [{id, datetime, filename, ...}]
let current = 0; // index into images
let playing = false;
let playTimer = null;
let sliderInstance = null;
let sliderUpdating = false; // prevent feedback loops between slider ↔ index

// ── Flatpickr ────────────────────────────────────────────────────────────────
const datePicker = flatpickr("#date-picker-input", {
  dateFormat: "Y-m-d",
  onChange([selectedDate]) {
    if (!images.length) return;
    jumpToDate(selectedDate);
  },
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function setStatus(msg) {
  statusEl.textContent = msg;
}

function showSpinner(on) {
  spinner.style.display = on ? "block" : "none";
}

function prefetchAdjacent(i) {
  if (images[i - 1]) getPreviewUrl(images[i - 1]).catch(() => {});
  if (images[i + 1]) getPreviewUrl(images[i + 1]).catch(() => {});
}

/** Jump to the image whose datetime is closest to targetDate. */
function jumpToDate(targetDate) {
  const target = targetDate.getTime();
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < images.length; i++) {
    const diff = Math.abs(new Date(images[i].datetime).getTime() - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  showImage(best);
}

/** Display image at index i. */
async function showImage(i) {
  if (!images.length) return;
  i = Math.max(0, Math.min(i, images.length - 1));
  current = i;

  const img = images[i];
  const dt = new Date(img.datetime);
  dateDisplay.textContent = dt.toLocaleString("en-GB", {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  prevBtn.disabled = i === 0;
  nextBtn.disabled = i === images.length - 1;

  // Update slider without triggering its own change handler
  if (sliderInstance) {
    sliderUpdating = true;
    sliderInstance.set(i);
    sliderUpdating = false;
  }

  // Update date picker (suppress its onChange)
  datePicker.setDate(dt, false);

  showSpinner(true);
  mainImage.style.display = "none";
  placeholder.style.display = "none";

  try {
    const url = await getPreviewUrl(img);
    mainImage.onload = () => {
      mainImage.style.display = "block";
      showSpinner(false);
      prefetchAdjacent(i);
    };
    mainImage.onerror = () => {
      placeholder.textContent = "Failed to load image.";
      placeholder.style.display = "block";
      showSpinner(false);
    };
    mainImage.src = url;
  } catch (err) {
    placeholder.textContent = `Failed to load image: ${err.message}`;
    placeholder.style.display = "block";
    showSpinner(false);
  }
}

// ── Slider setup ─────────────────────────────────────────────────────────────

function initSlider(count, minDate, maxDate) {
  if (sliderInstance) {
    sliderInstance.destroy();
    sliderInstance = null;
  }

  sliderYearMin.textContent = minDate.getFullYear();
  sliderYearMax.textContent = maxDate.getFullYear();

  noUiSlider.create(sliderEl, {
    start: [0],
    range: { min: 0, max: Math.max(1, count - 1) },
    step: 1,
    connect: "lower",
    tooltips: {
      to: (v) => {
        const idx = Math.round(v);
        if (!images[idx]) return "";
        return new Date(images[idx].datetime).toLocaleDateString("en-GB", {
          year: "numeric", month: "short", day: "numeric",
        });
      },
    },
  });

  sliderInstance = sliderEl.noUiSlider;
  sliderInstance.on("update", (values) => {
    if (sliderUpdating) return;
    showImage(Math.round(parseFloat(values[0])));
  });
}

// ── Playback ─────────────────────────────────────────────────────────────────

function stopPlay() {
  clearInterval(playTimer);
  playing = false;
  playBtn.textContent = "▶ Play";
}

function startPlay() {
  if (!images.length) return;
  playing = true;
  playBtn.textContent = "⏸ Pause";
  const fps = parseInt(speedSelect.value, 10);
  playTimer = setInterval(() => {
    if (current >= images.length - 1) {
      stopPlay();
      return;
    }
    showImage(current + 1);
  }, fps);
}

playBtn.addEventListener("click", () => (playing ? stopPlay() : startPlay()));
prevBtn.addEventListener("click", () => showImage(current - 1));
nextBtn.addEventListener("click", () => showImage(current + 1));

// Keyboard navigation
document.addEventListener("keydown", (e) => {
  if (!images.length) return;
  if (e.key === "ArrowLeft") { stopPlay(); showImage(current - 1); }
  if (e.key === "ArrowRight") { stopPlay(); showImage(current + 1); }
  if (e.key === " ") { e.preventDefault(); playing ? stopPlay() : startPlay(); }
});

// ── Camera selection ─────────────────────────────────────────────────────────

async function loadCamera(slug) {
  if (!slug) return;
  stopPlay();
  images = [];
  clearUrlCache();
  mainImage.style.display = "none";
  placeholder.textContent = "Loading…";
  placeholder.style.display = "block";
  prevBtn.disabled = nextBtn.disabled = playBtn.disabled = true;
  setStatus("Fetching image list…");

  try {
    images = await fetchCameraImages(slug, (n) => setStatus(`Loaded ${n} images…`));

    if (!images.length) {
      placeholder.textContent = "No images found for this camera.";
      setStatus("");
      return;
    }

    images.sort((a, b) => (a.datetime < b.datetime ? -1 : 1));

    const minDate = new Date(images[0].datetime);
    const maxDate = new Date(images[images.length - 1].datetime);

    initSlider(images.length, minDate, maxDate);

    // Configure date picker range
    datePicker.set("minDate", minDate);
    datePicker.set("maxDate", maxDate);

    playBtn.disabled = false;
    setStatus(`${images.length} images · ${minDate.getFullYear()}–${maxDate.getFullYear()}`);
    showImage(images.length - 1);
  } catch (err) {
    placeholder.textContent = `Error: ${err.message}`;
    placeholder.style.display = "block";
    setStatus("");
    console.error(err);
  }
}

cameraSelect.addEventListener("change", () => loadCamera(cameraSelect.value));

// ── Init: load camera list ───────────────────────────────────────────────────

(async () => {
  try {
    const cameras = await fetchCameras();
    cameras.forEach((cam) => {
      const opt = document.createElement("option");
      opt.value = cam.slug;
      opt.textContent = cam.camera_name;
      cameraSelect.appendChild(opt);
    });
    if (!cameras.length) setStatus("No cameras configured.");
  } catch (err) {
    setStatus("Failed to load cameras.");
    console.error(err);
  }
})();
