// Apply replacements to the in-memory Lottie data, before loadAnimation.
// M3: text (single-line). text_area here sets the string as-is (wrapping is M4);
// image base64-embeds the asset.

const fs = require('fs');
const path = require('path');

function assetsMap(data) {
  const m = {};
  (data.assets || []).forEach((a) => {
    m[a.id] = a;
  });
  return m;
}

// Find a layer by exact name, recursing into precomp assets.
function findLayer(data, name) {
  const byId = assetsMap(data);
  let found = null;
  function visit(layers) {
    for (const l of layers || []) {
      if (found) return;
      if (l.nm === name) {
        found = l;
        return;
      }
      if (l.ty === 0 && byId[l.refId] && byId[l.refId].layers) visit(byId[l.refId].layers);
    }
  }
  visit(data.layers);
  return found;
}

function setText(layer, value) {
  (layer.t.d.k || []).forEach((kf) => {
    kf.s.t = value;
  });
}

function mimeFor(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

function setImage(data, layer, value, assetsDir) {
  const as = assetsMap(data)[layer.refId];
  if (!as) throw new Error(`image layer "${layer.nm}" has unresolved refId ${layer.refId}`);
  let dataUri = value;
  if (!/^data:/.test(value)) {
    const buf = fs.readFileSync(path.resolve(assetsDir || '.', value));
    dataUri = `data:${mimeFor(value)};base64,${buf.toString('base64')}`;
  }
  as.p = dataUri;
  as.e = 1; // embedded
  as.u = '';
}

// replacements: { "<layerName>": { type, value, [width] } }
function applyReplacements(data, replacements, opts = {}) {
  const errors = [];
  let textReplaced = false;
  for (const [name, rec] of Object.entries(replacements || {})) {
    const layer = findLayer(data, name);
    if (!layer) {
      errors.push(`No layer named "${name}"`);
      continue;
    }
    try {
      if (rec.type === 'text' || rec.type === 'text_area') {
        setText(layer, rec.value);
        textReplaced = true;
      } else if (rec.type === 'image') {
        setImage(data, layer, rec.value, opts.assetsDir);
      } else {
        errors.push(`"${name}": unknown type "${rec.type}"`);
      }
    } catch (e) {
      errors.push(`"${name}": ${e.message}`);
    }
  }

  // Glyphs-baked exports carry a `chars` array of outlines for only the
  // original characters; lottie-web then drops any new character. Strip it so
  // text renders live from the fonts list (typeface comes from @font-face).
  if (textReplaced && Array.isArray(data.chars)) {
    delete data.chars;
    if (opts.onWarning) opts.onWarning('stripped baked `chars` array so replacement text renders live (supply the font via fonts/ for correct typeface)');
  }

  return { errors };
}

// For each text layer, the clip box it lives in = the nearest ancestor precomp
// layer's w/h (Lottie clips precomp content to those bounds), else the comp size.
function computeClipDims(data) {
  const byId = assetsMap(data);
  const out = {};
  function visit(layers, w, h) {
    for (const l of layers || []) {
      if (l.t) out[l.nm] = { w, h };
      if (l.ty === 0 && byId[l.refId] && byId[l.refId].layers) {
        visit(byId[l.refId].layers, l.w || w, l.h || h);
      }
    }
  }
  visit(data.layers, data.w, data.h);
  return out;
}

// Build the in-browser fit tasks for text replacements. Target width is the
// explicit option, else the clip width with a small safety margin.
function buildFitTasks(data, replacements) {
  const dims = computeClipDims(data);
  const tasks = [];
  for (const [name, rec] of Object.entries(replacements || {})) {
    if (rec.type !== 'text' && rec.type !== 'text_area') continue;
    const d = dims[name] || {};
    const width = rec.width ? rec.width : Math.round((d.w || data.w) * 0.95);
    tasks.push({ name, type: rec.type, width, height: d.h || data.h });
  }
  return tasks;
}

module.exports = { applyReplacements, findLayer, computeClipDims, buildFitTasks };
