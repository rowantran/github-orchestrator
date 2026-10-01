#!/bin/sh
set -eu
cd "$(dirname "$0")"
npm ci --ignore-scripts --no-audit --no-fund
exec npx playwright test "$@"
