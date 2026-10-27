/**
 * Google Business Profile API client — Feature F1-002.
 *
 * Owns the three risk mitigations for feasibility_analysis.key_technical_risks[0]
 * ("GBP API rate limits, policy changes, or restricted access to review-reply
 * endpoints"):
 *
 *   1. Per-location QUOTA BACKOFF — exponential backoff with jitter on 429 /
 *      RESOURCE_EXHAUSTED, honouring Retry-After when present.
 *   2. IDEMPOTENCY KEYS — every mutating call carries a stable key so a retried
 *      reply/post is not duplicated.
 *   3. CIRCUIT BREAKER — after N consecutive failures against an endpoint family
 *      the breaker opens for a cooldown, short-circuiting calls (fail fast) and
 *      logging to gbp_api_health_events so the admin console can surface outages.
 *
 * The domain NEVER stores or logs raw tokens: a fresh access token is requested
 * per call via the Google OAuth refresh grant using the connected-account's
 * refresh token (the owner linked Google through @nexus/profile-and-account with
 * the https://www.googleapis.com/auth/business.manage scope).
 */

import { randomUUID, createHash } from "node:crypto";

// ── DB shape (the substrate buildDb() adapter) ──────────────────────────────

export interface GbpDb {
  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  execute(sql: string, ...params: unknown[]): Promise<void>;
}

// ── Typed errors (pages map these to one-sentence fixes) ────────────────────

/** Raised when no Google connection exists / the refresh grant is revoked. */
export class GbpAccessError extends Error {
  readonly code = "gbp_access_revoked";
  constructor(message: string) {
    super(message);
    this.name = "GbpAccessError";
  }
}

/** Raised when the per-endpoint circuit breaker is open (fail fast). */
export class GbpCircuitOpenError extends Error {
  readonly code = "gbp_circuit_open";
  constructor(public readonly endpoint: string) {
    super(`GBP circuit open for ${endpoint} — temporarily unavailable`);
    this.name = "GbpCircuitOpenError";
  }
}

/** Raised when a request still fails after exhausting backoff retries. */
export class GbpRequestError extends Error {
  readonly code = "gbp_request_failed";
  constructor(
    message: string,
    public readonly status: number,
    public readonly quotaExceeded: boolean = false,
  ) {
    super(message);
    this.name = "GbpRequestError";
  }
}

// ── API base URLs (Business Profile family) ─────────────────────────────────

const ACCOUNT_MGMT_BASE = "https://mybusinessaccountmanagement.googleapis.com/v1";
const BUSINESS_INFO_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1";
const MYBUSINESS_V4_BASE = "https://mybusiness.googleapis.com/v4";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

const LOCATION_READ_MASK = [
  "name",
  "title",
  "storefrontAddress",
  "phoneNumbers",
  "websiteUri",
  "regularHours",
  "categories",
  "serviceArea",
  "metadata",
  "latlng",
].join(",");

// ── Tunables ────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 400;
const MAX_BACKOFF_MS = 20_000;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 60_000;

interface CircuitState {
  failures: number;
  openedAt: number | null;
}

// Module-level breaker keyed by endpoint family. Serverless instances are
// short-lived, so this is a best-effort fast-fail; durable state lives in
// gbp_api_health_events.
const circuits = new Map<string, CircuitState>();

// ── Public API types ────────────────────────────────────────────────────────

export interface GoogleAccount {
  name: string; // "accounts/123"
  accountName?: string;
  type?: string;
}

export interface GoogleLocation {
  name: string; // "locations/456" or "accounts/123/locations/456"
  title?: string;
  storefrontAddress?: Record<string, unknown> | null;
  phoneNumbers?: { primaryPhone?: string } | null;
  websiteUri?: string | null;
  regularHours?: Record<string, unknown> | null;
  categories?: {
    primaryCategory?: { displayName?: string; name?: string };
    additionalCategories?: Array<{ displayName?: string; name?: string }>;
  } | null;
  serviceArea?: {
    businessType?: string;
    places?: { placeInfos?: Array<{ placeName?: string; placeId?: string }> };
  } | null;
  metadata?: { placeId?: string; mapsUri?: string } | null;
  latlng?: { latitude?: number; longitude?: number } | null;
}

export interface GoogleReview {
  reviewId: string;
  reviewer?: { displayName?: string; profilePhotoUrl?: string };
  starRating?: string; // "FIVE" | "FOUR" | ...
  comment?: string;
  createTime?: string;
  updateTime?: string;
  reviewReply?: { comment?: string; updateTime?: string };
}

