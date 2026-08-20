import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import initSqlJs from "sql.js";
import { readCursorCredentialFromStateDbPath, readCursorTokenFromStateDbPath } from "../src/main/credential-provider";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

test("readCursorTokenFromStateDbPath reads token from sqlite db", async () => {
  const SQL = await initSqlJs({
    locateFile: (file) => require.resolve(`sql.js/dist/${file}`)
  });
  const db = new SQL.Database();
  db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", [
    "cursorAuth/accessToken",
    JSON.stringify({ accessToken: "cursor_test_token" })
  ]);

  const dir = await mkdtemp(join(tmpdir(), "usage-pulse-test-"));
  const dbPath = join(dir, "state.vscdb");

  try {
    const binary = Buffer.from(db.export());
    await writeFile(dbPath, binary);

    const token = await readCursorTokenFromStateDbPath(dbPath);
    assert.equal(token, "cursor_test_token");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("readCursorTokenFromStateDbPath falls back to sqlite3 CLI for oversized db files", async (t) => {
  try {
    await execFileAsync("sqlite3", ["-version"]);
  } catch {
    t.skip("sqlite3 CLI not available in this environment");
    return;
  }

  const SQL = await initSqlJs({
    locateFile: (file) => require.resolve(`sql.js/dist/${file}`)
  });
  const db = new SQL.Database();
  db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", [
    "cursorAuth/accessToken",
    JSON.stringify({ accessToken: "cursor_large_db_token" })
  ]);
  // Pad well past the 150MB sql.js-fallback threshold so stat() routes this through the CLI path.
  db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", ["padding/blob", "x".repeat(160 * 1024 * 1024)]);

  const dir = await mkdtemp(join(tmpdir(), "usage-pulse-test-"));
  const dbPath = join(dir, "state.vscdb");

  try {
    const binary = Buffer.from(db.export());
    await writeFile(dbPath, binary);

    const token = await readCursorTokenFromStateDbPath(dbPath);
    assert.equal(token, "cursor_large_db_token");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// Writes one value under the Cursor access-token key and reads it back through
// the real parsing path, so these cover the shared credential/expiry parsing
// without depending on a Keychain entry or a real IDE login.
const withStateDb = async (value: string, run: (dbPath: string) => Promise<void>): Promise<void> => {
  const SQL = await initSqlJs({
    locateFile: (file) => require.resolve(`sql.js/dist/${file}`)
  });
  const db = new SQL.Database();
  db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", ["cursorAuth/accessToken", value]);

  const dir = await mkdtemp(join(tmpdir(), "usage-pulse-test-"));
  const dbPath = join(dir, "state.vscdb");

  try {
    await writeFile(dbPath, Buffer.from(db.export()));
    await run(dbPath);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
};

const makeJwt = (payload: Record<string, unknown>): string => {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(payload)}.signature`;
};

test("readCursorCredentialFromStateDbPath derives expiry from the token's own exp claim", async () => {
  const expSeconds = Math.floor(Date.parse("2026-09-01T00:00:00.000Z") / 1000);
  const jwt = makeJwt({ sub: "user", exp: expSeconds });

  await withStateDb(JSON.stringify({ accessToken: jwt }), async (dbPath) => {
    const credential = await readCursorCredentialFromStateDbPath(dbPath);
    assert.equal(credential.token, jwt);
    assert.equal(credential.expiresAt, "2026-09-01T00:00:00.000Z");
  });
});

test("readCursorCredentialFromStateDbPath prefers an explicit expiresAt over the exp claim", async () => {
  const jwt = makeJwt({ exp: Math.floor(Date.parse("2026-09-01T00:00:00.000Z") / 1000) });
  const explicitMs = Date.parse("2026-08-25T06:30:00.000Z");

  await withStateDb(
    JSON.stringify({ claudeAiOauth: { accessToken: jwt, expiresAt: explicitMs } }),
    async (dbPath) => {
      const credential = await readCursorCredentialFromStateDbPath(dbPath);
      assert.equal(credential.token, jwt);
      assert.equal(credential.expiresAt, "2026-08-25T06:30:00.000Z");
    }
  );
});

test("readCursorCredentialFromStateDbPath reports no expiry for an opaque token", async () => {
  await withStateDb(JSON.stringify({ accessToken: "opaque_token" }), async (dbPath) => {
    const credential = await readCursorCredentialFromStateDbPath(dbPath);
    assert.equal(credential.token, "opaque_token");
    assert.equal(credential.expiresAt, null);
  });
});
