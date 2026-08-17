import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import { readCursorTokenFromStateDbPath } from "../src/main/credential-provider";

const require = createRequire(import.meta.url);

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
