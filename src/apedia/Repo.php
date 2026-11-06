<?php
declare(strict_types=1);

require_once __DIR__ . '/../Censor.php';

/** Thrown for user-correctable problems (bad parent, too deep...). Message is safe to show. */
final class ApediaInputError extends RuntimeException
{
}

/**
 * All APedia SQL lives here. Every statement is prepared with bound parameters;
 * nothing from a request is ever concatenated into SQL.
 *
 * posts.type is question | answer | comment.
 *   question: topic_id set; parent_id, question_id NULL
 *   answer:   parent_id = question_id = the question; depth 0
 *   comment:  parent_id = answer or comment; question_id = root question; depth = parent depth + 1
 */
final class ApediaRepo
{
    public const TEXT_MAX = 5000;
    public const MAX_DEPTH = 8;      // deepest allowed comment nesting (answer = 0)
    public const LIST_LIMIT = 500;
    public const THREAD_LIMIT = 1500;
    public const SEARCH_LIMIT = 100;
    public const PROFILE_LIMIT = 100;

    private const TOPICS = [
        'Art History', 'Biology', 'Calculus', 'Chemistry', 'Chinese',
        'Comparative Government & Politics', 'Computer Science', 'English', 'Environmental Science',
        'European History', 'French', 'German', 'Human Geography', 'Italian', 'Japanese',
        'Latin', 'Macroeconomics', 'Microeconomics', 'Music Theory', 'Physics', 'Psychology',
        'Research', 'Seminar', 'Spanish', 'Statistics', 'Studio Art',
        'U.S. Government & Politics', 'U.S. History', 'World History',
    ];

    public function __construct(private PDO $pdo)
    {
        $this->migrate();
    }

