"""GEDCOM 5.5.1 (.ged) UTF-8 import and export for persons, families, and sources."""

from __future__ import annotations

import calendar
import re
from dataclasses import dataclass, field
from typing import Any

from .models import PackageError, ParentChild, Person, PersonSourceLink, SourceRecord, UnionRecord
from .validators import ALLOWED_RELATION_TYPES, ALLOWED_SOURCE_TYPES, ALLOWED_UNION_STATUSES
from .version import BACKEND_VERSION

_MONTH_NUM_TO_GED = {
    1: "JAN",
    2: "FEB",
    3: "MAR",
    4: "APR",
    5: "MAY",
    6: "JUN",
    7: "JUL",
    8: "AUG",
    9: "SEP",
    10: "OCT",
    11: "NOV",
    12: "DEC",
}
_MONTH_GED_TO_NUM = {v: k for k, v in _MONTH_NUM_TO_GED.items()}

_GED_LINE_RE = re.compile(r"^\s*(\d+)\s+(?:(@[^@]+@)\s+)?([A-Za-z0-9_]+)(?:\s(.*))?$")
_ISO_DATE_RE = re.compile(r"^(~?)(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$")


@dataclass
class _GedNode:
    level: int
    tag: str
    value: str
    xref: str | None = None
    children: list[_GedNode] = field(default_factory=list)


@dataclass
class ParsedGedcomData:
    tree_name: str
    persons: list[dict[str, Any]]
    unions: list[dict[str, Any]]
    relations: list[dict[str, Any]]
    sources: list[dict[str, Any]]
    person_sources: list[dict[str, Any]]


def _format_gedcom_date(normalized: str) -> str:
    raw = (normalized or "").strip()
    if not raw:
        return ""
    match = _ISO_DATE_RE.match(raw)
    if not match:
        return raw
    approx = bool(match.group(1))
    year = int(match.group(2))
    month = int(match.group(3)) if match.group(3) else None
    day = int(match.group(4)) if match.group(4) else None

    if month and day:
        base = f"{day} {_MONTH_NUM_TO_GED[month]} {year:04d}"
    elif month:
        base = f"{_MONTH_NUM_TO_GED[month]} {year:04d}"
    else:
        base = f"{year:04d}"
    return f"ABT {base}" if approx else base


def _parse_gedcom_date(raw_value: str) -> str:
    raw = (raw_value or "").strip()
    if not raw:
        return ""

    approx = False
    upper = raw.upper()
    for prefix in ("ABT ", "EST ", "CAL ", "CA ", "CIRCA ", "~", "KB. ", "KB "):
        if upper.startswith(prefix):
            approx = True
            raw = raw[len(prefix) :].strip()
            upper = raw.upper()
            break

    # Handle range/qualifier prefixes gracefully by extracting the primary date
    for prefix in ("BEF ", "AFT "):
        if upper.startswith(prefix):
            approx = True
            raw = raw[len(prefix) :].strip()
            upper = raw.upper()
            break
    if upper.startswith("BET ") and " AND " in upper:
        approx = True
        idx = upper.index(" AND ")
        raw = raw[4:idx].strip()
        upper = raw.upper()

    # Exact DD MON YYYY
    m_dmy = re.match(r"^(\d{1,2})\s+([A-Z]{3})\s+(\d{4})$", upper)
    if m_dmy:
        day = int(m_dmy.group(1))
        month = _MONTH_GED_TO_NUM.get(m_dmy.group(2))
        year = int(m_dmy.group(3))
        if month and 1 <= year <= 2999:
            max_day = calendar.monthrange(year, month)[1]
            if 1 <= day <= max_day:
                return f"{'~' if approx else ''}{year:04d}-{month:02d}-{day:02d}"

    # MON YYYY
    m_my = re.match(r"^([A-Z]{3})\s+(\d{4})$", upper)
    if m_my:
        month = _MONTH_GED_TO_NUM.get(m_my.group(1))
        year = int(m_my.group(2))
        if month and 1 <= year <= 2999:
            return f"{'~' if approx else ''}{year:04d}-{month:02d}"

    # YYYY-MM-DD or YYYY.MM.DD
    m_iso = re.match(r"^(\d{4})[-./](\d{1,2})(?:[-./](\d{1,2}))?\.?$", raw)
    if m_iso:
        year = int(m_iso.group(1))
        month = int(m_iso.group(2))
        day = int(m_iso.group(3)) if m_iso.group(3) else None
        if 1 <= year <= 2999 and 1 <= month <= 12:
            if day is None:
                return f"{'~' if approx else ''}{year:04d}-{month:02d}"
            max_day = calendar.monthrange(year, month)[1]
            if 1 <= day <= max_day:
                return f"{'~' if approx else ''}{year:04d}-{month:02d}-{day:02d}"

    # Plain 4-digit year fallback
    m_year = re.search(r"\b(\d{4})\b", raw)
    if m_year:
        year = int(m_year.group(1))
        if 1 <= year <= 2999:
            return f"{'~' if approx else ''}{year:04d}"

    return ""


