FROM node:20-alpine

RUN corepack enable && corepack prepare pnpm@latest --activate

ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN pnpm add -g nodemon

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

CMD ["nodemon", "--delay", "0", "--watch", ".", "--ext", "js,json", "--signal", "SIGTERM", "index.js"]