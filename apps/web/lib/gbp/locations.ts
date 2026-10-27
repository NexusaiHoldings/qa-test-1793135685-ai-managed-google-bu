/**
 * GBP location linking + backfill — Feature F1-002.
 *
 * The one-step connect flow: once the owner links Google (via
 * @nexus/profile-and-account), we list every location the account manages and,
 * when the owner taps one, backfill categories, service areas, hours, phone,
 * existing media, and the full review history into the company DB.
 *
 * All DB access is parameterized raw SQL ($1,$2,…) via the substrate buildDb()
 * adapter. All IDs are UUID.
 */

import {
  GoogleBusinessClient,
  GbpAccessError,
  type GbpDb,
  type GoogleLocation,
} from "./google-client";
import { syncReviewsForLocation } from "./review-sync";

// ── view models ──────────────────────────────────────────────────────────────

export interface ManagedLocation {
  googleAccountId: string;
  googleLocationId: string; // "accounts/{a}/locations/{l}"
  title: string;
  businessType: "storefront" | "service_area";
  primaryCategory: string | null;
  serviceAreaSummary: string | null;
  alreadyLinked: boolean;
}

export interface LinkedLocationCard {
  id: string;
  title: string;
  businessType: "storefront" | "service_area";
  primaryCategory: string | null;
  reviewCount: number;
  averageRating: number | null;
  lastPostAt: string | null;
  lastPostAgoDays: number | null;
  profileUpdatedAt: string | null;
  profileUpdatedWeeksAgo: number | null;
  needsAttention: boolean; // last post > 60 days — the ICP trigger
}

interface LocationRow {
  id: string;
  title: string | null;
  business_type: string;
  primary_category: string | null;
  review_count: number;
  average_rating: string | number | null;
  last_post_at: Date | string | null;
  profile_updated_at: Date | string | null;
}

const STALE_POST_DAYS = 60;

// ── helpers ──────────────────────────────────────────────────────────────────

function categoryName(loc: GoogleLocation): string | null {
  const c = loc.categories?.primaryCategory;
  return c?.displayName ?? c?.name ?? null;
}

function additionalCategoryNames(loc: GoogleLocation): string[] {
  return (loc.categories?.additionalCategories ?? [])
    .map((c) => c.displayName ?? c.name ?? "")
    .filter((s) => s.length > 0);
}

function serviceAreaPlaces(loc: GoogleLocation): string[] {
  return (loc.serviceArea?.places?.placeInfos ?? [])
    .map((p) => p.placeName ?? "")
    .filter((s) => s.length > 0);
}

/** Hidden-address service-area businesses report businessType CUSTOMER_LOCATION_ONLY. */
function businessType(loc: GoogleLocation): "storefront" | "service_area" {
  const t = loc.serviceArea?.businessType;
  if (t === "CUSTOMER_LOCATION_ONLY" || t === "CUSTOMER_AND_BUSINESS_LOCATION") {
    // Hidden-address (CUSTOMER_LOCATION_ONLY) is the ICP; the hybrid type still
    // has a storefront, so only the pure customer-location type is service_area.
    return t === "CUSTOMER_LOCATION_ONLY" ? "service_area" : "storefront";
  }
  return "storefront";
}

/** Normalise a GBP location resource name to "accounts/{a}/locations/{l}". */
export function qualifyLocationName(accountName: string, locationName: string): string {
  if (locationName.startsWith("accounts/")) return locationName;
  return `${accountName}/${locationName}`;
}

function daysSince(value: Date | string | null): number | null {
  if (!value) return null;
  const then = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(then)) return null;
  return Math.floor((Date.now() - then) / 86_400_000);
}

// ── list managed locations (connect page) ────────────────────────────────────

/**
 * List every location the owner's Google account manages, flagging which are
 * already linked. Throws GbpAccessError when Google is not connected / revoked
 * so the page can render the exact-fix error state.
 */
export async function listManagedLocations(
  db: GbpDb,
  userId: string,
): Promise<ManagedLocation[]> {
  const client = GoogleBusinessClient.forUser(db, userId);
  const accounts = await client.listAccounts();

  const linkedRows = await db.query<{ google_location_id: string }>(
    `SELECT google_location_id FROM gbp_locations WHERE user_id = $1`,
    userId,
  );
  const linked = new Set(linkedRows.map((r) => r.google_location_id));

  const managed: ManagedLocation[] = [];
  for (const account of accounts) {
    const locations = await client.listLocations(account.name);
    for (const loc of locations) {
      const qualified = qualifyLocationName(account.name, loc.name);
      const areas = serviceAreaPlaces(loc);
      managed.push({
        googleAccountId: account.name,
        googleLocationId: qualified,
        title: loc.title ?? "Untitled location",
        businessType: businessType(loc),
        primaryCategory: categoryName(loc),
        serviceAreaSummary: areas.length ? areas.slice(0, 3).join(", ") : null,
        alreadyLinked: linked.has(qualified),
      });
    }
  }
  return managed;
}

