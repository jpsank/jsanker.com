"""Tests for openchat/censor.py (port of src/Censor.php).

Plain unittest, no third-party packages. Slurs are never written in plain text here:
every test input is built at runtime from ROT13-encoded strings, and failure messages
show the input ROT13-encoded too.

Run from the openchat-app directory:
    python3 -m unittest discover -s tests -v
"""
import codecs
import importlib.util
import os
import unittest

# Load censor.py by path so the tests do not depend on the rest of the package
# (openchat/__init__.py) being importable.
_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "openchat", "censor.py")
_spec = importlib.util.spec_from_file_location("openchat_censor_under_test", _PATH)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
censor = _mod.censor
contains_slur = _mod.contains_slur


def d(s):
    """ROT13-decode a test string."""
    return codecs.decode(s, "rot13")


def show(s):
    """Safe-to-print form of a test input (ROT13, escaped)."""
    return "rot13:" + codecs.encode(s, "rot13").encode("unicode_escape").decode()


def stars(s):
    return "*" * len(s)


# ROT13-encoded words. Names are neutral on purpose.
STEM = d("avtt")          # unbounded stem; punctuation allowed between letters; swallows the rest of the word
STEM_A = d("avtn")        # stem + "a" (a whole word in its own right)
SHORT = d("snt")          # short bounded word with optional endings
PLAIN4 = d("tbbx")        # bounded word, plain plural
CHINK = d("puvax")        # bounded word, ending [sy]
SPIC = d("fcvp")
SPICK = d("fcvpx")
COON = d("pbba")
KIKE = d("xvxr")
# Same list as ENTRIES in Censor.php, but spelled here independently of censor.py.
ALL_WORDS = [
    d(w)
    for w in (
        "avtt avoo avtabt avtyrg snt xvxr xlxr puvax fcvp fcvpx jrgonpx gena ergneq tbbx pbba orncre gbjryurnq cnxv"
    ).split()
]
# Two entries cannot stand alone: they need one of their endings to form a word.
ALL_FORMS = list(ALL_WORDS)
ALL_FORMS[1] = ALL_WORDS[1] + "er"
ALL_FORMS[11] = ALL_WORDS[11] + "ny"
BASE_AND_SUFFIX = [(b, f[len(b):]) for b, f in zip(ALL_WORDS, ALL_FORMS)]
BOUNDED_WORDS = ALL_FORMS[1:]  # every entry except the stem is whole-word only

# Documented leetspeak substitutions (ASCII), and look-alike letters (Unicode).
LEET = {
    "a": "4@", "e": "3", "i": "1!|l", "o": "0", "s": "$5", "t": "7+", "g": "9q", "b": "8", "c": "(",
}
LOOK = {
    "a": "\u0430\u03b1\u00e0\u00e1\u00e2\u00e3\u00e4\u00e5",
    "b": "\u044c",
    "c": "\u0441\u03f2",
    "e": "\u0435\u0454\u00e8\u00e9\u00ea\u00eb\u20ac",
    "g": "\u0261",
    "i": "\u0456\u0131\u00ec\u00ed\u00ee\u00ef\u00a1",
    "k": "\u043a",
    "o": "\u043e\u03bf\u00f2\u00f3\u00f4\u00f5\u00f6",
    "t": "\u0442",
    "u": "\u03c5\u00f9\u00fa\u00fb\u00fc",
    "y": "\u0443\u00fd\u00ff",
}
INVISIBLE = ["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff", "\u00ad", "\u180e"]


class _Base(unittest.TestCase):
    def assertMasked(self, s, msg=""):
        self.assertEqual(censor(s), stars(s), msg + " " + show(s))
        self.assertTrue(contains_slur(s), msg + " " + show(s))

    def assertClean(self, s, msg=""):
        self.assertEqual(censor(s), s, msg + " " + show(s))
        self.assertFalse(contains_slur(s), msg + " " + show(s))


