/**
 * Fix-It Agent — AI-powered problem diagnosis and remediation.
 * Uses Dynatrace to detect problems, LLM to diagnose root causes,
 * then remediates by calling the feature flag API and sending
 * Dynatrace custom events — the same actions a human operator would take.
 *
 * Pipeline: detect → diagnose → propose fix → execute → verify → learn.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  getProblems, getProblemDetails, getLogs, getMetrics, getTopology,
  dynatraceToolDefs, executeDynatraceTool,
} from '../../tools/dynatrace/dtTools.js';
import { fixTools, fixToolDefs, executeFixTool, FixResult, FixType } from '../../tools/fixes/fixTools.js';
import {
  recordProblem, recordDiagnosis, recordFix,
  searchSimilar, generateLearning,
} from '../librarian/librarianAgent.js';
import { chat, chatJSON, agentLoop, isOllamaAvailable, ToolDefinition, ChatMessage } from '../../utils/llmClient.js';
import { createLogger } from '../../utils/logger.js';
import { withAgentSpan } from '../../utils/otelTracing.js';

const log = createLogger('fixit');

// ─── Types ────────────────────────────────────────────────────

export interface DiagnosisResult {
  problemId: string;
  summary: string;
  rootCause: string;
  confidence: number;
  evidence: string[];
  proposedFixes: ProposedFix[];
}

export interface ProposedFix {
  fixType: FixType;
  target: string;
  reasoning: string;
  risk: 'low' | 'medium' | 'high';
  details?: Record<string, unknown>;
}

export interface FixItRunResult {
  runId: string;
  problemId: string;
  diagnosis: DiagnosisResult;
  fixesExecuted: FixResult[];
  verified: boolean;
  totalDurationMs: number;
}

// ─── Helpers ──────────────────────────────────────────────────

const APP_BASE = `http://localhost:${process.env.PORT || 8080}`;

async function getCurrentFeatureFlags(): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(`${APP_BASE}/api/feature_flag`);
    const data = (await res.json()) as Record<string, unknown>;
    return (data as any).flags || {};
  } catch {
    return {};
  }
}

async function getRemediationFlags(): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(`${APP_BASE}/api/remediation/feature-flags`);
    const data = (await res.json()) as Record<string, unknown>;
    return (data as any).flags || {};
  } catch {
    return {};
  }
}

// ─── Core Pipeline ────────────────────────────────────────────

/**
 * Full autonomous run: detect → diagnose → fix → verify → learn.
 */
