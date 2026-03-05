/**
 * Generic service runner for Dynatrace Business Observability
 * Isolated Node.js processes that Dynatrace can track as separate services
 */
const express = require('express');
const http = require('http');
const crypto = require('crypto');

// Load enhanced error handling if available
let errorHandlingMiddleware;
try {
  const errorHelper = require('./dynatrace-error-helper.js');
  errorHandlingMiddleware = errorHelper.errorHandlingMiddleware;
} catch (e) {
  // Fallback if error helper is not available
  errorHandlingMiddleware = (serviceName) => (error, req, res, next) => {
    console.error(`[${serviceName}] Unhandled error:`, error.message);
    res.status(500).json({ 
      status: 'error', 
      error: error.message,
      service: serviceName,
      traceError: true
    });
  };
}

// Extract company context from environment (exact field names for Dynatrace filtering)
const companyName = process.env.COMPANY_NAME || 'DefaultCompany';
const domain = process.env.DOMAIN || 'default.com';
const industryType = process.env.INDUSTRY_TYPE || 'general';
const stepNameEnv = process.env.STEP_NAME || 'UnknownStep';

// Set Dynatrace environment variables for OneAgent
const serviceName = process.argv[2] || 'UnknownService';

// Set process title for OneAgent detection
process.title = serviceName;

// 🔑 DT_APPLICATION_ID: Overrides package.json name for Web application id
// This is what OneAgent uses for service detection/naming
process.env.DT_APPLICATION_ID = serviceName;

// 🔑 DT_CUSTOM_PROP: Adds custom metadata properties to the service
if (!process.env.DT_CUSTOM_PROP || !process.env.DT_CUSTOM_PROP.includes('dtServiceName=')) {
  process.env.DT_CUSTOM_PROP = `dtServiceName=${serviceName} companyName=${companyName} domain=${domain} industryType=${industryType}`;
}

// Internal env vars for app-level code
process.env.DT_SERVICE_NAME = serviceName;
process.env.DT_CLUSTER_ID = serviceName;
process.env.DT_NODE_ID = `${serviceName}-node`;

