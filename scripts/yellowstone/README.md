# Yellowstone checks

Two checks for the ground, weather and snow of `public/projects/yellowstone`.

**Against what was measured** (CPU only, about two minutes):

    node validate.mjs                      # runs 3 years, prints every number with its target
    node validate.mjs --update-baseline    # after a change you accept, save this run as the new baseline

`observed.json` holds the measurements (PRISM 1991-2020 normals over the park by elevation band; SNOTEL snowpack peaks and melt-out dates; SNOTEL station air temperature,
5 cm soil temperature and precipitation by month). `build-observed.mjs` shows where each number comes from and rebuilds it from the downloads.
Each number has a target. Inside it is `ok`; outside but no worse than `baseline.json` is a `gap` (known); worse than the baseline is `REGRESSED` and the script exits with an error.

**CPU against GPU** (needs Chrome with WebGPU):

    node serve.mjs                         # then open http://localhost:8099/gpu-compare.html?run=1

Runs the same world on both and checks how close the maps stay (average difference, cells far apart, the water books). The title says PASS or FAIL.

`baseline.json` was reset when the air temperature became a worked-out state instead of a fitted input: the air-temperature numbers got worse then, by design (the old input was fitted to the same PRISM data it was checked against).

Not measured yet, for want of data in the folder: stream flow (USGS gauges), lake level, lake ice dates, grass growth (NDVI), wind.
