/**
 * publish_review_reply — company-local agent tool handler (F1-DT001).
 *
 * Confirm-gated MUTATION. The agent runtime has no DB reach and no internet
 * egress, so when it approves this confirm-gated tool it queues the action in
 * the runtime ledger; the cross-boundary mutation bridge
 * (app/api/cron/approved-actions) polls the ledger and dispatches here, against
 * THIS app's DB, via the DOMAIN_DISPATCH map in ./_dispatch.ts.
 *
 * Effect: writes the approved reply to Google Business Profile via v4
 * reviews.updateReply (a natural PUT upsert) with an idempotency key, then marks
 * the gbp_review_responses row published. It executes ONLY when
 *   (a) the location's tier permits publishing,
 *   (b) the location's approval mode permits publishing, and
 *   (c) a passing content check exists for the response.
 * Any of those unmet → a 4xx result (the bridge records it as "failed" without
 * retrying as a transient error).
 *
 * Tokens: domain code never stores or logs raw OAuth tokens — it requests a
 * fresh access token (business.manage scope) from the connected-accounts lego
 * on each GBP call.
 */

import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

/** Validated, normalized tool arguments. */
interface PublishArgs {
  readonly responseId: string;
  readonly reviewId: string;
  readonly idempotencyKey: string;
}

/** Tiers whose plan includes automated review-reply publishing. */
const PUBLISH_ENABLED_TIERS: ReadonlySet<string> = new Set([
  "standard",
  "pro",
  "growth",
  "scale",
  "enterprise",
]);

/** Approval modes under which a confirmed reply may be written to Google. */
const PUBLISH_ENABLED_APPROVAL_MODES: ReadonlySet<string> = new Set([
  "auto",
  "confirm",
  "review_then_publish",
]);

const GBP_API_BASE = "https://mybusiness.googleapis.com/v4";
const BUSINESS_MANAGE_SCOPE = "https://www.googleapis.com/auth/business.manage";
const MAX_GOOGLE_ATTEMPTS = 3;

/** Carries an HTTP-ish status so the handler can map failures to a result. */
class PublishError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "PublishError";
    this.status = status;
    this.code = code;
  }
}

/** JSON success result. */
function ok(body: Record<string, unknown>): HandlerResult {
  return { status: 200, body };
}

/** Plain-text error result (bridge records `body` as the failure reason). */
function fail(status: number, message: string): HandlerResult {
  return { status, body: message };
}

/** Coerce to a trimmed non-empty string, else null. */
function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalize the flat agent-tool args. Accepts both camelCase (tool-schema
 * style) and snake_case (ledger style) keys so the handler is robust to either
 * caller shape.
 */
function parseArgs(args: Args): PublishArgs | null {
  const responseId = asNonEmptyString(args.responseId ?? args.response_id);
  const reviewId = asNonEmptyString(args.reviewId ?? args.review_id);
  const idempotencyKey = asNonEmptyString(
    args.idempotencyKey ?? args.idempotency_key,
  );
  if (!responseId || !reviewId || !idempotencyKey) return null;
  return { responseId, reviewId, idempotencyKey };
}

/** Row joining the response, its review, and its location. */
interface PublishContextRow {
  readonly response_id: string;
  readonly review_id: string;
  readonly location_id: string;
  readonly reply_text: string | null;
  readonly response_status: string | null;
  readonly stored_idempotency_key: string | null;
  readonly google_review_name: string | null;
  readonly tier: string | null;
  readonly owner_user_id: string | null;
}

/**
 * Load the response together with the parent review and location in one query.
 * Returns null when no such (response, review) pair exists.
 */
