/**
 * OpenTelemetry Bootstrap — loaded via  node --require ./otel.js server.js
 *
 * Follows the official Dynatrace walkthrough:
 * https://docs.dynatrace.com/docs/shortlink/otel-wt-nodejs
 *
 * Automatically instruments HTTP calls
 * and exports traces + metrics + logs to Dynatrace via OTLP.
 *
 * Token scopes required (stored in .dt-credentials.json → otelToken):
 *   - openTelemetryTrace.ingest
 *   - metrics.ingest
 *   - logs.ingest
 */

// Load .env first so all modules (including config.ts) see env vars at import time
require('dotenv').config();

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
const {
  UndiciInstrumentation,
} = require("@opentelemetry/instrumentation-undici");

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

// 2. Fill gaps from .dt-credentials.json (resolve relative to this file's directory, not cwd)
const credentialsPath = require("path").resolve(__dirname, ".dt-credentials.json");
try {
  const creds = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));
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
  console.warn("[otel.js] 💡 Configure credentials at startup or via the UI, then restart for OTel export");
} else {
  console.log(`[otel.js] ✅ OTLP endpoint: ${DT_API_URL}`);
}

const CAN_EXPORT = !!(DT_API_URL && DT_API_TOKEN);
const AUTH_HEADER = { Authorization: "Api-Token " + DT_API_TOKEN };

// ===== GENERAL SETUP =====

registerInstrumentations({
  instrumentations: [
    // Instruments http/https module (legacy requests)
    new HttpInstrumentation(),
    // Instruments native fetch() (undici) — required for Node >= 18
    new UndiciInstrumentation(),
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

// Use env var for service name so child services get their own identity
const otelServiceName = process.env.OTEL_SERVICE_NAME || process.env.DT_SERVICE_NAME || "bizobs-ai-engine";

const resource = defaultResource()
  .merge(
    resourceFromAttributes({
      [ATTR_SERVICE_NAME]: otelServiceName,
      [ATTR_SERVICE_VERSION]: "2.9.10",
      "deployment.environment": process.env.NODE_ENV || "production",
      "service.namespace": "bizobs",
    })
  )
  .merge(dtmetadata);

// ===== TRACING SETUP =====

if (CAN_EXPORT) {
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
} else {
  // No credentials — register a basic tracer for local context propagation only
  const tracerProvider = new NodeTracerProvider({ resource: resource });
  tracerProvider.register();
  console.log("[otel.js] 🔇 OTel initialized (local only — no export). Configure DT credentials to enable export.");
}
