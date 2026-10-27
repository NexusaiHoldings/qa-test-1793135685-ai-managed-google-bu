/**
 * Escalation console (Feature F1-010).
 *
 * The human-in-the-loop queue: lists gbp_review_escalations (legal threats,
 * injury/property damage, sensitive situations) with the review, the agent's
 * rationale, the drafted reply, and operator actions (approve-as-is,
 * edit-and-publish, reply-manually-offline, mark-dismissed). Every action is
 * applied by a server action that re-authenticates, writes the escalation row,
 * and records an entry in the admin-console audit log.
 *
 * Server component — redirects non-admins. The dense-but-calm layout: left
 * filter rail, escalation cards with a severity stripe on the left edge, and a
 * diff-style view for edited replies.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getAdminUser } from "@/lib/admin-auth";
import { buildDb } from "@/lib/db";

export const dynamic = "force-dynamic";

const AUDIT_FALLBACK_ACTOR = "00000000-0000-0000-0000-000000000000";
const ACTIONS = ["approve_as_is", "edit_and_publish", "reply_manually_offline", "mark_dismissed"] as const;
type EscalationAction = (typeof ACTIONS)[number];

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

function severityColor(level: string): string {
  if (level === "high") return "#b91c1c";
  if (level === "medium") return "#b45309";
  return "#6b7280";
}

function toDateLabel(value: Date | string | null): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** Word-level diff (LCS) between the agent draft and the operator's edit. */
type DiffPart = { type: "same" | "add" | "del"; text: string };
function wordDiff(before: string, after: string): DiffPart[] {
  const a = before.split(/(\s+)/);
  const b = after.split(/(\s+)/);
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const parts: DiffPart[] = [];
  let i = 0;
  let j = 0;
  const push = (type: DiffPart["type"], text: string): void => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last && last.type === type) last.text += text;
    else parts.push({ type, text });
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push("del", a[i]);
      i += 1;
    } else {
      push("add", b[j]);
      j += 1;
    }
  }
  while (i < n) {
    push("del", a[i]);
    i += 1;
  }
  while (j < m) {
    push("add", b[j]);
    j += 1;
  }
  return parts;
}

/** Re-auth, apply the chosen action to the escalation, and audit it. */
async function applyEscalationAction(formData: FormData): Promise<void> {
  "use server";
  const admin = await getAdminUser();
  if (!admin) redirect("/");

  const escalationId = String(formData.get("escalationId") ?? "").trim();
  const action = String(formData.get("action") ?? "") as EscalationAction;
  const editedReply = String(formData.get("editedReply") ?? "");
  const note = String(formData.get("note") ?? "").trim();

  if (!escalationId || !ACTIONS.includes(action)) return;
  if (action === "edit_and_publish" && !editedReply.trim()) return;

  const db = buildDb();
  const nextStatus = action === "mark_dismissed" ? "dismissed" : "resolved";
  const updated = await db.query<{ id: string; location_id: string; status: string }>(
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
     RETURNING id, location_id, status`,
    escalationId,
    nextStatus,
    action,
    editedReply || null,
    note || null,
    admin.id || null,
  );
  if (updated.length === 0) return;

  await db.execute(
    `INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    admin.id || AUDIT_FALLBACK_ACTOR,
    `gbp.escalation.${action}`,
    "gbp_escalation",
    updated[0].id,
    JSON.stringify({
      actorEmail: admin.email,
      locationId: updated[0].location_id,
      status: updated[0].status,
      note: note || null,
      editedReply: action === "edit_and_publish" ? editedReply : null,
    }),
  );

  revalidatePath("/admin/escalations");
}

type SearchParams = { status?: string; risk?: string };

