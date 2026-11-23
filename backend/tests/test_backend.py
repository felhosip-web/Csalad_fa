"""Comprehensive unit and HTTP integration tests for the family tree backend."""

from __future__ import annotations

import json
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

from backend.db import CURRENT_SCHEMA_VERSION, connect_sqlite, ensure_schema, get_schema_version
from backend.models import ConflictError, PackageError, ValidationError
from backend.package import export_ftree_package, import_ftree_package
from backend.server import FamilyTreeHTTPServer
from backend.service import FamilyTreeService
from backend.validators import normalize_partial_date

# Minimal valid 1x1 PNG binary
TINY_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\x0bIDATx\x9cc``\x00\x00\x00\x02"
    b"\x00\x01H\xaf\xa4q\x00\x00\x00\x00IEND\xaeB`\x82"
)


class PartialDateTests(unittest.TestCase):
    def test_accepts_partial_and_hungarian_dates(self) -> None:
        self.assertEqual(normalize_partial_date(""), "")
        self.assertEqual(normalize_partial_date("1954"), "1954")
        self.assertEqual(normalize_partial_date("1954-06"), "1954-06")
        self.assertEqual(normalize_partial_date("1954. 6. 5."), "1954-06-05")
        self.assertEqual(normalize_partial_date("kb. 1920"), "~1920")
        self.assertEqual(normalize_partial_date("~1920-05"), "~1920-05")

    def test_rejects_invalid_dates(self) -> None:
        with self.assertRaises(ValidationError):
            normalize_partial_date("1999-13-01")
        with self.assertRaises(ValidationError):
            normalize_partial_date("2021-02-29")
        with self.assertRaises(ValidationError):
            normalize_partial_date("nem dátum")


class SchemaAndServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.workspace = Path(self.tmp.name) / "ws"
        self.service = FamilyTreeService(self.workspace)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_foreign_keys_and_schema_version(self) -> None:
        conn = connect_sqlite(self.workspace / "family.db")
        try:
            fk = conn.execute("PRAGMA foreign_keys;").fetchone()[0]
            self.assertEqual(fk, 1)
            self.assertEqual(get_schema_version(conn), CURRENT_SCHEMA_VERSION)
            self.assertEqual(ensure_schema(conn), CURRENT_SCHEMA_VERSION)
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    "INSERT INTO parent_child (child_id, parent_id, relation_type, created_at) VALUES ('x', 'y', 'biological', '2026-01-01T00:00:00Z');"
                )
        finally:
            conn.close()

    def test_multi_marriage_and_half_siblings(self) -> None:
        snap = self.service.seed_sample_family()
        self.assertEqual(snap["meta"]["person_count"], 7)
        self.assertEqual(snap["meta"]["union_count"], 3)

        persons_by_name = {p["full_name"]: p for p in snap["persons"]}
        kata_bundle = self.service.get_person_bundle(persons_by_name["Kovács Kata"]["id"])
        self.assertEqual(len(kata_bundle["parents"]), 2)
        self.assertEqual(len(kata_bundle["siblings"]), 1)
        self.assertEqual(kata_bundle["siblings"][0]["person"]["full_name"], "Kovács Bence")
        self.assertEqual(kata_bundle["siblings"][0]["sibling_type"], "half")

        peter_bundle = self.service.get_person_bundle(persons_by_name["Kovács Péter"]["id"])
        self.assertEqual(len(peter_bundle["unions"]), 2)
        statuses = {u["status"] for u in peter_bundle["unions"]}
        self.assertEqual(statuses, {"divorced", "married"})

    def test_cycle_prevention(self) -> None:
        a = self.service.create_person({"full_name": "Nagyapa"})
        b = self.service.quick_add_child(a["id"], {"full_name": "Apa"})["person"]
        c = self.service.quick_add_child(b["id"], {"full_name": "Gyermek"})["person"]

        with self.assertRaises(ConflictError):
            self.service.add_parent_child({"parent_id": c["id"], "child_id": a["id"]})

    def test_package_export_import_roundtrip_and_zip_slip(self) -> None:
        p = self.service.create_person({"full_name": "Teszt Elek", "birth_date": "1980"})
        upload_res = self.service.upload_person_avatar(p["id"], TINY_PNG)
        avatar_rel = upload_res["person"]["avatar_path"]
        self.assertTrue((self.workspace / avatar_rel).is_file())

        archive_path = Path(self.tmp.name) / "backup.ftree"
        export_ftree_package(self.workspace, archive_path)
        self.assertTrue(archive_path.is_file())

        with zipfile.ZipFile(archive_path, "r") as zf:
            names = set(zf.namelist())
            self.assertIn("meta.json", names)
            self.assertIn("family.db", names)
            self.assertIn(avatar_rel, names)

        # Import into fresh workspace
        ws2 = Path(self.tmp.name) / "ws2"
        meta = import_ftree_package(archive_path, ws2)
        self.assertEqual(meta.person_count, 1)
        self.assertTrue((ws2 / avatar_rel).is_file())

        # Zip Slip attack archive must be rejected
        bad_zip = Path(self.tmp.name) / "evil.ftree"
        with zipfile.ZipFile(bad_zip, "w") as zf:
            zf.writestr("../../evil.txt", "pwned")
        with self.assertRaises(PackageError):
            import_ftree_package(bad_zip, ws2)


class HTTPServerIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.service = FamilyTreeService(Path(self.tmp.name) / "ws")
        self.server = FamilyTreeHTTPServer(("127.0.0.1", 0), self.service)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.tmp.cleanup()

    def _req(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Content-Type": "application/json"} if body is not None else {}
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(req) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read().decode("utf-8"))

    def test_rest_api_flow(self) -> None:
        status, health = self._req("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(health["status"], "ok")

        status, created = self._req(
            "POST",
            "/api/persons",
            {"full_name": "Minta János", "birth_date": "1955", "gender": "male"},
        )
        self.assertEqual(status, 201)
        pid = created["person"]["id"]

        status, partner_res = self._req(
            "POST",
            f"/api/persons/{pid}/quick-partner",
            {"full_name": "Minta Jánosné", "birth_name": "Kis Mária", "gender": "female", "start_date": "1979"},
        )
        self.assertEqual(status, 201)
        uid = partner_res["union"]["id"]

        status, child_res = self._req(
            "POST",
            f"/api/persons/{pid}/quick-child",
            {"full_name": "Minta Dóra", "gender": "female", "birth_date": "1982-04", "union_id": uid},
        )
        self.assertEqual(status, 201)
        self.assertEqual(len(child_res["relations"]), 2)

        status, snap = self._req("GET", "/api/tree")
        self.assertEqual(status, 200)
        self.assertEqual(snap["meta"]["person_count"], 3)
        self.assertEqual(snap["meta"]["union_count"], 1)
        self.assertEqual(snap["meta"]["relation_count"], 2)
        self.assertTrue(snap["undo"]["can_undo"])

        status, undo_res = self._req("POST", "/api/undo", {})
        self.assertEqual(status, 200)
        self.assertEqual(undo_res["tree"]["meta"]["person_count"], 2)


if __name__ == "__main__":
    unittest.main()