/** True when the user has a Google connection (business.manage) linked. */
export async function hasGoogleConnection(db: GbpDb, userId: string): Promise<boolean> {
  const rows = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM connected_accounts
      WHERE user_id = $1 AND provider = 'google'`,
    userId,
  );
  return (rows[0]?.n ?? 0) > 0;
}

// ── link + backfill ──────────────────────────────────────────────────────────

export interface LinkResult {
  locationId: string;
  title: string;
  reviewsSynced: number;
  mediaSynced: number;
}

/**
 * Link a single location: upsert its profile (categories, service areas, hours,
 * phone), backfill existing media into the photo bank, then kick off the full
 * review-history sync (which also seeds the voice profile from the owner's past
 * replies).
 */
export async function linkLocation(
  db: GbpDb,
  userId: string,
  googleAccountId: string,
  googleLocationId: string,
): Promise<LinkResult> {
  const client = GoogleBusinessClient.forUser(db, userId);

  const qualified = qualifyLocationName(googleAccountId, googleLocationId);
  const loc = await client.getLocation(qualified);

  const primaryPhone = loc.phoneNumbers?.primaryPhone ?? null;
  const placeId = loc.metadata?.placeId ?? null;
  const mapsUri = loc.metadata?.mapsUri ?? null;

  const rows = await db.query<{ id: string }>(
    `INSERT INTO gbp_locations
       (user_id, google_account_id, google_location_id, title, primary_category,
        additional_categories, business_type, service_areas, regular_hours,
        primary_phone, website_url, storefront_address, place_id, maps_uri,
        profile_updated_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now(), now())
     ON CONFLICT (user_id, google_location_id) DO UPDATE SET
       google_account_id     = EXCLUDED.google_account_id,
       title                 = EXCLUDED.title,
       primary_category      = EXCLUDED.primary_category,
       additional_categories = EXCLUDED.additional_categories,
       business_type         = EXCLUDED.business_type,
       service_areas         = EXCLUDED.service_areas,
       regular_hours         = EXCLUDED.regular_hours,
       primary_phone         = EXCLUDED.primary_phone,
       website_url           = EXCLUDED.website_url,
       storefront_address    = EXCLUDED.storefront_address,
       place_id              = EXCLUDED.place_id,
       maps_uri              = EXCLUDED.maps_uri,
       profile_updated_at    = now(),
       updated_at            = now()
     RETURNING id`,
    userId,
    googleAccountId,
    qualified,
    loc.title ?? "Untitled location",
    categoryName(loc),
    JSON.stringify(additionalCategoryNames(loc)),
    businessType(loc),
    JSON.stringify(serviceAreaPlaces(loc)),
    JSON.stringify(loc.regularHours ?? {}),
    primaryPhone,
    loc.websiteUri ?? null,
    loc.storefrontAddress ? JSON.stringify(loc.storefrontAddress) : null,
    placeId,
    mapsUri,
  );

  const locationId = rows[0]?.id;
  if (!locationId) {
    throw new GbpAccessError("Could not persist the linked location — please retry.");
  }

  const mediaSynced = await backfillMedia(db, client, locationId, qualified, userId);
  const review = await syncReviewsForLocation(db, locationId, {
    userId,
    parent: qualified,
    kind: "backfill",
  });

  return {
    locationId,
    title: loc.title ?? "Untitled location",
    reviewsSynced: review.reviewsUpserted,
    mediaSynced,
  };
}

/** Backfill the location's existing GBP media into the photo bank. */
async function backfillMedia(
  db: GbpDb,
  client: GoogleBusinessClient,
  locationId: string,
  parent: string,
  userId: string,
): Promise<number> {
  let items;
  try {
    items = await client.listMedia(parent);
  } catch (e) {
    // Media is non-critical to the link; log and continue.
    console.warn(
      JSON.stringify({ at: "gbp.locations.backfillMedia", locationId, error: (e as Error).message }),
    );
    return 0;
  }

  let count = 0;
  for (const item of items) {
    await db.execute(
      `INSERT INTO gbp_photo_bank
         (location_id, source, media_format, google_media_id, source_url,
          thumbnail_url, description, uploaded_by)
       VALUES ($1,'gbp_existing',$2,$3,$4,$5,$6,$7)
       ON CONFLICT (location_id, google_media_id) DO UPDATE SET
         source_url    = EXCLUDED.source_url,
         thumbnail_url = EXCLUDED.thumbnail_url,
         description   = EXCLUDED.description`,
      locationId,
      item.mediaFormat ?? null,
      item.name,
      item.googleUrl ?? null,
      item.thumbnailUrl ?? null,
      item.description ?? null,
      userId,
    );
    count += 1;
  }

  await db.execute(
    `UPDATE gbp_locations SET media_count = $2, updated_at = now() WHERE id = $1`,
    locationId,
    count,
  );
  return count;
}

// ── linked location cards (connect page, post-connect) ───────────────────────

/** Fetch linked locations as render-ready cards for the connect page. */
export async function getLinkedLocationCards(
  db: GbpDb,
  userId: string,
): Promise<LinkedLocationCard[]> {
  const rows = await db.query<LocationRow>(
    `SELECT id, title, business_type, primary_category, review_count,
            average_rating, last_post_at, profile_updated_at
       FROM gbp_locations
      WHERE user_id = $1
      ORDER BY linked_at DESC`,
    userId,
  );

  return rows.map((r) => {
    const lastPostAgoDays = daysSince(r.last_post_at);
    const profileDays = daysSince(r.profile_updated_at);
    const avg =
      r.average_rating === null || r.average_rating === undefined
        ? null
        : Number(r.average_rating);
    return {
      id: r.id,
      title: r.title ?? "Untitled location",
      businessType: (r.business_type as "storefront" | "service_area") ?? "storefront",
      primaryCategory: r.primary_category,
      reviewCount: r.review_count ?? 0,
      averageRating: avg !== null && Number.isFinite(avg) ? avg : null,
      lastPostAt: r.last_post_at ? new Date(r.last_post_at).toISOString() : null,
      lastPostAgoDays,
      profileUpdatedAt: r.profile_updated_at
        ? new Date(r.profile_updated_at).toISOString()
        : null,
      profileUpdatedWeeksAgo: profileDays === null ? null : Math.floor(profileDays / 7),
      needsAttention: lastPostAgoDays === null ? true : lastPostAgoDays > STALE_POST_DAYS,
    };
  });
}
