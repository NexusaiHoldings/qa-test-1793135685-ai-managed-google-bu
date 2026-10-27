import { getSessionUser } from "@/lib/admin-auth";
import { redirect } from "next/navigation";
import { Pool } from "pg";
import { calibrateVoiceAction, approveVoiceAction } from "./actions";
import { upsertVoiceProfileForUser } from "@/lib/gbp/voice-profile";
import { getVoiceSamples } from "@/lib/gbp/voice-samples";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

type VoiceState = {
  locationId: string;
  approved: boolean;
  title: string | null;
};

async function getVoiceState(userId: string): Promise<VoiceState | null> {
  const query = `
    SELECT l.id AS location_id, l.title, COALESCE(vp.approved, false) AS approved
    FROM gbp_locations l
    LEFT JOIN gbp_voice_profiles vp ON vp.location_id = l.id
    WHERE l.user_id = $1
    ORDER BY l.linked_at ASC
    LIMIT 1
  `;
  const res = await pool.query<{ location_id: string; title: string | null; approved: boolean }>(query, [userId]);
  if (res.rowCount === 0) return null;
  return {
    locationId: res.rows[0].location_id,
    approved: res.rows[0].approved,
    title: res.rows[0].title,
  };
}

export default async function VoicePage(): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const userId = user.id;

  const state = await getVoiceState(userId);
  if (!state) {
    return (
      <main>
        <h1>Voice calibration</h1>
        <p>Connect a Google Business Profile location first, then we’ll calibrate your reply voice.</p>
        <div className="empty">No location connected yet.</div>
      </main>
    );
  }

  const profile = await upsertVoiceProfileForUser(userId);
  const samples = await getVoiceSamples(state.locationId);

  return (
    <main>
      <h1>Voice calibration</h1>
      <p>
        We build your reply style from your real reviews and past language first. Nothing automates until you approve it.
      </p>

      {!profile && (
        <form
          action={async (): Promise<void> => {
            "use server";
            await calibrateVoiceAction();
          }}
        >
          <button type="submit">Generate voice profile</button>
        </form>
      )}

      {profile && profile.route === "tone-picker" && (
        <section className="card">
          <h2>Quick tone picker</h2>
          <p className="muted">
            You have fewer than 5 written reviews, so we’ll start with a short preference setup instead of side-by-side
            samples.
          </p>
          <form
            action={async (formData: FormData): Promise<void> => {
              "use server";
              await calibrateVoiceAction(formData);
            }}
          >
            <label htmlFor="greeting">How do you usually open replies?</label>
            <select id="greeting" name="greeting" defaultValue="thanks">
              <option value="thanks">Simple thanks</option>
              <option value="name">Use customer name + thanks</option>
              <option value="direct">Direct and brief</option>
            </select>

            <label htmlFor="formality">Formality</label>
            <select id="formality" name="formality" defaultValue="balanced">
              <option value="casual">Casual</option>
              <option value="balanced">Balanced</option>
              <option value="formal">Formal</option>
            </select>

            <label htmlFor="signoff">Sign-off style</label>
            <select id="signoff" name="signoff" defaultValue="team">
              <option value="team">From the team</option>
              <option value="owner">Owner first-name sign-off</option>
              <option value="none">No sign-off</option>
            </select>

            <label htmlFor="never">Anything you never want to say</label>
            <input id="never" name="never" placeholder="e.g. guaranteed results, salesy language" />

            <button type="submit">Save tone and continue</button>
          </form>
        </section>
      )}

      {profile && profile.route === "samples" && (
        <section>
          <p className="muted">
            {state.title ? `${state.title} · ` : ""}
            {profile.sampleCount} review samples found
          </p>

          {samples.length === 0 ? (
            <div className="empty">No written reviews yet. Add at least one review comment to preview voice matching.</div>
          ) : (
            <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {samples.map((sample, idx) => (
                <li key={sample.reviewId} className="card" style={{ marginBottom: "1rem" }}>
                  <p className="muted">Progress: {idx + 1} of {samples.length}</p>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr",
                      gap: "0.75rem",
                    }}
                  >
                    <div className="card" style={{ background: "var(--muted-bg, rgba(127,127,127,0.08))" }}>
                      <h3>Real review</h3>
                      <p style={{ lineHeight: 1.7 }}>{sample.reviewText}</p>
                    </div>
                    <div className="card" style={{ boxShadow: "0 2px 10px rgba(0,0,0,0.08)" }}>
                      <h3>Drafted reply</h3>
                      <p style={{ lineHeight: 1.7 }}>{sample.draftedReply}</p>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}

          {!state.approved ? (
            <form
              action={async (): Promise<void> => {
                "use server";
                await approveVoiceAction(state.locationId);
              }}
            >
              <button type="submit">Sounds like me</button>
            </form>
          ) : (
            <section className="card">
              <h2>Voice approved ✅</h2>
              <p className="muted">
                Great — automation can now use this voice profile. Here’s a preview of your first weekly post tone:
              </p>
              <div className="card">
                <p>
                  Quick update from our team: this week we wrapped several local jobs and had great feedback on fast,
                  clean service. If you need help with your next project, we’re here and ready to help.
                </p>
              </div>
            </section>
          )}
        </section>
      )}
    </main>
  );
}
