<?php
declare(strict_types=1);

/** One topic: ask a question, list its questions by votes. */

require_once __DIR__ . '/../../../src/apedia/page.php';

$repo = apedia_repo();
$me = apedia_user();

$topicId = int_param($_GET['id'] ?? null);
$topic = $topicId !== null ? $repo->topic($topicId) : null;
if ($topic === null) {
    apedia_not_found('Topic', $me);
}
$self = topic_url($topicId);

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    csrf_require();
    $user = apedia_require_login();
    $action = $_POST['action'] ?? '';

    if ($action === 'vote') {
        $postId = int_param($_POST['post_id'] ?? null);
        $post = $postId !== null ? $repo->post($postId) : null;
        if ($post === null || $post['type'] !== 'question' || (int) $post['topic_id'] !== $topicId) {
            abort(404, 'No such question in this topic.');
        }
        apedia_throttle('apedia_vote', 60, 600, $self);
        $repo->toggleVote($postId, (int) $user['id']);
        redirect($self . '#p' . $postId);
    }

    if ($action === 'ask') {
        [$text, $err] = apedia_clean_text($_POST['text'] ?? null);
        if ($err !== null) {
            apedia_flash($err);
            redirect($self);
        }
        apedia_throttle('apedia_post', 20, 600, $self);
        $newId = $repo->addQuestion($topicId, (int) $user['id'], $text);
        redirect(question_url($newId));
    }

    abort(400, 'Unknown action.');
}

$questions = $repo->questionsInTopic($topicId, $me ? (int) $me['id'] : null);

apedia_start('APedia', [[$topic['name'], null]], $me);
echo "<h1 class='topic_header'>" . e($topic['name']) . '</h1>';
echo "<p class='num_questions'>" . count($questions) . ' ' . (count($questions) === 1 ? 'Question' : 'Questions') . '</p>';

echo "<div class='questions_container'>";
echo "<div class='topic'>" . post_form($self, 'Ask a question', $me !== null, null, 'ask') . '</div>';

foreach ($questions as $q) {
    $qid = (int) $q['id'];
    $n = (int) $q['answers'];
    echo "<div class='question' id='p" . $qid . "'><div class='question_details'>";
    echo vote_widget($q, $me !== null, $self);
    echo "<p class='answers_count'><span>" . $n . '</span> ' . ($n === 1 ? 'answer' : 'answers') . '</p>'
        . "<p class='text'><a href='" . e(question_url($qid)) . "'>" . e($q['text']) . '</a></p>'
        . "<p class='post_user'><a href='" . e(user_url((int) $q['user_id'])) . "'>" . e($q['username']) . '</a></p>';
    echo '</div></div>';
}
echo '</div>';
if (count($questions) >= ApediaRepo::LIST_LIMIT) {
    echo '<p class="num_questions">Showing the top ' . ApediaRepo::LIST_LIMIT . ' questions.</p>';
}

apedia_end();
