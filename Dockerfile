# WeRForces server image. Build: docker build -t werforces .
# Run:   docker run -p 8080:8080 -e WERFORCES_API_KEY=change-me werforces
# For HTTPS, use docker-compose.yml (Caddy terminates TLS in front of this container).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
COPY web ./web
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docs ./docs
COPY scenarios ./scenarios
COPY terrains ./terrains
COPY examples ./examples
# Saved scenarios and recordings persist in volumes mounted here.
RUN mkdir -p recordings && chown -R node:node scenarios recordings terrains
USER node
EXPOSE 8080 3000/udp
# Listening on all interfaces: set WERFORCES_API_KEY (or --api-key) for anything but a private network.
ENTRYPOINT ["node", "dist/server/cli.js", "--host", "0.0.0.0", "--port", "8080"]
CMD []
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/api/docs || exit 1
