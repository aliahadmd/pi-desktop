"""PyInstaller entry point: runs the sidecar app with uvicorn programmatically.

Usage: pi-desktop-sidecar --port N --host 127.0.0.1 [--log-level warning]
Env: PI_DESKTOP_DB, PI_DESKTOP_SESSIONS, PI_DESKTOP_TOKEN (see app.config).
"""
import argparse
import logging
import os
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(prog="pi-desktop-sidecar")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--log-level", default="warning")
    args = parser.parse_args()

    if args.port <= 0:
        print("--port is required", file=sys.stderr)
        return 2

    # Validate required env early with a clear message.
    if not os.environ.get("PI_DESKTOP_TOKEN"):
        print("PI_DESKTOP_TOKEN env is required", file=sys.stderr)
        return 2

    level = getattr(logging, args.log_level.upper(), logging.WARNING)
    logging.basicConfig(level=level, format="%(name)s %(levelname)s %(message)s")

    import uvicorn

    from app.main import app

    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level=args.log_level,
        # PyInstaller onefile: disable reload/workers semantics entirely.
        workers=1,
        lifespan="on",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
