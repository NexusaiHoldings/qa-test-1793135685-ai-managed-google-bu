import { NextResponse } from "next/server";
import { Pool } from "pg";
import { getAdminUser, writeAdminAuditLog } from "@nexus/admin-console";

type EscalationAction =
  | "approve_as_is"
  | "edit_and_publish"
  | "reply_manually_offline"
  | "mark_dismissed";

type ActionBody = {
  escalationId: string;
  action: EscalationAction;
  editedReply?: string;
  note?: string;
};

type EscalationRow = {
  id: string;
  review_id: string | null;
  location_id: string;
  reason: string | null;
  risk_level: string;
  status: string;
  created_at: Date;
  agent_rationale: string | null;
  drafted_reply: string | null;
  edited_reply: string | null;
  action: string | null;
  action_note: string | null;
  acted_at: Date | null;
  title: string | null;
  reviewer_name: string | null;
  star_rating: number | null;
  comment: string | null;
};

let pool: Pool | null = null;
function getPool(): Pool {
  if (pool) return pool;
  const connectionString: string | undefined = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  pool = new Pool({ connectionString });
  return pool;
}

export async function GET(): Promise<NextResponse> {
  const adminUser = await getAdminUser();
  if (!adminUser) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const db = getPool();
  const sql = `
    SELECT
      e.id, e.review_id, e.location_id, e.reason, e.risk_level, e.status, e.created_at,
      e.agent_rationale, e.drafted_reply, e.edited_reply, e.action, e.action_note, e.acted_at,
      l.title, r.reviewer_name, r.star_rating, r.comment
    FROM gbp_review_escalations e
    LEFT JOIN gbp_locations l ON l.id = e.location_id
    LEFT JOIN gbp_reviews r ON r.id = e.review_id
    ORDER BY
      CASE e.status WHEN 'open' THEN 0 ELSE 1 END,
      e.created_at DESC
    LIMIT 200
  `;
  const result = await db.query<EscalationRow>(sql);

  return NextResponse.json({
    escalations: result.rows.map((r) => ({
      id: r.id,
      reviewId: r.review_id,
      locationId: r.location_id,
      locationTitle: r.title ?? "Untitled location",
      reason: r.reason,
      riskLevel: r.risk_level,
      status: r.status,
      createdAt: r.created_at.toISOString(),
      agentRationale: r.agent_rationale,
      draftedReply: r.drafted_reply,
      editedReply: r.edited_reply,
      action: r.action,
      actionNote: r.action_note,
      actedAt: r.acted_at ? r.acted_at.toISOString() : null,
      reviewerName: r.reviewer_name,
      starRating: r.star_rating,
      comment: r.comment,
    })),
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  const adminUser = await getAdminUser();
  if (!adminUser) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await request.json()) as ActionBody;
  if (!body?.escalationId || !body?.action) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const db = getPool();
  const nextStatus =
    body.action === "mark_dismissed" ? "dismissed" : "resolved";

  const updateSql = `
    UPDATE gbp_review_escalations
    SET
      status = $2,
      action = $3,
      edited_reply = CASE WHEN $3 = 'edit_and_publish' THEN $4 ELSE edited_reply END,
      action_note = $5,
      acted_by = $6,
      acted_at = now(),
      external_reply_posted = CASE WHEN $3 IN ('approve_as_is','edit_and_publish') THEN true ELSE external_reply_posted END
    WHERE id = $1
    RETURNING id, location_id, status, action
  `;
  const updated = await db.query<{
    id: string;
    location_id: string;
    status: string;
    action: string;
  }>(updateSql, [
    body.escalationId,
    nextStatus,
    body.action,
    body.editedReply ?? null,
    body.note ?? null,
    adminUser.id,
  ]);

  if (updated.rowCount === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const row = updated.rows[0];

  await writeAdminAuditLog({
    actorUserId: adminUser.id,
    actorEmail: adminUser.email ?? null,
    action: `gbp.escalation.${body.action}`,
    target: `escalation:${row.id}`,
    metadata: {
      escalationId: row.id,
      locationId: row.location_id,
      status: row.status,
      note: body.note ?? null,
      editedReply: body.action === "edit_and_publish" ? body.editedReply ?? null : null,
    },
  });

  return NextResponse.json({ ok: true, escalationId: row.id, status: row.status, action: row.action });
}
