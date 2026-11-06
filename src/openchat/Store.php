<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/Image.php';
require_once __DIR__ . '/../Censor.php';

/** Thrown for problems the visitor can fix; message and status are safe to show. */
final class OpenChatException extends RuntimeException
{
    public function __construct(string $message, public readonly int $status = 400, public readonly int $retryAfter = 0)
    {
        parent::__construct($message);
    }
}

/**
 * OpenChat storage and post handling. All SQL uses bound parameters.
 * Images live in data_dir('openchat/uploads') as <id>.<ext>, never under public/.
 */
final class OpenChat
{
    public const MAX_LENGTH   = 1000;
    public const PER_PAGE     = 50;
    public const MAX_PER_PAGE = 100;

    /** Image abuse limits. A stored image is at most ~1 MB, so the site-wide cap bounds disk use per day. */
    public const IMAGES_PER_CLIENT_PER_DAY = 10;
    public const IMAGES_PER_SITE_PER_DAY   = 300;
    public const MIN_FREE_DISK_BYTES       = 2 * 1024 ** 3; // stop accepting images below 2 GB free

    public static function imagesEnabled(): bool
    {
        return getenv('OPENCHAT_ALLOW_IMAGES') === '1';
    }

    public static function uploadDir(): string
    {
        return data_dir('openchat/uploads');
    }

    public static function db(): PDO
    {
        static $ready = false;
        $pdo = db('openchat');
        if (!$ready) {
            $pdo->exec('CREATE TABLE IF NOT EXISTS messages (
                id             INTEGER PRIMARY KEY,
                message        TEXT NOT NULL,
                post_date      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                has_attachment INTEGER NOT NULL DEFAULT 0,
                image_ext      TEXT
            )');
            $pdo->exec('CREATE INDEX IF NOT EXISTS messages_post_date ON messages (post_date)');
            $ready = true;
        }
        return $pdo;
    }

    // ---------------------------------------------------------------- reading

