# Include INSIDE the existing mcp.coddycamp.uz TLS VirtualHost.
# Keep the existing root MCP and its discovery routes unchanged.
ProxyPreserveHost On
ProxyPass "/.well-known/oauth-authorization-server/amo" "http://127.0.0.1:@PORT@/.well-known/oauth-authorization-server/amo"
ProxyPassReverse "/.well-known/oauth-authorization-server/amo" "http://127.0.0.1:@PORT@/.well-known/oauth-authorization-server/amo"
ProxyPass "/.well-known/oauth-protected-resource/amo/mcp" "http://127.0.0.1:@PORT@/.well-known/oauth-protected-resource/amo/mcp"
ProxyPassReverse "/.well-known/oauth-protected-resource/amo/mcp" "http://127.0.0.1:@PORT@/.well-known/oauth-protected-resource/amo/mcp"
ProxyPass "/amo/" "http://127.0.0.1:@PORT@/amo/" timeout=300
ProxyPassReverse "/amo/" "http://127.0.0.1:@PORT@/amo/"
# Use a dedicated access log without query strings for OAuth paths.
SetEnvIf Request_URI "^/amo/" amo_sensitive
CustomLog /var/log/httpd/amo-mcp-access.log "%h %l %u %t \"%m %U %H\" %>s %b" env=amo_sensitive
