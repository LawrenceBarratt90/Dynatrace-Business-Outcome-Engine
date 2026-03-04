# Business Observability Forge

<p align="center">
  <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=https://github.com/lawrobar90/Dynatrace-Business-Observability-Forge" alt="QR code linking to the Business Observability Forge repository on GitHub" />
</p>

A full-stack business observability platform that dynamically creates microservices, simulates multi-step customer journeys across industries, and integrates deeply with Dynatrace — featuring AI-powered chaos injection, automated remediation, and operational memory.

**This is a unified repo** — it contains both the **Engine** (Node.js server) and the **Forge UI** (Dynatrace AppEngine app).

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Dynamic Microservices** | Spawns real Node.js child processes per journey step — each with its own Express server, Dynatrace OneAgent identity, and health endpoint |
| **7 Industry Companies** | Banking, Insurance, Manufacturing, Retail, Smyths, Telecommunications, Travel & Hospitality — each with unique journey definitions |
| **Auto-Load System** | Generates 30–60 journeys/minute per active company with zero manual interaction |
| **AI Agent Hub** | 4 AI agents — Nemesis (chaos), Fix-It (remediation), Librarian (memory), Dashboard (deployment) |
| **Per-Service Chaos Injection** | Target individual services with configurable error rates without affecting the rest of the fleet |
| **Chaos State Persistence** | All feature flag overrides survive server restarts via `.chaos-state.json` |
| **Port Persistence** | Services get the same port across restarts via `.port-allocations.json` |
| **Dynatrace Integration** | OneAgent metadata propagation, event ingestion (CUSTOM_DEPLOYMENT), OAuth SSO, dashboard deployment, DT API proxy |
| **Monaco Config-as-Code** | Automated Dynatrace configuration deployment (capture rules, service naming, OpenPipeline, OneAgent features) |
| **Saved Config Library** | 24 pre-built industry journeys + user-saved configs with export/import |

---

## Deploy

### Prerequisites

