# Combined image: Playwright (Chromium) for the SVG render + ffmpeg for the
# composite stage. One container runs the complete flow (see AGENTS.md).
FROM mcr.microsoft.com/playwright:v1.61.0-jammy

# ffmpeg for the Phase 1 composite stage
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first so this layer caches across code changes.
# playwright npm version matches the base image tag -> no browser re-download.
COPY package*.json ./
RUN npm install --omit=dev

# Bundle Open Sans as the deterministic default font, used when a job's JSON
# declares no fonts (or a referenced family isn't supplied). The Playwright base
# ships only Liberation/DejaVu/Noto, so Open Sans must be added here. Registered
# with fontconfig too, so Chromium's generic fallback is Open Sans as well.
COPY default-fonts ./default-fonts
RUN mkdir -p /usr/share/fonts/truetype/opensans \
  && cp ./default-fonts/*.ttf /usr/share/fonts/truetype/opensans/ \
  && fc-cache -f >/dev/null
ENV DEFAULT_FONTS_DIR=/app/default-fonts

# App code last (cheap layer; rebuilds are fast)
COPY src ./src

# Inputs/outputs are bind-mounted at runtime, e.g.:
#   docker run --rm -v "$PWD":/work lottie-render \
#     /work/anim-test-1.json /work/frames-svg
ENTRYPOINT ["node", "src/render.js"]
