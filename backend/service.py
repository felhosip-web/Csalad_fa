"""Domain service layer with genealogy invariants, quick-add flows, and packaging."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from pathlib import Path
import sqlite3
import tempfile
from typing import Any

from .db import connect_sqlite
from .media import delete_media_file, resolve_media_path, save_portrait_image
from .models import ConflictError, ParentChild, Person, UnionRecord, ValidationError
from .package import (
    export_ftree_package,
    import_ftree_package,
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
    validate_gender,
    validate_relation_type,
    validate_required_name,
    validate_union_status,
)


@dataclass
class _UndoSnapshot:
    label: str
    db_bytes: bytes
    media_backups: dict[str, bytes]


MAX_UNDO_STEPS = 15


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
        self.db_path.write_bytes(snap.db_bytes)
        for rel, data in snap.media_backups.items():
            try:
                target = resolve_media_path(self.workspace_dir, rel)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            except ValidationError:
                pass
        return {
            "undone_label": snap.label,
            "tree": self.get_tree_snapshot(),
        }

    # --- Tree & Metadata ---
    def get_tree_snapshot(self, search: str = "") -> dict[str, Any]:
        conn, repo = self._repo()
        try:
            persons = repo.list_persons(search=search)
            unions = repo.list_unions()
            relations = repo.list_parent_child()
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
                "undo": {
                    "can_undo": len(self._undo_stack) > 0,
                    "last_label": self._undo_stack[-1].label if self._undo_stack else "",
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
        try:
            existing = repo.get_person(person_id)
            self._push_undo(
                f"Portrékép módosítása: {existing.full_name}",
                media_paths=[existing.avatar_path] if existing.avatar_path else None,
            )
            media_info = save_portrait_image(self.workspace_dir, raw_bytes)
            updated = repo.update_person(
                person_id,
                {"avatar_path": str(media_info["avatar_path"])},
            )
        finally:
            conn.close()

        if existing.avatar_path and existing.avatar_path != updated.avatar_path:
            delete_media_file(self.workspace_dir, existing.avatar_path)

        return {"person": updated.to_dict(), "media": media_info}

    def remove_person_avatar(self, person_id: str) -> dict[str, Any]:
        conn, repo = self._repo()
        try:
            existing = repo.get_person(person_id)
            self._push_undo(
                f"Portrékép eltávolítása: {existing.full_name}",
                media_paths=[existing.avatar_path] if existing.avatar_path else None,
            )
            updated = repo.update_person(person_id, {"avatar_path": ""})
        finally:
            conn.close()
        if existing.avatar_path:
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

            return {
                "person": person.to_dict(),
                "parents": parents,
                "unions": union_entries,
                "children": children,
                "siblings": siblings,
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

    # --- Packaging (.ftree) ---
    def export_package(self, output_path: str | Path) -> Path:
        return export_ftree_package(self.workspace_dir, Path(output_path))

    def import_package(self, archive_path: str | Path) -> dict[str, Any]:
        self._undo_stack.clear()
        meta = import_ftree_package(Path(archive_path), self.workspace_dir)
        return {"meta": meta.to_dict(), "tree": self.get_tree_snapshot()}

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
            cleaned["birth_name"] = normalize_text(payload.get("birth_name"), max_length=200)
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
            cleaned["notes"] = normalize_text(payload.get("notes"), max_length=5000)

        # If death_date is explicitly set and is_living wasn't forced True, keep consistent
        if not partial and cleaned.get("death_date") and "is_living" not in payload:
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
