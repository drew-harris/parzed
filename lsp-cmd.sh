#!/bin/bash
# lsp-cmd
curl -s -X POST http://localhost:3000/command \
  -H 'Content-Type: application/json' \
  -d "{\"command\": \"$1\", \"file\": \"$2\", \"row\": $3, \"col\": $4}" | jq
