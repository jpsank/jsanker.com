<?php
declare(strict_types=1);

/**
 * Game of Life pattern API.
 *
 *   GET /api/pattern.php              a random pattern (RLE, text/plain), never cached
 *   GET /api/pattern.php?name=x.rle   that pattern; 404 unless x.rle is in _index_.json
 *
 * The response header X-Pattern-Name carries the file name that was served.
 * `name` is only ever compared against the index; the path is built from the
 * matching index entry, never from the request.
 */

require_once __DIR__ . '/../../src/bootstrap.php';

const PATTERN_DIR = APP_ROOT . '/data/patterns/';

header('Content-Type: text/plain; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method !== 'GET' && $method !== 'HEAD') {
    header('Allow: GET, HEAD');
    abort(405, 'Method Not Allowed');
}

$index = json_decode((string) file_get_contents(PATTERN_DIR . '_index_.json'), true, 8, JSON_THROW_ON_ERROR);
// Defence in depth: only plain *.rle file names can ever be served.
$names = array_values(array_filter(
    is_array($index) ? $index : [],
    static fn($n) => is_string($n) && preg_match('/^[A-Za-z0-9_.-]{1,100}\.rle$/', $n) === 1 && $n[0] !== '.'
));
if ($names === []) {
    abort(500, 'Pattern index is empty');
}

if (!isset($_GET['name'])) {
    $file = $names[random_int(0, count($names) - 1)];
    header('Cache-Control: no-store');
} else {
    if (!is_string($_GET['name'])) {
        abort(400, 'Bad Request');
    }
    $found = array_search($_GET['name'], $names, true);
    if ($found === false) {
        abort(404, 'Not Found');
    }
    $file = $names[$found];
    header('Cache-Control: public, max-age=86400');
}

$body = @file_get_contents(PATTERN_DIR . $file);
if ($body === false) {
    abort(404, 'Not Found');
}
header('X-Pattern-Name: ' . $file);
echo $body;
