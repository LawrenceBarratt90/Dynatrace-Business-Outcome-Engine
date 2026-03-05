/**
 * OpenTelemetry tracing for AI Agent Ollama calls.
 * Emits gen_ai.* spans following the OTel GenAI Semantic Conventions
 * so Dynatrace AI Observability can visualize LLM requests, tokens, latency.
 *
 * Env vars (set by the app or .env):
 *   DT_ENVIRONMENT   — e.g. https://abc12345.live.dynatrace.com
 *   DT_PLATFORM_TOKEN — API token with openTelemetryTrace.ingest scope
 *
 * The OTLP exporter sends to: {DT_ENVIRONMENT}/api/v2/otlp/v1/traces
 */

import { readFileSync } from 'fs';
import path from 'path';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { trace, context, SpanKind, SpanStatusCode, Span } from '@opentelemetry/api';
import { createLogger } from './logger.js';

const log = createLogger('otel');

// ─── Types ────────────────────────────────────────────────────

export interface GenAISpanOptions {
  operation: string;                  // 'chat' | 'chatJSON' | 'agentLoop'
  model: string;
  messages: { role: string; content: string }[];
  temperature?: number;
  tools?: { function: { name: string } }[];
}

export interface GenAISpanResult {
  content: string;
  toolCalls?: number;
  totalDurationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  error?: string;
}

// ─── Singleton Provider ───────────────────────────────────────

let _provider: NodeTracerProvider | null = null;
let _initialized = false;

/**
 * Read DT credentials from .dt-credentials.json (set via the UI).
 * Falls back gracefully if the file doesn't exist.
 */
function loadCredentialsFile(): { environmentUrl?: string; apiToken?: string; otelToken?: string } {
  try {
    const credsPath = path.join(process.cwd(), '.dt-credentials.json');
    const data = JSON.parse(readFileSync(credsPath, 'utf-8'));
    return {
      environmentUrl: data.environmentUrl || undefined,
      apiToken: data.apiToken || undefined,
      otelToken: data.otelToken || undefined,
    };
  } catch {
    return {};
  }
}

function getDTEndpoint(): string | null {
  const env = process.env.DT_ENVIRONMENT || process.env.DYNATRACE_URL || '';
  let url = env;
  // Fallback: read from persisted .dt-credentials.json (saved via UI)
  if (!url) {
    const creds = loadCredentialsFile();
    url = creds.environmentUrl || '';
    if (url) log.info('📦 DT URL loaded from .dt-credentials.json');
  }
  if (!url) return null;
  // Strip trailing slash, ensure no .apps. in URL
  const base = url.replace(/\/+$/, '').replace('.apps.dynatrace', '.dynatrace');
  return `${base}/api/v2/otlp/v1/traces`;
}

function getDTToken(): string | null {
  const envToken = process.env.DT_OTEL_TOKEN || process.env.DT_PLATFORM_TOKEN || process.env.DYNATRACE_TOKEN || process.env.DT_API_TOKEN || null;
  if (envToken) return envToken;
  // Fallback: read from persisted credentials file
  // Prefer otelToken (has ingest scopes) over apiToken (general)
  const creds = loadCredentialsFile();
  if (creds.otelToken) {
    log.info('📦 DT otelToken loaded from .dt-credentials.json (ingest scopes)');
    return creds.otelToken;
  }
  if (creds.apiToken) {
    log.info('📦 DT apiToken loaded from .dt-credentials.json (general)');
    return creds.apiToken;
  }
  return null;
}

