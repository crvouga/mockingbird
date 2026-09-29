"""Explicitly fetch hash-locked source files; never install or execute upstream."""
import argparse
import hashlib
from pathlib import Path
from urllib.request import urlopen
from sources import LOCK, verify

parser = argparse.ArgumentParser()
parser.add_argument("--fetch", action="store_true")
args = parser.parse_args()
if not args.fetch:
    parser.error("pass --fetch to download the pinned source files")
root = Path(__file__).resolve().parents[4]
destination = root / ".mockingbird/hermes-evidence/v2026.8.31"
destination.mkdir(parents=True, exist_ok=True)
for name, entry in LOCK["sources"].items():
    path = destination / name
    if path.exists():
        data = path.read_bytes()
    else:
        url = f"https://raw.githubusercontent.com/NousResearch/hermes-agent/{LOCK['commit']}/{entry['path']}"
        with urlopen(url, timeout=30) as response:
            data = response.read()
    if hashlib.sha256(data).hexdigest() != entry["sha256"]:
        raise ValueError(f"Pinned source hash mismatch: {name}")
    if not path.exists():
        path.write_bytes(data)
verify(destination)
print(f"Verified {len(LOCK['sources'])} files at {LOCK['commit']}")
