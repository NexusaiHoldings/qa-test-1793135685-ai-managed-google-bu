/**
 * GBP (Google Business Profile) domain schema — Feature F1-002.
 *
 * Company-owned tables for the one-step connect flow (hidden-address
 * service-area businesses), review sync, voice calibration, posts, rank
 * tracking, reporting, and the GBP API circuit-breaker health log.
 *
 * Picked up by `packages/db/migrate.ts` via the `*_DDL` constant convention
 * and run against the company DB at deploy (idempotent — every statement is
 * CREATE TABLE/INDEX IF NOT EXISTS). All primary keys are UUID.
 *
 * NOTE: `connected_accounts` (queried by the connect page to detect the owner's
 * Google link) is owned by the profile-and-account lego schema, so it is NOT
 * declared here — the TABLE-REF gate recognises lego-schema tables.
 */
export const GBP_DDL = `
-- 1. Linked locations (one row per Business Profile location the owner taps).
CREATE TABLE IF NOT EXISTS gbp_locations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL,
  google_account_id     text NOT NULL,
  google_location_id    text NOT NULL,
  title                 text,
  primary_category      text,
  additional_categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  business_type         text NOT NULL DEFAULT 'storefront',
  service_areas         jsonb NOT NULL DEFAULT '[]'::jsonb,
  regular_hours         jsonb NOT NULL DEFAULT '{}'::jsonb,
  primary_phone         text,
  website_url           text,
  storefront_address    jsonb,
  place_id              text,
  maps_uri              text,
  timezone              text,
  state                 text,
  review_count          integer NOT NULL DEFAULT 0,
  average_rating        numeric(2,1),
  media_count           integer NOT NULL DEFAULT 0,
  last_post_at          timestamptz,
  profile_updated_at    timestamptz,
  linked_at             timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gbp_locations_unique UNIQUE (user_id, google_location_id)
);
CREATE INDEX IF NOT EXISTS idx_gbp_locations_user ON gbp_locations (user_id);

-- 2. Sync runs (audit of every backfill / poll / webhook sync).
CREATE TABLE IF NOT EXISTS gbp_sync_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id         uuid,
  kind                text NOT NULL,
  status              text NOT NULL DEFAULT 'running',
  reviews_seen        integer NOT NULL DEFAULT 0,
  reviews_upserted    integer NOT NULL DEFAULT 0,
  responses_upserted  integer NOT NULL DEFAULT 0,
  error               text,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz
);
CREATE INDEX IF NOT EXISTS idx_gbp_sync_runs_location ON gbp_sync_runs (location_id, started_at DESC);

-- 3. Reviews (plus the owner's inline reply, if any).
CREATE TABLE IF NOT EXISTS gbp_reviews (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id        uuid NOT NULL,
  google_review_id   text NOT NULL,
  reviewer_name      text,
  reviewer_photo_url text,
  star_rating        integer,
  comment            text,
  review_created_at  timestamptz,
  review_updated_at  timestamptz,
  reply_comment      text,
  reply_updated_at   timestamptz,
  has_owner_reply    boolean NOT NULL DEFAULT false,
  needs_reply        boolean NOT NULL DEFAULT true,
  synced_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gbp_reviews_unique UNIQUE (location_id, google_review_id)
);
CREATE INDEX IF NOT EXISTS idx_gbp_reviews_location ON gbp_reviews (location_id, review_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gbp_reviews_needs_reply ON gbp_reviews (location_id) WHERE needs_reply = true;

-- 4. Review responses (owner's past replies seed voice calibration; later AI drafts land here too).
CREATE TABLE IF NOT EXISTS gbp_review_responses (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id           uuid,
  location_id         uuid NOT NULL,
  source              text NOT NULL DEFAULT 'owner_backfill',
  comment             text NOT NULL,
  star_rating_context integer,
  author              text,
  used_for_voice      boolean NOT NULL DEFAULT false,
  created_at          timestamptz,
  synced_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gbp_review_responses_location ON gbp_review_responses (location_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gbp_review_responses_review
  ON gbp_review_responses (review_id, source) WHERE review_id IS NOT NULL;

-- 5. Voice profiles (retrieval-grounded "in your voice" profile per location).
CREATE TABLE IF NOT EXISTS gbp_voice_profiles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id         uuid NOT NULL,
  user_id             uuid,
  sample_count        integer NOT NULL DEFAULT 0,
  tone_summary        text,
  profile             jsonb NOT NULL DEFAULT '{}'::jsonb,
  seeded_from_reviews boolean NOT NULL DEFAULT false,
  approved            boolean NOT NULL DEFAULT false,
  approved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gbp_voice_profiles_unique UNIQUE (location_id)
);

-- 6. Review escalations (risk-flagged reviews routed to the owner/support lego).
CREATE TABLE IF NOT EXISTS gbp_review_escalations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id   uuid,
  location_id uuid NOT NULL,
  reason      text,
  risk_level  text NOT NULL DEFAULT 'medium',
  status      text NOT NULL DEFAULT 'open',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gbp_review_escalations_location ON gbp_review_escalations (location_id, status);

-- 7. Local posts (weekly publish; MVP uses owner photos + existing media only).
CREATE TABLE IF NOT EXISTS gbp_posts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id    uuid NOT NULL,
  google_post_id text,
  topic_type     text NOT NULL DEFAULT 'STANDARD',
  summary        text,
  cta_type       text,
  cta_url        text,
  media_url      text,
  state          text NOT NULL DEFAULT 'draft',
  publish_at     timestamptz,
  published_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gbp_posts_location ON gbp_posts (location_id, publish_at DESC);

-- 8. Photo bank (existing GBP media backfilled at connect + owner uploads).
CREATE TABLE IF NOT EXISTS gbp_photo_bank (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     uuid NOT NULL,
  source          text NOT NULL DEFAULT 'gbp_existing',
  media_format    text,
  google_media_id text,
  source_url      text,
  thumbnail_url   text,
  description     text,
  uploaded_by     uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gbp_photo_bank_unique UNIQUE (location_id, google_media_id)
);
CREATE INDEX IF NOT EXISTS idx_gbp_photo_bank_location ON gbp_photo_bank (location_id);

-- 9. Keywords (rank-tracking targets).
CREATE TABLE IF NOT EXISTS gbp_keywords (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL,
  keyword     text NOT NULL,
  locale      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gbp_keywords_unique UNIQUE (location_id, keyword)
);

-- 10. Rank snapshots (DataForSEO local-pack results over time).
CREATE TABLE IF NOT EXISTS gbp_rank_snapshots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL,
  keyword_id  uuid,
  rank        integer,
  found       boolean NOT NULL DEFAULT false,
  provider    text NOT NULL DEFAULT 'dataforseo',
  captured_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gbp_rank_snapshots_location ON gbp_rank_snapshots (location_id, captured_at DESC);

-- 11. Monthly reports.
CREATE TABLE IF NOT EXISTS gbp_reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id  uuid NOT NULL,
  period_start date NOT NULL,
  period_end   date NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gbp_reports_location ON gbp_reports (location_id, period_end DESC);

-- 12. Content checks (claims guard verdicts before any GBP write).
CREATE TABLE IF NOT EXISTS gbp_content_checks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id    uuid NOT NULL,
  subject_type   text NOT NULL,
  subject_id     uuid,
  verdict        text NOT NULL DEFAULT 'pending',
  findings       jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_kind   text,
  content_ref    uuid,
  stripped_claims jsonb NOT NULL DEFAULT '[]'::jsonb,
  rewritten_text text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gbp_content_checks_location ON gbp_content_checks (location_id, created_at DESC);

-- 13. Approval settings (auto-reply thresholds / quiet hours per location).
CREATE TABLE IF NOT EXISTS gbp_approval_settings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id    uuid NOT NULL,
  auto_reply     boolean NOT NULL DEFAULT false,
  min_star_auto  integer NOT NULL DEFAULT 4,
  quiet_hours    jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gbp_approval_settings_unique UNIQUE (location_id)
);

-- 14. Edit feedback (owner edits to AI drafts feed voice calibration).
CREATE TABLE IF NOT EXISTS gbp_edit_feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL,
  response_id uuid,
  original    text,
  edited      text,
  delta       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gbp_edit_feedback_location ON gbp_edit_feedback (location_id);

-- 15. API health events (quota/backoff/circuit-breaker telemetry for google-client).
CREATE TABLE IF NOT EXISTS gbp_api_health_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id    uuid,
  endpoint       text NOT NULL,
  method         text NOT NULL DEFAULT 'GET',
  status_code    integer,
  ok             boolean NOT NULL DEFAULT false,
  error_code     text,
  quota_exceeded boolean NOT NULL DEFAULT false,
  latency_ms     integer,
  attempt        integer NOT NULL DEFAULT 1,
  circuit_state  text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gbp_api_health_endpoint ON gbp_api_health_events (endpoint, created_at DESC);

-- 16. Pub/Sub notification watches (optional webhook that keeps reviews current).
CREATE TABLE IF NOT EXISTS gbp_notification_watches (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id          uuid,
  google_account_id    text,
  topic                text,
  subscription         text,
  state                text NOT NULL DEFAULT 'active',
  last_notification_at timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gbp_notification_watches_location ON gbp_notification_watches (location_id);

-- ── Review Response Engine additions (Feature F1-005) ──────────────────────────
ALTER TABLE gbp_reviews ADD COLUMN IF NOT EXISTS risk_tier         text;
ALTER TABLE gbp_reviews ADD COLUMN IF NOT EXISTS risk_reasons      jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE gbp_reviews ADD COLUMN IF NOT EXISTS classified_at     timestamptz;
ALTER TABLE gbp_reviews ADD COLUMN IF NOT EXISTS draft_reply       text;
ALTER TABLE gbp_reviews ADD COLUMN IF NOT EXISTS draft_response_id uuid;
ALTER TABLE gbp_reviews ADD COLUMN IF NOT EXISTS draft_generated_at timestamptz;
ALTER TABLE gbp_reviews ADD COLUMN IF NOT EXISTS draft_model       text;
ALTER TABLE gbp_reviews ADD COLUMN IF NOT EXISTS approval_status   text NOT NULL DEFAULT 'pending';
ALTER TABLE gbp_reviews ADD COLUMN IF NOT EXISTS approved_at       timestamptz;
ALTER TABLE gbp_reviews ADD COLUMN IF NOT EXISTS published_at      timestamptz;
ALTER TABLE gbp_reviews ADD COLUMN IF NOT EXISTS escalated         boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_gbp_reviews_approval_status ON gbp_reviews (location_id, approval_status, review_created_at DESC);

-- ── Operator Escalation Queue additions (Feature F1-010) ──────────────────────
CREATE TABLE IF NOT EXISTS gbp_escalations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id          uuid,
  location_id        uuid NOT NULL,
  severity           text NOT NULL DEFAULT 'medium',
  category           text NOT NULL DEFAULT 'sensitive',
  agent_rationale    text,
  drafted_reply      text,
  edited_reply       text,
  action             text NOT NULL DEFAULT 'open',
  action_taken_by    uuid,
  action_note        text,
  action_taken_at    timestamptz,
  dismissed_reason   text,
  token_cost_input   integer NOT NULL DEFAULT 0,
  token_cost_output  integer NOT NULL DEFAULT 0,
  provider_spend_usd numeric(12,4) NOT NULL DEFAULT 0,
  quota_units        integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gbp_escalations_location_status ON gbp_escalations (location_id, action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gbp_escalations_review ON gbp_escalations (review_id);

CREATE TABLE IF NOT EXISTS gbp_automation_pauses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope            text NOT NULL DEFAULT 'location',
  location_id      uuid,
  is_paused        boolean NOT NULL DEFAULT false,
  reason           text,
  paused_by        uuid,
  paused_at        timestamptz,
  resume_at        timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gbp_automation_pauses_unique_scope UNIQUE (scope, location_id)
);
CREATE INDEX IF NOT EXISTS idx_gbp_automation_pauses_scope ON gbp_automation_pauses (scope, is_paused);

CREATE INDEX IF NOT EXISTS idx_gbp_api_health_location_created
  ON gbp_api_health_events (location_id, created_at DESC);
`;
