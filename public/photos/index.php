<?php
declare(strict_types=1);
require_once __DIR__ . '/../../src/layout.php';

// file => caption (captions carried over from the old carousel)
$photos = [
    'lake.jpeg'      => 'Lake Fayetteville, Arkansas',
    'cat.jpeg'       => 'Johnson, Arkansas',
    'blessings.jpeg' => 'Johnson, Arkansas',
    'doorway.jpeg'   => 'Johnson, Arkansas',
    'car.jpeg'       => 'Fayetteville, Arkansas',
    'deer.jpeg'      => 'Fayetteville, Arkansas',
    'fence1.jpeg'    => 'Fayetteville, Arkansas',
    'log.jpeg'       => 'Lake Fayetteville, Arkansas',
    'fence2.jpeg'    => 'Fayetteville, Arkansas',
    'twilight.jpeg'  => 'Fayetteville, Arkansas',
    'hha.jpeg'       => 'Haas Hall Academy, Fayetteville, Arkansas',
    'IMG_8387.jpg'   => 'Northwest Arkansas',
];

page_start([
    'title'       => 'Photos',
    'description' => 'Photos from Northwest Arkansas.',
    'crumbs'      => [['home', '/'], ['photos', null]],
]);
?>
<h1>Photos</h1>
<?php foreach ($photos as $file => $caption): ?>
<figure>
  <img src="/img/photos/<?= e($file) ?>" alt="<?= e($caption) ?>" loading="lazy">
  <figcaption><?= e($caption) ?></figcaption>
</figure>
<?php endforeach;
page_end();
