# syntax=docker/dockerfile:1

# Three stages: deps (install once, cached independently of source changes),
# builder (compile with Next's standalone output), runner (the actual image
# that ships — just the standalone server + static assets, no source, no
# dev dependencies, no full node_modules tree).

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Only the NEXT_PUBLIC_* connection defaults need to exist at build time —
# Next.js inlines them into the client bundle during `next build`. Everything
# else (OIDC_*, AGENT_*, SESSION_SECRET) is read from process.env at request
# time by server-only code and belongs at *runtime* (see docker-compose.yml's
# env_file), never baked into the image. These three are non-secret UI
# pre-fill values, not credentials — see .env.local.example.
ARG NEXT_PUBLIC_DEFAULT_REGION=us-east-2
ARG NEXT_PUBLIC_DEFAULT_QUALIFIER=DEFAULT
ARG NEXT_PUBLIC_DEFAULT_HARNESS_ARN=
ENV NEXT_PUBLIC_DEFAULT_REGION=$NEXT_PUBLIC_DEFAULT_REGION \
    NEXT_PUBLIC_DEFAULT_QUALIFIER=$NEXT_PUBLIC_DEFAULT_QUALIFIER \
    NEXT_PUBLIC_DEFAULT_HARNESS_ARN=$NEXT_PUBLIC_DEFAULT_HARNESS_ARN \
    NEXT_TELEMETRY_DISABLED=1

RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Standalone output already runs as a plain Node server (server.js) with no
# build tooling involved, so there's no reason to run it as root.
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 -G nodejs nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

# Node has fetch built in (18+) — no need to add curl/wget to the alpine
# image just for this.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
