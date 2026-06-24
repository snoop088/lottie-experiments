// CLI over renderJob(): render a Lottie to a transparent PNG sequence, with
// optional placeholder replacement from CSV / JSON / JSONL.
//
// Usage:
//   node src/render.js <lottie.json> <outDir>
//        [ --csv spec.csv | --json job.json | --jsonl jobs.jsonl ]
//        [--width N] [--height N] [--range a:b]
//        [--fonts-dir DIR] [--assets-dir DIR]
//
// JSON/JSONL jobs may carry their own `lottie`/`out`/`width`/`height`/`start`
// (§5.2); CLI flags and positionals fill the gaps.

const fs = require('fs');
const path = require('path');
const { loadCsv, loadJson, loadJsonl } = require('./input');
const { renderJob } = require('./renderJob');

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) opts[a.slice(2)] = argv[++i];
    else positional.push(a);
  }
  return { positional, opts };
}

function parseRange(s) {
  if (!s) return undefined;
  const [a, b] = String(s).split(':').map((n) => parseInt(n, 10));
  if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
  return [a, b];
}

async function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));

  const sources = ['csv', 'json', 'jsonl'].filter((k) => opts[k]);
  if (sources.length > 1) {
    console.error(`Use only one of --csv / --json / --jsonl (got ${sources.join(', ')})`);
    process.exit(2);
  }

  // Normalize every transport to a list of jobs { lottie?, out?, width?, height?, start?, replacements }.
  let jobs;
  let inputBase; // dir to resolve relative image paths against
  if (opts.csv) {
    jobs = [{ replacements: loadCsv(path.resolve(opts.csv)) }];
    inputBase = path.dirname(path.resolve(opts.csv));
  } else if (opts.json) {
    jobs = [loadJson(path.resolve(opts.json))];
    inputBase = path.dirname(path.resolve(opts.json));
  } else if (opts.jsonl) {
    jobs = loadJsonl(path.resolve(opts.jsonl));
    inputBase = path.dirname(path.resolve(opts.jsonl));
  } else {
    jobs = [{ replacements: {} }];
  }

  const range = parseRange(opts.range);
  const multi = jobs.length > 1;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const input = job.lottie || positional[0] || './anim-test-1.json';
    const outDir = job.out || positional[1] || (multi ? `./frames-svg/job-${i}` : './frames-svg');

    if (!fs.existsSync(input)) {
      console.error(`Input not found: ${input}`);
      process.exit(1);
    }

    const animationData = JSON.parse(fs.readFileSync(input, 'utf8'));
    const fontsDir =
      opts['fonts-dir'] || path.join(path.dirname(path.resolve(input)), 'custom-fonts');
    const assetsDir = opts['assets-dir'] || inputBase || path.dirname(path.resolve(input));

    if (multi) console.log(`\n[job ${i + 1}/${jobs.length}] ${input} -> ${outDir}`);

    const res = await renderJob({
      animationData,
      replacements: job.replacements,
      outDir,
      width: job.width || opts.width,
      height: job.height || opts.height,
      range,
      fontsDir,
      assetsDir,
      onWarning: (m) => console.warn('  ⚠ ' + m),
      onProgress: (n, total) => {
        if (n % 25 === 0 || n === total) process.stdout.write(`\r  frame ${n}/${total}`);
      },
    });

    console.log(`\nDone. ${res.total} PNGs @ ${res.width}x${res.height} -> ${res.framesDir}`);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
