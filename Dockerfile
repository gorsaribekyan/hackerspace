# Ubuntu 24.04 — Node app with native deps (node-pty) and fish for interactive shells
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    HOST=0.0.0.0 \
    PORT=3000 \
    SHELL=/usr/bin/fish

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        build-essential \
        python3 \
        fish \
    && rm -rf /var/lib/apt/lists/*

# Node.js LTS (npm included) — required to run the app and install deps
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