export function initTracing(): void {
  if (_initialized) return;
  _initialized = true;

  const endpoint = getDTEndpoint();
  const token = getDTToken();

  if (!endpoint || !token) {
    log.warn('⚠️  OTel tracing NOT enabled — DT_ENVIRONMENT or DT_PLATFORM_TOKEN not set');
    log.info('📋 Current environment variables:');
    log.info(`   DT_ENVIRONMENT: ${process.env.DT_ENVIRONMENT ? '✓ set' : '✗ not set'}`);
    log.info(`   DYNATRACE_URL: ${process.env.DYNATRACE_URL ? '✓ set' : '✗ not set'}`);
    log.info(`   DT_PLATFORM_TOKEN: ${process.env.DT_PLATFORM_TOKEN ? '✓ set (hidden)' : '✗ not set'}`);
    log.info(`   DYNATRACE_TOKEN: ${process.env.DYNATRACE_TOKEN ? '✓ set (hidden)' : '✗ not set'}`);
    log.info(`   DT_API_TOKEN: ${process.env.DT_API_TOKEN ? '✓ set (hidden)' : '✗ not set'}`);
    log.info('💡 To enable AI Observability: set DT_ENVIRONMENT and DT_PLATFORM_TOKEN');
    return;
  }

  log.info(`✅ Initializing OTel tracing for AI Observability`);
  log.info(`   Endpoint: ${endpoint}`);
  log.info(`   Service: bizobs-ai-agents v1.0.0`);

  const resource = resourceFromAttributes({
    'service.name': 'bizobs-ai-agents',
    'service.version': '1.0.0',
    'deployment.environment': process.env.NODE_ENV || 'production',
  });

  const exporter = new OTLPTraceExporter({
    url: endpoint,
    headers: {
      Authorization: `Api-Token ${token}`,
    },
  });

  _provider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  _provider.register();

  log.info('🎯 OTel tracing initialized — GenAI spans for Ollama calls will appear in Dynatrace');
  log.info('📊 View in Dynatrace: Notebooks > Dynatrace Intelligence > AI Observability');
}

export function getTracer() {
  return trace.getTracer('bizobs-ai-agents', '1.0.0');
}

// ─── GenAI Span Wrapper ──────────────────────────────────────

/**
 * Wrap an Ollama call in a GenAI-convention span.
 * Uses attributes from https://docs.dynatrace.com/docs/observe/dynatrace-for-ai-observability/models-and-platforms/ollama
 */
export async function withGenAISpan<T>(
  options: GenAISpanOptions,
  fn: () => Promise<T>,
  extractResult?: (result: T) => GenAISpanResult,
): Promise<T> {
  if (!_provider) {
    // Tracing not enabled — run without span
    return fn();
  }

  const tracer = getTracer();
  const spanName = `${options.operation} ${options.model}`;

  return tracer.startActiveSpan(spanName, {
    kind: SpanKind.CLIENT,
    attributes: {
      // GenAI semantic conventions
      'gen_ai.system': 'ollama',
      'gen_ai.request.model': options.model,
      'llm.request.type': options.operation === 'chatJSON' ? 'chat' : options.operation,
      'gen_ai.request.temperature': options.temperature ?? 0.3,

      // Prompt content (first user + system messages)
      ...(options.messages[0] ? {
        'gen_ai.prompt.0.role': options.messages[0].role,
        'gen_ai.prompt.0.content': truncate(options.messages[0].content, 4096),
      } : {}),
      ...(options.messages.length > 1 ? {
        'gen_ai.prompt.1.role': options.messages[1].role,
        'gen_ai.prompt.1.content': truncate(options.messages[1].content, 4096),
      } : {}),

      // Tool info
      ...(options.tools?.length ? {
        'gen_ai.request.tools_count': options.tools.length,
        'gen_ai.request.tools': options.tools.map(t => t.function.name).join(', '),
      } : {}),
    },
  }, async (span: Span) => {
    try {
      const result = await fn();

      if (extractResult) {
        const r = extractResult(result);
        span.setAttributes({
          'gen_ai.completion.0.role': 'assistant',
          'gen_ai.completion.0.content': truncate(r.content, 4096),
          'gen_ai.response.model': options.model,
          ...(r.promptTokens != null ? { 'gen_ai.usage.prompt_tokens': r.promptTokens } : {}),
          ...(r.completionTokens != null ? { 'gen_ai.usage.completion_tokens': r.completionTokens } : {}),
          ...(r.toolCalls ? { 'gen_ai.response.tool_calls': r.toolCalls } : {}),
          'gen_ai.response.duration_ms': r.totalDurationMs,
        });

        span.setStatus({ code: SpanStatusCode.OK });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }

      span.end();
      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg });
      span.setAttribute('error.message', errMsg);
      span.setAttribute('error.type', err instanceof Error ? err.constructor.name : 'Error');
      span.end();
      throw err;
    }
  });
}

// ─── Graceful shutdown ───────────────────────────────────────

export async function shutdownTracing(): Promise<void> {
  if (_provider) {
    log.info('Shutting down OTel tracing...');
    await _provider.shutdown();
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.substring(0, max) + '...[truncated]';
}
