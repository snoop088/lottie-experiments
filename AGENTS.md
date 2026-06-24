# Lottie Templating & Render Pipeline — Spec / Plan

> Living design doc. Edit freely; implementation follows what's written here.
> Status: **DRAFT — pending your review.** Nothing in `src/` is built yet.

## 1. Goal

The main goal is to achieve a composited camera tracked dynamic animation on top of a live shot footage. 

- The purpose of *dynamism* - being able to swap programatically from another data source the parts of this animation
- This then is composited via `ffmpeg` on top of live shot footage or 3D render or AI generated footage.

### How Is It Done

Full process outside of scope of the programattic implementation. Supplied for context.

AE is used to camera match live footage with placeholders. They are animated to be part of the live footage animation. Subsequently the placeholders are included in the CSV (or later could be as jsonl post) to the software backend. It will parse the input, together with exported `animation.json` to produce the dynamic animation overlay as a sequence of transparent png frames, as described below.

### Deployment

**Decided: a single combined Docker image** for the render flow (Playwright render
**and** ffmpeg composite). **Lambda is ruled out for the render** — 15-min hard
timeout, plus the ~1.5 GB Chromium + ffmpeg footprint.

**App topology (decided in §14):** that image runs as an **on-demand ECS Fargate
task, one per job** (scale-to-zero, pay-per-render), triggered by the web app. The
web app itself — **Next.js UI + API on AWS Amplify** (Git CI/CD, custom domain,
SSR/API as managed Lambda) — handles all the *light* request/response work, with
**DynamoDB** (jobs) and **S3** (files). Cold starts are accepted for near-zero idle
cost; the earlier "always-warm container" plan is superseded by this split. Worker-
pool tuning / SQS smoothing remain optimizations deferred until the flow works (§13,
§14.7).

### Process Outline

Take a Lottie `animation.json` plus a CSV of replacements, swap the named
placeholders (text / multi-line text / images), render the result with **full
effect fidelity** (the Gaussian-blur glow that the canvas renderer drops), and
write a **transparent PNG sequence**.

Runs inside a **Docker** image so renders are reproducible and CI-friendly.

Once the frames are available use a `start` frame pointer to superimpose them on top of a live footage. Animation and footage run at the **footage's frame rate**, deduced from it via `ffprobe` (not assumed 30 — the sample footage is 24 fps; see §11a).

## 2. Why a headless browser (the core decision)

`lottie-nodejs` only ships Lottie's **canvas** renderer, which **ignores the
effects array** — so Gaussian Blur / Drop Shadow / Tint are silently dropped
(this is exactly why our first PNGs lost the glow). Lottie only honors those
effects in its **SVG** renderer, which maps them to native SVG filters
(`<feGaussianBlur>` etc.).

Therefore we run **lottie-web's SVG renderer in headless Chromium** (via
Playwright) and screenshot each frame. Slower than canvas, but pixel-faithful.

## 2a. Phasing

Strategy: **build the complete end-to-end flow first in one combined container,
then optimize.**

- **Phase 1 — Complete flow (current target):** template a Lottie (text /
  text_area / image swaps) → render a **transparent PNG sequence** with full
  effect fidelity → **composite** it onto live-action (or 3D / AI) footage with
  `ffmpeg` at a `start` frame, **preserving the footage's audio**. All in one
  Docker image. Animation/footage run at the footage's fps (ffprobe-deduced; §11a).
- **Phase 2 — Optimization (later):** render parallelism (queue + worker pool),
  optionally splitting render/compose into separate services, and deployment
  scaling. Sections tagged **(Phase 2)** are spec-only for now.

## 3. Stack (decided)

| Concern            | Choice                          |
| ------------------ | ------------------------------- |
| Script runtime     | **Node.js**                     |
| Browser automation | **Playwright** (Chromium)       |
| Lottie renderer    | **lottie-web**, `renderer: 'svg'` |
| Placeholder lookup | **By AE layer / asset name**    |
| Output (Phase 1)   | **Transparent PNG sequence** (platform-independent; no ProRes) |
| Compositing        | **ffmpeg** (overlay + audio passthrough) |
| Packaging          | **One combined Docker image** (Playwright + ffmpeg) → **ECR**; Lambda ruled out for render |
| Web app            | **Next.js (UI + API) on AWS Amplify** (Git CI/CD, custom domain) — §14 |
| Render compute     | **On-demand ECS Fargate task**, one per job (scale-to-zero) — §14 |
| State              | **DynamoDB** (jobs) + **S3** (files), IAM roles — §14 |

## 4. High-level flow

```
CSV/JSONL ─┐
            ├─► [Node] parse input records + Lottie JSON
JSON ──────┘        │
              ├─► apply replacements to the in-memory animationData
              │     • text       → set layer text string
              │     • text_area  → wrap to width, set multi-line string
              │     • image      → base64-embed file as a data-URI asset
              │
              ├─► launch Playwright Chromium, open render.html
              ├─► page.evaluate: lottie.loadAnimation({ renderer:'svg', animationData })
              │
              └─► for frame in [start..end]:
                     anim.goToAndStop(frame, true)        // SVG updates, effects applied
                     page.screenshot({ omitBackground:true })  // transparent PNG
                     write frames/NNNN.png
```

