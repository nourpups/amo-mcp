# Shared MCP publication boundary

Install the Python stdlib executable root-owned at `/usr/local/sbin/mcp-release` and a root-owned config at `/etc/mcp-release/config.json`; examples here contain no credentials. Config, manifest, prepared template and their ancestors must be root-owned and not group/world writable. SQLite data is instead UID1000-owned, mode700. `/run/mcp-release` and `/var/lib/mcp-release` are root-private directories. Do not put the lease directly in world-writable `/run/lock`.

Commands:

- `mcp-release inspect`: current vhost fingerprint and artifact metadata.
- `mcp-release publish /absolute/root-owned-manifest.json`: immutable prebuilt image only, source/architecture/user validation, new uniquely named container, localhost health with public Host, runtime UID/SQLite check, full candidate Apache validation, compare-and-swap vhost check, managed route installation and graceful reload. Existing root MCP directives remain in place. No SQL/build command runs in the controller.
- `mcp-release recover <release-id>`: removes only the first installation's own Include/log filter or regenerates the previous managed route from its retained verified artifact and keeps the prior container healthy. Unrelated staff changes to the vhost survive. A newer published route cannot be rolled back by an older state. State contains IDs, hashes and paths, not live config backup copies or secret values.
- `mcp-release reload`: configtest and graceful Apache reload under the common lease.
- `mcp-release run -- /absolute/vendor/executable args...`: same lease around an existing supported writer. This delegation preserves original stdout, stderr and exit status. Caller must handle its original credential output safely.

A contender fails before Docker/config/runtime actions. The entire existing writer must enter `run`, not only its final restart. Required actual server wiring includes `httpd` systemd ExecReload, whole certbot renewal before Apache plugin edits, and supported manual deployment/router writers. Apache's vendor `apachectl graceful` can directly signal httpd and bypass systemd ExecReload; its actual installed wrapper must use the same controller. Known vendor commands that call `systemctl reload httpd` while already holding the lease must call nested `mcp-release reload` instead, since systemd does not inherit the caller's descriptor.

Nested controlled children inherit the real flock descriptor. Vendor programs such as certbot may close unrelated FDs; Linux fallback then proves the recorded owner is an actual ancestor with matching process start ticks, root-owned lock inode and current kernel FLOCK record. An environment value alone grants no authority. Ancestor proof is checked again before each delegated executor action. The controlling parent synchronously waits for vendor children. This coverage is for installed supported writers; arbitrary privileged root-shell mutation is not intercepted or claimed prevented.

The root prepares a route template using `@PORT@` for the candidate private port, containing the `/amo/` and path-specific discovery ProxyPass rules, the `amo_sensitive` SetEnvIf rule and a dedicated query-free CustomLog. The controller adds `env=!amo_sensitive` to exactly one existing unfiltered combined access log under an owned marker, so authorization flows never also enter the old query-bearing combined log. Recovery reverses only its own marker/filter. Unsupported existing logging policy fails closed.

Before production, verify actual installation hashes and every known writer binding, then prove a competing attempt is denied before mutation. Local tests do not prove server wiring. Register attended availability monitoring and execute forward actions through the existing `dev-task-state release-run --operation forward` boundary. This helper grants no outage approval or backup permission.

Tests: `python3 -m unittest discover -s tests -p 'release_controller_test.py' -v`. Linux-only test checks the vendor close_fds path against the actual kernel lock owner; it is skipped on macOS and must run on Linux before installation.
