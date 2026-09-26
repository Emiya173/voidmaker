import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

export async function migrate(connectionString?: string): Promise<void> {
  const client = new pg.Client(connectionString ? { connectionString } : undefined);
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(91244013)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const directory = join(process.cwd(), "db", "migrations");
    for (const filename of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
      const existing = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [filename]);
      if (existing.rowCount) continue;
      await client.query("BEGIN");
      try {
        await client.query(await readFile(join(directory, filename), "utf8"));
        await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [filename]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(91244013)").catch(() => undefined);
    await client.end();
  }
}

if (process.argv[1]?.endsWith("migrate.ts") || process.argv[1]?.endsWith("migrate.js")) {
  await migrate(process.env.DATABASE_URL);
}
