"""Cross-platform desktop entry point for the packaged Családfa application.

Starts the local Python HTTP API + bundled React production UI without needing Node.js,
stores family tree data in a persistent user directory, and opens the default browser.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import sys
import tempfile
import threading
import urllib.request
import webbrowser
from pathlib import Path

# Ensure repo root is on sys.path when invoked directly from source
_THIS_FILE = Path(__file__).resolve()
_REPO_ROOT = _THIS_FILE.parent.parent
if not getattr(sys, "frozen", False) and str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from backend.server import FamilyTreeHTTPServer  # noqa: E402
from backend.service import FamilyTreeService  # noqa: E402


def resolve_bundle_root() -> Path:
    """Return the directory containing bundled resources (`dist/`, `backend/`)."""
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        return Path(meipass)
    return _REPO_ROOT


def resolve_default_data_dir() -> Path:
    """Choose a persistent, user-writable folder for SQLite DB and portrait media."""
    env_dir = os.environ.get("FTREE_DATA_DIR")
    if env_dir:
        return Path(env_dir).expanduser().resolve()

    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
        if base:
            return (Path(base) / "Csaladfa" / "workspace").resolve()
        return (Path.home() / "Csaladfa" / "workspace").resolve()

    xdg_data = os.environ.get("XDG_DATA_HOME")
    base_dir = Path(xdg_data).expanduser() if xdg_data else (Path.home() / ".local" / "share")
    return (base_dir / "csaladfa" / "workspace").resolve()


def pick_available_port(host: str, preferred_port: int) -> int:
    """Return preferred_port if free, otherwise probe nearby ports or fall back to OS ephemeral."""
    candidates = [preferred_port, *range(8002, 8021), 0]
    for port in candidates:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind((host, port))
                return int(sock.getsockname()[1])
            except OSError:
                continue
    return 0


def run_smoke_test(static_dir: Path) -> int:
    """Start an ephemeral server, verify `/` and `/api/health`, then exit cleanly."""
    with tempfile.TemporaryDirectory(prefix="ftree_smoke_") as tmp_dir:
        service = FamilyTreeService(Path(tmp_dir) / "workspace")
        server = FamilyTreeHTTPServer(("127.0.0.1", 0), service, static_dir=static_dir)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=5) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"Unexpected /api/health status: {resp.status}")
                health = json.loads(resp.read().decode("utf-8"))
                if health.get("status") != "ok":
                    raise RuntimeError(f"Unexpected /api/health payload: {health}")

            with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=5) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"Unexpected / status: {resp.status}")
                html = resp.read().decode("utf-8", errors="replace")
                if "<html" not in html.lower():
                    raise RuntimeError("Root response does not look like HTML.")

            print(f"Smoke test OK (port={port}, pillow={health.get('pillow_available')})", flush=True)
            return 0
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


def main() -> int:
    parser = argparse.ArgumentParser(description="Családfa asztali indító")
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Figyelő interfész (távoli eléréshez kifejezetten meg kell adni)",
    )
    parser.add_argument("--port", type=int, default=int(os.environ.get("FTREE_PORT", "8001")))
    parser.add_argument("--data-dir", default=None, help="Egyéni adatkönyvtár útvonala")
    parser.add_argument("--no-browser", action="store_true", help="Ne nyissa meg automatikusan a böngészőt")
    parser.add_argument("--smoke-test", action="store_true", help="Önellenőrző füstteszt futtatása")
    args = parser.parse_args()

    bundle_root = resolve_bundle_root()
    static_dir = bundle_root / "dist"
    if not (static_dir / "index.html").is_file():
        print(
            f"Hiba: a beépített webes felület nem található itt: {static_dir}\n"
            "Fejlesztői módban előbb futtasd az 'npm run build' parancsot.",
            file=sys.stderr,
        )
        return 1

    if args.smoke_test:
        return run_smoke_test(static_dir)

    data_dir = Path(args.data_dir).expanduser().resolve() if args.data_dir else resolve_default_data_dir()
    actual_port = pick_available_port(args.host, args.port)
    service = FamilyTreeService(data_dir)
    server = FamilyTreeHTTPServer((args.host, actual_port), service, static_dir=static_dir)
    actual_port = server.server_address[1]
    url = f"http://{args.host}:{actual_port}/"

    print("============================================================", flush=True)
    print("  Családfa — Hordozható családfakészítő és -szerkesztő", flush=True)
    print("============================================================", flush=True)
    print(f"  Megnyitás böngészőben : {url}", flush=True)
    print(f"  Adatok mentési helye  : {data_dir}", flush=True)
    print("  Leállítás             : Zárd be ezt az ablakot vagy nyomj Ctrl+C-t.", flush=True)
    print("============================================================", flush=True)

    stop_event = threading.Event()

    def _request_shutdown(_signum: int, _frame: object) -> None:
        stop_event.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, _request_shutdown)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _request_shutdown)

    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

    print("\nA Családfa alkalmazás biztonságosan leállt.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
