"""SQLite connection management, schema initialization, and forward migrations."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .validators import utc_now_iso

CURRENT_SCHEMA_VERSION = 1
SCHEMA_SQL_PATH = Path(__file__).resolve().parent / "schema.sql"


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    apply: Callable[[sqlite3.Connection], None]


def _apply_initial_schema(conn: sqlite3.Connection) -> None:
    sql_script = SCHEMA_SQL_PATH.read_text(encoding="utf-8")
    conn.executescript(sql_script)


# Ordered list of schema migrations. Future versions append here so older .ftree
# files migrate seamlessly without breaking existing fields.
MIGRATIONS: list[Migration] = [
    Migration(version=1, name="initial_family_tree_schema", apply=_apply_initial_schema),
]


def connect_sqlite(db_path: str | Path) -> sqlite3.Connection:
    """Open a SQLite connection configured with foreign keys and safe concurrency."""
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=10.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    configure_connection(conn)
    return conn


def configure_connection(conn: sqlite3.Connection) -> None:
    """Ensure foreign keys and resilient pragmas are active on every connection."""
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA busy_timeout = 5000;")
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")


def get_schema_version(conn: sqlite3.Connection) -> int:
    """Return the highest applied migration version, or 0 for an uninitialized DB."""
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations';"
    ).fetchone()
    if row is None:
        return int(conn.execute("PRAGMA user_version;").fetchone()[0])

    ver_row = conn.execute("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations;").fetchone()
    return int(ver_row["v"]) if ver_row else 0


def ensure_schema(conn: sqlite3.Connection) -> int:
    """Initialize or migrate the SQLite database up to CURRENT_SCHEMA_VERSION."""
    configure_connection(conn)
    current_version = get_schema_version(conn)

    for migration in MIGRATIONS:
        if migration.version <= current_version:
            continue
        migration.apply(conn)
        conn.execute(
            """
            INSERT OR REPLACE INTO schema_migrations (version, name, applied_at)
            VALUES (?, ?, ?);
            """,
            (migration.version, migration.name, utc_now_iso()),
        )
        conn.execute(f"PRAGMA user_version = {int(migration.version)};")
        conn.commit()
        current_version = migration.version

    return current_version
