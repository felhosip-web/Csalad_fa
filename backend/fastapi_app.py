"""Optional FastAPI entrypoint sharing the exact same FamilyTreeService & contract.

Run with:
    uvicorn backend.fastapi_app:app --reload --port 8001
"""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, File, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from .db import CURRENT_SCHEMA_VERSION
from .media import CONTENT_TYPES, PILLOW_AVAILABLE, resolve_media_path
from .models import BackendError, PackageError, format_error_payload
from .service import FamilyTreeService
from .version import BACKEND_VERSION

logger = logging.getLogger(__name__)

DATA_DIR = Path(os.environ.get("FTREE_DATA_DIR", "./data/workspace"))
service = FamilyTreeService(DATA_DIR)

app = FastAPI(
    title="Családfa Backend API",
    version=BACKEND_VERSION,
    description="Hordozható SQLite + .ftree családfa adatkezelő API",
)


@app.exception_handler(BackendError)
async def backend_error_handler(request: Request, exc: BackendError) -> JSONResponse:
    logger.warning("API error on %s %s [%s]: %s", request.method, request.url.path, exc.code, exc.message)
    return JSONResponse(status_code=exc.status_code, content=exc.to_dict())


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    logger.warning("Request validation error on %s %s: %s", request.method, request.url.path, exc)
    return JSONResponse(
        status_code=422,
        content=format_error_payload(
            "validation_error",
            "A kérés adatai hiányosak vagy érvénytelen formátumúak.",
        ),
    )


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    logger.warning("HTTP %s on %s %s", exc.status_code, request.method, request.url.path)
    if exc.status_code == 404:
        return JSONResponse(
            status_code=404,
            content=format_error_payload("not_found", "A kért végpont vagy fájl nem található."),
        )
    return JSONResponse(
        status_code=exc.status_code,
        content=format_error_payload("http_error", "A kérés feldolgozása sikertelen."),
    )


@app.exception_handler(Exception)
async def unhandled_error_handler(request: Request, _exc: Exception) -> JSONResponse:
    logger.exception("Unhandled FastAPI exception on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content=format_error_payload(
            "internal_error",
            "Váratlan belső szerverhiba történt.",
            "Próbáld meg újra egy pillanat múlva.",
        ),
    )


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "engine": "fastapi-sqlite",
        "version": BACKEND_VERSION,
        "backend_version": BACKEND_VERSION,
        "pillow_available": PILLOW_AVAILABLE,
    }


@app.get("/api/version")
def version() -> dict[str, Any]:
    return {
        "backend_version": BACKEND_VERSION,
        "engine": "fastapi-sqlite",
        "schema_version": CURRENT_SCHEMA_VERSION,
    }


@app.get("/api/tree")
def get_tree(search: str = Query(default="")) -> dict[str, Any]:
    return service.get_tree_snapshot(search=search)


@app.patch("/api/tree/meta")
def rename_tree(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    return {"meta": service.rename_tree(str(payload.get("tree_name") or ""))}


@app.get("/api/persons")
def list_persons(search: str = Query(default="")) -> dict[str, Any]:
    return {"persons": service.list_persons(search=search)}


@app.post("/api/persons", status_code=201)
def create_person(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    return {"person": service.create_person(payload)}


@app.get("/api/persons/{person_id}")
def get_person(person_id: str) -> dict[str, Any]:
    return service.get_person_bundle(person_id)


@app.patch("/api/persons/{person_id}")
def update_person(person_id: str, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    return {"person": service.update_person(person_id, payload)}


@app.delete("/api/persons/{person_id}")
def delete_person(person_id: str) -> dict[str, Any]:
    return service.delete_person(person_id)


@app.post("/api/persons/{person_id}/quick-parent", status_code=201)
def quick_parent(person_id: str, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    return service.quick_add_parent(person_id, payload)


@app.post("/api/persons/{person_id}/quick-child", status_code=201)
def quick_child(person_id: str, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    return service.quick_add_child(person_id, payload)


@app.post("/api/persons/{person_id}/quick-partner", status_code=201)
def quick_partner(person_id: str, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    return service.quick_add_partner(person_id, payload)


@app.post("/api/persons/{person_id}/avatar")
async def upload_avatar(person_id: str, file: UploadFile = File(...)) -> dict[str, Any]:
    raw_bytes = await file.read()
    return service.upload_person_avatar(person_id, raw_bytes)


@app.delete("/api/persons/{person_id}/avatar")
def delete_avatar(person_id: str) -> dict[str, Any]:
    return {"person": service.remove_person_avatar(person_id)}


@app.post("/api/unions", status_code=201)
def create_union(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    return {"union": service.create_union(payload)}


@app.patch("/api/unions/{union_id}")
def update_union(union_id: str, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    return {"union": service.update_union(union_id, payload)}


@app.delete("/api/unions/{union_id}")
def delete_union(union_id: str) -> dict[str, Any]:
    return service.delete_union(union_id)


@app.post("/api/relations", status_code=201)
def create_relation(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    return {"relation": service.add_parent_child(payload)}


@app.delete("/api/relations/{child_id}/{parent_id}")
def delete_relation(child_id: str, parent_id: str) -> dict[str, Any]:
    return service.delete_parent_child(child_id, parent_id)


@app.get("/api/package/export")
def export_package() -> Response:
    with tempfile.TemporaryDirectory(prefix="ftree_dl_") as tmp_dir:
        out_file = Path(tmp_dir) / "csaladfa.ftree"
        service.export_package(out_file)
        data = out_file.read_bytes()
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": 'attachment; filename="csaladfa.ftree"'},
    )


@app.post("/api/package/import")
async def import_package(file: UploadFile = File(...)) -> dict[str, Any]:
    raw_bytes = await file.read()
    if not raw_bytes:
        raise PackageError(
            "A kiválasztott .ftree csomagfájl üres.",
            code="EMPTY_ARCHIVE",
            hint="Válassz ki egy érvényes, nem üres .ftree fájlt.",
        )
    with tempfile.TemporaryDirectory(prefix="ftree_up_") as tmp_dir:
        tmp_file = Path(tmp_dir) / "upload.ftree"
        tmp_file.write_bytes(raw_bytes)
        return service.import_package(tmp_file)


@app.post("/api/package/new")
def new_tree(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    return service.create_new_tree(tree_name=str(payload.get("tree_name") or "Új családfa"))


@app.post("/api/package/seed-sample")
def seed_sample() -> dict[str, Any]:
    return service.seed_sample_family()


@app.post("/api/undo")
def undo_action() -> dict[str, Any]:
    return service.undo_last_action()


@app.get("/media/{rel_path:path}")
def serve_media(rel_path: str) -> FileResponse:
    target = resolve_media_path(service.workspace_dir, f"media/{rel_path}")
    ctype = CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream")
    return FileResponse(path=target, media_type=ctype)
