/**
 * Serverless proxy function for BizObs Generator API calls.
 * Runs server-side to bypass browser CSP restrictions.
 */

import { edgeConnectClient } from '@dynatrace-sdk/client-app-engine-edge-connect';
import { workflowsClient } from '@dynatrace-sdk/client-automation';
import { settingsObjectsClient } from '@dynatrace-sdk/client-classic-environment-v2';
import { documentsClient, environmentSharesClient } from '@dynatrace-sdk/client-document';
import { queryExecutionClient } from '@dynatrace-sdk/client-query';

interface ProxyPayload {
  action: 'simulate-journey' | 'test-connection' | 'get-services' | 'stop-all-services' | 'stop-company-services' | 'get-dormant-services' | 'clear-dormant-services' | 'clear-company-dormant' | 'chaos-get-active' | 'chaos-get-recipes' | 'chaos-inject' | 'chaos-revert' | 'chaos-revert-all' | 'chaos-get-targeted' | 'chaos-remove-target' | 'chaos-smart' | 'ec-create' | 'ec-update-patterns' | 'detect-builtin-settings' | 'deploy-builtin-settings' | 'deploy-workflow' | 'debug-builtin-schema' | 'generate-dashboard' | 'generate-dashboard-async' | 'get-dashboard-status' | 'deploy-dashboard' | 'deploy-ai-dashboard' | 'deploy-business-flow' | 'generate-pdf';
  apiHost: string;
  apiPort: string;
  apiProtocol: string;
  body?: unknown;
}