class BasicTests(_Base):
    def test_empty_and_ordinary_text(self):
        self.assertEqual(censor(""), "")
        self.assertFalse(contains_slur(""))
        for t in ["Hello, world!", "The quick brown fox.", "\u65e5\u672c\u8a9e", "\U0001F600 emoji", "a\nb\tc", "100% $5.99 a|b"]:
            self.assertClean(t)

    def test_every_word_masked_to_same_length(self):
        for w in ALL_FORMS:
            self.assertMasked(w)
            self.assertEqual(censor("x " + w + " y"), "x " + stars(w) + " y", show(w))

    def test_case_insensitive(self):
        for w in ALL_FORMS:
            for v in (w.upper(), w.title(), "".join(c.upper() if i % 2 else c for i, c in enumerate(w))):
                self.assertMasked(v)

    def test_multiple_matches_and_punctuation_around(self):
        s = PLAIN4 + " ok " + SHORT + ", " + PLAIN4.upper() + "!"
        self.assertEqual(censor(s), stars(PLAIN4) + " ok " + stars(SHORT) + ", " + stars(PLAIN4) + "!")
        self.assertEqual(censor("(" + PLAIN4 + ")"), "(" + stars(PLAIN4) + ")")


class ObfuscationTests(_Base):
    def test_leetspeak_one_position_at_a_time(self):
        count = 0
        for w, suf in BASE_AND_SUFFIX:
            for i, ch in enumerate(w):
                for sub in LEET.get(ch, ""):
                    self.assertMasked(w[:i] + sub + w[i + 1:] + suf)
                    count += 1
        self.assertGreater(count, 50)

    def test_leetspeak_all_letters_at_once(self):
        for w, suf in BASE_AND_SUFFIX:
            self.assertMasked("".join(LEET[c][0] if c in LEET else c for c in w) + suf)

    def test_repeated_letters(self):
        for w, suf in BASE_AND_SUFFIX:
            self.assertMasked("".join(c * 3 for c in w) + suf)
            self.assertMasked("".join(c * 2 for c in w).upper() + suf.upper())
        rep = "".join(c * 4 for c in PLAIN4)
        self.assertEqual(censor("a " + rep + "s b"), "a " + stars(rep + "s") + " b")

    def test_punctuation_between_letters_only_for_sep_words(self):
        for sep in [".", "-", "_", "*", "..", ",", "/", "!", "@", "#", ".-", "\u2013"]:
            v = sep.join(STEM)
            self.assertEqual(censor("a " + v + " b"), "a " + stars(v) + " b", show(sep))
            self.assertTrue(contains_slur(v))
        # not allowed for the other words
        for w in BOUNDED_WORDS:
            self.assertClean(".".join(w))
        # more than two punctuation characters, letters, or digits in between: not matched
        self.assertClean("...".join(STEM))
        self.assertClean("x".join(STEM))
        self.assertClean("1".join(STEM))

    def test_letters_separated_by_spaces_are_deliberately_not_matched(self):
        for w in ALL_FORMS:
            for sp in (" ", "  ", "\t", "\n", "\u00a0", "\u3000", "\u2003"):
                self.assertClean(sp.join(w))
        # no space allowed as the separator even next to punctuation
        self.assertClean(". ".join(STEM))

    def test_lookalike_unicode_letters(self):
        count = 0
        for w, suf in BASE_AND_SUFFIX:
            for i, ch in enumerate(w):
                for sub in LOOK.get(ch, ""):
                    self.assertMasked(w[:i] + sub + w[i + 1:] + suf)
                    self.assertMasked((w[:i] + sub + w[i + 1:] + suf).upper())
                    count += 1
        self.assertGreater(count, 100)

    def test_dotted_capital_i_is_not_a_lookalike(self):
        # Python's re.IGNORECASE folds U+0130 to "i"; PHP/PCRE does not. The port must not either.
        v = KIKE.replace("i", "\u0130")
        self.assertClean(v)
        self.assertClean(v.upper())

    def test_zero_width_and_soft_hyphen_padding(self):
        for z in INVISIBLE:
            for w in ALL_FORMS:
                v = z.join(w)
                self.assertTrue(contains_slur(v), show(w))
                # the invisible characters are removed, then the word is masked
                self.assertEqual(censor("a " + v + " b"), "a " + stars(w) + " b", show(w))
            self.assertEqual(censor(z + PLAIN4 + z), stars(PLAIN4))
        # removal on its own, no slur involved
        self.assertEqual(censor("he\u200bll\u00ado\ufeff"), "hello")
        # padding does not defeat the whole-word rule either way
        self.assertEqual(censor("z\u200b" + PLAIN4), "z" + PLAIN4)


