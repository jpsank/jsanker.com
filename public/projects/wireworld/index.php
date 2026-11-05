<?php
declare(strict_types=1);

/**
 * WireWorld — Turing-complete cellular automaton for simulating logic elements.
 * Static client-side toy. The original was a bare full-screen page: no breadcrumb bar,
 * only its own style.css (shared.css only styles the bar, so it is inert here).
 */

require_once __DIR__ . '/../../../src/layout.php';

page_start([
    'legacy'      => true,
    'nobar'       => true,
    'title'       => 'WireWorld',
    'description' => 'My implementation of the popular Turing-complete cellular automaton to simulate electronic logic elements',
    'styles'      => ['/projects/wireworld/style.css'],
    'scripts'     => [
        ['src' => '/projects/wireworld/presets.js', 'module' => true],
        ['src' => '/projects/wireworld/wireworld.js', 'module' => true],
        ['src' => '/projects/wireworld/script.js', 'module' => true],
    ],
]);
?>
    <div id="presetSelect">
        <p>Choose a preset:</p>

    </div>
    <p id="warningElem"></p>

    <canvas id="wireworld-canvas">
    </canvas>

<?php page_end();
