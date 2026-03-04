#!/bin/bash
# ============================================================
#  Business Observability Forge — One-Command Setup
# ============================================================
#  Usage:
#    git clone https://github.com/lawrobar90/Dynatrace-Business-Observability-Forge.git
#    cd Dynatrace-Business-Observability-Forge && ./setup.sh
#
#  The script will prompt you for 4 values if setup.conf doesn't exist.
#  Or pre-fill setup.conf and it runs non-interactively.
# ============================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF_FILE="$SCRIPT_DIR/setup.conf"

# ── Colors ──────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
step() { echo -e "\n${BLUE}━━━ $1 ━━━${NC}"; }
ok()   { echo -e "  ${GREEN}✓ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠ $1${NC}"; }
fail() { echo -e "  ${RED}✗ $1${NC}"; exit 1; }

echo -e "${BLUE}"
cat << 'BANNER'
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║     Business Observability Forge                             ║
║     One-Command Setup                                        ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
BANNER
echo -e "${NC}"

# ── Collect credentials ─────────────────────────────────────
# If setup.conf exists and is filled in, use it silently.
# Otherwise, prompt interactively.

if [ -f "$CONF_FILE" ]; then
  source "$CONF_FILE"
fi

prompt_if_missing() {
  local var_name="$1"
  local prompt_text="$2"
  local placeholder="$3"
  local current_val="${!var_name}"

  if [ -z "$current_val" ] || [ "$current_val" = "$placeholder" ]; then
    echo -ne "  ${CYAN}${prompt_text}${NC} "
    read -r input
    if [ -z "$input" ]; then
      fail "$var_name is required. Cannot continue."
    fi
    eval "$var_name=\"$input\""
  fi
}

NEED_PROMPT=false
if [ -z "$TENANT_ID" ] || [ "$TENANT_ID" = "YOUR_TENANT_ID" ] || \
   [ -z "$API_TOKEN" ] || [[ "$API_TOKEN" == *"XXXX"* ]] || \
   [ -z "$OAUTH_CLIENT_ID" ] || [[ "$OAUTH_CLIENT_ID" == *"XXXX"* ]] || \
   [ -z "$OAUTH_CLIENT_SECRET" ] || [[ "$OAUTH_CLIENT_SECRET" == *"YYYY"* ]]; then
  NEED_PROMPT=true
fi

if [ "$NEED_PROMPT" = true ]; then
  echo -e "${BOLD}  We need 4 values. The prompts below tell you where to find each one.${NC}"
  echo ""

  # 1. Tenant ID
  echo -e "  ${CYAN}─── 1/4: Tenant ID ───${NC}"
  echo -e "  ${YELLOW}Look at your Dynatrace URL: https://${BOLD}<THIS-PART>${NC}${YELLOW}.sprint.dynatracelabs.com${NC}"
  prompt_if_missing "TENANT_ID" "Tenant ID:" "YOUR_TENANT_ID"
  echo ""

  # 2. API Token
  echo -e "  ${CYAN}─── 2/4: API Token ───${NC}"
  echo -e "  ${YELLOW}Dynatrace → Settings → Access Tokens → Generate new token${NC}"
  echo -e "  ${YELLOW}Scopes: events.ingest, metrics.ingest, openTelemetryTrace.ingest, entities.read${NC}"
  echo -e "  ${YELLOW}Starts with: dt0c01.${NC}"
  prompt_if_missing "API_TOKEN" "API Token:" "dt0c01.XXXX..."
  echo ""

  # 3. OAuth Client ID
  echo -e "  ${CYAN}─── 3/4: OAuth Client ID ───${NC}"
  echo -e "  ${YELLOW}Dynatrace → Settings → General → External Requests → Add EdgeConnect${NC}"
  echo -e "  ${YELLOW}DT generates the OAuth credentials — copy the Client ID${NC}"
  echo -e "  ${YELLOW}Starts with: dt0s10.  (NOT dt0s02 — that's account-level, won't work)${NC}"
  prompt_if_missing "OAUTH_CLIENT_ID" "OAuth Client ID:" "dt0s10.XXXX"
  echo ""

  # 4. OAuth Client Secret
  echo -e "  ${CYAN}─── 4/4: OAuth Client Secret ───${NC}"
  echo -e "  ${YELLOW}Same page as above — shown only once when you create the EdgeConnect!${NC}"
  echo -e "  ${YELLOW}Starts with: dt0s10.  (longer than the ID, contains a dot in the middle)${NC}"
  prompt_if_missing "OAUTH_CLIENT_SECRET" "OAuth Client Secret:" "dt0s10.XXXX.YYYY..."
  echo ""
fi

