import { Pool } from "pg";

export type VoiceProfile = {
  greetingStyle: string;
  signOffStyle: string;
  formality: "casual" | "balanced" | "formal";
  tradeVocabulary: string[];
  thingsNeverSaid: string[];
  styleRules: string[];
};

export type VoiceProfileResult = {
  locationId: string;
  profileId: string;
  sampleCount: number;
  approved: boolean;
  toneSummary: string;
  profile: VoiceProfile;
  route: "samples" | "tone-picker";
};

type ParsedProfile = VoiceProfile & { toneSummary: string };

/** Hand-rolled structured-output validator (no external deps) for the gateway payload. */
function parseVoiceProfile(value: unknown): ParsedProfile | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;

  const greetingStyle = typeof v.greetingStyle === "string" ? v.greetingStyle.trim() : "";
  const signOffStyle = typeof v.signOffStyle === "string" ? v.signOffStyle.trim() : "";
  const toneSummary = typeof v.toneSummary === "string" ? v.toneSummary.trim() : "";
  if (!greetingStyle || !signOffStyle || !toneSummary) return null;

  const formality =
    v.formality === "casual" || v.formality === "balanced" || v.formality === "formal"
      ? v.formality
      : null;
  if (!formality) return null;

  const toStringArray = (input: unknown): string[] =>
    Array.isArray(input)
      ? input.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];

  return {
    greetingStyle,
    signOffStyle,
    formality,
    tradeVocabulary: toStringArray(v.tradeVocabulary),
    thingsNeverSaid: toStringArray(v.thingsNeverSaid),
    styleRules: toStringArray(v.styleRules),
    toneSummary,
  };
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

type SeedRow = {
  location_id: string;
  title: string | null;
  primary_category: string | null;
  website_url: string | null;
  review_count: number;
  sample_count: number;
  reviewer_comment: string | null;
  owner_reply: string | null;
};

function fallbackProfile(rows: SeedRow[]): { profile: VoiceProfile; toneSummary: string } {
  const vocab = new Set<string>();
  for (const row of rows) {
    const text = `${row.owner_reply ?? ""} ${row.reviewer_comment ?? ""}`.toLowerCase();
    for (const token of ["thanks", "appreciate", "team", "service", "quick", "professional", "clean"]) {
      if (text.includes(token)) vocab.add(token);
    }
  }
  return {
    toneSummary: "Friendly, concise, and service-focused with clear appreciation for customer feedback.",
    profile: {
      greetingStyle: "Start with direct thanks using the reviewer's name when present.",
      signOffStyle: "Close warmly from the team (no hard sell).",
      formality: "balanced",
      tradeVocabulary: Array.from(vocab),
      thingsNeverSaid: ["guaranteed results", "blame the customer", "legal threats"],
      styleRules: [
        "Keep replies under 90 words.",
        "Acknowledge the specific service context.",
        "Use plain language an owner-operator would actually say.",
      ],
    },
  };
}

async function buildGatewayProfile(seed: SeedRow[]): Promise<{ profile: VoiceProfile; toneSummary: string }> {
  const seedText = seed
    .map((r) =>
      [
        `Business: ${r.title ?? "Unknown"}`,
        `Category: ${r.primary_category ?? "Unknown"}`,
        `Customer review: ${r.reviewer_comment ?? ""}`,
        `Owner reply: ${r.owner_reply ?? ""}`,
      ].join("\n"),
    )
    .join("\n\n---\n\n");

  const endpoint = process.env.NEXUS_GATEWAY_URL;
  if (!endpoint) {
    return fallbackProfile(seed);
  }

  try {
    const response = await fetch(`${endpoint}/v1/structured`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.NEXUS_GATEWAY_API_KEY ?? ""}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        schema: {
          type: "object",
          properties: {
            greetingStyle: { type: "string" },
            signOffStyle: { type: "string" },
            formality: { type: "string", enum: ["casual", "balanced", "formal"] },
            tradeVocabulary: { type: "array", items: { type: "string" } },
            thingsNeverSaid: { type: "array", items: { type: "string" } },
            styleRules: { type: "array", items: { type: "string" } },
            toneSummary: { type: "string" },
          },
          required: [
            "greetingStyle",
            "signOffStyle",
            "formality",
            "tradeVocabulary",
            "thingsNeverSaid",
            "styleRules",
            "toneSummary",
          ],
          additionalProperties: false,
        },
        prompt:
          "Extract the owner's authentic brand voice from historical review/response pairs. Avoid marketing fluff. Output only JSON.",
        input: seedText,
      }),
      cache: "no-store",
    });

    if (!response.ok) return fallbackProfile(seed);
    const payload = (await response.json()) as { output?: unknown };
    const parsed = parseVoiceProfile(payload.output);
    if (!parsed) return fallbackProfile(seed);

    const { toneSummary, ...profile } = parsed;
    return { profile, toneSummary };
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "gbp.voice_profile.gateway_failed",
        message: error instanceof Error ? error.message : "unknown error",
      }),
    );
    return fallbackProfile(seed);
  }
}

export async function upsertVoiceProfileForUser(userId: string): Promise<VoiceProfileResult | null> {
  const seedQuery = `
    SELECT
      l.id AS location_id,
      l.title,
      l.primary_category,
      l.website_url,
      COALESCE(l.review_count, 0) AS review_count,
      (
        SELECT COUNT(*)
        FROM gbp_reviews r2
        WHERE r2.location_id = l.id
          AND COALESCE(NULLIF(TRIM(r2.comment), ''), '') <> ''
      )::int AS sample_count,
      r.comment AS reviewer_comment,
      COALESCE(rr.comment, r.reply_comment) AS owner_reply
    FROM gbp_locations l
    LEFT JOIN gbp_reviews r ON r.location_id = l.id
    LEFT JOIN gbp_review_responses rr ON rr.review_id = r.id
    WHERE l.user_id = $1
    ORDER BY l.linked_at ASC, r.review_created_at DESC
    LIMIT 60
  `;
  const seedRes = await pool.query<SeedRow>(seedQuery, [userId]);
  if (seedRes.rowCount === 0) return null;

  const locationId = seedRes.rows[0].location_id;
  const rowsForLocation = seedRes.rows.filter((r) => r.location_id === locationId);
  const sampleCount = rowsForLocation[0]?.sample_count ?? 0;
  const route: "samples" | "tone-picker" = sampleCount >= 5 ? "samples" : "tone-picker";

  const { profile, toneSummary } = await buildGatewayProfile(rowsForLocation);

  const upsert = `
    INSERT INTO gbp_voice_profiles (
      location_id,
      user_id,
      sample_count,
      tone_summary,
      profile,
      seeded_from_reviews,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5::jsonb, $6, now())
    ON CONFLICT (location_id)
    DO UPDATE SET
      user_id = EXCLUDED.user_id,
      sample_count = EXCLUDED.sample_count,
      tone_summary = EXCLUDED.tone_summary,
      profile = EXCLUDED.profile,
      seeded_from_reviews = EXCLUDED.seeded_from_reviews,
      updated_at = now()
    RETURNING id, approved
  `;
  const upsertRes = await pool.query<{ id: string; approved: boolean }>(upsert, [
    locationId,
    userId,
    sampleCount,
    toneSummary,
    JSON.stringify(profile),
    sampleCount >= 1,
  ]);

  return {
    locationId,
    profileId: upsertRes.rows[0].id,
    sampleCount,
    approved: upsertRes.rows[0].approved,
    toneSummary,
    profile,
    route,
  };
}
