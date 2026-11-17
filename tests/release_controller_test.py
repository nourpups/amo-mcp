import importlib.util
import json
import multiprocessing
import os
import re
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "deploy/release/mcp-release.py"
spec = importlib.util.spec_from_file_location("mcp_release", SOURCE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class FakeRuntime(m.Runtime):
    def __init__(self):
        self.calls = []
        self.unhealthy = False
        self.public_unhealthy = False
        self.invalid = False
        self.reload_failure = False

    def command(self, argv, capture=False):
        self.calls.append(tuple(argv))
        if "-t" in argv and "-f" in argv:
            prepared = Path(argv[argv.index("-f")+1]).read_text()
            vhost_path = re.search(r'^Include "([^"\n]+/vhost.conf)"$', prepared,re.M).group(1)
            vhost = Path(vhost_path).read_text()
            if "# mcp-release managed amo route" in vhost:
                include = re.search(r'^    Include "([^"\n]+/route.inc)"$',vhost,re.M)
                if not include or not Path(include.group(1)).exists():
                    raise m.Denied("candidate must validate its exact managed Include syntax")
                if 'ProxyPass "/amo/"' not in Path(include.group(1)).read_text():
                    raise m.Denied("candidate Include must reference prepared route content")
        if "-t" in argv and self.invalid:
            raise m.Denied("invalid candidate")
        if "graceful" in argv and self.reload_failure:
            self.reload_failure = False
            raise m.Denied("reload failed once")
        return b""

    def start(self, manifest, name):
        self.calls.append(("start", name))

    def remove(self, name):
        self.calls.append(("remove", name))

    def health(self, manifest):
        self.calls.append(("health", manifest["port"]))
        if self.unhealthy:
            raise m.Denied("unhealthy")

    def public_health(self, manifest):
        self.calls.append(("public_health",manifest["host"]))
        if self.public_unhealthy:
            raise m.Denied("public route unavailable")

    def identity(self, name):
        self.calls.append(("identity", name))


class FixtureController(m.Controller):
    def manifest(self, value):
        # Fixture files deliberately reside under /tmp and the caller owns the test DB.
        # Production root-only ownership validation is separately tested below.
        return dict(value)


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "conf.d").mkdir()
        self.vhost = self.root / "conf.d/mcp.conf"
        self.before = '<VirtualHost *:443>\nServerName mcp.coddycamp.uz\nDocumentRoot /accepted/current/public\nCustomLog /var/log/httpd/mcp-access.log combined\n</VirtualHost>\n'
        self.vhost.write_text(self.before)
        self.main = self.root / "httpd.conf"
        self.main.write_text('ServerRoot "%s"\nIncludeOptional conf.d/*.conf\n' % self.root)
        self.template = self.root / "template.inc"
        self.template.write_text('ProxyPass "/amo/" "http://127.0.0.1:@PORT@/amo/"\n')
        self.cfg = {"host":"mcp.coddycamp.uz", "state_dir":str(self.root / "state"), "work_dir":str(self.root / "work"), "lock_file":str(self.root / "lease"), "route_file":str(self.root / "routes/amo.inc"), "vhost_file":str(self.vhost), "apache_config":str(self.main), "apache_root":str(self.root), "apache_binary":"/fake/httpd", "health_timeout":0}
        self.runtime = FakeRuntime()
        self.dir_trust = patch.object(m, "private_directory", side_effect=lambda path, uid=0: Path(path))
        self.dir_trust.start()
        self.controller = FixtureController(self.cfg, self.runtime, os.getuid())
        self.manifest = {"source_sha":"a"*40,"image":"sha256:"+"b"*64,"port":18765,"host":"mcp.coddycamp.uz","template_file":str(self.template),"template_sha256":m.sha(self.template.read_bytes()),"expected_vhost_sha256":m.sha(self.vhost.read_bytes()),"env_file":"/private/runtime.env","data_dir":"/private/data"}
        self.trust = patch.object(m, "private_file", side_effect=lambda path, uid=0: Path(path))
        self.trust.start()

    def tearDown(self):
        self.trust.stop()
        self.dir_trust.stop()
        self.temp.cleanup()

    def test_held_common_lease_rejects_before_any_executor_or_route_change(self):
        with self.controller.lease():
            with self.assertRaises(m.Denied):
                self.controller.publish(self.manifest)
        self.assertEqual(self.runtime.calls, [])
        self.assertEqual(self.vhost.read_text(), self.before)

    def test_stale_vhost_fingerprint_rejects_before_container_start(self):
        self.vhost.write_text(self.before + "# concurrent accepted change\n")
        with self.assertRaises(m.Denied):
            self.controller.publish(self.manifest)
        self.assertEqual(self.runtime.calls, [])

    def test_unhealthy_candidate_never_changes_routing(self):
        self.runtime.unhealthy = True
        with self.assertRaises(m.Denied):
            self.controller.publish(self.manifest)
        self.assertEqual(self.vhost.read_text(), self.before)
        self.assertFalse(Path(self.cfg["route_file"]).exists())
        self.assertTrue(any(call[0] == "remove" for call in self.runtime.calls))
        self.assertFalse(any("graceful" in call for call in self.runtime.calls))

    def test_public_unhealthy_after_graceful_restores_only_own_first_install(self):
        self.runtime.public_unhealthy = True
        with self.assertRaises(m.Denied):
            self.controller.publish(self.manifest)
        self.assertEqual(self.vhost.read_text(), self.before)
        self.assertFalse(Path(self.cfg["route_file"]).exists())
        self.assertIsNone(self.controller.active())
        self.assertTrue(any(call[0] == "public_health" for call in self.runtime.calls))
        self.assertTrue(any(call[0] == "remove" for call in self.runtime.calls))

    def test_public_unhealthy_candidate_restores_previous_route_without_public_precondition(self):
        self.controller.publish(self.manifest)
        previous = self.controller.active()
        self.runtime.public_unhealthy = True
        with self.assertRaises(m.Denied):
            self.controller.publish({**self.manifest,"port":18766,"expected_vhost_sha256":m.sha(self.vhost.read_bytes())})
        self.assertEqual(self.controller.active(), previous)
        self.assertIn("127.0.0.1:18765",Path(self.cfg["route_file"]).read_text())
        self.assertFalse(("remove",previous["container"]) in self.runtime.calls)

    def test_validation_retains_real_include_directive_and_prepared_route_file(self):
        target = self.controller.with_include(self.before)
        self.assertIn('    # mcp-release managed amo route\n    Include "',target)
        self.assertNotRegex(target,r'Include[^\n]+#')
        self.controller.validate(target,self.controller.routes(self.manifest))
        self.assertTrue(any("-t" in call and "-f" in call for call in self.runtime.calls))

    def test_invalid_candidate_config_never_changes_active_tree(self):
        self.runtime.invalid = True
        with self.assertRaises(m.Denied):
            self.controller.publish(self.manifest)
        self.assertEqual(self.vhost.read_text(), self.before)
        self.assertFalse(Path(self.cfg["route_file"]).exists())
        self.assertFalse(any("graceful" in call for call in self.runtime.calls))

    def test_successful_first_install_and_recovery_preserve_unrelated_edits(self):
        release = self.controller.publish(self.manifest)
        self.assertIn(self.controller.directive, self.vhost.read_text())
        self.assertIn("combined env=!amo_sensitive", self.vhost.read_text())
        self.assertIn('127.0.0.1:18765', Path(self.cfg["route_file"]).read_text())
        self.assertFalse(any("build" in call for call in self.runtime.calls))
        self.vhost.write_text(self.vhost.read_text() + "# concurrent staff edit\n")
        self.controller.recover(release)
        self.assertEqual(self.vhost.read_text(), self.before + "# concurrent staff edit\n")
        self.assertIsNone(self.controller.active())
        self.assertFalse(Path(self.cfg["route_file"]).exists())

    def test_failed_reload_restores_only_own_added_route(self):
        self.runtime.reload_failure = True
        with self.assertRaises(m.Denied):
            self.controller.publish(self.manifest)
        self.assertEqual(self.vhost.read_text(), self.before)
        self.assertFalse(Path(self.cfg["route_file"]).exists())

    def test_second_release_retains_previous_runtime_and_recovers_it(self):
        first = self.controller.publish(self.manifest)
        original = self.controller.active()
        second_manifest = {**self.manifest,"port":18766,"expected_vhost_sha256":m.sha(self.vhost.read_bytes())}
        second = self.controller.publish(second_manifest)
        self.assertNotEqual(first, second)
        self.assertFalse(("remove", original["container"]) in self.runtime.calls)
        self.controller.recover(second)
        self.assertEqual(self.controller.active(), original)
        self.assertIn('127.0.0.1:18765', Path(self.cfg["route_file"]).read_text())

    def test_newer_route_is_not_overwritten_by_older_recovery(self):
        first = self.controller.publish(self.manifest)
        second = self.controller.publish({**self.manifest,"port":18766,"expected_vhost_sha256":m.sha(self.vhost.read_bytes())})
        with self.assertRaises(m.Denied):
            self.controller.recover(first)
        self.assertEqual(self.controller.active()["manifest"]["release_id"], second)

    def test_inherited_real_lease_allows_nested_wrapper_but_fake_fd_does_not(self):
        with self.controller.lease():
            with patch.dict(os.environ, {"MCP_RELEASE_LOCK_FD":str(self.runtime.lock_fd)}):
                with self.controller.lease():
                    pass
            with patch.dict(os.environ, {"MCP_RELEASE_LOCK_FD":"987654"}):
                with self.assertRaises(m.Denied):
                    with self.controller.lease():
                        pass

    def test_conflicting_log_policy_rejects_before_route_mutation(self):
        self.vhost.write_text(self.before.replace("combined", "combined env=staff_policy"))
        incoming = {**self.manifest,"expected_vhost_sha256":m.sha(self.vhost.read_bytes())}
        with self.assertRaises(m.Denied):
            self.controller.publish(incoming)
        self.assertFalse(Path(self.cfg["route_file"]).exists())

    def test_delegated_run_preserves_original_stdio_and_exit_status(self):
        runtime = m.Runtime()
        with patch.object(m.subprocess, "run", return_value=m.subprocess.CompletedProcess(["/vendor"], 42)) as run:
            self.assertEqual(runtime.delegate(["/vendor", "--status"]), 42)
            self.assertNotIn("stdout", run.call_args.kwargs)
            self.assertNotIn("stderr", run.call_args.kwargs)
            self.assertEqual(run.call_args.args[0], ["/vendor", "--status"])

    @unittest.skipUnless(Path("/proc/self/stat").exists(), "Linux kernel lease proof")
    def test_vendor_child_closing_fds_uses_actual_ancestor_kernel_lease(self):
        script = """
import importlib.util,json,os,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('gate',sys.argv[1]);gate=importlib.util.module_from_spec(spec);spec.loader.exec_module(gate)
gate.private_directory=lambda path,uid=0:Path(path)
controller=gate.Controller(json.loads(sys.argv[2]),uid=os.getuid())
with controller.lease():
    assert controller.runtime.lease_check()
"""
        with self.controller.lease():
            environment, _ = self.runtime.execution()
            result = subprocess.run([sys.executable,"-c",script,str(SOURCE),json.dumps(self.cfg)],env=environment,close_fds=True,capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            environment["MCP_RELEASE_LOCK_OWNER"] = "%s:wrong:%s" % (os.getpid(),self.runtime.lock_fd)
            forged = subprocess.run([sys.executable,"-c",script,str(SOURCE),json.dumps(self.cfg)],env=environment,close_fds=True,capture_output=True)
            self.assertNotEqual(forged.returncode, 0)

    def test_root_path_policy_rejects_symlink(self):
        self.trust.stop()
        symlink = self.root / "symlink"
        symlink.symlink_to(self.vhost)
        with self.assertRaises(m.Denied):
            m.private_file(symlink, os.getuid())
        self.trust.start()


if __name__ == "__main__":
    unittest.main()
