#!/usr/bin/env python3
"""Run the read-only preflight with only the read-role credential file loaded."""
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from awx_client import ROOT, load_role_env, role_env_path

MAP = {"AWX_READ_CLIENT_ID": "AWX_SANDBOX_CLIENT_ID", "AWX_READ_API_KEY": "AWX_SANDBOX_API_KEY"}


def read_scoped(path):
    loaded = load_role_env(path, "read")
    return {MAP[k]: v for k, v in loaded.items() if k in MAP}


def child_env(path):
    env = {k: v for k, v in os.environ.items() if not k.startswith("AWX_")}
    env.update(read_scoped(path))
    return env


def main():
    return subprocess.call([sys.executable, str(ROOT / "scripts" / "airwallex_readonly_preflight.py")],
                           env=child_env(role_env_path("read")))


if __name__ == "__main__":
    sys.exit(main())
