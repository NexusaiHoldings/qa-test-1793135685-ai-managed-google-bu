/**
 * publish_gbp_post — company-local agent tool handler (F1-DT002).
 *
 * Confirm-gated MUTATION. The agent runtime has no DB reach and no internet
 * egress, so when it approves this confirm-gated tool it queues the action in
 * the runtime ledger; the cross-boundary mutation bridge
 * (app/api/cron/approved-actions) polls the ledger and dispatches here, against
 * THIS app's DB, via the DOMAIN_DISPATCH map in ./_dispatch.ts. The
 * gbp-weekly-publish cron is what proposes the action in the first place.
 *
 * Effect: creates the weekly local post on Google Business Profile via v4
 * localPosts.create, keyed idempotently on (location_id, week_of) so a retried
 * run (or two crons firing in the same week) never double-posts, then marks the
 * matching gbp_posts row published.
 *
 * It executes ONLY when
 *   (a) a draft post for the (location, week) exists with a non-empty summary,
 *   (b) the location has an owner connected-account for Google auth, and
 *   (c) a passing claims/compliance content check exists for the post.
 * Any of those unmet → a 4xx result (the bridge records it as "failed" without
 * retrying it as a transient error).
 *
 * Tokens: domain code never stores or logs raw OAuth tokens — it requests a
 * fresh access token (business.manage scope) from the connected-accounts lego
 * on each GBP call.
 */

import { createHash } from "node:crypto";
import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

/** Validated, normalized tool arguments. */
interface PublishArgs {
  /** Direct target when the cron queued a specific draft row. */
  readonly postId: string | null;
  /** Fallback target: (location_id, week_of) pair. */
  readonly locationId: string | null;
  /** ISO date (YYYY-MM-DD) for the Monday of the target week. */
  readonly weekOf: string | null;
  /** Caller-supplied idempotency key, else derived from (location, week). */
  readonly idempotencyKey: string | null;
}

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
 * Normalize an arbitrary date-ish value to the ISO date (YYYY-MM-DD) of the
 * Monday that starts its week. Returns null when the value isn't a valid date.
 * Using the week-start makes (location_id, week_of) a stable idempotency key no
 * matter which day inside the week the cron happens to fire.
 */
function toWeekOf(value: unknown): string | null {
  const raw = asNonEmptyString(value);
  if (!raw) return null;
  const parsed = new Date(raw.length === 10 ? `${raw}T00:00:00Z` : raw);
  if (Number.isNaN(parsed.getTime())) return null;
  // JS getUTCDay: 0=Sun..6=Sat → shift so Monday is the start of the week.
  const dow = parsed.getUTCDay();
  const mondayOffset = (dow + 6) % 7;
  const monday = new Date(parsed.getTime() - mondayOffset * 86_400_000);
  return monday.toISOString().slice(0, 10);
}

/**
 * Normalize the flat agent-tool args. Accepts both camelCase (tool-schema
 * style) and snake_case (ledger style) keys so the handler is robust to either
 * caller shape. Either `post_id` OR (`location_id` + `week_of`) must resolve.
 */
function parseArgs(args: Args): PublishArgs | null {
  const postId = asNonEmptyString(args.postId ?? args.post_id);
  const locationId = asNonEmptyString(args.locationId ?? args.location_id);
  const weekOf = toWeekOf(args.weekOf ?? args.week_of);
  const idempotencyKey = asNonEmptyString(
    args.idempotencyKey ?? args.idempotency_key,
  );
  if (!postId && !(locationId && weekOf)) return null;
  return { postId, locationId, weekOf, idempotencyKey };
}

/** A draft post joined to its location's Google linkage + owner. */
interface PostContextRow {
  readonly post_id: string;
  readonly location_id: string;
  readonly summary: string | null;
  readonly topic_type: string | null;
  readonly cta_type: string | null;
  readonly cta_url: string | null;
  readonly media_url: string | null;
  readonly state: string | null;
  readonly google_post_id: string | null;
  readonly publish_at: string | null;
  readonly google_account_id: string | null;
  readonly google_location_id: string | null;
  readonly owner_user_id: string | null;
}

/**
 * Load the draft post together with its location linkage in one query. When
 * targeting by (location, week) we select the single draft whose publish_at
 * falls inside that ISO week, newest first. Returns null when none matches.
 */
