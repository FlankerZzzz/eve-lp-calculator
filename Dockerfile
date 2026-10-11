FROM node:22-bookworm-slim

WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm run build

ENV ESI_BASE_URL=https://ali-esi.evepc.163.com
ENV NODE_ENV=production
ENV V2_SQLITE_PATH=/v2/eve-v2.db
ENV V2_LOG_PATH=/v2/logs

EXPOSE 3000
VOLUME ["/v2"]
CMD ["npm", "run", "start", "--", "--hostname", "0.0.0.0", "--port", "3000"]
