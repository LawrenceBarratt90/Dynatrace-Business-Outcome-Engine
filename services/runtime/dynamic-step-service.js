/**
 * Dynamic Step Service - Creates services with proper Dynatrace identification
 * This service dynamically adapts its identity based on the step name provided
 */
const { createService } = require('./service-runner.js');
const { callService, getServiceNameFromStep, getServicePortFromStep } = require('./child-caller.js');
const { 
  TracedError, 
  withErrorTracking, 
  errorHandlingMiddleware,
  checkForStepError, 
  markSpanAsFailed, 
  reportError,
  sendErrorEvent,
  sendFeatureFlagCustomEvent,
  addCustomAttributes 
} = require('./dynatrace-error-helper.js');
const http = require('http');
const crypto = require('crypto');

// 🚦 FEATURE FLAG AUTO-REGENERATION TRACKER
let correlationIdCounter = 0;
let currentFeatureFlags = {};
let journeySteps = [];
let lastRegenerationCount = 0;

// Default error rate configuration (can be overridden via payload or global API)
const DEFAULT_ERROR_CONFIG = {
  errors_per_transaction: 0,    // No errors by default — Gremlin sets per-service overrides
  errors_per_visit: 0,          // No errors by default
  errors_per_minute: 0,         // No errors by default
  regenerate_every_n_transactions: 100  // Regenerate flags every 100 transactions
};

// Fetch error config from main server — passes service name for per-service targeting
// If this service has a targeted override (from Gremlin chaos), only IT gets the elevated rate
// Checks BOTH compound name (e.g., "PaymentService-SmythcsShoes") AND base name (e.g., "PaymentService")
async function fetchGlobalErrorConfig(myFullServiceName, myBaseServiceName) {
  return new Promise((resolve) => {
    // Build query string with BOTH service names so server can check either
    const params = [];
    if (myFullServiceName) params.push(`service=${encodeURIComponent(myFullServiceName)}`);
    if (myBaseServiceName && myBaseServiceName !== myFullServiceName) {
      params.push(`baseService=${encodeURIComponent(myBaseServiceName)}`);
    }
    const queryParams = params.length > 0 ? `?${params.join('&')}` : '';
    
    const options = {
      hostname: '127.0.0.1',
      port: process.env.MAIN_SERVER_PORT || 8080,
      path: `/api/feature_flag${queryParams}`,
      method: 'GET',
      timeout: 500
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.success && response.flags) {
            console.log('📥 [Feature Flags] Fetched from main server:', response.flags);
            resolve(response.flags);
          } else {
            resolve(DEFAULT_ERROR_CONFIG);
          }
        } catch (e) {
          resolve(DEFAULT_ERROR_CONFIG);
        }
      });
    });
    
    req.on('error', () => {
      // Silently fall back to defaults if main server not available
      resolve(DEFAULT_ERROR_CONFIG);
    });
    
    req.on('timeout', () => {
      req.destroy();
      resolve(DEFAULT_ERROR_CONFIG);
    });
    
    req.end();
  });
}

// Auto-regenerate feature flags based on volume
function checkAndRegenerateFeatureFlags(journeyData, errorConfig = DEFAULT_ERROR_CONFIG) {
  correlationIdCounter++;
  
  // Store journey steps for first request - check multiple payload shapes
  if (journeySteps.length === 0) {
    const steps = journeyData?.journey?.steps || journeyData?.steps || [];
    if (steps.length > 0) {
      journeySteps = steps;
      console.log(`📋 [Feature Flags] Captured ${journeySteps.length} journey steps for flag generation`);
    }
  }
  
  // Calculate if we should regenerate based on transaction volume
  const transactionsSinceRegen = correlationIdCounter - lastRegenerationCount;
  const shouldRegenerate = transactionsSinceRegen >= errorConfig.regenerate_every_n_transactions;
  
  // Generate initial flags on first request
  if (correlationIdCounter === 1 && journeySteps.length > 0) {
    console.log(`🎯 [Feature Flags] Initial generation (volume-based, regenerate every ${errorConfig.regenerate_every_n_transactions} transactions)`);
    currentFeatureFlags = autoGenerateFeatureFlagsServer(journeySteps, journeyData, errorConfig);
    console.log(`✅ [Feature Flags] Generated ${Object.keys(currentFeatureFlags).length} initial flags`);
    lastRegenerationCount = correlationIdCounter;
  }
  
  // Regenerate based on transaction volume
  if (shouldRegenerate && journeySteps.length > 0 && correlationIdCounter > 1) {
    console.log(`🔄 [Feature Flags] Regenerating after ${transactionsSinceRegen} transactions (correlationId: ${correlationIdCounter})`);
    currentFeatureFlags = autoGenerateFeatureFlagsServer(journeySteps, journeyData, errorConfig);
    console.log(`✅ [Feature Flags] Generated ${Object.keys(currentFeatureFlags).length} new flags`);
    lastRegenerationCount = correlationIdCounter;
  }
  
  return currentFeatureFlags;
}

// Server-side auto-generation (mirrors client logic)
function autoGenerateFeatureFlagsServer(steps, journeyData, errorConfig = DEFAULT_ERROR_CONFIG) {
  const stepNames = steps.map(s => (s.stepName || s.name || '').toLowerCase());
  const allStepText = stepNames.join(' ');
  const possibleFlags = [];
  
  // Use errors_per_transaction as base error rate (default 0 = no errors)
  const baseErrorRate = errorConfig.errors_per_transaction || 0;
  
  // Payment/Financial patterns
  if (allStepText.includes('payment') || allStepText.includes('checkout') || allStepText.includes('transaction')) {
    possibleFlags.push({
      name: 'Payment Gateway Timeout',
      errorType: 'timeout',
      errorRate: baseErrorRate * (0.8 + Math.random() * 0.4), // 80%-120% of base rate
      affectedSteps: steps.filter(s => 
        (s.stepName || s.name || '').toLowerCase().match(/payment|checkout|transaction|billing/)
      ).map(s => s.stepName || s.name),
      severity: 'CRITICAL',
      remediation: 'restart_payment_gateway',
      enabled: true
    });
  }
  
  // Inventory/Fulfillment patterns
  if (allStepText.includes('inventory') || allStepText.includes('fulfil') || allStepText.includes('stock') || allStepText.includes('order')) {
    possibleFlags.push({
      name: 'Inventory Sync Failure',
      errorType: 'service_unavailable',
      errorRate: baseErrorRate * (0.5 + Math.random() * 0.3), // 50%-80% of base rate
      affectedSteps: steps.filter(s => 
        (s.stepName || s.name || '').toLowerCase().match(/inventory|fulfil|stock|order/)
      ).map(s => s.stepName || s.name),
      severity: 'WARNING',
      remediation: 'trigger_inventory_sync',
      enabled: true
    });
  }
  
  // Validation/Verification patterns
  if (allStepText.includes('verif') || allStepText.includes('valid') || allStepText.includes('check')) {
    possibleFlags.push({
      name: 'Validation Timeout',
      errorType: 'validation_failed',
      errorRate: baseErrorRate * (0.3 + Math.random() * 0.2), // 30%-50% of base rate
      affectedSteps: steps.filter(s => 
        (s.stepName || s.name || '').toLowerCase().match(/verif|valid|check|customer|account/)
      ).map(s => s.stepName || s.name),
      severity: 'LOW',
      remediation: 'retry_with_defaults',
      enabled: true
    });
  }
  
  // Manufacturing patterns
  if (allStepText.includes('weld') || allStepText.includes('assembl') || allStepText.includes('machine') || allStepText.includes('robot') || allStepText.includes('paint') || allStepText.includes('inspect') || allStepText.includes('factory') || allStepText.includes('bodyshop') || allStepText.includes('endofline')) {
    possibleFlags.push({
      name: 'Robot Malfunction',
      errorType: 'internal_error',
      errorRate: baseErrorRate * (0.9 + Math.random() * 0.4), // 90%-130% of base rate
      affectedSteps: steps.filter(s => 
        (s.stepName || s.name || '').toLowerCase().match(/weld|assembl|machine|robot|fabricat|paint|inspect|factory|bodyshop|endofline|gate|release/)
      ).map(s => s.stepName || s.name),
      severity: 'CRITICAL',
      remediation: 'restart_robot_controller',
      enabled: true
    });
  }
  
  // Filter and randomly select 1-3 flags
  const validFlags = possibleFlags.filter(f => f.affectedSteps && f.affectedSteps.length > 0);
  
  if (validFlags.length === 0) {
    // Generic fallback
    validFlags.push({
      name: 'Service Timeout',
      errorType: 'timeout',
      errorRate: baseErrorRate,
      affectedSteps: steps.slice(0, Math.ceil(steps.length / 2)).map(s => s.stepName || s.name),
      severity: 'WARNING',
      remediation: 'restart_service',
      enabled: true
    });
  }
  
  const numToEnable = Math.min(validFlags.length, Math.floor(Math.random() * 3) + 1);
  const shuffled = validFlags.sort(() => 0.5 - Math.random());
  const selectedFlags = shuffled.slice(0, numToEnable);
  
  const flags = {};
  selectedFlags.forEach(flag => {
    const flagId = flag.name.toLowerCase().replace(/\s+/g, '_');
    flags[flagId] = flag;
  });
  
  // Log configuration being used
  console.log(`📊 [Feature Flags] Using error config: errors_per_transaction=${errorConfig.errors_per_transaction}, regenerate_every=${errorConfig.regenerate_every_n_transactions}`);
  
  return flags;
}

// Enhanced Dynatrace helpers with error tracking
const withCustomSpan = (name, callback) => {
  console.log('[dynatrace] Custom span:', name);
  return withErrorTracking(name, callback)();
};

const sendBusinessEvent = (eventType, data) => {
  console.log('[dynatrace] Business event:', eventType, data);
  
  // Business events not needed - OneAgent captures flattened rqBody automatically
  console.log('[dynatrace] OneAgent will capture flattened request structure for:', eventType);
  
  // Simple flattening of data for logging (no arrays, just values)
  const flattenedData = {};
  const flatten = (obj, prefix = '') => {
    if (!obj || typeof obj !== 'object') return;
    Object.keys(obj).forEach(key => {
      const value = obj[key];
      const newKey = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        flatten(value, newKey);
      } else if (value !== null && value !== undefined) {
        flattenedData[newKey] = String(value);
      }
    });
  };
  flatten(data);
  
  // Log flattened fields separately so they appear in logs as individual entries
  Object.keys(flattenedData).forEach(key => {
    if (key.startsWith('additional.') || key.startsWith('customer.') || key.startsWith('business.') || key.startsWith('trace.')) {
      console.log(`[bizevent-field] ${key}=${flattenedData[key]}`);
    }
  });
  
  // Make a lightweight HTTP call to an internal endpoint with flattened data as headers
  // This will be captured by OneAgent as a separate HTTP request with flattened fields
  try {
    const mainServerPort = process.env.MAIN_SERVER_PORT || '4000';
    const flattenedHeaders = {};
    
    // Add flattened fields as HTTP headers (OneAgent will capture these)
    Object.keys(flattenedData).forEach(key => {
      if (key.startsWith('additional.') || key.startsWith('customer.') || key.startsWith('business.') || key.startsWith('trace.')) {
        // HTTP headers can't have dots, so replace with dashes
        const headerKey = `x-biz-${key.replace(/\./g, '-')}`;
        const headerValue = String(flattenedData[key]).substring(0, 100); // Limit header length
        flattenedHeaders[headerKey] = headerValue;
      }
    });
    
    // Add core business event metadata
    flattenedHeaders['x-biz-event-type'] = eventType;
    flattenedHeaders['x-biz-correlation-id'] = flattenedData.correlationId || '';
    flattenedHeaders['x-biz-step-name'] = flattenedData.stepName || '';
    flattenedHeaders['x-biz-company'] = flattenedData.company || '';
    
    const postData = JSON.stringify(flattenedData);
    const options = {
      hostname: '127.0.0.1',
      port: mainServerPort,
      path: '/api/internal/bizevent',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        ...flattenedHeaders
      },
      timeout: 1000
    };
    
    const req = http.request(options, (res) => {
      // Consume response to complete the request
      res.on('data', () => {});
      res.on('end', () => {
        console.log(`[dynatrace] Business event HTTP call completed: ${res.statusCode}`);
      });
    });
    
    req.on('error', (err) => {
      // Ignore errors - this is just for OneAgent capture
      console.log(`[dynatrace] Business event HTTP call failed (expected): ${err.message}`);
    });
    
    req.on('timeout', () => {
      req.destroy();
    });
    
    req.write(postData);
    req.end();
    
  } catch (err) {
    // Ignore errors in business event HTTP call
    console.log(`[dynatrace] Business event HTTP call error (expected): ${err.message}`);
  }
};

// Old flattening function removed - using ultra-simple flattening in request processing instead

// Feature Flag Error Helpers
function getHttpStatusForErrorType(errorType) {
  const statusMap = {
    'timeout': 504,
    'service_unavailable': 503,
    'validation_failed': 400,
    'payment_declined': 402,
    'authentication_failed': 401,
    'rate_limit_exceeded': 429,
    'internal_error': 500
  };
  return statusMap[errorType] || 500;
}

function getErrorMessageForType(errorType, stepName) {
  const messages = {
    'timeout': `${stepName} service timeout after 5000ms`,
    'service_unavailable': `${stepName} service temporarily unavailable`,
    'validation_failed': `${stepName} validation failed - invalid data format`,
    'payment_declined': `Payment declined by ${stepName} processor`,
    'authentication_failed': `Authentication failed in ${stepName}`,
    'rate_limit_exceeded': `Rate limit exceeded for ${stepName}`,
    'internal_error': `Internal error in ${stepName} processing`
  };
  return messages[errorType] || `Unknown error in ${stepName}`;
}

function getRemediationAction(flagName) {
  const actions = {
    'payment_gateway_timeout': 'restart_payment_service',
    'inventory_sync_failure': 'trigger_inventory_sync',
    'validation_error': 'retry_with_defaults',
    'authentication_timeout': 'refresh_auth_tokens',
    'rate_limit_breach': 'enable_circuit_breaker'
  };
  return actions[flagName] || 'manual_intervention';
}

// Wait for a service health endpoint to respond on the given port
function waitForServiceReady(port, timeout = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    function check() {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 1000 }, (res) => {
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() - start < timeout) setTimeout(check, 150); else resolve(false);
      });
      req.on('timeout', () => { req.destroy(); if (Date.now() - start < timeout) setTimeout(check, 150); else resolve(false); });
      req.end();
    }
    check();
  });
}

// Get service name from command line arguments or environment
const serviceNameArg = process.argv.find((arg, index) => process.argv[index - 1] === '--service-name');
const serviceName = serviceNameArg || process.env.SERVICE_NAME;
const stepName = process.env.STEP_NAME;

// CRITICAL: Set process title immediately for Dynatrace detection
// This is what Dynatrace uses to identify the service
if (serviceName) {
  try {
    process.title = serviceName;
    // Also set argv[0] to the service name - this is crucial for Dynatrace
    if (process.argv && process.argv.length > 0) {
      process.argv[0] = serviceName;
    }
    // 🔑 DT_APPLICATION_ID: Overrides package.json name for Web application id
    // This is what OneAgent uses for service detection/naming
    process.env.DT_APPLICATION_ID = serviceName;
    
    // 🔑 DT_CUSTOM_PROP: Adds custom metadata properties to the service
    process.env.DT_CUSTOM_PROP = `dtServiceName=${serviceName} companyName=${process.env.COMPANY_NAME || 'unknown'} domain=${process.env.DOMAIN || 'unknown'} industryType=${process.env.INDUSTRY_TYPE || 'unknown'}`;
    
    // Internal env vars for app-level code
    process.env.DT_SERVICE_NAME = serviceName;
    process.env.DYNATRACE_SERVICE_NAME = serviceName;
    process.env.DT_CLUSTER_ID = serviceName;
    process.env.DT_NODE_ID = `${serviceName}-node`;
    console.log(`[dynamic-step-service] Set process identity to: ${serviceName}`);
  } catch (e) {
    console.error(`[dynamic-step-service] Failed to set process identity: ${e.message}`);
  }
}

