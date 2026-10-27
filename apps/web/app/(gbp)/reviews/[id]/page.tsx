/**
 * /reviews/[id] — a single review (Feature F1-005, Review Response Engine).
 *
 * Shows the review, the drafted/published reply, its status, and the claims the
 * guardrail stripped before the reply became publishable. The owner can draft (if
 * not yet drafted), edit the draft, and publish — or, for human_review-tier
 * reviews, see that it was routed to the team with a support ticket.
 *
 * Server component with inline server actions (same pattern as /voice). The
 * draft/publish pipeline lives in lib/gbp/* so the page stays presentational.
 */

import type { JSX } from "react";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { buildDb } from "@/lib/db";
import { getSessionUser } from "@/lib/admin-auth";
import { draftReplyForReview } from "@/lib/gbp/review-reply";
import { publishReplyForReview } from "@/lib/gbp/publish-reply";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface DetailRow {
  id: string;
  location_id: string;
  reviewer_name: string | null;
  star_rating: number | null;
  comment: string | null;
  review_created_at: string | null;
  reply_comment: string | null;
  draft_reply: string | null;
  has_owner_reply: boolean;
  reply_status: string | null;
  risk_tier: string | null;
  risk_reasons: unknown;
  content_check_id: string | null;
  location_title: string | null;
}

interface RiskReason {
  category: string;
  label: string;
  matched: string;
}

interface StrippedClaim {
  description?: string;
  span?: string;
  ruleKind?: string;
}

interface ContentCheckRow {
  verdict: string;
  stripped_claims: unknown;
}

interface EscalationRow {
  status: string;
  reason: string | null;
  support_ticket_id: string | null;
}

// ── loaders ─────────────────────────────────────────────────────────────────

async function loadDetail(reviewId: string, userId: string): Promise<DetailRow | null> {
  const db = buildDb();
  const rows = await db.query<DetailRow>(
    `SELECT r.id,
            r.location_id,
            r.reviewer_name,
            r.star_rating,
            r.comment,
            r.review_created_at,
            r.reply_comment,
            r.draft_reply,
            r.has_owner_reply,
            r.reply_status,
            r.risk_tier,
            r.risk_reasons,
            r.content_check_id,
            l.title AS location_title
       FROM gbp_reviews r
       JOIN gbp_locations l ON l.id = r.location_id
      WHERE r.id = $1 AND l.user_id = $2
      LIMIT 1`,
    reviewId,
    userId,
  );
  return rows[0] ?? null;
}

async function loadContentCheck(row: DetailRow): Promise<StrippedClaim[]> {
  const db = buildDb();
  const rows = await db.query<ContentCheckRow>(
    row.content_check_id
      ? `SELECT verdict, stripped_claims FROM gbp_content_checks WHERE id = $1 LIMIT 1`
      : `SELECT verdict, stripped_claims FROM gbp_content_checks
          WHERE content_ref = $1 ORDER BY created_at DESC LIMIT 1`,
    row.content_check_id ?? row.id,
  );
  const raw = rows[0]?.stripped_claims;
  return Array.isArray(raw) ? (raw as StrippedClaim[]) : [];
}

