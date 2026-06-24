// Job detail (§14.2 "/<id>"): status (10 s poll), output video, downloads.
// Shell only.
export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <>
      <h1>Job {id}</h1>
      <p className="muted">Status + output video coming next (A2).</p>
      <div className="panel">
        <p className="muted">No data yet for this job.</p>
      </div>
    </>
  );
}
