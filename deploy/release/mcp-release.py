#!/usr/bin/env python3
"""Root-owned MCP publication boundary. No builds, SQL or credential output."""
import argparse
import contextlib
import fcntl
import glob
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid


class Denied(RuntimeError):
    pass


def sha(data):
    return hashlib.sha256(data).hexdigest()


def private_file(path, uid=0):
    path = Path(path)
    for item in (path, *path.parents):
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != uid or info.st_mode & 0o022:
            raise Denied("untrusted path ownership or permissions")
    if not path.is_file():
        raise Denied("expected regular file")
    return path


def private_directory(path, uid=0):
    path = Path(path)
    for item in (path, *path.parents):
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != uid or info.st_mode & 0o022:
            raise Denied("untrusted directory ownership or permissions")
    if not path.is_dir():
        raise Denied("expected directory")
    return path


def atomic(path, data, mode=0o600):
    path = Path(path)
    fd, name = tempfile.mkstemp(prefix=".candidate-", dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(name)


class Runtime:
    lock_fd = None

    def command(self, argv, capture=False):
        # Diagnostics are categorical: Docker/configtest output may contain private config.
        environment = dict(os.environ)
        inherited = ()
        if self.lock_fd is not None:
            environment["MCP_RELEASE_LOCK_FD"] = str(self.lock_fd)
            inherited = (self.lock_fd,)
        else:
            environment.pop("MCP_RELEASE_LOCK_FD", None)
        result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=environment, pass_fds=inherited)
        if result.returncode:
            raise Denied("external executor failed")
        return result.stdout if capture else b""

    def inspect_image(self, image):
        data = json.loads(self.command(["docker", "image", "inspect", image], True))
        return data[0]

    def start(self, manifest, name):
        self.command([
            "docker", "run", "--detach", "--name", name, "--init", "--restart", "unless-stopped",
            "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
            "--tmpfs", "/tmp:size=16m,mode=1777", "--publish", "127.0.0.1:%s:8765" % manifest["port"],
            "--env-file", manifest["env_file"], "--mount", "type=bind,src=%s,dst=/data" % manifest["data_dir"],
            "--label", "mcp.release=%s" % manifest["release_id"], manifest["image"],
        ])

    def health(self, manifest):
        request = urllib.request.Request("http://127.0.0.1:%s/amo/health" % manifest["port"], headers={"Host": manifest["host"]})
        # A local health endpoint must never redirect into another service.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args):
                return None
        with urllib.request.build_opener(NoRedirect).open(request, timeout=2) as response:
            body = json.load(response)
            if response.status != 200 or body.get("name") != "amocrm-mcp" or body.get("ok") is not True:
                raise Denied("candidate is not healthy")

    def identity(self, name):
        self.command(["docker", "exec", name, "node", "-e", "const fs=require('node:fs');if(process.getuid()!==1000)process.exit(1);fs.accessSync('/data/amo.sqlite',fs.constants.R_OK|fs.constants.W_OK)"])

    def remove(self, name):
        self.command(["docker", "rm", "--force", name])


