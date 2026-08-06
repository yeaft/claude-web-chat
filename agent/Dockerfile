FROM node:24-bookworm-slim

ARG BUILD_VERSION=dev
ENV NODE_ENV=production \
    HOME=/home/yeaft \
    YEAFT_DIR=/home/yeaft/.yeaft \
    WORK_DIR=/workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client tini \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 10001 --shell /usr/sbin/nologin yeaft \
  && mkdir -p /app /workspace /home/yeaft/.yeaft \
  && chown -R yeaft:yeaft /app /workspace /home/yeaft

WORKDIR /app
COPY package.json package-lock.json ./
COPY agent/package.json ./agent/
RUN npm ci --workspace=agent --omit=dev
COPY --chown=yeaft:yeaft agent ./agent

USER yeaft
VOLUME ["/home/yeaft/.yeaft", "/workspace"]
ENTRYPOINT ["/usr/bin/tini", "--", "node", "agent/cli.js"]
CMD []
