import { Pool } from "pg";
import { buildVoiceSamples } from "@/lib/gbp/voice-samples";

type VoiceSampleState = {
  index: number;
  reviewComment: string;
  currentReply: string;
  approved: boolean;
};

type VoiceOnboardingState = {
  locationId: string;
  mode: "samples" | "tone-picker";
  samples: VoiceSampleState[];
  currentIndex: number;
  readyToApprove: boolean;
  isApproved: boolean;
  successPreview: string;
};

type TonePickerInput = {
  userId: string;
  locationId: string;
  greetingStyle: string;
  formality: string;
  signOffStyle: string;
  neverSay: string;
};

type SampleFeedbackInput = {
  userId: string;
  locationId: string;
  sampleIndex: number;
  approved: boolean;
  editedReply: string;
};

type ApproveInput = {
  userId: string;
  locationId: string;
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function getPrimaryLocationId(userId: string): Promise<string | null> {
  const result = await pool.query<{ id: string }>(
    `
      SELECT id
      FROM gbp_locations
      WHERE user_id = $1
      ORDER BY linked_at ASC
      LIMIT 1
    `,
    [userId],
  );
  return result.rows[0]?.id ?? null;
}

export async function getVoiceOnboardingState(
  userId: string,
  requestedLocationId?: string,
): Promise<VoiceOnboardingState | null> {
  const locationId = requestedLocationId ?? (await getPrimaryLocationId(userId));
  if (!locationId) return null;

  const reviews = await pool.query<{ comment: string }>(
    `
      SELECT comment
      FROM gbp_reviews
      WHERE location_id = $1
        AND comment IS NOT NULL
        AND length(trim(comment)) > 0
      ORDER BY review_created_at DESC NULLS LAST
      LIMIT 20
    `,
    [locationId],
  );

  const profileRes = await pool.query<{ profile: Record<string, unknown>; seeded_from_reviews: boolean }>(
    `
      SELECT profile, seeded_from_reviews
      FROM gbp_voice_profiles
      WHERE location_id = $1
      LIMIT 1
    `,
    [locationId],
  );

  const profile = profileRes.rows[0]?.profile ?? {};
  const approved = Boolean((profile as { approved?: boolean }).approved);

  if (approved) {
    return {
      locationId,
      mode: "samples",
      samples: [],
      currentIndex: 0,
      readyToApprove: true,
      isApproved: true,
      successPreview:
        typeof (profile as { firstPostPreview?: unknown }).firstPostPreview === "string"
          ? ((profile as { firstPostPreview: string }).firstPostPreview ?? "")
          : "This week we helped another local homeowner get fast, honest service. Thanks for trusting our team.",
    };
  }

  if (reviews.rowCount < 5) {
    return {
      locationId,
      mode: "tone-picker",
      samples: [],
      currentIndex: 0,
      readyToApprove: false,
      isApproved: false,
      successPreview: "",
    };
  }

  const samples = await buildVoiceSamples({
    userId,
    locationId,
    reviews: reviews.rows.map((r) => r.comment).filter(Boolean),
  });

  const sampleState: VoiceSampleState[] = samples.map((s, idx) => ({
    index: idx,
    reviewComment: s.reviewComment,
    currentReply: s.currentReply,
    approved: s.approved,
  }));

  const currentIndex = sampleState.findIndex((s) => !s.approved);
  return {
    locationId,
    mode: "samples",
    samples: sampleState,
    currentIndex: currentIndex === -1 ? sampleState.length - 1 : currentIndex,
    readyToApprove: sampleState.every((s) => s.approved),
    isApproved: false,
    successPreview: "",
  };
}

export async function saveTonePickerProfile(input: TonePickerInput): Promise<void> {
  const profile = {
    greetingStyle: input.greetingStyle,
    formality: input.formality,
    signOffStyle: input.signOffStyle,
    neverSay: input.neverSay ? input.neverSay.split(",").map((v) => v.trim()).filter(Boolean) : [],
    approved: false,
    source: "tone_picker",
  };

  await pool.query(
    `
      INSERT INTO gbp_voice_profiles (location_id, user_id, sample_count, tone_summary, profile, seeded_from_reviews, updated_at)
      VALUES ($1, $2, 0, $3, $4::jsonb, false, now())
      ON CONFLICT (location_id)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        sample_count = 0,
        tone_summary = EXCLUDED.tone_summary,
        profile = EXCLUDED.profile,
        seeded_from_reviews = false,
        updated_at = now()
    `,
    [
      input.locationId,
      input.userId,
      `${input.formality} with ${input.greetingStyle} greeting and ${input.signOffStyle} sign-off`,
      JSON.stringify(profile),
    ],
  );
}

export async function saveVoiceSampleFeedback(input: SampleFeedbackInput): Promise<void> {
  const state = await getVoiceOnboardingState(input.userId, input.locationId);
  if (!state || state.mode !== "samples") {
    throw new Error("Voice samples are unavailable.");
  }

  const sample = state.samples[input.sampleIndex];
  if (!sample) {
    throw new Error("Sample index out of range.");
  }

  const updatedSamples = state.samples.map((s) =>
    s.index === input.sampleIndex
      ? {
          ...s,
          currentReply: input.editedReply || s.currentReply,
          approved: input.approved,
        }
      : s,
  );

  const existing = await pool.query<{ profile: Record<string, unknown> }>(
    `SELECT profile FROM gbp_voice_profiles WHERE location_id = $1 LIMIT 1`,
    [input.locationId],
  );

  const merged = {
    ...(existing.rows[0]?.profile ?? {}),
    approved: false,
    samplePairs: updatedSamples,
  };

  await pool.query(
    `
      INSERT INTO gbp_voice_profiles (location_id, user_id, sample_count, tone_summary, profile, seeded_from_reviews, updated_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, true, now())
      ON CONFLICT (location_id)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        sample_count = EXCLUDED.sample_count,
        tone_summary = EXCLUDED.tone_summary,
        profile = EXCLUDED.profile,
        seeded_from_reviews = true,
        updated_at = now()
    `,
    [
      input.locationId,
      input.userId,
      updatedSamples.length,
      "Owner-calibrated from review sample approvals",
      JSON.stringify(merged),
    ],
  );
}

export async function approveVoiceProfile(input: ApproveInput): Promise<void> {
  const existing = await pool.query<{ profile: Record<string, unknown> }>(
    `SELECT profile FROM gbp_voice_profiles WHERE location_id = $1 LIMIT 1`,
    [input.locationId],
  );

  const merged = {
    ...(existing.rows[0]?.profile ?? {}),
    approved: true,
    approvedAt: new Date().toISOString(),
    firstPostPreview:
      "Thanks for supporting our local business. This week we're sharing a recent job highlight and practical tips to keep your home running smoothly.",
  };

  await pool.query(
    `
      INSERT INTO gbp_voice_profiles (location_id, user_id, sample_count, tone_summary, profile, seeded_from_reviews, updated_at)
      VALUES ($1, $2, 3, $3, $4::jsonb, true, now())
      ON CONFLICT (location_id)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        profile = EXCLUDED.profile,
        tone_summary = EXCLUDED.tone_summary,
        seeded_from_reviews = true,
        updated_at = now()
    `,
    [input.locationId, input.userId, "Approved voice profile", JSON.stringify(merged)],
  );
}
