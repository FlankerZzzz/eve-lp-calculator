FROM node:22-bookworm-slim

WORKDIR /app
COPY package*.json ./
ARG HTTP_PROXY=http://192.168.31.152:7890
ARG HTTPS_PROXY=http://192.168.31.152:7890
ENV HTTP_PROXY=$HTTP_PROXY
ENV HTTPS_PROXY=$HTTPS_PROXY
RUN npm install --no-audit --no-fund
ENV HTTP_PROXY=
ENV HTTPS_PROXY=
COPY . .
RUN npm run build

ENV ESI_BASE_URL=https://ali-esi.evepc.163.com
ENV NODE_ENV=production
ENV SQLITE_RUNTIME=1
ENV SQLITE_PATH=/data/eve-lp.db
ENV WRANGLER_WRITE_LOGS=false
ENV WRANGLER_LOG_PATH=/app/.wrangler/logs
ENV MINIFLARE_REGISTRY_PATH=/app/.wrangler/registry

EXPOSE 3000
VOLUME ["/data"]
CMD ["npm", "run", "start", "--", "--hostname", "0.0.0.0", "--port", "3000"]
