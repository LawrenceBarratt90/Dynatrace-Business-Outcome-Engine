# Technical Guide — Business Observability Forge

> A hands-on guide for engineers, SEs, and developers who want to get the platform running and understand what's under the hood.

---

## What Is This?

The Business Observability Forge is a two-part system:

1. **The Engine** — A Node.js server that dynamically spawns microservices, simulates customer journeys, and runs AI agents for chaos injection and auto-remediation.
2. **The Forge UI** — A Dynatrace AppEngine app (React + Strato) that gives you a single-pane-of-glass inside Dynatrace to control everything.

The Engine runs on your host (EC2, VM, Codespace). The Forge UI runs inside Dynatrace and talks to the Engine through an **EdgeConnect** tunnel.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
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
┌──────────────────────────────────────────────────────────────────┐
│  Your Host (EC2 / VM / Codespace)                                │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Main Server (port 8080) — Express.js + Socket.IO        │   │
│  │  ├── 18 API route modules (75+ endpoints)                │   │
│  │  ├── AI Agents: Nemesis (chaos), Fix-It (remediation),   │   │
│  │  │              Librarian (memory), Dashboard (deploy)    │   │
│  │  ├── Feature Flag Manager (per-service isolation)        │   │
│  │  ├── Journey Simulation Engine                           │   │
│  │  └── Dynatrace Event Ingestion + DT API Proxy           │   │
│  └──────────────────────────────────────────────────────────┘   │
│                          │                                       │
│              spawns child processes                               │
│                          ▼                                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Dynamic Child Services (ports 8081–8200)                │   │
│  │  Each = separate Node.js process with:                   │   │
│  │  ├── Own Express server + /health endpoint               │   │
│  │  ├── Dynatrace OneAgent identity (unique DT_TAGS)        │   │
│  │  ├── Per-service feature flags from main server          │   │
│  │  └── Service-to-service call chaining                    │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌────────────────┐  ┌───────────┐  ┌────────────────────┐     │
│  │  EdgeConnect    │  │  OneAgent  │  │  Ollama (LLM)     │     │
│  │  (tunnel)       │  │           │  │  llama3.2          │     │
│  └────────────────┘  └───────────┘  └────────────────────┘     │
└──────────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

| Component | Version | Purpose |
|-----------|---------|---------|
| **Node.js** | v22+ | Server runtime |
| **Dynatrace OneAgent** | Latest | Auto-instruments every child service |
| **Dynatrace Tenant** | Sprint or Managed | Receives bizevents, traces, events |
| **EdgeConnect** | Latest | Tunnels AppEngine UI → your server |
| **Ollama** (optional) | Latest | Powers AI agents (Nemesis, Fix-It, Librarian) |

---

## Getting Started

### 1. Clone & Install

```bash
git clone https://github.com/lawrobar90/Dynatrace-AI-Business-Observability-Engine.git
cd Dynatrace-AI-Business-Observability-Engine
npm install
```

### 2. Configure Dynatrace Credentials

Create `.dt-credentials.json` in the project root:

```json
{
  "environmentUrl": "https://YOUR_TENANT.sprint.dynatracelabs.com",
  "apiToken": "dt0c01.XXXX...",
  "otelToken": "dt0c01.YYYY..."
}
```

Or set environment variables:

```bash
export DT_ENVIRONMENT="https://YOUR_TENANT.sprint.dynatracelabs.com"
export DT_PLATFORM_TOKEN="dt0c01.XXXX..."
```

### 3. Start the Server

```bash
npm start
# Server starts on port 8080
# Health check: http://localhost:8080/api/health
```

The server will:
- Start Express on port 8080
- Initialize route modules and AI agents (if Ollama is available)
- Wait for journeys to be launched from the Forge UI
- **No services are spawned by default** — the server starts clean

### 4. Deploy EdgeConnect

EdgeConnect creates a secure tunnel from Dynatrace to your server. Edit `edgeconnect/edgeConnect.yaml`:

```yaml
name: bizobs-generator
api_endpoint_host: YOUR_TENANT.sprint.apps.dynatracelabs.com
oauth:
  client_id: dt0s10.XXXXX
  client_secret: dt0s10.XXXXX.YYYYY...
  resource: urn:dtenvironment:YOUR_TENANT_ID
  endpoint: https://sso-sprint.dynatracelabs.com/sso/oauth2/token
```

Run it:

```bash
cd edgeconnect
./run-edgeconnect.sh
```

### 5. Deploy the AppEngine UI

```bash
# From the Dynatrace-Business-Observability-Forge repo
npx dt-app deploy
```

This deploys the Forge UI to your Dynatrace tenant. Open it from **Apps → Business Observability Forge**.

### 6. Configure from the Forge UI

The **Get Started** tab in the Forge UI walks you through:

