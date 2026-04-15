import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Page } from '@dynatrace/strato-components-preview/layouts';
import { Flex } from '@dynatrace/strato-components/layouts';
import { Heading, Paragraph, Strong } from '@dynatrace/strato-components/typography';
import { Button } from '@dynatrace/strato-components/buttons';
import Colors from '@dynatrace/strato-design-tokens/colors';
import { InfoButton } from '../components/InfoButton';
import { getEnvironmentUrl } from '@dynatrace-sdk/app-environment';

const TENANT_URL = (() => {
  try { return getEnvironmentUrl().replace(/\/$/, ''); } catch { return ''; }
})();

// ── Types ──────────────────────────────────────────────────
interface DtLink { label: string; url: string; }
interface WalkthroughStep {
  title: string;
  action: string;
  where: string;
  dtLink?: DtLink;
  tip?: string;
  dql?: string[];
}
interface DemoPath {
  id: string;
  icon: string;
  title: string;
  subtitle: string;
  color: string;
  steps: WalkthroughStep[];
}
interface Persona {
  id: string;
  icon: string;
  role: string;
  title: string;
  color: string;
  audience: string;
  focusAreas: string[];
  talkingPoints: string[];
  demoFlow: { step: string; detail: string; dtLink?: DtLink }[];
  suggestedPaths: string[];   // IDs from DEMO_PATHS
}

type GuideMode = 'paths' | 'personas';

