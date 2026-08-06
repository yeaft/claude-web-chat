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
RUN node -e "const fs=require('fs'); const p='agent/package.json'; const j=JSON.parse(fs.readFileSync(p)); j.version=process.argv[1].replace(/^v/, ''); fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\\n')" "$BUILD_VERSION" \
  && chmod 0755 agent/container-entrypoint.sh

VOLUME ["/home/yeaft/.yeaft", "/workspace"]
ENTRYPOINT ["/app/agent/container-entrypoint.sh"]
CMD []