- **Dynatrace Sprint tenant** (`*.sprint.dynatracelabs.com`)
- **Node.js v22+** and **Docker** on your host (EC2/VM)
- **2 Dynatrace credentials** (see [TECHNICAL-GUIDE.md](TECHNICAL-GUIDE.md#step-2-create-dynatrace-credentials) for how to create them):

| Credential | Type | Where To Create |
|-----------|------|-----------------|
| **API Token** | `dt0c01.*` | DT tenant → Settings → Access Tokens (scopes: `events.ingest`, `metrics.ingest`, `openTelemetryTrace.ingest`, `entities.read`) |
| **OAuth Client** | `dt0s10.*` | DT tenant → Settings → General → External Requests → Add EdgeConnect (then add `app-engine:apps:install` + `app-engine:apps:run` scopes in Account Management → IAM → OAuth clients) |

### One Command

```bash
git clone https://github.com/lawrobar90/Dynatrace-Business-Observability-Forge.git && cd Dynatrace-Business-Observability-Forge && ./setup.sh
```

The script prompts you for 4 values (tenant ID, API token, OAuth client ID, OAuth client secret), then automatically:

1. Installs npm packages
2. Configures & starts EdgeConnect (Docker)
3. Deploys the Forge UI to your Dynatrace tenant
4. Builds TypeScript agents
5. Starts the Engine server

**After setup:** Open **Dynatrace → Apps → Business Observability Forge** → Settings → Config → enter your private IP → Save → Test → Get Started checklist.

---

<details>
<summary><strong>Manual Setup (step-by-step)</strong></summary>

### Phase 1 — Pull

```bash
git clone https://github.com/lawrobar90/Dynatrace-Business-Observability-Forge.git
cd Dynatrace-Business-Observability-Forge
npm install
```

### Phase 2 — Deploy

```bash
# 1. Copy your EdgeConnect YAML (downloaded from DT External Requests page)
#    Or edit edgeconnect/edgeConnect.yaml manually with your OAuth Client values
cp ~/Downloads/edgeConnect.yaml edgeconnect/edgeConnect.yaml

# 2. Start EdgeConnect tunnel
bash edgeconnect/run-edgeconnect.sh

# 3. Deploy Forge UI to Dynatrace AppEngine
#    (setup.sh handles credentials automatically — for manual deploy, run ./setup.sh)
npx dt-app deploy

# 4. Build agents & start the Engine server
npm run build:agents
npm start
```

### Phase 3 — Configure

1. Open Dynatrace → **Apps** → **Business Observability Forge**
2. Go to **Settings** (gear icon) → **Config** tab
3. Set Host/IP to your **private IP** (not public!) — find it with `hostname -I | awk '{print $1}'`
4. Set Port to `8080`, Protocol to `HTTP`
5. Click **Save**, then **Test**
6. Go to **Get Started** tab → work through the checklist (deploy OpenPipeline, capture rules, etc.)
7. Go to **Home** → pick a template → click **Run**

> **AWS users:** Always use the **private IP** (e.g. `172.31.x.x`), not the Elastic/public IP. AWS does not support NAT hairpin.

</details>

For the full detailed guide, see [TECHNICAL-GUIDE.md](TECHNICAL-GUIDE.md).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Dynatrace Platform                            │
│                                                                  │
│  ┌──────────────────────────┐   ┌───────────────────────────┐   │
│  │  Business Observability  │   │  Services / BizEvents /   │   │
│  │  Forge UI (AppEngine)    │   │  Dashboards / Problems    │   │
│  └──────────┬───────────────┘   └───────────────────────────┘   │
│             │ EdgeConnect Tunnel                  ▲               │
│             │ (HTTPS → port 8080)                 │ OneAgent +   │
│             │                                     │ OTLP         │
└─────────────┼─────────────────────────────────────┼──────────────┘
              │                                     │
              ▼                                     │
┌─────────────────────────────────────────────────────────────────┐
│  Your Host (EC2 / VM / Codespace)                                │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Main Server (port 8080) — Express.js + Socket.IO        │   │
│  │  ├── API routes, AI Agents, Journey Engine              │   │
│  │  └── Dynatrace Event Ingestion + DT API Proxy           │   │
│  └──────────────────────────────────────────────────────────┘   │
│                          │                                       │
│              spawns child processes                               │
│                          ▼                                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Dynamic Child Services (ports 8081–8200)                │   │
│  │  Each = separate Node.js process with OneAgent identity  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌────────────────┐  ┌───────────┐  ┌────────────────────┐     │
│  │  EdgeConnect    │  │  OneAgent  │  │  Ollama (LLM)     │     │
│  │  (tunnel)       │  │           │  │  llama3.2          │     │
│  └────────────────┘  └───────────┘  └────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

---

## AI Agent Hub

The Agent Hub (Step 4 in the UI) provides four specialized AI agents powered by an LLM backend (Ollama).

### Nemesis — Chaos Agent
Controlled chaos injection with LLM-powered recipe selection.

- **7 chaos recipes**: `enable_errors`, `increase_error_rate`, `slow_responses`, `disable_circuit_breaker`, `disable_cache`, `target_company`, `custom_flag`
- **Per-service targeting**: Errors only affect the targeted service — other services remain healthy
- **Configurable intensity**: Scale 1–10 maps to 10%–100% error rates
- **Auto-revert**: Configurable duration timers automatically restore healthy state
- **Safety lock**: Max concurrent faults limit
- **Dynatrace events**: Every chaos injection sends a `CUSTOM_DEPLOYMENT` event with `[ROOT CAUSE]` metadata

### Fix-It — Remediation Agent
Autonomous problem detection, diagnosis, and remediation.

- **Full pipeline**: Detect → Diagnose → Propose Fix → Execute → Verify → Learn
- **Dynatrace-aware**: Queries DT problems, logs, metrics, and topology for diagnosis
- **7 fix types**: `disable_errors`, `reset_feature_flags`, `reduce_error_rate`, `enable_circuit_breaker`, `enable_cache`, `disable_slow_responses`, `send_dt_event`
- **LLM agent loop**: Function calling for intelligent decision-making
- **Learning**: Records outcomes to Librarian for future reference

### Librarian — Operational Memory
Persistent knowledge store for the AI agent ecosystem.

- **Vector store**: Similarity search across past incidents
- **History store**: Chronological event timeline
- **Records**: Chaos events, reverts, DT problems, diagnoses, fixes, outcomes
- **LLM-powered learning**: Generates insights from incident history

### Dashboard — AI Dashboard Deployer
One-click Dynatrace dashboard deployment.

- **Pre-built dashboards**: Generate from journey configurations
- **AI-generated**: LLM creates custom dashboard JSON
- **Deployment**: Via Dynatrace Document API (OAuth or API token auth)

---

## Auto-Load System

Once services are running, the auto-load system automatically generates realistic traffic:

- **30–60 journeys/minute** per active company
- **Zero interaction required** — starts automatically when services come online
- **Service watcher**: Polls for new/removed companies every 10 seconds
- **Randomized profiles**: 10 customer profiles across 4 priority levels
- **Tracks metrics**: Iterations, successes, and errors per company
- **Stops automatically** when services are shut down

---

## Chaos Injection & Feature Flags

### Per-Service Isolation
Each child service fetches its own feature flags from the main server (`GET /api/feature_flag?service=<name>`). Only services with explicit overrides receive elevated error rates.

### Key Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/feature_flag` | Get global + per-service flags |
| `POST` | `/api/feature_flag` | Set global or targeted (`targetService`) overrides |
| `DELETE` | `/api/feature_flag/service/:name` | Remove a per-service override |
| `POST` | `/api/remediation/feature-flag` | Set remediation flags + send DT event |

### Persistence
- Feature flag overrides → `.chaos-state.json` (restored on startup)
- Service port assignments → `.port-allocations.json` (restored on startup)
- Dynatrace credentials → `.dt-credentials.json` (restored on startup)

---

## Dynatrace Integration

### Event Ingestion
Every chaos injection and remediation action sends a `CUSTOM_DEPLOYMENT` event to Dynatrace with rich metadata:
- `deployment.project`, `deployment.name`, `deployment.version`
- `dt.event.is_rootcause_relevant: true`
- `dt.event.description` with `[ROOT CAUSE]` or `[REMEDIATION]` prefixes

### DT API Proxy
Agents query Dynatrace through local proxy endpoints:

| Endpoint | DT API |
|----------|--------|
| `/api/dt-proxy/problems` | Problems v2 |
| `/api/dt-proxy/events` | Events v2 |
| `/api/dt-proxy/metrics` | Metrics v2 |
| `/api/dt-proxy/entities` | Entities v2 |
| `/api/dt-proxy/logs` | Logs v2 |

### OneAgent Metadata
Each child service gets Dynatrace environment variables:
- `DT_APPLICATION_ID`, `DT_CUSTOM_PROP`, `DT_TAGS`, `DT_CLUSTER_ID`
- Release metadata for version tracking

### Authentication
- **OAuth SSO**: Dynatrace Sprint SSO via `simple-oauth2` (authorization code grant)
- **API Token**: Direct token auth for event ingestion
- **UI Config**: ⚙️ Settings modal for credential management

### Monaco Config-as-Code

```bash
# Automated deployment via Settings API
npm run configure:dynatrace

# Or via Monaco CLI
npm run configure:monaco
```

Deploys: OneAgent features, capture rules, service naming, OpenPipeline pipelines & routing.

---

## UI Overview

### 5-Tab Wizard

| Tab | Description |
|-----|-------------|
| 🏠 **Welcome** | Application overview and getting-started guide |
| **Step 1: Customer Details** | Company name, domain, industry type input |
| **Step 2: Generate Prompts** | AI/Copilot prompt generation for journey creation |
| **Step 3: Generate Data** | Journey simulation controls, data generation, LoadRunner integration |
| 🤖 **Step 4: AI Agent Hub** | Nemesis / Fix-It / Librarian / Dashboard agent controls |

### Additional UI Elements
- **Saved Prompts Sidebar** (left panel): Save/load/duplicate/delete/export/import journey configs. 24 pre-built + user-saved configs.
- **Service Status Dropdown** (top-right): Live service status with refresh.
- **Dynatrace Settings Modal**: Configure DT environment URL + API token from the UI.

---

## Technical Stack

| Component | Technology |
|-----------|-----------|
| **Runtime** | Node.js v22+ (ESM modules) |
| **Framework** | Express.js 4 + Socket.IO 4 |
| **AI Agents** | TypeScript → compiled to `dist/` |
| **LLM Backend** | Ollama (llama3.2) |
| **Observability** | Dynatrace OneAgent + OpenTelemetry |
| **Frontend** | Single-page HTML + Tailwind CSS (dark theme) |
| **Auth** | OAuth 2.0 via `simple-oauth2` |
| **Proxy** | nginx with SSL (port 443) |

---

## Project Structure

```
├── server.js                    # Main application server (~4,700 lines, 75+ endpoints)
├── package.json                 # business-observability-engine v0.1.0
├── .env.template                # Environment variable template
│
├── agents/                      # TypeScript AI agent source
│   ├── nemesis/                 # Chaos injection agent
│   ├── fixit/                   # Auto-remediation agent
│   └── librarian/               # Operational memory agent
├── dist/                        # Compiled TypeScript output
│
├── tools/                       # TypeScript tool libraries
│   ├── chaos/                   # 7 chaos recipes
│   ├── dynatrace/               # DT API wrappers + LLM tool definitions
│   └── fixes/                   # 7 fix type implementations
├── utils/                       # LLM client, config, logger, OpenTelemetry
│
├── routes/                      # 18 Express route modules
│   ├── journey-simulation.js    # Full journey simulation engine (2,639 lines)
│   ├── oauth.js                 # Dynatrace OAuth SSO
│   ├── mcp-integration.js       # MCP session management (1,305 lines)
│   ├── ai-dashboard.js          # AI dashboard generation
│   ├── loadrunner-*.js          # LoadRunner integration
│   └── ...                      # Journey, simulate, metrics, steps, flow, config, proxy
│
├── services/                    # Core service infrastructure
│   ├── service-manager.js       # Dynamic service creation (1,040 lines)
│   ├── dynamic-step-service.cjs # Child service template (1,183 lines)
│   ├── auto-load.js             # Auto-load watcher (327 lines)
│   ├── port-manager.js          # Port allocation + persistence (364 lines)
│   ├── service-runner.cjs       # Individual service spawner
│   └── ...                      # Child-caller, event service, metrics service
│
├── middleware/                   # Express middleware
│   └── dynatrace-metadata.js    # DT metadata injection/propagation
│
├── public/                      # Frontend
│   └── index.html               # Single-page UI (~10,800 lines)
│
├── saved-configs/               # 32 persisted journey configs (24 default + 8 user)
├── dynatrace-monaco/            # Monaco v2 config-as-code project
├── dynatrace-workflows/         # Self-healing workflow JSON
├── dashboards/                  # Sample/generated dashboard JSON
├── loadrunner-tests/            # LoadRunner scenarios by industry
├── memory/                      # Vector + history stores for Librarian
├── prompts/                     # AI prompt templates (system context, DQL, dashboards)
├── scripts/                     # Operational scripts (deploy, simulate, nginx, autostart)
├── nginx/                       # Nginx reverse proxy config
├── k8s/                         # Kubernetes deployment manifests
├── logs/                        # Application + continuous-generation logs
│
├── .chaos-state.json            # Persisted chaos/feature flag state
├── .dt-credentials.json         # Persisted Dynatrace credentials
└── .port-allocations.json       # Persisted port-to-service mappings
```

---

## API Route Summary

| Mount | Purpose |
|-------|---------|
| `/api/journey-simulation` | Full journey simulation engine |
| `/api/journey` | Journey CRUD |
| `/api/simulate` | Basic simulation |
| `/api/metrics` | Metrics endpoints |
| `/api/steps` | Step management |
| `/api/flow` | Flow visualization |
| `/api/config` | Copilot prompt generation |
| `/api/nemesis` | Nemesis chaos agent API |
| `/api/fixit` | Fix-It remediation agent API |
| `/api/librarian` | Librarian memory agent API |
| `/api/ai-dashboard` | AI dashboard generation |
| `/api/loadrunner` | LoadRunner integration |
| `/api/loadrunner-service` | LoadRunner service management |
| `/api/oauth` | Dynatrace OAuth SSO |
| `/api/service-proxy` | Service proxy |
| `/api/feature_flag` | Feature flag management |
| `/api/remediation/*` | Remediation flag management |
| `/api/dt-proxy/*` | Dynatrace API proxy |
| `/api/dynatrace/*` | Dashboard deployment, connection test |
| `/api/admin/*` | Service management, config persistence, credentials |

---

## Management Commands

```bash
./start-server.sh    # Full startup with nginx + all services
./status.sh          # Detailed status report
./stop.sh            # Stop all services
./restart.sh         # Restart application
```

```bash
npm start                       # Start server
npm run build:agents            # Compile TypeScript agents
npm run configure:dynatrace     # Deploy DT config via Settings API
npm run configure:monaco        # Deploy DT config via Monaco CLI
```

---

## Demo Walkthrough

1. **Start the server** → services auto-create as journeys are defined
2. **Step 1**: Enter company details (or pick from 24 pre-built industry journeys)
3. **Step 2**: Generate AI/Copilot prompts for journey definition
4. **Step 3**: Run journey simulation — services spin up dynamically, auto-load begins
5. **Step 4**: Open the AI Agent Hub:
   - Use **Nemesis** to inject chaos into a specific service
   - Watch **Dynatrace** detect the problem
   - Let **Fix-It** autonomously diagnose and remediate
   - Review the full incident timeline in **Librarian**
   - Deploy a **Dashboard** to visualize the journey

---

**Built for Dynatrace Partner Power-Up Program**
Demonstrating advanced business observability with AI-powered chaos engineering and automated remediation.
