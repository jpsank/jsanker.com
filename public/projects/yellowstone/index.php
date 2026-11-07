<?php
declare(strict_types=1);

/**
 * Yellowstone: grazers and wolves on land with rain, water and nitrogen, each animal with an evolving neural network, running in your browser.
 * The simulation is sim.js (animals) and land.js (the ground), a JavaScript rebuild of github.com/jpsank/thesis with terrain, wolves, days and seasons added.
 */

require_once __DIR__ . '/../../../src/layout.php';

page_start([
    'title'       => 'Yellowstone',
    'description' => 'A tiny ecosystem of land, water, grass, grazers and wolves, where every animal evolves its own neural network through days and seasons. Run it in your browser, then release the wolves.',
    'crumbs'      => [['home', '/'], ['projects', '/projects/'], ['yellowstone', null]],
    'styles'      => ['/projects/yellowstone/yellowstone.css'],
    'scripts'     => [['src' => '/projects/yellowstone/app.js', 'module' => true]],
]);
?>
<div class="gp">
<h1>Yellowstone</h1>
<p class="lede">Put a herd of grazers on rolling ground with rain, rivers and seasons, give each animal a small brain that evolves, and let a few years go by. Then release wolves, the way they were brought back to Yellowstone in 1995 after about seventy years away, and see what changes. Nothing tells the grass where to grow, the grazers how to flee, or the wolves how to hunt. It runs entirely in your browser, so there is no server behind it.</p>
<p class="credit">A toy ecosystem, not a model of the real park. Rebuilt in JavaScript from <a href="https://github.com/jpsank/thesis">github.com/jpsank/thesis</a>, with terrain, water, wolves, days and seasons added.</p>

