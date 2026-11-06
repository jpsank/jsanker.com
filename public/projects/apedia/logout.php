<?php
declare(strict_types=1);

require_once __DIR__ . '/../../../src/apedia/page.php';

// Logging out changes state, so it is POST-only and CSRF-protected.
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    csrf_require();
    session_destroy_all();
}
redirect(APEDIA_URL);