export async function autoFix(problemId?: string): Promise<FixItRunResult> {
  return withAgentSpan('fixit', 'autoFix', { ...(problemId ? { 'fixit.problem_id': problemId } : {}) }, async () => {
  const runId = `fixit-${Date.now()}`;
  const startTime = Date.now();
  log.info('🔧 Fix-It Agent starting', { runId, problemId });

  // Step 1: Detect
  let targetProblemId = problemId;
  if (!targetProblemId) {
    const problems = await getProblems('1h');
    if (problems.length === 0) {
      log.info('No active problems — checking feature flag state');
      // Even without DT problems, check if flags are in a bad state
      const flags = await getCurrentFeatureFlags();
      const remFlags = await getRemediationFlags();
      const errorRate = (flags as any).errors_per_transaction ?? 0.1;
      const errorsEnabled = (remFlags as any).errorInjectionEnabled ?? true;

      if (errorRate > 0.5 || !errorsEnabled) {
        targetProblemId = `flag-anomaly-${Date.now()}`;
        log.info(`Detected feature flag anomaly: errorRate=${errorRate}, enabled=${errorsEnabled}`);
      } else {
        return {
          runId, problemId: 'none',
          diagnosis: {
            problemId: 'none', summary: 'No active problems', rootCause: 'N/A',
            confidence: 1, evidence: [], proposedFixes: [],
          },
          fixesExecuted: [], verified: true,
          totalDurationMs: Date.now() - startTime,
        };
      }
    } else {
      targetProblemId = problems[0].problemId;
      log.info(`Auto-selected problem: ${targetProblemId} — ${problems[0].title}`);
    }
  }

  // Step 2: Diagnose
  const diagnosis = await diagnose(targetProblemId!);

  // Step 3: Record
  await recordProblem({
    problemId: targetProblemId!,
    title: diagnosis.summary,
    severity: 'unknown',
    affectedEntities: diagnosis.evidence,
  });

  await recordDiagnosis({
    problemId: targetProblemId!,
    diagnosis: diagnosis.rootCause,
    confidence: diagnosis.confidence,
    proposedFix: diagnosis.proposedFixes.map(f => `${f.fixType}:${f.target}`).join(', '),
  });

  // Step 4: Execute fixes
  const fixesExecuted: FixResult[] = [];
  for (const fix of diagnosis.proposedFixes) {
    if (fix.risk === 'high') {
      log.warn(`Skipping high-risk fix: ${fix.fixType}`, { reasoning: fix.reasoning });
      continue;
    }

    log.info(`Executing fix: ${fix.fixType} on ${fix.target}`, { risk: fix.risk });
    const handler = fixTools[fix.fixType];
    if (handler) {
      const result = await handler({
        target: fix.target,
        details: { ...fix.details, problemId: targetProblemId },
      });
      fixesExecuted.push(result);

      await recordFix({
        fixId: result.fixId, problemId: targetProblemId!,
        fixType: fix.fixType, target: fix.target,
        success: result.success, message: result.message,
      });
    }
  }

  // Step 5: Verify
  const verified = await verifyFix(targetProblemId!);

  // Step 6: Generate learning (fire-and-forget — don't block the response)
  generateLearning(targetProblemId!).catch(err => {
    log.warn('Learning generation failed', { error: String(err) });
  });

  const totalDurationMs = Date.now() - startTime;
  log.info('🔧 Fix-It Agent complete', { runId, fixes: fixesExecuted.length, verified, totalDurationMs });

  return { runId, problemId: targetProblemId!, diagnosis, fixesExecuted, verified, totalDurationMs };
  });
}

/**
 * Diagnose a problem using LLM + Dynatrace data + feature flag state.
 */
export async function diagnose(problemId: string): Promise<DiagnosisResult> {
  return withAgentSpan('fixit', 'diagnose', { 'fixit.problem_id': problemId }, async () => {
  log.info('Diagnosing problem', { problemId });

  // Gather local context only — DT Workflow sends problem data, no need to call DT API
  const [featureFlags, remFlags] = await Promise.all([
    getCurrentFeatureFlags(),
    getRemediationFlags(),
  ]);

  // Check Librarian for known issues
  const similar = await searchSimilar(`problem ${problemId}`, 3);
  const pastContext = similar.results.length > 0
    ? `\nKnown issues:\n${similar.results.map(r => `- ${r.text}`).join('\n')}`
    : '';

  const ollamaUp = await isOllamaAvailable();

  if (ollamaUp) {
    try {
      // Try LLM diagnosis with a timeout — fall back to rules if it takes too long
      const llmResult = await llmDiagnose(problemId, featureFlags, remFlags, pastContext);
      return llmResult;
    } catch (err) {
      log.warn('LLM diagnosis failed, falling back to rules', { error: String(err) });
      return ruleDiagnose(problemId, null, featureFlags, remFlags);
    }
  } else {
    return ruleDiagnose(problemId, null, featureFlags, remFlags);
  }
  });
}

// ─── LLM Diagnosis ───────────────────────────────────────────