    /** @return array{metadata: array<string,int>, result: list<array<string,mixed>>} */
    public static function page(int $page, int $perPage): array
    {
        $page = max(0, min($page, 1_000_000));
        $perPage = max(1, min($perPage, self::MAX_PER_PAGE));

        $pdo = self::db();
        $stmt = $pdo->prepare('SELECT id, message, post_date, has_attachment FROM messages
                               ORDER BY id DESC LIMIT :limit OFFSET :offset');
        $stmt->bindValue(':limit', $perPage, PDO::PARAM_INT);
        $stmt->bindValue(':offset', $page * $perPage, PDO::PARAM_INT);
        $stmt->execute();
        $rows = self::publicRows($stmt->fetchAll());

        $total = (int) $pdo->query('SELECT COUNT(*) FROM messages')->fetchColumn();
        return [
            'metadata' => ['num_pages' => (int) ceil($total / $perPage), 'num_messages' => $total],
            'result'   => $rows,
        ];
    }

    /** @return array{metadata: array<string,int>, result: list<array<string,mixed>>} */
    public static function after(int $lastId): array
    {
        $stmt = self::db()->prepare('SELECT id, message, post_date, has_attachment FROM messages
                                     WHERE id > :id ORDER BY id DESC LIMIT :limit');
        $stmt->bindValue(':id', $lastId, PDO::PARAM_INT);
        $stmt->bindValue(':limit', self::MAX_PER_PAGE, PDO::PARAM_INT);
        $stmt->execute();
        $rows = self::publicRows($stmt->fetchAll());
        return ['metadata' => ['num_messages' => count($rows)], 'result' => $rows];
    }

    /**
     * Only expose what the client needs, with proper types.
     * Existing attachments are always shown; OPENCHAT_ALLOW_IMAGES only gates NEW uploads.
     */
    private static function publicRows(array $rows): array
    {
        return array_map(static fn(array $r): array => [
            'id'             => (int) $r['id'],
            'message'        => (string) $r['message'],
            'post_date'      => (string) $r['post_date'], // UTC, "YYYY-MM-DD HH:MM:SS"
            'has_attachment' => (int) $r['has_attachment'] === 1 ? 1 : 0,
        ], $rows);
    }

    /**
     * Attach an image to an existing message from a file on disk (used by the legacy
     * import). The file goes through exactly the same sanitiser as a new upload:
     * type sniffing, size/pixel caps, GD decode, resize, re-encode.
     *
     * @throws OpenChatImageException if the file is not an acceptable image
     */
    public static function importImage(int $id, string $path): void
    {
        $image = OpenChatImage::sanitize($path);
        $pdo = self::db();
        $exists = $pdo->prepare('SELECT 1 FROM messages WHERE id = :id');
        $exists->execute([':id' => $id]);
        if (!$exists->fetchColumn()) {
            throw new OpenChatImageException("No message with id $id.", 404);
        }
        $dest = self::uploadDir() . "/$id.{$image['ext']}";
        if (file_put_contents($dest, $image['bytes'], LOCK_EX) === false) {
            throw new RuntimeException('could not store image');
        }
        chmod($dest, 0640);
        $pdo->prepare('UPDATE messages SET has_attachment = 1, image_ext = :ext WHERE id = :id')
            ->execute([':ext' => $image['ext'], ':id' => $id]);
    }

    /** @return array{path: string, mime: string}|null  image file for a message, if any */
    public static function imageFor(int $id): ?array
    {
        $stmt = self::db()->prepare('SELECT image_ext FROM messages WHERE id = :id AND has_attachment = 1');
        $stmt->execute([':id' => $id]);
        $ext = $stmt->fetchColumn();
        // The extension is mapped through an allow-list; the path is built from an int id only.
        if (!is_string($ext) || !isset(OpenChatImage::OUTPUTS[$ext])) {
            return null;
        }
        $path = self::uploadDir() . "/$id.$ext";
        return is_file($path) ? ['path' => $path, 'mime' => OpenChatImage::OUTPUTS[$ext]] : null;
    }

    // ---------------------------------------------------------------- writing

    /** Validate the text: trimmed, valid UTF-8, 1..1000 chars, no control characters. */
    public static function cleanText(mixed $raw): string
    {
        if (!is_string($raw) || !mb_check_encoding($raw, 'UTF-8')) {
            throw new OpenChatException('Message must be text.');
        }
        $text = trim($raw);
        $len = mb_strlen($text);
        if ($len < 1) {
            throw new OpenChatException('Type a message first.');
        }
        if ($len > self::MAX_LENGTH) {
            throw new OpenChatException('Message exceeds the ' . self::MAX_LENGTH . ' character limit.', 413);
        }
        // C0/C1 controls (incl. NUL and newlines), and bidi override/isolate characters used for spoofing.
        if (preg_match('/[\p{Cc}\x{202A}-\x{202E}\x{2066}-\x{2069}]/u', $text)) {
            throw new OpenChatException('Message contains characters that are not allowed.');
        }
        return $text;
    }

    /** Cheap CSRF defence in depth: browsers tell us when a request is cross-site. */
    public static function requireSameOrigin(): void
    {
        $site = $_SERVER['HTTP_SEC_FETCH_SITE'] ?? null;
        if ($site !== null && $site !== 'same-origin' && $site !== 'none') {
            throw new OpenChatException('Cross-site posts are not allowed.', 403);
        }
        $origin = $_SERVER['HTTP_ORIGIN'] ?? null;
        if ($origin !== null && $origin !== 'null') {
            $host = parse_url($origin, PHP_URL_HOST);
            $port = parse_url($origin, PHP_URL_PORT);
            $originHost = is_string($host) ? strtolower($host) . ($port ? ':' . $port : '') : '';
            if ($originHost === '' || $originHost !== strtolower((string) ($_SERVER['HTTP_HOST'] ?? ''))) {
                throw new OpenChatException('Cross-site posts are not allowed.', 403);
            }
        } elseif ($origin === 'null') {
            throw new OpenChatException('Cross-site posts are not allowed.', 403);
        }
    }

    /** @return int id of the new message */
    public static function post(array $post, array $files): int
    {
        self::requireSameOrigin();

        $file = $files['userfile'] ?? null;
        $hasFile = is_array($file) && is_int($file['error'] ?? null) && $file['error'] !== UPLOAD_ERR_NO_FILE;
        if ($hasFile && !self::imagesEnabled()) {
            throw new OpenChatException('Image uploads are turned off on this board.', 403);
        }

        // Every attempt counts against the client's budget, even one that fails validation below, so a
        // flood of bad requests cannot be free. All of this happens before any image decoding (the expensive part).
        if (!rate_limit('openchat_post_min', 6, 60)) {
            throw new OpenChatException('You are posting too fast. Try again in a minute.', 429, 60);
        }
        if (!rate_limit('openchat_post_day', 60, 86400)) {
            throw new OpenChatException('Daily post limit reached. Try again tomorrow.', 429, 3600);
        }
        if ($hasFile) {
            // Images cost disk and CPU, so they get a tighter personal budget and a sitewide cap, and are
            // paused outright when the disk is nearly full.
            if (!rate_limit('openchat_img_day', self::IMAGES_PER_CLIENT_PER_DAY, 86400)) {
                throw new OpenChatException('Daily image limit reached. Try again tomorrow, or post without an image.', 429, 3600);
            }
            if (!rate_limit('openchat_img_site_day', self::IMAGES_PER_SITE_PER_DAY, 86400, true)) {
                throw new OpenChatException('The board has reached its image limit for today. Try again tomorrow.', 429, 3600);
            }
            $free = @disk_free_space(self::uploadDir());
            if ($free !== false && $free < self::MIN_FREE_DISK_BYTES) {
                throw new OpenChatException('Image uploads are paused right now. Post without an image.', 503, 3600);
            }
        }

        // Slurs are masked before storage, so the database never holds them. Same length, so the limit still holds.
        $text = Censor::clean(self::cleanText($post['text'] ?? null));

        $image = null;
        if ($hasFile) {
            $image = self::processUpload($file);
        }

        $pdo = self::db();
        $pdo->beginTransaction();
        $path = null;
        try {
            $stmt = $pdo->prepare("INSERT INTO messages (message, post_date, has_attachment, image_ext)
                                   VALUES (:message, strftime('%Y-%m-%d %H:%M:%S', 'now'), :att, :ext)");
            $stmt->bindValue(':message', $text);
            $stmt->bindValue(':att', $image ? 1 : 0, PDO::PARAM_INT);
            $stmt->bindValue(':ext', $image['ext'] ?? null, $image ? PDO::PARAM_STR : PDO::PARAM_NULL);
            $stmt->execute();
            $id = (int) $pdo->lastInsertId();

            if ($image) {
                $path = self::uploadDir() . "/$id.{$image['ext']}";
                if (file_put_contents($path, $image['bytes'], LOCK_EX) === false) {
                    throw new RuntimeException('could not store upload');
                }
                chmod($path, 0640);
            }
            $pdo->commit();
        } catch (Throwable $t) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            if ($path !== null && is_file($path)) {
                unlink($path);
            }
            throw $t;
        }
        return $id;
    }

    /** @return array{bytes: string, ext: string} */
    private static function processUpload(array $file): array
    {
        switch ($file['error']) {
            case UPLOAD_ERR_OK:
                break;
            case UPLOAD_ERR_INI_SIZE:
            case UPLOAD_ERR_FORM_SIZE:
                throw new OpenChatException('That image is too large (5 MB max).', 413);
            case UPLOAD_ERR_PARTIAL:
                throw new OpenChatException('The image upload was interrupted. Try again.');
            default:
                throw new OpenChatException('The image could not be uploaded.');
        }
        $tmp = $file['tmp_name'] ?? null;
        if (!is_string($tmp) || !is_uploaded_file($tmp)) {
            throw new OpenChatException('The image could not be uploaded.');
        }
        try {
            return OpenChatImage::sanitize($tmp);
        } catch (OpenChatImageException $e) {
            throw new OpenChatException($e->getMessage(), $e->status);
        }
    }
}

/** Send a JSON response and stop. */
function openchat_json(array $payload, int $status = 200, array $headers = []): never
{
    send_security_headers();
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    foreach ($headers as $h) {
        header($h);
    }
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE | JSON_HEX_TAG | JSON_HEX_AMP);
    exit;
}
