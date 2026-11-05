<?php
declare(strict_types=1);

/** One question with its answers and threaded comments. */

require_once __DIR__ . '/../../../src/apedia/page.php';

$repo = apedia_repo();
$me = apedia_user();

$qid = int_param($_GET['id'] ?? null);
$thread = $qid !== null ? $repo->thread($qid, $me ? (int) $me['id'] : null) : null;
if ($thread === null) {
    apedia_not_found('Question', $me);
}
$question = $thread['question'];
$self = question_url($qid);

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    csrf_require();
    $user = apedia_require_login();
    $action = $_POST['action'] ?? '';

    if ($action === 'vote') {
        $postId = int_param($_POST['post_id'] ?? null);
        $post = $postId !== null ? $repo->post($postId) : null;
        // The target must exist and live on this very question page.
        if ($post === null || ((int) $post['id'] !== $qid && (int) $post['question_id'] !== $qid)) {
            abort(404, 'No such post on this question.');
        }
        apedia_throttle('apedia_vote', 60, 600, $self);
        $repo->toggleVote($postId, (int) $user['id']);
        redirect($self . '#p' . $postId);
    }

    if ($action === 'reply') {
        $parentId = int_param($_POST['parent_id'] ?? null);
        if ($parentId === null) {
            abort(400, 'Missing parent post.');
        }
        [$text, $err] = apedia_clean_text($_POST['text'] ?? null);
        if ($err !== null) {
            apedia_flash($err);
            redirect($self . '#p' . $parentId);
        }
        apedia_throttle('apedia_post', 20, 600, $self);
        try {
            $newId = $repo->addReply($qid, $parentId, (int) $user['id'], $text);
        } catch (ApediaInputError $ex) {
            apedia_flash($ex->getMessage());
            redirect($self);
        }
        redirect($self . '#p' . $newId);
    }

    abort(400, 'Unknown action.');
}

$topic = $repo->topic((int) $question['topic_id']);
$children = $thread['children'];
$loggedIn = $me !== null;

/** One answer/comment box: vote container, author, text, reply form. */
function render_post(array $c, string $self, bool $loggedIn): void
{
    $id = (int) $c['id'];
    $isAnswer = $c['type'] === 'answer';
    echo "<div class='post " . e($c['type']) . "' id='p" . $id . "'>";
    echo vote_widget($c, $loggedIn, $self);
    echo "<p class='post_user'><a href='" . e(user_url((int) $c['user_id'])) . "'>" . e($c['username']) . '</a></p>'
        . "<p class='text'>" . render_text((string) $c['text']) . '</p>';
    if ((int) $c['depth'] < ApediaRepo::MAX_DEPTH) {
        echo post_form($self, $isAnswer ? 'Comment' : 'Reply', $loggedIn, $id, 'reply');
    }
    echo '</div>';
}

/** Render a post followed by the nested list of its replies. Depth-capped so it can never run away. */
function render_thread(array $c, array $children, int $depth, string $self, bool $loggedIn): void
{
    render_post($c, $self, $loggedIn);
    $kids = $children[(int) $c['id']] ?? [];
    if ($kids && $depth <= ApediaRepo::MAX_DEPTH + 1) {
        echo '<ul>';
        foreach ($kids as $k) {
            render_thread($k, $children, $depth + 1, $self, $loggedIn);
        }
        echo '</ul>';
    }
}

$trail = [];
if ($topic !== null) {
    $trail[] = [$topic['name'], topic_url((int) $topic['id'])];
}
$trail[] = [snippet((string) $question['text']), null];

apedia_start('APedia', $trail, $me);

$lines = explode("\n", str_replace("\r", '', (string) $question['text']), 2);
echo "<div class='question_header'>";
if ($topic !== null) {
    echo "<p><a href='" . e(topic_url((int) $topic['id'])) . "'>" . e($topic['name']) . '</a></p>';
}
echo "<div class='question_title' id='p" . $qid . "'>";
echo '<h1>' . str_replace('  ', ' &nbsp;', e($lines[0])) . vote_widget($question, $loggedIn, $self) . '</h1>';
if (isset($lines[1])) {
    echo '<p>' . render_text($lines[1]) . '</p>';
}
echo '</div></div>';

$answers = $children[$qid] ?? [];
echo "<p class='num_answers'>" . count($answers) . ' ' . (count($answers) === 1 ? 'Answer' : 'Answers') . '</p>';
echo post_form($self, 'Add an answer', $loggedIn, $qid, 'reply');

echo "<div class='answers_container'>";
foreach ($answers as $a) {
    render_thread($a, $children, 0, $self, $loggedIn);
}
echo '</div>';

apedia_end();
