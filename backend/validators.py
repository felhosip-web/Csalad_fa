"""Input validators and partial date normalization for genealogy records."""

from __future__ import annotations

import calendar
import re
from datetime import datetime, timezone

from .models import ValidationError

ALLOWED_GENDERS = frozenset({"male", "female", "other", "unknown"})
ALLOWED_UNION_STATUSES = frozenset(
    {"married", "divorced", "partner", "widowed", "separated", "unknown"}
)
ALLOWED_RELATION_TYPES = frozenset(
    {"biological", "adoptive", "step", "foster", "guardian"}
)

_APPROX_PREFIX_RE = re.compile(r"^(?:~|kb\.?|ca\.?|circa)\s*", re.IGNORECASE)
_YEAR_RE = re.compile(r"^(\d{4})$")
_YEAR_MONTH_RE = re.compile(r"^(\d{4})[-./\s]+(\d{1,2})\.?$")
_FULL_DATE_RE = re.compile(r"^(\d{4})[-./\s]+(\d{1,2})[-./\s]+(\d{1,2})\.?$")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalize_text(value: object, *, max_length: int = 5000) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValidationError("A szöveges mező formátuma érvénytelen.")
    cleaned = value.strip()
    if len(cleaned) > max_length:
        raise ValidationError(f"A szöveg túl hosszú (maximum {max_length} karakter).")
    return cleaned


def validate_required_name(value: object, field_label: str = "Teljes név") -> str:
    name = normalize_text(value, max_length=200)
    if not name:
        raise ValidationError(f"A(z) {field_label} megadása kötelező.")
    return name


def validate_gender(value: object) -> str:
    if value is None or value == "":
        return "unknown"
    if not isinstance(value, str):
        raise ValidationError("Érvénytelen nem (gender) érték.")
    normalized = value.strip().lower()
    if normalized not in ALLOWED_GENDERS:
        raise ValidationError(
            f"Érvénytelen nem: '{value}'. Engedélyezett értékek: {', '.join(sorted(ALLOWED_GENDERS))}."
        )
    return normalized


def validate_union_status(value: object) -> str:
    if value is None or value == "":
        return "married"
    if not isinstance(value, str):
        raise ValidationError("Érvénytelen kapcsolat állapot.")
    normalized = value.strip().lower()
    if normalized not in ALLOWED_UNION_STATUSES:
        raise ValidationError(
            f"Érvénytelen kapcsolat állapot: '{value}'. Engedélyezett értékek: {', '.join(sorted(ALLOWED_UNION_STATUSES))}."
        )
    return normalized


def validate_relation_type(value: object) -> str:
    if value is None or value == "":
        return "biological"
    if not isinstance(value, str):
        raise ValidationError("Érvénytelen szülő-gyermek kapcsolat típus.")
    normalized = value.strip().lower()
    if normalized not in ALLOWED_RELATION_TYPES:
        raise ValidationError(
            f"Érvénytelen kapcsolat típus: '{value}'. Engedélyezett értékek: {', '.join(sorted(ALLOWED_RELATION_TYPES))}."
        )
    return normalized


def normalize_partial_date(value: object, *, field_label: str = "Dátum") -> str:
    """Validate and normalize partial or full dates.

    Accepted inputs:
    - "" / None -> ""
    - "1954" -> "1954"
    - "1954-06" / "1954.06." -> "1954-06"
    - "1954-06-15" / "1954.06.15." / "1954. 06. 15." -> "1954-06-15"
    - Optional approximate prefix: "~1954", "kb. 1954", "ca. 1954-06" -> "~1954", "~1954-06"
    """
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValidationError(f"A(z) {field_label} mező csak szöveg lehet.")

    raw = value.strip()
    if not raw:
        return ""

    approx = False
    if _APPROX_PREFIX_RE.match(raw):
        approx = True
        raw = _APPROX_PREFIX_RE.sub("", raw).strip()

    if not raw:
        raise ValidationError(f"A(z) {field_label} nem tartalmaz érvényes évszámot.")

    prefix = "~" if approx else ""

    m_year = _YEAR_RE.match(raw)
    if m_year:
        year = int(m_year.group(1))
        _validate_year(year, field_label)
        return f"{prefix}{year:04d}"

    m_ym = _YEAR_MONTH_RE.match(raw)
    if m_ym:
        year = int(m_ym.group(1))
        month = int(m_ym.group(2))
        _validate_year(year, field_label)
        if not 1 <= month <= 12:
            raise ValidationError(f"Érvénytelen hónap a(z) {field_label} mezőben: {month}.")
        return f"{prefix}{year:04d}-{month:02d}"

    m_full = _FULL_DATE_RE.match(raw)
    if m_full:
        year = int(m_full.group(1))
        month = int(m_full.group(2))
        day = int(m_full.group(3))
        _validate_year(year, field_label)
        if not 1 <= month <= 12:
            raise ValidationError(f"Érvénytelen hónap a(z) {field_label} mezőben: {month}.")
        max_day = calendar.monthrange(year, month)[1]
        if not 1 <= day <= max_day:
            raise ValidationError(
                f"Érvénytelen nap a(z) {field_label} mezőben ({year:04d}-{month:02d}-{day:02d})."
            )
        return f"{prefix}{year:04d}-{month:02d}-{day:02d}"

    raise ValidationError(
        f"Érvénytelen {field_label.lower()} formátum: '{value}'. Használj pl. '1954', '1954-06', '1954-06-15' vagy '~1954' formátumot."
    )


def _validate_year(year: int, field_label: str) -> None:
    if year < 1 or year > 2999:
        raise ValidationError(f"Érvénytelen évszám a(z) {field_label} mezőben: {year}.")


def parse_bool_flag(value: object, *, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        low = value.strip().lower()
        if low in ("true", "1", "yes", "igen"):
            return True
        if low in ("false", "0", "no", "nem"):
            return False
    raise ValidationError("Érvénytelen logikai (is_living) érték.")
