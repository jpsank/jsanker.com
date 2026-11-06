"""Slur filter for user-written text. Python port of src/Censor.php (behavior-identical).

    censor(text)         strip invisible characters, replace slurs with asterisks (same length)
    contains_slur(text)  True if the text contains a slur (used to reject usernames)

(PHP names: Censor::clean and Censor::contains.)

Policy: slurs are censored at WRITE time, so the database never holds them.

The word list is stored ROT13-encoded on purpose, so the slurs are not sitting in
plain text in the repository (or in grep results). It is the same list, in the same
order, as ENTRIES in src/Censor.php; keep the two in sync. To add a word:
    python3 -c 'import codecs; print(codecs.encode("theword", "rot13"))'
and add an entry to ENTRIES below. Entry fields:
  w      ROT13 of the base word
  bound  True = must be a whole word (no letters/digits directly before or after)
  sep    True = allow punctuation between letters (n.i.g.g.a)
  pre    extra regex placed before the word (e.g. a lookbehind exclusion)
  post   regex for allowed endings (plurals etc.), placed after the word

What it catches: any case, leetspeak (4/@, 3, 1/!, 0, $, 5, 7, 9/q), repeated letters,
common Cyrillic/Greek look-alikes, and zero-width/soft-hyphen padding.
What it deliberately does NOT do: split-by-spaces spelling ("n i g g a"), because that
would censor ordinary text. It is a reasonable-effort filter, not a guarantee.

Port notes: Python's `re` has no \\p{L}/\\p{N}, so those (and PCRE's Unicode \\s) are
expanded to explicit character classes built from `unicodedata` on first use. Python's
Unicode database can be newer than the PCRE one PHP uses, so characters assigned very
recently may be classed differently from PHP (only matters for them being adjacent to a word).
"""
from __future__ import annotations

import codecs
import re
import unicodedata

MASK = "*"

# (w, bound, sep, pre, post) -- same order and contents as ENTRIES in Censor.php.
ENTRIES = [
    # stem, matches the rest of the word too; not after "s" and not certain innocent words
    {"w": "avtt",      "bound": False, "sep": True, "pre": "(?<![s5$])", "post": r"(?!l|ard)\p{L}*"},
    {"w": "avoo",      "bound": True,  "post": "(?:e+r+|a+h?|u+h)s?"},
    {"w": "avtabt",    "bound": True,  "post": "s?"},
    {"w": "avtyrg",    "bound": True,  "post": "s?"},
    {"w": "snt",       "bound": True,  "post": "(?:o+t+|e+t+|i+t+|y+)?s?"},
    {"w": "xvxr",      "bound": True,  "post": "s?"},
    {"w": "xlxr",      "bound": True,  "post": "s?"},
    {"w": "puvax",     "bound": True,  "post": "[sy]?"},
    {"w": "fcvp",      "bound": True,  "post": "s?", "pre": ""},
    {"w": "fcvpx",     "bound": True,  "post": "(?! and span)s?"},
    {"w": "jrgonpx",   "bound": True,  "post": "s?"},
    {"w": "gena",      "bound": True,  "post": "n(?:y|ie)s?"},
    {"w": "ergneq",    "bound": True,  "post": "(?:ed|s)?"},
    {"w": "tbbx",      "bound": True,  "post": "s?"},
    {"w": "pbba",      "bound": True,  "pre": "(?<!maine )", "post": "s?"},
    {"w": "orncre",    "bound": True,  "post": "s?"},
    {"w": "gbjryurnq", "bound": True,  "post": "s?"},
    {"w": "cnxv",      "bound": True,  "post": "s?"},
]

# Letter => look-alike character class (all lowercase; regexes are case-insensitive).
LOOKALIKES = {
    "a": "[a4@àáâãäåаα]",
    "b": "[b8ь]",
    "c": "[c(сϲ]",
    "e": "[e3€èéêëеє]",
    "g": "[g9qɡ]",
    "i": "[i1!|¡lìíîïіı]",
    "k": "[kк]",
    "o": "[o0òóôõöоο]",
    "s": "[s5$]",
    "t": "[t7+т]",
    "u": "[uùúûüυ]",
    "y": "[yýÿу]",
}

