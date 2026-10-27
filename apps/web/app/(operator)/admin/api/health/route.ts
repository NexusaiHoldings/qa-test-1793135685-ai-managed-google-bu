import { NextRequest, NextResponse } from "next/server";
import { getAdminUser, logAdminEvent } from "@nexus/admin-console";
import { getFleetHealth } from "@/lib/gbp/platform-health";
import { setAutomationPause } from "@/lib/gbp/automation-pause";

export async function GET(): Promise<NextResponse> {
  const admin = await getAdminUser();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const data = await getFleetHealth();
  return NextResponse.json(data);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const admin = await getAdminUser();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = (await req.json()) as {
    scope: "fleet" | "location";
    locationId?: string;
    isPaused: boolean;
    reason?: string;
  };

  const state = await setAutomationPause({
    scope: body.scope,
    locationId: body.locationId,
    isPaused: body.isPaused,
    reason: body.reason,
    pausedBy: admin.id,
  });

  await logAdminEvent({
    actorId: admin.id,
    action: "gbp.automation.pause",
    target: body.scope === "fleet" ? "fleet" : body.locationId ?? "unknown",
    details: { isPaused: body.isPaused, reason: body.reason ?? null },
  });

  return NextResponse.json({ ok: true, state });
}