// Generic step service that can handle any step name dynamically
function createStepService(serviceName, stepName) {
  // Convert stepName to proper service format if needed
  const properServiceName = getServiceNameFromStep(stepName || serviceName);
  
  createService(properServiceName, (app) => {
    // Add error handling middleware
    app.use(errorHandlingMiddleware(properServiceName));
    
    app.post('/process', async (req, res, next) => {
      const payload = req.body || {};
      const correlationId = req.correlationId;
      const thinkTimeMs = Number(payload.thinkTimeMs || 200);
      const currentStepName = payload.stepName || stepName;
      
      // Process payload to ensure single values for arrays (no flattening, just array simplification)
      const processedPayload = { ...payload };
      
      console.log(`[${properServiceName}] Processing payload with ${Object.keys(processedPayload).length} fields`);
      
      // The payload should already be simplified from journey-simulation.js
      // We'll just ensure any remaining arrays are converted to single values
      function simplifyArraysInObject(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        
        const simplified = {};
        Object.keys(obj).forEach(key => {
          const value = obj[key];
          if (Array.isArray(value) && value.length > 0) {
            // Pick ONE random item from any array
            const randomIndex = Math.floor(Math.random() * value.length);
            simplified[key] = value[randomIndex];
          } else if (typeof value === 'object' && value !== null) {
            // Recursively simplify nested objects
            simplified[key] = simplifyArraysInObject(value);
          } else {
            simplified[key] = value;
          }
        });
        return simplified;
      }
      
      // Simplify any remaining arrays in nested objects
      if (processedPayload.additionalFields) {
        processedPayload.additionalFields = simplifyArraysInObject(processedPayload.additionalFields);
        console.log(`[${properServiceName}] Simplified arrays in additionalFields`);
      }
      
      if (processedPayload.customerProfile) {
        processedPayload.customerProfile = simplifyArraysInObject(processedPayload.customerProfile);
        console.log(`[${properServiceName}] Simplified arrays in customerProfile`);
      }
      
      if (processedPayload.traceMetadata) {
        processedPayload.traceMetadata = simplifyArraysInObject(processedPayload.traceMetadata);
        console.log(`[${properServiceName}] Simplified arrays in traceMetadata`);
      }
      
      // Update the request body with the processed payload
      // hasError is already inside additionalFields from journey-simulation.js
      req.body = processedPayload;
      
      try {
        // Check for step errors first (both explicit and simulated)
        const stepError = checkForStepError(payload, null); // You can pass error profile here
        if (stepError) {
          console.error(`[${properServiceName}] Step error detected:`, stepError.message);
          throw stepError;
        }
        
        // Extract trace context from incoming request headers
        const incomingTraceParent = req.headers['traceparent'];
        const incomingTraceState = req.headers['tracestate'];
        const dynatraceTraceId = req.headers['x-dynatrace-trace-id'];
        
        // Generate trace IDs for distributed tracing
        function generateUUID() {
          return crypto.randomUUID();
        }
        
        let traceId, parentSpanId;
        
        if (incomingTraceParent) {
          // Parse W3C traceparent: 00-trace_id-parent_id-flags
          const parts = incomingTraceParent.split('-');
          if (parts.length === 4) {
            traceId = parts[1];
            parentSpanId = parts[2];
            console.log(`[${properServiceName}] Using incoming trace context: ${traceId.substring(0,8)}...`);
          }
        } else if (dynatraceTraceId) {
          traceId = dynatraceTraceId;
          parentSpanId = req.headers['x-dynatrace-parent-span-id'];
          console.log(`[${properServiceName}] Using Dynatrace trace context: ${traceId.substring(0,8)}...`);
        }
        
        // Fallback to payload or generate new
        if (!traceId) {
          traceId = payload.traceId || generateUUID().replace(/-/g, '');
          parentSpanId = payload.spanId || null;
        }
        
        const spanId = generateUUID().slice(0, 16).replace(/-/g, '');
        
        console.log(`[${properServiceName}] Trace context: traceId=${traceId.substring(0,8)}..., spanId=${spanId.substring(0,8)}..., parentSpanId=${parentSpanId ? parentSpanId.substring(0,8) + '...' : 'none'}`);
        
        // --- OneAgent Distributed Tracing Integration ---
        // Let OneAgent handle trace/span propagation automatically
        // Store journey context for business observability
        const journeyTrace = Array.isArray(payload.journeyTrace) ? [...payload.journeyTrace] : [];
        const stepEntry = {
          stepName: currentStepName,
          serviceName: properServiceName,
          timestamp: new Date().toISOString(),
          correlationId,
          success: true, // Will be updated if error occurs
          traceId: traceId.substring(0,8) + '...',
          spanId: spanId.substring(0,8) + '...'
        };
        journeyTrace.push(stepEntry);

      // Look up current step's data from the journey steps array for chained execution
      let currentStepData = null;
      if (payload.steps && Array.isArray(payload.steps)) {
        console.log(`[${properServiceName}] Looking for step data for: ${currentStepName}, Available steps:`, payload.steps.map(s => s.stepName || s.name));
        currentStepData = payload.steps.find(step => 
          step.stepName === currentStepName || 
          step.name === currentStepName ||
          step.serviceName === properServiceName
        );
        console.log(`[${properServiceName}] Found step data:`, currentStepData ? 'YES' : 'NO');
        if (currentStepData) {
          console.log(`[${properServiceName}] Step data details:`, JSON.stringify(currentStepData, null, 2));
        }
      } else {
        console.log(`[${properServiceName}] No steps array in payload`);
      }
      
      // Use step-specific data if found, otherwise use payload defaults
      const stepDescription = currentStepData?.description || payload.stepDescription || '';
      const stepCategory = currentStepData?.category || payload.stepCategory || '';
      const estimatedDuration = currentStepData?.estimatedDuration || payload.estimatedDuration;
      const businessRationale = currentStepData?.businessRationale || payload.businessRationale;
      const substeps = currentStepData?.substeps || payload.substeps;

      // Log service processing with step-specific details
      console.log(`[${properServiceName}] Processing step with payload:`, JSON.stringify({
        stepName: payload.stepName,
        stepIndex: payload.stepIndex,
        totalSteps: payload.totalSteps,
        stepDescription: stepDescription,
        stepCategory: stepCategory,
        subSteps: payload.subSteps,
        hasError: payload.hasError,
        errorType: payload.errorType,
        companyName: payload.companyName,
        domain: payload.domain,
        industryType: payload.industryType,
        correlationId: payload.correlationId,
        // Include Copilot duration fields for OneAgent capture (step-specific)
        estimatedDuration: estimatedDuration,
        businessRationale: businessRationale,
        category: stepCategory,
        substeps: substeps,
        estimatedDurationMs: payload.estimatedDurationMs
      }, null, 2));
      console.log(`[${properServiceName}] Current step name: ${currentStepName}`);
      console.log(`[${properServiceName}] Step-specific substeps:`, payload.subSteps || []);
      console.log(`[${properServiceName}] Journey trace so far:`, JSON.stringify(journeyTrace));

      // 🚦 Feature Flag Error Injection with Auto-Regeneration
      let errorInjected = null;
      
      // Fetch error config for THIS service (per-service targeting from Gremlin)
      // Check BOTH full service name (compound) AND base service name (clean)
      const fullServiceName = process.env.FULL_SERVICE_NAME || properServiceName;
      const baseServiceName = process.env.SERVICE_NAME || process.env.DT_SERVICE_NAME || properServiceName;
      const globalConfig = await fetchGlobalErrorConfig(fullServiceName, baseServiceName);
      
      // Extract error configuration from payload (allows override) or use global
      const errorConfig = {
        errors_per_transaction: payload.errorConfig?.errors_per_transaction ?? globalConfig.errors_per_transaction,
        errors_per_visit: payload.errorConfig?.errors_per_visit ?? globalConfig.errors_per_visit,
        errors_per_minute: payload.errorConfig?.errors_per_minute ?? globalConfig.errors_per_minute,
        regenerate_every_n_transactions: payload.errorConfig?.regenerate_every_n_transactions ?? globalConfig.regenerate_every_n_transactions
      };
      
      // Log if global config is being used (indicates Dynatrace control)
      if (!payload.errorConfig && globalConfig.errors_per_transaction !== DEFAULT_ERROR_CONFIG.errors_per_transaction) {
        console.log(`🌐 [Error Config] Using global config from API (Dynatrace controlled): ${globalConfig.errors_per_transaction}`);
      }
      
      // Check if errors are disabled (errors_per_transaction = 0)
      if (errorConfig.errors_per_transaction === 0) {
        console.log(`⏸️  [Feature Flags] Errors disabled (errors_per_transaction=0) - Self-healing active!`);
        featureFlags = {};
      } else {
        // Check and regenerate feature flags every N transactions
        let featureFlags = payload.featureFlags || {};
        if (Object.keys(featureFlags).length === 0) {
          // Use auto-generated flags if none provided
          featureFlags = checkAndRegenerateFeatureFlags(payload, errorConfig);
        } else {
          // Still track and potentially regenerate even with provided flags
          const regeneratedFlags = checkAndRegenerateFeatureFlags(payload, errorConfig);
          if (Object.keys(regeneratedFlags).length > 0) {
            featureFlags = regeneratedFlags;
            console.log(`🔄 [Feature Flags] Using regenerated flags (transaction: ${correlationIdCounter})`);
          }
        }
        
        // ═══ DIRECT INJECTION FALLBACK ═══
        // If pattern-based flag generation produced no flags (e.g. no steps array in payload,
        // or step name doesn't match any pattern), inject errors directly based on
        // errors_per_transaction rate. This ensures chaos injection ALWAYS works when
        // the Gremlin/Nemesis agent targets a specific service, regardless of step patterns.
        if (!featureFlags || Object.keys(featureFlags).length === 0) {
          const shouldError = Math.random() < errorConfig.errors_per_transaction;
          if (shouldError) {
            // Pick a realistic error type based on the step/service name
            const errorTypes = ['service_unavailable', 'timeout', 'internal_error', 'connection_refused'];
            const selectedType = errorTypes[Math.floor(Math.random() * errorTypes.length)];
            errorInjected = {
              feature_flag: 'chaos_direct_injection',
              error_type: selectedType,
              http_status: getHttpStatusForErrorType(selectedType),
              message: getErrorMessageForType(selectedType, currentStepName),
              remediation_action: 'restart_service',
              recoverable: true,
              retry_count: 0,
              injected_at: new Date().toISOString()
            };
            console.log(`🎯 [Chaos Direct] No pattern flags available — using direct injection at ${(errorConfig.errors_per_transaction * 100).toFixed(0)}% rate`);
            console.log(`🚨 Injecting error:`, JSON.stringify(errorInjected, null, 2));
          } else {
            console.log(`🎯 [Chaos Direct] No pattern flags — direct injection check: PASS (rate: ${(errorConfig.errors_per_transaction * 100).toFixed(0)}%)`);
          }
        } else if (featureFlags && typeof featureFlags === 'object') {
        
        // Check each active feature flag to see if this step is affected
        for (const [flagName, flagConfig] of Object.entries(featureFlags)) {
          if (flagConfig.enabled && flagConfig.affectedSteps) {
            const isAffectedStep = flagConfig.affectedSteps.some(step => 
              currentStepName.toLowerCase().includes(step.toLowerCase()) ||
              step.toLowerCase().includes(currentStepName.toLowerCase())
            );
            
            if (isAffectedStep) {
              // Apply error rate probability
              const shouldError = Math.random() < flagConfig.errorRate;
              
              if (shouldError) {
                errorInjected = {
                  feature_flag: flagName,
                  error_type: flagConfig.errorType || 'unknown',
                  http_status: getHttpStatusForErrorType(flagConfig.errorType),
                  message: getErrorMessageForType(flagConfig.errorType, currentStepName),
                  remediation_action: flagConfig.remediationAction || getRemediationAction(flagName),
                  recoverable: true,
                  retry_count: 0,
                  injected_at: new Date().toISOString()
                };
                
                console.log(`🚦 Feature flag triggered: ${flagName} on step ${currentStepName}`);
                console.log(`🚨 Injecting error:`, JSON.stringify(errorInjected, null, 2));
                break; // Only inject one error per request
              }
            }
          }
        }
        } // end if (featureFlags && typeof featureFlags === 'object')
      } // end else (errors enabled)

      // Simulate processing with realistic timing (add delay if error)
      const processingTime = errorInjected ? 
        Math.floor(Math.random() * 2000) + 3000 : // 3-5s for errors
        Math.floor(Math.random() * 200) + 100;    // 100-300ms normal

      // 🚨 If error injected by feature flag, record a REAL exception on the OTel span
      // so Dynatrace captures span.events[].exception.* for DQL queries
      // Uses await instead of setTimeout to preserve OTel active span context
      if (errorInjected) {
        // Simulate processing delay while keeping OTel span context alive
        await new Promise(resolve => setTimeout(resolve, processingTime));
        
        const httpStatus = errorInjected.http_status || 500;
        const errorMessage = errorInjected.message || `Feature flag error in ${currentStepName}`;
        
        // Create a real Error that will be recorded on the span
        const realError = new Error(errorMessage);
        realError.name = `FeatureFlagError_${errorInjected.error_type}`;
        realError.status = httpStatus;
        realError.httpStatus = httpStatus;
        
        // Add rich context so it shows up in Dynatrace exception details
        console.error(`🚨 [${properServiceName}] FEATURE FLAG EXCEPTION: ${errorMessage}`);
        console.error(`🚨 [${properServiceName}] Error Type: ${errorInjected.error_type} | HTTP ${httpStatus} | Flag: ${errorInjected.feature_flag}`);
        
        // Add custom attributes BEFORE the error response so OneAgent captures them on the span
        addCustomAttributes({
          'journey.step': currentStepName,
          'journey.service': properServiceName,
          'journey.correlationId': correlationId,
          'journey.company': processedPayload.companyName || 'unknown',
          'journey.domain': processedPayload.domain || 'unknown',
          'journey.industryType': processedPayload.industryType || 'unknown',
          'journey.processingTime': processingTime,
          'error.occurred': true,
          'error.feature_flag': errorInjected.feature_flag,
          'error.type': errorInjected.error_type,
          'error.http_status': httpStatus,
          'error.remediation_action': errorInjected.remediation_action || 'unknown'
        });
        
        // 🔑 Report as a real Dynatrace exception — this calls span.recordException() on the active OTel span
        // which creates span.events[] with exception.type, exception.message, exception.stack_trace
        reportError(realError, {
          'journey.step': currentStepName,
          'service.name': properServiceName,
          'correlation.id': correlationId,
          'http.status': httpStatus,
          'error.category': 'feature_flag_injection',
          'error.feature_flag': errorInjected.feature_flag,
          'error.type': errorInjected.error_type
        });
        
        // 🔑 Mark the span as failed — this calls span.setStatus(ERROR) on the active OTel span
        markSpanAsFailed(realError, {
          'journey.step': currentStepName,
          'service.name': properServiceName,
          'correlation.id': correlationId,
          'http.status': httpStatus,
          'error.category': 'feature_flag_injection'
        });
        
        // Send error business event
        sendErrorEvent('feature_flag_error', realError, {
          stepName: currentStepName,
          serviceName: properServiceName,
          correlationId,
          httpStatus,
          featureFlag: errorInjected.feature_flag,
          errorType: errorInjected.error_type,
          remediationAction: errorInjected.remediation_action
        });
        
        // 🎯 Send Dynatrace custom event via OneAgent SDK + Events API v2
        sendFeatureFlagCustomEvent({
          serviceName: properServiceName,
          stepName: currentStepName,
          featureFlag: errorInjected.feature_flag,
          errorType: errorInjected.error_type,
          httpStatus,
          correlationId,
          errorRate: errorConfig.errors_per_transaction,
          domain: processedPayload.domain || '',
          industryType: processedPayload.industryType || '',
          companyName: processedPayload.companyName || ''
        });
        
        // Set error headers for trace propagation
        res.setHeader('x-trace-error', 'true');
        res.setHeader('x-error-type', realError.name);
        res.setHeader('x-journey-failed', 'true');
        res.setHeader('x-http-status', httpStatus.toString());
        res.setHeader('x-correlation-id', correlationId);
        res.setHeader('x-dynatrace-trace-id', traceId);
        res.setHeader('x-dynatrace-span-id', spanId);
        const traceId32 = traceId.substring(0, 32).padEnd(32, '0');
        const spanId16 = spanId.substring(0, 16).padEnd(16, '0');
        res.setHeader('traceparent', `00-${traceId32}-${spanId16}-01`);
        
        // 🔑 Pass error through Express error handling so OneAgent captures it as a REAL exception
        // OneAgent instruments Express error middleware and records exceptions on the span
        // This makes exceptions visible in Dynatrace's 'Exceptions' tab on traces
        realError.responsePayload = {
          ...processedPayload,
          stepName: currentStepName,
          service: properServiceName,
          status: 'error',
          correlationId,
          processingTime,
          pid: process.pid,
          timestamp: new Date().toISOString(),
          error_occurred: true,
          error: errorInjected,
          journeyTrace,
          traceError: true,
          httpStatus,
          _traceInfo: {
            failed: true,
            errorMessage,
            errorType: realError.name,
            httpStatus,
            featureFlag: errorInjected.feature_flag,
            requestCorrelationId: correlationId
          }
        };
        return next(realError);
      }

      const finish = async () => {
        // Generate dynamic metadata based on step name
        const metadata = generateStepMetadata(currentStepName);

        // Add custom attributes to OneAgent span (simplified)
        const customAttributes = {
          'journey.step': currentStepName,
          'journey.service': properServiceName,
          'journey.correlationId': correlationId,
          'journey.company': processedPayload.companyName || 'unknown',
          'journey.domain': processedPayload.domain || 'unknown',
          'journey.industryType': processedPayload.industryType || 'unknown',
          'journey.processingTime': processingTime
        };
        
        addCustomAttributes(customAttributes);

        // ✅ OneAgent automatically captures this /process request as a bizevent via capture rules
        // No manual sendBusinessEvent() needed - the request payload itself becomes the bizevent
        console.log(`[${properServiceName}] Processing step ${currentStepName} - OneAgent will capture as bizevent`);

        let response = {
          // Include the clean processed payload without duplication
          ...processedPayload,
          stepName: currentStepName,
          service: properServiceName,
          status: 'completed',
          correlationId,
          processingTime,
          pid: process.pid,
          timestamp: new Date().toISOString(),
          // Include step-specific duration fields from the current step data
          stepDescription: stepDescription,
          stepCategory: stepCategory,
          estimatedDuration: estimatedDuration,
          businessRationale: businessRationale,
          duration: processedPayload.duration,
          substeps: substeps,
          metadata,
          journeyTrace,
          error_occurred: false
        };

        // No flattened fields duplication - the processedPayload already contains clean data

        // Include incoming trace headers in the response for validation (non-invasive)
        try {
          response.traceparent = incomingTraceParent || null;
          response.tracestate = incomingTraceState || null;
          response.x_dynatrace_trace_id = dynatraceTraceId || null;
          response.x_dynatrace_parent_span_id = req.headers['x-dynatrace-parent-span-id'] || null;
        } catch (e) {}


        // --- Chaining logic ---
        let nextStepName = null;
        let nextServiceName = undefined;
        
        console.log(`[${properServiceName}] 🔗 CHAINING LOGIC: Checking for next step...`);
        console.log(`[${properServiceName}] 🔗 Current step: ${currentStepName}`);
        console.log(`[${properServiceName}] 🔗 Has steps array: ${!!(payload.steps && Array.isArray(payload.steps))}`);
        if (payload.steps && Array.isArray(payload.steps)) {
          console.log(`[${properServiceName}] 🔗 Steps array length: ${payload.steps.length}`);
          console.log(`[${properServiceName}] 🔗 Steps array contents:`, JSON.stringify(payload.steps.map(s => ({ stepName: s.stepName, serviceName: s.serviceName })), null, 2));
          
          const currentIndex = payload.steps.findIndex(s =>
            (s.stepName === currentStepName) ||
            (s.name === currentStepName) ||
            (s.serviceName === properServiceName)
          );
          console.log(`[${properServiceName}] 🔗 Current step index: ${currentIndex} of ${payload.steps.length - 1}`);
          
          if (currentIndex >= 0 && currentIndex < payload.steps.length - 1) {
            const nextStep = payload.steps[currentIndex + 1];
            nextStepName = nextStep ? (nextStep.stepName || nextStep.name) : null;
            nextServiceName = nextStep && nextStep.serviceName ? nextStep.serviceName : (nextStepName ? getServiceNameFromStep(nextStepName) : undefined);
            console.log(`[${properServiceName}] 🔗 FOUND NEXT STEP: ${nextStepName} (service: ${nextServiceName})`);
          } else {
            console.log(`[${properServiceName}] 🔗 NO NEXT STEP: End of journey (current index: ${currentIndex})`);
            nextStepName = null;
            nextServiceName = undefined;
          }
        } else {
          console.log(`[${properServiceName}] 🔗 NO STEPS ARRAY in payload - cannot chain!`);
        }

        if (nextStepName && nextServiceName) {
          try {
            await new Promise(r => setTimeout(r, thinkTimeMs));
            // Ask main server to ensure next service is running and get its port
            let nextServicePort = null;
            try {
              const adminPort = process.env.MAIN_SERVER_PORT || '4000';
              nextServicePort = await new Promise((resolve, reject) => {
                const req = http.request({ hostname: '127.0.0.1', port: adminPort, path: '/api/admin/ensure-service', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => { 
                  let data = '';
                  res.on('data', chunk => data += chunk);
                  res.on('end', () => {
                    try {
                      const parsed = JSON.parse(data);
                      resolve(parsed.port || null);
                    } catch {
                      resolve(null);
                    }
                  });
                });
                req.on('error', () => resolve(null));
                req.end(JSON.stringify({ 
                  stepName: nextStepName, 
                  serviceName: nextServiceName,
                  context: {
                    companyName: payload.companyName,
                    domain: payload.domain,
                    industryType: payload.industryType,
                    journeyType: payload.journeyType,
                    stepName: nextStepName,
                    serviceName: nextServiceName,
                    category: nextStepData?.category || ''
                  }
                }));
              });
              console.log(`[${properServiceName}] Next service ${nextServiceName} allocated on port ${nextServicePort}`);
            } catch (e) {
              console.error(`[${properServiceName}] Failed to get next service port:`, e.message);
            }
            // Look up next step's specific data
            let nextStepData = null;
            if (payload.steps && Array.isArray(payload.steps)) {
              nextStepData = payload.steps.find(step => 
                step.stepName === nextStepName || 
                step.name === nextStepName ||
                step.serviceName === nextServiceName
              );
            }

            const nextPayload = {
              ...processedPayload,  // Use flattened payload instead of original
              stepName: nextStepName,
              serviceName: nextServiceName,
              // Add step-specific fields for the next step
              stepDescription: nextStepData?.description || '',
              stepCategory: nextStepData?.category || '',
              estimatedDuration: nextStepData?.estimatedDuration,
              businessRationale: nextStepData?.businessRationale,
              substeps: nextStepData?.substeps,
              estimatedDurationMs: nextStepData?.estimatedDuration ? nextStepData.estimatedDuration * 60 * 1000 : null,
              action: 'auto_chained',
              parentStep: currentStepName,
              correlationId,
              journeyId: payload.journeyId,
              domain: payload.domain,
              companyName: payload.companyName,
              industryType: payload.industryType,
              journeyType: payload.journeyType,
              thinkTimeMs,
              steps: payload.steps,
              traceId,
              spanId, // pass as parentSpanId to next
              journeyTrace
            };
            
            // Build proper trace headers for service-to-service call
            const traceHeaders = { 
              'x-correlation-id': correlationId,
              // W3C Trace Context format
              'traceparent': `00-${traceId.padEnd(32, '0')}-${spanId.padEnd(16, '0')}-01`,
              // Dynatrace specific headers
              'x-dynatrace-trace-id': traceId,
              'x-dynatrace-parent-span-id': spanId
            };
            
            // Pass through any incoming trace state
            if (incomingTraceState) {
              traceHeaders['tracestate'] = incomingTraceState;
            }
            
            console.log(`[${properServiceName}] Propagating trace to ${nextServiceName}: traceparent=${traceHeaders['traceparent']}`);
            
            // Use the port returned from ensure-service API (actual allocated port)
            const nextPort = nextServicePort || getServicePortFromStep(nextServiceName);
            console.log(`[${properServiceName}] Calling ${nextServiceName} on port ${nextPort}`);
            // Ensure next service is listening before calling
            await waitForServiceReady(nextPort, 5000);
            const next = await callService(nextServiceName, nextPayload, traceHeaders, nextPort);
            // Bubble up the full downstream trace to the current response; ensure our own span is included once
            if (next && Array.isArray(next.trace)) {
              const last = next.trace[next.trace.length - 1];
              // If our span isn't the last, append ours before adopting
              const hasCurrent = next.trace.some(s => s.spanId === spanId);
              response.trace = hasCurrent ? next.trace : [...next.trace, { traceId, spanId, parentSpanId, stepName: currentStepName }];
            }
            response.next = next;
          } catch (e) {
            response.nextError = e.message;
            console.error(`[${properServiceName}] Error calling next service:`, e.message);
          }
        }

        // Send trace context headers back in response for Dynatrace distributed tracing
        res.setHeader('x-dynatrace-trace-id', traceId);
        res.setHeader('x-dynatrace-span-id', spanId);
        if (parentSpanId) {
          res.setHeader('x-dynatrace-parent-span-id', parentSpanId);
        }
        // W3C Trace Context response header
        const traceId32 = traceId.substring(0, 32).padEnd(32, '0');
        const spanId16 = spanId.substring(0, 16).padEnd(16, '0');
        res.setHeader('traceparent', `00-${traceId32}-${spanId16}-01`);
        res.setHeader('x-correlation-id', correlationId);
        
        res.json(response);
      };

      // Use await to preserve OTel active span context (setTimeout loses it)
      await new Promise(resolve => setTimeout(resolve, processingTime));
      await finish();
      
    } catch (error) {
      // Handle any errors that occur during step processing
      console.error(`[${properServiceName}] Step processing error:`, error.message);
      
      // Ensure proper HTTP status code is set
      const httpStatus = error.status || error.httpStatus || 500;
      
      // Report the error to Dynatrace as a trace exception
      reportError(error, {
        'journey.step': currentStepName,
        'service.name': properServiceName,
        'correlation.id': correlationId,
        'http.status': httpStatus,
        'error.category': 'journey_step_failure'
      });
      
      // Mark trace as failed with comprehensive context
      markSpanAsFailed(error, {
        'journey.step': currentStepName,
        'service.name': properServiceName,
        'correlation.id': correlationId,
        'http.status': httpStatus,
        'error.category': 'journey_step_failure',
        'journey.company': processedPayload.companyName || 'unknown',
        'journey.domain': processedPayload.domain || 'unknown'
      });
      
      // Update journey trace to mark this step as failed
      const journeyTrace = Array.isArray(payload.journeyTrace) ? [...payload.journeyTrace] : [];
      const failedStepEntry = {
        stepName: currentStepName,
        serviceName: properServiceName,
        timestamp: new Date().toISOString(),
        correlationId,
        success: false,
        error: error.message,
        errorType: error.constructor.name,
        httpStatus: httpStatus
      };
      journeyTrace.push(failedStepEntry);
      
      // Send error business event with enhanced context
      sendErrorEvent('journey_step_failed', error, {
        stepName: currentStepName,
        serviceName: properServiceName,
        correlationId,
        httpStatus: httpStatus,
        company: processedPayload.companyName || 'unknown',
        domain: processedPayload.domain || 'unknown'
      });
      
      // OneAgent captures the bizevent from the /process request body natively
      // additionalFields.hasError was set in the request payload by journey-simulation.js
      
      // Build comprehensive error response
      const errorResponse = {
        ...processedPayload,  // Include flattened fields for consistency
        status: 'error',
        error: error.message,
        errorType: error.constructor.name,
        stepName: currentStepName,
        service: properServiceName,
        correlationId,
        timestamp: new Date().toISOString(),
        journeyTrace,
        traceError: true,
        pid: process.pid,
        httpStatus: httpStatus,
        // Add OneAgent-friendly trace failure markers
        _traceInfo: {
          failed: true,
          errorMessage: error.message,
          errorType: error.constructor.name,
          httpStatus: httpStatus,
          requestCorrelationId: correlationId
        }
      };
      
      // Set comprehensive error headers for trace propagation
      res.setHeader('x-trace-error', 'true');
      res.setHeader('x-error-type', error.constructor.name);
      res.setHeader('x-journey-failed', 'true');
      res.setHeader('x-http-status', httpStatus.toString());
      res.setHeader('x-correlation-id', correlationId);
      
      // 🔑 Pass error through Express error handling so OneAgent captures the exception
      console.log(`[${properServiceName}] Passing error to Express error handler for OneAgent capture (HTTP ${httpStatus})`);
      error.status = error.status || httpStatus;
      error.responsePayload = errorResponse;
      return next(error);
    }
    });

    // 🔑 Express error middleware — MUST be AFTER routes to catch next(error)
    // OneAgent instruments Express error handling and captures exceptions on the active span
    // This is what makes real exceptions visible in Dynatrace trace 'Exceptions' tab
    app.use((err, req, res, next) => {
      const status = err.status || err.httpStatus || 500;
      
      // Log that we're handling through Express error middleware (OneAgent will capture)
      console.log(`[${properServiceName}] 🎯 Express error middleware: ${err.name || 'Error'}: ${err.message} (HTTP ${status})`);
      
      // Send response payload if available (from feature-flag error or catch block)
      if (err.responsePayload) {
        return res.status(status).json(err.responsePayload);
      }
      
      // Fallback generic error response
      return res.status(status).json({
        status: 'error',
        error: err.message,
        errorType: err.name || 'Error',
        service: properServiceName,
        traceError: true,
        timestamp: new Date().toISOString()
      });
    });
  });
}

// Generate dynamic metadata based on step name
function generateStepMetadata(stepName) {
  const lowerStep = stepName.toLowerCase();
  
  // Discovery/Exploration type steps
  if (lowerStep.includes('discover') || lowerStep.includes('explor')) {
    return {
      itemsDiscovered: Math.floor(Math.random() * 100) + 50,
      touchpointsAnalyzed: Math.floor(Math.random() * 20) + 10,
      dataSourcesConnected: Math.floor(Math.random() * 5) + 3
    };
  }
  
  // Awareness/Marketing type steps
  if (lowerStep.includes('aware') || lowerStep.includes('market')) {
    return {
      impressionsGenerated: Math.floor(Math.random() * 10000) + 5000,
      channelsActivated: Math.floor(Math.random() * 8) + 4,
      audienceReach: Math.floor(Math.random() * 50000) + 25000
    };
  }
  
  // Consideration/Selection type steps
  if (lowerStep.includes('consider') || lowerStep.includes('select') || lowerStep.includes('evaluat')) {
    return {
      optionsEvaluated: Math.floor(Math.random() * 15) + 5,
      comparisonsMade: Math.floor(Math.random() * 8) + 3,
      criteriaAnalyzed: Math.floor(Math.random() * 20) + 10
    };
  }
  
  // Purchase/Process/Transaction type steps
  if (lowerStep.includes('purchase') || lowerStep.includes('process') || lowerStep.includes('transaction') || lowerStep.includes('start')) {
    return {
      transactionValue: Math.floor(Math.random() * 1000) + 100,
      processingMethod: ['automated', 'manual', 'hybrid'][Math.floor(Math.random() * 3)],
      conversionRate: (Math.random() * 0.05 + 0.02).toFixed(3)
    };
  }
  
  // Completion/Retention type steps
  if (lowerStep.includes('complet') || lowerStep.includes('retain') || lowerStep.includes('finish')) {
    return {
      completionRate: (Math.random() * 0.3 + 0.6).toFixed(3),
      satisfactionScore: (Math.random() * 2 + 8).toFixed(1),
      issuesResolved: Math.floor(Math.random() * 5)
    };
  }
  
  // PostProcess/Advocacy type steps
  if (lowerStep.includes('post') || lowerStep.includes('advocacy') || lowerStep.includes('follow')) {
    return {
      followUpActions: Math.floor(Math.random() * 10) + 2,
      referralsGenerated: Math.floor(Math.random() * 8) + 1,
      engagementScore: Math.floor(Math.random() * 4) + 7
    };
  }
  
  // Data Persistence/Storage type steps (MongoDB integration)
  if (lowerStep.includes('persist') || lowerStep.includes('storage') || lowerStep.includes('data') || 
      lowerStep.includes('archive') || lowerStep.includes('record') || lowerStep.includes('save')) {
    return {
      recordsStored: Math.floor(Math.random() * 50) + 10,
      dataIntegrityScore: (Math.random() * 0.05 + 0.95).toFixed(3),
      storageEfficiency: (Math.random() * 0.1 + 0.85).toFixed(3),
      backupStatus: 'completed',
      indexingTime: Math.floor(Math.random() * 100) + 50
    };
  }
  
  // Generic fallback
  return {
    itemsProcessed: Math.floor(Math.random() * 50) + 20,
    processingEfficiency: (Math.random() * 0.2 + 0.8).toFixed(3),
    qualityScore: (Math.random() * 2 + 8).toFixed(1)
  };
}

module.exports = { createStepService };

// Auto-start the service when this file is run directly
if (require.main === module) {
  // Get service name from command line arguments or environment
  const serviceNameArg = process.argv.find((arg, index) => process.argv[index - 1] === '--service-name');
  const serviceName = serviceNameArg || process.env.SERVICE_NAME || 'DynamicService';
  const stepName = process.env.STEP_NAME || 'DefaultStep';
  
  // Set process title and DT_CUSTOM_PROP immediately for Dynatrace detection
  try {
    process.title = serviceName;
    // 🔑 DT_APPLICATION_ID: Overrides package.json name for Web application id
    process.env.DT_APPLICATION_ID = serviceName;
    
    // 🔑 DT_CUSTOM_PROP: Adds custom metadata properties
    if (!process.env.DT_CUSTOM_PROP || !process.env.DT_CUSTOM_PROP.includes('dtServiceName=')) {
      process.env.DT_CUSTOM_PROP = `dtServiceName=${serviceName} companyName=${process.env.COMPANY_NAME || 'unknown'} domain=${process.env.DOMAIN || 'unknown'} industryType=${process.env.INDUSTRY_TYPE || 'unknown'}`;
    }
    console.log(`[dynamic-step-service] Set process title to: ${serviceName}`);
    console.log(`[dynamic-step-service] DT_CUSTOM_PROP: ${process.env.DT_CUSTOM_PROP}`);
  } catch (e) {
    console.error(`[dynamic-step-service] Failed to set process title: ${e.message}`);
  }
  
  console.log(`[dynamic-step-service] Starting service: ${serviceName} for step: ${stepName}`);
  createStepService(serviceName, stepName);
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZHluYW1pYy1zdGVwLXNlcnZpY2UuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJkeW5hbWljLXN0ZXAtc2VydmljZS5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIER5bmFtaWMgU3RlcCBTZXJ2aWNlIC0gQ3JlYXRlcyBzZXJ2aWNlcyB3aXRoIHByb3BlciBEeW5hdHJhY2UgaWRlbnRpZmljYXRpb25cbiAqIFRoaXMgc2VydmljZSBkeW5hbWljYWxseSBhZGFwdHMgaXRzIGlkZW50aXR5IGJhc2VkIG9uIHRoZSBzdGVwIG5hbWUgcHJvdmlkZWRcbiAqL1xuY29uc3QgeyBjcmVhdGVTZXJ2aWNlIH0gPSByZXF1aXJlKCcuL3NlcnZpY2UtcnVubmVyLmpzJyk7XG5jb25zdCB7IGNhbGxTZXJ2aWNlLCBnZXRTZXJ2aWNlTmFtZUZyb21TdGVwLCBnZXRTZXJ2aWNlUG9ydEZyb21TdGVwIH0gPSByZXF1aXJlKCcuL2NoaWxkLWNhbGxlci5qcycpO1xuY29uc3QgeyBcbiAgVHJhY2VkRXJyb3IsIFxuICB3aXRoRXJyb3JUcmFja2luZywgXG4gIGVycm9ySGFuZGxpbmdNaWRkbGV3YXJlLFxuICBjaGVja0ZvclN0ZXBFcnJvciwgXG4gIG1hcmtTcGFuQXNGYWlsZWQsIFxuICByZXBvcnRFcnJvcixcbiAgc2VuZEVycm9yRXZlbnQsXG4gIHNlbmRGZWF0dXJlRmxhZ0N1c3RvbUV2ZW50LFxuICBhZGRDdXN0b21BdHRyaWJ1dGVzIFxufSA9IHJlcXVpcmUoJy4vZHluYXRyYWNlLWVycm9yLWhlbHBlci5qcycpO1xuY29uc3QgaHR0cCA9IHJlcXVpcmUoJ2h0dHAnKTtcbmNvbnN0IGNyeXB0byA9IHJlcXVpcmUoJ2NyeXB0bycpO1xuXG4vLyDwn5qmIEZFQVRVUkUgRkxBRyBBVVRPLVJFR0VORVJBVElPTiBUUkFDS0VSXG5sZXQgY29ycmVsYXRpb25JZENvdW50ZXIgPSAwO1xubGV0IGN1cnJlbnRGZWF0dXJlRmxhZ3MgPSB7fTtcbmxldCBqb3VybmV5U3RlcHMgPSBbXTtcbmxldCBsYXN0UmVnZW5lcmF0aW9uQ291bnQgPSAwO1xuXG4vLyBEZWZhdWx0IGVycm9yIHJhdGUgY29uZmlndXJhdGlvbiAoY2FuIGJlIG92ZXJyaWRkZW4gdmlhIHBheWxvYWQgb3IgZ2xvYmFsIEFQSSlcbmNvbnN0IERFRkFVTFRfRVJST1JfQ09ORklHID0ge1xuICBlcnJvcnNfcGVyX3RyYW5zYWN0aW9uOiAwLCAgICAvLyBObyBlcnJvcnMgYnkgZGVmYXVsdCDigJQgR3JlbWxpbiBzZXRzIHBlci1zZXJ2aWNlIG92ZXJyaWRlc1xuICBlcnJvcnNfcGVyX3Zpc2l0OiAwLCAgICAgICAgICAvLyBObyBlcnJvcnMgYnkgZGVmYXVsdFxuICBlcnJvcnNfcGVyX21pbnV0ZTogMCwgICAgICAgICAvLyBObyBlcnJvcnMgYnkgZGVmYXVsdFxuICByZWdlbmVyYXRlX2V2ZXJ5X25fdHJhbnNhY3Rpb25zOiAxMDAgIC8vIFJlZ2VuZXJhdGUgZmxhZ3MgZXZlcnkgMTAwIHRyYW5zYWN0aW9uc1xufTtcblxuLy8gRmV0Y2ggZXJyb3IgY29uZmlnIGZyb20gbWFpbiBzZXJ2ZXIg4oCUIHBhc3NlcyBzZXJ2aWNlIG5hbWUgZm9yIHBlci1zZXJ2aWNlIHRhcmdldGluZ1xuLy8gSWYgdGhpcyBzZXJ2aWNlIGhhcyBhIHRhcmdldGVkIG92ZXJyaWRlIChmcm9tIEdyZW1saW4gY2hhb3MpLCBvbmx5IElUIGdldHMgdGhlIGVsZXZhdGVkIHJhdGVcbi8vIENoZWNrcyBCT1RIIGNvbXBvdW5kIG5hbWUgKGUuZy4sIFwiUGF5bWVudFNlcnZpY2UtU215dGhjc1Nob2VzXCIpIEFORCBiYXNlIG5hbWUgKGUuZy4sIFwiUGF5bWVudFNlcnZpY2VcIilcbmFzeW5jIGZ1bmN0aW9uIGZldGNoR2xvYmFsRXJyb3JDb25maWcobXlGdWxsU2VydmljZU5hbWUsIG15QmFzZVNlcnZpY2VOYW1lKSB7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgIC8vIEJ1aWxkIHF1ZXJ5IHN0cmluZyB3aXRoIEJPVEggc2VydmljZSBuYW1lcyBzbyBzZXJ2ZXIgY2FuIGNoZWNrIGVpdGhlclxuICAgIGNvbnN0IHBhcmFtcyA9IFtdO1xuICAgIGlmIChteUZ1bGxTZXJ2aWNlTmFtZSkgcGFyYW1zLnB1c2goYHNlcnZpY2U9JHtlbmNvZGVVUklDb21wb25lbnQobXlGdWxsU2VydmljZU5hbWUpfWApO1xuICAgIGlmIChteUJhc2VTZXJ2aWNlTmFtZSAmJiBteUJhc2VTZXJ2aWNlTmFtZSAhPT0gbXlGdWxsU2VydmljZU5hbWUpIHtcbiAgICAgIHBhcmFtcy5wdXNoKGBiYXNlU2VydmljZT0ke2VuY29kZVVSSUNvbXBvbmVudChteUJhc2VTZXJ2aWNlTmFtZSl9YCk7XG4gICAgfVxuICAgIGNvbnN0IHF1ZXJ5UGFyYW1zID0gcGFyYW1zLmxlbmd0aCA+IDAgPyBgPyR7cGFyYW1zLmpvaW4oJyYnKX1gIDogJyc7XG4gICAgXG4gICAgY29uc3Qgb3B0aW9ucyA9IHtcbiAgICAgIGhvc3RuYW1lOiAnMTI3LjAuMC4xJyxcbiAgICAgIHBvcnQ6IHByb2Nlc3MuZW52Lk1BSU5fU0VSVkVSX1BPUlQgfHwgODA4MCxcbiAgICAgIHBhdGg6IGAvYXBpL2ZlYXR1cmVfZmxhZyR7cXVlcnlQYXJhbXN9YCxcbiAgICAgIG1ldGhvZDogJ0dFVCcsXG4gICAgICB0aW1lb3V0OiA1MDBcbiAgICB9O1xuICAgIFxuICAgIGNvbnN0IHJlcSA9IGh0dHAucmVxdWVzdChvcHRpb25zLCAocmVzKSA9PiB7XG4gICAgICBsZXQgZGF0YSA9ICcnO1xuICAgICAgcmVzLm9uKCdkYXRhJywgY2h1bmsgPT4gZGF0YSArPSBjaHVuayk7XG4gICAgICByZXMub24oJ2VuZCcsICgpID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCByZXNwb25zZSA9IEpTT04ucGFyc2UoZGF0YSk7XG4gICAgICAgICAgaWYgKHJlc3BvbnNlLnN1Y2Nlc3MgJiYgcmVzcG9uc2UuZmxhZ3MpIHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKCfwn5OlIFtGZWF0dXJlIEZsYWdzXSBGZXRjaGVkIGZyb20gbWFpbiBzZXJ2ZXI6JywgcmVzcG9uc2UuZmxhZ3MpO1xuICAgICAgICAgICAgcmVzb2x2ZShyZXNwb25zZS5mbGFncyk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJlc29sdmUoREVGQVVMVF9FUlJPUl9DT05GSUcpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJlc29sdmUoREVGQVVMVF9FUlJPUl9DT05GSUcpO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICB9KTtcbiAgICBcbiAgICByZXEub24oJ2Vycm9yJywgKCkgPT4ge1xuICAgICAgLy8gU2lsZW50bHkgZmFsbCBiYWNrIHRvIGRlZmF1bHRzIGlmIG1haW4gc2VydmVyIG5vdCBhdmFpbGFibGVcbiAgICAgIHJlc29sdmUoREVGQVVMVF9FUlJPUl9DT05GSUcpO1xuICAgIH0pO1xuICAgIFxuICAgIHJlcS5vbigndGltZW91dCcsICgpID0+IHtcbiAgICAgIHJlcS5kZXN0cm95KCk7XG4gICAgICByZXNvbHZlKERFRkFVTFRfRVJST1JfQ09ORklHKTtcbiAgICB9KTtcbiAgICBcbiAgICByZXEuZW5kKCk7XG4gIH0pO1xufVxuXG4vLyBBdXRvLXJlZ2VuZXJhdGUgZmVhdHVyZSBmbGFncyBiYXNlZCBvbiB2b2x1bWVcbmZ1bmN0aW9uIGNoZWNrQW5kUmVnZW5lcmF0ZUZlYXR1cmVGbGFncyhqb3VybmV5RGF0YSwgZXJyb3JDb25maWcgPSBERUZBVUxUX0VSUk9SX0NPTkZJRykge1xuICBjb3JyZWxhdGlvbklkQ291bnRlcisrO1xuICBcbiAgLy8gU3RvcmUgam91cm5leSBzdGVwcyBmb3IgZmlyc3QgcmVxdWVzdCAtIGNoZWNrIG11bHRpcGxlIHBheWxvYWQgc2hhcGVzXG4gIGlmIChqb3VybmV5U3RlcHMubGVuZ3RoID09PSAwKSB7XG4gICAgY29uc3Qgc3RlcHMgPSBqb3VybmV5RGF0YT8uam91cm5leT8uc3RlcHMgfHwgam91cm5leURhdGE/LnN0ZXBzIHx8IFtdO1xuICAgIGlmIChzdGVwcy5sZW5ndGggPiAwKSB7XG4gICAgICBqb3VybmV5U3RlcHMgPSBzdGVwcztcbiAgICAgIGNvbnNvbGUubG9nKGDwn5OLIFtGZWF0dXJlIEZsYWdzXSBDYXB0dXJlZCAke2pvdXJuZXlTdGVwcy5sZW5ndGh9IGpvdXJuZXkgc3RlcHMgZm9yIGZsYWcgZ2VuZXJhdGlvbmApO1xuICAgIH1cbiAgfVxuICBcbiAgLy8gQ2FsY3VsYXRlIGlmIHdlIHNob3VsZCByZWdlbmVyYXRlIGJhc2VkIG9uIHRyYW5zYWN0aW9uIHZvbHVtZVxuICBjb25zdCB0cmFuc2FjdGlvbnNTaW5jZVJlZ2VuID0gY29ycmVsYXRpb25JZENvdW50ZXIgLSBsYXN0UmVnZW5lcmF0aW9uQ291bnQ7XG4gIGNvbnN0IHNob3VsZFJlZ2VuZXJhdGUgPSB0cmFuc2FjdGlvbnNTaW5jZVJlZ2VuID49IGVycm9yQ29uZmlnLnJlZ2VuZXJhdGVfZXZlcnlfbl90cmFuc2FjdGlvbnM7XG4gIFxuICAvLyBHZW5lcmF0ZSBpbml0aWFsIGZsYWdzIG9uIGZpcnN0IHJlcXVlc3RcbiAgaWYgKGNvcnJlbGF0aW9uSWRDb3VudGVyID09PSAxICYmIGpvdXJuZXlTdGVwcy5sZW5ndGggPiAwKSB7XG4gICAgY29uc29sZS5sb2coYPCfjq8gW0ZlYXR1cmUgRmxhZ3NdIEluaXRpYWwgZ2VuZXJhdGlvbiAodm9sdW1lLWJhc2VkLCByZWdlbmVyYXRlIGV2ZXJ5ICR7ZXJyb3JDb25maWcucmVnZW5lcmF0ZV9ldmVyeV9uX3RyYW5zYWN0aW9uc30gdHJhbnNhY3Rpb25zKWApO1xuICAgIGN1cnJlbnRGZWF0dXJlRmxhZ3MgPSBhdXRvR2VuZXJhdGVGZWF0dXJlRmxhZ3NTZXJ2ZXIoam91cm5leVN0ZXBzLCBqb3VybmV5RGF0YSwgZXJyb3JDb25maWcpO1xuICAgIGNvbnNvbGUubG9nKGDinIUgW0ZlYXR1cmUgRmxhZ3NdIEdlbmVyYXRlZCAke09iamVjdC5rZXlzKGN1cnJlbnRGZWF0dXJlRmxhZ3MpLmxlbmd0aH0gaW5pdGlhbCBmbGFnc2ApO1xuICAgIGxhc3RSZWdlbmVyYXRpb25Db3VudCA9IGNvcnJlbGF0aW9uSWRDb3VudGVyO1xuICB9XG4gIFxuICAvLyBSZWdlbmVyYXRlIGJhc2VkIG9uIHRyYW5zYWN0aW9uIHZvbHVtZVxuICBpZiAoc2hvdWxkUmVnZW5lcmF0ZSAmJiBqb3VybmV5U3RlcHMubGVuZ3RoID4gMCAmJiBjb3JyZWxhdGlvbklkQ291bnRlciA+IDEpIHtcbiAgICBjb25zb2xlLmxvZyhg8J+UhCBbRmVhdHVyZSBGbGFnc10gUmVnZW5lcmF0aW5nIGFmdGVyICR7dHJhbnNhY3Rpb25zU2luY2VSZWdlbn0gdHJhbnNhY3Rpb25zIChjb3JyZWxhdGlvbklkOiAke2NvcnJlbGF0aW9uSWRDb3VudGVyfSlgKTtcbiAgICBjdXJyZW50RmVhdHVyZUZsYWdzID0gYXV0b0dlbmVyYXRlRmVhdHVyZUZsYWdzU2VydmVyKGpvdXJuZXlTdGVwcywgam91cm5leURhdGEsIGVycm9yQ29uZmlnKTtcbiAgICBjb25zb2xlLmxvZyhg4pyFIFtGZWF0dXJlIEZsYWdzXSBHZW5lcmF0ZWQgJHtPYmplY3Qua2V5cyhjdXJyZW50RmVhdHVyZUZsYWdzKS5sZW5ndGh9IG5ldyBmbGFnc2ApO1xuICAgIGxhc3RSZWdlbmVyYXRpb25Db3VudCA9IGNvcnJlbGF0aW9uSWRDb3VudGVyO1xuICB9XG4gIFxuICByZXR1cm4gY3VycmVudEZlYXR1cmVGbGFncztcbn1cblxuLy8gU2VydmVyLXNpZGUgYXV0by1nZW5lcmF0aW9uIChtaXJyb3JzIGNsaWVudCBsb2dpYylcbmZ1bmN0aW9uIGF1dG9HZW5lcmF0ZUZlYXR1cmVGbGFnc1NlcnZlcihzdGVwcywgam91cm5leURhdGEsIGVycm9yQ29uZmlnID0gREVGQVVMVF9FUlJPUl9DT05GSUcpIHtcbiAgY29uc3Qgc3RlcE5hbWVzID0gc3RlcHMubWFwKHMgPT4gKHMuc3RlcE5hbWUgfHwgcy5uYW1lIHx8ICcnKS50b0xvd2VyQ2FzZSgpKTtcbiAgY29uc3QgYWxsU3RlcFRleHQgPSBzdGVwTmFtZXMuam9pbignICcpO1xuICBjb25zdCBwb3NzaWJsZUZsYWdzID0gW107XG4gIFxuICAvLyBVc2UgZXJyb3JzX3Blcl90cmFuc2FjdGlvbiBhcyBiYXNlIGVycm9yIHJhdGUgKGRlZmF1bHQgMCA9IG5vIGVycm9ycylcbiAgY29uc3QgYmFzZUVycm9yUmF0ZSA9IGVycm9yQ29uZmlnLmVycm9yc19wZXJfdHJhbnNhY3Rpb24gfHwgMDtcbiAgXG4gIC8vIFBheW1lbnQvRmluYW5jaWFsIHBhdHRlcm5zXG4gIGlmIChhbGxTdGVwVGV4dC5pbmNsdWRlcygncGF5bWVudCcpIHx8IGFsbFN0ZXBUZXh0LmluY2x1ZGVzKCdjaGVja291dCcpIHx8IGFsbFN0ZXBUZXh0LmluY2x1ZGVzKCd0cmFuc2FjdGlvbicpKSB7XG4gICAgcG9zc2libGVGbGFncy5wdXNoKHtcbiAgICAgIG5hbWU6ICdQYXltZW50IEdhdGV3YXkgVGltZW91dCcsXG4gICAgICBlcnJvclR5cGU6ICd0aW1lb3V0JyxcbiAgICAgIGVycm9yUmF0ZTogYmFzZUVycm9yUmF0ZSAqICgwLjggKyBNYXRoLnJhbmRvbSgpICogMC40KSwgLy8gODAlLTEyMCUgb2YgYmFzZSByYXRlXG4gICAgICBhZmZlY3RlZFN0ZXBzOiBzdGVwcy5maWx0ZXIocyA9PiBcbiAgICAgICAgKHMuc3RlcE5hbWUgfHwgcy5uYW1lIHx8ICcnKS50b0xvd2VyQ2FzZSgpLm1hdGNoKC9wYXltZW50fGNoZWNrb3V0fHRyYW5zYWN0aW9ufGJpbGxpbmcvKVxuICAgICAgKS5tYXAocyA9PiBzLnN0ZXBOYW1lIHx8IHMubmFtZSksXG4gICAgICBzZXZlcml0eTogJ0NSSVRJQ0FMJyxcbiAgICAgIHJlbWVkaWF0aW9uOiAncmVzdGFydF9wYXltZW50X2dhdGV3YXknLFxuICAgICAgZW5hYmxlZDogdHJ1ZVxuICAgIH0pO1xuICB9XG4gIFxuICAvLyBJbnZlbnRvcnkvRnVsZmlsbG1lbnQgcGF0dGVybnNcbiAgaWYgKGFsbFN0ZXBUZXh0LmluY2x1ZGVzKCdpbnZlbnRvcnknKSB8fCBhbGxTdGVwVGV4dC5pbmNsdWRlcygnZnVsZmlsJykgfHwgYWxsU3RlcFRleHQuaW5jbHVkZXMoJ3N0b2NrJykgfHwgYWxsU3RlcFRleHQuaW5jbHVkZXMoJ29yZGVyJykpIHtcbiAgICBwb3NzaWJsZUZsYWdzLnB1c2goe1xuICAgICAgbmFtZTogJ0ludmVudG9yeSBTeW5jIEZhaWx1cmUnLFxuICAgICAgZXJyb3JUeXBlOiAnc2VydmljZV91bmF2YWlsYWJsZScsXG4gICAgICBlcnJvclJhdGU6IGJhc2VFcnJvclJhdGUgKiAoMC41ICsgTWF0aC5yYW5kb20oKSAqIDAuMyksIC8vIDUwJS04MCUgb2YgYmFzZSByYXRlXG4gICAgICBhZmZlY3RlZFN0ZXBzOiBzdGVwcy5maWx0ZXIocyA9PiBcbiAgICAgICAgKHMuc3RlcE5hbWUgfHwgcy5uYW1lIHx8ICcnKS50b0xvd2VyQ2FzZSgpLm1hdGNoKC9pbnZlbnRvcnl8ZnVsZmlsfHN0b2NrfG9yZGVyLylcbiAgICAgICkubWFwKHMgPT4gcy5zdGVwTmFtZSB8fCBzLm5hbWUpLFxuICAgICAgc2V2ZXJpdHk6ICdXQVJOSU5HJyxcbiAgICAgIHJlbWVkaWF0aW9uOiAndHJpZ2dlcl9pbnZlbnRvcnlfc3luYycsXG4gICAgICBlbmFibGVkOiB0cnVlXG4gICAgfSk7XG4gIH1cbiAgXG4gIC8vIFZhbGlkYXRpb24vVmVyaWZpY2F0aW9uIHBhdHRlcm5zXG4gIGlmIChhbGxTdGVwVGV4dC5pbmNsdWRlcygndmVyaWYnKSB8fCBhbGxTdGVwVGV4dC5pbmNsdWRlcygndmFsaWQnKSB8fCBhbGxTdGVwVGV4dC5pbmNsdWRlcygnY2hlY2snKSkge1xuICAgIHBvc3NpYmxlRmxhZ3MucHVzaCh7XG4gICAgICBuYW1lOiAnVmFsaWRhdGlvbiBUaW1lb3V0JyxcbiAgICAgIGVycm9yVHlwZTogJ3ZhbGlkYXRpb25fZmFpbGVkJyxcbiAgICAgIGVycm9yUmF0ZTogYmFzZUVycm9yUmF0ZSAqICgwLjMgKyBNYXRoLnJhbmRvbSgpICogMC4yKSwgLy8gMzAlLTUwJSBvZiBiYXNlIHJhdGVcbiAgICAgIGFmZmVjdGVkU3RlcHM6IHN0ZXBzLmZpbHRlcihzID0+IFxuICAgICAgICAocy5zdGVwTmFtZSB8fCBzLm5hbWUgfHwgJycpLnRvTG93ZXJDYXNlKCkubWF0Y2goL3ZlcmlmfHZhbGlkfGNoZWNrfGN1c3RvbWVyfGFjY291bnQvKVxuICAgICAgKS5tYXAocyA9PiBzLnN0ZXBOYW1lIHx8IHMubmFtZSksXG4gICAgICBzZXZlcml0eTogJ0xPVycsXG4gICAgICByZW1lZGlhdGlvbjogJ3JldHJ5X3dpdGhfZGVmYXVsdHMnLFxuICAgICAgZW5hYmxlZDogdHJ1ZVxuICAgIH0pO1xuICB9XG4gIFxuICAvLyBNYW51ZmFjdHVyaW5nIHBhdHRlcm5zXG4gIGlmIChhbGxTdGVwVGV4dC5pbmNsdWRlcygnd2VsZCcpIHx8IGFsbFN0ZXBUZXh0LmluY2x1ZGVzKCdhc3NlbWJsJykgfHwgYWxsU3RlcFRleHQuaW5jbHVkZXMoJ21hY2hpbmUnKSB8fCBhbGxTdGVwVGV4dC5pbmNsdWRlcygncm9ib3QnKSB8fCBhbGxTdGVwVGV4dC5pbmNsdWRlcygncGFpbnQnKSB8fCBhbGxTdGVwVGV4dC5pbmNsdWRlcygnaW5zcGVjdCcpIHx8IGFsbFN0ZXBUZXh0LmluY2x1ZGVzKCdmYWN0b3J5JykgfHwgYWxsU3RlcFRleHQuaW5jbHVkZXMoJ2JvZHlzaG9wJykgfHwgYWxsU3RlcFRleHQuaW5jbHVkZXMoJ2VuZG9mbGluZScpKSB7XG4gICAgcG9zc2libGVGbGFncy5wdXNoKHtcbiAgICAgIG5hbWU6ICdSb2JvdCBNYWxmdW5jdGlvbicsXG4gICAgICBlcnJvclR5cGU6ICdpbnRlcm5hbF9lcnJvcicsXG4gICAgICBlcnJvclJhdGU6IGJhc2VFcnJvclJhdGUgKiAoMC45ICsgTWF0aC5yYW5kb20oKSAqIDAuNCksIC8vIDkwJS0xMzAlIG9mIGJhc2UgcmF0ZVxuICAgICAgYWZmZWN0ZWRTdGVwczogc3RlcHMuZmlsdGVyKHMgPT4gXG4gICAgICAgIChzLnN0ZXBOYW1lIHx8IHMubmFtZSB8fCAnJykudG9Mb3dlckNhc2UoKS5tYXRjaCgvd2VsZHxhc3NlbWJsfG1hY2hpbmV8cm9ib3R8ZmFicmljYXR8cGFpbnR8aW5zcGVjdHxmYWN0b3J5fGJvZHlzaG9wfGVuZG9mbGluZXxnYXRlfHJlbGVhc2UvKVxuICAgICAgKS5tYXAocyA9PiBzLnN0ZXBOYW1lIHx8IHMubmFtZSksXG4gICAgICBzZXZlcml0eTogJ0NSSVRJQ0FMJyxcbiAgICAgIHJlbWVkaWF0aW9uOiAncmVzdGFydF9yb2JvdF9jb250cm9sbGVyJyxcbiAgICAgIGVuYWJsZWQ6IHRydWVcbiAgICB9KTtcbiAgfVxuICBcbiAgLy8gRmlsdGVyIGFuZCByYW5kb21seSBzZWxlY3QgMS0zIGZsYWdzXG4gIGNvbnN0IHZhbGlkRmxhZ3MgPSBwb3NzaWJsZUZsYWdzLmZpbHRlcihmID0+IGYuYWZmZWN0ZWRTdGVwcyAmJiBmLmFmZmVjdGVkU3RlcHMubGVuZ3RoID4gMCk7XG4gIFxuICBpZiAodmFsaWRGbGFncy5sZW5ndGggPT09IDApIHtcbiAgICAvLyBHZW5lcmljIGZhbGxiYWNrXG4gICAgdmFsaWRGbGFncy5wdXNoKHtcbiAgICAgIG5hbWU6ICdTZXJ2aWNlIFRpbWVvdXQnLFxuICAgICAgZXJyb3JUeXBlOiAndGltZW91dCcsXG4gICAgICBlcnJvclJhdGU6IGJhc2VFcnJvclJhdGUsXG4gICAgICBhZmZlY3RlZFN0ZXBzOiBzdGVwcy5zbGljZSgwLCBNYXRoLmNlaWwoc3RlcHMubGVuZ3RoIC8gMikpLm1hcChzID0+IHMuc3RlcE5hbWUgfHwgcy5uYW1lKSxcbiAgICAgIHNldmVyaXR5OiAnV0FSTklORycsXG4gICAgICByZW1lZGlhdGlvbjogJ3Jlc3RhcnRfc2VydmljZScsXG4gICAgICBlbmFibGVkOiB0cnVlXG4gICAgfSk7XG4gIH1cbiAgXG4gIGNvbnN0IG51bVRvRW5hYmxlID0gTWF0aC5taW4odmFsaWRGbGFncy5sZW5ndGgsIE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIDMpICsgMSk7XG4gIGNvbnN0IHNodWZmbGVkID0gdmFsaWRGbGFncy5zb3J0KCgpID0+IDAuNSAtIE1hdGgucmFuZG9tKCkpO1xuICBjb25zdCBzZWxlY3RlZEZsYWdzID0gc2h1ZmZsZWQuc2xpY2UoMCwgbnVtVG9FbmFibGUpO1xuICBcbiAgY29uc3QgZmxhZ3MgPSB7fTtcbiAgc2VsZWN0ZWRGbGFncy5mb3JFYWNoKGZsYWcgPT4ge1xuICAgIGNvbnN0IGZsYWdJZCA9IGZsYWcubmFtZS50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1xccysvZywgJ18nKTtcbiAgICBmbGFnc1tmbGFnSWRdID0gZmxhZztcbiAgfSk7XG4gIFxuICAvLyBMb2cgY29uZmlndXJhdGlvbiBiZWluZyB1c2VkXG4gIGNvbnNvbGUubG9nKGDwn5OKIFtGZWF0dXJlIEZsYWdzXSBVc2luZyBlcnJvciBjb25maWc6IGVycm9yc19wZXJfdHJhbnNhY3Rpb249JHtlcnJvckNvbmZpZy5lcnJvcnNfcGVyX3RyYW5zYWN0aW9ufSwgcmVnZW5lcmF0ZV9ldmVyeT0ke2Vycm9yQ29uZmlnLnJlZ2VuZXJhdGVfZXZlcnlfbl90cmFuc2FjdGlvbnN9YCk7XG4gIFxuICByZXR1cm4gZmxhZ3M7XG59XG5cbi8vIEVuaGFuY2VkIER5bmF0cmFjZSBoZWxwZXJzIHdpdGggZXJyb3IgdHJhY2tpbmdcbmNvbnN0IHdpdGhDdXN0b21TcGFuID0gKG5hbWUsIGNhbGxiYWNrKSA9PiB7XG4gIGNvbnNvbGUubG9nKCdbZHluYXRyYWNlXSBDdXN0b20gc3BhbjonLCBuYW1lKTtcbiAgcmV0dXJuIHdpdGhFcnJvclRyYWNraW5nKG5hbWUsIGNhbGxiYWNrKSgpO1xufTtcblxuY29uc3Qgc2VuZEJ1c2luZXNzRXZlbnQgPSAoZXZlbnRUeXBlLCBkYXRhKSA9PiB7XG4gIGNvbnNvbGUubG9nKCdbZHluYXRyYWNlXSBCdXNpbmVzcyBldmVudDonLCBldmVudFR5cGUsIGRhdGEpO1xuICBcbiAgLy8gQnVzaW5lc3MgZXZlbnRzIG5vdCBuZWVkZWQgLSBPbmVBZ2VudCBjYXB0dXJlcyBmbGF0dGVuZWQgcnFCb2R5IGF1dG9tYXRpY2FsbHlcbiAgY29uc29sZS5sb2coJ1tkeW5hdHJhY2VdIE9uZUFnZW50IHdpbGwgY2FwdHVyZSBmbGF0dGVuZWQgcmVxdWVzdCBzdHJ1Y3R1cmUgZm9yOicsIGV2ZW50VHlwZSk7XG4gIFxuICAvLyBTaW1wbGUgZmxhdHRlbmluZyBvZiBkYXRhIGZvciBsb2dnaW5nIChubyBhcnJheXMsIGp1c3QgdmFsdWVzKVxuICBjb25zdCBmbGF0dGVuZWREYXRhID0ge307XG4gIGNvbnN0IGZsYXR0ZW4gPSAob2JqLCBwcmVmaXggPSAnJykgPT4ge1xuICAgIGlmICghb2JqIHx8IHR5cGVvZiBvYmogIT09ICdvYmplY3QnKSByZXR1cm47XG4gICAgT2JqZWN0LmtleXMob2JqKS5mb3JFYWNoKGtleSA9PiB7XG4gICAgICBjb25zdCB2YWx1ZSA9IG9ialtrZXldO1xuICAgICAgY29uc3QgbmV3S2V5ID0gcHJlZml4ID8gYCR7cHJlZml4fS4ke2tleX1gIDoga2V5O1xuICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcgJiYgdmFsdWUgIT09IG51bGwgJiYgIUFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgIGZsYXR0ZW4odmFsdWUsIG5ld0tleSk7XG4gICAgICB9IGVsc2UgaWYgKHZhbHVlICE9PSBudWxsICYmIHZhbHVlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgZmxhdHRlbmVkRGF0YVtuZXdLZXldID0gU3RyaW5nKHZhbHVlKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfTtcbiAgZmxhdHRlbihkYXRhKTtcbiAgXG4gIC8vIExvZyBmbGF0dGVuZWQgZmllbGRzIHNlcGFyYXRlbHkgc28gdGhleSBhcHBlYXIgaW4gbG9ncyBhcyBpbmRpdmlkdWFsIGVudHJpZXNcbiAgT2JqZWN0LmtleXMoZmxhdHRlbmVkRGF0YSkuZm9yRWFjaChrZXkgPT4ge1xuICAgIGlmIChrZXkuc3RhcnRzV2l0aCgnYWRkaXRpb25hbC4nKSB8fCBrZXkuc3RhcnRzV2l0aCgnY3VzdG9tZXIuJykgfHwga2V5LnN0YXJ0c1dpdGgoJ2J1c2luZXNzLicpIHx8IGtleS5zdGFydHNXaXRoKCd0cmFjZS4nKSkge1xuICAgICAgY29uc29sZS5sb2coYFtiaXpldmVudC1maWVsZF0gJHtrZXl9PSR7ZmxhdHRlbmVkRGF0YVtrZXldfWApO1xuICAgIH1cbiAgfSk7XG4gIFxuICAvLyBNYWtlIGEgbGlnaHR3ZWlnaHQgSFRUUCBjYWxsIHRvIGFuIGludGVybmFsIGVuZHBvaW50IHdpdGggZmxhdHRlbmVkIGRhdGEgYXMgaGVhZGVyc1xuICAvLyBUaGlzIHdpbGwgYmUgY2FwdHVyZWQgYnkgT25lQWdlbnQgYXMgYSBzZXBhcmF0ZSBIVFRQIHJlcXVlc3Qgd2l0aCBmbGF0dGVuZWQgZmllbGRzXG4gIHRyeSB7XG4gICAgY29uc3QgbWFpblNlcnZlclBvcnQgPSBwcm9jZXNzLmVudi5NQUlOX1NFUlZFUl9QT1JUIHx8ICc0MDAwJztcbiAgICBjb25zdCBmbGF0dGVuZWRIZWFkZXJzID0ge307XG4gICAgXG4gICAgLy8gQWRkIGZsYXR0ZW5lZCBmaWVsZHMgYXMgSFRUUCBoZWFkZXJzIChPbmVBZ2VudCB3aWxsIGNhcHR1cmUgdGhlc2UpXG4gICAgT2JqZWN0LmtleXMoZmxhdHRlbmVkRGF0YSkuZm9yRWFjaChrZXkgPT4ge1xuICAgICAgaWYgKGtleS5zdGFydHNXaXRoKCdhZGRpdGlvbmFsLicpIHx8IGtleS5zdGFydHNXaXRoKCdjdXN0b21lci4nKSB8fCBrZXkuc3RhcnRzV2l0aCgnYnVzaW5lc3MuJykgfHwga2V5LnN0YXJ0c1dpdGgoJ3RyYWNlLicpKSB7XG4gICAgICAgIC8vIEhUVFAgaGVhZGVycyBjYW4ndCBoYXZlIGRvdHMsIHNvIHJlcGxhY2Ugd2l0aCBkYXNoZXNcbiAgICAgICAgY29uc3QgaGVhZGVyS2V5ID0gYHgtYml6LSR7a2V5LnJlcGxhY2UoL1xcLi9nLCAnLScpfWA7XG4gICAgICAgIGNvbnN0IGhlYWRlclZhbHVlID0gU3RyaW5nKGZsYXR0ZW5lZERhdGFba2V5XSkuc3Vic3RyaW5nKDAsIDEwMCk7IC8vIExpbWl0IGhlYWRlciBsZW5ndGhcbiAgICAgICAgZmxhdHRlbmVkSGVhZGVyc1toZWFkZXJLZXldID0gaGVhZGVyVmFsdWU7XG4gICAgICB9XG4gICAgfSk7XG4gICAgXG4gICAgLy8gQWRkIGNvcmUgYnVzaW5lc3MgZXZlbnQgbWV0YWRhdGFcbiAgICBmbGF0dGVuZWRIZWFkZXJzWyd4LWJpei1ldmVudC10eXBlJ10gPSBldmVudFR5cGU7XG4gICAgZmxhdHRlbmVkSGVhZGVyc1sneC1iaXotY29ycmVsYXRpb24taWQnXSA9IGZsYXR0ZW5lZERhdGEuY29ycmVsYXRpb25JZCB8fCAnJztcbiAgICBmbGF0dGVuZWRIZWFkZXJzWyd4LWJpei1zdGVwLW5hbWUnXSA9IGZsYXR0ZW5lZERhdGEuc3RlcE5hbWUgfHwgJyc7XG4gICAgZmxhdHRlbmVkSGVhZGVyc1sneC1iaXotY29tcGFueSddID0gZmxhdHRlbmVkRGF0YS5jb21wYW55IHx8ICcnO1xuICAgIFxuICAgIGNvbnN0IHBvc3REYXRhID0gSlNPTi5zdHJpbmdpZnkoZmxhdHRlbmVkRGF0YSk7XG4gICAgY29uc3Qgb3B0aW9ucyA9IHtcbiAgICAgIGhvc3RuYW1lOiAnMTI3LjAuMC4xJyxcbiAgICAgIHBvcnQ6IG1haW5TZXJ2ZXJQb3J0LFxuICAgICAgcGF0aDogJy9hcGkvaW50ZXJuYWwvYml6ZXZlbnQnLFxuICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICBoZWFkZXJzOiB7XG4gICAgICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICAgICdDb250ZW50LUxlbmd0aCc6IEJ1ZmZlci5ieXRlTGVuZ3RoKHBvc3REYXRhKSxcbiAgICAgICAgLi4uZmxhdHRlbmVkSGVhZGVyc1xuICAgICAgfSxcbiAgICAgIHRpbWVvdXQ6IDEwMDBcbiAgICB9O1xuICAgIFxuICAgIGNvbnN0IHJlcSA9IGh0dHAucmVxdWVzdChvcHRpb25zLCAocmVzKSA9PiB7XG4gICAgICAvLyBDb25zdW1lIHJlc3BvbnNlIHRvIGNvbXBsZXRlIHRoZSByZXF1ZXN0XG4gICAgICByZXMub24oJ2RhdGEnLCAoKSA9PiB7fSk7XG4gICAgICByZXMub24oJ2VuZCcsICgpID0+IHtcbiAgICAgICAgY29uc29sZS5sb2coYFtkeW5hdHJhY2VdIEJ1c2luZXNzIGV2ZW50IEhUVFAgY2FsbCBjb21wbGV0ZWQ6ICR7cmVzLnN0YXR1c0NvZGV9YCk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgICBcbiAgICByZXEub24oJ2Vycm9yJywgKGVycikgPT4ge1xuICAgICAgLy8gSWdub3JlIGVycm9ycyAtIHRoaXMgaXMganVzdCBmb3IgT25lQWdlbnQgY2FwdHVyZVxuICAgICAgY29uc29sZS5sb2coYFtkeW5hdHJhY2VdIEJ1c2luZXNzIGV2ZW50IEhUVFAgY2FsbCBmYWlsZWQgKGV4cGVjdGVkKTogJHtlcnIubWVzc2FnZX1gKTtcbiAgICB9KTtcbiAgICBcbiAgICByZXEub24oJ3RpbWVvdXQnLCAoKSA9PiB7XG4gICAgICByZXEuZGVzdHJveSgpO1xuICAgIH0pO1xuICAgIFxuICAgIHJlcS53cml0ZShwb3N0RGF0YSk7XG4gICAgcmVxLmVuZCgpO1xuICAgIFxuICB9IGNhdGNoIChlcnIpIHtcbiAgICAvLyBJZ25vcmUgZXJyb3JzIGluIGJ1c2luZXNzIGV2ZW50IEhUVFAgY2FsbFxuICAgIGNvbnNvbGUubG9nKGBbZHluYXRyYWNlXSBCdXNpbmVzcyBldmVudCBIVFRQIGNhbGwgZXJyb3IgKGV4cGVjdGVkKTogJHtlcnIubWVzc2FnZX1gKTtcbiAgfVxufTtcblxuLy8gT2xkIGZsYXR0ZW5pbmcgZnVuY3Rpb24gcmVtb3ZlZCAtIHVzaW5nIHVsdHJhLXNpbXBsZSBmbGF0dGVuaW5nIGluIHJlcXVlc3QgcHJvY2Vzc2luZyBpbnN0ZWFkXG5cbi8vIEZlYXR1cmUgRmxhZyBFcnJvciBIZWxwZXJzXG5mdW5jdGlvbiBnZXRIdHRwU3RhdHVzRm9yRXJyb3JUeXBlKGVycm9yVHlwZSkge1xuICBjb25zdCBzdGF0dXNNYXAgPSB7XG4gICAgJ3RpbWVvdXQnOiA1MDQsXG4gICAgJ3NlcnZpY2VfdW5hdmFpbGFibGUnOiA1MDMsXG4gICAgJ3ZhbGlkYXRpb25fZmFpbGVkJzogNDAwLFxuICAgICdwYXltZW50X2RlY2xpbmVkJzogNDAyLFxuICAgICdhdXRoZW50aWNhdGlvbl9mYWlsZWQnOiA0MDEsXG4gICAgJ3JhdGVfbGltaXRfZXhjZWVkZWQnOiA0MjksXG4gICAgJ2ludGVybmFsX2Vycm9yJzogNTAwXG4gIH07XG4gIHJldHVybiBzdGF0dXNNYXBbZXJyb3JUeXBlXSB8fCA1MDA7XG59XG5cbmZ1bmN0aW9uIGdldEVycm9yTWVzc2FnZUZvclR5cGUoZXJyb3JUeXBlLCBzdGVwTmFtZSkge1xuICBjb25zdCBtZXNzYWdlcyA9IHtcbiAgICAndGltZW91dCc6IGAke3N0ZXBOYW1lfSBzZXJ2aWNlIHRpbWVvdXQgYWZ0ZXIgNTAwMG1zYCxcbiAgICAnc2VydmljZV91bmF2YWlsYWJsZSc6IGAke3N0ZXBOYW1lfSBzZXJ2aWNlIHRlbXBvcmFyaWx5IHVuYXZhaWxhYmxlYCxcbiAgICAndmFsaWRhdGlvbl9mYWlsZWQnOiBgJHtzdGVwTmFtZX0gdmFsaWRhdGlvbiBmYWlsZWQgLSBpbnZhbGlkIGRhdGEgZm9ybWF0YCxcbiAgICAncGF5bWVudF9kZWNsaW5lZCc6IGBQYXltZW50IGRlY2xpbmVkIGJ5ICR7c3RlcE5hbWV9IHByb2Nlc3NvcmAsXG4gICAgJ2F1dGhlbnRpY2F0aW9uX2ZhaWxlZCc6IGBBdXRoZW50aWNhdGlvbiBmYWlsZWQgaW4gJHtzdGVwTmFtZX1gLFxuICAgICdyYXRlX2xpbWl0X2V4Y2VlZGVkJzogYFJhdGUgbGltaXQgZXhjZWVkZWQgZm9yICR7c3RlcE5hbWV9YCxcbiAgICAnaW50ZXJuYWxfZXJyb3InOiBgSW50ZXJuYWwgZXJyb3IgaW4gJHtzdGVwTmFtZX0gcHJvY2Vzc2luZ2BcbiAgfTtcbiAgcmV0dXJuIG1lc3NhZ2VzW2Vycm9yVHlwZV0gfHwgYFVua25vd24gZXJyb3IgaW4gJHtzdGVwTmFtZX1gO1xufVxuXG5mdW5jdGlvbiBnZXRSZW1lZGlhdGlvbkFjdGlvbihmbGFnTmFtZSkge1xuICBjb25zdCBhY3Rpb25zID0ge1xuICAgICdwYXltZW50X2dhdGV3YXlfdGltZW91dCc6ICdyZXN0YXJ0X3BheW1lbnRfc2VydmljZScsXG4gICAgJ2ludmVudG9yeV9zeW5jX2ZhaWx1cmUnOiAndHJpZ2dlcl9pbnZlbnRvcnlfc3luYycsXG4gICAgJ3ZhbGlkYXRpb25fZXJyb3InOiAncmV0cnlfd2l0aF9kZWZhdWx0cycsXG4gICAgJ2F1dGhlbnRpY2F0aW9uX3RpbWVvdXQnOiAncmVmcmVzaF9hdXRoX3Rva2VucycsXG4gICAgJ3JhdGVfbGltaXRfYnJlYWNoJzogJ2VuYWJsZV9jaXJjdWl0X2JyZWFrZXInXG4gIH07XG4gIHJldHVybiBhY3Rpb25zW2ZsYWdOYW1lXSB8fCAnbWFudWFsX2ludGVydmVudGlvbic7XG59XG5cbi8vIFdhaXQgZm9yIGEgc2VydmljZSBoZWFsdGggZW5kcG9pbnQgdG8gcmVzcG9uZCBvbiB0aGUgZ2l2ZW4gcG9ydFxuZnVuY3Rpb24gd2FpdEZvclNlcnZpY2VSZWFkeShwb3J0LCB0aW1lb3V0ID0gNTAwMCkge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICBjb25zdCBzdGFydCA9IERhdGUubm93KCk7XG4gICAgZnVuY3Rpb24gY2hlY2soKSB7XG4gICAgICBjb25zdCByZXEgPSBodHRwLnJlcXVlc3QoeyBob3N0bmFtZTogJzEyNy4wLjAuMScsIHBvcnQsIHBhdGg6ICcvaGVhbHRoJywgbWV0aG9kOiAnR0VUJywgdGltZW91dDogMTAwMCB9LCAocmVzKSA9PiB7XG4gICAgICAgIHJlc29sdmUodHJ1ZSk7XG4gICAgICB9KTtcbiAgICAgIHJlcS5vbignZXJyb3InLCAoKSA9PiB7XG4gICAgICAgIGlmIChEYXRlLm5vdygpIC0gc3RhcnQgPCB0aW1lb3V0KSBzZXRUaW1lb3V0KGNoZWNrLCAxNTApOyBlbHNlIHJlc29sdmUoZmFsc2UpO1xuICAgICAgfSk7XG4gICAgICByZXEub24oJ3RpbWVvdXQnLCAoKSA9PiB7IHJlcS5kZXN0cm95KCk7IGlmIChEYXRlLm5vdygpIC0gc3RhcnQgPCB0aW1lb3V0KSBzZXRUaW1lb3V0KGNoZWNrLCAxNTApOyBlbHNlIHJlc29sdmUoZmFsc2UpOyB9KTtcbiAgICAgIHJlcS5lbmQoKTtcbiAgICB9XG4gICAgY2hlY2soKTtcbiAgfSk7XG59XG5cbi8vIEdldCBzZXJ2aWNlIG5hbWUgZnJvbSBjb21tYW5kIGxpbmUgYXJndW1lbnRzIG9yIGVudmlyb25tZW50XG5jb25zdCBzZXJ2aWNlTmFtZUFyZyA9IHByb2Nlc3MuYXJndi5maW5kKChhcmcsIGluZGV4KSA9PiBwcm9jZXNzLmFyZ3ZbaW5kZXggLSAxXSA9PT0gJy0tc2VydmljZS1uYW1lJyk7XG5jb25zdCBzZXJ2aWNlTmFtZSA9IHNlcnZpY2VOYW1lQXJnIHx8IHByb2Nlc3MuZW52LlNFUlZJQ0VfTkFNRTtcbmNvbnN0IHN0ZXBOYW1lID0gcHJvY2Vzcy5lbnYuU1RFUF9OQU1FO1xuXG4vLyBDUklUSUNBTDogU2V0IHByb2Nlc3MgdGl0bGUgaW1tZWRpYXRlbHkgZm9yIER5bmF0cmFjZSBkZXRlY3Rpb25cbi8vIFRoaXMgaXMgd2hhdCBEeW5hdHJhY2UgdXNlcyB0byBpZGVudGlmeSB0aGUgc2VydmljZVxuaWYgKHNlcnZpY2VOYW1lKSB7XG4gIHRyeSB7XG4gICAgcHJvY2Vzcy50aXRsZSA9IHNlcnZpY2VOYW1lO1xuICAgIC8vIEFsc28gc2V0IGFyZ3ZbMF0gdG8gdGhlIHNlcnZpY2UgbmFtZSAtIHRoaXMgaXMgY3J1Y2lhbCBmb3IgRHluYXRyYWNlXG4gICAgaWYgKHByb2Nlc3MuYXJndiAmJiBwcm9jZXNzLmFyZ3YubGVuZ3RoID4gMCkge1xuICAgICAgcHJvY2Vzcy5hcmd2WzBdID0gc2VydmljZU5hbWU7XG4gICAgfVxuICAgIC8vIPCflJEgRFRfQVBQTElDQVRJT05fSUQ6IE92ZXJyaWRlcyBwYWNrYWdlLmpzb24gbmFtZSBmb3IgV2ViIGFwcGxpY2F0aW9uIGlkXG4gICAgLy8gVGhpcyBpcyB3aGF0IE9uZUFnZW50IHVzZXMgZm9yIHNlcnZpY2UgZGV0ZWN0aW9uL25hbWluZ1xuICAgIHByb2Nlc3MuZW52LkRUX0FQUExJQ0FUSU9OX0lEID0gc2VydmljZU5hbWU7XG4gICAgXG4gICAgLy8g8J+UkSBEVF9DVVNUT01fUFJPUDogQWRkcyBjdXN0b20gbWV0YWRhdGEgcHJvcGVydGllcyB0byB0aGUgc2VydmljZVxuICAgIHByb2Nlc3MuZW52LkRUX0NVU1RPTV9QUk9QID0gYGR0U2VydmljZU5hbWU9JHtzZXJ2aWNlTmFtZX0gY29tcGFueU5hbWU9JHtwcm9jZXNzLmVudi5DT01QQU5ZX05BTUUgfHwgJ3Vua25vd24nfSBkb21haW49JHtwcm9jZXNzLmVudi5ET01BSU4gfHwgJ3Vua25vd24nfSBpbmR1c3RyeVR5cGU9JHtwcm9jZXNzLmVudi5JTkRVU1RSWV9UWVBFIHx8ICd1bmtub3duJ31gO1xuICAgIFxuICAgIC8vIEludGVybmFsIGVudiB2YXJzIGZvciBhcHAtbGV2ZWwgY29kZVxuICAgIHByb2Nlc3MuZW52LkRUX1NFUlZJQ0VfTkFNRSA9IHNlcnZpY2VOYW1lO1xuICAgIHByb2Nlc3MuZW52LkRZTkFUUkFDRV9TRVJWSUNFX05BTUUgPSBzZXJ2aWNlTmFtZTtcbiAgICBwcm9jZXNzLmVudi5EVF9DTFVTVEVSX0lEID0gc2VydmljZU5hbWU7XG4gICAgcHJvY2Vzcy5lbnYuRFRfTk9ERV9JRCA9IGAke3NlcnZpY2VOYW1lfS1ub2RlYDtcbiAgICBjb25zb2xlLmxvZyhgW2R5bmFtaWMtc3RlcC1zZXJ2aWNlXSBTZXQgcHJvY2VzcyBpZGVudGl0eSB0bzogJHtzZXJ2aWNlTmFtZX1gKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoYFtkeW5hbWljLXN0ZXAtc2VydmljZV0gRmFpbGVkIHRvIHNldCBwcm9jZXNzIGlkZW50aXR5OiAke2UubWVzc2FnZX1gKTtcbiAgfVxufVxuXG4vLyBHZW5lcmljIHN0ZXAgc2VydmljZSB0aGF0IGNhbiBoYW5kbGUgYW55IHN0ZXAgbmFtZSBkeW5hbWljYWxseVxuZnVuY3Rpb24gY3JlYXRlU3RlcFNlcnZpY2Uoc2VydmljZU5hbWUsIHN0ZXBOYW1lKSB7XG4gIC8vIENvbnZlcnQgc3RlcE5hbWUgdG8gcHJvcGVyIHNlcnZpY2UgZm9ybWF0IGlmIG5lZWRlZFxuICBjb25zdCBwcm9wZXJTZXJ2aWNlTmFtZSA9IGdldFNlcnZpY2VOYW1lRnJvbVN0ZXAoc3RlcE5hbWUgfHwgc2VydmljZU5hbWUpO1xuICBcbiAgY3JlYXRlU2VydmljZShwcm9wZXJTZXJ2aWNlTmFtZSwgKGFwcCkgPT4ge1xuICAgIC8vIEFkZCBlcnJvciBoYW5kbGluZyBtaWRkbGV3YXJlXG4gICAgYXBwLnVzZShlcnJvckhhbmRsaW5nTWlkZGxld2FyZShwcm9wZXJTZXJ2aWNlTmFtZSkpO1xuICAgIFxuICAgIGFwcC5wb3N0KCcvcHJvY2VzcycsIGFzeW5jIChyZXEsIHJlcywgbmV4dCkgPT4ge1xuICAgICAgY29uc3QgcGF5bG9hZCA9IHJlcS5ib2R5IHx8IHt9O1xuICAgICAgY29uc3QgY29ycmVsYXRpb25JZCA9IHJlcS5jb3JyZWxhdGlvbklkO1xuICAgICAgY29uc3QgdGhpbmtUaW1lTXMgPSBOdW1iZXIocGF5bG9hZC50aGlua1RpbWVNcyB8fCAyMDApO1xuICAgICAgY29uc3QgY3VycmVudFN0ZXBOYW1lID0gcGF5bG9hZC5zdGVwTmFtZSB8fCBzdGVwTmFtZTtcbiAgICAgIFxuICAgICAgLy8gUHJvY2VzcyBwYXlsb2FkIHRvIGVuc3VyZSBzaW5nbGUgdmFsdWVzIGZvciBhcnJheXMgKG5vIGZsYXR0ZW5pbmcsIGp1c3QgYXJyYXkgc2ltcGxpZmljYXRpb24pXG4gICAgICBjb25zdCBwcm9jZXNzZWRQYXlsb2FkID0geyAuLi5wYXlsb2FkIH07XG4gICAgICBcbiAgICAgIGNvbnNvbGUubG9nKGBbJHtwcm9wZXJTZXJ2aWNlTmFtZX1dIFByb2Nlc3NpbmcgcGF5bG9hZCB3aXRoICR7T2JqZWN0LmtleXMocHJvY2Vzc2VkUGF5bG9hZCkubGVuZ3RofSBmaWVsZHNgKTtcbiAgICAgIFxuICAgICAgLy8gVGhlIHBheWxvYWQgc2hvdWxkIGFscmVhZHkgYmUgc2ltcGxpZmllZCBmcm9tIGpvdXJuZXktc2ltdWxhdGlvbi5qc1xuICAgICAgLy8gV2UnbGwganVzdCBlbnN1cmUgYW55IHJlbWFpbmluZyBhcnJheXMgYXJlIGNvbnZlcnRlZCB0byBzaW5nbGUgdmFsdWVzXG4gICAgICBmdW5jdGlvbiBzaW1wbGlmeUFycmF5c0luT2JqZWN0KG9iaikge1xuICAgICAgICBpZiAoIW9iaiB8fCB0eXBlb2Ygb2JqICE9PSAnb2JqZWN0JykgcmV0dXJuIG9iajtcbiAgICAgICAgXG4gICAgICAgIGNvbnN0IHNpbXBsaWZpZWQgPSB7fTtcbiAgICAgICAgT2JqZWN0LmtleXMob2JqKS5mb3JFYWNoKGtleSA9PiB7XG4gICAgICAgICAgY29uc3QgdmFsdWUgPSBvYmpba2V5XTtcbiAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkgJiYgdmFsdWUubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgLy8gUGljayBPTkUgcmFuZG9tIGl0ZW0gZnJvbSBhbnkgYXJyYXlcbiAgICAgICAgICAgIGNvbnN0IHJhbmRvbUluZGV4ID0gTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogdmFsdWUubGVuZ3RoKTtcbiAgICAgICAgICAgIHNpbXBsaWZpZWRba2V5XSA9IHZhbHVlW3JhbmRvbUluZGV4XTtcbiAgICAgICAgICB9IGVsc2UgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcgJiYgdmFsdWUgIT09IG51bGwpIHtcbiAgICAgICAgICAgIC8vIFJlY3Vyc2l2ZWx5IHNpbXBsaWZ5IG5lc3RlZCBvYmplY3RzXG4gICAgICAgICAgICBzaW1wbGlmaWVkW2tleV0gPSBzaW1wbGlmeUFycmF5c0luT2JqZWN0KHZhbHVlKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc2ltcGxpZmllZFtrZXldID0gdmFsdWU7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHNpbXBsaWZpZWQ7XG4gICAgICB9XG4gICAgICBcbiAgICAgIC8vIFNpbXBsaWZ5IGFueSByZW1haW5pbmcgYXJyYXlzIGluIG5lc3RlZCBvYmplY3RzXG4gICAgICBpZiAocHJvY2Vzc2VkUGF5bG9hZC5hZGRpdGlvbmFsRmllbGRzKSB7XG4gICAgICAgIHByb2Nlc3NlZFBheWxvYWQuYWRkaXRpb25hbEZpZWxkcyA9IHNpbXBsaWZ5QXJyYXlzSW5PYmplY3QocHJvY2Vzc2VkUGF5bG9hZC5hZGRpdGlvbmFsRmllbGRzKTtcbiAgICAgICAgY29uc29sZS5sb2coYFske3Byb3BlclNlcnZpY2VOYW1lfV0gU2ltcGxpZmllZCBhcnJheXMgaW4gYWRkaXRpb25hbEZpZWxkc2ApO1xuICAgICAgfVxuICAgICAgXG4gICAgICBpZiAocHJvY2Vzc2VkUGF5bG9hZC5jdXN0b21lclByb2ZpbGUpIHtcbiAgICAgICAgcHJvY2Vzc2VkUGF5bG9hZC5jdXN0b21lclByb2ZpbGUgPSBzaW1wbGlmeUFycmF5c0luT2JqZWN0KHByb2Nlc3NlZFBheWxvYWQuY3VzdG9tZXJQcm9maWxlKTtcbiAgICAgICAgY29uc29sZS5sb2coYFske3Byb3BlclNlcnZpY2VOYW1lfV0gU2ltcGxpZmllZCBhcnJheXMgaW4gY3VzdG9tZXJQcm9maWxlYCk7XG4gICAgICB9XG4gICAgICBcbiAgICAgIGlmIChwcm9jZXNzZWRQYXlsb2FkLnRyYWNlTWV0YWRhdGEpIHtcbiAgICAgICAgcHJvY2Vzc2VkUGF5bG9hZC50cmFjZU1ldGFkYXRhID0gc2ltcGxpZnlBcnJheXNJbk9iamVjdChwcm9jZXNzZWRQYXlsb2FkLnRyYWNlTWV0YWRhdGEpO1xuICAgICAgICBjb25zb2xlLmxvZyhgWyR7cHJvcGVyU2VydmljZU5hbWV9XSBTaW1wbGlmaWVkIGFycmF5cyBpbiB0cmFjZU1ldGFkYXRhYCk7XG4gICAgICB9XG4gICAgICBcbiAgICAgIC8vIFVwZGF0ZSB0aGUgcmVxdWVzdCBib2R5IHdpdGggdGhlIHByb2Nlc3NlZCBwYXlsb2FkXG4gICAgICAvLyBoYXNFcnJvciBpcyBhbHJlYWR5IGluc2lkZSBhZGRpdGlvbmFsRmllbGRzIGZyb20gam91cm5leS1zaW11bGF0aW9uLmpzXG4gICAgICByZXEuYm9keSA9IHByb2Nlc3NlZFBheWxvYWQ7XG4gICAgICBcbiAgICAgIHRyeSB7XG4gICAgICAgIC8vIENoZWNrIGZvciBzdGVwIGVycm9ycyBmaXJzdCAoYm90aCBleHBsaWNpdCBhbmQgc2ltdWxhdGVkKVxuICAgICAgICBjb25zdCBzdGVwRXJyb3IgPSBjaGVja0ZvclN0ZXBFcnJvcihwYXlsb2FkLCBudWxsKTsgLy8gWW91IGNhbiBwYXNzIGVycm9yIHByb2ZpbGUgaGVyZVxuICAgICAgICBpZiAoc3RlcEVycm9yKSB7XG4gICAgICAgICAgY29uc29sZS5lcnJvcihgWyR7cHJvcGVyU2VydmljZU5hbWV9XSBTdGVwIGVycm9yIGRldGVjdGVkOmAsIHN0ZXBFcnJvci5tZXNzYWdlKTtcbiAgICAgICAgICB0aHJvdyBzdGVwRXJyb3I7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIC8vIEV4dHJhY3QgdHJhY2UgY29udGV4dCBmcm9tIGluY29taW5nIHJlcXVlc3QgaGVhZGVyc1xuICAgICAgICBjb25zdCBpbmNvbWluZ1RyYWNlUGFyZW50ID0gcmVxLmhlYWRlcnNbJ3RyYWNlcGFyZW50J107XG4gICAgICAgIGNvbnN0IGluY29taW5nVHJhY2VTdGF0ZSA9IHJlcS5oZWFkZXJzWyd0cmFjZXN0YXRlJ107XG4gICAgICAgIGNvbnN0IGR5bmF0cmFjZVRyYWNlSWQgPSByZXEuaGVhZGVyc1sneC1keW5hdHJhY2UtdHJhY2UtaWQnXTtcbiAgICAgICAgXG4gICAgICAgIC8vIEdlbmVyYXRlIHRyYWNlIElEcyBmb3IgZGlzdHJpYnV0ZWQgdHJhY2luZ1xuICAgICAgICBmdW5jdGlvbiBnZW5lcmF0ZVVVSUQoKSB7XG4gICAgICAgICAgcmV0dXJuIGNyeXB0by5yYW5kb21VVUlEKCk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGxldCB0cmFjZUlkLCBwYXJlbnRTcGFuSWQ7XG4gICAgICAgIFxuICAgICAgICBpZiAoaW5jb21pbmdUcmFjZVBhcmVudCkge1xuICAgICAgICAgIC8vIFBhcnNlIFczQyB0cmFjZXBhcmVudDogMDAtdHJhY2VfaWQtcGFyZW50X2lkLWZsYWdzXG4gICAgICAgICAgY29uc3QgcGFydHMgPSBpbmNvbWluZ1RyYWNlUGFyZW50LnNwbGl0KCctJyk7XG4gICAgICAgICAgaWYgKHBhcnRzLmxlbmd0aCA9PT0gNCkge1xuICAgICAgICAgICAgdHJhY2VJZCA9IHBhcnRzWzFdO1xuICAgICAgICAgICAgcGFyZW50U3BhbklkID0gcGFydHNbMl07XG4gICAgICAgICAgICBjb25zb2xlLmxvZyhgWyR7cHJvcGVyU2VydmljZU5hbWV9XSBVc2luZyBpbmNvbWluZyB0cmFjZSBjb250ZXh0OiAke3RyYWNlSWQuc3Vic3RyaW5nKDAsOCl9Li4uYCk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKGR5bmF0cmFjZVRyYWNlSWQpIHtcbiAgICAgICAgICB0cmFjZUlkID0gZHluYXRyYWNlVHJhY2VJZDtcbiAgICAgICAgICBwYXJlbnRTcGFuSWQgPSByZXEuaGVhZGVyc1sneC1keW5hdHJhY2UtcGFyZW50LXNwYW4taWQnXTtcbiAgICAgICAgICBjb25zb2xlLmxvZyhgWyR7cHJvcGVyU2VydmljZU5hbWV9XSBVc2luZyBEeW5hdHJhY2UgdHJhY2UgY29udGV4dDogJHt0cmFjZUlkLnN1YnN0cmluZygwLDgpfS4uLmApO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAvLyBGYWxsYmFjayB0byBwYXlsb2FkIG9yIGdlbmVyYXRlIG5ld1xuICAgICAgICBpZiAoIXRyYWNlSWQpIHtcbiAgICAgICAgICB0cmFjZUlkID0gcGF5bG9hZC50cmFjZUlkIHx8IGdlbmVyYXRlVVVJRCgpLnJlcGxhY2UoLy0vZywgJycpO1xuICAgICAgICAgIHBhcmVudFNwYW5JZCA9IHBheWxvYWQuc3BhbklkIHx8IG51bGw7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGNvbnN0IHNwYW5JZCA9IGdlbmVyYXRlVVVJRCgpLnNsaWNlKDAsIDE2KS5yZXBsYWNlKC8tL2csICcnKTtcbiAgICAgICAgXG4gICAgICAgIGNvbnNvbGUubG9nKGBbJHtwcm9wZXJTZXJ2aWNlTmFtZX1dIFRyYWNlIGNvbnRleHQ6IHRyYWNlSWQ9JHt0cmFjZUlkLnN1YnN0cmluZygwLDgpfS4uLiwgc3BhbklkPSR7c3BhbklkLnN1YnN0cmluZygwLDgpfS4uLiwgcGFyZW50U3BhbklkPSR7cGFyZW50U3BhbklkID8gcGFyZW50U3BhbklkLnN1YnN0cmluZygwLDgpICsgJy4uLicgOiAnbm9uZSd9YCk7XG4gICAgICAgIFxuICAgICAgICAvLyAtLS0gT25lQWdlbnQgRGlzdHJpYnV0ZWQgVHJhY2luZyBJbnRlZ3JhdGlvbiAtLS1cbiAgICAgICAgLy8gTGV0IE9uZUFnZW50IGhhbmRsZSB0cmFjZS9zcGFuIHByb3BhZ2F0aW9uIGF1dG9tYXRpY2FsbHlcbiAgICAgICAgLy8gU3RvcmUgam91cm5leSBjb250ZXh0IGZvciBidXNpbmVzcyBvYnNlcnZhYmlsaXR5XG4gICAgICAgIGNvbnN0IGpvdXJuZXlUcmFjZSA9IEFycmF5LmlzQXJyYXkocGF5bG9hZC5qb3VybmV5VHJhY2UpID8gWy4uLnBheWxvYWQuam91cm5leVRyYWNlXSA6IFtdO1xuICAgICAgICBjb25zdCBzdGVwRW50cnkgPSB7XG4gICAgICAgICAgc3RlcE5hbWU6IGN1cnJlbnRTdGVwTmFtZSxcbiAgICAgICAgICBzZXJ2aWNlTmFtZTogcHJvcGVyU2VydmljZU5hbWUsXG4gICAgICAgICAgdGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgICAgY29ycmVsYXRpb25JZCxcbiAgICAgICAgICBzdWNjZXNzOiB0cnVlLCAvLyBXaWxsIGJlIHVwZGF0ZWQgaWYgZXJyb3Igb2NjdXJzXG4gICAgICAgICAgdHJhY2VJZDogdHJhY2VJZC5zdWJzdHJpbmcoMCw4KSArICcuLi4nLFxuICAgICAgICAgIHNwYW5JZDogc3BhbklkLnN1YnN0cmluZygwLDgpICsgJy4uLidcbiAgICAgICAgfTtcbiAgICAgICAgam91cm5leVRyYWNlLnB1c2goc3RlcEVudHJ5KTtcblxuICAgICAgLy8gTG9vayB1cCBjdXJyZW50IHN0ZXAncyBkYXRhIGZyb20gdGhlIGpvdXJuZXkgc3RlcHMgYXJyYXkgZm9yIGNoYWluZWQgZXhlY3V0aW9uXG4gICAgICBsZXQgY3VycmVudFN0ZXBEYXRhID0gbnVsbDtcbiAgICAgIGlmIChwYXlsb2FkLnN0ZXBzICYmIEFycmF5LmlzQXJyYXkocGF5bG9hZC5zdGVwcykpIHtcbiAgICAgICAgY29uc29sZS5sb2coYFske3Byb3BlclNlcnZpY2VOYW1lfV0gTG9va2luZyBmb3Igc3RlcCBkYXRhIGZvcjogJHtjdXJyZW50U3RlcE5hbWV9LCBBdmFpbGFibGUgc3RlcHM6YCwgcGF5bG9hZC5zdGVwcy5tYXAocyA9PiBzLnN0ZXBOYW1lIHx8IHMubmFtZSkpO1xuICAgICAgICBjdXJyZW50U3RlcERhdGEgPSBwYXlsb2FkLnN0ZXBzLmZpbmQoc3RlcCA9PiBcbiAgICAgICAgICBzdGVwLnN0ZXBOYW1lID09PSBjdXJyZW50U3RlcE5hbWUgfHwgXG4gICAgICAgICAgc3RlcC5uYW1lID09PSBjdXJyZW50U3RlcE5hbWUgfHxcbiAgICAgICAgICBzdGVwLnNlcnZpY2VOYW1lID09PSBwcm9wZXJTZXJ2aWNlTmFtZVxuICAgICAgICApO1xuICAgICAgICBjb25zb2xlLmxvZyhgWyR7cHJvcGVyU2VydmljZU5hbWV9XSBGb3VuZCBzdGVwIGRhdGE6YCwgY3VycmVudFN0ZXBEYXRhID8gJ1lFUycgOiAnTk8nKTtcbiAgICAgICAgaWYgKGN1cnJlbnRTdGVwRGF0YSkge1xuICAgICAgICAgIGNvbnNvbGUubG9nKGBbJHtwcm9wZXJTZXJ2aWNlTmFtZX1dIFN0ZXAgZGF0YSBkZXRhaWxzOmAsIEpTT04uc3RyaW5naWZ5KGN1cnJlbnRTdGVwRGF0YSwgbnVsbCwgMikpO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zb2xlLmxvZyhgWyR7cHJvcGVyU2VydmljZU5hbWV9XSBObyBzdGVwcyBhcnJheSBpbiBwYXlsb2FkYCk7XG4gICAgICB9XG4gICAgICBcbiAgICAgIC8vIFVzZSBzdGVwLXNwZWNpZmljIGRhdGEgaWYgZm91bmQsIG90aGVyd2lzZSB1c2UgcGF5bG9hZCBkZWZhdWx0c1xuICAgICAgY29uc3Qgc3RlcERlc2NyaXB0aW9uID0gY3VycmVudFN0ZXBEYXRhPy5kZXNjcmlwdGlvbiB8fCBwYXlsb2FkLnN0ZXBEZXNjcmlwdGlvbiB8fCAnJztcbiAgICAgIGNvbnN0IHN0ZXBDYXRlZ29yeSA9IGN1cnJlbnRTdGVwRGF0YT8uY2F0ZWdvcnkgfHwgcGF5bG9hZC5zdGVwQ2F0ZWdvcnkgfHwgJyc7XG4gICAgICBjb25zdCBlc3RpbWF0ZWREdXJhdGlvbiA9IGN1cnJlbnRTdGVwRGF0YT8uZXN0aW1hdGVkRHVyYXRpb24gfHwgcGF5bG9hZC5lc3RpbWF0ZWREdXJhdGlvbjtcbiAgICAgIGNvbnN0IGJ1c2luZXNzUmF0aW9uYWxlID0gY3VycmVudFN0ZXBEYXRhPy5idXNpbmVzc1JhdGlvbmFsZSB8fCBwYXlsb2FkLmJ1c2luZXNzUmF0aW9uYWxlO1xuICAgICAgY29uc3Qgc3Vic3RlcHMgPSBjdXJyZW50U3RlcERhdGE/LnN1YnN0ZXBzIHx8IHBheWxvYWQuc3Vic3RlcHM7XG5cbiAgICAgIC8vIExvZyBzZXJ2aWNlIHByb2Nlc3Npbmcgd2l0aCBzdGVwLXNwZWNpZmljIGRldGFpbHNcbiAgICAgIGNvbnNvbGUubG9nKGBbJHtwcm9wZXJTZXJ2aWNlTmFtZX1dIFByb2Nlc3Npbmcgc3RlcCB3aXRoIHBheWxvYWQ6YCwgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBzdGVwTmFtZTogcGF5bG9hZC5zdGVwTmFtZSxcbiAgICAgICAgc3RlcEluZGV4OiBwYXlsb2FkLnN0ZXBJbmRleCxcbiAgICAgICAgdG90YWxTdGVwczogcGF5bG9hZC50b3RhbFN0ZXBzLFxuICAgICAgICBzdGVwRGVzY3JpcHRpb246IHN0ZXBEZXNjcmlwdGlvbixcbiAgICAgICAgc3RlcENhdGVnb3J5OiBzdGVwQ2F0ZWdvcnksXG4gICAgICAgIHN1YlN0ZXBzOiBwYXlsb2FkLnN1YlN0ZXBzLFxuICAgICAgICBoYXNFcnJvcjogcGF5bG9hZC5oYXNFcnJvcixcbiAgICAgICAgZXJyb3JUeXBlOiBwYXlsb2FkLmVycm9yVHlwZSxcbiAgICAgICAgY29tcGFueU5hbWU6IHBheWxvYWQuY29tcGFueU5hbWUsXG4gICAgICAgIGRvbWFpbjogcGF5bG9hZC5kb21haW4sXG4gICAgICAgIGluZHVzdHJ5VHlwZTogcGF5bG9hZC5pbmR1c3RyeVR5cGUsXG4gICAgICAgIGNvcnJlbGF0aW9uSWQ6IHBheWxvYWQuY29ycmVsYXRpb25JZCxcbiAgICAgICAgLy8gSW5jbHVkZSBDb3BpbG90IGR1cmF0aW9uIGZpZWxkcyBmb3IgT25lQWdlbnQgY2FwdHVyZSAoc3RlcC1zcGVjaWZpYylcbiAgICAgICAgZXN0aW1hdGVkRHVyYXRpb246IGVzdGltYXRlZER1cmF0aW9uLFxuICAgICAgICBidXNpbmVzc1JhdGlvbmFsZTogYnVzaW5lc3NSYXRpb25hbGUsXG4gICAgICAgIGNhdGVnb3J5OiBzdGVwQ2F0ZWdvcnksXG4gICAgICAgIHN1YnN0ZXBzOiBzdWJzdGVwcyxcbiAgICAgICAgZXN0aW1hdGVkRHVyYXRpb25NczogcGF5bG9hZC5lc3RpbWF0ZWREdXJhdGlvbk1zXG4gICAgICB9LCBudWxsLCAyKSk7XG4gICAgICBjb25zb2xlLmxvZyhgWyR7cHJvcGVyU2VydmljZU5hbWV9XSBDdXJyZW50IHN0ZXAgbmFtZTogJHtjdXJyZW50U3RlcE5hbWV9YCk7XG4gICAgICBjb25zb2xlLmxvZyhgWyR7cHJvcGVyU2VydmljZU5hbWV9XSBTdGVwLXNwZWNpZmljIHN1YnN0ZXBzOmAsIHBheWxvYWQuc3ViU3RlcHMgfHwgW10pO1xuICAgICAgY29uc29sZS5sb2coYFske3Byb3BlclNlcnZpY2VOYW1lfV0gSm91cm5leSB0cmFjZSBzbyBmYXI6YCwgSlNPTi5zdHJpbmdpZnkoam91cm5leVRyYWNlKSk7XG5cbiAgICAgIC8vIPCfmqYgRmVhdHVyZSBGbGFnIEVycm9yIEluamVjdGlvbiB3aXRoIEF1dG8tUmVnZW5lcmF0aW9uXG4gICAgICBsZXQgZXJyb3JJbmplY3RlZCA9IG51bGw7XG4gICAgICBcbiAgICAgIC8vIEZldGNoIGVycm9yIGNvbmZpZyBmb3IgVEhJUyBzZXJ2aWNlIChwZXItc2VydmljZSB0YXJnZXRpbmcgZnJvbSBHcmVtbGluKVxuICAgICAgLy8gQ2hlY2sgQk9USCBmdWxsIHNlcnZpY2UgbmFtZSAoY29tcG91bmQpIEFORCBiYXNlIHNlcnZpY2UgbmFtZSAoY2xlYW4pXG4gICAgICBjb25zdCBmdWxsU2VydmljZU5hbWUgPSBwcm9jZXNzLmVudi5GVUxMX1NFUlZJQ0VfTkFNRSB8fCBwcm9wZXJTZXJ2aWNlTmFtZTtcbiAgICAgIGNvbnN0IGJhc2VTZXJ2aWNlTmFtZSA9IHByb2Nlc3MuZW52LlNFUlZJQ0VfTkFNRSB8fCBwcm9jZXNzLmVudi5EVF9TRVJWSUNFX05BTUUgfHwgcHJvcGVyU2VydmljZU5hbWU7XG4gICAgICBjb25zdCBnbG9iYWxDb25maWcgPSBhd2FpdCBmZXRjaEdsb2JhbEVycm9yQ29uZmlnKGZ1bGxTZXJ2aWNlTmFtZSwgYmFzZVNlcnZpY2VOYW1lKTtcbiAgICAgIFxuICAgICAgLy8gRXh0cmFjdCBlcnJvciBjb25maWd1cmF0aW9uIGZyb20gcGF5bG9hZCAoYWxsb3dzIG92ZXJyaWRlKSBvciB1c2UgZ2xvYmFsXG4gICAgICBjb25zdCBlcnJvckNvbmZpZyA9IHtcbiAgICAgICAgZXJyb3JzX3Blcl90cmFuc2FjdGlvbjogcGF5bG9hZC5lcnJvckNvbmZpZz8uZXJyb3JzX3Blcl90cmFuc2FjdGlvbiA/PyBnbG9iYWxDb25maWcuZXJyb3JzX3Blcl90cmFuc2FjdGlvbixcbiAgICAgICAgZXJyb3JzX3Blcl92aXNpdDogcGF5bG9hZC5lcnJvckNvbmZpZz8uZXJyb3JzX3Blcl92aXNpdCA/PyBnbG9iYWxDb25maWcuZXJyb3JzX3Blcl92aXNpdCxcbiAgICAgICAgZXJyb3JzX3Blcl9taW51dGU6IHBheWxvYWQuZXJyb3JDb25maWc/LmVycm9yc19wZXJfbWludXRlID8/IGdsb2JhbENvbmZpZy5lcnJvcnNfcGVyX21pbnV0ZSxcbiAgICAgICAgcmVnZW5lcmF0ZV9ldmVyeV9uX3RyYW5zYWN0aW9uczogcGF5bG9hZC5lcnJvckNvbmZpZz8ucmVnZW5lcmF0ZV9ldmVyeV9uX3RyYW5zYWN0aW9ucyA/PyBnbG9iYWxDb25maWcucmVnZW5lcmF0ZV9ldmVyeV9uX3RyYW5zYWN0aW9uc1xuICAgICAgfTtcbiAgICAgIFxuICAgICAgLy8gTG9nIGlmIGdsb2JhbCBjb25maWcgaXMgYmVpbmcgdXNlZCAoaW5kaWNhdGVzIER5bmF0cmFjZSBjb250cm9sKVxuICAgICAgaWYgKCFwYXlsb2FkLmVycm9yQ29uZmlnICYmIGdsb2JhbENvbmZpZy5lcnJvcnNfcGVyX3RyYW5zYWN0aW9uICE9PSBERUZBVUxUX0VSUk9SX0NPTkZJRy5lcnJvcnNfcGVyX3RyYW5zYWN0aW9uKSB7XG4gICAgICAgIGNvbnNvbGUubG9nKGDwn4yQIFtFcnJvciBDb25maWddIFVzaW5nIGdsb2JhbCBjb25maWcgZnJvbSBBUEkgKER5bmF0cmFjZSBjb250cm9sbGVkKTogJHtnbG9iYWxDb25maWcuZXJyb3JzX3Blcl90cmFuc2FjdGlvbn1gKTtcbiAgICAgIH1cbiAgICAgIFxuICAgICAgLy8gQ2hlY2sgaWYgZXJyb3JzIGFyZSBkaXNhYmxlZCAoZXJyb3JzX3Blcl90cmFuc2FjdGlvbiA9IDApXG4gICAgICBpZiAoZXJyb3JDb25maWcuZXJyb3JzX3Blcl90cmFuc2FjdGlvbiA9PT0gMCkge1xuICAgICAgICBjb25zb2xlLmxvZyhg4o+477iPICBbRmVhdHVyZSBGbGFnc10gRXJyb3JzIGRpc2FibGVkIChlcnJvcnNfcGVyX3RyYW5zYWN0aW9uPTApIC0gU2VsZi1oZWFsaW5nIGFjdGl2ZSFgKTtcbiAgICAgICAgZmVhdHVyZUZsYWdzID0ge307XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBDaGVjayBhbmQgcmVnZW5lcmF0ZSBmZWF0dXJlIGZsYWdzIGV2ZXJ5IE4gdHJhbnNhY3Rpb25zXG4gICAgICAgIGxldCBmZWF0dXJlRmxhZ3MgPSBwYXlsb2FkLmZlYXR1cmVGbGFncyB8fCB7fTtcbiAgICAgICAgaWYgKE9iamVjdC5rZXlzKGZlYXR1cmVGbGFncykubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgLy8gVXNlIGF1dG8tZ2VuZXJhdGVkIGZsYWdzIGlmIG5vbmUgcHJvdmlkZWRcbiAgICAgICAgICBmZWF0dXJlRmxhZ3MgPSBjaGVja0FuZFJlZ2VuZXJhdGVGZWF0dXJlRmxhZ3MocGF5bG9hZCwgZXJyb3JDb25maWcpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIFN0aWxsIHRyYWNrIGFuZCBwb3RlbnRpYWxseSByZWdlbmVyYXRlIGV2ZW4gd2l0aCBwcm92aWRlZCBmbGFnc1xuICAgICAgICAgIGNvbnN0IHJlZ2VuZXJhdGVkRmxhZ3MgPSBjaGVja0FuZFJlZ2VuZXJhdGVGZWF0dXJlRmxhZ3MocGF5bG9hZCwgZXJyb3JDb25maWcpO1xuICAgICAgICAgIGlmIChPYmplY3Qua2V5cyhyZWdlbmVyYXRlZEZsYWdzKS5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBmZWF0dXJlRmxhZ3MgPSByZWdlbmVyYXRlZEZsYWdzO1xuICAgICAgICAgICAgY29uc29sZS5sb2coYPCflIQgW0ZlYXR1cmUgRmxhZ3NdIFVzaW5nIHJlZ2VuZXJhdGVkIGZsYWdzICh0cmFuc2FjdGlvbjogJHtjb3JyZWxhdGlvbklkQ291bnRlcn0pYCk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAvLyDilZDilZDilZAgRElSRUNUIElOSkVDVElPTiBGQUxMQkFDSyDilZDilZDilZBcbiAgICAgICAgLy8gSWYgcGF0dGVybi1iYXNlZCBmbGFnIGdlbmVyYXRpb24gcHJvZHVjZWQgbm8gZmxhZ3MgKGUuZy4gbm8gc3RlcHMgYXJyYXkgaW4gcGF5bG9hZCxcbiAgICAgICAgLy8gb3Igc3RlcCBuYW1lIGRvZXNuJ3QgbWF0Y2ggYW55IHBhdHRlcm4pLCBpbmplY3QgZXJyb3JzIGRpcmVjdGx5IGJhc2VkIG9uXG4gICAgICAgIC8vIGVycm9yc19wZXJfdHJhbnNhY3Rpb24gcmF0ZS4gVGhpcyBlbnN1cmVzIGNoYW9zIGluamVjdGlvbiBBTFdBWVMgd29ya3Mgd2hlblxuICAgICAgICAvLyB0aGUgR3JlbWxpbi9OZW1lc2lzIGFnZW50IHRhcmdldHMgYSBzcGVjaWZpYyBzZXJ2aWNlLCByZWdhcmRsZXNzIG9mIHN0ZXAgcGF0dGVybnMuXG4gICAgICAgIGlmICghZmVhdHVyZUZsYWdzIHx8IE9iamVjdC5rZXlzKGZlYXR1cmVGbGFncykubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgY29uc3Qgc2hvdWxkRXJyb3IgPSBNYXRoLnJhbmRvbSgpIDwgZXJyb3JDb25maWcuZXJyb3JzX3Blcl90cmFuc2FjdGlvbjtcbiAgICAgICAgICBpZiAoc2hvdWxkRXJyb3IpIHtcbiAgICAgICAgICAgIC8vIFBpY2sgYSByZWFsaXN0aWMgZXJyb3IgdHlwZSBiYXNlZCBvbiB0aGUgc3RlcC9zZXJ2aWNlIG5hbWVcbiAgICAgICAgICAgIGNvbnN0IGVycm9yVHlwZXMgPSBbJ3NlcnZpY2VfdW5hdmFpbGFibGUnLCAndGltZW91dCcsICdpbnRlcm5hbF9lcnJvcicsICdjb25uZWN0aW9uX3JlZnVzZWQnXTtcbiAgICAgICAgICAgIGNvbnN0IHNlbGVjdGVkVHlwZSA9IGVycm9yVHlwZXNbTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogZXJyb3JUeXBlcy5sZW5ndGgpXTtcbiAgICAgICAgICAgIGVycm9ySW5qZWN0ZWQgPSB7XG4gICAgICAgICAgICAgIGZlYXR1cmVfZmxhZzogJ2NoYW9zX2RpcmVjdF9pbmplY3Rpb24nLFxuICAgICAgICAgICAgICBlcnJvcl90eXBlOiBzZWxlY3RlZFR5cGUsXG4gICAgICAgICAgICAgIGh0dHBfc3RhdHVzOiBnZXRIdHRwU3RhdHVzRm9yRXJyb3JUeXBlKHNlbGVjdGVkVHlwZSksXG4gICAgICAgICAgICAgIG1lc3NhZ2U6IGdldEVycm9yTWVzc2FnZUZvclR5cGUoc2VsZWN0ZWRUeXBlLCBjdXJyZW50U3RlcE5hbWUpLFxuICAgICAgICAgICAgICByZW1lZGlhdGlvbl9hY3Rpb246ICdyZXN0YXJ0X3NlcnZpY2UnLFxuICAgICAgICAgICAgICByZWNvdmVyYWJsZTogdHJ1ZSxcbiAgICAgICAgICAgICAgcmV0cnlfY291bnQ6IDAsXG4gICAgICAgICAgICAgIGluamVjdGVkX2F0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBjb25zb2xlLmxvZyhg8J+OryBbQ2hhb3MgRGlyZWN0XSBObyBwYXR0ZXJuIGZsYWdzIGF2YWlsYWJsZSDigJQgdXNpbmcgZGlyZWN0IGluamVjdGlvbiBhdCAkeyhlcnJvckNvbmZpZy5lcnJvcnNfcGVyX3RyYW5zYWN0aW9uICogMTAwKS50b0ZpeGVkKDApfSUgcmF0ZWApO1xuICAgICAgICAgICAgY29uc29sZS5sb2coYPCfmqggSW5qZWN0aW5nIGVycm9yOmAsIEpTT04uc3RyaW5naWZ5KGVycm9ySW5qZWN0ZWQsIG51bGwsIDIpKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29uc29sZS5sb2coYPCfjq8gW0NoYW9zIERpcmVjdF0gTm8gcGF0dGVybiBmbGFncyDigJQgZGlyZWN0IGluamVjdGlvbiBjaGVjazogUEFTUyAocmF0ZTogJHsoZXJyb3JDb25maWcuZXJyb3JzX3Blcl90cmFuc2FjdGlvbiAqIDEwMCkudG9GaXhlZCgwKX0lKWApO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmIChmZWF0dXJlRmxhZ3MgJiYgdHlwZW9mIGZlYXR1cmVGbGFncyA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgXG4gICAgICAgIC8vIENoZWNrIGVhY2ggYWN0aXZlIGZlYXR1cmUgZmxhZyB0byBzZWUgaWYgdGhpcyBzdGVwIGlzIGFmZmVjdGVkXG4gICAgICAgIGZvciAoY29uc3QgW2ZsYWdOYW1lLCBmbGFnQ29uZmlnXSBvZiBPYmplY3QuZW50cmllcyhmZWF0dXJlRmxhZ3MpKSB7XG4gICAgICAgICAgaWYgKGZsYWdDb25maWcuZW5hYmxlZCAmJiBmbGFnQ29uZmlnLmFmZmVjdGVkU3RlcHMpIHtcbiAgICAgICAgICAgIGNvbnN0IGlzQWZmZWN0ZWRTdGVwID0gZmxhZ0NvbmZpZy5hZmZlY3RlZFN0ZXBzLnNvbWUoc3RlcCA9PiBcbiAgICAgICAgICAgICAgY3VycmVudFN0ZXBOYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoc3RlcC50b0xvd2VyQ2FzZSgpKSB8fFxuICAgICAgICAgICAgICBzdGVwLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoY3VycmVudFN0ZXBOYW1lLnRvTG93ZXJDYXNlKCkpXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoaXNBZmZlY3RlZFN0ZXApIHtcbiAgICAgICAgICAgICAgLy8gQXBwbHkgZXJyb3IgcmF0ZSBwcm9iYWJpbGl0eVxuICAgICAgICAgICAgICBjb25zdCBzaG91bGRFcnJvciA9IE1hdGgucmFuZG9tKCkgPCBmbGFnQ29uZmlnLmVycm9yUmF0ZTtcbiAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgIGlmIChzaG91bGRFcnJvcikge1xuICAgICAgICAgICAgICAgIGVycm9ySW5qZWN0ZWQgPSB7XG4gICAgICAgICAgICAgICAgICBmZWF0dXJlX2ZsYWc6IGZsYWdOYW1lLFxuICAgICAgICAgICAgICAgICAgZXJyb3JfdHlwZTogZmxhZ0NvbmZpZy5lcnJvclR5cGUgfHwgJ3Vua25vd24nLFxuICAgICAgICAgICAgICAgICAgaHR0cF9zdGF0dXM6IGdldEh0dHBTdGF0dXNGb3JFcnJvclR5cGUoZmxhZ0NvbmZpZy5lcnJvclR5cGUpLFxuICAgICAgICAgICAgICAgICAgbWVzc2FnZTogZ2V0RXJyb3JNZXNzYWdlRm9yVHlwZShmbGFnQ29uZmlnLmVycm9yVHlwZSwgY3VycmVudFN0ZXBOYW1lKSxcbiAgICAgICAgICAgICAgICAgIHJlbWVkaWF0aW9uX2FjdGlvbjogZmxhZ0NvbmZpZy5yZW1lZGlhdGlvbkFjdGlvbiB8fCBnZXRSZW1lZGlhdGlvbkFjdGlvbihmbGFnTmFtZSksXG4gICAgICAgICAgICAgICAgICByZWNvdmVyYWJsZTogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgIHJldHJ5X2NvdW50OiAwLFxuICAgICAgICAgICAgICAgICAgaW5qZWN0ZWRfYXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYPCfmqYgRmVhdHVyZSBmbGFnIHRyaWdnZXJlZDogJHtmbGFnTmFtZX0gb24gc3RlcCAke2N1cnJlbnRTdGVwTmFtZX1gKTtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhg8J+aqCBJbmplY3RpbmcgZXJyb3I6YCwgSlNPTi5zdHJpbmdpZnkoZXJyb3JJbmplY3RlZCwgbnVsbCwgMikpO1xuICAgICAgICAgICAgICAgIGJyZWFrOyAvLyBPbmx5IGluamVjdCBvbmUgZXJyb3IgcGVyIHJlcXVlc3RcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICB9IC8vIGVuZCBpZiAoZmVhdHVyZUZsYWdzICYmIHR5cGVvZiBmZWF0dXJlRmxhZ3MgPT09ICdvYmplY3QnKVxuICAgICAgfSAvLyBlbmQgZWxzZSAoZXJyb3JzIGVuYWJsZWQpXG5cbiAgICAgIC8vIFNpbXVsYXRlIHByb2Nlc3Npbmcgd2l0aCByZWFsaXN0aWMgdGltaW5nIChhZGQgZGVsYXkgaWYgZXJyb3IpXG4gICAgICBjb25zdCBwcm9jZXNzaW5nVGltZSA9IGVycm9ySW5qZWN0ZWQgPyBcbiAgICAgICAgTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogMjAwMCkgKyAzMDAwIDogLy8gMy01cyBmb3IgZXJyb3JzXG4gICAgICAgIE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIDIwMCkgKyAxMDA7ICAgIC8vIDEwMC0zMDBtcyBub3JtYWxcblxuICAgICAgLy8g8J+aqCBJZiBlcnJvciBpbmplY3RlZCBieSBmZWF0dXJlIGZsYWcsIHJlY29yZCBhIFJFQUwgZXhjZXB0aW9uIG9uIHRoZSBPVGVsIHNwYW5cbiAgICAgIC8vIHNvIER5bmF0cmFjZSBjYXB0dXJlcyBzcGFuLmV2ZW50c1tdLmV4Y2VwdGlvbi4qIGZvciBEUUwgcXVlcmllc1xuICAgICAgLy8gVXNlcyBhd2FpdCBpbnN0ZWFkIG9mIHNldFRpbWVvdXQgdG8gcHJlc2VydmUgT1RlbCBhY3RpdmUgc3BhbiBjb250ZXh0XG4gICAgICBpZiAoZXJyb3JJbmplY3RlZCkge1xuICAgICAgICAvLyBTaW11bGF0ZSBwcm9jZXNzaW5nIGRlbGF5IHdoaWxlIGtlZXBpbmcgT1RlbCBzcGFuIGNvbnRleHQgYWxpdmVcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UocmVzb2x2ZSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIHByb2Nlc3NpbmdUaW1lKSk7XG4gICAgICAgIFxuICAgICAgICBjb25zdCBodHRwU3RhdHVzID0gZXJyb3JJbmplY3RlZC5odHRwX3N0YXR1cyB8fCA1MDA7XG4gICAgICAgIGNvbnN0IGVycm9yTWVzc2FnZSA9IGVycm9ySW5qZWN0ZWQubWVzc2FnZSB8fCBgRmVhdHVyZSBmbGFnIGVycm9yIGluICR7Y3VycmVudFN0ZXBOYW1lfWA7XG4gICAgICAgIFxuICAgICAgICAvLyBDcmVhdGUgYSByZWFsIEVycm9yIHRoYXQgd2lsbCBiZSByZWNvcmRlZCBvbiB0aGUgc3BhblxuICAgICAgICBjb25zdCByZWFsRXJyb3IgPSBuZXcgRXJyb3IoZXJyb3JNZXNzYWdlKTtcbiAgICAgICAgcmVhbEVycm9yLm5hbWUgPSBgRmVhdHVyZUZsYWdFcnJvcl8ke2Vycm9ySW5qZWN0ZWQuZXJyb3JfdHlwZX1gO1xuICAgICAgICByZWFsRXJyb3Iuc3RhdHVzID0gaHR0cFN0YXR1cztcbiAgICAgICAgcmVhbEVycm9yLmh0dHBTdGF0dXMgPSBodHRwU3RhdHVzO1xuICAgICAgICBcbiAgICAgICAgLy8gQWRkIHJpY2ggY29udGV4dCBzbyBpdCBzaG93cyB1cCBpbiBEeW5hdHJhY2UgZXhjZXB0aW9uIGRldGFpbHNcbiAgICAgICAgY29uc29sZS5lcnJvcihg8J+aqCBbJHtwcm9wZXJTZXJ2aWNlTmFtZX1dIEZFQVRVUkUgRkxBRyBFWENFUFRJT046ICR7ZXJyb3JNZXNzYWdlfWApO1xuICAgICAgICBjb25zb2xlLmVycm9yKGDwn5qoIFske3Byb3BlclNlcnZpY2VOYW1lfV0gRXJyb3IgVHlwZTogJHtlcnJvckluamVjdGVkLmVycm9yX3R5cGV9IHwgSFRUUCAke2h0dHBTdGF0dXN9IHwgRmxhZzogJHtlcnJvckluamVjdGVkLmZlYXR1cmVfZmxhZ31gKTtcbiAgICAgICAgXG4gICAgICAgIC8vIEFkZCBjdXN0b20gYXR0cmlidXRlcyBCRUZPUkUgdGhlIGVycm9yIHJlc3BvbnNlIHNvIE9uZUFnZW50IGNhcHR1cmVzIHRoZW0gb24gdGhlIHNwYW5cbiAgICAgICAgYWRkQ3VzdG9tQXR0cmlidXRlcyh7XG4gICAgICAgICAgJ2pvdXJuZXkuc3RlcCc6IGN1cnJlbnRTdGVwTmFtZSxcbiAgICAgICAgICAnam91cm5leS5zZXJ2aWNlJzogcHJvcGVyU2VydmljZU5hbWUsXG4gICAgICAgICAgJ2pvdXJuZXkuY29ycmVsYXRpb25JZCc6IGNvcnJlbGF0aW9uSWQsXG4gICAgICAgICAgJ2pvdXJuZXkuY29tcGFueSc6IHByb2Nlc3NlZFBheWxvYWQuY29tcGFueU5hbWUgfHwgJ3Vua25vd24nLFxuICAgICAgICAgICdqb3VybmV5LmRvbWFpbic6IHByb2Nlc3NlZFBheWxvYWQuZG9tYWluIHx8ICd1bmtub3duJyxcbiAgICAgICAgICAnam91cm5leS5pbmR1c3RyeVR5cGUnOiBwcm9jZXNzZWRQYXlsb2FkLmluZHVzdHJ5VHlwZSB8fCAndW5rbm93bicsXG4gICAgICAgICAgJ2pvdXJuZXkucHJvY2Vzc2luZ1RpbWUnOiBwcm9jZXNzaW5nVGltZSxcbiAgICAgICAgICAnZXJyb3Iub2NjdXJyZWQnOiB0cnVlLFxuICAgICAgICAgICdlcnJvci5mZWF0dXJlX2ZsYWcnOiBlcnJvckluamVjdGVkLmZlYXR1cmVfZmxhZyxcbiAgICAgICAgICAnZXJyb3IudHlwZSc6IGVycm9ySW5qZWN0ZWQuZXJyb3JfdHlwZSxcbiAgICAgICAgICAnZXJyb3IuaHR0cF9zdGF0dXMnOiBodHRwU3RhdHVzLFxuICAgICAgICAgICdlcnJvci5yZW1lZGlhdGlvbl9hY3Rpb24nOiBlcnJvckluamVjdGVkLnJlbWVkaWF0aW9uX2FjdGlvbiB8fCAndW5rbm93bidcbiAgICAgICAgfSk7XG4gICAgICAgIFxuICAgICAgICAvLyDwn5SRIFJlcG9ydCBhcyBhIHJlYWwgRHluYXRyYWNlIGV4Y2VwdGlvbiDigJQgdGhpcyBjYWxscyBzcGFuLnJlY29yZEV4Y2VwdGlvbigpIG9uIHRoZSBhY3RpdmUgT1RlbCBzcGFuXG4gICAgICAgIC8vIHdoaWNoIGNyZWF0ZXMgc3Bhbi5ldmVudHNbXSB3aXRoIGV4Y2VwdGlvbi50eXBlLCBleGNlcHRpb24ubWVzc2FnZSwgZXhjZXB0aW9uLnN0YWNrX3RyYWNlXG4gICAgICAgIHJlcG9ydEVycm9yKHJlYWxFcnJvciwge1xuICAgICAgICAgICdqb3VybmV5LnN0ZXAnOiBjdXJyZW50U3RlcE5hbWUsXG4gICAgICAgICAgJ3NlcnZpY2UubmFtZSc6IHByb3BlclNlcnZpY2VOYW1lLFxuICAgICAgICAgICdjb3JyZWxhdGlvbi5pZCc6IGNvcnJlbGF0aW9uSWQsXG4gICAgICAgICAgJ2h0dHAuc3RhdHVzJzogaHR0cFN0YXR1cyxcbiAgICAgICAgICAnZXJyb3IuY2F0ZWdvcnknOiAnZmVhdHVyZV9mbGFnX2luamVjdGlvbicsXG4gICAgICAgICAgJ2Vycm9yLmZlYXR1cmVfZmxhZyc6IGVycm9ySW5qZWN0ZWQuZmVhdHVyZV9mbGFnLFxuICAgICAgICAgICdlcnJvci50eXBlJzogZXJyb3JJbmplY3RlZC5lcnJvcl90eXBlXG4gICAgICAgIH0pO1xuICAgICAgICBcbiAgICAgICAgLy8g8J+UkSBNYXJrIHRoZSBzcGFuIGFzIGZhaWxlZCDigJQgdGhpcyBjYWxscyBzcGFuLnNldFN0YXR1cyhFUlJPUikgb24gdGhlIGFjdGl2ZSBPVGVsIHNwYW5cbiAgICAgICAgbWFya1NwYW5Bc0ZhaWxlZChyZWFsRXJyb3IsIHtcbiAgICAgICAgICAnam91cm5leS5zdGVwJzogY3VycmVudFN0ZXBOYW1lLFxuICAgICAgICAgICdzZXJ2aWNlLm5hbWUnOiBwcm9wZXJTZXJ2aWNlTmFtZSxcbiAgICAgICAgICAnY29ycmVsYXRpb24uaWQnOiBjb3JyZWxhdGlvbklkLFxuICAgICAgICAgICdodHRwLnN0YXR1cyc6IGh0dHBTdGF0dXMsXG4gICAgICAgICAgJ2Vycm9yLmNhdGVnb3J5JzogJ2ZlYXR1cmVfZmxhZ19pbmplY3Rpb24nXG4gICAgICAgIH0pO1xuICAgICAgICBcbiAgICAgICAgLy8gU2VuZCBlcnJvciBidXNpbmVzcyBldmVudFxuICAgICAgICBzZW5kRXJyb3JFdmVudCgnZmVhdHVyZV9mbGFnX2Vycm9yJywgcmVhbEVycm9yLCB7XG4gICAgICAgICAgc3RlcE5hbWU6IGN1cnJlbnRTdGVwTmFtZSxcbiAgICAgICAgICBzZXJ2aWNlTmFtZTogcHJvcGVyU2VydmljZU5hbWUsXG4gICAgICAgICAgY29ycmVsYXRpb25JZCxcbiAgICAgICAgICBodHRwU3RhdHVzLFxuICAgICAgICAgIGZlYXR1cmVGbGFnOiBlcnJvckluamVjdGVkLmZlYXR1cmVfZmxhZyxcbiAgICAgICAgICBlcnJvclR5cGU6IGVycm9ySW5qZWN0ZWQuZXJyb3JfdHlwZSxcbiAgICAgICAgICByZW1lZGlhdGlvbkFjdGlvbjogZXJyb3JJbmplY3RlZC5yZW1lZGlhdGlvbl9hY3Rpb25cbiAgICAgICAgfSk7XG4gICAgICAgIFxuICAgICAgICAvLyDwn46vIFNlbmQgRHluYXRyYWNlIGN1c3RvbSBldmVudCB2aWEgT25lQWdlbnQgU0RLICsgRXZlbnRzIEFQSSB2MlxuICAgICAgICBzZW5kRmVhdHVyZUZsYWdDdXN0b21FdmVudCh7XG4gICAgICAgICAgc2VydmljZU5hbWU6IHByb3BlclNlcnZpY2VOYW1lLFxuICAgICAgICAgIHN0ZXBOYW1lOiBjdXJyZW50U3RlcE5hbWUsXG4gICAgICAgICAgZmVhdHVyZUZsYWc6IGVycm9ySW5qZWN0ZWQuZmVhdHVyZV9mbGFnLFxuICAgICAgICAgIGVycm9yVHlwZTogZXJyb3JJbmplY3RlZC5lcnJvcl90eXBlLFxuICAgICAgICAgIGh0dHBTdGF0dXMsXG4gICAgICAgICAgY29ycmVsYXRpb25JZCxcbiAgICAgICAgICBlcnJvclJhdGU6IGVycm9yQ29uZmlnLmVycm9yc19wZXJfdHJhbnNhY3Rpb24sXG4gICAgICAgICAgZG9tYWluOiBwcm9jZXNzZWRQYXlsb2FkLmRvbWFpbiB8fCAnJyxcbiAgICAgICAgICBpbmR1c3RyeVR5cGU6IHByb2Nlc3NlZFBheWxvYWQuaW5kdXN0cnlUeXBlIHx8ICcnLFxuICAgICAgICAgIGNvbXBhbnlOYW1lOiBwcm9jZXNzZWRQYXlsb2FkLmNvbXBhbnlOYW1lIHx8ICcnXG4gICAgICAgIH0pO1xuICAgICAgICBcbiAgICAgICAgLy8gU2V0IGVycm9yIGhlYWRlcnMgZm9yIHRyYWNlIHByb3BhZ2F0aW9uXG4gICAgICAgIHJlcy5zZXRIZWFkZXIoJ3gtdHJhY2UtZXJyb3InLCAndHJ1ZScpO1xuICAgICAgICByZXMuc2V0SGVhZGVyKCd4LWVycm9yLXR5cGUnLCByZWFsRXJyb3IubmFtZSk7XG4gICAgICAgIHJlcy5zZXRIZWFkZXIoJ3gtam91cm5leS1mYWlsZWQnLCAndHJ1ZScpO1xuICAgICAgICByZXMuc2V0SGVhZGVyKCd4LWh0dHAtc3RhdHVzJywgaHR0cFN0YXR1cy50b1N0cmluZygpKTtcbiAgICAgICAgcmVzLnNldEhlYWRlcigneC1jb3JyZWxhdGlvbi1pZCcsIGNvcnJlbGF0aW9uSWQpO1xuICAgICAgICByZXMuc2V0SGVhZGVyKCd4LWR5bmF0cmFjZS10cmFjZS1pZCcsIHRyYWNlSWQpO1xuICAgICAgICByZXMuc2V0SGVhZGVyKCd4LWR5bmF0cmFjZS1zcGFuLWlkJywgc3BhbklkKTtcbiAgICAgICAgY29uc3QgdHJhY2VJZDMyID0gdHJhY2VJZC5zdWJzdHJpbmcoMCwgMzIpLnBhZEVuZCgzMiwgJzAnKTtcbiAgICAgICAgY29uc3Qgc3BhbklkMTYgPSBzcGFuSWQuc3Vic3RyaW5nKDAsIDE2KS5wYWRFbmQoMTYsICcwJyk7XG4gICAgICAgIHJlcy5zZXRIZWFkZXIoJ3RyYWNlcGFyZW50JywgYDAwLSR7dHJhY2VJZDMyfS0ke3NwYW5JZDE2fS0wMWApO1xuICAgICAgICBcbiAgICAgICAgLy8g8J+UkSBQYXNzIGVycm9yIHRocm91Z2ggRXhwcmVzcyBlcnJvciBoYW5kbGluZyBzbyBPbmVBZ2VudCBjYXB0dXJlcyBpdCBhcyBhIFJFQUwgZXhjZXB0aW9uXG4gICAgICAgIC8vIE9uZUFnZW50IGluc3RydW1lbnRzIEV4cHJlc3MgZXJyb3IgbWlkZGxld2FyZSBhbmQgcmVjb3JkcyBleGNlcHRpb25zIG9uIHRoZSBzcGFuXG4gICAgICAgIC8vIFRoaXMgbWFrZXMgZXhjZXB0aW9ucyB2aXNpYmxlIGluIER5bmF0cmFjZSdzICdFeGNlcHRpb25zJyB0YWIgb24gdHJhY2VzXG4gICAgICAgIHJlYWxFcnJvci5yZXNwb25zZVBheWxvYWQgPSB7XG4gICAgICAgICAgLi4ucHJvY2Vzc2VkUGF5bG9hZCxcbiAgICAgICAgICBzdGVwTmFtZTogY3VycmVudFN0ZXBOYW1lLFxuICAgICAgICAgIHNlcnZpY2U6IHByb3BlclNlcnZpY2VOYW1lLFxuICAgICAgICAgIHN0YXR1czogJ2Vycm9yJyxcbiAgICAgICAgICBjb3JyZWxhdGlvbklkLFxuICAgICAgICAgIHByb2Nlc3NpbmdUaW1lLFxuICAgICAgICAgIHBpZDogcHJvY2Vzcy5waWQsXG4gICAgICAgICAgdGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgICAgZXJyb3Jfb2NjdXJyZWQ6IHRydWUsXG4gICAgICAgICAgZXJyb3I6IGVycm9ySW5qZWN0ZWQsXG4gICAgICAgICAgam91cm5leVRyYWNlLFxuICAgICAgICAgIHRyYWNlRXJyb3I6IHRydWUsXG4gICAgICAgICAgaHR0cFN0YXR1cyxcbiAgICAgICAgICBfdHJhY2VJbmZvOiB7XG4gICAgICAgICAgICBmYWlsZWQ6IHRydWUsXG4gICAgICAgICAgICBlcnJvck1lc3NhZ2UsXG4gICAgICAgICAgICBlcnJvclR5cGU6IHJlYWxFcnJvci5uYW1lLFxuICAgICAgICAgICAgaHR0cFN0YXR1cyxcbiAgICAgICAgICAgIGZlYXR1cmVGbGFnOiBlcnJvckluamVjdGVkLmZlYXR1cmVfZmxhZyxcbiAgICAgICAgICAgIHJlcXVlc3RDb3JyZWxhdGlvbklkOiBjb3JyZWxhdGlvbklkXG4gICAgICAgICAgfVxuICAgICAgICB9O1xuICAgICAgICByZXR1cm4gbmV4dChyZWFsRXJyb3IpO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBmaW5pc2ggPSBhc3luYyAoKSA9PiB7XG4gICAgICAgIC8vIEdlbmVyYXRlIGR5bmFtaWMgbWV0YWRhdGEgYmFzZWQgb24gc3RlcCBuYW1lXG4gICAgICAgIGNvbnN0IG1ldGFkYXRhID0gZ2VuZXJhdGVTdGVwTWV0YWRhdGEoY3VycmVudFN0ZXBOYW1lKTtcblxuICAgICAgICAvLyBBZGQgY3VzdG9tIGF0dHJpYnV0ZXMgdG8gT25lQWdlbnQgc3BhbiAoc2ltcGxpZmllZClcbiAgICAgICAgY29uc3QgY3VzdG9tQXR0cmlidXRlcyA9IHtcbiAgICAgICAgICAnam91cm5leS5zdGVwJzogY3VycmVudFN0ZXBOYW1lLFxuICAgICAgICAgICdqb3VybmV5LnNlcnZpY2UnOiBwcm9wZXJTZXJ2aWNlTmFtZSxcbiAgICAgICAgICAnam91cm5leS5jb3JyZWxhdGlvbklkJzogY29ycmVsYXRpb25JZCxcbiAgICAgICAgICAnam91cm5leS5jb21wYW55JzogcHJvY2Vzc2VkUGF5bG9hZC5jb21wYW55TmFtZSB8fCAndW5rbm93bicsXG4gICAgICAgICAgJ2pvdXJuZXkuZG9tYWluJzogcHJvY2Vzc2VkUGF5bG9hZC5kb21haW4gfHwgJ3Vua25vd24nLFxuICAgICAgICAgICdqb3VybmV5LmluZHVzdHJ5VHlwZSc6IHByb2Nlc3NlZFBheWxvYWQuaW5kdXN0cnlUeXBlIHx8ICd1bmtub3duJyxcbiAgICAgICAgICAnam91cm5leS5wcm9jZXNzaW5nVGltZSc6IHByb2Nlc3NpbmdUaW1lXG4gICAgICAgIH07XG4gICAgICAgIFxuICAgICAgICBhZGRDdXN0b21BdHRyaWJ1dGVzKGN1c3RvbUF0dHJpYnV0ZXMpO1xuXG4gICAgICAgIC8vIOKchSBPbmVBZ2VudCBhdXRvbWF0aWNhbGx5IGNhcHR1cmVzIHRoaXMgL3Byb2Nlc3MgcmVxdWVzdCBhcyBhIGJpemV2ZW50IHZpYSBjYXB0dXJlIHJ1bGVzXG4gICAgICAgIC8vIE5vIG1hbnVhbCBzZW5kQnVzaW5lc3NFdmVudCgpIG5lZWRlZCAtIHRoZSByZXF1ZXN0IHBheWxvYWQgaXRzZWxmIGJlY29tZXMgdGhlIGJpemV2ZW50XG4gICAgICAgIGNvbnNvbGUubG9nKGBbJHtwcm9wZXJTZXJ2aWNlTmFtZX1dIFByb2Nlc3Npbmcgc3RlcCAke2N1cnJlbnRTdGVwTmFtZX0gLSBPbmVBZ2VudCB3aWxsIGNhcHR1cmUgYXMgYml6ZXZlbnRgKTtcblxuICAgICAgICBsZXQgcmVzcG9uc2UgPSB7XG4gICAgICAgICAgLy8gSW5jbHVkZSB0aGUgY2xlYW4gcHJvY2Vzc2VkIHBheWxvYWQgd2l0aG91dCBkdXBsaWNhdGlvblxuICAgICAgICAgIC4uLnByb2Nlc3NlZFBheWxvYWQsXG4gICAgICAgICAgc3RlcE5hbWU6IGN1cnJlbnRTdGVwTmFtZSxcbiAgICAgICAgICBzZXJ2aWNlOiBwcm9wZXJTZXJ2aWNlTmFtZSxcbiAgICAgICAgICBzdGF0dXM6ICdjb21wbGV0ZWQnLFxuICAgICAgICAgIGNvcnJlbGF0aW9uSWQsXG4gICAgICAgICAgcHJvY2Vzc2luZ1RpbWUsXG4gICAgICAgICAgcGlkOiBwcm9jZXNzLnBpZCxcbiAgICAgICAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgICAvLyBJbmNsdWRlIHN0ZXAtc3BlY2lmaWMgZHVyYXRpb24gZmllbGRzIGZyb20gdGhlIGN1cnJlbnQgc3RlcCBkYXRhXG4gICAgICAgICAgc3RlcERlc2NyaXB0aW9uOiBzdGVwRGVzY3JpcHRpb24sXG4gICAgICAgICAgc3RlcENhdGVnb3J5OiBzdGVwQ2F0ZWdvcnksXG4gICAgICAgICAgZXN0aW1hdGVkRHVyYXRpb246IGVzdGltYXRlZER1cmF0aW9uLFxuICAgICAgICAgIGJ1c2luZXNzUmF0aW9uYWxlOiBidXNpbmVzc1JhdGlvbmFsZSxcbiAgICAgICAgICBkdXJhdGlvbjogcHJvY2Vzc2VkUGF5bG9hZC5kdXJhdGlvbixcbiAgICAgICAgICBzdWJzdGVwczogc3Vic3RlcHMsXG4gICAgICAgICAgbWV0YWRhdGEsXG4gICAgICAgICAgam91cm5leVRyYWNlLFxuICAgICAgICAgIGVycm9yX29jY3VycmVkOiBmYWxzZVxuICAgICAgICB9O1xuXG4gICAgICAgIC8vIE5vIGZsYXR0ZW5lZCBmaWVsZHMgZHVwbGljYXRpb24gLSB0aGUgcHJvY2Vzc2VkUGF5bG9hZCBhbHJlYWR5IGNvbnRhaW5zIGNsZWFuIGRhdGFcblxuICAgICAgICAvLyBJbmNsdWRlIGluY29taW5nIHRyYWNlIGhlYWRlcnMgaW4gdGhlIHJlc3BvbnNlIGZvciB2YWxpZGF0aW9uIChub24taW52YXNpdmUpXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmVzcG9uc2UudHJhY2VwYXJlbnQgPSBpbmNvbWluZ1RyYWNlUGFyZW50IHx8IG51bGw7XG4gICAgICAgICAgcmVzcG9uc2UudHJhY2VzdGF0ZSA9IGluY29taW5nVHJhY2VTdGF0ZSB8fCBudWxsO1xuICAgICAgICAgIHJlc3BvbnNlLnhfZHluYXRyYWNlX3RyYWNlX2lkID0gZHluYXRyYWNlVHJhY2VJZCB8fCBudWxsO1xuICAgICAgICAgIHJlc3BvbnNlLnhfZHluYXRyYWNlX3BhcmVudF9zcGFuX2lkID0gcmVxLmhlYWRlcnNbJ3gtZHluYXRyYWNlLXBhcmVudC1zcGFuLWlkJ10gfHwgbnVsbDtcbiAgICAgICAgfSBjYXRjaCAoZSkge31cblxuXG4gICAgICAgIC8vIC0tLSBDaGFpbmluZyBsb2dpYyAtLS1cbiAgICAgICAgbGV0IG5leHRTdGVwTmFtZSA9IG51bGw7XG4gICAgICAgIGxldCBuZXh0U2VydmljZU5hbWUgPSB1bmRlZmluZWQ7XG4gICAgICAgIFxuICAgICAgICBjb25zb2xlLmxvZyhgWyR7cHJvcGVyU2VydmljZU5hbWV9XSDwn5SXIENIQUlOSU5HIExPR0lDOiBDaGVja2luZyBmb3IgbmV4dCBzdGVwLi4uYCk7XG4gICAgICAgIGNvbnNvbGUubG9nKGBbJHtwcm9wZXJTZXJ2aWNlTmFtZX1dIPCflJcgQ3VycmVudCBzdGVwOiAke2N1cnJlbnRTdGVwTmFtZX1gKTtcbiAgICAgICAgY29uc29sZS5sb2coYFske3Byb3BlclNlcnZpY2VOYW1lfV0g8J+UlyBIYXMgc3RlcHMgYXJyYXk6ICR7ISEocGF5bG9hZC5zdGVwcyAmJiBBcnJheS5pc0FycmF5KHBheWxvYWQuc3RlcHMpKX1gKTtcbiAgICAgICAgaWYgKHBheWxvYWQuc3RlcHMgJiYgQXJyYXkuaXNBcnJheShwYXlsb2FkLnN0ZXBzKSkge1xuICAgICAgICAgIGNvbnNvbGUubG9nKGBbJHtwcm9wZXJTZXJ2aWNlTmFtZX1dIPCflJcgU3RlcHMgYXJyYXkgbGVuZ3RoOiAke3BheWxvYWQuc3RlcHMubGVuZ3RofWApO1xuICAgICAgICAgIGNvbnNvbGUubG9nKGBbJHtwcm9wZXJTZXJ2aWNlTmFtZX1dIPCflJcgU3RlcHMgYXJyYXkgY29udGVudHM6YCwgSlNPTi5zdHJpbmdpZnkocGF5bG9hZC5zdGVwcy5tYXAocyA9PiAoeyBzdGVwTmFtZTogcy5zdGVwTmFtZSwgc2VydmljZU5hbWU6IHMuc2VydmljZU5hbWUgfSkpLCBudWxsLCAyKSk7XG4gICAgICAgICAgXG4gICAgICAgICAgY29uc3QgY3VycmVudEluZGV4ID0gcGF5bG9hZC5zdGVwcy5maW5kSW5kZXgocyA9PlxuICAgICAgICAgICAgKHMuc3RlcE5hbWUgPT09IGN1cnJlbnRTdGVwTmFtZSkgfHxcbiAgICAgICAgICAgIChzLm5hbWUgPT09IGN1cnJlbnRTdGVwTmFtZSkgfHxcbiAgICAgICAgICAgIChzLnNlcnZpY2VOYW1lID09PSBwcm9wZXJTZXJ2aWNlTmFtZSlcbiAgICAgICAgICApO1xuICAgICAgICAgIGNvbnNvbGUubG9nKGBbJHtwcm9wZXJTZXJ2aWNlTmFtZX1dIPCflJcgQ3VycmVudCBzdGVwIGluZGV4OiAke2N1cnJlbnRJbmRleH0gb2YgJHtwYXlsb2FkLnN0ZXBzLmxlbmd0aCAtIDF9YCk7XG4gICAgICAgICAgXG4gICAgICAgICAgaWYgKGN1cnJlbnRJbmRleCA+PSAwICYmIGN1cnJlbnRJbmRleCA8IHBheWxvYWQuc3RlcHMubGVuZ3RoIC0gMSkge1xuICAgICAgICAgICAgY29uc3QgbmV4dFN0ZXAgPSBwYXlsb2FkLnN0ZXBzW2N1cnJlbnRJbmRleCArIDFdO1xuICAgICAgICAgICAgbmV4dFN0ZXBOYW1lID0gbmV4dFN0ZXAgPyAobmV4dFN0ZXAuc3RlcE5hbWUgfHwgbmV4dFN0ZXAubmFtZSkgOiBudWxsO1xuICAgICAgICAgICAgbmV4dFNlcnZpY2VOYW1lID0gbmV4dFN0ZXAgJiYgbmV4dFN0ZXAuc2VydmljZU5hbWUgPyBuZXh0U3RlcC5zZXJ2aWNlTmFtZSA6IChuZXh0U3RlcE5hbWUgPyBnZXRTZXJ2aWNlTmFtZUZyb21TdGVwKG5leHRTdGVwTmFtZSkgOiB1bmRlZmluZWQpO1xuICAgICAgICAgICAgY29uc29sZS5sb2coYFske3Byb3BlclNlcnZpY2VOYW1lfV0g8J+UlyBGT1VORCBORVhUIFNURVA6ICR7bmV4dFN0ZXBOYW1lfSAoc2VydmljZTogJHtuZXh0U2VydmljZU5hbWV9KWApO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjb25zb2xlLmxvZyhgWyR7cHJvcGVyU2VydmljZU5hbWV9XSDwn5SXIE5PIE5FWFQgU1RFUDogRW5kIG9mIGpvdXJuZXkgKGN1cnJlbnQgaW5kZXg6ICR7Y3VycmVudEluZGV4fSlgKTtcbiAgICAgICAgICAgIG5leHRTdGVwTmFtZSA9IG51bGw7XG4gICAgICAgICAgICBuZXh0U2VydmljZU5hbWUgPSB1bmRlZmluZWQ7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGNvbnNvbGUubG9nKGBbJHtwcm9wZXJTZXJ2aWNlTmFtZX1dIPCflJcgTk8gU1RFUFMgQVJSQVkgaW4gcGF5bG9hZCAtIGNhbm5vdCBjaGFpbiFgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChuZXh0U3RlcE5hbWUgJiYgbmV4dFNlcnZpY2VOYW1lKSB7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKHIgPT4gc2V0VGltZW91dChyLCB0aGlua1RpbWVNcykpO1xuICAgICAgICAgICAgLy8gQXNrIG1haW4gc2VydmVyIHRvIGVuc3VyZSBuZXh0IHNlcnZpY2UgaXMgcnVubmluZyBhbmQgZ2V0IGl0cyBwb3J0XG4gICAgICAgICAgICBsZXQgbmV4dFNlcnZpY2VQb3J0ID0gbnVsbDtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGNvbnN0IGFkbWluUG9ydCA9IHByb2Nlc3MuZW52Lk1BSU5fU0VSVkVSX1BPUlQgfHwgJzQwMDAnO1xuICAgICAgICAgICAgICBuZXh0U2VydmljZVBvcnQgPSBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgcmVxID0gaHR0cC5yZXF1ZXN0KHsgaG9zdG5hbWU6ICcxMjcuMC4wLjEnLCBwb3J0OiBhZG1pblBvcnQsIHBhdGg6ICcvYXBpL2FkbWluL2Vuc3VyZS1zZXJ2aWNlJywgbWV0aG9kOiAnUE9TVCcsIGhlYWRlcnM6IHsgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyB9IH0sIChyZXMpID0+IHsgXG4gICAgICAgICAgICAgICAgICBsZXQgZGF0YSA9ICcnO1xuICAgICAgICAgICAgICAgICAgcmVzLm9uKCdkYXRhJywgY2h1bmsgPT4gZGF0YSArPSBjaHVuayk7XG4gICAgICAgICAgICAgICAgICByZXMub24oJ2VuZCcsICgpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKGRhdGEpO1xuICAgICAgICAgICAgICAgICAgICAgIHJlc29sdmUocGFyc2VkLnBvcnQgfHwgbnVsbCk7XG4gICAgICAgICAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgICAgICAgIHJlc29sdmUobnVsbCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIHJlcS5vbignZXJyb3InLCAoKSA9PiByZXNvbHZlKG51bGwpKTtcbiAgICAgICAgICAgICAgICByZXEuZW5kKEpTT04uc3RyaW5naWZ5KHsgXG4gICAgICAgICAgICAgICAgICBzdGVwTmFtZTogbmV4dFN0ZXBOYW1lLCBcbiAgICAgICAgICAgICAgICAgIHNlcnZpY2VOYW1lOiBuZXh0U2VydmljZU5hbWUsXG4gICAgICAgICAgICAgICAgICBjb250ZXh0OiB7XG4gICAgICAgICAgICAgICAgICAgIGNvbXBhbnlOYW1lOiBwYXlsb2FkLmNvbXBhbnlOYW1lLFxuICAgICAgICAgICAgICAgICAgICBkb21haW46IHBheWxvYWQuZG9tYWluLFxuICAgICAgICAgICAgICAgICAgICBpbmR1c3RyeVR5cGU6IHBheWxvYWQuaW5kdXN0cnlUeXBlLFxuICAgICAgICAgICAgICAgICAgICBqb3VybmV5VHlwZTogcGF5bG9hZC5qb3VybmV5VHlwZSxcbiAgICAgICAgICAgICAgICAgICAgc3RlcE5hbWU6IG5leHRTdGVwTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgc2VydmljZU5hbWU6IG5leHRTZXJ2aWNlTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgY2F0ZWdvcnk6IG5leHRTdGVwRGF0YT8uY2F0ZWdvcnkgfHwgJydcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KSk7XG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgWyR7cHJvcGVyU2VydmljZU5hbWV9XSBOZXh0IHNlcnZpY2UgJHtuZXh0U2VydmljZU5hbWV9IGFsbG9jYXRlZCBvbiBwb3J0ICR7bmV4dFNlcnZpY2VQb3J0fWApO1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICBjb25zb2xlLmVycm9yKGBbJHtwcm9wZXJTZXJ2aWNlTmFtZX1dIEZhaWxlZCB0byBnZXQgbmV4dCBzZXJ2aWNlIHBvcnQ6YCwgZS5tZXNzYWdlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC8vIExvb2sgdXAgbmV4dCBzdGVwJ3Mgc3BlY2lmaWMgZGF0YVxuICAgICAgICAgICAgbGV0IG5leHRTdGVwRGF0YSA9IG51bGw7XG4gICAgICAgICAgICBpZiAocGF5bG9hZC5zdGVwcyAmJiBBcnJheS5pc0FycmF5KHBheWxvYWQuc3RlcHMpKSB7XG4gICAgICAgICAgICAgIG5leHRTdGVwRGF0YSA9IHBheWxvYWQuc3RlcHMuZmluZChzdGVwID0+IFxuICAgICAgICAgICAgICAgIHN0ZXAuc3RlcE5hbWUgPT09IG5leHRTdGVwTmFtZSB8fCBcbiAgICAgICAgICAgICAgICBzdGVwLm5hbWUgPT09IG5leHRTdGVwTmFtZSB8fFxuICAgICAgICAgICAgICAgIHN0ZXAuc2VydmljZU5hbWUgPT09IG5leHRTZXJ2aWNlTmFtZVxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBuZXh0UGF5bG9hZCA9IHtcbiAgICAgICAgICAgICAgLi4ucHJvY2Vzc2VkUGF5bG9hZCwgIC8vIFVzZSBmbGF0dGVuZWQgcGF5bG9hZCBpbnN0ZWFkIG9mIG9yaWdpbmFsXG4gICAgICAgICAgICAgIHN0ZXBOYW1lOiBuZXh0U3RlcE5hbWUsXG4gICAgICAgICAgICAgIHNlcnZpY2VOYW1lOiBuZXh0U2VydmljZU5hbWUsXG4gICAgICAgICAgICAgIC8vIEFkZCBzdGVwLXNwZWNpZmljIGZpZWxkcyBmb3IgdGhlIG5leHQgc3RlcFxuICAgICAgICAgICAgICBzdGVwRGVzY3JpcHRpb246IG5leHRTdGVwRGF0YT8uZGVzY3JpcHRpb24gfHwgJycsXG4gICAgICAgICAgICAgIHN0ZXBDYXRlZ29yeTogbmV4dFN0ZXBEYXRhPy5jYXRlZ29yeSB8fCAnJyxcbiAgICAgICAgICAgICAgZXN0aW1hdGVkRHVyYXRpb246IG5leHRTdGVwRGF0YT8uZXN0aW1hdGVkRHVyYXRpb24sXG4gICAgICAgICAgICAgIGJ1c2luZXNzUmF0aW9uYWxlOiBuZXh0U3RlcERhdGE/LmJ1c2luZXNzUmF0aW9uYWxlLFxuICAgICAgICAgICAgICBzdWJzdGVwczogbmV4dFN0ZXBEYXRhPy5zdWJzdGVwcyxcbiAgICAgICAgICAgICAgZXN0aW1hdGVkRHVyYXRpb25NczogbmV4dFN0ZXBEYXRhPy5lc3RpbWF0ZWREdXJhdGlvbiA/IG5leHRTdGVwRGF0YS5lc3RpbWF0ZWREdXJhdGlvbiAqIDYwICogMTAwMCA6IG51bGwsXG4gICAgICAgICAgICAgIGFjdGlvbjogJ2F1dG9fY2hhaW5lZCcsXG4gICAgICAgICAgICAgIHBhcmVudFN0ZXA6IGN1cnJlbnRTdGVwTmFtZSxcbiAgICAgICAgICAgICAgY29ycmVsYXRpb25JZCxcbiAgICAgICAgICAgICAgam91cm5leUlkOiBwYXlsb2FkLmpvdXJuZXlJZCxcbiAgICAgICAgICAgICAgZG9tYWluOiBwYXlsb2FkLmRvbWFpbixcbiAgICAgICAgICAgICAgY29tcGFueU5hbWU6IHBheWxvYWQuY29tcGFueU5hbWUsXG4gICAgICAgICAgICAgIGluZHVzdHJ5VHlwZTogcGF5bG9hZC5pbmR1c3RyeVR5cGUsXG4gICAgICAgICAgICAgIGpvdXJuZXlUeXBlOiBwYXlsb2FkLmpvdXJuZXlUeXBlLFxuICAgICAgICAgICAgICB0aGlua1RpbWVNcyxcbiAgICAgICAgICAgICAgc3RlcHM6IHBheWxvYWQuc3RlcHMsXG4gICAgICAgICAgICAgIHRyYWNlSWQsXG4gICAgICAgICAgICAgIHNwYW5JZCwgLy8gcGFzcyBhcyBwYXJlbnRTcGFuSWQgdG8gbmV4dFxuICAgICAgICAgICAgICBqb3VybmV5VHJhY2VcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIEJ1aWxkIHByb3BlciB0cmFjZSBoZWFkZXJzIGZvciBzZXJ2aWNlLXRvLXNlcnZpY2UgY2FsbFxuICAgICAgICAgICAgY29uc3QgdHJhY2VIZWFkZXJzID0geyBcbiAgICAgICAgICAgICAgJ3gtY29ycmVsYXRpb24taWQnOiBjb3JyZWxhdGlvbklkLFxuICAgICAgICAgICAgICAvLyBXM0MgVHJhY2UgQ29udGV4dCBmb3JtYXRcbiAgICAgICAgICAgICAgJ3RyYWNlcGFyZW50JzogYDAwLSR7dHJhY2VJZC5wYWRFbmQoMzIsICcwJyl9LSR7c3BhbklkLnBhZEVuZCgxNiwgJzAnKX0tMDFgLFxuICAgICAgICAgICAgICAvLyBEeW5hdHJhY2Ugc3BlY2lmaWMgaGVhZGVyc1xuICAgICAgICAgICAgICAneC1keW5hdHJhY2UtdHJhY2UtaWQnOiB0cmFjZUlkLFxuICAgICAgICAgICAgICAneC1keW5hdHJhY2UtcGFyZW50LXNwYW4taWQnOiBzcGFuSWRcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIFBhc3MgdGhyb3VnaCBhbnkgaW5jb21pbmcgdHJhY2Ugc3RhdGVcbiAgICAgICAgICAgIGlmIChpbmNvbWluZ1RyYWNlU3RhdGUpIHtcbiAgICAgICAgICAgICAgdHJhY2VIZWFkZXJzWyd0cmFjZXN0YXRlJ10gPSBpbmNvbWluZ1RyYWNlU3RhdGU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKGBbJHtwcm9wZXJTZXJ2aWNlTmFtZX1dIFByb3BhZ2F0aW5nIHRyYWNlIHRvICR7bmV4dFNlcnZpY2VOYW1lfTogdHJhY2VwYXJlbnQ9JHt0cmFjZUhlYWRlcnNbJ3RyYWNlcGFyZW50J119YCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIFVzZSB0aGUgcG9ydCByZXR1cm5lZCBmcm9tIGVuc3VyZS1zZXJ2aWNlIEFQSSAoYWN0dWFsIGFsbG9jYXRlZCBwb3J0KVxuICAgICAgICAgICAgY29uc3QgbmV4dFBvcnQgPSBuZXh0U2VydmljZVBvcnQgfHwgZ2V0U2VydmljZVBvcnRGcm9tU3RlcChuZXh0U2VydmljZU5hbWUpO1xuICAgICAgICAgICAgY29uc29sZS5sb2coYFske3Byb3BlclNlcnZpY2VOYW1lfV0gQ2FsbGluZyAke25leHRTZXJ2aWNlTmFtZX0gb24gcG9ydCAke25leHRQb3J0fWApO1xuICAgICAgICAgICAgLy8gRW5zdXJlIG5leHQgc2VydmljZSBpcyBsaXN0ZW5pbmcgYmVmb3JlIGNhbGxpbmdcbiAgICAgICAgICAgIGF3YWl0IHdhaXRGb3JTZXJ2aWNlUmVhZHkobmV4dFBvcnQsIDUwMDApO1xuICAgICAgICAgICAgY29uc3QgbmV4dCA9IGF3YWl0IGNhbGxTZXJ2aWNlKG5leHRTZXJ2aWNlTmFtZSwgbmV4dFBheWxvYWQsIHRyYWNlSGVhZGVycywgbmV4dFBvcnQpO1xuICAgICAgICAgICAgLy8gQnViYmxlIHVwIHRoZSBmdWxsIGRvd25zdHJlYW0gdHJhY2UgdG8gdGhlIGN1cnJlbnQgcmVzcG9uc2U7IGVuc3VyZSBvdXIgb3duIHNwYW4gaXMgaW5jbHVkZWQgb25jZVxuICAgICAgICAgICAgaWYgKG5leHQgJiYgQXJyYXkuaXNBcnJheShuZXh0LnRyYWNlKSkge1xuICAgICAgICAgICAgICBjb25zdCBsYXN0ID0gbmV4dC50cmFjZVtuZXh0LnRyYWNlLmxlbmd0aCAtIDFdO1xuICAgICAgICAgICAgICAvLyBJZiBvdXIgc3BhbiBpc24ndCB0aGUgbGFzdCwgYXBwZW5kIG91cnMgYmVmb3JlIGFkb3B0aW5nXG4gICAgICAgICAgICAgIGNvbnN0IGhhc0N1cnJlbnQgPSBuZXh0LnRyYWNlLnNvbWUocyA9PiBzLnNwYW5JZCA9PT0gc3BhbklkKTtcbiAgICAgICAgICAgICAgcmVzcG9uc2UudHJhY2UgPSBoYXNDdXJyZW50ID8gbmV4dC50cmFjZSA6IFsuLi5uZXh0LnRyYWNlLCB7IHRyYWNlSWQsIHNwYW5JZCwgcGFyZW50U3BhbklkLCBzdGVwTmFtZTogY3VycmVudFN0ZXBOYW1lIH1dO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmVzcG9uc2UubmV4dCA9IG5leHQ7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgcmVzcG9uc2UubmV4dEVycm9yID0gZS5tZXNzYWdlO1xuICAgICAgICAgICAgY29uc29sZS5lcnJvcihgWyR7cHJvcGVyU2VydmljZU5hbWV9XSBFcnJvciBjYWxsaW5nIG5leHQgc2VydmljZTpgLCBlLm1lc3NhZ2UpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFNlbmQgdHJhY2UgY29udGV4dCBoZWFkZXJzIGJhY2sgaW4gcmVzcG9uc2UgZm9yIER5bmF0cmFjZSBkaXN0cmlidXRlZCB0cmFjaW5nXG4gICAgICAgIHJlcy5zZXRIZWFkZXIoJ3gtZHluYXRyYWNlLXRyYWNlLWlkJywgdHJhY2VJZCk7XG4gICAgICAgIHJlcy5zZXRIZWFkZXIoJ3gtZHluYXRyYWNlLXNwYW4taWQnLCBzcGFuSWQpO1xuICAgICAgICBpZiAocGFyZW50U3BhbklkKSB7XG4gICAgICAgICAgcmVzLnNldEhlYWRlcigneC1keW5hdHJhY2UtcGFyZW50LXNwYW4taWQnLCBwYXJlbnRTcGFuSWQpO1xuICAgICAgICB9XG4gICAgICAgIC8vIFczQyBUcmFjZSBDb250ZXh0IHJlc3BvbnNlIGhlYWRlclxuICAgICAgICBjb25zdCB0cmFjZUlkMzIgPSB0cmFjZUlkLnN1YnN0cmluZygwLCAzMikucGFkRW5kKDMyLCAnMCcpO1xuICAgICAgICBjb25zdCBzcGFuSWQxNiA9IHNwYW5JZC5zdWJzdHJpbmcoMCwgMTYpLnBhZEVuZCgxNiwgJzAnKTtcbiAgICAgICAgcmVzLnNldEhlYWRlcigndHJhY2VwYXJlbnQnLCBgMDAtJHt0cmFjZUlkMzJ9LSR7c3BhbklkMTZ9LTAxYCk7XG4gICAgICAgIHJlcy5zZXRIZWFkZXIoJ3gtY29ycmVsYXRpb24taWQnLCBjb3JyZWxhdGlvbklkKTtcbiAgICAgICAgXG4gICAgICAgIHJlcy5qc29uKHJlc3BvbnNlKTtcbiAgICAgIH07XG5cbiAgICAgIC8vIFVzZSBhd2FpdCB0byBwcmVzZXJ2ZSBPVGVsIGFjdGl2ZSBzcGFuIGNvbnRleHQgKHNldFRpbWVvdXQgbG9zZXMgaXQpXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgcHJvY2Vzc2luZ1RpbWUpKTtcbiAgICAgIGF3YWl0IGZpbmlzaCgpO1xuICAgICAgXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIC8vIEhhbmRsZSBhbnkgZXJyb3JzIHRoYXQgb2NjdXIgZHVyaW5nIHN0ZXAgcHJvY2Vzc2luZ1xuICAgICAgY29uc29sZS5lcnJvcihgWyR7cHJvcGVyU2VydmljZU5hbWV9XSBTdGVwIHByb2Nlc3NpbmcgZXJyb3I6YCwgZXJyb3IubWVzc2FnZSk7XG4gICAgICBcbiAgICAgIC8vIEVuc3VyZSBwcm9wZXIgSFRUUCBzdGF0dXMgY29kZSBpcyBzZXRcbiAgICAgIGNvbnN0IGh0dHBTdGF0dXMgPSBlcnJvci5zdGF0dXMgfHwgZXJyb3IuaHR0cFN0YXR1cyB8fCA1MDA7XG4gICAgICBcbiAgICAgIC8vIFJlcG9ydCB0aGUgZXJyb3IgdG8gRHluYXRyYWNlIGFzIGEgdHJhY2UgZXhjZXB0aW9uXG4gICAgICByZXBvcnRFcnJvcihlcnJvciwge1xuICAgICAgICAnam91cm5leS5zdGVwJzogY3VycmVudFN0ZXBOYW1lLFxuICAgICAgICAnc2VydmljZS5uYW1lJzogcHJvcGVyU2VydmljZU5hbWUsXG4gICAgICAgICdjb3JyZWxhdGlvbi5pZCc6IGNvcnJlbGF0aW9uSWQsXG4gICAgICAgICdodHRwLnN0YXR1cyc6IGh0dHBTdGF0dXMsXG4gICAgICAgICdlcnJvci5jYXRlZ29yeSc6ICdqb3VybmV5X3N0ZXBfZmFpbHVyZSdcbiAgICAgIH0pO1xuICAgICAgXG4gICAgICAvLyBNYXJrIHRyYWNlIGFzIGZhaWxlZCB3aXRoIGNvbXByZWhlbnNpdmUgY29udGV4dFxuICAgICAgbWFya1NwYW5Bc0ZhaWxlZChlcnJvciwge1xuICAgICAgICAnam91cm5leS5zdGVwJzogY3VycmVudFN0ZXBOYW1lLFxuICAgICAgICAnc2VydmljZS5uYW1lJzogcHJvcGVyU2VydmljZU5hbWUsXG4gICAgICAgICdjb3JyZWxhdGlvbi5pZCc6IGNvcnJlbGF0aW9uSWQsXG4gICAgICAgICdodHRwLnN0YXR1cyc6IGh0dHBTdGF0dXMsXG4gICAgICAgICdlcnJvci5jYXRlZ29yeSc6ICdqb3VybmV5X3N0ZXBfZmFpbHVyZScsXG4gICAgICAgICdqb3VybmV5LmNvbXBhbnknOiBwcm9jZXNzZWRQYXlsb2FkLmNvbXBhbnlOYW1lIHx8ICd1bmtub3duJyxcbiAgICAgICAgJ2pvdXJuZXkuZG9tYWluJzogcHJvY2Vzc2VkUGF5bG9hZC5kb21haW4gfHwgJ3Vua25vd24nXG4gICAgICB9KTtcbiAgICAgIFxuICAgICAgLy8gVXBkYXRlIGpvdXJuZXkgdHJhY2UgdG8gbWFyayB0aGlzIHN0ZXAgYXMgZmFpbGVkXG4gICAgICBjb25zdCBqb3VybmV5VHJhY2UgPSBBcnJheS5pc0FycmF5KHBheWxvYWQuam91cm5leVRyYWNlKSA/IFsuLi5wYXlsb2FkLmpvdXJuZXlUcmFjZV0gOiBbXTtcbiAgICAgIGNvbnN0IGZhaWxlZFN0ZXBFbnRyeSA9IHtcbiAgICAgICAgc3RlcE5hbWU6IGN1cnJlbnRTdGVwTmFtZSxcbiAgICAgICAgc2VydmljZU5hbWU6IHByb3BlclNlcnZpY2VOYW1lLFxuICAgICAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgY29ycmVsYXRpb25JZCxcbiAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgIGVycm9yOiBlcnJvci5tZXNzYWdlLFxuICAgICAgICBlcnJvclR5cGU6IGVycm9yLmNvbnN0cnVjdG9yLm5hbWUsXG4gICAgICAgIGh0dHBTdGF0dXM6IGh0dHBTdGF0dXNcbiAgICAgIH07XG4gICAgICBqb3VybmV5VHJhY2UucHVzaChmYWlsZWRTdGVwRW50cnkpO1xuICAgICAgXG4gICAgICAvLyBTZW5kIGVycm9yIGJ1c2luZXNzIGV2ZW50IHdpdGggZW5oYW5jZWQgY29udGV4dFxuICAgICAgc2VuZEVycm9yRXZlbnQoJ2pvdXJuZXlfc3RlcF9mYWlsZWQnLCBlcnJvciwge1xuICAgICAgICBzdGVwTmFtZTogY3VycmVudFN0ZXBOYW1lLFxuICAgICAgICBzZXJ2aWNlTmFtZTogcHJvcGVyU2VydmljZU5hbWUsXG4gICAgICAgIGNvcnJlbGF0aW9uSWQsXG4gICAgICAgIGh0dHBTdGF0dXM6IGh0dHBTdGF0dXMsXG4gICAgICAgIGNvbXBhbnk6IHByb2Nlc3NlZFBheWxvYWQuY29tcGFueU5hbWUgfHwgJ3Vua25vd24nLFxuICAgICAgICBkb21haW46IHByb2Nlc3NlZFBheWxvYWQuZG9tYWluIHx8ICd1bmtub3duJ1xuICAgICAgfSk7XG4gICAgICBcbiAgICAgIC8vIE9uZUFnZW50IGNhcHR1cmVzIHRoZSBiaXpldmVudCBmcm9tIHRoZSAvcHJvY2VzcyByZXF1ZXN0IGJvZHkgbmF0aXZlbHlcbiAgICAgIC8vIGFkZGl0aW9uYWxGaWVsZHMuaGFzRXJyb3Igd2FzIHNldCBpbiB0aGUgcmVxdWVzdCBwYXlsb2FkIGJ5IGpvdXJuZXktc2ltdWxhdGlvbi5qc1xuICAgICAgXG4gICAgICAvLyBCdWlsZCBjb21wcmVoZW5zaXZlIGVycm9yIHJlc3BvbnNlXG4gICAgICBjb25zdCBlcnJvclJlc3BvbnNlID0ge1xuICAgICAgICAuLi5wcm9jZXNzZWRQYXlsb2FkLCAgLy8gSW5jbHVkZSBmbGF0dGVuZWQgZmllbGRzIGZvciBjb25zaXN0ZW5jeVxuICAgICAgICBzdGF0dXM6ICdlcnJvcicsXG4gICAgICAgIGVycm9yOiBlcnJvci5tZXNzYWdlLFxuICAgICAgICBlcnJvclR5cGU6IGVycm9yLmNvbnN0cnVjdG9yLm5hbWUsXG4gICAgICAgIHN0ZXBOYW1lOiBjdXJyZW50U3RlcE5hbWUsXG4gICAgICAgIHNlcnZpY2U6IHByb3BlclNlcnZpY2VOYW1lLFxuICAgICAgICBjb3JyZWxhdGlvbklkLFxuICAgICAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgam91cm5leVRyYWNlLFxuICAgICAgICB0cmFjZUVycm9yOiB0cnVlLFxuICAgICAgICBwaWQ6IHByb2Nlc3MucGlkLFxuICAgICAgICBodHRwU3RhdHVzOiBodHRwU3RhdHVzLFxuICAgICAgICAvLyBBZGQgT25lQWdlbnQtZnJpZW5kbHkgdHJhY2UgZmFpbHVyZSBtYXJrZXJzXG4gICAgICAgIF90cmFjZUluZm86IHtcbiAgICAgICAgICBmYWlsZWQ6IHRydWUsXG4gICAgICAgICAgZXJyb3JNZXNzYWdlOiBlcnJvci5tZXNzYWdlLFxuICAgICAgICAgIGVycm9yVHlwZTogZXJyb3IuY29uc3RydWN0b3IubmFtZSxcbiAgICAgICAgICBodHRwU3RhdHVzOiBodHRwU3RhdHVzLFxuICAgICAgICAgIHJlcXVlc3RDb3JyZWxhdGlvbklkOiBjb3JyZWxhdGlvbklkXG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICBcbiAgICAgIC8vIFNldCBjb21wcmVoZW5zaXZlIGVycm9yIGhlYWRlcnMgZm9yIHRyYWNlIHByb3BhZ2F0aW9uXG4gICAgICByZXMuc2V0SGVhZGVyKCd4LXRyYWNlLWVycm9yJywgJ3RydWUnKTtcbiAgICAgIHJlcy5zZXRIZWFkZXIoJ3gtZXJyb3ItdHlwZScsIGVycm9yLmNvbnN0cnVjdG9yLm5hbWUpO1xuICAgICAgcmVzLnNldEhlYWRlcigneC1qb3VybmV5LWZhaWxlZCcsICd0cnVlJyk7XG4gICAgICByZXMuc2V0SGVhZGVyKCd4LWh0dHAtc3RhdHVzJywgaHR0cFN0YXR1cy50b1N0cmluZygpKTtcbiAgICAgIHJlcy5zZXRIZWFkZXIoJ3gtY29ycmVsYXRpb24taWQnLCBjb3JyZWxhdGlvbklkKTtcbiAgICAgIFxuICAgICAgLy8g8J+UkSBQYXNzIGVycm9yIHRocm91Z2ggRXhwcmVzcyBlcnJvciBoYW5kbGluZyBzbyBPbmVBZ2VudCBjYXB0dXJlcyB0aGUgZXhjZXB0aW9uXG4gICAgICBjb25zb2xlLmxvZyhgWyR7cHJvcGVyU2VydmljZU5hbWV9XSBQYXNzaW5nIGVycm9yIHRvIEV4cHJlc3MgZXJyb3IgaGFuZGxlciBmb3IgT25lQWdlbnQgY2FwdHVyZSAoSFRUUCAke2h0dHBTdGF0dXN9KWApO1xuICAgICAgZXJyb3Iuc3RhdHVzID0gZXJyb3Iuc3RhdHVzIHx8IGh0dHBTdGF0dXM7XG4gICAgICBlcnJvci5yZXNwb25zZVBheWxvYWQgPSBlcnJvclJlc3BvbnNlO1xuICAgICAgcmV0dXJuIG5leHQoZXJyb3IpO1xuICAgIH1cbiAgICB9KTtcblxuICAgIC8vIPCflJEgRXhwcmVzcyBlcnJvciBtaWRkbGV3YXJlIOKAlCBNVVNUIGJlIEFGVEVSIHJvdXRlcyB0byBjYXRjaCBuZXh0KGVycm9yKVxuICAgIC8vIE9uZUFnZW50IGluc3RydW1lbnRzIEV4cHJlc3MgZXJyb3IgaGFuZGxpbmcgYW5kIGNhcHR1cmVzIGV4Y2VwdGlvbnMgb24gdGhlIGFjdGl2ZSBzcGFuXG4gICAgLy8gVGhpcyBpcyB3aGF0IG1ha2VzIHJlYWwgZXhjZXB0aW9ucyB2aXNpYmxlIGluIER5bmF0cmFjZSB0cmFjZSAnRXhjZXB0aW9ucycgdGFiXG4gICAgYXBwLnVzZSgoZXJyLCByZXEsIHJlcywgbmV4dCkgPT4ge1xuICAgICAgY29uc3Qgc3RhdHVzID0gZXJyLnN0YXR1cyB8fCBlcnIuaHR0cFN0YXR1cyB8fCA1MDA7XG4gICAgICBcbiAgICAgIC8vIExvZyB0aGF0IHdlJ3JlIGhhbmRsaW5nIHRocm91Z2ggRXhwcmVzcyBlcnJvciBtaWRkbGV3YXJlIChPbmVBZ2VudCB3aWxsIGNhcHR1cmUpXG4gICAgICBjb25zb2xlLmxvZyhgWyR7cHJvcGVyU2VydmljZU5hbWV9XSDwn46vIEV4cHJlc3MgZXJyb3IgbWlkZGxld2FyZTogJHtlcnIubmFtZSB8fCAnRXJyb3InfTogJHtlcnIubWVzc2FnZX0gKEhUVFAgJHtzdGF0dXN9KWApO1xuICAgICAgXG4gICAgICAvLyBTZW5kIHJlc3BvbnNlIHBheWxvYWQgaWYgYXZhaWxhYmxlIChmcm9tIGZlYXR1cmUtZmxhZyBlcnJvciBvciBjYXRjaCBibG9jaylcbiAgICAgIGlmIChlcnIucmVzcG9uc2VQYXlsb2FkKSB7XG4gICAgICAgIHJldHVybiByZXMuc3RhdHVzKHN0YXR1cykuanNvbihlcnIucmVzcG9uc2VQYXlsb2FkKTtcbiAgICAgIH1cbiAgICAgIFxuICAgICAgLy8gRmFsbGJhY2sgZ2VuZXJpYyBlcnJvciByZXNwb25zZVxuICAgICAgcmV0dXJuIHJlcy5zdGF0dXMoc3RhdHVzKS5qc29uKHtcbiAgICAgICAgc3RhdHVzOiAnZXJyb3InLFxuICAgICAgICBlcnJvcjogZXJyLm1lc3NhZ2UsXG4gICAgICAgIGVycm9yVHlwZTogZXJyLm5hbWUgfHwgJ0Vycm9yJyxcbiAgICAgICAgc2VydmljZTogcHJvcGVyU2VydmljZU5hbWUsXG4gICAgICAgIHRyYWNlRXJyb3I6IHRydWUsXG4gICAgICAgIHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG59XG5cbi8vIEdlbmVyYXRlIGR5bmFtaWMgbWV0YWRhdGEgYmFzZWQgb24gc3RlcCBuYW1lXG5mdW5jdGlvbiBnZW5lcmF0ZVN0ZXBNZXRhZGF0YShzdGVwTmFtZSkge1xuICBjb25zdCBsb3dlclN0ZXAgPSBzdGVwTmFtZS50b0xvd2VyQ2FzZSgpO1xuICBcbiAgLy8gRGlzY292ZXJ5L0V4cGxvcmF0aW9uIHR5cGUgc3RlcHNcbiAgaWYgKGxvd2VyU3RlcC5pbmNsdWRlcygnZGlzY292ZXInKSB8fCBsb3dlclN0ZXAuaW5jbHVkZXMoJ2V4cGxvcicpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGl0ZW1zRGlzY292ZXJlZDogTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogMTAwKSArIDUwLFxuICAgICAgdG91Y2hwb2ludHNBbmFseXplZDogTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogMjApICsgMTAsXG4gICAgICBkYXRhU291cmNlc0Nvbm5lY3RlZDogTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogNSkgKyAzXG4gICAgfTtcbiAgfVxuICBcbiAgLy8gQXdhcmVuZXNzL01hcmtldGluZyB0eXBlIHN0ZXBzXG4gIGlmIChsb3dlclN0ZXAuaW5jbHVkZXMoJ2F3YXJlJykgfHwgbG93ZXJTdGVwLmluY2x1ZGVzKCdtYXJrZXQnKSkge1xuICAgIHJldHVybiB7XG4gICAgICBpbXByZXNzaW9uc0dlbmVyYXRlZDogTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogMTAwMDApICsgNTAwMCxcbiAgICAgIGNoYW5uZWxzQWN0aXZhdGVkOiBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiA4KSArIDQsXG4gICAgICBhdWRpZW5jZVJlYWNoOiBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiA1MDAwMCkgKyAyNTAwMFxuICAgIH07XG4gIH1cbiAgXG4gIC8vIENvbnNpZGVyYXRpb24vU2VsZWN0aW9uIHR5cGUgc3RlcHNcbiAgaWYgKGxvd2VyU3RlcC5pbmNsdWRlcygnY29uc2lkZXInKSB8fCBsb3dlclN0ZXAuaW5jbHVkZXMoJ3NlbGVjdCcpIHx8IGxvd2VyU3RlcC5pbmNsdWRlcygnZXZhbHVhdCcpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9wdGlvbnNFdmFsdWF0ZWQ6IE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIDE1KSArIDUsXG4gICAgICBjb21wYXJpc29uc01hZGU6IE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIDgpICsgMyxcbiAgICAgIGNyaXRlcmlhQW5hbHl6ZWQ6IE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIDIwKSArIDEwXG4gICAgfTtcbiAgfVxuICBcbiAgLy8gUHVyY2hhc2UvUHJvY2Vzcy9UcmFuc2FjdGlvbiB0eXBlIHN0ZXBzXG4gIGlmIChsb3dlclN0ZXAuaW5jbHVkZXMoJ3B1cmNoYXNlJykgfHwgbG93ZXJTdGVwLmluY2x1ZGVzKCdwcm9jZXNzJykgfHwgbG93ZXJTdGVwLmluY2x1ZGVzKCd0cmFuc2FjdGlvbicpIHx8IGxvd2VyU3RlcC5pbmNsdWRlcygnc3RhcnQnKSkge1xuICAgIHJldHVybiB7XG4gICAgICB0cmFuc2FjdGlvblZhbHVlOiBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiAxMDAwKSArIDEwMCxcbiAgICAgIHByb2Nlc3NpbmdNZXRob2Q6IFsnYXV0b21hdGVkJywgJ21hbnVhbCcsICdoeWJyaWQnXVtNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiAzKV0sXG4gICAgICBjb252ZXJzaW9uUmF0ZTogKE1hdGgucmFuZG9tKCkgKiAwLjA1ICsgMC4wMikudG9GaXhlZCgzKVxuICAgIH07XG4gIH1cbiAgXG4gIC8vIENvbXBsZXRpb24vUmV0ZW50aW9uIHR5cGUgc3RlcHNcbiAgaWYgKGxvd2VyU3RlcC5pbmNsdWRlcygnY29tcGxldCcpIHx8IGxvd2VyU3RlcC5pbmNsdWRlcygncmV0YWluJykgfHwgbG93ZXJTdGVwLmluY2x1ZGVzKCdmaW5pc2gnKSkge1xuICAgIHJldHVybiB7XG4gICAgICBjb21wbGV0aW9uUmF0ZTogKE1hdGgucmFuZG9tKCkgKiAwLjMgKyAwLjYpLnRvRml4ZWQoMyksXG4gICAgICBzYXRpc2ZhY3Rpb25TY29yZTogKE1hdGgucmFuZG9tKCkgKiAyICsgOCkudG9GaXhlZCgxKSxcbiAgICAgIGlzc3Vlc1Jlc29sdmVkOiBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiA1KVxuICAgIH07XG4gIH1cbiAgXG4gIC8vIFBvc3RQcm9jZXNzL0Fkdm9jYWN5IHR5cGUgc3RlcHNcbiAgaWYgKGxvd2VyU3RlcC5pbmNsdWRlcygncG9zdCcpIHx8IGxvd2VyU3RlcC5pbmNsdWRlcygnYWR2b2NhY3knKSB8fCBsb3dlclN0ZXAuaW5jbHVkZXMoJ2ZvbGxvdycpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGZvbGxvd1VwQWN0aW9uczogTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogMTApICsgMixcbiAgICAgIHJlZmVycmFsc0dlbmVyYXRlZDogTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogOCkgKyAxLFxuICAgICAgZW5nYWdlbWVudFNjb3JlOiBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiA0KSArIDdcbiAgICB9O1xuICB9XG4gIFxuICAvLyBEYXRhIFBlcnNpc3RlbmNlL1N0b3JhZ2UgdHlwZSBzdGVwcyAoTW9uZ29EQiBpbnRlZ3JhdGlvbilcbiAgaWYgKGxvd2VyU3RlcC5pbmNsdWRlcygncGVyc2lzdCcpIHx8IGxvd2VyU3RlcC5pbmNsdWRlcygnc3RvcmFnZScpIHx8IGxvd2VyU3RlcC5pbmNsdWRlcygnZGF0YScpIHx8IFxuICAgICAgbG93ZXJTdGVwLmluY2x1ZGVzKCdhcmNoaXZlJykgfHwgbG93ZXJTdGVwLmluY2x1ZGVzKCdyZWNvcmQnKSB8fCBsb3dlclN0ZXAuaW5jbHVkZXMoJ3NhdmUnKSkge1xuICAgIHJldHVybiB7XG4gICAgICByZWNvcmRzU3RvcmVkOiBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiA1MCkgKyAxMCxcbiAgICAgIGRhdGFJbnRlZ3JpdHlTY29yZTogKE1hdGgucmFuZG9tKCkgKiAwLjA1ICsgMC45NSkudG9GaXhlZCgzKSxcbiAgICAgIHN0b3JhZ2VFZmZpY2llbmN5OiAoTWF0aC5yYW5kb20oKSAqIDAuMSArIDAuODUpLnRvRml4ZWQoMyksXG4gICAgICBiYWNrdXBTdGF0dXM6ICdjb21wbGV0ZWQnLFxuICAgICAgaW5kZXhpbmdUaW1lOiBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiAxMDApICsgNTBcbiAgICB9O1xuICB9XG4gIFxuICAvLyBHZW5lcmljIGZhbGxiYWNrXG4gIHJldHVybiB7XG4gICAgaXRlbXNQcm9jZXNzZWQ6IE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIDUwKSArIDIwLFxuICAgIHByb2Nlc3NpbmdFZmZpY2llbmN5OiAoTWF0aC5yYW5kb20oKSAqIDAuMiArIDAuOCkudG9GaXhlZCgzKSxcbiAgICBxdWFsaXR5U2NvcmU6IChNYXRoLnJhbmRvbSgpICogMiArIDgpLnRvRml4ZWQoMSlcbiAgfTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSB7IGNyZWF0ZVN0ZXBTZXJ2aWNlIH07XG5cbi8vIEF1dG8tc3RhcnQgdGhlIHNlcnZpY2Ugd2hlbiB0aGlzIGZpbGUgaXMgcnVuIGRpcmVjdGx5XG5pZiAocmVxdWlyZS5tYWluID09PSBtb2R1bGUpIHtcbiAgLy8gR2V0IHNlcnZpY2UgbmFtZSBmcm9tIGNvbW1hbmQgbGluZSBhcmd1bWVudHMgb3IgZW52aXJvbm1lbnRcbiAgY29uc3Qgc2VydmljZU5hbWVBcmcgPSBwcm9jZXNzLmFyZ3YuZmluZCgoYXJnLCBpbmRleCkgPT4gcHJvY2Vzcy5hcmd2W2luZGV4IC0gMV0gPT09ICctLXNlcnZpY2UtbmFtZScpO1xuICBjb25zdCBzZXJ2aWNlTmFtZSA9IHNlcnZpY2VOYW1lQXJnIHx8IHByb2Nlc3MuZW52LlNFUlZJQ0VfTkFNRSB8fCAnRHluYW1pY1NlcnZpY2UnO1xuICBjb25zdCBzdGVwTmFtZSA9IHByb2Nlc3MuZW52LlNURVBfTkFNRSB8fCAnRGVmYXVsdFN0ZXAnO1xuICBcbiAgLy8gU2V0IHByb2Nlc3MgdGl0bGUgYW5kIERUX0NVU1RPTV9QUk9QIGltbWVkaWF0ZWx5IGZvciBEeW5hdHJhY2UgZGV0ZWN0aW9uXG4gIHRyeSB7XG4gICAgcHJvY2Vzcy50aXRsZSA9IHNlcnZpY2VOYW1lO1xuICAgIC8vIPCflJEgRFRfQVBQTElDQVRJT05fSUQ6IE92ZXJyaWRlcyBwYWNrYWdlLmpzb24gbmFtZSBmb3IgV2ViIGFwcGxpY2F0aW9uIGlkXG4gICAgcHJvY2Vzcy5lbnYuRFRfQVBQTElDQVRJT05fSUQgPSBzZXJ2aWNlTmFtZTtcbiAgICBcbiAgICAvLyDwn5SRIERUX0NVU1RPTV9QUk9QOiBBZGRzIGN1c3RvbSBtZXRhZGF0YSBwcm9wZXJ0aWVzXG4gICAgaWYgKCFwcm9jZXNzLmVudi5EVF9DVVNUT01fUFJPUCB8fCAhcHJvY2Vzcy5lbnYuRFRfQ1VTVE9NX1BST1AuaW5jbHVkZXMoJ2R0U2VydmljZU5hbWU9JykpIHtcbiAgICAgIHByb2Nlc3MuZW52LkRUX0NVU1RPTV9QUk9QID0gYGR0U2VydmljZU5hbWU9JHtzZXJ2aWNlTmFtZX0gY29tcGFueU5hbWU9JHtwcm9jZXNzLmVudi5DT01QQU5ZX05BTUUgfHwgJ3Vua25vd24nfSBkb21haW49JHtwcm9jZXNzLmVudi5ET01BSU4gfHwgJ3Vua25vd24nfSBpbmR1c3RyeVR5cGU9JHtwcm9jZXNzLmVudi5JTkRVU1RSWV9UWVBFIHx8ICd1bmtub3duJ31gO1xuICAgIH1cbiAgICBjb25zb2xlLmxvZyhgW2R5bmFtaWMtc3RlcC1zZXJ2aWNlXSBTZXQgcHJvY2VzcyB0aXRsZSB0bzogJHtzZXJ2aWNlTmFtZX1gKTtcbiAgICBjb25zb2xlLmxvZyhgW2R5bmFtaWMtc3RlcC1zZXJ2aWNlXSBEVF9DVVNUT01fUFJPUDogJHtwcm9jZXNzLmVudi5EVF9DVVNUT01fUFJPUH1gKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoYFtkeW5hbWljLXN0ZXAtc2VydmljZV0gRmFpbGVkIHRvIHNldCBwcm9jZXNzIHRpdGxlOiAke2UubWVzc2FnZX1gKTtcbiAgfVxuICBcbiAgY29uc29sZS5sb2coYFtkeW5hbWljLXN0ZXAtc2VydmljZV0gU3RhcnRpbmcgc2VydmljZTogJHtzZXJ2aWNlTmFtZX0gZm9yIHN0ZXA6ICR7c3RlcE5hbWV9YCk7XG4gIGNyZWF0ZVN0ZXBTZXJ2aWNlKHNlcnZpY2VOYW1lLCBzdGVwTmFtZSk7XG59Il0sIm1hcHBpbmdzIjoiQUFBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSJ9
