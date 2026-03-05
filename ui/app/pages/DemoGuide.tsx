import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Page } from '@dynatrace/strato-components-preview/layouts';
import { Flex } from '@dynatrace/strato-components/layouts';
import { Heading, Paragraph, Strong } from '@dynatrace/strato-components/typography';
import { Button } from '@dynatrace/strato-components/buttons';
import Colors from '@dynatrace/strato-design-tokens/colors';
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
    subtitle: 'Generate services, see them in Dynatrace, download a dashboard',
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
        title: 'Download a dashboard',
        action: 'The app auto-generates a Dynatrace dashboard JSON after services are created. It downloads automatically. Go to Dynatrace → Dashboards → Upload to import it.',
        where: 'This app (auto-download) → Dynatrace Dashboards',
        dtLink: { label: 'Dashboards', url: `${TENANT_URL}/ui/apps/dynatrace.dashboards` },
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
        action: 'Go to the Services page in this app. You should see active services with green status. If not, go back to Quick Start and generate some first.',
        where: 'This app → Services',
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
        title: 'Revert chaos (cleanup)',
        action: 'On the Chaos Control page, click "Revert All" to reset all faults. Services return to normal.',
        where: 'This app → Chaos Control',
      },
    ],
  },
  {
    id: 'traces-and-otel',
    icon: '🔍',
    title: 'Traces & OpenTelemetry',
    subtitle: 'See distributed traces, OTel data, and GenAI spans',
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
      {
        title: 'Trigger an AI agent call',
        action: 'Go to Fix-It and run a diagnosis, or use Chaos Control\'s "Smart Chaos" mode. These actions make calls to the local LLM (Ollama) which generate GenAI spans.',
        where: 'This app → Fix-It or Chaos Control',
        tip: 'If Ollama is not installed (lite mode), the agent uses rule-based fallbacks instead — no GenAI spans will appear.',
      },
      {
        title: 'View GenAI spans',
        action: 'In Distributed Traces, look for spans with gen_ai.system = "ollama". These show the model name, prompt tokens, completion tokens, and latency for each LLM call.',
        where: 'Dynatrace',
        dtLink: { label: 'Distributed Traces', url: `${TENANT_URL}/ui/apps/dynatrace.distributedtracing/` },
      },
      {
        title: 'Query with DQL (optional)',
        action: 'Open a Notebook and try: fetch spans | filter gen_ai.system == "ollama" — this shows all LLM calls with token counts and timing.',
        where: 'Dynatrace',
        dtLink: { label: 'Notebooks', url: `${TENANT_URL}/ui/apps/dynatrace.notebooks` },
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
        action: 'Open Technologies to see all the processes running on the host — the main BizObs server, the dynamically generated services, and Ollama (if installed).',
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
        where: 'BizObs Forge App',
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
];

// ── Persona Demos ──────────────────────────────────────────
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
      { step: 'Open the auto-generated dashboard', detail: 'Highlight business KPIs — conversion rates, error rates, latency by journey step.', dtLink: { label: 'Dashboards', url: `${TENANT_URL}/ui/apps/dynatrace.dashboards` } },
      { step: 'Inject chaos and watch Dynatrace Intelligence', detail: 'Break something, then show Dynatrace Intelligence finding the root cause automatically.', dtLink: { label: 'Problems', url: `${TENANT_URL}/ui/apps/dynatrace.davis.problems/` } },
      { step: 'Auto-remediate with Fix-It', detail: 'Let AI fix the problem — emphasize speed and zero manual intervention.' },
      { step: 'Show the AppEngine app itself', detail: 'Point out this is a Dynatrace-native app — Strato components, EdgeConnect, serverless functions.' },
    ],
    suggestedPaths: ['quick-start', 'chaos-and-fix'],
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
      'The generated dashboard includes golden signals: traffic, latency, errors, and saturation — the four pillars of SRE.',
    ],
    demoFlow: [
      { step: 'Show running services', detail: 'Open Services app, show healthy baselines and service flow.', dtLink: { label: 'Services', url: `${TENANT_URL}/ui/apps/dynatrace.services` } },
      { step: 'Inject a 50% error rate', detail: 'Use Chaos Control to break a payment service. Show the fault propagating.' },
      { step: 'Watch Dynatrace Intelligence raise a problem', detail: 'Open Problems. Show the automatic root cause analysis and the correlated deployment event.', dtLink: { label: 'Problems', url: `${TENANT_URL}/ui/apps/dynatrace.davis.problems/` } },
      { step: 'Auto-remediate with Fix-It', detail: 'Run Fix-It auto-diagnose. Show it reading flags, finding the issue, and disabling the fault.' },
      { step: 'Verify in Dynatrace', detail: 'Show error rates dropping, problem closing. Highlight zero human intervention.', dtLink: { label: 'Services', url: `${TENANT_URL}/ui/apps/dynatrace.services` } },
      { step: 'Show golden signals on dashboard', detail: 'Open the generated dashboard — traffic, latency, errors, saturation tiles.', dtLink: { label: 'Dashboards', url: `${TENANT_URL}/ui/apps/dynatrace.dashboards` } },
    ],
    suggestedPaths: ['chaos-and-fix', 'quick-start'],
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
      'GenAI / LLM observability with semantic spans',
      'DQL for custom trace queries',
    ],
    talkingPoints: [
      'Every generated service is auto-instrumented with OpenTelemetry — HTTP spans, database calls, and inter-service communication are all captured.',
      'Traces show the full request path across services — you can see exactly where latency or errors occur in the waterfall.',
      'When Ollama (local LLM) is running, Fix-It and Smart Chaos produce GenAI spans with model name, token counts, and latency.',
      'DQL lets you query traces like a database — filter by service, status code, duration, or custom attributes.',
    ],
    demoFlow: [
      { step: 'Generate services and wait for traces', detail: 'Create a journey, wait 2 minutes for OneAgent to discover services.' },
      { step: 'Open Distributed Traces', detail: 'Show the trace list — filter by service name to find journey transactions.', dtLink: { label: 'Distributed Traces', url: `${TENANT_URL}/ui/apps/dynatrace.distributedtracing/` } },
      { step: 'Drill into a trace waterfall', detail: 'Click a trace. Walk through the spans — show HTTP calls, durations, status codes.' },
      { step: 'Trigger a GenAI span', detail: 'Run Fix-It diagnosis or Smart Chaos. Then find the gen_ai spans in traces.' },
      { step: 'Query with DQL in Notebooks', detail: 'Open a notebook. Run: fetch spans | filter gen_ai.system == "ollama" to show LLM observability.', dtLink: { label: 'Notebooks', url: `${TENANT_URL}/ui/apps/dynatrace.notebooks` } },
    ],
    suggestedPaths: ['traces-and-otel', 'live-debugger', 'quick-start'],
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
      'Auto-generated dashboards with KPI tiles',
      'Conversion funnel visibility',
      'Business impact of technical issues',
    ],
    talkingPoints: [
      'Choose from 10+ industry templates — Retail, Healthcare, Financial Services, Travel, etc. Each models a realistic business journey.',
      'The app auto-generates a 46-tile dashboard covering journey overview, filtered views, performance, golden signals, and observability.',
      'Dashboard tiles show business-relevant metrics: orders per minute, cart abandonment rates, payment success rates.',
      'When chaos hits a service, you can show how a technical issue (e.g. payment errors) directly impacts business KPIs.',
    ],
    demoFlow: [
      { step: 'Show industry templates', detail: 'Open Step 1 and scroll through the available industries. Point out the journey steps for each.' },
      { step: 'Generate a Retail journey', detail: 'Pick "Retail" with a custom company name. Show the JSON preview to demonstrate the data model.' },
      { step: 'Open the auto-generated dashboard', detail: 'Import the downloaded JSON into Dashboards. Walk through each section.', dtLink: { label: 'Dashboards', url: `${TENANT_URL}/ui/apps/dynatrace.dashboards` } },
      { step: 'Highlight business tiles', detail: 'Focus on Journey Overview and Filtered View sections — these show business-level metrics.' },
      { step: 'Break something and show impact', detail: 'Inject chaos on a payment service. Switch to the dashboard and show error rates climbing on business tiles.' },
    ],
    suggestedPaths: ['quick-start', 'chaos-and-fix'],
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
      { step: 'View technologies/processes', detail: 'Show the Node.js processes — main server, generated services, Ollama. All auto-discovered.', dtLink: { label: 'Technologies', url: `${TENANT_URL}/ui/apps/dynatrace.technologies` } },
      { step: 'Generate services and show discovery', detail: 'Create a journey. Watch new processes appear in Technologies within minutes.' },
    ],
    suggestedPaths: ['platform', 'quick-start'],
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
      'Show breadth: services auto-discovered, traces flowing, dashboard generated — all from one click.',
      'The chaos → detect → fix loop is the "wow moment". Dynatrace Intelligence finds root cause without configuration. Fix-It heals it automatically.',
      'Close with the platform story: this entire app is a Dynatrace extension. Customers can build apps like this themselves.',
    ],
    demoFlow: [
      { step: '1. Hook: Generate a journey (2 min)', detail: 'Pick Retail + a customer\'s company name if possible. Click Generate. Wait for services to appear.' },
      { step: '2. Show services in Dynatrace (1 min)', detail: 'Open Services. Show the generated services, their dependencies, and the service flow.', dtLink: { label: 'Services', url: `${TENANT_URL}/ui/apps/dynatrace.services` } },
      { step: '3. Open the dashboard (1 min)', detail: 'Import the auto-downloaded dashboard. Walk through 2-3 key tiles: journey overview, error rates, golden signals.', dtLink: { label: 'Dashboards', url: `${TENANT_URL}/ui/apps/dynatrace.dashboards` } },
      { step: '4. Break it — inject chaos (30 sec)', detail: 'Go to Chaos Control. Enable 50% errors on the payment service. Say: "Let\'s see what happens."' },
      { step: '5. Dynatrace Intelligence detects the problem (2 min)', detail: 'Open Problems. Dynatrace Intelligence finds the root cause → correlated deployment event → full impact analysis.', dtLink: { label: 'Problems', url: `${TENANT_URL}/ui/apps/dynatrace.davis.problems/` } },
      { step: '6. Auto-remediate with Fix-It (1 min)', detail: 'Run Fix-It. Watch it diagnose and fix. Switch to Problems — problem closing automatically.' },
      { step: '7. Show traces (optional, 1 min)', detail: 'If time allows, show distributed traces and GenAI spans for the LLM calls.', dtLink: { label: 'Distributed Traces', url: `${TENANT_URL}/ui/apps/dynatrace.distributedtracing/` } },
      { step: '8. LiveDebugger deep-dive (optional, 2 min)', detail: 'Open LiveDebugger on a service process. Set breakpoints on lines 697 (error injection), 708 (full error object), and 996 (service chain call) in dynamic-step-service.js. Capture snapshots showing injected errors, customer data, and trace context — three perspectives in one workflow.', dtLink: { label: 'LiveDebugger', url: `${TENANT_URL}/ui/apps/dynatrace.devobs.debugger/debugger` } },
      { step: '9. Platform story close (30 sec)', detail: 'Remind them: this is an AppEngine app. Built with React + Strato. Deployed to Dynatrace. Customers can build their own.' },
    ],
    suggestedPaths: ['quick-start', 'chaos-and-fix', 'traces-and-otel', 'live-debugger', 'platform'],
  },
  {
    id: 'ai-ml',
    icon: '🤖',
    role: 'AI / ML Engineer',
    title: 'GenAI Observability',
    color: '#16a085',
    audience: 'AI/ML engineers, data scientists, and anyone interested in LLM observability',
    focusAreas: [
      'GenAI span instrumentation',
      'Ollama local LLM monitoring',
      'Token usage and latency tracking',
      'AI agent decision tracing',
    ],
    talkingPoints: [
      'The Fix-It and Smart Chaos features use a local LLM (Ollama) to make decisions. Every LLM call is instrumented as a GenAI span.',
      'Spans capture: model name, prompt tokens, completion tokens, total tokens, response time, and the system (ollama).',
      'You can query all LLM calls with DQL: fetch spans | filter gen_ai.system == "ollama" — giving you a full audit trail.',
      'When Ollama isn\'t available, the app falls back to rule-based logic — showing graceful degradation in AI-powered features.',
    ],
    demoFlow: [
      { step: 'Generate services (prerequisite)', detail: 'Create a journey first so there are services to diagnose.' },
      { step: 'Inject chaos', detail: 'Use Chaos Control to create a problem that Fix-It will need to analyze.' },
      { step: 'Run Fix-It with AI diagnosis', detail: 'Click Auto Diagnose. The LLM analyzes the service state and decides on a fix.' },
      { step: 'Find the GenAI spans', detail: 'Open Distributed Traces. Filter for gen_ai spans. Show model, tokens, latency.', dtLink: { label: 'Distributed Traces', url: `${TENANT_URL}/ui/apps/dynatrace.distributedtracing/` } },
      { step: 'Query with DQL', detail: 'Open a Notebook. Run: fetch spans | filter gen_ai.system == "ollama" | fields model, prompt_tokens, completion_tokens, duration', dtLink: { label: 'Notebooks', url: `${TENANT_URL}/ui/apps/dynatrace.notebooks` } },
    ],
    suggestedPaths: ['traces-and-otel', 'chaos-and-fix'],
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
      { step: 'Show the dashboard journey overview', detail: 'Focus on the funnel: which steps have the most traffic, where latency is highest.', dtLink: { label: 'Dashboards', url: `${TENANT_URL}/ui/apps/dynatrace.dashboards` } },
      { step: 'Break a step and show business impact', detail: 'Inject errors on "Add to Cart". Show how downstream steps (Checkout, Payment) are affected.' },
      { step: 'Query journey data with DQL', detail: 'In a Notebook, show a custom query filtering by journey step and status.', dtLink: { label: 'Notebooks', url: `${TENANT_URL}/ui/apps/dynatrace.notebooks` } },
    ],
    suggestedPaths: ['quick-start', 'chaos-and-fix'],
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
                { label: 'Dashboards', url: `${TENANT_URL}/ui/apps/dynatrace.dashboards` },
                { label: 'AI Observability', url: `${TENANT_URL}/ui/apps/dynatrace.dashboards/dashboard/bizobs-ai-observability-dashboard` },
                { label: 'Notebooks', url: `${TENANT_URL}/ui/apps/dynatrace.notebooks` },
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
                  {selectedPath === 'quick-start' && ' "Chaos & Fix-It" is a good next step once your services are running.'}
                  {selectedPath === 'chaos-and-fix' && ' "Traces & OpenTelemetry" shows what\'s happening under the hood.'}
                  {selectedPath === 'traces-and-otel' && ' "LiveDebugger" lets you set breakpoints on running services to inspect errors at the code level.'}
                  {selectedPath === 'live-debugger' && ' "Platform & Architecture" covers how the whole system connects — AppEngine, EdgeConnect, and OneAgent.'}
                  {selectedPath === 'platform' && ' Try "LiveDebugger" for code-level debugging, or "Chaos & Fix-It" to see auto-remediation in action.'}
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
