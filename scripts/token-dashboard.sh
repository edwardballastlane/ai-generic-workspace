#!/usr/bin/env bash
exec node "$(dirname "${BASH_SOURCE[0]}")/token-dashboard.js" "$@"