## 5. Inputs

**Required sources per job (TODO — to formalize in the app stack):** the Lottie
**JSON**, the **footage** (for composite), and **all fonts** the JSON references.
Fonts are a first-class required input alongside JSON/footage — a missing font is
a hard error, not a warning (see §8 TODO for why: it silently clips fitted text).

### 5.1 Lottie JSON
- Path passed on CLI. Loaded, parsed, mutated **before** `loadAnimation`.
- Native `w`/`h`/`fr` used unless overridden on the CLI.
- `ip`/`op` define the frame range (note: this project's sample has `ip:30`).

### 5.2 Replacements — input formats

Same data, two transports. **CSV is a test/dev convenience.** The **frontend
sends one JSON job per POST** (see §5.3). All transports normalize to the same
internal record list before rendering.

A replacement targets one placeholder by **`type`** + **`value`** (+ optional
type-specific params). The placeholder **name is the key** (it's already unique).

#### JSON — single job (the frontend POST body)
The replacement map is an object **keyed by AE layer name**, optionally wrapped
in a small job envelope carrying the template + render params:

```json
{
  "lottie": "anim-test-1.json",
  "out": "frames/job-001",
  "width": 800, "height": 600, "start": 0,
  "replacements": {
    "placeholder1":            { "type": "text",      "value": "The dynamic text" },
    "placeholder_longer_text": { "type": "text_area", "value": "longer copy that should wrap", "width": 320 },
    "image_place_holder":      { "type": "image",     "value": "data:image/png;base64,iVBORw0KGgo…" }
  }
}
```

The frontend can also POST **just the `replacements` map** if the template +
params are fixed server-side.

#### JSONL — batch (later: queue/worker)
One of the JSON job objects above **per line**. Only needed when batching many
jobs into a stream; the per-line schema is identical to the single job.

#### CSV — test/dev only
```csv
name,type,value,options
placeholder1,text,The dynamic text,
placeholder_longer_text,text_area,"longer copy that should wrap",width=320
image_place_holder,image,./assets/logo.png,
```
- Parsed with a real CSV parser (RFC-4180 quoting), **not** split-on-comma.
- `options` cell is an optional `key=value;key=value` bag (e.g. `width=320`).

#### Field semantics (all formats)
- **key / `name`** — the AE layer name. Exact match (see §7). JSON uses it as
  the object key; CSV uses the `name` column.
- `type` — one of `text` | `text_area` | `image`.
- `value` —
  - `text` / `text_area`: the replacement string.
  - `image`: **either a base64 data-URI** (`data:image/png;base64,…`, what the
    frontend sends) **or a file path** (what the CLI/CSV uses in tests).
- params — `width` for `text_area`. `width`/`height` may accompany an `image`
  but are **hints only** (aspect is always preserved, §6.3). In CSV these live
  in the `options` bag; in JSON they're sibling fields.

### 5.3 Transport rationale

- **Frontend → backend: one JSON object per job.** Native types, painless
  multi-line copy, carries base64 images inline, and bundles render params with
  the replacement map. This is the real ingestion path.
- **Batch: JSONL.** Same object, one per line — streamable and trivially
  parallelizable (worker reads a line, renders, moves on; feeds Phase 2
  parallelism). Use only when many jobs travel together.
- **CSV: testing only.** Convenient to hand-edit, but stringly-typed and awkward
  for base64 / multi-line / nested params — not a production transport.

## 6. Placeholder types

### 6.1 `text` (single line)
Find the text layer by name → set its string on every text keyframe
(`layer.t.d.k[*].s.t = value`). Color, alignment, and animation are preserved.

**Auto-shrink to fit (implemented):** measured in-browser with the real font
(`canvas.measureText`, after `@font-face` load). If the string is wider than the
target width, the font size (`s.s`) is reduced until it fits one line; a warning
logs the size change. Target width = the `width` option, else the nearest
ancestor **precomp clip width** (`× 0.95` margin), else the comp width.

**Glyphs gotcha (important):** if the Lottie was exported from Bodymovin with
**"Glyphs" enabled**, it carries a top-level `chars` array of baked outlines for
**only the characters in the original text**. lottie-web renders text from those
glyphs and **silently drops any new character** — so "MartinDImov" → "Nick
Dimitrov" rendered as "iDimitrov". **Fix:** when a text replacement is applied,
the pipeline **deletes the `chars` array** so text renders live from the `fonts`
list. The correct **typeface then requires the actual font** supplied via
`fonts/` + `@font-face` (§8); without it text falls back to a default face.
Best practice: export templates with **"Glyphs" off**.

### 6.2 `text_area` (multi-line, wrapping) — **implemented**
Lottie text does **not** reliably auto-wrap by box width across all exports, so
we **wrap explicitly**: greedy word-wrap measured in-browser with the real font,
inserting `\r` line breaks into the string before render. Existing explicit
breaks are preserved.

- Target width: `width` option, else the nearest ancestor **precomp clip width**
  (`× 0.95`), else the comp width.
- Measurement uses `canvas.measureText` after `@font-face` load, so it matches
  Chromium. Line-height taken from the layer's existing leading (`s.lh`).
- **Vertical overflow:** behaves like an HTML renderer — **does not fail.**
  Wrapped lines × line-height vs the clip height; if it overflows, render as-is
  and **log a warning** (the box clips it) so the operator can shorten the copy.

### 6.3 `image`
Find the image layer by name → resolve its `refId` to the asset in `assets[]` →
**set the asset to an embedded base64 data-URI** (`asset.p = "data:image/png;base64,…"`,
`asset.e = 1`, `asset.u = ""`). Embedding avoids external-file path issues in
the browser. The `value` is **either already a data-URI** (frontend POST — used
as-is) **or a file path** (CLI/CSV — read from disk and base64-encoded, relative
to CWD or `--assets-dir`).
- **Fit (decided): always preserve aspect ratio.** Replacement images are
  expected to already be the correct dimensions for their placeholder, so no
  stretching — preserve aspect and leave sizing to the source asset.

## 7. Placeholder matching (decided: naming convention)

**Convention — AE layer name:** `ph.<type>.<key>`
- `type` ∈ `text` | `text_area` | `image`
- `key` ∈ `[A-Za-z0-9_-]+` — the field name the form/POST uses
- Examples: `ph.text.headline`, `ph.text_area.bio`, `ph.image.avatar`
- The **full layer name** (`ph.text.headline`) is the key in the replacement
  map; `key` is just the human-facing/form field label.

**Discovery & matching** (`src/placeholders.js`):
- Scan every layer name, **recursing into precomps** (`ty === 0` → asset
  `layers`), since templates nest content in precomps.
- A `text` / `text_area` token must sit on a **text layer** (`ty === 5`); an
  `image` token on an **image layer** (`ty === 2`) → resolve `refId` → `assets[]`.
- `node src/placeholders.js <json>` lists discovered placeholders (the
  `--list-placeholders` capability).

**Validation** (fail loud, no silent skips):
- Any name starting `ph.` that doesn't match the pattern → error (malformed).
- Type token on the wrong layer type → error.
- Duplicate placeholder names → error.
- A submitted replacement whose key matches no placeholder, or whose `type`
  disagrees with the placeholder → error, listing known names.

## 8. Rendering

- `render.html`: the host shell — a minimal page that bundles `lottie-web`,
  receives the injected `@font-face` CSS, loads the replaced JSON with
  `renderer: 'svg'`, and exposes a tiny API (`window.__load(data)`,
  `window.__seek(frame)`, `window.__info()`) that Playwright drives to step and
  screenshot frames. This shell + SVG renderer is what restores the glow.
- Page viewport / lottie container sized to render dimensions; **transparent
  background** (no CSS background) + `page.screenshot({ omitBackground: true })`.
- Frame stepping: `goToAndStop(frame, true)` then await one rAF/`load` settle
  before screenshot to ensure SVG filters have painted.
- Frame range: full `[0, totalFrames)` by default; `--range a:b` to subset.
- Output: `frames/NNNN.png`, zero-padded width derived from total count.
- **Fonts (decided):** custom fonts are supplied in a **`custom-fonts/` folder**.
  At render time the script generates `@font-face` CSS pointing at those files and
  injects it into the page (Playwright `addStyleTag`), mapping each font file to
  the family name(s) the text layers reference. Chromium only needs the fonts
  available **to the page**, so this `@font-face` injection is the whole
  mechanism — **no OS-level font install / `fc-cache` baking needed.**

  - **TODO — fonts are a REQUIRED source input (to validate):** treat fonts the
    same as the footage and the Lottie JSON — they must all be supplied by the
    frontend per job. A referenced font that isn't supplied should be a **direct
    error that fails the job**, not a warning. Reason (validated on test-project-1):
    fonts aren't only about typeface fidelity — the auto-shrink/wrap fit measures
    with `canvas.measureText`, and a missing font makes Chromium measure one
    fallback face but render another, so text **silently clips**. So a missing
    font is a correctness failure, not cosmetic. (Currently the code only *warns*
    on a missing font/dir — change to hard error once the app stack is built.)

## 9. CLI (proposed)

```
node src/render.js \
  --lottie ./anim-test-1.json \
  ( --json ./job.json | --jsonl ./jobs.jsonl | --csv ./spec.csv ) \
  --out ./frames \
  [--width 800] [--height 600] \
  [--range 0:180] \
  [--fonts-dir ./fonts] \
  [--assets-dir ./assets] \
  [--list-placeholders]
```

- Exactly one input: `--json` (single job), `--jsonl` (batch), or `--csv` (test).
  JSON/JSONL jobs may carry their own `lottie`/`out`/size/`start`.
- Defaults pulled from the Lottie (`w`,`h`) and files alongside the JSON.
- Exit non-zero on any unresolved placeholder or render error.

## 10. Docker (one combined image)

> Lives in **`render/`** (the engine subdir of the monorepo, §12). Build context
> is `render/`; the image is pushed to ECR and run as the Fargate task (§14).

- Base: `mcr.microsoft.com/playwright:vX.Y-jammy` (Chromium + system libs +
  fonts preinstalled).
- **Install ffmpeg in the same image** (`apt-get install ffmpeg`) so one
  container runs both render and composite — the complete flow, no handoff.
- `npm install` the app; bundle `lottie-web` + `render.html` + Open Sans default.
- Build + run (entry is `src/render.js`; mount data for local CLI use):
  ```
  docker build -t lottie-render render/
  docker run --rm -v "$PWD/render":/work -w /work --entrypoint node \
    lottie-render /app/src/render.js anim-test-1.json frames --csv spec.csv
  ```
- `fonts/` is bundled into the image so `@font-face` can reference it (no
  `fc-cache` / OS font install needed — §8).

## 11. Resolved decisions

1. **text_area overflow:** behave like an HTML renderer — render as-is and **log
   a warning** so the operator can adjust copy / max chars. No failure. (§6.2)
2. **image fit:** **always preserve aspect**; replacements arrive correctly
   sized. (§6.3)
3. **Fonts:** supplied in a **`custom-fonts/` folder** (`.otf`/`.ttf` fine, no
   WOFF needed); script base64-injects `@font-face` CSS into the page, matched to
   the JSON font list's `fFamily`. No OS-level font baking needed. (§8)
4. **Color/transform placeholders:** **N/A** — out of scope.
5. **Output:** **transparent PNGs only**, platform-independent. No ProRes
   (Apple-specific). Phase 2 video comes from compositing, not the renderer.
6. **Performance / parallelism:** acknowledged bottleneck (screenshot-per-frame).
   A browserless approach was considered but **does not render effects** (blurs /
   drop shadows) correctly, so headless Chromium stays. **Parallelism deferred to
   Phase 2.**
7. **Input format:** **CSV for testing, JSONL for production** (§5.2 / §5.3).
   Always parse CSV with a real RFC-4180 parser.

## 11a. Composite onto footage — **(Phase 1, M6 ✅)**

Overlay the PNG sequence onto a footage MP4, preserving audio
([src/composite.js](src/composite.js): `composite()` + `probeFootage()` + CLI).

- **Inputs:** footage `.mp4` (video, audio optional), the PNG sequence, and a
  `start` frame — the footage frame at which animation frame `0000.png` appears.
- **Resolution AND fps are deduced from the footage** (`ffprobe`), not assumed —
  **the earlier "both 30 fps" assumption was wrong** (the test footage is 24 fps).
  The sequence is played at the footage fps so overlay frame N lands on footage
  frame `start + N`. Frames are expected to already be footage-sized (camera-matched
  in AE), so the overlay is **full-frame at 0,0**.
- **Audio (must not be lost):** when the footage has an audio stream it's mapped
  straight through (`-map 0:a -c:a copy`); video-only footage is handled too.
- **Passthrough:** before `start` and after the sequence ends, the footage shows
  through (`overlay=eof_action=pass`); output duration = footage duration.
- **Verified filtergraph** (`START = start / fps`):
  ```
  ffmpeg -y -i footage.mp4 \
         -framerate <fps> -start_number <N> -i frames/%0<pad>d.png \
         -filter_complex "[1:v]setpts=PTS-STARTPTS+<START>/TB[ov];\
                          [0:v][ov]overlay=eof_action=pass:enable='gte(t,<START>)'[v]" \
         -map "[v]" -map 0:a -c:a copy -c:v libx264 -pix_fmt yuv420p \
         -r <fps> -movflags +faststart out.mp4
  ```
  Verified in-container: audio preserved (aac survived), `start` offset honoured,
  footage passes through where the overlay is absent, and alpha/glow blend onto the
  footage correctly (glow demo over a red plate).
- **Note for the render side:** for perfect alignment the PNG sequence should be
  produced at the footage fps/length (the renderer takes `width`/`height`; fps
  alignment is the frontend's job when it deduces footage params). Output is H.264
  + `yuv420p`; color-range/space matching with the footage is a polish item.

## 12. Project structure — **monorepo**

Two deployables in one repo: the **Next.js app at root** (Amplify autodetects it)
and the **render engine in `render/`** (built to an ECR image, run as the Fargate
task). Amplify only builds the root app; it ignores `render/`.
```
.
├── AGENTS.md             ← this file
├── package.json          ← Next.js app (next/react) — Amplify autodetect target
├── next.config.mjs · tsconfig.json
├── app/                  ← Next App Router (UI + API + server actions)
│   ├── layout.tsx · globals.css · page.tsx        (/ jobs list)
│   ├── new/page.tsx                               (/new two-step gather)
│   ├── [id]/page.tsx                              (/<id> job detail + poll)
│   ├── [id]/fields/page.tsx                       (/<id>/fields dynamic form)
│   └── api/health/route.ts                        (liveness; more routes A2)
│
└── render/               ← the engine (its own package.json: playwright + lottie-web)
    ├── Dockerfile · .dockerignore                 (combined Playwright + ffmpeg)
    ├── src/
    │   ├── render.js      ← thin CLI over renderJob()
    │   ├── renderJob.js   ← pure render engine: replace→fit→SVG→PNG (AWS-unaware)
    │   ├── composite.js   ← ffmpeg overlay onto footage (audio + fps via ffprobe)
    │   ├── input.js       ← CSV + JSON/JSONL ingestion → normalized job shape
    │   ├── placeholders.js · replace.js · fonts.js
    │   ├── render.html    ← lottie-web SVG host shell (__fit / __init / __seek)
    │   └── make-form.js
    ├── default-fonts/     ← Open Sans, baked into the image (default fallback)
    ├── custom-fonts/ · anim-test-1.json · Simple_Animation*.json · spec.csv · job.json
    └── (src/task.js — AWS task entrypoint — lands in A4)
```

## 13. Implementation milestones

### Phase 1 — Complete flow (one combined image)
1. **M1 — Skeleton render ✅** Playwright + lottie-web SVG → PNG sequence of
   `anim-test-1.json` **with the glow**. Combined Dockerfile (Playwright+ffmpeg)
   built here too.
2. **M2 — Name matching ✅** `ph.<type>.<key>` convention, precomp-recursing
   discovery + strict validation; `placeholders.js` CLI + form generator.
3. **M3 — text + image ✅** CSV-driven; single-line text + base64 image embed;
   auto-strips baked `chars` so dynamic text renders.
4. **M4 — text fitting ✅** in-browser `measureText`: `text` auto-shrinks to one
   line; `text_area` wraps to width with vertical-overflow warning.
5. **M5 — Fonts ✅ / Inputs ✅** `custom-fonts/` → base64 `@font-face` injection
   done. CSV **and JSON / JSONL** ingestion done (`src/input.js`
   `loadJson`/`loadJsonl`, normalized to one job shape — §5.2).
6. **M6 — ffmpeg composite ✅** [src/composite.js](src/composite.js): overlay PNG
   sequence on footage at `start` frame, **audio preserved**, **resolution + fps
   deduced from footage** (not assumed 30), footage passthrough where the overlay
   is absent, alpha/glow blended. Verified in-container.
7. **M7 — Dockerize (combined) ✅** one image with Playwright **and** ffmpeg;
   volume-mounted runs working.
8. **M8 — Polish ⬜** `--range`, error UX, README, examples.

### Phase 2 — Optimization (later)
9. **M9 — Parallelism:** job queue + worker pool of containers for throughput.
10. **M10 — Split & scale:** optionally separate render/compose services;
    always-warm deployment (Cloud Run / Fargate / Fly / host). **Lambda ruled
    out** (§Deployment).

---
*Edit anything above; the first real coding step (M1) waits on your sign-off.*

## 14. Frontend + API — the app (decided)

> Turns the CLI render engine (§1–§13) into a small web app. Decisions below were
> taken with the operator on review; **(default)** marks a call I made to keep it
> simple — say the word to change any of them.

### 14.0 User flow (source narrative)
1. Designer gets a brief for a new `dynamic video`.
2. They produce an AE comp with `placeholders` per the naming convention (§7).
3. Operator opens **`/new`** — a single page that unlocks in two gated steps:
   - **Step 1 — name + JSON.** Enter a **Job Name** and upload the Lottie **JSON**.
     It's **validated server-side** (`/api/validate`, §14.3): malformed / no
     placeholders → message, stay on `/new`. Valid → step 2 unlocks.
   - **Step 2 — assets.** Upload the **footage**; supply **fonts** — *required if
     the JSON lists font families* (hard gate, §8/§14.6), otherwise the baked-in
     **Open Sans** default is used (no upload, no warning). Optional **frame
     offset** (the `start` of §11a). Final mp4 **resolution is deduced from the
     footage** (ffprobe), never entered.
   - When JSON✓ + footage✓ + fonts✓(or n/a), **Continue** commits the job and
     routes to **`/<id>/fields`**.
4. **`/<id>/fields`** — the dynamic form (three field types: text / textarea /
   file) is generated from the validated placeholders. Operator fills it and
   submits → render is enqueued.
5. The UI **polls status every 10 s** on **`/<id>`**; when done it shows the
   **output video + download**.
6. **`/`** lists all jobs with status. A job abandoned at the fields step is a
   **Draft** with a **"Complete"** button (resume → `/<id>/fields`). Any finished
   job can be **edited**, which **clones** it (reusing JSON/footage/fonts) with new
   replacement fields.
7. The whole app sits behind **simple password protection**.

### 14.1 Shape (decided: Amplify front + on-demand Fargate render — cost-first)
Two right-sized AWS pieces, both **scale-to-zero**, joined by **DynamoDB + S3**.
Cold starts are **accepted** in exchange for near-zero idle cost.

- **Front — AWS Amplify Hosting (Next.js).** One Next.js app is the UI *and* the
  API (App Router **Route Handlers** under `/api/*` — one build, one origin, no
  CORS). Amplify gives **Git-based CI/CD**, a **custom domain + managed cert**, and
  runs the SSR/API as managed **Lambda**, so it scales to ~zero when idle. The API
  is all *light* request/response work (auth, presign, DynamoDB, template parse) —
  a perfect Lambda fit, and what the original spec wanted ("Lambda for presigning").
- **Render — on-demand ECS Fargate task (one per job).** `POST /api/jobs` writes
  the job to DynamoDB and fires **`ecs:RunTask`**; a single Fargate task runs the
  existing **Playwright + ffmpeg** image (the §10 Dockerfile, pushed to **ECR**),
  renders + composites, uploads the result to S3, updates DynamoDB, and **exits**.
  Pay only for the seconds it runs; $0 when no one's rendering. **No worker process,
  no polling loop** — the task *is* the unit of work, and the trigger replaces the
  queue. **Lambda was not used for the render** (its 15-min hard cap, §Deployment).
- **State — DynamoDB (jobs) + S3 (files), IAM roles throughout** (no long-lived
  keys). DynamoDB is now in v1 (App Runner/SQLite-on-a-volume is gone).

```
browser ─ HTTPS ─► Amplify (Next.js: UI pages + /api/* + Server Actions = Lambda)
   │                 ├─ /api/validate /uploads/presign /login /jobs ─► DynamoDB
   │                 └─ submitFields (action) ─► ecs:RunTask ─► Fargate task (from ECR)
   └─ PUT ─────────► S3 (footage, fonts)               renderJob() + ffmpeg
                     S3 (result) ◄────────────────────  ├─ upload mp4 ─► S3
   GET (presigned) ◄ S3 (result)                        └─ update status ─► DynamoDB
                                                            ▲ UI polls /api/jobs/:id
```

- **Big binaries never tunnel through the API.** The browser uploads **footage and
  fonts straight to S3 via presigned PUT**. The small **JSON** goes through
  `/api/validate` (it's well under 1–2 MB; §14.3) and the handler stores it to S3
  itself. The job record carries only **S3 keys**, not base64. *(Refines §6.3: the
  frontend path is an "S3 key", not an inline data-URI.)*
- **The Fargate task** downloads the JSON, its **fonts**, the source images, and
  the footage from `jobs/<id>/` to its (ephemeral) local disk, runs the existing
  pipeline (which already takes a `fontsDir` + file paths), uploads the result mp4,
  and records the result key in DynamoDB. **Fonts must be on local disk before
  `renderJob()` is called** — `@font-face` injection + `measureText` fitting both
  depend on them (§8).
- **Cost shape:** at rest ≈ $0 (Amplify idle + Fargate zero + DynamoDB on-demand +
  S3 storage). Per render ≈ cents (a ~2 vCPU/4 GB task for a few minutes). Tens of
  renders/day → low single-digit $/month.

### 14.2 Routes & API surface
**UI pages** (App Router). `/new` is a static route, so it wins over the dynamic
`/[id]` segment.

| Route | Purpose |
| ----- | ------- |
| `/` | List all jobs with status (Draft / Queued / Rendering / Compositing / Done / Error). Draft rows show **"Complete"** → `/<id>/fields`; Done rows show the video + download; every row has **"Edit"** (clones). |
| `/new` | The two-step gather (§14.3): name + JSON, then footage + fonts. |
| `/<id>/fields` | Dynamic form from the validated placeholders — **3 field types**: `text`→input, `text_area`→textarea, `image`→file. Used for fill, **Complete**, and **Edit**. |
| `/<id>` | Job detail: status (**10 s poll**), output video, downloads. |

**API** — Next.js **Route Handlers** (`app/api/.../route.ts`), called by client JS.
All except `/api/login` require `Authorization: Bearer <token>`.

| Method | Route | Purpose |
| ------ | ----- | ------- |
| POST | `/api/login` | `{password}` → `{token}` (validated against `APP_PASSWORD`). |
| POST | `/api/validate` | **JSON in the body** (small — guard rejects > ~4 MB as "malformed / embedded media"). Runs `discover()` (§7) + reads the font list. Valid → mint `id`, store JSON to `staging/<id>/anim.json`, return `{id, fields[], fonts[]}`. Invalid → `422` with messages. |
| POST | `/api/uploads/presign` | `{id, kind:'footage'|'font'|'image', family?, filename, contentType}` → `{key, putUrl}` (PUT, **TTL 1 h**) under `staging/<id>/…`. Browser PUTs the binary itself. |
| GET | `/api/jobs` | List rows for `/`. |
| GET | `/api/jobs/:id` | `{status, progress?, error?, resultUrl?}`; `resultUrl` = presigned GET (**TTL 24 h**). The poll target. |
| POST | `/api/jobs/:id/resign` | Fresh presigned URLs for this job's assets/result ("obtain a new URL"). |

**Server Actions** (form mutations that end in a `redirect`):
- `commitJob({ id, name, jsonKey, footageKey, fontKeys })` — re-validate, **copy
  `staging/<id>/* → jobs/<id>/*`**, `ddb.put(status:'draft')`, redirect `/<id>/fields`.
- `submitFields(id, replacements)` — validate against the cached `fields[]`,
  `ddb.update(replacements, status:'queued')`, **`ecs:RunTask`**, redirect `/<id>`.
- `cloneJob(id)` — new `id`, `ddb.put` **referencing the parent's** `jsonKey` /
  `footageKey` / `fontKeys` (no copy) + `parentId`, redirect `/<id>/fields`.

### 14.3 New-job flow (validate → commit → fields)
```
/new  step 1 — name + JSON
  POST /api/validate  (json in body)         ← validation runs in Next Node
     invalid → errors, stay on /new (no record yet)
     valid   → mint id, store staging/<id>/anim.json, return { id, fields[], fonts[] }
/new  step 2 — assets (unlocked by valid JSON)
  footage → presign + PUT → staging/<id>/footage.<ext>
  fonts   → if JSON lists families: presign + PUT each → staging/<id>/fonts/<family>.<ext>  (required)
            else: none — Open Sans default (§14.6)
  Continue enabled when json✓ + footage✓ + fonts✓(or n/a)
commit  → Server Action commitJob   (copy staging→jobs/<id>, ddb.put draft) → redirect /<id>/fields
/<id>/fields
  submit → Server Action submitFields  (validate, ddb.update queued, ecs:RunTask) → redirect /<id>
```
- **Why validate-by-body, not S3-first:** a real template is < 1–2 MB (the repo
  samples are 12–35 KB), comfortably under the Lambda/Server-Action caps — so the
  small JSON rides the request and the handler stores it. Only the big binaries
  (footage, fonts) use presigned PUT. The size guard catches the "footage baked
  into the JSON" mistake early.
- **`id` minted at validate** to scope the `staging/<id>/` uploads. The committed
  **job record** is written at `commitJob` (end of step 2) — so a flow abandoned
  *during upload* leaves only staging objects (self-cleaning, §14.4); abandoned
  *at the fields step* is a resumable **Draft** in the list.

### 14.4 Data model — DynamoDB + S3
**DynamoDB `jobs` item** (stays tiny — images are S3 keys, never inline base64):
```
id, name, parentId?,
status: draft | queued | rendering | compositing | done | error,
jsonKey, footageKey, fontKeys:[{family,key}],
fields:[…],            // cached placeholder schema → render the form without re-parsing
replacements:{…},      // the form values ("replacement fields as JSON")
start, resolution, resultKey?, error?, createdAt, updatedAt,
ttl?                   // set on staging/abandoned drafts, cleared on commit
```
**S3 layout** (one private bucket, no public objects):
```
staging/<id>/…                         # step-1/2 uploads; 24 h lifecycle auto-deletes abandoned
jobs/<id>/anim.json
jobs/<id>/fonts/<family>.<ext>
jobs/<id>/images/<placeholder>.<ext>
jobs/<id>/output/<projectName>.mp4
```
- **Objects persist; only presigned *URLs* expire.** "Expires in 1 h / 24 h" is the
  **URL TTL**, not deletion — so **Edit/clone reuses** a job's JSON/footage/fonts by
  key, and the UI **re-signs on demand** (`/resign`). (If S3 lifecycle *deletion* is
  ever added, it must spare committed `jobs/` objects, or clones break.)
- **Edit = clone (decided):** a new record referencing the parent's asset keys; the
  original job + its video are untouched, no re-upload, only new replacements +
  output.

### 14.5 Render lifecycle & the `renderJob` call chain
Three layers; `renderJob()` is the innermost, **AWS-unaware** one (so the existing
CLI and the task both call it):
```
submitFields (Amplify)  → ecs:RunTask(overrides.env JOB_ID=<id>)
  Fargate task entry  src/task.js  (AWS-aware)
    job = ddb.get(JOB_ID); ddb.update('rendering')
    download jobs/<id>/{anim.json, fonts/*, images/*, footage} → /tmp
    { framesDir } = await renderJob({ animationData, replacements, fontsDir, … })
    await composite({ footage, framesDir, out, start: job.start }) → out.mp4   (§11a / src/composite.js; ddb 'compositing')
    upload → jobs/<id>/output/…; ddb.update('done', resultKey); process.exit(0)
```
- Status transitions are written to DynamoDB so the `/<id>` poll reflects progress;
  `renderJob` reports frame progress via an `onProgress` callback.
- **One task per job → jobs parallelize naturally** (no concurrency-1 bottleneck);
  add a max-concurrent cap if a team bursts. Worker-pool tuning stays Phase-2 (§13 M9).
- **No zombies:** the task sets `error` on any throw; a `rendering` row whose task
  exited non-zero / passed a TTL is reaped to `error`.

### 14.6 Fonts (required-if-listed, else baked Open Sans)
- **JSON lists font families → those fonts are required** uploads; the project
  can't be committed until each is supplied (§8 — a wrong-metric fallback silently
  clips fitted text). Validated at `/api/validate` (which returns the family list).
- **JSON lists none → Open Sans**, **baked into the image** as the deterministic
  default (the Playwright base ships only Liberation/DejaVu/Noto — no Open Sans — so
  it's bundled via the Dockerfile). No coin-flip fallback, so **no warning needed**.
- The task assembles a local `fontsDir` (downloaded job fonts, or the baked default)
  before `renderJob()`; [src/fonts.js](src/fonts.js) matches files → `@font-face`.

### 14.7 What's deferred to Phase 2
The cost-first v1 already uses DynamoDB + on-demand Fargate, so most of the
original AWS-native plan is *in*, not deferred. Left for later, each a clean
drop-in: **SQS** between `submitFields` and `RunTask` (smooths bursts, adds
retries); a **concurrency cap / worker-pool** (§13 M9); **S3 lifecycle deletion**
(§14.4, must spare `jobs/`); per-user accounts; and **API Gateway** only if the API
ever leaves Amplify. **Lambda-container render** stays rejected for the 15-min cap
(§Deployment).

### 14.8 Auth (decided: Amplify Basic Auth — shared password)
**Hosting-level HTTP Basic Auth** on the Amplify branch (not an app-level login).
It blocks **pages and `/api/*` alike at the CDN before the app runs**, so no login
page, cookie, or middleware is needed. Single shared username + password; the
browser prompts once and auto-sends the credential on later requests (so the app's
own `fetch`/API calls keep working).
- Configured via `aws amplify update-branch --enable-basic-auth`, driven from
  `BASIC_AUTH_USER`/`BASIC_AUTH_PASSWORD` in [scripts/aws-setup.sh](scripts/aws-setup.sh)
  (secret stays in `.env`, never the repo). Applies to the custom domain too.
- **Caveat:** presigned S3 media is fetched directly from S3, *not* through Amplify,
  so it's gated by URL secrecy + TTL (§14.4), not by Basic Auth.
- *(Superseded the earlier localStorage-bearer idea — Basic Auth is simpler and
  gates the API uniformly. App-level login + httpOnly cookie + middleware remains
  the fallback if we ever need a custom login UI / logout / per-user.)*

### 14.9 App milestones (Phase 1, after backend M6)
- **A1 — Engine as a library ✅** pure `renderJob(opts)` in
  [src/renderJob.js](src/renderJob.js); [src/render.js](src/render.js) is now a thin
  CLI over it; **JSON/JSONL ingestion** done ([src/input.js](src/input.js));
  **Open Sans** baked into the image ([Dockerfile](Dockerfile) +
  [default-fonts/](default-fonts/)) as the deterministic fallback in
  [src/fonts.js](src/fonts.js). Verified in-container (real font + fallback).
  *(The AWS-aware `src/task.js` wrapper — JOB_ID → S3 → DynamoDB → composite —
  lands with A3/A4, once S3/DynamoDB and the M6 composite exist; it would be a
  no-op stub before then.)*
- **A2 — Next.js app + API ◐** monorepo done (Next at root, engine in `render/`);
  shell pages (`/`, `/new`, `/<id>`, `/<id>/fields`) + `/api/health` build & Amplify-
  autodetect ✅. **TODO:** Route Handlers (`/api/login`, `/api/validate` incl. size
  guard + font detection, `/api/uploads/presign`, `/api/jobs` list/get/resign) +
  bearer auth; Server Actions (`commitJob`, `submitFields`, `cloneJob`); **DynamoDB**.
- **A3 — S3 + ECR image:** presign/upload/download incl. **fonts**; staging→commit
  copy; the task assembles `fontsDir`; push the §10 Playwright+ffmpeg image to
  **ECR**; `ffprobe` resolution.
- **A4 — Trigger + composite:** `submitFields` → `ecs:RunTask`; task chains
  `renderJob()` → `composite()` (both built — M6 ✅) + reports status to DynamoDB.
- **A5 — Frontend polish:** dynamic form (3 types), 10 s polling, Draft "Complete",
  Edit→clone, login gate.
- **A6 — Deploy:** Amplify (Git CI/CD + custom domain + `APP_PASSWORD`); ECS task
  def + IAM roles (Amplify→`RunTask`; task→S3/DynamoDB); ECR push pipeline; S3
  lifecycle on `staging/` + DynamoDB TTL on drafts.

### 14.10 Provisioned (us-east-1) & env
Created by [scripts/aws-setup.sh](scripts/aws-setup.sh) (idempotent):
- **DynamoDB** `lottie-jobs` — PK `id`, on-demand, **TTL on `ttl`** (draft cleanup).
- **S3** `lottie-render-780954185713` — all public access blocked; **CORS** PUT/GET/
  HEAD from the app origins (presigned uploads); **lifecycle** expires `staging/`
  after 1 day.
- **Amplify app** `d2i1tmezpcq4dj` (WEB_COMPUTE) → https://main.d2i1tmezpcq4dj.amplifyapp.com

**Env vars** the app reads (server-side only): `DYNAMODB_TABLE`, `S3_BUCKET`,
`AWS_REGION`, and (later) `APP_PASSWORD`, `RENDER_TASK_*` for `ecs:RunTask`.
- **Local dev:** in `.env` (gitignored) alongside AWS creds — both loaded by Next.
- **Prod:** set as Amplify env; **creds come from an IAM role on the Amplify SSR
  compute** (DynamoDB + S3 + later `ecs:RunTask`), not long-lived keys — wired in A6.

---
*Backend engine (A1 + M6) done. App: A2 in progress — shell live on Amplify,
DynamoDB + S3 provisioned; next is the data layer + `/api/validate` + presign + jobs
routes + server actions.*
