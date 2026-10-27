import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = {
  locationId?: unknown;
  reason?: unknown;
  confirm?: unknown;
  requestedBy?: unknown;
};

type LocationRecord = {
  id: string;
  organization_id: string | null;
};

const asString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed: string = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const asBoolean = (value: unknown): boolean => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized: string = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes") {
      return true;
    }
  }

  return false;
};

const isUuid = (value: string): boolean => {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
};

const getDb = (ctx: HandlerContext): {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
} | null => {
  const maybeDb: unknown = (ctx as { db?: unknown }).db;
  if (
    maybeDb &&
    typeof maybeDb === "object" &&
    "query" in maybeDb &&
    typeof (maybeDb as { query: unknown }).query === "function"
  ) {
    return maybeDb as {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    };
  }
  return null;
};

const extractOrgIdFromSession = (ctx: HandlerContext): string | null => {
  const maybeSession: unknown = (ctx as { session?: unknown }).session;
  if (!maybeSession || typeof maybeSession !== "object") {
    return null;
  }

  const sessionObj: Record<string, unknown> = maybeSession as Record<string, unknown>;

  const directOrg: string | null = asString(sessionObj.organizationId);
  if (directOrg) {
    return directOrg;
  }

  const orgIdAlt: string | null = asString(sessionObj.orgId);
  if (orgIdAlt) {
    return orgIdAlt;
  }

  const user = sessionObj.user;
  if (user && typeof user === "object") {
    const userObj: Record<string, unknown> = user as Record<string, unknown>;
    return asString(userObj.organizationId) ?? asString(userObj.orgId);
  }

  return null;
};

export async function handlePauseLocationAutomation(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const locationId: string | null = asString(args.locationId);
  const reason: string | null = asString(args.reason);
  const confirm: boolean = asBoolean(args.confirm);
  const requestedBy: string =
    asString(args.requestedBy) ??
    asString((ctx as { actor?: unknown }).actor) ??
    asString((ctx as { toolRunId?: unknown }).toolRunId) ??
    "agent";

  if (!confirm) {
    return {
      ok: false,
      error: {
        code: "confirm_required",
        message: "pause_location_automation is confirm-gated and requires confirm=true.",
      },
    };
  }

  if (!locationId || !isUuid(locationId)) {
    return {
      ok: false,
      error: {
        code: "invalid_location_id",
        message: "locationId must be a valid UUID.",
      },
    };
  }

  if (!reason) {
    return {
      ok: false,
      error: {
        code: "invalid_reason",
        message: "reason is required.",
      },
    };
  }

  const db = getDb(ctx);
  if (!db) {
    return {
      ok: false,
      error: {
        code: "db_unavailable",
        message: "Database connection is not available in handler context.",
      },
    };
  }

  const actorOrgId: string | null = extractOrgIdFromSession(ctx);

  const locationRes = await db.query(
    `
      SELECT id, organization_id
      FROM gbp_locations
      WHERE id = $1
      LIMIT 1
    `,
    [locationId],
  );

  if (locationRes.rows.length === 0) {
    return {
      ok: false,
      error: {
        code: "location_not_found",
        message: "GBP location was not found.",
      },
    };
  }

  const location: LocationRecord = {
    id: String(locationRes.rows[0].id),
    organization_id:
      locationRes.rows[0].organization_id === null
        ? null
        : String(locationRes.rows[0].organization_id),
  };

  if (actorOrgId && location.organization_id && actorOrgId !== location.organization_id) {
    return {
      ok: false,
      error: {
        code: "forbidden",
        message: "You are not allowed to pause automation for this location.",
      },
    };
  }

  await db.query(
    `
      UPDATE gbp_locations
      SET automation_status = $2,
          automation_pause_reason = $3,
          automation_paused_at = NOW(),
          automation_updated_at = NOW()
      WHERE id = $1
    `,
    [location.id, "paused", reason],
  );

  await db.query(
    `
      INSERT INTO gbp_api_health_events (
        id,
        location_id,
        event_type,
        severity,
        message,
        metadata_json,
        created_at
      )
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        $3,
        $4,
        $5::jsonb,
        NOW()
      )
    `,
    [
      location.id,
      "automation_paused",
      "warning",
      `Automation paused: ${reason}`,
      JSON.stringify({
        reason,
        requestedBy,
        source: "pause_location_automation",
      }),
    ],
  );

  return {
    ok: true,
    data: {
      locationId: location.id,
      automationStatus: "paused",
      reason,
    },
  };
}
