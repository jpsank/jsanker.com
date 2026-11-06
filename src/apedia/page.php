<?php
declare(strict_types=1);

/**
 * Shared helpers for the APedia pages: repository access, session login state,
 * flash messages, text rendering, common page chrome and form fragments.
 */

require_once __DIR__ . '/../layout.php';
require_once __DIR__ . '/Repo.php';

const APEDIA_URL = '/projects/apedia/';

// Hash of a throwaway password, verified when a username doesn't exist so that
// "unknown user" and "wrong password" take about the same time.
const APEDIA_DUMMY_HASH = '$2y$12$iG3LJmWnoh.fs.QCu6zxpeYDUyZM9rXnjcZGJoh3u6cvJtSJVJaLi';

function apedia_repo(): ApediaRepo
{
    static $repo = null;
    return $repo ??= new ApediaRepo(db('apedia'));
}

/** The logged-in user ['id', 'username', 'created_at'], or null. Call before any output. */
function apedia_user(): ?array
{
    static $loaded = false, $user = null;
    if ($loaded) {
        return $user;
    }
    $loaded = true;
    session_boot();
    $id = $_SESSION['apedia_uid'] ?? null;
    if (is_int($id)) {
        $user = apedia_repo()->userById($id);
        if ($user === null) {
            unset($_SESSION['apedia_uid']);   // account vanished
        }
    }
    return $user;
}

function apedia_sign_in(int $userId): void
{
    session_rotate();                         // new session id: no fixation
    $_SESSION['apedia_uid'] = $userId;
}

function apedia_require_login(): array
{
    $me = apedia_user();
    if ($me === null) {
        redirect(APEDIA_URL . 'login.php');
    }
    return $me;
}

function apedia_flash(string $message): void
{
    session_boot();
    $_SESSION['apedia_flash'] = $message;
}

function apedia_take_flash(): ?string
{
    session_boot();
    $m = $_SESSION['apedia_flash'] ?? null;
    unset($_SESSION['apedia_flash']);
    return is_string($m) ? $m : null;
}

/** Rate limit a write action; on refusal, flash a message and redirect back to $backTo. */
function apedia_throttle(string $bucket, int $max, int $window, string $backTo): void
{
    if (!rate_limit($bucket, $max, $window)) {
        apedia_flash('You are doing that too often. Please wait a few minutes and try again.');
        redirect($backTo);
    }
}

/**
 * Validate user-submitted post text. Returns [text, error]. The text is stored raw
 * (never pre-escaped); it is escaped on output with render_text().
 */
function apedia_clean_text(mixed $value): array
{
    if (!is_string($value)) {
        return [null, 'Please write something.'];
    }
    $value = str_replace(["\r\n", "\r"], "\n", $value);
    $text = str_param($value, ApediaRepo::TEXT_MAX);
    if ($text === null) {
        return [null, 'That text is invalid or longer than ' . ApediaRepo::TEXT_MAX . ' characters.'];
    }
    if ($text === '') {
        return [null, 'Please write something.'];
    }
    return [$text, null];
}

/** Escaped text with line breaks and doubled spaces preserved. */
function render_text(string $text): string
{
    return nl2br(str_replace('  ', ' &nbsp;', e($text)), false);
}

function snippet(string $text, int $max = 100): string
{
    $text = preg_replace('/\s+/u', ' ', $text) ?? $text;
    return mb_strlen($text) > $max ? mb_substr($text, 0, $max) . '...' : $text;
}

function plural(int $n, string $one, string $many): string
{
    return $n . ' ' . ($n === 1 ? $one : $many);
}

function apedia_date(string $ts): string
{
    return substr($ts, 0, 10);
}

function topic_url(int $id): string
{
    return APEDIA_URL . 'topic.php?id=' . $id;
}

function question_url(int $id, ?int $postAnchor = null): string
{
    return APEDIA_URL . 'question.php?id=' . $id . ($postAnchor !== null ? '#p' . $postAnchor : '');
}

function user_url(int $id): string
{
    return APEDIA_URL . 'user.php?id=' . $id;
}

/**
 * Start an APedia page in the original puffyboa.xyz look.
 * $trail = extra crumbs after "APedia", as [[label, url|null], ...].
 * $layout: 'home' (big centred title + search form, <div class="main">),
 *          'inner' (small title, login status list, <div id="main">),
 *          'auth' (small title only, <div id="main">).
 */
