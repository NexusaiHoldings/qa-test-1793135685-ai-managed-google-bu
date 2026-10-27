/**
 * /reviews — the owner's review feed (Feature F1-005, Review Response Engine).
 *
 * A timeline of review cards: the star rating as filled accent stars, a status
 * pill (Replied · Awaiting you · With our team), and — when a reply exists — the
 * reply shown as a chat bubble on a slightly elevated surface beneath the review.
 * Cards lift subtly on hover. Empty state invites patience ("we check every 30
 * minutes"); the three-card skeleton covers the DB/sync load via <Suspense>; a
 * sync error surfaces the last successful sync time rather than a bare failure.
 *
 * Server component by default. Mobile-first — the ICP is an owner-operator who
 * only ever opens the tap-to-approve queue from a phone.
 */

import type { JSX } from "react";
import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { buildDb } from "@/lib/db";
import { getSessionUser } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface FeedRow {
  id: string;
  reviewer_name: string | null;
  star_rating: number | null;
  comment: string | null;
  review_created_at: string | null;
  reply_comment: string | null;
  draft_reply: string | null;
  has_owner_reply: boolean;
  reply_status: string | null;
  risk_tier: string | null;
  location_title: string | null;
}

interface SyncStatus {
  lastError: string | null;
  lastSuccessAt: string | null;
}

type PillKind = "replied" | "awaiting" | "team";

function pillFor(row: FeedRow): { kind: PillKind; label: string } {
  if (row.has_owner_reply || row.reply_status === "published") {
    return { kind: "replied", label: "Replied" };
  }
  if (row.reply_status === "with_team" || row.risk_tier === "human_review") {
    return { kind: "team", label: "With our team" };
  }
  return { kind: "awaiting", label: "Awaiting you" };
}

function formatWhen(value: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// ── star rendering ────────────────────────────────────────────────────────────

function Stars({ rating }: { rating: number | null }): JSX.Element {
  const value = typeof rating === "number" ? Math.max(0, Math.min(5, rating)) : 0;
  return (
    <span className="rr-stars" aria-label={`${value} out of 5 stars`} role="img">
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={n <= value ? "rr-star filled" : "rr-star"} aria-hidden="true">
          ★
        </span>
      ))}
    </span>
  );
}

// ── one review card ───────────────────────────────────────────────────────────

function ReviewCard({ row }: { row: FeedRow }): JSX.Element {
  const pill = pillFor(row);
  const replyText = row.reply_comment ?? row.draft_reply ?? null;
  const replyLabel = row.has_owner_reply ? "Your reply" : "Draft reply";

  return (
    <li className="card rr-card">
      <div className="rr-card-head">
        <div>
          <Stars rating={row.star_rating} />
          <strong className="rr-name">{row.reviewer_name ?? "Anonymous"}</strong>
        </div>
        <span className={`rr-pill rr-pill-${pill.kind}`}>{pill.label}</span>
      </div>

      {row.comment ? (
        <p className="rr-comment">{row.comment}</p>
      ) : (
        <p className="muted rr-comment">(No written review — star rating only)</p>
      )}

      {replyText && (
        <div className="rr-bubble">
          <span className="muted rr-bubble-label">{replyLabel}</span>
          <p className="rr-bubble-text">{replyText}</p>
        </div>
      )}

      <div className="rr-card-foot">
        <span className="muted">
          {row.location_title ? `${row.location_title} · ` : ""}
          {formatWhen(row.review_created_at)}
        </span>
        <Link className="btn secondary rr-open" href={`/reviews/${row.id}`}>
          {pill.kind === "awaiting" ? "Review & reply" : "Open"}
        </Link>
      </div>
    </li>
  );
}

// ── empty + skeleton + error states ───────────────────────────────────────────

function EmptyState(): JSX.Element {
  return (
    <div className="empty rr-empty">
      <svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true" className="rr-empty-art">
        <circle cx="32" cy="32" r="30" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.3" />
        <path
          d="M20 26h24M20 34h16"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.5"
        />
        <path
          d="M32 12l3.1 6.3 6.9 1-5 4.9 1.2 6.8L32 29l-6.2 3.3 1.2-6.8-5-4.9 6.9-1z"
          fill="currentColor"
          opacity="0.45"
        />
      </svg>
      <p>No new reviews yet — we check every 30 minutes.</p>
      <p className="muted">
        When a customer leaves a review we draft a reply in your voice and bring it here.
      </p>
    </div>
  );
}

function SkeletonFeed(): JSX.Element {
  return (
    <ul className="rr-list" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <li key={i} className="card rr-card rr-skel">
          <div className="rr-skel-line rr-skel-stars" />
          <div className="rr-skel-line rr-skel-wide" />
          <div className="rr-skel-line rr-skel-mid" />
          <div className="rr-skel-bubble" />
        </li>
      ))}
    </ul>
  );
}

// ── data ──────────────────────────────────────────────────────────────────────

async function loadFeed(userId: string): Promise<FeedRow[]> {
  const db = buildDb();
  return db.query<FeedRow>(
    `SELECT r.id,
            r.reviewer_name,
            r.star_rating,
            r.comment,
            r.review_created_at,
            r.reply_comment,
            r.draft_reply,
            r.has_owner_reply,
            r.reply_status,
            r.risk_tier,
            l.title AS location_title
       FROM gbp_reviews r
       JOIN gbp_locations l ON l.id = r.location_id
      WHERE l.user_id = $1
      ORDER BY r.review_created_at DESC NULLS LAST, r.synced_at DESC
      LIMIT 100`,
    userId,
  );
}

