import Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Private, encrypted OAuth state. Raw bearer tokens are never used as record keys. */
export class AuthStore {
  private readonly db: Database.Database;
  private readonly key: Buffer;

  constructor(path: string, encryptionKey: string) {
    this.key = Buffer.from(encryptionKey, "base64");
    if (this.key.length !== 32) throw new Error("OAuth encryption key must contain 32 base64-encoded bytes");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS oauth_state (
      kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, expires INTEGER NOT NULL,
      PRIMARY KEY (kind, id)
    ); CREATE INDEX IF NOT EXISTS oauth_expiry ON oauth_state(expires);`);
    // Detect a lost/replaced encryption key at startup, before serving any grants.
    if (!this.get("metadata", "key-check")) this.put("metadata", "key-check", { ok: true }, Number.MAX_SAFE_INTEGER);
  }

  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare("SELECT value, expires FROM oauth_state WHERE kind = ? AND id = ?").get(kind, id) as { value: string; expires: number } | undefined;
    if (!row || row.expires <= Date.now()) return undefined;
    const [iv, tag, encrypted] = row.value.split(".").map((part) => Buffer.from(part, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv!);
    decipher.setAAD(Buffer.from(`${kind}:${id}`));
    decipher.setAuthTag(tag!);
    return JSON.parse(Buffer.concat([decipher.update(encrypted!), decipher.final()]).toString("utf8")) as T;
  }

  put(kind: string, id: string, value: unknown, expires: number): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`${kind}:${id}`));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    const packed = [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64")).join(".");
    this.db.prepare("INSERT INTO oauth_state(kind,id,value,expires) VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value,expires=excluded.expires").run(kind, id, packed, expires);
  }

  delete(kind: string, id: string): void {
    this.db.prepare("DELETE FROM oauth_state WHERE kind=? AND id=?").run(kind, id);
  }

  revokeConnection(id: string): boolean {
    const grant = this.get<{ token: string; revoked?: boolean; expires: number }>("grants", id);
    if (!grant) return false;
    this.put("grants", id, { ...grant, token: "", revoked: true }, grant.expires);
    return true;
  }

  transaction<T>(action: () => T): T { return this.db.transaction(action)(); }
  cleanup(): void { this.db.prepare("DELETE FROM oauth_state WHERE expires <= ?").run(Date.now()); }
  close(): void { this.db.close(); }
}
