#!/bin/sh

if [ ! -f /home/node/.n8n/.initialized ]; then
  n8n import:workflow --separate --input=/workflows
  touch /home/node/.n8n/.initialized
fi

exec n8n start