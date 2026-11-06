<?php
declare(strict_types=1);

/**
 * OpenChat — an open ledger for anonymous public messages.
 * Ported from the original PHP/SQLite app and hardened: prepared statements,
 * validated and rate-limited posting, re-encoded image uploads stored outside
 * the web root (and only when OPENCHAT_ALLOW_IMAGES=1), escaped output.
 */

require_once __DIR__ . '/../../../src/layout.php';
require_once __DIR__ . '/../../../src/openchat/Store.php';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    // JS clients get JSON; a plain form post (no JS) gets a redirect or a text error.
    $wantsJson = str_contains($_SERVER['HTTP_ACCEPT'] ?? '', 'application/json');
    try {
        OpenChat::post($_POST, $_FILES);
        if ($wantsJson) {
            openchat_json(['ok' => true]);
        }
        redirect('/projects/openchat/');
    } catch (OpenChatException $e) {
        $headers = $e->retryAfter > 0 ? ['Retry-After: ' . $e->retryAfter] : [];
        if ($wantsJson) {
            openchat_json(['ok' => false, 'error' => $e->getMessage()], $e->status, $headers);
        }
        foreach ($headers as $h) {
            header($h);
        }
        abort($e->status, $e->getMessage());
    } catch (Throwable $t) {
        error_log('openchat post: ' . $t::class . ': ' . $t->getMessage());
        if ($wantsJson) {
            openchat_json(['ok' => false, 'error' => 'Something went wrong on my end.'], 500);
        }
        abort(500, 'Something went wrong on my end.');
    }
}

if (!in_array($_SERVER['REQUEST_METHOD'], ['GET', 'HEAD'], true)) {
    header('Allow: GET, HEAD, POST');
    abort(405, 'Method not allowed.');
}

$images = OpenChat::imagesEnabled();

page_start([
    'legacy'      => true,
    'title'       => 'OpenChat',
    'description' => 'An open ledger for posting anonymous public messages',
    'crumbs'      => [['OpenChat', 'index.php']],
    'styles'      => ['/projects/openchat/style.css'],
    'scripts'     => ['/projects/openchat/script.js'],
]);
?>

	<section id="jumbo">
		<h1>OpenChat</h1>
		<p>welcome to openchat, an open ledger for posting anonymous public messages</p>
	</section>

	<section id="main">

		<form id="form" method="post" action="/projects/openchat/"<?= $images ? ' enctype="multipart/form-data"' : '' ?>>
		    <input type="text" name="text" placeholder="type something" maxlength="<?= OpenChat::MAX_LENGTH ?>" required="required" autocomplete="off">
<?php if ($images): ?>
		    <input name="userfile" accept="image/jpeg,image/png,image/gif,image/webp" type="file" />
<?php endif; ?>
		    <input type="submit">
		    <p id="form-error" role="alert" hidden></p>
		</form>

		<div id="ledger" data-per-page="<?= OpenChat::PER_PAGE ?>" aria-live="polite">
		</div>

	</section>

<?php page_end();
