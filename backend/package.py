"""Portable .ftree (ZIP) archive packager and unpackager."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import shutil
import sqlite3
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

from . import __version__
from .db import CURRENT_SCHEMA_VERSION, connect_sqlite, ensure_schema
from .models import PackageError, TreeMeta
from .validators import utc_now_iso

logger = logging.getLogger(__name__)

FORMAT_NAME = "ftree"
FORMAT_VERSION = 1
CHECKSUM_ALGORITHM = "sha256"
MAX_ARCHIVE_ENTRIES = 5000
MAX_ARCHIVE_UNCOMPRESSED_BYTES = 250 * 1024 * 1024  # 250 MB
_SHA256_HEX_RE = re.compile(r"^[0-9a-f]{64}$", re.IGNORECASE)


def compute_sha256(file_path: Path) -> str:
    """Compute lowercase hexadecimal SHA-256 digest for a file."""
    digest = hashlib.sha256()
    with file_path.open("rb") as fh:
        while True:
            chunk = fh.read(65536)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _atomic_write_text(target: Path, content: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=str(target.parent), prefix=".tmp_", suffix=target.suffix or ".tmp"
    )
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(content)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(str(tmp_path), str(target))
    except Exception:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
        raise


def _atomic_write_bytes(target: Path, data: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=str(target.parent), prefix=".tmp_", suffix=target.suffix or ".tmp"
    )
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(str(tmp_path), str(target))
    except Exception:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
        raise


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

    raw_checksums = data.get("checksums")
    checksums: dict[str, str] = {}
    if isinstance(raw_checksums, dict):
        for k, v in raw_checksums.items():
            if isinstance(k, str) and isinstance(v, str):
                checksums[k] = v

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
        checksum_algorithm=str(data.get("checksum_algorithm") or CHECKSUM_ALGORITHM),
        checksums=checksums,
    )


def write_workspace_meta(workspace_dir: Path, meta: TreeMeta) -> Path:
    meta_file = workspace_dir / "meta.json"
    _atomic_write_text(
        meta_file,
        json.dumps(meta.to_dict(), ensure_ascii=False, indent=2),
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
                checksum_algorithm=CHECKSUM_ALGORITHM,
                checksums={},
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
    """Bundle family.db, referenced media/, and meta.json (with SHA-256 checksums) atomically."""
    db_path = workspace_dir / "family.db"
    if not db_path.is_file():
        raise PackageError(
            "Nincs aktív családfa adatbázis a mentéshez.",
            code="PACKAGE_NO_DATABASE",
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)

    try:
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
                referenced_media = {str(r["avatar_path"]).lstrip("/") for r in avatar_rows}
            finally:
                conn.close()

            media_files: list[tuple[str, Path]] = []
            checksums: dict[str, str] = {
                "family.db": compute_sha256(snapshot_db),
            }

            media_root = (workspace_dir / "media").resolve()
            if media_root.is_dir():
                for rel in sorted(referenced_media):
                    if "\\" in rel or not rel.startswith("media/"):
                        continue
                    candidate = (workspace_dir / rel).resolve()
                    if candidate.is_file() and candidate.is_relative_to(media_root):
                        checksums[rel] = compute_sha256(candidate)
                        media_files.append((rel, candidate))

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
                checksum_algorithm=CHECKSUM_ALGORITHM,
                checksums=checksums,
            )
            write_workspace_meta(workspace_dir, meta)

            # Create temp archive in the exact same directory as output_path for true atomic os.replace
            fd, tmp_zip_name = tempfile.mkstemp(
                dir=str(output_path.parent), prefix=".tmp_export_", suffix=".ftree"
            )
            os.close(fd)
            tmp_zip = Path(tmp_zip_name)
            try:
                with zipfile.ZipFile(
                    tmp_zip, mode="w", compression=zipfile.ZIP_DEFLATED, compresslevel=6
                ) as zf:
                    zf.writestr("meta.json", json.dumps(meta.to_dict(), ensure_ascii=False, indent=2))
                    zf.write(snapshot_db, arcname="family.db")
                    for rel, candidate in media_files:
                        zf.write(candidate, arcname=rel)

                with tmp_zip.open("r+b") as fh:
                    os.fsync(fh.fileno())
                os.replace(str(tmp_zip), str(output_path))
            except Exception:
                if tmp_zip.exists():
                    tmp_zip.unlink(missing_ok=True)
                raise
    except PackageError:
        raise
    except (OSError, sqlite3.Error, zipfile.BadZipFile) as exc:
        logger.exception("Package export failed")
        raise PackageError(
            "Nem sikerült elkészíteni a .ftree mentési fájlt.",
            code="PACKAGE_EXPORT_ERROR",
            hint="Ellenőrizd a rendelkezésre álló tárhelyet, majd próbáld meg újra.",
        ) from exc
    return output_path


def _validate_zip_member(info: zipfile.ZipInfo, target_root: Path) -> Path:
    """Prevent Zip Slip path traversal and unsafe archive entries."""
    raw_name = info.filename
    if not raw_name or raw_name.startswith("/") or "\\" in raw_name:
        raise PackageError(
            "A csomag érvénytelen fájlelérési utat tartalmaz.",
            code="INVALID_ARCHIVE_ENTRY",
        )

    posix = PurePosixPath(raw_name)
    if posix.is_absolute() or ".." in posix.parts:
        raise PackageError(
            "A csomag nem engedélyezett elérési utat tartalmaz.",
            code="INVALID_ARCHIVE_ENTRY",
        )

    resolved_root = target_root.resolve()
    dest = (resolved_root / Path(*posix.parts)).resolve()
    if not dest.is_relative_to(resolved_root):
        raise PackageError(
            "A csomag nem engedélyezett célútvonalat tartalmaz.",
            code="INVALID_ARCHIVE_ENTRY",
        )
    return dest


def _verify_staged_checksums(staging: Path, raw_meta: dict[str, object] | None) -> tuple[bool, str | None]:
    """Verify SHA-256 checksums in staged meta.json.

    Returns (checksums_enforced, legacy_warning).
    """
    if raw_meta is None or "checksums" not in raw_meta or raw_meta.get("checksums") is None:
        return (
            False,
            "Ez egy régebbi .ftree csomag, amely még nem tartalmaz SHA-256 ellenőrzőösszeget. A következő mentéskor már automatikusan védve lesz.",
        )

    algo = str(raw_meta.get("checksum_algorithm") or CHECKSUM_ALGORITHM).strip().lower()
    if algo != CHECKSUM_ALGORITHM:
        raise PackageError(
            "A csomag ismeretlen ellenőrzőösszeg-algoritmust használ, ezért nem tölthető be biztonságosan.",
            code="CHECKSUM_MISMATCH",
            hint="Ellenőrizd, hogy valóban a Családfa alkalmazással mentett .ftree fájlt választottál-e ki.",
        )

    raw_checksums = raw_meta.get("checksums")
    if not isinstance(raw_checksums, dict) or "family.db" not in raw_checksums:
        raise PackageError(
            "A csomag ellenőrzőösszeg-adatai hiányosak vagy sérültek.",
            code="CHECKSUM_MISMATCH",
            hint="A fájl sérült vagy módosult. Próbálj meg egy korábbi ép biztonsági mentést betölteni.",
        )

    staging_root = staging.resolve()
    for rel_key, expected_val in raw_checksums.items():
        if (
            not isinstance(rel_key, str)
            or not isinstance(expected_val, str)
            or not rel_key
            or rel_key.startswith("/")
            or "\\" in rel_key
            or ".." in PurePosixPath(rel_key).parts
            or (rel_key != "family.db" and not rel_key.startswith("media/"))
        ):
            raise PackageError(
                "A csomag ellenőrzőösszeg-listája érvénytelen hivatkozást tartalmaz.",
                code="CHECKSUM_MISMATCH",
            )

        if not _SHA256_HEX_RE.match(expected_val.strip()):
            raise PackageError(
                "A csomagban található SHA-256 ellenőrzőösszeg formátuma hibás.",
                code="CHECKSUM_MISMATCH",
            )

        target = (staging_root / rel_key).resolve()
        if not target.is_relative_to(staging_root) or not target.is_file():
            raise PackageError(
                "A csomagból hiányzik egy ellenőrzőösszeggel védett fájl, ezért a betöltés megszakadt.",
                code="CHECKSUM_MISMATCH",
                hint="A .ftree archívum hiányos vagy megsérült. Használj egy korábbi biztonsági mentést.",
            )

        actual_hex = compute_sha256(target)
        if not hmac.compare_digest(actual_hex.lower(), expected_val.strip().lower()):
            raise PackageError(
                "A családfa csomag ellenőrzőösszege (SHA-256) nem egyezik: a fájl megsérült vagy módosult.",
                code="CHECKSUM_MISMATCH",
                hint="A sérült adatok betöltése a családfád védelme érdekében megszakadt. Próbáld meg egy korábbi mentésből visszaállítani.",
            )

    return True, None


def import_ftree_package_checked(
    archive_path: Path, workspace_dir: Path
) -> tuple[TreeMeta, str | None]:
    """Validate checksums, SQLite integrity, and unpack a .ftree ZIP archive atomically."""
    if not archive_path.is_file():
        raise PackageError(
            "A megadott .ftree csomagfájl nem található.",
            code="PACKAGE_NOT_FOUND",
        )

    if not zipfile.is_zipfile(archive_path):
        raise PackageError(
            "A kiválasztott fájl nem érvényes .ftree csomag.",
            code="INVALID_ARCHIVE",
            hint="Ellenőrizd, hogy valóban egy .ftree kiterjesztésű családfa mentést választottál-e ki.",
        )

    with tempfile.TemporaryDirectory(prefix="ftree_import_") as tmp_dir_str:
        staging = Path(tmp_dir_str)
        total_uncompressed = 0

        try:
            with zipfile.ZipFile(archive_path, mode="r") as zf:
                infos = zf.infolist()
                if len(infos) > MAX_ARCHIVE_ENTRIES:
                    raise PackageError("A csomag túl sok fájlt tartalmaz.", code="ARCHIVE_TOO_MANY_FILES")

                for info in infos:
                    if info.is_dir():
                        continue
                    total_uncompressed += max(0, info.file_size)
                    if total_uncompressed > MAX_ARCHIVE_UNCOMPRESSED_BYTES:
                        raise PackageError(
                            "A csomag mérete meghaladja a biztonsági korlátot.",
                            code="ARCHIVE_TOO_LARGE",
                        )

                    dest = _validate_zip_member(info, staging)
                    rel = info.filename
                    if rel not in ("meta.json", "family.db") and not rel.startswith("media/"):
                        raise PackageError(
                            "A csomag nem támogatott fájlt tartalmaz.",
                            code="UNEXPECTED_ARCHIVE_ENTRY",
                        )

                    dest.parent.mkdir(parents=True, exist_ok=True)
                    with zf.open(info, "r") as src, dest.open("wb") as dst:
                        shutil.copyfileobj(src, dst)
        except zipfile.BadZipFile as exc:
            logger.warning("Corrupt zip archive rejected: %s", exc)
            raise PackageError(
                "A .ftree archívum sérült vagy hibás.",
                code="CORRUPT_ARCHIVE",
                hint="Tölts be egy korábbi, ép biztonsági mentést.",
            ) from exc
        except OSError as exc:
            logger.exception("IO error while unpacking archive")
            raise PackageError(
                "Nem sikerült kicsomagolni a .ftree fájlt.",
                code="PACKAGE_UNPACK_ERROR",
            ) from exc

        staged_meta_file = staging / "meta.json"
        raw_meta: dict[str, object] | None = None
        if staged_meta_file.is_file():
            try:
                loaded_meta = json.loads(staged_meta_file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                logger.warning("Corrupt meta.json inside archive: %s", exc)
                raise PackageError(
                    "A csomag metaadatai sérültek vagy olvashatatlanok.",
                    code="INVALID_PACKAGE_META",
                    hint="A .ftree fájl megsérülhetett. Próbálj meg egy másik mentést betölteni.",
                ) from exc
            if not isinstance(loaded_meta, dict):
                raise PackageError(
                    "A csomag metaadatai hibás szerkezetűek.",
                    code="INVALID_PACKAGE_META",
                )
            raw_meta = loaded_meta

        checksums_enforced, legacy_warning = _verify_staged_checksums(staging, raw_meta)

        staged_db = staging / "family.db"
        if not staged_db.is_file():
            raise PackageError(
                "A csomagból hiányzik a családfa adatbázisa.",
                code="MISSING_DATABASE",
            )

        # Validate SQLite integrity, foreign-key consistency & apply forward schema migrations
        try:
            conn = connect_sqlite(staged_db)
            try:
                integrity = conn.execute("PRAGMA integrity_check;").fetchone()[0]
                if integrity != "ok":
                    raise PackageError(
                        "A csomagban lévő adatbázis sérült.",
                        code="CORRUPT_DATABASE",
                    )
                fk_violations = conn.execute("PRAGMA foreign_key_check;").fetchall()
                if fk_violations:
                    raise PackageError(
                        "A csomagban lévő adatbázis kapcsolati hivatkozásai sérültek.",
                        code="CORRUPT_DATABASE",
                    )
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
                referenced_media = {str(r["avatar_path"]).lstrip("/") for r in avatar_rows}
            finally:
                conn.close()
        except PackageError:
            raise
        except sqlite3.DatabaseError as exc:
            logger.warning("SQLite error while validating imported package: %s", exc)
            raise PackageError(
                "A csomagban található adatbázis sérült vagy nem olvasható.",
                code="INVALID_DATABASE",
                hint="Ellenőrizd, hogy ép .ftree fájlt választottál-e ki.",
            ) from exc

        # If checksums were enforced, verify no tampered/unlisted media file exists for referenced avatars
        if checksums_enforced and raw_meta is not None:
            raw_cs = raw_meta.get("checksums") or {}
            if isinstance(raw_cs, dict):
                for rel in referenced_media:
                    candidate = staging / rel
                    if candidate.is_file() and rel not in raw_cs:
                        raise PackageError(
                            "A csomag egy ellenőrizetlen portréképet tartalmaz, ezért a betöltés megszakadt.",
                            code="CHECKSUM_MISMATCH",
                            hint="A csomag fájllistája nem egyezik a tartalommal.",
                        )

        # Prune any unreferenced media files inside staging so imported workspace stays tidy
        resolved_staging = staging.resolve()
        staged_media_root = resolved_staging / "media"
        if staged_media_root.is_dir():
            for path in list(staged_media_root.rglob("*")):
                if path.is_file():
                    rel = path.relative_to(resolved_staging).as_posix()
                    if rel not in referenced_media:
                        path.unlink(missing_ok=True)

        (staging / "media" / "avatars").mkdir(parents=True, exist_ok=True)

        # Cleanly snapshot the migrated DB so WAL/SHM sidecars aren't needed during swap
        clean_db = staging / "family_clean.db"
        try:
            _snapshot_sqlite(staged_db, clean_db)
            db_bytes = clean_db.read_bytes()
        except (sqlite3.Error, OSError) as exc:
            logger.exception("Failed to snapshot migrated database during import")
            raise PackageError(
                "Nem sikerült előkészíteni a betöltendő adatbázist.",
                code="PACKAGE_IMPORT_ERROR",
            ) from exc

        final_checksums: dict[str, str] = {"family.db": compute_sha256(clean_db)}
        if staged_media_root.is_dir():
            for rel in sorted(referenced_media):
                candidate = (staging / rel).resolve()
                if candidate.is_file() and candidate.is_relative_to(staged_media_root):
                    final_checksums[rel] = compute_sha256(candidate)

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
            checksum_algorithm=CHECKSUM_ALGORITHM,
            checksums=final_checksums,
        )

        # Atomically replace workspace contents with full rollback on error
        workspace_dir.mkdir(parents=True, exist_ok=True)
        prev_db_bytes = (workspace_dir / "family.db").read_bytes() if (workspace_dir / "family.db").is_file() else None
        prev_meta_bytes = (workspace_dir / "meta.json").read_bytes() if (workspace_dir / "meta.json").is_file() else None

        tmp_media_dir = Path(tempfile.mkdtemp(dir=str(workspace_dir), prefix=".tmp_media_"))
        media_dest = workspace_dir / "media"
        media_backup: Path | None = None
        try:
            shutil.copytree(staging / "media", tmp_media_dir, dirs_exist_ok=True)
            if media_dest.exists():
                media_backup = Path(
                    tempfile.mkdtemp(dir=str(workspace_dir), prefix=".tmp_media_old_")
                )
                media_backup.rmdir()
                media_dest.rename(media_backup)
            tmp_media_dir.rename(media_dest)

            for sidecar_name in ("family.db-wal", "family.db-shm"):
                sidecar = workspace_dir / sidecar_name
                if sidecar.is_file():
                    sidecar.unlink()

            _atomic_write_bytes(workspace_dir / "family.db", db_bytes)
            write_workspace_meta(workspace_dir, final_meta)

            if media_backup is not None and media_backup.exists():
                shutil.rmtree(media_backup, ignore_errors=True)
        except Exception as exc:
            logger.exception("Failed during atomic workspace replacement on import")
            if prev_db_bytes is not None:
                try:
                    _atomic_write_bytes(workspace_dir / "family.db", prev_db_bytes)
                except OSError:
                    pass
            if prev_meta_bytes is not None:
                try:
                    _atomic_write_bytes(workspace_dir / "meta.json", prev_meta_bytes)
                except OSError:
                    pass
            if media_backup is not None and media_backup.exists():
                if media_dest.exists():
                    shutil.rmtree(media_dest, ignore_errors=True)
                media_backup.rename(media_dest)
            if tmp_media_dir.exists():
                shutil.rmtree(tmp_media_dir, ignore_errors=True)
            raise PackageError(
                "A családfa betöltése közben fájlrendszeri hiba történt, az eredeti állapot változatlan maradt.",
                code="PACKAGE_IMPORT_ERROR",
            ) from exc

    return final_meta, legacy_warning


def import_ftree_package(archive_path: Path, workspace_dir: Path) -> TreeMeta:
    """Validate and unpack a .ftree ZIP archive into workspace_dir atomically."""
    meta, _warning = import_ftree_package_checked(archive_path, workspace_dir)
    return meta