async function loadPublishContext(
  ctx: HandlerContext,
  responseId: string,
  reviewId: string,
): Promise<PublishContextRow | null> {
  const rows = await ctx.db.query<PublishContextRow>(
    `SELECT
       resp.id                 AS response_id,
       resp.review_id          AS review_id,
       resp.location_id        AS location_id,
       resp.reply_text         AS reply_text,
       resp.status             AS response_status,
       resp.idempotency_key    AS stored_idempotency_key,
       rev.google_review_name  AS google_review_name,
       loc.tier                AS tier,
       loc.owner_user_id       AS owner_user_id
     FROM gbp_review_responses resp
     JOIN gbp_reviews rev    ON rev.id = resp.review_id
     JOIN gbp_locations loc  ON loc.id = resp.location_id
     WHERE resp.id = $1::uuid AND resp.review_id = $2::uuid
     LIMIT 1`,
    responseId,
    reviewId,
  );
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Resolve the location's approval mode. Returns the mode string, or null when
 * no approval-settings row exists for the location (treated as not permitted).
 */
async function loadApprovalMode(
  ctx: HandlerContext,
  locationId: string,
): Promise<string | null> {
  const rows = await ctx.db.query<{ approval_mode: string | null }>(
    `SELECT approval_mode
       FROM gbp_approval_settings
      WHERE location_id = $1::uuid
      LIMIT 1`,
    locationId,
  );
  if (rows.length === 0) return null;
  return asNonEmptyString(rows[0].approval_mode);
}

/**
 * True iff the response has at least one content check with a passing status.
 * The claims/compliance guard must have cleared the text before any GBP write.
 */
async function hasPassingContentCheck(
  ctx: HandlerContext,
  responseId: string,
): Promise<boolean> {
  const rows = await ctx.db.query<{ passing: number }>(
    `SELECT COUNT(*)::int AS passing
       FROM gbp_content_checks
      WHERE response_id = $1::uuid AND status = 'passed'`,
    responseId,
  );
  return rows.length > 0 && Number(rows[0].passing) > 0;
}

/**
 * Request a fresh GBP access token from the connected-accounts lego for the
 * location's owner. The raw token is never persisted or logged.
 */
async function requestGoogleAccessToken(ownerUserId: string): Promise<string> {
  const base = (
    process.env.CONNECTED_ACCOUNTS_URL ||
    process.env.APP_BASE_URL ||
    process.env.NEXTAUTH_URL ||
    ""
  ).replace(/\/+$/, "");
  if (!base) {
    throw new PublishError(
      500,
      "config_error",
      "connected-accounts base URL is not configured",
    );
  }
  const serviceToken =
    process.env.CONNECTED_ACCOUNTS_SERVICE_TOKEN ||
    process.env.RUNTIME_AUTH_TOKEN ||
    "";

  let res: Response;
  try {
    res = await fetch(`${base}/api/account/connected/google/access-token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(serviceToken ? { authorization: `Bearer ${serviceToken}` } : {}),
      },
      body: JSON.stringify({ user_id: ownerUserId, scope: BUSINESS_MANAGE_SCOPE }),
    });
  } catch (e) {
    throw new PublishError(
      502,
      "token_unavailable",
      `connected-accounts token request failed: ${(e as Error).message}`,
    );
  }
  if (!res.ok) {
    throw new PublishError(
      res.status === 403 || res.status === 401 ? 403 : 502,
      "token_unavailable",
      `connected-accounts returned ${res.status} for the Google access token`,
    );
  }
  const data = (await res.json().catch(() => ({}))) as { access_token?: unknown };
  const token = asNonEmptyString(data.access_token);
  if (!token) {
    throw new PublishError(
      502,
      "token_unavailable",
      "connected-accounts did not return an access_token",
    );
  }
  return token;
}

/** Sleep helper for retry backoff. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Write the reply to Google via v4 reviews.updateReply (PUT = idempotent
 * upsert). Retries on 429/5xx with exponential backoff; the idempotency key is
 * forwarded as a request id for traceability. Returns the Google reply name.
 */
async function publishReplyToGoogle(
  accessToken: string,
  googleReviewName: string,
  replyText: string,
  idempotencyKey: string,
): Promise<string> {
  const url = `${GBP_API_BASE}/${googleReviewName}/reply`;
  let lastStatus = 0;
  let lastBody = "";

  for (let attempt = 1; attempt <= MAX_GOOGLE_ATTEMPTS; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          "x-goog-request-id": idempotencyKey,
        },
        body: JSON.stringify({ comment: replyText }),
      });
    } catch (e) {
      lastStatus = 0;
      lastBody = (e as Error).message;
      if (attempt < MAX_GOOGLE_ATTEMPTS) {
        await delay(250 * attempt);
        continue;
      }
      break;
    }

    if (res.ok) {
      const payload = (await res.json().catch(() => ({}))) as {
        name?: unknown;
      };
      return asNonEmptyString(payload.name) ?? `${googleReviewName}/reply`;
    }

    lastStatus = res.status;
    lastBody = (await res.text().catch(() => "")).slice(0, 300);

    // Retry transient failures only; 4xx (except 429) are terminal.
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < MAX_GOOGLE_ATTEMPTS) {
      await delay(250 * attempt);
      continue;
    }
    break;
  }

  const mapped = lastStatus >= 400 && lastStatus < 500 ? lastStatus : 502;
  throw new PublishError(
    mapped,
    "google_publish_failed",
    `GBP updateReply failed (status ${lastStatus || "network"})${
      lastBody ? `: ${lastBody}` : ""
    }`,
  );
}

/** Mark the response row published with the Google reply name + idempotency key. */
async function markResponsePublished(
  ctx: HandlerContext,
  responseId: string,
  googleReplyName: string,
  idempotencyKey: string,
): Promise<void> {
  await ctx.db.execute(
    `UPDATE gbp_review_responses
        SET status            = 'published',
            published_at      = NOW(),
            google_reply_name = $2,
            idempotency_key   = $3,
            updated_at        = NOW()
      WHERE id = $1::uuid`,
    responseId,
    googleReplyName,
    idempotencyKey,
  );
}

/**
 * Handle the confirm-gated `publish_review_reply` mutation.
 *
 * @param ctx  request-scoped DB + event bus supplied by the bridge route.
 * @param args flat tool arguments from the approved-action ledger.
 */
export async function handlePublishReviewReply(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const parsed = parseArgs(args);
  if (!parsed) {
    return fail(
      400,
      "publish_review_reply requires non-empty responseId, reviewId, and idempotencyKey",
    );
  }

  try {
    const context = await loadPublishContext(
      ctx,
      parsed.responseId,
      parsed.reviewId,
    );
    if (!context) {
      return fail(404, "review response not found for the given responseId/reviewId");
    }

    // Idempotency: a prior run with the SAME key already succeeded → success.
    if (context.response_status === "published") {
      if (context.stored_idempotency_key === parsed.idempotencyKey) {
        return ok({
          status: "already_published",
          response_id: context.response_id,
          review_id: context.review_id,
          idempotent: true,
        });
      }
      return fail(
        409,
        "review response already published with a different idempotency key",
      );
    }

    const replyText = asNonEmptyString(context.reply_text);
    if (!replyText) {
      return fail(422, "review response has no reply text to publish");
    }

    // Gate 1 — tier permits publishing.
    const tier = (context.tier ?? "").trim().toLowerCase();
    if (!PUBLISH_ENABLED_TIERS.has(tier)) {
      return fail(
        403,
        `location tier "${tier || "unknown"}" does not permit review-reply publishing`,
      );
    }

    // Gate 2 — approval mode permits publishing.
    const approvalMode = (
      (await loadApprovalMode(ctx, context.location_id)) ?? ""
    )
      .trim()
      .toLowerCase();
    if (!PUBLISH_ENABLED_APPROVAL_MODES.has(approvalMode)) {
      return fail(
        403,
        `approval mode "${approvalMode || "unset"}" does not permit review-reply publishing`,
      );
    }

    // Gate 3 — a passing content check must exist.
    const cleared = await hasPassingContentCheck(ctx, context.response_id);
    if (!cleared) {
      return fail(
        422,
        "no passing content check exists for this review response; publishing blocked",
      );
    }

    const googleReviewName = asNonEmptyString(context.google_review_name);
    if (!googleReviewName) {
      return fail(422, "review is missing its Google resource name; cannot publish");
    }
    const ownerUserId = asNonEmptyString(context.owner_user_id);
    if (!ownerUserId) {
      return fail(422, "location has no owner connected-account for Google auth");
    }

    const accessToken = await requestGoogleAccessToken(ownerUserId);
    const googleReplyName = await publishReplyToGoogle(
      accessToken,
      googleReviewName,
      replyText,
      parsed.idempotencyKey,
    );

    await markResponsePublished(
      ctx,
      context.response_id,
      googleReplyName,
      parsed.idempotencyKey,
    );

    await ctx.events.publish("gbp.review_reply_published", {
      response_id: context.response_id,
      review_id: context.review_id,
      location_id: context.location_id,
      google_reply_name: googleReplyName,
      idempotency_key: parsed.idempotencyKey,
    });

    return ok({
      status: "published",
      response_id: context.response_id,
      review_id: context.review_id,
      location_id: context.location_id,
      google_reply_name: googleReplyName,
    });
  } catch (e) {
    if (e instanceof PublishError) {
      await ctx.events
        .publish("gbp.review_reply_publish_failed", {
          response_id: parsed.responseId,
          review_id: parsed.reviewId,
          code: e.code,
          message: e.message,
        })
        .catch(() => {});
      return fail(e.status, e.message);
    }
    return fail(500, `internal error publishing review reply: ${(e as Error).message}`);
  }
}
