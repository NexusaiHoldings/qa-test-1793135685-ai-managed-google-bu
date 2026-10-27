/**
 * Review reply drafting — Feature F1-005 (Review Response Engine).
 *
 * Given a classified review, draft the owner's reply grounded in:
 *
 *   - the location's gbp_voice_profiles row (the retrieval-grounded "in your
 *     voice" profile seeded from the owner's own past replies), and
 *   - recalled gbp_edit_feedback (how the owner edited previous AI drafts), so
 *     the draft drifts toward their real phrasing over time.
 *
 * Negative reviews get de-escalation framing (ceo_briefing key_features[1]):
 * acknowledge, take it offline, no defensiveness, never admit legal liability.
 * Every draft passes the Claims & Compliance Guardrail before it is ever stored
 * as publishable — the technical answer to ceo_briefing.data_findings[2]
 * (FTC Act §5 / state trade-licensing advertising rules).
 *
 * human_review-tier reviews are NOT drafted for publication — they create a
 * gbp_escalations record and a @nexus/support-and-help ticket so a human owns
 * the response.
 *
 * All SQL is parameterized; all IDs are UUID. LLM calls go through the Nexus
 * gateway with a deterministic in-voice fallback so the pipeline never blocks on
 * model availability.
 */

import { handleCreateTicket, type EventBus } from "@nexus/support-and-help";
import { runClaimsGuard } from "@/lib/gbp/claims-guard";
import {
  classifyReviewRisk,
  type RiskClassification,
  type RiskTier,
} from "@/lib/gbp/review-risk";
import type { GbpDb } from "@/lib/gbp/google-client";

// Fire-and-forget event bus for the ticket handler. We don't wire analytics from
// the escalation path, so a no-op satisfies the handler's EventBus dependency.
const NOOP_EVENT_BUS: EventBus = {
  async publish(): Promise<void> {
    /* no-op — escalation telemetry is not routed from the review pipeline */
  },
};

export interface DraftReplyResult {
  reviewId: string;
  locationId: string;
  tier: RiskTier;
  /** "drafted" | "escalated" | "blocked" | "already_replied" | "not_found" */
  outcome: "drafted" | "escalated" | "blocked" | "already_replied" | "not_found";
  draftReply: string | null;
  responseId: string | null;
  contentCheckId: string | null;
  strippedClaims: unknown[];
  escalationId: string | null;
  ticketId: string | null;
  replyStatus: string;
}

interface ReviewJoinRow {
  id: string;
  location_id: string;
  user_id: string | null;
  google_review_id: string;
  reviewer_name: string | null;
  star_rating: number | null;
  comment: string | null;
  has_owner_reply: boolean;
  risk_tier: string | null;
  risk_reasons: unknown;
  tone_summary: string | null;
  profile: Record<string, unknown> | null;
  location_title: string | null;
  owner_email: string | null;
}

interface EditFeedbackRow {
  original: string | null;
  edited: string | null;
  delta: string | null;
}

interface VoiceProfileShape {
  greetingStyle?: string;
  signOffStyle?: string;
  formality?: string;
  tradeVocabulary?: string[];
  thingsNeverSaid?: string[];
  styleRules?: string[];
}

// ── data loading ──────────────────────────────────────────────────────────────

async function loadReview(db: GbpDb, reviewId: string): Promise<ReviewJoinRow | null> {
  const rows = await db.query<ReviewJoinRow>(
    `SELECT r.id,
            r.location_id,
            l.user_id,
            r.google_review_id,
            r.reviewer_name,
            r.star_rating,
            r.comment,
            r.has_owner_reply,
            r.risk_tier,
            r.risk_reasons,
            vp.tone_summary,
            vp.profile,
            l.title AS location_title,
            u.email AS owner_email
       FROM gbp_reviews r
       JOIN gbp_locations l ON l.id = r.location_id
       LEFT JOIN gbp_voice_profiles vp ON vp.location_id = r.location_id
       LEFT JOIN users u ON u.id = l.user_id
      WHERE r.id = $1
      LIMIT 1`,
    reviewId,
  );
  return rows[0] ?? null;
}

async function recallEditFeedback(db: GbpDb, locationId: string): Promise<EditFeedbackRow[]> {
  return db.query<EditFeedbackRow>(
    `SELECT original, edited, delta
       FROM gbp_edit_feedback
      WHERE location_id = $1
      ORDER BY created_at DESC
      LIMIT 5`,
    locationId,
  );
}

