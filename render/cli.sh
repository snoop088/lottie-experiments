#!/usr/bin/env bash
# Run the render engine CLI inside the Docker image (Playwright + ffmpeg + Open
# Sans baked in), mounting this render/ dir as the working dir. File paths you
# pass are relative to render/.
#
# Usage:
#   render/cli.sh render <lottie.json> <outDir> [--csv f | --json f] [--range a:b] [--width N] [--height N]
#   render/cli.sh composite <footage.mp4> <framesDir> <out.mp4> [--start N]
#   render/cli.sh placeholders <lottie.json>
#   render/cli.sh build                 # (re)build the Docker image
#
# Examples:
#   render/cli.sh render Simple_Animation.ph.json out --csv spec.csv
#   render/cli.sh render --json job.json
#   render/cli.sh composite footage.mp4 out result.mp4 --start 0
set -euo pipefail

IMAGE="${IMAGE:-lottie-render:latest}"
DIR="$(cd "$(dirname "$0")" && pwd)"   # the render/ directory

usage() { awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "$0"; }

cmd="${1:-}"; shift || true
case "$cmd" in
  render)            script=render.js ;;
  composite)         script=composite.js ;;
  placeholders|ph)   script=placeholders.js ;;
  *.js)              script="$cmd" ;;
  build)             exec docker build -t "$IMAGE" "$DIR" ;;
  ""|-h|--help)      usage; exit 0 ;;
  *) echo "unknown command: '$cmd' (use render | composite | placeholders | build)"; exit 2 ;;
esac

# Build the image on first use if it isn't present yet.
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -t "$IMAGE" "$DIR"

exec docker run --rm -v "$DIR":/work -w /work --entrypoint node "$IMAGE" "/app/src/$script" "$@"
