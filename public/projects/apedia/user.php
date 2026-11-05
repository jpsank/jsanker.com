<?php
declare(strict_types=1);

/** Public profile: join date, score, and every post with its ancestry. */

require_once __DIR__ . '/../../../src/apedia/page.php';

$repo = apedia_repo();
$me = apedia_user();

$uid = int_param($_GET['id'] ?? null);
$user = $uid !== null ? $repo->userById($uid) : null;
if ($user === null) {
    apedia_not_found('User', $me);
}

$score = $repo->userScore($uid);
$chains = $repo->userPostChains($uid);

apedia_start('APedia', [[$user['username'], null]], $me);
echo '<h1>' . e($user['username']) . '</h1>';
echo '<p>Joined ' . e($user['created_at']) . '</p>';
echo '<p>User score: ' . $score . '</p>';
echo "<h3 class='num_posts'>" . count($chains) . ' ' . (count($chains) === 1 ? 'Post' : 'Posts') . '</h3>';

echo "<div class='posts_container'>";
foreach (array_reverse($chains) as $chain) {   // oldest first, like the original
    $last = count($chain) - 1;
    $html = '';
    foreach ($chain as $i => $node) {
        $label = $node['kind'] === 'topic' ? $node['text'] : snippet($node['text']);
        $href = match ($node['kind']) {
            'topic'    => topic_url($node['id']),
            'question' => question_url($node['id']),
            default    => question_url($node['question_id'], $node['id']),
        };
        $html .= "<a class='" . e($node['kind']) . ($i === $last ? ' final' : '') . "' href='" . e($href) . "'>" . e($label) . '</a>';
    }
    echo "<div class='user_post " . e($chain[$last]['kind']) . "'>" . $html . '</div>';
}
echo '</div>';
if (count($chains) >= ApediaRepo::PROFILE_LIMIT) {
    echo '<p class="num_posts">Showing the ' . ApediaRepo::PROFILE_LIMIT . ' most recent posts.</p>';
}

apedia_end();
