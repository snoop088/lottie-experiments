// Build @font-face CSS for the fonts a Lottie references, from local files.
//
// lottie-web's SVG renderer sets the text element's font-family to the font
// list entry's `fFamily`, so we must register @font-face under that name (we
// also register the `fName` for safety). Fonts are base64-embedded into the CSS
// to dodge file:// font-loading restrictions in headless Chromium.
//
// Open Sans fallback (AGENTS.md §14.6): a job's JSON may declare a font family
// for which no file was supplied (or declare none at all). To keep output
// deterministic, pass `opts.fallbackFile` (the baked-in Open Sans, see
// DEFAULT_FONTS_DIR) and any unmatched family is registered against it instead
// of falling through to Chromium's generic face (which clips fitted text, §8).

const fs = require('fs');
const path = require('path');

const EXT_FORMAT = { '.otf': 'opentype', '.ttf': 'truetype', '.woff': 'woff', '.woff2': 'woff2' };
const EXT_MIME = { '.otf': 'font/otf', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const FALLBACK_FAMILY = 'Open Sans';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function faceFor(family, absFile) {
  const ext = path.extname(absFile).toLowerCase();
  const buf = fs.readFileSync(absFile);
  const src = `url(data:${EXT_MIME[ext]};base64,${buf.toString('base64')}) format('${EXT_FORMAT[ext]}')`;
  return `@font-face{font-family:'${String(family).replace(/'/g, '')}';font-style:normal;font-weight:normal;src:${src};}\n`;
}

// opts.fallbackFile — absolute path to the Open Sans default (optional).
function buildFontCss(animationData, fontsDir, opts = {}) {
  const list = (animationData.fonts && animationData.fonts.list) || [];
  const fallbackFile = opts.fallbackFile && fs.existsSync(opts.fallbackFile) ? opts.fallbackFile : null;
  const warnings = [];
  const families = new Set();
  let css = '';

  let files = [];
  if (fontsDir) {
    try {
      files = fs.readdirSync(fontsDir).filter((f) => EXT_FORMAT[path.extname(f).toLowerCase()]);
    } catch (e) {
      warnings.push(`fonts dir "${fontsDir}" not found`);
    }
  }

  // No declared fonts: register the Open Sans default and force it onto the
  // SVG text (there's no fFamily to map, so this is the only hook).
  if (!list.length) {
    if (fallbackFile) {
      css += faceFor(FALLBACK_FAMILY, fallbackFile);
      css += `#lottie text{font-family:'${FALLBACK_FAMILY}';}\n`;
      families.add(FALLBACK_FAMILY);
    }
    return { css, families: [...families], warnings };
  }

  for (const font of list) {
    const fName = font.fName || '';
    const fFamily = font.fFamily || fName;
    const targets = [norm(fName), norm(fFamily)].filter(Boolean);

    // fuzzy match a file by either the PostScript name or the family name
    const file = files.find((f) => {
      const n = norm(path.basename(f, path.extname(f)));
      return targets.some((t) => n.includes(t) || t.includes(n));
    });

    const fams = [...new Set([fFamily, fName].filter(Boolean))];
    if (file) {
      const abs = path.join(fontsDir, file);
      for (const fam of fams) {
        css += faceFor(fam, abs);
        families.add(fam);
      }
    } else if (fallbackFile) {
      // register the declared family name(s) against Open Sans so the text
      // still resolves to a real, metric-stable face
      for (const fam of fams) {
        css += faceFor(fam, fallbackFile);
        families.add(fam);
      }
      warnings.push(`no font file for "${fName}" (family "${fFamily}") — using ${FALLBACK_FAMILY} default`);
    } else {
      warnings.push(`no font file in ${fontsDir} for "${fName}" (family "${fFamily}") — text will use a fallback face`);
    }
  }

  return { css, families: [...families], warnings };
}

module.exports = { buildFontCss, FALLBACK_FAMILY };
