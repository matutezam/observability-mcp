FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

ENV OBSERVABILITY_MCP_MODE=http
ENV PORT=3000

CMD ["node", "dist/index.js"]
