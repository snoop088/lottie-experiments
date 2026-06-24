// renderJob — the pure render engine. Given an in-memory Lottie + a normalized
// replacement map, apply the replacements (text / text_area / image), inject the
// fonts, drive lottie-web's SVG renderer in headless Chromium, and write a
// transparent PNG sequence. AWS-unaware on purpose: the CLI (src/render.js) and
// the Fargate task entrypoint (src/task.js, later) both call this.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { validate } = require('./placeholders');
const { applyReplacements, buildFitTasks } = require('./replace');
const { buildFontCss } = require('./fonts');

const RENDER_HTML = path.join(__dirname, 'render.html');

// Pick the first font file in a dir (used to resolve the Open Sans default).
function firstFontFile(dir) {
  if (!dir) return null;
  try {
    const f = fs.readdirSync(dir).find((n) => /\.(ttf|otf|woff2?)$/i.test(n));
    return f ? path.join(dir, f) : null;
  } catch (e) {
    return null;
  }
}

// opts:
//   animationData  (object, required)   parsed Lottie; mutated in place
//   replacements   (object)             { name: { type, value, width? } }
//   outDir         (string, required)   PNG output dir (created if missing)
//   width, height  (number)             default from animationData
//   range          ([a, b])             frame subset; default full range
//   fontsDir       (string)             per-job fonts
//   defaultFontsDir(string)             baked Open Sans dir (env DEFAULT_FONTS_DIR)
//   assetsDir      (string)             base for image file-path replacements
//   onProgress     (fn(frame,total))    progress callback
//   onWarning      (fn(msg))            non-fatal warnings
// returns { framesDir, total, width, height, warnings }
async function renderJob(opts = {}) {
  const {
    animationData,
    replacements = {},
    outDir,
    range,
    fontsDir,
    assetsDir,
    onProgress,
    onWarning = () => {},
  } = opts;

  if (!animationData || typeof animationData !== 'object') {
    throw new Error('renderJob: animationData (parsed Lottie object) is required');
  }
  if (!outDir) throw new Error('renderJob: outDir is required');

  const warnings = [];
  const warn = (m) => {
    warnings.push(m);
    onWarning(m);
  };

  const width = parseInt(opts.width, 10) || animationData.w;
  const height = parseInt(opts.height, 10) || animationData.h;

  // --- replacements (fail loud on validation / apply errors, §7) ---
  let fitTasks = [];
  if (replacements && Object.keys(replacements).length) {
    const v = validate(animationData, replacements);
    if (v.errors.length) {
      throw new Error('Validation failed:\n  ' + v.errors.join('\n  '));
    }
    const r = applyReplacements(animationData, replacements, { assetsDir, onWarning: warn });
    if (r.errors.length) {
      throw new Error('Replacement errors:\n  ' + r.errors.join('\n  '));
    }
    fitTasks = buildFitTasks(animationData, replacements);
  }

  // --- fonts: per-job dir, with the baked Open Sans as the deterministic fallback ---
  const defaultFontsDir = opts.defaultFontsDir || process.env.DEFAULT_FONTS_DIR;
  const fallbackFile = firstFontFile(defaultFontsDir);
  const font = buildFontCss(animationData, fontsDir, { fallbackFile });
  font.warnings.forEach(warn);

  fs.mkdirSync(outDir, { recursive: true });

  const lottiePath = require.resolve('lottie-web/build/player/lottie.min.js');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.goto('file://' + RENDER_HTML);

    // @font-face first, then lottie-web, then wait for the fonts to load so
    // measureText (fit) and the SVG renderer see the real faces.
    if (font.css) await page.addStyleTag({ content: font.css });
    await page.addScriptTag({ path: lottiePath });
    if (font.families.length) {
      await page.evaluate(async (fams) => {
        await Promise.all(fams.map((f) => document.fonts.load(`64px '${f}'`)));
        await document.fonts.ready;
      }, font.families);
    }

    // fit (shrink / wrap) with the loaded font, then init the SVG animation
    const fit = await page.evaluate(
      ({ animationData, fitTasks }) => window.__fit(animationData, fitTasks),
      { animationData, fitTasks }
    );
    fit.warnings.forEach(warn);

    const info = await page.evaluate(({ width, height }) => window.__init(width, height), {
      width,
      height,
    });

    const total = info.totalFrames;
    const start = range ? Math.max(0, range[0]) : 0;
    const end = range ? Math.min(total, range[1]) : total;
    const pad = Math.max(4, String(Math.max(0, end - 1)).length);
    const el = await page.$('#lottie');

    for (let f = start; f < end; f++) {
      await page.evaluate((frame) => window.__seek(frame), f);
      // settle one animation frame so SVG filters (blur) have painted
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
      const buf = await el.screenshot({ omitBackground: true });
      fs.writeFileSync(path.join(outDir, String(f).padStart(pad, '0') + '.png'), buf);
      if (onProgress) onProgress(f - start + 1, end - start);
    }

    return { framesDir: outDir, total: end - start, width, height, warnings };
  } finally {
    await browser.close();
  }
}

module.exports = { renderJob };
