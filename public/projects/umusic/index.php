<?php
declare(strict_types=1);

/**
 * uMusic: a live demo of the original player UI (a Flask app that scraped SoundCloud charts).
 * The scraped songs can't be reached or hosted, so the tracks here are fictional and synthesised
 * in the browser (Web Audio). Markup, ids and CSS follow the original home.html / style.css.
 */

require_once __DIR__ . '/../../../src/layout.php';

page_start([
    'title'       => 'uMusic',
    'description' => 'A working demo of uMusic, an ad-free chart player. Fictional tracks, synthesised in your browser.',
    'legacy'      => true,
    'nobar'       => true,
    'styles'      => ['/projects/umusic/umusic.css'],
    'scripts'     => [
        '/projects/umusic/tracks.js',
        '/projects/umusic/synth.js',
        '/projects/umusic/covers.js',
        '/projects/umusic/dom.js',
        '/projects/umusic/script.js',
        '/projects/umusic/load.js',
    ],
]);
?>
<p class="demo-note">Demo: these tracks are fictional and synthesised in your browser; nothing is downloaded. &middot; <a href="/projects/">&larr; projects</a></p>
<div class="logo">
    <img alt="uMusic" src="/projects/umusic/uMusic.png">
</div>
<section id="media">
    <i id="shuffle" class="glyphicon glyphicon-random control-btn b-shuffle"></i>
    <div id="current_track">
        <i id="play" class="glyphicon glyphicon-play control-btn b-play"></i>
        <i id="prev" class="glyphicon glyphicon glyphicon-step-backward control-btn b-prev"></i>
        <i id="next" class="glyphicon glyphicon glyphicon-step-forward control-btn b-next"></i>
        <img id="current_img" alt="">
    </div>
    <div>
        <progress id="audioProgress" value="0" max="1"></progress>
    </div>
</section>

<template id="track_template">
    <div class="track">
        <img alt="">
    </div>
</template>
<div id="scroller" class="flex"></div>
<div id="sentinel">
    <p id="title"></p>
</div>
<noscript><p class="demo-note">The player needs JavaScript.</p></noscript>
<?php page_end();
