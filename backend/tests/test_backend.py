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
from backend.media import MAX_UPLOAD_BYTES
from backend.models import ConflictError, NotFoundError, PackageError, ValidationError
from backend.package import export_ftree_package, import_ftree_package
from backend.server import FamilyTreeHTTPServer
from backend.service import MAX_UNDO_STEPS, FamilyTreeService
from backend.validators import normalize_partial_date, validate_date_order
from backend.version import BACKEND_VERSION

# Minimal valid 1x1 PNG binary
TINY_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\x0bIDATx\x9cc``\x00\x00\x00\x02"
    b"\x00\x01H\xaf\xa4q\x00\x00\x00\x00IEND\xaeB`\x82"
)

# Alternate valid 1x1 PNG binary (slightly different payload bytes for distinct file checks)
TINY_PNG_ALT = TINY_PNG + b"\x00"


class PartialDateTests(unittest.TestCase):
    def test_accepts_partial_and_hungarian_dates(self) -> None:
        self.assertEqual(normalize_partial_date(""), "")
        self.assertEqual(normalize_partial_date("1954"), "1954")
        self.assertEqual(normalize_partial_date("1954."), "1954")
        self.assertEqual(normalize_partial_date("1954-06"), "1954-06")
        self.assertEqual(normalize_partial_date("1954. 06."), "1954-06")
        self.assertEqual(normalize_partial_date("1954-06-15"), "1954-06-15")
        self.assertEqual(normalize_partial_date("1954. 06. 15."), "1954-06-15")
        self.assertEqual(normalize_partial_date("1954. 6. 5."), "1954-06-05")
        self.assertEqual(normalize_partial_date("kb. 1920"), "~1920")
        self.assertEqual(normalize_partial_date("kb.1920"), "~1920")
        self.assertEqual(normalize_partial_date("~1920"), "~1920")
        self.assertEqual(normalize_partial_date("~1920-05"), "~1920-05")

    def test_rejects_invalid_dates(self) -> None:
        for bad in ("1999-13-01", "1954-00", "1954-06-31", "2021-02-29", "0000", "~", "nem dátum"):
            with self.subTest(bad=bad):
                with self.assertRaises(ValidationError):
                    normalize_partial_date(bad)

    def test_chronological_order_validation(self) -> None:
        # Compatible partial dates must pass
        validate_date_order("1980", "1980-05", earlier_label="Születési dátum", later_label="Halálozási dátum")
        validate_date_order("~1920", "1995-03-10", earlier_label="Születési dátum", later_label="Halálozási dátum")
        # Impossible chronological order must fail
        with self.assertRaises(ValidationError) as ctx:
            validate_date_order("1990", "1985", earlier_label="Születési dátum", later_label="Halálozási dátum")
        self.assertIn("nem lehet korábbi", ctx.exception.message)


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

    def test_hungarian_validation_and_chronology_rules(self) -> None:
        with self.assertRaises(ValidationError) as empty_ctx:
            self.service.create_person({"full_name": "   "})
        self.assertIn("kötelező", empty_ctx.exception.message)

        with self.assertRaises(ValidationError) as order_ctx:
            self.service.create_person(
                {"full_name": "Időutazó Béla", "birth_date": "1980", "death_date": "1975"}
            )
        self.assertIn("nem lehet korábbi", order_ctx.exception.message)

        with self.assertRaises(ValidationError) as living_ctx:
            self.service.create_person(
                {"full_name": "Ellentmondás Ádám", "birth_date": "1950", "death_date": "2020", "is_living": True}
            )
        self.assertIn("Élő személyhez", living_ctx.exception.message)

        p1 = self.service.create_person({"full_name": "Teszt Béla", "birth_date": "1960"})
        with self.assertRaises(ValidationError):
            self.service.update_person(p1["id"], {"death_date": "1959"})

        with self.assertRaises(NotFoundError) as nf_ctx:
            self.service.get_person_bundle("nem-letezo-id")
        self.assertIn("nem található", nf_ctx.exception.message)

        p2 = self.service.create_person({"full_name": "Teszt Anna", "birth_date": "1962"})
        with self.assertRaises(ValidationError):
            self.service.create_union(
                {
                    "partner1_id": p1["id"],
                    "partner2_id": p2["id"],
                    "start_date": "2005",
                    "end_date": "2001",
                }
            )

        u = self.service.create_union(
            {"partner1_id": p1["id"], "partner2_id": p2["id"], "start_date": "1985"}
        )
        with self.assertRaises(ValidationError):
            self.service.update_union(u["id"], {"end_date": "1980"})

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

        with self.assertRaises(ConflictError) as ctx:
            self.service.add_parent_child({"parent_id": c["id"], "child_id": a["id"]})
        self.assertIn("Körkörös kapcsolat", ctx.exception.message)

    def test_media_validation_replacement_and_undo_cleanup(self) -> None:
        p = self.service.create_person({"full_name": "Kép Teszt", "birth_date": "1985"})
        initial_undo = self.service.get_tree_snapshot()["undo"]["steps_available"]

        with self.assertRaises(ValidationError) as empty_img:
            self.service.upload_person_avatar(p["id"], b"")
        self.assertIn("Üres képfájl", empty_img.exception.message)

        with self.assertRaises(ValidationError) as bad_img:
            self.service.upload_person_avatar(p["id"], b"not-a-valid-image-payload")
        self.assertIn("nem érvényes", bad_img.exception.message)

        with self.assertRaises(ValidationError) as big_img:
            self.service.upload_person_avatar(p["id"], b"x" * (MAX_UPLOAD_BYTES + 1))
        self.assertIn("10 MB", big_img.exception.message)

        # Invalid uploads must not create phantom undo entries
        self.assertEqual(self.service.get_tree_snapshot()["undo"]["steps_available"], initial_undo)

        # Valid upload then replacement deletes old file
        up1 = self.service.upload_person_avatar(p["id"], TINY_PNG)
        path1 = up1["person"]["avatar_path"]
        self.assertTrue((self.workspace / path1).is_file())

        up2 = self.service.upload_person_avatar(p["id"], TINY_PNG_ALT)
        path2 = up2["person"]["avatar_path"]
        self.assertNotEqual(path1, path2)
        self.assertFalse((self.workspace / path1).exists())
        self.assertTrue((self.workspace / path2).is_file())

        # Undoing replacement restores old avatar and removes the undone upload
        undo_res = self.service.undo_last_action()
        self.assertIn("Visszavonva:", undo_res["message"])
        self.assertTrue((self.workspace / path1).is_file())
        self.assertFalse((self.workspace / path2).exists())

        # Removing avatar deletes file
        self.service.remove_person_avatar(p["id"])
        self.assertFalse((self.workspace / path1).exists())

    def test_package_export_excludes_orphans_and_overwrites_atomically(self) -> None:
        p = self.service.create_person({"full_name": "Teszt Elek", "birth_date": "1980"})
        upload_res = self.service.upload_person_avatar(p["id"], TINY_PNG)
        avatar_rel = upload_res["person"]["avatar_path"]
        self.assertTrue((self.workspace / avatar_rel).is_file())

        # Place an orphan file in media/avatars/
        orphan_file = self.workspace / "media" / "avatars" / "orphan_unused.png"
        orphan_file.write_bytes(TINY_PNG)

        archive_path = Path(self.tmp.name) / "backup.ftree"
        archive_path.write_bytes(b"existing corrupt content")
        export_ftree_package(self.workspace, archive_path)
        self.assertTrue(archive_path.is_file())

        # No leftover temporary files in target directory
        leftovers = [f.name for f in archive_path.parent.iterdir() if f.name.startswith(".tmp_")]
        self.assertEqual(leftovers, [])

        with zipfile.ZipFile(archive_path, "r") as zf:
            names = set(zf.namelist())
            self.assertIn("meta.json", names)
            self.assertIn("family.db", names)
            self.assertIn(avatar_rel, names)
            self.assertNotIn("media/avatars/orphan_unused.png", names)
            exported_meta = json.loads(zf.read("meta.json").decode("utf-8"))
            self.assertEqual(exported_meta["person_count"], 1)
            self.assertEqual(exported_meta["format_version"], 1)
            self.assertEqual(exported_meta["checksum_algorithm"], "sha256")
            self.assertIn("family.db", exported_meta["checksums"])
            self.assertIn(avatar_rel, exported_meta["checksums"])
            self.assertEqual(len(exported_meta["checksums"]["family.db"]), 64)

        # Import into fresh workspace
        ws2 = Path(self.tmp.name) / "ws2"
        meta = import_ftree_package(archive_path, ws2)
        self.assertEqual(meta.person_count, 1)
        self.assertEqual(meta.checksum_algorithm, "sha256")
        self.assertIn("family.db", meta.checksums)
        self.assertTrue((ws2 / avatar_rel).is_file())

        # Zip Slip attack archive must be rejected
        bad_zip = Path(self.tmp.name) / "evil.ftree"
        with zipfile.ZipFile(bad_zip, "w") as zf:
            zf.writestr("../../evil.txt", "pwned")
        with self.assertRaises(PackageError):
            import_ftree_package(bad_zip, ws2)

    def test_checksum_mismatch_detection_and_legacy_fallback(self) -> None:
        p = self.service.create_person({"full_name": "Ellenőrző Béla", "birth_date": "1975"})
        upload_res = self.service.upload_person_avatar(p["id"], TINY_PNG)
        avatar_rel = upload_res["person"]["avatar_path"]

        archive_path = Path(self.tmp.name) / "valid.ftree"
        export_ftree_package(self.workspace, archive_path)

        # 1. Tampering with family.db must raise CHECKSUM_MISMATCH and preserve existing workspace
        tampered_db_zip = Path(self.tmp.name) / "tampered_db.ftree"
        with zipfile.ZipFile(archive_path, "r") as zin, zipfile.ZipFile(tampered_db_zip, "w") as zout:
            for item in zin.infolist():
                data = zin.read(item.filename)
                if item.filename == "family.db":
                    data = data[:-4] + b"XXXX"
                zout.writestr(item.filename, data)

        ws_target = Path(self.tmp.name) / "ws_target"
        target_service = FamilyTreeService(ws_target)
        target_service.create_person({"full_name": "Eredeti Személy"})

        with self.assertRaises(PackageError) as cm_ctx:
            target_service.import_package(tampered_db_zip)
        self.assertEqual(cm_ctx.exception.code, "CHECKSUM_MISMATCH")
        self.assertIn("SHA-256", cm_ctx.exception.message)
        # Existing workspace & undo stack must remain untouched
        snap_after = target_service.get_tree_snapshot()
        self.assertEqual(snap_after["persons"][0]["full_name"], "Eredeti Személy")
        self.assertTrue(snap_after["undo"]["can_undo"])
        # No leftover temporary files
        leftovers = [f.name for f in ws_target.iterdir() if f.name.startswith(".tmp_")]
        self.assertEqual(leftovers, [])

        # 2. Tampering with a media file must raise CHECKSUM_MISMATCH
        tampered_media_zip = Path(self.tmp.name) / "tampered_media.ftree"
        with zipfile.ZipFile(archive_path, "r") as zin, zipfile.ZipFile(tampered_media_zip, "w") as zout:
            for item in zin.infolist():
                data = zin.read(item.filename)
                if item.filename == avatar_rel:
                    data = TINY_PNG_ALT
                zout.writestr(item.filename, data)

        with self.assertRaises(PackageError) as media_ctx:
            target_service.import_package(tampered_media_zip)
        self.assertEqual(media_ctx.exception.code, "CHECKSUM_MISMATCH")

        # 3. Missing checksum-protected media file must raise CHECKSUM_MISMATCH
        missing_media_zip = Path(self.tmp.name) / "missing_media.ftree"
        with zipfile.ZipFile(archive_path, "r") as zin, zipfile.ZipFile(missing_media_zip, "w") as zout:
            for item in zin.infolist():
                if item.filename == avatar_rel:
                    continue
                zout.writestr(item.filename, zin.read(item.filename))

        with self.assertRaises(PackageError) as missing_ctx:
            target_service.import_package(missing_media_zip)
        self.assertEqual(missing_ctx.exception.code, "CHECKSUM_MISMATCH")

        # 4. Legacy archive without checksums loads cleanly with a Hungarian warning
        legacy_zip = Path(self.tmp.name) / "legacy.ftree"
        with zipfile.ZipFile(archive_path, "r") as zin, zipfile.ZipFile(legacy_zip, "w") as zout:
            for item in zin.infolist():
                data = zin.read(item.filename)
                if item.filename == "meta.json":
                    meta_obj = json.loads(data.decode("utf-8"))
                    meta_obj.pop("checksums", None)
                    meta_obj.pop("checksum_algorithm", None)
                    data = json.dumps(meta_obj, ensure_ascii=False).encode("utf-8")
                zout.writestr(item.filename, data)

        legacy_res = target_service.import_package(legacy_zip)
        self.assertIsNotNone(legacy_res["warning"])
        self.assertIn("régebbi", legacy_res["warning"].lower())
        self.assertEqual(legacy_res["tree"]["persons"][0]["full_name"], "Ellenőrző Béla")
        # Re-exporting creates protected checksums
        reexported = Path(self.tmp.name) / "reexported.ftree"
        target_service.export_package(reexported)
        with zipfile.ZipFile(reexported, "r") as zf:
            re_meta = json.loads(zf.read("meta.json").decode("utf-8"))
            self.assertIn("family.db", re_meta["checksums"])

    def test_undo_stack_limit_25_steps(self) -> None:
        self.assertEqual(MAX_UNDO_STEPS, 25)
        for idx in range(30):
            self.service.create_person({"full_name": f"Személy {idx + 1}"})

        snap = self.service.get_tree_snapshot()
        self.assertEqual(snap["meta"]["person_count"], 30)
        self.assertEqual(snap["undo"]["steps_available"], 25)

        undone_count = 0
        for _ in range(25):
            res = self.service.undo_last_action()
            self.assertTrue(res["message"].startswith("Visszavonva:"))
            undone_count += 1
        self.assertEqual(undone_count, 25)

        after_snap = self.service.get_tree_snapshot()
        self.assertEqual(after_snap["meta"]["person_count"], 5)
        self.assertFalse(after_snap["undo"]["can_undo"])
        self.assertEqual(after_snap["undo"]["steps_available"], 0)

        with self.assertRaises(ValidationError) as empty_undo:
            self.service.undo_last_action()
        self.assertIn("Nincs visszavonható", empty_undo.exception.message)


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

    def _post_raw(self, path: str, raw_bytes: bytes, content_type: str = "application/octet-stream") -> tuple[int, dict]:
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=raw_bytes,
            headers={"Content-Type": content_type},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read().decode("utf-8"))

    def test_rest_api_flow_and_hungarian_errors(self) -> None:
        status, health = self._req("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(health["status"], "ok")
        self.assertEqual(health["version"], BACKEND_VERSION)
        self.assertEqual(health["backend_version"], BACKEND_VERSION)

        status, ver = self._req("GET", "/api/version")
        self.assertEqual(status, 200)
        self.assertEqual(ver["backend_version"], BACKEND_VERSION)
        self.assertEqual(ver["schema_version"], CURRENT_SCHEMA_VERSION)

        # 404 returns structured ok:false Hungarian error
        status, not_found = self._req("GET", "/api/ismeretlen-veg-pont")
        self.assertEqual(status, 404)
        self.assertIs(not_found["ok"], False)
        self.assertEqual(not_found["error"]["code"], "not_found")
        self.assertIn("nem található", not_found["error"]["message"])

        # Invalid chronological order via REST API returns 422 with structured Hungarian error
        status, bad_person = self._req(
            "POST",
            "/api/persons",
            {"full_name": "Hibás Dátum", "birth_date": "1990", "death_date": "1980"},
        )
        self.assertEqual(status, 422)
        self.assertIs(bad_person["ok"], False)
        self.assertEqual(bad_person["error"]["code"], "validation_error")
        self.assertIn("nem lehet korábbi", bad_person["error"]["message"])

        status, created = self._req(
            "POST",
            "/api/persons",
            {"full_name": "Minta János", "birth_date": "1955.", "gender": "male"},
        )
        self.assertEqual(status, 201)
        pid = created["person"]["id"]
        self.assertEqual(created["person"]["birth_date"], "1955")

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
            {"full_name": "Minta Dóra", "gender": "female", "birth_date": "1982. 04.", "union_id": uid},
        )
        self.assertEqual(status, 201)
        self.assertEqual(child_res["person"]["birth_date"], "1982-04")
        self.assertEqual(len(child_res["relations"]), 2)

        # Export via HTTP, tamper, and verify CHECKSUM_MISMATCH structured JSON response
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/api/package/export") as dl_resp:
            exported_bytes = dl_resp.read()
        exported_file = Path(self.tmp.name) / "http_export.ftree"
        exported_file.write_bytes(exported_bytes)
        tampered_http = Path(self.tmp.name) / "http_tampered.ftree"
        with zipfile.ZipFile(exported_file, "r") as zin, zipfile.ZipFile(tampered_http, "w") as zout:
            for item in zin.infolist():
                payload = zin.read(item.filename)
                if item.filename == "family.db":
                    payload = b"corrupted" + payload[9:]
                zout.writestr(item.filename, payload)

        status, import_err = self._post_raw("/api/package/import", tampered_http.read_bytes())
        self.assertEqual(status, 400)
        self.assertIs(import_err["ok"], False)
        self.assertEqual(import_err["error"]["code"], "CHECKSUM_MISMATCH")
        self.assertIn("SHA-256", import_err["error"]["message"])
        self.assertTrue(import_err["error"].get("hint"))

        status, snap = self._req("GET", "/api/tree")
        self.assertEqual(status, 200)
        self.assertEqual(snap["meta"]["person_count"], 3)
        self.assertEqual(snap["meta"]["union_count"], 1)
        self.assertEqual(snap["meta"]["relation_count"], 2)
        self.assertTrue(snap["undo"]["can_undo"])
        self.assertEqual(snap["undo"]["steps_available"], 3)

        status, undo_res = self._req("POST", "/api/undo", {})
        self.assertEqual(status, 200)
        self.assertEqual(undo_res["tree"]["meta"]["person_count"], 2)
        self.assertIn("Visszavonva:", undo_res["message"])

    def test_static_spa_serving_and_traversal_protection(self) -> None:
        static_root = Path(self.tmp.name) / "static_dist"
        assets_dir = static_root / "assets"
        assets_dir.mkdir(parents=True)
        (static_root / "index.html").write_text("<html><body>Csaladfa SPA</body></html>", encoding="utf-8")
        (assets_dir / "app.js").write_text("console.log('ok');", encoding="utf-8")

        spa_server = FamilyTreeHTTPServer(("127.0.0.1", 0), self.service, static_dir=static_root)
        spa_port = spa_server.server_address[1]
        spa_thread = threading.Thread(target=spa_server.serve_forever, daemon=True)
        spa_thread.start()
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{spa_port}/") as resp:
                self.assertEqual(resp.status, 200)
                self.assertIn("Csaladfa SPA", resp.read().decode("utf-8"))

            with urllib.request.urlopen(f"http://127.0.0.1:{spa_port}/assets/app.js") as resp:
                self.assertEqual(resp.status, 200)
                self.assertIn("console.log('ok')", resp.read().decode("utf-8"))

            with self.assertRaises(urllib.error.HTTPError) as err_ctx:
                urllib.request.urlopen(f"http://127.0.0.1:{spa_port}/../ws/family.db")
            self.assertEqual(err_ctx.exception.code, 404)
            err_ctx.exception.close()

            with self.assertRaises(urllib.error.HTTPError) as api_err_ctx:
                urllib.request.urlopen(f"http://127.0.0.1:{spa_port}/api/nem-letezo")
            self.assertEqual(api_err_ctx.exception.code, 404)
            api_err_ctx.exception.close()
        finally:
            spa_server.shutdown()
            spa_server.server_close()
            spa_thread.join(timeout=2)


