# ---------- dependências (cache reaproveitado pelas etapas seguintes) ----------
FROM node:22-alpine AS deps
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund

# ---------- build (API + interface) ----------
FROM deps AS build
COPY . .
RUN npm run build

# ---------- dependências de produção somente da API ----------
# Usa o cache já baixado em "deps" (--prefer-offline): evita um segundo download pela rede.
FROM deps AS prod-deps
RUN rm -rf node_modules apps/*/node_modules \
 && npm ci --omit=dev -w apps/api --prefer-offline --no-audit --no-fund \
 && mkdir -p apps/api/node_modules

# ---------- runtime ----------
FROM node:22-alpine
ENV NODE_ENV=production TZ=America/Sao_Paulo
RUN apk add --no-cache tzdata
WORKDIR /app
COPY package.json ./
COPY apps/api/package.json apps/api/
COPY --from=prod-deps /src/node_modules node_modules
COPY --from=prod-deps /src/apps/api/node_modules apps/api/node_modules
COPY --from=build /src/apps/api/dist apps/api/dist
COPY --from=build /src/apps/web/dist web
USER node
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3333/api/health || exit 1
CMD ["node", "apps/api/dist/server.js"]
