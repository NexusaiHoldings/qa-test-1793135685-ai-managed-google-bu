/**
 * Platform-health API (Feature F1-010).
 *
 * GET  — fleet health snapshot (automation status, sync, quota, auth
 *        revocations, suspension signals, and internal-only cost figures).
 * POST — flip the automation kill switch for one location or the whole fleet;
 *        the write is audit-logged to the admin-console `admin_audit_log`.
 *
 * Auth: getAdminUser() runs FIRST — a 403 is returned before the body is parsed
 * or the DB is touched.
 */

import { NextResponse } from "next/server";
import { getAdminUser } from "@/lib/admin-auth";
import { buildDb } from "@/lib/db";
import { getFleetHealth } from "@/lib/gbp/platform-health";
import { setAutomationPause } from "@/lib/gbp/automation-pause";

export const dynamic = "force-dynamic";

const AUDIT_FALLBACK_ACTOR = "00000000-0000-0000-0000-000000000000";

type PauseBody = {
  scope?: string;
  locationId?: string;
  paused?: boolean;
  reason?: string;
};

export async function GET(): Promise<NextResponse> {
  const adminUser = await getAdminUser();
  if (!adminUser) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const health = await getFleetHealth();
  return NextResponse.json({ health });
}

export async function POST(request: Request): Promise<NextResponse> {
  const adminUser = await getAdminUser();
  if (!adminUser) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: PauseBody;
  try {
    body = (await request.json()) as PauseBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const scope = body.scope;
  if ((scope !== "fleet" && scope !== "location") || typeof body.paused !== "boolean") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }
  const locationId = (body.locationId ?? "").trim();
  if (scope === "location" && !locationId) {
    return NextResponse.json({ error: "locationId required for location scope" }, { status: 400 });
  }

  const state = await setAutomationPause({
    scope,
    locationId: scope === "location" ? locationId : null,
    paused: body.paused,
    reason: (body.reason ?? "").trim() || null,
    actorUserId: adminUser.id || null,
    actorEmail: adminUser.email ?? null,
    source: "operator_health_console",
  });

  const db = buildDb();
  await db.execute(
    `INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    adminUser.id || AUDIT_FALLBACK_ACTOR,
    state.paused ? "gbp.automation.pause" : "gbp.automation.resume",
    state.scope === "fleet" ? "gbp_fleet" : "gbp_location",
    state.scope === "fleet" ? "fleet" : state.locationId,
    JSON.stringify({
      actorEmail: adminUser.email,
      scope: state.scope,
      locationId: state.locationId,
      reason: state.reason,
      source: state.source,
    }),
  );

  return NextResponse.json({ state });
}