def _format_gedcom_name(full_name: str) -> str:
    parts = full_name.strip().split()
    if len(parts) <= 1:
        return full_name.strip()
    return f"/{parts[0]}/ {' '.join(parts[1:])}"


def _clean_gedcom_name(raw_name: str) -> str:
    return " ".join(raw_name.replace("/", " ").split()).strip()


def _emit_multiline(lines: list[str], level: int, tag: str, text: str) -> None:
    clean = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    rows = clean.split("\n")
    lines.append(f"{level} {tag} {rows[0]}".rstrip())
    for extra in rows[1:]:
        lines.append(f"{level + 1} CONT {extra}".rstrip())


def export_gedcom_text(
    *,
    tree_name: str,
    persons: list[Person],
    unions: list[UnionRecord],
    relations: list[ParentChild],
    sources: list[SourceRecord],
    person_sources: list[PersonSourceLink],
) -> str:
    """Serialize the active family tree into UTF-8 GEDCOM 5.5.1 text."""
    person_xref: dict[str, str] = {p.id: f"@I{idx + 1}@" for idx, p in enumerate(persons)}
    source_xref: dict[str, str] = {s.id: f"@S{idx + 1}@" for idx, s in enumerate(sources)}

    # Build family groups: existing unions + synthetic single-parent families for unlinked relations
    families: list[dict[str, Any]] = []
    union_to_fam_idx: dict[str, int] = {}

    for u in unions:
        fam_idx = len(families)
        union_to_fam_idx[u.id] = fam_idx
        families.append(
            {
                "xref": f"@F{fam_idx + 1}@",
                "partner1_id": u.partner1_id,
                "partner2_id": u.partner2_id,
                "status": u.status,
                "start_date": u.start_date,
                "end_date": u.end_date,
                "notes": u.notes,
                "children": [],  # list of (child_id, relation_type)
            }
        )

    single_parent_fam_idx: dict[str, int] = {}
    seen_fam_child: set[tuple[int, str]] = set()
    person_famc: dict[str, list[tuple[str, str]]] = {}
    person_fams: dict[str, list[str]] = {}

    # Pre-register FAMS for unions
    for fam in families:
        if fam["partner1_id"]:
            person_fams.setdefault(fam["partner1_id"], []).append(fam["xref"])
        if fam["partner2_id"]:
            person_fams.setdefault(fam["partner2_id"], []).append(fam["xref"])

    for rel in relations:
        if rel.union_id and rel.union_id in union_to_fam_idx:
            fam_idx = union_to_fam_idx[rel.union_id]
        else:
            if rel.parent_id not in single_parent_fam_idx:
                fam_idx = len(families)
                xref = f"@F{fam_idx + 1}@"
                single_parent_fam_idx[rel.parent_id] = fam_idx
                families.append(
                    {
                        "xref": xref,
                        "partner1_id": rel.parent_id,
                        "partner2_id": None,
                        "status": "unknown",
                        "start_date": "",
                        "end_date": "",
                        "notes": "",
                        "children": [],
                    }
                )
                person_fams.setdefault(rel.parent_id, []).append(xref)
            fam_idx = single_parent_fam_idx[rel.parent_id]

        fam_xref = families[fam_idx]["xref"]
        if (fam_idx, rel.child_id) not in seen_fam_child:
            seen_fam_child.add((fam_idx, rel.child_id))
            families[fam_idx]["children"].append((rel.child_id, rel.relation_type))
            person_famc.setdefault(rel.child_id, []).append((fam_xref, rel.relation_type))

    person_by_id = {p.id: p for p in persons}
    sources_by_person: dict[str, list[PersonSourceLink]] = {}
    for link in person_sources:
        if link.source_id in source_xref:
            sources_by_person.setdefault(link.person_id, []).append(link)

    lines: list[str] = [
        "0 HEAD",
        "1 SOUR Csaladfa",
        f"2 VERS {BACKEND_VERSION}",
        "2 NAME Családfa",
        "1 GEDC",
        "2 VERS 5.5.1",
        "2 FORM LINEAGE-LINKED",
        "1 CHAR UTF-8",
        f"1 _TREE {tree_name or 'Új családfa'}",
        f"1 NOTE {tree_name or 'Új családfa'}",
    ]

    for p in persons:
        xref = person_xref[p.id]
        lines.append(f"0 {xref} INDI")
        lines.append(f"1 NAME {_format_gedcom_name(p.full_name)}")
        if p.birth_name.strip():
            lines.append(f"1 NAME {_format_gedcom_name(p.birth_name)}")
            lines.append("2 TYPE maiden")

        sex = "M" if p.gender == "male" else "F" if p.gender == "female" else "X" if p.gender == "other" else "U"
        lines.append(f"1 SEX {sex}")

        if p.birth_date:
            lines.append("1 BIRT")
            lines.append(f"2 DATE {_format_gedcom_date(p.birth_date)}")

        if p.death_date:
            lines.append("1 DEAT")
            lines.append(f"2 DATE {_format_gedcom_date(p.death_date)}")
        elif not p.is_living:
            lines.append("1 DEAT Y")

        if p.notes.strip():
            _emit_multiline(lines, 1, "NOTE", p.notes)

        for fam_xref, rel_type in person_famc.get(p.id, []):
            lines.append(f"1 FAMC {fam_xref}")
            pedi = {
                "biological": "birth",
                "adoptive": "adopted",
                "foster": "foster",
            }.get(rel_type)
            if pedi:
                lines.append(f"2 PEDI {pedi}")

        for fam_xref in dict.fromkeys(person_fams.get(p.id, [])):
            lines.append(f"1 FAMS {fam_xref}")

        for link in sources_by_person.get(p.id, []):
            lines.append(f"1 SOUR {source_xref[link.source_id]}")
            if link.citation_note.strip():
                lines.append(f"2 PAGE {link.citation_note.strip()}")

    for fam in families:
        lines.append(f"0 {fam['xref']} FAM")
        p1_id = fam["partner1_id"]
        p2_id = fam["partner2_id"]
        p1 = person_by_id.get(p1_id) if p1_id else None
        p2 = person_by_id.get(p2_id) if p2_id else None

        husb_id: str | None = p1_id
        wife_id: str | None = p2_id
        if p1 and p1.gender == "female" and (not p2 or p2.gender != "female"):
            husb_id, wife_id = p2_id, p1_id

        if husb_id and husb_id in person_xref:
            lines.append(f"1 HUSB {person_xref[husb_id]}")
        if wife_id and wife_id in person_xref:
            lines.append(f"1 WIFE {person_xref[wife_id]}")

        status = fam["status"]
        if status and status != "unknown":
            lines.append(f"1 _USTAT {status}")

        if status in ("married", "divorced", "widowed", "separated", "partner") or fam["start_date"]:
            if status != "unknown" or fam["start_date"]:
                lines.append("1 MARR")
                if fam["start_date"]:
                    lines.append(f"2 DATE {_format_gedcom_date(fam['start_date'])}")

        if status == "divorced" or fam["end_date"]:
            lines.append("1 DIV")
            if fam["end_date"]:
                lines.append(f"2 DATE {_format_gedcom_date(fam['end_date'])}")

        if fam["notes"].strip():
            _emit_multiline(lines, 1, "NOTE", fam["notes"])

        for child_id, rel_type in fam["children"]:
            if child_id in person_xref:
                lines.append(f"1 CHIL {person_xref[child_id]}")
                if rel_type and rel_type != "biological":
                    lines.append(f"2 _PEDI {rel_type}")

    for s in sources:
        xref = source_xref[s.id]
        lines.append(f"0 {xref} SOUR")
        _emit_multiline(lines, 1, "TITL", s.title)
        if s.reference.strip():
            _emit_multiline(lines, 1, "PUBL", s.reference)
        lines.append(f"1 _TYPE {s.source_type}")
        if s.notes.strip():
            _emit_multiline(lines, 1, "NOTE", s.notes)

    lines.append("0 TRLR")
    return "\n".join(lines) + "\n"


