# doax server: Registry Server + Code Repository + Auth Server in one process.
#   docker build -t doax/server .
#   docker run -p 8080:8080 -v doax-data:/data -e DOAX_DOMAIN=https://registry.corp.internal doax/server
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm prune --prod

FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    DOAX_DATA_DIR=/data
WORKDIR /app
COPY --from=build /src ./
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "apps/doax-server/dist/main.js"]
