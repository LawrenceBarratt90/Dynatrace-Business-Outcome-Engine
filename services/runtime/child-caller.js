const http = require('http');
const crypto = require('crypto');

const SERVICE_PORTS = {
  'discovery-service': 4101,
  'awareness-service': 4102,
  'consideration-service': 4103,
  'purchase-service': 4104,
  'retention-service': 4105,
  'advocacy-service': 4106
};

function getServiceNameFromStep(stepName) {
  // Normalize: preserve CamelCase (ProductDiscovery -> ProductDiscoveryService) and handle spaces/underscores/hyphens
  if (!stepName) return null;
  if (/Service$/.test(String(stepName))) return String(stepName);
  const cleaned = String(stepName).replace(/[^a-zA-Z0-9_\-\s]/g, '').trim();
  const spaced = cleaned
    .replace(/[\-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  const serviceBase = spaced
    .split(' ')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  const serviceName = `${serviceBase}Service`;
  console.log(`[child-caller] Converting step "${stepName}" to service "${serviceName}"`);
  return serviceName;
}

function getServicePortFromStep(stepNameOrServiceName) {
  // Accept either a step name or an exact service name; prefer using as-is if it already looks like a Service
  const serviceName = /Service$/.test(String(stepNameOrServiceName))
    ? String(stepNameOrServiceName)
    : getServiceNameFromStep(stepNameOrServiceName);
  if (!serviceName) return null;
  
  // Create a consistent hash-based port allocation (same as eventService)
  let hash = 0;
  for (let i = 0; i < serviceName.length; i++) {
    const char = serviceName.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  // Map to port range 4101-4199
  const port = 4101 + (Math.abs(hash) % 99);
  console.log(`[child-caller] Service "${serviceName}" mapped to port ${port}`);
  return port;
}

function callService(serviceName, payload, headers = {}, overridePort) {
  return new Promise((resolve, reject) => {
    // Use overridePort if provided, else hash-based mapping
    const port = overridePort || getServicePortFromStep(serviceName) || SERVICE_PORTS[serviceName];
    if (!port) return reject(new Error(`Unknown service: ${serviceName}`));
    
    // Prepare headers with proper Dynatrace trace propagation
    const requestHeaders = { 'Content-Type': 'application/json' };
    
    // Add custom journey headers
    if (payload) {
      if (payload.journeyId) requestHeaders['x-journey-id'] = payload.journeyId;
      if (payload.stepName) requestHeaders['x-journey-step'] = payload.stepName;
      if (payload.domain) requestHeaders['x-customer-segment'] = payload.domain;
      if (payload.correlationId) requestHeaders['x-correlation-id'] = payload.correlationId;
    }
    
    // CRITICAL: Add Dynatrace trace propagation headers
    // Use W3C Trace Context format for proper distributed tracing
    if (payload && payload.traceId && payload.spanId) {
      // W3C traceparent format: version-trace_id-parent_id-trace_flags
      const traceId32 = payload.traceId.replace(/-/g, '').substring(0, 32).padEnd(32, '0');
      const spanId16 = payload.spanId.replace(/-/g, '').substring(0, 16).padEnd(16, '0');
      requestHeaders['traceparent'] = `00-${traceId32}-${spanId16}-01`;
      
      // Also add Dynatrace-specific headers for better compatibility
      requestHeaders['x-dynatrace-trace-id'] = traceId32;
      requestHeaders['x-dynatrace-parent-span-id'] = spanId16;
    }
    
    // Pass through any existing trace headers from incoming request
    if (headers) {
      Object.keys(headers).forEach(key => {
        const lowerKey = key.toLowerCase();
        if (lowerKey === 'traceparent' || 
            lowerKey === 'tracestate' ||
            lowerKey.startsWith('x-dynatrace') ||
            lowerKey.includes('trace') ||
            lowerKey.includes('span')) {
          requestHeaders[key] = headers[key];
        }
      });
    }
    
    const options = {
      hostname: '127.0.0.1',
      port,
      path: '/process',
      method: 'POST',
      headers: requestHeaders
    };
    
    console.log(`🔗 [${serviceName}] Calling service on port ${port} with Dynatrace headers:`, 
      Object.keys(requestHeaders).filter(k => 
        k.toLowerCase().includes('trace') || 
        k.toLowerCase().includes('span') || 
        k.toLowerCase().includes('dynatrace')
      ));
    
    const req = http.request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { 
          const result = body ? JSON.parse(body) : {};
          console.log(`✅ [${serviceName}] Service call completed with trace propagation`);
          resolve(result); 
        } catch (e) { 
          console.error(`❌ [${serviceName}] Failed to parse response:`, e.message);
          reject(e); 
        }
      });
    });
    req.on('error', (err) => {
      console.error(`❌ [${serviceName}] Service call failed:`, err.message);
      reject(err);
    });
    req.end(JSON.stringify(payload || {}));
  });
}

