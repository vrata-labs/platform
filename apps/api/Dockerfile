FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY . .

RUN corepack enable
RUN pnpm install --frozen-lockfile --config.node-linker=hoisted
RUN pnpm --filter @noah/runtime-web build && pnpm --filter @noah/control-plane build && pnpm --filter @noah/api build
RUN pnpm prune --prod --config.confirmModulesPurge=false --config.node-linker=hoisted

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/runtime-web/dist ./apps/runtime-web/dist
COPY --from=build /app/apps/runtime-web/public ./apps/runtime-web/public
COPY --from=build /app/apps/control-plane/dist ./apps/control-plane/dist

EXPOSE 4000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 CMD node -e "fetch('http://127.0.0.1:' + (process.env.API_PORT || '4000') + '/health').then((r) => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "apps/api/dist/index.js"]
