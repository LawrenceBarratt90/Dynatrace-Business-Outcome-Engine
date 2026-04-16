/**
 * OpenTelemetry tracing for AI Agent Ollama calls.
 * Emits gen_ai.* spans following the OTel GenAI Semantic Conventions
 * so Dynatrace AI Observability can visualize LLM requests, tokens, latency.
 *
 * IMPORTANT: Uses the GLOBAL TracerProvider registered by otel.cjs (loaded via --require).
 * Do NOT create a separate NodeTracerProvider here — that would override the global one
 * and break metrics/logs export.
 */

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
// Uses the GLOBAL TracerProvider from otel.cjs (no duplicate provider)
let _initialized = false;

export function initTracing(): void {
  if (_initialized) return;
  _initialized = true;
  log.info('✅ GenAI tracing using global OTel provider from otel.cjs');
  log.info('📊 View in Dynatrace: Notebooks > Dynatrace Intelligence > AI Observability');
}

export function getTracer() {
  return trace.getTracer('bizobs-ai-agents', '2.0.0');
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

// ─── Agent Operation Span Wrapper ────────────────────────────

/**
 * Wrap an agent operation in a named span so all child GenAI spans
 * (from chat/chatJSON calls) appear grouped under a single trace.
 * e.g. "nemesis.smartChaos" → "chatJSON llama3.2" → HTTP to Ollama
 */
export async function withAgentSpan<T>(
  agent: string,
  operation: string,
  attributes: Record<string, string | number | boolean> = {},
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  const spanName = `${agent}.${operation}`;

  return tracer.startActiveSpan(spanName, {
    kind: SpanKind.INTERNAL,
    attributes: {
      'ai.agent.name': agent,
      'ai.agent.operation': operation,
      ...attributes,
    },
  }, async (span: Span) => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg });
      span.setAttribute('error.message', errMsg);
      span.end();
      throw err;
    }
  });
}

// ─── Graceful shutdown ───────────────────────────────────────

export async function shutdownTracing(): Promise<void> {
  // No-op: global provider from otel.cjs handles shutdown
  log.info('Tracing shutdown delegated to global otel.cjs provider');
}

// ─── Helpers ─────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.substring(0, max) + '...[truncated]';
}