def _decode_gedcom_bytes(raw_bytes: bytes) -> str:
    if not raw_bytes or not raw_bytes.strip():
        raise PackageError(
            "A kiválasztott GEDCOM (.ged) fájl üres.",
            code="EMPTY_GEDCOM",
            hint="Válassz ki egy érvényes, adatokat tartalmazó .ged fájlt.",
        )
    if b"\x00" in raw_bytes:
        raise PackageError(
            "A kiválasztott fájl nem szöveges GEDCOM (.ged) formátumú.",
            code="INVALID_GEDCOM",
            hint="Ellenőrizd, hogy nem sérült-e a fájl, vagy valóban .ged fájlt választottál-e ki.",
        )
    for encoding in ("utf-8-sig", "utf-8", "cp1250", "latin-1"):
        try:
            return raw_bytes.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise PackageError(
        "A GEDCOM fájl karakterkódolása nem értelmezhető.",
        code="INVALID_GEDCOM_ENCODING",
        hint="Mentsd el a GEDCOM fájlt UTF-8 kódolással, majd próbáld meg újra.",
    )


def _parse_gedcom_tree(text: str) -> list[_GedNode]:
    roots: list[_GedNode] = []
    stack: list[_GedNode] = []

    for raw_line in text.splitlines():
        if not raw_line.strip():
            continue
        match = _GED_LINE_RE.match(raw_line)
        if not match:
            continue
        level = int(match.group(1))
        xref = match.group(2)
        tag = match.group(3).upper()
        value = (match.group(4) or "").rstrip("\r\n")

        if tag == "CONT" and stack:
            stack[-1].value = f"{stack[-1].value}\n{value}".lstrip("\n") if stack[-1].value else value
            continue
        if tag == "CONC" and stack:
            stack[-1].value = f"{stack[-1].value}{value}"
            continue

        node = _GedNode(level=level, tag=tag, value=value, xref=xref)
        if level == 0:
            roots.append(node)
            stack = [node]
            continue

        while stack and stack[-1].level >= level:
            stack.pop()
        if not stack:
            roots.append(node)
            stack = [node]
        else:
            stack[-1].children.append(node)
            stack.append(node)

    return roots


