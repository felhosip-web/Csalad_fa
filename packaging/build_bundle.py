"""Cross-platform PyInstaller bundler for Linux (.tar.gz) and Windows (.zip) targets."""

from __future__ import annotations

import argparse
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

README_TXT_HU = """Családfa — Gyors indítási útmutató
========================================

1. Indítás:
   - Windowson: kattints duplán a "Csaladfa.exe" fájlra.
   - Linuxon: nyiss meg egy terminált ebben a mappában és futtasd: ./csaladfa
     (Ha szükséges, előtte add meg a futtatási jogot: chmod +x csaladfa)

2. Használat:
   - A program automatikusan megnyitja a családfát a böngésződben.
   - Ha a böngésző nem nyílik meg magától, másold be a fekete ablakban megjelenő
     http://127.0.0.1:... címet a böngésző címsorába.
   - A program leállításához egyszerűen zárd be az indító ablakot.

3. Biztonsági mentés:
   - A családfa adatai helyben tárolódnak a számítógépeden.
   - A "Mentés és megnyitás" fülön bármikor készíthetsz egyetlen hordozható .ftree fájlt,
     amely tartalmazza az összes adatot és portréképet SHA-256 ellenőrzéssel.
"""


def sanitize_version(raw: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "-", (raw or "dev").strip())
    return cleaned.strip("-") or "dev"


def main() -> int:
    parser = argparse.ArgumentParser(description="Build standalone Linux/Windows PyInstaller package")
    parser.add_argument("--version", default="dev", help="Kiadas vagy tag neve (pl. v1.0.0)")
    parser.add_argument("--skip-smoke-test", action="store_true", help="Füstteszt kihagyása")
    args = parser.parse_args()

    dist_dir = REPO_ROOT / "dist"
    schema_sql = REPO_ROOT / "backend" / "schema.sql"
    launcher = REPO_ROOT / "packaging" / "run_desktop.py"
    guide_md = REPO_ROOT / "docs" / "terjesztes-linux-windows.md"

    if not (dist_dir / "index.html").is_file():
        print("Hiba: hiányzik a 'dist/index.html'. Előbb futtasd az 'npm run build' parancsot.", file=sys.stderr)
        return 1
    if not schema_sql.is_file() or not launcher.is_file():
        print("Hiba: hiányoznak a backend vagy indító forrásfájlok.", file=sys.stderr)
        return 1

    is_windows = platform.system().lower().startswith("win")
    app_name = "Csaladfa" if is_windows else "csaladfa"
    target_slug = "windows-x64" if is_windows else "linux-x64"
    version_tag = sanitize_version(args.version)

    work_dir = REPO_ROOT / "build_pyinstaller"
    bundle_out_root = REPO_ROOT / "dist_bundle"
    release_dir = REPO_ROOT / "release-artifacts"

    for path in (work_dir, bundle_out_root):
        if path.exists():
            shutil.rmtree(path)
    release_dir.mkdir(parents=True, exist_ok=True)

    pyinstaller_cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onedir",
        "--name",
        app_name,
        "--distpath",
        str(bundle_out_root),
        "--workpath",
        str(work_dir),
        "--specpath",
        str(work_dir),
        "--paths",
        str(REPO_ROOT),
        "--add-data",
        f"{dist_dir}{os.pathsep}dist",
        "--add-data",
        f"{schema_sql}{os.pathsep}backend",
        "--collect-submodules",
        "backend",
        "--hidden-import",
        "PIL.Image",
        "--hidden-import",
        "PIL.ImageOps",
        "--hidden-import",
        "PIL.WebPImagePlugin",
        str(launcher),
    ]

    print(f"PyInstaller csomagolás indítása ({target_slug})...", flush=True)
    subprocess.run(pyinstaller_cmd, cwd=REPO_ROOT, check=True)

    packaged_dir = bundle_out_root / app_name
    exe_name = f"{app_name}.exe" if is_windows else app_name
    packaged_exe = packaged_dir / exe_name
    if not packaged_exe.is_file():
        print(f"Hiba: a várt futtatható fájl nem jött létre: {packaged_exe}", file=sys.stderr)
        return 1

    if not is_windows:
        os.chmod(packaged_exe, 0o755)

    if guide_md.is_file():
        shutil.copy2(guide_md, packaged_dir / "Hasznalati_utmutato.md")
    (packaged_dir / "OLVASS_EL.txt").write_text(README_TXT_HU, encoding="utf-8")

    if not args.skip_smoke_test:
        print(f"Csomagolt bináris füsttesztelése: {packaged_exe} --smoke-test", flush=True)
        subprocess.run([str(packaged_exe), "--smoke-test"], check=True)

    archive_stem = f"csaladfa-{version_tag}-{target_slug}"
    if is_windows:
        archive_path = release_dir / f"{archive_stem}.zip"
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            for file_path in sorted(packaged_dir.rglob("*")):
                if file_path.is_file():
                    arcname = Path(app_name) / file_path.relative_to(packaged_dir)
                    zf.write(file_path, arcname=str(arcname))
    else:
        archive_path = release_dir / f"{archive_stem}.tar.gz"
        with tarfile.open(archive_path, "w:gz") as tf:
            tf.add(packaged_dir, arcname=app_name)

    print(f"Csomag sikeresen elkészült: {archive_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
