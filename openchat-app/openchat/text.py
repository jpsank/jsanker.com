"""Small text helpers shared by templates and views."""
from __future__ import annotations

import re
from datetime import datetime

from .models import utcnow


def _plural(n: int, unit: str) -> str:
    return f"{n} {unit}{'' if n == 1 else 's'}"


def ago(dt: datetime | None) -> str:
    """'5 minutes', '3 hours', '12 days' and, for long gaps, the two largest units: '3 years 6 days'."""
    if dt is None:
        return "never"
    seconds = max(0.0, (utcnow() - dt).total_seconds())
    if seconds <= 60:
        return _plural(round(seconds), "second") + " ago"
    minutes = seconds / 60
    if minutes <= 60:
        return _plural(round(minutes), "minute") + " ago"
    hours = minutes / 60
    if hours <= 24:
        return _plural(round(hours), "hour") + " ago"
    total_days = round(hours / 24)
    years, days = divmod(total_days, 365)
    if years == 0:
        return _plural(total_days, "day") + " ago"
    return _plural(years, "year") + ("" if days == 0 else " " + _plural(days, "day")) + " ago"


def iso(dt: datetime | None) -> str:
    return "" if dt is None else dt.strftime("%Y-%m-%dT%H:%M:%SZ")


NAME_RE = re.compile(r"[A-Za-z0-9_-]{3,24}")
CHAT_RE = re.compile(r"[A-Za-z0-9_-]{3,30}")


def like_pattern(term: str) -> str:
    """Escape LIKE wildcards in a search term (used with escape='\\\\')."""
    return "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
