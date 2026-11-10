# Node 22 has node:sqlite, so the default storage path needs no native build and
# no dependencies at all. `pg` is installed only when the postgres profile is used.
FROM node:22-slim

ENV NODE_ENV=production \
    SG_DB=/data/softgarden.db \
    SG_CACHE_DIR=/cache \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

WORKDIR /app

# package.json alone first so this layer caches; there are no runtime deps to
# install, and --omit=optional keeps `pg` out of the default image.
COPY package.json ./
RUN npm install --omit=dev --omit=optional --no-audit --no-fund

COPY src ./src

# The database and the ~100 MB Common Crawl index both need to outlive the
# container: change detection and drop alerts compare against previous runs.
VOLUME ["/data", "/cache"]

RUN mkdir -p /data /cache && chown -R node:node /data /cache
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SG_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Default to the dashboard; the scheduler service overrides this.
CMD ["node", "src/cli.js", "dashboard"]
