/**
 * Serverless proxy function for BizObs Generator API calls.
 * Runs server-side to bypass browser CSP restrictions.
 */

import { edgeConnectClient } from '@dynatrace-sdk/client-app-engine-edge-connect';
import { workflowsClient } from '@dynatrace-sdk/client-automation';
import { settingsObjectsClient, credentialVaultClient } from '@dynatrace-sdk/client-classic-environment-v2';
import { documentsClient, environmentSharesClient } from '@dynatrace-sdk/client-document';
import { queryExecutionClient } from '@dynatrace-sdk/client-query';

interface ProxyPayload {
  action: 'simulate-journey' | 'simulate-vcarb-race' | 'vcarb-race-status' | 'stop-vcarb-race' | 'get-saved-config' | 'test-connection' | 'get-services' | 'stop-all-services' | 'stop-company-services' | 'get-dormant-services' | 'clear-dormant-services' | 'clear-company-dormant' | 'chaos-get-active' | 'chaos-get-recipes' | 'chaos-inject' | 'chaos-revert' | 'chaos-revert-all' | 'chaos-get-targeted' | 'chaos-remove-target' | 'chaos-smart' | 'ec-create' | 'ec-update-patterns' | 'detect-builtin-settings' | 'deploy-builtin-settings' | 'deploy-workflow' | 'debug-builtin-schema' | 'generate-dashboard' | 'generate-dashboard-async' | 'get-dashboard-status' | 'deploy-dashboard' | 'deploy-ai-dashboard' | 'mcp-generate-deploy-dashboard' | 'list-saved-dashboards' | 'load-saved-dashboard' | 'delete-saved-dashboard' | 'deploy-business-flow' | 'list-business-flows' | 'delete-business-flows' | 'generate-pdf' | 'generate-doc' | 'load-app-settings' | 'save-app-settings' | 'check-journey-assets' | 'create-notebook' | 'execute-dql' | 'demonstrator-ai-tiles' | 'demonstrator-tiles-status' | 'field-repo-get' | 'librarian-history' | 'librarian-stats' | 'librarian-analyze' | 'system-health' | 'system-cleanup' | 'github-copilot-generate' | 'github-copilot-check-credential' | 'github-copilot-save-credential' | 'github-copilot-list-models';
  apiHost: string;
  apiPort: string;
  apiProtocol: string;
  body?: unknown;
}

