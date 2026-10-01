#!/usr/bin/env bash
exec node "$(dirname "${BASH_SOURCE[0]}")/audit-session-attribution.js" "$@"
