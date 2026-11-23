"""Portrait image optimization (Pillow) and safe media storage."""

from __future__ import annotations

import io
import logging
import os
import tempfile
import uuid
from pathlib import Path

from .models import ValidationError

logger = logging.getLogger(__name__)

try:
    from PIL import Image, ImageOps, UnidentifiedImageError

    PILLOW_AVAILABLE = True
except ImportError:  # pragma: no cover - fallback for minimal Python environments
    Image = None  # type: ignore[assignment]
    ImageOps = None  # type: ignore[assignment]
    UnidentifiedImageError = Exception  # type: ignore[assignment,misc]
    PILLOW_AVAILABLE = False

MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB input cap
MAX_PORTRAIT_DIMENSION = 512
JPEG_QUALITY = 84
WEBP_QUALITY = 82

CONTENT_TYPES = {
    ".webp": "image/webp",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
}


def detect_image_extension(raw_bytes: bytes) -> str | None:
    """Validate image magic bytes without relying on user-supplied filenames."""
    if len(raw_bytes) < 16:
        return None
    if raw_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        if b"IHDR" not in raw_bytes[8:20]:
            return None
        return ".png"
    if raw_bytes.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if raw_bytes[:4] == b"RIFF" and raw_bytes[8:12] == b"WEBP":
        return ".webp"
    return None


def resolve_media_path(workspace_dir: Path, relative_path: str) -> Path:
    """Resolve a relative media path strictly inside <workspace_dir>/media."""
    if not relative_path or "\\" in relative_path:
        raise ValidationError("Érvénytelen média elérési út.")
    clean_rel = relative_path.lstrip("/")
    if not clean_rel.startswith("media/"):
        raise ValidationError("A média fájl csak a media/ mappán belül lehet.")

    media_root = (workspace_dir / "media").resolve()
    media_root.mkdir(parents=True, exist_ok=True)
    target = (workspace_dir / clean_rel).resolve()

    if not target.is_relative_to(media_root):
        raise ValidationError("Tiltott fájlútvonal.")
    return target


def _atomic_write_bytes(target: Path, data: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(target.parent), prefix=".tmp_img_", suffix=target.suffix)
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


def save_portrait_image(workspace_dir: Path, raw_bytes: bytes) -> dict[str, object]:
    """Validate, optimize/resize (with Pillow when available), and store a portrait atomically."""
    if not raw_bytes:
        raise ValidationError("Üres képfájl. Válassz ki egy érvényes portréképet.")
    if len(raw_bytes) > MAX_UPLOAD_BYTES:
        raise ValidationError("A feltöltött képfájl túl nagy (legfeljebb 10 MB lehet).")

    avatars_dir = (workspace_dir / "media" / "avatars").resolve()
    avatars_dir.mkdir(parents=True, exist_ok=True)

    file_id = uuid.uuid4().hex

    if PILLOW_AVAILABLE and Image is not None and ImageOps is not None:
        try:
            with Image.open(io.BytesIO(raw_bytes)) as img:
                img.load()
                img = ImageOps.exif_transpose(img)
                if img.mode in ("RGBA", "LA", "P"):
                    background = Image.new("RGBA", img.size, (255, 255, 255, 255))
                    rgba = img.convert("RGBA")
                    background.paste(rgba, mask=rgba.split()[3])
                    img = background.convert("RGB")
                elif img.mode != "RGB":
                    img = img.convert("RGB")

                img.thumbnail(
                    (MAX_PORTRAIT_DIMENSION, MAX_PORTRAIT_DIMENSION),
                    Image.Resampling.LANCZOS,
                )

                out = io.BytesIO()
                try:
                    img.save(out, format="WEBP", quality=WEBP_QUALITY, method=6)
                    ext = ".webp"
                except Exception:
                    out = io.BytesIO()
                    img.save(out, format="JPEG", quality=JPEG_QUALITY, optimize=True)
                    ext = ".jpg"

                processed_bytes = out.getvalue()
                rel_path = f"media/avatars/{file_id}{ext}"
                target = resolve_media_path(workspace_dir, rel_path)
                _atomic_write_bytes(target, processed_bytes)
                return {
                    "avatar_path": rel_path,
                    "optimized": True,
                    "byte_size": len(processed_bytes),
                    "width": img.width,
                    "height": img.height,
                }
        except (UnidentifiedImageError, OSError, ValueError, SyntaxError, EOFError) as exc:
            logger.warning("Portrait processing failed: %s", exc)
            raise ValidationError(
                "A feltöltött képfájl sérült, hibás vagy nem támogatott formátumú.",
                code="INVALID_IMAGE",
                hint="Csak érvényes PNG, JPG vagy WEBP képfájl tölthető fel.",
            ) from exc

    # Minimal-runtime fallback: verify magic bytes and store atomically
    ext = detect_image_extension(raw_bytes)
    if ext is None:
        raise ValidationError(
            "A feltöltött fájl nem érvényes vagy támogatott kép.",
            code="INVALID_IMAGE",
            hint="Csak érvényes PNG, JPG vagy WEBP képfájl tölthető fel.",
        )
    rel_path = f"media/avatars/{file_id}{ext}"
    target = resolve_media_path(workspace_dir, rel_path)
    try:
        _atomic_write_bytes(target, raw_bytes)
    except OSError as exc:
        logger.exception("Failed to write portrait image safely")
        raise ValidationError(
            "Nem sikerült elmenteni a portréképet a tárhelyre.",
            code="MEDIA_WRITE_ERROR",
            hint="Ellenőrizd a szabad tárhelyet és próbáld meg újra.",
        ) from exc
    return {
        "avatar_path": rel_path,
        "optimized": False,
        "byte_size": len(raw_bytes),
    }


def delete_media_file(workspace_dir: Path, relative_path: str) -> None:
    """Safely delete an existing avatar file if it exists inside media/."""
    if not relative_path:
        return
    try:
        target = resolve_media_path(workspace_dir, relative_path)
        if target.is_file():
            target.unlink(missing_ok=True)
    except (ValidationError, OSError) as exc:
        logger.warning("Could not remove media file %s: %s", relative_path, exc)


def cleanup_unused_avatars(workspace_dir: Path, referenced_paths: set[str]) -> int:
    """Remove any unreferenced files in media/avatars/ and return count removed."""
    avatars_dir = (workspace_dir / "media" / "avatars").resolve()
    if not avatars_dir.is_dir():
        return 0
    normalized_refs = {p.lstrip("/") for p in referenced_paths if p}
    removed = 0
    for item in avatars_dir.iterdir():
        if not item.is_file():
            continue
        rel = f"media/avatars/{item.name}"
        if rel not in normalized_refs:
            item.unlink(missing_ok=True)
            removed += 1
    return removed
