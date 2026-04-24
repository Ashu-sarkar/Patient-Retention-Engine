FROM n8nio/n8n

USER root

COPY workflows /workflows
COPY start.sh /start.sh

RUN chmod +x /start.sh \
 && chown -R node:node /workflows \
 && chown node:node /start.sh

# Run as node so n8n stores data in /home/node/.n8n (matches the volume mount)
USER node

ENTRYPOINT ["/start.sh"]