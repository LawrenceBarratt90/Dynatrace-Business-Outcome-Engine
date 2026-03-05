/**
 * OpenTelemetry Bootstrap — loaded via  node --require ./otel.js server.js
 *
 * Follows the official Dynatrace walkthrough:
 * https://docs.dynatrace.com/docs/shortlink/otel-wt-nodejs
 *
 * Automatically instruments HTTP calls (including Ollama requests)
 * and exports traces + metrics + logs to Dynatrace via OTLP.
 *
 * Token scopes required (stored in .dt-credentials.json → otelToken):
 *   - openTelemetryTrace.ingest
 *   - metrics.ingest
 *   - logs.ingest
 */

const opentelemetry = require("@opentelemetry/api");
const {
  resourceFromAttributes,
  emptyResource,
  defaultResource,
} = require("@opentelemetry/resources");
const {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} = require("@opentelemetry/semantic-conventions");
const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
const { registerInstrumentations } = require("@opentelemetry/instrumentation");
const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base");
const {
  OTLPTraceExporter,
} = require("@opentelemetry/exporter-trace-otlp-proto");
const {
  OTLPMetricExporter,
} = require("@opentelemetry/exporter-metrics-otlp-proto");
const {
  MeterProvider,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} = require("@opentelemetry/sdk-metrics");
const {
  LoggerProvider,
  BatchLogRecordProcessor,
} = require("@opentelemetry/sdk-logs");
const {
  OTLPLogExporter,
} = require("@opentelemetry/exporter-logs-otlp-proto");
const {
  HttpInstrumentation,
} = require("@opentelemetry/instrumentation-http");

const { logs: logsAPI } = require("@opentelemetry/api-logs");
const fs = require("fs");

// ===== LOAD CREDENTIALS =====
// Prefer the dedicated otelToken from .dt-credentials.json (has ingest scopes)
// Fall back to env vars or the general apiToken

let DT_API_URL = "";
let DT_API_TOKEN = "";

// 1. Try env vars first
if (process.env.DT_ENVIRONMENT) {
  DT_API_URL = process.env.DT_ENVIRONMENT.replace(/\/+$/, "") + "/api/v2/otlp";
}
DT_API_TOKEN = process.env.DT_OTEL_TOKEN || process.env.DT_PLATFORM_TOKEN || "";

// 2. Fill gaps from .dt-credentials.json
try {
  const creds = JSON.parse(fs.readFileSync(".dt-credentials.json", "utf-8"));
  if (!DT_API_URL && creds.environmentUrl) {
    DT_API_URL = creds.environmentUrl.replace(/\/+$/, "") + "/api/v2/otlp";
  }
  // Prefer the dedicated otelToken (has ingest scopes)
  if (!DT_API_TOKEN) {
    DT_API_TOKEN = creds.otelToken || creds.apiToken || "";
  }
  if (DT_API_URL) {
    console.log("[otel.js] 📦 Loaded credentials from .dt-credentials.json");
    console.log("[otel.js]    Token type:", creds.otelToken ? "otelToken (ingest scopes)" : "apiToken (general)");
  }
} catch {
  // file not present
}

if (!DT_API_URL || !DT_API_TOKEN) {
  console.warn("[otel.js] ⚠️  Missing DT URL or token — OTel will NOT export");
} else {
  console.log(`[otel.js] ✅ OTLP endpoint: ${DT_API_URL}`);
}

const AUTH_HEADER = { Authorization: "Api-Token " + DT_API_TOKEN };

// ===== GENERAL SETUP =====

registerInstrumentations({
  instrumentations: [
    new HttpInstrumentation({
      // Tag outbound Ollama HTTP calls with GenAI attributes
      requestHook: (span, request) => {
        const url =
          typeof request.path === "string"
            ? request.path
            : String(request.path || "");
        const host =
          (request.headers && request.headers.host) ||
          (request.getHeader && request.getHeader("host")) ||
          "";
        if (
          String(host).includes("11434") ||
          url.includes("/api/generate") ||
          url.includes("/api/chat")
        ) {
          span.setAttribute("gen_ai.system", "ollama");
          span.setAttribute(
            "gen_ai.request.model",
            process.env.OLLAMA_MODEL || "llama3.2"
          );
          span.setAttribute("ai.agent.framework", "bizobs-engine");
        }
      },
    }),
  ],
});

// ===== DT METADATA ENRICHMENT =====
// Read OneAgent metadata files to link OTel data with host/process topology

let dtmetadata = emptyResource();
for (const name of [
  "dt_metadata_e617c525669e072eebe3d0f08212e8f2.json",
  "/var/lib/dynatrace/enrichment/dt_metadata.json",
  "/var/lib/dynatrace/enrichment/dt_host_metadata.json",
]) {
  try {
    dtmetadata = dtmetadata.merge(
      resourceFromAttributes(
        JSON.parse(
          fs.readFileSync(
            name.startsWith("/var")
              ? name
              : fs.readFileSync(name).toString("utf-8").trim()
          ).toString("utf-8")
        )
      )
    );
    console.log(`[otel.js] 📎 Loaded DT metadata from: ${name}`);
    break;
  } catch {
    // metadata file not present — skip
  }
}

const resource = defaultResource()
  .merge(
    resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "bizobs-ai-engine",
      [ATTR_SERVICE_VERSION]: "2.9.10",
      "deployment.environment": process.env.NODE_ENV || "production",
      "service.namespace": "bizobs",
      "ai.engine.type": "ollama-agent-framework",
    })
  )
  .merge(dtmetadata);

// ===== TRACING SETUP =====

const traceExporter = new OTLPTraceExporter({
  url: DT_API_URL + "/v1/traces",
  headers: AUTH_HEADER,
});

const traceProcessor = new BatchSpanProcessor(traceExporter);

const tracerProvider = new NodeTracerProvider({
  resource: resource,
  spanProcessors: [traceProcessor],
});

tracerProvider.register();
console.log("[otel.js] 📡 Traces → " + DT_API_URL + "/v1/traces");

// ===== METRIC SETUP =====

const metricExporter = new OTLPMetricExporter({
  url: DT_API_URL + "/v1/metrics",
  headers: AUTH_HEADER,
  temporalityPreference: AggregationTemporality.DELTA,
});

const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 3000,
});

const meterProvider = new MeterProvider({
  resource: resource,
  readers: [metricReader],
});

opentelemetry.metrics.setGlobalMeterProvider(meterProvider);
console.log("[otel.js] 📊 Metrics → " + DT_API_URL + "/v1/metrics");

// ===== LOG SETUP =====

const logExporter = new OTLPLogExporter({
  url: DT_API_URL + "/v1/logs",
  headers: AUTH_HEADER,
});

const loggerProvider = new LoggerProvider({
  resource: resource,
  processors: [new BatchLogRecordProcessor(logExporter)],
});

logsAPI.setGlobalLoggerProvider(loggerProvider);
console.log("[otel.js] 📝 Logs   → " + DT_API_URL + "/v1/logs");

// ===== READY =====

console.log("[otel.js] 🎯 OpenTelemetry initialized — traces + metrics + logs → Dynatrace");