async function loadPostContext(
  ctx: HandlerContext,
  parsed: PublishArgs,
): Promise<PostContextRow | null> {
  const selectCols = `
       p.id                 AS post_id,
       p.location_id        AS location_id,
       p.summary            AS summary,
       p.topic_type         AS topic_type,
       p.cta_type           AS cta_type,
       p.cta_url            AS cta_url,
       p.media_url          AS media_url,
       p.state              AS state,
       p.google_post_id     AS google_post_id,
       p.publish_at         AS publish_at,
       loc.google_account_id  AS google_account_id,
       loc.google_location_id AS google_location_id,
       loc.user_id            AS owner_user_id`;

  if (parsed.postId) {
    const rows = await ctx.db.query<PostContextRow>(
      `SELECT ${selectCols}
         FROM gbp_posts p
         JOIN gbp_locations loc ON loc.id = p.location_id
        WHERE p.id = $1::uuid
        LIMIT 1`,
      parsed.postId,
    );
    return rows.length > 0 ? rows[0] : null;
  }

  const rows = await ctx.db.query<PostContextRow>(
    `SELECT ${selectCols}
       FROM gbp_posts p
       JOIN gbp_locations loc ON loc.id = p.location_id
      WHERE p.location_id = $1::uuid
        AND p.publish_at >= $2::date
        AND p.publish_at < ($2::date + INTERVAL '7 days')
      ORDER BY p.publish_at DESC, p.created_at DESC
      LIMIT 1`,
    parsed.locationId,
    parsed.weekOf,
  );
  return rows.length > 0 ? rows[0] : null;
}

/**
 * True iff a passing content check exists for this post. The claims/compliance
 * guard must have cleared the summary before any GBP write.
 */