async function llmDiagnose(
  problemId: string,
  featureFlags: Record<string, unknown>,
  remFlags: Record<string, unknown>,
  pastContext: string,
): Promise<DiagnosisResult> {
  return withAgentSpan('fixit', 'llmDiagnose', { 'fixit.problem_id': problemId }, async () => {
  const context = `Flags: ${JSON.stringify(featureFlags)} Toggles: ${JSON.stringify(remFlags)}${pastContext}`;

  const result = await chatJSON<{
    summary: string;
    rootCause: string;
    confidence: number;
    evidence: string[];
    proposedFixes: { fixType: FixType; target: string; reasoning: string; risk: string }[];
  }>([
    {
      role: 'system',
      content: `Fix-It Agent. Diagnose flag state and prescribe fix.\nFix types: disable_errors, reset_feature_flags, reduce_error_rate, enable_circuit_breaker, enable_cache, disable_slow_responses\nRespond JSON: {"summary":"one line","rootCause":"what is wrong","confidence":0.8,"evidence":["..."],"proposedFixes":[{"fixType":"...","target":"...","reasoning":"one sentence","risk":"low"}]}`,
    },
    { role: 'user', content: context },
  ], { temperature: 0.3 });

  return {
    problemId,
    summary: result.summary,
    rootCause: result.rootCause,
    confidence: Math.min(Math.max(result.confidence, 0), 1),
    evidence: result.evidence || [],
    proposedFixes: (result.proposedFixes || []).map(f => ({
      fixType: f.fixType as FixType,
      target: f.target,
      reasoning: f.reasoning,
      risk: (f.risk as 'low' | 'medium' | 'high') || 'medium',
    })),
  };
  });
}

// ─── Rule-based Diagnosis Fallback ───────────────────────────

function ruleDiagnose(
  problemId: string,
  problem: Record<string, unknown> | null,
  featureFlags: Record<string, unknown>,
  remFlags: Record<string, unknown>,
): DiagnosisResult {
  const title = (problem?.title as string) || 'Unknown problem';
  const severity = (problem?.severityLevel as string) || 'UNKNOWN';

  const fixes: ProposedFix[] = [];
  const evidence: string[] = [];
  const errorRate = (featureFlags as any).errors_per_transaction ?? 0.1;
  const errorsEnabled = (remFlags as any).errorInjectionEnabled ?? true;
  const slowEnabled = (remFlags as any).slowResponsesEnabled ?? false;
  const cacheEnabled = (remFlags as any).cacheEnabled ?? true;
  const cbEnabled = (remFlags as any).circuitBreakerEnabled ?? false;

  evidence.push(`Problem: ${title} (${severity})`);
  evidence.push(`Error rate: ${errorRate}, injection: ${errorsEnabled}, slow: ${slowEnabled}`);
  evidence.push(`Cache: ${cacheEnabled}, circuit breaker: ${cbEnabled}`);

  // High error rate
  if (errorRate > 0.3) {
    fixes.push({
      fixType: 'reduce_error_rate', target: 'errors_per_transaction',
      reasoning: `Error rate is ${errorRate} (>0.3) — likely Nemesis injection. Reducing to 0.01.`,
      risk: 'low', details: { rate: 0.01 },
    });
  }

  // Error injection is enabled and causing issues
  if (errorsEnabled && (title.toLowerCase().includes('error') || title.toLowerCase().includes('failure'))) {
    fixes.push({
      fixType: 'disable_errors', target: 'errorInjectionEnabled',
      reasoning: 'Error injection is enabled and errors are being detected — disable to remediate.',
      risk: 'low',
    });
  }

  // Slow responses enabled
  if (slowEnabled && (title.toLowerCase().includes('response time') || title.toLowerCase().includes('slowdown'))) {
    fixes.push({
      fixType: 'disable_slow_responses', target: 'slowResponsesEnabled',
      reasoning: 'Slow responses enabled — causing latency.',
      risk: 'low',
    });
  }

  // Cache disabled
  if (!cacheEnabled) {
    fixes.push({
      fixType: 'enable_cache', target: 'cacheEnabled',
      reasoning: 'Cache is disabled — re-enabling to improve performance.',
      risk: 'low',
    });
  }

  // Circuit breaker disabled during cascading failures
  if (!cbEnabled && title.toLowerCase().includes('cascade')) {
    fixes.push({
      fixType: 'enable_circuit_breaker', target: 'circuitBreakerEnabled',
      reasoning: 'Circuit breaker off during cascading failure — enabling to contain damage.',
      risk: 'low',
    });
  }

  // Always send a DT event documenting the fix
  fixes.push({
    fixType: 'send_dt_event', target: 'dynatrace',
    reasoning: 'Document the remediation action in Dynatrace.',
    risk: 'low',
    details: { title: `Fix-It Agent: remediating ${title}`, problemId },
  });

  // Default: reset everything
  if (fixes.length <= 1) {
    fixes.unshift({
      fixType: 'reset_feature_flags', target: 'all',
      reasoning: 'No specific pattern — resetting all flags to safe defaults.',
      risk: 'low',
    });
  }

  return {
    problemId,
    summary: title,
    rootCause: `Rule-based: ${title}. Flags: errorRate=${errorRate}, errors=${errorsEnabled}, slow=${slowEnabled}, cache=${cacheEnabled}, cb=${cbEnabled}`,
    confidence: 0.6,
    evidence,
    proposedFixes: fixes,
  };
}

