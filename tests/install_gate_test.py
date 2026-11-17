import contextlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

m = load("install_gate", ROOT / "deploy/release/install-gate.py")
c = load("real_controller", ROOT / "deploy/release/mcp-release.py")


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.originals = {}
        for logical in m.PATHS:
            p = self.path(logical)
            p.parent.mkdir(parents=True, exist_ok=True)
            if logical in m.TRANSFORMS:
                body = b"# test fixture\n" + m.TRANSFORMS[logical][0] + b"\n"
            else:
                body = b"#!/bin/sh\nexit 0\n"
            if logical == "/usr/bin/certbot":
                actual = p.with_name("certbot-3")
                actual.write_bytes(body)
                actual.chmod(0o755)
                p.symlink_to("certbot-3")
            else:
                p.write_bytes(body)
                p.chmod(0o755)
            self.originals[logical] = (body, os.readlink(p) if p.is_symlink() else None)
        self.trust = patch.object(c, "private_directory", side_effect=lambda path, uid=0: Path(path))
        self.trust.start()
        self.controller = c.Controller({"state_dir": str(self.root / "state"), "work_dir": str(self.root / "work"), "lock_file": str(self.root / "lock/common")}, uid=os.getuid())
        self.reloads = []
        self.installer = m.Installer(self.controller, self.root, uid=os.getuid(), daemon_reload=lambda: self.reloads.append("daemon-reload"))

    def path(self, logical):
        return self.root / logical.lstrip("/")

    def tearDown(self):
        self.trust.stop()
        self.temp.cleanup()

    def assert_unwired(self):
        for logical, (body, link) in self.originals.items():
            p = self.path(logical)
            self.assertEqual(p.read_bytes(), body)
            self.assertEqual(os.readlink(p) if p.is_symlink() else None, link)
            self.assertFalse(self.path(logical + m.SUFFIX).exists())
        for logical in m.DROPINS:
            self.assertFalse(self.path(logical).exists())
        self.assertFalse(self.installer.metadata.exists())

    def test_real_controller_held_lease_rejects_before_protected_writes(self):
        with self.controller.lease():
            with self.assertRaises(c.Denied):
                self.installer.install()
        self.assert_unwired()
        self.assertEqual(self.reloads, [])

    def test_moves_executors_wraps_entrypoints_and_is_idempotent(self):
        self.assertEqual(self.installer.install()["status"], "installed")
        for logical, (body, link) in self.originals.items():
            self.assertEqual(self.path(logical).read_bytes(), m.wrapper(logical))
            vendor = self.path(logical + m.SUFFIX)
            if logical in m.TRANSFORMS:
                self.assertEqual(vendor.read_bytes(), body.replace(*m.TRANSFORMS[logical]))
            else:
                self.assertEqual(vendor.read_bytes(), body)
            self.assertEqual(os.readlink(vendor) if vendor.is_symlink() else None, link)
        for logical, data in m.DROPINS.items():
            self.assertEqual(self.path(logical).read_bytes(), data)
        state = json.loads(self.installer.metadata.read_text())
        self.assertEqual(state["phase"], "installed")
        self.assertEqual(stat.S_IMODE(self.installer.metadata.stat().st_mode), 0o600)
        self.assertEqual(self.installer.install()["status"], "already-installed")
        self.assertEqual(self.reloads, ["daemon-reload"])

    def test_unsupported_payload_denied_before_any_write(self):
        logical = "/usr/local/bin/dars-api-tls"
        p = self.path(logical)
        p.write_bytes(b"unknown new vendor version\n")
        with self.assertRaises(m.Denied):
            self.installer.install()
        self.assertEqual(p.read_bytes(), b"unknown new vendor version\n")
        for other in m.PATHS:
            self.assertFalse(self.path(other + m.SUFFIX).exists())
        self.assertFalse(self.installer.metadata.exists())
        self.assertEqual(self.reloads, [])

    def test_changed_installed_vendor_is_never_overwritten(self):
        self.installer.install()
        p = self.path("/usr/sbin/apachectl" + m.SUFFIX)
        p.write_bytes(b"updated externally")
        with self.assertRaises(m.Denied):
            self.installer.install()
        self.assertEqual(p.read_bytes(), b"updated externally")
        self.assertEqual(self.reloads, ["daemon-reload"])

    def test_daemon_failure_restores_moved_originals_and_inverse_transforms(self):
        calls = []
        def daemon():
            calls.append("daemon-reload")
            if len(calls) == 1:
                raise m.Denied("fixture daemon failure")
        self.installer.daemon_reload = daemon
        with self.assertRaises(m.Denied):
            self.installer.install()
        self.assert_unwired()
        self.assertEqual(calls, ["daemon-reload", "daemon-reload"])

    def test_mid_install_failure_restores_only_own_changes(self):
        real_atomic = m.atomic
        def fail_at_certbot(path, data, mode):
            if path == self.path("/usr/bin/certbot"):
                raise OSError("fixture disk failure")
            return real_atomic(path, data, mode)
        with patch.object(m, "atomic", side_effect=fail_at_certbot):
            with self.assertRaises(OSError):
                self.installer.install()
        self.assert_unwired()

    def test_linux_certbot_symlink_mode_does_not_bypass_target_checks(self):
        certbot = self.path("/usr/bin/certbot")
        original_lstat = Path.lstat
        def linux_link_mode(path):
            info = original_lstat(path)
            if path == certbot:
                fields = list(info)
                fields[0] = stat.S_IFLNK | 0o777
                return os.stat_result(fields)
            return info
        with patch.object(Path, "lstat", linux_link_mode):
            self.assertEqual(self.installer.install()["status"], "installed")

    def test_existing_unowned_vendor_or_dropin_is_not_overwritten(self):
        p = self.path(next(iter(m.DROPINS)))
        p.parent.mkdir(parents=True)
        p.write_text("external configuration")
        with self.assertRaises(m.Denied):
            self.installer.install()
        self.assertEqual(p.read_text(), "external configuration")
        self.assertFalse(self.installer.metadata.exists())
        self.assertEqual(self.reloads, [])


if __name__ == "__main__":
    unittest.main()
