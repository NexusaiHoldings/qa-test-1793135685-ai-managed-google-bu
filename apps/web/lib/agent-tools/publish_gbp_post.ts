import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = {
  location_id?: unknown;
  week_of?: unknown;
  dry_run?: unknown;
};

type DbRow = {
  id: string;
  location_id: string;
  week_of: string;
  google_location_name: string | null;
  title: string | null;
  summary: string | null;
  cta_label: string | null;
  cta_url: string | null;
  media_url: string | null;
  published_at: string | null;
  google_post_name: string | null;
};

type GoogleCreateResponse = {
  name?: string;
  [key: string]: unknown;
};

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
};

function asQueryable(ctx: HandlerContext): Queryable {
  const maybeDb = (ctx as unknown as { db?: Queryable; pool?: Queryable }).db
    ?? (ctx as unknown as { db?: Queryable; pool?: Queryable }).pool;
  if (!maybeDb || typeof maybeDb.query !== "function") {
    throw new Error("handler_context_missing_db_query");
  }
  return maybeDb;
}

function normalizeIsoDate(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`invalid_${field}`);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid_${field}`);
  }
  return d.toISOString().slice(0, 10);
}

function normalizeUuid(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`invalid_${field}`);
  }
  const v = value.trim();
  const uuidRe =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(v)) {
    throw new Error(`invalid_${field}`);
  }
  return v;
}

function toErrorResult(code: string, message: string): HandlerResult {
  return {
    ok: false,
    code,
    error: message,
  } as unknown as HandlerResult;
}

async function resolveGoogleClient(ctx: HandlerContext): Promise<{
  createLocalPost: (input: {
    locationId: string;
    title: string;
    summary: string;
    ctaLabel?: string | null;
    ctaUrl?: string | null;
    mediaUrl?: string | null;
    idempotencyKey: string;
  }) => Promise<GoogleCreateResponse>;
}> {
  const dynamicImport = await import("@/lib/gbp/google-client").catch(() => null);
  if (!dynamicImport || typeof (dynamicImport as Record<string, unknown>).createLocalPost !== "function") {
    throw new Error("google_client_createLocalPost_missing");
  }
  const createLocalPost = (dynamicImport as {
    createLocalPost: (ctx: HandlerContext, input: {
      locationId: string;
      title: string;
      summary: string;
      ctaLabel?: string | null;
      ctaUrl?: string | null;
      mediaUrl?: string | null;
      idempotencyKey: string;
    }) => Promise<GoogleCreateResponse>;
  }).createLocalPost;

  return {
    createLocalPost: async (input) => createLocalPost(ctx, input),
  };
}

export async function handlePublishGbpPost(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  try {
    const locationId = normalizeUuid(args.location_id, "location_id");
    const weekOf = normalizeIsoDate(args.week_of, "week_of");
    const dryRun = Boolean(args.dry_run);

    const db = asQueryable(ctx);

    const selected = await db.query(
      `
      SELECT
        p.id,
        p.location_id,
        p.week_of::text AS week_of,
        p.google_location_name,
        p.title,
        p.summary,
        p.cta_label,
        p.cta_url,
        p.media_url,
        p.published_at::text AS published_at,
        p.google_post_name
      FROM gbp_posts p
      WHERE p.location_id = $1
        AND p.week_of = $2::date
      LIMIT 1
      `,
      [locationId, weekOf],
    );

    if (selected.rows.length === 0) {
      return toErrorResult("not_found", "No scheduled GBP post for location/week");
    }

    const row = selected.rows[0] as DbRow;

    if (row.published_at || row.google_post_name) {
      return {
        ok: true,
        data: {
          status: "already_published",
          location_id: row.location_id,
          week_of: row.week_of,
          post_id: row.id,
          google_post_name: row.google_post_name ?? null,
        },
      } as unknown as HandlerResult;
    }

    if (!row.title || !row.summary) {
      return toErrorResult("invalid_state", "Post missing title or summary");
    }

    const idempotencyKey = `gbp-post:${row.location_id}:${row.week_of}`;

    if (dryRun) {
      return {
        ok: true,
        data: {
          status: "dry_run",
          post_id: row.id,
          location_id: row.location_id,
          week_of: row.week_of,
          idempotency_key: idempotencyKey,
        },
      } as unknown as HandlerResult;
    }

    const googleClient = await resolveGoogleClient(ctx);
    const created = await googleClient.createLocalPost({
      locationId: row.location_id,
      title: row.title,
      summary: row.summary,
      ctaLabel: row.cta_label,
      ctaUrl: row.cta_url,
      mediaUrl: row.media_url,
      idempotencyKey,
    });

    const googlePostName =
      typeof created.name === "string" && created.name.trim().length > 0
        ? created.name.trim()
        : null;

    await db.query(
      `
      UPDATE gbp_posts
      SET
        published_at = NOW(),
        google_post_name = COALESCE($3, google_post_name),
        updated_at = NOW()
      WHERE location_id = $1
        AND week_of = $2::date
      `,
      [row.location_id, row.week_of, googlePostName],
    );

    return {
      ok: true,
      data: {
        status: "published",
        post_id: row.id,
        location_id: row.location_id,
        week_of: row.week_of,
        google_post_name: googlePostName,
        idempotency_key: idempotencyKey,
      },
    } as unknown as HandlerResult;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "publish_gbp_post_failed";
    return toErrorResult("publish_gbp_post_failed", message);
  }
}
