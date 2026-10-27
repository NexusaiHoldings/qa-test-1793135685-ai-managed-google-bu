/**
 * GBP review sync — Feature F1-002.
 *
 * Pulls the review history for a location (reviews + the owner's past replies)
 * and upserts into gbp_reviews / gbp_review_responses. The owner's existing
 * replies seed the voice-calibration profile. Driven by:
 *
 *   - the one-step connect backfill (full history),
 *   - the 30-minute gbp-review-poll cron (keeps reviews current so AI replies
 *     land inside the 2-hour window from ceo_briefing.ai_automation_core),
 *   - the optional Pub/Sub webhook (near-real-time nudge for a single location).
 *
 * All SQL is parameterized; all IDs are UUID.
 */

import {
  GoogleBusinessClient,
  starRatingToInt,
  type GbpDb,
  type GoogleReview,
} from "./google-client";

export interface SyncOptions {
  userId?: string;
  parent?: string; // "accounts/{a}/locations/{l}"
  kind?: "backfill" | "review_poll" | "webhook";
  maxPages?: number;
}

export interface SyncResult {
  locationId: string;
  reviewsSeen: number;
  reviewsUpserted: number;
  responsesUpserted: number;
  status: "success" | "error";
  error?: string;
}

interface LocationLookupRow {
  id: string;
  user_id: string;
  google_location_id: string;
}

// ── sync run bookkeeping ─────────────────────────────────────────────────────

async function openSyncRun(
  db: GbpDb,
  locationId: string,
  kind: string,
): Promise<string | null> {
  try {
    const rows = await db.query<{ id: string }>(
      `INSERT INTO gbp_sync_runs (location_id, kind, status)
       VALUES ($1,$2,'running') RETURNING id`,
      locationId,
      kind,
    );
    return rows[0]?.id ?? null;
  } catch (e) {
    console.warn(
      JSON.stringify({ at: "gbp.review-sync.openSyncRun", locationId, error: (e as Error).message }),
    );
    return null;
  }
}

async function closeSyncRun(
  db: GbpDb,
  runId: string | null,
  result: Omit<SyncResult, "locationId">,
): Promise<void> {
  if (!runId) return;
  try {
    await db.execute(
      `UPDATE gbp_sync_runs
          SET status = $2, reviews_seen = $3, reviews_upserted = $4,
              responses_upserted = $5, error = $6, finished_at = now()
        WHERE id = $1`,
      runId,
      result.status,
      result.reviewsSeen,
      result.reviewsUpserted,
      result.responsesUpserted,
      result.error ?? null,
    );
  } catch (e) {
    console.warn(
      JSON.stringify({ at: "gbp.review-sync.closeSyncRun", runId, error: (e as Error).message }),
    );
  }
}

// ── single review upsert ─────────────────────────────────────────────────────

