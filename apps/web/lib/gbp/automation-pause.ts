import { query } from "@/lib/db";

export type AutomationPauseScope = "fleet" | "location";

export interface AutomationPauseState {
  scope: AutomationPauseScope;
  locationId: string | null;
  isPaused: boolean;
  reason: string | null;
  pausedBy: string | null;
  pausedAt: string | null;
  resumeAt: string | null;
  updatedAt: string;
}

export async function getAutomationPauseState(locationId?: string): Promise<AutomationPauseState> {
  const scope: AutomationPauseScope = locationId ? "location" : "fleet";
  const rows = await query<{
    scope: AutomationPauseScope;
    location_id: string | null;
    is_paused: boolean;
    reason: string | null;
    paused_by: string | null;
    paused_at: string | null;
    resume_at: string | null;
    updated_at: string;
  }>(
    `SELECT scope, location_id, is_paused, reason, paused_by, paused_at, resume_at, updated_at
     FROM gbp_automation_pauses
     WHERE scope = $1 AND (
       ($2::uuid IS NULL AND location_id IS NULL) OR location_id = $2::uuid
     )
     LIMIT 1`,
    [scope, locationId ?? null],
  );

  if (rows.length === 0) {
    return {
      scope,
      locationId: locationId ?? null,
      isPaused: false,
      reason: null,
      pausedBy: null,
      pausedAt: null,
      resumeAt: null,
      updatedAt: new Date().toISOString(),
    };
  }

  const row = rows[0];
  return {
    scope: row.scope,
    locationId: row.location_id,
    isPaused: row.is_paused,
    reason: row.reason,
    pausedBy: row.paused_by,
    pausedAt: row.paused_at,
    resumeAt: row.resume_at,
    updatedAt: row.updated_at,
  };
}

export async function setAutomationPause(params: {
  scope: AutomationPauseScope;
  locationId?: string;
  isPaused: boolean;
  reason?: string;
  pausedBy?: string;
  resumeAt?: string | null;
}): Promise<AutomationPauseState> {
  const locationId = params.scope === "fleet" ? null : params.locationId ?? null;
  const pausedAt = params.isPaused ? new Date().toISOString() : null;

  await query(
    `INSERT INTO gbp_automation_pauses (
      scope, location_id, is_paused, reason, paused_by, paused_at, resume_at, updated_at
    ) VALUES ($1, $2::uuid, $3, $4, $5::uuid, $6::timestamptz, $7::timestamptz, now())
    ON CONFLICT (scope, location_id)
    DO UPDATE SET
      is_paused = EXCLUDED.is_paused,
      reason = EXCLUDED.reason,
      paused_by = EXCLUDED.paused_by,
      paused_at = EXCLUDED.paused_at,
      resume_at = EXCLUDED.resume_at,
      updated_at = now()`,
    [
      params.scope,
      locationId,
      params.isPaused,
      params.reason ?? null,
      params.pausedBy ?? null,
      pausedAt,
      params.resumeAt ?? null,
    ],
  );

  return getAutomationPauseState(locationId ?? undefined);
}
