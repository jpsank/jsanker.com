#!/usr/bin/env php
<?php
declare(strict_types=1);

/**
 * One-off import of the 2019 puffyboa.xyz databases into the new site.
 *
 *   php bin/migrate-legacy.php --legacy-dir=/path/with/the/db-files [--uploads=DIR] [--dry-run]
 *
 * --legacy-dir  folder containing openchat.db, openchat2.db and/or apedia.db (read-only; copies are used)
 * --uploads     optional folder of the old OpenChat attachment files, named by their old message id
 *               (openchat2.db ids), e.g. 139 or 139.jpg. They go through the normal image sanitiser.
 * --dry-run     do everything, then roll back and write nothing
 *
 * Rules:
 *   - the destination tables must be empty (to redo an import, delete the SQLite file and rerun)
 *   - text is cleaned by LegacyClean: slurs masked, injected markup removed, control/bidi characters
 *     stripped, over-long posts truncated to the new limits (OpenChat 1000, APedia 5000 characters)
 *   - APedia: ids, dates, password hashes and votes are preserved (people can still log in);
 *     old text was stored HTML-escaped, so it is decoded once; usernames that are invalid or contain
 *     a slur are renamed to user<ID>
 *   - the report lists row ids and reason codes only, never message content
 */

if (PHP_SAPI !== 'cli') {
    exit(1);
}

require_once __DIR__ . '/../src/bootstrap.php';
require_once __DIR__ . '/../src/LegacyClean.php';
require_once __DIR__ . '/../src/openchat/Store.php';
require_once __DIR__ . '/../src/apedia/Repo.php';

$opts = getopt('', ['legacy-dir:', 'uploads:', 'dry-run', 'help']);
if (isset($opts['help']) || !isset($opts['legacy-dir'])) {
    fwrite(STDERR, "Usage: php bin/migrate-legacy.php --legacy-dir=DIR [--uploads=DIR] [--dry-run]\n");
    exit(isset($opts['help']) ? 0 : 2);
}
$legacyDir = rtrim((string) $opts['legacy-dir'], '/');
$uploadsDir = isset($opts['uploads']) ? rtrim((string) $opts['uploads'], '/') : null;
$dryRun = isset($opts['dry-run']);

