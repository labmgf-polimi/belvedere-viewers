// The GNSS survey control panel: the year dropdown and the Load / Remove
// buttons, plus the close button on the velocity chart panel.
//
// `createAnnotation` comes from annotations.js and `hideChartPanel` from
// velocityChart.js — both are classic scripts loaded before this module.

/** Throw on a non-2xx response so the .catch below reports it. */
function asJson(response) {
  if (!response.ok) {
    throw new Error(`${response.url} -> HTTP ${response.status}`);
  }
  return response.json();
}

// Fetch survey years from the backend API and populate the dropdown
fetch(`${API_BASE}/surveys/years/`)
  .then(asJson)
  .then((years) => {
    const dropdown = document.getElementById("yearDropdown");
    years.forEach((year) => {
      const option = document.createElement("option");
      option.value = year;
      option.textContent = year;
      dropdown.appendChild(option);
    });
  })
  .catch((error) => console.error("Error fetching years:", error));

// Add event listener to load annotations button
document
  .getElementById("loadAnnotationsBtn")
  .addEventListener("click", function () {
    const selectedYear = document.getElementById("yearDropdown").value;
    if (!selectedYear) {
      alert("Please select a year before loading annotations.");
      return;
    }

    fetch(`${API_BASE}/surveys/measurements/?year=${selectedYear}&is_fixed=false`)
      .then(asJson)
      .then((points) => {
        // Clear the previous set first, otherwise repeated clicks (or a change
        // of year) stack duplicate annotations on top of each other.
        potreeViewer.scene.annotations.removeAllChildren();
        hideChartPanel();

        points.forEach((point) => {
          // `h` is the ellipsoidal height, which is the vertical datum the
          // point clouds use. `h_orto` would sink the annotations by the local
          // geoid undulation (~54 m).
          const position = [
            parseFloat(point.east),
            parseFloat(point.north),
            parseFloat(point.h),
          ];
          const descriptionText =
            "<b>Coordinates:</b> " +
            position.map((v) => v.toFixed(3)).join(", ");
          createAnnotation(
            point.id, // id
            potreeViewer.scene, // scene
            point.label, // titleText
            position, // position (floats)
            [], // cameraPosition (empty)
            [], // cameraTarget (empty)
            descriptionText // descriptionText
          );
        });
      })
      .catch((error) => console.error("Error fetching points:", error));
  });

// Add event listener to remove annotations button
document
  .getElementById("removeAnnotationsBtn")
  .addEventListener("click", function () {
    //Remove all GNSS annotations loaded in the scene
    potreeViewer.scene.annotations.removeAllChildren();
    //Hide graph panel
    hideChartPanel();
  });

// The chart panel's close button (styled in css/style.css, previously unwired).
document.getElementById("close-btn").addEventListener("click", hideChartPanel);
