FROM n8nio/n8n

USER root

COPY workflows /workflows
COPY start.sh /start.sh

RUN chmod +x /start.sh
RUN chown -R node:node /workflows

# 🔥 THIS IS THE KEY FIX
ENTRYPOINT ["/start.sh"]