def _child_map(node: _GedNode) -> dict[str, list[_GedNode]]:
    grouped: dict[str, list[_GedNode]] = {}
    for ch in node.children:
        grouped.setdefault(ch.tag, []).append(ch)
    return grouped


def _infer_source_type(title: str, raw_type: str = "") -> str:
    clean = raw_type.strip().lower()
    if clean in ALLOWED_SOURCE_TYPES:
        return clean
    low = title.lower()
    if any(k in low for k in ("anyakönyv", "birth", "marriage", "death", "church", "egyházi", "keresztel")):
        return "registry"
    if any(k in low for k in ("fotó", "fénykép", "kép", "photo", "portrait")):
        return "photo"
    if any(k in low for k in ("elbeszélés", "interjú", "emlékezet", "oral", "mesél")):
        return "oral_history"
    return "document"


def parse_gedcom_bytes(raw_bytes: bytes, *, override_tree_name: str | None = None) -> ParsedGedcomData:
    """Parse GEDCOM 5.5.1 bytes into normalized persons, unions, parent-child links, and sources."""
    text = _decode_gedcom_bytes(raw_bytes)
    roots = _parse_gedcom_tree(text)
    if not roots or not any(r.tag in ("HEAD", "INDI", "FAM", "SOUR") for r in roots):
        raise PackageError(
            "A kiválasztott fájl nem tartalmaz érvényes GEDCOM szerkezetet.",
            code="INVALID_GEDCOM",
            hint="Ellenőrizd, hogy szabványos GEDCOM (.ged) fájlt töltöttél-e fel.",
        )

    tree_name = (override_tree_name or "").strip() or "Importált családfa"
    sources: list[dict[str, Any]] = []
    source_xref_to_id: dict[str, str] = {}
    inline_source_key_to_id: dict[tuple[str, str], str] = {}

    # 1. Header + Sources
    for node in roots:
        if node.tag == "HEAD" and not override_tree_name:
            cmap = _child_map(node)
            tree_tag = cmap.get("_TREE") or cmap.get("NOTE")
            if tree_tag and tree_tag[0].value.strip():
                tree_name = tree_tag[0].value.strip()[:120]

        elif node.tag == "SOUR" and node.xref:
            cmap = _child_map(node)
            title = (
                (cmap.get("TITL") or cmap.get("ABBR") or cmap.get("TEXT") or [None])[0]
            )
            title_val = title.value.strip() if title and title.value.strip() else f"Forrás ({node.xref.strip('@')})"
            ref_node = (cmap.get("PUBL") or cmap.get("AUTH") or cmap.get("REPO") or [None])[0]
            ref_val = ref_node.value.strip() if ref_node else ""
            raw_type = cmap["_TYPE"][0].value if "_TYPE" in cmap else ""
            note_val = "\n".join(n.value for n in cmap.get("NOTE", []) if n.value.strip())
            sid = f"ged_src_{len(sources) + 1}"
            source_xref_to_id[node.xref] = sid
            sources.append(
                {
                    "id": sid,
                    "source_type": _infer_source_type(title_val, raw_type),
                    "title": title_val[:200],
                    "reference": ref_val[:500],
                    "notes": note_val[:5000],
                }
            )

    # 2. Individuals
    persons: list[dict[str, Any]] = []
    indi_xref_to_id: dict[str, str] = {}
    person_sources: list[dict[str, Any]] = []
    seen_person_source: set[tuple[str, str]] = set()
    indi_famc_pedi: dict[tuple[str, str], str] = {}

    for node in roots:
        if node.tag != "INDI":
            continue
        cmap = _child_map(node)
        name_nodes = cmap.get("NAME", [])
        full_name = ""
        birth_name = ""
        for idx, n in enumerate(name_nodes):
            cleaned = _clean_gedcom_name(n.value)
            if not cleaned:
                continue
            sub = _child_map(n)
            ntype = sub["TYPE"][0].value.strip().lower() if "TYPE" in sub else ""
            if idx == 0 and not full_name:
                full_name = cleaned
            elif ntype in ("maiden", "birth", "leánykori", "születési") or not birth_name:
                if cleaned != full_name:
                    birth_name = cleaned

        if not full_name:
            full_name = f"Ismeretlen személy ({(node.xref or str(len(persons) + 1)).strip('@')})"

        sex_raw = cmap["SEX"][0].value.strip().upper() if "SEX" in cmap else "U"
        gender = "male" if sex_raw == "M" else "female" if sex_raw == "F" else "other" if sex_raw == "X" else "unknown"

        birth_date = ""
        if "BIRT" in cmap:
            b_sub = _child_map(cmap["BIRT"][0])
            if "DATE" in b_sub:
                birth_date = _parse_gedcom_date(b_sub["DATE"][0].value)

        death_date = ""
        is_living = True
        if "DEAT" in cmap:
            is_living = False
            d_node = cmap["DEAT"][0]
            d_sub = _child_map(d_node)
            if "DATE" in d_sub:
                death_date = _parse_gedcom_date(d_sub["DATE"][0].value)

        notes = "\n".join(n.value for n in cmap.get("NOTE", []) if n.value.strip())[:5000]
        pid = f"ged_ind_{len(persons) + 1}"
        if node.xref:
            indi_xref_to_id[node.xref] = pid

        persons.append(
            {
                "id": pid,
                "full_name": full_name[:200],
                "birth_name": birth_name[:200],
                "gender": gender,
                "birth_date": birth_date,
                "death_date": death_date,
                "is_living": is_living,
                "notes": notes,
            }
        )

        for famc_node in cmap.get("FAMC", []):
            fam_xref = famc_node.value.strip()
            f_sub = _child_map(famc_node)
            if fam_xref and "PEDI" in f_sub:
                pedi_raw = f_sub["PEDI"][0].value.strip().lower()
                mapped_pedi = {
                    "birth": "biological",
                    "adopted": "adoptive",
                    "foster": "foster",
                }.get(pedi_raw, pedi_raw if pedi_raw in ALLOWED_RELATION_TYPES else "biological")
                indi_famc_pedi[(fam_xref, pid)] = mapped_pedi

        for s_node in cmap.get("SOUR", []):
            s_val = s_node.value.strip()
            s_sub = _child_map(s_node)
            cit_node = (s_sub.get("PAGE") or s_sub.get("TEXT") or [None])[0]
            citation_note = cit_node.value.strip()[:500] if cit_node else ""
            sid: str | None = None
            if s_val.startswith("@") and s_val.endswith("@") and s_val in source_xref_to_id:
                sid = source_xref_to_id[s_val]
            elif s_val:
                key = ("document", s_val[:200])
                if key not in inline_source_key_to_id:
                    sid = f"ged_src_{len(sources) + 1}"
                    inline_source_key_to_id[key] = sid
                    sources.append(
                        {
                            "id": sid,
                            "source_type": _infer_source_type(s_val),
                            "title": s_val[:200],
                            "reference": "",
                            "notes": "",
                        }
                    )
                else:
                    sid = inline_source_key_to_id[key]
            if sid and (pid, sid) not in seen_person_source:
                seen_person_source.add((pid, sid))
                person_sources.append(
                    {
                        "person_id": pid,
                        "source_id": sid,
                        "citation_note": citation_note,
                    }
                )

    if not persons:
        raise PackageError(
            "A GEDCOM fájl nem tartalmaz egyetlen személyt (INDI) sem.",
            code="EMPTY_GEDCOM_RECORDS",
            hint="Legalább egy személy bejegyzése szükséges a családfa betöltéséhez.",
        )

    # 3. Families -> Unions + ParentChild relations
    unions: list[dict[str, Any]] = []
    relations: list[dict[str, Any]] = []
    seen_rel: set[tuple[str, str]] = set()

    for node in roots:
        if node.tag != "FAM":
            continue
        cmap = _child_map(node)
        husb_xref = cmap["HUSB"][0].value.strip() if "HUSB" in cmap else ""
        wife_xref = cmap["WIFE"][0].value.strip() if "WIFE" in cmap else ""
        p1_id = indi_xref_to_id.get(husb_xref)
        p2_id = indi_xref_to_id.get(wife_xref)
        if p1_id is None and p2_id is not None:
            p1_id, p2_id = p2_id, None
        if p1_id is not None and p2_id == p1_id:
            p2_id = None

        start_date = ""
        if "MARR" in cmap:
            m_sub = _child_map(cmap["MARR"][0])
            if "DATE" in m_sub:
                start_date = _parse_gedcom_date(m_sub["DATE"][0].value)

        end_date = ""
        if "DIV" in cmap:
            d_sub = _child_map(cmap["DIV"][0])
            if "DATE" in d_sub:
                end_date = _parse_gedcom_date(d_sub["DATE"][0].value)

        raw_ustat = cmap["_USTAT"][0].value.strip().lower() if "_USTAT" in cmap else ""
        if raw_ustat in ALLOWED_UNION_STATUSES:
            status = raw_ustat
        elif "DIV" in cmap:
            status = "divorced"
        elif "MARR" in cmap:
            status = "married"
        else:
            status = "partner" if p2_id else "unknown"

        notes = "\n".join(n.value for n in cmap.get("NOTE", []) if n.value.strip())[:2000]

        has_union_event = "MARR" in cmap or "DIV" in cmap or bool(raw_ustat) or bool(notes)
        union_id: str | None = None
        if p1_id and (p2_id is not None or has_union_event):
            union_id = f"ged_uni_{len(unions) + 1}"
            unions.append(
                {
                    "id": union_id,
                    "partner1_id": p1_id,
                    "partner2_id": p2_id,
                    "status": status,
                    "start_date": start_date,
                    "end_date": end_date,
                    "notes": notes,
                }
            )

        fam_xref = node.xref or ""
        for chil_node in cmap.get("CHIL", []):
            child_xref = chil_node.value.strip()
            child_id = indi_xref_to_id.get(child_xref)
            if not child_id:
                continue
            c_sub = _child_map(chil_node)
            pedi_custom = c_sub["_PEDI"][0].value.strip().lower() if "_PEDI" in c_sub else ""
            if pedi_custom in ALLOWED_RELATION_TYPES:
                rel_type = pedi_custom
            else:
                rel_type = indi_famc_pedi.get((fam_xref, child_id), "biological")

            for parent_id in (p1_id, p2_id):
                if not parent_id or parent_id == child_id:
                    continue
                if (child_id, parent_id) in seen_rel:
                    continue
                seen_rel.add((child_id, parent_id))
                relations.append(
                    {
                        "child_id": child_id,
                        "parent_id": parent_id,
                        "union_id": union_id,
                        "relation_type": rel_type,
                    }
                )

    return ParsedGedcomData(
        tree_name=tree_name,
        persons=persons,
        unions=unions,
        relations=relations,
        sources=sources,
        person_sources=person_sources,
    )
