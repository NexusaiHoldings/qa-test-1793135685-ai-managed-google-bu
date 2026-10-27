/**
 * pause_location_automation — company-local agent tool handler (F1-DT003).
 *
 * Confirm-gated MUTATION. The agent runtime has no DB reach, so when it approves
 * this confirm-gated tool it queues the action in the runtime ledger; the
 * cross-boundary mutation bridge (app/api/cron/approved-actions) polls the
 * ledger and dispatches here, against THIS app's DB, via the DOMAIN_DISPATCH map
 * in ./_dispatch.ts.
 *
 * Effect: flips gbp_locations.automation_status to "paused" (recording the
 * reason + paused_at) and writes a gbp_api_health_events telemetry row so the
 * admin console can surface that automation stopped for the location. It is
 * invoked when the google-client circuit breaker trips (repeated GBP API
 * failures / quota exhaustion) or when an operator explicitly requests a pause.
 *
 * Idempotent: a location already paused is reported back as such without a
 * second health event, so a retried ledger dispatch never double-writes.
 */

import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

/** Validated, normalized tool arguments. */
interface PauseArgs {
  /** Target GBP location (UUID). */
  readonly locationId: string;
  /** Free-form reason recorded on the location + health event. */
  readonly reason: string;
  /** Who/what requested the pause — operator id, "circuit_breaker", "agent". */
  readonly requestedBy: string;
  /** Confirm gate — must be true for the mutation to run. */
  readonly confirm: boolean;
}

/** A GBP location row (narrowed to the fields this handler needs). */
interface LocationRow {
  readonly id: string;
  readonly automation_status: string | null;
}

const PAUSED_STATUS = "paused";

/** JSON success result (bridge records `body` as the success payload). */
function ok(body: Record<string, unknown>): HandlerResult {
  return { status: 200, body };
}

/** Plain-text error result (bridge records `body` as the failure reason). */
function fail(status: number, message: string): HandlerResult {
  return { status, body: message };
}

/** Coerce to a trimmed non-empty string, else null. */
function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Coerce a loosely-typed flag (boolean, or "true"/"1"/"yes") to boolean. */
function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }
  return false;
}

/** RFC-4122 UUID check — all company ids are UUID, never integers. */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/**
 * Normalize the flat agent-tool args. Accepts both camelCase (tool-schema
 * style) and snake_case (ledger style) keys so the handler is robust to either
 * caller shape. Returns null when a required field is missing/invalid.
 */
function parseArgs(args: Args): PauseArgs | null {
  const locationId = asNonEmptyString(args.locationId ?? args.location_id);
  const reason = asNonEmptyString(args.reason);
  if (!locationId || !isUuid(locationId) || !reason) return null;

  const requestedBy =
    asNonEmptyString(args.requestedBy ?? args.requested_by) ?? "agent";
  const confirm = asBoolean(args.confirm);

  return { locationId, reason, requestedBy, confirm };
}

/**
 * Handle the confirm-gated `pause_location_automation` mutation.
 *
 * @param ctx  request-scoped DB + event bus supplied by the bridge route.
 * @param args flat tool arguments from the approved-action ledger.
 */
export async function handlePauseLocationAutomation(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const parsed = parseArgs(args);
  if (!parsed) {
    return fail(
      400,
      "pause_location_automation requires a valid location UUID and a non-empty reason",
    );
  }

  // Confirm gate — the cross-boundary bridge only forwards an approved action,
  // but the mutation still refuses to run unless confirm is explicitly set.
  if (!parsed.confirm) {
    return fail(
      422,
      "pause_location_automation is confirm-gated and requires confirm=true",
    );
  }

  try {
    const rows = await ctx.db.query<LocationRow>(
      `SELECT id, automation_status
         FROM gbp_locations
        WHERE id = $1::uuid
        LIMIT 1`,
      parsed.locationId,
    );
    if (rows.length === 0) {
      return fail(404, "GBP location not found");
    }

    const location = rows[0];

    // Idempotency: already paused → report back without a duplicate event.
    if (location.automation_status === PAUSED_STATUS) {
      return ok({
        status: "already_paused",
        location_id: location.id,
        automation_status: PAUSED_STATUS,
        reason: parsed.reason,
        idempotent: true,
      });
    }

    await ctx.db.execute(
      `UPDATE gbp_locations
          SET automation_status       = $2,
              automation_pause_reason = $3,
              automation_paused_at    = NOW(),
              updated_at              = NOW()
        WHERE id = $1::uuid`,
      location.id,
      PAUSED_STATUS,
      parsed.reason,
    );

    // Telemetry row mirrors the google-client circuit-breaker health log so the
    // admin console surfaces the pause alongside API-health events.
    await ctx.db.execute(
      `INSERT INTO gbp_api_health_events
         (location_id, endpoint, method, status_code, ok, error_code,
          quota_exceeded, latency_ms, attempt, circuit_state)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      location.id,
      "automation.pause",
      "INTERNAL",
      null,
      false,
      parsed.reason.slice(0, 200),
      false,
      null,
      1,
      PAUSED_STATUS,
    );

    await ctx.events.publish("gbp.automation_paused", {
      location_id: location.id,
      reason: parsed.reason,
      requested_by: parsed.requestedBy,
      source: "pause_location_automation",
    });

    console.info(
      JSON.stringify({
        at: "gbp.pause_location_automation",
        location_id: location.id,
        requested_by: parsed.requestedBy,
      }),
    );

    return ok({
      status: "paused",
      location_id: location.id,
      automation_status: PAUSED_STATUS,
      reason: parsed.reason,
      requested_by: parsed.requestedBy,
      idempotent: false,
    });
  } catch (e) {
    const message = (e as Error).message;
    console.warn(
      JSON.stringify({
        at: "gbp.pause_location_automation.error",
        location_id: parsed.locationId,
        error: message,
      }),
    );
    return fail(500, `internal error pausing location automation: ${message}`);
  }
}
