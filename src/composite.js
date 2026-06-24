// composite — overlay the transparent PNG sequence onto footage with ffmpeg,
// preserving the footage's audio (AGENTS.md §11a / M6).
//
// Resolution AND frame rate are deduced from the footage (ffprobe), not assumed:
// the overlay sequence is played at the footage's fps so overlay frame N lands on
// footage frame `start + N`. Frames are expected to already be footage-sized
// (camera-matched in AE), so the overlay is full-frame at 0,0. Before `start` and
// after the sequence ends, the footage shows through (overlay only where frames
// exist). AWS-unaware: the CLI and the Fargate task both call composite().

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function run(cmd, args, onLog) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => {
      err += d;
      if (onLog) onLog(String(d));
    });
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} exited ${code}\n${err}`))
    );
  });
}

// Probe footage → { width, height, fpsNum, fpsDen, fps, hasAudio, duration }.
async function probeFootage(footage) {
  const { out } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,width,height,r_frame_rate',
    '-show_entries', 'format=duration',
    '-of', 'json',
    footage,
  ]);
  const info = JSON.parse(out);
  const v = (info.streams || []).find((s) => s.codec_type === 'video');
  const hasAudio = (info.streams || []).some((s) => s.codec_type === 'audio');
  if (!v) throw new Error(`no video stream in ${footage}`);
  const [num, den] = String(v.r_frame_rate || '30/1').split('/').map(Number);
  return {
    width: v.width,
    height: v.height,
    fpsNum: num,
    fpsDen: den || 1,
    fps: num / (den || 1),
    hasAudio,
    duration: info.format ? Number(info.format.duration) : undefined,
  };
}

// Inspect a frame dir → { pattern, startNumber, count } for ffmpeg's image2 demuxer.
function inspectFrames(framesDir) {
  const files = fs
    .readdirSync(framesDir)
    .filter((f) => /^\d+\.png$/.test(f))
    .sort();
  if (!files.length) throw new Error(`no NNNN.png frames in ${framesDir}`);
  const stem = path.basename(files[0], '.png');
  return {
    pattern: path.join(framesDir, `%0${stem.length}d.png`),
    startNumber: parseInt(stem, 10),
    count: files.length,
  };
}

// opts:
//   footage   (string, required)   footage mp4 (video + audio)
//   framesDir (string, required)   transparent PNG sequence
//   out       (string, required)   output mp4
//   start     (number, frames)     footage frame where overlay frame 0 lands (default 0)
//   codec     (string)             video codec (default libx264)
//   onLog     (fn)                 ffmpeg stderr lines
// returns { out, width, height, fps, hasAudio, start }
async function composite(opts = {}) {
  const { footage, framesDir, out, start = 0, codec = 'libx264', onLog } = opts;
  if (!footage || !fs.existsSync(footage)) throw new Error(`footage not found: ${footage}`);
  if (!framesDir) throw new Error('composite: framesDir is required');
  if (!out) throw new Error('composite: out is required');

  const f = await probeFootage(footage);
  const frames = inspectFrames(framesDir);
  const startSec = start / f.fps; // footage frame -> seconds

  // shift the overlay to begin at `startSec`; overlay only from then on; when the
  // sequence ends, pass the footage through; keep footage audio untouched.
  const graph =
    `[1:v]setpts=PTS-STARTPTS+${startSec}/TB[ov];` +
    `[0:v][ov]overlay=eof_action=pass:enable='gte(t,${startSec})'[v]`;

  const args = [
    '-y',
    '-i', footage,
    '-framerate', `${f.fpsNum}/${f.fpsDen}`,
    '-start_number', String(frames.startNumber),
    '-i', frames.pattern,
    '-filter_complex', graph,
    '-map', '[v]',
    ...(f.hasAudio ? ['-map', '0:a', '-c:a', 'copy'] : []),
    '-c:v', codec,
    '-pix_fmt', 'yuv420p',
    '-r', `${f.fpsNum}/${f.fpsDen}`,
    '-movflags', '+faststart',
    out,
  ];

  await run('ffmpeg', args, onLog);
  return { out, width: f.width, height: f.height, fps: f.fps, hasAudio: f.hasAudio, start };
}

module.exports = { composite, probeFootage, inspectFrames };

// CLI: node src/composite.js <footage.mp4> <framesDir> <out.mp4> [--start N]
if (require.main === module) {
  const argv = process.argv.slice(2);
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) opts[argv[i].slice(2)] = argv[++i];
    else positional.push(argv[i]);
  }
  const [footage, framesDir, out] = positional;
  if (!footage || !framesDir || !out) {
    console.error('Usage: node src/composite.js <footage.mp4> <framesDir> <out.mp4> [--start N]');
    process.exit(2);
  }
  composite({
    footage,
    framesDir,
    out,
    start: parseInt(opts.start, 10) || 0,
    onLog: (l) => process.stderr.write(l),
  })
    .then((r) =>
      console.log(`\nComposited ${r.width}x${r.height} @ ${r.fps}fps (audio:${r.hasAudio}) -> ${r.out}`)
    )
    .catch((e) => {
      console.error(e.message || e);
      process.exit(1);
    });
}