function apedia_start(string $title, array $trail = [], ?array $me = null, string $searchValue = '', string $layout = 'inner'): void
{
    $crumbs = [['APedia', APEDIA_URL . 'index.php']];
    foreach ($trail as [$label, $url]) {
        $crumbs[] = [$label, $url ?? ''];
    }
    page_start([
        'legacy'      => true,
        'title'       => 'APedia',
        'description' => 'Crowd-sourced Q and A for AP classes',
        'crumbs'      => $crumbs,
        'styles'      => [APEDIA_URL . 'style.css'],
        'scripts'     => [APEDIA_URL . 'script.js'],
    ]);

    if ($layout !== 'auth') {
        echo '<ul class="nav">' . "\n    ";
        if ($me !== null) {
            echo '<li>Logged in as <a href="' . e(user_url((int) $me['id'])) . '">' . e($me['username']) . '</a>. '
                . '<form class="logout" method="post" action="' . e(APEDIA_URL . 'logout.php') . '">'
                . csrf_field() . '<button type="submit">Log out</button></form></li>';
        } else {
            echo '<li><a href="' . e(APEDIA_URL . 'login.php') . '">Log in</a> or <a href="' . e(APEDIA_URL . 'register.php') . '">Sign up</a></li>';
        }
        echo "\n</ul>\n\n";
    }

    $spans = '<span class="A">A</span><span class="P">P</span>edia';
    if ($layout === 'home') {
        echo '<div class="jumbo title">' . "\n    <h1>\n        <a href=\"" . e(APEDIA_URL . 'index.php') . '">' . $spans . "</a>\n    </h1>\n"
            . "    <p>Crowd-sourced Q and A for AP classes</p>\n</div>\n\n";
        echo '<form id="search" method="get">' . "\n"
            . '    <input type="text" name="search" maxlength="100" placeholder="Search questions" aria-label="Search questions" value="' . e($searchValue) . '">' . "\n"
            . '    <input type="submit" value="Search">' . "\n</form>\n\n\n";
        echo '<div class="main">' . "\n";
    } else {
        if ($layout === 'auth') {
            echo '<div class="left title">' . "\n    <a href=\"" . e(APEDIA_URL . 'index.php') . '"><h1>' . $spans . "</h1></a>\n</div>\n\n";
        } else {
            echo '<div class="left title">' . "\n    <h1><a href=\"" . e(APEDIA_URL . 'index.php') . '">' . $spans . "</a></h1>\n</div>\n\n";
        }
        echo '<div id="main">' . "\n";
    }

    $flash = apedia_take_flash();
    if ($flash !== null) {
        echo '<p class="err_message">' . e($flash) . "</p>\n";
    }
}

function apedia_end(): void
{
    echo "</div>\n";
    page_end();
}

/** 404 page; ends the request. */
function apedia_not_found(string $what, ?array $me): never
{
    http_response_code(404);
    apedia_start('APedia', [], $me);
    echo e($what) . ' not found.';
    apedia_end();
    exit;
}

/** Vote container: a CSRF-protected upvote form (logged in) or the plain count (logged out). */
function vote_widget(array $row, bool $loggedIn, string $action): string
{
    $id = (int) $row['id'];
    $n = (int) $row['votes'];
    if (!$loggedIn) {
        return "<div class='vote_container no_login'>" . $n . ' <span>&#9650;</span></p></div>';   // stray </p> kept from the original (it renders an empty paragraph)
    }
    $mine = (int) $row['mine'] > 0;
    return "<div class='vote_container" . ($mine ? ' already' : '') . "'>"
        . '<form method="post" action="' . e($action) . '">'
        . '<label>' . $n . '</label>'
        . csrf_field()
        . '<input type="hidden" name="action" value="vote">'
        . '<input type="hidden" name="post_id" value="' . $id . '">'
        . '<input type="submit" value="&#9650;" title="' . ($mine ? 'Remove your vote' : 'Upvote') . '">'
        . '</form></div>';
}

/** A text-posting form (expands on focus, see script.js), or a login link when logged out. */
function post_form(string $action, string $label, bool $loggedIn, ?int $parentId = null, string $verb = 'post'): string
{
    if (!$loggedIn) {
        return "<p class='login_link'><a href=\"" . e(APEDIA_URL . 'login.php') . '">Login to <span>' . e($label) . '</span></a></p>';
    }
    return '<form class="submit block" method="post" action="' . e($action) . '">'
        . csrf_field()
        . '<input type="hidden" name="action" value="' . e($verb) . '">'
        . '<textarea name="text" maxlength="' . ApediaRepo::TEXT_MAX . '" placeholder="' . e($label) . '" aria-label="' . e($label) . '" required></textarea>'
        . ($parentId !== null ? '<input type="hidden" name="parent_id" value="' . $parentId . '">' : '')
        . '<input type="submit"></form>';
}