// ── prompt + fallback drafting ────────────────────────────────────────────────

function firstName(reviewerName: string | null): string {
  if (!reviewerName) return "";
  return reviewerName.trim().split(/\s+/)[0] ?? "";
}

/** True when the review needs de-escalation framing rather than a thank-you. */
function isNegative(starRating: number | null, tier: RiskTier): boolean {
  if (tier !== "auto") return true;
  return typeof starRating === "number" && starRating > 0 && starRating <= 3;
}

function profileOf(row: ReviewJoinRow): VoiceProfileShape {
  return (row.profile && typeof row.profile === "object" ? row.profile : {}) as VoiceProfileShape;
}

/**
 * Deterministic in-voice reply used when the gateway is unavailable. It still
 * honours the voice profile's greeting/sign-off and applies de-escalation
 * framing for negatives so the fallback is never tone-deaf.
 */
function fallbackDraft(row: ReviewJoinRow, negative: boolean): string {
  const profile = profileOf(row);
  const name = firstName(row.reviewer_name);
  const greetingLead = name ? `Hi ${name}, ` : "Hi there, ";
  const business = row.location_title ?? "our team";
  const signOff = profile.signOffStyle && /thank|team|cheers|best/i.test(profile.signOffStyle)
    ? `— the ${business} team`
    : `— ${business}`;

  if (negative) {
    return [
      `${greetingLead}thank you for taking the time to share this feedback, and I'm sorry your experience fell short of what we aim for.`,
      `That's not the standard we hold ourselves to. I'd really like to understand what happened and make it right — please reach out to us directly so we can look into it together.`,
      signOff,
    ].join(" ");
  }

  return [
    `${greetingLead}thank you so much for the kind words!`,
    `It means a lot to the whole team to hear we got it right for you. We appreciate you trusting us and look forward to helping again whenever you need us.`,
    signOff,
  ].join(" ");
}

function buildVoiceDirectives(row: ReviewJoinRow, feedback: EditFeedbackRow[]): string {
  const profile = profileOf(row);
  const parts: string[] = [];
  if (row.tone_summary) parts.push(`Voice summary: ${row.tone_summary}`);
  if (profile.greetingStyle) parts.push(`Greeting style: ${profile.greetingStyle}`);
  if (profile.signOffStyle) parts.push(`Sign-off style: ${profile.signOffStyle}`);
  if (profile.formality) parts.push(`Formality: ${profile.formality}`);
  if (profile.tradeVocabulary?.length) {
    parts.push(`Trade vocabulary to prefer: ${profile.tradeVocabulary.join(", ")}`);
  }
  if (profile.thingsNeverSaid?.length) {
    parts.push(`Never say: ${profile.thingsNeverSaid.join("; ")}`);
  }
  if (profile.styleRules?.length) {
    parts.push(`Style rules: ${profile.styleRules.join("; ")}`);
  }
  const edits = feedback
    .filter((f) => (f.edited ?? "").trim().length > 0)
    .map((f, i) => `Edit ${i + 1}: owner rewrote "${(f.original ?? "").slice(0, 160)}" → "${(f.edited ?? "").slice(0, 160)}"`);
  if (edits.length) {
    parts.push(`Learn from how the owner edited past drafts:\n${edits.join("\n")}`);
  }
  return parts.join("\n");
}

interface GatewayReply {
  reply: string;
}

function parseGatewayReply(value: unknown): GatewayReply | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const reply = typeof v.reply === "string" ? v.reply.trim() : "";
  if (!reply) return null;
  return { reply };
}

