FROM n8nio/n8n

USER root

# Copy workflows into container
COPY workflows /workflows

RUN chown -R node:node /workflows

USER node

CMD sh -c "if [ ! -f /home/node/.n8n/.initialized ]; then \
  n8n import:workflow --separate --input=/workflows && \
  touch /home/node/.n8n/.initialized; \
fi && n8n start"