# ── Validate credential formats (always, even from setup.conf) ──
if [[ ! "$API_TOKEN" == dt0c01.* ]]; then
  fail "API Token must start with 'dt0c01.' — you entered '${API_TOKEN:0:10}...'. Delete setup.conf and re-run ./setup.sh"
fi
if [[ ! "$OAUTH_CLIENT_ID" == dt0s10.* ]]; then
  echo -e "  ${RED}✗ OAuth Client ID must start with 'dt0s10.' (environment-level)${NC}"
  echo -e "  ${YELLOW}  You entered '${OAUTH_CLIENT_ID:0:12}...' which looks like an account-level token (dt0s02).${NC}"
  echo -e "  ${YELLOW}  Create it in: Dynatrace → Settings → General → External Requests → Add EdgeConnect${NC}"
  echo -e "  ${YELLOW}  Then delete setup.conf and re-run ./setup.sh${NC}"
  exit 1
fi
if [[ ! "$OAUTH_CLIENT_SECRET" == dt0s10.* ]]; then
  echo -e "  ${RED}✗ OAuth Client Secret must start with 'dt0s10.' (environment-level)${NC}"
  echo -e "  ${YELLOW}  You entered '${OAUTH_CLIENT_SECRET:0:12}...' — this looks like an account-level secret.${NC}"
  echo -e "  ${YELLOW}  The secret comes from the same EdgeConnect page as the Client ID.${NC}"
  echo -e "  ${YELLOW}  Delete setup.conf and re-run ./setup.sh${NC}"
  exit 1
fi

# Save valid credentials for future runs
if [ "$NEED_PROMPT" = true ]; then
  cat > "$CONF_FILE" << EOF
TENANT_ID="$TENANT_ID"
API_TOKEN="$API_TOKEN"
OAUTH_CLIENT_ID="$OAUTH_CLIENT_ID"
OAUTH_CLIENT_SECRET="$OAUTH_CLIENT_SECRET"
EOF
  ok "Saved to setup.conf (won't ask again)"
fi

# Derive URLs
TENANT_URL="https://${TENANT_ID}.sprint.dynatracelabs.com"
APPS_URL="https://${TENANT_ID}.sprint.apps.dynatracelabs.com"
SSO_URL="https://sso-sprint.dynatracelabs.com/sso/oauth2/token"
PRIVATE_IP=$(hostname -I | awk '{print $1}')

echo -e "  Tenant:     ${BOLD}$TENANT_URL${NC}"
echo -e "  Private IP: ${BOLD}$PRIVATE_IP${NC}"

# ── Step 1: Prerequisites ──────────────────────────────────
step "Step 1/6: Checking prerequisites"

install_node22() {
  echo "  Installing Node.js v22..."
  # Remove old Node.js first (dnf/yum won't upgrade if already installed from default repo)
  if command -v node &>/dev/null; then
    echo "  Removing old Node.js $(node --version)..."
    sudo dnf remove -y nodejs npm 2>/dev/null || sudo yum remove -y nodejs npm 2>/dev/null || sudo apt-get remove -y nodejs 2>/dev/null || true
    hash -r 2>/dev/null || true
  fi
  if command -v dnf &>/dev/null; then
    # Amazon Linux 2023 / Fedora / RHEL 9+
    curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - 2>&1 | tail -1
    sudo dnf install -y nodejs 2>&1 | tail -3
  elif command -v yum &>/dev/null; then
    # Amazon Linux 2 / RHEL 7-8 / CentOS
    curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - 2>&1 | tail -1
    sudo yum install -y nodejs 2>&1 | tail -3
  elif command -v apt-get &>/dev/null; then
    # Ubuntu / Debian
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - 2>&1 | tail -1
    sudo apt-get install -y nodejs 2>&1 | tail -3
  else
    fail "Cannot auto-install Node.js — install v22+ manually: https://nodejs.org"
  fi
  # Refresh path
  hash -r 2>/dev/null || true
}

NEED_NODE=false
if ! command -v node &>/dev/null; then
  NEED_NODE=true
else
  NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -lt 22 ]; then
    warn "Node.js $(node --version) found but v22+ required — upgrading..."
    NEED_NODE=true
  fi
fi

if [ "$NEED_NODE" = true ]; then
  install_node22
  if ! command -v node &>/dev/null; then
    fail "Node.js installation failed. Install v22+ manually: https://nodejs.org"
  fi
  NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -lt 22 ]; then
    fail "Node.js v22+ required but got $(node --version) after install. Install manually."
  fi
fi
ok "Node.js $(node --version)"

if ! command -v docker &>/dev/null; then
  echo "  Installing Docker..."
  sudo yum install -y docker 2>/dev/null || sudo apt-get install -y docker.io 2>/dev/null
  sudo systemctl start docker
  sudo systemctl enable docker
  sudo usermod -aG docker "$(whoami)"
  ok "Docker installed"
