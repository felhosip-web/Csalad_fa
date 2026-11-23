"""Zero-dependency cross-platform HTTP API server for the family tree backend.

Runs out-of-the-box on Linux and Windows with Python 3.11+ standard library.
Implements the full REST API contract defined in docs/api-contract.md.
"""

from __future__ import annotations

import argparse
import json
import logging
import mimetypes
import os
import tempfile
from email.parser import BytesParser
from email.policy import default as email_policy
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

from . import __version__
from .media import CONTENT_TYPES, PILLOW_AVAILABLE, resolve_media_path
from .models import BackendError, PackageError, ValidationError, format_error_payload
from .service import FamilyTreeService

logger = logging.getLogger(__name__)

MAX_BODY_BYTES = 25 * 1024 * 1024  # 25 MB max request body


def _parse_multipart_file(content_type: str, body: bytes, field_name: str = "file") -> bytes:
    """Extract binary file payload from multipart/form-data using stdlib email parser."""
    header_block = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8")
    msg = BytesParser(policy=email_policy).parsebytes(header_block + body)
    if not msg.is_multipart():
        raise ValidationError("Érvénytelen fájlfeltöltési kérés.")

    first_file: bytes | None = None
    for part in msg.iter_parts():
        disp_name = part.get_param("name", header="content-disposition")
        payload = part.get_payload(decode=True)
        if payload is None:
            continue
        if disp_name == field_name:
            return payload
        if first_file is None and part.get_filename():
            first_file = payload

    if first_file is not None:
        return first_file
    raise ValidationError("Nem található feltöltött fájl a kérésben.")


class FamilyTreeHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(
        self,
        server_address: tuple[str, int],
        service: FamilyTreeService,
        static_dir: str | Path | None = None,
    ) -> None:
        self.service = service
        self.static_dir: Path | None = (
            Path(static_dir).resolve() if static_dir is not None else None
        )
        super().__init__(server_address, FamilyTreeRequestHandler)


class FamilyTreeRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    @property
    def service(self) -> FamilyTreeService:
        return self.server.service  # type: ignore[attr-defined]

    @property
    def static_dir(self) -> Path | None:
        return self.server.static_dir  # type: ignore[attr-defined]

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        if os.environ.get("FTREE_QUIET_LOGS") == "1":
            return
        super().log_message(format, *args)

    # --- Response helpers ---
    def _send_json(self, status: int, payload: Any) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _send_bytes(
        self,
        status: int,
        data: bytes,
        *,
        content_type: str,
        filename: str | None = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self) -> bytes:
        raw_len = self.headers.get("Content-Length")
        if not raw_len:
            return b""
        try:
            length = int(raw_len)
        except ValueError as exc:
            raise ValidationError("Érvénytelen kérésméret-fejléc.") from exc
        if length < 0 or length > MAX_BODY_BYTES:
            raise ValidationError("A kérés mérete meghaladja a megengedett korlátot.")
        return self.rfile.read(length) if length > 0 else b""

    def _read_json(self) -> dict[str, Any]:
        body = self._read_body()
        if not body:
            return {}
        try:
            parsed = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValidationError("Érvénytelen adat formátum a kérésben.") from exc
        if not isinstance(parsed, dict):
            raise ValidationError("A kérés adatainak objektum formátumúnak kell lenniük.")
        return parsed

    def _handle_exception(self, exc: Exception) -> None:
        if isinstance(exc, BackendError):
            logger.warning("Request failed (%s %s) [%s]: %s", self.command, self.path, exc.code, exc.message)
            self._send_json(exc.status_code, exc.to_dict())
            return
        logger.exception("Unhandled server exception (%s %s)", self.command, self.path)
        self._send_json(
            HTTPStatus.INTERNAL_SERVER_ERROR,
            format_error_payload(
                "internal_error",
                "Váratlan belső szerverhiba történt.",
                "Próbáld meg újra egy pillanat múlva.",
            ),
        )

    # --- HTTP Verb Dispatchers ---
    def do_GET(self) -> None:  # noqa: N802
        try:
            self._route_get()
        except Exception as exc:  # noqa: BLE001
            self._handle_exception(exc)

    def do_POST(self) -> None:  # noqa: N802
        try:
            self._route_post()
        except Exception as exc:  # noqa: BLE001
            self._handle_exception(exc)

    def do_PATCH(self) -> None:  # noqa: N802
        try:
            self._route_patch()
        except Exception as exc:  # noqa: BLE001
            self._handle_exception(exc)

    def do_DELETE(self) -> None:  # noqa: N802
        try:
            self._route_delete()
        except Exception as exc:  # noqa: BLE001
            self._handle_exception(exc)

    # --- Route Handlers ---
    def _route_get(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        qs = parse_qs(parsed.query)
        parts = [p for p in path.split("/") if p]

        if path == "/api/health":
            self._send_json(
                200,
                {
                    "status": "ok",
                    "engine": "python-stdlib-sqlite",
                    "version": __version__,
                    "pillow_available": PILLOW_AVAILABLE,
                },
            )
            return

        if path == "/api/tree":
            search = qs.get("search", [""])[0]
            self._send_json(200, self.service.get_tree_snapshot(search=search))
            return

        if path == "/api/persons":
            search = qs.get("search", [""])[0]
            self._send_json(200, {"persons": self.service.list_persons(search=search)})
            return

        if len(parts) == 3 and parts[0] == "api" and parts[1] == "persons":
            person_id = unquote(parts[2])
            self._send_json(200, self.service.get_person_bundle(person_id))
            return

        if path == "/api/package/export":
            with tempfile.TemporaryDirectory(prefix="ftree_dl_") as tmp_dir:
                out_file = Path(tmp_dir) / "csaladfa.ftree"
                self.service.export_package(out_file)
                data = out_file.read_bytes()
            self._send_bytes(
                200,
                data,
                content_type="application/octet-stream",
                filename="csaladfa.ftree",
            )
            return

        if parts and parts[0] == "media":
            rel_path = "/".join(unquote(p) for p in parts)
            target = resolve_media_path(self.service.workspace_dir, rel_path)
            if not target.is_file():
                self._send_json(404, format_error_payload("not_found", "A kért kép nem található."))
                return
            ctype = CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream")
            self._send_bytes(200, target.read_bytes(), content_type=ctype)
            return

        if self.static_dir is not None and not path.startswith("/api/") and path != "/api":
            if self._serve_static_asset(path):
                return

        self._send_json(404, format_error_payload("not_found", "A kért végpont nem található."))

    def _serve_static_asset(self, url_path: str) -> bool:
        """Serve bundled React production files safely when running in desktop/standalone mode."""
        static_root = self.static_dir
        if static_root is None or not static_root.is_dir():
            return False

        rel = unquote(url_path.lstrip("/"))
        target: Path | None = None
        if rel:
            try:
                candidate = (static_root / rel).resolve()
                candidate.relative_to(static_root)
            except ValueError:
                return False
            if candidate.is_file():
                target = candidate
            elif "." in Path(rel).name:
                # Missing static asset (e.g. .js/.css/.png) should return 404 rather than HTML
                return False

        if target is None:
            index_file = static_root / "index.html"
            if not index_file.is_file():
                return False
            target = index_file

        mime_type, _ = mimetypes.guess_type(str(target))
        ctype = mime_type or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
            ctype = f"{ctype}; charset=utf-8"

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        data = target.read_bytes()
        self.send_header("Content-Length", str(len(data)))
        cache_control = "no-cache" if target.name == "index.html" else "public, max-age=3600"
        self.send_header("Cache-Control", cache_control)
        self.end_headers()
        self.wfile.write(data)
        return True

    def _route_post(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        parts = [p for p in path.split("/") if p]

        if path == "/api/persons":
            created = self.service.create_person(self._read_json())
            self._send_json(201, {"person": created})
            return

        if len(parts) == 4 and parts[:2] == ["api", "persons"]:
            person_id = unquote(parts[2])
            action = parts[3]
            if action == "quick-parent":
                res = self.service.quick_add_parent(person_id, self._read_json())
                self._send_json(201, res)
                return
            if action == "quick-child":
                res = self.service.quick_add_child(person_id, self._read_json())
                self._send_json(201, res)
                return
            if action == "quick-partner":
                res = self.service.quick_add_partner(person_id, self._read_json())
                self._send_json(201, res)
                return
            if action == "avatar":
                ctype = self.headers.get("Content-Type", "")
                body = self._read_body()
                if "multipart/form-data" in ctype.lower():
                    raw_img = _parse_multipart_file(ctype, body, field_name="file")
                else:
                    raw_img = body
                res = self.service.upload_person_avatar(person_id, raw_img)
                self._send_json(200, res)
                return

        if path == "/api/unions":
            created = self.service.create_union(self._read_json())
            self._send_json(201, {"union": created})
            return

        if path == "/api/relations":
            created = self.service.add_parent_child(self._read_json())
            self._send_json(201, {"relation": created})
            return

        if path == "/api/package/new":
            data = self._read_json()
            tree_name = str(data.get("tree_name") or "Új családfa")
            self._send_json(200, self.service.create_new_tree(tree_name=tree_name))
            return

        if path == "/api/package/seed-sample":
            self._send_json(200, self.service.seed_sample_family())
            return

        if path == "/api/undo":
            self._send_json(200, self.service.undo_last_action())
            return

        if path == "/api/package/import":
            ctype = self.headers.get("Content-Type", "")
            body = self._read_body()
            if "multipart/form-data" in ctype.lower():
                raw_archive = _parse_multipart_file(ctype, body, field_name="file")
            else:
                raw_archive = body
            if not raw_archive:
                raise PackageError(
                    "A kiválasztott .ftree csomagfájl üres.",
                    code="EMPTY_ARCHIVE",
                    hint="Válassz ki egy érvényes, nem üres .ftree fájlt.",
                )
            with tempfile.TemporaryDirectory(prefix="ftree_up_") as tmp_dir:
                tmp_file = Path(tmp_dir) / "upload.ftree"
                tmp_file.write_bytes(raw_archive)
                res = self.service.import_package(tmp_file)
            self._send_json(200, res)
            return

        self._send_json(404, format_error_payload("not_found", "A kért végpont nem található."))

    def _route_patch(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        parts = [p for p in path.split("/") if p]

        if path == "/api/tree/meta":
            data = self._read_json()
            meta = self.service.rename_tree(str(data.get("tree_name") or ""))
            self._send_json(200, {"meta": meta})
            return

        if len(parts) == 3 and parts[:2] == ["api", "persons"]:
            person_id = unquote(parts[2])
            updated = self.service.update_person(person_id, self._read_json())
            self._send_json(200, {"person": updated})
            return

        if len(parts) == 3 and parts[:2] == ["api", "unions"]:
            union_id = unquote(parts[2])
            updated = self.service.update_union(union_id, self._read_json())
            self._send_json(200, {"union": updated})
            return

        self._send_json(404, format_error_payload("not_found", "A kért végpont nem található."))

    def _route_delete(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        parts = [p for p in path.split("/") if p]

        if len(parts) == 3 and parts[:2] == ["api", "persons"]:
            person_id = unquote(parts[2])
            self._send_json(200, self.service.delete_person(person_id))
            return

        if len(parts) == 4 and parts[:2] == ["api", "persons"] and parts[3] == "avatar":
            person_id = unquote(parts[2])
            self._send_json(200, {"person": self.service.remove_person_avatar(person_id)})
            return

        if len(parts) == 3 and parts[:2] == ["api", "unions"]:
            union_id = unquote(parts[2])
            self._send_json(200, self.service.delete_union(union_id))
            return

        if len(parts) == 4 and parts[:2] == ["api", "relations"]:
            child_id = unquote(parts[2])
            parent_id = unquote(parts[3])
            self._send_json(200, self.service.delete_parent_child(child_id, parent_id))
            return

        self._send_json(404, format_error_payload("not_found", "A kért végpont nem található."))


def run_server(
    host: str = "127.0.0.1",
    port: int = 8001,
    data_dir: str = "./data/workspace",
    static_dir: str | Path | None = None,
) -> None:
    service = FamilyTreeService(Path(data_dir))
    server = FamilyTreeHTTPServer((host, port), service, static_dir=static_dir)
    print(f"FamilyTree Python API listening on http://{host}:{port} (workspace={Path(data_dir).resolve()})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Családfa Python API szerver")
    parser.add_argument("--host", default=os.environ.get("FTREE_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("FTREE_PORT", "8001")))
    parser.add_argument(
        "--data-dir",
        default=os.environ.get("FTREE_DATA_DIR", "./data/workspace"),
        help="Aktív SQLite + media munkakönyvtár útvonala",
    )
    parser.add_argument(
        "--static-dir",
        default=os.environ.get("FTREE_STATIC_DIR") or None,
        help="Opcionális React build (dist/) könyvtár önálló futtatáshoz",
    )
    args = parser.parse_args()
    run_server(host=args.host, port=args.port, data_dir=args.data_dir, static_dir=args.static_dir)


if __name__ == "__main__":
    main()
