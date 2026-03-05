/**
 * Data Persistence Service - Final step in customer journey
 * Stores complete journey data in memory with Dynatrace tracing
 * (MongoDB integration removed)
 */

const { createService } = require('./service-runner.js');
const http = require('http');
const crypto = require('crypto');

// In-memory storage for journey data (replaces MongoDB)
const journeyStorage = {
  journeys: new Map(),
  steps: [],
  stats: {
    totalJourneys: 0,
    companiesStats: new Map()
  }
};

// Fallback Dynatrace helpers
const addCustomAttributes = (attributes) => {
  console.log('[dynatrace] Custom attributes:', attributes);
};

const withCustomSpan = (name, callback) => {
  console.log('[dynatrace] Custom span:', name);
  return callback();
};

const sendBusinessEvent = (eventType, data) => {
  console.log('[dynatrace] Business event:', eventType, data);
};

createService('DataPersistenceService', (app) => {
  app.post('/process', async (req, res) => {
    const payload = req.body || {};
    const correlationId = req.correlationId;
    const currentStepName = payload.stepName || 'DataPersistence';
    
    console.log(`[DataPersistenceService] Processing final journey step with correlation: ${correlationId}`);
    console.log(`[DataPersistenceService] Received journey data:`, JSON.stringify(payload, null, 2));

    // Extract trace context
    const incomingTraceParent = req.headers['traceparent'];
    const incomingTraceState = req.headers['tracestate'];
    const dynatraceTraceId = req.headers['x-dynatrace-trace-id'];
    
    // Generate span ID for this service
    const spanId = crypto.randomUUID().slice(0, 16).replace(/-/g, '');
    
    let traceId, parentSpanId;
    
    if (incomingTraceParent) {
      const parts = incomingTraceParent.split('-');
      if (parts.length === 4) {
        traceId = parts[1];
        parentSpanId = parts[2];
      }
    } else if (dynatraceTraceId) {
      traceId = dynatraceTraceId;
      parentSpanId = req.headers['x-dynatrace-parent-span-id'];
    } else {
      traceId = payload.traceId || crypto.randomUUID().replace(/-/g, '');
      parentSpanId = payload.spanId || null;
    }

    console.log(`[DataPersistenceService] Trace context: traceId=${traceId.substring(0,8)}..., spanId=${spanId.substring(0,8)}..., parentSpanId=${parentSpanId ? parentSpanId.substring(0,8) + '...' : 'none'}`);

    // Simulate processing time (database operations take longer)
    const processingTime = Math.floor(Math.random() * 300) + 200; // 200-500ms for DB operations

    const finish = async () => {
      try {
        // Prepare comprehensive journey data for MongoDB storage
        const journeyData = {
          journeyId: payload.journeyId || correlationId,
          correlationId,
          traceId,
          
          // Company context
          companyName: payload.companyName || 'Unknown Company',
          domain: payload.domain || 'unknown.com',
          industryType: payload.industryType || 'general',
          
          // Customer profile
          customerProfile: {
            userId: payload.userId || crypto.randomUUID(),
            email: payload.email || `customer@${payload.domain || 'example.com'}`,
            demographic: payload.demographic || `${payload.industryType || 'general'} customers`,
            painPoints: payload.painPoints || ['complexity', 'cost'],
            goals: payload.goals || ['efficiency', 'value']
          },
          
          // Journey metadata
          status: 'completed',
          totalSteps: Array.isArray(payload.steps) ? payload.steps.length : 6,
          completedSteps: Array.isArray(payload.steps) ? payload.steps.length : 6,
          
          // Journey trace with all steps
          steps: payload.journeyTrace || payload.steps || [],
          stepNames: Array.isArray(payload.steps) ? payload.steps.map(s => s.stepName || s.name) : [],
          
          // Business metrics (aggregate from all steps)
          totalProcessingTime: processingTime + (payload.processingTime || 0),
          conversionValue: payload.conversionValue || Math.floor(Math.random() * 1000) + 500,
          satisfactionScore: payload.satisfactionScore || (Math.random() * 2 + 8).toFixed(1),
          npsScore: payload.npsScore || Math.floor(Math.random() * 11),
          businessValue: payload.businessValue || Math.floor(Math.random() * 1000) + 500,
          
          // Technical context
          sessionId: payload.sessionId || crypto.randomUUID(),
          deviceType: payload.deviceType || 'web',
          browser: payload.browser || 'Chrome',
          location: payload.location || 'London, UK',
          
          // Additional fields from journey generation
          additionalFields: payload.additionalFields || {}
        };

        // Add custom attributes for Dynatrace
        const customAttributes = {
          'journey.step': currentStepName,
          'journey.service': 'DataPersistenceService',
          'journey.correlationId': correlationId,
          'journey.company': journeyData.companyName,
          'journey.domain': journeyData.domain,
          'journey.industryType': journeyData.industryType,
          'journey.totalSteps': journeyData.totalSteps,
          'journey.processingTime': processingTime,
          'database.operation': 'store_customer_journey',
          'database.collection': 'customer_journeys'
        };
        
        addCustomAttributes(customAttributes);

        // Store in memory (replaces MongoDB)
        let storageResult = null;
        let storageError = null;
        
        try {
          console.log('[DataPersistenceService] Storing journey data in memory...');
          
          // Store journey in memory
          const documentId = crypto.randomUUID();
          journeyData.documentId = documentId;
          journeyData.storedAt = new Date().toISOString();
          
          // Store in memory collections
          journeyStorage.journeys.set(journeyData.journeyId, journeyData);
          
          // Store individual steps
          if (journeyData.steps && Array.isArray(journeyData.steps)) {
            journeyData.steps.forEach((step, index) => {
              journeyStorage.steps.push({
                id: crypto.randomUUID(),
                journeyId: journeyData.journeyId,
                stepIndex: index + 1,
                stepName: step.stepName || `Step${index + 1}`,
                serviceName: step.serviceName || `${step.stepName}Service`,
                stepData: step,
                companyContext: {
                  companyName: journeyData.companyName,
                  industryType: journeyData.industryType,
                  domain: journeyData.domain
                },
                timestamp: new Date().toISOString()
              });
            });
          }
          
          // Update stats
          journeyStorage.stats.totalJourneys++;
          
          if (!journeyStorage.stats.companiesStats.has(journeyData.companyName)) {
            journeyStorage.stats.companiesStats.set(journeyData.companyName, {
              count: 0,
              latestJourney: null,
              avgBusinessValue: 0,
              industries: new Set()
            });
          }
          
          const companyStats = journeyStorage.stats.companiesStats.get(journeyData.companyName);
          companyStats.count++;
          companyStats.latestJourney = journeyData.storedAt;
          companyStats.avgBusinessValue = ((companyStats.avgBusinessValue * (companyStats.count - 1)) + journeyData.businessValue) / companyStats.count;
          companyStats.industries.add(journeyData.industryType);
          
          storageResult = {
            success: true,
            journeyId: journeyData.journeyId,
            documentId: documentId,
            timestamp: journeyData.storedAt
          };
          
          console.log(`[DataPersistenceService] Successfully stored journey in memory:`, storageResult);
          
          // Send business event for successful storage
          sendBusinessEvent('journey_data_persisted', {
            journeyId: journeyData.journeyId,
            correlationId,
            companyName: journeyData.companyName,
            industryType: journeyData.industryType,
            totalSteps: journeyData.totalSteps,
            businessValue: journeyData.businessValue,
            documentId: storageResult.documentId,
            storageType: 'in-memory'
          });
          
        } catch (error) {
          console.error('[DataPersistenceService] Memory storage failed:', error.message);
          storageError = error.message;
          
          // Send business event for storage failure
          sendBusinessEvent('journey_storage_failed', {
            journeyId: journeyData.journeyId,
            correlationId,
            error: error.message,
            companyName: journeyData.companyName,
            storageType: 'in-memory'
          });
        }

        // Update journey trace with this final step
        const journeyTrace = Array.isArray(payload.journeyTrace) ? [...payload.journeyTrace] : [];
        const stepEntry = {
          stepName: currentStepName,
          serviceName: 'DataPersistenceService',
          timestamp: new Date().toISOString(),
          correlationId,
          processingTime,
          storageOperation: storageResult ? 'success' : 'failed',
          documentId: storageResult?.documentId || null
        };
        journeyTrace.push(stepEntry);

        // Prepare final response
        const response = {
          ...payload,
          stepName: currentStepName,
          service: 'DataPersistenceService',
          status: 'completed',
          correlationId,
          processingTime,
          pid: process.pid,
          timestamp: new Date().toISOString(),
          
          // Storage operation results
          storageResults: {
            success: !!storageResult,
            journeyId: journeyData.journeyId,
            documentId: storageResult?.documentId || null,
            error: storageError,
            storedAt: storageResult?.timestamp || null,
            storageType: 'in-memory'
          },
          
          // Final journey summary
          journeySummary: {
            totalSteps: journeyData.totalSteps,
            completedSteps: journeyData.completedSteps,
            totalProcessingTime: journeyData.totalProcessingTime,
            businessValue: journeyData.businessValue,
            satisfactionScore: journeyData.satisfactionScore,
            company: journeyData.companyName,
            industry: journeyData.industryType
          },
          
          journeyTrace,
          
          // Metadata for final step
          metadata: {
            isTerminalStep: true,
            dataPersisted: !!storageResult,
            finalStep: true,
            dataIntegrity: 'validated',
            archivalStatus: 'completed',
            storageType: 'in-memory'
          }
        };

        console.log(`[DataPersistenceService] Final journey processing completed:`, {
          journeyId: journeyData.journeyId,
          correlationId,
          storageSuccess: !!storageResult,
          totalSteps: journeyData.totalSteps,
          processingTime
        });

        res.json(response);
        
      } catch (error) {
        console.error('[DataPersistenceService] Critical error in final processing:', error);
        
        // Emergency response for critical failures
        res.status(500).json({
          stepName: currentStepName,
          service: 'DataPersistenceService',
          status: 'error',
          correlationId,
          error: error.message,
          processingTime,
          timestamp: new Date().toISOString(),
          metadata: {
            isTerminalStep: true,
            criticalError: true,
            errorType: 'service_failure'
          }
        });
      }
    };

    // Simulate database processing time
    setTimeout(finish, processingTime);
  });

  // Health check endpoint that includes storage status
  app.get('/health', async (req, res) => {
    try {
      const storageHealth = {
        status: 'healthy',
        type: 'in-memory',
        journeysStored: journeyStorage.journeys.size,
        stepsStored: journeyStorage.steps.length,
        companiesTracked: journeyStorage.stats.companiesStats.size
      };
      
      res.json({
        service: 'DataPersistenceService',
        status: 'healthy',
        timestamp: new Date().toISOString(),
        pid: process.pid,
        storage: storageHealth,
        capabilities: [
          'journey_storage',
          'in_memory_persistence', 
          'analytics_support',
          'dynatrace_tracing'
        ]
      });
    } catch (error) {
      res.status(500).json({
        service: 'DataPersistenceService',
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Analytics endpoint for stored journey data
  app.get('/analytics/:companyName', async (req, res) => {
    try {
      const { companyName } = req.params;
      const { timeframe = '24h' } = req.query;
      
      // Calculate time range
      const now = new Date();
      const timeRanges = {
        '1h': new Date(now - 60 * 60 * 1000),
        '24h': new Date(now - 24 * 60 * 60 * 1000),
        '7d': new Date(now - 7 * 24 * 60 * 60 * 1000),
        '30d': new Date(now - 30 * 24 * 60 * 60 * 1000)
      };
      
      const startTime = timeRanges[timeframe] || timeRanges['24h'];
      
      // Filter journeys by company and timeframe
      const companyJourneys = Array.from(journeyStorage.journeys.values())
        .filter(journey => 
          journey.companyName === companyName && 
          new Date(journey.timestamp) >= startTime
        );
      
      // Calculate analytics
      const analytics = {
        companyName,
        timeframe,
        totalJourneys: companyJourneys.length,
        avgProcessingTime: companyJourneys.reduce((sum, j) => sum + (j.totalProcessingTime || 0), 0) / companyJourneys.length || 0,
        avgSatisfactionScore: companyJourneys.reduce((sum, j) => sum + (j.businessMetrics?.satisfactionScore || 0), 0) / companyJourneys.length || 0,
        totalBusinessValue: companyJourneys.reduce((sum, j) => sum + (j.businessMetrics?.businessValue || 0), 0),
        completionRate: companyJourneys.reduce((sum, j) => sum + ((j.completedSteps || 0) / (j.totalSteps || 1)), 0) / companyJourneys.length || 0,
        industries: [...new Set(companyJourneys.map(j => j.industryType))]
      };
      
      res.json({
        company: companyName,
        timeframe,
        analytics,
        generatedAt: new Date().toISOString(),
        storageType: 'in-memory'
      });
      
    } catch (error) {
      res.status(500).json({
        error: 'Analytics generation failed',
        message: error.message
      });
    }
  });

  // Journey stats endpoint
  app.get('/stats', async (req, res) => {
    try {
      const companiesStats = Array.from(journeyStorage.stats.companiesStats.entries()).map(([companyName, stats]) => ({
        _id: companyName,
        count: stats.count,
        latestJourney: stats.latestJourney,
        avgBusinessValue: stats.avgBusinessValue,
        industries: Array.from(stats.industries)
      })).sort((a, b) => b.count - a.count);
      
      const stats = {
        totalJourneys: journeyStorage.stats.totalJourneys,
        companiesStats
      };
      
      res.json({
        ...stats,
        generatedAt: new Date().toISOString(),
        service: 'DataPersistenceService',
        storageType: 'in-memory'
      });
      
    } catch (error) {
      res.status(500).json({
        error: 'Stats generation failed',
        message: error.message
      });
    }
  });
});

console.log('[DataPersistenceService] Service initialized with in-memory storage');
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRGF0YVBlcnNpc3RlbmNlU2VydmljZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIkRhdGFQZXJzaXN0ZW5jZVNlcnZpY2UuanMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBEYXRhIFBlcnNpc3RlbmNlIFNlcnZpY2UgLSBGaW5hbCBzdGVwIGluIGN1c3RvbWVyIGpvdXJuZXlcbiAqIFN0b3JlcyBjb21wbGV0ZSBqb3VybmV5IGRhdGEgaW4gbWVtb3J5IHdpdGggRHluYXRyYWNlIHRyYWNpbmdcbiAqIChNb25nb0RCIGludGVncmF0aW9uIHJlbW92ZWQpXG4gKi9cblxuY29uc3QgeyBjcmVhdGVTZXJ2aWNlIH0gPSByZXF1aXJlKCcuL3NlcnZpY2UtcnVubmVyLmpzJyk7XG5jb25zdCBodHRwID0gcmVxdWlyZSgnaHR0cCcpO1xuY29uc3QgY3J5cHRvID0gcmVxdWlyZSgnY3J5cHRvJyk7XG5cbi8vIEluLW1lbW9yeSBzdG9yYWdlIGZvciBqb3VybmV5IGRhdGEgKHJlcGxhY2VzIE1vbmdvREIpXG5jb25zdCBqb3VybmV5U3RvcmFnZSA9IHtcbiAgam91cm5leXM6IG5ldyBNYXAoKSxcbiAgc3RlcHM6IFtdLFxuICBzdGF0czoge1xuICAgIHRvdGFsSm91cm5leXM6IDAsXG4gICAgY29tcGFuaWVzU3RhdHM6IG5ldyBNYXAoKVxuICB9XG59O1xuXG4vLyBGYWxsYmFjayBEeW5hdHJhY2UgaGVscGVyc1xuY29uc3QgYWRkQ3VzdG9tQXR0cmlidXRlcyA9IChhdHRyaWJ1dGVzKSA9PiB7XG4gIGNvbnNvbGUubG9nKCdbZHluYXRyYWNlXSBDdXN0b20gYXR0cmlidXRlczonLCBhdHRyaWJ1dGVzKTtcbn07XG5cbmNvbnN0IHdpdGhDdXN0b21TcGFuID0gKG5hbWUsIGNhbGxiYWNrKSA9PiB7XG4gIGNvbnNvbGUubG9nKCdbZHluYXRyYWNlXSBDdXN0b20gc3BhbjonLCBuYW1lKTtcbiAgcmV0dXJuIGNhbGxiYWNrKCk7XG59O1xuXG5jb25zdCBzZW5kQnVzaW5lc3NFdmVudCA9IChldmVudFR5cGUsIGRhdGEpID0+IHtcbiAgY29uc29sZS5sb2coJ1tkeW5hdHJhY2VdIEJ1c2luZXNzIGV2ZW50OicsIGV2ZW50VHlwZSwgZGF0YSk7XG59O1xuXG5jcmVhdGVTZXJ2aWNlKCdEYXRhUGVyc2lzdGVuY2VTZXJ2aWNlJywgKGFwcCkgPT4ge1xuICBhcHAucG9zdCgnL3Byb2Nlc3MnLCBhc3luYyAocmVxLCByZXMpID0+IHtcbiAgICBjb25zdCBwYXlsb2FkID0gcmVxLmJvZHkgfHwge307XG4gICAgY29uc3QgY29ycmVsYXRpb25JZCA9IHJlcS5jb3JyZWxhdGlvbklkO1xuICAgIGNvbnN0IGN1cnJlbnRTdGVwTmFtZSA9IHBheWxvYWQuc3RlcE5hbWUgfHwgJ0RhdGFQZXJzaXN0ZW5jZSc7XG4gICAgXG4gICAgY29uc29sZS5sb2coYFtEYXRhUGVyc2lzdGVuY2VTZXJ2aWNlXSBQcm9jZXNzaW5nIGZpbmFsIGpvdXJuZXkgc3RlcCB3aXRoIGNvcnJlbGF0aW9uOiAke2NvcnJlbGF0aW9uSWR9YCk7XG4gICAgY29uc29sZS5sb2coYFtEYXRhUGVyc2lzdGVuY2VTZXJ2aWNlXSBSZWNlaXZlZCBqb3VybmV5IGRhdGE6YCwgSlNPTi5zdHJpbmdpZnkocGF5bG9hZCwgbnVsbCwgMikpO1xuXG4gICAgLy8gRXh0cmFjdCB0cmFjZSBjb250ZXh0XG4gICAgY29uc3QgaW5jb21pbmdUcmFjZVBhcmVudCA9IHJlcS5oZWFkZXJzWyd0cmFjZXBhcmVudCddO1xuICAgIGNvbnN0IGluY29taW5nVHJhY2VTdGF0ZSA9IHJlcS5oZWFkZXJzWyd0cmFjZXN0YXRlJ107XG4gICAgY29uc3QgZHluYXRyYWNlVHJhY2VJZCA9IHJlcS5oZWFkZXJzWyd4LWR5bmF0cmFjZS10cmFjZS1pZCddO1xuICAgIFxuICAgIC8vIEdlbmVyYXRlIHNwYW4gSUQgZm9yIHRoaXMgc2VydmljZVxuICAgIGNvbnN0IHNwYW5JZCA9IGNyeXB0by5yYW5kb21VVUlEKCkuc2xpY2UoMCwgMTYpLnJlcGxhY2UoLy0vZywgJycpO1xuICAgIFxuICAgIGxldCB0cmFjZUlkLCBwYXJlbnRTcGFuSWQ7XG4gICAgXG4gICAgaWYgKGluY29taW5nVHJhY2VQYXJlbnQpIHtcbiAgICAgIGNvbnN0IHBhcnRzID0gaW5jb21pbmdUcmFjZVBhcmVudC5zcGxpdCgnLScpO1xuICAgICAgaWYgKHBhcnRzLmxlbmd0aCA9PT0gNCkge1xuICAgICAgICB0cmFjZUlkID0gcGFydHNbMV07XG4gICAgICAgIHBhcmVudFNwYW5JZCA9IHBhcnRzWzJdO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoZHluYXRyYWNlVHJhY2VJZCkge1xuICAgICAgdHJhY2VJZCA9IGR5bmF0cmFjZVRyYWNlSWQ7XG4gICAgICBwYXJlbnRTcGFuSWQgPSByZXEuaGVhZGVyc1sneC1keW5hdHJhY2UtcGFyZW50LXNwYW4taWQnXTtcbiAgICB9IGVsc2Uge1xuICAgICAgdHJhY2VJZCA9IHBheWxvYWQudHJhY2VJZCB8fCBjcnlwdG8ucmFuZG9tVVVJRCgpLnJlcGxhY2UoLy0vZywgJycpO1xuICAgICAgcGFyZW50U3BhbklkID0gcGF5bG9hZC5zcGFuSWQgfHwgbnVsbDtcbiAgICB9XG5cbiAgICBjb25zb2xlLmxvZyhgW0RhdGFQZXJzaXN0ZW5jZVNlcnZpY2VdIFRyYWNlIGNvbnRleHQ6IHRyYWNlSWQ9JHt0cmFjZUlkLnN1YnN0cmluZygwLDgpfS4uLiwgc3BhbklkPSR7c3BhbklkLnN1YnN0cmluZygwLDgpfS4uLiwgcGFyZW50U3BhbklkPSR7cGFyZW50U3BhbklkID8gcGFyZW50U3BhbklkLnN1YnN0cmluZygwLDgpICsgJy4uLicgOiAnbm9uZSd9YCk7XG5cbiAgICAvLyBTaW11bGF0ZSBwcm9jZXNzaW5nIHRpbWUgKGRhdGFiYXNlIG9wZXJhdGlvbnMgdGFrZSBsb25nZXIpXG4gICAgY29uc3QgcHJvY2Vzc2luZ1RpbWUgPSBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiAzMDApICsgMjAwOyAvLyAyMDAtNTAwbXMgZm9yIERCIG9wZXJhdGlvbnNcblxuICAgIGNvbnN0IGZpbmlzaCA9IGFzeW5jICgpID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIC8vIFByZXBhcmUgY29tcHJlaGVuc2l2ZSBqb3VybmV5IGRhdGEgZm9yIE1vbmdvREIgc3RvcmFnZVxuICAgICAgICBjb25zdCBqb3VybmV5RGF0YSA9IHtcbiAgICAgICAgICBqb3VybmV5SWQ6IHBheWxvYWQuam91cm5leUlkIHx8IGNvcnJlbGF0aW9uSWQsXG4gICAgICAgICAgY29ycmVsYXRpb25JZCxcbiAgICAgICAgICB0cmFjZUlkLFxuICAgICAgICAgIFxuICAgICAgICAgIC8vIENvbXBhbnkgY29udGV4dFxuICAgICAgICAgIGNvbXBhbnlOYW1lOiBwYXlsb2FkLmNvbXBhbnlOYW1lIHx8ICdVbmtub3duIENvbXBhbnknLFxuICAgICAgICAgIGRvbWFpbjogcGF5bG9hZC5kb21haW4gfHwgJ3Vua25vd24uY29tJyxcbiAgICAgICAgICBpbmR1c3RyeVR5cGU6IHBheWxvYWQuaW5kdXN0cnlUeXBlIHx8ICdnZW5lcmFsJyxcbiAgICAgICAgICBcbiAgICAgICAgICAvLyBDdXN0b21lciBwcm9maWxlXG4gICAgICAgICAgY3VzdG9tZXJQcm9maWxlOiB7XG4gICAgICAgICAgICB1c2VySWQ6IHBheWxvYWQudXNlcklkIHx8IGNyeXB0by5yYW5kb21VVUlEKCksXG4gICAgICAgICAgICBlbWFpbDogcGF5bG9hZC5lbWFpbCB8fCBgY3VzdG9tZXJAJHtwYXlsb2FkLmRvbWFpbiB8fCAnZXhhbXBsZS5jb20nfWAsXG4gICAgICAgICAgICBkZW1vZ3JhcGhpYzogcGF5bG9hZC5kZW1vZ3JhcGhpYyB8fCBgJHtwYXlsb2FkLmluZHVzdHJ5VHlwZSB8fCAnZ2VuZXJhbCd9IGN1c3RvbWVyc2AsXG4gICAgICAgICAgICBwYWluUG9pbnRzOiBwYXlsb2FkLnBhaW5Qb2ludHMgfHwgWydjb21wbGV4aXR5JywgJ2Nvc3QnXSxcbiAgICAgICAgICAgIGdvYWxzOiBwYXlsb2FkLmdvYWxzIHx8IFsnZWZmaWNpZW5jeScsICd2YWx1ZSddXG4gICAgICAgICAgfSxcbiAgICAgICAgICBcbiAgICAgICAgICAvLyBKb3VybmV5IG1ldGFkYXRhXG4gICAgICAgICAgc3RhdHVzOiAnY29tcGxldGVkJyxcbiAgICAgICAgICB0b3RhbFN0ZXBzOiBBcnJheS5pc0FycmF5KHBheWxvYWQuc3RlcHMpID8gcGF5bG9hZC5zdGVwcy5sZW5ndGggOiA2LFxuICAgICAgICAgIGNvbXBsZXRlZFN0ZXBzOiBBcnJheS5pc0FycmF5KHBheWxvYWQuc3RlcHMpID8gcGF5bG9hZC5zdGVwcy5sZW5ndGggOiA2LFxuICAgICAgICAgIFxuICAgICAgICAgIC8vIEpvdXJuZXkgdHJhY2Ugd2l0aCBhbGwgc3RlcHNcbiAgICAgICAgICBzdGVwczogcGF5bG9hZC5qb3VybmV5VHJhY2UgfHwgcGF5bG9hZC5zdGVwcyB8fCBbXSxcbiAgICAgICAgICBzdGVwTmFtZXM6IEFycmF5LmlzQXJyYXkocGF5bG9hZC5zdGVwcykgPyBwYXlsb2FkLnN0ZXBzLm1hcChzID0+IHMuc3RlcE5hbWUgfHwgcy5uYW1lKSA6IFtdLFxuICAgICAgICAgIFxuICAgICAgICAgIC8vIEJ1c2luZXNzIG1ldHJpY3MgKGFnZ3JlZ2F0ZSBmcm9tIGFsbCBzdGVwcylcbiAgICAgICAgICB0b3RhbFByb2Nlc3NpbmdUaW1lOiBwcm9jZXNzaW5nVGltZSArIChwYXlsb2FkLnByb2Nlc3NpbmdUaW1lIHx8IDApLFxuICAgICAgICAgIGNvbnZlcnNpb25WYWx1ZTogcGF5bG9hZC5jb252ZXJzaW9uVmFsdWUgfHwgTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogMTAwMCkgKyA1MDAsXG4gICAgICAgICAgc2F0aXNmYWN0aW9uU2NvcmU6IHBheWxvYWQuc2F0aXNmYWN0aW9uU2NvcmUgfHwgKE1hdGgucmFuZG9tKCkgKiAyICsgOCkudG9GaXhlZCgxKSxcbiAgICAgICAgICBucHNTY29yZTogcGF5bG9hZC5ucHNTY29yZSB8fCBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiAxMSksXG4gICAgICAgICAgYnVzaW5lc3NWYWx1ZTogcGF5bG9hZC5idXNpbmVzc1ZhbHVlIHx8IE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIDEwMDApICsgNTAwLFxuICAgICAgICAgIFxuICAgICAgICAgIC8vIFRlY2huaWNhbCBjb250ZXh0XG4gICAgICAgICAgc2Vzc2lvbklkOiBwYXlsb2FkLnNlc3Npb25JZCB8fCBjcnlwdG8ucmFuZG9tVVVJRCgpLFxuICAgICAgICAgIGRldmljZVR5cGU6IHBheWxvYWQuZGV2aWNlVHlwZSB8fCAnd2ViJyxcbiAgICAgICAgICBicm93c2VyOiBwYXlsb2FkLmJyb3dzZXIgfHwgJ0Nocm9tZScsXG4gICAgICAgICAgbG9jYXRpb246IHBheWxvYWQubG9jYXRpb24gfHwgJ0xvbmRvbiwgVUsnLFxuICAgICAgICAgIFxuICAgICAgICAgIC8vIEFkZGl0aW9uYWwgZmllbGRzIGZyb20gam91cm5leSBnZW5lcmF0aW9uXG4gICAgICAgICAgYWRkaXRpb25hbEZpZWxkczogcGF5bG9hZC5hZGRpdGlvbmFsRmllbGRzIHx8IHt9XG4gICAgICAgIH07XG5cbiAgICAgICAgLy8gQWRkIGN1c3RvbSBhdHRyaWJ1dGVzIGZvciBEeW5hdHJhY2VcbiAgICAgICAgY29uc3QgY3VzdG9tQXR0cmlidXRlcyA9IHtcbiAgICAgICAgICAnam91cm5leS5zdGVwJzogY3VycmVudFN0ZXBOYW1lLFxuICAgICAgICAgICdqb3VybmV5LnNlcnZpY2UnOiAnRGF0YVBlcnNpc3RlbmNlU2VydmljZScsXG4gICAgICAgICAgJ2pvdXJuZXkuY29ycmVsYXRpb25JZCc6IGNvcnJlbGF0aW9uSWQsXG4gICAgICAgICAgJ2pvdXJuZXkuY29tcGFueSc6IGpvdXJuZXlEYXRhLmNvbXBhbnlOYW1lLFxuICAgICAgICAgICdqb3VybmV5LmRvbWFpbic6IGpvdXJuZXlEYXRhLmRvbWFpbixcbiAgICAgICAgICAnam91cm5leS5pbmR1c3RyeVR5cGUnOiBqb3VybmV5RGF0YS5pbmR1c3RyeVR5cGUsXG4gICAgICAgICAgJ2pvdXJuZXkudG90YWxTdGVwcyc6IGpvdXJuZXlEYXRhLnRvdGFsU3RlcHMsXG4gICAgICAgICAgJ2pvdXJuZXkucHJvY2Vzc2luZ1RpbWUnOiBwcm9jZXNzaW5nVGltZSxcbiAgICAgICAgICAnZGF0YWJhc2Uub3BlcmF0aW9uJzogJ3N0b3JlX2N1c3RvbWVyX2pvdXJuZXknLFxuICAgICAgICAgICdkYXRhYmFzZS5jb2xsZWN0aW9uJzogJ2N1c3RvbWVyX2pvdXJuZXlzJ1xuICAgICAgICB9O1xuICAgICAgICBcbiAgICAgICAgYWRkQ3VzdG9tQXR0cmlidXRlcyhjdXN0b21BdHRyaWJ1dGVzKTtcblxuICAgICAgICAvLyBTdG9yZSBpbiBtZW1vcnkgKHJlcGxhY2VzIE1vbmdvREIpXG4gICAgICAgIGxldCBzdG9yYWdlUmVzdWx0ID0gbnVsbDtcbiAgICAgICAgbGV0IHN0b3JhZ2VFcnJvciA9IG51bGw7XG4gICAgICAgIFxuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnNvbGUubG9nKCdbRGF0YVBlcnNpc3RlbmNlU2VydmljZV0gU3RvcmluZyBqb3VybmV5IGRhdGEgaW4gbWVtb3J5Li4uJyk7XG4gICAgICAgICAgXG4gICAgICAgICAgLy8gU3RvcmUgam91cm5leSBpbiBtZW1vcnlcbiAgICAgICAgICBjb25zdCBkb2N1bWVudElkID0gY3J5cHRvLnJhbmRvbVVVSUQoKTtcbiAgICAgICAgICBqb3VybmV5RGF0YS5kb2N1bWVudElkID0gZG9jdW1lbnRJZDtcbiAgICAgICAgICBqb3VybmV5RGF0YS5zdG9yZWRBdCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcbiAgICAgICAgICBcbiAgICAgICAgICAvLyBTdG9yZSBpbiBtZW1vcnkgY29sbGVjdGlvbnNcbiAgICAgICAgICBqb3VybmV5U3RvcmFnZS5qb3VybmV5cy5zZXQoam91cm5leURhdGEuam91cm5leUlkLCBqb3VybmV5RGF0YSk7XG4gICAgICAgICAgXG4gICAgICAgICAgLy8gU3RvcmUgaW5kaXZpZHVhbCBzdGVwc1xuICAgICAgICAgIGlmIChqb3VybmV5RGF0YS5zdGVwcyAmJiBBcnJheS5pc0FycmF5KGpvdXJuZXlEYXRhLnN0ZXBzKSkge1xuICAgICAgICAgICAgam91cm5leURhdGEuc3RlcHMuZm9yRWFjaCgoc3RlcCwgaW5kZXgpID0+IHtcbiAgICAgICAgICAgICAgam91cm5leVN0b3JhZ2Uuc3RlcHMucHVzaCh7XG4gICAgICAgICAgICAgICAgaWQ6IGNyeXB0by5yYW5kb21VVUlEKCksXG4gICAgICAgICAgICAgICAgam91cm5leUlkOiBqb3VybmV5RGF0YS5qb3VybmV5SWQsXG4gICAgICAgICAgICAgICAgc3RlcEluZGV4OiBpbmRleCArIDEsXG4gICAgICAgICAgICAgICAgc3RlcE5hbWU6IHN0ZXAuc3RlcE5hbWUgfHwgYFN0ZXAke2luZGV4ICsgMX1gLFxuICAgICAgICAgICAgICAgIHNlcnZpY2VOYW1lOiBzdGVwLnNlcnZpY2VOYW1lIHx8IGAke3N0ZXAuc3RlcE5hbWV9U2VydmljZWAsXG4gICAgICAgICAgICAgICAgc3RlcERhdGE6IHN0ZXAsXG4gICAgICAgICAgICAgICAgY29tcGFueUNvbnRleHQ6IHtcbiAgICAgICAgICAgICAgICAgIGNvbXBhbnlOYW1lOiBqb3VybmV5RGF0YS5jb21wYW55TmFtZSxcbiAgICAgICAgICAgICAgICAgIGluZHVzdHJ5VHlwZTogam91cm5leURhdGEuaW5kdXN0cnlUeXBlLFxuICAgICAgICAgICAgICAgICAgZG9tYWluOiBqb3VybmV5RGF0YS5kb21haW5cbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIFxuICAgICAgICAgIC8vIFVwZGF0ZSBzdGF0c1xuICAgICAgICAgIGpvdXJuZXlTdG9yYWdlLnN0YXRzLnRvdGFsSm91cm5leXMrKztcbiAgICAgICAgICBcbiAgICAgICAgICBpZiAoIWpvdXJuZXlTdG9yYWdlLnN0YXRzLmNvbXBhbmllc1N0YXRzLmhhcyhqb3VybmV5RGF0YS5jb21wYW55TmFtZSkpIHtcbiAgICAgICAgICAgIGpvdXJuZXlTdG9yYWdlLnN0YXRzLmNvbXBhbmllc1N0YXRzLnNldChqb3VybmV5RGF0YS5jb21wYW55TmFtZSwge1xuICAgICAgICAgICAgICBjb3VudDogMCxcbiAgICAgICAgICAgICAgbGF0ZXN0Sm91cm5leTogbnVsbCxcbiAgICAgICAgICAgICAgYXZnQnVzaW5lc3NWYWx1ZTogMCxcbiAgICAgICAgICAgICAgaW5kdXN0cmllczogbmV3IFNldCgpXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgXG4gICAgICAgICAgY29uc3QgY29tcGFueVN0YXRzID0gam91cm5leVN0b3JhZ2Uuc3RhdHMuY29tcGFuaWVzU3RhdHMuZ2V0KGpvdXJuZXlEYXRhLmNvbXBhbnlOYW1lKTtcbiAgICAgICAgICBjb21wYW55U3RhdHMuY291bnQrKztcbiAgICAgICAgICBjb21wYW55U3RhdHMubGF0ZXN0Sm91cm5leSA9IGpvdXJuZXlEYXRhLnN0b3JlZEF0O1xuICAgICAgICAgIGNvbXBhbnlTdGF0cy5hdmdCdXNpbmVzc1ZhbHVlID0gKChjb21wYW55U3RhdHMuYXZnQnVzaW5lc3NWYWx1ZSAqIChjb21wYW55U3RhdHMuY291bnQgLSAxKSkgKyBqb3VybmV5RGF0YS5idXNpbmVzc1ZhbHVlKSAvIGNvbXBhbnlTdGF0cy5jb3VudDtcbiAgICAgICAgICBjb21wYW55U3RhdHMuaW5kdXN0cmllcy5hZGQoam91cm5leURhdGEuaW5kdXN0cnlUeXBlKTtcbiAgICAgICAgICBcbiAgICAgICAgICBzdG9yYWdlUmVzdWx0ID0ge1xuICAgICAgICAgICAgc3VjY2VzczogdHJ1ZSxcbiAgICAgICAgICAgIGpvdXJuZXlJZDogam91cm5leURhdGEuam91cm5leUlkLFxuICAgICAgICAgICAgZG9jdW1lbnRJZDogZG9jdW1lbnRJZCxcbiAgICAgICAgICAgIHRpbWVzdGFtcDogam91cm5leURhdGEuc3RvcmVkQXRcbiAgICAgICAgICB9O1xuICAgICAgICAgIFxuICAgICAgICAgIGNvbnNvbGUubG9nKGBbRGF0YVBlcnNpc3RlbmNlU2VydmljZV0gU3VjY2Vzc2Z1bGx5IHN0b3JlZCBqb3VybmV5IGluIG1lbW9yeTpgLCBzdG9yYWdlUmVzdWx0KTtcbiAgICAgICAgICBcbiAgICAgICAgICAvLyBTZW5kIGJ1c2luZXNzIGV2ZW50IGZvciBzdWNjZXNzZnVsIHN0b3JhZ2VcbiAgICAgICAgICBzZW5kQnVzaW5lc3NFdmVudCgnam91cm5leV9kYXRhX3BlcnNpc3RlZCcsIHtcbiAgICAgICAgICAgIGpvdXJuZXlJZDogam91cm5leURhdGEuam91cm5leUlkLFxuICAgICAgICAgICAgY29ycmVsYXRpb25JZCxcbiAgICAgICAgICAgIGNvbXBhbnlOYW1lOiBqb3VybmV5RGF0YS5jb21wYW55TmFtZSxcbiAgICAgICAgICAgIGluZHVzdHJ5VHlwZTogam91cm5leURhdGEuaW5kdXN0cnlUeXBlLFxuICAgICAgICAgICAgdG90YWxTdGVwczogam91cm5leURhdGEudG90YWxTdGVwcyxcbiAgICAgICAgICAgIGJ1c2luZXNzVmFsdWU6IGpvdXJuZXlEYXRhLmJ1c2luZXNzVmFsdWUsXG4gICAgICAgICAgICBkb2N1bWVudElkOiBzdG9yYWdlUmVzdWx0LmRvY3VtZW50SWQsXG4gICAgICAgICAgICBzdG9yYWdlVHlwZTogJ2luLW1lbW9yeSdcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICBjb25zb2xlLmVycm9yKCdbRGF0YVBlcnNpc3RlbmNlU2VydmljZV0gTWVtb3J5IHN0b3JhZ2UgZmFpbGVkOicsIGVycm9yLm1lc3NhZ2UpO1xuICAgICAgICAgIHN0b3JhZ2VFcnJvciA9IGVycm9yLm1lc3NhZ2U7XG4gICAgICAgICAgXG4gICAgICAgICAgLy8gU2VuZCBidXNpbmVzcyBldmVudCBmb3Igc3RvcmFnZSBmYWlsdXJlXG4gICAgICAgICAgc2VuZEJ1c2luZXNzRXZlbnQoJ2pvdXJuZXlfc3RvcmFnZV9mYWlsZWQnLCB7XG4gICAgICAgICAgICBqb3VybmV5SWQ6IGpvdXJuZXlEYXRhLmpvdXJuZXlJZCxcbiAgICAgICAgICAgIGNvcnJlbGF0aW9uSWQsXG4gICAgICAgICAgICBlcnJvcjogZXJyb3IubWVzc2FnZSxcbiAgICAgICAgICAgIGNvbXBhbnlOYW1lOiBqb3VybmV5RGF0YS5jb21wYW55TmFtZSxcbiAgICAgICAgICAgIHN0b3JhZ2VUeXBlOiAnaW4tbWVtb3J5J1xuICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gVXBkYXRlIGpvdXJuZXkgdHJhY2Ugd2l0aCB0aGlzIGZpbmFsIHN0ZXBcbiAgICAgICAgY29uc3Qgam91cm5leVRyYWNlID0gQXJyYXkuaXNBcnJheShwYXlsb2FkLmpvdXJuZXlUcmFjZSkgPyBbLi4ucGF5bG9hZC5qb3VybmV5VHJhY2VdIDogW107XG4gICAgICAgIGNvbnN0IHN0ZXBFbnRyeSA9IHtcbiAgICAgICAgICBzdGVwTmFtZTogY3VycmVudFN0ZXBOYW1lLFxuICAgICAgICAgIHNlcnZpY2VOYW1lOiAnRGF0YVBlcnNpc3RlbmNlU2VydmljZScsXG4gICAgICAgICAgdGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgICAgY29ycmVsYXRpb25JZCxcbiAgICAgICAgICBwcm9jZXNzaW5nVGltZSxcbiAgICAgICAgICBzdG9yYWdlT3BlcmF0aW9uOiBzdG9yYWdlUmVzdWx0ID8gJ3N1Y2Nlc3MnIDogJ2ZhaWxlZCcsXG4gICAgICAgICAgZG9jdW1lbnRJZDogc3RvcmFnZVJlc3VsdD8uZG9jdW1lbnRJZCB8fCBudWxsXG4gICAgICAgIH07XG4gICAgICAgIGpvdXJuZXlUcmFjZS5wdXNoKHN0ZXBFbnRyeSk7XG5cbiAgICAgICAgLy8gUHJlcGFyZSBmaW5hbCByZXNwb25zZVxuICAgICAgICBjb25zdCByZXNwb25zZSA9IHtcbiAgICAgICAgICAuLi5wYXlsb2FkLFxuICAgICAgICAgIHN0ZXBOYW1lOiBjdXJyZW50U3RlcE5hbWUsXG4gICAgICAgICAgc2VydmljZTogJ0RhdGFQZXJzaXN0ZW5jZVNlcnZpY2UnLFxuICAgICAgICAgIHN0YXR1czogJ2NvbXBsZXRlZCcsXG4gICAgICAgICAgY29ycmVsYXRpb25JZCxcbiAgICAgICAgICBwcm9jZXNzaW5nVGltZSxcbiAgICAgICAgICBwaWQ6IHByb2Nlc3MucGlkLFxuICAgICAgICAgIHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICAgIFxuICAgICAgICAgIC8vIFN0b3JhZ2Ugb3BlcmF0aW9uIHJlc3VsdHNcbiAgICAgICAgICBzdG9yYWdlUmVzdWx0czoge1xuICAgICAgICAgICAgc3VjY2VzczogISFzdG9yYWdlUmVzdWx0LFxuICAgICAgICAgICAgam91cm5leUlkOiBqb3VybmV5RGF0YS5qb3VybmV5SWQsXG4gICAgICAgICAgICBkb2N1bWVudElkOiBzdG9yYWdlUmVzdWx0Py5kb2N1bWVudElkIHx8IG51bGwsXG4gICAgICAgICAgICBlcnJvcjogc3RvcmFnZUVycm9yLFxuICAgICAgICAgICAgc3RvcmVkQXQ6IHN0b3JhZ2VSZXN1bHQ/LnRpbWVzdGFtcCB8fCBudWxsLFxuICAgICAgICAgICAgc3RvcmFnZVR5cGU6ICdpbi1tZW1vcnknXG4gICAgICAgICAgfSxcbiAgICAgICAgICBcbiAgICAgICAgICAvLyBGaW5hbCBqb3VybmV5IHN1bW1hcnlcbiAgICAgICAgICBqb3VybmV5U3VtbWFyeToge1xuICAgICAgICAgICAgdG90YWxTdGVwczogam91cm5leURhdGEudG90YWxTdGVwcyxcbiAgICAgICAgICAgIGNvbXBsZXRlZFN0ZXBzOiBqb3VybmV5RGF0YS5jb21wbGV0ZWRTdGVwcyxcbiAgICAgICAgICAgIHRvdGFsUHJvY2Vzc2luZ1RpbWU6IGpvdXJuZXlEYXRhLnRvdGFsUHJvY2Vzc2luZ1RpbWUsXG4gICAgICAgICAgICBidXNpbmVzc1ZhbHVlOiBqb3VybmV5RGF0YS5idXNpbmVzc1ZhbHVlLFxuICAgICAgICAgICAgc2F0aXNmYWN0aW9uU2NvcmU6IGpvdXJuZXlEYXRhLnNhdGlzZmFjdGlvblNjb3JlLFxuICAgICAgICAgICAgY29tcGFueTogam91cm5leURhdGEuY29tcGFueU5hbWUsXG4gICAgICAgICAgICBpbmR1c3RyeTogam91cm5leURhdGEuaW5kdXN0cnlUeXBlXG4gICAgICAgICAgfSxcbiAgICAgICAgICBcbiAgICAgICAgICBqb3VybmV5VHJhY2UsXG4gICAgICAgICAgXG4gICAgICAgICAgLy8gTWV0YWRhdGEgZm9yIGZpbmFsIHN0ZXBcbiAgICAgICAgICBtZXRhZGF0YToge1xuICAgICAgICAgICAgaXNUZXJtaW5hbFN0ZXA6IHRydWUsXG4gICAgICAgICAgICBkYXRhUGVyc2lzdGVkOiAhIXN0b3JhZ2VSZXN1bHQsXG4gICAgICAgICAgICBmaW5hbFN0ZXA6IHRydWUsXG4gICAgICAgICAgICBkYXRhSW50ZWdyaXR5OiAndmFsaWRhdGVkJyxcbiAgICAgICAgICAgIGFyY2hpdmFsU3RhdHVzOiAnY29tcGxldGVkJyxcbiAgICAgICAgICAgIHN0b3JhZ2VUeXBlOiAnaW4tbWVtb3J5J1xuICAgICAgICAgIH1cbiAgICAgICAgfTtcblxuICAgICAgICBjb25zb2xlLmxvZyhgW0RhdGFQZXJzaXN0ZW5jZVNlcnZpY2VdIEZpbmFsIGpvdXJuZXkgcHJvY2Vzc2luZyBjb21wbGV0ZWQ6YCwge1xuICAgICAgICAgIGpvdXJuZXlJZDogam91cm5leURhdGEuam91cm5leUlkLFxuICAgICAgICAgIGNvcnJlbGF0aW9uSWQsXG4gICAgICAgICAgc3RvcmFnZVN1Y2Nlc3M6ICEhc3RvcmFnZVJlc3VsdCxcbiAgICAgICAgICB0b3RhbFN0ZXBzOiBqb3VybmV5RGF0YS50b3RhbFN0ZXBzLFxuICAgICAgICAgIHByb2Nlc3NpbmdUaW1lXG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJlcy5qc29uKHJlc3BvbnNlKTtcbiAgICAgICAgXG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBjb25zb2xlLmVycm9yKCdbRGF0YVBlcnNpc3RlbmNlU2VydmljZV0gQ3JpdGljYWwgZXJyb3IgaW4gZmluYWwgcHJvY2Vzc2luZzonLCBlcnJvcik7XG4gICAgICAgIFxuICAgICAgICAvLyBFbWVyZ2VuY3kgcmVzcG9uc2UgZm9yIGNyaXRpY2FsIGZhaWx1cmVzXG4gICAgICAgIHJlcy5zdGF0dXMoNTAwKS5qc29uKHtcbiAgICAgICAgICBzdGVwTmFtZTogY3VycmVudFN0ZXBOYW1lLFxuICAgICAgICAgIHNlcnZpY2U6ICdEYXRhUGVyc2lzdGVuY2VTZXJ2aWNlJyxcbiAgICAgICAgICBzdGF0dXM6ICdlcnJvcicsXG4gICAgICAgICAgY29ycmVsYXRpb25JZCxcbiAgICAgICAgICBlcnJvcjogZXJyb3IubWVzc2FnZSxcbiAgICAgICAgICBwcm9jZXNzaW5nVGltZSxcbiAgICAgICAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgICBtZXRhZGF0YToge1xuICAgICAgICAgICAgaXNUZXJtaW5hbFN0ZXA6IHRydWUsXG4gICAgICAgICAgICBjcml0aWNhbEVycm9yOiB0cnVlLFxuICAgICAgICAgICAgZXJyb3JUeXBlOiAnc2VydmljZV9mYWlsdXJlJ1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfTtcblxuICAgIC8vIFNpbXVsYXRlIGRhdGFiYXNlIHByb2Nlc3NpbmcgdGltZVxuICAgIHNldFRpbWVvdXQoZmluaXNoLCBwcm9jZXNzaW5nVGltZSk7XG4gIH0pO1xuXG4gIC8vIEhlYWx0aCBjaGVjayBlbmRwb2ludCB0aGF0IGluY2x1ZGVzIHN0b3JhZ2Ugc3RhdHVzXG4gIGFwcC5nZXQoJy9oZWFsdGgnLCBhc3luYyAocmVxLCByZXMpID0+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc3RvcmFnZUhlYWx0aCA9IHtcbiAgICAgICAgc3RhdHVzOiAnaGVhbHRoeScsXG4gICAgICAgIHR5cGU6ICdpbi1tZW1vcnknLFxuICAgICAgICBqb3VybmV5c1N0b3JlZDogam91cm5leVN0b3JhZ2Uuam91cm5leXMuc2l6ZSxcbiAgICAgICAgc3RlcHNTdG9yZWQ6IGpvdXJuZXlTdG9yYWdlLnN0ZXBzLmxlbmd0aCxcbiAgICAgICAgY29tcGFuaWVzVHJhY2tlZDogam91cm5leVN0b3JhZ2Uuc3RhdHMuY29tcGFuaWVzU3RhdHMuc2l6ZVxuICAgICAgfTtcbiAgICAgIFxuICAgICAgcmVzLmpzb24oe1xuICAgICAgICBzZXJ2aWNlOiAnRGF0YVBlcnNpc3RlbmNlU2VydmljZScsXG4gICAgICAgIHN0YXR1czogJ2hlYWx0aHknLFxuICAgICAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgcGlkOiBwcm9jZXNzLnBpZCxcbiAgICAgICAgc3RvcmFnZTogc3RvcmFnZUhlYWx0aCxcbiAgICAgICAgY2FwYWJpbGl0aWVzOiBbXG4gICAgICAgICAgJ2pvdXJuZXlfc3RvcmFnZScsXG4gICAgICAgICAgJ2luX21lbW9yeV9wZXJzaXN0ZW5jZScsIFxuICAgICAgICAgICdhbmFseXRpY3Nfc3VwcG9ydCcsXG4gICAgICAgICAgJ2R5bmF0cmFjZV90cmFjaW5nJ1xuICAgICAgICBdXG4gICAgICB9KTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgcmVzLnN0YXR1cyg1MDApLmpzb24oe1xuICAgICAgICBzZXJ2aWNlOiAnRGF0YVBlcnNpc3RlbmNlU2VydmljZScsXG4gICAgICAgIHN0YXR1czogJ3VuaGVhbHRoeScsXG4gICAgICAgIGVycm9yOiBlcnJvci5tZXNzYWdlLFxuICAgICAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxuICAgICAgfSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBBbmFseXRpY3MgZW5kcG9pbnQgZm9yIHN0b3JlZCBqb3VybmV5IGRhdGFcbiAgYXBwLmdldCgnL2FuYWx5dGljcy86Y29tcGFueU5hbWUnLCBhc3luYyAocmVxLCByZXMpID0+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgeyBjb21wYW55TmFtZSB9ID0gcmVxLnBhcmFtcztcbiAgICAgIGNvbnN0IHsgdGltZWZyYW1lID0gJzI0aCcgfSA9IHJlcS5xdWVyeTtcbiAgICAgIFxuICAgICAgLy8gQ2FsY3VsYXRlIHRpbWUgcmFuZ2VcbiAgICAgIGNvbnN0IG5vdyA9IG5ldyBEYXRlKCk7XG4gICAgICBjb25zdCB0aW1lUmFuZ2VzID0ge1xuICAgICAgICAnMWgnOiBuZXcgRGF0ZShub3cgLSA2MCAqIDYwICogMTAwMCksXG4gICAgICAgICcyNGgnOiBuZXcgRGF0ZShub3cgLSAyNCAqIDYwICogNjAgKiAxMDAwKSxcbiAgICAgICAgJzdkJzogbmV3IERhdGUobm93IC0gNyAqIDI0ICogNjAgKiA2MCAqIDEwMDApLFxuICAgICAgICAnMzBkJzogbmV3IERhdGUobm93IC0gMzAgKiAyNCAqIDYwICogNjAgKiAxMDAwKVxuICAgICAgfTtcbiAgICAgIFxuICAgICAgY29uc3Qgc3RhcnRUaW1lID0gdGltZVJhbmdlc1t0aW1lZnJhbWVdIHx8IHRpbWVSYW5nZXNbJzI0aCddO1xuICAgICAgXG4gICAgICAvLyBGaWx0ZXIgam91cm5leXMgYnkgY29tcGFueSBhbmQgdGltZWZyYW1lXG4gICAgICBjb25zdCBjb21wYW55Sm91cm5leXMgPSBBcnJheS5mcm9tKGpvdXJuZXlTdG9yYWdlLmpvdXJuZXlzLnZhbHVlcygpKVxuICAgICAgICAuZmlsdGVyKGpvdXJuZXkgPT4gXG4gICAgICAgICAgam91cm5leS5jb21wYW55TmFtZSA9PT0gY29tcGFueU5hbWUgJiYgXG4gICAgICAgICAgbmV3IERhdGUoam91cm5leS50aW1lc3RhbXApID49IHN0YXJ0VGltZVxuICAgICAgICApO1xuICAgICAgXG4gICAgICAvLyBDYWxjdWxhdGUgYW5hbHl0aWNzXG4gICAgICBjb25zdCBhbmFseXRpY3MgPSB7XG4gICAgICAgIGNvbXBhbnlOYW1lLFxuICAgICAgICB0aW1lZnJhbWUsXG4gICAgICAgIHRvdGFsSm91cm5leXM6IGNvbXBhbnlKb3VybmV5cy5sZW5ndGgsXG4gICAgICAgIGF2Z1Byb2Nlc3NpbmdUaW1lOiBjb21wYW55Sm91cm5leXMucmVkdWNlKChzdW0sIGopID0+IHN1bSArIChqLnRvdGFsUHJvY2Vzc2luZ1RpbWUgfHwgMCksIDApIC8gY29tcGFueUpvdXJuZXlzLmxlbmd0aCB8fCAwLFxuICAgICAgICBhdmdTYXRpc2ZhY3Rpb25TY29yZTogY29tcGFueUpvdXJuZXlzLnJlZHVjZSgoc3VtLCBqKSA9PiBzdW0gKyAoai5idXNpbmVzc01ldHJpY3M/LnNhdGlzZmFjdGlvblNjb3JlIHx8IDApLCAwKSAvIGNvbXBhbnlKb3VybmV5cy5sZW5ndGggfHwgMCxcbiAgICAgICAgdG90YWxCdXNpbmVzc1ZhbHVlOiBjb21wYW55Sm91cm5leXMucmVkdWNlKChzdW0sIGopID0+IHN1bSArIChqLmJ1c2luZXNzTWV0cmljcz8uYnVzaW5lc3NWYWx1ZSB8fCAwKSwgMCksXG4gICAgICAgIGNvbXBsZXRpb25SYXRlOiBjb21wYW55Sm91cm5leXMucmVkdWNlKChzdW0sIGopID0+IHN1bSArICgoai5jb21wbGV0ZWRTdGVwcyB8fCAwKSAvIChqLnRvdGFsU3RlcHMgfHwgMSkpLCAwKSAvIGNvbXBhbnlKb3VybmV5cy5sZW5ndGggfHwgMCxcbiAgICAgICAgaW5kdXN0cmllczogWy4uLm5ldyBTZXQoY29tcGFueUpvdXJuZXlzLm1hcChqID0+IGouaW5kdXN0cnlUeXBlKSldXG4gICAgICB9O1xuICAgICAgXG4gICAgICByZXMuanNvbih7XG4gICAgICAgIGNvbXBhbnk6IGNvbXBhbnlOYW1lLFxuICAgICAgICB0aW1lZnJhbWUsXG4gICAgICAgIGFuYWx5dGljcyxcbiAgICAgICAgZ2VuZXJhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgc3RvcmFnZVR5cGU6ICdpbi1tZW1vcnknXG4gICAgICB9KTtcbiAgICAgIFxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICByZXMuc3RhdHVzKDUwMCkuanNvbih7XG4gICAgICAgIGVycm9yOiAnQW5hbHl0aWNzIGdlbmVyYXRpb24gZmFpbGVkJyxcbiAgICAgICAgbWVzc2FnZTogZXJyb3IubWVzc2FnZVxuICAgICAgfSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBKb3VybmV5IHN0YXRzIGVuZHBvaW50XG4gIGFwcC5nZXQoJy9zdGF0cycsIGFzeW5jIChyZXEsIHJlcykgPT4ge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBjb21wYW5pZXNTdGF0cyA9IEFycmF5LmZyb20oam91cm5leVN0b3JhZ2Uuc3RhdHMuY29tcGFuaWVzU3RhdHMuZW50cmllcygpKS5tYXAoKFtjb21wYW55TmFtZSwgc3RhdHNdKSA9PiAoe1xuICAgICAgICBfaWQ6IGNvbXBhbnlOYW1lLFxuICAgICAgICBjb3VudDogc3RhdHMuY291bnQsXG4gICAgICAgIGxhdGVzdEpvdXJuZXk6IHN0YXRzLmxhdGVzdEpvdXJuZXksXG4gICAgICAgIGF2Z0J1c2luZXNzVmFsdWU6IHN0YXRzLmF2Z0J1c2luZXNzVmFsdWUsXG4gICAgICAgIGluZHVzdHJpZXM6IEFycmF5LmZyb20oc3RhdHMuaW5kdXN0cmllcylcbiAgICAgIH0pKS5zb3J0KChhLCBiKSA9PiBiLmNvdW50IC0gYS5jb3VudCk7XG4gICAgICBcbiAgICAgIGNvbnN0IHN0YXRzID0ge1xuICAgICAgICB0b3RhbEpvdXJuZXlzOiBqb3VybmV5U3RvcmFnZS5zdGF0cy50b3RhbEpvdXJuZXlzLFxuICAgICAgICBjb21wYW5pZXNTdGF0c1xuICAgICAgfTtcbiAgICAgIFxuICAgICAgcmVzLmpzb24oe1xuICAgICAgICAuLi5zdGF0cyxcbiAgICAgICAgZ2VuZXJhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgc2VydmljZTogJ0RhdGFQZXJzaXN0ZW5jZVNlcnZpY2UnLFxuICAgICAgICBzdG9yYWdlVHlwZTogJ2luLW1lbW9yeSdcbiAgICAgIH0pO1xuICAgICAgXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIHJlcy5zdGF0dXMoNTAwKS5qc29uKHtcbiAgICAgICAgZXJyb3I6ICdTdGF0cyBnZW5lcmF0aW9uIGZhaWxlZCcsXG4gICAgICAgIG1lc3NhZ2U6IGVycm9yLm1lc3NhZ2VcbiAgICAgIH0pO1xuICAgIH1cbiAgfSk7XG59KTtcblxuY29uc29sZS5sb2coJ1tEYXRhUGVyc2lzdGVuY2VTZXJ2aWNlXSBTZXJ2aWNlIGluaXRpYWxpemVkIHdpdGggaW4tbWVtb3J5IHN0b3JhZ2UnKTsiXSwibWFwcGluZ3MiOiJBQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBIn0=
