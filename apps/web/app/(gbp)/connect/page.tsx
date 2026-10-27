/**
 * /connect — the one-step GBP connect flow (Feature F1-002).
 *
 * For hidden-address service-area businesses we onboard via the Google
 * connection, NEVER a Maps lookup (customer_evidence objection: "these tools
 * can't even find me"). After the owner links Google through
 * @nexus/profile-and-account, this page lists every location the account
 * manages; the owner taps one and we backfill categories, service areas,
 * hours, phone, existing media, and the full review history.
 *
 * Server component by default. The managed-location fetch (a network call to
 * the GBP API) is wrapped in <Suspense> so the owner sees a card skeleton while
 * it loads. Error + empty states explain the exact fix in one sentence.
 */

import type { JSX } from "react";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { buildDb } from "@/lib/db";
import { getSessionUser } from "@/lib/admin-auth";
import {
  listManagedLocations,
  getLinkedLocationCards,
  hasGoogleConnection,
  type ManagedLocation,
  type LinkedLocationCard,
} from "@/lib/gbp/locations";
import { GbpAccessError } from "@/lib/gbp/google-client";
import { linkLocationFormAction } from "./actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ── page ─────────────────────────────────────────────────────────────────────

export default async function ConnectPage(): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const db = buildDb();
  const connected = await hasGoogleConnection(db, user.id);
  const linked = await getLinkedLocationCards(db, user.id);

  return (
    <main>
      <h1>Connect your Google Business Profile</h1>
      <p>
        We onboard straight from your Google connection — no Maps lookup, no
        &ldquo;we can&rsquo;t find you.&rdquo; Link Google once and tap the
        location you want us to manage.
      </p>

      {!connected ? (
        <ConnectCard />
      ) : (
        <>
          {linked.length > 0 && <LinkedLocations cards={linked} />}
          <Suspense fallback={<LocationSkeleton />}>
            {/* Network call to the GBP Account Management API. */}
            <ManagedLocations userId={user.id} />
          </Suspense>
        </>
      )}
    </main>
  );
}

// ── not-connected: single centered card with the Google 'G' button ───────────

function ConnectCard(): JSX.Element {
  return (
    <section className="card" style={{ textAlign: "center", maxWidth: 420, margin: "2rem auto" }}>
      <h2>One tap to start</h2>
      <p className="muted">
        Connect the Google account that manages your Business Profile. We only
        request the Business Profile scope — we never touch your inbox.
      </p>
      <p>
        <a className="btn" href="/api/auth/oauth/google/start">
          <GoogleG /> Connect Google
        </a>
      </p>
    </section>
  );
}

/** The Google 'G' mark — the only accent element on the connect card. */
function GoogleG(): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 48 48"
      width="18"
      height="18"
      style={{ verticalAlign: "middle", marginRight: 8 }}
    >
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.1 0 24 0 14.6 0 6.4 5.4 2.6 13.2l7.8 6.1C12.2 13.1 17.6 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9.1h12.4c-.5 2.9-2.1 5.3-4.6 7l7.1 5.5c4.2-3.9 6.6-9.6 6.6-16z" />
      <path fill="#FBBC05" d="M10.4 28.3a14.5 14.5 0 0 1 0-8.6l-7.8-6.1a24 24 0 0 0 0 20.8l7.8-6.1z" />
      <path fill="#34A853" d="M24 48c6.1 0 11.3-2 15.1-5.5l-7.1-5.5c-2 1.3-4.5 2.1-8 2.1-6.4 0-11.8-3.6-13.6-8.8l-7.8 6.1C6.4 42.6 14.6 48 24 48z" />
    </svg>
  );
}

// ── connected: already-linked location cards ─────────────────────────────────

function LinkedLocations({ cards }: { cards: LinkedLocationCard[] }): JSX.Element {
  return (
    <section>
      <h2>Your connected locations</h2>
      {cards.map((c) => (
        <LocationRow key={c.id} card={c} />
      ))}
    </section>
  );
}

function LocationRow({ card }: { card: LinkedLocationCard }): JSX.Element {
  const badge =
    card.businessType === "service_area" ? "Service area" : "Storefront";
  return (
    <article className="card">
      <h3>{card.title}</h3>
      <p className="muted">
        <span>{badge}</span>
        {card.primaryCategory ? ` · ${card.primaryCategory}` : ""}
      </p>
      <p>
        {card.reviewCount} review{card.reviewCount === 1 ? "" : "s"}
        {card.averageRating !== null ? ` · ${card.averageRating.toFixed(1)}★` : ""}
      </p>
      <LastPostChip card={card} />
    </article>
  );
}

