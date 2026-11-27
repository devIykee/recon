FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY web ./web
ENV RECON_MODE=server \
    RECON_DATA=/data \
    RECON_PORT=4317 \
    NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4317/api/health || exit 1
CMD ["node", "bin/recon.js", "serve"]
