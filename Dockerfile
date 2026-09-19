FROM node:24-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
FROM dependencies AS build
COPY . .
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund
RUN rm -rf .next/cache
FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/lib ./lib
COPY --from=build /app/server.ts /app/package.json /app/next.config.ts /app/tsconfig.json ./
EXPOSE 3000
CMD ["npm","run","start"]