async function hasPassingContentCheck(
  ctx: HandlerContext,
  locationId: string,
  postId: string,
): Promise<boolean> {
  const rows = await ctx.db.query<{ passing: number }>(
    `SELECT COUNT(*)::int AS passing
       FROM gbp_content_checks
      WHERE location_id = $1::uuid
        AND subject_type = 'post'
        AND subject_id = $2::uuid
        AND verdict = 'passed'`,
    locationId,
    postId,
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

/** Stable idempotency key for the (location, week) local post. */
function deriveIdempotencyKey(locationId: string, weekOf: string): string {
  return createHash("sha256")
    .update(`localPost:${locationId}:${weekOf}`)
    .digest("hex")
    .slice(0, 32);
}

/** Shape of the request body sent to v4 localPosts.create. */
interface LocalPostBody {
  languageCode: string;
  summary: string;
  topicType: string;
  callToAction?: { actionType: string; url?: string };
  media?: Array<{ mediaFormat: string; sourceUrl: string }>;
}

/**
 * Create the local post on Google via v4 localPosts.create. Retries on
 * 429/5xx with exponential backoff; the idempotency key is forwarded both as
 * a header and a request id so a retried POST never double-creates. Returns
 * the created post's Google resource name.
 */
async function createLocalPostOnGoogle(
  accessToken: string,
  parent: string,
  body: LocalPostBody,
  idempotencyKey: string,
): Promise<string> {
  const url = `${GBP_API_BASE}/${parent}/localPosts`;
  let lastStatus = 0;
  let lastBody = "";

  for (let attempt = 1; attempt <= MAX_GOOGLE_ATTEMPTS; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          "x-goog-request-id": idempotencyKey,
          "x-idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(body),
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
      const payload = (await res.json().catch(() => ({}))) as { name?: unknown };
      return asNonEmptyString(payload.name) ?? `${parent}/localPosts/unknown`;
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
    `GBP localPosts.create failed (status ${lastStatus || "network"})${
      lastBody ? `: ${lastBody}` : ""
    }`,
  );
}

/** Build the localPosts.create request body from the draft row. */
function buildLocalPostBody(row: PostContextRow, summary: string): LocalPostBody {
  const body: LocalPostBody = {
    languageCode: "en-US",
    summary,
    topicType: asNonEmptyString(row.topic_type) ?? "STANDARD",
  };
  const ctaType = asNonEmptyString(row.cta_type);
  if (ctaType) {
    const ctaUrl = asNonEmptyString(row.cta_url);
    body.callToAction = ctaUrl
      ? { actionType: ctaType, url: ctaUrl }
      : { actionType: ctaType };
  }
  const mediaUrl = asNonEmptyString(row.media_url);
  if (mediaUrl) {
    body.media = [{ mediaFormat: "PHOTO", sourceUrl: mediaUrl }];
  }
  return body;
}

/** Mark the post row published with its Google resource name. */
async function markPostPublished(
  ctx: HandlerContext,
  postId: string,
  googlePostName: string,
): Promise<void> {
  await ctx.db.execute(
    `UPDATE gbp_posts
        SET state          = 'published',
            published_at   = NOW(),
            google_post_id = $2
      WHERE id = $1::uuid`,
    postId,
    googlePostName,
  );
  await ctx.db.execute(
    `UPDATE gbp_locations
        SET last_post_at = NOW(),
            updated_at   = NOW()
      WHERE id = (SELECT location_id FROM gbp_posts WHERE id = $1::uuid)`,
    postId,
  );
}

/**
 * Handle the confirm-gated `publish_gbp_post` mutation.
 *
 * @param ctx  request-scoped DB + event bus supplied by the bridge route.
 * @param args flat tool arguments from the approved-action ledger.
 */
export async function handlePublishGbpPost(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const parsed = parseArgs(args);
  if (!parsed) {
    return fail(
      400,
      "publish_gbp_post requires post_id, or location_id + a valid week_of",
    );
  }

  try {
    const context = await loadPostContext(ctx, parsed);
    if (!context) {
      return fail(404, "no GBP post draft found for the given target");
    }

    const weekOf =
      parsed.weekOf ?? toWeekOf(context.publish_at) ?? "unscheduled";
    const idempotencyKey =
      parsed.idempotencyKey ??
      deriveIdempotencyKey(context.location_id, weekOf);

    // Idempotency: a prior run already published this (location, week) → ok.
    if (context.state === "published" && context.google_post_id) {
      return ok({
        status: "already_published",
        post_id: context.post_id,
        location_id: context.location_id,
        week_of: weekOf,
        google_post_id: context.google_post_id,
        idempotent: true,
      });
    }

    const summary = asNonEmptyString(context.summary);
    if (!summary) {
      return fail(422, "GBP post draft has no summary to publish");
    }

    // Gate — Google linkage must be resolvable into a localPosts parent.
    const accountId = asNonEmptyString(context.google_account_id);
    const googleLocationId = asNonEmptyString(context.google_location_id);
    if (!accountId || !googleLocationId) {
      return fail(422, "location is missing its Google account/location linkage");
    }
    const ownerUserId = asNonEmptyString(context.owner_user_id);
    if (!ownerUserId) {
      return fail(422, "location has no owner connected-account for Google auth");
    }

    // Gate — a passing claims/compliance content check must exist.
    const cleared = await hasPassingContentCheck(
      ctx,
      context.location_id,
      context.post_id,
    );
    if (!cleared) {
      return fail(
        422,
        "no passing content check exists for this GBP post; publishing blocked",
      );
    }

    const accessToken = await requestGoogleAccessToken(ownerUserId);
    const parent = `accounts/${accountId}/locations/${googleLocationId}`;
    const body = buildLocalPostBody(context, summary);
    const googlePostName = await createLocalPostOnGoogle(
      accessToken,
      parent,
      body,
      idempotencyKey,
    );

    await markPostPublished(ctx, context.post_id, googlePostName);

    await ctx.events.publish("gbp.post_published", {
      post_id: context.post_id,
      location_id: context.location_id,
      week_of: weekOf,
      google_post_id: googlePostName,
      idempotency_key: idempotencyKey,
    });

    return ok({
      status: "published",
      post_id: context.post_id,
      location_id: context.location_id,
      week_of: weekOf,
      google_post_id: googlePostName,
      idempotent: false,
    });
  } catch (e) {
    if (e instanceof PublishError) {
      await ctx.events
        .publish("gbp.post_publish_failed", {
          post_id: parsed.postId,
          location_id: parsed.locationId,
          week_of: parsed.weekOf,
          code: e.code,
          message: e.message,
        })
        .catch(() => {});
      return fail(e.status, e.message);
    }
    return fail(500, `internal error publishing GBP post: ${(e as Error).message}`);
  }
}
