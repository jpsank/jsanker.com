<?php
declare(strict_types=1);

/**
 * Speedreed — read a book one word at a time.
 *
 * Hardening over the original:
 *   - the set of readable books is built from scandir() of data/speedreed/texts
 *     (names restricted to [A-Za-z0-9_]); the request's `file` value is only ever
 *     compared against that list, never used to build a path
 *   - `file` must be a plain string of the form folder:file.txt; arrays, missing
 *     or extra parts, null bytes and over-long values are rejected
 *   - at most MAX_BYTES of a book is read
 *   - every printed value goes through e()
 */

require_once __DIR__ . '/../../../src/layout.php';

const MAX_BYTES = 2_000_000;
const MAX_PARAM = 200;

/** @return array<string, list<string>> folder => [file.txt, ...], sorted */
function listTexts(string $root): array
{
    $texts = [];
    $folders = is_dir($root) ? (scandir($root) ?: []) : [];
    foreach ($folders as $folder) {
        if (!preg_match('/^[A-Za-z0-9_]+$/', $folder) || !is_dir("$root/$folder")) {
            continue;
        }
        foreach (scandir("$root/$folder") ?: [] as $file) {
            if (preg_match('/^[A-Za-z0-9_]+\.txt$/', $file) && is_file("$root/$folder/$file")) {
                $texts[$folder][] = $file;
            }
        }
    }
    return $texts;
}

$textRoot = APP_ROOT . '/data/speedreed/texts';
$texts = listTexts($textRoot);

$requested = $_GET['file'] ?? null;
$library = $requested === null || $requested === '';
$book = null;   // [folder, file]
$bookText = null;

if (!$library) {
    if (is_string($requested) && strlen($requested) <= MAX_PARAM) {
        // Match against the allow-list; the matching entry (not the request) supplies the path.
        foreach ($texts as $folder => $files) {
            foreach ($files as $file) {
                if (hash_equals("$folder:$file", $requested)) {
                    $book = [$folder, $file];
                    break 2;
                }
            }
        }
    }
    if ($book !== null) {
        $raw = file_get_contents("$textRoot/{$book[0]}/{$book[1]}", false, null, 0, MAX_BYTES);
        if ($raw !== false) {
            $bookText = str_replace(["\r\n", "\r"], "\n", $raw);
        }
    }
    if ($bookText === null) {
        http_response_code(404);
    }
}

page_start([
    'legacy'      => true,
    'title'       => 'Speedreed',
    'description' => 'Browse and read a collection of my favorite books with speed',
    'crumbs'      => [['Speedreed', '/projects/speedreed/']],
    'styles'      => ['/projects/speedreed/style.css'],
    'scripts'     => ['/projects/speedreed/script.js'],
]);
?>

    <div class="jumbo">
        <h1>Speedreed</h1>
    </div>

    <div id="main">
<?php if ($library): ?>
        <div id='library'>
<?php foreach ($texts as $folder => $files): ?>
            <div class='author'><h3><?= e(str_replace('_', ' ', $folder)) ?></h3>
<?php foreach ($files as $file): ?>
                <p><a href='?file=<?= e(rawurlencode("$folder:$file")) ?>'><?= e(ucwords(str_replace('_', ' ', substr($file, 0, -4)))) ?></a></p>
<?php endforeach; ?>
            </div>
<?php endforeach; ?>
        </div>
        <p class="note">Only public-domain books (from Project Gutenberg) are on the shelf here; the other books from the original library are left out for copyright reasons.</p>
<?php elseif ($bookText !== null): ?>
        <div id='controls' hidden>
            <button type='button' id='sr-back'>&larr; back</button>
            <button type='button' id='sr-pause'>pause</button>
            <button type='button' id='sr-restart'>start over</button>
        </div>
        <div id='text'>
<?php
    $lines = explode("\n", e($bookText));
    foreach ($lines as $l => $line) {
        echo "<div class='line' id='$l'>";
        foreach (preg_split('/\s+/', $line) ?: [] as $word) {
            echo "<p class='word'>" . $word . "</p>";
        }
        echo "</div>\n";
    }
?>
        </div>
<?php else: ?>
        <div id='text'>File not found.</div>
<?php endif; ?>
    </div>
<?php page_end();