<h2>The model</h2>
<ul class="rules">
  <li><strong>The world</strong> is a 200 × 200 grid. East and west wrap round, and the top and bottom are walls. Every cell has ground at some height, a temperature, an amount of water, an amount of nitrogen and an amount of grass, and at most one animal. It starts with 400 prey and grass everywhere. Wolves arrive when you release them.</li>
  <li><strong>Latitude.</strong> The map runs from 65° north at the top to 25° north at the bottom, with Yellowstone's 45° across the middle, so the seasons are not the same everywhere. Further north it is colder on average and summers and winters are further apart. The south is warmer and drier, and the wettest ground is through the middle. Nothing tells an animal where to be when: if any of them follow the seasons, they have worked it out for themselves.</li>
  <li><strong>Days and seasons.</strong> A day is 60 steps and a year is 30 days (1,800 steps), so each season lasts about 450 steps. The world starts at noon on the summer solstice, 21 June, and the year follows the real calendar, with spring from March to May. The sun is placed where it really would be: from the latitude, the time of year (it climbs to 23.4° north of the equator at midsummer and falls the same distance south at midwinter) and the hour, with the small drift of noon through the year that real sundials have. So the days are long in summer and short in winter, more so the further north you go, and the sun stands higher in the south than in the north. The air temperature comes from the season, the time of day (it peaks in the afternoon, a little after the sun) and the height: about 1.2 °C colder for every unit of it, so ridges are colder than valleys. The temperature shown is the air at 45° north and the map's average height. The ground has a temperature of its own on every cell. It follows the air above it a little behind, conducts heat to the cells around it, and is warmed by animals (see below). Water holds a lot of heat for its weight, so wet ground and ponds warm and cool slowly while dry ground swings with the air. It is the ground temperature that melts snow, slows the grass and makes animals burn more. A slope gets more sun the more squarely it faces it, so in the north slopes that face south are warmer than ones that face north: their snow melts first and their grass starts first, while the north-facing ones stay cold and snowy longest. The land is shaded by the sun's real direction too, so the light moves round the hills through the day and the year.</li>
  <li><strong>Water.</strong> Rain falls evenly over the whole map, in showers that are more frequent and heavier in wetter months. How much falls each month follows the climate at Mammoth in Yellowstone (NOAA's 1991–2020 normals): wettest in May, with a second peak in October, and driest in winter and high summer. Where the air is near freezing it falls as snow instead, which piles up, mostly on the high ground first, and melts as the ground under it warms, so the snow lies longest on the ridges. Water runs downhill, filling the low ground, and carries dissolved nitrogen with it. The lowest ground is where the river leaves the park: water that gets there drains away, with its nitrogen. Some evaporates (more where it is warm and sunny), some soaks away below the roots, and grass drinks the rest.</li>
  <li><strong>Grass</strong> grows on every cell in proportion to the sunlight, as long as the soil has water and nitrogen and is not frozen, flooded, dried out or under snow. Cold soil slows the roots, so grass takes up less water and nitrogen and grows less the colder the ground is. Growing uses up water and takes nitrogen out of the soil. Grass cannot grow under an animal, so standing still has a price. Seed blows in from the cells around it, so patches spread and regrow once they are grazed down.</li>
  <li><strong>Seeing.</strong> Each animal sees a 9 × 9 patch of colours. Bare ground is grey and thicker grass is greener. Other animals are orange for grass-eaters through yellow for meat-eaters, with more blue as their energy runs down. Nobody sees energy as a number, nor the height of the ground or the water on it. Beyond the eight neighbouring cells, what animals see dims at night but never goes dark, because deer and wolves both see well after sunset.</li>
  <li><strong>Acting.</strong> The brain has an output for each of the nine cells around the animal (itself in the middle): how much it wants to go there. Each step costs energy, more the longer it is and more again for every bit of height it climbs (going downhill is free) and for wading through water (the deeper, the dearer), and the animal takes the step where what it wants outweighs what it costs the most. So wanting a step twice as much cancels a step that costs twice as much, and slopes and flooded ground are felt without the network ever being told about them. Stepping onto an empty cell moves there, and stepping onto another animal is a bite. An animal with more than 100 energy also picks where to breed, with a second set of nine outputs.</li>
  <li><strong>Eating and digesting.</strong> An animal grazes the grass on the cell it stands on, and food then passes through a gut for a few steps. Every animal has a diet between 0 and 1, passed on to its children with small changes. At 0 it gets full energy from grass and almost nothing from meat; at 1 it is the reverse; in between it gets some from each and the most from neither. A bite succeeds with a chance equal to the square of its diet, so grazers almost never kill and wolves usually do. A killer takes part of its victim as meat. Whatever an animal cannot use goes onto the ground below it as nitrogen, and a body gives its nitrogen back to the ground when it dies. The nitrogen then flows with the water and feeds the grass.</li>
  <li><strong>Energy.</strong> Animals burn a little energy every step, more when it is cold, which means in winter and higher up the hill, and a good deal more when they stand in cold water, which draws heat from a body far faster than air does. Everything they burn is given off as heat into the ground they stand on, which conducts it to the eight cells around it until it leaks away into the air above. So an animal warms its neighbours and is warmed by them, and a crowd in winter burns less than a loner. Anything at zero is dead. Breeding costs 25 per parent, and only animals with similar diets mate. Wolves are the animals with a diet of 0.5 or more. Released wolves start at 0.9, with random brains.</li>
  <li><strong>Evolving.</strong> A child copies its parent's genome, with small random changes to weights and biases and now and then a new neuron or connection. Two animals that point at each other breed together and mix their genomes. Released wolves start with random brains and have to evolve their way into hunting.</li>
  <li><strong>Genome to brain.</strong> The genome is a small network (grown by NEAT) that is asked, for every pair of neurons in a fixed layout, "how strongly should these two be wired?" The answers are the weights of the brain that then sees and acts (the HyperNEAT recipe). That is how a couple of dozen genes can paint a brain of 6,600 connections.</li>
</ul>

<h2>Run it</h2>
<div class="sim">
  <div class="sim-view">
    <canvas id="gp-canvas" width="200" height="200" role="img" aria-label="The 200 by 200 world: ground with grass and water, animals from orange (grass-eaters) to yellow (meat-eaters)."></canvas>
    <ul class="key" aria-label="Colour key">
      <li><span class="sw sw-grass"></span>grass</li>
      <li><span class="sw sw-water"></span>water</li>
      <li><span class="sw sw-prey"></span>diet: grass to meat</li>
      <li><span class="sw sw-weak"></span>low energy (paler)</li>
      <li><span class="sw sw-breeding"></span>can breed (darker)</li>
    </ul>
  </div>
  <div class="sim-side">
    <div class="buttons">
      <button type="button" id="gp-run" aria-pressed="false">Run</button>
      <button type="button" id="gp-step">Step</button>
      <button type="button" id="gp-reset">New run</button>
      <button type="button" id="gp-wolves">Release 80 wolves</button>
    </div>
    <div class="fields">
      <label>Seed <input type="number" id="gp-seed" value="1" min="0" step="1"></label>
      <label>Speed
        <select id="gp-speed">
          <option value="1">1 step a frame</option>
          <option value="4" selected>4 steps</option>
          <option value="16">16 steps</option>
          <option value="64">as fast as it goes</option>
        </select>
      </label>
    </div>
    <div class="fields">
      <label>Show
        <select id="gp-layer">
          <option value="land" selected>The land</option>
          <option value="grass">Grass</option>
          <option value="water">Water</option>
          <option value="snow">Snow</option>
          <option value="temperature">Ground temperature</option>
          <option value="nitrogen">Nitrogen</option>
          <option value="elevation">Height</option>
        </select>
      </label>
      <label class="check"><input type="checkbox" id="gp-mating" checked> Let pairs mate</label>
    </div>
    <p id="gp-stat" class="stat" aria-live="off"></p>
    <p id="gp-clock" class="small muted" aria-live="off"></p>
    <table class="moves" aria-label="Share of animal moves in each direction so far">
      <caption>Where animals step (share of all moves so far)</caption>
      <tbody id="gp-moves"></tbody>
    </table>
    <p id="gp-inspect" class="small muted"></p>
  </div>
</div>
<div class="chart brain" id="gp-brain" hidden>
  <h4 class="brain-head"></h4>
  <p class="sub brain-note"></p>
  <div class="brain-sub"></div>
  <p class="sub">Orange cells are positive, blue negative, and the outlined cell is the one it picks. Hover a cell for its value.</p>
  <h5>The genome that grew it</h5>
  <div class="brain-genome"></div>
  <p class="sub brain-genome-note"></p>
  <p class="sub">The genome is a small NEAT network. It is asked about every pair of neurons, with six inputs (where the receiving neuron is, and where the sending one is) and gives back the connection weight. Orange links add, blue links subtract, and thicker is stronger.</p>
</div>
<div class="chart">
  <h4>Animals in this run</h4>
  <p class="sub">Prey and wolves on one scale. Move over the plot to read a step.</p>
  <div id="gp-chart"></div>
  <p id="gp-readout" class="readout" aria-live="off"></p>
</div>
<div class="chart">
  <h4>Grass in this run</h4>
  <p class="sub">All the grass on the map, on its own scale because it is a different kind of number.</p>
  <div id="gp-chart-grass"></div>
  <p id="gp-readout-grass" class="readout" aria-live="off"></p>
</div>
<p class="muted small">Every seed gives a different run, and the same seed repeats the same run in the same browser. Expect booms and crashes. If it slows down, that is hundreds of brains each deciding something every step.</p>

</div>
<?php page_end();