// ── Demo Paths — only features that actually exist ─────────
const DEMO_PATHS: DemoPath[] = [
  {
    id: 'quick-start',
    icon: '🚀',
    title: 'Quick Start',
    subtitle: 'Generate services, see them in Dynatrace, explore Demonstrator Dashboards',
    color: '#3498db',
    steps: [
      {
        title: 'Configure the connection',
        action: 'Open Settings (⚙️ icon in the top bar). Enter the API host and port for the BizObs server. Save.',
        where: 'This app → Settings',
      },
      {
        title: 'Pick a journey template',
        action: 'On the Home page, click "Get Started". Choose an industry (e.g. Retail) and a company name. Click Next.',
        where: 'This app → Home → Step 1',
      },
      {
        title: 'Generate services',
        action: 'Review the JSON preview, then click "Generate Services". The backend spins up real Node.js services that send traces and metrics via OpenTelemetry.',
        where: 'This app → Home → Step 2',
        tip: 'Services take ~2 minutes to be discovered by OneAgent in Dynatrace.',
      },
      {
        title: 'Check services in Dynatrace',
        action: 'Open Services in Dynatrace. You should see the generated services (e.g. "Acme-Corp-Payment-Service"). Click one to view response time, error rate, and throughput.',
        where: 'Dynatrace',
        dtLink: { label: 'Services', url: `${TENANT_URL}/ui/apps/dynatrace.services` },
      },
      {
        title: 'View the service flow',
        action: 'Open Services and select a service to see its dependencies and how the journey services connect to each other.',
        where: 'Dynatrace',
        dtLink: { label: 'Services', url: `${TENANT_URL}/ui/apps/dynatrace.services` },
      },
      {
        title: 'Explore Demonstrator Dashboards',
        action: 'Navigate to this app\'s Demonstrator Dashboards page. Choose from 4 persona-based presets — Developer, Operations, Executive, or Dynatrace Intelligence — each with comprehensive, filterable tiles powered by DQL. Select a company and journey to see live data.',
        where: 'This app → Demonstrator Dashboards',
        tip: 'Each preset has 20-38 tiles covering heroes, timeseries, bar charts, donuts, tables, honeycomb, and more — all filterable by company, journey, service, and event type.',
      },
    ],
  },
  {
    id: 'demonstrator-dashboards',
    icon: '📊',
    title: 'Demonstrator Dashboards Deep Dive',
    subtitle: 'Four persona-based preset dashboards — Developer, Operations, Executive, Dynatrace Intelligence',
    color: '#27ae60',
    steps: [
      {
        title: 'Open Demonstrator Dashboards',
        action: 'Navigate to the Demonstrator Dashboards page from the main nav. You\'ll see a preset selector at the top, company/journey/service filters, and a timeframe picker.',
        where: 'This app → Demonstrator Dashboards',
      },
      {
        title: 'Developer Preset (~30 tiles)',
        action: 'Select the Developer preset. This shows the RED metrics table (Requests, Errors, Duration per service), latency percentiles (p50/p90/p99), error timeseries, top endpoints, failed spans analyzer, exception breakdown, log analysis, and trace correlation.',
        where: 'This app → Demonstrator Dashboards → Developer',
        tip: 'The RED metrics table is the centerpiece — it shows every service\'s golden signals at a glance. Great for identifying the trouble service during a chaos demo.',
      },
      {
        title: 'Operations Preset (~27 tiles)',
        action: 'Switch to Operations. This covers infrastructure health: host CPU/memory, process resource usage, network I/O, disk saturation, service availability %, and deployment events correlated with problems.',
        where: 'This app → Demonstrator Dashboards → Operations',
      },
      {
        title: 'Executive Preset (~38 tiles)',
        action: 'Switch to Executive for the business view: total revenue, order volume, bounce rate, customer churn %, SLA compliance, journey funnel (step-by-step conversion), IT impact on business KPIs, revenue by service and customer tier, and top customers.',
        where: 'This app → Demonstrator Dashboards → Executive',
        tip: 'This is the money slide for execs. Show revenue trending down when you inject chaos on the payment service — it directly connects technical failures to business impact.',
      },
      {
        title: 'Dynatrace Intelligence Preset (~19 tiles)',
        action: 'Switch to Dynatrace Intelligence. This shows active problems, root cause analysis summaries, anomaly detection timeline, mean time to detect (MTTD), MTTR, problem resolution trends, and Impact analysis by service and business entity.',
        where: 'This app → Demonstrator Dashboards → Dynatrace Intelligence',
      },
      {
        title: 'Filter by company and journey',
        action: 'Use the filter dropdowns to scope the dashboard to a specific company or journey. All tiles update dynamically — every DQL query is parametrized with the selected filters.',
        where: 'This app → Demonstrator Dashboards',
        tip: 'If you have multiple companies running, filtering to one company shows data isolation. Switch quickly between companies to show multi-tenancy.',
      },
      {
        title: 'Compare before and after chaos',
        action: 'Open the Developer preset with healthy services. Note the baseline metrics. Then inject chaos via Chaos Control, come back, and watch the error rates, latency spikes, and failed span counts climb in real time. Fix the problem with Fix-It, then watch recovery.',
        where: 'This app → Demonstrator Dashboards + Chaos Control + Fix-It',
        tip: 'This is the complete observability loop in one view: healthy → degraded → detected → remediated → recovered — all visible on the dashboard tiles.',
      },
    ],
  },
  {
    id: 'chaos-and-fix',
    icon: '💥',
    title: 'Chaos & Fix-It',
    subtitle: 'Inject faults, watch Dynatrace Intelligence detect them, then auto-remediate',
    color: '#e74c3c',
    steps: [
      {
        title: 'Make sure services are running',
        action: 'On the Home page, check the Active Journeys panel. You should see running journeys with green status badges and service counts. If not, go back to Quick Start and generate some first.',
        where: 'This app → Home → Active Journeys',
      },
      {
        title: 'Inject chaos',
        action: 'Go to Chaos Control. Pick a running service and inject a fault — e.g. "Enable Errors" at 50% error rate. The service will start returning errors.',
        where: 'This app → Chaos Control',
      },
      {
        title: 'Watch Dynatrace Intelligence detect the problem',
        action: 'Open Problems in Dynatrace. Within a few minutes, Dynatrace Intelligence should raise a problem card for the increased error rate. Click into it to see the root cause analysis.',
        where: 'Dynatrace',
        dtLink: { label: 'Problems', url: `${TENANT_URL}/ui/apps/dynatrace.davis.problems/` },
        tip: 'Dynatrace Intelligence uses automatic baselines — no thresholds to configure. It compares current behavior to what it learned as normal.',
      },
      {
        title: 'See the deployment event on the service',
        action: 'The chaos injection sends a CUSTOM_DEPLOYMENT event to Dynatrace tagged with [ROOT CAUSE]. Open the affected service in the Services app and check its Events tab to see the deployment event correlated with the problem.',
        where: 'Dynatrace',
        dtLink: { label: 'Services', url: `${TENANT_URL}/ui/apps/dynatrace.services` },
      },
      {
        title: 'Run Fix-It',
        action: 'Go to the Fix-It page. Click "Auto Diagnose" or enter a problem description. Fix-It will read the current feature flags, figure out what\'s wrong, and apply a fix (e.g. disable error injection, reduce error rate).',
        where: 'This app → Fix-It',
      },
      {
        title: 'Verify the fix',
        action: 'Go back to Dynatrace Problems. The problem should close after the fix takes effect. Check Services to confirm error rates have dropped.',
        where: 'Dynatrace',
        dtLink: { label: 'Problems', url: `${TENANT_URL}/ui/apps/dynatrace.davis.problems/` },
      },
      {
        title: 'Try Smart Chaos',
        action: 'Instead of picking a fault manually, use Smart Chaos mode. Describe a goal in plain English — e.g. "Simulate a payment processing outage" — and the agent picks the best chaos recipe, target service, and intensity automatically.',
        where: 'This app → Chaos Control → Smart Chaos',
        tip: 'Smart Chaos uses the Nemesis Agent under the hood. It evaluates running services and picks the most impactful target. Great for showing AI-driven chaos engineering.',
      },
      {
        title: 'Check Librarian memory',
        action: 'After the fix, the Librarian agent has recorded the entire incident: chaos injection, problem detection, diagnosis, and remediation. This creates an operational memory that can be searched later.',
        where: 'This app → Fix-It (Librarian tab)',
        tip: 'You can search past incidents — e.g. "payment errors" finds all related past problems, even if the exact words differ.',
      },
      {
        title: 'Revert chaos (cleanup)',
        action: 'On the Chaos Control page, click "Revert All" to reset all faults. Services return to normal.',
        where: 'This app → Chaos Control',
      },
    ],
  },
  {
    id: 'autonomous-ops',
    icon: '⚡',
    title: 'Autonomous Operations',
    subtitle: 'Closed-loop autonomous chaos, AI diagnosis, auto-remediation, and operational memory',
    color: '#e67e22',
    steps: [
      {
        title: 'Ensure services are running with load',
        action: 'Generate a journey (Quick Start steps 1-3) and make sure auto-load is active. You need continuous traffic flowing through services — the autonomous scheduler triggers on transaction volume thresholds.',
        where: 'This app → Home',
      },
      {
        title: 'Understand the autonomous loop',
        action: 'The autonomous operations pipeline is a closed loop: (1) Nemesis Agent injects chaos based on conditions or schedules → (2) Dynatrace Intelligence detects the resulting problem → (3) Fix-It Agent diagnoses and remediates autonomously → (4) Librarian records the full incident for future learning.',
        where: 'Conceptual overview',
      },
      {
        title: 'Let Nemesis inject chaos',
        action: 'The Nemesis agent can inject chaos via Smart Chaos mode. Describe a scenario like "degrade the checkout experience" and the agent selects the target service, fault type (errors, latency, circuit breaker), and intensity.',
        where: 'This app → Chaos Control → Smart Chaos',
      },
      {
        title: 'Watch Fix-It auto-diagnose',
        action: 'When a problem appears, run Fix-It\'s auto-diagnosis. The agent queries Dynatrace for active problems, reads feature flag state, and determines root cause and remediation. It then applies the fix automatically — toggling feature flags to disable the injected fault.',
        where: 'This app → Fix-It → Auto Diagnose',
        dtLink: { label: 'Problems', url: `${TENANT_URL}/ui/apps/dynatrace.davis.problems/` },
      },
      {
        title: 'View the Librarian timeline',
        action: 'After Fix-It resolves the problem, the Librarian agent records the full incident timeline: when chaos was injected, when the problem was detected, what diagnosis was made, what fix was applied, and whether it succeeded. This creates a searchable operational memory.',
        where: 'This app → Fix-It (Librarian)',
      },
      {
        title: 'Search past incidents',
        action: 'Use the Librarian\'s search to find similar past incidents. Try searching "payment errors" or "high latency" — the Librarian finds related incidents, even if the exact wording is different.',
        where: 'This app → Fix-It (Librarian)',
      },
      {
        title: 'Review the autonomous loop results',
        action: 'Check the Librarian timeline to see the full autonomous cycle: chaos injection, problem detection, diagnosis, remediation, and resolution. Each step is logged with timestamps and outcomes.',
        where: 'This app → Fix-It (Librarian)',
        tip: 'This is the signature demo: a fully autonomous operations loop — chaos, detect, diagnose, fix, learn.',
      },
    ],
  },
  {
    id: 'traces-and-otel',
    icon: '🔍',
    title: 'Traces & OpenTelemetry',
    subtitle: 'See distributed traces and OTel data',
    color: '#9b59b6',
    steps: [
      {
        title: 'View distributed traces',
        action: 'With services running, open Distributed Traces in Dynatrace. You\'ll see traces for each journey transaction — multiple spans across the services.',
        where: 'Dynatrace',
        dtLink: { label: 'Distributed Traces', url: `${TENANT_URL}/ui/apps/dynatrace.distributedtracing/` },
      },
      {
        title: 'Drill into a trace',
        action: 'Click any trace to see the waterfall view — each span shows the service, duration, and status. HTTP calls between services are visible.',
        where: 'Dynatrace → Distributed Traces → click a trace',
      },
    ],
  },
  {
    id: 'platform',
    icon: '🏗️',
    title: 'Platform & Architecture',
    subtitle: 'AppEngine, EdgeConnect, and how it all connects',
    color: '#2c3e50',
    steps: [
      {
        title: 'You\'re in an AppEngine app',
        action: 'This app is a Dynatrace AppEngine application — a React app using Strato components, running natively inside Dynatrace. Check the Apps list to see it.',
        where: 'Dynatrace',
        dtLink: { label: 'Apps', url: `${TENANT_URL}/ui/apps` },
      },
      {
        title: 'Check EdgeConnect',
        action: 'EdgeConnect creates a secure tunnel from Dynatrace to the BizObs server. No inbound ports are open on the server — all traffic goes through EdgeConnect.',
        where: 'Dynatrace',
        dtLink: { label: 'EdgeConnect', url: `${TENANT_URL}/ui/apps/dynatrace.settings/settings/external-requests/?tab=edge-connect` },
      },
      {
        title: 'Check the host',
        action: 'Open Hosts — you should see the EC2/VM running the BizObs server. OneAgent monitors the host and auto-discovers the Node.js processes.',
        where: 'Dynatrace',
        dtLink: { label: 'Hosts', url: `${TENANT_URL}/ui/apps/dynatrace.hosts` },
      },
      {
        title: 'View the technology stack',
        action: 'Open Technologies to see all the processes running on the host — the main BizObs server and the dynamically generated services.',
        where: 'Dynatrace',
        dtLink: { label: 'Technologies', url: `${TENANT_URL}/ui/apps/dynatrace.technologies` },
      },
    ],
  },
  {
    id: 'live-debugger',
    icon: '🔬',
    title: 'LiveDebugger',
    subtitle: 'Set breakpoints on running services — capture variables, errors, and trace context in real time',
    color: '#c0392b',
    steps: [
      {
        title: 'Ensure services are running',
        action: 'You need at least one generated journey with active services before using LiveDebugger. Go to the Home page and check that services are listed with a green status. If not, generate a journey first (Quick Start path, steps 1-3).',
        where: 'BizObs Demonstrator App',
        tip: 'Services must have active traffic for snapshots to trigger. The auto-load feature keeps services producing requests automatically.',
      },
      {
        title: 'Open LiveDebugger',
        action: 'Open the Dynatrace LiveDebugger app. This is a non-intrusive production debugger — it captures variable snapshots without stopping or slowing the process.',
        where: 'Dynatrace',
        dtLink: { label: 'LiveDebugger', url: `${TENANT_URL}/ui/apps/dynatrace.devobs.debugger/debugger` },
        tip: 'LiveDebugger requires OneAgent with the "Node.js LiveDebugger" module enabled on the host.',
      },
      {
        title: 'Select the service process',
        action: 'In the LiveDebugger sidebar, expand the monitored host and find one of the generated service processes (e.g. "NeedRecognitionService" or "PaymentProcessing"). Click it to select it as the debug target.',
        where: 'Dynatrace LiveDebugger',
        tip: 'Each generated service runs as its own Node.js process. Pick one that handles business logic — payment or checkout services are great for demos.',
      },
      {
        title: 'Navigate to the source file',
        action: 'In the file tree on the left, navigate to: services → runtime → dynamic-step-service.js. This is the main service engine that processes every request, injects errors, and chains calls to the next service.',
        where: 'Dynatrace LiveDebugger',
        tip: 'LiveDebugger pulls source from the connected GitHub repo. The runtime/ folder contains .js files specifically for LiveDebugger compatibility.',
      },
      {
        title: 'Breakpoint 1 — Line 697: Error injection point',
        action: 'Scroll to line 697: "const httpStatus = errorInjected.http_status || 500". Click the line number gutter to set a non-breaking breakpoint. This line fires only when an error has been injected — you\'ll capture the raw fault data before the error response is built.',
        where: 'Dynatrace LiveDebugger',
        tip: 'This is the first line inside the "if (errorInjected)" block. Snapshots here show: errorInjected (error_type, http_status, feature_flag, remediation_action), errorConfig (errors_per_transaction probability), and customerProfile (name, tier, company).',
      },
      {
        title: 'Breakpoint 2 — Line 708: After realError is built',
        action: 'Scroll to line 708: the console.error() call right after the realError object is constructed. Set a second breakpoint here. This captures the complete error object that will actually be returned to the caller — including the formatted error message, HTTP status, stack trace, and correlation IDs.',
        where: 'Dynatrace LiveDebugger',
        tip: 'Best breakpoint for demos. At this point realError contains: { statusCode, error_type, message, service, step, correlationId, traceId, timestamp, remediation_action, feature_flag }. This is everything you need to understand exactly what went wrong and why.',
      },
      {
        title: 'Breakpoint 3 — Line 996: Service chain call',
        action: 'Scroll to line 996: "await callService(...)". Set a third breakpoint here. This captures the moment one service calls the next service in the journey chain — you\'ll see the target URL, the request payload being forwarded, and the full trace context (traceparent header) being propagated.',
        where: 'Dynatrace LiveDebugger',
        tip: 'This breakpoint shows the distributed architecture in action: how one microservice calls the next, what data is passed along, and how OpenTelemetry trace context flows between services. Great for explaining service mesh concepts.',
      },
      {
        title: 'Add conditions (optional)',
        action: 'Right-click any breakpoint to add a condition. Useful conditions:\n\n• Line 697/708: errorInjected !== null — only fire when an error is injected (skip clean requests)\n• Line 697/708: errorInjected.http_status === 500 — catch only server errors\n• Line 996: nextServiceUrl.includes("Payment") — only capture calls to the payment service',
        where: 'Dynatrace LiveDebugger',
        tip: 'Conditions keep snapshots focused and prevent noise. Without conditions on lines 697/708, you may capture clean requests where errorInjected is null.',
      },
      {
        title: 'Wait for snapshots',
        action: 'With auto-load running and chaos enabled, wait a few seconds. As requests flow through the service, each breakpoint captures independent snapshots. You\'ll see them appear in the Snapshots panel — one per breakpoint hit. Click any snapshot to inspect its variables.',
        where: 'Dynatrace LiveDebugger',
        tip: 'If snapshots aren\'t appearing, verify: (1) the service has traffic, (2) Chaos Control has errors enabled for lines 697/708, (3) the breakpoints are on the correct lines. Line 996 fires on every request regardless of chaos.',
      },
      {
        title: 'Inspect snapshot data',
        action: 'Click a snapshot to expand the variable state captured at that moment:\n\n• Line 697 snapshot — errorInjected: { error_type, http_status, feature_flag, remediation_action }, errorConfig: { errors_per_transaction }, customerProfile: { name, tier, company }\n• Line 708 snapshot — all of the above PLUS realError: { statusCode, message, service, step, correlationId, traceId, timestamp, stack }\n• Line 996 snapshot — nextServiceUrl, requestPayload, req.headers (traceparent, correlationId, traceId), serviceConfig (chain targets)',
        where: 'Dynatrace LiveDebugger',
        tip: 'The traceparent and traceId headers in any snapshot link directly to a distributed trace. Copy the traceId to correlate code-level data with the full trace waterfall.',
      },
      {
        title: 'Correlate with Distributed Traces',
        action: 'Copy the traceId from any snapshot\'s req.headers. Open Distributed Traces and search for it. You\'ll see the full end-to-end trace waterfall — showing exactly where this error occurred in the service chain, how it propagated, and which downstream services were affected.',
        where: 'Dynatrace',
        dtLink: { label: 'Distributed Traces', url: `${TENANT_URL}/ui/apps/dynatrace.distributedtracing/` },
        tip: 'This is the "aha moment" — connecting live code-level variable snapshots to distributed trace observability. Three breakpoints, three perspectives: the fault (697), the error response (708), and the service chain (996). No other platform does all three in one workflow.',
      },
    ],
  },
  {
    id: 'slo-reliability',
    icon: '🎯',
    title: 'SLOs & Site Reliability Guardian',
    subtitle: 'Define Service Level Objectives, track error budgets, and validate releases with Guardian',
    color: '#06b6d4',
    steps: [
      {
        title: 'Understand what SLOs you can create',
        action: 'The generated services produce real traffic with measurable success rates and latency. You can create SLOs for availability (% of successful requests) and performance (% of requests under a latency threshold). Open Services to see the metrics flowing.',
        where: 'Dynatrace',
        dtLink: { label: 'Services', url: `${TENANT_URL}/ui/apps/dynatrace.services` },
        tip: 'Every service the Demonstrator creates sends real HTTP requests with OpenTelemetry instrumentation — the same metrics you\'d use for production SLOs.',
      },
      {
        title: 'Create an Availability SLO',
        action: 'Navigate to the SLO app in Dynatrace. Click "Create SLO". Choose a service from the generated journey (e.g. the payment service). Set the SLI to "Availability" — percentage of successful requests. Set a target of 99.5% and a warning at 99.8%. Save it.',
        where: 'Dynatrace',
        dtLink: { label: 'SLOs', url: `${TENANT_URL}/ui/apps/dynatrace.slo` },
        tip: 'With auto-load running, you\'ll see the SLO immediately start tracking. The error budget shows how much "failure" you can tolerate before breaching.',
      },
      {
        title: 'Create a Performance SLO',
        action: 'Create a second SLO — this time for performance. Set the SLI to "Latency" — percentage of requests completing under 500ms. Target: 95%. This gives you the two golden SLOs: availability AND performance.',
        where: 'Dynatrace',
        dtLink: { label: 'SLOs', url: `${TENANT_URL}/ui/apps/dynatrace.slo` },
      },
      {
        title: 'Burn the error budget with chaos',
        action: 'Go to Chaos Control and inject 30% errors on the service you created SLOs for. Watch the SLO page update — the error budget starts burning. This is exactly how you\'d catch a production issue eating through your reliability budget.',
        where: 'This app → Chaos Control + Dynatrace SLOs',
        dtLink: { label: 'SLOs', url: `${TENANT_URL}/ui/apps/dynatrace.slo` },
        tip: 'With 30% errors and a 99.5% SLO, the error budget burns fast. In production, you\'d get alerted when the burn rate exceeds a threshold — driving automated rollback.',
      },
      {
        title: 'Open Site Reliability Guardian',
        action: 'Navigate to the Automations app and find Site Reliability Guardian. Create a new Guardian — add your SLOs as validation objectives. This is Dynatrace\'s quality gate for releases and deployments.',
        where: 'Dynatrace',
        dtLink: { label: 'Automations', url: `${TENANT_URL}/ui/apps/dynatrace.automations` },
        tip: 'Site Reliability Guardian is the "go/no-go" gate. In a CI/CD pipeline, it validates SLOs, error rates, and performance after a deployment — automatically rolling back if thresholds are breached.',
      },
      {
        title: 'Validate with Guardian',
        action: 'Run a Guardian validation against your services. It evaluates all the objectives you added — SLOs, error rates, latency — and returns a pass/warning/fail verdict. Revert the chaos, run Guardian again, and show the "pass" result.',
        where: 'Dynatrace → Automations → Site Reliability Guardian',
        dtLink: { label: 'Automations', url: `${TENANT_URL}/ui/apps/dynatrace.automations` },
        tip: 'This is the story: inject chaos → Guardian fails → fix the issue → Guardian passes. It\'s the validation loop that proves Dynatrace can gate deployments automatically.',
      },
      {
        title: 'View the SRE Dashboard preset',
        action: 'Open the BizObs Demonstrator Dashboards page and select the "SRE / Reliability" preset. This shows live DQL-powered tiles for availability, error budgets, latency percentiles (p50/p90/p99), HTTP status breakdowns, and service reliability rankings.',
        where: 'This app → Demonstrator Dashboards → SRE preset',
      },
    ],
  },
  {
    id: 'log-biz-events',
    icon: '📊',
    title: 'Logs & Business Events',
    subtitle: 'Analyze logs from services, explore business events, and build DQL-powered analytics',
    color: '#8b5cf6',
    steps: [
      {
        title: 'View logs from generated services',
        action: 'With services running, open the Logs app in Dynatrace. You\'ll see log entries from the Node.js processes — request logs, error logs, and application events. Filter by service name to see logs from specific journey steps.',
        where: 'Dynatrace',
        dtLink: { label: 'Logs', url: `${TENANT_URL}/ui/apps/dynatrace.logs` },
        tip: 'OneAgent automatically captures stdout/stderr from the Node.js processes. No log shipping config needed — it\'s immediate.',
      },
      {
        title: 'Explore business events',
        action: 'The Demonstrator sends business events for every journey transaction — each step (Browse, Add to Cart, Checkout, Payment, etc.) emits an event with company name, journey type, step name, status, and processing time. Open the Biz Events app or query with DQL.',
        where: 'Dynatrace',
        dtLink: { label: 'Notebooks', url: `${TENANT_URL}/ui/apps/dynatrace.notebooks` },
        tip: 'Business events are the bridge between technical observability and business value. They let you answer "how many orders failed?" not just "which HTTP calls returned 500?".',
      },
      {
        title: 'Query business events with DQL',
        action: 'Open a Notebook and run these DQL queries to explore business events flowing through the system:',
        where: 'Dynatrace',
        dtLink: { label: 'Notebooks', url: `${TENANT_URL}/ui/apps/dynatrace.notebooks` },
        dql: [
          'fetch bizevents\n| summarize count(), by:{event.type}',
          'fetch bizevents\n| filter event.type == "bizobs.journey.step"\n| summarize count(), by:{step_name, status}',
        ],
      },
      {
        title: 'Correlate logs with traces',
        action: 'Find an error log entry (or inject chaos to create errors). Click the log entry to see correlated traces — Dynatrace automatically links logs to the distributed trace that produced them using trace context.',
        where: 'Dynatrace → Logs → click an entry',
        tip: 'This is the "three pillars" story: metrics → traces → logs, all correlated automatically by Dynatrace. No manual correlation IDs needed.',
      },
      {
        title: 'View the Biz Events Dashboard preset',
        action: 'Open the BizObs Demonstrator Dashboards page and select the "Biz Events" preset. This shows live DQL-powered tiles for event volume, types, error rates by service/journey/company, and a full event detail table.',
        where: 'This app → Demonstrator Dashboards → Biz Events preset',
      },
    ],
  },
  {
    id: 'security',
    icon: '🔒',
    title: 'Security & Vulnerability Management',
    subtitle: 'Runtime Application Protection, vulnerability detection, and security event monitoring',
    color: '#f59e0b',
    steps: [
      {
        title: 'Open Application Security',
        action: 'Navigate to the Application Security overview in Dynatrace. This is where all security findings are aggregated — runtime vulnerabilities, third-party library risks, and security events detected by OneAgent.',
        where: 'Dynatrace',
        dtLink: { label: 'Application Security', url: `${TENANT_URL}/ui/apps/dynatrace.classic.security.overview` },
        tip: 'No separate scanner or agent needed — OneAgent monitors the running Node.js processes and detects vulnerabilities in real-time from the actual code execution path.',
      },
      {
        title: 'Check for vulnerabilities',
        action: 'Open the Vulnerabilities view. OneAgent scans the Node.js dependencies (npm packages) used by the BizObs server and generated services. You\'ll see CVEs, severity ratings, affected libraries, and which processes load the vulnerable code.',
        where: 'Dynatrace',
        dtLink: { label: 'Vulnerabilities', url: `${TENANT_URL}/ui/apps/dynatrace.classic.vulnerabilities` },
        tip: 'Dynatrace shows runtime-reachable vulnerabilities — not just "this library is installed" but "this vulnerable code path is actually executed." This massively reduces false positives.',
      },
      {
        title: 'View security events',
        action: 'Check for Runtime Application Protection events. If OneAgent detects suspicious activity (SQL injection attempts, path traversal, etc.) on the running services, it logs security events you can analyze.',
        where: 'Dynatrace → Application Security → Attacks',
        dtLink: { label: 'Attacks', url: `${TENANT_URL}/ui/apps/dynatrace.classic.attacks` },
      },
      {
        title: 'Connect security to services',
        action: 'In the vulnerability view, click through to see which services are affected. Dynatrace maps vulnerabilities to the specific service and process — so you know exactly which part of your architecture has the risk.',
        where: 'Dynatrace → Vulnerabilities → click a vulnerability',
        tip: 'This is the power of having security AND observability in one platform — you see the vulnerability, the affected service, its traffic volume, and whether it\'s in a critical path. Risk-based prioritization, not just severity.',
      },
      {
        title: 'Query security data with DQL',
        action: 'Open a Notebook and run these DQL queries to explore security data:',
        where: 'Dynatrace',
        dtLink: { label: 'Notebooks', url: `${TENANT_URL}/ui/apps/dynatrace.notebooks` },
        dql: [
          'fetch events\n| filter event.kind == "SECURITY_EVENT"\n| summarize count(), by:{event.category}',
          'fetch entities\n| filter type == "dt.entity.process_group_instance"\n| filter isNotNull(securityProblem)',
        ],
      },
      {
        title: 'View the Security Dashboard preset',
        action: 'Open the BizObs Demonstrator Dashboards page and select the "Security" preset. This shows live DQL-powered tiles for security event volume, attack detection, event categories, trends, and affected entities.',
        where: 'This app → Demonstrator Dashboards → Security preset',
      },
    ],
  },
  {
    id: 'dynatrace-intelligence',
    icon: '🧠',
    title: 'Dynatrace Intelligence Deep Dive',
    subtitle: 'Anomaly detection, root cause analysis, impact analysis, and AI-powered problem resolution',
    color: '#e74c3c',
    steps: [
      {
        title: 'Understand what Dynatrace Intelligence monitors',
        action: 'Dynatrace Intelligence automatically baselines every metric on every entity — services, hosts, processes. It detects anomalies without any manual thresholds. With the BizObs services running, Dynatrace Intelligence is already watching error rates, response times, throughput, and infrastructure metrics.',
        where: 'Conceptual overview',
        tip: 'Dynatrace Intelligence uses deterministic AI, not LLMs. It gives precise, explainable root cause analysis — not probabilistic guesses. This is the key differentiator.',
      },
      {
        title: 'Create a problem for Dynatrace Intelligence to detect',
        action: 'Go to Chaos Control and inject a fault — try 40% errors on a payment service, or 2000ms latency on a checkout service. Dynatrace Intelligence needs sustained anomalous traffic to trigger, so keep auto-load running and wait 2-3 minutes.',
        where: 'This app → Chaos Control',
        tip: 'Higher error rates (40%+) trigger faster. Latency injection at 2000ms+ is also very visible. The key is sustained traffic through the affected service.',
      },
      {
        title: 'Watch the problem card appear',
        action: 'Open the Problems view. Within minutes, Dynatrace Intelligence creates a problem card with: (1) the root cause entity, (2) the impacted services/entities, (3) the anomaly type (error rate increase, response time degradation), and (4) the precise time it started.',
        where: 'Dynatrace',
        dtLink: { label: 'Problems', url: `${TENANT_URL}/ui/apps/dynatrace.davis.problems/` },
      },
      {
        title: 'Analyze root cause',
        action: 'Click into the problem card. Dynatrace Intelligence shows the root cause entity and the full dependency chain. It traces the problem from the point of impact through the topology to the originating entity. The "Related events" section shows what changed.',
        where: 'Dynatrace → Problems → click a problem',
        tip: 'Dynatrace Intelligence uses SmartScape topology (which services call which) to determine causality, not just correlation. This is why it pinpoints root cause, not just symptoms.',
      },
      {
        title: 'Check the impact analysis',
        action: 'In the problem card, look at the "Impact" section. Dynatrace Intelligence shows which services, hosts, and application components are affected. With the BizObs journey services, you\'ll see the downstream cascade — e.g. a payment error impacts checkout, which impacts the overall journey.',
        where: 'Dynatrace → Problems → Impact tab',
      },
      {
        title: 'View the anomaly timeline',
        action: 'In the problem card, check the event timeline. It shows the sequence: when the anomaly started, when Dynatrace Intelligence correlated it, which entities were added to the problem. This tells the story of the incident.',
        where: 'Dynatrace → Problems → Events tab',
      },
      {
        title: 'Fix and watch the problem close',
        action: 'Go to Chaos Control and revert the fault (or use Fix-It to auto-remediate). Watch the problem card in Dynatrace — Dynatrace Intelligence will close it automatically when metrics return to baseline. The resolution time is tracked.',
        where: 'This app → Chaos Control + Dynatrace Problems',
        dtLink: { label: 'Problems', url: `${TENANT_URL}/ui/apps/dynatrace.davis.problems/` },
        tip: 'The full cycle — fault → detection → analysis → resolution → closure — is the core Dynatrace story. MTTD (mean time to detect) and MTTR (mean time to resolve) are both visible in the timeline.',
      },
      {
        title: 'View the Dynatrace Intelligence Dashboard preset',
        action: 'Open the BizObs Demonstrator Dashboards page and select the "Dynatrace Intelligence" preset. This shows live tiles for active problems, root cause analysis, anomaly detection, impact mapping, and MTTD/MTTR tracking.',
        where: 'This app → Demonstrator Dashboards → Intelligence preset',
      },
    ],
  },
  {
    id: 'notebooks-dql',
    icon: '📓',
    title: 'Notebooks & DQL Mastery',
    subtitle: 'Query everything with DQL — spans, events, logs, metrics, entities — all in collaborative Notebooks',
    color: '#2563eb',
    steps: [
      {
        title: 'Open a Dynatrace Notebook',
        action: 'Navigate to Notebooks and create a new one. Notebooks are Dynatrace\'s collaborative analysis environment — you can write DQL queries, add markdown sections, create visualizations, and share with your team.',
        where: 'Dynatrace',
        dtLink: { label: 'Notebooks', url: `${TENANT_URL}/ui/apps/dynatrace.notebooks` },
      },
      {
        title: 'Query distributed traces',
        action: 'Add a DQL section and run the query below — it gives you a service health overview from trace data.',
        where: 'Dynatrace → Notebook',
        tip: 'DQL (Dynatrace Query Language) queries Grail — the unified data lakehouse. Every data type (spans, metrics, logs, events, entities) uses the same query language.',
        dql: [
          'fetch spans\n| filter dt.entity.service != ""\n| summarize count(), avgDuration = avg(duration), errorCount = countIf(otel.status_code == "ERROR"), by:{dt.entity.service}\n| sort count() desc',
        ],
      },
      {
        title: 'Query business events',
        action: 'Run the query below to see conversion rate per journey step:',
        where: 'Dynatrace → Notebook',
        dql: [
          'fetch bizevents\n| filter event.type == "bizobs.journey.step"\n| summarize successes = countIf(status == "success"), failures = countIf(status == "error"), by:{step_name}\n| fieldsAdd successRate = round(successes * 100.0 / (successes + failures), decimals:1)',
        ],
      },
      {
        title: 'Query problems and events',
        action: 'Run the query below to see all Dynatrace Intelligence-detected problems with root cause:',
        where: 'Dynatrace → Notebook',
        dql: [
          'fetch events\n| filter event.kind == "DAVIS_PROBLEM"\n| fields timestamp, display_id, title, event.status, root_cause_entity_name, affected_entity_ids\n| sort timestamp desc',
        ],
      },
      {
        title: 'Build a custom visualization',
        action: 'Take any query result and switch the visualization type — table, time series, bar chart, pie chart, single value. DQL results are immediately visualizable without any extra configuration. Try the timeseries query below.',
        where: 'Dynatrace → Notebook',
        tip: 'Notebooks support mixing DQL sections, markdown commentary, and visualizations. They\'re great for incident postmortems, capacity reviews, and executive reports.',
        dql: [
          'fetch spans\n| makeTimeseries count(), by:{dt.entity.service}',
        ],
      },
      {
        title: 'Export tiles to a Notebook',
        action: 'Go to the Demonstrator Dashboards page in this app. Select any preset (Developer, SRE, etc.) and click "Export to Notebook". This creates a Notebook with all the DQL queries from that preset — ready to customize.',
        where: 'This app → Demonstrator Dashboards → Export to Notebook',
        tip: 'This shows how DQL queries are composable and portable — generate them in the app, export to a Notebook, customize for your specific analysis, share with the team.',
      },
    ],
  },
];
const PERSONAS: Persona[] = [
  {
    id: 'cto',
    icon: '👔',
    role: 'CTO / VP Engineering',
    title: 'Executive Overview',
    color: '#1a5276',
    audience: 'C-level executives, VPs, and senior leadership who want the strategic picture',
    focusAreas: [
      'Business journey visibility end-to-end',
      'AI-powered root cause analysis (Dynatrace Intelligence)',
      'Auto-remediation reducing MTTR',
      'Platform extensibility via AppEngine',
    ],
    talkingPoints: [
      'Every business transaction is modeled as a journey with real services — from Browse to Checkout to Fulfillment.',
      'Dynatrace Intelligence detects anomalies automatically using AI baselines — no manual thresholds to maintain.',
      'Fix-It auto-remediates problems in seconds, not hours. Show the chaos → detect → fix → verify loop.',
      'This entire app runs natively inside Dynatrace using AppEngine — it\'s not an external tool, it\'s a platform extension.',
    ],
    demoFlow: [
      { step: 'Generate a Retail journey (Quick Start)', detail: 'Show how fast you can model a business process end-to-end.' },
      { step: 'Open Demonstrator Dashboards — Executive preset', detail: 'Navigate to Demonstrator Dashboards. Select the Executive preset to show business KPIs: revenue trends, SLA compliance, IT impact on business, journey flow funnel, and top customers.' },
      { step: 'Inject chaos and watch Dynatrace Intelligence', detail: 'Break something, then show Dynatrace Intelligence finding the root cause automatically.', dtLink: { label: 'Problems', url: `${TENANT_URL}/ui/apps/dynatrace.davis.problems/` } },
      { step: 'Auto-remediate with Fix-It', detail: 'Let AI fix the problem — emphasize speed and zero manual intervention.' },
      { step: 'Show the AppEngine app itself', detail: 'Point out this is a Dynatrace-native app — Strato components, EdgeConnect, serverless functions.' },
    ],
    suggestedPaths: ['quick-start', 'demonstrator-dashboards', 'dynatrace-intelligence', 'chaos-and-fix'],
  },
  {
    id: 'sre',
    icon: '🛡️',
    role: 'SRE / Platform Engineer',
    title: 'Reliability & Chaos Engineering',
    color: '#c0392b',
    audience: 'Site reliability engineers, platform teams, and on-call responders',
    focusAreas: [
      'Chaos engineering with controlled fault injection',
      'Automatic problem detection via Dynatrace Intelligence',
      'Auto-remediation and self-healing services',
      'SLO-relevant golden signals (traffic, latency, errors, saturation)',
    ],
    talkingPoints: [
      'Chaos Control lets you inject specific faults — error rates, latency spikes, timeouts — on individual services.',
      'Every chaos injection sends a CUSTOM_DEPLOYMENT event tagged [ROOT CAUSE] so Dynatrace Intelligence correlates it instantly.',
      'Fix-It reads feature flags, diagnoses the issue, and applies the fix automatically — simulating a real auto-remediation workflow.',
      'The in-app Demonstrator Dashboards include Developer and Operations presets with golden signals: traffic, latency, errors — filterable by company and service.',
    ],
    demoFlow: [
      { step: 'Show running services', detail: 'Open Services app, show healthy baselines and service flow.', dtLink: { label: 'Services', url: `${TENANT_URL}/ui/apps/dynatrace.services` } },
      { step: 'Inject a 50% error rate', detail: 'Use Chaos Control to break a payment service. Show the fault propagating.' },
      { step: 'Watch Dynatrace Intelligence raise a problem', detail: 'Open Problems. Show the automatic root cause analysis and the correlated deployment event.', dtLink: { label: 'Problems', url: `${TENANT_URL}/ui/apps/dynatrace.davis.problems/` } },
      { step: 'Auto-remediate with Fix-It', detail: 'Run Fix-It auto-diagnose. Show it reading flags, finding the issue, and disabling the fault.' },
      { step: 'Verify in Dynatrace', detail: 'Show error rates dropping, problem closing. Highlight zero human intervention.', dtLink: { label: 'Services', url: `${TENANT_URL}/ui/apps/dynatrace.services` } },
      { step: 'Show golden signals on Demonstrator Dashboards', detail: 'Open Demonstrator Dashboards → Developer preset. Show traffic, latency (p50/p90/p99), errors, and service health tiles with RED metrics table.' },
    ],
    suggestedPaths: ['chaos-and-fix', 'slo-reliability', 'autonomous-ops', 'dynatrace-intelligence'],
  },
  {
    id: 'developer',
    icon: '💻',
    role: 'Application Developer',
    title: 'Traces, Code & Debugging',
    color: '#8e44ad',
    audience: 'Full-stack and backend developers who care about code-level visibility',
    focusAreas: [
      'Distributed tracing across microservices',
      'OpenTelemetry instrumentation (auto + manual)',
      'Log correlation with traces',
      'DQL for custom trace queries',
    ],
    talkingPoints: [
      'Every generated service is auto-instrumented with OpenTelemetry — HTTP spans, database calls, and inter-service communication are all captured.',
      'Traces show the full request path across services — you can see exactly where latency or errors occur in the waterfall.',
      'When agents run diagnosis or Smart Chaos, the decisions and results are visible in distributed traces.',
      'DQL lets you query traces like a database — filter by service, status code, duration, or custom attributes.',
    ],
    demoFlow: [
      { step: 'Generate services and wait for traces', detail: 'Create a journey, wait 2 minutes for OneAgent to discover services.' },
      { step: 'Open Distributed Traces', detail: 'Show the trace list — filter by service name to find journey transactions.', dtLink: { label: 'Distributed Traces', url: `${TENANT_URL}/ui/apps/dynatrace.distributedtracing/` } },
      { step: 'Drill into a trace waterfall', detail: 'Click a trace. Walk through the spans — show HTTP calls, durations, status codes.' },
      { step: 'Query with DQL in Notebooks', detail: 'Open a notebook. Use DQL to query and filter traces.', dtLink: { label: 'Notebooks', url: `${TENANT_URL}/ui/apps/dynatrace.notebooks` } },
    ],
    suggestedPaths: ['traces-and-otel', 'live-debugger', 'log-biz-events', 'notebooks-dql'],
  },
  {
    id: 'business-analyst',
    icon: '📊',
    role: 'Business Analyst',
    title: 'Business KPIs & Dashboards',
    color: '#27ae60',
    audience: 'Business analysts, product owners, and anyone focused on business metrics',
    focusAreas: [
      'Business journey modeling (industry templates)',
      'In-app Demonstrator Dashboards with 4 persona presets',
      'Conversion funnel and journey flow visibility',
      'Business impact of technical issues',
    ],
    talkingPoints: [
      'Choose from 10+ industry templates — Retail, Healthcare, Financial Services, Travel, etc. Each models a realistic business journey.',
      'The in-app Demonstrator Dashboards page has 4 persona presets: Developer (~30 tiles), Operations (~27 tiles), Executive (~38 tiles), and Dynatrace Intelligence (~19 tiles) — all filterable by company, journey, service, and event type.',
      'Executive preset shows revenue trends, SLA compliance, journey funnel, IT impact on business, and top customers by revenue.',
      'When chaos hits a service, you can show how a technical issue (e.g. payment errors) directly impacts business KPIs on the Executive preset.',
    ],
    demoFlow: [
      { step: 'Show industry templates', detail: 'Open Step 1 and scroll through the available industries. Point out the journey steps for each.' },
      { step: 'Generate a Retail journey', detail: 'Pick "Retail" with a custom company name. Show the JSON preview to demonstrate the data model.' },
      { step: 'Open Demonstrator Dashboards — Executive preset', detail: 'Navigate to Demonstrator Dashboards. Select Executive to show revenue, SLA, journey funnel, and IT impact tiles. Filter by the company you just generated.' },
      { step: 'Switch to Developer preset', detail: 'Show the Developer view: service health RED table, latency percentiles, error trends, traces & exceptions, and log analysis.' },
      { step: 'Break something and show impact', detail: 'Inject chaos on a payment service. Switch to the Executive preset and show revenue impact, error trends, and IT problems climbing.' },
    ],
    suggestedPaths: ['quick-start', 'demonstrator-dashboards', 'log-biz-events', 'chaos-and-fix'],
  },
  {
    id: 'devops',
    icon: '⚙️',
    role: 'DevOps / Infrastructure',
    title: 'Platform & Deployment',
    color: '#2c3e50',
    audience: 'DevOps engineers, infrastructure teams, and cloud architects',
    focusAreas: [
      'Dynatrace AppEngine app architecture',
      'EdgeConnect secure tunneling',
      'Host and process monitoring',
      'Serverless functions (proxy-api)',
    ],
    talkingPoints: [
      'This app is built with Dynatrace AppEngine — React + Strato component library, deployed with dt-app CLI.',
      'EdgeConnect provides a secure tunnel between Dynatrace and the backend server. No public endpoints, no VPN needed.',
      'The backend runs on an EC2 instance monitored by OneAgent. All Node.js processes are auto-discovered.',
      'The AppEngine app uses a serverless proxy function (proxy-api) to route requests through EdgeConnect to the backend.',
    ],
    demoFlow: [
      { step: 'Show you\'re inside Dynatrace', detail: 'Point out the Dynatrace chrome, Strato components, app URL pattern. This IS Dynatrace.', dtLink: { label: 'Apps', url: `${TENANT_URL}/ui/apps` } },
      { step: 'Open EdgeConnect settings', detail: 'Show the secure tunnel configuration. Explain: no inbound ports, all traffic is outbound from the server.', dtLink: { label: 'EdgeConnect', url: `${TENANT_URL}/ui/apps/dynatrace.settings/settings/external-requests/?tab=edge-connect` } },
      { step: 'Check the host', detail: 'Open Hosts. Show the EC2 instance, CPU/memory, disk — OneAgent sees everything.', dtLink: { label: 'Hosts', url: `${TENANT_URL}/ui/apps/dynatrace.hosts` } },
      { step: 'View technologies/processes', detail: 'Show the Node.js processes — main server, generated services. All auto-discovered.', dtLink: { label: 'Technologies', url: `${TENANT_URL}/ui/apps/dynatrace.technologies` } },
      { step: 'Generate services and show discovery', detail: 'Create a journey. Watch new processes appear in Technologies within minutes.' },
    ],
    suggestedPaths: ['platform', 'security', 'quick-start'],
  },
  {
    id: 'sales-engineer',
    icon: '🎯',
    role: 'Sales Engineer / SE',
    title: 'Full Demo Flow',
    color: '#e67e22',
    audience: 'SEs running a customer demo or internal enablement session',
    focusAreas: [
      'End-to-end wow factor — fast, visual, interactive',
      'Business value + technical depth in one flow',
      'Dynatrace Intelligence differentiation',
      'Platform extensibility story',
    ],
    talkingPoints: [
      'Start with the business angle: "In 30 seconds, we model a full customer journey with real services."',
      'Show breadth: services auto-discovered, traces flowing, 4 persona-based Demonstrator Dashboards (Developer, Ops, Executive, Intelligence) — all from one click.',
      'The chaos → detect → fix → learn loop is the "wow moment". Dynatrace Intelligence finds root cause. Fix-It heals. Librarian remembers for next time.',
      'Close with the platform story: this entire app is a Dynatrace extension. Customers can build apps like this themselves.',
    ],
    demoFlow: [
      { step: '1. Hook: Generate a journey (2 min)', detail: 'Pick Retail + a customer\'s company name if possible. Click Generate. Wait for services to appear.' },
      { step: '2. Show services in Dynatrace (1 min)', detail: 'Open Services. Show the generated services, their dependencies, and the service flow.', dtLink: { label: 'Services', url: `${TENANT_URL}/ui/apps/dynatrace.services` } },
      { step: '3. Open Demonstrator Dashboards (1 min)', detail: 'Navigate to Demonstrator Dashboards. Show Executive preset (revenue, SLA, journey funnel). Switch to Developer preset (RED metrics, latency, traces). Filter by the company name.' },
      { step: '4. Break it — inject chaos (30 sec)', detail: 'Go to Chaos Control. Enable 50% errors on the payment service. Say: "Let\'s see what happens."' },
      { step: '5. Dynatrace Intelligence detects the problem (2 min)', detail: 'Open Problems. Dynatrace Intelligence finds the root cause → correlated deployment event → full impact analysis.', dtLink: { label: 'Problems', url: `${TENANT_URL}/ui/apps/dynatrace.davis.problems/` } },
      { step: '6. Auto-remediate with Fix-It (1 min)', detail: 'Run Fix-It. Watch it diagnose and fix. Switch to Problems — problem closing automatically.' },
      { step: '7. Show the Librarian memory (optional, 1 min)', detail: 'Open the Librarian. Search for the incident you just fixed. Show how it records chaos → problem → diagnosis → fix as a timeline.' },
      { step: '8. LiveDebugger deep-dive (optional, 2 min)', detail: 'Open LiveDebugger on a service process. Set breakpoints on lines 697 (error injection), 708 (full error object), and 996 (service chain call) in dynamic-step-service.js. Capture snapshots showing injected errors, customer data, and trace context.', dtLink: { label: 'LiveDebugger', url: `${TENANT_URL}/ui/apps/dynatrace.devobs.debugger/debugger` } },
      { step: '9. Platform story close (30 sec)', detail: 'Remind them: this is an AppEngine app. Built with React + Strato. Deployed to Dynatrace. Customers can build their own.' },
    ],
    suggestedPaths: ['quick-start', 'chaos-and-fix', 'demonstrator-dashboards', 'live-debugger', 'slo-reliability', 'dynatrace-intelligence'],
  },
  {
    id: 'product-manager',
    icon: '📋',
    role: 'Product Manager',
    title: 'Customer Journey Visibility',
    color: '#2980b9',
    audience: 'Product managers, UX leads, and customer experience teams',
    focusAreas: [
      'Customer journey modeling across industries',
      'Step-by-step funnel visibility',
      'Impact of failures on user experience',
      'Data-driven decision making with DQL',
    ],
    talkingPoints: [
      'Each industry template models a realistic customer journey — e.g. Retail: Browse → Search → Add to Cart → Checkout → Payment → Fulfillment.',
      'Every step is a real service with real metrics: how many users reach each step, how long it takes, and where they drop off.',
      'Injecting chaos on one step (e.g. Payment) shows exactly how a backend issue cascades to the customer experience.',
      'Notebooks and DQL let you build custom queries — "show me all failed payments in the last hour grouped by error type".',
    ],
    demoFlow: [
      { step: 'Walk through industry templates', detail: 'Show the variety: Retail, Healthcare, Travel, etc. Each has different journey steps.' },
      { step: 'Generate a journey with your product name', detail: 'Use the customer\'s product or a relatable brand name for impact.' },
      { step: 'Show Demonstrator Dashboards — Executive preset', detail: 'Focus on the journey funnel: which steps have the most traffic, revenue by step, and where drop-off is highest.' },
      { step: 'Break a step and show business impact', detail: 'Inject errors on "Add to Cart". Show how downstream steps (Checkout, Payment) are affected.' },
      { step: 'Query journey data with DQL', detail: 'In a Notebook, show a custom query filtering by journey step and status.', dtLink: { label: 'Notebooks', url: `${TENANT_URL}/ui/apps/dynatrace.notebooks` } },
    ],
    suggestedPaths: ['quick-start', 'demonstrator-dashboards', 'log-biz-events', 'chaos-and-fix'],
  },
  {
    id: 'security-analyst',
    icon: '🛡️',
    role: 'Security / Compliance Analyst',
    title: 'Security Posture & Vulnerabilities',
    color: '#f59e0b',
    audience: 'CISOs, security engineers, compliance officers, and risk managers',
    focusAreas: [
      'Runtime Application Protection with OneAgent',
      'Vulnerability detection in running code and dependencies',
      'Security event monitoring and attack detection',
      'Risk-based prioritization — reachable vs. installed vulnerabilities',
    ],
    talkingPoints: [
      'OneAgent monitors the running Node.js processes and detects vulnerabilities in real-time — not just installed packages, but actually executed code paths. This eliminates false positives.',
      'Runtime Application Protection detects and blocks attacks (SQL injection, path traversal, command injection) at the application layer — no WAF configuration needed.',
      'The Demonstrator Dashboards Security preset shows live DQL-powered tiles: security event volume, attack categories, trends, and affected entities — all queryable with DQL.',
      'Vulnerabilities are mapped to services and infrastructure via SmartScape topology — so you know the risk context, not just the CVE severity score.',
    ],
    demoFlow: [
      { step: 'Open Application Security overview', detail: 'Navigate to Application Security in Dynatrace. Show the summary: third-party vulnerabilities, runtime vulnerabilities, and attack events detected on the BizObs services.', dtLink: { label: 'Application Security', url: `${TENANT_URL}/ui/apps/dynatrace.classic.security.overview` } },
      { step: 'Check Node.js vulnerabilities', detail: 'Open the Vulnerabilities view. Show the CVEs detected in npm packages used by the BizObs server. Highlight which are runtime-reachable vs. just installed.', dtLink: { label: 'Vulnerabilities', url: `${TENANT_URL}/ui/apps/dynatrace.classic.vulnerabilities` } },
      { step: 'Map vulnerability to service topology', detail: 'Click a vulnerability. Show which specific services and processes are affected. Trace it through the SmartScape dependency graph.', dtLink: { label: 'Vulnerabilities', url: `${TENANT_URL}/ui/apps/dynatrace.classic.vulnerabilities` } },
      { step: 'View the Security Dashboard preset', detail: 'Open Demonstrator Dashboards and select the Security preset. Show security event tiles, attack trends, and affected entity mapping — all live DQL queries.' },
      { step: 'Query security data with DQL', detail: 'Open a Notebook. Run: fetch events | filter event.kind == "SECURITY_EVENT" | summarize count(), by:{event.category} | sort count() desc — shows security event breakdown.', dtLink: { label: 'Notebooks', url: `${TENANT_URL}/ui/apps/dynatrace.notebooks` } },
    ],
    suggestedPaths: ['security', 'platform', 'demonstrator-dashboards'],
  },
  {
    id: 'data-analyst',
    icon: '📊',
    role: 'Data Engineer / DQL Analyst',
    title: 'DQL, Notebooks & Custom Analytics',
    color: '#2563eb',
    audience: 'Data engineers, analytics teams, observability platform engineers, and anyone who loves querying data',
    focusAreas: [
      'DQL (Dynatrace Query Language) across all data types',
      'Grail unified data lakehouse — spans, metrics, logs, events, entities',
      'Notebooks for collaborative analysis and reporting',
      'Custom dashboard creation from live DQL queries',
    ],
    talkingPoints: [
      'DQL queries every data type in Dynatrace from a single language: fetch spans, fetch bizevents, fetch events, fetch logs, fetch metrics, fetch entities. No tool switching.',
      'Grail is the unified data lakehouse — all observability signals land in one place. Cross-correlate traces with logs with business events in a single query.',
      'The Demonstrator generates rich data across all types: distributed traces from services, business events from journeys, Dynatrace Intelligence problems from chaos, logs from processes, and host metrics from OneAgent.',
      'Notebooks combine DQL queries, markdown documentation, and visualizations in a shareable document — ideal for incident postmortems, capacity reviews, and custom reports.',
    ],
    demoFlow: [
      { step: 'Create a Notebook', detail: 'Open Notebooks and create a new one. Add a title like "BizObs Data Analysis — [date]".', dtLink: { label: 'Notebooks', url: `${TENANT_URL}/ui/apps/dynatrace.notebooks` } },
      { step: 'Query spans (traces)', detail: 'Add a DQL section: fetch spans | filter dt.entity.service != "" | summarize count(), avgDuration = avg(duration), by:{dt.entity.service} | sort count() desc — service health overview.' },
      { step: 'Query business events', detail: 'Add another section: fetch bizevents | filter event.type == "bizobs.journey.step" | summarize count(), by:{step_name, status} — journey step conversion analysis.' },
      { step: 'Query Dynatrace Intelligence problems', detail: 'Run: fetch events | filter event.kind == "DAVIS_PROBLEM" | fields timestamp, display_id, title, event.status — problem history.' },
      { step: 'Build a time series', detail: 'Run: fetch spans | makeTimeseries count(), by:{dt.entity.service} — shows request volume over time per service. Switch to chart view.' },
      { step: 'Export a dashboard preset to Notebook', detail: 'Go to Demonstrator Dashboards, select Developer preset, click "Export to Notebook". Show how all DQL tiles become Notebook sections ready to customize.' },
    ],
    suggestedPaths: ['notebooks-dql', 'demonstrator-dashboards', 'traces-and-otel', 'log-biz-events'],
  },
];