// ─── Verification ────────────────────────────────────────────

async function verifyFix(problemId: string): Promise<boolean> {
  await new Promise(r => setTimeout(r, 5_000));

  // Check DT problem status
  try {
    const problem = await getProblemDetails(problemId);
    if (!problem) return true;
    const status = (problem as unknown as Record<string, unknown>).status as string;
    if (status === 'CLOSED') return true;
  } catch { /* DT unavailable */ }

  // Also verify feature flags are in a healthy state
  const flags = await getCurrentFeatureFlags();
  const remFlags = await getRemediationFlags();
  const errorRate = (flags as any).errors_per_transaction ?? 0.1;

  return errorRate <= 0.1;
}

// ─── Agentic Mode (full LLM tool-use loop) ───────────────────

export async function agenticDiagnose(problemDescription: string): Promise<string> {
  return withAgentSpan('fixit', 'agenticDiagnose', { 'fixit.description': problemDescription }, async () => {
  // ── Fallback when Ollama / LLM is not available ──
  const ollamaUp = await isOllamaAvailable();
  if (!ollamaUp) {
    log.warn('LLM unavailable — running rule-based diagnosis for agentic request');
    const featureFlags = await getCurrentFeatureFlags();
    const remFlags      = await getRemediationFlags();
    const diagnosis = ruleDiagnose(
      'agentic-' + Date.now(),
      { title: problemDescription, severityLevel: 'ERROR' },
      featureFlags as unknown as Record<string, unknown>,
      remFlags     as unknown as Record<string, unknown>,
    );

    // Execute every proposed fix so the result matches what the LLM loop would do
    const executed: string[] = [];
    for (const fix of diagnosis.proposedFixes) {
      try {
        const fixResult = await executeFixTool(fix.fixType, fix.details ?? {});
        executed.push(`✅ ${fix.fixType}: ${fixResult}`);
      } catch (err) {
        executed.push(`⚠️ ${fix.fixType}: ${String(err)}`);
      }
    }

    return [
      `## Rule-Based Diagnosis (AI unavailable)`,
      `**Problem:** ${problemDescription}`,
      `**Root cause:** ${diagnosis.rootCause}`,
      `**Confidence:** ${(diagnosis.confidence * 100).toFixed(0)}%`,
      `### Evidence`, ...diagnosis.evidence.map(e => `- ${e}`),
      `### Actions Taken`, ...executed,
    ].join('\n');
  }

  const allTools: ToolDefinition[] = [
    ...fixToolDefs,
    {
      type: 'function',
      function: {
        name: 'getFeatureFlags',
        description: 'Get current feature flag values (error rates, injection toggles, etc.)',
        parameters: { type: 'object', properties: {} },
      },
    },
  ];

  const systemPrompt = `Fix-It Agent. Check flags with getFeatureFlags, then fix the problem.\nTools: disableErrors, resetFeatureFlags, reduceErrorRate, enableCircuitBreaker, enableCache, disableSlowResponses, sendDtEvent.\nWorkflow: 1) getFeatureFlags 2) identify bad flags 3) call fix tool 4) summarize what you fixed in 2-3 sentences.`;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: problemDescription },
  ];

  const executeTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    if (name === 'getFeatureFlags') {
      const [flags, remFlags] = await Promise.all([getCurrentFeatureFlags(), getRemediationFlags()]);
      return JSON.stringify({ featureFlags: flags, remediationFlags: remFlags });
    }

    // Fix tools only
    return executeFixTool(name, args);
  };

  return agentLoop(messages, allTools, executeTool, 8);
  });
}

export default { autoFix, diagnose, agenticDiagnose };
