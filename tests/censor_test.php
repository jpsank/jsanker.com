<?php
declare(strict_types=1);

/**
 * Tests for src/Censor.php.   php tests/censor_test.php
 * Cases are ROT13-encoded so no slur appears in plain text here or in the output
 * (failures print the ROT13 form).
 */

require_once __DIR__ . '/../src/Censor.php';

$fail = 0;
$pass = 0;
function check(bool $ok, string $label): void
{
    global $fail, $pass;
    if ($ok) {
        $pass++;
    } else {
        $fail++;
        echo "FAIL: $label\n";
    }
}

// ---- must be censored (ROT13 of the plain forms) ------------------------------------------
$positives = [
    'avttre', 'avttn', 'avttnf', 'avttref', 'avttnm', 'avttnu',         // n-word family
    'avoon', 'avoore', 'avtabt', 'avtyrg',
    'snttbg', 'snttbgf', 'snt', 'snttl',                                  // f-slur
    'xvxr', 'xvxrf', 'puvax', 'puvaxf', 'fcvp', 'fcvpf',
    'jrgonpx', 'genaal', 'genaavrf', 'ergneq', 'ergneqrq', 'ergneqf',
    'tbbx', 'pbba', 'orncre', 'gbjryurnq', 'cnxv',
];
foreach ($positives as $rot) {
    $w = str_rot13($rot);
    $variants = [
        'plain'     => $w,
        'upper'     => strtoupper($w),
        'title'     => ucfirst($w),
        'sentence'  => "you are a $w and everyone knows it",
        'punct'     => "hey, $w! stop.",
        'zero-width' => implode("\u{200B}", mb_str_split($w)),
    ];
    foreach ($variants as $kind => $text) {
        $out = Censor::clean($text);
        check($out !== $text && !Censor::contains($out) && mb_strlen($out) === mb_strlen(str_replace("\u{200B}", '', $text)),
            "$kind: $rot");
        check(Censor::contains($text), "contains/$kind: $rot");
    }
}

// Obfuscation of the n-word specifically: leetspeak, repeats, punctuation separators, homoglyphs.
$core = str_rot13('avttre');
$evasions = [
    strtr($core, ['i' => '1']), strtr($core, ['i' => '!']), strtr($core, ['e' => '3']),
    strtr($core, ['g' => 'q']), strtr($core, ['i' => '1', 'e' => '3']),
    'N' . str_repeat('i', 4) . 'gger', substr($core, 0, 3) . str_repeat('g', 3) . 'er',
    implode('.', str_split($core)), implode('-', str_split($core)), implode('*', str_split($core)),
    str_replace('i', "\u{0456}", $core),       // Cyrillic i
    str_replace('e', "\u{0435}", $core),       // Cyrillic e
    strtr(str_rot13('avttn'), ['i' => '1']),   // "n1gga"-style
];
foreach ($evasions as $i => $text) {
    check(Censor::clean("x $text y") !== "x $text y", 'evasion #' . $i);
}

// Mask keeps the length and is not applied twice
$s = 'hello ' . str_rot13('avttn') . ' world';
$once = Censor::clean($s);
check($once === 'hello ***** world', 'mask length');
check(Censor::clean($once) === $once, 'idempotent');

// ---- must NOT be touched ---------------------------------------------------------------------
$innocent = [
    'snigger', 'sniggered', 'sniggering', 'niggle', 'niggling', 'niggardly', 'niggard',
    'Niger', 'Nigeria', 'Nigerian', 'Nigel', 'nightly', 'night', 'signal', 'design', 'knight',
    'Maine Coon', 'raccoon', 'cocoon', 'coons', // "coons" alone IS censored; see below
    'flame retardant', 'fire retardation', 'retarding force',
    'spicy', 'spice', 'spick and span', 'special', 'Pakistan', 'Pakistani', 'packing',
    'chinkapin', 'Chinese', 'China', 'chin', 'title', 'bike', 'likes', 'kiker',
    'classic', 'assess', 'analytics', 'Scunthorpe', 'cocktail', 'Dickens', 'passage',
    'in Iggy Pop', 'in igloo', 'tag', 'bag', 'flag', 'fagade', 'fagot-free is fine',
    'cooking', 'gooky', 'tranquil', 'transfer', 'translate', 'training', 'terrain',
    'beanery', 'beanbag', 'towelling', 'towel head count',
    'I love chemistry and the periodic table', 'What is the derivative of x^2?',
    'Can someone explain photosynthesis? Thanks!', '<3 hearts & "quotes" 100% fine',
];
// words in the list above that are genuinely censored by design
$expectedCensored = ['coons', 'fagot-free is fine'];
foreach ($innocent as $text) {
    $out = Censor::clean($text);
    if (in_array($text, $expectedCensored, true)) {
        check($out !== $text, 'should censor: ' . str_rot13($text));
    } else {
        check($out === $text, 'false positive: ' . $text);
    }
}

// Usernames
check(Censor::contains(str_rot13('avttre') . '123'), 'username with slur prefix');
check(!Censor::contains('julian_s'), 'normal username');

// Robustness: invalid UTF-8 must fail closed, never throw
check(Censor::clean("bad \xC3\x28 bytes") !== '', 'invalid utf-8 does not throw');

echo "\n$pass passed, $fail failed\n";
exit($fail === 0 ? 0 : 1);
