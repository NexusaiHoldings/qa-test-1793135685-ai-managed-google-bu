/**
 * Escalation console API (Feature F1-010).
 *
 * GET  — list gbp_review_escalations (open first) with the review, the agent's
 *        rationale, the drafted reply, and any prior operator action.
 * POST — apply an operator action: approve-as-is, edit-and-publish,
 *        reply-manually-offline, or mark-dismissed. Every action is written to
 *        the admin-console `admin_audit_log`.
 *
 * Auth: getAdminUser() is called FIRST and a 403 is returned before the request
 * body is parsed or the DB is touched (per objective). Non-admins never reach
 * the query layer.
 */

import { NextResponse } from "next/server";
import { getAdminUser } from "@/lib/admin-auth";
import { buildDb } from "@/lib/db";

export const dynamic = "force-dynamic";

const ESCALATION_ACTIONS = [
  "approve_as_is",
  "edit_and_publish",
  "reply_manually_offline",
  "mark_dismissed",
] as const;
type EscalationAction = (typeof ESCALATION_ACTIONS)[number];

const AUDIT_FALLBACK_ACTOR = "00000000-0000-0000-0000-000000000000";

type ActionBody = {
  escalationId?: string;
  action?: string;
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
  created_at: Date | string;
  agent_rationale: string | null;
  drafted_reply: string | null;
  edited_reply: string | null;
  action: string | null;
  action_note: string | null;
  acted_at: Date | string | null;
  external_reply_posted: boolean;
  title: string | null;
  reviewer_name: string | null;
  star_rating: number | null;
  comment: string | null;
};

function toIso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function GET(): Promise<NextResponse> {
  const adminUser = await getAdminUser();
  if (!adminUser) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const db = buildDb();
  const rows = await db.query<EscalationRow>(`
    SELECT
      e.id, e.review_id, e.location_id, e.reason, e.risk_level, e.status, e.created_at,
      e.agent_rationale, e.drafted_reply, e.edited_reply, e.action, e.action_note,
      e.acted_at, e.external_reply_posted,
      l.title, r.reviewer_name, r.star_rating, r.comment
    FROM gbp_review_escalations e
    LEFT JOIN gbp_locations l ON l.id = e.location_id
    LEFT JOIN gbp_reviews r ON r.id = e.review_id
    ORDER BY
      CASE e.status WHEN 'open' THEN 0 ELSE 1 END,
      e.created_at DESC
    LIMIT 200
  `);

  return NextResponse.json({
    escalations: rows.map((r) => ({
      id: r.id,
      reviewId: r.review_id,
      locationId: r.location_id,
      locationTitle: r.title ?? "Untitled location",
      reason: r.reason,
      riskLevel: r.risk_level,
      status: r.status,
      createdAt: toIso(r.created_at),
      agentRationale: r.agent_rationale,
      draftedReply: r.drafted_reply,
      editedReply: r.edited_reply,
      action: r.action,
      actionNote: r.action_note,
      actedAt: toIso(r.acted_at),
      externalReplyPosted: r.external_reply_posted,
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

  let body: ActionBody;
  try {
    body = (await request.json()) as ActionBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const escalationId = (body.escalationId ?? "").trim();
  const action = body.action as EscalationAction | undefined;
  if (!escalationId || !action || !ESCALATION_ACTIONS.includes(action)) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }
  if (action === "edit_and_publish" && !(body.editedReply ?? "").trim()) {
    return NextResponse.json({ error: "edited_reply_required" }, { status: 400 });
  }

  const db = buildDb();
  const nextStatus = action === "mark_dismissed" ? "dismissed" : "resolved";

  const updated = await db.query<{ id: string; location_id: string; status: string; action: string }>(
    `UPDATE gbp_review_escalations
     SET status = $2,
         action = $3,
         edited_reply = CASE WHEN $3 = 'edit_and_publish' THEN $4 ELSE edited_reply END,
         action_note = $5,
         acted_by = $6,
         acted_at = now(),
         external_reply_posted = CASE
           WHEN $3 IN ('approve_as_is', 'edit_and_publish') THEN true
           ELSE external_reply_posted
         END
     WHERE id = $1
     RETURNING id, location_id, status, action`,
    escalationId,
    nextStatus,
    action,
    body.editedReply ?? null,
    (body.note ?? "").trim() || null,
    adminUser.id || null,
  );

  if (updated.length === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const row = updated[0];

  await db.execute(
    `INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    adminUser.id || AUDIT_FALLBACK_ACTOR,
    `gbp.escalation.${action}`,
    "gbp_escalation",
    row.id,
    JSON.stringify({
      actorEmail: adminUser.email,
      locationId: row.location_id,
      status: row.status,
      note: (body.note ?? "").trim() || null,
      editedReply: action === "edit_and_publish" ? body.editedReply ?? null : null,
    }),
  );

  return NextResponse.json({ ok: true, escalationId: row.id, status: row.status, action: row.action });
}
