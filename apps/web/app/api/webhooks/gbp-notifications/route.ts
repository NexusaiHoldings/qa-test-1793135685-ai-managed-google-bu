/**
 * POST /api/webhooks/gbp-notifications — Feature F1-002.
 *
 * Optional Google Pub/Sub push webhook. When the owner's GBP notification
 * topic fires (e.g. NEW_REVIEW / UPDATED_REVIEW), Pub/Sub POSTs a base64
 * message here; we decode it, resolve the referenced location, and trigger an
 * immediate review sync so replies land fast — complementing the 30-minute
 * poll cron.
 *
 * External fixed URL → lives under /api/webhooks/* (URL-determinism exception).
 *
 * Auth: Pub/Sub push can carry a verification token in the query string
 * (?token=…) matched against GBP_PUBSUB_VERIFICATION_TOKEN, or an
 * `Authorization: Bearer` OIDC token; when neither env is set the route is
 * unguarded for local/dev. We ALWAYS ack (200) so Pub/Sub does not hot-retry a
 * poison message — processing errors are logged, not surfaced as 5xx.
 */

import { NextResponse } from "next/server";
import { buildDb } from "@/lib/db";
import { syncReviewsByGoogleName } from "@/lib/gbp/review-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

interface PubSubEnvelope {
  message?: {
    data?: string; // base64-encoded JSON
    messageId?: string;
    attributes?: Record<string, string>;
  };
  subscription?: string;
}

interface GbpNotification {
  location?: string; // "accounts/{a}/locations/{l}" or "locations/{l}"
  notificationType?: string;
}

function authorized(request: Request): boolean {
  const token = process.env.GBP_PUBSUB_VERIFICATION_TOKEN;
  if (!token) return true; // unguarded in dev

  const url = new URL(request.url);
  if (url.searchParams.get("token") === token) return true;

  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${token}`;
}

/** Decode the base64 Pub/Sub payload into a GBP notification, or null. */
function decodeNotification(envelope: PubSubEnvelope): GbpNotification | null {
  const data = envelope.message?.data;
  if (!data) return null;
  try {
    const json = Buffer.from(data, "base64").toString("utf8");
    return JSON.parse(json) as GbpNotification;
  } catch {
    return null;
  }
}

async function recordWatchPing(
  db: ReturnType<typeof buildDb>,
  subscription: string | undefined,
  location: string | null,
): Promise<void> {
  if (!subscription) return;
  try {
    await db.execute(
      `UPDATE gbp_notification_watches
          SET last_notification_at = now(), updated_at = now()
        WHERE subscription = $1`,
      subscription,
    );
  } catch (e) {
    console.warn(
      JSON.stringify({ at: "gbp.webhook.recordWatchPing", location, error: (e as Error).message }),
    );
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!authorized(request)) {
    return new NextResponse("forbidden", { status: 403 });
  }

  let envelope: PubSubEnvelope;
  try {
    envelope = (await request.json()) as PubSubEnvelope;
  } catch {
    // Malformed body — ack so Pub/Sub stops retrying.
    return NextResponse.json({ ok: false, reason: "invalid_json" });
  }

  const notification = decodeNotification(envelope);
  if (!notification?.location) {
    return NextResponse.json({ ok: true, skipped: "no_location" });
  }

  const db = buildDb();
  await recordWatchPing(db, envelope.subscription, notification.location);

  try {
    const result = await syncReviewsByGoogleName(db, notification.location);
    if (!result) {
      return NextResponse.json({ ok: true, skipped: "location_not_linked" });
    }
    console.log(
      JSON.stringify({
        at: "gbp.webhook.gbp-notifications",
        notificationType: notification.notificationType ?? "unknown",
        locationId: result.locationId,
        reviewsUpserted: result.reviewsUpserted,
        status: result.status,
      }),
    );
    return NextResponse.json({
      ok: true,
      locationId: result.locationId,
      reviewsUpserted: result.reviewsUpserted,
    });
  } catch (e) {
    // Always ack to avoid hot-retry; log for investigation.
    console.error(
      JSON.stringify({ at: "gbp.webhook.gbp-notifications", error: (e as Error).message }),
    );
    return NextResponse.json({ ok: false, error: "processing_error" });
  }
}
