<?php
declare(strict_types=1);

/** APedia home: topic list with question counts, or search results. */

require_once __DIR__ . '/../../../src/apedia/page.php';

$repo = apedia_repo();
$me = apedia_user();

$query = '';
$searching = false;
$error = null;
if (isset($_GET['search'])) {
    $raw = is_string($_GET['search']) ? trim($_GET['search']) : '';
    if (mb_check_encoding($raw, 'UTF-8') && mb_strlen($raw) <= 100) {
        $query = str_replace("\0", '', $raw);
    } else {
        $error = 'Search is limited to 100 characters.';
        $raw = '';
    }
    $searching = $query !== '';
}

apedia_start('APedia', [], $me, $query, 'home');

if ($error !== null) {
    echo '<p class="err_message">' . e($error) . '</p>';
}

if ($searching) {
    $topics = $repo->searchTopics($query);
    $questions = $repo->searchQuestions($query);
    echo "<div class='search_results'>";
    if (!$topics && !$questions) {
        echo '<p>No results found.</p>';
    }
    foreach ($topics as $t) {
        echo "<div class='result'><a class='topic' href='" . e(topic_url((int) $t['id'])) . "'>" . e($t['name']) . '</a></div>';
    }
    foreach ($questions as $q) {
        echo "<div class='result'><a class='topic' href='" . e(topic_url((int) $q['topic_id'])) . "'>" . e($q['topic_name']) . '</a>'
            . "<a class='question' href='" . e(question_url((int) $q['id'])) . "'>" . e(snippet((string) $q['text'])) . '</a></div>';
    }
    echo '</div>';
} else {
    echo "<div class='topics_container'>";
    foreach ($repo->topics() as $t) {
        $n = (int) $t['n'];
        echo "<div class='" . ($n > 0 ? 'active' : 'inactive') . "'><a href='" . e(topic_url((int) $t['id'])) . "'>" . e($t['name'])
            . ($n > 0 ? ' (' . $n . ')' : '') . '</a></div>';
    }
    echo '</div>';
}

apedia_end();