    private function migrate(): void
    {
        if ((int) $this->pdo->query('PRAGMA user_version')->fetchColumn() >= 1) {
            return;
        }
        $this->pdo->exec('BEGIN IMMEDIATE');
        try {
            $this->pdo->exec('
                CREATE TABLE IF NOT EXISTS topics (
                    id   INTEGER PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE
                );
                CREATE TABLE IF NOT EXISTS users (
                    id            INTEGER PRIMARY KEY,
                    created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    username      TEXT NOT NULL COLLATE NOCASE UNIQUE
                                  CHECK (length(username) BETWEEN 3 AND 30),
                    password_hash TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS posts (
                    id          INTEGER PRIMARY KEY,
                    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    type        TEXT NOT NULL CHECK (type IN (\'question\', \'answer\', \'comment\')),
                    text        TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND ' . self::TEXT_MAX . '),
                    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    topic_id    INTEGER REFERENCES topics(id) ON DELETE CASCADE,
                    parent_id   INTEGER REFERENCES posts(id) ON DELETE CASCADE,
                    question_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
                    depth       INTEGER NOT NULL DEFAULT 0,
                    CHECK (
                        (type = \'question\' AND topic_id IS NOT NULL AND parent_id IS NULL AND question_id IS NULL)
                        OR (type IN (\'answer\', \'comment\') AND topic_id IS NULL
                            AND parent_id IS NOT NULL AND question_id IS NOT NULL)
                    )
                );
                CREATE INDEX IF NOT EXISTS posts_topic    ON posts (topic_id, type);
                CREATE INDEX IF NOT EXISTS posts_question ON posts (question_id);
                CREATE INDEX IF NOT EXISTS posts_user     ON posts (user_id);
                CREATE TABLE IF NOT EXISTS votes (
                    id         INTEGER PRIMARY KEY,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
                    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    UNIQUE (post_id, user_id)
                );
                CREATE INDEX IF NOT EXISTS votes_user ON votes (user_id);
            ');
            $ins = $this->pdo->prepare('INSERT OR IGNORE INTO topics (name) VALUES (?)');
            foreach (self::TOPICS as $name) {
                $ins->execute([$name]);
            }
            $this->pdo->exec('PRAGMA user_version = 1');
            $this->pdo->exec('COMMIT');
        } catch (Throwable $t) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->exec('ROLLBACK');
            }
            throw $t;
        }
    }

    // ------------------------------------------------------------- users ---

    public function userById(int $id): ?array
    {
        $st = $this->pdo->prepare('SELECT id, username, created_at FROM users WHERE id = ?');
        $st->execute([$id]);
        return $st->fetch() ?: null;
    }

    public function userAuthByName(string $username): ?array
    {
        $st = $this->pdo->prepare('SELECT id, username, password_hash FROM users WHERE username = ? COLLATE NOCASE');
        $st->execute([$username]);
        return $st->fetch() ?: null;
    }

    /** Returns the new id, or null if the username is taken (case-insensitively). */
    public function createUser(string $username, string $hash): ?int
    {
        try {
            $st = $this->pdo->prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
            $st->execute([$username, $hash]);
            return (int) $this->pdo->lastInsertId();
        } catch (PDOException $e) {
            if (str_contains($e->getMessage(), 'UNIQUE')) {
                return null;
            }
            throw $e;
        }
    }

    public function updatePasswordHash(int $id, string $hash): void
    {
        $this->pdo->prepare('UPDATE users SET password_hash = ? WHERE id = ?')->execute([$hash, $id]);
    }

    public function userScore(int $id): int
    {
        $st = $this->pdo->prepare('SELECT COUNT(*) FROM votes v JOIN posts p ON p.id = v.post_id WHERE p.user_id = ?');
        $st->execute([$id]);
        return (int) $st->fetchColumn();
    }

    /**
     * The user's most recent posts, each with its ancestry (topic, question, answer, comments...)
     * fetched in a single recursive query. Returns a list of chains; each chain is a list of
     * ['kind' => topic|question|answer|comment, 'id', 'question_id', 'text'] from root to the post.
     */
    public function userPostChains(int $userId): array
    {
        $st = $this->pdo->prepare('
            WITH RECURSIVE chain (root, depth, id, type, parent_id, question_id, topic_id, text) AS (
                SELECT p.id, 0, p.id, p.type, p.parent_id, p.question_id, p.topic_id, substr(p.text, 1, 200)
                FROM (SELECT * FROM posts WHERE user_id = :uid ORDER BY id DESC LIMIT :lim) p
                UNION ALL
                SELECT c.root, c.depth + 1, a.id, a.type, a.parent_id, a.question_id, a.topic_id, substr(a.text, 1, 200)
                FROM chain c JOIN posts a ON a.id = c.parent_id
                WHERE c.depth < 20
            )
            SELECT c.root, c.id, c.type, c.question_id, c.topic_id, c.text, t.name AS topic_name
            FROM chain c LEFT JOIN topics t ON t.id = c.topic_id
            ORDER BY c.root DESC, c.depth DESC
        ');
        $st->bindValue(':uid', $userId, PDO::PARAM_INT);
        $st->bindValue(':lim', self::PROFILE_LIMIT, PDO::PARAM_INT);
        $st->execute();

        $chains = [];
        foreach ($st as $r) {
            $root = (int) $r['root'];
            if ($r['type'] === 'question') {
                $chains[$root][] = ['kind' => 'topic', 'id' => (int) $r['topic_id'], 'question_id' => 0, 'text' => (string) $r['topic_name']];
                $qid = (int) $r['id'];
            } else {
                $qid = (int) $r['question_id'];
            }
            $chains[$root][] = ['kind' => $r['type'], 'id' => (int) $r['id'], 'question_id' => $qid, 'text' => (string) $r['text']];
        }
        return array_values($chains);
    }

    // ------------------------------------------------------------ topics ---

    public function topics(): array
    {
        return $this->pdo->query('
            SELECT t.id, t.name, COUNT(q.id) AS n
            FROM topics t LEFT JOIN posts q ON q.topic_id = t.id AND q.type = \'question\'
            GROUP BY t.id ORDER BY t.name
        ')->fetchAll();
    }

    public function topic(int $id): ?array
    {
        $st = $this->pdo->prepare('SELECT id, name FROM topics WHERE id = ?');
        $st->execute([$id]);
        return $st->fetch() ?: null;
    }

    /** Questions in a topic with vote count, my-vote flag and answer count; most voted first. */
    public function questionsInTopic(int $topicId, ?int $me): array
    {
        $st = $this->pdo->prepare('
            SELECT q.id, q.text, q.created_at, q.user_id, u.username,
                   COALESCE(v.n, 0) AS votes, COALESCE(v.mine, 0) AS mine, COALESCE(a.n, 0) AS answers
            FROM posts q
            JOIN users u ON u.id = q.user_id
            LEFT JOIN (SELECT post_id, COUNT(*) AS n, SUM(user_id = :me) AS mine FROM votes GROUP BY post_id) v ON v.post_id = q.id
            LEFT JOIN (SELECT question_id, COUNT(*) AS n FROM posts WHERE type = \'answer\' GROUP BY question_id) a ON a.question_id = q.id
            WHERE q.type = \'question\' AND q.topic_id = :tid
            ORDER BY votes DESC, q.id DESC
            LIMIT :lim
        ');
        $st->bindValue(':me', $me ?? 0, PDO::PARAM_INT);
        $st->bindValue(':tid', $topicId, PDO::PARAM_INT);
        $st->bindValue(':lim', self::LIST_LIMIT, PDO::PARAM_INT);
        $st->execute();
        return $st->fetchAll();
    }

    // ------------------------------------------------------------- posts ---

    public function post(int $id): ?array
    {
        $st = $this->pdo->prepare('SELECT id, type, topic_id, parent_id, question_id, depth FROM posts WHERE id = ?');
        $st->execute([$id]);
        return $st->fetch() ?: null;
    }

    /**
     * Question plus all its answers and comments, with authors and vote counts, in one query.
     * Sorted by votes (then oldest first). Returns null if $questionId is not a question.
     * Result: ['question' => row, 'children' => [parent_id => [rows]]]
     */
    public function thread(int $questionId, ?int $me): ?array
    {
        $st = $this->pdo->prepare('
            SELECT p.id, p.type, p.text, p.parent_id, p.topic_id, p.depth, p.created_at, p.user_id, u.username,
                   COUNT(v.id) AS votes, COALESCE(SUM(v.user_id = :me), 0) AS mine
            FROM posts p
            JOIN users u ON u.id = p.user_id
            LEFT JOIN votes v ON v.post_id = p.id
            WHERE p.id = :q OR p.question_id = :q
            GROUP BY p.id
            ORDER BY votes DESC, p.id ASC
            LIMIT :lim
        ');
        $st->bindValue(':me', $me ?? 0, PDO::PARAM_INT);
        $st->bindValue(':q', $questionId, PDO::PARAM_INT);
        $st->bindValue(':lim', self::THREAD_LIMIT, PDO::PARAM_INT);
        $st->execute();

        $question = null;
        $children = [];
        foreach ($st as $r) {
            if ((int) $r['id'] === $questionId) {
                if ($r['type'] !== 'question') {
                    return null;
                }
                $question = $r;
            } else {
                $children[(int) $r['parent_id']][] = $r;
            }
        }
        return $question === null ? null : ['question' => $question, 'children' => $children];
    }

    public function addQuestion(int $topicId, int $userId, string $text): int
    {
        if ($this->topic($topicId) === null) {
            throw new ApediaInputError('That topic does not exist.');
        }
        $st = $this->pdo->prepare('INSERT INTO posts (type, text, user_id, topic_id) VALUES (\'question\', ?, ?, ?)');
        $st->execute([Censor::clean($text), $userId, $topicId]);
        return (int) $this->pdo->lastInsertId();
    }

    /**
     * Add an answer (parent is the question) or a comment (parent is an answer/comment).
     * The parent must exist and belong to $questionId; comment nesting is capped.
     */
    public function addReply(int $questionId, int $parentId, int $userId, string $text): int
    {
        $this->pdo->exec('BEGIN IMMEDIATE');
        try {
            $parent = $this->post($parentId);
            if ($parent === null) {
                throw new ApediaInputError('The post you were replying to no longer exists.');
            }
            if ($parent['type'] === 'question') {
                if ((int) $parent['id'] !== $questionId) {
                    throw new ApediaInputError('That reply does not belong to this question.');
                }
                $type = 'answer';
                $depth = 0;
            } else {
                if ((int) $parent['question_id'] !== $questionId) {
                    throw new ApediaInputError('That reply does not belong to this question.');
                }
                $type = 'comment';
                $depth = (int) $parent['depth'] + 1;
                if ($depth > self::MAX_DEPTH) {
                    throw new ApediaInputError('This thread is nested too deeply to reply to.');
                }
            }
            $st = $this->pdo->prepare(
                'INSERT INTO posts (type, text, user_id, parent_id, question_id, depth) VALUES (?, ?, ?, ?, ?, ?)'
            );
            $st->execute([$type, Censor::clean($text), $userId, $parentId, $questionId, $depth]);
            $id = (int) $this->pdo->lastInsertId();
            $this->pdo->exec('COMMIT');
            return $id;
        } catch (Throwable $t) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->exec('ROLLBACK');
            }
            throw $t;
        }
    }

    /** Toggle the user's vote on an existing post. Returns true if now voted, false if removed. */
    public function toggleVote(int $postId, int $userId): bool
    {
        $this->pdo->exec('BEGIN IMMEDIATE');
        try {
            if ($this->post($postId) === null) {
                throw new ApediaInputError('That post does not exist.');
            }
            $del = $this->pdo->prepare('DELETE FROM votes WHERE post_id = ? AND user_id = ?');
            $del->execute([$postId, $userId]);
            $voted = $del->rowCount() === 0;
            if ($voted) {
                $this->pdo->prepare('INSERT INTO votes (post_id, user_id) VALUES (?, ?)')->execute([$postId, $userId]);
            }
            $this->pdo->exec('COMMIT');
            return $voted;
        } catch (Throwable $t) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->exec('ROLLBACK');
            }
            throw $t;
        }
    }

    // ------------------------------------------------------------ search ---

    /** Escape LIKE wildcards so user input matches literally. */
    private static function likePattern(string $q): string
    {
        return '%' . str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $q) . '%';
    }

    public function searchTopics(string $q): array
    {
        $st = $this->pdo->prepare('SELECT id, name FROM topics WHERE name LIKE ? ESCAPE \'\\\' ORDER BY name');
        $st->execute([self::likePattern($q)]);
        return $st->fetchAll();
    }

    public function searchQuestions(string $q): array
    {
        $st = $this->pdo->prepare('
            SELECT q.id, q.text, t.id AS topic_id, t.name AS topic_name, COUNT(v.id) AS votes
            FROM posts q
            JOIN topics t ON t.id = q.topic_id
            LEFT JOIN votes v ON v.post_id = q.id
            WHERE q.type = \'question\' AND q.text LIKE :pat ESCAPE \'\\\'
            GROUP BY q.id
            ORDER BY votes DESC, q.id DESC
            LIMIT :lim
        ');
        $st->bindValue(':pat', self::likePattern($q));
        $st->bindValue(':lim', self::SEARCH_LIMIT, PDO::PARAM_INT);
        $st->execute();
        return $st->fetchAll();
    }
}
