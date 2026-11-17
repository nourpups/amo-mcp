# Shared MCP/Apache publication wiring

`install-gate.py` installs the common controller lease into the supported existing paths discovered on ccprod. It does not publish an application, run Certbot, restart Apache, reload Apache, or change SQL. Its only systemd action is `daemon-reload`.

## Prerequisites and installation

Install the reviewed controller as root-owned `/usr/local/sbin/mcp-release` and its private configuration as `/etc/mcp-release/config.json` first. Validate the controller's own lease, inherited-descriptor/verified-ancestor handling and runtime recovery tests. Check that no old unguarded controller process is running before switching entrypoints. Run this installer through the user's attended release monitoring and `release-run --operation forward` boundary:

```sh
python3 /absolute/reviewed/install-gate.py
```

The installer imports the installed controller only after checking its root ownership, parent permissions and absence of symlinks. It then acquires that controller's real common OS lease **before** changing protected executables or systemd wiring. A competing lease holder causes denial without those changes.

The five existing executables are **moved**, not copied, to a sibling ending in `.mcp-release-vendor`. Their canonical paths become small wrappers calling `mcp-release run -- <relocated-vendor> "$@"`:

- `/usr/sbin/apachectl`
- `/usr/bin/certbot` (its original relative `certbot-3` symlink is moved intact)
- `/usr/local/sbin/junior-parallel-router`
- `/usr/local/bin/dars-api-tls`
- `/usr/local/sbin/ccprod-cleanup-final.py`

The latter two vendor payloads have only their known `systemctl reload httpd` commands changed to `mcp-release reload`. This avoids acquiring the same lease in an unrelated systemd daemon process while the publisher is holding it. The installer requires the exact expected command shape once and refuses changed payloads. No other application logic is changed.

Systemd gets two dedicated `mcp-release.conf` drop-ins:

- `httpd.service`: clear ExecReload and replace it with `mcp-release reload`.
- `certbot-renew.service`: clear ExecStart and wrap the existing renewal command, including its existing environment-variable arguments, in `mcp-release run`. The lease is held before the Apache authenticator can edit configuration, and through its reloads and cleanup.

The existing Apache ExecStart, PHP Wants drop-ins, renewal EnvironmentFile and timer schedule remain in place. Both MCP renewals use Certbot's Apache authenticator/installer. No renewal-hook files or configured hook commands were found during inspection. Future hooks which ask systemd to reload while the lease is held must be adapted deliberately; unlike ordinary child processes, systemd does not inherit the parent lease descriptor or ancestry.

## Ownership, recovery and upgrades

The root-private `/var/lib/mcp-release/wiring.json` contains paths, source/vendor hashes, symlink identities, modes and installation phase. It contains no configuration bodies or secrets. Installed wrappers and relocated vendors must still match that proof for an idempotent run. Unknown pre-existing vendor/drop-in files, externally changed payloads and incomplete installation states are refused.

On installation failure, the installer removes only its unchanged wrappers/drop-ins, reverses its known reload-command transforms and moves the original executors back. It then reloads systemd's unit definitions. It creates no content backup files. If a file changed concurrently or systemd recovery fails, it retains a `recovery-required` metadata state and refuses to claim successful restoration. A killed process likewise requires inspection of the `installing` state before another attempt.

Package updates may replace `/usr/bin/certbot` or `/usr/sbin/apachectl`; the next idempotency check must detect that loss of wiring. Requalify the new vendor version before publication. Do not overwrite a newly installed vendor with an old wrapper without preserving and reviewing that version.

Existing manual MCP deployments must enter `mcp-release run -- /absolute/reviewed/deploy-script` before live source synchronization or SQLite migration. Candidate preparation remains isolated. Existing Coddy/Junior GitLab main branches had no CI deployment configuration at inspection. This controller does not intercept arbitrary root shell commands, `/usr/sbin/httpd` invocations, `systemctl kill` or deliberate calls to relocated vendor paths. Those are not alternative supported release paths.

## Installed proof required before application publication

Local tests are necessary but insufficient. After installation, verify canonical wrapper hashes, vendor identity, `systemctl show` effective ExecReload/ExecStart and both drop-in paths. While a real holder owns the common lease, attempt each canonical entrypoint and a separate `mcp-release reload`/publication command; every competing attempt must fail before executor/config/runtime changes. Then verify ordinary non-mutating passthrough and nested inherited/ancestor lease behavior. Do not invoke renewal, bootstrap, TLS installation or historical cleanup simply to test wiring.

The common lease serializes the identified supported paths; it does not establish universal protection against root access. Keep that boundary explicit in release evidence.

## Tests

```sh
python3 -m unittest discover -s tests -p install_gate_test.py -v
```

The local filesystem fixture uses the actual controller lease with a temporary lock. It covers lease contention, moves and transforms, the Certbot symlink shape, idempotency, refusal of external payload changes, a mid-install filesystem failure and daemon-reload failure recovery. It performs no production action.