async function loadSyncStatus(userId: string): Promise<SyncStatus> {
  const db = buildDb();
  const latest = await db.query<{ status: string; finished_at: string | null }>(
    `SELECT sr.status, sr.finished_at
       FROM gbp_sync_runs sr
       JOIN gbp_locations l ON l.id = sr.location_id
      WHERE l.user_id = $1
      ORDER BY sr.started_at DESC
      LIMIT 1`,
    userId,
  );
  const lastError = latest[0]?.status === "error" ? "error" : null;

  let lastSuccessAt: string | null = null;
  if (lastError) {
    const ok = await db.query<{ finished_at: string | null }>(
      `SELECT sr.finished_at
         FROM gbp_sync_runs sr
         JOIN gbp_locations l ON l.id = sr.location_id
        WHERE l.user_id = $1 AND sr.status = 'success'
        ORDER BY sr.finished_at DESC NULLS LAST
        LIMIT 1`,
      userId,
    );
    lastSuccessAt = ok[0]?.finished_at ?? null;
  }
  return { lastError, lastSuccessAt };
}

// ── feed (async — covered by Suspense skeleton) ───────────────────────────────

async function ReviewFeed({ userId }: { userId: string }): Promise<JSX.Element> {
  const [rows, sync] = await Promise.all([loadFeed(userId), loadSyncStatus(userId)]);

  return (
    <>
      {sync.lastError && (
        <div className="card rr-sync-warn">
          <strong>We couldn&rsquo;t reach Google on the last check.</strong>{" "}
          <span className="muted">
            {sync.lastSuccessAt
              ? `Last successful sync: ${formatWhen(sync.lastSuccessAt)}. We’ll keep retrying every 30 minutes.`
              : "We’ll keep retrying every 30 minutes."}
          </span>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="rr-list">
          {rows.map((row) => (
            <ReviewCard key={row.id} row={row} />
          ))}
        </ul>
      )}
    </>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

export default async function ReviewsPage(): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  return (
    <main>
      <ReviewStyles />
      <h1>Reviews</h1>
      <p>
        Every new review, with a reply drafted in your voice. Tap one to approve,
        edit, or send — sensitive reviews go straight to our team.
      </p>

      <Suspense fallback={<SkeletonFeed />}>
        <ReviewFeed userId={user.id} />
      </Suspense>
    </main>
  );
}

// ── scoped styling (globals.css is substrate-owned; we layer, never fight it) ──

function ReviewStyles(): JSX.Element {
  const css = `
    .rr-list { list-style: none; padding: 0; margin: 1.25rem 0 0; display: flex; flex-direction: column; gap: 1rem; }
    .rr-card { transition: transform 120ms ease, box-shadow 120ms ease; }
    .rr-card:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,0.10); }
    .rr-card-head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; }
    .rr-name { margin-left: 0.5rem; }
    .rr-stars { letter-spacing: 1px; }
    .rr-star { color: currentColor; opacity: 0.25; }
    .rr-star.filled { color: #f5a623; opacity: 1; }
    .rr-comment { margin: 0.6rem 0; }
    .rr-pill { font-size: 0.78rem; font-weight: 600; padding: 0.2rem 0.6rem; border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; }
    .rr-pill-replied { color: #1a7f4b; }
    .rr-pill-awaiting { color: #b06d00; }
    .rr-pill-team { color: #4a4a8a; }
    .rr-bubble { margin-top: 0.6rem; padding: 0.7rem 0.9rem; border-radius: 12px; border: 1px solid rgba(127,127,127,0.25); background: rgba(127,127,127,0.07); box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
    .rr-bubble-label { display: block; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.25rem; }
    .rr-bubble-text { margin: 0; }
    .rr-card-foot { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-top: 0.75rem; flex-wrap: wrap; }
    .rr-empty-art { display: block; margin: 0 auto 0.5rem; opacity: 0.8; }
    .rr-sync-warn { border-left: 4px solid #b06d00; margin-bottom: 1rem; }
    .rr-skel { pointer-events: none; }
    .rr-skel-line { height: 14px; border-radius: 6px; background: linear-gradient(90deg, rgba(127,127,127,0.12) 25%, rgba(127,127,127,0.22) 37%, rgba(127,127,127,0.12) 63%); background-size: 400% 100%; animation: rr-shimmer 1.3s ease-in-out infinite; margin: 0.5rem 0; }
    .rr-skel-stars { width: 120px; height: 18px; }
    .rr-skel-wide { width: 90%; }
    .rr-skel-mid { width: 60%; }
    .rr-skel-bubble { height: 52px; border-radius: 12px; margin-top: 0.75rem; background: linear-gradient(90deg, rgba(127,127,127,0.10) 25%, rgba(127,127,127,0.18) 37%, rgba(127,127,127,0.10) 63%); background-size: 400% 100%; animation: rr-shimmer 1.3s ease-in-out infinite; }
    @keyframes rr-shimmer { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }
    @media (prefers-reduced-motion: reduce) { .rr-card, .rr-skel-line, .rr-skel-bubble { transition: none; animation: none; } }
  `;
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}
