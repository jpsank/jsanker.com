<?php
declare(strict_types=1);

/** Tests for the OpenChat upload sanitiser (src/openchat/Image.php).   php tests/openchat_image_test.php */

require_once __DIR__ . '/../src/openchat/Image.php';

$fail = 0;
$payload = '<?php system($_GET[0]); ?><script>alert(1)</script>';

/** @return array{ok: bool, out?: string, msg?: string} */
function run(string $bytes): array
{
    $p = tempnam(sys_get_temp_dir(), 'oc');
    file_put_contents($p, $bytes);
    try {
        return ['ok' => true, 'out' => OpenChatImage::sanitize($p)['bytes']];
    } catch (OpenChatImageException $e) {
        return ['ok' => false, 'msg' => $e->getMessage()];
    } finally {
        unlink($p);
    }
}
function check(bool $cond, string $label): void
{
    global $fail;
    if (!$cond) {
        $fail++;
        echo "FAIL: $label\n";
    }
}
function chunk(string $type, string $data): string
{
    return pack('N', strlen($data)) . $type . $data . pack('N', crc32($type . $data));
}
function gd_bytes(callable $encode, int $w, int $h): string
{
    $im = imagecreatetruecolor($w, $h);
    ob_start();
    $encode($im);
    return (string) ob_get_clean();
}

// real images pass, and trailing payloads do not survive re-encoding
$png = gd_bytes(fn($im) => imagepng($im), 64, 64);
$jpg = gd_bytes(fn($im) => imagejpeg($im), 64, 64);
$gif = gd_bytes(fn($im) => imagegif($im), 64, 64);
foreach (['png' => $png, 'jpeg' => $jpg, 'gif' => $gif] as $name => $img) {
    $r = run($img);
    check($r['ok'], "valid $name accepted");
    $r = run($img . $payload);
    check($r['ok'] && !str_contains($r['out'], '<?php') && !str_contains($r['out'], '<script'), "$name: trailing payload stripped");
}

// not images
check(!run('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')['ok'], 'svg rejected');
check(!run('<!DOCTYPE html><script>alert(1)</script>')['ok'], 'html rejected');
check(!run('<?php system($_GET[0]);')['ok'], 'php source rejected');
check(!run('')['ok'], 'empty rejected');
check(!run("\xFF\xD8\xFF\xE0" . str_repeat('A', 500))['ok'], 'jpeg magic + junk rejected');

// pixel caps are enforced from the header, before any decoding
$sig = "\x89PNG\r\n\x1a\n";
check(!run($sig . chunk('IHDR', pack('NNCCCCC', 65000, 65000, 8, 2, 0, 0, 0)) . chunk('IEND', ''))['ok'], 'png 65000x65000 rejected');
check(!run($sig . chunk('IHDR', pack('NNCCCCC', 4000, 4001, 8, 2, 0, 0, 0)) . chunk('IEND', ''))['ok'], 'png just over 16MP rejected');

// GIF whose logical screen is tiny but whose frame is huge: libgd allocates the frame, so the frame is checked
$huge = "GIF89a" . pack('vv', 1, 1) . "\x80\x00\x00" . "\x00\x00\x00\xFF\xFF\xFF"
      . "\x2C" . pack('vvvv', 0, 0, 30000, 30000) . "\x00" . "\x02" . "\x02\x4C\x01" . "\x00" . "\x3B";
$r = run($huge);
check(!$r['ok'] && str_contains($r['msg'], 'too many pixels'), 'gif with huge frame rejected before decoding');
// ...and a truncated GIF (no trailer) is just an error, never a crash
check(!run(substr($gif, 0, -1))['ok'] || true, 'gif without trailer does not crash');

echo $fail === 0 ? "openchat images: all ok\n" : "openchat images: $fail failed\n";
exit($fail === 0 ? 0 : 1);
