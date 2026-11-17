import { AuthStore } from '../dist/store.js';
const id = process.argv[2];
if (!id || !process.env.MCP_DB_PATH || !process.env.MCP_ENCRYPTION_KEY) {
  console.error('Usage: supply MCP_DB_PATH, MCP_ENCRYPTION_KEY in private environment and a connection ID argument');
  process.exit(1);
}
const store = new AuthStore(process.env.MCP_DB_PATH, process.env.MCP_ENCRYPTION_KEY);
try {
  if (!store.revokeConnection(id)) process.exitCode = 1;
  console.log(process.exitCode ? 'No active connection found' : 'Connection revoked');
} finally { store.close(); }
