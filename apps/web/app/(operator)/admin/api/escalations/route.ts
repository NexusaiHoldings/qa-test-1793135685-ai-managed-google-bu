import { NextRequest, NextResponse } from "next/server";
import { getAdminUser, logAdminEvent } from "@nexus/admin-console";
import { query } from "@/lib/db";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const admin = await getAdminUser();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const severity = searchParams.get("severity");
  const action = searchParams.get("action");
  const locationId = searchParams.get("locationId");

  const rows = await query(
    `SELECT id, severity, category, action, agent_rationale, drafted_reply, edited_reply, created_at, location_id
     FROM gbp_escalations
     WHERE ($1::text IS NULL OR severity = $1)
       AND ($2::text IS NULL OR action = $2)
       AND ($3::uuid IS NULL OR location_id = $3::uuid)
     ORDER BY created_at DESC
     LIMIT 200`,
    [severity, action, locationId],
  );

  return NextResponse.json({ items: rows });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const admin = await getAdminUser();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = (await req.json()) as {
    escalationId: string;
    action: "approve-as-is" | "edit-and-publish" | "reply-manually-offline" | "mark-dismissed";
    editedReply?: string;
    note?: string;
  };

  const nextAction =
    body.action === "approve-as-is"
      ? "approved"
      : body.action === "edit-and-publish"
        ? "edited_published"
        : body.action === "reply-manually-offline"
          ? "manual_offline"
          : "dismissed";

  await query(
    `UPDATE gbp_escalations
     SET action = $2,
         edited_reply = COALESCE($3, edited_reply),
         action_note = $4,
         action_taken_by = $5::uuid,
         action_taken_at = now(),
         updated_at = now()
     WHERE id = $1::uuid`,
    [body.escalationId, nextAction, body.editedReply ?? null, body.note ?? null, admin.id],
  );

  await logAdminEvent({
    actorId: admin.id,
    action: "gbp.escalation.action",
    target: body.escalationId,
    details: { action: body.action },
  });

  return NextResponse.json({ ok: true });
}