class Controller:
    def __init__(self, config, runtime=None, uid=0):
        self.cfg, self.runtime, self.uid = config, runtime or Runtime(), uid
        self.state_dir = Path(config["state_dir"])
        self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        private_directory(self.state_dir, uid)
        self.work_dir = Path(config["work_dir"])
        self.work_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        private_directory(self.work_dir, uid)

    @contextlib.contextmanager
    def lease(self):
        path = Path(self.cfg["lock_file"])
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        private_directory(path.parent, self.uid)
        if path.exists() and (path.is_symlink() or path.stat().st_uid != self.uid):
            raise Denied("untrusted lease file")
        supplied = os.environ.get("MCP_RELEASE_LOCK_FD", "")
        inherited = None
        if supplied:
            try:
                inherited = int(supplied)
                info = os.fstat(inherited)
                active = path.stat()
                if (info.st_dev, info.st_ino) != (active.st_dev, active.st_ino):
                    raise ValueError("wrong lease descriptor")
                fd = os.dup(inherited)
            except (OSError, ValueError):
                raise Denied("invalid inherited lease descriptor")
        else:
            fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        previous_fd = self.runtime.lock_fd
        try:
            try:
                # Shared open-file-description inherits the real lock, not an env flag.
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Denied("another MCP/Apache publication owns the lease")
            self.runtime.lock_fd = fd
            yield
        finally:
            self.runtime.lock_fd = previous_fd
            os.close(fd)

    def active(self):
        path = self.state_dir / "active.json"
        return json.loads(private_file(path, self.uid).read_text()) if path.exists() else None

    def write_state(self, state):
        atomic(self.state_dir / (state["id"] + ".json"), json.dumps(state, sort_keys=True).encode())

    def manifest(self, manifest):
        manifest = dict(manifest)
        if not re.fullmatch(r"[0-9a-f]{40}", manifest.get("source_sha", "")):
            raise Denied("invalid source revision")
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", manifest.get("image", "")):
            raise Denied("expected an immutable local image ID")
        if not re.fullmatch(r"[0-9a-f]{64}", manifest.get("expected_vhost_sha256", "")):
            raise Denied("expected current vhost fingerprint")
        if not re.fullmatch(r"[0-9a-f]{64}", manifest.get("template_sha256", "")):
            raise Denied("expected prepared route template fingerprint")
        if manifest.get("host") != self.cfg["host"] or manifest["host"] != "mcp.coddycamp.uz":
            raise Denied("unsupported public host")
        if type(manifest.get("port")) is not int or not 1024 <= manifest["port"] <= 65535:
            raise Denied("invalid private port")
        for key in ("env_file", "template_file"):
            if not Path(manifest[key]).is_absolute():
                raise Denied("paths must be absolute")
            private_file(manifest[key], self.uid)
        if sha(Path(manifest["template_file"]).read_bytes()) != manifest["template_sha256"]:
            raise Denied("route template changed")
        data = Path(manifest["data_dir"])
        if not data.is_absolute() or data.is_symlink() or not data.is_dir() or data.stat().st_uid != 1000 or data.stat().st_mode & 0o077:
            raise Denied("persistent SQLite directory must be private and owned by UID1000")
        # Never allow commas to escape Docker's mount argument syntax.
        if "," in str(data):
            raise Denied("invalid data directory")
        image = self.runtime.inspect_image(manifest["image"])
        if image.get("Id") != manifest["image"] or (image.get("Config", {}).get("Labels") or {}).get("org.opencontainers.image.revision") != manifest["source_sha"]:
            raise Denied("image/source identity mismatch")
        if str(image.get("Config", {}).get("User")) not in ("node", "1000", "1000:1000"):
            raise Denied("candidate must run as UID1000")
        if image.get("Architecture") != self.cfg.get("architecture", "amd64"):
            raise Denied("candidate image architecture mismatch")
        return manifest

    @property
    def directive(self):
        return '    Include "%s" # mcp-release managed amo route\n' % self.cfg["route_file"]

    def vhost(self):
        return private_file(self.cfg["vhost_file"], self.uid).read_text()

    def with_include(self, text):
        if self.directive in text:
            if text.count(self.directive) != 1:
                raise Denied("duplicate managed route")
            return text
        if len(re.findall(r"</VirtualHost\s*>", text, re.I)) != 1:
            raise Denied("expected one TLS virtual host")
        if self.cfg["route_file"] in text:
            raise Denied("unrecognized route directive")
        return re.sub(r"(?i)(</VirtualHost\s*>)", lambda match: self.directive + match[1], text, count=1)

    def routes(self, manifest):
        private_file(manifest["template_file"], self.uid)
        content = Path(manifest["template_file"]).read_bytes()
        if sha(content) != manifest["template_sha256"]:
            raise Denied("retained route artifact changed")
        return content.replace(b"@PORT@", str(manifest["port"]).encode()).decode()

    def validate(self, vhost, route):
        """Validate a complete candidate configuration without changing the active tree."""
        main = private_file(self.cfg["apache_config"], self.uid).read_text()
        pattern = self.cfg.get("include_pattern", "conf.d/*.conf")
        server_root = Path(self.cfg.get("apache_root", "/etc/httpd"))
        files = sorted(glob.glob(str(server_root / pattern)))
        target = str(Path(self.cfg["vhost_file"]))
        if files.count(target) != 1:
            raise Denied("active vhost is not in the configured Apache include set")
        # A generated configuration is validation input, not a backup of live state.
        with tempfile.TemporaryDirectory(prefix="validate-", dir=self.work_dir) as directory:
            candidate = Path(directory) / "vhost.conf"
            candidate.write_text(vhost.replace(self.directive, route + "\n"))
            lines = ['Include "%s"' % (candidate if file == target else file) for file in files]
            token = re.compile(r"(?m)^\s*IncludeOptional\s+" + re.escape(pattern) + r"\s*$")
            if len(token.findall(main)) != 1:
                raise Denied("cannot construct the complete Apache validation tree")
            prepared = Path(directory) / "httpd.conf"
            prepared.write_text(token.sub("\n".join(lines), main))
            self.runtime.command([self.cfg["apache_binary"], "-t", "-f", str(prepared)])

    def reload(self):
        self.runtime.command([self.cfg["apache_binary"], "-t"])
        self.runtime.command([self.cfg["apache_binary"], "-k", "graceful"])

    def wait_health(self, manifest):
        deadline = time.monotonic() + self.cfg.get("health_timeout", 25)
        while True:
            try:
                self.runtime.health(manifest)
                return
            except Exception:
                if time.monotonic() >= deadline:
                    raise Denied("candidate did not become healthy")
                time.sleep(0.25)

    def publish(self, incoming):
        with self.lease():
            manifest = self.manifest(incoming)
            before = self.vhost()
            if sha(before.encode()) != manifest["expected_vhost_sha256"]:
                raise Denied("active vhost changed; preserve and requalify the new delta")
            previous = self.active()
            route_path = Path(self.cfg["route_file"])
            if previous:
                if not route_path.exists() or sha(private_file(route_path, self.uid).read_bytes()) != previous["route_sha256"] or self.directive not in before:
                    raise Denied("active managed routing differs from its accepted identity")
                self.wait_health(previous["manifest"])
            elif route_path.exists() or self.directive in before:
                raise Denied("unregistered route must be reconciled before publication")
            manifest["release_id"] = uuid.uuid4().hex
            name = "amo-mcp-%s-%s" % (manifest["source_sha"][:12], manifest["release_id"][:8])
            state = {"id": manifest["release_id"], "phase": "prepared", "manifest": manifest, "container": name, "previous": previous, "vhost_added": self.directive not in before}
            self.write_state(state)
            attempted = False
            route_written = False
            try:
                attempted = True
                self.runtime.start(manifest, name)
                self.wait_health(manifest)
                self.runtime.identity(name)
                after = self.with_include(before)
                route = self.routes(manifest)
                self.validate(after, route)
                # Check immediately before first configuration mutation as well.
                if self.vhost() != before:
                    raise Denied("active vhost changed during candidate preparation")
                route_path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                private_directory(route_path.parent, self.uid)
                state.update(phase="publishing", route_sha256=sha(route.encode()))
                self.write_state(state)
                atomic(route_path, route.encode(), 0o644)
                route_written = True
                state["phase"] = "route-installed"
                self.write_state(state)
                atomic(self.cfg["vhost_file"], after.encode(), 0o644)
                self.reload()
                self.wait_health(manifest)
                active = {"manifest": manifest, "container": name, "route_sha256": state["route_sha256"]}
                atomic(self.state_dir / "active.json", json.dumps(active, sort_keys=True).encode())
                state["phase"] = "published"
                self.write_state(state)
                return state["id"]
            except Exception:
                # Restore only our own route delta; no copied vhost backup is retained.
                if route_written:
                    self.restore(state)
                elif attempted:
                    with contextlib.suppress(Exception):
                        self.runtime.remove(name)
                state["phase"] = "failed-restored" if route_written else "failed-prepublication"
                self.write_state(state)
                raise

    def restore(self, state):
        current = self.vhost()
        path = Path(self.cfg["route_file"])
        if path.exists() and sha(path.read_bytes()) != state.get("route_sha256"):
            raise Denied("managed route changed; recovery cannot overwrite another publication")
        previous = state["previous"]
        if previous:
            self.wait_health(previous["manifest"])
            route = self.routes(previous["manifest"])
            target = self.with_include(current)
        else:
            if current.count(self.directive) > 1:
                raise Denied("ambiguous managed directive during recovery")
            target, route = current.replace(self.directive, ""), ""
        self.validate(target, route)
        if previous:
            atomic(path, route.encode(), 0o644)
        atomic(self.cfg["vhost_file"], target.encode(), 0o644)
        self.reload()
        if not previous:
            with contextlib.suppress(FileNotFoundError):
                path.unlink()
            with contextlib.suppress(FileNotFoundError):
                (self.state_dir / "active.json").unlink()
        else:
            atomic(self.state_dir / "active.json", json.dumps(previous, sort_keys=True).encode())
        self.runtime.remove(state["container"])

    def recover(self, release_id):
        if not re.fullmatch(r"[0-9a-f]{32}", release_id):
            raise Denied("invalid release identity")
        with self.lease():
            state = json.loads(private_file(self.state_dir / (release_id + ".json"), self.uid).read_text())
            if state["phase"] not in ("prepared", "publishing", "route-installed", "published"):
                raise Denied("release has no live route to recover")
            active = self.active()
            previous_container = (state.get("previous") or {}).get("container")
            if active and active["container"] not in (state["container"], previous_container):
                raise Denied("a newer release owns the active route")
            route = Path(self.cfg["route_file"])
            previous_hash = (state.get("previous") or {}).get("route_sha256")
            untouched = (not route.exists() and self.directive not in self.vhost()) or (route.exists() and previous_hash and sha(route.read_bytes()) == previous_hash)
            if state["phase"] in ("prepared", "publishing") and untouched:
                with contextlib.suppress(Exception):
                    self.runtime.remove(state["container"])
            else:
                self.restore(state)
            state["phase"] = "recovered"
            self.write_state(state)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/etc/mcp-release/config.json")
    parser.add_argument("operation", choices=("inspect", "publish", "recover", "reload", "run"))
    parser.add_argument("args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise Denied("controller must run as root")
    config = json.loads(private_file(args.config).read_text())
    controller = Controller(config)
    if args.operation == "inspect":
        print(json.dumps({"vhost_sha256": sha(controller.vhost().encode()), "active": controller.active()}, sort_keys=True))
    elif args.operation == "publish":
        if len(args.args) != 1:
            raise Denied("publish requires one root-owned manifest path")
        manifest = json.loads(private_file(args.args[0]).read_text())
        print(json.dumps({"release_id": controller.publish(manifest), "status": "published"}))
    elif args.operation == "recover":
        if len(args.args) != 1:
            raise Denied("recover requires release ID")
        controller.recover(args.args[0])
        print('{"status":"recovered"}')
    else:
        with controller.lease():
            if args.operation == "reload":
                if args.args:
                    raise Denied("reload accepts no arguments")
                controller.reload()
            else:
                command = args.args[1:] if args.args[:1] == ["--"] else args.args
                if not command or not Path(command[0]).is_absolute():
                    raise Denied("run requires an absolute executable and argv after --")
                controller.runtime.command(command)


if __name__ == "__main__":
    try:
        main()
    except (Denied, OSError, ValueError, KeyError):
        print("mcp-release: publication denied or executor failed; inspect private release state", file=sys.stderr)
        sys.exit(73)