function createService(serviceName, mountFn) {
  // CRITICAL: Set process identity for Dynatrace detection immediately
  try { 
    // Set process title - this is what Dynatrace sees as the service name
    process.title = serviceName; 
    
    // 🔑 DT_APPLICATION_ID: Overrides package.json name for Web application id
    process.env.DT_APPLICATION_ID = serviceName;
    
    // 🔑 DT_CUSTOM_PROP: Adds custom metadata properties
    if (!process.env.DT_CUSTOM_PROP || !process.env.DT_CUSTOM_PROP.includes('dtServiceName=')) {
      process.env.DT_CUSTOM_PROP = `dtServiceName=${serviceName} companyName=${companyName} domain=${domain} industryType=${industryType}`;
    }
    // Internal env vars for app-level code
    process.env.DT_SERVICE_NAME = serviceName;
    process.env.DYNATRACE_SERVICE_NAME = serviceName;
    
    // CRITICAL: Set process argv[0] to help with service detection
    // This changes what 'ps' shows as the command name
    if (process.argv && process.argv.length > 0) {
      process.argv[0] = serviceName;
    }
    
    console.log(`[service-runner] Service identity set to: ${serviceName} (PID: ${process.pid})`);
  } catch (e) {
    console.error(`[service-runner] Failed to set service identity: ${e.message}`);
  }
  
  const app = express();
  
  // CRITICAL: Add body parsing middleware for JSON payloads
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  
  // Add error handling middleware
  app.use(errorHandlingMiddleware(serviceName));
  app.use((req, res, next) => {
    // Capture inbound W3C Trace Context and custom correlation
    const inboundTraceparent = req.headers['traceparent'];
    const inboundTracestate = req.headers['tracestate'];
    const inboundCorrelation = req.headers['x-correlation-id'];
    const payload = req.body || {};
    // Always use the actual service name for Dynatrace tracing
    const dynatraceServiceName = process.env.SERVICE_NAME || serviceName;
    const stepName = payload.stepName || process.env.STEP_NAME || serviceName.replace('Service', '').replace('-service', '');

    // Essential headers only (company/service info now in DT_TAGS)
    res.setHeader('X-Service-Name', dynatraceServiceName);
    res.setHeader('x-journey-step', stepName);
    if (payload.journeyId) {
      res.setHeader('x-journey-id', payload.journeyId);
    }

    // Add/propagate correlation ID
    req.correlationId = inboundCorrelation || crypto.randomBytes(8).toString('hex');
    req.dynatraceHeaders = {};
    if (inboundTraceparent) req.dynatraceHeaders.traceparent = inboundTraceparent;
    if (inboundTracestate) req.dynatraceHeaders.tracestate = inboundTracestate;
    req.serviceName = dynatraceServiceName; // Use the actual service name

  // Add minimal context headers (company context now in DT_TAGS to avoid duplicates)
  res.setHeader('x-service-type', 'bizobs-microservice');
  res.setHeader('x-version', '1.0.0');

  // Log service identification for debugging
    console.log(`[${dynatraceServiceName}] Service identified with PID ${process.pid}, handling ${req.method} ${req.path}`);

    next();
  });
  
  // Health check endpoint with error status
  app.get('/health', (req, res) => {
    try {
      res.json({ 
        status: 'ok', 
        service: serviceName,
        pid: process.pid,
        timestamp: new Date().toISOString(),
        correlationId: req.correlationId,
        traceSupport: true,
        errorHandling: true
      });
    } catch (error) {
      res.status(500).json({
        status: 'error',
        service: serviceName,
        error: error.message,
        traceError: true
      });
    }
  });

  // Mount service-specific routes
  mountFn(app);

  const server = http.createServer(app);
  const port = process.env.PORT || 0; // Dynamic port assignment
  
  server.listen(port, () => {
    const address = server.address();
    const actualPort = typeof address === 'string' ? address : address.port;
    console.log(`[${serviceName}] Service running on port ${actualPort} with PID ${process.pid}`);
  });
  
  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log(`[${serviceName}] Received SIGTERM, shutting down...`);
    server.close(() => {
      process.exit(0);
    });
  });
  
  process.on('SIGINT', () => {
    console.log(`[${serviceName}] Received SIGINT, shutting down...`);
    server.close(() => {
      process.exit(0);
    });
  });
}

