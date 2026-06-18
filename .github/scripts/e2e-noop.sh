#!/usr/bin/env bash
set -euo pipefail

echo "Running Strux builder E2E placeholder"

if [[ "${STRUX_IN_CONTAINER:-}" != "1" ]]; then
    echo "Expected STRUX_IN_CONTAINER=1 inside the builder image" >&2
    exit 1
fi

command -v strux
command -v strux-introspect

strux --version

echo "E2E placeholder passed"
