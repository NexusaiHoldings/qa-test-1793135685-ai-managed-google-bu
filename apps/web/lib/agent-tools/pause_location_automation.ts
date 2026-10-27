import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";
import { getPool } from "@/lib/database";

type Args = {
  locationId?: unknown;
  reason?: unknown;
  actorType?: unknown;
};

type PauseLocationRow = {
  id: string;
  account_id: string;
  automation_status: string | null;
};

const MAX_REASON_LENGTH = 1000;

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed: string = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function handlePauseLocationAutomation(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const locationId: string | null = asNonEmptyString(args.locationId);
  const reasonRaw: string | null = asNonEmptyString(args.reason);
  const actorType: string = asNonEmptyString(args.actorType) ?? "system";

  if (!locationId) {
    return {
      ok: false,
      error: "invalid_args",
      message: "locationId is required.",
    };
  }

  if (!reasonRaw) {
    return {
      ok: false,
      error: "invalid_args",
      message: "reason is required.",
    };
  }

  const reason: string = reasonRaw.slice(0, MAX_REASON_LENGTH);
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const locationResult = await client.query<PauseLocationRow>(
      `
        SELECT id, account_id, automation_status
        FROM gbp_locations
        WHERE id = $1
        FOR UPDATE
      `,
      [locationId],
    );

    if (locationResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        error: "not_found",
        message: "Location not found.",
      };
    }

    const location = locationResult.rows[0];
    const previousStatus = location.automation_status ?? "unknown";

    await client.query(
      `
        UPDATE gbp_locations
        SET automation_status = 'paused',
            updated_at = NOW()
        WHERE id = $1
      `,
      [locationId],
    );

    await client.query(
      `
        INSERT INTO gbp_api_health_events (
          id,
          account_id,
          location_id,
          provider,
          event_type,
          severity,
          summary,
          details_json,
          created_at
        ) VALUES (
          gen_random_uuid(),
          $1,
          $2,
          'gbp',
          'automation_paused',
          'warning',
          $3,
          $4::jsonb,
          NOW()
        )
      `,
      [
        location.account_id,
        location.id,
        "Location automation paused",
        JSON.stringify({
          reason,
          actorType,
          previousStatus,
          requestedByUserId: ctx?.session?.user?.id ?? null,
        }),
      ],
    );

    await client.query("COMMIT");

    return {
      ok: true,
      data: {
        locationId: location.id,
        automationStatus: "paused",
        previousStatus,
        reason,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    return {
      ok: false,
      error: "pause_failed",
      message: "Failed to pause location automation.",
      data: {
        detail: error instanceof Error ? error.message : "unknown_error",
      },
    };
  } finally {
    client.release();
  }
}
