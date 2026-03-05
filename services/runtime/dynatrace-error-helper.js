/**
 * Enhanced Dynatrace Error Handling and Trace Failure Reporting
 * Ensures exceptions are properly captured and propagated in traces
 * Uses @dynatrace/oneagent-sdk when available for real trace integration
 * Uses @opentelemetry/api to record exceptions on spans (span.events[].exception.*)
 */

// Load OpenTelemetry API for span exception recording
// OneAgent provides an OTel API bridge so span.recordException() creates real span events
let otelTrace = null;
let otelSpanStatusCode = null;
try {
  const otelApi = require('@opentelemetry/api');
  otelTrace = otelApi.trace;
  otelSpanStatusCode = otelApi.SpanStatusCode;
  console.log('[dynatrace-otel] OpenTelemetry API loaded — span.recordException() available');
} catch (e) {
  console.log('[dynatrace-otel] OpenTelemetry API not available:', e.message);
}

// Try to load the real Dynatrace OneAgent SDK
let dtSdk = null;
let dtApi = null;
try {
  dtSdk = require('@dynatrace/oneagent-sdk');
  dtApi = dtSdk.createInstance();
  console.log('[dynatrace-sdk] OneAgent SDK loaded successfully, state:', dtApi.getCurrentState());
} catch (e) {
  console.log('[dynatrace-sdk] OneAgent SDK not available, using fallback logging:', e.message);
}

// Dynatrace API helpers for error reporting — uses real SDK when available
const addCustomAttributes = (attributes) => {
  if (dtApi && typeof dtApi.addCustomRequestAttribute === 'function') {
    // Use real OneAgent SDK to attach attributes to the current PurePath trace
    for (const [key, value] of Object.entries(attributes)) {
      try {
        dtApi.addCustomRequestAttribute(key, String(value));
      } catch (e) {
        // Silently skip if attribute can't be added
      }
    }
  }
  console.log('[dynatrace] Custom attributes:', JSON.stringify(attributes));
};

const reportError = (error, context = {}) => {
  // 🔑 Record exception on the active OTel span so Dynatrace captures span.events[].exception.*
  // This is what makes exceptions queryable via: span.events[][exception.stack_trace], exception.type, etc.
  if (otelTrace) {
    try {
      const activeSpan = otelTrace.getActiveSpan();
      if (activeSpan) {
        // recordException() creates a span event with:
        //   span_event.name = "exception"
        //   exception.type = error.name
        //   exception.message = error.message
        //   exception.stack_trace = error.stack
        activeSpan.recordException(error);
        // Set span status to ERROR so it shows as failed in Dynatrace
        activeSpan.setStatus({
          code: otelSpanStatusCode.ERROR,
          message: error.message || 'Unknown error'
        });
        // Add context as span attributes for richer exception details
        for (const [key, value] of Object.entries(context)) {
          activeSpan.setAttribute(key, String(value));
        }
        console.log(`[dynatrace-otel] Recorded exception on active span: ${error.name || 'Error'}: ${error.message}`);
      } else {
        console.log('[dynatrace-otel] No active span to record exception on');
      }
    } catch (e) {
      console.log('[dynatrace-otel] Failed to record exception on span:', e.message);
    }
  }

  // Attach exception details to the PurePath via OneAgent SDK (custom attributes)
  if (dtApi && typeof dtApi.addCustomRequestAttribute === 'function') {
    try {
      dtApi.addCustomRequestAttribute('error.message', error.message || 'Unknown error');
      dtApi.addCustomRequestAttribute('error.type', error.name || error.constructor?.name || 'Error');
      dtApi.addCustomRequestAttribute('error.stack', (error.stack || '').substring(0, 500));
      for (const [key, value] of Object.entries(context)) {
        dtApi.addCustomRequestAttribute(key, String(value));
      }
    } catch (e) {
      // Silently skip
    }
  }
  console.error(`[dynatrace-error] ${error.name || 'Error'}: ${error.message}`, JSON.stringify(context));
};

const markSpanAsFailed = (error, context = {}) => {
  // 🔑 Mark the active OTel span as failed + record exception event
  if (otelTrace) {
    try {
      const activeSpan = otelTrace.getActiveSpan();
      if (activeSpan) {
        // Ensure exception event exists on this span
        activeSpan.recordException(error);
        activeSpan.setStatus({
          code: otelSpanStatusCode.ERROR,
          message: error.message || 'Unknown'
        });
        // Set the exit-by-exception marker that Dynatrace uses for span.exit_by_exception_id
        activeSpan.setAttribute('otel.status_code', 'ERROR');
        activeSpan.setAttribute('exception.escaped', 'true');
      }
    } catch (e) {
      // Silently skip
    }
  }

  // Attach failure markers to the PurePath via OneAgent SDK
  if (dtApi && typeof dtApi.addCustomRequestAttribute === 'function') {
    try {
      dtApi.addCustomRequestAttribute('span.failed', 'true');
      dtApi.addCustomRequestAttribute('failure.message', error.message || 'Unknown');
      dtApi.addCustomRequestAttribute('failure.category', context['error.category'] || 'unknown');
    } catch (e) {
      // Silently skip
    }
  }
  console.error(`[dynatrace-span-failed] ${error.message}`, JSON.stringify(context));
};

const sendErrorEvent = (eventType, error, context = {}) => {
  console.log('[dynatrace] Error business event:', eventType, {
    error: error.message || error,
    errorType: error.constructor.name || 'Error',
    timestamp: new Date().toISOString(),
    ...context
  });
  // In real Dynatrace environment, this would send a business event
};

/**
 * Send a CUSTOM_INFO event to Dynatrace via Events API v2 when a feature flag fires.
 * Also enriches the current OneAgent PurePath trace with custom request attributes.
 * @param {Object} details - { serviceName, stepName, featureFlag, errorType, httpStatus, correlationId, errorRate, domain, industryType, companyName }
 */
