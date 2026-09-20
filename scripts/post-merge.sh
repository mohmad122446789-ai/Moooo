#!/usr/bin/env bash
set -euo pipefail

export CI=true

pnpm install --frozen-lockfile --prefer-offline
pnpm --filter @workspace/db run push-force
pnpm run build