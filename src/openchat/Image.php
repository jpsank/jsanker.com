<?php
declare(strict_types=1);

/**
 * Upload sanitiser for OpenChat. Original code written for this site; it
 * replaces the old SimpleImage class.
 *
 * Pipeline: size cap -> MIME sniff (finfo) -> header parse (getimagesize) ->
 * allow-list + consistency check -> pixel/memory caps (before decoding) ->
 * decode with GD -> scale down -> re-encode. Re-encoding discards every byte of
 * the original file (EXIF, trailing payloads, polyglots).
 */
final class OpenChatImageException extends RuntimeException
{
    public function __construct(string $message, public readonly int $status = 422)
    {
        parent::__construct($message);
    }
}

final class OpenChatImage
{
    public const MAX_BYTES  = 5 * 1024 * 1024;
    public const MAX_SIDE   = 8000;         // source width / height
    public const MAX_PIXELS = 16_000_000;   // source megapixels (GD needs ~4 bytes each)
    public const OUT_SIDE   = 500;          // stored width / height limit

    /** mime => [IMAGETYPE_*, decoder] */
    private const TYPES = [
        'image/jpeg' => [IMAGETYPE_JPEG, 'imagecreatefromjpeg'],
        'image/png'  => [IMAGETYPE_PNG,  'imagecreatefrompng'],
        'image/gif'  => [IMAGETYPE_GIF,  'imagecreatefromgif'],
        'image/webp' => [IMAGETYPE_WEBP, 'imagecreatefromwebp'],
    ];

    /** Stored extension => served Content-Type (the only two outputs we ever produce). */
    public const OUTPUTS = ['jpg' => 'image/jpeg', 'png' => 'image/png'];

    /**
     * @return array{bytes: string, ext: string} sanitised image bytes and extension
     * @throws OpenChatImageException with a message that is safe to show the user
     */
    public static function sanitize(string $path): array
    {
        $size = @filesize($path);
        if ($size === false || $size < 1) {
            throw new OpenChatImageException('That image is empty.');
        }
        if ($size > self::MAX_BYTES) {
            throw new OpenChatImageException('That image is too large (5 MB max).', 413);
        }

        $mime = (new finfo(FILEINFO_MIME_TYPE))->file($path);
        if (!is_string($mime) || !isset(self::TYPES[$mime])) {
            throw new OpenChatImageException('Only JPEG, PNG, GIF and WebP images are allowed.', 415);
        }
        [$expectedType, $decoder] = self::TYPES[$mime];
        if (!function_exists($decoder)) {
            throw new OpenChatImageException('That image format is not supported here.', 415);
        }

        $info = @getimagesize($path);
        if ($info === false || $info[2] !== $expectedType) {
            throw new OpenChatImageException('That does not look like a valid image.', 415);
        }
        [$w, $h] = $info;
        if ($w < 1 || $h < 1) {
            throw new OpenChatImageException('That does not look like a valid image.', 415);
        }
        if ($w > self::MAX_SIDE || $h > self::MAX_SIDE || $w * $h > self::MAX_PIXELS) {
            throw new OpenChatImageException('That image has too many pixels (8000 px per side, 16 megapixels max).', 413);
        }
        if (!self::fitsInMemory($w, $h)) {
            throw new OpenChatImageException('That image is too large to process.', 413);
        }

        if ($mime === 'image/gif') {
            self::checkGifFrames($path);
        }

        try {
            $src = $decoder($path);
            if ($src === false) {
                throw new OpenChatImageException('That image could not be read.');
            }
            // Trust what the decoder produced, not what the header claimed.
            $w = imagesx($src);
            $h = imagesy($src);
            if ($w < 1 || $h < 1 || $w > self::MAX_SIDE || $h > self::MAX_SIDE || $w * $h > self::MAX_PIXELS) {
                throw new OpenChatImageException('That image has too many pixels (8000 px per side, 16 megapixels max).', 413);
            }

            // Scale down (never up) so the longest side is OUT_SIDE.
            $scale = min(1.0, self::OUT_SIDE / max($w, $h));
            $nw = max(1, (int) round($w * $scale));
            $nh = max(1, (int) round($h * $scale));

            $dst = imagecreatetruecolor($nw, $nh);
            if ($dst === false) {
                throw new OpenChatImageException('That image could not be processed.');
            }
            $isJpeg = $mime === 'image/jpeg';
            if ($isJpeg) {
                imagefill($dst, 0, 0, (int) imagecolorallocate($dst, 255, 255, 255));
            } else {
                imagealphablending($dst, false);
                imagesavealpha($dst, true);
                imagefill($dst, 0, 0, (int) imagecolorallocatealpha($dst, 0, 0, 0, 127));
            }
            imagecopyresampled($dst, $src, 0, 0, 0, 0, $nw, $nh, $w, $h);
            unset($src);

            if ($isJpeg) {
                $dst = self::applyExifOrientation($dst, $path);
            }

            ob_start();
            $ok = $isJpeg ? imagejpeg($dst, null, 85) : imagepng($dst, null, 6);
            $bytes = (string) ob_get_clean();
            unset($dst);
            if (!$ok || $bytes === '') {
                throw new OpenChatImageException('That image could not be processed.');
            }
            return ['bytes' => $bytes, 'ext' => $isJpeg ? 'jpg' : 'png'];
        } catch (OpenChatImageException $e) {
            throw $e;
        } catch (Throwable $t) {
            // GD raises warnings (turned into exceptions) on truncated / hostile files.
            error_log('openchat image: ' . $t::class . ': ' . $t->getMessage());
            throw new OpenChatImageException('That image could not be read.');
        }
    }

