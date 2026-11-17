#!/usr/bin/env python3
"""Validate the complete prepared Apache tree without changing live files."""
import importlib.util
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("gate", root / "deploy/release/mcp-release.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
config = json.loads((root / "deploy/release/config.example.json").read_text())
config["state_dir"] = str(root / "validation-state")
config["work_dir"] = str(root / "validation-work")
gate = module.Controller(config)
gate.validate(gate.with_include(gate.vhost()), (root / "deploy/apache-amo.inc").read_text().replace("@PORT@", "18765"))
print("Actual full Apache candidate configtest passed; live files unchanged")
path = Path("/etc/sysconfig/httpd")
values = re.findall(r"(?m)^\s*OPTIONS=(.*)$", path.read_text() if path.exists() else "")
empty = not values or all(not value.strip().strip("\"'") for value in values)
print("httpd OPTIONS absent/empty:", empty)
if not empty:
    raise SystemExit("Nonempty Apache options need qualification before installation")
