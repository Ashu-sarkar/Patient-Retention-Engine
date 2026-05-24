FROM n8nio/n8n:2.17.7

USER root

COPY package.json package-lock.json /opt/patient-retention/
COPY workflows /workflows
COPY tests/setup-n8n.js /tests/setup-n8n.js
COPY start.sh /start.sh

RUN cd /opt/patient-retention \
 && npm ci --omit=dev --no-audit --no-fund \
 && chmod +x /start.sh \
 && chown -R node:node /opt/patient-retention /workflows /tests \
 && chown node:node /start.sh

ENV NODE_PATH=/opt/patient-retention/node_modules

# Run as node so n8n stores data in /home/node/.n8n (matches the volume mount)
USER node

ENTRYPOINT ["/start.sh"]
