#!/usr/bin/env python3
"""Reserve one docs-server port per Superset workspace.

Allocations live in ~/.superset/port-allocations.json, the shared file from
https://docs.superset.sh/ports. Each value is the base of a 20-port slot
aligned to 3000, the same layout superset-sh/superset writes, so workspaces
from this repo and from others do not overlap. This repo serves the docs site
on the base port.

stdout is only the port number on `reserve`. Everything else goes to stderr.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

ALLOC = Path.home() / ".superset" / "port-allocations.json"
LOCK_DIR = Path.home() / ".superset" / "port-allocations.lock"
START = 3000
RANGE = 20
# 200 slots: 3000 .. 6980. Past that, give up instead of scanning forever.
MAX_SLOTS = 200
# Ports the OS or Node refuse, or that macOS grabs (AirPlay on 5000 and 7000).
# A slot whose window contains one of these is skipped. Mirrors superset's list.
RESERVED = {
    3659,
    4045,
    5000,
    5060,
    5061,
    6000,
    6566,
    6665,
    6666,
    6667,
    6668,
    6669,
    6697,
    7000,
}
LOCK_TIMEOUT_SECONDS = 30
STALE_LOCK_SECONDS = 300


def workspace_key() -> str:
    raw = os.environ.get("SUPERSET_WORKSPACE_PATH") or os.getcwd()
    return os.path.realpath(raw)


def window_is_safe(base: int) -> bool:
    return not any(base <= port < base + RANGE for port in RESERVED)


def overlaps(candidate: int, used: set[int]) -> bool:
    return any(abs(candidate - other) < RANGE for other in used)


def port_is_free(port: int) -> bool:
    """True when nothing is accepting connections on this port."""
    families = [socket.AF_INET]
    if socket.has_ipv6:
        families.append(socket.AF_INET6)
    for family in families:
        host = "::1" if family == socket.AF_INET6 else "127.0.0.1"
        try:
            with socket.socket(family, socket.SOCK_STREAM) as sock:
                if family == socket.AF_INET6:
                    sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                sock.bind((host, port))
        except OSError as error:
            # This address family is not available here; it cannot be a conflict.
            if error.errno in {socket.EAFNOSUPPORT, socket.EADDRNOTAVAIL, socket.EINVAL}:
                continue
            return False
    return True


def lock_is_stale() -> bool:
    pid_file = LOCK_DIR / "pid"
    try:
        pid = int(pid_file.read_text().strip())
    except (OSError, ValueError):
        pid = 0
    if pid > 0:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        except PermissionError:
            return False
    try:
        age = time.time() - LOCK_DIR.stat().st_mtime
    except OSError:
        return True
    return age >= STALE_LOCK_SECONDS


def acquire_lock() -> None:
    ALLOC.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.time() + LOCK_TIMEOUT_SECONDS
    while True:
        try:
            LOCK_DIR.mkdir()
        except FileExistsError:
            if lock_is_stale():
                shutil.rmtree(LOCK_DIR, ignore_errors=True)
                continue
            if time.time() >= deadline:
                raise SystemExit(f"timed out waiting for {LOCK_DIR}")
            time.sleep(0.25)
            continue
        (LOCK_DIR / "pid").write_text(f"{os.getpid()}\n")
        return


def release_lock() -> None:
    pid_file = LOCK_DIR / "pid"
    try:
        owner = int(pid_file.read_text().strip())
    except (OSError, ValueError):
        owner = 0
    if owner not in {0, os.getpid()}:
        return
    shutil.rmtree(LOCK_DIR, ignore_errors=True)


def load_allocations() -> dict[str, int]:
    if not ALLOC.exists():
        return {}
    try:
        raw = json.loads(ALLOC.read_text())
    except json.JSONDecodeError as error:
        raise SystemExit(f"{ALLOC} is not valid JSON ({error}). Refusing to overwrite it.") from error
    if not isinstance(raw, dict):
        raise SystemExit(f"{ALLOC} must be a JSON object. Refusing to overwrite it.")
    allocations: dict[str, int] = {}
    for key, value in raw.items():
        if isinstance(key, str) and isinstance(value, int) and not isinstance(value, bool):
            allocations[key] = value
        else:
            print(f"ignoring invalid port allocation {key!r}: {value!r}", file=sys.stderr)
    return allocations


def save_allocations(allocations: dict[str, int]) -> None:
    payload = dict(sorted(allocations.items()))
    temporary = ALLOC.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(payload, indent=2) + "\n")
    os.replace(temporary, ALLOC)


def descendant_pids(pid: int) -> set[int]:
    pids = {pid}
    pending = [pid]
    while pending:
        current = pending.pop()
        result = subprocess.run(
            ["pgrep", "-P", str(current)],
            check=False,
            capture_output=True,
            text=True,
        )
        for line in result.stdout.split():
            if not line.isdigit():
                continue
            child = int(line)
            if child in pids:
                continue
            pids.add(child)
            pending.append(child)
    return pids


def workspace_holds_port(key: str, port: int) -> bool:
    """True when this workspace's recorded dev server is alive and listening."""
    pid_file = Path(key) / ".superset" / "dev-server.pid"
    try:
        pid = int(pid_file.read_text().strip())
    except (OSError, ValueError):
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    result = subprocess.run(
        ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
        check=False,
        capture_output=True,
        text=True,
    )
    listeners = {int(line) for line in result.stdout.split() if line.isdigit()}
    if not listeners:
        return False
    return bool(listeners & descendant_pids(pid))


def choose_port(allocations: dict[str, int], key: str) -> int:
    others = {port for owner, port in allocations.items() if owner != key}
    current = allocations.get(key)
    if (
        isinstance(current, int)
        and window_is_safe(current)
        and not overlaps(current, others)
        and (port_is_free(current) or workspace_holds_port(key, current))
    ):
        return current

    used = {port for owner, port in allocations.items() if owner != key}
    for slot in range(MAX_SLOTS):
        candidate = START + slot * RANGE
        if overlaps(candidate, used) or not window_is_safe(candidate):
            continue
        if not port_is_free(candidate):
            continue
        return candidate
    raise SystemExit(f"no free docs port in {START}..{START + (MAX_SLOTS - 1) * RANGE}")


def reserve() -> None:
    key = workspace_key()
    acquire_lock()
    try:
        allocations = load_allocations()
        port = choose_port(allocations, key)
        allocations[key] = port
        save_allocations(allocations)
    finally:
        release_lock()
    print(port)


def release() -> None:
    key = workspace_key()
    removed: int | None = None
    acquire_lock()
    try:
        allocations = load_allocations()
        removed = allocations.pop(key, None)
        if removed is not None:
            save_allocations(allocations)
    finally:
        release_lock()
    if removed is not None:
        print(f"released docs port {removed}", file=sys.stderr)


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "reserve":
        reserve()
        return
    if command == "release":
        release()
        return
    raise SystemExit("usage: port.py reserve|release")


if __name__ == "__main__":
    main()
