"""Parameterized SQLite repository for persons, unions, and parent-child relations."""

from __future__ import annotations

import sqlite3
import uuid
from typing import Any

from .models import (
    NotFoundError,
    ParentChild,
    Person,
    PersonSourceLink,
    SourceRecord,
    UnionRecord,
)
from .validators import utc_now_iso


def _row_to_person(row: sqlite3.Row) -> Person:
    return Person(
        id=str(row["id"]),
        full_name=str(row["full_name"]),
        birth_name=str(row["birth_name"]),
        gender=str(row["gender"]),
        birth_date=str(row["birth_date"]),
        death_date=str(row["death_date"]),
        is_living=bool(row["is_living"]),
        avatar_path=str(row["avatar_path"]),
        notes=str(row["notes"]),
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )


def _row_to_union(row: sqlite3.Row) -> UnionRecord:
    return UnionRecord(
        id=str(row["id"]),
        partner1_id=str(row["partner1_id"]),
        partner2_id=str(row["partner2_id"]) if row["partner2_id"] is not None else None,
        status=str(row["status"]),
        start_date=str(row["start_date"]),
        end_date=str(row["end_date"]),
        notes=str(row["notes"]),
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )


def _row_to_parent_child(row: sqlite3.Row) -> ParentChild:
    return ParentChild(
        child_id=str(row["child_id"]),
        parent_id=str(row["parent_id"]),
        union_id=str(row["union_id"]) if row["union_id"] is not None else None,
        relation_type=str(row["relation_type"]),
        created_at=str(row["created_at"]),
    )


def _row_to_source(row: sqlite3.Row) -> SourceRecord:
    return SourceRecord(
        id=str(row["id"]),
        source_type=str(row["source_type"]),
        title=str(row["title"]),
        reference=str(row["reference"]),
        notes=str(row["notes"]),
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )


def _row_to_person_source(row: sqlite3.Row) -> PersonSourceLink:
    return PersonSourceLink(
        person_id=str(row["person_id"]),
        source_id=str(row["source_id"]),
        citation_note=str(row["citation_note"]),
        created_at=str(row["created_at"]),
    )


