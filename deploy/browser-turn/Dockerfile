FROM coturn/coturn:4.17.2-r0@sha256:aa68aab64a3b929d57fc2924c98ea447bf996cf8dade2508e7b71eaf23f1f14e

USER 0:0
RUN cp /usr/bin/turnserver /usr/local/bin/yeaft-turnserver \
    && chmod 0555 /usr/local/bin/yeaft-turnserver
COPY --chmod=0555 start-turn.sh /usr/local/bin/start-yeaft-turn
COPY --chmod=0555 healthcheck.sh /usr/local/bin/healthcheck-yeaft-turn

USER 10001:10001
ENTRYPOINT ["/bin/sh", "/usr/local/bin/start-yeaft-turn"]
