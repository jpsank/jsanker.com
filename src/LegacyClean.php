<?php
declare(strict_types=1);

require_once __DIR__ . '/Censor.php';

/**
 * Sanitiser used only by bin/migrate-legacy.php when importing the 2019 OpenChat /
 * APedia databases. Every function returns [cleaned value or null, list of reason codes]
 * so the importer can report what it changed (by row id, never by content).
 *
 * Reason codes: invalid-utf8, entities-decoded, html-removed, control-chars, censored,
 *               truncated, empty, sql-like-text (flagged only; harmless once bound/escaped)
 */
final class LegacyClean
{
    /**
     * @param bool $decodeEntities  old APedia stored htmlspecialchars()-escaped text; decode it once
     *                              (the new code stores raw text and escapes on output)
     * @param bool $keepNewlines    APedia posts are multi-line; OpenChat messages are single-line
     * @return array{0: ?string, 1: list<string>}
     */
    public static function text(string $raw, int $max, bool $decodeEntities, bool $keepNewlines): array
    {
        $why = [];
        $s = mb_scrub($raw, 'UTF-8');
        if ($s !== $raw) {
            $why[] = 'invalid-utf8';
        }

        if ($decodeEntities) {
            $decoded = html_entity_decode($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
            if ($decoded !== $s) {
                $why[] = 'entities-decoded';
                $s = $decoded;
            }
        }

        if (preg_match('~union\s+(?:all\s+)?select|drop\s+table|;\s*--|\'\s*or\s*[\'"]?\d+[\'"]?\s*=\s*[\'"]?\d+~i', $s)) {
            $why[] = 'sql-like-text';
        }

        // Injected markup: script/style/iframe/object/embed blocks, any tag carrying an
        // inline event handler, HTML comments, and javascript:/vbscript: URL schemes.
        // Ordinary angle-bracket text (<3, "a < b", even <div> in a CS question) is left alone.
        $before = $s;
        $s = preg_replace('~<\s*(script|style|iframe|object|embed)\b[^>]*>.*?<\s*/\s*\1\s*>~is', '', $s) ?? $s;
        $s = preg_replace('~<\s*/?\s*(script|style|iframe|object|embed|meta|link|base|form)\b[^>]*>~i', '', $s) ?? $s;
        $s = preg_replace('~<[a-zA-Z][^>]*\son[a-z]+\s*=[^>]*>~i', '', $s) ?? $s;
        $s = preg_replace('~<!--.*?-->~s', '', $s) ?? $s;
        $s = preg_replace('~\b(?:javascript|vbscript)\s*:~i', '', $s) ?? $s;
        if ($s !== $before) {
            $why[] = 'html-removed';
        }

        // Control characters and bidi overrides (used for spoofing).
        $before = $s;
        $s = str_replace(["\r\n", "\r"], "\n", $s);
        if ($keepNewlines) {
            $s = preg_replace('/[^\P{Cc}\n]/u', ' ', $s) ?? $s;           // every control char except \n
            $s = preg_replace('/[ \t\x{00A0}]+\n/u', "\n", $s) ?? $s;     // trailing spaces
            $s = preg_replace('/\n{3,}/', "\n\n", $s) ?? $s;
        } else {
            $s = preg_replace('/\p{Cc}+/u', ' ', $s) ?? $s;
            $s = preg_replace('/\s{2,}/u', ' ', $s) ?? $s;
        }
        $s = preg_replace('/[\x{202A}-\x{202E}\x{2066}-\x{2069}]/u', '', $s) ?? $s;
        if (trim($s) !== trim($before) && trim(preg_replace('/\s+/u', ' ', $s)) !== trim(preg_replace('/\s+/u', ' ', $before))) {
            $why[] = 'control-chars';
        }

        $s = trim($s);

        $censored = Censor::clean($s);
        if ($censored !== $s) {
            $why[] = 'censored';
            $s = $censored;
        }

        if ($s === '') {
            $why[] = 'empty';
            return [null, $why];
        }
        if (mb_strlen($s) > $max) {
            $s = rtrim(mb_substr($s, 0, $max - 1)) . '…';
            $why[] = 'truncated';
        }
        return [$s, $why];
    }

    /**
     * New usernames are 3-30 of [A-Za-z0-9_-], unique case-insensitively, and slur-free.
     * Anything else becomes a safe name; the account (password, posts, votes) is kept.
     *
     * @param array<string,true> $taken lowercase names already used (updated)
     * @return array{0: string, 1: list<string>}
     */
    public static function username(string $name, int $id, array &$taken): array
    {
        $why = [];
        $clean = preg_replace('/[^A-Za-z0-9_-]/', '', mb_scrub($name, 'UTF-8')) ?? '';
        $clean = substr($clean, 0, 30);
        if ($clean !== $name) {
            $why[] = 'username-chars';
        }
        if (strlen($clean) < 3) {
            $clean = "user$id";
            $why[] = 'username-too-short';
        }
        if (Censor::contains($clean) || Censor::contains($name)) {
            $clean = "user$id";
            $why[] = 'username-censored';
        }
        if (isset($taken[strtolower($clean)])) {
            $clean = substr($clean, 0, 24) . "-$id";
            $why[] = 'username-duplicate';
        }
        $taken[strtolower($clean)] = true;
        return [$clean, $why];
    }
}
