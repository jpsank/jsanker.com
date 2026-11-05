<?php
declare(strict_types=1);

/**
 * Serves an OpenChat attachment: image.php?id=N
 * Files are stored outside the web root and were re-encoded on upload; we still
 * serve them with a fixed Content-Type, nosniff and a sandboxing CSP.
 */

require_once __DIR__ . '/../../../src/openchat/Store.php';

if (!in_array($_SERVER['REQUEST_METHOD'], ['GET', 'HEAD'], true)) {
    header('Allow: GET, HEAD');
    abort(405, 'Method not allowed.');
}

$id = int_param($_GET['id'] ?? null);
if ($id === null) {
    abort(400, 'Bad image id.');
}

try {
    $image = OpenChat::imageFor($id);
} catch (Throwable $t) {
    error_log('openchat image: ' . $t::class . ': ' . $t->getMessage());
    abort(500, 'Something went wrong on my end.');
}
if ($image === null) {
    abort(404, 'No such image.');
}

header('Content-Type: ' . $image['mime']);
header('X-Content-Type-Options: nosniff');
header("Content-Security-Policy: default-src 'none'; sandbox");
header('Cross-Origin-Resource-Policy: same-origin');
header('Content-Disposition: inline; filename="openchat-' . $id . '"');
header('Cache-Control: public, max-age=86400');
header('Content-Length: ' . (string) filesize($image['path']));
if ($_SERVER['REQUEST_METHOD'] !== 'HEAD') {
    readfile($image['path']);
}