class BoundaryAndSuffixTests(_Base):
    def test_bounded_words_need_to_be_whole_words(self):
        for w in BOUNDED_WORDS:
            self.assertFalse(contains_slur("z" + w), show(w))
            self.assertFalse(contains_slur(w + "z"), show(w))
            self.assertFalse(contains_slur("2" + w), show(w))
            self.assertFalse(contains_slur(w + "2"), show(w))
            self.assertFalse(contains_slur("\u00e9" + w), show(w))     # letter before
            self.assertFalse(contains_slur(w + "\u0430"), show(w))     # letter after
            self.assertFalse(contains_slur(w + "\u0663"), show(w))     # Arabic-Indic digit after
            self.assertTrue(contains_slur("-" + w + "-"), show(w))
            self.assertTrue(contains_slur("\U0001F600" + w + "\U0001F600"), show(w))

    def test_endings(self):
        self.assertEqual(censor(PLAIN4 + "S!"), stars(PLAIN4 + "S") + "!")
        self.assertEqual(censor(CHINK + "y"), stars(CHINK + "y"))
        self.assertEqual(censor(CHINK + "s"), stars(CHINK + "s"))
        for suffix in ("ot", "oot", "et", "it", "y", "s", "yy", "ots", "eets"):
            self.assertMasked(SHORT + suffix, suffix)
        for suffix in ("er", "ers", "eer", "ah", "aah", "uh", "uhs"):
            self.assertMasked(ALL_WORDS[1] + suffix, suffix)
        self.assertMasked(d("gena") + "nie")
        self.assertClean(d("gena"))   # this word needs an ending
        self.assertClean(ALL_WORDS[1])  # so does this one
        self.assertMasked(d("gena") + "nys")
        self.assertMasked(d("ergneq") + "ed")
        self.assertMasked(d("ergneq") + "s")
        # an ending that is not listed leaves a letter touching the word, so no match
        self.assertClean(PLAIN4 + "ish")

    def test_stem_swallows_rest_of_the_word(self):
        for tail in ("a", "er", "ers", "ing", "ah", "etry", "\u00e9", "\u0430"):
            self.assertMasked(STEM + tail, tail)
        self.assertEqual(censor(STEM + "a1"), stars(STEM + "a") + "1")
        self.assertEqual(censor(STEM + "a."), stars(STEM + "a") + ".")
        # unbounded on the left
        self.assertEqual(censor("z" + STEM + "a"), "z" + stars(STEM + "a"))


class ExceptionTests(_Base):
    def test_stem_not_matched_after_s(self):
        for pre in ("s", "S", "5", "$"):
            self.assertClean(pre + STEM + "er")
        self.assertTrue(contains_slur("a" + STEM + "er"))
        self.assertClean("ss" + STEM + "a")
        self.assertTrue(contains_slur("s." + STEM + "a"))   # not directly after the "s"

    def test_stem_innocent_words(self):
        for tail in ("le", "led", "ling", "les", "LE", "ard", "ards", "ardly", "Ard"):
            self.assertClean(STEM + tail)
            self.assertEqual(censor("a " + STEM + tail + " b"), "a " + STEM + tail + " b")
        # only directly after the stem
        self.assertTrue(contains_slur(STEM + "a" + "le"))
        self.assertTrue(contains_slur(STEM + "x" + "ard"))
        # also when the stem is spelled with punctuation or repeated letters
        self.assertClean(".".join(STEM) + "le")

    def test_spick_and_span(self):
        self.assertClean(SPICK + " and span")
        self.assertClean(SPICK + " AND SPAN")
        self.assertEqual(censor("so " + SPICK + " and span!"), "so " + SPICK + " and span!")
        self.assertMasked(SPICK)
        self.assertEqual(censor(SPICK + " and spam"), stars(SPICK) + " and spam")
        self.assertEqual(censor(SPICK + "  and span"), stars(SPICK) + "  and span")  # two spaces: no exception
        # the exception belongs to the "-k" spelling only
        self.assertEqual(censor(SPIC + " and span"), stars(SPIC) + " and span")

    def test_maine_coon(self):
        for pre in ("maine ", "Maine ", "MAINE "):
            self.assertClean(pre + COON)
            self.assertClean("my " + pre + COON + "s")
        self.assertMasked(COON)
        self.assertEqual(censor("maine  " + COON), "maine  " + stars(COON))   # two spaces
        self.assertEqual(censor("maine\t" + COON), "maine\t" + stars(COON))
        self.assertEqual(censor("maine." + COON), "maine." + stars(COON))
        self.assertEqual(censor("the " + COON), "the " + stars(COON))

    def test_innocent_sentences(self):
        for t in [
            "Scunthorpe", "Assassin", "Peacock", "Cocktail", "Cookbook", "Kiwi", "Tokyo", "Raccoon", "Cockpit",
            "Bigger and bigger", "Trigger", "Figure", "Nigel", "Giggle", "in Iggy", "I am in Iggy Pop fan",
            "Shaking", "The quick brown fox jumps over the lazy dog", "Caf\u00e9 Zo\u00eb na\u00efve",
        ]:
            self.assertClean(t)


