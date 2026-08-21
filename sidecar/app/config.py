"""Sidecar configuration: paths and auth come from the main process via env."""
import os
from pathlib import Path


class Config:
    def __init__(self) -> None:
        # DB path: shared SQLite file owned jointly with the Electron main process.
        self.db_path = Path(
            os.environ.get("PI_DESKTOP_DB", "")
            or Path.home() / "Library/Application Support/PiDesktop/pidesktop.db"
        )
        # Sessions root: pi's canonical JSONL storage.
        sessions_root = os.environ.get("PI_DESKTOP_SESSIONS", "")
        if sessions_root:
            self.sessions_root = Path(sessions_root)
        else:
            agent_dir = os.environ.get("PI_DESKTOP_AGENT_DIR", "") or str(
                Path.home() / ".pi" / "agent"
            )
            self.sessions_root = Path(agent_dir) / "sessions"
        # Per-boot token required on every request (loopback-only bind anyway).
        self.token = os.environ.get("PI_DESKTOP_TOKEN", "")


config = Config()
