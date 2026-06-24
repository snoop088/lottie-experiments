// New job — the two-step gather (§14.3): name + JSON -> validate -> footage + fonts
// -> commit -> /<id>/fields. Shell only; wiring (/api/validate, presign, commitJob)
// comes in later A2 steps.
export default function NewJobPage() {
  return (
    <>
      <h1>New job</h1>
      <p className="muted">Step 1 — name your job and upload the Lottie JSON.</p>
      <div className="panel">
        <p className="muted">Upload form coming next (A2).</p>
      </div>
    </>
  );
}
