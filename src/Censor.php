<?php
declare(strict_types=1);

/**
 * Slur filter for user-written text (OpenChat, APedia).
 *
 *   Censor::clean($text)     strip invisible characters, replace slurs with asterisks (same length)
 *   Censor::contains($text)  true if the text contains a slur (used to reject usernames)
 *
 * Policy: slurs are censored at WRITE time, so the database never holds them.
 * bin/recensor.php re-applies the current list to existing rows after you extend it.
 *
 * The word list is stored ROT13-encoded on purpose, so the slurs are not sitting in
 * plain text in the repository (or in grep results). To add a word:
 *     php -r 'echo str_rot13("theword"), "\n";'
 * and add an entry to ENTRIES below. Entry fields:
 *   w      ROT13 of the base word
 *   bound  true = must be a whole word (no letters/digits directly before or after)
 *   sep    true = allow punctuation between letters (n.i.g.g.a)
 *   pre    extra regex placed before the word (e.g. a lookbehind exclusion)
 *   post   regex for allowed endings (plurals etc.), placed after the word
 *
 * What it catches: any case, leetspeak (4/@, 3, 1/!, 0, $, 5, 7, 9/q), repeated letters,
 * common Cyrillic/Greek look-alikes, and zero-width/soft-hyphen padding.
 * What it deliberately does NOT do: split-by-spaces spelling ("n i g g a"), because that
 * would censor ordinary text ("in Iggy"). It is a reasonable-effort filter, not a guarantee.
 */
final class Censor
{
    public const MASK = '*';

    /** @var list<array{w: string, bound: bool, sep?: bool, pre?: string, post?: string}> */
    private const ENTRIES = [
        // stem, matches the rest of the word too; not after "s" (snigger) and not niggle/niggard
        ['w' => 'avtt',      'bound' => false, 'sep' => true, 'pre' => '(?<![s5$])', 'post' => '(?!l|ard)\p{L}*'],
        ['w' => 'avoo',      'bound' => true,  'post' => '(?:e+r+|a+h?|u+h)s?'],
        ['w' => 'avtabt',    'bound' => true,  'post' => 's?'],
        ['w' => 'avtyrg',    'bound' => true,  'post' => 's?'],
        ['w' => 'snt',       'bound' => true,  'post' => '(?:o+t+|e+t+|i+t+|y+)?s?'],
        ['w' => 'xvxr',      'bound' => true,  'post' => 's?'],
        ['w' => 'xlxr',      'bound' => true,  'post' => 's?'],
        ['w' => 'puvax',     'bound' => true,  'post' => '[sy]?'],
        ['w' => 'fcvp',      'bound' => true,  'post' => 's?', 'pre' => '', ],
        ['w' => 'fcvpx',     'bound' => true,  'post' => '(?! and span)s?'],
        ['w' => 'jrgonpx',   'bound' => true,  'post' => 's?'],
        ['w' => 'gena',      'bound' => true,  'post' => 'n(?:y|ie)s?'],
        ['w' => 'ergneq',    'bound' => true,  'post' => '(?:ed|s)?'],
        ['w' => 'tbbx',      'bound' => true,  'post' => 's?'],
        ['w' => 'pbba',      'bound' => true,  'pre' => '(?<!maine )', 'post' => 's?'],
        ['w' => 'orncre',    'bound' => true,  'post' => 's?'],
        ['w' => 'gbjryurnq', 'bound' => true,  'post' => 's?'],
        ['w' => 'cnxv',      'bound' => true,  'post' => 's?'],
    ];

    /** Letter => look-alike character class (all lowercase; regexes are case-insensitive). */
    private const LOOKALIKES = [
        'a' => '[a4@àáâãäåаα]',
        'b' => '[b8ь]',
        'c' => '[c(сϲ]',
        'e' => '[e3€èéêëеє]',
        'g' => '[g9qɡ]',
        'i' => '[i1!|¡lìíîïіı]',
        'k' => '[kк]',
        'o' => '[o0òóôõöоο]',
        's' => '[s5$]',
        't' => '[t7+т]',
        'u' => '[uùúûüυ]',
        'y' => '[yýÿу]',
    ];

    /** @var list<string>|null compiled regexes */
    private static ?array $compiled = null;

    /** Remove zero-width / soft-hyphen characters (used to hide words), then mask slurs. */
    public static function clean(string $text): string
    {
        $text = self::stripInvisible($text);
        foreach (self::patterns() as $re) {
            $out = preg_replace_callback(
                $re,
                static fn(array $m): string => str_repeat(self::MASK, max(1, mb_strlen($m[0]))),
                $text
            );
            if ($out === null) {
                // Invalid UTF-8 or a regex engine limit: fail closed.
                return str_repeat(self::MASK, max(1, mb_strlen($text, '8bit')));
            }
            $text = $out;
        }
        return $text;
    }

    public static function contains(string $text): bool
    {
        $text = self::stripInvisible($text);
        foreach (self::patterns() as $re) {
            $hit = preg_match($re, $text);
            if ($hit === 1 || $hit === false) {
                return true; // false = engine error: fail closed
            }
        }
        return false;
    }

    private static function stripInvisible(string $text): string
    {
        return preg_replace('/[\x{200B}-\x{200D}\x{2060}\x{FEFF}\x{00AD}\x{180E}]/u', '', $text) ?? $text;
    }

    /** @return list<string> */
    private static function patterns(): array
    {
        if (self::$compiled !== null) {
            return self::$compiled;
        }
        $out = [];
        foreach (self::ENTRIES as $e) {
            $sep = !empty($e['sep']) ? '[^\p{L}\p{N}\s]{0,2}' : '';
            $letters = [];
            foreach (str_split(str_rot13($e['w'])) as $ch) {
                $letters[] = (self::LOOKALIKES[$ch] ?? preg_quote($ch, '~')) . '+';
            }
            $lb = $e['bound'] ? '(?<![\p{L}\p{N}])' : '';
            $la = $e['bound'] ? '(?![\p{L}\p{N}])' : '';
            $out[] = '~' . $lb . ($e['pre'] ?? '') . implode($sep, $letters) . ($e['post'] ?? '') . $la . '~iu';
        }
        return self::$compiled = $out;
    }
}
