#!/usr/bin/env python3
"""Install the shared MCP lease into existing supported Apache release paths.

Moves vendor executables; never copies them as backups. Does not reload Apache,
restart services, run certbot, apply SQL, or publish an application.
"""
import argparse
import contextlib
import hashlib
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile


class Denied(RuntimeError):
    pass


PATHS = ("/usr/sbin/apachectl", "/usr/bin/certbot", "/usr/local/sbin/junior-parallel-router",
         "/usr/local/bin/dars-api-tls", "/usr/local/sbin/ccprod-cleanup-final.py")
CONTROLLER = "/usr/local/sbin/mcp-release"
SUFFIX = ".mcp-release-vendor"
TRANSFORMS = {
    "/usr/local/bin/dars-api-tls": (b"systemctl reload httpd", b"/usr/local/sbin/mcp-release reload"),
    "/usr/local/sbin/ccprod-cleanup-final.py": (
        b"subprocess.run(['systemctl','reload','httpd'],check=True)",
        b"subprocess.run(['/usr/local/sbin/mcp-release','reload'],check=True)"),
}
DROPINS = {
    "/etc/systemd/system/httpd.service.d/mcp-release.conf":
        b"[Service]\nExecReload=\nExecReload=/usr/local/sbin/mcp-release reload\n",
    "/etc/systemd/system/certbot-renew.service.d/mcp-release.conf":
        b"[Service]\nExecStart=\nExecStart=/usr/local/sbin/mcp-release run -- /usr/bin/certbot.mcp-release-vendor renew --noninteractive --no-random-sleep-on-renew $PRE_HOOK $POST_HOOK $RENEW_HOOK $DEPLOY_HOOK $CERTBOT_ARGS\n",
}


def digest(value):
    return hashlib.sha256(value).hexdigest()


