FROM node:24-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates chromium \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/repo

ENV CI=true
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/bin

