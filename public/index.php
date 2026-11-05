<?php
declare(strict_types=1);
require_once __DIR__ . '/../src/layout.php';

page_start([
    'description' => 'Julian Sanker — Yale CS graduate from Northwest Arkansas. Software, AI, computational biology.',
    'styles'      => ['/life/life.css'],
    'scripts'     => ['/home.js', '/life/life.js'],
]);
?>
<img class="portrait" src="/img/me.jpeg" alt="Julian Sanker" width="144" height="144">

<div class="hero">
  <canvas id="fidget" class="fidget" role="img" aria-label="A fidget spinner. Drag across it to spin."></canvas>
  <h1>Julian Sanker</h1>
</div>

<p>I'm a Yale University graduate with a degree in Computer Science, from Northwest Arkansas.</p>

<p>I enjoy creating software, particularly websites and useful apps. I'm looking for jobs in software
engineering, artificial intelligence, and computational biology.</p>

<p>I also enjoy nature, and I'm interested in creating models of living organisms using
<a href="https://nn.cs.utexas.edu/downloads/papers/stanley.ec02.pdf">neural networks and evolutionary algorithms</a>.</p>

<p>Reach out at <a href="mailto:julian@sankergroup.org">julian@sankergroup.org</a>
or <a href="https://calendly.com/juliansanker">schedule a meeting</a>.</p>

<div class="life">
  <canvas id="life-canvas" width="160" height="100" role="img"
          aria-label="Conway's Game of Life. Click or drag to toggle cells."></canvas>
  <p id="life-status" class="life-status muted small">Loading a pattern…</p>
  <p class="life-controls small">
    <button type="button" id="life-play">pause</button>
    <button type="button" id="life-step">step</button>
    <button type="button" id="life-random">new random pattern</button>
    <button type="button" id="life-clear">clear</button>
    <button type="button" id="life-zoom-in">zoom in</button>
    <button type="button" id="life-zoom-out">zoom out</button>
    <button type="button" id="life-fit">fit all</button>
    <button type="button" id="life-mode">drag: draw</button>
    <span class="life-speed">
      <label for="life-speed">speed</label>
      <input type="range" id="life-speed" min="1" max="60" value="15">
    </span>
  </p>
</div>
<p class="muted small"><a href="https://en.wikipedia.org/wiki/Conway%27s_Game_of_Life">Conway's Game of Life</a>,
seeded at random from about 1,260 patterns. Drag to draw cells; zoom out or press “fit all” to see the whole grid
(Ctrl/⌘ + scroll or pinch also zooms; Shift-drag or “drag: move” pans).
On a touch screen, tap cells to toggle them and swipe to scroll the page; set “drag” to draw or move to use one finger on the grid, and pinch to zoom.</p>

<h2>Colophon</h2>
<p class="muted small">Plain HTML and PHP, one stylesheet, no tracking. The old projects are the original PHP,
audited and patched, running in a single FrankenPHP container.</p>
<?php page_end();
