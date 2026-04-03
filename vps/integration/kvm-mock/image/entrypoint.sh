#!/bin/sh
set -eu
# One container per tier: Ollama (bootstrap.sh §4 env from compose) + nginx for Rowboat/Bifrost /health URLs.
ollama serve &
exec nginx -g "daemon off;"
