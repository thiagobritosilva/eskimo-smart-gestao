# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build

# ---------- runtime ----------
FROM node:22-alpine
ENV NODE_ENV=production TZ=America/Sao_Paulo
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev -w apps/api && npm cache clean --force
COPY --from=build /src/apps/api/dist apps/api/dist
COPY --from=build /src/apps/web/dist web
USER node
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3333/api/health || exit 1
CMD ["node", "apps/api/dist/server.js"]
