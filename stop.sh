#!/bin/bash
# Stop the Business Observability Forge server
cd "$(dirname "$0")"

echo "🛑 Stopping Business Observability Forge..."

# Stop via PID file
if [[ -f server.pid ]]; then
  PID=$(cat server.pid)
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    echo "  Stopped server (PID $PID)"
    sleep 2
    # Force kill if still running
    if kill -0 "$PID" 2>/dev/null; then
      kill -9 "$PID" 2>/dev/null
      echo "  Force killed PID $PID"
    fi
  fi
  rm -f server.pid
fi

# Catch any remaining node server processes
pkill -f "node.*server.js" 2>/dev/null || true
sleep 1

# Verify port is free
if command -v fuser &>/dev/null; then
  fuser 8080/tcp 2>/dev/null && fuser -k 8080/tcp 2>/dev/null || true
fi

echo "✅ Server stopped"
