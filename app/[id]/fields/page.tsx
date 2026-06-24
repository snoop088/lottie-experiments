// Dynamic placeholder form (§14.2 "/<id>/fields"): 3 field types —
// text -> input, text_area -> textarea, image -> file. Used for fill / complete /
// edit. Shell only; the form is generated from the job's cached fields[] next (A2).
export default async function FieldsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <>
      <h1>Fields — job {id}</h1>
      <p className="muted">
        Dynamic form (text / textarea / file) generated from the template
        placeholders. Coming next (A2).
      </p>
      <div className="panel">
        <p className="muted">No fields loaded yet.</p>
      </div>
    </>
  );
}
