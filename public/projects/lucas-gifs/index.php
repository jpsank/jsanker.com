<?php
declare(strict_types=1);

/**
 * Lucas Gifs: a middle-school page of GIFs, shown as it was.
 * The original was ~40 MB of GIFs. These are animated WebP (lossy), displayed at the original sizes.
 * The page is the original bare standalone page: no site chrome.
 */

require_once __DIR__ . '/../../../src/layout.php';

/** [file stem, caption, alt text, display width, display height] in the original page's order. */
$clips = [
    ['lucas_pingpong_cats', 'jumping lucas bean cats', 'A cat hopping across a ping-pong table with Lucas\'s face edited onto it', 720, 404],
    ['sk8r_cat', 'epic trickshot sk8r kat', 'A big black dog on a lawn, with a tiny Lucas-faced skateboarder rolling by behind it', 480, 278],
    ['cheese_face', 'cat pwned by cheese', 'A tabby cat with Lucas\'s face edited onto its head, reaching out a paw', 480, 480],
    ['running_parakeet', 'all ur base are belong to parakeet', 'A green parakeet running across a table with Lucas\'s face edited onto it', 480, 310],
];

page_start([
    'title'       => 'Lucas Gifs',
    'description' => 'A page of GIFs from middle school, cut down from 40 MB to a few.',
    'legacy'      => true,
    'nobar'       => true,
    'styles'      => ['/projects/lucas-gifs/style.css'],
    'scripts'     => ['/projects/lucas-gifs/lucas-gifs.js'],
]);
$m = '/projects/lucas-gifs/media/';
?>
	<h2>Gifs of Lucas</h2>
	<p class="blurb">From middle school. The original was 40 MB; this is the cut-down version.</p>
	<p>Using this famous photo:</p>
	<img src="<?= $m ?>lucas.webp" alt="Lucas" width="73" height="98" loading="lazy">
	<h1>The Gifs</h1>
<?php foreach ($clips as [$stem, $caption, $alt, $w, $h]): ?>
	<p><?= e($caption) ?></p>
	<img src="<?= $m . e($stem) ?>.webp" data-still="<?= $m . e($stem) ?>.poster.webp" alt="<?= e($alt) ?>" width="<?= $w ?>" height="<?= $h ?>" loading="lazy">
<?php endforeach; ?>
	<p class="back"><a href="/projects/">&larr; back</a></p>
<?php page_end();