| Step | What It Does |
|------|-------------|
| Configure Server IP | Set the IP/hostname of your engine server |
| Create EdgeConnect | Auto-creates EdgeConnect config in Dynatrace |
| Deploy EdgeConnect | Instructions for running EdgeConnect on your host |
| Verify EdgeConnect Online | Polls DT to confirm tunnel is up |
| OneAgent Installed | Verifies OneAgent is reporting from your host |
| Test Connection | Pings the engine through the EdgeConnect tunnel |
| OpenPipeline Pipeline | Creates the BizEvents processing pipeline |
| OpenPipeline Routing | Configures routing rules for business events |
| Business Event Capture Rule | Deploys capture rules for OneAgent |
| OneAgent Feature Flags | Enables required OneAgent feature flags |

Each step has a **Deploy** button that auto-configures the Dynatrace settings via the Settings API — no manual configuration needed.

---

## How It Works

### Journey Simulation Flow

```
1. User picks a template (e.g. "Healthcare Provider — Patient Care Journey")
   or enters custom company details
                    │
                    ▼
2. Engine spawns child services (one per journey step)
   e.g. PatientRegistrationService (port 8081)
        TriageAndAssessmentService (port 8082)
        ClinicalConsultationService (port 8083)
        ...
                    │
                    ▼
3. Auto-load generates continuous traffic
   - Random customer profiles
   - Realistic timing between steps
   - OneAgent captures each request as a bizevent
                    │
                    ▼
4. Dynatrace sees:
   - Services in Smartscape topology
   - Business events in BizEvents
   - Traces with full distributed context
   - Custom properties (company, industry, step, revenue, etc.)
```

### The Template Library

24 pre-built industry journey templates across 8 verticals:

| Industry | Journeys |
|----------|----------|
| **Banking** | Account Opening, Fraud Resolution, Loan Application |
| **Insurance** | Claims, Purchase, Renewal |
| **Manufacturing** | Maintenance Support, Procurement, Upgrade Project |
| **Media** | Purchase, Support, Upgrade |
| **Retail** | Click & Collect, Loyalty Signup, Purchase |
| **Telecommunications** | Broadband Signup, Purchase, Support |
| **Travel & Hospitality** | Booking, Complaint Resolution, Corporate Booking |
| **Financial Services** | Account Opening, ISA Transfer, Support Request |

Each template includes: company name, domain, industry type, journey steps with substeps, business metadata (revenue, category, KPIs), and customer profiles.

### Per-Service Chaos Injection

Chaos is injected through **feature flags**, not by killing processes:

```
┌──────────────────────┐     GET /api/feature_flag?service=X     ┌─────────────┐
│  Child Service       │ ──────────────────────────────────────► │ Main Server │
│  (port 8082)         │ ◄────────────────────────────────────── │ (port 8080) │
│                      │     { errors_per_transaction: 0.8 }     │             │
│  if (Math.random()   │                                         │ Feature     │
│    < errorRate)      │                                         │ Flag Store  │
│    throw Error()     │                                         └─────────────┘
└──────────────────────┘
```

The Gremlin agent (Nemesis) sets error rates on specific services. Each service polls its own flags from the main server. Only the targeted service sees elevated errors — everything else stays healthy.

7 chaos recipes:
- `enable_errors` — Set error rate (10%–100%)
- `increase_error_rate` — Ramp up existing errors
- `slow_responses` — Add latency
- `disable_circuit_breaker` — Remove resilience
- `disable_cache` — Force cache misses
- `target_company` — Target all services for one company
- `custom_flag` — Set any arbitrary flag

### AI Agent Architecture

```
┌─────────────┐    injects chaos    ┌────────────────┐
│  Nemesis     │ ──────────────────► │ Feature Flags  │
│  (Chaos)     │                     │ (per-service)  │
└──────┬───────┘                     └────────────────┘
       │ records to                          │
       ▼                                     │ errors propagate
┌─────────────┐                              ▼
│  Librarian   │ ◄─── records ────── ┌────────────────┐
│  (Memory)    │                     │ Dynatrace      │
└──────┬───────┘                     │ (Problems,     │
       │ provides context            │  BizEvents)    │
       ▼                             └───────┬────────┘
┌─────────────┐    queries DT API            │
│  Fix-It      │ ◄──────────────────────────┘
│  (Remediate) │
│              │ ── resets flags ──► Feature Flags
│              │ ── sends event ──► Dynatrace
└──────────────┘
```

All agents use **LLM function calling** (via Ollama) to decide what actions to take. The Librarian provides persistent memory so agents can learn from past incidents.

### Dynatrace Event Ingestion

Every chaos injection and remediation action sends a `CUSTOM_DEPLOYMENT` event to Dynatrace:

