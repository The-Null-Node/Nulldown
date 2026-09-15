import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const runProductionFixture = (mode: string) => {
  const result = spawnSync("bun", ["--eval", `
    import assert from "node:assert/strict";
    import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { createBunSqliteStore, applySqliteMigrations } from ${JSON.stringify(resolve("src/server/bunSqliteStore.ts"))};
    const mode = ${JSON.stringify(mode)};
    const directory = await mkdtemp(join(tmpdir(), "nulldown-production-migrations-"));
    const migrations = join(directory, "migrations");
    await mkdir(migrations);
    const files = (await readdir(${JSON.stringify(resolve("migrations"))})).filter(f => f.endsWith(".sql")).sort();
    assert.equal(files.length, 15);
    const sources = await Promise.all(files.map(f => readFile(join(${JSON.stringify(resolve("migrations"))}, f), "utf8")));
    for (let i = 0; i < files.length; i++) await writeFile(join(migrations, files[i]), sources[i]);
    let store = await createBunSqliteStore({ databasePath: join(directory, "legacy.sqlite") });
    try {
      // Build the released schema directly, with no candidate runner or ledger.
      for (const sql of sources.slice(0, 12)) store.exec(sql);
      if (mode === "partial" || mode === "rollback") {
        store.exec(sources[12].split(";")[mode === "partial" ? 0 : 2] + ";");
        store.exec(sources[13].split(";")[0] + ";");
        if (mode === "rollback") {
          store.exec("ALTER TABLE auth_cli_device_tickets DROP COLUMN credential_id;");
          store.exec("ALTER TABLE auth_cli_device_tickets ADD COLUMN credential_id BLOB;");
        }
      } else {
        let delegation = sources[12];
        if (mode === "type") delegation = delegation.replace("authoring_requested INTEGER", "authoring_requested TEXT");
        if (mode === "default") delegation = delegation.replace("DEFAULT 0", "DEFAULT 1");
        if (mode === "nullable") delegation = delegation.replace("INTEGER NOT NULL DEFAULT 0", "INTEGER DEFAULT 0");
        if (mode === "constraint") delegation = delegation.replace("DEFAULT 0", "DEFAULT 0 CHECK (authoring_requested IN (0, 1))");
        store.exec(delegation);
        for (const sql of sources.slice(13)) store.exec(mode === "recipient" ? sql.replace("encryption_public_jwk TEXT", "encryption_public_jwk BLOB") : sql);
        if (mode === "index") {
          store.exec("DROP INDEX idx_auth_cli_device_tickets_credential_id;");
          store.exec("CREATE INDEX idx_auth_cli_device_tickets_credential_id ON auth_cli_device_tickets(credential_id);");
        }
        if (mode === "missing-index") store.exec("DROP INDEX idx_auth_cli_device_tickets_credential_id;");
        if (mode === "table") {
          store.exec("ALTER TABLE auth_user_preferences RENAME TO incompatible_preferences;");
          store.exec("CREATE TABLE auth_user_preferences (wrong TEXT);");
        }
      }
      await store.prepare("INSERT INTO accounts (account_id, signing_public_jwk, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .bind("kept-account", "kept-signing-material", 1, 2).run();
      await store.prepare("INSERT INTO auth_cli_device_tickets (ticket_id,device_code_hash,user_code_hash,client_public_jwk_json,created_at,expires_at) VALUES (?,?,?,?,?,?)")
        .bind("kept-ticket", "device-hash", "user-hash", "kept-encryption-material", 1, 999999).run();
      await store.prepare("INSERT INTO search_index (id,drop_id,title) VALUES (?,?,?)")
        .bind("kept-search", "kept-drop", "Retained search title").run();
      assert.equal(await store.prepare("SELECT name FROM sqlite_schema WHERE name='nulldown_sqlite_migrations'").first(), null);
      const columnsBefore = await store.prepare("PRAGMA table_info(auth_cli_device_tickets)").all();
      await writeFile(join(migrations, "0016_pending.sql"), "CREATE TABLE pending (value TEXT); INSERT INTO pending VALUES ('still; pending');");
      let error = null;
      try { await applySqliteMigrations(store, migrations); } catch (e) { error = e.message; }
      if (!["full", "partial", "missing-index"].includes(mode)) {
        assert.match(error, /schema mismatch/);
        const failedFile = mode === "table" ? files[14] : mode === "recipient" ? files[13] : files[12];
        assert.equal(await store.prepare("SELECT name FROM nulldown_sqlite_migrations WHERE name=?").bind(failedFile).first(), null);
        assert.equal(await store.prepare("SELECT name FROM sqlite_schema WHERE name='pending'").first(), null);
        if (mode === "rollback") assert.deepEqual(await store.prepare("PRAGMA table_info(auth_cli_device_tickets)").all(), columnsBefore);
      } else {
        assert.equal(error, null);
        assert.deepEqual(await store.prepare("SELECT value FROM pending").first(), { value: "still; pending" });
        assert.equal((await store.prepare("SELECT count(*) AS total FROM nulldown_sqlite_migrations").first()).total, 16);
        assert.equal((await store.prepare("SELECT sql FROM sqlite_schema WHERE name='idx_auth_cli_device_tickets_credential_id'").first()).sql.includes("UNIQUE INDEX"), true);
        const columns = (await store.prepare("PRAGMA table_info(auth_cli_device_tickets)").all()).results;
        assert.equal(columns.find(c => c.name === "authoring_requested").dflt_value, "0");
        for (const column of ["delegate_signing_public_jwk_json", "credential_id", "credential_expires_at", "device_delegation_json"]) assert.ok(columns.find(c => c.name === column));
        for (const column of ["encryption_kid", "encryption_public_jwk"]) assert.ok((await store.prepare("PRAGMA table_info(accounts)").all()).results.find(c => c.name === column));
        for (let restart = 0; restart < 2; restart++) {
          store.close();
          store = await createBunSqliteStore({ databasePath: join(directory, "legacy.sqlite") });
          assert.deepEqual(await applySqliteMigrations(store, migrations), []);
        }
      }
      assert.equal((await store.prepare("SELECT signing_public_jwk FROM accounts WHERE account_id='kept-account'").first()).signing_public_jwk, "kept-signing-material");
      assert.equal((await store.prepare("SELECT client_public_jwk_json FROM auth_cli_device_tickets WHERE ticket_id='kept-ticket'").first()).client_public_jwk_json, "kept-encryption-material");
      assert.equal((await store.prepare("SELECT title FROM search_index WHERE id='kept-search'").first()).title, "Retained search title");
      console.log("passed");
    } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
  `], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("passed");
};

it.each(["full", "partial", "missing-index"])("adopts the actual %s pre-ledger production schema, preserving data and pending work across restarts", runProductionFixture);

it.each(["type", "default", "nullable", "constraint", "index", "table", "recipient", "rollback"])("rejects legacy schema mismatch (%s) without marking the migration or retaining partial changes", runProductionFixture);

it("applies ALTER migrations once across restart and rolls back failed files before retry", () => {
  const modulePath = resolve("src/server/bunSqliteStore.ts");
  const result = spawnSync("bun", ["--eval", `
    import { mkdtemp, writeFile, rm } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { createBunSqliteStore, applySqliteMigrations } from ${JSON.stringify(modulePath)};
    const directory = await mkdtemp(join(tmpdir(), "nulldown-migration-test-"));
    let store;
    try {
      const databasePath = join(directory, "test.sqlite");
      await writeFile(join(directory, "0001.sql"), "CREATE TABLE records (id TEXT PRIMARY KEY); INSERT INTO records VALUES ('kept');");
      await writeFile(join(directory, "0002.sql"), "ALTER TABLE records ADD COLUMN authoring_requested INTEGER NOT NULL DEFAULT 0;");
      store = await createBunSqliteStore({ databasePath });
      const first = await applySqliteMigrations(store, directory);
      store.close();
      store = await createBunSqliteStore({ databasePath });
      const second = await applySqliteMigrations(store, directory);
      await writeFile(join(directory, "0003.sql"), "ALTER TABLE records ADD COLUMN retry TEXT; INSERT INTO missing_table VALUES (1);");
      let failed = false;
      try { await applySqliteMigrations(store, directory); } catch { failed = true; }
      const ledgerAfterFailure = await store.prepare("SELECT name FROM nulldown_sqlite_migrations ORDER BY name").all();
      await writeFile(join(directory, "0003.sql"), "ALTER TABLE records ADD COLUMN retry TEXT;");
      const retry = await applySqliteMigrations(store, directory);
      const row = await store.prepare("SELECT * FROM records").first();
      console.log(JSON.stringify({ first, second, failed, ledgerAfterFailure, retry, row }));
    } finally {
      store?.close();
      await rm(directory, { recursive: true, force: true });
    }
  `], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    first: ["0001.sql", "0002.sql"],
    second: [],
    failed: true,
    ledgerAfterFailure: { results: [{ name: "0001.sql" }, { name: "0002.sql" }] },
    retry: ["0003.sql"],
    row: { id: "kept", authoring_requested: 0, retry: null },
  });
});