export default async function EscalationsPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}): Promise<JSX.Element> {
  const admin = await getAdminUser();
  if (!admin) redirect("/");

  const statusFilter = searchParams?.status ?? "open";
  const riskFilter = searchParams?.risk ?? "all";

  const db = buildDb();
  const rows = await db.query<EscalationRow>(
    `SELECT
       e.id, e.review_id, e.location_id, e.reason, e.risk_level, e.status, e.created_at,
       e.agent_rationale, e.drafted_reply, e.edited_reply, e.action, e.action_note,
       e.acted_at, e.external_reply_posted,
       l.title, r.reviewer_name, r.star_rating, r.comment
     FROM gbp_review_escalations e
     LEFT JOIN gbp_locations l ON l.id = e.location_id
     LEFT JOIN gbp_reviews r ON r.id = e.review_id
     WHERE ($1 = 'all' OR e.status = $1)
       AND ($2 = 'all' OR e.risk_level = $2)
     ORDER BY
       CASE e.status WHEN 'open' THEN 0 ELSE 1 END,
       e.created_at DESC
     LIMIT 200`,
    statusFilter,
    riskFilter,
  );

  const openCount = rows.filter((r) => r.status === "open").length;

  const statusOptions = ["open", "resolved", "dismissed", "all"];
  const riskOptions = ["all", "high", "medium", "low"];

  return (
    <main>
      <h1>Escalations</h1>
      <p>
        Human-in-the-loop queue for sensitive GBP review situations — legal threats, injury or property
        damage, and other situations the agent routed to a human. {openCount} open.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: "1.25rem", alignItems: "start" }}>
        <aside className="card" aria-label="Filters">
          <h3>Filters</h3>
          <form method="get" style={{ display: "grid", gap: "0.75rem" }}>
            <label>
              Status
              <select name="status" defaultValue={statusFilter}>
                {statusOptions.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Risk tier
              <select name="risk" defaultValue={riskFilter}>
                {riskOptions.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit">Apply</button>
          </form>
        </aside>

        {rows.length === 0 ? (
          <div className="empty">No escalations — the agent is handling everything</div>
        ) : (
          <section style={{ display: "grid", gap: "0.9rem" }}>
            {rows.map((e) => {
              const isOpen = e.status === "open";
              const diff =
                e.drafted_reply && e.edited_reply ? wordDiff(e.drafted_reply, e.edited_reply) : null;
              return (
                <article
                  key={e.id}
                  className="card"
                  style={{ borderLeft: `6px solid ${severityColor(e.risk_level)}`, paddingLeft: "1rem" }}
                >
                  <h3 style={{ marginBottom: "0.25rem" }}>
                    {e.title ?? "Untitled location"} · {e.risk_level.toUpperCase()} ·{" "}
                    <span className="muted">{e.status}</span>
                  </h3>
                  <p className="muted" style={{ marginTop: 0 }}>
                    {e.reviewer_name ?? "Unknown reviewer"}
                    {e.star_rating ? ` · ${e.star_rating}★` : ""} · raised {toDateLabel(e.created_at)}
                  </p>

                  <p>{e.comment ?? "No review body on file."}</p>
                  <p>
                    <strong>Why escalated:</strong> {e.reason ?? "—"}
                  </p>
                  <p>
                    <strong>Agent rationale:</strong> {e.agent_rationale ?? "—"}
                  </p>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
                    <div>
                      <h4>Drafted reply</h4>
                      <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{e.drafted_reply ?? "—"}</pre>
                    </div>
                    <div>
                      <h4>{diff ? "Edited reply (diff)" : "Edited reply"}</h4>
                      {diff ? (
                        <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
                          {diff.map((part, idx) => {
                            if (part.type === "same") return <span key={idx}>{part.text}</span>;
                            if (part.type === "add")
                              return (
                                <span key={idx} style={{ background: "#dcfce7", color: "#166534" }}>
                                  {part.text}
                                </span>
                              );
                            return (
                              <span
                                key={idx}
                                style={{ background: "#fee2e2", color: "#991b1b", textDecoration: "line-through" }}
                              >
                                {part.text}
                              </span>
                            );
                          })}
                        </pre>
                      ) : (
                        <pre style={{ whiteSpace: "pre-wrap", margin: 0 }} className="muted">
                          {e.edited_reply ?? "(no edits yet)"}
                        </pre>
                      )}
                    </div>
                  </div>

                  {isOpen ? (
                    <div style={{ marginTop: "0.75rem", display: "grid", gap: "0.75rem" }}>
                      <form action={applyEscalationAction} style={{ display: "grid", gap: "0.5rem" }}>
                        <input type="hidden" name="escalationId" value={e.id} />
                        <input type="hidden" name="action" value="edit_and_publish" />
                        <label>
                          Edit &amp; publish
                          <textarea name="editedReply" rows={4} defaultValue={e.drafted_reply ?? ""} />
                        </label>
                        <input type="text" name="note" placeholder="Operator note (optional)" />
                        <button type="submit">Edit &amp; publish</button>
                      </form>

                      <div className="toolbar">
                        <form action={applyEscalationAction}>
                          <input type="hidden" name="escalationId" value={e.id} />
                          <input type="hidden" name="action" value="approve_as_is" />
                          <button type="submit">Approve as-is</button>
                        </form>
                        <form action={applyEscalationAction}>
                          <input type="hidden" name="escalationId" value={e.id} />
                          <input type="hidden" name="action" value="reply_manually_offline" />
                          <button type="submit" className="secondary">
                            Replied manually (offline)
                          </button>
                        </form>
                        <form action={applyEscalationAction}>
                          <input type="hidden" name="escalationId" value={e.id} />
                          <input type="hidden" name="action" value="mark_dismissed" />
                          <button type="submit" className="secondary">
                            Dismiss
                          </button>
                        </form>
                      </div>
                    </div>
                  ) : (
                    <p className="muted" style={{ marginTop: "0.75rem" }}>
                      {e.action ? `Resolved via ${e.action.replace(/_/g, " ")}` : "Closed"}
                      {e.acted_at ? ` · ${toDateLabel(e.acted_at)}` : ""}
                      {e.action_note ? ` · “${e.action_note}”` : ""}
                    </p>
                  )}
                </article>
              );
            })}
          </section>
        )}
      </div>
    </main>
  );
}