async function loadEscalation(reviewId: string): Promise<EscalationRow | null> {
  const db = buildDb();
  const rows = await db.query<EscalationRow>(
    `SELECT status, reason, support_ticket_id
       FROM gbp_escalations
      WHERE review_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    reviewId,
  );
  return rows[0] ?? null;
}

// ── presentation helpers ──────────────────────────────────────────────────────

function statusLabel(row: DetailRow): string {
  if (row.has_owner_reply || row.reply_status === "published") return "Replied";
  if (row.reply_status === "with_team" || row.risk_tier === "human_review") return "With our team";
  if (row.reply_status === "blocked") return "Needs your edit";
  return "Awaiting you";
}

function riskReasons(row: DetailRow): RiskReason[] {
  return Array.isArray(row.risk_reasons) ? (row.risk_reasons as RiskReason[]) : [];
}

function Stars({ rating }: { rating: number | null }): JSX.Element {
  const value = typeof rating === "number" ? Math.max(0, Math.min(5, rating)) : 0;
  return (
    <span aria-label={`${value} out of 5 stars`} role="img" style={{ letterSpacing: 1 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          aria-hidden="true"
          style={{ color: n <= value ? "#f5a623" : "currentColor", opacity: n <= value ? 1 : 0.25 }}
        >
          ★
        </span>
      ))}
    </span>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

export default async function ReviewDetailPage({
  params,
}: {
  params: { id: string };
}): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const reviewId = params.id;
  const row = await loadDetail(reviewId, user.id);
  if (!row) notFound();

  const [claims, escalation] = await Promise.all([
    loadContentCheck(row),
    loadEscalation(reviewId),
  ]);

  const reasons = riskReasons(row);
  const status = statusLabel(row);
  const isHumanReview = row.risk_tier === "human_review";
  const canPublish = !row.has_owner_reply && !isHumanReview && Boolean(row.draft_reply);

  // ── server actions ──────────────────────────────────────────────────────────

  async function draftAction(): Promise<void> {
    "use server";
    const sessionUser = await getSessionUser();
    if (!sessionUser) redirect("/login");
    const db = buildDb();
    const owned = await db.query<{ id: string }>(
      `SELECT r.id FROM gbp_reviews r JOIN gbp_locations l ON l.id = r.location_id
        WHERE r.id = $1 AND l.user_id = $2 LIMIT 1`,
      reviewId,
      sessionUser.id,
    );
    if (!owned[0]) notFound();
    await draftReplyForReview(db, reviewId);
    revalidatePath(`/reviews/${reviewId}`);
    revalidatePath(`/reviews`);
  }

  async function publishAction(formData: FormData): Promise<void> {
    "use server";
    const sessionUser = await getSessionUser();
    if (!sessionUser) redirect("/login");
    const db = buildDb();
    const owned = await db.query<{ id: string }>(
      `SELECT r.id FROM gbp_reviews r JOIN gbp_locations l ON l.id = r.location_id
        WHERE r.id = $1 AND l.user_id = $2 LIMIT 1`,
      reviewId,
      sessionUser.id,
    );
    if (!owned[0]) notFound();
    const edited = (formData.get("reply") ?? "").toString().trim();
    await publishReplyForReview(db, reviewId, edited ? { editedText: edited } : {});
    revalidatePath(`/reviews/${reviewId}`);
    revalidatePath(`/reviews`);
  }

  const replyText = row.reply_comment ?? row.draft_reply ?? "";

  return (
    <main>
      <p>
        <Link className="btn secondary" href="/reviews">
          ← Back to reviews
        </Link>
      </p>

      <h1>Review from {row.reviewer_name ?? "Anonymous"}</h1>
      <p>
        <Stars rating={row.star_rating} />{" "}
        <span className="muted">
          {row.location_title ? `${row.location_title} · ` : ""}Status: {status}
        </span>
      </p>

      <section className="card">
        <h2>What they said</h2>
        {row.comment ? <p>{row.comment}</p> : <p className="muted">(No written review — star rating only.)</p>}
      </section>

      {reasons.length > 0 && (
        <section className="card">
          <h2>Why we routed it this way</h2>
          <p className="muted">
            {isHumanReview
              ? "This review touches a sensitive area, so our team handles the reply."
              : "We flagged these so you can check the tone before it goes live."}
          </p>
          <ul>
            {reasons.map((reason, i) => (
              <li key={`${reason.category}-${i}`}>
                {reason.label}
                {reason.matched ? <span className="muted"> — “{reason.matched}”</span> : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      {isHumanReview ? (
        <section className="card">
          <h2>With our team</h2>
          <p>
            We didn’t auto-reply to this one. It was escalated to our support team so a
            person can respond with care.
          </p>
          {escalation?.support_ticket_id && (
            <p className="muted">Support ticket opened (ref {escalation.support_ticket_id}).</p>
          )}
          {escalation?.status && <p className="muted">Escalation status: {escalation.status}.</p>}
        </section>
      ) : row.has_owner_reply ? (
        <section className="card">
          <h2>Your reply</h2>
          <div
            style={{
              padding: "0.7rem 0.9rem",
              borderRadius: 12,
              border: "1px solid rgba(127,127,127,0.25)",
              background: "rgba(127,127,127,0.07)",
            }}
          >
            <p style={{ margin: 0 }}>{replyText}</p>
          </div>
          <p className="muted">Published to Google.</p>
        </section>
      ) : row.draft_reply ? (
        <section className="card">
          <h2>Draft reply</h2>
          <p className="muted">
            {row.reply_status === "blocked"
              ? "The claims guard removed some wording. Review the draft below, then send."
              : row.reply_status === "auto_queued"
                ? "This positive review is cleared to send — review it or publish now."
                : "Edit if you like, then send. Nothing goes live until you publish."}
          </p>
          <form action={publishAction}>
            <textarea name="reply" rows={6} defaultValue={replyText} style={{ width: "100%" }} />
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
              <button type="submit" disabled={!canPublish}>
                Publish to Google
              </button>
            </div>
          </form>
        </section>
      ) : (
        <section className="card">
          <h2>No draft yet</h2>
          <p className="muted">
            We haven’t drafted a reply for this review yet. Generate one in your voice now.
          </p>
          <form action={draftAction}>
            <button type="submit">Draft a reply</button>
          </form>
        </section>
      )}

      <section className="card">
        <h2>Claims stripped by the guardrail</h2>
        {claims.length === 0 ? (
          <p className="muted">
            Nothing was stripped — the draft contained no risky claims, pricing promises, or
            guarantees.
          </p>
        ) : (
          <ul>
            {claims.map((claim, i) => (
              <li key={i}>
                {claim.description ?? "Flagged claim"}
                {claim.span ? <span className="muted"> — removed “{claim.span}”</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
