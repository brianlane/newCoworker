# Single “VPS in a box”: Ollama + nginx stubs for Rowboat :3000/health and Bifrost :8080/health.
# Tier-specific env (starter vs standard) is supplied by docker-compose.
FROM ollama/ollama:latest
USER root
RUN if command -v apt-get >/dev/null 2>&1; then \
      apt-get update \
      && apt-get install -y --no-install-recommends nginx curl \
      && rm -rf /var/lib/apt/lists/*; \
    else \
      apk add --no-cache nginx curl; \
    fi
COPY nginx-integration.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
