# Lottie Templating & Render Pipeline

Swap named placeholders in a Lottie animation (text, multi-line text, images),
render it to a **transparent PNG sequence** with full effect fidelity, and
**composite** it onto live-action footage with `ffmpeg` — all wrapped in a small
web app for non-technical operators.

The renderer runs **lottie-web's SVG renderer in headless Chromium** (Playwright)
so effects like Gaussian blur / drop shadow are preserved — the canvas renderer
silently drops them.

> Full design & decisions live in [AGENTS.md](AGENTS.md).

## Repo layout (monorepo)

```
.                  Next.js app (UI + API) — deployed on AWS Amplify
├── app/           App Router pages + API routes
└── render/        Render engine — Playwright + ffmpeg in one Docker image
    ├── src/        renderJob, composite, placeholders, fonts, input
    ├── cli.sh      local CLI wrapper (runs the engine in Docker)
    └── Dockerfile  combined Playwright + ffmpeg image → ECR
```

## How it works

1. Designer builds an After Effects comp with placeholders named
   `ph.<type>.<key>` (`text` | `text_area` | `image`) and exports the Lottie JSON.
2. Operator uploads the JSON + footage (+ fonts if the JSON references any) and
   fills in the generated form fields.
3. The engine swaps placeholders, renders a transparent PNG sequence, and
   composites it onto the footage at a chosen start frame (audio + fps preserved,
   deduced via `ffprobe`).

## Web app (local dev)

```bash
npm install
npm run dev          # Next.js on http://localhost:3000
```

## Render engine (CLI)

Runs the engine in Docker (auto-builds the image on first use); paths are
relative to `render/`:

```bash
render/cli.sh render Simple_Animation.ph.json out --csv spec.csv
render/cli.sh composite footage.mp4 out result.mp4 --start 0
render/cli.sh placeholders Simple_Animation.ph.json   # list discovered placeholders
```

## Stack

- **App:** Next.js (UI + API) on AWS Amplify
- **Render:** on-demand ECS Fargate task (Playwright + ffmpeg image from ECR)
- **State:** DynamoDB (jobs) + S3 (files)

## Status

Backend render engine is built & verified (M1–M7). The web app is in progress
(A2): Next.js shell live on Amplify, DynamoDB + S3 + Basic Auth provisioned. See
[AGENTS.md](AGENTS.md) §13 / §14.9 for per-milestone status.
