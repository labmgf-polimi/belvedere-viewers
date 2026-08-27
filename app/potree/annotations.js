// GNSS point annotations and their velocity chart.
//
// The chart is drawn into the `#chart-container` element declared in index.php.
// That element and the `#close-btn` next to it must survive across openings, so
// nothing here ever writes to `#gcp-chart` itself.

const CHART_CONTAINER_ID = "chart-container";

/** The persistent element the ECharts instance lives in. */
function chartContainer() {
  return document.getElementById(CHART_CONTAINER_ID);
}

/**
 * Get the chart instance for the panel, creating it on first use.
 *
 * ECharts keeps one instance per DOM element; re-initialising without
 * disposing leaks a canvas and a registry entry on every click.
 */
function getChart(container) {
  const existing = echarts.getInstanceByDom(container);
  if (existing) {
    return existing;
  }
  container.textContent = ""; // drop a previous "no data" message
  return echarts.init(container);
}

/** Replace the chart with a plain text message. */
function showChartMessage(message) {
  const container = chartContainer();
  echarts.getInstanceByDom(container)?.dispose();
  container.textContent = message;
}

window.addEventListener("resize", () => {
  const container = chartContainer();
  if (container) {
    echarts.getInstanceByDom(container)?.resize();
  }
});

/**
 * Create and add a Potree annotation to the scene with the provided information.
 *
 * @param {number} id - Unique identifier for the annotation.
 * @param {object} scene - The Potree scene in which the annotation will be added.
 * @param {string} titleText - Text for the title of the annotation.
 * @param {number[]} position - Array containing x, y, z coordinates of the annotation position.
 * @param {number[]} cameraPosition - Array containing x, y, z coordinates of the camera position.
 * @param {number[]} cameraTarget - Array containing x, y, z coordinates of the camera target.
 * @param {string} descriptionText - Text for the description of the annotation.
 * @returns {object} The created Potree.Annotation.
 */
function createAnnotation(
  id,
  scene,
  titleText,
  position,
  cameraPosition,
  cameraTarget,
  descriptionText
) {
  const titleElement = $("<span></span>").text(titleText);

  const annotation = new Potree.Annotation({
    position: position,
    title: titleElement,
    cameraPosition: cameraPosition,
    cameraTarget: cameraTarget,
    description: descriptionText,
  });
  // Assigning unique ID from database
  annotation.customId = id;
  annotation.visible = true;
  scene.annotations.add(annotation);
  // Potree stringifies the title when building the annotation list
  titleElement.toString = () => titleText;

  // The velocity series is fetched only when the user opens the annotation:
  // fetching it up front costs one request per GNSS point on every load.
  titleElement.click(() => {
    document.getElementById("gcp-chart").style.visibility = "visible";
    showVelocity(titleText, annotation, descriptionText);
  });

  return annotation;
}

/** First and last survey dates covered by a velocity series, as HTML. */
function surveyDateRange(data) {
  const minSurveyDate = new Date(
    Math.min(...data.map((entry) => new Date(entry.survey_date_ini)))
  );
  const maxSurveyDate = new Date(
    Math.max(...data.map((entry) => new Date(entry.survey_date_fin)))
  );
  return (
    `<br><b>Least recent survey date:</b> ${minSurveyDate.toLocaleDateString()}` +
    `<br><b>Most recent survey date:</b> ${maxSurveyDate.toLocaleDateString()}`
  );
}

/** Fetch the velocity series for a point, draw it and complete the description. */
function showVelocity(pointLabel, annotation, baseDescription) {
  fetch(`${API_BASE}/surveys/points/${encodeURIComponent(pointLabel)}/velocity/`)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`velocity request failed: HTTP ${response.status}`);
      }
      return response.json();
    })
    .then((data) => {
      if (!data || data.length === 0) {
        console.warn("No velocity data found for the point label:", pointLabel);
        showChartMessage(`No velocity data found for point ${pointLabel}`);
        return;
      }
      annotation.description = baseDescription + surveyDateRange(data);
      renderVelocityChart(data, pointLabel);
    })
    .catch((error) => {
      console.error("Error fetching velocity data:", error);
      showChartMessage(`Could not load velocity data for point ${pointLabel}`);
    });
}

/** Draw the velocity series in the chart panel. */
function renderVelocityChart(data, pointLabel) {
  const xAxisData = data.map((entry) => entry.survey_year);
  const seriesData = data.map((entry) => parseFloat(entry.v));

  const option = {
    textStyle: {
      color: "#fff",
    },
    title: {
      text: "Velocity over time for point " + pointLabel,
      textStyle: {
        color: "#fff",
      },
      textAlign: "auto",
      padding: 10,
      left: "center",
    },
    xAxis: {
      type: "category",
      data: xAxisData,
    },
    yAxis: {
      type: "value",
      name: "Velocity (m/d)",
    },
    tooltip: {
      trigger: "axis",
      valueFormatter: (value) => parseFloat(value).toFixed(3) + " m/d",
    },
    toolbox: {
      showTitle: true,
      feature: {
        saveAsImage: {},
        dataView: { readOnly: false },
        dataZoom: {
          yAxisIndex: "none",
        },
        magicType: { type: ["line", "bar"] },
        restore: {},
      },
    },
    series: [
      {
        data: seriesData,
        type: "line",
      },
    ],
  };

  // `true` replaces the previous option instead of merging it, so switching
  // points does not leave the old series behind.
  getChart(chartContainer()).setOption(option, true);
}
