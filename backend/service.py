"""Domain service layer with genealogy invariants, quick-add flows, and packaging."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from pathlib import Path
import sqlite3
import tempfile
from typing import Any

from .db import connect_sqlite
from .gedcom import export_gedcom_text, parse_gedcom_bytes
from .media import (
    _atomic_write_bytes,
    cleanup_unused_avatars,
    delete_media_file,
    resolve_media_path,
    save_portrait_image,
)
from .models import ConflictError, NotFoundError, PackageError, ParentChild, Person, UnionRecord, ValidationError
from .package import (
    export_ftree_package,
    import_ftree_package_checked,
    initialize_workspace,
    read_workspace_meta,
    write_workspace_meta,
)
from .repository import FamilyRepository
from .validators import (
    normalize_partial_date,
    normalize_text,
    parse_bool_flag,
    utc_now_iso,
    validate_date_order,
    validate_gender,
    validate_relation_type,
    validate_required_name,
    validate_source_type,
    validate_union_status,
)


@dataclass
class _UndoSnapshot:
    label: str
    db_bytes: bytes
    media_backups: dict[str, bytes]


MAX_UNDO_STEPS = 25


class FamilyTreeService:
    """High-level genealogy operations over a portable workspace directory."""

    def __init__(self, workspace_dir: str | Path) -> None:
        self.workspace_dir = Path(workspace_dir)
        self.db_path = initialize_workspace(self.workspace_dir)
        self._undo_stack: list[_UndoSnapshot] = []

    def _repo(self) -> tuple[Any, FamilyRepository]:
        conn = connect_sqlite(self.db_path)
        return conn, FamilyRepository(conn)

    def _push_undo(self, label: str, *, media_paths: list[str] | None = None) -> None:
        """Save a lightweight SQLite backup snapshot before a mutating operation."""
        with tempfile.TemporaryDirectory(prefix="ftree_undo_") as tmp_dir:
            snap_path = Path(tmp_dir) / "snap.db"
            src_conn = connect_sqlite(self.db_path)
            try:
                dst_conn = sqlite3.connect(str(snap_path))
                try:
                    src_conn.backup(dst_conn)
                    dst_conn.commit()
                finally:
                    dst_conn.close()
            finally:
                src_conn.close()
            db_bytes = snap_path.read_bytes()

        media_backups: dict[str, bytes] = {}
        for rel in media_paths or []:
            if not rel:
                continue
            try:
                target = resolve_media_path(self.workspace_dir, rel)
                if target.is_file():
                    media_backups[rel] = target.read_bytes()
            except ValidationError:
                pass

        self._undo_stack.append(
            _UndoSnapshot(label=label, db_bytes=db_bytes, media_backups=media_backups)
        )
        if len(self._undo_stack) > MAX_UNDO_STEPS:
            self._undo_stack.pop(0)

    def undo_last_action(self) -> dict[str, Any]:
        """Restore the workspace to the state prior to the latest mutation."""
        if not self._undo_stack:
            raise ValidationError("Nincs visszavonható művelet.")
        snap = self._undo_stack.pop()
        for suffix in ("-wal", "-shm"):
            sidecar = Path(f"{self.db_path}{suffix}")
            if sidecar.is_file():
                sidecar.unlink()
        _atomic_write_bytes(self.db_path, snap.db_bytes)
        for suffix in ("-wal", "-shm"):
            sidecar = Path(f"{self.db_path}{suffix}")
            if sidecar.is_file():
                sidecar.unlink()

        for rel, data in snap.media_backups.items():
            try:
                target = resolve_media_path(self.workspace_dir, rel)
                _atomic_write_bytes(target, data)
            except ValidationError:
                pass

        conn, _repo = self._repo()
        try:
            avatar_rows = conn.execute(
                "SELECT DISTINCT avatar_path FROM persons WHERE avatar_path != '';"
            ).fetchall()
            referenced_paths = {str(r["avatar_path"]).lstrip("/") for r in avatar_rows}
        finally:
            conn.close()
        cleanup_unused_avatars(self.workspace_dir, referenced_paths)

        return {
            "undone_label": snap.label,
            "message": f"Visszavonva: {snap.label}",
            "tree": self.get_tree_snapshot(),
        }

    # --- Tree & Metadata ---
    def get_tree_snapshot(self, search: str = "") -> dict[str, Any]:
        conn, repo = self._repo()
        try:
            persons = repo.list_persons(search=search)
            unions = repo.list_unions()
            relations = repo.list_parent_child()
            sources = repo.list_sources()
            meta = read_workspace_meta(self.workspace_dir)
            meta.tree_name = repo.get_tree_name()
            meta.person_count = len(repo.list_persons()) if search else len(persons)
            meta.union_count = len(unions)
            meta.relation_count = len(relations)
            return {
                "meta": meta.to_dict(),
                "persons": [p.to_dict() for p in persons],
                "unions": [u.to_dict() for u in unions],
                "parent_child": [r.to_dict() for r in relations],
                "sources": [s.to_dict() for s in sources],
                "undo": {
                    "can_undo": len(self._undo_stack) > 0,
                    "last_label": self._undo_stack[-1].label if self._undo_stack else "",
                    "steps_available": len(self._undo_stack),
                },
            }
        finally:
            conn.close()

    def rename_tree(self, tree_name: str) -> dict[str, Any]:
        clean_name = validate_required_name(tree_name, "Családfa neve")
        conn, repo = self._repo()
        try:
            repo.set_tree_name(clean_name)
        finally:
            conn.close()
        meta = read_workspace_meta(self.workspace_dir)
        meta.tree_name = clean_name
        meta.updated_at = utc_now_iso()
        write_workspace_meta(self.workspace_dir, meta)
        return meta.to_dict()

    def create_new_tree(self, tree_name: str = "Új családfa") -> dict[str, Any]:
        clean_name = validate_required_name(tree_name, "Családfa neve")
        self._undo_stack.clear()
        for fname in ("family.db", "family.db-wal", "family.db-shm", "meta.json"):
            p = self.workspace_dir / fname
            if p.is_file():
                p.unlink()
        media_dir = self.workspace_dir / "media"
        if media_dir.exists():
            import shutil

            shutil.rmtree(media_dir)
        self.db_path = initialize_workspace(self.workspace_dir, tree_name=clean_name)
        return self.get_tree_snapshot()

    # --- Person CRUD ---
    def list_persons(self, search: str = "") -> list[dict[str, Any]]:
        conn, repo = self._repo()
        try:
            return [p.to_dict() for p in repo.list_persons(search=search)]
        finally:
            conn.close()

    def create_person(self, payload: dict[str, Any]) -> dict[str, Any]:
        cleaned = self._validate_person_payload(payload, partial=False)
        self._push_undo(f"Személy felvétele: {cleaned['full_name']}")
        conn, repo = self._repo()
        try:
            person = repo.create_person(**cleaned)
            return person.to_dict()
        finally:
            conn.close()

    def update_person(self, person_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        cleaned = self._validate_person_payload(payload, partial=True)
        conn, repo = self._repo()
        try:
            existing = repo.get_person(person_id)
            final_birth = cleaned.get("birth_date", existing.birth_date)
            final_death = cleaned.get("death_date", existing.death_date)
            validate_date_order(
                final_birth,
                final_death,
                earlier_label="Születési dátum",
                later_label="Halálozási dátum",
            )
            if final_death:
                if "is_living" in payload and cleaned.get("is_living") is True:
                    raise ValidationError("Élő személyhez nem adható meg halálozási dátum.")
                if "death_date" in cleaned and "is_living" not in payload:
                    cleaned["is_living"] = False

            self._push_undo(f"Adatok módosítása: {existing.full_name}")
            person = repo.update_person(person_id, cleaned)
            return person.to_dict()
        finally:
            conn.close()

    def delete_person(self, person_id: str) -> dict[str, Any]:
        conn, repo = self._repo()
        try:
            existing = repo.get_person(person_id)
            self._push_undo(
                f"Személy törlése: {existing.full_name}",
                media_paths=[existing.avatar_path] if existing.avatar_path else None,
            )
            deleted = repo.delete_person(person_id)
        finally:
            conn.close()
        if deleted.avatar_path:
            delete_media_file(self.workspace_dir, deleted.avatar_path)
        return {"deleted": deleted.to_dict()}

    def upload_person_avatar(self, person_id: str, raw_bytes: bytes) -> dict[str, Any]:
        conn, repo = self._repo()
        saved_path = ""
        try:
            existing = repo.get_person(person_id)
            media_info = save_portrait_image(self.workspace_dir, raw_bytes)
            saved_path = str(media_info["avatar_path"])
            self._push_undo(
                f"Portrékép módosítása: {existing.full_name}",
                media_paths=[existing.avatar_path] if existing.avatar_path else None,
            )
            updated = repo.update_person(
                person_id,
                {"avatar_path": saved_path},
            )
        except Exception:
            if saved_path:
                delete_media_file(self.workspace_dir, saved_path)
            raise
        finally:
            conn.close()

        if existing.avatar_path and existing.avatar_path != updated.avatar_path:
            delete_media_file(self.workspace_dir, existing.avatar_path)

        return {"person": updated.to_dict(), "media": media_info}

    def remove_person_avatar(self, person_id: str) -> dict[str, Any]:
        conn, repo = self._repo()
        try:
            existing = repo.get_person(person_id)
            if not existing.avatar_path:
                return existing.to_dict()
            self._push_undo(
                f"Portrékép eltávolítása: {existing.full_name}",
                media_paths=[existing.avatar_path],
            )
            updated = repo.update_person(person_id, {"avatar_path": ""})
        finally:
            conn.close()
        delete_media_file(self.workspace_dir, existing.avatar_path)
        return updated.to_dict()

    def get_person_bundle(self, person_id: str) -> dict[str, Any]:
        """Return a person with parents, unions, children, and computed full/half siblings."""
        conn, repo = self._repo()
        try:
            person = repo.get_person(person_id)
            all_persons = {p.id: p for p in repo.list_persons()}

            # Parents
            parent_links = repo.get_parents_of(person_id)
            parents = [
                {
                    **link.to_dict(),
                    "person": all_persons[link.parent_id].to_dict(),
                }
                for link in parent_links
                if link.parent_id in all_persons
            ]

            # Unions + partners + children per union
            unions = repo.list_unions_for_person(person_id)
            union_entries: list[dict[str, Any]] = []
            children_in_unions: set[str] = set()
            for union in unions:
                partner_id = (
                    union.partner2_id
                    if union.partner1_id == person_id
                    else union.partner1_id
                )
                partner = all_persons[partner_id].to_dict() if partner_id and partner_id in all_persons else None
                u_children_links = repo.get_children_of_union(union.id)
                u_children = []
                for cl in u_children_links:
                    if cl.parent_id == person_id and cl.child_id in all_persons:
                        children_in_unions.add(cl.child_id)
                        u_children.append(
                            {
                                **cl.to_dict(),
                                "person": all_persons[cl.child_id].to_dict(),
                            }
                        )
                union_entries.append(
                    {
                        **union.to_dict(),
                        "partner": partner,
                        "children": u_children,
                    }
                )

            # All children (including those not linked to a union)
            child_links = repo.get_children_of(person_id)
            children = [
                {
                    **link.to_dict(),
                    "person": all_persons[link.child_id].to_dict(),
                }
                for link in child_links
                if link.child_id in all_persons
            ]

            # Compute full and half siblings via shared parents
            my_parent_ids = {link.parent_id for link in parent_links}
            sibling_shared_parents: dict[str, set[str]] = {}
            for pid in my_parent_ids:
                for sibling_link in repo.get_children_of(pid):
                    if sibling_link.child_id == person_id:
                        continue
                    sibling_shared_parents.setdefault(sibling_link.child_id, set()).add(pid)

            siblings = []
            for sib_id, shared_pids in sibling_shared_parents.items():
                if sib_id not in all_persons:
                    continue
                sib_parent_ids = {l.parent_id for l in repo.get_parents_of(sib_id)}
                is_full = (
                    len(my_parent_ids) >= 2
                    and my_parent_ids == sib_parent_ids
                    and len(shared_pids) >= 2
                )
                siblings.append(
                    {
                        "person": all_persons[sib_id].to_dict(),
                        "shared_parent_ids": sorted(shared_pids),
                        "sibling_type": "full" if is_full else "half",
                    }
                )

            sources = repo.get_sources_for_person(person_id)

            return {
                "person": person.to_dict(),
                "parents": parents,
                "unions": union_entries,
                "children": children,
                "siblings": siblings,
                "sources": sources,
            }
        finally:
            conn.close()

    # --- Unions ---
    def create_union(self, payload: dict[str, Any]) -> dict[str, Any]:
        partner1_id = normalize_text(payload.get("partner1_id"))
        raw_p2 = payload.get("partner2_id")
        partner2_id = normalize_text(raw_p2) if raw_p2 else None
        if not partner1_id:
            raise ValidationError("Az első partner megadása kötelező.")
        if partner2_id == "":
            partner2_id = None
        if partner2_id is not None and partner1_id == partner2_id:
            raise ValidationError("Egy személy nem alkothat párkapcsolatot önmagával.")

        status = validate_union_status(payload.get("status"))
        start_date = normalize_partial_date(payload.get("start_date"), field_label="Kezdő dátum")
        end_date = normalize_partial_date(payload.get("end_date"), field_label="Befejező dátum")
        validate_date_order(
            start_date,
            end_date,
            earlier_label="Kezdő dátum",
            later_label="Befejező dátum",
        )
        notes = normalize_text(payload.get("notes"), max_length=2000)

        conn, repo = self._repo()
        try:
            p1 = repo.get_person(partner1_id)
            if partner2_id is not None:
                repo.get_person(partner2_id)
            self._push_undo(f"Kapcsolat felvétele: {p1.full_name}")
            union = repo.create_union(
                partner1_id=partner1_id,
                partner2_id=partner2_id,
                status=status,
                start_date=start_date,
                end_date=end_date,
                notes=notes,
            )
            return union.to_dict()
        finally:
            conn.close()

    def update_union(self, union_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        conn, repo = self._repo()
        try:
            existing = repo.get_union(union_id)
            fields: dict[str, Any] = {}
            if "partner1_id" in payload:
                p1 = normalize_text(payload.get("partner1_id"))
                if not p1:
                    raise ValidationError("Az első partner megadása kötelező.")
                repo.get_person(p1)
                fields["partner1_id"] = p1
            if "partner2_id" in payload:
                raw_p2 = payload.get("partner2_id")
                p2 = normalize_text(raw_p2) if raw_p2 else None
                if p2:
                    repo.get_person(p2)
                fields["partner2_id"] = p2

            final_p1 = fields.get("partner1_id", existing.partner1_id)
            final_p2 = fields.get("partner2_id", existing.partner2_id)
            if final_p2 is not None and final_p1 == final_p2:
                raise ValidationError("A két partner nem lehet ugyanaz a személy.")

            if "status" in payload:
                fields["status"] = validate_union_status(payload.get("status"))
            if "start_date" in payload:
                fields["start_date"] = normalize_partial_date(
                    payload.get("start_date"), field_label="Kezdő dátum"
                )
            if "end_date" in payload:
                fields["end_date"] = normalize_partial_date(
                    payload.get("end_date"), field_label="Befejező dátum"
                )
            validate_date_order(
                fields.get("start_date", existing.start_date),
                fields.get("end_date", existing.end_date),
                earlier_label="Kezdő dátum",
                later_label="Befejező dátum",
            )
            if "notes" in payload:
                fields["notes"] = normalize_text(payload.get("notes"), max_length=2000)

            self._push_undo("Párkapcsolat módosítása")
            updated = repo.update_union(union_id, fields)
            return updated.to_dict()
        finally:
            conn.close()

    def delete_union(self, union_id: str) -> dict[str, Any]:
        conn, repo = self._repo()
        try:
            repo.get_union(union_id)
            self._push_undo("Párkapcsolat törlése")
            deleted = repo.delete_union(union_id)
            return {"deleted": deleted.to_dict()}
        finally:
            conn.close()

    # --- Parent-Child Relations ---
    def add_parent_child(self, payload: dict[str, Any]) -> dict[str, Any]:
        child_id = normalize_text(payload.get("child_id"))
        parent_id = normalize_text(payload.get("parent_id"))
        raw_union_id = payload.get("union_id")
        union_id = normalize_text(raw_union_id) if raw_union_id else None
        relation_type = validate_relation_type(payload.get("relation_type"))

        if not child_id or not parent_id:
            raise ValidationError("A szülő és a gyermek azonosítója kötelező.")
        if child_id == parent_id:
            raise ValidationError("Egy személy nem lehet saját maga szülője.")

        conn, repo = self._repo()
        try:
            repo.get_person(child_id)
            repo.get_person(parent_id)
            if union_id is not None:
                union = repo.get_union(union_id)
                if parent_id not in (union.partner1_id, union.partner2_id):
                    raise ValidationError(
                        "A megadott szülő nem tagja a kiválasztott párkapcsolatnak."
                    )

            self._ensure_no_cycle(repo, parent_id=parent_id, child_id=child_id)
            self._push_undo("Szülő-gyermek kapcsolat rögzítése")
            rel = repo.upsert_parent_child(
                child_id=child_id,
                parent_id=parent_id,
                union_id=union_id,
                relation_type=relation_type,
            )
            return rel.to_dict()
        finally:
            conn.close()

    def delete_parent_child(self, child_id: str, parent_id: str) -> dict[str, Any]:
        conn, repo = self._repo()
        try:
            repo.get_relation(child_id, parent_id)
            self._push_undo("Szülő-gyermek kapcsolat törlése")
            repo.delete_parent_child(child_id, parent_id)
            return {"deleted": {"child_id": child_id, "parent_id": parent_id}}
        finally:
            conn.close()

    # --- User-Friendly Quick-Add Workflows ---
    def quick_add_parent(self, child_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Create a new person and immediately link them as parent of child_id."""
        relation_type = validate_relation_type(payload.get("relation_type"))
        raw_union_id = payload.get("union_id")
        union_id = normalize_text(raw_union_id) if raw_union_id else None
        person_fields = self._validate_person_payload(payload, partial=False)

        conn, repo = self._repo()
        try:
            repo.get_person(child_id)
            if union_id is not None:
                repo.get_union(union_id)
            self._push_undo(f"Szülő hozzáadása: {person_fields['full_name']}")
            parent = repo.create_person(**person_fields)
            rel = repo.upsert_parent_child(
                child_id=child_id,
                parent_id=parent.id,
                union_id=union_id,
                relation_type=relation_type,
            )
            return {"person": parent.to_dict(), "relation": rel.to_dict()}
        finally:
            conn.close()

    def quick_add_child(self, parent_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Create a new child and attach them to parent_id (and optionally both parents of union_id)."""
        relation_type = validate_relation_type(payload.get("relation_type"))
        raw_union_id = payload.get("union_id")
        union_id = normalize_text(raw_union_id) if raw_union_id else None
        link_both = parse_bool_flag(payload.get("link_both_partners"), default=True)
        person_fields = self._validate_person_payload(payload, partial=False)

        conn, repo = self._repo()
        try:
            repo.get_person(parent_id)
            union: UnionRecord | None = None
            if union_id is not None:
                union = repo.get_union(union_id)
                if parent_id not in (union.partner1_id, union.partner2_id):
                    raise ValidationError("A kiválasztott szülő nem része ennek a kapcsolatnak.")

            self._push_undo(f"Gyermek hozzáadása: {person_fields['full_name']}")
            child = repo.create_person(**person_fields)
            relations: list[dict[str, Any]] = []
            rel1 = repo.upsert_parent_child(
                child_id=child.id,
                parent_id=parent_id,
                union_id=union_id,
                relation_type=relation_type,
            )
            relations.append(rel1.to_dict())

            if union is not None and link_both:
                other_parent = (
                    union.partner2_id
                    if union.partner1_id == parent_id
                    else union.partner1_id
                )
                if other_parent is not None:
                    rel2 = repo.upsert_parent_child(
                        child_id=child.id,
                        parent_id=other_parent,
                        union_id=union.id,
                        relation_type=relation_type,
                    )
                    relations.append(rel2.to_dict())

            return {"person": child.to_dict(), "relations": relations}
        finally:
            conn.close()

    def quick_add_partner(self, person_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Create a new person and immediately create a union with person_id."""
        status = validate_union_status(payload.get("status"))
        start_date = normalize_partial_date(payload.get("start_date"), field_label="Kezdő dátum")
        end_date = normalize_partial_date(payload.get("end_date"), field_label="Befejező dátum")
        validate_date_order(
            start_date,
            end_date,
            earlier_label="Kezdő dátum",
            later_label="Befejező dátum",
        )
        union_notes = normalize_text(payload.get("union_notes"), max_length=2000)
        person_fields = self._validate_person_payload(payload, partial=False)

        conn, repo = self._repo()
        try:
            repo.get_person(person_id)
            self._push_undo(f"Partner hozzáadása: {person_fields['full_name']}")
            partner = repo.create_person(**person_fields)
            union = repo.create_union(
                partner1_id=person_id,
                partner2_id=partner.id,
                status=status,
                start_date=start_date,
                end_date=end_date,
                notes=union_notes,
            )
            return {"person": partner.to_dict(), "union": union.to_dict()}
        finally:
            conn.close()

    # --- Sources & Citations ---
    def list_sources(self, search: str = "") -> list[dict[str, Any]]:
        conn, repo = self._repo()
        try:
            return [s.to_dict() for s in repo.list_sources(search=search)]
        finally:
            conn.close()

    def create_source(self, payload: dict[str, Any]) -> dict[str, Any]:
        title = validate_required_name(payload.get("title"), "Forrás címe")
        source_type = validate_source_type(payload.get("source_type"))
        reference = normalize_text(
            payload.get("reference"), max_length=500, field_label="Forráshely / hivatkozás"
        )
        notes = normalize_text(
            payload.get("notes"), max_length=5000, field_label="Forrás megjegyzése"
        )
        self._push_undo(f"Forrás felvétele: {title}")
        conn, repo = self._repo()
        try:
            source = repo.create_source(
                source_type=source_type,
                title=title,
                reference=reference,
                notes=notes,
            )
            return source.to_dict()
        finally:
            conn.close()

    def update_source(self, source_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        conn, repo = self._repo()
        try:
            existing = repo.get_source(source_id)
            fields: dict[str, Any] = {}
            if "title" in payload:
                fields["title"] = validate_required_name(payload.get("title"), "Forrás címe")
            if "source_type" in payload:
                fields["source_type"] = validate_source_type(payload.get("source_type"))
            if "reference" in payload:
                fields["reference"] = normalize_text(
                    payload.get("reference"),
                    max_length=500,
                    field_label="Forráshely / hivatkozás",
                )
            if "notes" in payload:
                fields["notes"] = normalize_text(
                    payload.get("notes"),
                    max_length=5000,
                    field_label="Forrás megjegyzése",
                )
            self._push_undo(f"Forrás módosítása: {existing.title}")
            updated = repo.update_source(source_id, fields)
            return updated.to_dict()
        finally:
            conn.close()

    def delete_source(self, source_id: str) -> dict[str, Any]:
        conn, repo = self._repo()
        try:
            existing = repo.get_source(source_id)
            self._push_undo(f"Forrás törlése: {existing.title}")
            deleted = repo.delete_source(source_id)
            return {"deleted": deleted.to_dict()}
        finally:
            conn.close()

    def add_source_to_person(self, person_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        raw_source_id = payload.get("source_id")
        existing_source_id = normalize_text(raw_source_id) if raw_source_id else ""
        citation_note = normalize_text(
            payload.get("citation_note"),
            max_length=500,
            field_label="Részlet / oldalszám",
        )

        conn, repo = self._repo()
        try:
            person = repo.get_person(person_id)
            if existing_source_id:
                source = repo.get_source(existing_source_id)
                self._push_undo(f"Forrás hozzárendelése: {person.full_name}")
            else:
                title = validate_required_name(payload.get("title"), "Forrás címe")
                source_type = validate_source_type(payload.get("source_type"))
                reference = normalize_text(
                    payload.get("reference"),
                    max_length=500,
                    field_label="Forráshely / hivatkozás",
                )
                notes = normalize_text(
                    payload.get("notes"),
                    max_length=5000,
                    field_label="Forrás megjegyzése",
                )
                self._push_undo(f"Forrás rögzítése: {title}")
                source = repo.create_source(
                    source_type=source_type,
                    title=title,
                    reference=reference,
                    notes=notes,
                )

            link = repo.link_person_source(
                person_id=person_id,
                source_id=source.id,
                citation_note=citation_note,
            )
            return {
                "source": source.to_dict(),
                "link": link.to_dict(),
                "sources": repo.get_sources_for_person(person_id),
            }
        finally:
            conn.close()

    def remove_source_from_person(self, person_id: str, source_id: str) -> dict[str, Any]:
        conn, repo = self._repo()
        try:
            person = repo.get_person(person_id)
            exists = conn.execute(
                "SELECT 1 FROM person_sources WHERE person_id = ? AND source_id = ?;",
                (person_id, source_id),
            ).fetchone()
            if exists is None:
                raise NotFoundError("A személyhez tartozó forráshivatkozás nem található.")
            self._push_undo(f"Forrás eltávolítása: {person.full_name}")
            repo.unlink_person_source(person_id, source_id)
            return {
                "removed": {"person_id": person_id, "source_id": source_id},
                "sources": repo.get_sources_for_person(person_id),
            }
        finally:
            conn.close()

    # --- Packaging (.ftree) & GEDCOM (.ged) ---
    def export_package(self, output_path: str | Path) -> Path:
        return export_ftree_package(self.workspace_dir, Path(output_path))

    def import_package(self, archive_path: str | Path) -> dict[str, Any]:
        meta, warning = import_ftree_package_checked(Path(archive_path), self.workspace_dir)
        self._undo_stack.clear()
        return {
            "meta": meta.to_dict(),
            "tree": self.get_tree_snapshot(),
            "warning": warning,
        }

    def export_gedcom(self) -> str:
        conn, repo = self._repo()
        try:
            return export_gedcom_text(
                tree_name=repo.get_tree_name(),
                persons=repo.list_persons(),
                unions=repo.list_unions(),
                relations=repo.list_parent_child(),
                sources=repo.list_sources(),
                person_sources=repo.list_person_sources(),
            )
        finally:
            conn.close()

    def import_gedcom(
        self, raw_bytes: bytes, *, tree_name: str | None = None
    ) -> dict[str, Any]:
        parsed = parse_gedcom_bytes(raw_bytes, override_tree_name=tree_name)

        with tempfile.TemporaryDirectory(prefix="ftree_ged_") as tmp_dir:
            tmp_ws = Path(tmp_dir) / "ws"
            tmp_db = initialize_workspace(tmp_ws, tree_name=parsed.tree_name)
            tmp_conn = connect_sqlite(tmp_db)
            try:
                tmp_repo = FamilyRepository(tmp_conn)
                for p in parsed.persons:
                    tmp_repo.create_person(
                        person_id=p["id"],
                        full_name=p["full_name"],
                        birth_name=p["birth_name"],
                        gender=p["gender"],
                        birth_date=p["birth_date"],
                        death_date=p["death_date"],
                        is_living=bool(p["is_living"]),
                        notes=p["notes"],
                    )
                for s in parsed.sources:
                    tmp_repo.create_source(
                        source_id=s["id"],
                        source_type=s["source_type"],
                        title=s["title"],
                        reference=s["reference"],
                        notes=s["notes"],
                    )
                for u in parsed.unions:
                    tmp_repo.create_union(
                        union_id=u["id"],
                        partner1_id=u["partner1_id"],
                        partner2_id=u["partner2_id"],
                        status=u["status"],
                        start_date=u["start_date"],
                        end_date=u["end_date"],
                        notes=u["notes"],
                    )
                for r in parsed.relations:
                    try:
                        self._ensure_no_cycle(
                            tmp_repo,
                            parent_id=r["parent_id"],
                            child_id=r["child_id"],
                        )
                    except ConflictError as exc:
                        raise PackageError(
                            "A GEDCOM fájl körkörös szülő–gyermek hivatkozást tartalmaz.",
                            code="INVALID_GEDCOM_CYCLE",
                            hint="Ellenőrizd a forrásfájlban a családi kapcsolatokat, mert egy személy nem lehet saját őse.",
                        ) from exc
                    tmp_repo.upsert_parent_child(
                        child_id=r["child_id"],
                        parent_id=r["parent_id"],
                        union_id=r["union_id"],
                        relation_type=r["relation_type"],
                    )
                for ps in parsed.person_sources:
                    tmp_repo.link_person_source(
                        person_id=ps["person_id"],
                        source_id=ps["source_id"],
                        citation_note=ps["citation_note"],
                    )
            finally:
                tmp_conn.close()

            for suffix in ("-wal", "-shm"):
                sidecar = Path(f"{tmp_db}{suffix}")
                if sidecar.is_file():
                    sidecar.unlink()
            staged_db_bytes = tmp_db.read_bytes()

        conn, repo = self._repo()
        try:
            existing_media = [p.avatar_path for p in repo.list_persons() if p.avatar_path]
        finally:
            conn.close()

        self._push_undo("GEDCOM importálás", media_paths=existing_media)

        for suffix in ("-wal", "-shm"):
            sidecar = Path(f"{self.db_path}{suffix}")
            if sidecar.is_file():
                sidecar.unlink()
        _atomic_write_bytes(self.db_path, staged_db_bytes)
        for suffix in ("-wal", "-shm"):
            sidecar = Path(f"{self.db_path}{suffix}")
            if sidecar.is_file():
                sidecar.unlink()

        cleanup_unused_avatars(self.workspace_dir, set())

        meta = read_workspace_meta(self.workspace_dir)
        meta.tree_name = parsed.tree_name
        meta.person_count = len(parsed.persons)
        meta.union_count = len(parsed.unions)
        meta.relation_count = len(parsed.relations)
        meta.updated_at = utc_now_iso()
        write_workspace_meta(self.workspace_dir, meta)

        snapshot = self.get_tree_snapshot()
        return {
            "meta": snapshot["meta"],
            "tree": snapshot,
            "imported": {
                "person_count": len(parsed.persons),
                "union_count": len(parsed.unions),
                "relation_count": len(parsed.relations),
                "source_count": len(parsed.sources),
            },
        }

    # --- Demo Sample Family (useful for testing multiple marriages & half-siblings) ---
    def seed_sample_family(self) -> dict[str, Any]:
        """Reset workspace with a realistic Hungarian multi-marriage sample family."""
        self.create_new_tree("Kovács–Nagy családfa")
        conn, repo = self._repo()
        try:
            # Nagyszülők
            nagyapa = repo.create_person(
                full_name="Kovács István",
                gender="male",
                birth_date="1942",
                death_date="2018-11",
                is_living=False,
                notes="Asztalosmester Szegeden, három unoka büszke nagyapja.",
            )
            nagyanya = repo.create_person(
                full_name="Kovács Istvánné",
                birth_name="Tóth Ilona",
                gender="female",
                birth_date="1945-04-12",
                is_living=True,
                notes="Nyugdíjas általános iskolai tanítónő.",
            )
            u_gp = repo.create_union(
                partner1_id=nagyapa.id,
                partner2_id=nagyanya.id,
                status="widowed",
                start_date="1966-08-20",
                end_date="2018-11",
                notes="Több mint 50 évig éltek boldog házasságban.",
            )

            # Második generáció (több házassággal)
            peter = repo.create_person(
                full_name="Kovács Péter",
                gender="male",
                birth_date="1968-03-05",
                is_living=True,
                notes="Gépészmérnök, első és második házasságából is született gyermeke.",
            )
            repo.upsert_parent_child(child_id=peter.id, parent_id=nagyapa.id, union_id=u_gp.id)
            repo.upsert_parent_child(child_id=peter.id, parent_id=nagyanya.id, union_id=u_gp.id)

            anna = repo.create_person(
                full_name="Szabó Anna",
                birth_name="Szabó Anna",
                gender="female",
                birth_date="1970",
                is_living=True,
                notes="Kovács Péter első házastársa.",
            )
            u_m1 = repo.create_union(
                partner1_id=peter.id,
                partner2_id=anna.id,
                status="divorced",
                start_date="1993-06-12",
                end_date="2002",
            )
            kata = repo.create_person(
                full_name="Kovács Kata",
                gender="female",
                birth_date="1995-09-18",
                is_living=True,
                notes="Kovács Péter és Szabó Anna lánya.",
            )
            repo.upsert_parent_child(child_id=kata.id, parent_id=peter.id, union_id=u_m1.id)
            repo.upsert_parent_child(child_id=kata.id, parent_id=anna.id, union_id=u_m1.id)

            eva = repo.create_person(
                full_name="Kovácsné Nagy Éva",
                birth_name="Nagy Éva",
                gender="female",
                birth_date="1976-11",
                is_living=True,
                notes="Kovács Péter második felesége, gyógyszerész.",
            )
            u_m2 = repo.create_union(
                partner1_id=peter.id,
                partner2_id=eva.id,
                status="married",
                start_date="2005-05-14",
            )
            bence = repo.create_person(
                full_name="Kovács Bence",
                gender="male",
                birth_date="2007-02-23",
                is_living=True,
                notes="Kovács Péter és Nagy Éva fia (Kata féltestvére).",
            )
            repo.upsert_parent_child(child_id=bence.id, parent_id=peter.id, union_id=u_m2.id)
            repo.upsert_parent_child(child_id=bence.id, parent_id=eva.id, union_id=u_m2.id)
        finally:
            conn.close()

        return self.get_tree_snapshot()

    # --- Internal Helpers ---
    def _validate_person_payload(
        self, payload: dict[str, Any], *, partial: bool
    ) -> dict[str, Any]:
        cleaned: dict[str, Any] = {}
        if not partial or "full_name" in payload:
            cleaned["full_name"] = validate_required_name(
                payload.get("full_name"), "Teljes név"
            )
        if not partial or "birth_name" in payload:
            cleaned["birth_name"] = normalize_text(
                payload.get("birth_name"), max_length=200, field_label="Születési név"
            )
        if not partial or "gender" in payload:
            cleaned["gender"] = validate_gender(payload.get("gender"))
        if not partial or "birth_date" in payload:
            cleaned["birth_date"] = normalize_partial_date(
                payload.get("birth_date"), field_label="Születési dátum"
            )
        if not partial or "death_date" in payload:
            cleaned["death_date"] = normalize_partial_date(
                payload.get("death_date"), field_label="Halálozási dátum"
            )
        if not partial or "is_living" in payload:
            default_living = not bool(cleaned.get("death_date"))
            cleaned["is_living"] = parse_bool_flag(
                payload.get("is_living"), default=default_living
            )
        if not partial or "notes" in payload:
            cleaned["notes"] = normalize_text(
                payload.get("notes"), max_length=5000, field_label="Megjegyzés"
            )

        if not partial:
            validate_date_order(
                cleaned["birth_date"],
                cleaned["death_date"],
                earlier_label="Születési dátum",
                later_label="Halálozási dátum",
            )
            if cleaned.get("death_date"):
                if "is_living" in payload and cleaned.get("is_living") is True:
                    raise ValidationError("Élő személyhez nem adható meg halálozási dátum.")
                cleaned["is_living"] = False

        return cleaned

    def _ensure_no_cycle(
        self, repo: FamilyRepository, *, parent_id: str, child_id: str
    ) -> None:
        """Ensure child_id is not an ancestor of parent_id (prevents cyclic family trees)."""
        visited: set[str] = set()
        queue: deque[str] = deque([parent_id])
        while queue:
            current = queue.popleft()
            if current == child_id:
                raise ConflictError(
                    "Körkörös kapcsolat nem hozható létre (a gyermek nem lehet saját szülőjének őse)."
                )
            if current in visited:
                continue
            visited.add(current)
            for link in repo.get_parents_of(current):
                queue.append(link.parent_id)
