<?php
declare(strict_types=1);

require_once __DIR__ . '/../../src/layout.php';

page_start([
    'title'       => 'Life',
    'description' => "Conway's Game of Life, seeded with a random pattern from a library of about 1,260.",
    'styles'      => ['/life/life.css'],
    'scripts'     => ['/life/life.js'],
]);
?>
<h1>Life</h1>

<p>
  This is <a href="https://en.wikipedia.org/wiki/Conway%27s_Game_of_Life">Conway's Game of Life</a>:
  a cell lives if it has two or three live neighbours, and a dead cell comes to life if it has exactly three.
  The grid wraps around at the edges. Each visit starts from a random pattern out of about 1,260
  (oscillators, spaceships, guns, methuselahs) borrowed from the Life community's pattern collections.
  Click or drag on the grid to draw your own cells.
</p>

<div class="life">
  <canvas id="life-canvas" width="160" height="100" role="img"
          aria-label="Game of Life grid. Click or drag to toggle cells."></canvas>
  <p id="life-status" class="life-status muted small">Loading a pattern…</p>
  <p class="life-controls small">
    <button type="button" id="life-play">pause</button>
    <button type="button" id="life-step">step</button>
    <button type="button" id="life-random">new random pattern</button>
    <button type="button" id="life-clear">clear</button>
    <span class="life-speed">
      <label for="life-speed">speed</label>
      <input type="range" id="life-speed" min="1" max="60" value="15">
    </span>
  </p>
</div>

<noscript><p class="note">The Game of Life needs JavaScript to run.</p></noscript>
<?php
page_end();
