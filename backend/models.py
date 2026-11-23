"""Domain models and structured error types for the family tree backend."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


def format_error_payload(
    code: str,
    message: str,
    hint: str | None = None,
) -> dict[str, Any]:
    """Build a uniform, safe JSON error response without internal details."""
    error_body: dict[str, Any] = {
        "code": code,
        "message": message,
    }
    if hint:
        error_body["hint"] = hint
    return {
        "ok": False,
        "error": error_body,
    }


class BackendError(Exception):
    """Base application error carrying an HTTP-friendly status code."""

    status_code: int = 400
    code: str = "bad_request"
    default_message: str = "Hibás vagy nem teljesíthető kérés."

    def __init__(
        self,
        message: str | None = None,
        *,
        code: str | None = None,
        status_code: int | None = None,
        hint: str | None = None,
    ) -> None:
        final_message = message or self.default_message
        super().__init__(final_message)
        self.message = final_message
        self.hint = hint
        if code is not None:
            self.code = code
        if status_code is not None:
            self.status_code = status_code

    def to_dict(self) -> dict[str, Any]:
        return format_error_payload(self.code, self.message, self.hint)


class ValidationError(BackendError):
    status_code = 422
    code = "validation_error"
    default_message = "A megadott adatok érvénytelenek vagy hiányosak."


class NotFoundError(BackendError):
    status_code = 404
    code = "not_found"
    default_message = "A keresett adat nem található."


class ConflictError(BackendError):
    status_code = 409
    code = "conflict"
    default_message = "A művelet ütközik egy meglévő családfabeli szabállyal."


class PackageError(BackendError):
    status_code = 400
    code = "package_error"
    default_message = "Hiba történt a .ftree csomag kezelése közben."


@dataclass(slots=True)
class Person:
    id: str
    full_name: str
    birth_name: str
    gender: str
    birth_date: str
    death_date: str
    is_living: bool
    avatar_path: str
    notes: str
    created_at: str
    updated_at: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class UnionRecord:
    id: str
    partner1_id: str
    partner2_id: str | None
    status: str
    start_date: str
    end_date: str
    notes: str
    created_at: str
    updated_at: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class ParentChild:
    child_id: str
    parent_id: str
    union_id: str | None
    relation_type: str
    created_at: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class SourceRecord:
    id: str
    source_type: str
    title: str
    reference: str
    notes: str
    created_at: str
    updated_at: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class PersonSourceLink:
    person_id: str
    source_id: str
    citation_note: str
    created_at: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class TreeMeta:
    format: str
    format_version: int
    schema_version: int
    tree_name: str
    app_version: str
    created_at: str
    updated_at: str
    person_count: int = 0
    union_count: int = 0
    relation_count: int = 0
    checksum_algorithm: str = "sha256"
    checksums: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