async function upsertReview(
  db: GbpDb,
  locationId: string,
  review: GoogleReview,
): Promise<{ reviewRowId: string | null; responseUpserted: boolean }> {
  const star = starRatingToInt(review.starRating);
  const hasReply = Boolean(review.reviewReply?.comment);

  const rows = await db.query<{ id: string }>(
    `INSERT INTO gbp_reviews
       (location_id, google_review_id, reviewer_name, reviewer_photo_url,
        star_rating, comment, review_created_at, review_updated_at,
        reply_comment, reply_updated_at, has_owner_reply, needs_reply, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (location_id, google_review_id) DO UPDATE SET
       reviewer_name      = EXCLUDED.reviewer_name,
       reviewer_photo_url = EXCLUDED.reviewer_photo_url,
       star_rating        = EXCLUDED.star_rating,
       comment            = EXCLUDED.comment,
       review_updated_at  = EXCLUDED.review_updated_at,
       reply_comment      = EXCLUDED.reply_comment,
       reply_updated_at   = EXCLUDED.reply_updated_at,
       has_owner_reply    = EXCLUDED.has_owner_reply,
       needs_reply        = EXCLUDED.needs_reply,
       synced_at          = now()
     RETURNING id`,
    locationId,
    review.reviewId,
    review.reviewer?.displayName ?? null,
    review.reviewer?.profilePhotoUrl ?? null,
    star || null,
    review.comment ?? null,
    review.createTime ?? null,
    review.updateTime ?? null,
    review.reviewReply?.comment ?? null,
    review.reviewReply?.updateTime ?? null,
    hasReply,
    !hasReply,
  );

  const reviewRowId = rows[0]?.id ?? null;
  let responseUpserted = false;

  // Seed voice calibration from the owner's existing reply.
  if (hasReply && reviewRowId && review.reviewReply?.comment) {
    await db.execute(
      `INSERT INTO gbp_review_responses
         (review_id, location_id, source, comment, star_rating_context,
          author, used_for_voice, created_at, synced_at)
       VALUES ($1,$2,'owner_backfill',$3,$4,'owner', true, $5, now())
       ON CONFLICT (review_id, source) WHERE review_id IS NOT NULL
       DO UPDATE SET comment = EXCLUDED.comment,
                     star_rating_context = EXCLUDED.star_rating_context,
                     synced_at = now()`,
      reviewRowId,
      locationId,
      review.reviewReply.comment,
      star || null,
      review.reviewReply.updateTime ?? null,
    );
    responseUpserted = true;
  }

  return { reviewRowId, responseUpserted };
}

// ── voice profile seeding ────────────────────────────────────────────────────

/**
 * Refresh the location's voice profile sample count from the owner's backfilled
 * replies. A later sprint runs the retrieval-grounded prompt; here we just keep
 * the count + seeded flag current so the UI/pipeline knows calibration data
 * exists.
 */
