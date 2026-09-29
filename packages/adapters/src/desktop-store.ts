import pg from "pg";
import {
  type DesktopGrants,
  type DesktopPolicy,
  type DesktopSource,
  desktopGrants,
  desktopPolicy,
  noDesktopGrants,
  persistentDesktopGrant,
} from "../../contracts/src/desktop.js";

export class DesktopStore {
  private readonly pool: pg.Pool;
  constructor(url?: string) {
    this.pool = new pg.Pool(url ? { connectionString: url } : undefined);
  }
  async start(): Promise<{ policy: DesktopPolicy; grants: DesktopGrants }> {
    const rows = await this.pool.query<{ policy: unknown; grants: unknown }>(
      "SELECT policy,grants FROM desktop_settings WHERE id=true",
    );
    const policy = desktopPolicy.parse(rows.rows[0]?.policy ?? {});
    const saved = desktopGrants.parse(rows.rows[0]?.grants ?? noDesktopGrants);
    const grants = Object.fromEntries(
      Object.entries(saved).map(([source, value]) => [
        source,
        value === persistentDesktopGrant ? persistentDesktopGrant : 0,
      ]),
    ) as DesktopGrants;
    await this.save(policy, grants, "host_start");
    return { policy, grants };
  }
  async save(policy: DesktopPolicy, grants: DesktopGrants, kind: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO desktop_settings(id,policy,grants) VALUES(true,$1,$2)
        ON CONFLICT(id) DO UPDATE SET policy=$1,grants=$2,updated_at=now()`,
        [JSON.stringify(policy), JSON.stringify(grants)],
      );
      await client.query("INSERT INTO desktop_events(kind,detail) VALUES($1,$2)", [
        kind,
        JSON.stringify({ policy, grants }),
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async audit(kind: string, source: DesktopSource | null, detail: Record<string, unknown> = {}): Promise<void> {
    await this.pool.query("INSERT INTO desktop_events(kind,source,detail) VALUES($1,$2,$3)", [
      kind,
      source,
      JSON.stringify(detail),
    ]);
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}
