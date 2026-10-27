import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = {
  location_id?: unknown;
  week_of?: unknown;
  post_id?: unknown;
};

type DbRow = {
  id: string;
  location_id: string;
  week_of: string;
  status: string;
  post_type: string | null;
  summary: string | null;
  call_to_action_type: string | null;
  call_to_action_url: string | null;
  media_source_url: string | null;
  gmb_local_post_name: string | null;
};

type GoogleClient = {
  createLocalPost: (input: {
    locationId: string;
    languageCode?: string;
    summary: string;
    callToAction?: { actionType: string; url?: string };
    media?: { sourceUrl: string };
    event?: Record<string, unknown>;
  }) => Promise<{ name?: string }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function getDb(ctx: HandlerContext): Promise<{
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}> {
  const candidate = (ctx as unknown as { db?: unknown }).db;
  if (
    isRecord(candidate) &&
    typeof candidate.query === "function"
  ) {
    return candidate as {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    };
  }

  const dynamicImport = new Function("m", "return import(m)") as (m: string) => Promise<unknown>;
  const pgMod = await dynamicImport("pg");
  const PoolCtor = (pgMod as { Pool?: new (cfg: { connectionString?: string }) => unknown }).Pool;
  if (!PoolCtor) {
    throw new Error("pg Pool unavailable");
  }
  const pool = new PoolCtor({ connectionString: process.env.DATABASE_URL });
  return pool as {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  };
}

async function getGoogleClient(ctx: HandlerContext): Promise<GoogleClient> {
  const candidate = (ctx as unknown as { googleClient?: unknown }).googleClient;
  if (isRecord(candidate) && typeof candidate.createLocalPost === "function") {
    return candidate as GoogleClient;
  }
  const dynamicImport = new Function("m", "return import(m)") as (m: string) => Promise<unknown>;
  const mod = await dynamicImport("@/lib/gbp/google-client");
  const createGoogleClient = (mod as { createGoogleClient?: () => Promise<GoogleClient> }).createGoogleClient;
  if (!createGoogleClient) {
    throw new Error("google client factory unavailable");
  }
  return createGoogleClient();
}

export async function handlePublishGbpPost(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  try {
    const locationId = asString(args.location_id);
    const weekOf = asString(args.week_of);
    const postId = asString(args.post_id);

    if (!locationId && !postId) {
      return {
        ok: false,
        error: "invalid_args",
        message: "Expected location_id + week_of or post_id.",
      };
    }

    const db = await getDb(ctx);
    const params: unknown[] = [];
    let whereClause = "";
    if (postId) {
      params.push(postId);
      whereClause = `id = $${params.length}`;
    } else {
      params.push(locationId, weekOf);
      whereClause = `location_id = $1 AND week_of = $2`;
    }

    const selectSql = `
      SELECT id, location_id, week_of, status, post_type, summary,
             call_to_action_type, call_to_action_url, media_source_url,
             gmb_local_post_name
      FROM gbp_posts
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const selected = await db.query(selectSql, params);
    const row = (selected.rows[0] ?? null) as DbRow | null;

    if (!row) {
      return {
        ok: false,
        error: "not_found",
        message: "No matching GBP post draft found.",
      };
    }

    if (row.status === "published" && row.gmb_local_post_name) {
      return {
        ok: true,
        data: {
          id: row.id,
          location_id: row.location_id,
          week_of: row.week_of,
          status: row.status,
          gmb_local_post_name: row.gmb_local_post_name,
          idempotent: true,
        },
      };
    }

    if (!row.summary || row.summary.trim().length === 0) {
      return {
        ok: false,
        error: "invalid_state",
        message: "Draft summary is empty.",
      };
    }

    const google = await getGoogleClient(ctx);
    const created = await google.createLocalPost({
      locationId: row.location_id,
      summary: row.summary,
      callToAction: row.call_to_action_type
        ? {
            actionType: row.call_to_action_type,
            url: row.call_to_action_url ?? undefined,
          }
        : undefined,
      media: row.media_source_url ? { sourceUrl: row.media_source_url } : undefined,
    });

    const gmbName = typeof created.name === "string" ? created.name : null;
    await db.query(
      `
      UPDATE gbp_posts
      SET status = 'published',
          published_at = NOW(),
          gmb_local_post_name = COALESCE($2, gmb_local_post_name),
          updated_at = NOW()
      WHERE id = $1
      `,
      [row.id, gmbName],
    );

    return {
      ok: true,
      data: {
        id: row.id,
        location_id: row.location_id,
        week_of: row.week_of,
        status: "published",
        gmb_local_post_name: gmbName,
        idempotent: false,
      },
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: "publish_failed",
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
