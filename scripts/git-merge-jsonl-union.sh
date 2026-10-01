#!/usr/bin/env bash
exec node "$(dirname "${BASH_SOURCE[0]}")/git-merge-jsonl-union.js" "$@"