```json
{
  "eventType": "CUSTOM_DEPLOYMENT",
  "title": "💥 Chaos Injection: enable_errors on CheckInAndRegistrationService",
  "entitySelector": "type(SERVICE),entityName.contains(\"CheckInAndRegistrationService\")",
  "properties": {
    "change.type": "chaos-injection",
    "chaos.id": "chaos-1772608582260-3",
    "chaos.type": "enable_errors",
    "chaos.target": "CheckInAndRegistrationService",
    "deployment.source": "gremlin-agent",
    "dt.event.is_rootcause_relevant": "true"
  }
}
```

These events appear as deployment markers on the affected service in Dynatrace, enabling root cause correlation with Davis AI.

---

## Key API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/health` | GET | Server health + child service list |
| `/api/journey-simulation/simulate-journey` | POST | Launch a journey simulation |
| `/api/admin/services/status` | GET | All service statuses |
| `/api/admin/services/restart-all` | POST | Restart all core services |
| `/api/gremlin/inject` | POST | Inject chaos into a service |
| `/api/gremlin/active` | GET | List active chaos faults |
| `/api/gremlin/revert/:faultId` | POST | Revert a specific fault |
| `/api/gremlin/revert-all` | POST | Revert all active faults |
| `/api/feature_flag` | GET/POST | Read/set feature flags |
| `/api/nemesis/*` | POST | Nemesis AI agent endpoints |
| `/api/fixit/*` | POST | Fix-It AI agent endpoints |
| `/api/librarian/*` | GET/POST | Librarian memory endpoints |
| `/api/dt-proxy/*` | GET | Proxy to Dynatrace APIs |

---

## Forge UI Pages (AppEngine)

The Dynatrace AppEngine app has 5 pages:

| Page | Route | Purpose |
|------|-------|---------|
| **Home** | `/` | Welcome, Get Started wizard, Template Library, Journey Builder (4-tab flow) |
| **Services** | `/services` | Live service dashboard with start/stop controls per company |
| **Chaos Control** | `/chaos` | Select a service, pick a chaos type, inject — with live active faults list |
| **Fix-It Agent** | `/fixit` | Trigger automated diagnosis and remediation |
| **Settings** | `/settings` | Configure server IP, API tokens, EdgeConnect credentials |

### Home Page Flow

```
Welcome Tab → Step 1: Company Details → Step 2: Generate Prompts → Step 3: Run Simulation
     │
     ├── Template Library sidebar (left panel)
     │   ├── 24 pre-built industry templates
     │   ├── Search/filter by industry
     │   ├── Click to load → auto-populates all fields
     │   ├── Export/Import configs (JSON)
     │   └── Save custom configs
     │
     └── Get Started checklist (persisted to DT settings)
         ├── Auto-detects EdgeConnect, OneAgent, OpenPipeline status
         ├── One-click Deploy buttons for each DT config
         └── Progress tracked across sessions
```

---

## Persistence

| File | Contents | Survives Restart? |
|------|----------|-------------------|
| `.chaos-state.json` | Active chaos/feature flag overrides | ✅ |
| `.port-allocations.json` | Service → port mappings | ✅ |
| `.dt-credentials.json` | DT environment URL + API token | ✅ |
| `saved-configs/*.json` | Journey templates + user configs | ✅ |
| `memory/` | Librarian vector + history stores | ✅ |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| No services in Dynatrace | OneAgent not installed or feature flags not enabled | Run Get Started checklist in Forge UI |
| EdgeConnect shows offline | OAuth creds expired or EdgeConnect not running | Re-run `./run-edgeconnect.sh`, check creds |
| Forge UI shows "Connection failed" | Server IP not configured or EdgeConnect down | Settings → Server IP, verify EdgeConnect |
| Chaos injection sends 200+ events | entitySelector too broad | Fixed in v2.9.10+ — now scoped to target service |
| AI agents don't respond | Ollama not running or model not pulled | `ollama pull llama3.2` and ensure port 11434 is up |
| Auto-load not generating journeys | No journey simulations started | Launch a template from the Template Library |

---

## Tech Stack Summary

| Layer | Technology |
|-------|-----------|
| Engine Runtime | Node.js v22 (ESM), Express.js 4, Socket.IO 4 |
| AI Agents | TypeScript → compiled to `dist/`, LLM via Ollama |
| AppEngine UI | React 18, Dynatrace Strato components, TypeScript |
| Observability | Dynatrace OneAgent + OpenTelemetry SDK |
| Config-as-Code | Monaco v2 (Settings API deployment) |
| Tunnel | Dynatrace EdgeConnect |
| Auth | OAuth 2.0 (SSO), API Token |

---

*For the business perspective and demo walkthrough, see [BUSINESS-GUIDE.md](BUSINESS-GUIDE.md).*
