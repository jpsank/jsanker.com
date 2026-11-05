<?php
declare(strict_types=1);

/**
 * Shared plumbing for jsanker.com and every PHP project under it:
 * output escaping, security headers / CSP, hardened sessions, CSRF tokens,
 * SQLite access and rate limiting.
 *
 * Rules the projects follow:
 *   - every value printed into HTML goes through e()
 *   - every SQL statement is a prepared statement with bound parameters
 *   - every state-changing request is a POST carrying a CSRF token
 */

define('APP_ROOT', dirname(__DIR__));

// ---------------------------------------------------------------- errors ---

set_error_handler(static function (int $severity, string $message, string $file, int $line): bool {
    if (!(error_reporting() & $severity)) {
        return false;
    }
    if ($severity & (E_DEPRECATED | E_USER_DEPRECATED)) {
        error_log("Deprecated: $message in $file:$line");
        return true;
    }
    throw new ErrorException($message, 0, $severity, $file, $line);
});

set_exception_handler(static function (Throwable $t): void {
    error_log(sprintf('%s: %s in %s:%d', $t::class, $t->getMessage(), $t->getFile(), $t->getLine()));
    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: text/plain; charset=utf-8');
    }
    echo "Something went wrong on my end.\n";
});

// ----------------------------------------------------------------- basics ---

