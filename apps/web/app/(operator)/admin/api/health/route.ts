import { NextResponse } from "next/server";
import { getAdminUser, writeAdminAuditLog } from "@nexus/admin-console";
import { getFleetHealth } from "@/lib/gbp/platform-health";
import { setAutomationPause } from "@/lib/gbp/automation-pause";

type PauseBody = {
  scope: "fleet" | "location";
  locationId?: string;
  paused: boolean;
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

  const body = (await request.json()) as PauseBody;
  if (!body || typeof body.paused !== "boolean" || (body.scope !== "fleet" && body.scope !== "location")) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  if (body.scope === "location" && !body.locationId) {
    return NextResponse.json({ error: "locationId required for location scope" }, { status: 400 });
  }

  const state = await setAutomationPause({
    scope: body.scope,
    locationId: body.locationId ?? null,
    paused: body.paused,
    reason: body.reason ?? null,
    actorUserId: adminUser.id,
    actorEmail: adminUser.email ?? null,
    source: "operator_health_console",
  });

  await writeAdminAuditLog({
    actorUserId: adminUser.id,
    actorEmail: adminUser.email ?? null,
    action: state.paused ? "gbp.automation.pause" : "gbp.automation.resume",
    target: state.scope === "fleet" ? "fleet" : `location:${state.locationId}`,
    metadata: {
      scope: state.scope,
      locationId: state.locationId,
      reason: state.reason,
      source: state.source,
    },
  });

  return NextResponse.json({ state });
}
