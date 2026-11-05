FROM node:22-alpine

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

ENV NODE_ENV=production \
    APP_HOST=0.0.0.0 \
    APP_PORT=8080

EXPOSE 8080
CMD ["node", "server/index.mjs"]
