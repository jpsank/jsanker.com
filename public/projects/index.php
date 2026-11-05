<?php
declare(strict_types=1);
require_once __DIR__ . '/../../src/layout.php';

page_start([
    'title'       => 'Projects',
    'description' => 'Personal projects from high school, ported and still running.',
    'crumbs'      => [['home', '/'], ['projects', null]],
]);
?>
<h1>Projects</h1>
<p>These are from high school. The PHP ones are the original code, security-patched and moved onto this site.
For anything more recent, <a href="mailto:julian@sankergroup.org">email me</a>.</p>

<h2>Running</h2>
<ul class="plain">
  <li><a href="/projects/chemcalc/">ChemCalc</a> — thermodynamic properties of molecules and chemical equations (AP Chem), with an equation balancer.</li>
  <li><a href="/projects/openchat/">OpenChat</a> — an open ledger for posting anonymous public messages.</li>
  <li><a href="/projects/apedia/">APedia</a> — crowd-sourced Q&amp;A for AP classes. Accounts, voting, comments.</li>
  <li><a href="/projects/speedreed/">Speedreed</a> — read public-domain books one word at a time.</li>
  <li><a href="/projects/wireworld/">WireWorld</a> — Turing-complete cellular automaton for simulating logic gates.</li>
  <li><a href="/projects/audiovisual/">Audiovisual.js</a> — particle animations driven by your own music file.</li>
  <li><a href="/life/">Game of Life</a> — random patterns from the LifeWiki collection.</li>
  <li><a href="https://crimemap.app/">Crime Map</a> — interactive map of 911 dispatches, hosted elsewhere.</li>
</ul>

<h2>Souvenirs</h2>
<p class="muted">The services these depended on are gone, so each is cut down to the part that still works.</p>
<ul class="plain">
  <li><a href="/projects/hha-grades/">HHA Grades</a> — the grade checker's interface, running on made-up data (the school portal it scraped is gone).</li>
  <li><a href="/projects/umusic/">uMusic</a> — the chart player's interface, with fictional tracks synthesised in your browser.</li>
  <li><a href="/projects/coronariskmap/">CoronaRiskMap</a> — COVID-19 cases per ICU bed by state, frozen at July 2020 with a date slider.</li>
  <li><a href="/projects/lucas-gifs/">Lucas Gifs</a> — something terrible from middle school, cut down from 40 MB to 4.</li>
</ul>
<?php page_end();