// ── Grail Field Discovery: query which additionalfields.* exist for a company/journey ──
// Returns array of {name, type} objects — type is inferred from actual data values
async function discoverBizEventFieldsViaSDK(company: string, journeyType: string): Promise<{name: string, type: 'string'|'numeric', sampleValue?: string|number}[] | null> {
  try {
    const safeCompany = company.replace(/["\\]/g, '');
    const safeJourney = journeyType.replace(/["\\]/g, '');
    // Fetch 1 recent bizevent WITHOUT a | fields clause — this returns ALL columns
    // including every additionalfields.* the customer has, no matter what they named them.
    // We only need 1 record since all records share the same schema/fields.
    const dql = `fetch bizevents
| filter event.kind == "BIZ_EVENT"
| filter json.companyName == "${safeCompany}"
| filter json.journeyType == "${safeJourney}"
| sort timestamp desc
| limit 1`;

    console.log(`[proxy-api] Discovering bizevent fields for ${company} / ${journeyType}...`);

    const queryResult = await queryExecutionClient.queryExecute({
      body: {
        query: dql,
        requestTimeoutMilliseconds: 15000,
        maxResultRecords: 1,
      },
    });

    const records = queryResult?.result?.records || [];
    if (records.length === 0) {
      console.log('[proxy-api] No bizevent records found for field discovery');
      return [];
    }

    // Extract field names, types, and sample values from the single record
    const record = records[0];
    const result: {name: string, type: 'string'|'numeric', sampleValue?: string|number}[] = [];
    if (record && typeof record === 'object') {
      for (const [key, value] of Object.entries(record)) {
        if (value !== null && value !== undefined && value !== '' && key.startsWith('additionalfields.')) {
          const fieldName = key.replace('additionalfields.', '');
          const strVal = String(value);
          const isNumeric = !isNaN(Number(strVal)) && strVal.trim() !== '';
          result.push({
            name: fieldName,
            type: isNumeric ? 'numeric' : 'string',
            sampleValue: isNumeric ? Number(strVal) : strVal,
          });
        }
      }
    }

    console.log(`[proxy-api] Discovered ${result.length} fields: ${result.map(f => `${f.name}(${f.type}=${f.sampleValue})`).join(', ')}`);
    return result;
  } catch (e: any) {
    console.warn(`[proxy-api] Field discovery error: ${e.message}`);
    return null;
  }
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

      // 1. BizEvents HTTP incoming capture rule named "Business Observability Demonstrator"
      try {
        const result = await settingsObjectsClient.getSettingsObjects({
          schemaIds: 'builtin:bizevents.http.incoming',
          fields: 'objectId,value',
          pageSize: 50,
        });
        detected['biz-events'] = (result.items || []).some(
          (i: any) => i.value?.ruleName === 'Business Observability Demonstrator' || i.value?.ruleName === 'Business Outcome Engine' || i.value?.ruleName === 'Business Observability Generator' || i.value?.ruleName === 'BizObs App'
        );
      } catch { detected['biz-events'] = false; }

      // 2. OpenPipeline bizevents pipeline named "Business Observability Demonstrator"
      try {
        const result = await settingsObjectsClient.getSettingsObjects({
          schemaIds: 'builtin:openpipeline.bizevents.pipelines',
          fields: 'objectId,value',
          pageSize: 50,
        });
        detected['openpipeline'] = (result.items || []).some(
          (i: any) => i.value?.displayName === 'Business Observability Demonstrator' || i.value?.displayName === 'Business Outcome Engine' || i.value?.displayName === 'Business Observability Generator' || i.value?.displayName === 'BizObs Template Pipeline'
        );
      } catch { detected['openpipeline'] = false; }

      // 3. OpenPipeline bizevents routing — check for "Business Observability Demonstrator" entry
      try {
        const result = await settingsObjectsClient.getSettingsObjects({
          schemaIds: 'builtin:openpipeline.bizevents.routing',
          fields: 'objectId,value',
          pageSize: 10,
        });
        let hasRoute = false;
        for (const item of result.items || []) {
          const val = item.value as { routingEntries?: Array<{ description?: string }> };
          if (val.routingEntries?.some(e => e.description === 'Business Observability Demonstrator' || e.description === 'Business Outcome Engine' || e.description === 'Business Observability Generator' || e.description === 'BizObs App')) {
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

      // 9. Outbound connections allowlist — check if models.inference.ai.azure.com is allowed
      try {
        const result = await settingsObjectsClient.getSettingsObjects({
          schemaIds: 'builtin:dt-javascript-runtime.allowed-outbound-connections',
          fields: 'objectId,value',
          pageSize: 1,
        });
        const item = result.items?.[0];
        const aoc = (item?.value as any)?.allowedOutboundConnections;
        if (aoc) {
          // If enforcement is disabled, all hosts are allowed
          if (aoc.enforced === false) {
            detected['outbound-github-models'] = true;
          } else {
            const hostList: string[] = aoc.hostList || [];
            detected['outbound-github-models'] = hostList.includes('models.inference.ai.azure.com');
          }
        } else {
          detected['outbound-github-models'] = false;
        }
      } catch (e: any) {
        console.log(`[detect] Outbound allowlist detection error: ${e.message}`);
        detected['outbound-github-models'] = false;
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
              (i: any) => i.value?.ruleName === 'Business Observability Demonstrator' || i.value?.ruleName === 'Business Outcome Engine' || i.value?.ruleName === 'Business Observability Generator' || i.value?.ruleName === 'BizObs App'
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
                    ruleName: 'Business Observability Demonstrator',
                    triggers: [{
                      caseSensitive: false,
                      source: { dataSource: 'request.path' },
                      type: 'STARTS_WITH',
                      value: '/process',
                    }],
                    event: {
                      category: { sourceType: 'constant.string', source: 'Business Observability Demonstrator' },
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
            const matchDisplayNames = ['Business Observability Demonstrator', 'Business Outcome Engine', 'Business Observability Generator', 'BizObs Template Pipeline'];
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
                    displayName: 'Business Observability Demonstrator',
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
                          id: 'processor_Business_Outcome_Engine_' + Math.floor(Math.random() * 10000),
                          type: 'costAllocation',
                          matcher: 'matchesvalue(event.category, "Business Observability Demonstrator")',
                          description: 'Business Observability Demonstrator',
                          enabled: true,
                          costAllocation: {
                            value: {
                              type: 'constant',
                              constant: 'BusinessOutcomeEngineApp',
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
                      (e) => e.description === 'Business Observability Demonstrator' || e.description === 'Business Outcome Engine' || e.description === 'Business Observability Generator' || e.description === 'BizObs App' || e.pipelineId === newPipelineObjectId
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
                        matcher: 'matchesvalue(event.category, "Business Observability Demonstrator")',
                        description: 'Business Observability Demonstrator',
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
                            matcher: 'matchesvalue(event.category, "Business Observability Demonstrator")',
                            description: 'Business Observability Demonstrator',
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
              (i: any) => i.value?.customId === 'bizobs-template-pipeline' || i.value?.displayName === 'Business Observability Demonstrator' || i.value?.displayName === 'Business Outcome Engine' || i.value?.displayName === 'Business Observability Generator' || i.value?.displayName === 'BizObs Template Pipeline'
            );

            if (!bizobsPipeline) {
              results['openpipeline-routing'] = { success: false, error: 'Pipeline "Business Observability Demonstrator" must be created first — deploy the Pipeline step before Routing' };
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
                  (e) => e.description === 'Business Observability Demonstrator' || e.description === 'Business Outcome Engine' || e.description === 'Business Observability Generator' || e.description === 'BizObs App' || e.pipelineId === pipelineObjectId
                );

                if (alreadyHasEntry) {
                  results['openpipeline-routing'] = { success: true, error: 'Already exists — no changes needed' };
                } else {
                  routingValue.routingEntries = routingValue.routingEntries || [];
                  routingValue.routingEntries.push({
                    enabled: true,
                    pipelineType: 'custom',
                    pipelineId: pipelineObjectId,
                    matcher: 'matchesvalue(event.category, "Business Observability Demonstrator")',
                    description: 'Business Observability Demonstrator',
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
                        matcher: 'matchesvalue(event.category, "Business Observability Demonstrator")',
                        description: 'Business Observability Demonstrator',
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
          } else if (configKey === 'outbound-github-models') {
            // Add models.inference.ai.azure.com to the outbound connections allowlist
            const existing = await settingsObjectsClient.getSettingsObjects({
              schemaIds: 'builtin:dt-javascript-runtime.allowed-outbound-connections',
              fields: 'objectId,value',
              pageSize: 1,
            });
            const item = existing.items?.[0];
            const aoc = (item?.value as any)?.allowedOutboundConnections;

            if (aoc) {
              const hostList: string[] = aoc.hostList || [];
              if (hostList.includes('models.inference.ai.azure.com')) {
                results['outbound-github-models'] = { success: true, error: 'Already in allowlist — no changes needed' };
              } else {
                // Update existing object — add host to the list
                await settingsObjectsClient.putSettingsObjectByObjectId({
                  objectId: item!.objectId,
                  body: {
                    value: {
                      allowedOutboundConnections: {
                        enforced: aoc.enforced !== false,
                        hostList: [...hostList, 'models.inference.ai.azure.com'],
                      },
                    },
                  },
                });
                results['outbound-github-models'] = { success: true };
              }
            } else {
              // No settings object exists yet — create one
              await settingsObjectsClient.postSettingsObjects({
                body: [{
                  schemaId: 'builtin:dt-javascript-runtime.allowed-outbound-connections',
                  scope: 'environment',
                  value: {
                    allowedOutboundConnections: {
                      enforced: true,
                      hostList: ['models.inference.ai.azure.com'],
                    },
                  },
                }],
              });
              results['outbound-github-models'] = { success: true };
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
        // Discover available fields before async generation too
        const asyncBody = { ...(body as any) };
        const asyncJd = asyncBody.journeyData;
        if (asyncJd?.company && asyncJd?.journeyType) {
          const asyncFields = await discoverBizEventFieldsViaSDK(asyncJd.company, asyncJd.journeyType);
          if (asyncFields !== null) {
            asyncBody.journeyData = { ...asyncJd, discoveredFields: asyncFields };
          }
        }
        const res = await fetchWithRetry(`${baseUrl}/api/ai-dashboard/generate-async`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(asyncBody),
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
        const hasPrompt = !!(body as any)?.customPrompt;
        // Discover available bizevent fields via SDK before generating
        const generateBody = { ...(body as any) };
        const jd = generateBody.journeyData;
        if (jd?.company && jd?.journeyType) {
          const discoveredFields = await discoverBizEventFieldsViaSDK(jd.company, jd.journeyType);
          if (discoveredFields !== null) {
            generateBody.journeyData = { ...jd, discoveredFields };
          }
        }
        const res = await fetchWithRetry(`${baseUrl}/api/ai-dashboard/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(generateBody),
          signal: AbortSignal.timeout(hasPrompt ? 130000 : 60000),
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


    // ── List saved dashboards on EC2 host ──
    if (action === 'list-saved-dashboards') {
      try {
        const res = await fetchWithRetry(`${baseUrl}/api/ai-dashboard/saved`, {
          method: 'GET',
          signal: AbortSignal.timeout(10000),
        });
        const data = await res.json();
        return { success: res.ok, ...data };
      } catch (error: any) {
        console.error('[proxy-api] List saved dashboards error:', error.message);
        return { success: false, error: error.message };
      }
    }

    // ── Load a specific saved dashboard from EC2 host ──
    if (action === 'load-saved-dashboard') {
      try {
        const { dashboardId } = body as { dashboardId: string };
        if (!dashboardId) return { success: false, error: 'dashboardId required' };
        const safeId = dashboardId.replace(/[^a-zA-Z0-9-]/g, '');
        const res = await fetchWithRetry(`${baseUrl}/api/ai-dashboard/saved/${safeId}`, {
          method: 'GET',
          signal: AbortSignal.timeout(10000),
        });
        const data = await res.json();
        return { success: res.ok, ...data };
      } catch (error: any) {
        console.error('[proxy-api] Load saved dashboard error:', error.message);
        return { success: false, error: error.message };
      }
    }

    // ── Delete a saved dashboard from EC2 host ──
    if (action === 'delete-saved-dashboard') {
      try {
        const { dashboardId } = body as { dashboardId: string };
        if (!dashboardId) return { success: false, error: 'dashboardId required' };
        const safeId = dashboardId.replace(/[^a-zA-Z0-9-]/g, '');
        const res = await fetchWithRetry(`${baseUrl}/api/ai-dashboard/saved/${safeId}`, {
          method: 'DELETE',
          signal: AbortSignal.timeout(10000),
        });
        const data = await res.json();
        return { success: res.ok, ...data };
      } catch (error: any) {
        console.error('[proxy-api] Delete saved dashboard error:', error.message);
        return { success: false, error: error.message };
      }
    }

    // ── MCP-powered: Generate + Deploy Dashboard in one step ──
    if (action === 'mcp-generate-deploy-dashboard') {
      try {
        const { company, journeyType, useAI = true, customPrompt } = body as { company: string; journeyType: string; useAI?: boolean; customPrompt?: string };
        if (!company || !journeyType) {
          return { success: false, error: 'company and journeyType are required' };
        }

        const hasCustomPrompt = !!customPrompt;
        console.log(`[proxy-api] Generate+deploy: ${company} / ${journeyType}${hasCustomPrompt ? ` (custom prompt: "${customPrompt!.substring(0, 60)}...")` : ''}`);

        // Step 1: Discover available bizevent fields via SDK, then call EC2 generate endpoint
        const discoveredFields = await discoverBizEventFieldsViaSDK(company, journeyType);
        const generatePayload: any = {
          journeyData: { company, journeyType, ...(discoveredFields !== null ? { discoveredFields } : {}) },
          useAI,
        };
        if (hasCustomPrompt) generatePayload.customPrompt = customPrompt;

        const genRes = await fetchWithRetry(`${baseUrl}/api/ai-dashboard/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(generatePayload),
          signal: AbortSignal.timeout(180000),
        });

        const data = await genRes.json();
        if (!data.success || !data.dashboard) {
          return { success: false, error: data.error || 'Dashboard generation failed' };
        }

        const dashboard = data.dashboard;
        if (!dashboard || !dashboard.content) {
          return { success: false, error: 'Dashboard generation returned no content' };
        }

        const generationMethod = data.generationMethod || 'unknown';
        console.log(`[proxy-api] Generated ${Object.keys(dashboard.content.tiles || {}).length} tiles via ${generationMethod}`);

        // Step 2: Deploy the dashboard to Dynatrace using Document API
        const sanitizedCompany = company.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
        const sanitizedJourney = journeyType.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
        // Use AI-provided slug for unique document IDs per prompt focus, falling back to journey type
        const aiSlug = (dashboard.metadata?.dashboardSlug || '').replace(/[^a-z0-9-]/gi, '-').toLowerCase().replace(/-+/g, '-').replace(/^-|-$/g, '');
        const dashboardId = aiSlug
          ? `bizobs-${sanitizedCompany}-${aiSlug}`
          : `bizobs-${sanitizedCompany}-${sanitizedJourney}`;
        const dashboardName = dashboard.name || `${company} - ${journeyType} Journey`;

        let alreadyExisted = false;
        try {
          const existing = await documentsClient.getDocument({ id: dashboardId });
          // Dashboard exists — update it
          await documentsClient.updateDocument({
            id: dashboardId,
            optimisticLockingVersion: existing.metadata!.version,
            body: {
              name: dashboardName,
              content: new Blob([JSON.stringify(dashboard.content)], { type: 'application/json' }),
            },
          });
          alreadyExisted = true;
          console.log(`[proxy-api] MCP dashboard updated: ${dashboardId}`);
        } catch (e: any) {
          // 404 = doesn't exist → create it
          if (e?.body?.error?.code === 404 || e?.statusCode === 404) {
            const result = await documentsClient.createDocument({
              body: {
                id: dashboardId,
                name: dashboardName,
                type: 'dashboard',
                content: new Blob([JSON.stringify(dashboard.content)], { type: 'application/json' }),
              },
            });

            // Share with entire environment
            try {
              await environmentSharesClient.createEnvironmentShare({
                body: { documentId: result.id!, access: 'read' },
              });
            } catch (shareErr: any) {
              console.warn('[proxy-api] Dashboard shared failed (non-blocking):', shareErr.message);
            }
            console.log(`[proxy-api] MCP dashboard created: ${dashboardId}`);
          } else {
            throw e;
          }
        }

        const dashboardUrl = `/ui/apps/dynatrace.dashboards/dashboard/${dashboardId}`;
        return {
          success: true,
          data: {
            dashboardId,
            dashboardUrl,
            dashboardName,
            tileCount: Object.keys(dashboard.content.tiles || {}).length,
            generationMethod,
            alreadyExisted,
            message: alreadyExisted
              ? `Dashboard "${dashboardName}" updated successfully`
              : `Dashboard "${dashboardName}" deployed and shared with environment`,
          },
        };
      } catch (error: any) {
        console.error('[proxy-api] MCP generate+deploy error:', error.message);
        return { success: false, error: error.message || 'MCP dashboard generation failed' };
      }
    }

    if (action === 'deploy-ai-dashboard') {
      // Deploy the built-in AI Observability dashboard using the Document API
      const DASHBOARD_ID = 'bizobs-ai-observability-dashboard';
      const DASHBOARD_NAME = '[AI Obs] Ollama — BizObs Demonstrator';

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

    // ── Executive Summary Document (HTML — Word-convertible) ──
    if (action === 'generate-doc') {
      try {
        const res = await fetchWithRetry(`${baseUrl}/api/pdf/executive-doc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) {
          const errText = await res.text();
          return { success: false, error: `Document generation failed (${res.status}): ${errText}` };
        }
        const html = await res.text();
        const contentDisposition = res.headers.get('content-disposition') || '';
        const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/);
        const filename = filenameMatch ? filenameMatch[1] : 'BizObs-Summary.html';
        return { success: true, data: { html, filename, sizeKb: Math.round(html.length / 1024) } };
      } catch (error: any) {
        console.error('[proxy-api] Document generation error:', error.message);
        return { success: false, error: error.message };
      }
    }

    if (action === 'get-saved-config') {
      const configName = (body as any)?.configName || '';
      const apiUrl = `${baseUrl}/api/admin/configs/${encodeURIComponent(configName)}`;
      const response = await fetchWithRetry(apiUrl, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        return { success: false, status: response.status, error: `Config not found: ${configName}` };
      }
      const data = await response.json();
      return { success: true, data };
    }

    if (action === 'simulate-vcarb-race') {
      const apiUrl = `${baseUrl}/api/journey-simulation/simulate-vcarb-race`;
      const response = await fetchWithRetry(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
      const data = await response.json();
      return { success: response.ok, status: response.status, data };
    }

    if (action === 'vcarb-race-status') {
      const raceId = (body as any)?.raceId || '';
      const apiUrl = `${baseUrl}/api/journey-simulation/vcarb-race-status/${encodeURIComponent(raceId)}`;
      const response = await fetchWithRetry(apiUrl, { method: 'GET', signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      return { success: response.ok, data };
    }

    if (action === 'stop-vcarb-race') {
      const raceId = (body as any)?.raceId || '';
      const apiUrl = `${baseUrl}/api/journey-simulation/stop-vcarb-race/${encodeURIComponent(raceId)}`;
      const response = await fetchWithRetry(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      const data = await response.json();
      return { success: response.ok, data };
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

    if (action === 'list-business-flows') {
      try {
        const result = await settingsObjectsClient.getSettingsObjects({
          schemaIds: 'app:dynatrace.biz.flow:biz-flow-settings',
          fields: 'objectId,value',
          pageSize: 500,
        });
        const flows = (result.items || []).map((item: any) => ({
          objectId: item.objectId,
          name: item.value?.name,
          isSmartscapeTopologyEnabled: item.value?.isSmartscapeTopologyEnabled || false,
          stepsCount: item.value?.steps?.length || 0,
          version: item.version,
        }));
        return { success: true, data: { totalCount: result.totalCount, flows } };
      } catch (err: any) {
        return { success: false, error: err.message || 'Failed to list business flows' };
      }
    }

    if (action === 'delete-business-flows') {
      try {
        const { objectIds } = body as { objectIds: string[] };
        if (!objectIds || objectIds.length === 0) {
          return { success: false, error: 'objectIds array is required' };
        }
        const results: { objectId: string; deleted: boolean; error?: string }[] = [];
        for (const oid of objectIds) {
          try {
            await settingsObjectsClient.deleteSettingsObjectByObjectId({ objectId: oid });
            results.push({ objectId: oid, deleted: true });
          } catch (err: any) {
            results.push({ objectId: oid, deleted: false, error: err.message });
          }
        }
        return { success: true, data: { results, deletedCount: results.filter(r => r.deleted).length } };
      } catch (err: any) {
        return { success: false, error: err.message || 'Failed to delete business flows' };
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // CHECK JOURNEY ASSETS — Dashboard & BizFlow existence per company/journey
    // ══════════════════════════════════════════════════════════════════
    if (action === 'check-journey-assets') {
      try {
        const journeys = (payload.body as any)?.journeys as Array<{ company: string; journeyType: string }> || [];
        const assets: Record<string, { dashboard: { exists: boolean; id: string; url: string; name?: string }; bizflow: { exists: boolean; name?: string } }> = {};

        // 1. Fetch all BizFlows in one call
        let allFlows: any[] = [];
        try {
          const flowResult = await settingsObjectsClient.getSettingsObjects({
            schemaIds: 'app:dynatrace.biz.flow:biz-flow-settings',
            fields: 'objectId,value',
            pageSize: 500,
          });
          allFlows = flowResult.items || [];
        } catch { /* BizFlow app may not be installed */ }

        // 2. Collect unique companies and list all their dashboards in bulk
        const uniqueCompanies = [...new Set(journeys.map(j => j.company))];
        const dashboardsByCompany: Record<string, Array<{ id: string; name: string }>> = {};
        for (const company of uniqueCompanies) {
          const sanitizedCompany = company.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
          const prefix = `bizobs-${sanitizedCompany}`;
          try {
            const docs = await documentsClient.listDocuments({
              filter: `id starts-with '${prefix}' and type = 'dashboard'`,
              pageSize: 50,
            });
            dashboardsByCompany[company] = (docs.documents || []).map((d: any) => ({
              id: d.id,
              name: d.name || d.id,
            }));
          } catch {
            dashboardsByCompany[company] = [];
          }
        }

        for (const { company, journeyType } of journeys) {
          const sanitizedCompany = company.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
          const sanitizedJourney = journeyType.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
          const key = `${company}::${journeyType}`;

          // Match dashboard: exact journey ID first, then any that contains the journey slug
          const companyDashboards = dashboardsByCompany[company] || [];
          const exactMatch = companyDashboards.find(d => d.id === `bizobs-${sanitizedCompany}-${sanitizedJourney}`);
          const fuzzyMatch = !exactMatch
            ? companyDashboards.find(d => d.id.includes(sanitizedJourney) || d.name.toLowerCase().includes(journeyType.toLowerCase()))
            : undefined;
          const matchedDash = exactMatch || fuzzyMatch;
          const dashboardUrl = matchedDash
            ? `/ui/apps/dynatrace.dashboards/dashboard/${matchedDash.id}`
            : `/ui/apps/dynatrace.dashboards/dashboard/bizobs-${sanitizedCompany}-${sanitizedJourney}`;

          // Match BizFlow by company or journey name
          const companyLower = company.toLowerCase();
          const matchedFlow = allFlows.find((f: any) => {
            const name = (f.value?.name || '').toLowerCase();
            return name.includes(companyLower) || (name.includes(sanitizedCompany) && name.includes(sanitizedJourney));
          });

          assets[key] = {
            dashboard: {
              exists: !!matchedDash,
              id: matchedDash?.id || `bizobs-${sanitizedCompany}-${sanitizedJourney}`,
              url: dashboardUrl,
              name: matchedDash?.name,
            },
            bizflow: { exists: !!matchedFlow, name: matchedFlow?.value?.name },
          };
        }
        return { success: true, data: assets };
      } catch (err: any) {
        return { success: false, error: err.message || 'Failed to check journey assets' };
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // APP-WIDE SETTINGS via Document Service
    // Uses a shared Grail Document (isPrivate=false) so ALL users on the
    // tenant see the same EC2 IP / port / protocol without configuring.
    // ══════════════════════════════════════════════════════════════════
    const APP_SETTINGS_DOC_ID = 'bizobs-demonstrator-app-settings';
    const APP_SETTINGS_DOC_NAME = 'BizObs Demonstrator App Settings';
    const APP_SETTINGS_DOC_TYPE = 'bizobs-config';

    if (action === 'load-app-settings') {
      try {
        const doc = await documentsClient.getDocument({ id: APP_SETTINGS_DOC_ID });
        if (doc.content) {
          const text = await doc.content.get('text');
          const settings = JSON.parse(text);
          return { success: true, settings, version: doc.metadata?.version };
        }
        return { success: false, error: 'Document has no content' };
      } catch (err: any) {
        // 404 = document doesn't exist yet — not an error, just no settings saved
        const code = err?.body?.error?.code || err?.statusCode || err?.code;
        if (code === 404 || err?.message?.includes('not found') || err?.name === 'DocumentOrSnapshotNotFound') {
          return { success: false, error: 'no-document' };
        }
        return { success: false, error: err.message || 'Failed to load app settings' };
      }
    }

    if (action === 'save-app-settings') {
      try {
        const settingsJson = JSON.stringify(payload.body || {});
        const blob = new Blob([settingsJson], { type: 'application/json' });

        // Try to update existing document first
        let saved = false;
        try {
          const existing = await documentsClient.getDocument({ id: APP_SETTINGS_DOC_ID });
          const version = existing.metadata?.version;
          if (version) {
            await documentsClient.updateDocument({
              id: APP_SETTINGS_DOC_ID,
              optimisticLockingVersion: version,
              body: {
                content: blob,
                name: APP_SETTINGS_DOC_NAME,
                type: APP_SETTINGS_DOC_TYPE,
                isPrivate: false, // Public = readable by ALL users on the tenant
              },
            });
            saved = true;
          }
        } catch (getErr: any) {
          // Document doesn't exist — create it
          const code = getErr?.body?.error?.code || getErr?.statusCode || getErr?.code;
          if (code === 404 || getErr?.message?.includes('not found') || getErr?.name === 'DocumentOrSnapshotNotFound') {
            await documentsClient.createDocument({
              body: {
                id: APP_SETTINGS_DOC_ID,
                name: APP_SETTINGS_DOC_NAME,
                type: APP_SETTINGS_DOC_TYPE,
                content: blob,
              },
            });
            // Make it public so all users can read it
            try {
              const created = await documentsClient.getDocument({ id: APP_SETTINGS_DOC_ID });
              if (created.metadata?.version) {
                await documentsClient.updateDocument({
                  id: APP_SETTINGS_DOC_ID,
                  optimisticLockingVersion: created.metadata.version,
                  body: { isPrivate: false },
                });
              }
            } catch { /* isPrivate update is best-effort */ }

            // Also create an environment share so other users can write too
            try {
              await environmentSharesClient.createEnvironmentShare({
                body: { documentId: APP_SETTINGS_DOC_ID, access: 'read-write' },
              });
            } catch { /* Share may already exist — ignore */ }
            saved = true;
          } else {
            throw getErr;
          }
        }

        return { success: saved };
      } catch (err: any) {
        return { success: false, error: err.message || 'Failed to save app settings' };
      }
    }

    /* ── Demonstrator Dashboards: AI-generated tiles via Ollama (async job model) ── */
    if (action === 'demonstrator-ai-tiles') {
      try {
        const reqBody = payload.body as {
          fields?: { name: string; type: string; sampleValue?: string | number }[];
          preset?: string;
          companyName?: string;
          journeyType?: string;
          timeframe?: string;
          services?: string[];
        };
        // If no fields provided by frontend, discover them server-side
        let fields = reqBody?.fields;
        if ((!fields || fields.length === 0) && reqBody?.companyName && reqBody?.journeyType) {
          const discovered = await discoverBizEventFieldsViaSDK(reqBody.companyName, reqBody.journeyType);
          if (discovered && discovered.length > 0) fields = discovered;
        }
        if (!fields || fields.length === 0) {
          return { success: false, error: 'No fields discovered for AI tile generation' };
        }
        console.log(`[proxy-api] demonstrator-ai-tiles: starting async job for ${fields.length} fields, ${reqBody?.preset} preset`);
        // Start the async job — returns immediately with a jobId
        const resp = await fetchWithRetry(`${baseUrl}/api/ai-dashboard/demonstrator-tiles-async`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify({
            fields,
            preset: reqBody?.preset || 'executive',
            companyName: reqBody?.companyName || '',
            journeyType: reqBody?.journeyType || '',
            timeframe: reqBody?.timeframe || 'now()-2h',
            services: reqBody?.services || [],
          }),
        });
        const data = await resp.json();
        return data;
      } catch (err: any) {
        console.error('[proxy-api] demonstrator-ai-tiles error:', err.message);
        return { success: false, error: err.message || 'Demonstrator AI Tiles request failed' };
      }
    }

    /* ── Demonstrator Dashboards: poll for AI tile generation status ── */
    if (action === 'demonstrator-tiles-status') {
      try {
        const { jobId } = (payload.body || {}) as { jobId?: string };
        if (!jobId) return { success: false, error: 'jobId required' };
        const resp = await fetchWithRetry(`${baseUrl}/api/ai-dashboard/demonstrator-tiles-status/${encodeURIComponent(jobId)}`, {
          method: 'GET',
          signal: AbortSignal.timeout(15000),
        });
        const data = await resp.json();
        return data;
      } catch (err: any) {
        console.error('[proxy-api] demonstrator-tiles-status error:', err.message);
        return { success: false, error: err.message || 'Status check failed' };
      }
    }

    /* ── Field Repository: get captured journey field schemas for AI ── */
    if (action === 'field-repo-get') {
      try {
        const reqBody = payload.body as { company?: string; journeyType?: string; full?: boolean };
        const params = new URLSearchParams();
        if (reqBody?.company) params.set('company', reqBody.company);
        if (reqBody?.journeyType) params.set('journey', reqBody.journeyType);
        if (reqBody?.full) params.set('full', 'true');
        const resp = await fetchWithRetry(`${baseUrl}/api/ai-dashboard/field-repo?${params.toString()}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        });
        const data = await resp.json();
        return data;
      } catch (err: any) {
        console.error('[proxy-api] field-repo-get error:', err.message);
        return { success: false, error: err.message || 'Field repo request failed' };
      }
    }

    /* ── Demonstrator Dashboards: execute arbitrary DQL server-side ── */
    if (action === 'execute-dql') {
      try {
        const { query, timeoutMs, maxRecords } = (payload.body || {}) as { query?: string; timeoutMs?: number; maxRecords?: number };
        console.log('[proxy-api] execute-dql called, query:', query?.substring(0, 120));
        if (!query || typeof query !== 'string') {
          return { success: false, error: 'Missing or invalid query' };
        }
        const queryResult = await queryExecutionClient.queryExecute({
          body: {
            query,
            requestTimeoutMilliseconds: timeoutMs || 15000,
            maxResultRecords: maxRecords || 1000,
          },
        });
        const records = queryResult?.result?.records || [];
        console.log(`[proxy-api] execute-dql returned ${records.length} records, keys:`, records.length > 0 ? Object.keys(records[0]) : '(empty)');
        return { success: true, records, metadata: queryResult?.result?.metadata };
      } catch (err: any) {
        console.error('[proxy-api] execute-dql error:', err.message);
        return { success: false, error: err.message || 'DQL execution failed' };
      }
    }

    /* ── Demonstrator Dashboards: create a Dynatrace Notebook from DQL tiles ── */
    if (action === 'create-notebook') {
      try {
        const { name, content } = (payload.body || {}) as { name?: string; content?: string };
        if (!name || !content) {
          return { success: false, error: 'Missing name or content for notebook' };
        }
        const blob = new Blob([content], { type: 'application/json' });
        const result = await documentsClient.createDocument({
          body: {
            name,
            type: 'notebook',
            content: blob,
          },
        });
        return { success: true, id: result.id || 'created' };
      } catch (err: any) {
        return { success: false, error: err.message || 'Failed to create notebook' };
      }
    }

    /* ── Librarian Agent: get recent history ── */
    if (action === 'librarian-history') {
      try {
        const { limit } = (payload.body || {}) as { limit?: number };
        const resp = await fetchWithRetry(`${baseUrl}/api/librarian/history?limit=${limit || 100}`, {
          method: 'GET',
          signal: AbortSignal.timeout(15000),
        });
        const data = await resp.json();
        return { success: true, events: data };
      } catch (err: any) {
        console.error('[proxy-api] librarian-history error:', err.message);
        return { success: false, error: err.message || 'Failed to fetch librarian history' };
      }
    }

    /* ── Librarian Agent: get stats ── */
    if (action === 'librarian-stats') {
      try {
        const resp = await fetchWithRetry(`${baseUrl}/api/librarian/stats`, {
          method: 'GET',
          signal: AbortSignal.timeout(15000),
        });
        const data = await resp.json();
        return { success: true, ...data };
      } catch (err: any) {
        console.error('[proxy-api] librarian-stats error:', err.message);
        return { success: false, error: err.message || 'Failed to fetch librarian stats' };
      }
    }

    /* ── Librarian Agent: full Ollama-powered analysis ── */
    if (action === 'librarian-analyze') {
      try {
        console.log('[proxy-api] librarian-analyze: requesting Ollama analysis of operational history');
        const resp = await fetchWithRetry(`${baseUrl}/api/librarian/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(120000),
        });
        const data = await resp.json();
        return data;
      } catch (err: any) {
        console.error('[proxy-api] librarian-analyze error:', err.message);
        return { success: false, error: err.message || 'Librarian analysis failed' };
      }
    }

    /* ── System Maintenance: disk health & auto-cleanup ── */
    if (action === 'system-health') {
      try {
        const resp = await fetchWithRetry(`${baseUrl}/api/system/health`, { signal: AbortSignal.timeout(30000) });
        return await resp.json();
      } catch (err: any) {
        console.error('[proxy-api] system-health error:', err.message);
        return { success: false, error: err.message || 'System health check failed' };
      }
    }

    if (action === 'system-cleanup') {
      try {
        const resp = await fetchWithRetry(`${baseUrl}/api/system/cleanup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
          signal: AbortSignal.timeout(60000),
        });
        return await resp.json();
      } catch (err: any) {
        console.error('[proxy-api] system-cleanup error:', err.message);
        return { success: false, error: err.message || 'System cleanup failed' };
      }
    }

    // ── GitHub Copilot / AI Generation ──────────────────────────────────────

    const GITHUB_CREDENTIAL_NAME = 'bizobs-github-pat';

    if (action === 'github-copilot-check-credential') {
      try {
        const creds = await credentialVaultClient.listCredentials({ type: 'TOKEN' });
        const existing = (creds.credentials || []).find(
          (c: any) => c.name === GITHUB_CREDENTIAL_NAME
        );
        if (existing) {
          return { success: true, data: { configured: true, credentialId: existing.id, name: existing.name } };
        }
        return { success: true, data: { configured: false } };
      } catch (err: any) {
        console.error('[proxy-api] github-copilot-check-credential error:', err.message);
        return { success: false, error: err.message || 'Failed to check credential vault' };
      }
    }

    if (action === 'github-copilot-save-credential') {
      try {
        const { token } = body as { token: string };
        if (!token || !token.startsWith('ghp_') && !token.startsWith('github_pat_')) {
          return { success: false, error: 'Invalid token format. GitHub PATs start with ghp_ or github_pat_' };
        }
        // Check if credential already exists — update it if so
        const creds = await credentialVaultClient.listCredentials({ type: 'TOKEN' });
        const existing = (creds.credentials || []).find(
          (c: any) => c.name === GITHUB_CREDENTIAL_NAME
        );
        if (existing) {
          await credentialVaultClient.updateCredentials({
            id: existing.id,
            body: {
              name: GITHUB_CREDENTIAL_NAME,
              scopes: ['APP_ENGINE'],
              type: 'TOKEN',
              token: token,
              description: 'GitHub Personal Access Token for AI-powered prompt generation in Business Observability Demonstrator',
            } as any,
          });
          return { success: true, data: { credentialId: existing.id, updated: true } };
        }
        // Create new
        const result = await credentialVaultClient.createCredentials({
          body: {
            name: GITHUB_CREDENTIAL_NAME,
            scopes: ['APP_ENGINE'],
            type: 'TOKEN',
            token: token,
            description: 'GitHub Personal Access Token for AI-powered prompt generation in Business Observability Demonstrator',
          } as any,
        });
        return { success: true, data: { credentialId: result.id, created: true } };
      } catch (err: any) {
        console.error('[proxy-api] github-copilot-save-credential error:', err.message);
        return { success: false, error: err.message || 'Failed to save credential' };
      }
    }

    if (action === 'github-copilot-list-models') {
      try {
        // Retrieve the GitHub PAT from credential vault
        const creds = await credentialVaultClient.listCredentials({ type: 'TOKEN' });
        const existing = (creds.credentials || []).find(
          (c: any) => c.name === GITHUB_CREDENTIAL_NAME
        );
        if (!existing) {
          return { success: true, data: { models: [], configured: false } };
        }
        const details = await credentialVaultClient.getCredentialsDetails({ id: existing.id });
        const ghToken = (details as any).token;
        if (!ghToken) {
          return { success: true, data: { models: [], configured: false } };
        }

        // Call GitHub Models API to list available models
        const resp = await fetch('https://models.inference.ai.azure.com/models', {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${ghToken}` },
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) {
          if (resp.status === 401) {
            return { success: false, error: 'GitHub token is invalid or expired.', code: 'AUTH_FAILED' };
          }
          return { success: true, data: { models: [], configured: true, error: `API returned ${resp.status}` } };
        }

        const result = await resp.json();
        // Filter to chat/completion models and extract useful info
        const models = (result.data || result || [])
          .filter((m: any) => m.id && (m.task === 'chat-completion' || !m.task))
          .map((m: any) => ({
            id: m.id,
            name: m.name || m.id,
            owned_by: m.owned_by || m.publisher || '',
          }))
          .sort((a: any, b: any) => a.id.localeCompare(b.id));

        return { success: true, data: { models, configured: true } };
      } catch (err: any) {
        console.error('[proxy-api] github-copilot-list-models error:', err.message);
        return { success: true, data: { models: [], configured: true, error: err.message } };
      }
    }

    if (action === 'github-copilot-generate') {
      try {
        const { prompt, model } = body as { prompt: string; model?: string };
        if (!prompt) {
          return { success: false, error: 'Prompt is required' };
        }
        // 1. Retrieve the GitHub PAT from credential vault
        const creds = await credentialVaultClient.listCredentials({ type: 'TOKEN' });
        const existing = (creds.credentials || []).find(
          (c: any) => c.name === GITHUB_CREDENTIAL_NAME
        );
        if (!existing) {
          return { success: false, error: 'GitHub PAT not configured. Go to Settings → GitHub Copilot to set it up.', code: 'NO_CREDENTIAL' };
        }
        const details = await credentialVaultClient.getCredentialsDetails({ id: existing.id });
        const ghToken = (details as any).token;
        if (!ghToken) {
          return { success: false, error: 'Could not retrieve token from credential vault.', code: 'TOKEN_EMPTY' };
        }

        // 2. Call GitHub Models API (OpenAI-compatible)
        const selectedModel = model || 'gpt-4o';
        const resp = await fetch('https://models.inference.ai.azure.com/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${ghToken}`,
          },
          body: JSON.stringify({
            model: selectedModel,
            messages: [
              { role: 'system', content: 'You are a business analyst AI assistant. Respond with well-structured, actionable JSON when the prompt requests it. Otherwise respond with clear, professional text.' },
              { role: 'user', content: prompt },
            ],
            temperature: 0.7,
            max_tokens: 4096,
          }),
          signal: AbortSignal.timeout(120000),
        });

        if (!resp.ok) {
          const errText = await resp.text();
          if (resp.status === 401) {
            return { success: false, error: 'GitHub token is invalid or expired. Update it in Settings → GitHub Copilot.', code: 'AUTH_FAILED' };
          }
          if (resp.status === 429) {
            return { success: false, error: 'GitHub Models rate limit reached. Try again in a few minutes.', code: 'RATE_LIMITED' };
          }
          return { success: false, error: `GitHub Models API error (${resp.status}): ${errText.slice(0, 200)}` };
        }

        const result = await resp.json();
        const content = result.choices?.[0]?.message?.content || '';
        return {
          success: true,
          data: {
            content,
            model: selectedModel,
            usage: result.usage || {},
          },
        };
      } catch (err: any) {
        console.error('[proxy-api] github-copilot-generate error:', err.message);
        return { success: false, error: err.message || 'AI generation failed' };
      }
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
