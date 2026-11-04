# syntax=docker/dockerfile:1.7
# prompt-to-part: the built app and its API on one port (`pnpm start`). See "Docker" in the README.
#
# Build arguments:
#   WITH_BAMBU=1   adds Bambu Studio's command line (Cost tab slicing, 3MF print settings); about
#                  +750 MB, linux/amd64 only. BAMBU_URL / BAMBU_SHA256 pin the release.
#   WITH_BLENDER=1 adds Blender for .blend export; about +1 GB (a 380 MB download), linux/amd64 only.
#                  BLENDER_URL / BLENDER_SHA256 pin the release.

ARG NODE_IMAGE=node:26.7.0-trixie-slim@sha256:5758d367d7b4f48b73a9bb3530e687e47efb289f3b43f9c0450a25225ae0db5d
ARG WITH_BAMBU=0
ARG WITH_BLENDER=0

# ---- pnpm, for the build stages only (Node 26 comes without Corepack) ----
FROM ${NODE_IMAGE} AS pnpm
ARG PNPM_VERSION=12.15.0
RUN npm install -g --no-audit --no-fund --allow-scripts=pnpm pnpm@${PNPM_VERSION}
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# ---- dependencies (all of them, for the build) ----
# The store is a build cache, so packages are copied into node_modules/.pnpm: node_modules holds
# everything it links to, and can be copied to the runtime stage.
FROM pnpm AS deps
RUN --mount=type=cache,target=/pnpm-store pnpm install --frozen-lockfile --store-dir /pnpm-store

# ---- the browser app (dist/) ----
FROM deps AS build
COPY . .
RUN pnpm run build

# ---- runtime dependencies only ----
FROM pnpm AS prod-deps
RUN --mount=type=cache,target=/pnpm-store pnpm install --prod --frozen-lockfile --store-dir /pnpm-store

# ---- Bambu Studio: the official Linux AppImage, checked and unpacked ----
FROM ${NODE_IMAGE} AS bambu-1
ARG BAMBU_URL=https://github.com/bambulab/BambuStudio/releases/download/v02.08.02.61/BambuStudio_ubuntu24.04-v02.08.02.61-20260820225108.AppImage
ARG BAMBU_SHA256=d501b103fac5424513ec0e8d6bc145fb30719de2c7d94d7320d723740c81a7fd
ADD --checksum=sha256:${BAMBU_SHA256} ${BAMBU_URL} /tmp/bambu.AppImage
WORKDIR /tmp
# The command line needs the slicer and its printer profiles, not the GUI's help pages, web views,
# pictures, bed models, calibration models, fonts or translations.
RUN chmod +x bambu.AppImage && ./bambu.AppImage --appimage-extract > /dev/null \
  && cd squashfs-root/resources && rm -rf hms web images model calib fonts i18n tooltip && cd /tmp \
  && mv squashfs-root /opt/bambu-studio && rm bambu.AppImage

FROM scratch AS bambu-0
WORKDIR /opt/bambu-studio

FROM bambu-${WITH_BAMBU} AS bambu

# ---- Blender: the official Linux release, checked and unpacked ----
FROM ${NODE_IMAGE} AS blender-1
ARG BLENDER_URL=https://download.blender.org/release/Blender5.2/blender-5.2.2-linux-x64.tar.xz
ARG BLENDER_SHA256=84098912789dc450e95697c4184fb8a90acbe5111c2ba4aede3fecb57806a168
# Headless export needs no translations, pip or Cython.
ADD --checksum=sha256:${BLENDER_SHA256} ${BLENDER_URL} /tmp/blender.tar.xz
RUN apt-get update && apt-get install -y --no-install-recommends xz-utils \
  && mkdir /opt/blender && tar -xJf /tmp/blender.tar.xz -C /opt/blender --strip-components=1 && rm /tmp/blender.tar.xz \
  && cd /opt/blender && rm -rf */datafiles/locale */python/lib/python3*/site-packages/pip */python/lib/python3*/site-packages/Cython

FROM scratch AS blender-0
WORKDIR /opt/blender

FROM blender-${WITH_BLENDER} AS blender

# ---- runtime ----
FROM ${NODE_IMAGE}
ARG WITH_BAMBU
ARG WITH_BLENDER
# fontconfig and fonts for text (installed fonts are listed next to the bundled ones), tini to pass
# signals on and reap Bambu Studio and Claude Code processes; Bambu Studio's command line also needs
# the GTK and WebKit libraries it is linked against, even without a display.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked --mount=type=cache,target=/var/lib/apt,sharing=locked \
  rm -f /etc/apt/apt.conf.d/docker-clean \
  && apt-get update \
  && apt-get install -y --no-install-recommends tini fontconfig fonts-dejavu-core fonts-liberation2 \
  && if [ "$WITH_BAMBU" = 1 ]; then apt-get install -y --no-install-recommends \
       libgtk-3-0t64 libwebkit2gtk-4.1-0 libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 libgl1 libegl1 libdbus-1-3; fi \
  && if [ "$WITH_BLENDER" = 1 ]; then apt-get install -y --no-install-recommends \
       libx11-6 libxi6 libxxf86vm1 libxfixes3 libxrender1 libxkbcommon0 libsm6 libgl1 libegl1; fi \
  && fc-cache -f
COPY --from=bambu /opt/bambu-studio /opt/bambu-studio
RUN if [ "$WITH_BAMBU" = 1 ]; then ln -s /opt/bambu-studio/AppRun /usr/local/bin/bambustudio; else rmdir /opt/bambu-studio; fi
COPY --from=blender /opt/blender /opt/blender
RUN if [ "$WITH_BLENDER" = 1 ]; then ln -s /opt/blender/blender /usr/local/bin/blender; else rmdir /opt/blender; fi

WORKDIR /app
# UV_THREADPOOL_SIZE: name lookups and file reads share Node's thread pool (4 threads by default), so
# a slow DNS server would otherwise hold up every file read and stall the whole server.
ENV NODE_ENV=production \
    UV_THREADPOOL_SIZE=16 \
    JIG_HOST=0.0.0.0 \
    PORT=8787 \
    JIG_DATA=/data \
    JIG_DOCKER=1 \
    CLAUDE_CONFIG_DIR=/home/node/.claude
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json pnpm-lock.yaml tsconfig.json index.html vite.config.ts LICENSE ./
COPY server ./server
COPY shared ./shared
COPY src ./src
# The volumes' mount points, owned by the user the app runs as: designs and the Bambu template (/data),
# Claude Code's sessions (CLAUDE_CONFIG_DIR) and the OpenSCAD engine plus the bundled workers
# (node_modules/.cache, the only place the sandboxed workers may read besides node_modules).
RUN mkdir -p /data /home/node/.claude node_modules/.cache \
  && chown node:node /data /home/node/.claude node_modules/.cache

USER node
EXPOSE 8787
VOLUME ["/data", "/home/node/.claude", "/app/node_modules/.cache"]
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
# What `pnpm start` runs, without pnpm in between (the runtime has no pnpm).
CMD ["node", "--import", "tsx", "server/index.ts", "--production"]
