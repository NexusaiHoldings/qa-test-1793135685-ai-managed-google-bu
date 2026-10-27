/**
 * Review risk triage — Feature F1-005 (Review Response Engine).
 *
 * When gbp_reviews gains a row, we classify it into one of three tiers derived
 * directly from liability_assessor.human_in_loop_required_for:
 *
 *   - auto           routine 3–5 star, no factual dispute → safe to draft + publish
 *   - owner_approve  1–2 star with factual disputes or pricing/warranty mentions
 *                    → drafted but held for the owner's tap-to-approve
 *   - human_review   personal injury, property damage, legal threats, minors or
 *                    sensitive household situations → never auto-replied; routed
 *                    to the team with an escalation + support ticket
 *
 * Triage is deterministic (keyword/pattern + star rating) so it is cheap, fast,
 * and auditable — the "cheaper classification model" of the tech-stack spec is a
 * rules-first pass; a gateway model can refine it later without changing the
 * stored shape. All SQL is parameterized; all IDs are UUID.
 */

import type { GbpDb } from "./google-client";

export type RiskTier = "auto" | "owner_approve" | "human_review";

export interface RiskReason {
  /** Which liability vector matched (e.g. "personal_injury", "pricing_dispute"). */
  category: string;
  /** Human-readable explanation shown to the owner on the review detail page. */
  label: string;
  /** The exact phrase in the review text that tripped the rule (for the audit). */
  matched: string;
}

export interface RiskClassification {
  tier: RiskTier;
  reasons: RiskReason[];
  /** True when the review carries no comment to act on (routine star-only). */
  factualDispute: boolean;
}

interface RiskRule {
  category: string;
  label: string;
  /** Lowercased substrings / word-boundary phrases that signal this vector. */
  patterns: RegExp[];
}

// ── human_review: liability_assessor highest-severity vectors ─────────────────
// These are NEVER auto-replied regardless of star rating — a polite auto-reply to
// "your tech injured my child" is the exact FTC/liability failure mode we guard.
const HUMAN_REVIEW_RULES: RiskRule[] = [
  {
    category: "personal_injury",
    label: "Describes a personal injury or health risk",
    patterns: [
      /\binjur(?:y|ed|ies)\b/,
      /\bhospital(?:ized|ised)?\b/,
      /\bemergency room\b/,
      /\b(?:the )?er\b/,
      /\bhurt\b/,
      /\bburn(?:ed|t|s)?\b/,
      /\belectrocut(?:ed|ion)\b/,
      /\bshock(?:ed)?\b/,
      /\bcarbon monoxide\b/,
      /\bgas leak\b/,
      /\bpoison(?:ed|ing)?\b/,
      /\bcaught fire\b/,
      /\bmade (?:me|us|him|her|them) sick\b/,
    ],
  },
  {
    category: "property_damage",
    label: "Alleges property damage",
    patterns: [
      /\bflood(?:ed|ing)?\b/,
      /\bwater damage\b/,
      /\bruin(?:ed|s)?\b/,
      /\bdestroy(?:ed|s)?\b/,
      /\bceiling (?:collapsed|caved)\b/,
      /\bdamaged my\b/,
      /\bbroke my\b/,
      /\bmold\b/,
    ],
  },
  {
    category: "legal_threat",
    label: "Contains a legal threat or regulator complaint",
    patterns: [
      /\blawyer\b/,
      /\battorney\b/,
      /\bsu(?:e|ing)\b/,
      /\blawsuit\b/,
      /\blegal action\b/,
      /\bsmall claims\b/,
      /\btake (?:you|them) to court\b/,
      /\bcourt\b/,
      /\bbbb\b/,
      /\blicens(?:e|ing) board\b/,
      /\bstate board\b/,
      /\breport(?:ing|ed)? (?:you|them|this) to\b/,
    ],
  },
  {
    category: "sensitive_household",
    label: "Involves a minor or sensitive household situation",
    patterns: [
      /\bmy (?:child|kid|kids|children|baby|son|daughter|toddler|infant)\b/,
      /\belderly\b/,
      /\bdisabled\b/,
      /\bhospice\b/,
      /\bnursing (?:home|care)\b/,
      /\bwheelchair\b/,
    ],
  },
];