module.exports = { SERVICE_PORTS, getServiceNameFromStep, getServicePortFromStep, callService };
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2hpbGQtY2FsbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiY2hpbGQtY2FsbGVyLmpzIl0sInNvdXJjZXNDb250ZW50IjpbImNvbnN0IGh0dHAgPSByZXF1aXJlKCdodHRwJyk7XG5jb25zdCBjcnlwdG8gPSByZXF1aXJlKCdjcnlwdG8nKTtcblxuY29uc3QgU0VSVklDRV9QT1JUUyA9IHtcbiAgJ2Rpc2NvdmVyeS1zZXJ2aWNlJzogNDEwMSxcbiAgJ2F3YXJlbmVzcy1zZXJ2aWNlJzogNDEwMixcbiAgJ2NvbnNpZGVyYXRpb24tc2VydmljZSc6IDQxMDMsXG4gICdwdXJjaGFzZS1zZXJ2aWNlJzogNDEwNCxcbiAgJ3JldGVudGlvbi1zZXJ2aWNlJzogNDEwNSxcbiAgJ2Fkdm9jYWN5LXNlcnZpY2UnOiA0MTA2XG59O1xuXG5mdW5jdGlvbiBnZXRTZXJ2aWNlTmFtZUZyb21TdGVwKHN0ZXBOYW1lKSB7XG4gIC8vIE5vcm1hbGl6ZTogcHJlc2VydmUgQ2FtZWxDYXNlIChQcm9kdWN0RGlzY292ZXJ5IC0+IFByb2R1Y3REaXNjb3ZlcnlTZXJ2aWNlKSBhbmQgaGFuZGxlIHNwYWNlcy91bmRlcnNjb3Jlcy9oeXBoZW5zXG4gIGlmICghc3RlcE5hbWUpIHJldHVybiBudWxsO1xuICBpZiAoL1NlcnZpY2UkLy50ZXN0KFN0cmluZyhzdGVwTmFtZSkpKSByZXR1cm4gU3RyaW5nKHN0ZXBOYW1lKTtcbiAgY29uc3QgY2xlYW5lZCA9IFN0cmluZyhzdGVwTmFtZSkucmVwbGFjZSgvW15hLXpBLVowLTlfXFwtXFxzXS9nLCAnJykudHJpbSgpO1xuICBjb25zdCBzcGFjZWQgPSBjbGVhbmVkXG4gICAgLnJlcGxhY2UoL1tcXC1fXSsvZywgJyAnKVxuICAgIC5yZXBsYWNlKC8oW2EtejAtOV0pKFtBLVpdKS9nLCAnJDEgJDInKVxuICAgIC5yZXBsYWNlKC9cXHMrL2csICcgJylcbiAgICAudHJpbSgpO1xuICBjb25zdCBzZXJ2aWNlQmFzZSA9IHNwYWNlZFxuICAgIC5zcGxpdCgnICcpXG4gICAgLmZpbHRlcihCb29sZWFuKVxuICAgIC5tYXAodyA9PiB3LmNoYXJBdCgwKS50b1VwcGVyQ2FzZSgpICsgdy5zbGljZSgxKSlcbiAgICAuam9pbignJyk7XG4gIGNvbnN0IHNlcnZpY2VOYW1lID0gYCR7c2VydmljZUJhc2V9U2VydmljZWA7XG4gIGNvbnNvbGUubG9nKGBbY2hpbGQtY2FsbGVyXSBDb252ZXJ0aW5nIHN0ZXAgXCIke3N0ZXBOYW1lfVwiIHRvIHNlcnZpY2UgXCIke3NlcnZpY2VOYW1lfVwiYCk7XG4gIHJldHVybiBzZXJ2aWNlTmFtZTtcbn1cblxuZnVuY3Rpb24gZ2V0U2VydmljZVBvcnRGcm9tU3RlcChzdGVwTmFtZU9yU2VydmljZU5hbWUpIHtcbiAgLy8gQWNjZXB0IGVpdGhlciBhIHN0ZXAgbmFtZSBvciBhbiBleGFjdCBzZXJ2aWNlIG5hbWU7IHByZWZlciB1c2luZyBhcy1pcyBpZiBpdCBhbHJlYWR5IGxvb2tzIGxpa2UgYSBTZXJ2aWNlXG4gIGNvbnN0IHNlcnZpY2VOYW1lID0gL1NlcnZpY2UkLy50ZXN0KFN0cmluZyhzdGVwTmFtZU9yU2VydmljZU5hbWUpKVxuICAgID8gU3RyaW5nKHN0ZXBOYW1lT3JTZXJ2aWNlTmFtZSlcbiAgICA6IGdldFNlcnZpY2VOYW1lRnJvbVN0ZXAoc3RlcE5hbWVPclNlcnZpY2VOYW1lKTtcbiAgaWYgKCFzZXJ2aWNlTmFtZSkgcmV0dXJuIG51bGw7XG4gIFxuICAvLyBDcmVhdGUgYSBjb25zaXN0ZW50IGhhc2gtYmFzZWQgcG9ydCBhbGxvY2F0aW9uIChzYW1lIGFzIGV2ZW50U2VydmljZSlcbiAgbGV0IGhhc2ggPSAwO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IHNlcnZpY2VOYW1lLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgY2hhciA9IHNlcnZpY2VOYW1lLmNoYXJDb2RlQXQoaSk7XG4gICAgaGFzaCA9ICgoaGFzaCA8PCA1KSAtIGhhc2gpICsgY2hhcjtcbiAgICBoYXNoID0gaGFzaCAmIGhhc2g7IC8vIENvbnZlcnQgdG8gMzItYml0IGludGVnZXJcbiAgfVxuICAvLyBNYXAgdG8gcG9ydCByYW5nZSA0MTAxLTQxOTlcbiAgY29uc3QgcG9ydCA9IDQxMDEgKyAoTWF0aC5hYnMoaGFzaCkgJSA5OSk7XG4gIGNvbnNvbGUubG9nKGBbY2hpbGQtY2FsbGVyXSBTZXJ2aWNlIFwiJHtzZXJ2aWNlTmFtZX1cIiBtYXBwZWQgdG8gcG9ydCAke3BvcnR9YCk7XG4gIHJldHVybiBwb3J0O1xufVxuXG5mdW5jdGlvbiBjYWxsU2VydmljZShzZXJ2aWNlTmFtZSwgcGF5bG9hZCwgaGVhZGVycyA9IHt9LCBvdmVycmlkZVBvcnQpIHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAvLyBVc2Ugb3ZlcnJpZGVQb3J0IGlmIHByb3ZpZGVkLCBlbHNlIGhhc2gtYmFzZWQgbWFwcGluZ1xuICAgIGNvbnN0IHBvcnQgPSBvdmVycmlkZVBvcnQgfHwgZ2V0U2VydmljZVBvcnRGcm9tU3RlcChzZXJ2aWNlTmFtZSkgfHwgU0VSVklDRV9QT1JUU1tzZXJ2aWNlTmFtZV07XG4gICAgaWYgKCFwb3J0KSByZXR1cm4gcmVqZWN0KG5ldyBFcnJvcihgVW5rbm93biBzZXJ2aWNlOiAke3NlcnZpY2VOYW1lfWApKTtcbiAgICBcbiAgICAvLyBQcmVwYXJlIGhlYWRlcnMgd2l0aCBwcm9wZXIgRHluYXRyYWNlIHRyYWNlIHByb3BhZ2F0aW9uXG4gICAgY29uc3QgcmVxdWVzdEhlYWRlcnMgPSB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfTtcbiAgICBcbiAgICAvLyBBZGQgY3VzdG9tIGpvdXJuZXkgaGVhZGVyc1xuICAgIGlmIChwYXlsb2FkKSB7XG4gICAgICBpZiAocGF5bG9hZC5qb3VybmV5SWQpIHJlcXVlc3RIZWFkZXJzWyd4LWpvdXJuZXktaWQnXSA9IHBheWxvYWQuam91cm5leUlkO1xuICAgICAgaWYgKHBheWxvYWQuc3RlcE5hbWUpIHJlcXVlc3RIZWFkZXJzWyd4LWpvdXJuZXktc3RlcCddID0gcGF5bG9hZC5zdGVwTmFtZTtcbiAgICAgIGlmIChwYXlsb2FkLmRvbWFpbikgcmVxdWVzdEhlYWRlcnNbJ3gtY3VzdG9tZXItc2VnbWVudCddID0gcGF5bG9hZC5kb21haW47XG4gICAgICBpZiAocGF5bG9hZC5jb3JyZWxhdGlvbklkKSByZXF1ZXN0SGVhZGVyc1sneC1jb3JyZWxhdGlvbi1pZCddID0gcGF5bG9hZC5jb3JyZWxhdGlvbklkO1xuICAgIH1cbiAgICBcbiAgICAvLyBDUklUSUNBTDogQWRkIER5bmF0cmFjZSB0cmFjZSBwcm9wYWdhdGlvbiBoZWFkZXJzXG4gICAgLy8gVXNlIFczQyBUcmFjZSBDb250ZXh0IGZvcm1hdCBmb3IgcHJvcGVyIGRpc3RyaWJ1dGVkIHRyYWNpbmdcbiAgICBpZiAocGF5bG9hZCAmJiBwYXlsb2FkLnRyYWNlSWQgJiYgcGF5bG9hZC5zcGFuSWQpIHtcbiAgICAgIC8vIFczQyB0cmFjZXBhcmVudCBmb3JtYXQ6IHZlcnNpb24tdHJhY2VfaWQtcGFyZW50X2lkLXRyYWNlX2ZsYWdzXG4gICAgICBjb25zdCB0cmFjZUlkMzIgPSBwYXlsb2FkLnRyYWNlSWQucmVwbGFjZSgvLS9nLCAnJykuc3Vic3RyaW5nKDAsIDMyKS5wYWRFbmQoMzIsICcwJyk7XG4gICAgICBjb25zdCBzcGFuSWQxNiA9IHBheWxvYWQuc3BhbklkLnJlcGxhY2UoLy0vZywgJycpLnN1YnN0cmluZygwLCAxNikucGFkRW5kKDE2LCAnMCcpO1xuICAgICAgcmVxdWVzdEhlYWRlcnNbJ3RyYWNlcGFyZW50J10gPSBgMDAtJHt0cmFjZUlkMzJ9LSR7c3BhbklkMTZ9LTAxYDtcbiAgICAgIFxuICAgICAgLy8gQWxzbyBhZGQgRHluYXRyYWNlLXNwZWNpZmljIGhlYWRlcnMgZm9yIGJldHRlciBjb21wYXRpYmlsaXR5XG4gICAgICByZXF1ZXN0SGVhZGVyc1sneC1keW5hdHJhY2UtdHJhY2UtaWQnXSA9IHRyYWNlSWQzMjtcbiAgICAgIHJlcXVlc3RIZWFkZXJzWyd4LWR5bmF0cmFjZS1wYXJlbnQtc3Bhbi1pZCddID0gc3BhbklkMTY7XG4gICAgfVxuICAgIFxuICAgIC8vIFBhc3MgdGhyb3VnaCBhbnkgZXhpc3RpbmcgdHJhY2UgaGVhZGVycyBmcm9tIGluY29taW5nIHJlcXVlc3RcbiAgICBpZiAoaGVhZGVycykge1xuICAgICAgT2JqZWN0LmtleXMoaGVhZGVycykuZm9yRWFjaChrZXkgPT4ge1xuICAgICAgICBjb25zdCBsb3dlcktleSA9IGtleS50b0xvd2VyQ2FzZSgpO1xuICAgICAgICBpZiAobG93ZXJLZXkgPT09ICd0cmFjZXBhcmVudCcgfHwgXG4gICAgICAgICAgICBsb3dlcktleSA9PT0gJ3RyYWNlc3RhdGUnIHx8XG4gICAgICAgICAgICBsb3dlcktleS5zdGFydHNXaXRoKCd4LWR5bmF0cmFjZScpIHx8XG4gICAgICAgICAgICBsb3dlcktleS5pbmNsdWRlcygndHJhY2UnKSB8fFxuICAgICAgICAgICAgbG93ZXJLZXkuaW5jbHVkZXMoJ3NwYW4nKSkge1xuICAgICAgICAgIHJlcXVlc3RIZWFkZXJzW2tleV0gPSBoZWFkZXJzW2tleV07XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH1cbiAgICBcbiAgICBjb25zdCBvcHRpb25zID0ge1xuICAgICAgaG9zdG5hbWU6ICcxMjcuMC4wLjEnLFxuICAgICAgcG9ydCxcbiAgICAgIHBhdGg6ICcvcHJvY2VzcycsXG4gICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgIGhlYWRlcnM6IHJlcXVlc3RIZWFkZXJzXG4gICAgfTtcbiAgICBcbiAgICBjb25zb2xlLmxvZyhg8J+UlyBbJHtzZXJ2aWNlTmFtZX1dIENhbGxpbmcgc2VydmljZSBvbiBwb3J0ICR7cG9ydH0gd2l0aCBEeW5hdHJhY2UgaGVhZGVyczpgLCBcbiAgICAgIE9iamVjdC5rZXlzKHJlcXVlc3RIZWFkZXJzKS5maWx0ZXIoayA9PiBcbiAgICAgICAgay50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKCd0cmFjZScpIHx8IFxuICAgICAgICBrLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoJ3NwYW4nKSB8fCBcbiAgICAgICAgay50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKCdkeW5hdHJhY2UnKVxuICAgICAgKSk7XG4gICAgXG4gICAgY29uc3QgcmVxID0gaHR0cC5yZXF1ZXN0KG9wdGlvbnMsIChyZXMpID0+IHtcbiAgICAgIGxldCBib2R5ID0gJyc7XG4gICAgICByZXMuc2V0RW5jb2RpbmcoJ3V0ZjgnKTtcbiAgICAgIHJlcy5vbignZGF0YScsIChjKSA9PiAoYm9keSArPSBjKSk7XG4gICAgICByZXMub24oJ2VuZCcsICgpID0+IHtcbiAgICAgICAgdHJ5IHsgXG4gICAgICAgICAgY29uc3QgcmVzdWx0ID0gYm9keSA/IEpTT04ucGFyc2UoYm9keSkgOiB7fTtcbiAgICAgICAgICBjb25zb2xlLmxvZyhg4pyFIFske3NlcnZpY2VOYW1lfV0gU2VydmljZSBjYWxsIGNvbXBsZXRlZCB3aXRoIHRyYWNlIHByb3BhZ2F0aW9uYCk7XG4gICAgICAgICAgcmVzb2x2ZShyZXN1bHQpOyBcbiAgICAgICAgfSBjYXRjaCAoZSkgeyBcbiAgICAgICAgICBjb25zb2xlLmVycm9yKGDinYwgWyR7c2VydmljZU5hbWV9XSBGYWlsZWQgdG8gcGFyc2UgcmVzcG9uc2U6YCwgZS5tZXNzYWdlKTtcbiAgICAgICAgICByZWplY3QoZSk7IFxuICAgICAgICB9XG4gICAgICB9KTtcbiAgICB9KTtcbiAgICByZXEub24oJ2Vycm9yJywgKGVycikgPT4ge1xuICAgICAgY29uc29sZS5lcnJvcihg4p2MIFske3NlcnZpY2VOYW1lfV0gU2VydmljZSBjYWxsIGZhaWxlZDpgLCBlcnIubWVzc2FnZSk7XG4gICAgICByZWplY3QoZXJyKTtcbiAgICB9KTtcbiAgICByZXEuZW5kKEpTT04uc3RyaW5naWZ5KHBheWxvYWQgfHwge30pKTtcbiAgfSk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0geyBTRVJWSUNFX1BPUlRTLCBnZXRTZXJ2aWNlTmFtZUZyb21TdGVwLCBnZXRTZXJ2aWNlUG9ydEZyb21TdGVwLCBjYWxsU2VydmljZSB9OyJdLCJtYXBwaW5ncyI6IkFBQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBIn0=
