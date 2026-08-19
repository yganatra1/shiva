FROM node:24-bookworm-slim AS build

WORKDIR /opt/shiva/app
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/tsconfig.json ./
COPY app/src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /opt/shiva/app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /opt/shiva/app/dist ./dist
COPY app/drizzle ./drizzle

EXPOSE 3000
CMD ["sh", "-c", "node dist/database/migrate.js && node dist/server.js"]
