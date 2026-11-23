"""Portrait image optimization (Pillow) and safe media storage."""

from __future__ import annotations

import io
import uuid
from pathlib import Path

from .models import ValidationError

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
    if len(raw_bytes) < 12:
        return None
    if raw_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
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


def save_portrait_image(workspace_dir: Path, raw_bytes: bytes) -> dict[str, object]:
    """Validate, optimize/resize (with Pillow when available), and store a portrait.

    Returns a dictionary containing:
    - avatar_path: POSIX relative path (e.g. 'media/avatars/<uuid>.webp')
    - optimized: bool (True if Pillow resized/re-encoded it)
    - byte_size: int
    """
    if not raw_bytes:
        raise ValidationError("Üres képfájl.")
    if len(raw_bytes) > MAX_UPLOAD_BYTES:
        raise ValidationError("A feltöltött kép túl nagy (maximum 10 MB).")

    avatars_dir = (workspace_dir / "media" / "avatars").resolve()
    avatars_dir.mkdir(parents=True, exist_ok=True)

    file_id = uuid.uuid4().hex

    if PILLOW_AVAILABLE and Image is not None and ImageOps is not None:
        try:
            with Image.open(io.BytesIO(raw_bytes)) as img:
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
                target.write_bytes(processed_bytes)
                return {
                    "avatar_path": rel_path,
                    "optimized": True,
                    "byte_size": len(processed_bytes),
                    "width": img.width,
                    "height": img.height,
                }
        except UnidentifiedImageError as exc:
            raise ValidationError("A feltöltött fájl nem érvényes kép (PNG, JPG vagy WEBP).") from exc

    # Minimal-runtime fallback: verify magic bytes and store safely
    ext = detect_image_extension(raw_bytes)
    if ext is None:
        raise ValidationError(
            "Csak érvényes PNG, JPEG vagy WEBP képfájl tölthető fel."
        )
    rel_path = f"media/avatars/{file_id}{ext}"
    target = resolve_media_path(workspace_dir, rel_path)
    target.write_bytes(raw_bytes)
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
    except ValidationError:
        return
    if target.is_file():
        target.unlink()
