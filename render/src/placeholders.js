// Placeholder discovery + validation.
//
// Convention:  ph.<type>.<key>
//   type ∈ text | text_area | image
//   key  ∈ [A-Za-z0-9_-]+   (the field name the form/POST uses)
//
// The full layer name (e.g. "ph.text.headline") is the key used to match a
// replacement record back onto its layer (see AGENTS.md §7).

const fs = require('fs');

const PH_RE = /^ph\.(text|text_area|image)\.([A-Za-z0-9_-]+)$/;
const LAYER_TYPE_FOR = { text: 5, text_area: 5, image: 2 }; // ty 5 = text, 2 = image

// Walk all layers, recursing into precomp assets, and collect placeholders.
function discover(data) {
  const placeholders = [];
  const errors = [];
  const seen = new Set();

  const assetById = {};
  (data.assets || []).forEach((a) => {
    assetById[a.id] = a;
  });

  function currentText(layer) {
    try {
      return layer.t.d.k[0].s.t;
    } catch (e) {
      return undefined;
    }
  }

  function visit(layers, trail) {
    (layers || []).forEach((l) => {
      const nm = l.nm || '';

      if (/^ph\./.test(nm)) {
        const m = nm.match(PH_RE);
        if (!m) {
          errors.push(
            `Malformed placeholder name "${nm}" — expected ph.<text|text_area|image>.<key>`
          );
        } else {
          const type = m[1];
          const key = m[2];
          const expectTy = LAYER_TYPE_FOR[type];

          if (l.ty !== expectTy) {
            errors.push(
              `"${nm}": type '${type}' must sit on layer type ${expectTy}, but this layer is type ${l.ty}`
            );
          } else if (seen.has(nm)) {
            errors.push(`Duplicate placeholder name "${nm}"`);
          } else {
            seen.add(nm);
            let current;
            if (type === 'image') {
              const as = assetById[l.refId];
              current = as
                ? as.p
                  ? String(as.p).slice(0, 32) + '…'
                  : `(asset ${l.refId})`
                : `(unresolved refId ${l.refId})`;
            } else {
              current = currentText(l);
            }
            placeholders.push({
              name: nm,
              key,
              type,
              comp: trail.join(' > ') || '(root)',
              current,
            });
          }
        }
      }

      // recurse into precomp layers
      if (l.ty === 0 && l.refId && assetById[l.refId] && assetById[l.refId].layers) {
        visit(assetById[l.refId].layers, trail.concat(l.nm || l.refId));
      }
    });
  }

  visit(data.layers, []);
  return { placeholders, errors };
}

// Validate a set of replacement records (keyed by layer name) against a Lottie.
// Returns { errors } — every key must resolve to exactly one placeholder of a
// matching type. Fail loud, no silent skips (AGENTS.md §7).
function validate(data, replacements) {
  const { placeholders, errors } = discover(data);
  const byName = new Map(placeholders.map((p) => [p.name, p]));
  const out = errors.slice();

  for (const [name, rec] of Object.entries(replacements || {})) {
    const p = byName.get(name);
    if (!p) {
      out.push(
        `Replacement for unknown placeholder "${name}". Known: ${
          [...byName.keys()].join(', ') || '(none)'
        }`
      );
    } else if (rec.type && rec.type !== p.type) {
      out.push(`"${name}": replacement type '${rec.type}' != placeholder type '${p.type}'`);
    }
  }
  return { errors: out };
}

module.exports = { discover, validate, PH_RE };

// CLI: node src/placeholders.js <animation.json> [--json]
if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node src/placeholders.js <animation.json> [--json]');
    process.exit(2);
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = discover(data);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(`Placeholders in ${file}:`);
    if (!res.placeholders.length) console.log('  (none found)');
    res.placeholders.forEach((p) =>
      console.log(
        `  • ${p.name}  [${p.type}]  key=${p.key}  comp=${p.comp}  current=${JSON.stringify(
          p.current
        )}`
      )
    );
    if (res.errors.length) {
      console.log('\nErrors:');
      res.errors.forEach((e) => console.log('  ✗ ' + e));
    }
  }
  process.exit(res.errors.length ? 1 : 0);
}