_INVISIBLE = re.compile("[​-‍⁠﻿­᠎]")

_compiled: list[re.Pattern] | None = None


def _ranges(pred) -> str:
    """Body of a regex character class (no brackets) for every code point satisfying pred."""
    out = []
    start = prev = None
    for cp in range(0x40000):  # no letters/numbers/spaces exist above plane 3
        if 0xD800 <= cp <= 0xDFFF or not pred(chr(cp)):
            continue
        if start is None:
            start = prev = cp
        elif cp == prev + 1:
            prev = cp
        else:
            out.append((start, prev))
            start = prev = cp
    if start is not None:
        out.append((start, prev))
    return "".join(
        "\\U%08x" % a if a == b else "\\U%08x-\\U%08x" % (a, b) for a, b in out
    )


def _patterns() -> list[re.Pattern]:
    global _compiled
    if _compiled is not None:
        return _compiled

    letter = _ranges(lambda c: unicodedata.category(c)[0] == "L")
    number = _ranges(lambda c: unicodedata.category(c)[0] == "N")
    # PCRE \s under /u: Z* categories plus tab, LF, VT, FF, CR, NEL, and U+180E (PCRE's \h).
    space = _ranges(
        lambda c: unicodedata.category(c)[0] == "Z" or c in "\t\n\v\f\r\x85᠎"
    )

    def expand(rx: str) -> str:
        # (?-i:...) because PCRE does not case-fold \p{..} classes but Python would
        return rx.replace(r"\p{L}", "(?-i:[" + letter + "])")

    out = []
    for e in ENTRIES:
        sep = "(?-i:[^" + letter + number + space + "]){0,2}" if e.get("sep") else ""
        letters = []
        for ch in codecs.decode(e["w"], "rot13"):
            letters.append(LOOKALIKES.get(ch, re.escape(ch)) + "+")
        lb = "(?<!(?-i:[" + letter + number + "]))" if e["bound"] else ""
        la = "(?!(?-i:[" + letter + number + "]))" if e["bound"] else ""
        rx = lb + expand(e.get("pre", "")) + sep.join(letters) + expand(e.get("post", "")) + la
        out.append(re.compile(rx, re.IGNORECASE))
    _compiled = out
    return out


def _strip_invisible(text: str) -> str:
    """Remove zero-width / soft-hyphen characters (used to hide words)."""
    return _INVISIBLE.sub("", text)


def _is_valid_utf8(text: str) -> bool:
    try:
        text.encode("utf-8")
        return True
    except UnicodeEncodeError:  # lone surrogates: PHP would see invalid UTF-8
        return False


def _view(text: str) -> str:
    """Same-length copy of text that the patterns are run against.

    Python's re.IGNORECASE treats U+0130 (capital I with dot) as a case variant of "i";
    PCRE (and so PHP) does not. Swap it for a neutral letter so it is not matched as "i"
    (it stays a letter, so word boundaries behave as in PHP).
    """
    return text.replace("\u0130", "\u05d0")


def censor(text: str) -> str:
    """Strip invisible characters, then replace each slur with asterisks (same length)."""
    if not _is_valid_utf8(text):
        # Invalid UTF-8: fail closed (PHP masks by byte length).
        return MASK * max(1, len(text.encode("utf-8", "surrogatepass")))
    text = _strip_invisible(text)
    view = _view(text)
    for rx in _patterns():
        spans = [m.span() for m in rx.finditer(view)]
        if not spans:
            continue
        out_text, out_view, last = [], [], 0
        for a, b in spans:
            mask = MASK * max(1, b - a)
            out_text += [text[last:a], mask]
            out_view += [view[last:a], mask]
            last = b
        text = "".join(out_text) + text[last:]
        view = "".join(out_view) + view[last:]
    return text


def contains_slur(text: str) -> bool:
    """True if the text contains a slur (used to reject usernames)."""
    if not _is_valid_utf8(text):
        return True  # fail closed
    view = _view(_strip_invisible(text))
    return any(rx.search(view) for rx in _patterns())