export default async function (payload: ProxyPayload) {
  if (!payload || !payload.action) {
    return { success: false, error: 'Missing action in payload' };
  }

  const { action, apiHost, apiPort, apiProtocol, body } = payload;
  const baseUrl = `${apiProtocol}://${apiHost}:${apiPort}`;

  // Retry-aware fetch — handles EdgeConnect reconnection gaps (server disconnects every ~3 min)
  const fetchWithRetry = async (url: string, init?: RequestInit, attempts = 4, delayMs = 2000): Promise<Response> => {
    let lastErr: any;
    for (let i = 1; i <= attempts; i++) {
      try {
        return await fetch(url, { ...init, signal: init?.signal || AbortSignal.timeout(15000) });
      } catch (err: any) {
        lastErr = err;
        const isEC = err.message?.includes('Connection error') || err.message?.includes('EdgeConnect');
        if (!isEC || i === attempts) throw err;
        console.warn(`[proxy-api] fetch retry ${i}/${attempts} for ${url}: ${err.message}`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    throw lastErr;
  };

  try {
    if (action === 'test-connection') {
      // Helper: attempt to reach the server (retries health endpoint before falling back)
      const tryHealth = async (): Promise<{ ok: true; status: number; message: string; callerIp: string | null; healthy: boolean } | { ok: false }> => {
        // Try /api/health up to 3 times (handles EdgeConnect reconnection gaps)
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const healthRes = await fetch(`${baseUrl}/api/health`, {
              method: 'GET',
              signal: AbortSignal.timeout(8000),
            });
            const healthData = await healthRes.json() as Record<string, unknown>;
            const callerIp = (healthData.callerIp as string) || null;
            return { ok: true, healthy: true, status: healthRes.status, message: `Server is running on ${apiHost}:${apiPort} (health: ${healthRes.status})`, callerIp };
          } catch {
            if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
          }
        }
        // All health retries failed — try a simple connectivity check
        try {
          const fallbackRes = await fetch(`${baseUrl}/`, {
            method: 'GET',
            signal: AbortSignal.timeout(8000),
          });
          return { ok: true, healthy: fallbackRes.status >= 200 && fallbackRes.status < 400, status: fallbackRes.status, message: `Server reachable on ${apiHost}:${apiPort} but /api/health failed (status ${fallbackRes.status})`, callerIp: null };
        } catch {
          return { ok: false };
        }
      };

      // First attempt
      const first = await tryHealth();
      if (first.ok) {
        return { success: first.healthy, status: first.status, message: first.message, callerIp: first.callerIp };
      }

      // Connection failed — auto-register host pattern with EdgeConnect and retry
      let ecAutoRegistered = false;
      if (apiHost && apiHost !== 'localhost' && apiHost !== '127.0.0.1') {
        try {
          const listResult = await edgeConnectClient.listEdgeConnects({ addFields: 'metadata' });
          const ecs = listResult.edgeConnects || [];
          if (ecs.length > 0) {
            // Prefer online EdgeConnect, fallback to first
            const targetEc = ecs.find((ec: any) => (ec.metadata?.instances || []).length > 0) || ecs[0];
            const existing: string[] = targetEc.hostPatterns || [];
            if (!existing.includes(apiHost)) {
              await edgeConnectClient.updateEdgeConnect({
                edgeConnectId: targetEc.id!,
                body: { name: targetEc.name!, hostPatterns: [...existing, apiHost] },
              });
              // Wait for routing to propagate
              await new Promise(resolve => setTimeout(resolve, 3000));
              ecAutoRegistered = true;
            }
          }
        } catch (ecErr: any) {
          console.error('[proxy-api] EdgeConnect auto-register failed:', ecErr.message);
        }
      }

      // Retry after EdgeConnect registration
      if (ecAutoRegistered) {
        const retry = await tryHealth();
        if (retry.ok) {
          return {
            success: true,
            status: retry.status,
            message: `${retry.message} (auto-registered EdgeConnect host pattern)`,
            callerIp: retry.callerIp,
            ecAutoRegistered: true,
          };
        }
      }

      // Both attempts failed
      const ecHint = ecAutoRegistered
        ? 'EdgeConnect host pattern was auto-registered but routing may need a moment. Try again in 10-15 seconds.'
        : 'Ensure an EdgeConnect is created and running. The host IP must be registered as a host pattern on the EdgeConnect in Dynatrace.';
      return {
        success: false,
        error: `Cannot reach ${apiHost}:${apiPort}`,
        callerIp: null,
        ecAutoRegistered,
        details: `Could not reach ${baseUrl} through EdgeConnect. ${ecHint}`,
      };
    }

    if (action === 'get-services') {
      const healthRes = await fetchWithRetry(`${baseUrl}/api/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(30000),
      });
      const data = await healthRes.json();
      return { success: true, status: healthRes.status, data };
    }

    if (action === 'stop-all-services') {
      const res = await fetchWithRetry(`${baseUrl}/api/admin/services/stop-everything`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json();
      return { success: true, status: res.status, data };
    }

    if (action === 'stop-company-services') {
      const res = await fetchWithRetry(`${baseUrl}/api/admin/services/stop-by-company`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json();
      return { success: true, status: res.status, data };
    }

    if (action === 'get-dormant-services') {
      const res = await fetchWithRetry(`${baseUrl}/api/admin/services/dormant`, {
        method: 'GET',
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      return { success: true, status: res.status, data };
    }

    if (action === 'clear-dormant-services') {
      const res = await fetchWithRetry(`${baseUrl}/api/admin/services/clear-dormant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      return { success: true, status: res.status, data };
    }

    if (action === 'clear-company-dormant') {
      const res = await fetchWithRetry(`${baseUrl}/api/admin/services/clear-dormant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      return { success: true, status: res.status, data };
    }

    // ── Chaos Agent endpoints ──

    if (action === 'chaos-get-active') {
      const res = await fetchWithRetry(`${baseUrl}/api/gremlin/active`, { method: 'GET', signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      return { success: true, status: res.status, data };
    }

    if (action === 'chaos-get-recipes') {
      const res = await fetchWithRetry(`${baseUrl}/api/gremlin/recipes`, { method: 'GET', signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      return { success: true, status: res.status, data };
    }

    if (action === 'chaos-inject') {
      const res = await fetchWithRetry(`${baseUrl}/api/gremlin/inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json();
      return { success: true, status: res.status, data };
    }

    if (action === 'chaos-revert') {
      const { faultId } = body as { faultId: string };
      const res = await fetchWithRetry(`${baseUrl}/api/gremlin/revert/${encodeURIComponent(faultId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      return { success: true, status: res.status, data };
    }

    if (action === 'chaos-revert-all') {
      const res = await fetchWithRetry(`${baseUrl}/api/gremlin/revert-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json();
      return { success: true, status: res.status, data };
    }

    if (action === 'chaos-get-targeted') {
      const res = await fetchWithRetry(`${baseUrl}/api/feature_flag/services`, { method: 'GET', signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      return { success: true, status: res.status, data };
    }

    if (action === 'chaos-remove-target') {
      const { serviceName } = body as { serviceName: string };
      const res = await fetchWithRetry(`${baseUrl}/api/feature_flag/service/${encodeURIComponent(serviceName)}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      return { success: true, status: res.status, data };
    }

    if (action === 'chaos-smart') {
      const res = await fetchWithRetry(`${baseUrl}/api/gremlin/smart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json();
      return { success: true, status: res.status, data };
    }

    // ── EdgeConnect creation via SDK (server-side, uses platform auth) ──

    if (action === 'ec-create') {
      const { oauthClientId, ecName, hostPatterns } = body as {
        oauthClientId?: string;
        ecName: string;
        hostPatterns: string[];
      };

      try {
        // If no oauthClientId provided, SDK auto-generates an environment-scoped OAuth client
        const createBody: { name: string; hostPatterns: string[]; oauthClientId?: string } = {
          name: ecName,
          hostPatterns,
        };
        if (oauthClientId) {
          createBody.oauthClientId = oauthClientId;
        }
        const result = await edgeConnectClient.createEdgeConnect({
          body: createBody,
        });
        return { success: true, data: result };
      } catch (sdkErr: any) {
        const errBody = sdkErr?.body || sdkErr;
        const detail = errBody?.error?.message || sdkErr?.message || 'Unknown SDK error';
        const missingScopes = errBody?.error?.details?.missingScopes;
        const scopeInfo = missingScopes?.length ? ` | Missing scopes: ${missingScopes.join(', ')}` : '';
        return {
          success: false,
          error: `SDK EdgeConnect create failed: ${detail}${scopeInfo}`,
          debug: { rawError: JSON.stringify(errBody, null, 2) },
        };
      }
    }

    // ── Update EdgeConnect host patterns (auto-register server IP for routing) ──

    if (action === 'ec-update-patterns') {
      const { hostPatterns } = body as { hostPatterns: string[] };
      if (!hostPatterns || hostPatterns.length === 0) {
        return { success: false, error: 'hostPatterns array is required' };
      }
      try {
        // List existing EdgeConnects to find one to update
        const listResult = await edgeConnectClient.listEdgeConnects({ addFields: 'metadata' });
        const ecs = listResult.edgeConnects || [];
        if (ecs.length === 0) {
          return { success: false, error: 'No EdgeConnects found. Create one first.' };
        }
        // Prefer the first online EdgeConnect, or just take the first one
        const onlineEc = ecs.find((ec: any) => (ec.metadata?.instances || []).length > 0) || ecs[0];
        const ecId = onlineEc.id;
        const ecName = onlineEc.name;
        const existingPatterns: string[] = onlineEc.hostPatterns || [];

        // Merge new patterns with existing (deduplicate)
        const merged = [...new Set([...existingPatterns, ...hostPatterns])];

        // Update the EdgeConnect with merged host patterns
        await edgeConnectClient.updateEdgeConnect({
          edgeConnectId: ecId,
          body: { name: ecName, hostPatterns: merged },
        });

        return {
          success: true,
          data: { ecId, ecName, hostPatterns: merged, added: hostPatterns.filter(p => !existingPatterns.includes(p)) },
        };
      } catch (sdkErr: any) {
        const errBody = sdkErr?.body || sdkErr;
        const detail = errBody?.error?.message || sdkErr?.message || 'Unknown SDK error';
        return { success: false, error: `Failed to update EdgeConnect patterns: ${detail}` };
      }
    }

    // ── Detect builtin Dynatrace settings for Get Started checklist ──
    if (action === 'detect-builtin-settings') {
      const detected: Record<string, boolean> = {};
      const hostIp = (body as any)?.hostIp as string | undefined;

      // 1. BizEvents HTTP incoming capture rule named "Business Observability Forge"
      try {
        const result = await settingsObjectsClient.getSettingsObjects({
          schemaIds: 'builtin:bizevents.http.incoming',
          fields: 'objectId,value',
          pageSize: 50,
        });
        detected['biz-events'] = (result.items || []).some(
          (i: any) => i.value?.ruleName === 'Business Observability Forge' || i.value?.ruleName === 'Business Observability Generator' || i.value?.ruleName === 'BizObs App'
        );
      } catch { detected['biz-events'] = false; }

      // 2. OpenPipeline bizevents pipeline named "Business Observability Forge"
      try {
        const result = await settingsObjectsClient.getSettingsObjects({
          schemaIds: 'builtin:openpipeline.bizevents.pipelines',
          fields: 'objectId,value',
          pageSize: 50,
        });
        detected['openpipeline'] = (result.items || []).some(
          (i: any) => i.value?.displayName === 'Business Observability Forge' || i.value?.displayName === 'Business Observability Generator' || i.value?.displayName === 'BizObs Template Pipeline'
        );
      } catch { detected['openpipeline'] = false; }

      // 3. OpenPipeline bizevents routing — check for "Business Observability Forge" entry
      try {
        const result = await settingsObjectsClient.getSettingsObjects({
          schemaIds: 'builtin:openpipeline.bizevents.routing',
          fields: 'objectId,value',
          pageSize: 10,
        });
        let hasRoute = false;
        for (const item of result.items || []) {
          const val = item.value as { routingEntries?: Array<{ description?: string }> };
          if (val.routingEntries?.some(e => e.description === 'Business Observability Forge' || e.description === 'Business Observability Generator' || e.description === 'BizObs App')) {
            hasRoute = true;
            break;
          }
        }
        detected['openpipeline-routing'] = hasRoute;
      } catch { detected['openpipeline-routing'] = false; }

      // 4. OneAgent feature flag SENSOR_NODEJS_BIZEVENTS_HTTP_INCOMING enabled
      try {
        const result = await settingsObjectsClient.getSettingsObjects({
          schemaIds: 'builtin:oneagent.features',
          fields: 'objectId,value',
          filter: "value.key = 'SENSOR_NODEJS_BIZEVENTS_HTTP_INCOMING'",
          pageSize: 1,
        });
        // Must exist AND have both enabled + instrumentation true
        const flagValue = result.items?.[0]?.value as Record<string, unknown> | undefined;
        detected['feature-flags'] = result.totalCount > 0 && flagValue?.enabled === true && flagValue?.instrumentation === true;
      } catch { detected['feature-flags'] = false; }

      // 5. OneAgent installed on host — DQL query using matchesPhrase for the configured IP
      if (hostIp) {
        try {
          const dqlQuery = `fetch dt.entity.host
| fields ipAddress
| filter matchesPhrase(ipAddress,"${hostIp}")
| filter isNotNull(ipAddress)
| summarize OneAgentDeployed = count()`;
          console.log(`[detect] OneAgent DQL: ${dqlQuery}`);
          const queryResult = await queryExecutionClient.queryExecute({
            body: {
              query: dqlQuery,
              requestTimeoutMilliseconds: 15000,
              maxResultRecords: 1,
            },
          });
          const records = queryResult?.result?.records || [];
          const count = Number(records[0]?.OneAgentDeployed ?? 0);
          console.log(`[detect] OneAgent count for ${hostIp}: ${count}`);
          detected['oneagent'] = count > 0;
        } catch (e: any) { console.log(`[detect] OneAgent DQL error: ${e.message}`); detected['oneagent'] = false; }
      } else {
        console.log('[detect] No hostIp provided, skipping OneAgent check');
        detected['oneagent'] = false;
      }

      // 6. EdgeConnect deployed and online — check via EdgeConnect SDK
      try {
        const ecList = await edgeConnectClient.listEdgeConnects({ addFields: 'metadata' });
        const ecItems = ecList.edgeConnects || [];
        detected['edgeconnect-create'] = ecItems.length > 0;
        const anyWithInstances = ecItems.some(
          (ec: any) => (ec.metadata?.instances || []).length > 0
        );
        detected['edgeconnect-deploy'] = anyWithInstances;
        detected['edgeconnect-online'] = anyWithInstances;
      } catch {
        detected['edgeconnect-create'] = false;
        detected['edgeconnect-deploy'] = false;
        detected['edgeconnect-online'] = false;
      }

      // 7. EdgeConnect connectivity + test-connection — ping the configured host from serverless
      //    If the fetch succeeds, EdgeConnect routing works AND connection is verified.
      if (apiHost && apiPort) {
        try {
          const proto = apiProtocol || 'http';
          const pingUrl = `${proto}://${apiHost}:${apiPort}/api/health`;
          console.log(`[detect] Pinging ${pingUrl}...`);
          const pingRes = await fetchWithRetry(pingUrl, {
            method: 'GET',
            signal: AbortSignal.timeout(6000),
          });
          const reachable = pingRes.ok || pingRes.status > 0;
          console.log(`[detect] Ping result: status=${pingRes.status}, reachable=${reachable}`);
          detected['outbound-connections'] = reachable;
          detected['test-connection'] = reachable;
        } catch (e: any) {
          console.log(`[detect] Ping failed: ${e.message}`);
          detected['outbound-connections'] = false;
          detected['test-connection'] = false;
        }
      } else {
        console.log(`[detect] No apiHost/apiPort — skipping ping`);
        detected['outbound-connections'] = false;
        detected['test-connection'] = false;
      }

      // 8. Automation Workflow — search for "BizObs Fix-It Agent" workflow
      try {
        const wfList = await workflowsClient.getWorkflows({
          search: 'BizObs Fix-It Agent',
        });
        detected['automation-workflow'] = (wfList.results || []).some(
          (wf: any) => wf.title?.includes('BizObs Fix-It Agent')
        );
      } catch (e: any) {
        console.log(`[detect] Workflow detection error: ${e.message}`);
        detected['automation-workflow'] = false;
      }

      return { success: true, data: detected };
    }

    // ── Deploy builtin Dynatrace settings for BizObs ──
    if (action === 'debug-builtin-schema') {
      const debugResults: Record<string, unknown> = {};
      
      // 1. Fetch existing pipelines from BOTH schema variants
      for (const schemaId of ['builtin:openpipeline.bizevents.pipelines', 'builtin:openpipeline.events.pipelines']) {
        const key = schemaId.includes('bizevents') ? 'pipelines-bizevents' : 'pipelines-events';
        try {
          const result = await settingsObjectsClient.getSettingsObjects({
            schemaIds: schemaId,
            pageSize: 10,
          });
          debugResults[key] = { totalCount: result.totalCount, items: result.items?.map(i => ({ objectId: i.objectId, schemaVersion: i.schemaVersion, value: i.value })) };
        } catch (err: any) {
          debugResults[key] = { error: err?.message, body: err?.body };
        }
      }

      // 2. Fetch existing routing from BOTH variants
      for (const schemaId of ['builtin:openpipeline.bizevents.routing', 'builtin:openpipeline.events.routing']) {
        const key = schemaId.includes('bizevents') ? 'routing-bizevents' : 'routing-events';
        try {
          const result = await settingsObjectsClient.getSettingsObjects({
            schemaIds: schemaId,
            pageSize: 10,
          });
          debugResults[key] = { totalCount: result.totalCount, items: result.items?.map(i => ({ objectId: i.objectId, schemaVersion: i.schemaVersion, value: i.value })) };
        } catch (err: any) {
          debugResults[key] = { error: err?.message, body: err?.body };
        }
      }

      // 3. Validate-only POST with our pipeline schema against BOTH variants
      const pipelineValue = {
        displayName: 'BizObs Debug Test Pipeline',
        enabled: true,
        processors: [
          {
            id: 'debug-test-processor',
            displayName: 'Debug Test',
            enabled: true,
            type: 'dql',
            matcher: 'true',
            dqlScript: 'fieldsAdd test = "debug"',
          },
        ],
      };
      // Also try with id field
      const pipelineValueWithId = { id: 'debug-test-pipeline', ...pipelineValue };

      for (const schemaId of ['builtin:openpipeline.bizevents.pipelines', 'builtin:openpipeline.events.pipelines']) {
        const variant = schemaId.includes('bizevents') ? 'bizevents' : 'events';
        
        // Without id
        try {
          await settingsObjectsClient.postSettingsObjects({
            validateOnly: true,
            body: [{ schemaId, scope: 'environment', value: pipelineValue }],
          });
          debugResults[`validate-${variant}-no-id`] = { valid: true };
        } catch (err: any) {
          debugResults[`validate-${variant}-no-id`] = { valid: false, error: err?.message, body: err?.body ? JSON.stringify(err.body) : undefined };
        }

        // With id
        try {
          await settingsObjectsClient.postSettingsObjects({
            validateOnly: true,
            body: [{ schemaId, scope: 'environment', value: pipelineValueWithId }],
          });
          debugResults[`validate-${variant}-with-id`] = { valid: true };
        } catch (err: any) {
          debugResults[`validate-${variant}-with-id`] = { valid: false, error: err?.message, body: err?.body ? JSON.stringify(err.body) : undefined };
        }
      }

      // 4. Fetch capture rules
      try {
        const result = await settingsObjectsClient.getSettingsObjects({
          schemaIds: 'builtin:bizevents.http.incoming',
          pageSize: 10,
        });
        debugResults['captureRules'] = { totalCount: result.totalCount, items: result.items?.map(i => ({ objectId: i.objectId, schemaVersion: i.schemaVersion, value: i.value })) };
      } catch (err: any) {
        debugResults['captureRules'] = { error: err?.message, body: err?.body };
      }

      // 5. OpenPipeline Configuration API URL probe — test several candidates
      const opUrlCandidates = [
        '/platform/classic/environment-api/v2/openpipeline/configurations/bizevents',
        '/platform/classic/environment-api/v2/openpipeline/configurations/events',
        '/platform/classic/environment-api/v2/openpipeline/bizevents',
        '/api/v2/openpipeline/configurations/bizevents',
        '/api/v2/openpipeline/configurations/events',
        '/platform/openpipeline/v1/configurations/bizevents',
        '/platform/openpipeline/v1/configurations/events',
        '/platform/classic/environment-api/v2/openpipeline',
      ];
      const probeResults: Record<string, unknown> = {};
      for (const url of opUrlCandidates) {
        try {
          const res = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
          const text = await res.text();
          const preview = text.substring(0, 300);
          probeResults[url] = { status: res.status, preview };
        } catch (e: any) {
          probeResults[url] = { error: e.message };
        }
      }
      debugResults['openpipeline-url-probe'] = probeResults;

      return { success: true, data: debugResults };
    }

    if (action === 'deploy-builtin-settings') {
      const { configs } = body as { configs: string[] };
      if (!configs || !Array.isArray(configs) || configs.length === 0) {
        return { success: false, error: 'No configs specified to deploy' };
      }

      const results: Record<string, { success: boolean; error?: string }> = {};

      for (const configKey of configs) {
        try {
          if (configKey === 'biz-events') {
            // Check if capture rule already exists — skip if found
            const existing = await settingsObjectsClient.getSettingsObjects({
              schemaIds: 'builtin:bizevents.http.incoming',
              fields: 'objectId,value',
              pageSize: 50,
            });
            const captureExists = (existing.items || []).some(
              (i: any) => i.value?.ruleName === 'Business Observability Forge' || i.value?.ruleName === 'Business Observability Generator' || i.value?.ruleName === 'BizObs App'
            );

            if (captureExists) {
              results['biz-events'] = { success: true, error: 'Already exists — no changes needed' };
            } else {
              // Create from scratch matching the exact working tenant config
              await settingsObjectsClient.postSettingsObjects({
                body: [{
                  schemaId: 'builtin:bizevents.http.incoming',
                  scope: 'environment',
                  value: {
                    enabled: true,
                    ruleName: 'Business Observability Forge',
                    triggers: [{
                      caseSensitive: false,
                      source: { dataSource: 'request.path' },
                      type: 'STARTS_WITH',
                      value: '/process',
                    }],
                    event: {
                      category: { sourceType: 'constant.string', source: 'Business Observability Forge' },
                      provider: { sourceType: 'request.body', path: 'companyName' },
                      type: { sourceType: 'request.body', path: 'stepName' },
                      data: [
                        { name: 'HasError', source: { sourceType: 'request.body', path: 'json.hasError' } },
                        { name: 'rsBody', source: { sourceType: 'response.body', path: '*' } },
                        { name: 'rqBody', source: { sourceType: 'request.body', path: '*' } },
                      ],
                    },
                  },
                }],
              });
              results['biz-events'] = { success: true };
            }

          } else if (configKey === 'openpipeline') {
            // Create FULL pipeline via Settings API (bizevents.pipelines)
            // Includes processors, costAllocation, and all section arrays — matching exact tenant config

            // Check if already exists — search both top-level value and nested pipelines arrays
            const existingPipeline = await settingsObjectsClient.getSettingsObjects({
              schemaIds: 'builtin:openpipeline.bizevents.pipelines',
              pageSize: 50,
            });
            const matchNames = ['bizobs-template-pipeline'];
            const matchDisplayNames = ['Business Observability Forge', 'Business Observability Generator', 'BizObs Template Pipeline'];
            const matchingPipeline = (existingPipeline.items || []).find((i: any) => {
              const v = i.value;
              if (!v) return false;
              // Direct match on the settings object value
              if (matchNames.includes(v.customId) || matchDisplayNames.includes(v.displayName)) return true;
              // Some schemas nest pipelines in an array inside the value
              const nested = v.pipelines || v.items || [];
              return nested.some((p: any) => matchNames.includes(p.customId) || matchDisplayNames.includes(p.displayName));
            });

            if (matchingPipeline) {
              results['openpipeline'] = { success: true, error: 'Already exists — no changes needed' };
            } else {
              // Create the full pipeline with processors, costAllocation, and all sections
              try {
              const pipelineResponse = await settingsObjectsClient.postSettingsObjects({
                body: [{
                  schemaId: 'builtin:openpipeline.bizevents.pipelines',
                  scope: 'environment',
                  value: {
                    metadataList: [],
                    customId: 'bizobs-template-pipeline',
                    displayName: 'Business Observability Forge',
                    processing: {
                      processors: [
                        {
                          id: 'processor_JSON_Parser_' + Math.floor(Math.random() * 10000),
                          type: 'dql',
                          matcher: 'true',
                          description: 'JSON Parser',
                          enabled: true,
                          dql: {
                            script: 'parse rqBody, "JSON:json"\n| fieldsFlatten json\n| parse json.additionalFields, "JSON:additionalFields"\n| fieldsFlatten json.additionalFields, prefix:"additionalfields."',
                          },
                        },
                        {
                          id: 'processor_Error_Field_' + Math.floor(Math.random() * 10000),
                          type: 'dql',
                          matcher: 'true',
                          description: 'Error Field',
                          enabled: true,
                          dql: {
                            script: 'fieldsAdd  event.type = if(json.hasError == true, concat(event.type, ``, " - Exception"), else:{`event.type`})',
                          },
                        },
                      ],
                    },
                    securityContext: { processors: [] },
                    costAllocation: {
                      processors: [
                        {
                          id: 'processor_Business_Observability_Forge_' + Math.floor(Math.random() * 10000),
                          type: 'costAllocation',
                          matcher: 'matchesvalue(event.category, "Business Observability Forge")',
                          description: 'Business Observability Forge',
                          enabled: true,
                          costAllocation: {
                            value: {
                              type: 'constant',
                              constant: 'BusinessObservabilityForgeApp',
                            },
                          },
                        },
                      ],
                    },
                    productAllocation: { processors: [] },
                    storage: { processors: [] },
                    smartscapeNodeExtraction: { processors: [] },
                    smartscapeEdgeExtraction: { processors: [] },
                    metricExtraction: { processors: [] },
                    davis: { processors: [] },
                    dataExtraction: { processors: [] },
                  },
                }],
              });

              const newPipelineObjectId = pipelineResponse?.[0]?.objectId;
              console.log(`[deploy] Pipeline created with objectId: ${newPipelineObjectId}`);
              results['openpipeline'] = { success: true };

              // If routing is also requested, chain it now with the correct pipelineId
              if (configs.includes('openpipeline-routing') && newPipelineObjectId) {
                try {
                  // Fetch existing routing object (there's always at least a default one)
                  const existingRouting = await settingsObjectsClient.getSettingsObjects({
                    schemaIds: 'builtin:openpipeline.bizevents.routing',
                    fields: 'objectId,value',
                    pageSize: 10,
                  });

                  if (existingRouting.items && existingRouting.items.length > 0) {
                    // The routing schema has ONE settings object with a routingEntries[] array
                    const routingItem = existingRouting.items[0];
                    const routingValue = JSON.parse(JSON.stringify(routingItem.value)) as {
                      routingEntries?: Array<Record<string, unknown>>;
                    };

                    // Check if entry already exists
                    const alreadyHasEntry = (routingValue.routingEntries || []).some(
                      (e) => e.description === 'Business Observability Forge' || e.description === 'Business Observability Generator' || e.description === 'BizObs App' || e.pipelineId === newPipelineObjectId
                    );

                    if (alreadyHasEntry) {
                      results['openpipeline-routing'] = { success: true, error: 'Already exists — no changes needed' };
                    } else {
                      // Add new routing entry matching exact working tenant config
                      routingValue.routingEntries = routingValue.routingEntries || [];
                      routingValue.routingEntries.push({
                        enabled: true,
                        pipelineType: 'custom',
                        pipelineId: newPipelineObjectId,
                        matcher: 'matchesvalue(event.category, "Business Observability Forge")',
                        description: 'Business Observability Forge',
                      });

                      console.log(`[deploy] Routing: adding entry with pipelineId=${newPipelineObjectId}, total entries=${routingValue.routingEntries.length}`);

                      await settingsObjectsClient.postSettingsObjects({
                        body: [{
                          schemaId: 'builtin:openpipeline.bizevents.routing',
                          scope: 'environment',
                          value: routingValue,
                        }],
                      });
                      results['openpipeline-routing'] = { success: true };
                    }
                  } else {
                    // No existing routing object — create one from scratch
                    await settingsObjectsClient.postSettingsObjects({
                      body: [{
                        schemaId: 'builtin:openpipeline.bizevents.routing',
                        scope: 'environment',
                        value: {
                          routingEntries: [{
                            enabled: true,
                            pipelineType: 'custom',
                            pipelineId: newPipelineObjectId,
                            matcher: 'matchesvalue(event.category, "Business Observability Forge")',
                            description: 'Business Observability Forge',
                          }],
                        },
                      }],
                    });
                    results['openpipeline-routing'] = { success: true };
                  }
                } catch (routeErr: any) {
                  const detail = routeErr?.body?.error?.constraintViolations
                    ? JSON.stringify(routeErr.body.error.constraintViolations)
                    : routeErr?.body?.error?.message || routeErr?.message || 'Unknown error';
                  results['openpipeline-routing'] = { success: false, error: detail };
                }
              }
              } catch (pipelineErr: any) {
                // Handle duplicate customId error gracefully — pipeline already exists
                const errMsg = JSON.stringify(pipelineErr?.body || pipelineErr?.message || pipelineErr);
                if (errMsg.includes('identical customId') || errMsg.includes('customId')) {
                  console.log('[deploy] Pipeline already exists (caught duplicate customId error)');
                  results['openpipeline'] = { success: true, error: 'Already exists — no changes needed (duplicate customId)' };
                } else {
                  throw pipelineErr;
                }
              }
            }

          } else if (configKey === 'openpipeline-routing') {
            // Skip if already handled by the openpipeline block above
            if (results['openpipeline-routing']) continue;

            // Routing requested alone — find the Business Observability Generator pipeline objectId
            const pipelineCheck = await settingsObjectsClient.getSettingsObjects({
              schemaIds: 'builtin:openpipeline.bizevents.pipelines',
              fields: 'objectId,value',
              pageSize: 50,
            });
            const bizobsPipeline = (pipelineCheck.items || []).find(
              (i: any) => i.value?.customId === 'bizobs-template-pipeline' || i.value?.displayName === 'Business Observability Forge' || i.value?.displayName === 'Business Observability Generator' || i.value?.displayName === 'BizObs Template Pipeline'
            );

            if (!bizobsPipeline) {
              results['openpipeline-routing'] = { success: false, error: 'Pipeline "Business Observability Forge" must be created first — deploy the Pipeline step before Routing' };
            } else {
              const pipelineObjectId = bizobsPipeline.objectId;

              // Fetch existing routing object
              const existingRouting = await settingsObjectsClient.getSettingsObjects({
                schemaIds: 'builtin:openpipeline.bizevents.routing',
                fields: 'objectId,value',
                pageSize: 10,
              });

              if (existingRouting.items && existingRouting.items.length > 0) {
                const routingItem = existingRouting.items[0];
                const routingValue = JSON.parse(JSON.stringify(routingItem.value)) as {
                  routingEntries?: Array<Record<string, unknown>>;
                };

                // Check if entry already exists
                const alreadyHasEntry = (routingValue.routingEntries || []).some(
                  (e) => e.description === 'Business Observability Forge' || e.description === 'Business Observability Generator' || e.description === 'BizObs App' || e.pipelineId === pipelineObjectId
                );

                if (alreadyHasEntry) {
                  results['openpipeline-routing'] = { success: true, error: 'Already exists — no changes needed' };
                } else {
                  routingValue.routingEntries = routingValue.routingEntries || [];
                  routingValue.routingEntries.push({
                    enabled: true,
                    pipelineType: 'custom',
                    pipelineId: pipelineObjectId,
                    matcher: 'matchesvalue(event.category, "Business Observability Forge")',
                    description: 'Business Observability Forge',
                  });

                  console.log(`[deploy] Routing standalone: adding entry with pipelineId=${pipelineObjectId}`);

                  await settingsObjectsClient.postSettingsObjects({
                    body: [{
                      schemaId: 'builtin:openpipeline.bizevents.routing',
                      scope: 'environment',
                      value: routingValue,
                    }],
                  });
                  results['openpipeline-routing'] = { success: true };
                }
              } else {
                // No existing routing object — create from scratch
                await settingsObjectsClient.postSettingsObjects({
                  body: [{
                    schemaId: 'builtin:openpipeline.bizevents.routing',
                    scope: 'environment',
                    value: {
                      routingEntries: [{
                        enabled: true,
                        pipelineType: 'custom',
                        pipelineId: pipelineObjectId,
                        matcher: 'matchesvalue(event.category, "Business Observability Forge")',
                        description: 'Business Observability Forge',
                      }],
                    },
                  }],
                });
                results['openpipeline-routing'] = { success: true };
              }
            }

          } else if (configKey === 'feature-flags') {
            // OneAgent feature keys are predefined enums — cannot create custom keys.
            // Check if SENSOR_NODEJS_BIZEVENTS_HTTP_INCOMING already exists; if so, update it.
            const existing = await settingsObjectsClient.getSettingsObjects({
              schemaIds: 'builtin:oneagent.features',
              fields: 'objectId,value',
              filter: "value.key = 'SENSOR_NODEJS_BIZEVENTS_HTTP_INCOMING'",
              pageSize: 1,
            });

            if (existing.totalCount > 0 && existing.items?.[0]) {
              // Already exists — ensure it's enabled
              const currentValue = existing.items[0].value as Record<string, unknown>;
              if (currentValue.enabled === true) {
                results['feature-flags'] = { success: true, error: 'Already configured and enabled — no changes needed' };
              } else {
                // UPDATE existing object via PUT (can't POST a duplicate feature key)
                const updatedValue = JSON.parse(JSON.stringify(currentValue));
                updatedValue.enabled = true;
                updatedValue.instrumentation = true;
                await settingsObjectsClient.putSettingsObjectByObjectId({
                  objectId: existing.items[0].objectId,
                  body: {
                    value: updatedValue,
                  },
                });
                results['feature-flags'] = { success: true };
              }
            } else {
              // Create from scratch with the real key
              await settingsObjectsClient.postSettingsObjects({
                body: [{
                  schemaId: 'builtin:oneagent.features',
                  scope: 'environment',
                  value: {
                    enabled: true,
                    key: 'SENSOR_NODEJS_BIZEVENTS_HTTP_INCOMING',
                    instrumentation: true,
                  },
                }],
              });
              results['feature-flags'] = { success: true };
            }
          } else if (configKey === 'automation-workflow') {
            // Workflow requires automation:workflows:write scope which is restricted
            // to Dynatrace-provided apps. Return the template for manual import.
            results['automation-workflow'] = {
              success: false,
              error: 'Workflow must be imported manually — use the Import button in Get Started',
            };
          } else {
            results[configKey] = { success: false, error: `Unknown config key: ${configKey}. OpenPipeline configs must be configured manually.` };
          }
        } catch (err: any) {
          const violations = err?.body?.error?.constraintViolations;
          const errorMsg = err?.body?.error?.message;
          const fullBody = err?.body ? JSON.stringify(err.body, null, 2) : undefined;
          const detail = violations
            ? JSON.stringify(violations)
            : errorMsg || err?.message || 'Unknown error';
          results[configKey] = { success: false, error: `${detail}${fullBody ? ' | Full: ' + fullBody : ''}` };
        }
      }

      return { success: true, data: results };
    }

    // ── Get Automation Workflow Template (BizObs Fix-It Agent) ──
    // Returns the workflow JSON template with the current server URL injected.
    // The user imports this into Dynatrace Workflows manually (write scope is restricted).
    if (action === 'deploy-workflow') {
      const workflowTemplate = {
        title: 'BizObs Fix-It Agent \u2014 Autonomous Remediation',
        description: 'Davis problem \u2192 gather DQL context \u2192 query Davis root cause \u2192 call Fix-It Agent \u2192 verify remediation \u2192 send BizEvent summary',
        isPrivate: false,
        schemaVersion: 3,
        type: 'STANDARD',
        trigger: {
          eventTrigger: {
            isActive: true,
            filterQuery: 'event.kind == "DAVIS_PROBLEM" AND event.status == "ACTIVE" AND (event.status_transition == "CREATED" OR event.status_transition == "UPDATED" OR event.status_transition == "REOPENED") AND (event.category == "AVAILABILITY" OR event.category == "ERROR" OR event.category == "SLOWDOWN" OR event.category == "RESOURCE_CONTENTION" OR event.category == "CUSTOM_ALERT")',
            uniqueExpression: '{{ event()["event.id"] }}-{{ "open" if event()["event.status"] == "ACTIVE" else "resolved" }}-{{ event()["dt.davis.last_reopen_timestamp"] }}',
            triggerConfiguration: {
              type: 'davis-problem',
              value: {
                categories: { error: true, custom: true, resource: true, slowdown: true, availability: true },
                entityTags: {},
                customFilter: '',
                analysisReady: false,
                onProblemClose: false,
                entityTagsMatch: null,
              },
            },
          },
        },
        tasks: {
          invoke_dynatrace_intelligence: {
            name: 'invoke_dynatrace_intelligence',
            action: 'dynatrace.davis.copilot.workflow.actions:davis-copilot',
            input: {
              config: 'dynatrace',
              prompt: 'Analyze this Davis problem and provide: (1) what happened, (2) root cause analysis, (3) business impact, (4) remediation steps.\n\nProblem: {{ event()["display_id"] }} \u2014 {{ event()["event.name"] }}\nCategory: {{ event()["event.category"] }}\nStatus: {{ event()["event.status"] }}\nAffected Service: {{ event()["dt.entity.service"] }}\nRelated Process Group: {{ event()["dt.entity.process_group"] }}\nImpact Level: {{ event()["dt.davis.impact_level"] }}\n\nDescription:\n{{ event()["event.description"] }}',
              autoTrim: true,
              instruction: 'Be specific about the affected service name and entity ID. Include the problem ID in your response. Focus on actionable remediation steps.',
              supplementary: `Entity tags: {{ event()["entity_tags"] }}\nAffected entity IDs: {{ event()["affected_entity_ids"] }}\nEvent start: {{ event()["event.start"] }}\nDavis event IDs: {{ event()["dt.davis.event_ids"] }}\nThis is a BizObs journey service running on an EC2 instance. The service is part of an insurance purchase journey. If the failure rate is elevated, the remediation is to disable the error injection feature flag via the API endpoint POST /api/feature_flag with errors_per_transaction set to 0.`,
            },
            position: { x: 0, y: 1 },
            description: 'Prompt the Dynatrace Intelligence generative AI',
            predecessors: [],
          },
          call_ai_fixit_agent: {
            name: 'call_ai_fixit_agent',
            action: 'dynatrace.automations:http-function',
            input: {
              url: `${baseUrl}/api/feature_flag`,
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              payload: '{\n  "targetService": "{% set tags = event()[\'entity_tags\'] %}{% for tag in tags %}{% if \'DT_APPLICATION_NAME:\' in tag %}{{ tag | replace(\'[Environment]DT_APPLICATION_NAME:\', \'\') }}{% endif %}{% endfor %}",\n  "flags": {\n    "errors_per_transaction": 0,\n    "errors_per_visit": 0,\n    "errors_per_minute": 0\n  }\n}',
              failOnResponseCodes: '400-599',
            },
            position: { x: 0, y: 2 },
            conditions: { states: { invoke_dynatrace_intelligence: 'OK' } },
            description: 'Issue an HTTP request to any API.',
            predecessors: ['invoke_dynatrace_intelligence'],
          },
        },
        input: {},
        hourlyExecutionLimit: 1000,
      };

      return {
        success: true,
        data: { workflowTemplate },
      };
    }

    // ── Async Dashboard generation (jobs/polling model) ──
    if (action === 'generate-dashboard-async') {
      try {
        const res = await fetchWithRetry(`${baseUrl}/api/ai-dashboard/generate-async`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20000), // Allow extra time for routing/edge latency
        });
        const data = await res.json();
        return { success: res.ok, ...data };
      } catch (error: any) {
        console.error('[proxy-api] Async dashboard start error:', error.message);
        return { success: false, error: error.message };
      }
    }

    // Get dashboard job status (polling)
    if (action === 'get-dashboard-status') {
      try {
        const { jobId } = body as { jobId: string };
        if (!jobId) {
          return { success: false, error: 'jobId required' };
        }
        const res = await fetchWithRetry(`${baseUrl}/api/ai-dashboard/status/${jobId}`, {
          method: 'GET',
          signal: AbortSignal.timeout(15000), // Slightly longer to accommodate network/edge delays
        });
        const data = await res.json();
        return { success: res.ok, ...data };
      } catch (error: any) {
        console.error('[proxy-api] Dashboard status check error:', error.message);
        return { success: false, error: error.message };
      }
    }

    // ── AI Dashboard generation (calls server's ai-dashboard route) ──
    if (action === 'generate-dashboard') {
      try {
        const res = await fetchWithRetry(`${baseUrl}/api/ai-dashboard/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30000), // Template generation: fast, but allow ample time
        });
        const data = await res.json();
        // Optimize large response: strip unnecessary fields to reduce size
        if (data.dashboard && data.dashboard.content) {
          // Keep only essential dashboard properties
          const optimized = {
            name: data.dashboard.name,
            type: data.dashboard.type,
            version: data.dashboard.version,
            content: data.dashboard.content,
            metadata: data.dashboard.metadata
          };
          // Check size and optionally compress
          const jsonStr = JSON.stringify(optimized);
          const sizeKb = jsonStr.length / 1024;
          
          // If response is large enough, indicate compression for client-side handling
          return { 
            success: res.ok, 
            status: res.status, 
            data: { 
              dashboard: optimized,
              _meta: { sizeMb: (sizeKb / 1024).toFixed(3), compressed: false }
            } 
          };
        }
        // Fallback: return minimal response structure
        return { success: res.ok, status: res.status, data };
      } catch (error: any) {
        console.error('[proxy-api] Dashboard generation timeout/error:', error.message);
        return { success: false, status: 0, error: error.message };
      }
    }


    if (action === 'deploy-ai-dashboard') {
      // Deploy the built-in AI Observability dashboard using the Document API
      const DASHBOARD_ID = 'bizobs-ai-observability-dashboard';
      const DASHBOARD_NAME = '[AI Obs] Ollama — BizObs Forge';

      try {
        // Check if dashboard already exists
        try {
          const existing = await documentsClient.getDocument({ id: DASHBOARD_ID });
          // Dashboard exists — update it with latest version
          const dashboardContent = (body as any)?.dashboardContent;
          if (dashboardContent) {
            await documentsClient.updateDocument({
              id: DASHBOARD_ID,
              optimisticLockingVersion: existing.metadata!.version,
              body: {
                content: new Blob([JSON.stringify(dashboardContent)], { type: 'application/json' }),
              },
            });
            return {
              success: true,
              data: {
                dashboardId: DASHBOARD_ID,
                dashboardUrl: `/ui/apps/dynatrace.dashboards/dashboard/${DASHBOARD_ID}`,
                message: 'AI Observability dashboard updated to latest version',
                alreadyExisted: true,
              },
            };
          }
          return {
            success: true,
            data: {
              dashboardId: DASHBOARD_ID,
              dashboardUrl: `/ui/apps/dynatrace.dashboards/dashboard/${DASHBOARD_ID}`,
              message: 'AI Observability dashboard already exists',
              alreadyExisted: true,
            },
          };
        } catch (e: any) {
          // 404 means doesn't exist — proceed to create
          if (e?.body?.error?.code !== 404 && e?.statusCode !== 404) {
            throw e;
          }
        }

        // Dashboard doesn't exist — create it
        const dashboardContent = (body as any)?.dashboardContent;
        if (!dashboardContent) {
          return { success: false, error: 'Missing dashboardContent in request body' };
        }

        const result = await documentsClient.createDocument({
          body: {
            id: DASHBOARD_ID,
            name: DASHBOARD_NAME,
            type: 'dashboard',
            content: new Blob([JSON.stringify(dashboardContent)], { type: 'application/json' }),
          },
        });

        // Share with entire environment
        try {
          await environmentSharesClient.createEnvironmentShare({
            body: { documentId: result.id!, access: 'read' },
          });
        } catch (shareErr: any) {
          console.warn('[proxy-api] Dashboard created but sharing failed:', shareErr.message);
        }

        return {
          success: true,
          data: {
            dashboardId: result.id,
            dashboardUrl: `/ui/apps/dynatrace.dashboards/dashboard/${result.id}`,
            message: 'AI Observability dashboard deployed and shared with environment',
          },
        };
      } catch (error: any) {
        console.error('[proxy-api] AI Dashboard deploy error:', error.message, error.body || '');
        return { success: false, error: error.message || 'Failed to deploy AI Observability dashboard' };
      }
    }

    if (action === 'deploy-business-flow') {
      try {
        // 1. Generate the Business Flow JSON from the Node backend (no DT credentials needed)
        const genRes = await fetchWithRetry(`${baseUrl}/api/business-flow/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10000),
        });
        const genData = await genRes.json() as any;
        if (!genRes.ok || !genData.ok || !genData.businessFlow) {
          return { success: false, error: genData.error || 'Failed to generate Business Flow' };
        }
        const flow = genData.businessFlow;

        // 2. Deploy to Dynatrace using AppEngine SDK (uses AppEngine OAuth — no API token needed)
        await settingsObjectsClient.postSettingsObjects({
          body: [{
            schemaId: 'app:dynatrace.biz.flow:biz-flow-settings',
            scope: 'environment',
            value: flow,
          }],
        });

        return {
          success: true,
          data: {
            ok: true,
            name: flow.name,
            steps: flow.steps.length,
            message: `Business Flow "${flow.name}" deployed successfully.`
          }
        };
      } catch (error: any) {
        console.error('[proxy-api] Business Flow deploy error:', error.message);
        return { success: false, status: 0, error: error.message };
      }
    }

    // ── Executive Summary PDF generation ──
    if (action === 'generate-pdf') {
      try {
        const res = await fetchWithRetry(`${baseUrl}/api/pdf/executive-summary`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) {
          const errText = await res.text();
          return { success: false, error: `PDF generation failed (${res.status}): ${errText}` };
        }
        // Convert binary PDF to base64 so it can travel through the JSON proxy
        const arrayBuffer = await res.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
        const contentDisposition = res.headers.get('content-disposition') || '';
        const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/);
        const filename = filenameMatch ? filenameMatch[1] : 'BizObs-Summary.pdf';
        return { success: true, data: { base64, filename, sizeKb: Math.round(arrayBuffer.byteLength / 1024) } };
      } catch (error: any) {
        console.error('[proxy-api] PDF generation error:', error.message);
        return { success: false, error: error.message };
      }
    }

    if (action === 'simulate-journey') {
      const apiUrl = `${baseUrl}/api/journey-simulation/simulate-journey`;
      const response = await fetchWithRetry(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });

      const responseText = await response.text();
      let data: unknown;
      try {
        data = JSON.parse(responseText);
      } catch {
        data = responseText;
      }

      if (!response.ok) {
        return {
          success: false,
          status: response.status,
          error: `API responded with ${response.status}: ${response.statusText}`,
          data,
        };
      }

      return { success: true, status: response.status, data };
    }

    return { success: false, error: `Unknown action: ${action}` };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Connection failed',
      details: `Could not reach ${baseUrl}. Check host/port, ensure the server is running, and that your firewall allows inbound TCP on port ${apiPort}.`,
    };
  }
}
