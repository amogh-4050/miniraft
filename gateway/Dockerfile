FROM node:20-alpine

# corepack is built into Node 20, use it to enable pnpm
# this avoids a separate npm install -g pnpm call
RUN corepack enable && corepack prepare pnpm@latest --activate

# Tell pnpm to use this directory as its store
# so Docker can cache it as a layer
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN pnpm add -g nodemon

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

CMD ["nodemon", "--delay", "0", "--watch", ".", "--ext", "js,json", "index.js"]