module.exports = { createService };
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VydmljZS1ydW5uZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJzZXJ2aWNlLXJ1bm5lci5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEdlbmVyaWMgc2VydmljZSBydW5uZXIgZm9yIER5bmF0cmFjZSBCdXNpbmVzcyBPYnNlcnZhYmlsaXR5XG4gKiBJc29sYXRlZCBOb2RlLmpzIHByb2Nlc3NlcyB0aGF0IER5bmF0cmFjZSBjYW4gdHJhY2sgYXMgc2VwYXJhdGUgc2VydmljZXNcbiAqL1xuY29uc3QgZXhwcmVzcyA9IHJlcXVpcmUoJ2V4cHJlc3MnKTtcbmNvbnN0IGh0dHAgPSByZXF1aXJlKCdodHRwJyk7XG5jb25zdCBjcnlwdG8gPSByZXF1aXJlKCdjcnlwdG8nKTtcblxuLy8gTG9hZCBlbmhhbmNlZCBlcnJvciBoYW5kbGluZyBpZiBhdmFpbGFibGVcbmxldCBlcnJvckhhbmRsaW5nTWlkZGxld2FyZTtcbnRyeSB7XG4gIGNvbnN0IGVycm9ySGVscGVyID0gcmVxdWlyZSgnLi9keW5hdHJhY2UtZXJyb3ItaGVscGVyLmpzJyk7XG4gIGVycm9ySGFuZGxpbmdNaWRkbGV3YXJlID0gZXJyb3JIZWxwZXIuZXJyb3JIYW5kbGluZ01pZGRsZXdhcmU7XG59IGNhdGNoIChlKSB7XG4gIC8vIEZhbGxiYWNrIGlmIGVycm9yIGhlbHBlciBpcyBub3QgYXZhaWxhYmxlXG4gIGVycm9ySGFuZGxpbmdNaWRkbGV3YXJlID0gKHNlcnZpY2VOYW1lKSA9PiAoZXJyb3IsIHJlcSwgcmVzLCBuZXh0KSA9PiB7XG4gICAgY29uc29sZS5lcnJvcihgWyR7c2VydmljZU5hbWV9XSBVbmhhbmRsZWQgZXJyb3I6YCwgZXJyb3IubWVzc2FnZSk7XG4gICAgcmVzLnN0YXR1cyg1MDApLmpzb24oeyBcbiAgICAgIHN0YXR1czogJ2Vycm9yJywgXG4gICAgICBlcnJvcjogZXJyb3IubWVzc2FnZSxcbiAgICAgIHNlcnZpY2U6IHNlcnZpY2VOYW1lLFxuICAgICAgdHJhY2VFcnJvcjogdHJ1ZVxuICAgIH0pO1xuICB9O1xufVxuXG4vLyBFeHRyYWN0IGNvbXBhbnkgY29udGV4dCBmcm9tIGVudmlyb25tZW50IChleGFjdCBmaWVsZCBuYW1lcyBmb3IgRHluYXRyYWNlIGZpbHRlcmluZylcbmNvbnN0IGNvbXBhbnlOYW1lID0gcHJvY2Vzcy5lbnYuQ09NUEFOWV9OQU1FIHx8ICdEZWZhdWx0Q29tcGFueSc7XG5jb25zdCBkb21haW4gPSBwcm9jZXNzLmVudi5ET01BSU4gfHwgJ2RlZmF1bHQuY29tJztcbmNvbnN0IGluZHVzdHJ5VHlwZSA9IHByb2Nlc3MuZW52LklORFVTVFJZX1RZUEUgfHwgJ2dlbmVyYWwnO1xuY29uc3Qgc3RlcE5hbWVFbnYgPSBwcm9jZXNzLmVudi5TVEVQX05BTUUgfHwgJ1Vua25vd25TdGVwJztcblxuLy8gU2V0IER5bmF0cmFjZSBlbnZpcm9ubWVudCB2YXJpYWJsZXMgZm9yIE9uZUFnZW50XG5jb25zdCBzZXJ2aWNlTmFtZSA9IHByb2Nlc3MuYXJndlsyXSB8fCAnVW5rbm93blNlcnZpY2UnO1xuXG4vLyBTZXQgcHJvY2VzcyB0aXRsZSBmb3IgT25lQWdlbnQgZGV0ZWN0aW9uXG5wcm9jZXNzLnRpdGxlID0gc2VydmljZU5hbWU7XG5cbi8vIPCflJEgRFRfQVBQTElDQVRJT05fSUQ6IE92ZXJyaWRlcyBwYWNrYWdlLmpzb24gbmFtZSBmb3IgV2ViIGFwcGxpY2F0aW9uIGlkXG4vLyBUaGlzIGlzIHdoYXQgT25lQWdlbnQgdXNlcyBmb3Igc2VydmljZSBkZXRlY3Rpb24vbmFtaW5nXG5wcm9jZXNzLmVudi5EVF9BUFBMSUNBVElPTl9JRCA9IHNlcnZpY2VOYW1lO1xuXG4vLyDwn5SRIERUX0NVU1RPTV9QUk9QOiBBZGRzIGN1c3RvbSBtZXRhZGF0YSBwcm9wZXJ0aWVzIHRvIHRoZSBzZXJ2aWNlXG5pZiAoIXByb2Nlc3MuZW52LkRUX0NVU1RPTV9QUk9QIHx8ICFwcm9jZXNzLmVudi5EVF9DVVNUT01fUFJPUC5pbmNsdWRlcygnZHRTZXJ2aWNlTmFtZT0nKSkge1xuICBwcm9jZXNzLmVudi5EVF9DVVNUT01fUFJPUCA9IGBkdFNlcnZpY2VOYW1lPSR7c2VydmljZU5hbWV9IGNvbXBhbnlOYW1lPSR7Y29tcGFueU5hbWV9IGRvbWFpbj0ke2RvbWFpbn0gaW5kdXN0cnlUeXBlPSR7aW5kdXN0cnlUeXBlfWA7XG59XG5cbi8vIEludGVybmFsIGVudiB2YXJzIGZvciBhcHAtbGV2ZWwgY29kZVxucHJvY2Vzcy5lbnYuRFRfU0VSVklDRV9OQU1FID0gc2VydmljZU5hbWU7XG5wcm9jZXNzLmVudi5EVF9DTFVTVEVSX0lEID0gc2VydmljZU5hbWU7XG5wcm9jZXNzLmVudi5EVF9OT0RFX0lEID0gYCR7c2VydmljZU5hbWV9LW5vZGVgO1xuXG5mdW5jdGlvbiBjcmVhdGVTZXJ2aWNlKHNlcnZpY2VOYW1lLCBtb3VudEZuKSB7XG4gIC8vIENSSVRJQ0FMOiBTZXQgcHJvY2VzcyBpZGVudGl0eSBmb3IgRHluYXRyYWNlIGRldGVjdGlvbiBpbW1lZGlhdGVseVxuICB0cnkgeyBcbiAgICAvLyBTZXQgcHJvY2VzcyB0aXRsZSAtIHRoaXMgaXMgd2hhdCBEeW5hdHJhY2Ugc2VlcyBhcyB0aGUgc2VydmljZSBuYW1lXG4gICAgcHJvY2Vzcy50aXRsZSA9IHNlcnZpY2VOYW1lOyBcbiAgICBcbiAgICAvLyDwn5SRIERUX0FQUExJQ0FUSU9OX0lEOiBPdmVycmlkZXMgcGFja2FnZS5qc29uIG5hbWUgZm9yIFdlYiBhcHBsaWNhdGlvbiBpZFxuICAgIHByb2Nlc3MuZW52LkRUX0FQUExJQ0FUSU9OX0lEID0gc2VydmljZU5hbWU7XG4gICAgXG4gICAgLy8g8J+UkSBEVF9DVVNUT01fUFJPUDogQWRkcyBjdXN0b20gbWV0YWRhdGEgcHJvcGVydGllc1xuICAgIGlmICghcHJvY2Vzcy5lbnYuRFRfQ1VTVE9NX1BST1AgfHwgIXByb2Nlc3MuZW52LkRUX0NVU1RPTV9QUk9QLmluY2x1ZGVzKCdkdFNlcnZpY2VOYW1lPScpKSB7XG4gICAgICBwcm9jZXNzLmVudi5EVF9DVVNUT01fUFJPUCA9IGBkdFNlcnZpY2VOYW1lPSR7c2VydmljZU5hbWV9IGNvbXBhbnlOYW1lPSR7Y29tcGFueU5hbWV9IGRvbWFpbj0ke2RvbWFpbn0gaW5kdXN0cnlUeXBlPSR7aW5kdXN0cnlUeXBlfWA7XG4gICAgfVxuICAgIC8vIEludGVybmFsIGVudiB2YXJzIGZvciBhcHAtbGV2ZWwgY29kZVxuICAgIHByb2Nlc3MuZW52LkRUX1NFUlZJQ0VfTkFNRSA9IHNlcnZpY2VOYW1lO1xuICAgIHByb2Nlc3MuZW52LkRZTkFUUkFDRV9TRVJWSUNFX05BTUUgPSBzZXJ2aWNlTmFtZTtcbiAgICBcbiAgICAvLyBDUklUSUNBTDogU2V0IHByb2Nlc3MgYXJndlswXSB0byBoZWxwIHdpdGggc2VydmljZSBkZXRlY3Rpb25cbiAgICAvLyBUaGlzIGNoYW5nZXMgd2hhdCAncHMnIHNob3dzIGFzIHRoZSBjb21tYW5kIG5hbWVcbiAgICBpZiAocHJvY2Vzcy5hcmd2ICYmIHByb2Nlc3MuYXJndi5sZW5ndGggPiAwKSB7XG4gICAgICBwcm9jZXNzLmFyZ3ZbMF0gPSBzZXJ2aWNlTmFtZTtcbiAgICB9XG4gICAgXG4gICAgY29uc29sZS5sb2coYFtzZXJ2aWNlLXJ1bm5lcl0gU2VydmljZSBpZGVudGl0eSBzZXQgdG86ICR7c2VydmljZU5hbWV9IChQSUQ6ICR7cHJvY2Vzcy5waWR9KWApO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihgW3NlcnZpY2UtcnVubmVyXSBGYWlsZWQgdG8gc2V0IHNlcnZpY2UgaWRlbnRpdHk6ICR7ZS5tZXNzYWdlfWApO1xuICB9XG4gIFxuICBjb25zdCBhcHAgPSBleHByZXNzKCk7XG4gIFxuICAvLyBDUklUSUNBTDogQWRkIGJvZHkgcGFyc2luZyBtaWRkbGV3YXJlIGZvciBKU09OIHBheWxvYWRzXG4gIGFwcC51c2UoZXhwcmVzcy5qc29uKHsgbGltaXQ6ICcxMG1iJyB9KSk7XG4gIGFwcC51c2UoZXhwcmVzcy51cmxlbmNvZGVkKHsgZXh0ZW5kZWQ6IHRydWUsIGxpbWl0OiAnMTBtYicgfSkpO1xuICBcbiAgLy8gQWRkIGVycm9yIGhhbmRsaW5nIG1pZGRsZXdhcmVcbiAgYXBwLnVzZShlcnJvckhhbmRsaW5nTWlkZGxld2FyZShzZXJ2aWNlTmFtZSkpO1xuICBhcHAudXNlKChyZXEsIHJlcywgbmV4dCkgPT4ge1xuICAgIC8vIENhcHR1cmUgaW5ib3VuZCBXM0MgVHJhY2UgQ29udGV4dCBhbmQgY3VzdG9tIGNvcnJlbGF0aW9uXG4gICAgY29uc3QgaW5ib3VuZFRyYWNlcGFyZW50ID0gcmVxLmhlYWRlcnNbJ3RyYWNlcGFyZW50J107XG4gICAgY29uc3QgaW5ib3VuZFRyYWNlc3RhdGUgPSByZXEuaGVhZGVyc1sndHJhY2VzdGF0ZSddO1xuICAgIGNvbnN0IGluYm91bmRDb3JyZWxhdGlvbiA9IHJlcS5oZWFkZXJzWyd4LWNvcnJlbGF0aW9uLWlkJ107XG4gICAgY29uc3QgcGF5bG9hZCA9IHJlcS5ib2R5IHx8IHt9O1xuICAgIC8vIEFsd2F5cyB1c2UgdGhlIGFjdHVhbCBzZXJ2aWNlIG5hbWUgZm9yIER5bmF0cmFjZSB0cmFjaW5nXG4gICAgY29uc3QgZHluYXRyYWNlU2VydmljZU5hbWUgPSBwcm9jZXNzLmVudi5TRVJWSUNFX05BTUUgfHwgc2VydmljZU5hbWU7XG4gICAgY29uc3Qgc3RlcE5hbWUgPSBwYXlsb2FkLnN0ZXBOYW1lIHx8IHByb2Nlc3MuZW52LlNURVBfTkFNRSB8fCBzZXJ2aWNlTmFtZS5yZXBsYWNlKCdTZXJ2aWNlJywgJycpLnJlcGxhY2UoJy1zZXJ2aWNlJywgJycpO1xuXG4gICAgLy8gRXNzZW50aWFsIGhlYWRlcnMgb25seSAoY29tcGFueS9zZXJ2aWNlIGluZm8gbm93IGluIERUX1RBR1MpXG4gICAgcmVzLnNldEhlYWRlcignWC1TZXJ2aWNlLU5hbWUnLCBkeW5hdHJhY2VTZXJ2aWNlTmFtZSk7XG4gICAgcmVzLnNldEhlYWRlcigneC1qb3VybmV5LXN0ZXAnLCBzdGVwTmFtZSk7XG4gICAgaWYgKHBheWxvYWQuam91cm5leUlkKSB7XG4gICAgICByZXMuc2V0SGVhZGVyKCd4LWpvdXJuZXktaWQnLCBwYXlsb2FkLmpvdXJuZXlJZCk7XG4gICAgfVxuXG4gICAgLy8gQWRkL3Byb3BhZ2F0ZSBjb3JyZWxhdGlvbiBJRFxuICAgIHJlcS5jb3JyZWxhdGlvbklkID0gaW5ib3VuZENvcnJlbGF0aW9uIHx8IGNyeXB0by5yYW5kb21CeXRlcyg4KS50b1N0cmluZygnaGV4Jyk7XG4gICAgcmVxLmR5bmF0cmFjZUhlYWRlcnMgPSB7fTtcbiAgICBpZiAoaW5ib3VuZFRyYWNlcGFyZW50KSByZXEuZHluYXRyYWNlSGVhZGVycy50cmFjZXBhcmVudCA9IGluYm91bmRUcmFjZXBhcmVudDtcbiAgICBpZiAoaW5ib3VuZFRyYWNlc3RhdGUpIHJlcS5keW5hdHJhY2VIZWFkZXJzLnRyYWNlc3RhdGUgPSBpbmJvdW5kVHJhY2VzdGF0ZTtcbiAgICByZXEuc2VydmljZU5hbWUgPSBkeW5hdHJhY2VTZXJ2aWNlTmFtZTsgLy8gVXNlIHRoZSBhY3R1YWwgc2VydmljZSBuYW1lXG5cbiAgLy8gQWRkIG1pbmltYWwgY29udGV4dCBoZWFkZXJzIChjb21wYW55IGNvbnRleHQgbm93IGluIERUX1RBR1MgdG8gYXZvaWQgZHVwbGljYXRlcylcbiAgcmVzLnNldEhlYWRlcigneC1zZXJ2aWNlLXR5cGUnLCAnYml6b2JzLW1pY3Jvc2VydmljZScpO1xuICByZXMuc2V0SGVhZGVyKCd4LXZlcnNpb24nLCAnMS4wLjAnKTtcblxuICAvLyBMb2cgc2VydmljZSBpZGVudGlmaWNhdGlvbiBmb3IgZGVidWdnaW5nXG4gICAgY29uc29sZS5sb2coYFske2R5bmF0cmFjZVNlcnZpY2VOYW1lfV0gU2VydmljZSBpZGVudGlmaWVkIHdpdGggUElEICR7cHJvY2Vzcy5waWR9LCBoYW5kbGluZyAke3JlcS5tZXRob2R9ICR7cmVxLnBhdGh9YCk7XG5cbiAgICBuZXh0KCk7XG4gIH0pO1xuICBcbiAgLy8gSGVhbHRoIGNoZWNrIGVuZHBvaW50IHdpdGggZXJyb3Igc3RhdHVzXG4gIGFwcC5nZXQoJy9oZWFsdGgnLCAocmVxLCByZXMpID0+IHtcbiAgICB0cnkge1xuICAgICAgcmVzLmpzb24oeyBcbiAgICAgICAgc3RhdHVzOiAnb2snLCBcbiAgICAgICAgc2VydmljZTogc2VydmljZU5hbWUsXG4gICAgICAgIHBpZDogcHJvY2Vzcy5waWQsXG4gICAgICAgIHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICBjb3JyZWxhdGlvbklkOiByZXEuY29ycmVsYXRpb25JZCxcbiAgICAgICAgdHJhY2VTdXBwb3J0OiB0cnVlLFxuICAgICAgICBlcnJvckhhbmRsaW5nOiB0cnVlXG4gICAgICB9KTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgcmVzLnN0YXR1cyg1MDApLmpzb24oe1xuICAgICAgICBzdGF0dXM6ICdlcnJvcicsXG4gICAgICAgIHNlcnZpY2U6IHNlcnZpY2VOYW1lLFxuICAgICAgICBlcnJvcjogZXJyb3IubWVzc2FnZSxcbiAgICAgICAgdHJhY2VFcnJvcjogdHJ1ZVxuICAgICAgfSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBNb3VudCBzZXJ2aWNlLXNwZWNpZmljIHJvdXRlc1xuICBtb3VudEZuKGFwcCk7XG5cbiAgY29uc3Qgc2VydmVyID0gaHR0cC5jcmVhdGVTZXJ2ZXIoYXBwKTtcbiAgY29uc3QgcG9ydCA9IHByb2Nlc3MuZW52LlBPUlQgfHwgMDsgLy8gRHluYW1pYyBwb3J0IGFzc2lnbm1lbnRcbiAgXG4gIHNlcnZlci5saXN0ZW4ocG9ydCwgKCkgPT4ge1xuICAgIGNvbnN0IGFkZHJlc3MgPSBzZXJ2ZXIuYWRkcmVzcygpO1xuICAgIGNvbnN0IGFjdHVhbFBvcnQgPSB0eXBlb2YgYWRkcmVzcyA9PT0gJ3N0cmluZycgPyBhZGRyZXNzIDogYWRkcmVzcy5wb3J0O1xuICAgIGNvbnNvbGUubG9nKGBbJHtzZXJ2aWNlTmFtZX1dIFNlcnZpY2UgcnVubmluZyBvbiBwb3J0ICR7YWN0dWFsUG9ydH0gd2l0aCBQSUQgJHtwcm9jZXNzLnBpZH1gKTtcbiAgfSk7XG4gIFxuICAvLyBHcmFjZWZ1bCBzaHV0ZG93blxuICBwcm9jZXNzLm9uKCdTSUdURVJNJywgKCkgPT4ge1xuICAgIGNvbnNvbGUubG9nKGBbJHtzZXJ2aWNlTmFtZX1dIFJlY2VpdmVkIFNJR1RFUk0sIHNodXR0aW5nIGRvd24uLi5gKTtcbiAgICBzZXJ2ZXIuY2xvc2UoKCkgPT4ge1xuICAgICAgcHJvY2Vzcy5leGl0KDApO1xuICAgIH0pO1xuICB9KTtcbiAgXG4gIHByb2Nlc3Mub24oJ1NJR0lOVCcsICgpID0+IHtcbiAgICBjb25zb2xlLmxvZyhgWyR7c2VydmljZU5hbWV9XSBSZWNlaXZlZCBTSUdJTlQsIHNodXR0aW5nIGRvd24uLi5gKTtcbiAgICBzZXJ2ZXIuY2xvc2UoKCkgPT4ge1xuICAgICAgcHJvY2Vzcy5leGl0KDApO1xuICAgIH0pO1xuICB9KTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSB7IGNyZWF0ZVNlcnZpY2UgfTsiXSwibWFwcGluZ3MiOiJBQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EifQ==
