"""Portable .ftree (ZIP) archive packager and unpackager."""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

from . import __version__
from .db import CURRENT_SCHEMA_VERSION, connect_sqlite, ensure_schema
from .models import PackageError, TreeMeta
from .validators import utc_now_iso

FORMAT_NAME = "ftree"
FORMAT_VERSION = 1
MAX_ARCHIVE_ENTRIES = 5000
MAX_ARCHIVE_UNCOMPRESSED_BYTES = 250 * 1024 * 1024  # 250 MB


def read_workspace_meta(workspace_dir: Path) -> TreeMeta:
    """Read meta.json from workspace, or synthesize defaults if missing."""
    meta_file = workspace_dir / "meta.json"
    now = utc_now_iso()
    data: dict[str, object] = {}
    if meta_file.is_file():
        try:
            loaded = json.loads(meta_file.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data = loaded
        except (OSError, json.JSONDecodeError):
            data = {}

    return TreeMeta(
        format=str(data.get("format") or FORMAT_NAME),
        format_version=int(data.get("format_version") or FORMAT_VERSION),
        schema_version=int(data.get("schema_version") or CURRENT_SCHEMA_VERSION),
        tree_name=str(data.get("tree_name") or "Új családfa"),
        app_version=str(data.get("app_version") or __version__),
        created_at=str(data.get("created_at") or now),
        updated_at=str(data.get("updated_at") or now),
        person_count=int(data.get("person_count") or 0),
        union_count=int(data.get("union_count") or 0),
        relation_count=int(data.get("relation_count") or 0),
    )


def write_workspace_meta(workspace_dir: Path, meta: TreeMeta) -> Path:
    meta_file = workspace_dir / "meta.json"
    meta_file.write_text(
        json.dumps(meta.to_dict(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return meta_file


def initialize_workspace(workspace_dir: Path, *, tree_name: str = "Új családfa") -> Path:
    """Create or ensure a clean local workspace directory with family.db and media/."""
    workspace_dir.mkdir(parents=True, exist_ok=True)
    (workspace_dir / "media" / "avatars").mkdir(parents=True, exist_ok=True)
    db_path = workspace_dir / "family.db"
    conn = connect_sqlite(db_path)
    try:
        schema_ver = ensure_schema(conn)
        now = utc_now_iso()
        existing_name = conn.execute(
            "SELECT value FROM tree_settings WHERE key = 'tree_name';"
        ).fetchone()
        if existing_name is None:
            conn.execute(
                "INSERT INTO tree_settings (key, value, updated_at) VALUES ('tree_name', ?, ?);",
                (tree_name, now),
            )
            conn.commit()
            resolved_name = tree_name
        else:
            resolved_name = str(existing_name["value"])

        if not (workspace_dir / "meta.json").is_file():
            meta = TreeMeta(
                format=FORMAT_NAME,
                format_version=FORMAT_VERSION,
                schema_version=schema_ver,
                tree_name=resolved_name,
                app_version=__version__,
                created_at=now,
                updated_at=now,
            )
            write_workspace_meta(workspace_dir, meta)
    finally:
        conn.close()
    return db_path


def _snapshot_sqlite(source_db: Path, dest_db: Path) -> None:
    """Use SQLite's online backup API to create a clean, single-file snapshot."""
    src_conn = connect_sqlite(source_db)
    try:
        dst_conn = sqlite3.connect(str(dest_db))
        try:
            src_conn.backup(dst_conn)
            dst_conn.commit()
        finally:
            dst_conn.close()
    finally:
        src_conn.close()


def export_ftree_package(workspace_dir: Path, output_path: Path) -> Path:
    """Bundle family.db, referenced media/, and meta.json into a portable .ftree ZIP."""
    db_path = workspace_dir / "family.db"
    if not db_path.is_file():
        raise PackageError("Nincs aktív családfa adatbázis a mentéshez.")

    output_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="ftree_export_") as tmp_dir_str:
        tmp_dir = Path(tmp_dir_str)
        snapshot_db = tmp_dir / "family.db"
        _snapshot_sqlite(db_path, snapshot_db)

        conn = connect_sqlite(snapshot_db)
        try:
            schema_ver = ensure_schema(conn)
            person_count = int(conn.execute("SELECT COUNT(*) FROM persons;").fetchone()[0])
            union_count = int(conn.execute("SELECT COUNT(*) FROM unions;").fetchone()[0])
            relation_count = int(conn.execute("SELECT COUNT(*) FROM parent_child;").fetchone()[0])
            name_row = conn.execute(
                "SELECT value FROM tree_settings WHERE key = 'tree_name';"
            ).fetchone()
            avatar_rows = conn.execute(
                "SELECT DISTINCT avatar_path FROM persons WHERE avatar_path != '';"
            ).fetchall()
            referenced_media = {str(r["avatar_path"]) for r in avatar_rows}
        finally:
            conn.close()

        prev_meta = read_workspace_meta(workspace_dir)
        now = utc_now_iso()
        meta = TreeMeta(
            format=FORMAT_NAME,
            format_version=FORMAT_VERSION,
            schema_version=schema_ver,
            tree_name=str(name_row["value"]) if name_row else prev_meta.tree_name,
            app_version=__version__,
            created_at=prev_meta.created_at or now,
            updated_at=now,
            person_count=person_count,
            union_count=union_count,
            relation_count=relation_count,
        )
        write_workspace_meta(workspace_dir, meta)

        tmp_zip = tmp_dir / "archive.ftree"
        with zipfile.ZipFile(tmp_zip, mode="w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            zf.writestr("meta.json", json.dumps(meta.to_dict(), ensure_ascii=False, indent=2))
            zf.write(snapshot_db, arcname="family.db")

            media_root = (workspace_dir / "media").resolve()
            if media_root.is_dir():
                for rel in sorted(referenced_media):
                    if "\\" in rel or not rel.startswith("media/"):
                        continue
                    candidate = (workspace_dir / rel).resolve()
                    if candidate.is_file() and candidate.is_relative_to(media_root):
                        zf.write(candidate, arcname=rel)

        shutil.move(str(tmp_zip), str(output_path))
    return output_path


def _validate_zip_member(info: zipfile.ZipInfo, target_root: Path) -> Path:
    """Prevent Zip Slip path traversal and unsafe archive entries."""
    raw_name = info.filename
    if not raw_name or raw_name.startswith("/") or "\\" in raw_name:
        raise PackageError(f"Érvénytelen fájlnév a csomagban: '{raw_name}'.")

    posix = PurePosixPath(raw_name)
    if posix.is_absolute() or ".." in posix.parts:
        raise PackageError(f"Tiltott elérési út a csomagban: '{raw_name}'.")

    resolved_root = target_root.resolve()
    dest = (resolved_root / Path(*posix.parts)).resolve()
    if not dest.is_relative_to(resolved_root):
        raise PackageError(f"Tiltott célútvonal a csomagban: '{raw_name}'.")
    return dest


def import_ftree_package(archive_path: Path, workspace_dir: Path) -> TreeMeta:
    """Validate and unpack a .ftree ZIP archive into workspace_dir safely."""
    if not archive_path.is_file():
        raise PackageError("A megadott .ftree csomagfájl nem található.")

    if not zipfile.is_zipfile(archive_path):
        raise PackageError("A kiválasztott fájl nem érvényes .ftree (ZIP) csomag.")

    with tempfile.TemporaryDirectory(prefix="ftree_import_") as tmp_dir_str:
        staging = Path(tmp_dir_str)
        total_uncompressed = 0

        try:
            with zipfile.ZipFile(archive_path, mode="r") as zf:
                infos = zf.infolist()
                if len(infos) > MAX_ARCHIVE_ENTRIES:
                    raise PackageError("A csomag túl sok fájlt tartalmaz.")

                for info in infos:
                    if info.is_dir():
                        continue
                    total_uncompressed += max(0, info.file_size)
                    if total_uncompressed > MAX_ARCHIVE_UNCOMPRESSED_BYTES:
                        raise PackageError("A csomag mérete meghaladja a biztonsági korlátot.")

                    dest = _validate_zip_member(info, staging)
                    # Only allow known package paths: meta.json, family.db, media/*
                    rel = info.filename
                    if rel not in ("meta.json", "family.db") and not rel.startswith("media/"):
                        raise PackageError(f"Ismeretlen fájl a csomagban: '{rel}'.")

                    dest.parent.mkdir(parents=True, exist_ok=True)
                    with zf.open(info, "r") as src, dest.open("wb") as dst:
                        shutil.copyfileobj(src, dst)
        except zipfile.BadZipFile as exc:
            raise PackageError("A .ftree archívum sérült vagy hibás.") from exc

        staged_db = staging / "family.db"
        if not staged_db.is_file():
            raise PackageError("A csomagból hiányzik a 'family.db' adatbázis.")

        # Validate SQLite integrity & apply any forward schema migrations
        try:
            conn = connect_sqlite(staged_db)
            try:
                integrity = conn.execute("PRAGMA integrity_check;").fetchone()[0]
                if integrity != "ok":
                    raise PackageError("A csomagban lévő SQLite adatbázis sérült.")
                schema_ver = ensure_schema(conn)
                person_count = int(conn.execute("SELECT COUNT(*) FROM persons;").fetchone()[0])
                union_count = int(conn.execute("SELECT COUNT(*) FROM unions;").fetchone()[0])
                relation_count = int(conn.execute("SELECT COUNT(*) FROM parent_child;").fetchone()[0])
                name_row = conn.execute(
                    "SELECT value FROM tree_settings WHERE key = 'tree_name';"
                ).fetchone()
            finally:
                conn.close()
        except sqlite3.DatabaseError as exc:
            raise PackageError(f"Hibás SQLite adatbázis a csomagban: {exc}") from exc

        staged_meta = read_workspace_meta(staging)
        now = utc_now_iso()
        final_meta = TreeMeta(
            format=FORMAT_NAME,
            format_version=FORMAT_VERSION,
            schema_version=schema_ver,
            tree_name=str(name_row["value"]) if name_row else staged_meta.tree_name,
            app_version=__version__,
            created_at=staged_meta.created_at or now,
            updated_at=now,
            person_count=person_count,
            union_count=union_count,
            relation_count=relation_count,
        )
        write_workspace_meta(staging, final_meta)
        (staging / "media" / "avatars").mkdir(parents=True, exist_ok=True)

        # Atomically replace workspace contents
        workspace_dir.mkdir(parents=True, exist_ok=True)
        for item_name in ("family.db", "family.db-wal", "family.db-shm", "meta.json"):
            p = workspace_dir / item_name
            if p.is_file():
                p.unlink()
        media_dest = workspace_dir / "media"
        if media_dest.exists():
            shutil.rmtree(media_dest)

        shutil.copy2(staging / "family.db", workspace_dir / "family.db")
        shutil.copy2(staging / "meta.json", workspace_dir / "meta.json")
        shutil.copytree(staging / "media", media_dest)

    return final_meta