/** "Last post X days ago" chip — warning color when stale (>60 days, the ICP trigger). */
function LastPostChip({ card }: { card: LinkedLocationCard }): JSX.Element {
  if (card.lastPostAgoDays === null) {
    return (
      <p>
        <span style={{ color: "#b45309", fontWeight: 600 }}>No posts yet</span>
      </p>
    );
  }
  const stale = card.needsAttention;
  return (
    <p>
      <span style={stale ? { color: "#b45309", fontWeight: 600 } : undefined}>
        Last post {card.lastPostAgoDays} day{card.lastPostAgoDays === 1 ? "" : "s"} ago
      </span>
    </p>
  );
}

// ── connected: locations the account manages (tap to link) ───────────────────

async function ManagedLocations({ userId }: { userId: string }): Promise<JSX.Element> {
  let managed: ManagedLocation[];
  try {
    managed = await listManagedLocations(buildDb(), userId);
  } catch (e) {
    return <ErrorState error={e} />;
  }

  const unlinked = managed.filter((m) => !m.alreadyLinked);
  if (managed.length === 0) {
    return <NoLocationsManaged />;
  }
  if (unlinked.length === 0) {
    return (
      <section>
        <p className="muted">
          Every location this Google account manages is already connected.
        </p>
        <p>
          <a className="btn secondary" href="/api/auth/oauth/google/start">
            Connect another Google account
          </a>
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2>Tap a location to connect</h2>
      {unlinked.map((m) => (
        <form key={m.googleLocationId} action={linkLocationFormAction} className="card">
          <input type="hidden" name="googleAccountId" value={m.googleAccountId} />
          <input type="hidden" name="googleLocationId" value={m.googleLocationId} />
          <h3>{m.title}</h3>
          <p className="muted">
            <span>{m.businessType === "service_area" ? "Service area" : "Storefront"}</span>
            {m.primaryCategory ? ` · ${m.primaryCategory}` : ""}
          </p>
          {m.serviceAreaSummary && (
            <p className="muted">Serves: {m.serviceAreaSummary}</p>
          )}
          <button type="submit">Connect this location</button>
        </form>
      ))}
      <p>
        <a className="btn secondary" href="/api/auth/oauth/google/start">
          Connect another Google account
        </a>
      </p>
    </section>
  );
}

// ── states: empty / error / loading ──────────────────────────────────────────

function NoLocationsManaged(): JSX.Element {
  return (
    <section className="empty">
      <QuietProfileIllustration />
      <p>
        This Google account doesn&rsquo;t manage any Business Profile locations
        yet — add your business in Google, then reconnect here.
      </p>
    </section>
  );
}

function ErrorState({ error }: { error: unknown }): JSX.Element {
  const message =
    error instanceof GbpAccessError
      ? error.message
      : "We couldn’t reach Google just now — reconnect your Google account and try again.";
  return (
    <section className="empty">
      <p>
        <span style={{ color: "#b45309", fontWeight: 600 }}>{message}</span>
      </p>
      <p>
        <a className="btn secondary" href="/api/auth/oauth/google/start">
          Reconnect Google
        </a>
      </p>
    </section>
  );
}

/** Card-shaped skeleton shown while the managed-location list loads. */
function LocationSkeleton(): JSX.Element {
  const bar = (w: string): JSX.Element => (
    <div
      aria-hidden="true"
      style={{
        height: 12,
        width: w,
        borderRadius: 6,
        background: "currentColor",
        opacity: 0.12,
        margin: "0.5rem 0",
      }}
    />
  );
  return (
    <section aria-busy="true" aria-label="Loading your locations">
      <div className="card">
        {bar("60%")}
        {bar("40%")}
        {bar("30%")}
      </div>
      <div className="card">
        {bar("55%")}
        {bar("45%")}
        {bar("35%")}
      </div>
    </section>
  );
}

/** Quiet-profile illustration for the empty state. */
function QuietProfileIllustration(): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 120 80"
      width="120"
      height="80"
      style={{ display: "block", margin: "0 auto 1rem", opacity: 0.5 }}
    >
      <rect x="10" y="14" width="100" height="52" rx="8" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="34" cy="34" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <line x1="52" y1="30" x2="96" y2="30" stroke="currentColor" strokeWidth="2" />
      <line x1="52" y1="40" x2="84" y2="40" stroke="currentColor" strokeWidth="2" />
      <line x1="24" y1="54" x2="96" y2="54" stroke="currentColor" strokeWidth="2" strokeDasharray="4 4" />
    </svg>
  );
}