async function gatewayDraft(
  row: ReviewJoinRow,
  feedback: EditFeedbackRow[],
  negative: boolean,
): Promise<string> {
  const endpoint = process.env.NEXUS_GATEWAY_URL;
  if (!endpoint) return fallbackDraft(row, negative);

  const directives = buildVoiceDirectives(row, feedback);
  const deEscalation = negative
    ? "This is a negative review. Use de-escalation framing: acknowledge the concern sincerely, apologize for the experience WITHOUT admitting legal fault, and invite them to continue the conversation offline to make it right. Do not be defensive and do not dispute specifics publicly."
    : "This is a positive review. Thank the reviewer warmly and specifically, keep it brief, and invite them back.";

  const input = [
    directives,
    "",
    deEscalation,
    "",
    `Reviewer: ${row.reviewer_name ?? "Anonymous"}`,
    `Rating: ${row.star_rating ?? "n/a"} star`,
    `Review: ${row.comment ?? "(no written comment)"}`,
    "",
    "Write a single reply of 90 words or fewer. Do not make factual claims, guarantees, pricing promises, or comparative statements. Output only JSON of the form {\"reply\": \"...\"}.",
  ].join("\n");

  try {
    const response = await fetch(`${endpoint}/v1/structured`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.NEXUS_GATEWAY_API_KEY ?? ""}`,
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        schema: {
          type: "object",
          properties: { reply: { type: "string" } },
          required: ["reply"],
          additionalProperties: false,
        },
        prompt:
          "You draft Google review replies in the small-business owner's authentic voice. Ground every reply in the provided voice profile and past edits.",
        input,
      }),
      cache: "no-store",
    });
    if (!response.ok) return fallbackDraft(row, negative);
    const payload = (await response.json()) as { output?: unknown };
    const parsed = parseGatewayReply(payload.output);
    return parsed ? parsed.reply : fallbackDraft(row, negative);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "gbp.review_reply.gateway_failed",
        reviewId: row.id,
        message: error instanceof Error ? error.message : "unknown error",
      }),
    );
    return fallbackDraft(row, negative);
  }
}

// ── escalation (human_review tier) ────────────────────────────────────────────

async function escalateReview(
  db: GbpDb,
  row: ReviewJoinRow,
  classification: RiskClassification,
): Promise<{ escalationId: string; ticketId: string | null }> {
  const reasonLabels = classification.reasons.map((r) => r.label);
  const reasonText = reasonLabels.length
    ? reasonLabels.join("; ")
    : "Flagged for human review";

  // 1. Create (or claim the existing) escalation record.
  const escRows = await db.query<{ id: string }>(
    `INSERT INTO gbp_escalations (review_id, location_id, tier, reason, reasons, status)
     VALUES ($1, $2, 'human_review', $3, $4::jsonb, 'open')
     ON CONFLICT (review_id) DO UPDATE SET
       reason  = EXCLUDED.reason,
       reasons = EXCLUDED.reasons,
       tier    = 'human_review'
     RETURNING id`,
    row.id,
    row.location_id,
    reasonText,
    JSON.stringify(classification.reasons),
  );
  const escalationId = escRows[0]?.id ?? "";

  // 2. Open a first-line support ticket via @nexus/support-and-help.
  let ticketId: string | null = null;
  try {
    const subject = `Sensitive review needs a human reply — ${row.location_title ?? "your location"}`;
    const message = [
      `A ${row.star_rating ?? "?"}-star review from ${row.reviewer_name ?? "a customer"} was flagged for human review and was NOT auto-replied.`,
      ``,
      `Why it was escalated: ${reasonText}.`,
      ``,
      `Review text: ${row.comment ?? "(no written comment)"}`,
      ``,
      `Please draft and publish the reply yourself from the /reviews queue.`,
    ].join("\n");

    const result = await handleCreateTicket(
      { db, events: NOOP_EVENT_BUS },
      {
        user_id: row.user_id ?? undefined,
        subject,
        message,
        priority: "high",
        email: row.owner_email ?? undefined,
      },
    );
    if (result.status === 201 && typeof result.body === "object") {
      ticketId = (result.body as { ticket_id?: string }).ticket_id ?? null;
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "gbp.review_reply.ticket_failed",
        reviewId: row.id,
        message: error instanceof Error ? error.message : "unknown error",
      }),
    );
  }

  if (ticketId) {
    await db.execute(
      `UPDATE gbp_escalations SET support_ticket_id = $2 WHERE id = $1`,
      escalationId,
      ticketId,
    );
  }

  await db.execute(
    `UPDATE gbp_reviews
        SET reply_status = 'with_team',
            risk_tier    = 'human_review',
            risk_reasons = $2::jsonb,
            classified_at = now()
      WHERE id = $1`,
    row.id,
    JSON.stringify(classification.reasons),
  );

  return { escalationId, ticketId };
}

// ── store a passing draft ─────────────────────────────────────────────────────

async function storeDraft(
  db: GbpDb,
  row: ReviewJoinRow,
  text: string,
  tier: RiskTier,
): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO gbp_review_responses
       (review_id, location_id, source, comment, star_rating_context, author, used_for_voice, created_at)
     VALUES ($1, $2, 'ai_draft', $3, $4, 'agent', false, now())
     ON CONFLICT (review_id, source) WHERE review_id IS NOT NULL
     DO UPDATE SET comment = EXCLUDED.comment,
                   star_rating_context = EXCLUDED.star_rating_context,
                   synced_at = now()
     RETURNING id`,
    row.id,
    row.location_id,
    text,
    row.star_rating,
  );
  return rows[0]?.id ?? "";
}

