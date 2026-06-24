// Input parsing -> a normalized job: { lottie?, out?, width?, height?, start?,
//   replacements: { "<layerName>": { type, value, [width] } } }.
// Three transports normalize to the same shape (AGENTS.md §5.2):
//   - CSV  (test/dev)        -> loadCsv  -> bare replacements map
//   - JSON (frontend POST)   -> loadJson -> one job (envelope or bare map)
//   - JSONL (batch)          -> loadJsonl -> array of jobs

const fs = require('fs');

// Minimal RFC-4180 CSV parser (handles quotes, escaped quotes, commas/newlines
// inside quoted fields). Avoids pulling a dependency into the image.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r') {
      // ignore; handled by \n
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseOptions(s) {
  const o = {};
  (s || '').split(';').forEach((p) => {
    p = p.trim();
    if (!p) return;
    const eq = p.indexOf('=');
    if (eq === -1) return;
    o[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
  });
  return o;
}

function loadCsv(file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8')).filter(
    (r) => r.length && r.some((c) => c.trim() !== '')
  );
  if (!rows.length) return {};
  const header = rows.shift().map((h) => h.trim().toLowerCase());
  const col = (n) => header.indexOf(n);

  const map = {};
  for (const r of rows) {
    const name = (r[col('name')] || '').trim();
    if (!name) continue;
    const rec = {
      type: (r[col('type')] || '').trim(),
      value: r[col('value')] != null ? r[col('value')] : '',
    };
    const opts = parseOptions(col('options') >= 0 ? r[col('options')] : '');
    if (opts.width) rec.width = Number(opts.width);
    map[name] = rec;
  }
  return map;
}

// A job object is either a bare replacements map (keys = layer names) or an
// envelope carrying render params plus a `replacements` map (§5.2). Normalize
// both to the envelope shape. Image `value`s may be a data-URI, a file path, or
// (from the frontend) an S3 key — resolution is the caller's concern.
function normalizeJob(obj) {
  if (!obj || typeof obj !== 'object') return { replacements: {} };
  if (obj.replacements && typeof obj.replacements === 'object') {
    return obj; // envelope: { lottie?, out?, width?, height?, start?, replacements }
  }
  return { replacements: obj }; // bare map
}

function loadJson(file) {
  return normalizeJob(JSON.parse(fs.readFileSync(file, 'utf8')));
}

// JSONL: one job object per non-empty line.
function loadJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => normalizeJob(JSON.parse(l)));
}

module.exports = { loadCsv, loadJson, loadJsonl, normalizeJob, parseCsv, parseOptions };
