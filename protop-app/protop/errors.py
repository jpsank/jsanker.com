"""One error type for everything the routes reject; the app turns it into {"error": ...} JSON."""
from __future__ import annotations


class ApiError(Exception):
    def __init__(self, status: int, message: str, retry_after: int | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.retry_after = retry_after