/** Open a read-only copy of a legacy SQLite file (never touches the original or leaves -wal files). */
function open_legacy(string $path): PDO
{
    $tmp = tempnam(sys_get_temp_dir(), 'legacy');
    if ($tmp === false || !copy($path, $tmp)) {
        throw new RuntimeException("Cannot read $path");
    }
    register_shutdown_function(static fn() => @unlink($tmp));
    return new PDO('sqlite:' . $tmp, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
}

function note(array &$report, string $key, int|string $id, array $why): void
{
    foreach ($why as $w) {
        $report[$key][$w][] = $id;
    }
}

function print_report(string $title, array $counts, array $reasons): void
{
    echo "\n== $title\n";
    foreach ($counts as $k => $v) {
        printf("  %-34s %d\n", $k, $v);
    }
    foreach ($reasons as $code => $ids) {
        $shown = implode(', ', array_slice($ids, 0, 25)) . (count($ids) > 25 ? ', ...' : '');
        printf("  %-34s %d  (ids: %s)\n", "changed: $code", count($ids), $shown);
    }
}

// =========================================================================== OpenChat ===

function migrate_openchat(string $legacyDir, ?string $uploadsDir, bool $dryRun): void
{
    $sources = ['openchat.db' => 1, 'openchat2.db' => 2];
    $rows = [];
    $seen = [];
    $counts = ['legacy rows read' => 0, 'duplicates skipped' => 0, 'skipped (empty after cleaning)' => 0];
    $reasons = [];

    foreach ($sources as $file => $src) {
        $path = "$legacyDir/$file";
        if (!is_file($path)) {
            echo "  (no $file, skipping)\n";
            continue;
        }
        $old = open_legacy($path);
        foreach ($old->query('SELECT id, message, post_date, has_attachment FROM Messages ORDER BY id') as $r) {
            $counts['legacy rows read']++;
            $date = is_string($r['post_date']) && ($t = strtotime($r['post_date'] . ' UTC')) !== false
                ? gmdate('Y-m-d H:i:s', $t) : '2019-01-01 00:00:00';
            $key = sha1((string) $r['message'] . "\0" . $date);
            if (isset($seen[$key])) {
                $counts['duplicates skipped']++;
                continue;
            }
            $seen[$key] = true;
            $rows[] = ['src' => $src, 'old' => (int) $r['id'], 'text' => (string) $r['message'],
                       'date' => $date, 'att' => (int) $r['has_attachment'] === 1];
        }
    }
    usort($rows, static fn($a, $b) => [$a['date'], $a['src'], $a['old']] <=> [$b['date'], $b['src'], $b['old']]);

    $pdo = OpenChat::db();
    if ((int) $pdo->query('SELECT COUNT(*) FROM messages')->fetchColumn() > 0) {
        throw new RuntimeException('OpenChat already has messages. Delete db/openchat.sqlite in the data directory to re-import.');
    }

    $counts['imported'] = 0;
    $counts['attachment flagged'] = 0;
    $counts['attachment image restored'] = 0;
    $counts['attachment image not found (text kept)'] = 0;
    $counts['attachment image rejected'] = 0;

    $ins = $pdo->prepare('INSERT INTO messages (message, post_date, has_attachment) VALUES (:m, :d, 0)');
    $pdo->beginTransaction();
    $pending = []; // new id => old id, for attachment import after the text is committed
    foreach ($rows as $r) {
        [$text, $why] = LegacyClean::text($r['text'], OpenChat::MAX_LENGTH, false, false);
        $label = "{$r['src']}:{$r['old']}";
        note($reasons, 'x', $label, []);
        foreach ($why as $w) {
            $reasons[$w][] = $label;
        }
        if ($text === null) {
            $counts['skipped (empty after cleaning)']++;
            continue;
        }
        $ins->execute([':m' => $text, ':d' => $r['date']]);
        $counts['imported']++;
        if ($r['att']) {
            $counts['attachment flagged']++;
            $pending[(int) $pdo->lastInsertId()] = $r['old'];
        }
    }
    unset($reasons['x']);
    if ($dryRun) {
        $pdo->rollBack();
    } else {
        $pdo->commit();
    }

    foreach ($pending as $newId => $oldId) {
        $file = null;
        if ($uploadsDir !== null) {
            foreach ([$uploadsDir . "/$oldId", ...(glob($uploadsDir . "/$oldId.*") ?: [])] as $cand) {
                if (is_file($cand)) {
                    $file = $cand;
                    break;
                }
            }
        }
        if ($file === null) {
            $counts['attachment image not found (text kept)']++;
        } elseif ($dryRun) {
            $counts['attachment image restored']++;
        } else {
            try {
                OpenChat::importImage($newId, $file);
                $counts['attachment image restored']++;
            } catch (OpenChatImageException $e) {
                $counts['attachment image rejected']++;
            }
        }
    }
    print_report('OpenChat (ids shown as <source db>:<old id>)', $counts, $reasons);
}

// ============================================================================= APedia ===

function migrate_apedia(string $legacyDir, bool $dryRun): void
{
    $path = "$legacyDir/apedia.db";
    if (!is_file($path)) {
        echo "  (no apedia.db, skipping)\n";
        return;
    }
    $old = open_legacy($path);
    $pdo = db('apedia');
    new ApediaRepo($pdo); // creates the schema and seeds the topics

    if ((int) $pdo->query('SELECT COUNT(*) FROM users')->fetchColumn() > 0
        || (int) $pdo->query('SELECT COUNT(*) FROM posts')->fetchColumn() > 0) {
        throw new RuntimeException('APedia already has users or posts. Delete db/apedia.sqlite in the data directory to re-import.');
    }

    $counts = [];
    $reasons = [];
    $pdo->exec('BEGIN IMMEDIATE');

    // ---- topics: map old id -> new id by name
    $topicByName = [];
    foreach ($pdo->query('SELECT id, name FROM topics') as $t) {
        $topicByName[strtolower($t['name'])] = (int) $t['id'];
    }
    $topicMap = [];
    foreach ($old->query('SELECT id, name FROM Topics') as $t) {
        $k = strtolower((string) $t['name']);
        if (!isset($topicByName[$k])) {
            $pdo->prepare('INSERT INTO topics (name) VALUES (?)')->execute([(string) $t['name']]);
            $topicByName[$k] = (int) $pdo->lastInsertId();
            $counts['topics added'] = ($counts['topics added'] ?? 0) + 1;
        }
        $topicMap[(int) $t['id']] = $topicByName[$k];
    }

    // ---- users (ids, dates and password hashes preserved)
    $taken = [];
    $users = [];
    $insU = $pdo->prepare('INSERT INTO users (id, created_at, username, password_hash) VALUES (?, ?, ?, ?)');
    foreach ($old->query('SELECT id, created_at, username, password FROM Users ORDER BY id') as $u) {
        $id = (int) $u['id'];
        $name = html_entity_decode((string) $u['username'], ENT_QUOTES | ENT_HTML5, 'UTF-8'); // old code escaped usernames
        [$clean, $why] = LegacyClean::username($name, $id, $taken);
        foreach ($why as $w) {
            $reasons[$w][] = $id;
        }
        $hash = (string) $u['password'];
        if (password_get_info($hash)['algo'] === null) {
            $hash = '!';                       // not a recognised hash: account stays but cannot log in
            $reasons['password-hash-invalid'][] = $id;
        }
        $insU->execute([$id, (string) $u['created_at'], $clean, $hash]);
        $users[$id] = true;
    }
    $counts['users imported'] = count($users);

    // ---- posts: questions, then answers, then comments (parents before children)
    $oldPosts = [];
    foreach ($old->query('SELECT id, created_at, type, text, parent, post_user FROM Posts ORDER BY id') as $p) {
        $oldPosts[(int) $p['id']] = $p;
    }
    $kept = [];     // id => ['type', 'question_id', 'depth']
    $counts['posts read'] = count($oldPosts);
    $counts['posts imported'] = 0;
    $counts['posts skipped (orphan / bad user / empty)'] = 0;
    $counts['comments flattened (nesting > ' . ApediaRepo::MAX_DEPTH . ')'] = 0;

    $insP = $pdo->prepare('INSERT INTO posts (id, created_at, type, text, user_id, topic_id, parent_id, question_id, depth)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    foreach (['question', 'answer', 'comment'] as $type) {
        // comments can nest, so repeat until no more can be placed
        do {
            $placed = 0;
            foreach ($oldPosts as $id => $p) {
                if ($p['type'] !== $type || isset($kept[$id]) || ($p['_done'] ?? false)) {
                    continue;
                }
                $uid = (int) $p['post_user'];
                $parent = (int) $p['parent'];
                if (!isset($users[$uid])) {
                    $oldPosts[$id]['_done'] = true;
                    $counts['posts skipped (orphan / bad user / empty)']++;
                    $reasons['skipped-bad-user'][] = $id;
                    continue;
                }
                $topic = $parentId = $questionId = null;
                $depth = 0;
                if ($type === 'question') {
                    $topic = $topicMap[$parent] ?? null;
                } elseif (!isset($kept[$parent])) {
                    continue; // parent not placed yet (or missing): retry; leftovers are counted below
                } elseif ($type === 'answer') {
                    if ($kept[$parent]['type'] !== 'question') {
                        $oldPosts[$id]['_done'] = true;
                        $counts['posts skipped (orphan / bad user / empty)']++;
                        $reasons['skipped-bad-parent'][] = $id;
                        continue;
                    }
                    $parentId = $parent;
                    $questionId = $parent;
                } else {
                    if ($kept[$parent]['type'] === 'question') {
                        $oldPosts[$id]['_done'] = true;
                        $counts['posts skipped (orphan / bad user / empty)']++;
                        $reasons['skipped-bad-parent'][] = $id;
                        continue;
                    }
                    $questionId = $kept[$parent]['question_id'];
                    $depth = $kept[$parent]['depth'] + 1;
                    $parentId = $parent;
                    // deeper than allowed: attach to the ancestor at the maximum depth instead
                    while ($depth > ApediaRepo::MAX_DEPTH) {
                        $parentId = (int) $pdo->query('SELECT parent_id FROM posts WHERE id = ' . (int) $parentId)->fetchColumn();
                        $depth--;
                        $reasons['comment-flattened'][] = $id;
                        $counts['comments flattened (nesting > ' . ApediaRepo::MAX_DEPTH . ')']++;
                    }
                }
                if ($type === 'question' && $topic === null) {
                    $oldPosts[$id]['_done'] = true;
                    $counts['posts skipped (orphan / bad user / empty)']++;
                    $reasons['skipped-bad-topic'][] = $id;
                    continue;
                }

                // old APedia stored htmlspecialchars()-escaped text; decode once, then clean
                [$text, $why] = LegacyClean::text((string) $p['text'], ApediaRepo::TEXT_MAX, true, true);
                foreach ($why as $w) {
                    $reasons[$w][] = $id;
                }
                if ($text === null) {
                    $oldPosts[$id]['_done'] = true;
                    $counts['posts skipped (orphan / bad user / empty)']++;
                    continue;
                }
                $insP->execute([$id, (string) $p['created_at'], $type, $text, $uid, $topic, $parentId, $questionId, $depth]);
                $kept[$id] = ['type' => $type, 'question_id' => $type === 'question' ? $id : $questionId, 'depth' => $depth];
                $counts['posts imported']++;
                $placed++;
            }
        } while ($placed > 0 && $type === 'comment');
    }
    foreach ($oldPosts as $id => $p) {
        if (!isset($kept[$id]) && !($p['_done'] ?? false)) {
            $counts['posts skipped (orphan / bad user / empty)']++;
            $reasons['skipped-orphan'][] = $id;
        }
    }

    // ---- votes (valid, unique)
    $insV = $pdo->prepare('INSERT OR IGNORE INTO votes (created_at, post_id, user_id) VALUES (?, ?, ?)');
    $counts['votes imported'] = 0;
    $counts['votes dropped (dangling / duplicate)'] = 0;
    foreach ($old->query('SELECT created_at, post_id, user_id FROM Votes ORDER BY id') as $v) {
        if (isset($kept[(int) $v['post_id']], $users[(int) $v['user_id']])) {
            $insV->execute([(string) $v['created_at'], (int) $v['post_id'], (int) $v['user_id']]);
            $counts['votes imported'] += $insV->rowCount();
            $counts['votes dropped (dangling / duplicate)'] += 1 - $insV->rowCount();
        } else {
            $counts['votes dropped (dangling / duplicate)']++;
        }
    }

    if ($dryRun) {
        $pdo->exec('ROLLBACK');
    } else {
        $pdo->exec('COMMIT');
    }
    print_report('APedia (ids are the original post / user ids)', $counts, $reasons);
}

// ================================================================================ main ===

try {
    echo $dryRun ? "DRY RUN: nothing will be written.\n" : "Importing into " . data_dir() . "\n";
    migrate_openchat($legacyDir, $uploadsDir, $dryRun);
    migrate_apedia($legacyDir, $dryRun);
    echo "\nDone." . ($dryRun ? " (dry run, rolled back)" : '') . "\n";
} catch (Throwable $t) {
    fwrite(STDERR, "\nMigration failed, nothing was committed: " . $t->getMessage() . "\n");
    exit(1);
}
