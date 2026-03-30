FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY . .

RUN corepack enable
RUN pnpm install --frozen-lockfile --config.node-linker=hoisted
RUN pnpm --filter @noah/room-state build
RUN pnpm prune --prod --config.confirmModulesPurge=false --config.node-linker=hoisted

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/room-state/package.json ./apps/room-state/package.json
COPY --from=build /app/apps/room-state/dist ./apps/room-state/dist

EXPOSE 2567

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 CMD node -e "fetch('http://127.0.0.1:' + (process.env.ROOM_STATE_PORT || '2567') + '/health').then((r) => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "apps/room-state/dist/index.js"]
