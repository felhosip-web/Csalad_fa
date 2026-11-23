"""Automatic semantic version bumper for separate Python backend and React frontend versions.

Updates:
- backend/version.py (BACKEND_VERSION)
- package.json ("version")

Supports manual target selection (`backend`, `frontend`, `both`) or `auto`
detection based on git diff paths (`backend/` vs. `src/`, `index.html`, `vite.config.ts`).
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_VERSION_FILE = REPO_ROOT / "backend" / "version.py"
PACKAGE_JSON_FILE = REPO_ROOT / "package.json"

SEMVER_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
BACKEND_ASSIGN_RE = re.compile(r'^(BACKEND_VERSION\s*=\s*)"([^"]+)"', re.MULTILINE)

FRONTEND_PREFIXES = ("src/", "public/")
FRONTEND_EXACT_FILES = {"index.html", "vite.config.ts", "tsconfig.json"}


def bump_semver(current: str, part: str) -> str:
    match = SEMVER_RE.match(current.strip())
    if not match:
        raise ValueError(f"Érvénytelen szemantikus verziószám: {current!r} (elvárt: X.Y.Z)")
    major, minor, patch = int(match.group(1)), int(match.group(2)), int(match.group(3))
    if part == "major":
        return f"{major + 1}.0.0"
    if part == "minor":
        return f"{major}.{minor + 1}.0"
    if part == "patch":
        return f"{major}.{minor}.{patch + 1}"
    raise ValueError(f"Ismeretlen léptetési szint: {part!r}")


def read_backend_version(path: Path = BACKEND_VERSION_FILE) -> str:
    text = path.read_text(encoding="utf-8")
    match = BACKEND_ASSIGN_RE.search(text)
    if not match:
        raise ValueError(f"Nem található BACKEND_VERSION mező a fájlban: {path}")
    return match.group(2)


def write_backend_version(new_version: str, path: Path = BACKEND_VERSION_FILE) -> None:
    text = path.read_text(encoding="utf-8")
    updated, count = BACKEND_ASSIGN_RE.subn(rf'\1"{new_version}"', text, count=1)
    if count != 1:
        raise ValueError(f"Nem sikerült frissíteni a BACKEND_VERSION értéket: {path}")
    path.write_text(updated, encoding="utf-8")


def read_frontend_version(path: Path = PACKAGE_JSON_FILE) -> str:
    data = json.loads(path.read_text(encoding="utf-8"))
    version = str(data.get("version") or "").strip()
    if not SEMVER_RE.match(version):
        raise ValueError(f"Érvénytelen frontend verzió a package.json fájlban: {version!r}")
    return version


def write_frontend_version(new_version: str, path: Path = PACKAGE_JSON_FILE) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    data["version"] = new_version
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def detect_targets_from_paths(changed_paths: list[str]) -> tuple[bool, bool]:
    """Return (bump_backend, bump_frontend) based on modified repository paths."""
    bump_backend = False
    bump_frontend = False
    for raw in changed_paths:
        norm = raw.strip().replace("\\", "/").lstrip("./")
        if not norm:
            continue
        if norm.startswith("backend/") and norm != "backend/version.py":
            bump_backend = True
        if norm.startswith(FRONTEND_PREFIXES) or norm in FRONTEND_EXACT_FILES:
            bump_frontend = True
    return bump_backend, bump_frontend


def git_changed_paths(base_ref: str, head_ref: str, cwd: Path = REPO_ROOT) -> list[str]:
    proc = subprocess.run(
        ["git", "diff", "--name-only", base_ref, head_ref],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"A git diff futtatása sikertelen ({base_ref}..{head_ref}): {proc.stderr.strip()}"
        )
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()]


def main() -> int:
    parser = argparse.ArgumentParser(description="Backend és frontend verziószám-léptető")
    parser.add_argument(
        "--target",
        choices=("auto", "backend", "frontend", "both"),
        default="auto",
        help="Melyik komponens verziója lépjen (auto = git diff alapján)",
    )
    parser.add_argument(
        "--bump",
        choices=("patch", "minor", "major"),
        default="patch",
        help="Szemantikus léptetés típusa",
    )
    parser.add_argument("--base-ref", default="HEAD~1", help="Git alap referencia auto módhoz")
    parser.add_argument("--head-ref", default="HEAD", help="Git cél referencia auto módhoz")
    parser.add_argument("--dry-run", action="store_true", help="Fájlok módosítása nélkül")
    parser.add_argument("--github-output", default="", help="GITHUB_OUTPUT fájl útvonala")
    args = parser.parse_args()

    cur_backend = read_backend_version()
    cur_frontend = read_frontend_version()

    if args.target == "both":
        bump_backend, bump_frontend = True, True
    elif args.target == "backend":
        bump_backend, bump_frontend = True, False
    elif args.target == "frontend":
        bump_backend, bump_frontend = False, True
    else:
        changed = git_changed_paths(args.base_ref, args.head_ref)
        bump_backend, bump_frontend = detect_targets_from_paths(changed)

    new_backend = bump_semver(cur_backend, args.bump) if bump_backend else cur_backend
    new_frontend = bump_semver(cur_frontend, args.bump) if bump_frontend else cur_frontend

    if not args.dry_run:
        if bump_backend:
            write_backend_version(new_backend)
        if bump_frontend:
            write_frontend_version(new_frontend)

    print(
        f"Backend: {cur_backend} -> {new_backend} (változott={bump_backend}) | "
        f"Frontend: {cur_frontend} -> {new_frontend} (változott={bump_frontend})",
        flush=True,
    )

    if args.github_output:
        out_path = Path(args.github_output)
        with out_path.open("a", encoding="utf-8") as fh:
            fh.write(f"backend_changed={'true' if bump_backend else 'false'}\n")
            fh.write(f"frontend_changed={'true' if bump_frontend else 'false'}\n")
            fh.write(f"backend_version={new_backend}\n")
            fh.write(f"frontend_version={new_frontend}\n")
            fh.write(f"release_tag=v{new_frontend}-be{new_backend}\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
