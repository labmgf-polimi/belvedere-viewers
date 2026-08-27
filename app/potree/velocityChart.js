// The velocity chart panel (`#gcp-chart`).
//
// Owns everything about the panel: showing/hiding it, and the single ECharts
// instance that lives inside `#chart-container`. Callers pass in a velocity
// series and a point label; they never touch the panel DOM themselves.
//
// `#chart-container` and `#close-btn` are declared in index.php and must
// survive across openings, so nothing here writes to `#gcp-chart.innerHTML`.

const CHART_PANEL_ID = "gcp-chart";
const CHART_CONTAINER_ID = "chart-container";

/** The persistent element the ECharts instance lives in. */
function chartContainer() {
  return document.getElementById(CHART_CONTAINER_ID);
}

function showChartPanel() {
  document.getElementById(CHART_PANEL_ID).style.visibility = "visible";
}

function hideChartPanel() {
  document.getElementById(CHART_PANEL_ID).style.visibility = "hidden";
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

/** Draw a velocity series in the chart panel. */
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
