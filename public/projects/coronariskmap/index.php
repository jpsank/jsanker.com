<?php
declare(strict_types=1);

/**
 * CoronaRiskMap: retired project, kept as a working, frozen snapshot.
 * The original Flask/Bootstrap 3/Leaflet page, ported 1:1. Fully client-side:
 * coronariskmap.js draws data.json (generated once from the final database of
 * the old site) with a vendored copy of Leaflet. No external requests.
 */

require_once __DIR__ . '/../../../src/layout.php';

page_start([
    'legacy'      => true,
    'nobar'       => true,
    'title'       => 'Home - COVID-19 Map',
    'description' => 'A frozen snapshot of a retired map of confirmed COVID-19 cases per ICU bed for each US state, March to July 2020.',
    'styles'      => [
        '/projects/coronariskmap/vendor/bootstrap.min.css',
        '/projects/coronariskmap/coronariskmap.css',
        '/projects/coronariskmap/vendor/leaflet.css',
    ],
    'scripts'     => [
        '/projects/coronariskmap/vendor/leaflet.js',
        '/projects/coronariskmap/coronariskmap.js',
    ],
]);
?>
    <div class="container">
        <h3>corona riskmap</h3>
        <p>
            A choropleth map that shows confirmed COVID-19 cases per ICU bed for each US state.
            <a href="https://github.com/puffyboa/coronamap">Github</a>
        </p>
        <p>
            <b>Frozen snapshot as of July 29, 2020.</b> The site used to update daily; its data sources have ended,
            so this is a historical replay of its final database (<a href="https://globalepidemics.org/2020/03/17/caring-for-covid-19-patients/">Harvard Global Health Institute</a>
            and <a href="https://covidtracking.com/">COVID Tracking Project</a>), not current or medical information.
            The street-map tiles of the original are left out.
            <a href="/projects/">&larr; All projects</a>
        </p>
        <noscript><p class="red">The map needs JavaScript.</p></noscript>
        <br>
        <h1>COVID-19 Cases vs. ICU Capacity</h1>
        <div class="dates" id="dates"></div>
        <div id="map" role="group" aria-label="Map of US states shaded by confirmed COVID-19 cases per ICU bed. The ranked table below has the same numbers."></div>
        <div class="player">
            <button type="button" id="play" class="btn btn-default btn-xs" aria-label="Play the timeline" disabled>Play</button>
            <label class="sr-only-note" for="slider">Date</label>
            <input type="range" id="slider" min="0" max="0" value="0" step="1" disabled>
            <output id="slider-date" for="slider" class="when"></output>
        </div>
        <br>
        <p>
            A <a href="https://www.cdc.gov/mmwr/volumes/69/wr/mm6912e2.htm?s_cid=mm6912e2_w">CDC analysis</a>
            of more than 2,400 cases of COVID-19 that have occurred in the United States in the last month
            shows that between 1 in 20 and 1 in 9 people who are confirmed cases require ICU admission.
        </p>
        <p>
            If it turns out that 1 in 9 cases require ICU admission, then
            <b id="num-bad-states" class="red">0</b> state(s)
            as of <span id="selected-date"></span>
            have too few ICU beds for their number of cases.
        </p>
        <br>
        <div class="scrollable">
            <table id="ranked" class="table table-hover table-condensed">
                <tr>
                    <th>Rank</th>
                    <th>Name</th>
                    <th>Cases / ICU bed</th>
                    <th>Positive tests</th>
                    <th>Negative tests</th>
                    <th>Total tests</th>
                    <th>Hospitalized</th>
                    <th>Deaths</th>
                    <th>Total ICU Beds</th>
                </tr>
            </table>
        </div>
        <br>
        <br>
        <i class="small">Built by Julian Sanker. <a href="mailto:julian@sankergroup.org">Contact me</a> if you have any issues</i>
    </div>
<?php page_end();
