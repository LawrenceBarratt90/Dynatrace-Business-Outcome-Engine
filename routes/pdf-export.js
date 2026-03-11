/**
 * PDF Export Routes
 * 
 * Endpoints:
 *   POST /api/pdf/executive-summary  — Generate a one-page executive summary PDF
 *   
 * Accepts journey + dashboard data, returns a downloadable PDF.
 */

import express from 'express';
import { generateExecutiveSummaryPDF } from '../services/pdfGenerator.js';

const router = express.Router();

/**
 * POST /api/pdf/executive-summary
 * 
 * Body: {
 *   journeyData: { companyName, industryType, journeyType, steps: [...] },
 *   dashboardData: { metadata: { totalTiles, detectedFields, ... }, content: { tiles: {...} } }
 * }
 * 
 * Returns: application/pdf binary stream
 */
router.post('/executive-summary', async (req, res) => {
  try {
    const { journeyData, dashboardData } = req.body;

    if (!journeyData || !journeyData.steps || journeyData.steps.length === 0) {
      return res.status(400).json({ error: 'Journey data with steps is required' });
    }

    console.log(`[PDF Export] Generating executive summary for: ${journeyData.companyName || journeyData.company} — ${journeyData.journeyType}`);

    const pdfBuffer = await generateExecutiveSummaryPDF({ journeyData, dashboardData: dashboardData || {} });

    const filename = `${(journeyData.companyName || journeyData.company || 'Customer').replace(/\s+/g, '-')}-BizObs-Summary.pdf`;

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': pdfBuffer.length,
    });

    res.send(pdfBuffer);
    console.log(`[PDF Export] ✅ Generated ${filename} (${(pdfBuffer.length / 1024).toFixed(1)}KB)`);
  } catch (error) {
    console.error('[PDF Export] Generation error:', error);
    res.status(500).json({ error: 'Failed to generate PDF: ' + error.message });
  }
});

/**
 * GET /api/pdf/health
 * Quick health check for the PDF service
 */
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'pdf-export', features: ['executive-summary'] });
});

export default router;
