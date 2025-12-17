#!/bin/bash
# zed-cmd - Interactive paredit command runner for Zed editor
# Uses Zed's environment variables for file/cursor context

if [ -n "$1" ]; then
  cmd="$1"
else
  read -p "cmd: " cmd
fi

# Convert from 1-indexed (Zed) to 0-indexed (LSP)
row=$((ZED_ROW - 1))
col=$((ZED_COLUMN - 1))

curl -s -X POST http://localhost:7834/command \
  -H 'Content-Type: application/json' \
  -d "{\"command\": \"$cmd\", \"file\": \"$ZED_FILE\", \"row\": $row, \"col\": $col}" | jq
