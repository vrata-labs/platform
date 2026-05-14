FROM mcr.microsoft.com/playwright:v1.58.2-noble AS build

WORKDIR /app

COPY . .

RUN corepack enable
RUN pnpm install --frozen-lockfile --config.node-linker=hoisted
RUN pnpm --filter @noah/shared-types build && pnpm --filter @noah/remote-browser build
RUN pnpm prune --prod --config.confirmModulesPurge=false --config.node-linker=hoisted

FROM mcr.microsoft.com/playwright:v1.58.2-noble AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/remote-browser/package.json ./apps/remote-browser/package.json
COPY --from=build /app/apps/remote-browser/dist ./apps/remote-browser/dist
COPY --from=build /app/packages/shared-types/package.json ./packages/shared-types/package.json
COPY --from=build /app/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=build /app/packages/shared-types/package.json ./node_modules/@noah/shared-types/package.json
COPY --from=build /app/packages/shared-types/dist ./node_modules/@noah/shared-types/dist

EXPOSE 4010

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 CMD node -e "fetch('http://127.0.0.1:' + (process.env.REMOTE_BROWSER_PORT || '4010') + '/health').then((r) => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "apps/remote-browser/dist/index.js"]
