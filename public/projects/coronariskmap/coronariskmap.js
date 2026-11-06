// CoronaRiskMap: frozen snapshot. Ported from the original main.js (Leaflet choropleth).
// Differences from the original: data comes from data.json instead of /fetch/<date>, there are
// no Mapbox tiles, the date strip is driven by the URL hash, and a slider/play control was added.
// Everything that comes from data is written with textContent.

(function () {
    'use strict';

    // -------------------- DATA --------------------

    let data;           // parsed data.json
    let features = [];  // GeoJSON features (properties are rewritten for each date)
    let dayIndex = 0;   // index into data.dates of the selected date
    let timer = null;

    function mdy(iso) {   // 2020-03-20 -> 03-20-20
        return iso.slice(5, 7) + '-' + iso.slice(8, 10) + '-' + iso.slice(2, 4);
    }
    function fromMdy(s) { // 03-20-20 -> 2020-03-20
        let m = /^(\d\d)-(\d\d)-(\d\d)$/.exec(s || '');
        return m ? '20' + m[3] + '-' + m[1] + '-' + m[2] : null;
    }
    function addDays(iso, n) {
        let d = new Date(iso + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
    }

    // the latest row at or before the date, like the original SQL query
    function statFor(s, i) {
        for (let k = i; k >= 0; k--) {
            if (s.pos[k] !== null || s.chk[k] !== null) {
                return {
                    positive: s.pos[k], negative: s.neg[k], pending: s.pend[k], hospitalized: s.hosp[k],
                    death: s.death[k], total_tests: s.tests[k], checked_at: s.chk[k], date: data.dates[k]
                };
            }
        }
        return null;
    }

    function propsFor(s, st) {
        return {
            full_name: s.name, name: s.id,
            'Total ICU Beds': s.icu,
            date: mdy(st.date), checked_at: st.checked_at,
            positive: st.positive, negative: st.negative, pending: st.pending,
            hospitalized: st.hospitalized, death: st.death, total_tests: st.total_tests,
            cases_per_bed: st.positive / s.icu
        };
    }

    // -------------------- INIT MAP --------------------

    let map;

    function initMap() {
        map = L.map('map').setView([37.8, -96], 4);
        map.attributionControl.setPrefix('<a href="https://leafletjs.com" title="A JavaScript library for interactive maps">Leaflet</a>');
    }

    // -------------------- INFO POPUP --------------------

    let info;

    function formatNum(n) {
        return n === null || n === undefined ? 'N/A' : n.toLocaleString();
    }
    function round2(n) {
        return Math.round(n * 100) / 100.;
    }
    const NBSP4 = '    ';

    function addInfo() {
        // control that shows state info on hover
        info = L.control();

        info.onAdd = function () {
            this._div = L.DomUtil.create('div', 'info');
            this.update();
            return this._div;
        };

        info.update = function (props) {
            let div = this._div;
            while (div.firstChild) div.removeChild(div.firstChild);
            function tag(name, text, cls) {
                let e = document.createElement(name);
                if (cls) e.className = cls;
                e.textContent = text;
                div.appendChild(e);
                return e;
            }
            function br() { div.appendChild(document.createElement('br')); }
            function line(text, indent) { div.appendChild(document.createTextNode((indent ? NBSP4 : '') + text)); br(); }

            tag('h4', 'COVID-19 Cases vs. ICU Capacity');
            if (props) {
                let datetime = new Date(props['checked_at']).toLocaleString('en-US', {
                    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit'
                });
                tag('b', props['full_name']); br();
                div.appendChild(document.createTextNode(formatNum(props['positive']) + ' positive tests '));
                tag('span', '(' + datetime + ')', 'small'); br();
                line(formatNum(props['negative']) + ' negative tests', true);
                line(formatNum(props['pending']) + ' pending tests', true);
                line(formatNum(props['total_tests']) + ' total tests', true);
                line(formatNum(props['hospitalized']) + ' hospitalized', true);
                line(formatNum(props['death']) + ' deaths', true);
                line(formatNum(props['Total ICU Beds']) + ' Total ICU beds');
                tag('b', formatNum(round2(props['cases_per_bed'])));
                div.appendChild(document.createTextNode(' Cases / ICU bed'));
            } else {
                div.appendChild(document.createTextNode('Hover over a state'));
            }
        };

        info.addTo(map);
    }

    // -------------------- FEATURE STYLING --------------------

    // get color depending on value
    function getColor(d) {
        return d > 200 ? '#FF00FF' :
            d > 100 ? '#C000FF' :
            d > 50 ? '#8000AC' :
            d > 20 ? '#800026' :
            d > 10 ? '#BD0026' :
            d > 5 ? '#E31A1C' :
            d > 2 ? '#FC4E2A' :
            d > 1 ? '#FD8D3C' :
            d > .5 ? '#FEB24C' :
            d > .2 ? '#FED976' :
            d > .1 ? '#FFEDA0' :
                     '#FFFAC0';
    }

    function style(feature) {
        return {
            weight: 2,
            opacity: 1,
            color: 'white',
            dashArray: '3',
            fillOpacity: 0.7,
            fillColor: getColor(feature['properties']['cases_per_bed'])
        };
    }

    // -------------------- FEATURE CONTROL --------------------

    let geojson;
    let currentlyHighlighted;

    function highlightFeature(e) {
        if (currentlyHighlighted)
            geojson.resetStyle(currentlyHighlighted);

        let layer = e.target;

        layer.setStyle({
            weight: 5,
            color: '#666',
            dashArray: '',
            fillOpacity: 0.7
        });

        if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) {
            layer.bringToFront();
        }

        info.update(layer.feature.properties);

        currentlyHighlighted = layer;
    }

    function resetHighlight(e) {
        geojson.resetStyle(e.target);
        info.update();
    }

    function zoomToFeature(e) {
        map.fitBounds(e.target.getBounds());
    }

    let isTouchDevice = ('ontouchstart' in document.documentElement);

    function onEachFeature(feature, layer) {
        if (isTouchDevice)
            layer.on({
                click: highlightFeature,
                dblclick: zoomToFeature
            });
        else
            layer.on({
                mouseover: highlightFeature,
                mouseout: resetHighlight,
                click: zoomToFeature
            });
    }

    // -------------------- FEATURE DATA --------------------

    let layers = {};  // state id -> leaflet layer
    let shown = {};   // state id -> bool

    function addGeoJSON() {
        features = data.states.map(s => ({
            type: 'Feature',
            id: s.id,
            properties: {},
            geometry: { type: s.type, coordinates: s.geo }
        }));
        geojson = L.geoJson({ type: 'FeatureCollection', features: features }, {
            style: style,
            onEachFeature: function (feature, layer) {
                layers[feature.id] = layer;
                onEachFeature(feature, layer);
            }
        });
        // layers are added to the map by update(), once they have data for the selected date

        map.attributionControl.addAttribution('Healthcare data &copy; <a href="https://globalepidemics.org/2020/03/17/caring-for-covid-19-patients/">HGHI</a>, COVID-19 data &copy; <a href="https://covidtracking.com/">COVID Tracking Project</a>');
    }

    // -------------------- LEGEND --------------------
    function addLegend() {
        let legend = L.control({ position: 'bottomright' });

        legend.onAdd = function () {
            let div = L.DomUtil.create('div', 'info legend'),
                grades = [0, .1, .2, .5, 1, 2, 5, 10, 20, 50, 100, 200];

            for (let i = 0; i < grades.length; i++) {
                let from = grades[i], to = grades[i + 1];
                let span = document.createElement('span'), sw = document.createElement('i');
                sw.style.background = getColor(from + .0001);
                span.appendChild(sw);
                span.appendChild(document.createTextNode(' ' + from + (to ? '–' + to : '+')));
                div.appendChild(span);
            }
            return div;
        };

        legend.addTo(map);
    }

    // -------------------- INFO ELEMENTS --------------------

    function setBadStates(feats) {
        let badStates = feats.filter(feat => feat['properties']['cases_per_bed'] > 9);
        document.getElementById('num-bad-states').textContent = badStates.length;
    }

    function td(tr, text, cls, bold) {
        let c = document.createElement('td');
        if (cls) c.className = cls;
        if (bold) { let b = document.createElement('b'); b.textContent = text; c.appendChild(b); }
        else c.textContent = text;
        tr.appendChild(c);
    }

    function setRanked(feats) {
        let table = document.getElementById('ranked');
        let old = table.querySelectorAll('tr:not(:first-child)');
        old.forEach(r => r.parentNode.removeChild(r));
        let body = table.tBodies[0];
        feats.forEach((feat, index) => {
            let props = feat['properties'];
            let tr = document.createElement('tr');
            td(tr, String(index + 1));
            td(tr, props['full_name']);
            td(tr, formatNum(round2(props['cases_per_bed'])), props['cases_per_bed'] > 9 ? 'red' : '', true);
            td(tr, formatNum(props['positive']));
            td(tr, formatNum(props['negative']));
            td(tr, formatNum(props['total_tests']));
            td(tr, formatNum(props['hospitalized']));
            td(tr, formatNum(props['death']));
            td(tr, formatNum(props['Total ICU Beds']), 'grey');
            body.appendChild(tr);
        });
    }

    // -------------------- DATE STRIP --------------------

    function setDates() {
        let sel = data.dates[dayIndex];
        // the selected date sits in the middle of the strip (up to 9 days after it), else the latest dates
        let list = data.dates.filter(d => d <= addDays(sel, 9)).reverse().slice(0, 18);
        let box = document.getElementById('dates');
        while (box.firstChild) box.removeChild(box.firstChild);
        list.forEach((d, i) => {
            let a = document.createElement('a');
            a.className = 'date' + (d === sel ? ' selected' : '');
            a.id = mdy(d);
            a.href = '#' + mdy(d);
            a.textContent = mdy(d).replace(/-/g, '/');
            box.appendChild(a);
            if (i < list.length - 1) box.appendChild(document.createTextNode(' '));
        });
    }

    // -------------------- UPDATE --------------------

    function update() {
        let sel = data.dates[dayIndex];
        if (currentlyHighlighted) { currentlyHighlighted = null; info.update(); }

        let shownFeatures = [];
        features.forEach((feat, i) => {
            let s = data.states[i], st = statFor(s, dayIndex), layer = layers[s.id];
            if (st && st.positive !== null) {
                feat.properties = propsFor(s, st);
                shownFeatures.push(feat);
                layer.setStyle(style(feat));
                if (!shown[s.id]) { geojson.addLayer(layer); shown[s.id] = true; }
            } else if (shown[s.id]) {
                geojson.removeLayer(layer); shown[s.id] = false;
            }
        });
        if (!geojson._map) geojson.addTo(map);
        shownFeatures.sort((a, b) => b.properties.cases_per_bed - a.properties.cases_per_bed);

        setBadStates(shownFeatures);
        setRanked(shownFeatures);
        setDates();

        let label = mdy(sel).replace(/-/g, '/');
        document.getElementById('selected-date').textContent = label;
        document.getElementById('slider-date').textContent = label;
        let slider = document.getElementById('slider');
        slider.value = dayIndex;
        slider.setAttribute('aria-valuetext', label);
        if (location.hash !== '#' + mdy(sel) && history.replaceState) history.replaceState(null, '', '#' + mdy(sel));
    }

    function setDay(i) {
        dayIndex = Math.max(0, Math.min(data.dates.length - 1, i));
        update();
    }

    // -------------------- TIMELINE --------------------

    function stop() {
        if (timer) { clearInterval(timer); timer = null; }
        let b = document.getElementById('play');
        b.textContent = 'Play';
        b.setAttribute('aria-label', 'Play the timeline');
    }
    function play() {
        let b = document.getElementById('play');
        if (dayIndex >= data.dates.length - 1) setDay(0);
        b.textContent = 'Pause';
        b.setAttribute('aria-label', 'Pause the timeline');
        timer = setInterval(() => {
            if (dayIndex >= data.dates.length - 1) { stop(); return; }
            setDay(dayIndex + 1);
        }, 140);
    }

    function fromHash() {
        let iso = fromMdy(location.hash.slice(1));
        let i = iso ? data.dates.indexOf(iso) : -1;
        return i >= 0 ? i : data.dates.length - 1;  // unknown or missing date: use the latest
    }

    // -------------------- MAIN --------------------

    async function main() {
        data = await fetch('/projects/coronariskmap/data.json', { credentials: 'omit' })
            .then(response => {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .catch(err => {
                console.log(err);
                document.getElementById('selected-date').textContent = '(data failed to load)';
            });
        if (!data) return;

        dayIndex = fromHash();

        initMap();
        addInfo();
        addGeoJSON();
        addLegend();

        let slider = document.getElementById('slider'), playBtn = document.getElementById('play');
        slider.max = data.dates.length - 1;
        slider.disabled = false;
        playBtn.disabled = false;
        playBtn.addEventListener('click', () => { if (timer) stop(); else play(); });
        slider.addEventListener('input', () => { stop(); setDay(+slider.value); });
        window.addEventListener('hashchange', () => { stop(); setDay(fromHash()); });
        document.getElementById('dates').addEventListener('click', stop);

        update();
    }

    main();
})();