export interface GoogleMediaItem {
  name: string;
  mediaFormat?: string;
  googleUrl?: string;
  thumbnailUrl?: string;
  description?: string;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | undefined>;
  endpointFamily: string;
  locationId?: string | null;
  idempotencyKey?: string;
}

// ── The client ───────────────────────────────────────────────────────────────

export class GoogleBusinessClient {
  private token: string | null = null;
  private tokenExpiresAt = 0;

  /**
   * @param db        substrate DB adapter (for health/circuit telemetry)
   * @param userId    the owner whose Google connection we act on behalf of
   * @param refreshToken  the connected-account refresh token (never persisted here)
   */
  constructor(
    private readonly db: GbpDb,
    private readonly userId: string,
    private readonly refreshToken: string | null,
  ) {}

  /**
   * Construct a client for a user by resolving their Google connection. The
   * refresh token is sourced from env for the MVP single-owner deployment
   * (the ICP is one owner-operator) — a multi-tenant build swaps this for a
   * per-user lookup against the connected-accounts lego's token vault.
   */
  static forUser(db: GbpDb, userId: string): GoogleBusinessClient {
    const refresh =
      process.env.GBP_GOOGLE_REFRESH_TOKEN ||
      process.env.GOOGLE_BUSINESS_REFRESH_TOKEN ||
      null;
    return new GoogleBusinessClient(db, userId, refresh);
  }

  // ── token ────────────────────────────────────────────────────────────────