const sendFeatureFlagCustomEvent = async (details = {}) => {
  const {
    serviceName = 'unknown',
    stepName = 'unknown',
    featureFlag = 'unknown',
    errorType = 'unknown',
    httpStatus = 500,
    correlationId = '',
    errorRate = 0,
    domain = '',
    industryType = '',
    companyName = ''
  } = details;

  // 1) Enrich the current PurePath trace via OneAgent SDK
  if (dtApi && typeof dtApi.addCustomRequestAttribute === 'function') {
    try {
      dtApi.addCustomRequestAttribute('feature_flag.name', featureFlag);
      dtApi.addCustomRequestAttribute('feature_flag.active', 'true');
      dtApi.addCustomRequestAttribute('feature_flag.error_type', errorType);
      dtApi.addCustomRequestAttribute('feature_flag.error_rate', String(errorRate));
      dtApi.addCustomRequestAttribute('feature_flag.service', serviceName);
      dtApi.addCustomRequestAttribute('feature_flag.step', stepName);
    } catch (e) {
      // Silently skip
    }
  }

  // 2) Send CUSTOM_INFO event to Dynatrace Events API v2
  const DT_ENVIRONMENT = process.env.DT_ENVIRONMENT || process.env.DYNATRACE_URL;
  const DT_TOKEN = process.env.DT_PLATFORM_TOKEN || process.env.DYNATRACE_TOKEN;

  if (!DT_ENVIRONMENT || !DT_TOKEN) {
    console.log('[dynatrace-sdk] No DT credentials, skipping feature flag custom event');
    return { success: false, reason: 'no_credentials' };
  }

  const eventPayload = {
    eventType: 'CUSTOM_INFO',
    title: `Feature Flag Triggered: ${featureFlag}`,
    timeout: 15,
    properties: {
      'feature_flag.name': featureFlag,
      'feature_flag.error_type': errorType,
      'feature_flag.error_rate': String(errorRate),
      'feature_flag.http_status': String(httpStatus),
      'service.name': serviceName,
      'journey.step': stepName,
      'journey.correlationId': correlationId,
      'journey.domain': domain,
      'journey.industryType': industryType,
      'journey.company': companyName,
      'triggered.by': 'gremlin-agent',
      'event.source': 'bizobs-feature-flag',
      'dt.event.description': `Feature flag "${featureFlag}" injected ${errorType} error (HTTP ${httpStatus}) on ${serviceName} / ${stepName}`
    }
  };

  try {
    const response = await fetch(`${DT_ENVIRONMENT}/api/v2/events/ingest`, {
      method: 'POST',
      headers: {
        'Authorization': `Api-Token ${DT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(eventPayload)
    });
    const result = await response.text();
    console.log(`[dynatrace-sdk] Feature flag custom event sent: ${response.status}`, result);
    return { success: response.ok, status: response.status };
  } catch (err) {
    console.error('[dynatrace-sdk] Failed to send feature flag custom event:', err.message);
    return { success: false, error: err.message };
  }
};

/**
 * Enhanced error wrapper that captures errors for Dynatrace tracing
 */
class TracedError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = 'TracedError';
    this.context = context;
    this.timestamp = new Date().toISOString();
    
    // Immediately report to Dynatrace
    markSpanAsFailed(this, context);
    reportError(this, context);
  }
}

/**
 * Async function wrapper that catches errors and reports them to Dynatrace
 */
const withErrorTracking = (serviceName, operation) => {
  return async (...args) => {
    try {
      const result = await operation(...args);
      return result;
    } catch (error) {
      const context = {
        'service.name': serviceName,
        'operation': operation.name || 'unknown',
        'error.caught': true
      };
      
      // Mark trace as failed
      markSpanAsFailed(error, context);
      reportError(error, context);
      
      // Send error business event
      sendErrorEvent('service_operation_failed', error, {
        serviceName,
        operation: operation.name || 'unknown'
      });
      
      // Re-throw to maintain error flow
      throw new TracedError(error.message, context);
    }
  };
};

/**
 * Express middleware for error handling with Dynatrace integration
 */
const errorHandlingMiddleware = (serviceName) => {
  return (error, req, res, next) => {
    const context = {
      'service.name': serviceName,
      'request.path': req.path,
      'request.method': req.method,
      'correlation.id': req.correlationId,
      'journey.step': req.body?.stepName || 'unknown'
    };
    
    // Report error to Dynatrace
    markSpanAsFailed(error, context);
    reportError(error, context);
    
    // Send error business event
    sendErrorEvent('http_request_failed', error, {
      serviceName,
      path: req.path,
      method: req.method,
      correlationId: req.correlationId,
      stepName: req.body?.stepName
    });
    
    // Add error headers for trace propagation
    res.setHeader('x-trace-error', 'true');
    res.setHeader('x-error-type', error.constructor.name);
    res.setHeader('x-error-message', error.message);
    
    // Return standardized error response
    const errorResponse = {
      status: 'error',
      error: error.message,
      errorType: error.constructor.name,
      timestamp: new Date().toISOString(),
      correlationId: req.correlationId,
      service: serviceName,
      traceError: true
    };
    
    res.status(error.status || 500).json(errorResponse);
  };
};

/**
 * Simulate random errors based on error profiles for testing
 */
const simulateRandomError = (errorProfile, stepName, context = {}) => {
  if (!errorProfile || Math.random() >= errorProfile.errorRate) {
    return null; // No error
  }
  
  const errorType = errorProfile.errorTypes[Math.floor(Math.random() * errorProfile.errorTypes.length)];
  const httpStatus = errorProfile.httpErrors[Math.floor(Math.random() * errorProfile.httpErrors.length)];
  
  const error = new TracedError(`Simulated ${errorType} in ${stepName}`, {
    'error.simulated': true,
    'error.type': errorType,
    'http.status': httpStatus,
    'journey.step': stepName,
    ...context
  });
  
  error.status = httpStatus;
  error.errorType = errorType;
  
  return error;
};

/**
 * Check if a step should fail based on hasError flag or error simulation
 */
const checkForStepError = (payload, errorProfile) => {
  // Check explicit error flag first
  if (payload.hasError === true) {
    const error = new TracedError(
      payload.errorMessage || `Step ${payload.stepName} marked as failed`,
      {
        'error.explicit': true,
        'journey.step': payload.stepName,
        'service.name': payload.serviceName
      }
    );
    error.status = payload.httpStatus || 500;
    return error;
  }
  
  // Check for simulated errors
  if (errorProfile) {
    return simulateRandomError(errorProfile, payload.stepName, {
      'journey.step': payload.stepName,
      'service.name': payload.serviceName
    });
  }
  
  return null;
};

module.exports = {
  TracedError,
  withErrorTracking,
  errorHandlingMiddleware,
  simulateRandomError,
  checkForStepError,
  markSpanAsFailed,
  reportError,
  sendErrorEvent,
  sendFeatureFlagCustomEvent,
  addCustomAttributes
};
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZHluYXRyYWNlLWVycm9yLWhlbHBlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImR5bmF0cmFjZS1lcnJvci1oZWxwZXIuanMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBFbmhhbmNlZCBEeW5hdHJhY2UgRXJyb3IgSGFuZGxpbmcgYW5kIFRyYWNlIEZhaWx1cmUgUmVwb3J0aW5nXG4gKiBFbnN1cmVzIGV4Y2VwdGlvbnMgYXJlIHByb3Blcmx5IGNhcHR1cmVkIGFuZCBwcm9wYWdhdGVkIGluIHRyYWNlc1xuICogVXNlcyBAZHluYXRyYWNlL29uZWFnZW50LXNkayB3aGVuIGF2YWlsYWJsZSBmb3IgcmVhbCB0cmFjZSBpbnRlZ3JhdGlvblxuICogVXNlcyBAb3BlbnRlbGVtZXRyeS9hcGkgdG8gcmVjb3JkIGV4Y2VwdGlvbnMgb24gc3BhbnMgKHNwYW4uZXZlbnRzW10uZXhjZXB0aW9uLiopXG4gKi9cblxuLy8gTG9hZCBPcGVuVGVsZW1ldHJ5IEFQSSBmb3Igc3BhbiBleGNlcHRpb24gcmVjb3JkaW5nXG4vLyBPbmVBZ2VudCBwcm92aWRlcyBhbiBPVGVsIEFQSSBicmlkZ2Ugc28gc3Bhbi5yZWNvcmRFeGNlcHRpb24oKSBjcmVhdGVzIHJlYWwgc3BhbiBldmVudHNcbmxldCBvdGVsVHJhY2UgPSBudWxsO1xubGV0IG90ZWxTcGFuU3RhdHVzQ29kZSA9IG51bGw7XG50cnkge1xuICBjb25zdCBvdGVsQXBpID0gcmVxdWlyZSgnQG9wZW50ZWxlbWV0cnkvYXBpJyk7XG4gIG90ZWxUcmFjZSA9IG90ZWxBcGkudHJhY2U7XG4gIG90ZWxTcGFuU3RhdHVzQ29kZSA9IG90ZWxBcGkuU3BhblN0YXR1c0NvZGU7XG4gIGNvbnNvbGUubG9nKCdbZHluYXRyYWNlLW90ZWxdIE9wZW5UZWxlbWV0cnkgQVBJIGxvYWRlZCDigJQgc3Bhbi5yZWNvcmRFeGNlcHRpb24oKSBhdmFpbGFibGUnKTtcbn0gY2F0Y2ggKGUpIHtcbiAgY29uc29sZS5sb2coJ1tkeW5hdHJhY2Utb3RlbF0gT3BlblRlbGVtZXRyeSBBUEkgbm90IGF2YWlsYWJsZTonLCBlLm1lc3NhZ2UpO1xufVxuXG4vLyBUcnkgdG8gbG9hZCB0aGUgcmVhbCBEeW5hdHJhY2UgT25lQWdlbnQgU0RLXG5sZXQgZHRTZGsgPSBudWxsO1xubGV0IGR0QXBpID0gbnVsbDtcbnRyeSB7XG4gIGR0U2RrID0gcmVxdWlyZSgnQGR5bmF0cmFjZS9vbmVhZ2VudC1zZGsnKTtcbiAgZHRBcGkgPSBkdFNkay5jcmVhdGVJbnN0YW5jZSgpO1xuICBjb25zb2xlLmxvZygnW2R5bmF0cmFjZS1zZGtdIE9uZUFnZW50IFNESyBsb2FkZWQgc3VjY2Vzc2Z1bGx5LCBzdGF0ZTonLCBkdEFwaS5nZXRDdXJyZW50U3RhdGUoKSk7XG59IGNhdGNoIChlKSB7XG4gIGNvbnNvbGUubG9nKCdbZHluYXRyYWNlLXNka10gT25lQWdlbnQgU0RLIG5vdCBhdmFpbGFibGUsIHVzaW5nIGZhbGxiYWNrIGxvZ2dpbmc6JywgZS5tZXNzYWdlKTtcbn1cblxuLy8gRHluYXRyYWNlIEFQSSBoZWxwZXJzIGZvciBlcnJvciByZXBvcnRpbmcg4oCUIHVzZXMgcmVhbCBTREsgd2hlbiBhdmFpbGFibGVcbmNvbnN0IGFkZEN1c3RvbUF0dHJpYnV0ZXMgPSAoYXR0cmlidXRlcykgPT4ge1xuICBpZiAoZHRBcGkgJiYgdHlwZW9mIGR0QXBpLmFkZEN1c3RvbVJlcXVlc3RBdHRyaWJ1dGUgPT09ICdmdW5jdGlvbicpIHtcbiAgICAvLyBVc2UgcmVhbCBPbmVBZ2VudCBTREsgdG8gYXR0YWNoIGF0dHJpYnV0ZXMgdG8gdGhlIGN1cnJlbnQgUHVyZVBhdGggdHJhY2VcbiAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhhdHRyaWJ1dGVzKSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgZHRBcGkuYWRkQ3VzdG9tUmVxdWVzdEF0dHJpYnV0ZShrZXksIFN0cmluZyh2YWx1ZSkpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAvLyBTaWxlbnRseSBza2lwIGlmIGF0dHJpYnV0ZSBjYW4ndCBiZSBhZGRlZFxuICAgICAgfVxuICAgIH1cbiAgfVxuICBjb25zb2xlLmxvZygnW2R5bmF0cmFjZV0gQ3VzdG9tIGF0dHJpYnV0ZXM6JywgSlNPTi5zdHJpbmdpZnkoYXR0cmlidXRlcykpO1xufTtcblxuY29uc3QgcmVwb3J0RXJyb3IgPSAoZXJyb3IsIGNvbnRleHQgPSB7fSkgPT4ge1xuICAvLyDwn5SRIFJlY29yZCBleGNlcHRpb24gb24gdGhlIGFjdGl2ZSBPVGVsIHNwYW4gc28gRHluYXRyYWNlIGNhcHR1cmVzIHNwYW4uZXZlbnRzW10uZXhjZXB0aW9uLipcbiAgLy8gVGhpcyBpcyB3aGF0IG1ha2VzIGV4Y2VwdGlvbnMgcXVlcnlhYmxlIHZpYTogc3Bhbi5ldmVudHNbXVtleGNlcHRpb24uc3RhY2tfdHJhY2VdLCBleGNlcHRpb24udHlwZSwgZXRjLlxuICBpZiAob3RlbFRyYWNlKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGFjdGl2ZVNwYW4gPSBvdGVsVHJhY2UuZ2V0QWN0aXZlU3BhbigpO1xuICAgICAgaWYgKGFjdGl2ZVNwYW4pIHtcbiAgICAgICAgLy8gcmVjb3JkRXhjZXB0aW9uKCkgY3JlYXRlcyBhIHNwYW4gZXZlbnQgd2l0aDpcbiAgICAgICAgLy8gICBzcGFuX2V2ZW50Lm5hbWUgPSBcImV4Y2VwdGlvblwiXG4gICAgICAgIC8vICAgZXhjZXB0aW9uLnR5cGUgPSBlcnJvci5uYW1lXG4gICAgICAgIC8vICAgZXhjZXB0aW9uLm1lc3NhZ2UgPSBlcnJvci5tZXNzYWdlXG4gICAgICAgIC8vICAgZXhjZXB0aW9uLnN0YWNrX3RyYWNlID0gZXJyb3Iuc3RhY2tcbiAgICAgICAgYWN0aXZlU3Bhbi5yZWNvcmRFeGNlcHRpb24oZXJyb3IpO1xuICAgICAgICAvLyBTZXQgc3BhbiBzdGF0dXMgdG8gRVJST1Igc28gaXQgc2hvd3MgYXMgZmFpbGVkIGluIER5bmF0cmFjZVxuICAgICAgICBhY3RpdmVTcGFuLnNldFN0YXR1cyh7XG4gICAgICAgICAgY29kZTogb3RlbFNwYW5TdGF0dXNDb2RlLkVSUk9SLFxuICAgICAgICAgIG1lc3NhZ2U6IGVycm9yLm1lc3NhZ2UgfHwgJ1Vua25vd24gZXJyb3InXG4gICAgICAgIH0pO1xuICAgICAgICAvLyBBZGQgY29udGV4dCBhcyBzcGFuIGF0dHJpYnV0ZXMgZm9yIHJpY2hlciBleGNlcHRpb24gZGV0YWlsc1xuICAgICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhjb250ZXh0KSkge1xuICAgICAgICAgIGFjdGl2ZVNwYW4uc2V0QXR0cmlidXRlKGtleSwgU3RyaW5nKHZhbHVlKSk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc29sZS5sb2coYFtkeW5hdHJhY2Utb3RlbF0gUmVjb3JkZWQgZXhjZXB0aW9uIG9uIGFjdGl2ZSBzcGFuOiAke2Vycm9yLm5hbWUgfHwgJ0Vycm9yJ306ICR7ZXJyb3IubWVzc2FnZX1gKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnNvbGUubG9nKCdbZHluYXRyYWNlLW90ZWxdIE5vIGFjdGl2ZSBzcGFuIHRvIHJlY29yZCBleGNlcHRpb24gb24nKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zb2xlLmxvZygnW2R5bmF0cmFjZS1vdGVsXSBGYWlsZWQgdG8gcmVjb3JkIGV4Y2VwdGlvbiBvbiBzcGFuOicsIGUubWVzc2FnZSk7XG4gICAgfVxuICB9XG5cbiAgLy8gQXR0YWNoIGV4Y2VwdGlvbiBkZXRhaWxzIHRvIHRoZSBQdXJlUGF0aCB2aWEgT25lQWdlbnQgU0RLIChjdXN0b20gYXR0cmlidXRlcylcbiAgaWYgKGR0QXBpICYmIHR5cGVvZiBkdEFwaS5hZGRDdXN0b21SZXF1ZXN0QXR0cmlidXRlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgdHJ5IHtcbiAgICAgIGR0QXBpLmFkZEN1c3RvbVJlcXVlc3RBdHRyaWJ1dGUoJ2Vycm9yLm1lc3NhZ2UnLCBlcnJvci5tZXNzYWdlIHx8ICdVbmtub3duIGVycm9yJyk7XG4gICAgICBkdEFwaS5hZGRDdXN0b21SZXF1ZXN0QXR0cmlidXRlKCdlcnJvci50eXBlJywgZXJyb3IubmFtZSB8fCBlcnJvci5jb25zdHJ1Y3Rvcj8ubmFtZSB8fCAnRXJyb3InKTtcbiAgICAgIGR0QXBpLmFkZEN1c3RvbVJlcXVlc3RBdHRyaWJ1dGUoJ2Vycm9yLnN0YWNrJywgKGVycm9yLnN0YWNrIHx8ICcnKS5zdWJzdHJpbmcoMCwgNTAwKSk7XG4gICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhjb250ZXh0KSkge1xuICAgICAgICBkdEFwaS5hZGRDdXN0b21SZXF1ZXN0QXR0cmlidXRlKGtleSwgU3RyaW5nKHZhbHVlKSk7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgLy8gU2lsZW50bHkgc2tpcFxuICAgIH1cbiAgfVxuICBjb25zb2xlLmVycm9yKGBbZHluYXRyYWNlLWVycm9yXSAke2Vycm9yLm5hbWUgfHwgJ0Vycm9yJ306ICR7ZXJyb3IubWVzc2FnZX1gLCBKU09OLnN0cmluZ2lmeShjb250ZXh0KSk7XG59O1xuXG5jb25zdCBtYXJrU3BhbkFzRmFpbGVkID0gKGVycm9yLCBjb250ZXh0ID0ge30pID0+IHtcbiAgLy8g8J+UkSBNYXJrIHRoZSBhY3RpdmUgT1RlbCBzcGFuIGFzIGZhaWxlZCArIHJlY29yZCBleGNlcHRpb24gZXZlbnRcbiAgaWYgKG90ZWxUcmFjZSkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBhY3RpdmVTcGFuID0gb3RlbFRyYWNlLmdldEFjdGl2ZVNwYW4oKTtcbiAgICAgIGlmIChhY3RpdmVTcGFuKSB7XG4gICAgICAgIC8vIEVuc3VyZSBleGNlcHRpb24gZXZlbnQgZXhpc3RzIG9uIHRoaXMgc3BhblxuICAgICAgICBhY3RpdmVTcGFuLnJlY29yZEV4Y2VwdGlvbihlcnJvcik7XG4gICAgICAgIGFjdGl2ZVNwYW4uc2V0U3RhdHVzKHtcbiAgICAgICAgICBjb2RlOiBvdGVsU3BhblN0YXR1c0NvZGUuRVJST1IsXG4gICAgICAgICAgbWVzc2FnZTogZXJyb3IubWVzc2FnZSB8fCAnVW5rbm93bidcbiAgICAgICAgfSk7XG4gICAgICAgIC8vIFNldCB0aGUgZXhpdC1ieS1leGNlcHRpb24gbWFya2VyIHRoYXQgRHluYXRyYWNlIHVzZXMgZm9yIHNwYW4uZXhpdF9ieV9leGNlcHRpb25faWRcbiAgICAgICAgYWN0aXZlU3Bhbi5zZXRBdHRyaWJ1dGUoJ290ZWwuc3RhdHVzX2NvZGUnLCAnRVJST1InKTtcbiAgICAgICAgYWN0aXZlU3Bhbi5zZXRBdHRyaWJ1dGUoJ2V4Y2VwdGlvbi5lc2NhcGVkJywgJ3RydWUnKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAvLyBTaWxlbnRseSBza2lwXG4gICAgfVxuICB9XG5cbiAgLy8gQXR0YWNoIGZhaWx1cmUgbWFya2VycyB0byB0aGUgUHVyZVBhdGggdmlhIE9uZUFnZW50IFNES1xuICBpZiAoZHRBcGkgJiYgdHlwZW9mIGR0QXBpLmFkZEN1c3RvbVJlcXVlc3RBdHRyaWJ1dGUgPT09ICdmdW5jdGlvbicpIHtcbiAgICB0cnkge1xuICAgICAgZHRBcGkuYWRkQ3VzdG9tUmVxdWVzdEF0dHJpYnV0ZSgnc3Bhbi5mYWlsZWQnLCAndHJ1ZScpO1xuICAgICAgZHRBcGkuYWRkQ3VzdG9tUmVxdWVzdEF0dHJpYnV0ZSgnZmFpbHVyZS5tZXNzYWdlJywgZXJyb3IubWVzc2FnZSB8fCAnVW5rbm93bicpO1xuICAgICAgZHRBcGkuYWRkQ3VzdG9tUmVxdWVzdEF0dHJpYnV0ZSgnZmFpbHVyZS5jYXRlZ29yeScsIGNvbnRleHRbJ2Vycm9yLmNhdGVnb3J5J10gfHwgJ3Vua25vd24nKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAvLyBTaWxlbnRseSBza2lwXG4gICAgfVxuICB9XG4gIGNvbnNvbGUuZXJyb3IoYFtkeW5hdHJhY2Utc3Bhbi1mYWlsZWRdICR7ZXJyb3IubWVzc2FnZX1gLCBKU09OLnN0cmluZ2lmeShjb250ZXh0KSk7XG59O1xuXG5jb25zdCBzZW5kRXJyb3JFdmVudCA9IChldmVudFR5cGUsIGVycm9yLCBjb250ZXh0ID0ge30pID0+IHtcbiAgY29uc29sZS5sb2coJ1tkeW5hdHJhY2VdIEVycm9yIGJ1c2luZXNzIGV2ZW50OicsIGV2ZW50VHlwZSwge1xuICAgIGVycm9yOiBlcnJvci5tZXNzYWdlIHx8IGVycm9yLFxuICAgIGVycm9yVHlwZTogZXJyb3IuY29uc3RydWN0b3IubmFtZSB8fCAnRXJyb3InLFxuICAgIHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgIC4uLmNvbnRleHRcbiAgfSk7XG4gIC8vIEluIHJlYWwgRHluYXRyYWNlIGVudmlyb25tZW50LCB0aGlzIHdvdWxkIHNlbmQgYSBidXNpbmVzcyBldmVudFxufTtcblxuLyoqXG4gKiBTZW5kIGEgQ1VTVE9NX0lORk8gZXZlbnQgdG8gRHluYXRyYWNlIHZpYSBFdmVudHMgQVBJIHYyIHdoZW4gYSBmZWF0dXJlIGZsYWcgZmlyZXMuXG4gKiBBbHNvIGVucmljaGVzIHRoZSBjdXJyZW50IE9uZUFnZW50IFB1cmVQYXRoIHRyYWNlIHdpdGggY3VzdG9tIHJlcXVlc3QgYXR0cmlidXRlcy5cbiAqIEBwYXJhbSB7T2JqZWN0fSBkZXRhaWxzIC0geyBzZXJ2aWNlTmFtZSwgc3RlcE5hbWUsIGZlYXR1cmVGbGFnLCBlcnJvclR5cGUsIGh0dHBTdGF0dXMsIGNvcnJlbGF0aW9uSWQsIGVycm9yUmF0ZSwgZG9tYWluLCBpbmR1c3RyeVR5cGUsIGNvbXBhbnlOYW1lIH1cbiAqL1xuY29uc3Qgc2VuZEZlYXR1cmVGbGFnQ3VzdG9tRXZlbnQgPSBhc3luYyAoZGV0YWlscyA9IHt9KSA9PiB7XG4gIGNvbnN0IHtcbiAgICBzZXJ2aWNlTmFtZSA9ICd1bmtub3duJyxcbiAgICBzdGVwTmFtZSA9ICd1bmtub3duJyxcbiAgICBmZWF0dXJlRmxhZyA9ICd1bmtub3duJyxcbiAgICBlcnJvclR5cGUgPSAndW5rbm93bicsXG4gICAgaHR0cFN0YXR1cyA9IDUwMCxcbiAgICBjb3JyZWxhdGlvbklkID0gJycsXG4gICAgZXJyb3JSYXRlID0gMCxcbiAgICBkb21haW4gPSAnJyxcbiAgICBpbmR1c3RyeVR5cGUgPSAnJyxcbiAgICBjb21wYW55TmFtZSA9ICcnXG4gIH0gPSBkZXRhaWxzO1xuXG4gIC8vIDEpIEVucmljaCB0aGUgY3VycmVudCBQdXJlUGF0aCB0cmFjZSB2aWEgT25lQWdlbnQgU0RLXG4gIGlmIChkdEFwaSAmJiB0eXBlb2YgZHRBcGkuYWRkQ3VzdG9tUmVxdWVzdEF0dHJpYnV0ZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIHRyeSB7XG4gICAgICBkdEFwaS5hZGRDdXN0b21SZXF1ZXN0QXR0cmlidXRlKCdmZWF0dXJlX2ZsYWcubmFtZScsIGZlYXR1cmVGbGFnKTtcbiAgICAgIGR0QXBpLmFkZEN1c3RvbVJlcXVlc3RBdHRyaWJ1dGUoJ2ZlYXR1cmVfZmxhZy5hY3RpdmUnLCAndHJ1ZScpO1xuICAgICAgZHRBcGkuYWRkQ3VzdG9tUmVxdWVzdEF0dHJpYnV0ZSgnZmVhdHVyZV9mbGFnLmVycm9yX3R5cGUnLCBlcnJvclR5cGUpO1xuICAgICAgZHRBcGkuYWRkQ3VzdG9tUmVxdWVzdEF0dHJpYnV0ZSgnZmVhdHVyZV9mbGFnLmVycm9yX3JhdGUnLCBTdHJpbmcoZXJyb3JSYXRlKSk7XG4gICAgICBkdEFwaS5hZGRDdXN0b21SZXF1ZXN0QXR0cmlidXRlKCdmZWF0dXJlX2ZsYWcuc2VydmljZScsIHNlcnZpY2VOYW1lKTtcbiAgICAgIGR0QXBpLmFkZEN1c3RvbVJlcXVlc3RBdHRyaWJ1dGUoJ2ZlYXR1cmVfZmxhZy5zdGVwJywgc3RlcE5hbWUpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIC8vIFNpbGVudGx5IHNraXBcbiAgICB9XG4gIH1cblxuICAvLyAyKSBTZW5kIENVU1RPTV9JTkZPIGV2ZW50IHRvIER5bmF0cmFjZSBFdmVudHMgQVBJIHYyXG4gIGNvbnN0IERUX0VOVklST05NRU5UID0gcHJvY2Vzcy5lbnYuRFRfRU5WSVJPTk1FTlQgfHwgcHJvY2Vzcy5lbnYuRFlOQVRSQUNFX1VSTDtcbiAgY29uc3QgRFRfVE9LRU4gPSBwcm9jZXNzLmVudi5EVF9QTEFURk9STV9UT0tFTiB8fCBwcm9jZXNzLmVudi5EWU5BVFJBQ0VfVE9LRU47XG5cbiAgaWYgKCFEVF9FTlZJUk9OTUVOVCB8fCAhRFRfVE9LRU4pIHtcbiAgICBjb25zb2xlLmxvZygnW2R5bmF0cmFjZS1zZGtdIE5vIERUIGNyZWRlbnRpYWxzLCBza2lwcGluZyBmZWF0dXJlIGZsYWcgY3VzdG9tIGV2ZW50Jyk7XG4gICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIHJlYXNvbjogJ25vX2NyZWRlbnRpYWxzJyB9O1xuICB9XG5cbiAgY29uc3QgZXZlbnRQYXlsb2FkID0ge1xuICAgIGV2ZW50VHlwZTogJ0NVU1RPTV9JTkZPJyxcbiAgICB0aXRsZTogYEZlYXR1cmUgRmxhZyBUcmlnZ2VyZWQ6ICR7ZmVhdHVyZUZsYWd9YCxcbiAgICB0aW1lb3V0OiAxNSxcbiAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAnZmVhdHVyZV9mbGFnLm5hbWUnOiBmZWF0dXJlRmxhZyxcbiAgICAgICdmZWF0dXJlX2ZsYWcuZXJyb3JfdHlwZSc6IGVycm9yVHlwZSxcbiAgICAgICdmZWF0dXJlX2ZsYWcuZXJyb3JfcmF0ZSc6IFN0cmluZyhlcnJvclJhdGUpLFxuICAgICAgJ2ZlYXR1cmVfZmxhZy5odHRwX3N0YXR1cyc6IFN0cmluZyhodHRwU3RhdHVzKSxcbiAgICAgICdzZXJ2aWNlLm5hbWUnOiBzZXJ2aWNlTmFtZSxcbiAgICAgICdqb3VybmV5LnN0ZXAnOiBzdGVwTmFtZSxcbiAgICAgICdqb3VybmV5LmNvcnJlbGF0aW9uSWQnOiBjb3JyZWxhdGlvbklkLFxuICAgICAgJ2pvdXJuZXkuZG9tYWluJzogZG9tYWluLFxuICAgICAgJ2pvdXJuZXkuaW5kdXN0cnlUeXBlJzogaW5kdXN0cnlUeXBlLFxuICAgICAgJ2pvdXJuZXkuY29tcGFueSc6IGNvbXBhbnlOYW1lLFxuICAgICAgJ3RyaWdnZXJlZC5ieSc6ICdncmVtbGluLWFnZW50JyxcbiAgICAgICdldmVudC5zb3VyY2UnOiAnYml6b2JzLWZlYXR1cmUtZmxhZycsXG4gICAgICAnZHQuZXZlbnQuZGVzY3JpcHRpb24nOiBgRmVhdHVyZSBmbGFnIFwiJHtmZWF0dXJlRmxhZ31cIiBpbmplY3RlZCAke2Vycm9yVHlwZX0gZXJyb3IgKEhUVFAgJHtodHRwU3RhdHVzfSkgb24gJHtzZXJ2aWNlTmFtZX0gLyAke3N0ZXBOYW1lfWBcbiAgICB9XG4gIH07XG5cbiAgdHJ5IHtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKGAke0RUX0VOVklST05NRU5UfS9hcGkvdjIvZXZlbnRzL2luZ2VzdGAsIHtcbiAgICAgIG1ldGhvZDogJ1BPU1QnLFxuICAgICAgaGVhZGVyczoge1xuICAgICAgICAnQXV0aG9yaXphdGlvbic6IGBBcGktVG9rZW4gJHtEVF9UT0tFTn1gLFxuICAgICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nXG4gICAgICB9LFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoZXZlbnRQYXlsb2FkKVxuICAgIH0pO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcbiAgICBjb25zb2xlLmxvZyhgW2R5bmF0cmFjZS1zZGtdIEZlYXR1cmUgZmxhZyBjdXN0b20gZXZlbnQgc2VudDogJHtyZXNwb25zZS5zdGF0dXN9YCwgcmVzdWx0KTtcbiAgICByZXR1cm4geyBzdWNjZXNzOiByZXNwb25zZS5vaywgc3RhdHVzOiByZXNwb25zZS5zdGF0dXMgfTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc29sZS5lcnJvcignW2R5bmF0cmFjZS1zZGtdIEZhaWxlZCB0byBzZW5kIGZlYXR1cmUgZmxhZyBjdXN0b20gZXZlbnQ6JywgZXJyLm1lc3NhZ2UpO1xuICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogZXJyLm1lc3NhZ2UgfTtcbiAgfVxufTtcblxuLyoqXG4gKiBFbmhhbmNlZCBlcnJvciB3cmFwcGVyIHRoYXQgY2FwdHVyZXMgZXJyb3JzIGZvciBEeW5hdHJhY2UgdHJhY2luZ1xuICovXG5jbGFzcyBUcmFjZWRFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IobWVzc2FnZSwgY29udGV4dCA9IHt9KSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gJ1RyYWNlZEVycm9yJztcbiAgICB0aGlzLmNvbnRleHQgPSBjb250ZXh0O1xuICAgIHRoaXMudGltZXN0YW1wID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuICAgIFxuICAgIC8vIEltbWVkaWF0ZWx5IHJlcG9ydCB0byBEeW5hdHJhY2VcbiAgICBtYXJrU3BhbkFzRmFpbGVkKHRoaXMsIGNvbnRleHQpO1xuICAgIHJlcG9ydEVycm9yKHRoaXMsIGNvbnRleHQpO1xuICB9XG59XG5cbi8qKlxuICogQXN5bmMgZnVuY3Rpb24gd3JhcHBlciB0aGF0IGNhdGNoZXMgZXJyb3JzIGFuZCByZXBvcnRzIHRoZW0gdG8gRHluYXRyYWNlXG4gKi9cbmNvbnN0IHdpdGhFcnJvclRyYWNraW5nID0gKHNlcnZpY2VOYW1lLCBvcGVyYXRpb24pID0+IHtcbiAgcmV0dXJuIGFzeW5jICguLi5hcmdzKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IG9wZXJhdGlvbiguLi5hcmdzKTtcbiAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnN0IGNvbnRleHQgPSB7XG4gICAgICAgICdzZXJ2aWNlLm5hbWUnOiBzZXJ2aWNlTmFtZSxcbiAgICAgICAgJ29wZXJhdGlvbic6IG9wZXJhdGlvbi5uYW1lIHx8ICd1bmtub3duJyxcbiAgICAgICAgJ2Vycm9yLmNhdWdodCc6IHRydWVcbiAgICAgIH07XG4gICAgICBcbiAgICAgIC8vIE1hcmsgdHJhY2UgYXMgZmFpbGVkXG4gICAgICBtYXJrU3BhbkFzRmFpbGVkKGVycm9yLCBjb250ZXh0KTtcbiAgICAgIHJlcG9ydEVycm9yKGVycm9yLCBjb250ZXh0KTtcbiAgICAgIFxuICAgICAgLy8gU2VuZCBlcnJvciBidXNpbmVzcyBldmVudFxuICAgICAgc2VuZEVycm9yRXZlbnQoJ3NlcnZpY2Vfb3BlcmF0aW9uX2ZhaWxlZCcsIGVycm9yLCB7XG4gICAgICAgIHNlcnZpY2VOYW1lLFxuICAgICAgICBvcGVyYXRpb246IG9wZXJhdGlvbi5uYW1lIHx8ICd1bmtub3duJ1xuICAgICAgfSk7XG4gICAgICBcbiAgICAgIC8vIFJlLXRocm93IHRvIG1haW50YWluIGVycm9yIGZsb3dcbiAgICAgIHRocm93IG5ldyBUcmFjZWRFcnJvcihlcnJvci5tZXNzYWdlLCBjb250ZXh0KTtcbiAgICB9XG4gIH07XG59O1xuXG4vKipcbiAqIEV4cHJlc3MgbWlkZGxld2FyZSBmb3IgZXJyb3IgaGFuZGxpbmcgd2l0aCBEeW5hdHJhY2UgaW50ZWdyYXRpb25cbiAqL1xuY29uc3QgZXJyb3JIYW5kbGluZ01pZGRsZXdhcmUgPSAoc2VydmljZU5hbWUpID0+IHtcbiAgcmV0dXJuIChlcnJvciwgcmVxLCByZXMsIG5leHQpID0+IHtcbiAgICBjb25zdCBjb250ZXh0ID0ge1xuICAgICAgJ3NlcnZpY2UubmFtZSc6IHNlcnZpY2VOYW1lLFxuICAgICAgJ3JlcXVlc3QucGF0aCc6IHJlcS5wYXRoLFxuICAgICAgJ3JlcXVlc3QubWV0aG9kJzogcmVxLm1ldGhvZCxcbiAgICAgICdjb3JyZWxhdGlvbi5pZCc6IHJlcS5jb3JyZWxhdGlvbklkLFxuICAgICAgJ2pvdXJuZXkuc3RlcCc6IHJlcS5ib2R5Py5zdGVwTmFtZSB8fCAndW5rbm93bidcbiAgICB9O1xuICAgIFxuICAgIC8vIFJlcG9ydCBlcnJvciB0byBEeW5hdHJhY2VcbiAgICBtYXJrU3BhbkFzRmFpbGVkKGVycm9yLCBjb250ZXh0KTtcbiAgICByZXBvcnRFcnJvcihlcnJvciwgY29udGV4dCk7XG4gICAgXG4gICAgLy8gU2VuZCBlcnJvciBidXNpbmVzcyBldmVudFxuICAgIHNlbmRFcnJvckV2ZW50KCdodHRwX3JlcXVlc3RfZmFpbGVkJywgZXJyb3IsIHtcbiAgICAgIHNlcnZpY2VOYW1lLFxuICAgICAgcGF0aDogcmVxLnBhdGgsXG4gICAgICBtZXRob2Q6IHJlcS5tZXRob2QsXG4gICAgICBjb3JyZWxhdGlvbklkOiByZXEuY29ycmVsYXRpb25JZCxcbiAgICAgIHN0ZXBOYW1lOiByZXEuYm9keT8uc3RlcE5hbWVcbiAgICB9KTtcbiAgICBcbiAgICAvLyBBZGQgZXJyb3IgaGVhZGVycyBmb3IgdHJhY2UgcHJvcGFnYXRpb25cbiAgICByZXMuc2V0SGVhZGVyKCd4LXRyYWNlLWVycm9yJywgJ3RydWUnKTtcbiAgICByZXMuc2V0SGVhZGVyKCd4LWVycm9yLXR5cGUnLCBlcnJvci5jb25zdHJ1Y3Rvci5uYW1lKTtcbiAgICByZXMuc2V0SGVhZGVyKCd4LWVycm9yLW1lc3NhZ2UnLCBlcnJvci5tZXNzYWdlKTtcbiAgICBcbiAgICAvLyBSZXR1cm4gc3RhbmRhcmRpemVkIGVycm9yIHJlc3BvbnNlXG4gICAgY29uc3QgZXJyb3JSZXNwb25zZSA9IHtcbiAgICAgIHN0YXR1czogJ2Vycm9yJyxcbiAgICAgIGVycm9yOiBlcnJvci5tZXNzYWdlLFxuICAgICAgZXJyb3JUeXBlOiBlcnJvci5jb25zdHJ1Y3Rvci5uYW1lLFxuICAgICAgdGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICBjb3JyZWxhdGlvbklkOiByZXEuY29ycmVsYXRpb25JZCxcbiAgICAgIHNlcnZpY2U6IHNlcnZpY2VOYW1lLFxuICAgICAgdHJhY2VFcnJvcjogdHJ1ZVxuICAgIH07XG4gICAgXG4gICAgcmVzLnN0YXR1cyhlcnJvci5zdGF0dXMgfHwgNTAwKS5qc29uKGVycm9yUmVzcG9uc2UpO1xuICB9O1xufTtcblxuLyoqXG4gKiBTaW11bGF0ZSByYW5kb20gZXJyb3JzIGJhc2VkIG9uIGVycm9yIHByb2ZpbGVzIGZvciB0ZXN0aW5nXG4gKi9cbmNvbnN0IHNpbXVsYXRlUmFuZG9tRXJyb3IgPSAoZXJyb3JQcm9maWxlLCBzdGVwTmFtZSwgY29udGV4dCA9IHt9KSA9PiB7XG4gIGlmICghZXJyb3JQcm9maWxlIHx8IE1hdGgucmFuZG9tKCkgPj0gZXJyb3JQcm9maWxlLmVycm9yUmF0ZSkge1xuICAgIHJldHVybiBudWxsOyAvLyBObyBlcnJvclxuICB9XG4gIFxuICBjb25zdCBlcnJvclR5cGUgPSBlcnJvclByb2ZpbGUuZXJyb3JUeXBlc1tNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiBlcnJvclByb2ZpbGUuZXJyb3JUeXBlcy5sZW5ndGgpXTtcbiAgY29uc3QgaHR0cFN0YXR1cyA9IGVycm9yUHJvZmlsZS5odHRwRXJyb3JzW01hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIGVycm9yUHJvZmlsZS5odHRwRXJyb3JzLmxlbmd0aCldO1xuICBcbiAgY29uc3QgZXJyb3IgPSBuZXcgVHJhY2VkRXJyb3IoYFNpbXVsYXRlZCAke2Vycm9yVHlwZX0gaW4gJHtzdGVwTmFtZX1gLCB7XG4gICAgJ2Vycm9yLnNpbXVsYXRlZCc6IHRydWUsXG4gICAgJ2Vycm9yLnR5cGUnOiBlcnJvclR5cGUsXG4gICAgJ2h0dHAuc3RhdHVzJzogaHR0cFN0YXR1cyxcbiAgICAnam91cm5leS5zdGVwJzogc3RlcE5hbWUsXG4gICAgLi4uY29udGV4dFxuICB9KTtcbiAgXG4gIGVycm9yLnN0YXR1cyA9IGh0dHBTdGF0dXM7XG4gIGVycm9yLmVycm9yVHlwZSA9IGVycm9yVHlwZTtcbiAgXG4gIHJldHVybiBlcnJvcjtcbn07XG5cbi8qKlxuICogQ2hlY2sgaWYgYSBzdGVwIHNob3VsZCBmYWlsIGJhc2VkIG9uIGhhc0Vycm9yIGZsYWcgb3IgZXJyb3Igc2ltdWxhdGlvblxuICovXG5jb25zdCBjaGVja0ZvclN0ZXBFcnJvciA9IChwYXlsb2FkLCBlcnJvclByb2ZpbGUpID0+IHtcbiAgLy8gQ2hlY2sgZXhwbGljaXQgZXJyb3IgZmxhZyBmaXJzdFxuICBpZiAocGF5bG9hZC5oYXNFcnJvciA9PT0gdHJ1ZSkge1xuICAgIGNvbnN0IGVycm9yID0gbmV3IFRyYWNlZEVycm9yKFxuICAgICAgcGF5bG9hZC5lcnJvck1lc3NhZ2UgfHwgYFN0ZXAgJHtwYXlsb2FkLnN0ZXBOYW1lfSBtYXJrZWQgYXMgZmFpbGVkYCxcbiAgICAgIHtcbiAgICAgICAgJ2Vycm9yLmV4cGxpY2l0JzogdHJ1ZSxcbiAgICAgICAgJ2pvdXJuZXkuc3RlcCc6IHBheWxvYWQuc3RlcE5hbWUsXG4gICAgICAgICdzZXJ2aWNlLm5hbWUnOiBwYXlsb2FkLnNlcnZpY2VOYW1lXG4gICAgICB9XG4gICAgKTtcbiAgICBlcnJvci5zdGF0dXMgPSBwYXlsb2FkLmh0dHBTdGF0dXMgfHwgNTAwO1xuICAgIHJldHVybiBlcnJvcjtcbiAgfVxuICBcbiAgLy8gQ2hlY2sgZm9yIHNpbXVsYXRlZCBlcnJvcnNcbiAgaWYgKGVycm9yUHJvZmlsZSkge1xuICAgIHJldHVybiBzaW11bGF0ZVJhbmRvbUVycm9yKGVycm9yUHJvZmlsZSwgcGF5bG9hZC5zdGVwTmFtZSwge1xuICAgICAgJ2pvdXJuZXkuc3RlcCc6IHBheWxvYWQuc3RlcE5hbWUsXG4gICAgICAnc2VydmljZS5uYW1lJzogcGF5bG9hZC5zZXJ2aWNlTmFtZVxuICAgIH0pO1xuICB9XG4gIFxuICByZXR1cm4gbnVsbDtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICBUcmFjZWRFcnJvcixcbiAgd2l0aEVycm9yVHJhY2tpbmcsXG4gIGVycm9ySGFuZGxpbmdNaWRkbGV3YXJlLFxuICBzaW11bGF0ZVJhbmRvbUVycm9yLFxuICBjaGVja0ZvclN0ZXBFcnJvcixcbiAgbWFya1NwYW5Bc0ZhaWxlZCxcbiAgcmVwb3J0RXJyb3IsXG4gIHNlbmRFcnJvckV2ZW50LFxuICBzZW5kRmVhdHVyZUZsYWdDdXN0b21FdmVudCxcbiAgYWRkQ3VzdG9tQXR0cmlidXRlc1xufTsiXSwibWFwcGluZ3MiOiJBQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EifQ==