class ContainsTests(_Base):
    def test_contains_agrees_with_censor(self):
        samples = ["hello", PLAIN4, " " + PLAIN4 + " ", "z" + PLAIN4, STEM + "ger", "s" + STEM + "ger", "a b c", "",
                   SPICK + " and span", SPICK, "maine " + COON, COON, ".".join(STEM), ".".join(PLAIN4)]
        for s in samples:
            self.assertEqual(contains_slur(s), censor(s) != s, show(s))

    def test_contains_strips_invisible_first(self):
        self.assertTrue(contains_slur("\u200b".join(PLAIN4)))
        self.assertFalse(contains_slur("\u200b\u200c\ufeff"))

    def test_username_style_inputs(self):
        self.assertFalse(contains_slur("julian_s"))
        self.assertFalse(contains_slur("cool.user99"))
        self.assertTrue(contains_slur("xX-" + PLAIN4 + "-Xx"))
        self.assertTrue(contains_slur("xX_" + PLAIN4 + "_Xx"))    # "_" is not a letter/digit, so it is a word edge
        self.assertFalse(contains_slur("xX" + PLAIN4 + "Xx"))


class EdgeCaseTests(_Base):
    def test_mask_length_counts_characters_not_bytes(self):
        v = KIKE.replace("e", "\u20ac")  # euro sign is 3 bytes in UTF-8
        self.assertEqual(censor(v), stars(v))
        self.assertEqual(len(censor(v)), len(v))

    def test_long_inputs(self):
        s = ("lorem ipsum " * 20000) + PLAIN4 + (" dolor" * 20000)
        out = censor(s)
        self.assertEqual(len(out), len(s))
        self.assertEqual(out.count("*"), len(PLAIN4))
        self.assertEqual(censor("a" * 200000), "a" * 200000)
        self.assertEqual(censor("\u200b" * 100000), "")
        self.assertEqual(censor("\U0001F600" * 50000), "\U0001F600" * 50000)

    def test_emoji_and_mixed_scripts(self):
        t = "\U0001F600 \u041f\u0440\u0438\u0432\u0435\u0442 \u0395\u03bb\u03bb\u03b7\u03bd\u03b9\u03ba\u03ac \u4e2d\u6587 \u0639\u0631\u0628\u064a"
        self.assertClean(t)
        self.assertEqual(censor("\U0001F600" + PLAIN4 + "\U0001F600"), "\U0001F600" + stars(PLAIN4) + "\U0001F600")

    def test_invalid_text_fails_closed(self):
        # a lone surrogate is what invalid UTF-8 looks like inside a Python str
        self.assertTrue(contains_slur("ab\udcffcd"))
        self.assertEqual(set(censor("ab\udcffcd")), {"*"})

    def test_idempotent(self):
        for w in ALL_FORMS:
            once = censor("x " + w + " y")
            self.assertEqual(censor(once), once)


if __name__ == "__main__":
    unittest.main()
