#!/bin/bash
# zed-eval - Evaluate Clojure code via nREPL from Zed editor
# Uses ZED_SELECTED_TEXT, ZED_FILE, ZED_ROW, ZED_COLUMN environment variables

# Colors
DIM='\033[2m'
CYAN='\033[36m'
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
BOLD='\033[1m'
RESET='\033[0m'

# Convert from 1-indexed (Zed) to 0-indexed (LSP)
row=$((ZED_ROW - 1))
col=$((ZED_COLUMN - 1))

# Check if we have selected text or need to find form at cursor
if [ -n "$ZED_SELECTED_TEXT" ]; then
  # Escape the selected text for JSON
  code=$(echo "$ZED_SELECTED_TEXT" | jq -Rs .)
  result=$(curl -s -X POST http://localhost:7834/eval \
    -H 'Content-Type: application/json' \
    -d "{\"code\": $code, \"file\": \"$ZED_FILE\"}")
else
  # No selection - find form at cursor
  result=$(curl -s -X POST http://localhost:7834/eval \
    -H 'Content-Type: application/json' \
    -d "{\"file\": \"$ZED_FILE\", \"row\": $row, \"col\": $col}")
fi

# Get recent history (last 5, excluding current)
history=$(curl -s "http://localhost:7834/history?last=6" | jq -r '.[:-1] | reverse | .[] | "\(.ns)> \(.code | gsub("\n"; " ") | .[0:50])\n\(.value // .err // "nil") (\(.ms)ms)"')

# Print history header
if [ -n "$history" ]; then
  echo -e "${DIM}─────────────────────────────────────────${RESET}"
  echo -e "${DIM}Recent:${RESET}"
  echo "$history" | while IFS= read -r line; do
    if [[ "$line" == *">"* ]] && [[ "$line" != "=>"* ]]; then
      echo -e "${DIM}  $line${RESET}"
    else
      echo -e "${DIM}  → $line${RESET}"
    fi
  done
  echo -e "${DIM}─────────────────────────────────────────${RESET}"
  echo ""
fi

# Parse current result
ns=$(echo "$result" | jq -r '.ns')
value=$(echo "$result" | jq -r '.value // empty')
out=$(echo "$result" | jq -r '.out // empty')
err=$(echo "$result" | jq -r '.err // empty')
error=$(echo "$result" | jq -r '.error // empty')
ms=$(echo "$result" | jq -r '.ms')

# Get code from selection or from result (when form was found at cursor)
if [ -n "$ZED_SELECTED_TEXT" ]; then
  code_source="$ZED_SELECTED_TEXT"
else
  code_source=$(echo "$result" | jq -r '.code // empty')
fi

code_display=$(echo "$code_source" | head -3)
code_lines=$(echo "$code_source" | wc -l | tr -d ' ')

# Print current evaluation
echo -e "${CYAN}${ns}>${RESET} ${BOLD}$code_display${RESET}"
if [ "$code_lines" -gt 3 ]; then
  echo -e "${DIM}  ... ($code_lines lines)${RESET}"
fi
echo ""

# Print stdout if present
if [ -n "$out" ]; then
  echo -e "${DIM}stdout:${RESET}"
  echo "$out"
  echo ""
fi

# Print result or error
if [ -n "$error" ]; then
  echo -e "${RED}Error: $error${RESET}"
elif [ -n "$err" ]; then
  echo -e "${RED}$err${RESET}"
elif [ -n "$value" ]; then
  echo -e "${GREEN}=> $value${RESET}"
else
  echo -e "${YELLOW}=> nil${RESET}"
fi

echo -e "${DIM}(${ms}ms)${RESET}"
