"""Domain models and structured error types for the family tree backend."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


class BackendError(Exception):
    """Base application error carrying an HTTP-friendly status code."""

    status_code: int = 400
    code: str = "bad_request"

    def __init__(self, message: str, *, code: str | None = None, status_code: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        if code is not None:
            self.code = code
        if status_code is not None:
            self.status_code = status_code

    def to_dict(self) -> dict[str, Any]:
        return {"error": {"code": self.code, "message": self.message}}


class ValidationError(BackendError):
    status_code = 422
    code = "validation_error"


class NotFoundError(BackendError):
    status_code = 404
    code = "not_found"


class ConflictError(BackendError):
    status_code = 409
    code = "conflict"


class PackageError(BackendError):
    status_code = 400
    code = "package_error"


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

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
