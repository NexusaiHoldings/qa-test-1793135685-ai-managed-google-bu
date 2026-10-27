import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

type PublishArgs = {
  reviewId: string;
  responseId: string;
  idempotencyKey: string;
};

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed: string = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseArgs(args: Args): PublishArgs | null {
  const reviewId: string | null = asNonEmptyString(args.reviewId);
  const responseId: string | null = asNonEmptyString(args.responseId);
  const idempotencyKey: string | null = asNonEmptyString(args.idempotencyKey);

  if (!reviewId || !responseId || !idempotencyKey) {
    return null;
  }

  return { reviewId, responseId, idempotencyKey };
}

export async function handlePublishReviewReply(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const parsed: PublishArgs | null = parseArgs(args);

  if (!parsed) {
    return {
      ok: false,
      code: "invalid_args",
      message:
        "publish_review_reply requires non-empty reviewId, responseId, and idempotencyKey",
    };
  }

  const logger: {
    info?: (payload: Record<string, unknown>, message?: string) => void;
    error?: (payload: Record<string, unknown>, message?: string) => void;
  } = ((ctx as { logger?: unknown }).logger as {
    info?: (payload: Record<string, unknown>, message?: string) => void;
    error?: (payload: Record<string, unknown>, message?: string) => void;
  }) ?? {};

  logger.info?.(
    {
      tool: "publish_review_reply",
      reviewId: parsed.reviewId,
      responseId: parsed.responseId,
      idempotencyKey: parsed.idempotencyKey,
    },
    "publish_review_reply invoked",
  );

  return {
    ok: false,
    code: "not_implemented",
    message:
      "publish_review_reply is registered but not wired to GBP publishing services in this slice",
  };
}