    /**
     * getimagesize() reports a GIF's logical screen size, but libgd allocates the size of each frame, and the
     * two are independent fields in the file. Walk the GIF's blocks and apply the pixel caps to every frame
     * before anything is decoded. Bounded: each step moves forward and the file is already <= MAX_BYTES.
     */
    private static function checkGifFrames(string $path): void
    {
        $bad = static fn(): OpenChatImageException => new OpenChatImageException('That image could not be read.');
        $d = @file_get_contents($path);
        if ($d === false || strlen($d) < 14) {
            throw $bad();
        }
        $n = strlen($d);
        $flags = ord($d[10]);
        $pos = 13 + (($flags & 0x80) ? 3 * (1 << (($flags & 7) + 1)) : 0);

        $skipSubBlocks = static function (int $p) use ($d, $n, $bad): int {
            while ($p < $n) {
                $len = ord($d[$p++]);
                if ($len === 0) {
                    return $p;
                }
                $p += $len;
            }
            throw $bad();
        };

        while ($pos < $n) {
            $block = ord($d[$pos]);
            if ($block === 0x3B) {           // trailer
                return;
            }
            if ($block === 0x21) {           // extension: introducer, label, then data sub-blocks
                $pos = $skipSubBlocks($pos + 2);
                continue;
            }
            if ($block !== 0x2C || $pos + 10 > $n) {
                throw $bad();                // not an image descriptor either: malformed
            }
            $f = unpack('vleft/vtop/vw/vh', substr($d, $pos + 1, 8));
            if ($f['w'] < 1 || $f['h'] < 1 || $f['w'] > self::MAX_SIDE || $f['h'] > self::MAX_SIDE
                || $f['w'] * $f['h'] > self::MAX_PIXELS) {
                throw new OpenChatImageException('That image has too many pixels (8000 px per side, 16 megapixels max).', 413);
            }
            $local = ord($d[$pos + 9]);
            $pos += 10 + (($local & 0x80) ? 3 * (1 << (($local & 7) + 1)) : 0);
            $pos = $skipSubBlocks($pos + 1); // +1: LZW minimum code size byte
        }
        throw $bad();                        // ran off the end without a trailer
    }

    private static function fitsInMemory(int $w, int $h): bool
    {
        $limit = self::bytesFromIni((string) ini_get('memory_limit'));
        if ($limit <= 0) {
            return true; // unlimited
        }
        // decoded source + a little slack for the scaled copy and encoder
        $need = $w * $h * 5 + 8 * 1024 * 1024;
        return $need <= $limit - memory_get_usage(true);
    }

    private static function bytesFromIni(string $v): int
    {
        $v = trim($v);
        if ($v === '' || $v === '-1') {
            return -1;
        }
        $n = (int) $v;
        return match (strtolower(substr($v, -1))) {
            'g' => $n * 1024 ** 3,
            'm' => $n * 1024 ** 2,
            'k' => $n * 1024,
            default => $n,
        };
    }

    /** Honour the camera's rotation flag, since re-encoding drops EXIF. Needs ext-exif; skipped otherwise. */
    private static function applyExifOrientation(GdImage $img, string $path): GdImage
    {
        if (!function_exists('exif_read_data')) {
            return $img;
        }
        try {
            $exif = exif_read_data($path, 'IFD0');
            $angle = match ((int) ($exif['Orientation'] ?? 1)) {
                3 => 180,
                6 => 270, // imagerotate is counter-clockwise
                8 => 90,
                default => 0,
            };
            if ($angle !== 0) {
                $rot = imagerotate($img, $angle, 0);
                if ($rot !== false) {
                    return $rot;
                }
            }
        } catch (Throwable) {
            // unreadable EXIF: leave the image as is
        }
        return $img;
    }
}