// ── public entry point ────────────────────────────────────────────────────────

/**
 * Draft (and route) the reply for a single review.
 *
 *   - human_review → escalate (no public draft).
 *   - auto / owner_approve → draft in voice, run the claims guard, store the
 *     cleaned draft. auto drafts queue for publishing; owner_approve drafts wait
 *     for the owner's tap; a blocked guard verdict holds the draft for review.
 */
export async function draftReplyForReview(
  db: GbpDb,
  reviewId: string,
): Promise<DraftReplyResult> {
  const row = await loadReview(db, reviewId);
  if (!row) {
    return {
      reviewId,
      locationId: "",
      tier: "auto",
      outcome: "not_found",
      draftReply: null,
      responseId: null,
      contentCheckId: null,
      strippedClaims: [],
      escalationId: null,
      ticketId: null,
      replyStatus: "pending",
    };
  }

  if (row.has_owner_reply) {
    return {
      reviewId,
      locationId: row.location_id,
      tier: (row.risk_tier as RiskTier) ?? "auto",
      outcome: "already_replied",
      draftReply: null,
      responseId: null,
      contentCheckId: null,
      strippedClaims: [],
      escalationId: null,
      ticketId: null,
      replyStatus: "published",
    };
  }

  const classification = classifyReviewRisk({
    starRating: row.star_rating,
    comment: row.comment,
  });

  // Persist the tier up front so the feed reflects routing immediately.
  await db.execute(
    `UPDATE gbp_reviews
        SET risk_tier = $2, risk_reasons = $3::jsonb, classified_at = now()
      WHERE id = $1`,
    row.id,
    classification.tier,
    JSON.stringify(classification.reasons),
  );

  if (classification.tier === "human_review") {
    const { escalationId, ticketId } = await escalateReview(db, row, classification);
    return {
      reviewId: row.id,
      locationId: row.location_id,
      tier: "human_review",
      outcome: "escalated",
      draftReply: null,
      responseId: null,
      contentCheckId: null,
      strippedClaims: [],
      escalationId,
      ticketId,
      replyStatus: "with_team",
    };
  }

  const negative = isNegative(row.star_rating, classification.tier);
  const rawDraft = await gatewayDraft(row, await recallEditFeedback(db, row.location_id), negative);

  // Every generated string passes the claims guard before it is publishable.
  const guard = await runClaimsGuard({
    locationId: row.location_id,
    contentKind: "review_reply",
    contentRef: row.id,
    originalText: rawDraft,
  });

  const finalText = guard.verdict === "pass" ? guard.rewrittenText || rawDraft : guard.rewrittenText;
  const responseId = await storeDraft(db, row, finalText, classification.tier);

  const replyStatus =
    guard.verdict === "blocked"
      ? "blocked"
      : classification.tier === "auto"
        ? "auto_queued"
        : "awaiting_owner";

  await db.execute(
    `UPDATE gbp_reviews
        SET draft_reply       = $2,
            draft_response_id = $3,
            content_check_id  = $4,
            reply_status      = $5,
            drafted_at        = now()
      WHERE id = $1`,
    row.id,
    finalText,
    responseId,
    guard.contentCheckId,
    replyStatus,
  );

  return {
    reviewId: row.id,
    locationId: row.location_id,
    tier: classification.tier,
    outcome: guard.verdict === "blocked" ? "blocked" : "drafted",
    draftReply: finalText,
    responseId,
    contentCheckId: guard.contentCheckId,
    strippedClaims: guard.strippedClaims,
    escalationId: null,
    ticketId: null,
    replyStatus,
  };
}
