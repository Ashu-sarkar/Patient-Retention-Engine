FROM n8nio/n8n:2.17.7

USER root

COPY workflows /workflows
COPY tests/setup-n8n.js /tests/setup-n8n.js
COPY start.sh /start.sh

RUN chmod +x /start.sh \
 && chown -R node:node /workflows /tests \
 && chown node:node /start.sh

# Run as node so n8n stores data in /home/node/.n8n (matches the volume mount)
USER node

ENTRYPOINT ["/start.sh"]