// ── owner_approve: factual disputes + pricing/warranty vectors ────────────────
const DISPUTE_RULES: RiskRule[] = [
  {
    category: "pricing_dispute",
    label: "Disputes pricing or alleges overcharging",
    patterns: [
      /\bovercharg(?:e|ed|ing)\b/,
      /\boverpriced\b/,
      /\brip(?:[-\s]?off|ped me off)\b/,
      /\bhidden (?:fee|fees|charge|charges)\b/,
      /\bprice(?:d| gouging)?\b/,
      /\bquote(?:d)?\b/,
      /\bestimate\b/,
      /\brefund\b/,
      /\bcharged me\b/,
      /\btoo expensive\b/,
    ],
  },
  {
    category: "warranty_dispute",
    label: "Raises a warranty or guarantee issue",
    patterns: [
      /\bwarrant(?:y|ies)\b/,
      /\bguarantee(?:d)?\b/,
      /\bcame back\b/,
      /\bstill (?:broken|not working|leaking)\b/,
      /\bhad to call (?:you|them) (?:back|again)\b/,
    ],
  },
  {
    category: "factual_dispute",
    label: "Contests what happened (no-show, incomplete, or false claim)",
    patterns: [
      /\bnever (?:showed|came|called back|finished|fixed)\b/,
      /\bno[-\s]?show\b/,
      /\bdidn'?t (?:finish|fix|show|complete|call)\b/,
      /\bincomplete\b/,
      /\bunfinished\b/,
      /\bnot (?:true|accurate)\b/,
      /\blied\b/,
      /\bfraud\b/,
      /\bscam\b/,
    ],
  },
];

/** Normalise the comment for matching (lowercase, collapse whitespace). */
function normalizeComment(comment: string | null | undefined): string {
  return (comment ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Collect every rule in a set that matches, with the exact phrase hit. */
function matchRules(text: string, rules: RiskRule[]): RiskReason[] {
  const reasons: RiskReason[] = [];
  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      const hit = pattern.exec(text);
      if (hit) {
        reasons.push({ category: rule.category, label: rule.label, matched: hit[0] });
        break; // one hit per rule is enough to flag the vector
      }
    }
  }
  return reasons;
}

export interface ReviewForRisk {
  starRating: number | null;
  comment: string | null;
}

/**
 * Classify a single review into its risk tier. Pure + synchronous so it can run
 * inside sync, inside a cron poll, or in a unit test with zero I/O.
 */
export function classifyReviewRisk(review: ReviewForRisk): RiskClassification {
  const text = normalizeComment(review.comment);
  const star = typeof review.starRating === "number" ? review.starRating : 0;

  // 1. Highest-severity vectors win regardless of the star rating.
  const humanReasons = matchRules(text, HUMAN_REVIEW_RULES);
  if (humanReasons.length > 0) {
    return { tier: "human_review", reasons: humanReasons, factualDispute: true };
  }

  // 2. Factual / pricing / warranty disputes → the owner approves before we post.
  const disputeReasons = matchRules(text, DISPUTE_RULES);
  const lowStar = star > 0 && star <= 2;
  if (disputeReasons.length > 0 || lowStar) {
    const reasons = [...disputeReasons];
    if (lowStar && disputeReasons.length === 0) {
      reasons.push({
        category: "low_rating",
        label: "Low star rating — owner reviews the tone before publishing",
        matched: `${star}-star`,
      });
    }
    return { tier: "owner_approve", reasons, factualDispute: disputeReasons.length > 0 };
  }

  // 3. Routine positive/neutral review → safe to draft and auto-publish.
  return { tier: "auto", reasons: [], factualDispute: false };
}

/** Map a tier to the reply_status the feed renders a pill from. */
export function initialReplyStatusForTier(tier: RiskTier): string {
  switch (tier) {
    case "auto":
      return "auto_queued";
    case "owner_approve":
      return "awaiting_owner";
    case "human_review":
      return "with_team";
    default:
      return "pending";
  }
}

interface ReviewRow {
  id: string;
  location_id: string;
  star_rating: number | null;
  comment: string | null;
  has_owner_reply: boolean;
  risk_tier: string | null;
}

/**
 * Classify a review row by id and persist the tier + reasons + initial reply
 * status onto gbp_reviews. Idempotent: re-classifying an already-replied review
 * leaves it alone. Returns the classification (or null when the row is gone).
 */
export async function classifyAndPersist(
  db: GbpDb,
  reviewId: string,
): Promise<(RiskClassification & { reviewId: string; locationId: string }) | null> {
  const rows = await db.query<ReviewRow>(
    `SELECT id, location_id, star_rating, comment, has_owner_reply, risk_tier
       FROM gbp_reviews
      WHERE id = $1
      LIMIT 1`,
    reviewId,
  );
  const row = rows[0];
  if (!row) return null;

  const classification = classifyReviewRisk({
    starRating: row.star_rating,
    comment: row.comment,
  });

  // Never clobber a review the owner has already answered.
  const replyStatus = row.has_owner_reply
    ? "published"
    : initialReplyStatusForTier(classification.tier);

  await db.execute(
    `UPDATE gbp_reviews
        SET risk_tier     = $2,
            risk_reasons  = $3::jsonb,
            reply_status  = CASE WHEN reply_status = 'published' THEN reply_status ELSE $4 END,
            classified_at = now()
      WHERE id = $1`,
    reviewId,
    classification.tier,
    JSON.stringify(classification.reasons),
    replyStatus,
  );

  return {
    ...classification,
    reviewId: row.id,
    locationId: row.location_id,
  };
}
