// GNSS point annotations in the Potree scene.
//
// Creates the Potree.Annotation objects and, when one is opened, fetches its
// velocity series. Drawing that series is velocityChart.js's job — this file
// only decides *when* the panel is shown and what the annotation description
// says.

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
    showChartPanel();
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
