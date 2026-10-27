/**
 * Automation kill-switch (Feature F1-010).
 *
 * Backs the per-location and fleet-wide pause control on /admin/health — the
 * operator's hard stop for the liability_assessor "platform-enforcement tail
 * risk". Every cron/webhook writer checks {@link isAutomationPaused} before it
 * touches the GBP API, so flipping a pause here halts autonomous replies/posts
 * for one location (scope `location`) or the whole fleet (scope `fleet`).
 *
 * State lives in `gbp_automation_pauses` (declared in
 * packages/db/company/gbp.ts). All access is parameterized raw SQL via the
 * substrate `buildDb()` adapter. Fleet rows use a fixed sentinel location id so
 * the `UNIQUE (scope, location_id)` constraint de-duplicates them — Postgres
 * treats NULLs as distinct, which would otherwise let the fleet upsert insert a
 * fresh row on every toggle.
 */

import { buildDb } from "@/lib/db";

export type PauseScope = "fleet" | "location";

/** Sentinel location id for the single fleet-wide row (no real location uses it). */
export const FLEET_LOCATION_SENTINEL = "00000000-0000-0000-0000-000000000000";

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
  paused_at: Date | string | null;
  resumed_at: Date | string | null;
  updated_at: Date | string;
};

function toIso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row: DbRow): AutomationPauseState {
  const isFleet = row.scope === "fleet";
  const rawLocation = row.location_id;
  return {
    scope: row.scope,
    locationId: isFleet || rawLocation === FLEET_LOCATION_SENTINEL ? null : rawLocation,
    paused: row.paused,
    reason: row.reason,
    actorEmail: row.actor_email,
    source: row.source,
    pausedAt: toIso(row.paused_at),
    resumedAt: toIso(row.resumed_at),
    updatedAt: toIso(row.updated_at) ?? "",
  };
}

/**
 * Create or flip a pause row (the operator kill switch). Idempotent per
 * (scope, location): a second call with the same scope just updates in place.
 * `paused_at` / `resumed_at` only advance on an actual edge transition so the
 * audit timestamps stay meaningful.
 */
export async function setAutomationPause(input: {
  scope: PauseScope;
  locationId?: string | null;
  paused: boolean;
  reason?: string | null;
  actorUserId?: string | null;
  actorEmail?: string | null;
  source?: string;
}): Promise<AutomationPauseState> {
  const db = buildDb();
  const locationId: string =
    input.scope === "fleet"
      ? FLEET_LOCATION_SENTINEL
      : (input.locationId ?? "").trim();

  if (input.scope === "location" && !locationId) {
    throw new Error("locationId is required for location-scoped pauses");
  }

  const source: string = input.source ?? "operator_console";
  const sql = `
    INSERT INTO gbp_automation_pauses (
      scope, location_id, paused, reason, actor_user_id, actor_email, source,
      paused_at, resumed_at, updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      CASE WHEN $3 THEN now() ELSE NULL END,
      CASE WHEN $3 THEN NULL ELSE now() END,
      now()
    )
    ON CONFLICT (scope, location_id) DO UPDATE SET
      paused        = EXCLUDED.paused,
      reason        = EXCLUDED.reason,
      actor_user_id = EXCLUDED.actor_user_id,
      actor_email   = EXCLUDED.actor_email,
      source        = EXCLUDED.source,
      paused_at     = CASE
        WHEN EXCLUDED.paused = true AND gbp_automation_pauses.paused = false THEN now()
        ELSE gbp_automation_pauses.paused_at
      END,
      resumed_at    = CASE
        WHEN EXCLUDED.paused = false AND gbp_automation_pauses.paused = true THEN now()
        ELSE gbp_automation_pauses.resumed_at
      END,
      updated_at    = now()
    RETURNING scope, location_id, paused, reason, actor_email, source,
              paused_at, resumed_at, updated_at
  `;
  const rows = await db.query<DbRow>(
    sql,
    input.scope,
    locationId,
    input.paused,
    input.reason ?? null,
    input.actorUserId ?? null,
    input.actorEmail ?? null,
    source,
  );
  return mapRow(rows[0]);
}

/**
 * Snapshot of every pause row, shaped for fast lookup: the fleet flag plus a
 * per-location map. Callers combine them — a location is effectively paused if
 * the fleet switch OR its own switch is on.
 */
export async function getAutomationPauseMap(): Promise<{
  fleetPaused: boolean;
  fleet: AutomationPauseState | null;
  byLocationId: Record<string, AutomationPauseState>;
}> {
  const db = buildDb();
  const rows = await db.query<DbRow>(
    `SELECT scope, location_id, paused, reason, actor_email, source,
            paused_at, resumed_at, updated_at
     FROM gbp_automation_pauses`,
  );

  const byLocationId: Record<string, AutomationPauseState> = {};
  let fleet: AutomationPauseState | null = null;

  for (const row of rows) {
    const state = mapRow(row);
    if (row.scope === "fleet") {
      fleet = state;
      continue;
    }
    if (row.location_id && row.location_id !== FLEET_LOCATION_SENTINEL) {
      byLocationId[row.location_id] = state;
    }
  }

  return { fleetPaused: Boolean(fleet?.paused), fleet, byLocationId };
}

/** True if automation is halted for a location (its own switch or the fleet switch). */
export async function isAutomationPaused(locationId: string): Promise<boolean> {
  const { fleetPaused, byLocationId } = await getAutomationPauseMap();
  if (fleetPaused) return true;
  return Boolean(byLocationId[locationId]?.paused);
}