class FamilyRepository:
    """Thin, parameterized SQLite data-access layer."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    # --- Settings ---
    def get_tree_name(self) -> str:
        row = self.conn.execute(
            "SELECT value FROM tree_settings WHERE key = 'tree_name';"
        ).fetchone()
        return str(row["value"]) if row else "Új családfa"

    def set_tree_name(self, name: str) -> str:
        now = utc_now_iso()
        self.conn.execute(
            """
            INSERT INTO tree_settings (key, value, updated_at)
            VALUES ('tree_name', ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
            """,
            (name, now),
        )
        self.conn.commit()
        return name

    # --- Persons ---
    def list_persons(self, search: str = "") -> list[Person]:
        query = search.strip()
        if query:
            like = f"%{query}%"
            rows = self.conn.execute(
                """
                SELECT * FROM persons
                WHERE full_name LIKE ? COLLATE NOCASE
                   OR birth_name LIKE ? COLLATE NOCASE
                ORDER BY full_name COLLATE NOCASE ASC;
                """,
                (like, like),
            ).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT * FROM persons ORDER BY created_at ASC, full_name COLLATE NOCASE ASC;"
            ).fetchall()
        return [_row_to_person(r) for r in rows]

    def get_person(self, person_id: str) -> Person:
        row = self.conn.execute("SELECT * FROM persons WHERE id = ?;", (person_id,)).fetchone()
        if row is None:
            raise NotFoundError("A keresett személy nem található.")
        return _row_to_person(row)

    def create_person(
        self,
        *,
        full_name: str,
        birth_name: str = "",
        gender: str = "unknown",
        birth_date: str = "",
        death_date: str = "",
        is_living: bool = True,
        avatar_path: str = "",
        notes: str = "",
        person_id: str | None = None,
    ) -> Person:
        pid = person_id or uuid.uuid4().hex
        now = utc_now_iso()
        self.conn.execute(
            """
            INSERT INTO persons (
                id, full_name, birth_name, gender, birth_date, death_date,
                is_living, avatar_path, notes, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
            """,
            (
                pid,
                full_name,
                birth_name,
                gender,
                birth_date,
                death_date,
                1 if is_living else 0,
                avatar_path,
                notes,
                now,
                now,
            ),
        )
        self.conn.commit()
        return self.get_person(pid)

    def update_person(self, person_id: str, fields: dict[str, Any]) -> Person:
        existing = self.get_person(person_id)
        now = utc_now_iso()
        self.conn.execute(
            """
            UPDATE persons
            SET full_name = ?,
                birth_name = ?,
                gender = ?,
                birth_date = ?,
                death_date = ?,
                is_living = ?,
                avatar_path = ?,
                notes = ?,
                updated_at = ?
            WHERE id = ?;
            """,
            (
                fields.get("full_name", existing.full_name),
                fields.get("birth_name", existing.birth_name),
                fields.get("gender", existing.gender),
                fields.get("birth_date", existing.birth_date),
                fields.get("death_date", existing.death_date),
                1 if fields.get("is_living", existing.is_living) else 0,
                fields.get("avatar_path", existing.avatar_path),
                fields.get("notes", existing.notes),
                now,
                person_id,
            ),
        )
        self.conn.commit()
        return self.get_person(person_id)

    def delete_person(self, person_id: str) -> Person:
        person = self.get_person(person_id)
        # Clean up any unions where person was partner1 or partner2 if union becomes empty
        self.conn.execute(
            "DELETE FROM unions WHERE partner1_id = ? AND partner2_id IS NULL;",
            (person_id,),
        )
        # If person was partner1 and partner2 exists, promote partner2 -> partner1 before cascade
        rows = self.conn.execute(
            "SELECT id, partner2_id FROM unions WHERE partner1_id = ? AND partner2_id IS NOT NULL;",
            (person_id,),
        ).fetchall()
        now = utc_now_iso()
        for r in rows:
            self.conn.execute(
                "UPDATE unions SET partner1_id = ?, partner2_id = NULL, updated_at = ? WHERE id = ?;",
                (r["partner2_id"], now, r["id"]),
            )
        self.conn.execute("DELETE FROM persons WHERE id = ?;", (person_id,))
        self.conn.commit()
        return person

    # --- Unions ---
    def list_unions(self) -> list[UnionRecord]:
        rows = self.conn.execute(
            "SELECT * FROM unions ORDER BY created_at ASC;"
        ).fetchall()
        return [_row_to_union(r) for r in rows]

    def list_unions_for_person(self, person_id: str) -> list[UnionRecord]:
        rows = self.conn.execute(
            """
            SELECT * FROM unions
            WHERE partner1_id = ? OR partner2_id = ?
            ORDER BY start_date ASC, created_at ASC;
            """,
            (person_id, person_id),
        ).fetchall()
        return [_row_to_union(r) for r in rows]

    def get_union(self, union_id: str) -> UnionRecord:
        row = self.conn.execute("SELECT * FROM unions WHERE id = ?;", (union_id,)).fetchone()
        if row is None:
            raise NotFoundError("A keresett párkapcsolat vagy házasság nem található.")
        return _row_to_union(row)

    def create_union(
        self,
        *,
        partner1_id: str,
        partner2_id: str | None,
        status: str = "married",
        start_date: str = "",
        end_date: str = "",
        notes: str = "",
        union_id: str | None = None,
    ) -> UnionRecord:
        uid = union_id or uuid.uuid4().hex
        now = utc_now_iso()
        self.conn.execute(
            """
            INSERT INTO unions (
                id, partner1_id, partner2_id, status, start_date, end_date, notes, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
            """,
            (uid, partner1_id, partner2_id, status, start_date, end_date, notes, now, now),
        )
        self.conn.commit()
        return self.get_union(uid)

    def update_union(self, union_id: str, fields: dict[str, Any]) -> UnionRecord:
        existing = self.get_union(union_id)
        now = utc_now_iso()
        self.conn.execute(
            """
            UPDATE unions
            SET partner1_id = ?,
                partner2_id = ?,
                status = ?,
                start_date = ?,
                end_date = ?,
                notes = ?,
                updated_at = ?
            WHERE id = ?;
            """,
            (
                fields.get("partner1_id", existing.partner1_id),
                fields.get("partner2_id", existing.partner2_id),
                fields.get("status", existing.status),
                fields.get("start_date", existing.start_date),
                fields.get("end_date", existing.end_date),
                fields.get("notes", existing.notes),
                now,
                union_id,
            ),
        )
        self.conn.commit()
        return self.get_union(union_id)

    def delete_union(self, union_id: str) -> UnionRecord:
        union = self.get_union(union_id)
        self.conn.execute("DELETE FROM unions WHERE id = ?;", (union_id,))
        self.conn.commit()
        return union

    # --- Parent-Child Relations ---
    def list_parent_child(self) -> list[ParentChild]:
        rows = self.conn.execute(
            "SELECT * FROM parent_child ORDER BY created_at ASC;"
        ).fetchall()
        return [_row_to_parent_child(r) for r in rows]

    def get_parents_of(self, child_id: str) -> list[ParentChild]:
        rows = self.conn.execute(
            "SELECT * FROM parent_child WHERE child_id = ? ORDER BY created_at ASC;",
            (child_id,),
        ).fetchall()
        return [_row_to_parent_child(r) for r in rows]

    def get_children_of(self, parent_id: str) -> list[ParentChild]:
        rows = self.conn.execute(
            "SELECT * FROM parent_child WHERE parent_id = ? ORDER BY created_at ASC;",
            (parent_id,),
        ).fetchall()
        return [_row_to_parent_child(r) for r in rows]

    def get_children_of_union(self, union_id: str) -> list[ParentChild]:
        rows = self.conn.execute(
            "SELECT * FROM parent_child WHERE union_id = ? ORDER BY created_at ASC;",
            (union_id,),
        ).fetchall()
        return [_row_to_parent_child(r) for r in rows]

    def get_relation(self, child_id: str, parent_id: str) -> ParentChild:
        row = self.conn.execute(
            "SELECT * FROM parent_child WHERE child_id = ? AND parent_id = ?;",
            (child_id, parent_id),
        ).fetchone()
        if row is None:
            raise NotFoundError("A szülő–gyermek kapcsolat nem található.")
        return _row_to_parent_child(row)

    def upsert_parent_child(
        self,
        *,
        child_id: str,
        parent_id: str,
        union_id: str | None = None,
        relation_type: str = "biological",
    ) -> ParentChild:
        now = utc_now_iso()
        self.conn.execute(
            """
            INSERT INTO parent_child (child_id, parent_id, union_id, relation_type, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(child_id, parent_id) DO UPDATE SET
                union_id = excluded.union_id,
                relation_type = excluded.relation_type;
            """,
            (child_id, parent_id, union_id, relation_type, now),
        )
        self.conn.commit()
        return self.get_relation(child_id, parent_id)

    def delete_parent_child(self, child_id: str, parent_id: str) -> None:
        self.get_relation(child_id, parent_id)
        self.conn.execute(
            "DELETE FROM parent_child WHERE child_id = ? AND parent_id = ?;",
            (child_id, parent_id),
        )
        self.conn.commit()

    # --- Sources & Citations ---
    def list_sources(self, search: str = "") -> list[SourceRecord]:
        query = search.strip()
        if query:
            like = f"%{query}%"
            rows = self.conn.execute(
                """
                SELECT * FROM sources
                WHERE title LIKE ? COLLATE NOCASE
                   OR reference LIKE ? COLLATE NOCASE
                ORDER BY title COLLATE NOCASE ASC;
                """,
                (like, like),
            ).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT * FROM sources ORDER BY created_at ASC, title COLLATE NOCASE ASC;"
            ).fetchall()
        return [_row_to_source(r) for r in rows]

    def get_source(self, source_id: str) -> SourceRecord:
        row = self.conn.execute("SELECT * FROM sources WHERE id = ?;", (source_id,)).fetchone()
        if row is None:
            raise NotFoundError("A keresett forrás nem található.")
        return _row_to_source(row)

    def create_source(
        self,
        *,
        source_type: str = "document",
        title: str,
        reference: str = "",
        notes: str = "",
        source_id: str | None = None,
    ) -> SourceRecord:
        sid = source_id or uuid.uuid4().hex
        now = utc_now_iso()
        self.conn.execute(
            """
            INSERT INTO sources (id, source_type, title, reference, notes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?);
            """,
            (sid, source_type, title, reference, notes, now, now),
        )
        self.conn.commit()
        return self.get_source(sid)

    def update_source(self, source_id: str, fields: dict[str, Any]) -> SourceRecord:
        existing = self.get_source(source_id)
        now = utc_now_iso()
        self.conn.execute(
            """
            UPDATE sources
            SET source_type = ?,
                title = ?,
                reference = ?,
                notes = ?,
                updated_at = ?
            WHERE id = ?;
            """,
            (
                fields.get("source_type", existing.source_type),
                fields.get("title", existing.title),
                fields.get("reference", existing.reference),
                fields.get("notes", existing.notes),
                now,
                source_id,
            ),
        )
        self.conn.commit()
        return self.get_source(source_id)

    def delete_source(self, source_id: str) -> SourceRecord:
        source = self.get_source(source_id)
        self.conn.execute("DELETE FROM sources WHERE id = ?;", (source_id,))
        self.conn.commit()
        return source

    def list_person_sources(self) -> list[PersonSourceLink]:
        rows = self.conn.execute(
            "SELECT * FROM person_sources ORDER BY created_at ASC;"
        ).fetchall()
        return [_row_to_person_source(r) for r in rows]

    def get_sources_for_person(self, person_id: str) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            """
            SELECT
                ps.person_id,
                ps.source_id,
                ps.citation_note,
                ps.created_at AS linked_at,
                s.id,
                s.source_type,
                s.title,
                s.reference,
                s.notes,
                s.created_at,
                s.updated_at
            FROM person_sources ps
            JOIN sources s ON s.id = ps.source_id
            WHERE ps.person_id = ?
            ORDER BY ps.created_at ASC, s.title COLLATE NOCASE ASC;
            """,
            (person_id,),
        ).fetchall()
        result: list[dict[str, Any]] = []
        for r in rows:
            src = _row_to_source(r)
            result.append(
                {
                    "person_id": str(r["person_id"]),
                    "source_id": str(r["source_id"]),
                    "citation_note": str(r["citation_note"]),
                    "created_at": str(r["linked_at"]),
                    "source": src.to_dict(),
                }
            )
        return result

    def link_person_source(
        self,
        *,
        person_id: str,
        source_id: str,
        citation_note: str = "",
    ) -> PersonSourceLink:
        now = utc_now_iso()
        self.conn.execute(
            """
            INSERT INTO person_sources (person_id, source_id, citation_note, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(person_id, source_id) DO UPDATE SET
                citation_note = excluded.citation_note;
            """,
            (person_id, source_id, citation_note, now),
        )
        self.conn.commit()
        row = self.conn.execute(
            "SELECT * FROM person_sources WHERE person_id = ? AND source_id = ?;",
            (person_id, source_id),
        ).fetchone()
        if row is None:
            raise NotFoundError("A forráshivatkozás mentése nem sikerült.")
        return _row_to_person_source(row)

    def unlink_person_source(self, person_id: str, source_id: str) -> None:
        row = self.conn.execute(
            "SELECT 1 FROM person_sources WHERE person_id = ? AND source_id = ?;",
            (person_id, source_id),
        ).fetchone()
        if row is None:
            raise NotFoundError("A személyhez tartozó forráshivatkozás nem található.")
        self.conn.execute(
            "DELETE FROM person_sources WHERE person_id = ? AND source_id = ?;",
            (person_id, source_id),
        )
        self.conn.commit()

