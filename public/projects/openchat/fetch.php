<?php
declare(strict_types=1);

/**
 * OpenChat read API (JSON).
 *   fetch.php?last_id=N                  messages newer than id N (N may be 0)
 *   fetch.php?page=P[&per_page=K]        P is 0-based; clamped to >= 0. K is clamped to 1..100
 * Anything that is not a plain integer is a 400.
 */

require_once __DIR__ . '/../../../src/openchat/Store.php';

try {
    if (!in_array($_SERVER['REQUEST_METHOD'], ['GET', 'HEAD'], true)) {
        openchat_json(['ok' => false, 'error' => 'Method not allowed.'], 405, ['Allow: GET, HEAD']);
    }

    /** Integer (possibly negative or zero) from a query value, or null if it isn't one. */
    $intOrNull = static function (mixed $v): ?int {
        if (!is_string($v) || !preg_match('/^-?[0-9]{1,15}$/', $v)) {
            return null;
        }
        return (int) $v;
    };

    if (isset($_GET['last_id'])) {
        $raw = $_GET['last_id'];
        $lastId = $raw === '0' ? 0 : int_param($raw);
        if ($lastId === null) {
            openchat_json(['ok' => false, 'error' => 'last_id must be a non-negative integer.'], 400);
        }
        openchat_json(['ok' => true] + OpenChat::after($lastId));
    }

    if (isset($_GET['page'])) {
        $page = $intOrNull($_GET['page']);
        $perPage = isset($_GET['per_page']) ? $intOrNull($_GET['per_page']) : OpenChat::PER_PAGE;
        if ($page === null || $perPage === null) {
            openchat_json(['ok' => false, 'error' => 'page and per_page must be integers.'], 400);
        }
        openchat_json(['ok' => true] + OpenChat::page(
            max(0, $page),
            max(1, min($perPage, OpenChat::MAX_PER_PAGE))
        ));
    }

    openchat_json(['ok' => false, 'error' => 'Specify last_id or page.'], 400);
} catch (Throwable $t) {
    error_log('openchat fetch: ' . $t::class . ': ' . $t->getMessage());
    openchat_json(['ok' => false, 'error' => 'Something went wrong on my end.'], 500);
}
