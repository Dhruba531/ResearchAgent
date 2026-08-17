from __future__ import annotations

"""Shared runner infrastructure with no generated-content behavior."""

import hashlib
from pathlib import Path, PureWindowsPath
from typing import Any, Dict

from database import ARTIFACT_ROOT


class ConnectionManager:
    """Track active WebSocket subscribers per run and broadcast log payloads."""

    def __init__(self) -> None:
        self._connections: Dict[int, set] = {}

    async def connect(self, run_id: int, websocket) -> None:
        await websocket.accept()
        self._connections.setdefault(run_id, set()).add(websocket)

    def disconnect(self, run_id: int, websocket) -> None:
        self._connections.get(run_id, set()).discard(websocket)

    async def broadcast(self, run_id: int, payload: Dict[str, Any]) -> None:
        # A closed tab is discovered on send, not on disconnect, so collect the
        # failures and reap them afterwards — mutating the set mid-iteration would
        # blow up, and one dead subscriber must never stop the others receiving
        # the log line.
        dead = []
        for websocket in list(self._connections.get(run_id, set())):
            try:
                await websocket.send_json(payload)
            except Exception:
                dead.append(websocket)
        for websocket in dead:
            self.disconnect(run_id, websocket)


def checksum(path: Path) -> str:
    """Hash artifact bytes so metadata proves which file was generated."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def safe_artifact_filename(filename: str) -> str:
    """Return one safe filename, rejecting traversal on POSIX and Windows."""
    clean = str(filename or "").strip()
    if not clean or clean in {".", ".."} or "\x00" in clean:
        raise ValueError("Artifact filename is invalid.")
    # Check against both flavours regardless of the host OS: on POSIX, Path()
    # treats "..\\evil" as a single harmless name, so a Windows-style separator
    # would slip through a POSIX-only check and then escape once the value is
    # replayed somewhere that honours backslashes.
    if clean != Path(clean).name or clean != PureWindowsPath(clean).name:
        raise ValueError("Artifact filename must not contain path separators.")
    return clean


def safe_artifact_path(run_id: int, filename: str) -> Path:
    """Resolve a run artifact path and prove it remains inside the run directory."""
    # Resolve both sides before comparing so symlinks inside the artifact root
    # cannot redirect a write outside it.
    directory = (ARTIFACT_ROOT / f"run-{run_id}").resolve()
    directory.mkdir(parents=True, exist_ok=True)
    path = (directory / safe_artifact_filename(filename)).resolve()
    path.relative_to(directory)  # raises ValueError if the path escaped the run dir
    return path


def write_artifact(run_id: int, filename: str, content: str) -> Path:
    """Write a UTF-8 text artifact into the run-specific artifact directory."""
    path = safe_artifact_path(run_id, filename)
    path.write_text(content, encoding="utf-8")
    return path
