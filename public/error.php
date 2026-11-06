<?php
declare(strict_types=1);
require_once __DIR__ . '/../src/layout.php';

// Rendered by Caddy's handle_errors for 4xx/5xx without a body of their own.
$messages = [
    403 => ['Forbidden', "You aren't allowed to see that."],
    404 => ['Not found', "There's nothing at this address."],
    405 => ['Method not allowed', "That request type isn't supported here."],
    413 => ['Too large', 'That request was too big.'],
    429 => ['Slow down', 'Too many requests. Try again in a bit.'],
    500 => ['Server error', 'Something broke on my end.'],
    502 => ['Server error', 'Something broke on my end.'],
    503 => ['Unavailable', 'Back shortly.'],
];
$code = int_param($_GET['code'] ?? null, 599) ?? 404;
[$title, $text] = $messages[$code] ?? ['Error', 'Something went wrong.'];

http_response_code($code);
page_start(['title' => $title]);
?>
<h1><?= e($code) ?> — <?= e($title) ?></h1>
<p><?= e($text) ?> <a href="/">Go home</a>.</p>
<?php page_end();
