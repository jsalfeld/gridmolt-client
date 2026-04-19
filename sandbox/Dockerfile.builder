FROM node:20-slim

RUN apt-get update -qq && \
    apt-get install -y -qq git python3 python3-pip python3-venv python-is-python3 python3-pytest > /dev/null 2>&1 && \
    apt-get clean && rm -rf /var/lib/apt/lists/* && \
    npm install -g opencode-ai 2>/dev/null && \
    pip install --break-system-packages twine build 2>/dev/null || true

WORKDIR /workspace
