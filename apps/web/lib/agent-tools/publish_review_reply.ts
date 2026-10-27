import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = {
  reviewResponseId?: unknown;
  idempotencyKey?: unknown;
};

type ReviewResponseRow = {
  id: string;
  review_id: string;
  location_id: string;
  reply_text: string;
  status: string;
  content_check_status: string | null;
};

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getDbClient(ctx: HandlerContext): {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
} {
  const maybeDb = (ctx as unknown as { db?: unknown }).db;
  if (
    !maybeDb ||
    typeof maybeDb !== "object" ||
    typeof (maybeDb as { query?: unknown }).query !== "function"
  ) {
    throw new Error("HandlerContext.db.query is unavailable");
  }
  return maybeDb as {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  };
}

function getGoogleClient(ctx: HandlerContext): {
  updateReviewReply: (input: {
    locationId: string;
    reviewId: string;
    replyText: string;
    idempotencyKey: string;
  }) => Promise<{ externalReplyName?: string; updateTime?: string }>;
} {
  const maybeGoogle = (ctx as unknown as { googleBusinessProfile?: unknown }).googleBusinessProfile;
  if (
    !maybeGoogle ||
    typeof maybeGoogle !== "object" ||
    typeof (maybeGoogle as { updateReviewReply?: unknown }).updateReviewReply !== "function"
  ) {
    throw new Error("HandlerContext.googleBusinessProfile.updateReviewReply is unavailable");
  }
  return maybeGoogle as {
    updateReviewReply: (input: {
      locationId: string;
      reviewId: string;
      replyText: string;
      idempotencyKey: string;
    }) => Promise<{ externalReplyName?: string; updateTime?: string }>;
  };
}

export async function handlePublishReviewReply(
  ctx: HandlerContext,
  args: Args
): Promise<HandlerResult> {
  try {
    const reviewResponseId = asNonEmptyString(args.reviewResponseId);
    const idempotencyKey = asNonEmptyString(args.idempotencyKey);

    if (!reviewResponseId || !idempotencyKey) {
      return {
        ok: false,
        code: "invalid_args",
        message: "reviewResponseId and idempotencyKey are required non-empty strings.",
      };
    }

    const db = getDbClient(ctx);

    const responseResult = await db.query(
      "SELECT id, review_id, location_id, reply_text, status, content_check_status FROM gbp_review_responses WHERE id = $1 LIMIT 1",
      [reviewResponseId]
    );

    if (responseResult.rows.length === 0) {
      return {
        ok: false,
        code: "not_found",
        message: "Review response not found.",
      };
    }

    const row = responseResult.rows[0] as unknown as ReviewResponseRow;

    if (row.status === "published") {
      return {
        ok: true,
        code: "already_published",
        message: "Reply already published.",
        data: { reviewResponseId: row.id },
      };
    }

    if (row.content_check_status !== "pass") {
      return {
        ok: false,
        code: "content_check_required",
        message: "Reply cannot be published until a passing content check exists.",
      };
    }

    const googleClient = getGoogleClient(ctx);

    const googleResult = await googleClient.updateReviewReply({
      locationId: row.location_id,
      reviewId: row.review_id,
      replyText: row.reply_text,
      idempotencyKey,
    });

    await db.query(
      "UPDATE gbp_review_responses SET status = $1, published_at = NOW(), publish_idempotency_key = $2, updated_at = NOW() WHERE id = $3",
      ["published", idempotencyKey, row.id]
    );

    return {
      ok: true,
      code: "published",
      message: "Review reply published successfully.",
      data: {
        reviewResponseId: row.id,
        externalReplyName: googleResult.externalReplyName ?? null,
        publishedAt: googleResult.updateTime ?? null,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      ok: false,
      code: "publish_failed",
      message,
    };
  }
}
