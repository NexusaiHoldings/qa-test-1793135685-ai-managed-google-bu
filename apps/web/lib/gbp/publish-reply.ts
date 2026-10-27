/**
 * Review reply publishing — Feature F1-005 (Review Response Engine).
 *
 * Takes a drafted (or owner-edited) reply through the final gate and writes it to
 * Google Business Profile via the v4 reviews.reply endpoint. The GBP client
 * carries a stable idempotency key keyed on review + comment, so a retried
 * publish never double-posts (feasibility_analysis.key_technical_risks[0]).
 *
 *   - Re-runs the Claims & Compliance Guardrail on the exact text being posted
 *     (an owner may have edited the draft since it was generated).
 *   - Records owner edits into gbp_edit_feedback so the voice profile learns.
 *   - On success flips gbp_reviews to the published state so the /reviews feed
 *     shows a "Replied" pill.
 *
 * All SQL is parameterized; all IDs are UUID.
 */

import { runClaimsGuard } from "@/lib/gbp/claims-guard";
import { GoogleBusinessClient, GbpAccessError, type GbpDb } from "@/lib/gbp/google-client";

export interface PublishReplyOptions {
  /** Owner-edited text to publish instead of the stored AI draft. */
  editedText?: string;
}

export interface PublishReplyResult {
  reviewId: string;
  /** "published" | "blocked" | "no_draft" | "not_found" | "already_replied" | "error" */
  outcome: "published" | "blocked" | "no_draft" | "not_found" | "already_replied" | "error";
  publishedText: string | null;
  strippedClaims: unknown[];
  contentCheckId: string | null;
  error: string | null;
}

interface PublishRow {
  id: string;
  location_id: string;
  user_id: string | null;
  google_location_id: string;
  google_review_id: string;
  has_owner_reply: boolean;
  draft_reply: string | null;
  reply_status: string | null;
}

async function loadForPublish(db: GbpDb, reviewId: string): Promise<PublishRow | null> {
  const rows = await db.query<PublishRow>(
    `SELECT r.id,
            r.location_id,
            l.user_id,
            l.google_location_id,
            r.google_review_id,
            r.has_owner_reply,
            r.draft_reply,
            r.reply_status
       FROM gbp_reviews r
       JOIN gbp_locations l ON l.id = r.location_id
      WHERE r.id = $1
      LIMIT 1`,
    reviewId,
  );
  return rows[0] ?? null;
}

/** Record an owner edit so the voice profile learns the owner's phrasing. */
async function recordEditFeedback(
  db: GbpDb,
  row: PublishRow,
  original: string,
  edited: string,
): Promise<void> {
  if (original.trim() === edited.trim()) return;
  try {
    await db.execute(
      `INSERT INTO gbp_edit_feedback (location_id, response_id, original, edited, delta)
       VALUES ($1, $2, $3, $4, $5)`,
      row.location_id,
      row.id,
      original,
      edited,
      `len ${original.length}->${edited.length}`,
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "gbp.publish_reply.edit_feedback_failed",
        reviewId: row.id,
        message: error instanceof Error ? error.message : "unknown error",
      }),
    );
  }
}

/**
 * Publish the reply for a review to Google Business Profile.
 *
 * The caller (the owner's approve tap, or the auto-publish path) decides WHEN;
 * this function owns the guardrail, the GBP write, the edit-feedback loop, and
 * the local state transition.
 */
export async function publishReplyForReview(
  db: GbpDb,
  reviewId: string,
  opts: PublishReplyOptions = {},
): Promise<PublishReplyResult> {
  const row = await loadForPublish(db, reviewId);
  if (!row) {
    return {
      reviewId,
      outcome: "not_found",
      publishedText: null,
      strippedClaims: [],
      contentCheckId: null,
      error: "review not found",
    };
  }

  if (row.has_owner_reply) {
    return {
      reviewId,
      outcome: "already_replied",
      publishedText: null,
      strippedClaims: [],
      contentCheckId: null,
      error: null,
    };
  }

  const candidate = (opts.editedText ?? row.draft_reply ?? "").trim();
  if (!candidate) {
    return {
      reviewId,
      outcome: "no_draft",
      publishedText: null,
      strippedClaims: [],
      contentCheckId: null,
      error: "no draft reply to publish",
    };
  }

  // Record the owner's edit (if any) before we transform the text further.
  if (opts.editedText && row.draft_reply) {
    await recordEditFeedback(db, row, row.draft_reply, opts.editedText);
  }

  // Final guardrail pass on the EXACT text we are about to post.
  const guard = await runClaimsGuard({
    locationId: row.location_id,
    contentKind: "review_reply",
    contentRef: row.id,
    originalText: candidate,
  });

  if (guard.verdict === "blocked") {
    await db.execute(
      `UPDATE gbp_reviews
          SET reply_status = 'blocked',
              draft_reply = $2,
              content_check_id = $3
        WHERE id = $1`,
      row.id,
      guard.rewrittenText,
      guard.contentCheckId,
    );
    return {
      reviewId,
      outcome: "blocked",
      publishedText: null,
      strippedClaims: guard.strippedClaims,
      contentCheckId: guard.contentCheckId,
      error: "reply blocked by claims guard — remove flagged claims and retry",
    };
  }

  const finalText = guard.rewrittenText || candidate;

  // Build the v4 review resource name: "<parent>/reviews/<reviewId>".
  const reviewName = `${row.google_location_id}/reviews/${row.google_review_id}`;
  const client = GoogleBusinessClient.forUser(db, row.user_id ?? "");

  try {
    await client.updateReviewReply(reviewName, finalText);
  } catch (error) {
    const message =
      error instanceof GbpAccessError
        ? error.message
        : error instanceof Error
          ? error.message
          : "unknown error";
    console.error(
      JSON.stringify({
        level: "error",
        event: "gbp.publish_reply.gbp_write_failed",
        reviewId: row.id,
        message,
      }),
    );
    return {
      reviewId,
      outcome: "error",
      publishedText: null,
      strippedClaims: guard.strippedClaims,
      contentCheckId: guard.contentCheckId,
      error: message,
    };
  }

  await db.execute(
    `UPDATE gbp_reviews
        SET reply_comment     = $2,
            reply_updated_at  = now(),
            has_owner_reply   = true,
            needs_reply       = false,
            reply_status      = 'published',
            draft_reply       = $2,
            content_check_id  = $3,
            published_at      = now()
      WHERE id = $1`,
    row.id,
    finalText,
    guard.contentCheckId,
  );

  // Mark the stored AI draft as the published response.
  await db.execute(
    `UPDATE gbp_review_responses
        SET comment = $2, source = 'ai_published', synced_at = now()
      WHERE review_id = $1 AND source = 'ai_draft'`,
    row.id,
    finalText,
  );

  return {
    reviewId,
    outcome: "published",
    publishedText: finalText,
    strippedClaims: guard.strippedClaims,
    contentCheckId: guard.contentCheckId,
    error: null,
  };
}
