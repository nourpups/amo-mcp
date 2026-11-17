# Include INSIDE the existing mcp.coddycamp.uz TLS VirtualHost.
# Keep the existing root MCP and its discovery routes unchanged.
ProxyPass "/.well-known/oauth-authorization-server/amo" "http://127.0.0.1:8765/.well-known/oauth-authorization-server/amo"
ProxyPassReverse "/.well-known/oauth-authorization-server/amo" "http://127.0.0.1:8765/.well-known/oauth-authorization-server/amo"
ProxyPass "/.well-known/oauth-protected-resource/amo/mcp" "http://127.0.0.1:8765/.well-known/oauth-protected-resource/amo/mcp"
ProxyPassReverse "/.well-known/oauth-protected-resource/amo/mcp" "http://127.0.0.1:8765/.well-known/oauth-protected-resource/amo/mcp"
ProxyPass "/amo/" "http://127.0.0.1:8765/amo/" timeout=300
ProxyPassReverse "/amo/" "http://127.0.0.1:8765/amo/"
# Use a dedicated access log without query strings for OAuth paths.
SetEnvIf Request_URI "^/amo/" amo_sensitive
