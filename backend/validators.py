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

_APPROX_PREFIX_RE = re.compile(r"^(?:~|kb\.?|ca\.?|circa|körülbelül)\s*", re.IGNORECASE)
_YEAR_RE = re.compile(r"^(\d{4})\.?$")
_YEAR_MONTH_RE = re.compile(r"^(\d{4})[-./\s]+(\d{1,2})\.?$")
_FULL_DATE_RE = re.compile(r"^(\d{4})[-./\s]+(\d{1,2})[-./\s]+(\d{1,2})\.?$")
_NORMALIZED_DATE_RE = re.compile(r"^~?(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$")

_HU_VOWELS = frozenset("aáeéiíoóöőuúüű")


def _with_article(label: str) -> str:
    clean = label.strip()
    if not clean:
        return "A mező"
    article = "Az" if clean[0].lower() in _HU_VOWELS else "A"
    return f"{article} {clean}"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalize_text(value: object, *, max_length: int = 5000, field_label: str = "szöveges mező") -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValidationError(f"{_with_article(field_label)} csak szöveg lehet.")
    cleaned = value.strip()
    if len(cleaned) > max_length:
        raise ValidationError(
            f"{_with_article(field_label)} túl hosszú (legfeljebb {max_length} karakter lehet)."
        )
    return cleaned


def validate_required_name(value: object, field_label: str = "Teljes név") -> str:
    name = normalize_text(value, max_length=200, field_label=field_label)
    if not name:
        raise ValidationError(f"{_with_article(field_label)} megadása kötelező.")
    return name


def validate_gender(value: object) -> str:
    if value is None or value == "":
        return "unknown"
    if not isinstance(value, str):
        raise ValidationError("A nem mező értéke érvénytelen.")
    normalized = value.strip().lower()
    if normalized not in ALLOWED_GENDERS:
        raise ValidationError(
            f"Érvénytelen nem érték: '{value}'. Válassz a megengedett opciók közül (férfi, nő, egyéb, ismeretlen)."
        )
    return normalized


def validate_union_status(value: object) -> str:
    if value is None or value == "":
        return "married"
    if not isinstance(value, str):
        raise ValidationError("A párkapcsolat állapota érvénytelen.")
    normalized = value.strip().lower()
    if normalized not in ALLOWED_UNION_STATUSES:
        raise ValidationError(
            f"Érvénytelen kapcsolat állapot: '{value}'. Válassz érvényes állapotot (házas, elvált, élettárs, megözvegyült, különélő, ismeretlen)."
        )
    return normalized


def validate_relation_type(value: object) -> str:
    if value is None or value == "":
        return "biological"
    if not isinstance(value, str):
        raise ValidationError("A szülő–gyermek kapcsolat típusa érvénytelen.")
    normalized = value.strip().lower()
    if normalized not in ALLOWED_RELATION_TYPES:
        raise ValidationError(
            f"Érvénytelen rokonsági típus: '{value}'. Engedélyezett: vér szerinti, örökbefogadó, mostoha, nevelő, gyám."
        )
    return normalized


def normalize_partial_date(value: object, *, field_label: str = "Dátum") -> str:
    """Validate and normalize partial or full dates.

    Accepted inputs:
    - "" / None -> ""
    - "1954" / "1954." -> "1954"
    - "1954-06" / "1954. 06." -> "1954-06"
    - "1954-06-15" / "1954. 06. 15." -> "1954-06-15"
    - Optional approximate prefix: "~1920", "kb. 1920", "kb.1920" -> "~1920"
    """
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValidationError(f"{_with_article(field_label)} mező csak szöveg lehet.")

    raw = value.strip()
    if not raw:
        return ""

    approx = False
    if _APPROX_PREFIX_RE.match(raw):
        approx = True
        raw = _APPROX_PREFIX_RE.sub("", raw).strip()

    if not raw:
        raise ValidationError(f"{_with_article(field_label)} nem tartalmaz érvényes évszámot.")

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
            raise ValidationError(
                f"Érvénytelen hónap ({month}) a következő mezőben: {field_label.lower()}."
            )
        return f"{prefix}{year:04d}-{month:02d}"

    m_full = _FULL_DATE_RE.match(raw)
    if m_full:
        year = int(m_full.group(1))
        month = int(m_full.group(2))
        day = int(m_full.group(3))
        _validate_year(year, field_label)
        if not 1 <= month <= 12:
            raise ValidationError(
                f"Érvénytelen hónap ({month}) a következő mezőben: {field_label.lower()}."
            )
        max_day = calendar.monthrange(year, month)[1]
        if not 1 <= day <= max_day:
            raise ValidationError(
                f"Lehetetlen nap ({year:04d}. {month:02d}. {day:02d}.) a következő mezőben: {field_label.lower()}."
            )
        return f"{prefix}{year:04d}-{month:02d}-{day:02d}"

    raise ValidationError(
        f"Érvénytelen {field_label.lower()} formátum: '{value}'. Példa elfogadott formátumokra: 1954, 1954. 06., 1954. 06. 15. vagy kb. 1920."
    )


def _validate_year(year: int, field_label: str) -> None:
    if year < 1 or year > 2999:
        raise ValidationError(
            f"Érvénytelen évszám ({year}) a következő mezőben: {field_label.lower()}."
        )


def _parse_normalized_parts(normalized: str) -> tuple[int, int | None, int | None] | None:
    if not normalized:
        return None
    m = _NORMALIZED_DATE_RE.match(normalized)
    if not m:
        return None
    y = int(m.group(1))
    mo = int(m.group(2)) if m.group(2) is not None else None
    d = int(m.group(3)) if m.group(3) is not None else None
    return y, mo, d


def validate_date_order(
    earlier_date: str,
    later_date: str,
    *,
    earlier_label: str,
    later_label: str,
) -> None:
    """Ensure two normalized partial dates are not in impossible chronological order."""
    p1 = _parse_normalized_parts(earlier_date)
    p2 = _parse_normalized_parts(later_date)
    if p1 is None or p2 is None:
        return

    y1, m1, d1 = p1
    y2, m2, d2 = p2
    if y2 < y1:
        raise ValidationError(
            f"{_with_article(later_label)} ({later_date.lstrip('~')}) nem lehet korábbi, mint {_with_article(earlier_label).lower()} ({earlier_date.lstrip('~')})."
        )
    if y2 == y1 and m1 is not None and m2 is not None:
        if m2 < m1:
            raise ValidationError(
                f"{_with_article(later_label)} nem lehet korábbi, mint {_with_article(earlier_label).lower()}."
            )
        if m2 == m1 and d1 is not None and d2 is not None and d2 < d1:
            raise ValidationError(
                f"{_with_article(later_label)} nem lehet korábbi, mint {_with_article(earlier_label).lower()}."
            )


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
    raise ValidationError("Érvénytelen jelölés a 'Jelenleg élő személy' mezőben.")
