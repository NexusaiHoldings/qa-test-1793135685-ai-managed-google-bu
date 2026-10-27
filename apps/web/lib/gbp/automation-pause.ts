import { Pool } from "pg";

export type PauseScope = "fleet" | "location";

export type AutomationPauseState = {
  scope: PauseScope;
  locationId: string | null;
  paused: boolean;
  reason: string | null;
  actorEmail: string | null;
  source: string;
  pausedAt: string | null;
  resumedAt: string | null;
  updatedAt: string;
};

type DbRow = {
  scope: PauseScope;
  location_id: string | null;
  paused: boolean;
  reason: string | null;
  actor_email: string | null;
  source: string;
  paused_at: Date | null;
  resumed_at: Date | null;
  updated_at: Date;
};

let pool: Pool | null = null;

function getPool(): Pool {
  if (pool) return pool;
  const connectionString: string | undefined = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  pool = new Pool({ connectionString });
  return pool;
}

function mapRow(row: DbRow): AutomationPauseState {
  return {
    scope: row.scope,
    locationId: row.location_id,
    paused: row.paused,
    reason: row.reason,
    actorEmail: row.actor_email,
    source: row.source,
    pausedAt: row.paused_at ? row.paused_at.toISOString() : null,
    resumedAt: row.resumed_at ? row.resumed_at.toISOString() : null,
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function setAutomationPause(input: {
  scope: PauseScope;
  locationId?: string | null;
  paused: boolean;
  reason?: string | null;
  actorUserId?: string | null;
  actorEmail?: string | null;
  source?: string;
}): Promise<AutomationPauseState> {
  const db: Pool = getPool();
  const locationId: string | null = input.scope === "fleet" ? null : (input.locationId ?? null);
  const source: string = input.source ?? "operator_console";
  const sql = `
    INSERT INTO gbp_automation_pauses (
      scope, location_id, paused, reason, actor_user_id, actor_email, source, paused_at, resumed_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $3 THEN now() ELSE NULL END, CASE WHEN $3 THEN NULL ELSE now() END, now())
    ON CONFLICT (scope, location_id) DO UPDATE SET
      paused = EXCLUDED.paused,
      reason = EXCLUDED.reason,
      actor_user_id = EXCLUDED.actor_user_id,
      actor_email = EXCLUDED.actor_email,
      source = EXCLUDED.source,
      paused_at = CASE
        WHEN EXCLUDED.paused = true AND gbp_automation_pauses.paused = false THEN now()
        ELSE gbp_automation_pauses.paused_at
      END,
      resumed_at = CASE
        WHEN EXCLUDED.paused = false AND gbp_automation_pauses.paused = true THEN now()
        ELSE gbp_automation_pauses.resumed_at
      END,
      updated_at = now()
    RETURNING scope, location_id, paused, reason, actor_email, source, paused_at, resumed_at, updated_at
  `;
  const result = await db.query<DbRow>(sql, [
    input.scope,
    locationId,
    input.paused,
    input.reason ?? null,
    input.actorUserId ?? null,
    input.actorEmail ?? null,
    source,
  ]);
  return mapRow(result.rows[0]);
}

export async function getAutomationPauseMap(): Promise<{
  fleetPaused: boolean;
  byLocationId: Record<string, AutomationPauseState>;
}> {
  const db: Pool = getPool();
  const result = await db.query<DbRow>(
    `SELECT scope, location_id, paused, reason, actor_email, source, paused_at, resumed_at, updated_at
     FROM gbp_automation_pauses`
  );

  const byLocationId: Record<string, AutomationPauseState> = {};
  let fleetPaused = false;

  for (const row of result.rows) {
    const state = mapRow(row);
    if (row.scope === "fleet") {
      fleetPaused = row.paused;
      continue;
    }
    if (row.location_id) {
      byLocationId[row.location_id] = state;
    }
  }

  return { fleetPaused, byLocationId };
}