else
  ok "Docker $(docker --version | awk '{print $3}' | tr -d ',')"
fi

if ! sudo docker info &>/dev/null 2>&1; then
  sudo systemctl start docker
fi

# ── Step 2: npm install ────────────────────────────────────
step "Step 2/6: Installing packages"

if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  cd "$SCRIPT_DIR"
  npm install 2>&1 | tail -3
fi
ok "npm packages ready"

# ── Step 3: Credentials file ──────────────────────────────
step "Step 3/6: Configuring credentials"

cat > "$SCRIPT_DIR/.dt-credentials.json" << EOF
{
  "environmentUrl": "$TENANT_URL",
  "apiToken": "$API_TOKEN",
  "otelToken": "$API_TOKEN"
}
EOF
ok "Created .dt-credentials.json"

# ── Step 4: EdgeConnect ────────────────────────────────────
step "Step 4/6: Starting EdgeConnect"

cat > "$SCRIPT_DIR/edgeconnect/edgeConnect.yaml" << EOF
name: bizobs-generator
api_endpoint_host: ${TENANT_ID}.sprint.apps.dynatracelabs.com
oauth:
  client_id: ${OAUTH_CLIENT_ID}
  client_secret: ${OAUTH_CLIENT_SECRET}
  resource: urn:dtenvironment:${TENANT_ID}
  endpoint: ${SSO_URL}
EOF
ok "EdgeConnect YAML generated"

CONTAINER_NAME="edgeconnect-bizobs"
if sudo docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  sudo docker stop "$CONTAINER_NAME" 2>/dev/null || true
  sudo docker rm "$CONTAINER_NAME" 2>/dev/null || true
fi

echo "  Pulling EdgeConnect image..."
sudo docker pull dynatrace/edgeconnect:latest 2>&1 | tail -1

sudo docker run -d --restart always \
  --name "$CONTAINER_NAME" \
  --network host \
  --mount "type=bind,src=$SCRIPT_DIR/edgeconnect/edgeConnect.yaml,dst=/edgeConnect.yaml" \
  dynatrace/edgeconnect:latest > /dev/null

sleep 5
if sudo docker ps --filter "name=$CONTAINER_NAME" --format '{{.Status}}' | grep -q "Up"; then
  ok "EdgeConnect running"
else
  warn "EdgeConnect may not have started — check: docker logs $CONTAINER_NAME"
fi

# ── Step 5: Deploy app ─────────────────────────────────────
step "Step 5/6: Deploying Forge UI to Dynatrace"

cd "$SCRIPT_DIR"
export DT_APP_OAUTH_CLIENT_ID="$OAUTH_CLIENT_ID"
export DT_APP_OAUTH_CLIENT_SECRET="$OAUTH_CLIENT_SECRET"

echo "  Building and deploying (this takes ~30 seconds)..."
if npx dt-app deploy --non-interactive 2>&1 | tail -3; then
  ok "Forge UI deployed"
else
  warn "Deploy may have failed — you can retry: npx dt-app deploy"
fi

# ── Step 6: Build & start server ───────────────────────────
step "Step 6/6: Starting server"

echo "  Compiling TypeScript agents..."
npm run build:agents 2>&1 | tail -1

# Kill any existing server
if [ -f "$SCRIPT_DIR/server.pid" ]; then
  kill "$(cat "$SCRIPT_DIR/server.pid")" 2>/dev/null || true
fi

echo "  Starting server in background..."
nohup npm start > "$SCRIPT_DIR/server.log" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$SCRIPT_DIR/server.pid"

for i in {1..20}; do
  if curl -s http://localhost:8080/api/health > /dev/null 2>&1; then
    ok "Server running on port 8080 (PID: $SERVER_PID)"
    break
  fi
  sleep 1
done

if ! curl -s http://localhost:8080/api/health > /dev/null 2>&1; then
  warn "Server still starting — check: tail -f server.log"
fi

# ── Done ────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗"
echo -e "║                    Setup Complete!                        ║"
echo -e "╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}Open Dynatrace → Apps → Business Observability Forge${NC}"
echo ""
echo -e "  Then in Settings → Config tab:"
echo -e "    Host/IP:  ${BOLD}$PRIVATE_IP${NC}"
echo -e "    Port:     ${BOLD}8080${NC}"
echo -e "    Protocol: ${BOLD}HTTP${NC}"
echo ""
echo -e "  ${YELLOW}Click Save → Test → then work through the Get Started checklist.${NC}"
echo ""
echo -e "  Commands:"
echo -e "    tail -f server.log                    # Server logs"
echo -e "    docker logs -f edgeconnect-bizobs     # EdgeConnect logs"
echo -e "    curl localhost:8080/api/health        # Health check"
echo -e "    kill \$(cat server.pid)                # Stop server"
echo ""