def atomic(path, data, mode):
    fd, name = tempfile.mkstemp(prefix=".mcp-wire-", dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(name)


def wrapper(path):
    return ("#!/bin/sh\n# Managed shared MCP/Apache publication lease.\nexec %s run -- %s%s \"$@\"\n" %
            (CONTROLLER, path, SUFFIX)).encode()


class Installer:
    def __init__(self, controller, root=Path("/"), uid=0, daemon_reload=None):
        self.controller, self.root, self.uid = controller, Path(root).resolve(), uid
        self.metadata = self.path("/var/lib/mcp-release/wiring.json")
        self.daemon_reload = daemon_reload or self.systemd_reload

    def path(self, logical):
        return self.root / logical.lstrip("/")

    def trusted(self, path, allow_link=False):
        # Fixture roots are explicit. Production checks extend through filesystem root.
        relative = path.relative_to(self.root)
        items = [self.root]
        current = self.root
        for part in relative.parts:
            current /= part
            items.append(current)
        for item in items:
            if not item.exists() and not item.is_symlink():
                continue
            info = item.lstat()
            allowed_link = allow_link and item == path and stat.S_ISLNK(info.st_mode)
            if info.st_uid != self.uid or (info.st_mode & 0o022 and not allowed_link):
                raise Denied("untrusted wiring path ownership or permissions")
            if stat.S_ISLNK(info.st_mode) and not allowed_link:
                raise Denied("unexpected wiring symlink")
        if allow_link and path.is_symlink():
            resolved = path.resolve(strict=True)
            self.trusted(resolved)

    @staticmethod
    def systemd_reload():
        result = subprocess.run(["/usr/bin/systemctl", "daemon-reload"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode:
            raise Denied("systemd daemon-reload failed")

    def describe(self, logical):
        path = self.path(logical)
        self.trusted(path, allow_link=logical == "/usr/bin/certbot")
        if not path.is_file():
            raise Denied("required executor is absent")
        info = path.lstat()
        data = path.read_bytes()
        transformed = data
        transform = TRANSFORMS.get(logical)
        if transform:
            if data.count(transform[0]) != 1 or transform[1] in data:
                raise Denied("unsupported executor payload; expected reload boundary changed")
            transformed = data.replace(*transform)
        return {"path": logical, "original_sha256": digest(data), "vendor_sha256": digest(transformed),
                "wrapper_sha256": digest(wrapper(logical)), "mode": stat.S_IMODE(info.st_mode),
                "symlink": os.readlink(path) if path.is_symlink() else None}

    def validate_installed(self, state):
        if state.get("version") != 1 or state.get("phase") != "installed":
            raise Denied("incomplete wiring installation requires inspection")
        if [x.get("path") for x in state.get("executors", [])] != list(PATHS):
            raise Denied("wiring executor manifest changed")
        for record in state["executors"]:
            logical = record["path"]
            public, vendor = self.path(logical), self.path(logical + SUFFIX)
            self.trusted(public)
            self.trusted(vendor, allow_link=logical == "/usr/bin/certbot")
            if (not public.is_file() or public.is_symlink() or digest(public.read_bytes()) != digest(wrapper(logical)) or
                    digest(vendor.read_bytes()) != record["vendor_sha256"] or
                    (os.readlink(vendor) if vendor.is_symlink() else None) != record["symlink"]):
                raise Denied("installed wiring or vendor executor changed")
        for logical, data in DROPINS.items():
            path = self.path(logical)
            self.trusted(path)
            if not path.is_file() or path.read_bytes() != data:
                raise Denied("installed systemd wiring changed")

    def install(self):
        # Controller validates/inherits an OS-held common lease, never a flag alone.
        with self.controller.lease():
            self.trusted(self.metadata)
            if self.metadata.exists():
                state = json.loads(self.metadata.read_text())
                self.validate_installed(state)
                return {"status": "already-installed", "executors": len(PATHS)}
            records = [self.describe(logical) for logical in PATHS]
            for logical in PATHS:
                vendor = self.path(logical + SUFFIX)
                if vendor.exists() or vendor.is_symlink():
                    raise Denied("unowned relocated executor exists")
            for logical, data in DROPINS.items():
                path = self.path(logical)
                self.trusted(path)
                if path.exists() or path.is_symlink():
                    raise Denied("unowned systemd drop-in exists")
            created_dirs, moved, dropins = [], [], []
            state = {"version": 1, "phase": "installing", "executors": records,
                     "dropins": {key: digest(value) for key, value in DROPINS.items()}}
            try:
                self.make_parents(self.metadata, created_dirs)
                atomic(self.metadata, json.dumps(state, sort_keys=True).encode(), 0o600)
                for record in records:
                    logical = record["path"]
                    public, vendor = self.path(logical), self.path(logical + SUFFIX)
                    # Compare again immediately before mutation; never replace another writer.
                    if self.describe(logical) != record:
                        raise Denied("executor changed during wiring installation")
                    os.rename(public, vendor)
                    moved.append(record)
                    if logical in TRANSFORMS:
                        original = vendor.read_bytes()
                        atomic(vendor, original.replace(*TRANSFORMS[logical]), record["mode"])
                    atomic(public, wrapper(logical), 0o755)
                for logical, data in DROPINS.items():
                    path = self.path(logical)
                    self.make_parents(path, created_dirs)
                    atomic(path, data, 0o644)
                    dropins.append(logical)
                self.daemon_reload()
                state["phase"] = "installed"
                atomic(self.metadata, json.dumps(state, sort_keys=True).encode(), 0o600)
                self.validate_installed(state)
                return {"status": "installed", "executors": len(records)}
            except BaseException:
                # Restore only exact payloads from this attempt, with inverse transforms.
                rollback_errors = []
                for logical in reversed(dropins):
                    path = self.path(logical)
                    if path.is_file() and path.read_bytes() == DROPINS[logical]:
                        path.unlink()
                    else:
                        rollback_errors.append("drop-in changed")
                for record in reversed(moved):
                    try:
                        logical = record["path"]
                        public, vendor = self.path(logical), self.path(logical + SUFFIX)
                        if public.exists() or public.is_symlink():
                            if public.is_symlink() or public.read_bytes() != wrapper(logical):
                                raise Denied("wrapper changed during rollback")
                            public.unlink()
                        if digest(vendor.read_bytes()) != record["vendor_sha256"]:
                            # Atomic transform might have failed before replacement.
                            if digest(vendor.read_bytes()) != record["original_sha256"]:
                                raise Denied("vendor changed during rollback")
                        elif logical in TRANSFORMS:
                            original = vendor.read_bytes().replace(TRANSFORMS[logical][1], TRANSFORMS[logical][0])
                            if digest(original) != record["original_sha256"]:
                                raise Denied("inverse reload transform failed")
                            atomic(vendor, original, record["mode"])
                        os.rename(vendor, public)
                    except (OSError, Denied):
                        rollback_errors.append("executor recovery failed")
                try:
                    self.daemon_reload()
                except Exception:
                    rollback_errors.append("daemon recovery failed")
                if rollback_errors:
                    state["phase"] = "recovery-required"
                    atomic(self.metadata, json.dumps(state, sort_keys=True).encode(), 0o600)
                    raise Denied("wiring recovery needs inspection") from None
                with contextlib.suppress(FileNotFoundError):
                    self.metadata.unlink()
                for directory in reversed(created_dirs):
                    with contextlib.suppress(OSError):
                        directory.rmdir()
                raise

    def make_parents(self, path, created):
        absent = []
        parent = path.parent
        while not parent.exists():
            absent.append(parent)
            parent = parent.parent
        self.trusted(parent)
        for directory in reversed(absent):
            directory.mkdir(mode=0o700 if directory == self.metadata.parent else 0o755)
            created.append(directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--controller", default=CONTROLLER)
    parser.add_argument("--config", default="/etc/mcp-release/config.json")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise Denied("installer must run as root")
    # Validate before importing executable controller source.
    for value in (args.controller, args.config):
        p = Path(value)
        for item in (p, *p.parents):
            info = item.lstat()
            if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise Denied("untrusted controller or config")
    loader = importlib.machinery.SourceFileLoader("mcp_release_installed", args.controller)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    controller = module.Controller(json.loads(Path(args.config).read_text()))
    print(json.dumps(Installer(controller).install(), sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError):
        print("mcp gate installation denied; inspect private wiring state", file=sys.stderr)
        sys.exit(73)