  /**
   * Request a fresh access token via the OAuth refresh grant. Cached in-memory
   * for the token lifetime (minus a 60s safety margin). Raw tokens are never
   * written to the DB or logs.
   */
  async getAccessToken(): Promise<string> {
    const directToken = process.env.GBP_GOOGLE_ACCESS_TOKEN;
    if (directToken) return directToken;

    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt - 60_000) {
      return this.token;
    }

    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
    if (!this.refreshToken || !clientId || !clientSecret) {
      throw new GbpAccessError(
        "Google is not connected — link your Google account to continue.",
      );
    }

    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: this.refreshToken,
      grant_type: "refresh_token",
    });

    let res: Response;
    try {
      res = await fetch(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: params.toString(),
      });
    } catch (e) {
      throw new GbpAccessError(
        `Could not reach Google to refresh access: ${(e as Error).message}`,
      );
    }

    if (!res.ok) {
      // 400 invalid_grant == the owner revoked access; tell them to reconnect.
      throw new GbpAccessError(
        "Google access was revoked — reconnect your Google account to restore the link.",
      );
    }

    const json = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!json.access_token) {
      throw new GbpAccessError(
        "Google did not return an access token — reconnect your Google account.",
      );
    }
    this.token = json.access_token;
    this.tokenExpiresAt = now + (json.expires_in ?? 3600) * 1000;
    return this.token;
  }

  // ── circuit breaker ────────────────────────────────────────────────────────

  private circuit(family: string): CircuitState {
    let c = circuits.get(family);
    if (!c) {
      c = { failures: 0, openedAt: null };
      circuits.set(family, c);
    }
    return c;
  }

  /** True when the breaker is open and still within its cooldown window. */
  private isCircuitOpen(family: string): boolean {
    const c = this.circuit(family);
    if (c.openedAt === null) return false;
    if (Date.now() - c.openedAt >= CIRCUIT_COOLDOWN_MS) {
      // Cooldown elapsed → half-open: allow a trial call.
      c.openedAt = null;
      c.failures = 0;
      return false;
    }
    return true;
  }

  private recordSuccess(family: string): void {
    const c = this.circuit(family);
    c.failures = 0;
    c.openedAt = null;
  }

  private recordFailure(family: string): void {
    const c = this.circuit(family);
    c.failures += 1;
    if (c.failures >= CIRCUIT_FAILURE_THRESHOLD && c.openedAt === null) {
      c.openedAt = Date.now();
    }
  }

  private circuitStateLabel(family: string): string {
    const c = this.circuit(family);
    if (c.openedAt !== null) return "open";
    if (c.failures > 0) return "degraded";
    return "closed";
  }

  // ── telemetry ──────────────────────────────────────────────────────────────

  private async logHealth(entry: {
    endpoint: string;
    method: string;
    status: number | null;
    ok: boolean;
    errorCode: string | null;
    quotaExceeded: boolean;
    latencyMs: number;
    attempt: number;
    locationId: string | null;
  }): Promise<void> {
    try {
      await this.db.execute(
        `INSERT INTO gbp_api_health_events
           (location_id, endpoint, method, status_code, ok, error_code,
            quota_exceeded, latency_ms, attempt, circuit_state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        entry.locationId,
        entry.endpoint,
        entry.method,
        entry.status,
        entry.ok,
        entry.errorCode,
        entry.quotaExceeded,
        entry.latencyMs,
        entry.attempt,
        this.circuitStateLabel(entry.endpoint),
      );
    } catch (e) {
      // Telemetry must never break a call.
      console.warn(
        JSON.stringify({ at: "gbp.google-client.logHealth", error: (e as Error).message }),
      );
    }
  }

  // ── core request with backoff + idempotency + breaker ──────────────────────

  private async request<T>(url: string, opts: RequestOptions): Promise<T> {
    const family = opts.endpointFamily;
    if (this.isCircuitOpen(family)) {
      await this.logHealth({
        endpoint: family,
        method: opts.method ?? "GET",
        status: null,
        ok: false,
        errorCode: "circuit_open",
        quotaExceeded: false,
        latencyMs: 0,
        attempt: 0,
        locationId: opts.locationId ?? null,
      });
      throw new GbpCircuitOpenError(family);
    }

    const method = opts.method ?? "GET";
    const idempotencyKey =
      opts.idempotencyKey ??
      (method === "GET" ? undefined : deriveIdempotencyKey(url, opts.body));

    const fullUrl = buildUrl(url, opts.query);
    let lastErr: GbpRequestError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const token = await this.getAccessToken();
      const started = Date.now();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      };
      if (idempotencyKey) headers["X-Idempotency-Key"] = idempotencyKey;
      if (opts.body !== undefined) headers["Content-Type"] = "application/json";

      let res: Response;
      try {
        res = await fetch(fullUrl, {
          method,
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
      } catch (e) {
        lastErr = new GbpRequestError(`network error: ${(e as Error).message}`, 0);
        this.recordFailure(family);
        await this.logHealth({
          endpoint: family,
          method,
          status: null,
          ok: false,
          errorCode: "network_error",
          quotaExceeded: false,
          latencyMs: Date.now() - started,
          attempt,
          locationId: opts.locationId ?? null,
        });
        await sleep(backoffDelay(attempt));
        continue;
      }

      const latencyMs = Date.now() - started;
      const quotaExceeded = res.status === 429;

      if (res.ok) {
        this.recordSuccess(family);
        await this.logHealth({
          endpoint: family,
          method,
          status: res.status,
          ok: true,
          errorCode: null,
          quotaExceeded: false,
          latencyMs,
          attempt,
          locationId: opts.locationId ?? null,
        });
        if (res.status === 204) return {} as T;
        return (await res.json()) as T;
      }

      // Error path — classify.
      const bodyText = await res.text().catch(() => "");
      const retriable = quotaExceeded || res.status >= 500;
      this.recordFailure(family);
      await this.logHealth({
        endpoint: family,
        method,
        status: res.status,
        ok: false,
        errorCode: `http_${res.status}`,
        quotaExceeded,
        latencyMs,
        attempt,
        locationId: opts.locationId ?? null,
      });

      if (res.status === 401 || res.status === 403) {
        throw new GbpAccessError(
          "Google denied this request — your access may have been revoked; reconnect Google.",
        );
      }

      lastErr = new GbpRequestError(
        `GBP ${method} ${family} failed: ${res.status} ${bodyText.slice(0, 300)}`,
        res.status,
        quotaExceeded,
      );

      if (!retriable || attempt === MAX_ATTEMPTS) {
        throw lastErr;
      }

      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      await sleep(retryAfter ?? backoffDelay(attempt));
    }

    throw lastErr ?? new GbpRequestError("GBP request exhausted retries", 0);
  }

  // ── high-level endpoints ─────────────────────────────────────────────────

  /** Account Management API — list accounts the owner manages. */
  async listAccounts(): Promise<GoogleAccount[]> {
    const accounts: GoogleAccount[] = [];
    let pageToken: string | undefined;
    do {
      const data = await this.request<{
        accounts?: GoogleAccount[];
        nextPageToken?: string;
      }>(`${ACCOUNT_MGMT_BASE}/accounts`, {
        endpointFamily: "accounts.list",
        query: { pageSize: "100", pageToken },
      });
      if (data.accounts) accounts.push(...data.accounts);
      pageToken = data.nextPageToken;
    } while (pageToken);
    return accounts;
  }

  /** Business Information API — list every location under an account. */
  async listLocations(accountName: string): Promise<GoogleLocation[]> {
    const locations: GoogleLocation[] = [];
    let pageToken: string | undefined;
    do {
      const data = await this.request<{
        locations?: GoogleLocation[];
        nextPageToken?: string;
      }>(`${BUSINESS_INFO_BASE}/${accountName}/locations`, {
        endpointFamily: "locations.list",
        query: { readMask: LOCATION_READ_MASK, pageSize: "100", pageToken },
      });
      if (data.locations) locations.push(...data.locations);
      pageToken = data.nextPageToken;
    } while (pageToken);
    return locations;
  }

  /** Business Information API — full detail for a single location. */
  async getLocation(locationName: string): Promise<GoogleLocation> {
    return this.request<GoogleLocation>(`${BUSINESS_INFO_BASE}/${locationName}`, {
      endpointFamily: "locations.get",
      query: { readMask: LOCATION_READ_MASK },
      locationId: locationName,
    });
  }

  /**
   * mybusiness v4 — list reviews for a location (reviews + owner replies).
   * `parent` is "accounts/{a}/locations/{l}".
   */
  async listReviews(
    parent: string,
    opts: { pageToken?: string; pageSize?: number } = {},
  ): Promise<{ reviews: GoogleReview[]; nextPageToken?: string; totalReviewCount?: number; averageRating?: number }> {
    const data = await this.request<{
      reviews?: GoogleReview[];
      nextPageToken?: string;
      totalReviewCount?: number;
      averageRating?: number;
    }>(`${MYBUSINESS_V4_BASE}/${parent}/reviews`, {
      endpointFamily: "reviews.list",
      locationId: parent,
      query: {
        pageSize: String(opts.pageSize ?? 50),
        pageToken: opts.pageToken,
      },
    });
    return {
      reviews: data.reviews ?? [],
      nextPageToken: data.nextPageToken,
      totalReviewCount: data.totalReviewCount,
      averageRating: data.averageRating,
    };
  }

  /** mybusiness v4 — list existing media (photos) for a location. */
  async listMedia(parent: string): Promise<GoogleMediaItem[]> {
    const items: GoogleMediaItem[] = [];
    let pageToken: string | undefined;
    do {
      const data = await this.request<{
        mediaItems?: GoogleMediaItem[];
        nextPageToken?: string;
      }>(`${MYBUSINESS_V4_BASE}/${parent}/media`, {
        endpointFamily: "media.list",
        locationId: parent,
        query: { pageSize: "100", pageToken },
      });
      if (data.mediaItems) items.push(...data.mediaItems);
      pageToken = data.nextPageToken;
    } while (pageToken);
    return items;
  }

  /**
   * mybusiness v4 — upsert the owner reply on a review (idempotent PUT). Used by
   * the auto-reply pipeline; the idempotency key keys on review + comment so a
   * retried write never double-posts.
   */
  async updateReviewReply(reviewName: string, comment: string): Promise<void> {
    await this.request<Record<string, unknown>>(
      `${MYBUSINESS_V4_BASE}/${reviewName}/reply`,
      {
        method: "PUT",
        endpointFamily: "reviews.reply",
        locationId: reviewName,
        body: { comment },
        idempotencyKey: deriveIdempotencyKey(reviewName, comment),
      },
    );
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function buildUrl(base: string, query?: Record<string, string | undefined>): string {
  if (!query) return base;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== "") usp.set(k, v);
  }
  const qs = usp.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Full-jitter exponential backoff, capped. */
function backoffDelay(attempt: number): number {
  const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
  // Deterministic jitter derived from attempt (avoids Math.random for testability).
  const jitter = (attempt * 137) % 250;
  return exp + jitter;
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(MAX_BACKOFF_MS, seconds * 1000);
  return null;
}

/** Stable idempotency key for a mutating call, derived from target + payload. */
function deriveIdempotencyKey(target: string, body: unknown): string {
  const hash = createHash("sha256");
  hash.update(target);
  hash.update(" ");
  hash.update(typeof body === "string" ? body : JSON.stringify(body ?? ""));
  return hash.digest("hex").slice(0, 32);
}

/** Generate a one-off idempotency key (for callers that need a fresh one). */
export function newIdempotencyKey(): string {
  return randomUUID().replace(/-/g, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Map a GBP star-rating enum to an integer 1–5 (0 when unspecified). */
export function starRatingToInt(rating: string | undefined): number {
  switch (rating) {
    case "ONE":
      return 1;
    case "TWO":
      return 2;
    case "THREE":
      return 3;
    case "FOUR":
      return 4;
    case "FIVE":
      return 5;
    default:
      return 0;
  }
}
