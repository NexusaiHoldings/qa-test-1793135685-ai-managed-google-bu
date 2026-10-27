import { getServerSession } from "@nexus/identity-and-access";
import { redirect } from "next/navigation";
import {
  finalizeVoiceApprovalAction,
  saveSampleFeedbackAction,
  submitTonePickerAction,
} from "./actions";
import { getVoiceOnboardingState } from "@/lib/gbp/voice-profile";

export default async function VoicePage(): Promise<JSX.Element> {
  const session = await getServerSession();
  const userId = session?.user?.id;

  if (!userId) {
    redirect("/api/auth/signin");
  }

  const state = await getVoiceOnboardingState(userId);

  if (!state) {
    return (
      <main>
        <h1>Brand voice calibration</h1>
        <p>Connect a Google Business Profile location first to calibrate your voice.</p>
        <div className="empty">No location is linked yet.</div>
      </main>
    );
  }

  if (state.isApproved) {
    return (
      <main>
        <h1>Brand voice calibration</h1>
        <p>Your voice profile is approved. Automated drafting can now stay in your tone.</p>
        <section className="card">
          <h2>You're all set ✅</h2>
          <p className="muted">Preview of your first weekly post:</p>
          <p style={{ lineHeight: 1.7 }}>{state.successPreview}</p>
        </section>
      </main>
    );
  }

  if (state.mode === "tone-picker") {
    return (
      <main>
        <h1>Brand voice calibration</h1>
        <p>Quick tone picker (fewer than 5 reviews found). This takes about 60 seconds.</p>

        <form action={submitTonePickerAction} className="card">
          <input type="hidden" name="locationId" value={state.locationId} />

          <label htmlFor="greetingStyle">How should replies open?</label>
          <select id="greetingStyle" name="greetingStyle" defaultValue="warm">
            <option value="warm">Warm and thankful</option>
            <option value="direct">Direct and brief</option>
            <option value="neighborly">Neighborly/local</option>
          </select>

          <label htmlFor="formality">Overall tone</label>
          <select id="formality" name="formality" defaultValue="professional">
            <option value="casual">Casual</option>
            <option value="professional">Professional</option>
            <option value="formal">Formal</option>
          </select>

          <label htmlFor="signOffStyle">How should replies close?</label>
          <select id="signOffStyle" name="signOffStyle" defaultValue="team-name">
            <option value="team-name">Signed with team name</option>
            <option value="owner-name">Signed with owner name</option>
            <option value="none">No sign-off</option>
          </select>

          <label htmlFor="neverSay">Anything we should never say?</label>
          <input id="neverSay" name="neverSay" placeholder='e.g. "cheap", "guaranteed same-day"' />

          <button type="submit">Save my tone profile</button>
        </form>
      </main>
    );
  }

  const current = state.samples[state.currentIndex];
  const currentProgress = `${state.currentIndex + 1} of ${state.samples.length}`;

  return (
    <main>
      <h1>Brand voice calibration</h1>
      <p>Compare each real review with our drafted reply. Approve or edit all 3 before automation starts.</p>

      <p className="muted">Progress: {currentProgress}</p>

      <section className="card">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr",
            gap: "0.75rem",
          }}
        >
          <div className="card" style={{ background: "var(--surface-muted, #f6f6f6)" }}>
            <h3>Past customer review</h3>
            <p style={{ lineHeight: 1.8 }}>{current.reviewComment}</p>
          </div>

          <div className="card" style={{ boxShadow: "0 2px 10px rgba(0,0,0,0.06)" }}>
            <h3>Drafted reply in your voice</h3>
            <form action={saveSampleFeedbackAction}>
              <input type="hidden" name="locationId" value={state.locationId} />
              <input type="hidden" name="sampleIndex" value={String(current.index)} />
              <textarea
                name="editedReply"
                defaultValue={current.currentReply}
                rows={7}
                style={{ lineHeight: 1.8 }}
              />
              <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
                <button type="submit" name="approved" value="true">
                  Sounds like me
                </button>
                <button type="submit" name="approved" value="false">
                  Save edit
                </button>
              </div>
            </form>
          </div>
        </div>
      </section>

      <form action={finalizeVoiceApprovalAction}>
        <input type="hidden" name="locationId" value={state.locationId} />
        <button type="submit" disabled={!state.readyToApprove}>
          Approve voice profile & enable automation
        </button>
      </form>
    </main>
  );
}