class VersionScriptTests(unittest.TestCase):
    def test_semver_bump_and_path_detection(self) -> None:
        from scripts.bump_version import (
            bump_semver,
            detect_targets_from_paths,
            read_backend_version,
            read_frontend_version,
            write_backend_version,
            write_frontend_version,
        )

        self.assertEqual(bump_semver("0.1.0", "patch"), "0.1.1")
        self.assertEqual(bump_semver("0.1.5", "minor"), "0.2.0")
        self.assertEqual(bump_semver("1.4.9", "major"), "2.0.0")

        self.assertEqual(detect_targets_from_paths(["backend/server.py"]), (True, False))
        self.assertEqual(detect_targets_from_paths(["src/App.tsx"]), (False, True))
        self.assertEqual(detect_targets_from_paths(["backend/models.py", "src/components/Footer.tsx"]), (True, True))
        self.assertEqual(detect_targets_from_paths(["README.md", "backend/version.py"]), (False, False))

        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            be_file = tmp_path / "version.py"
            be_file.write_text('BACKEND_VERSION = "0.1.0"\n__version__ = BACKEND_VERSION\n', encoding="utf-8")
            fe_file = tmp_path / "package.json"
            fe_file.write_text('{\n  "name": "test",\n  "version": "0.1.0"\n}\n', encoding="utf-8")

            self.assertEqual(read_backend_version(be_file), "0.1.0")
            self.assertEqual(read_frontend_version(fe_file), "0.1.0")
            write_backend_version("0.1.1", be_file)
            write_frontend_version("0.2.0", fe_file)
            self.assertEqual(read_backend_version(be_file), "0.1.1")
            self.assertEqual(read_frontend_version(fe_file), "0.2.0")


if __name__ == "__main__":
    unittest.main()
