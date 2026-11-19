FROM node:24-bookworm-slim
WORKDIR /opt/gen-nettools-ota
COPY --chown=node:node server.mjs health.mjs http.mjs manifest.mjs providers.mjs version.mjs ./
USER node
EXPOSE 23887/tcp
CMD ["node", "server.mjs"]