// ── Component ──────────────────────────────────────────────
export const DemoGuide = () => {
  const navigate = useNavigate();
  const [mode, setMode] = useState<GuideMode>('paths');
  const [selectedPath, setSelectedPath] = useState<string>('quick-start');
  const [selectedPersona, setSelectedPersona] = useState<string>('cto');
  const [expandedStep, setExpandedStep] = useState<number | null>(null);

  const currentPath = DEMO_PATHS.find(p => p.id === selectedPath) || DEMO_PATHS[0];
  const currentPersona = PERSONAS.find(p => p.id === selectedPersona) || PERSONAS[0];

  // ── Render helpers ─────────────────────────────────────
  const renderStepDetail = (step: WalkthroughStep, index: number, color: string) => (
    <div
      key={index}
      style={{
        marginBottom: 8,
        borderRadius: 10,
        border: `1px solid ${expandedStep === index ? color + '44' : Colors.Border.Neutral.Default}`,
        background: expandedStep === index ? `${color}06` : Colors.Background.Surface.Default,
        transition: 'all 0.15s ease',
        overflow: 'hidden',
      }}
    >
      <div
        onClick={() => setExpandedStep(expandedStep === index ? null : index)}
        style={{ padding: '14px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}
      >
        <div style={{
          width: 28, height: 28, borderRadius: '50%',
          background: `linear-gradient(135deg, ${color}, ${color}88)`,
          color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, fontWeight: 700, flexShrink: 0,
        }}>
          {index + 1}
        </div>
        <div style={{ flex: 1 }}>
          <Strong style={{ fontSize: 14 }}>{step.title}</Strong>
          <div style={{ fontSize: 11, color: Colors.Text.Neutral.Subdued, marginTop: 2 }}>{step.where}</div>
        </div>
        <div style={{ fontSize: 12, color: Colors.Text.Neutral.Subdued, transform: expandedStep === index ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>▼</div>
      </div>
      {expandedStep === index && (
        <div style={{ padding: '0 16px 16px 56px' }}>
          <Paragraph style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 12 }}>{step.action}</Paragraph>
          {step.dql && step.dql.length > 0 && step.dql.map((query, qi) => (
            <div key={qi} style={{
              position: 'relative', marginBottom: 10, borderRadius: 8, overflow: 'hidden',
              border: `1px solid ${color}33`, background: 'rgba(0,0,0,0.25)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 10px', background: `${color}15`, borderBottom: `1px solid ${color}22` }}>
                <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: 1, color, opacity: 0.8 }}>DQL</span>
                <button
                  onClick={() => { navigator.clipboard.writeText(query); }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: Colors.Text.Neutral.Subdued, fontSize: 11, padding: '2px 6px', borderRadius: 4 }}
                  title="Copy DQL to clipboard"
                >📋 Copy</button>
              </div>
              <pre style={{ margin: 0, padding: '10px 14px', fontSize: 12, lineHeight: 1.6, fontFamily: "'JetBrains Mono', 'Fira Code', monospace", overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                <code>{query}</code>
              </pre>
            </div>
          ))}
          {step.tip && (
            <div style={{
              padding: '8px 14px', borderRadius: 8,
              background: 'rgba(255,210,63,0.1)', border: '1px solid rgba(255,210,63,0.3)',
              fontSize: 12, lineHeight: 1.5, marginBottom: 12,
            }}>
              💡 <strong>Tip:</strong> {step.tip}
            </div>
          )}
          {step.dtLink && (
            <a href={step.dtLink.url} target="_blank" rel="noopener noreferrer" style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '7px 14px', borderRadius: 8,
              border: `1px solid ${color}33`, background: `${color}0D`, color,
              fontSize: 12, fontWeight: 600, textDecoration: 'none', cursor: 'pointer',
            }}>
              🔗 Open {step.dtLink.label} in Dynatrace →
            </a>
          )}
        </div>
      )}
    </div>
  );

  return (
    <Page>
      <Page.Main>
        {/* ── Header ── */}
        <div style={{
          padding: '12px 20px',
          borderBottom: `1px solid ${Colors.Border.Neutral.Default}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: Colors.Background.Surface.Default,
          position: 'sticky', top: 0, zIndex: 10,
        }}>
          <Flex alignItems="center" gap={16}>
            <Heading level={4} style={{ margin: 0 }}>📖 Demo Guide</Heading>
            <InfoButton
              align="left"
              title="📖 Demo Guide"
              description="Interactive walkthrough for demoing the BizObs Demonstrator to different audiences."
              sections={[
                { label: '🗺️ Guided Paths', detail: '12 step-by-step walkthroughs: Quick Start, Dashboards, Chaos & Fix-It, Autonomous Ops, Traces, LiveDebugger, Platform, SLOs & Guardian, Logs & Biz Events, Security, Dynatrace Intelligence, Notebooks & DQL' },
                { label: '👥 Persona Demos', detail: '9 persona-tailored demo flows with talking points, focus areas, and suggested paths' },
                { label: '🔗 Dynatrace Links', detail: 'Quick links to Services, Problems, Traces, SLOs, Application Security, Dashboards, Notebooks, and LiveDebugger' },
                { label: 'Expand steps', detail: 'Click any step to see detailed actions, tips, and direct links to Dynatrace apps' },
              ]}
              footer="Switch between Guided Paths and Persona Demos using the toggle in the header."
            />
            {/* Mode toggle */}
            <div style={{
              display: 'flex', borderRadius: 8, overflow: 'hidden',
              border: `1px solid ${Colors.Border.Neutral.Default}`,
            }}>
              {([
                { key: 'paths' as GuideMode, label: '🗺️ Guided Paths' },
                { key: 'personas' as GuideMode, label: '👥 Persona Demos' },
              ]).map((tab) => (
                <div
                  key={tab.key}
                  onClick={() => { setMode(tab.key); setExpandedStep(null); }}
                  style={{
                    padding: '6px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                    background: mode === tab.key ? '#3498db' : 'transparent',
                    color: mode === tab.key ? 'white' : Colors.Text.Neutral.Default,
                    transition: 'all 0.15s ease',
                  }}
                >
                  {tab.label}
                </div>
              ))}
            </div>
          </Flex>
          <Button variant="default" onClick={() => navigate('/')}>← Back to Home</Button>
        </div>

        <Flex flexDirection="row" style={{ height: 'calc(100vh - 56px)', overflow: 'hidden' }}>
          {/* ── Left sidebar ── */}
          <div style={{
            width: 260, flexShrink: 0, overflow: 'auto',
            borderRight: `1px solid ${Colors.Border.Neutral.Default}`, padding: '16px 12px',
          }}>
            {mode === 'paths' ? (
              <>
                <Strong style={{ fontSize: 11, color: Colors.Text.Neutral.Subdued, textTransform: 'uppercase', letterSpacing: 1, display: 'block', marginBottom: 12, paddingLeft: 8 }}>
                  Choose a Path
                </Strong>
                {DEMO_PATHS.map((path) => (
                  <div
                    key={path.id}
                    onClick={() => { setSelectedPath(path.id); setExpandedStep(null); }}
                    style={{
                      padding: '12px', borderRadius: 10, cursor: 'pointer', marginBottom: 6,
                      background: selectedPath === path.id ? `linear-gradient(135deg, ${path.color}22, ${path.color}11)` : 'transparent',
                      border: selectedPath === path.id ? `2px solid ${path.color}66` : '2px solid transparent',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <Flex alignItems="center" gap={8}>
                      <div style={{ fontSize: 22 }}>{path.icon}</div>
                      <div>
                        <Strong style={{ fontSize: 13, color: selectedPath === path.id ? path.color : Colors.Text.Neutral.Default, display: 'block' }}>
                          {path.title}
                        </Strong>
                        <div style={{ fontSize: 11, color: Colors.Text.Neutral.Subdued, marginTop: 2, lineHeight: 1.3 }}>
                          {path.steps.length} steps
                        </div>
                      </div>
                    </Flex>
                  </div>
                ))}
              </>
            ) : (
              <>
                <Strong style={{ fontSize: 11, color: Colors.Text.Neutral.Subdued, textTransform: 'uppercase', letterSpacing: 1, display: 'block', marginBottom: 12, paddingLeft: 8 }}>
                  Choose a Persona
                </Strong>
                {PERSONAS.map((persona) => (
                  <div
                    key={persona.id}
                    onClick={() => { setSelectedPersona(persona.id); setExpandedStep(null); }}
                    style={{
                      padding: '10px 12px', borderRadius: 10, cursor: 'pointer', marginBottom: 6,
                      background: selectedPersona === persona.id ? `linear-gradient(135deg, ${persona.color}22, ${persona.color}11)` : 'transparent',
                      border: selectedPersona === persona.id ? `2px solid ${persona.color}66` : '2px solid transparent',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <Flex alignItems="center" gap={8}>
                      <div style={{ fontSize: 20 }}>{persona.icon}</div>
                      <div>
                        <Strong style={{ fontSize: 12, color: selectedPersona === persona.id ? persona.color : Colors.Text.Neutral.Default, display: 'block' }}>
                          {persona.role}
                        </Strong>
                        <div style={{ fontSize: 10, color: Colors.Text.Neutral.Subdued, marginTop: 1, lineHeight: 1.3 }}>
                          {persona.title}
                        </div>
                      </div>
                    </Flex>
                  </div>
                ))}
              </>
            )}

            {/* Quick Links — always visible */}
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${Colors.Border.Neutral.Default}` }}>
              <Strong style={{ fontSize: 11, color: Colors.Text.Neutral.Subdued, textTransform: 'uppercase', letterSpacing: 1, display: 'block', marginBottom: 10, paddingLeft: 8 }}>
                Dynatrace Links
              </Strong>
              {[
                { label: 'Services', url: `${TENANT_URL}/ui/apps/dynatrace.services` },
                { label: 'Problems', url: `${TENANT_URL}/ui/apps/dynatrace.davis.problems/` },
                { label: 'Traces', url: `${TENANT_URL}/ui/apps/dynatrace.distributedtracing/` },
                { label: 'SLOs', url: `${TENANT_URL}/ui/apps/dynatrace.slo` },
                { label: 'Application Security', url: `${TENANT_URL}/ui/apps/dynatrace.classic.security.overview` },
                { label: 'Logs', url: `${TENANT_URL}/ui/apps/dynatrace.logs` },
                { label: 'Dashboards', url: `${TENANT_URL}/ui/apps/dynatrace.dashboards` },
                { label: 'Demonstrator Dashboards', url: `${TENANT_URL}/ui/apps/my.bizobs.generator.master/ui/demonstrator-dashboards` },
                { label: 'Notebooks', url: `${TENANT_URL}/ui/apps/dynatrace.notebooks` },
                { label: 'Automations', url: `${TENANT_URL}/ui/apps/dynatrace.automations` },
                { label: 'LiveDebugger', url: `${TENANT_URL}/ui/apps/dynatrace.devobs.debugger/debugger` },
              ].map((link, i) => (
                <a key={i} href={link.url} target="_blank" rel="noopener noreferrer" style={{
                  display: 'block', padding: '6px 10px', fontSize: 12,
                  color: Colors.Text.Neutral.Default, textDecoration: 'none', borderRadius: 6, marginBottom: 2,
                }}>
                  🔗 {link.label}
                </a>
              ))}
            </div>
          </div>

          {/* ── Right: Content area ── */}
          <div style={{ flex: 1, overflow: 'auto', padding: '24px 32px' }}>
            {mode === 'paths' ? (
              <>
                {/* Path header */}
                <div style={{
                  background: `linear-gradient(135deg, ${currentPath.color}15, ${currentPath.color}05)`,
                  borderRadius: 12, border: `1px solid ${currentPath.color}33`,
                  padding: '18px 22px', marginBottom: 24,
                }}>
                  <Flex alignItems="center" gap={12}>
                    <div style={{ fontSize: 32 }}>{currentPath.icon}</div>
                    <div>
                      <Heading level={4} style={{ margin: 0, marginBottom: 4 }}>{currentPath.title}</Heading>
                      <Paragraph style={{ fontSize: 13, margin: 0, color: Colors.Text.Neutral.Subdued }}>
                        {currentPath.subtitle}
                      </Paragraph>
                    </div>
                  </Flex>
                </div>

                {/* Steps */}
                {currentPath.steps.map((step, index) => renderStepDetail(step, index, currentPath.color))}

                {/* Progress hint */}
                <div style={{
                  marginTop: 20, padding: '14px 18px', borderRadius: 10,
                  background: 'rgba(108,44,156,0.05)', border: `1px solid ${Colors.Border.Neutral.Default}`,
                  fontSize: 12, color: Colors.Text.Neutral.Subdued, lineHeight: 1.6,
                }}>
                  <strong>What next?</strong> After completing {currentPath.title}, try the other paths.
                  {selectedPath === 'quick-start' && ' "Demonstrator Dashboards Deep Dive" explores all preset dashboards, or try "Chaos & Fix-It" once your services are running.'}
                  {selectedPath === 'demonstrator-dashboards' && ' "Chaos & Fix-It" to break things and watch the dashboards react, or "SLOs & Site Reliability Guardian" to set quality gates.'}
                  {selectedPath === 'chaos-and-fix' && ' "Dynatrace Intelligence Deep Dive" to analyze the problem in depth, or "Autonomous Operations" for the full closed loop.'}
                  {selectedPath === 'autonomous-ops' && ' "Traces & OpenTelemetry" for a deep dive into distributed traces, or "SLOs & Site Reliability Guardian" to set quality gates on the services.'}
                  {selectedPath === 'traces-and-otel' && ' Try "Logs & Business Events" to analyze the other data types, or "LiveDebugger" for code-level debugging.'}
                  {selectedPath === 'live-debugger' && ' "Platform & Architecture" covers how the whole system connects, or "Notebooks & DQL" for custom analysis.'}
                  {selectedPath === 'platform' && ' Try "Security & Vulnerability Management" to see the security posture, or "SLOs & Site Reliability Guardian" for reliability gates.'}
                  {selectedPath === 'slo-reliability' && ' "Dynatrace Intelligence Deep Dive" to see how Dynatrace detects and analyzes problems, or "Chaos & Fix-It" to test your SLOs against real faults.'}
                  {selectedPath === 'log-biz-events' && ' "Notebooks & DQL Mastery" to build custom analysis, or "Traces & OpenTelemetry" to see the distributed traces behind the events.'}
                  {selectedPath === 'security' && ' "Platform & Architecture" to understand the infrastructure being secured, or "Dynatrace Intelligence Deep Dive" for problem detection.'}
                  {selectedPath === 'dynatrace-intelligence' && ' "SLOs & Site Reliability Guardian" to set quality gates, or "Chaos & Fix-It" to auto-remediate the problems Dynatrace Intelligence finds.'}
                  {selectedPath === 'notebooks-dql' && ' "Logs & Business Events" to explore more data types, or "Demonstrator Dashboards" to see pre-built DQL dashboards.'}
                </div>
              </>
            ) : (
              <>
                {/* Persona header */}
                <div style={{
                  background: `linear-gradient(135deg, ${currentPersona.color}15, ${currentPersona.color}05)`,
                  borderRadius: 12, border: `1px solid ${currentPersona.color}33`,
                  padding: '20px 24px', marginBottom: 24,
                }}>
                  <Flex alignItems="center" gap={12}>
                    <div style={{ fontSize: 36 }}>{currentPersona.icon}</div>
                    <div>
                      <Heading level={4} style={{ margin: 0, marginBottom: 4 }}>{currentPersona.role}</Heading>
                      <Paragraph style={{ fontSize: 13, margin: 0, color: Colors.Text.Neutral.Subdued }}>
                        {currentPersona.title} — {currentPersona.audience}
                      </Paragraph>
                    </div>
                  </Flex>
                </div>

                {/* Focus Areas */}
                <div style={{ marginBottom: 20 }}>
                  <Strong style={{ fontSize: 13, display: 'block', marginBottom: 10 }}>🎯 Focus Areas</Strong>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {currentPersona.focusAreas.map((area, i) => (
                      <div key={i} style={{
                        padding: '6px 14px', borderRadius: 20,
                        background: `${currentPersona.color}10`, border: `1px solid ${currentPersona.color}30`,
                        fontSize: 12, color: currentPersona.color, fontWeight: 500,
                      }}>
                        {area}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Talking Points */}
                <div style={{
                  marginBottom: 24, padding: '16px 20px', borderRadius: 12,
                  background: `${currentPersona.color}06`, border: `1px solid ${currentPersona.color}22`,
                }}>
                  <Strong style={{ fontSize: 13, display: 'block', marginBottom: 12 }}>💬 Key Talking Points</Strong>
                  {currentPersona.talkingPoints.map((point, i) => (
                    <div key={i} style={{
                      display: 'flex', gap: 10, marginBottom: i < currentPersona.talkingPoints.length - 1 ? 10 : 0,
                      fontSize: 13, lineHeight: 1.6,
                    }}>
                      <div style={{
                        width: 22, height: 22, borderRadius: '50%', flexShrink: 0, marginTop: 2,
                        background: currentPersona.color, color: 'white',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 11, fontWeight: 700,
                      }}>
                        {i + 1}
                      </div>
                      <div>{point}</div>
                    </div>
                  ))}
                </div>

                {/* Demo Flow */}
                <Strong style={{ fontSize: 13, display: 'block', marginBottom: 12 }}>🎬 Demo Flow</Strong>
                {currentPersona.demoFlow.map((flowStep, index) => (
                  <div
                    key={index}
                    style={{
                      marginBottom: 8, borderRadius: 10, overflow: 'hidden',
                      border: `1px solid ${expandedStep === index ? currentPersona.color + '44' : Colors.Border.Neutral.Default}`,
                      background: expandedStep === index ? `${currentPersona.color}06` : Colors.Background.Surface.Default,
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <div
                      onClick={() => setExpandedStep(expandedStep === index ? null : index)}
                      style={{ padding: '14px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}
                    >
                      <div style={{
                        width: 28, height: 28, borderRadius: '50%',
                        background: `linear-gradient(135deg, ${currentPersona.color}, ${currentPersona.color}88)`,
                        color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 13, fontWeight: 700, flexShrink: 0,
                      }}>
                        {index + 1}
                      </div>
                      <Strong style={{ fontSize: 14, flex: 1 }}>{flowStep.step}</Strong>
                      <div style={{ fontSize: 12, color: Colors.Text.Neutral.Subdued, transform: expandedStep === index ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>▼</div>
                    </div>
                    {expandedStep === index && (
                      <div style={{ padding: '0 16px 16px 56px' }}>
                        <Paragraph style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 12 }}>
                          {flowStep.detail}
                        </Paragraph>
                        {flowStep.dtLink && (
                          <a href={flowStep.dtLink.url} target="_blank" rel="noopener noreferrer" style={{
                            display: 'inline-flex', alignItems: 'center', gap: 6,
                            padding: '7px 14px', borderRadius: 8,
                            border: `1px solid ${currentPersona.color}33`, background: `${currentPersona.color}0D`,
                            color: currentPersona.color, fontSize: 12, fontWeight: 600,
                            textDecoration: 'none', cursor: 'pointer',
                          }}>
                            🔗 Open {flowStep.dtLink.label} in Dynatrace →
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                ))}

                {/* Suggested Paths */}
                <div style={{
                  marginTop: 20, padding: '14px 18px', borderRadius: 10,
                  background: 'rgba(108,44,156,0.05)', border: `1px solid ${Colors.Border.Neutral.Default}`,
                  fontSize: 12, lineHeight: 1.6,
                }}>
                  <strong>Recommended Guided Paths:</strong>{' '}
                  {currentPersona.suggestedPaths.map((pathId, i) => {
                    const p = DEMO_PATHS.find(d => d.id === pathId);
                    return p ? (
                      <span key={pathId}>
                        <span
                          onClick={() => { setMode('paths'); setSelectedPath(pathId); setExpandedStep(null); }}
                          style={{ color: p.color, cursor: 'pointer', fontWeight: 600, textDecoration: 'underline' }}
                        >
                          {p.icon} {p.title}
                        </span>
                        {i < currentPersona.suggestedPaths.length - 1 ? ', ' : ''}
                      </span>
                    ) : null;
                  })}
                </div>
              </>
            )}
          </div>
        </Flex>
      </Page.Main>
    </Page>
  );
};
