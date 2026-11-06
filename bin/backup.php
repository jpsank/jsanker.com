#!/usr/bin/env php
<?php
declare(strict_types=1);

/**
 * Consistent online backup of the site's data, safe to run while the site is serving requests.
 *
 *   php bin/backup.php --out=/some/new/dir
 *
 * Writes into --out (created, must not already contain files):
 *   <name>.sqlite          one copy of each database in the data dir (made with VACUUM INTO, so it is a
 *                          consistent snapshot even though the live file is in WAL mode)
 *   openchat-uploads/      the OpenChat image files, if any
 *   MANIFEST.txt           what was written (sizes and integrity-check results only, no content)
 *
 * scripts/backup.sh wraps this for the production server; scripts/restore.sh puts a backup back.
 */

if (PHP_SAPI !== 'cli') {
    exit(1);
}

require_once __DIR__ . '/../src/bootstrap.php';

$opts = getopt('', ['out:', 'help']);
if (isset($opts['help']) || !isset($opts['out'])) {
    fwrite(STDERR, "Usage: php bin/backup.php --out=DIR\n");
    exit(isset($opts['help']) ? 0 : 2);
}

$out = rtrim((string) $opts['out'], '/');
if (is_dir($out) && count(scandir($out) ?: []) > 2) {
    fwrite(STDERR, "Refusing to write into a non-empty directory: $out\n");
    exit(1);
}
if (!is_dir($out) && !mkdir($out, 0700, true)) {
    fwrite(STDERR, "Cannot create $out\n");
    exit(1);
}

$manifest = ['backup of jsanker.com data, ' . gmdate('Y-m-d H:i:s') . ' UTC'];
$failed = false;

// ---- databases
foreach (glob(data_dir('db') . '/*.sqlite') ?: [] as $file) {
    $name = basename($file, '.sqlite');
    if (!preg_match('/^[a-z0-9_]+$/', $name)) {
        continue;
    }
    $dest = "$out/$name.sqlite";
    try {
        $pdo = db($name);
        $pdo->exec('VACUUM INTO ' . $pdo->quote($dest));

        $copy = new PDO('sqlite:' . $dest);
        $copy->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $check = (string) $copy->query('PRAGMA integrity_check')->fetchColumn();
        $tables = (int) $copy->query("SELECT count(*) FROM sqlite_master WHERE type = 'table'")->fetchColumn();
        $manifest[] = sprintf('%s.sqlite  %d bytes  %d tables  integrity_check=%s', $name, filesize($dest), $tables, $check);
        if ($check !== 'ok') {
            $failed = true;
        }
    } catch (Throwable $e) {
        $manifest[] = "$name.sqlite  FAILED (" . get_class($e) . ')';
        $failed = true;
    }
}

// ---- OpenChat uploads
$uploads = data_dir('openchat/uploads');
$count = 0;
$bytes = 0;
foreach (scandir($uploads) ?: [] as $f) {
    $src = "$uploads/$f";
    if ($f === '.' || $f === '..' || !is_file($src)) {
        continue;
    }
    if (!is_dir("$out/openchat-uploads") && !mkdir("$out/openchat-uploads", 0700)) {
        $failed = true;
        break;
    }
    if (copy($src, "$out/openchat-uploads/$f")) {
        $count++;
        $bytes += (int) filesize($src);
    } else {
        $failed = true;
    }
}
$manifest[] = "openchat-uploads  $count files  $bytes bytes";

file_put_contents("$out/MANIFEST.txt", implode("\n", $manifest) . "\n");
echo implode("\n", $manifest), "\n";
exit($failed ? 1 : 0);
