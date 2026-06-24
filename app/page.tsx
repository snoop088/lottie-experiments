import Link from "next/link";

// Jobs list (§14.2 "/"). Shell: real listing comes from GET /api/jobs (DynamoDB)
// in a later A2 step.
export default function JobsPage() {
  return (
    <>
      <h1>Jobs</h1>
      <p className="muted">All render jobs — Draft / Queued / Rendering / Done / Error.</p>
      <div className="panel">
        <p className="muted">No jobs yet.</p>
        <p>
          <Link className="btn" href="/new">
            Start a new job
          </Link>
        </p>
      </div>
    </>
  );
}