async function refreshVoiceProfile(
  db: GbpDb,
  locationId: string,
  userId: string | undefined,
): Promise<void> {
  const rows = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM gbp_review_responses
      WHERE location_id = $1 AND used_for_voice = true`,
    locationId,
  );
  const sampleCount = rows[0]?.n ?? 0;

  await db.execute(
    `INSERT INTO gbp_voice_profiles
       (location_id, user_id, sample_count, seeded_from_reviews, updated_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (location_id) DO UPDATE SET
       user_id             = COALESCE(gbp_voice_profiles.user_id, EXCLUDED.user_id),
       sample_count        = EXCLUDED.sample_count,
       seeded_from_reviews = gbp_voice_profiles.seeded_from_reviews OR EXCLUDED.seeded_from_reviews,
       updated_at          = now()`,
    locationId,
    userId ?? null,
    sampleCount,
    sampleCount > 0,
  );
}

// ── public: sync one location ────────────────────────────────────────────────

/**
 * Sync the review history for one linked location. Resolves the user + parent
 * resource name from gbp_locations when not supplied (cron path).
 */
export async function syncReviewsForLocation(
  db: GbpDb,
  locationId: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const kind = opts.kind ?? "review_poll";
  const runId = await openSyncRun(db, locationId, kind);

  let userId = opts.userId;
  let parent = opts.parent;
  if (!userId || !parent) {
    const locRows = await db.query<LocationLookupRow>(
      `SELECT id, user_id, google_location_id FROM gbp_locations WHERE id = $1`,
      locationId,
    );
    const loc = locRows[0];
    if (!loc) {
      const result: SyncResult = {
        locationId,
        reviewsSeen: 0,
        reviewsUpserted: 0,
        responsesUpserted: 0,
        status: "error",
        error: "location_not_found",
      };
      await closeSyncRun(db, runId, result);
      return result;
    }
    userId = userId ?? loc.user_id;
    parent = parent ?? loc.google_location_id;
  }

  const client = GoogleBusinessClient.forUser(db, userId);
  const maxPages = opts.maxPages ?? (kind === "backfill" ? 50 : 4);

  let reviewsSeen = 0;
  let reviewsUpserted = 0;
  let responsesUpserted = 0;
  let totalReviewCount: number | undefined;
  let averageRating: number | undefined;

  try {
    let pageToken: string | undefined;
    let page = 0;
    do {
      const data = await client.listReviews(parent, { pageToken, pageSize: 50 });
      if (totalReviewCount === undefined) totalReviewCount = data.totalReviewCount;
      if (averageRating === undefined) averageRating = data.averageRating;

      for (const review of data.reviews) {
        reviewsSeen += 1;
        const { reviewRowId, responseUpserted } = await upsertReview(db, locationId, review);
        if (reviewRowId) reviewsUpserted += 1;
        if (responseUpserted) responsesUpserted += 1;
      }
      pageToken = data.nextPageToken;
      page += 1;
    } while (pageToken && page < maxPages);

    await refreshVoiceProfile(db, locationId, userId);

    // Keep the denormalised counters on the location current.
    await db.execute(
      `UPDATE gbp_locations
          SET review_count = COALESCE($2, review_count),
              average_rating = COALESCE($3, average_rating),
              updated_at = now()
        WHERE id = $1`,
      locationId,
      totalReviewCount ?? null,
      averageRating ?? null,
    );

    const result: SyncResult = {
      locationId,
      reviewsSeen,
      reviewsUpserted,
      responsesUpserted,
      status: "success",
    };
    await closeSyncRun(db, runId, result);
    return result;
  } catch (e) {
    const result: SyncResult = {
      locationId,
      reviewsSeen,
      reviewsUpserted,
      responsesUpserted,
      status: "error",
      error: (e as Error).message.slice(0, 500),
    };
    await closeSyncRun(db, runId, result);
    return result;
  }
}

// ── public: sync every linked location (cron) ────────────────────────────────

export interface PollSummary {
  locationsProcessed: number;
  reviewsUpserted: number;
  errors: number;
  results: SyncResult[];
}

/**
 * Poll every linked location. Used by the 30-minute gbp-review-poll cron.
 * Failures on one location never abort the others.
 */
export async function pollAllLocations(
  db: GbpDb,
  limit = 200,
): Promise<PollSummary> {
  const rows = await db.query<{ id: string; user_id: string; google_location_id: string }>(
    `SELECT id, user_id, google_location_id
       FROM gbp_locations
      ORDER BY updated_at ASC
      LIMIT $1`,
    limit,
  );

  const results: SyncResult[] = [];
  let reviewsUpserted = 0;
  let errors = 0;

  for (const row of rows) {
    const result = await syncReviewsForLocation(db, row.id, {
      userId: row.user_id,
      parent: row.google_location_id,
      kind: "review_poll",
    });
    results.push(result);
    reviewsUpserted += result.reviewsUpserted;
    if (result.status === "error") errors += 1;
  }

  return {
    locationsProcessed: rows.length,
    reviewsUpserted,
    errors,
    results,
  };
}

// ── public: sync by Google location resource name (webhook) ──────────────────

/**
 * Resolve a GBP location resource name (from a Pub/Sub notification) to its
 * linked row and sync it. Returns null when the location is not linked here.
 */
export async function syncReviewsByGoogleName(
  db: GbpDb,
  googleLocationName: string,
): Promise<SyncResult | null> {
  // Pub/Sub notifications may carry a bare "locations/{l}" — match by suffix.
  const rows = await db.query<LocationLookupRow>(
    `SELECT id, user_id, google_location_id
       FROM gbp_locations
      WHERE google_location_id = $1
         OR google_location_id LIKE '%' || $2`,
    googleLocationName,
    `/${googleLocationName.replace(/^.*\//, "")}`,
  );
  const loc = rows[0];
  if (!loc) return null;

  return syncReviewsForLocation(db, loc.id, {
    userId: loc.user_id,
    parent: loc.google_location_id,
    kind: "webhook",
  });
}