/** Escape a value for HTML text *and* attribute contexts. */
function e(string|int|float|null $value): string
{
    return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

/** Writable application state lives only here (a mounted volume in production). */
function data_dir(string $sub = ''): string
{
    $base = getenv('APP_DATA_DIR') ?: APP_ROOT . '/var';
    $path = $sub === '' ? $base : $base . '/' . $sub;
    if (!is_dir($path) && !mkdir($path, 0750, true) && !is_dir($path)) {
        throw new RuntimeException('Cannot create data directory');
    }
    return $path;
}

function is_https(): bool
{
    return ($_SERVER['HTTPS'] ?? '') === 'on'
        || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
}

function client_ip(): string
{
    return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
}

/** Stable per-install secret, generated on first use. Used to hash IPs for rate limiting. */
function app_secret(): string
{
    static $secret = null;
    if ($secret !== null) {
        return $secret;
    }
    $file = data_dir() . '/secret.key';
    if (!is_file($file)) {
        file_put_contents($file, bin2hex(random_bytes(32)), LOCK_EX);
        chmod($file, 0600);
    }
    return $secret = trim((string) file_get_contents($file));
}

function abort(int $status, string $message): never
{
    http_response_code($status);
    header('Content-Type: text/plain; charset=utf-8');
    echo $message . "\n";
    exit;
}

function redirect(string $to): never
{
    // Only same-site paths: never an absolute URL, never protocol-relative.
    if (!preg_match('#^/(?!/)[^\r\n]*$#', $to)) {
        $to = '/';
    }
    header('Location: ' . $to, true, 303);
    exit;
}

/** Positive integer from a GET/POST value, or null if it isn't one. */
function int_param(mixed $value, int $max = PHP_INT_MAX): ?int
{
    if (!is_string($value) || !preg_match('/^[1-9][0-9]{0,17}$/', $value)) {
        return null;
    }
    $n = (int) $value;
    return $n <= $max ? $n : null;
}

/** String from a request value, trimmed, with a hard length cap (in characters). */
function str_param(mixed $value, int $maxLength): ?string
{
    if (!is_string($value)) {
        return null;
    }
    $value = trim(str_replace("\0", '', $value));
    if (!mb_check_encoding($value, 'UTF-8') || mb_strlen($value) > $maxLength) {
        return null;
    }
    return $value;
}

// -------------------------------------------------------- headers and CSP ---

/**
 * Content-Security-Policy builder. Defaults are strict: no inline script, no
 * inline style, nothing from other origins. Pages that need more call
 * csp_allow() *before* the layout sends headers.
 */
function csp_defaults(): array
{
    return [
        'default-src'     => ["'none'"],
        'script-src'      => ["'self'"],
        'style-src'       => ["'self'"],
        'img-src'         => ["'self'", 'data:'],
        'font-src'        => ["'self'"],
        'connect-src'     => ["'self'"],
        'media-src'       => ["'self'", 'blob:'],
        'form-action'     => ["'self'"],
        'base-uri'        => ["'none'"],
        'object-src'      => ["'none'"],
        'frame-ancestors' => ["'none'"],
    ];
}

/** Adds sources to a directive, EXTENDING the strict default (never replacing it). */
function csp_allow(string $directive, string ...$sources): void
{
    $current = $GLOBALS['__csp'][$directive] ?? csp_defaults()[$directive] ?? [];
    $merged = array_values(array_unique(array_merge($current, $sources)));
    if (count($merged) > 1) {
        $merged = array_values(array_diff($merged, ["'none'"])); // 'none' can't be combined
    }
    $GLOBALS['__csp'][$directive] = $merged;
}

function send_security_headers(): void
{
    if (headers_sent()) {
        return;
    }
    $csp = array_merge(csp_defaults(), $GLOBALS['__csp'] ?? []);

    $parts = [];
    foreach ($csp as $directive => $sources) {
        $parts[] = $directive . ' ' . implode(' ', $sources);
    }
    header('Content-Security-Policy: ' . implode('; ', $parts));
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: strict-origin-when-cross-origin');
}

// --------------------------------------------------------------- sessions ---

function session_boot(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    session_name('jsid');
    session_save_path(data_dir('sessions'));
    session_set_cookie_params([
        'lifetime' => 0,
        'path'     => '/',
        'secure'   => is_https(),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();
}

/** Call right after a successful login to prevent session fixation. */
function session_rotate(): void
{
    session_boot();
    session_regenerate_id(true);
    unset($_SESSION['csrf']);
}

function session_destroy_all(): void
{
    session_boot();
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $p = session_get_cookie_params();
        setcookie(session_name(), '', [
            'expires'  => time() - 3600,
            'path'     => $p['path'],
            'secure'   => $p['secure'],
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
    }
    session_destroy();
}

// ------------------------------------------------------------------- CSRF ---

function csrf_token(): string
{
    session_boot();
    if (empty($_SESSION['csrf'])) {
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
    }
    return $_SESSION['csrf'];
}

function csrf_field(): string
{
    return '<input type="hidden" name="csrf" value="' . e(csrf_token()) . '">';
}

/** Require a POST with a valid CSRF token; 403 otherwise. */
function csrf_require(): void
{
    session_boot();
    $sent = $_POST['csrf'] ?? '';
    if ($_SERVER['REQUEST_METHOD'] !== 'POST'
        || !is_string($sent)
        || empty($_SESSION['csrf'])
        || !hash_equals($_SESSION['csrf'], $sent)) {
        abort(403, 'Invalid or missing security token. Go back, reload the page and try again.');
    }
}

// --------------------------------------------------------------- database ---

function db(string $name): PDO
{
    static $connections = [];
    if (!preg_match('/^[a-z0-9_]+$/', $name)) {
        throw new InvalidArgumentException('Bad database name');
    }
    if (isset($connections[$name])) {
        return $connections[$name];
    }
    $pdo = new PDO('sqlite:' . data_dir('db') . "/$name.sqlite", null, null, [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
    ]);
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA foreign_keys = ON');
    $pdo->exec('PRAGMA busy_timeout = 5000');
    return $connections[$name] = $pdo;
}

// ----------------------------------------------------------- rate limiting ---

/**
 * Sliding-window limiter keyed by (bucket, hashed client IP).
 * Returns true if the action is allowed (and records it), false if over the limit.
 */
function rate_limit(string $bucket, int $max, int $windowSeconds): bool
{
    $pdo = db('ratelimit');
    $pdo->exec('CREATE TABLE IF NOT EXISTS hits (
        key TEXT NOT NULL,
        at  INTEGER NOT NULL
    )');
    $pdo->exec('CREATE INDEX IF NOT EXISTS hits_key_at ON hits (key, at)');

    $key = $bucket . ':' . hash_hmac('sha256', client_ip(), app_secret());
    $now = time();

    $pdo->prepare('DELETE FROM hits WHERE at < :cutoff')->execute([':cutoff' => $now - 86400]);

    $count = $pdo->prepare('SELECT COUNT(*) FROM hits WHERE key = :key AND at > :since');
    $count->execute([':key' => $key, ':since' => $now - $windowSeconds]);
    if ((int) $count->fetchColumn() >= $max) {
        return false;
    }
    $pdo->prepare('INSERT INTO hits (key, at) VALUES (:key, :at)')->execute([':key' => $key, ':at' => $now]);
    return true;
}
