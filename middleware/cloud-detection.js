// Cloud environment detection and observability setup
import { detectEnvironment, setupObservability } from './middleware/cloud-observability.js';

// Detect if running in cloud environment
const environment = detectEnvironment();

if (environment.isCloud) {
  console.log(`🌩️ Cloud environment detected: ${environment.platform}`);
  console.log('📊 Setting up OpenTelemetry for direct Dynatrace integration...');
  
  // Setup OpenTelemetry for cloud environments
  await setupObservability({
    platform: environment.platform,
    dynatraceUrl: process.env.DYNATRACE_URL,
    dynatraceToken: process.env.DYNATRACE_TOKEN,
    serviceName: 'bizobs-demonstrator-cloud'
  });
} else {
  console.log('🖥️ Local/VM environment detected');
  console.log('🔍 Expecting OneAgent for observability...');
}

export { environment };