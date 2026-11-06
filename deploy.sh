#!/bin/sh
# Updates the server to the latest code and restarts the dashboard. Data is kept.
set -eu
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "No .env file. Run: cp .env.example .env, then fill it in." >&2
  exit 1
fi

git pull --ff-only
docker compose up -d --build
docker compose ps
