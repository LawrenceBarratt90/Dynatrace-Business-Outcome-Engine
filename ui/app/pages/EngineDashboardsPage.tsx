import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Flex } from '@dynatrace/strato-components';
import { InfoButton } from '../components/InfoButton';
import {
  TimeseriesChart,
  CategoricalBarChart,
  PieChart,
  DonutChart,
  HoneycombChart,
  MeterBarChart,
  SingleValue,
  GaugeChart,
  convertQueryResultToTimeseries,
} from '@dynatrace/strato-components-preview/charts';
import { useDqlQuery } from '@dynatrace-sdk/react-hooks';
import { loadAppSettings, AppSettings } from '../services/app-settings';
import { functions } from '@dynatrace-sdk/app-utils';
import appConfig from '../../../app.config.json';

const TENANT_BASE = appConfig.environmentUrl.replace(/\/$/, '');

/* ═══════════════════════════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════════════════════════ */

interface TileDefinition {
  id: string;
  title: string;
  vizType: 'timeseries' | 'categoricalBar' | 'pie' | 'donut' | 'honeycomb' | 'meterBar' | 'singleValue' | 'gauge' | 'worldMap' | 'heroMetric' | 'impactCard' | 'table' | 'sectionBanner';
  dql: string;
  width: 1 | 2 | 3;
  icon?: string;
  accent?: string;
  desc?: string;
}

/** A tile candidate declares which fields it needs to be shown */
interface TileCandidate extends TileDefinition {
  requiresNumeric?: string[];      // additionalfields.* that must have non-zero numeric values
  requiresCategorical?: string[];  // additionalfields.* that must be non-empty strings
}

/** Discovered field profile for the selected company/journey */
interface FieldProfile {
  numericFields: Set<string>;      // additionalfields.* with non-zero numeric values
  categoricalFields: Set<string>;  // additionalfields.* with non-empty string values
  allFieldNames: string[];         // all field keys found
}

type DashboardPreset = 'developer' | 'operations' | 'executive' | 'intelligence' | 'genai' | 'security' | 'sre' | 'logs' | 'vcarb';

type Timeframe = 'now()-30m' | 'now()-1h' | 'now()-2h' | 'now()-6h' | 'now()-12h' | 'now()-24h' | 'now()-3d' | 'now()-7d';

const TIMEFRAME_OPTIONS: { value: Timeframe; label: string }[] = [
  { value: 'now()-30m', label: '30 min' },
  { value: 'now()-1h', label: '1 hour' },
  { value: 'now()-2h', label: '2 hours' },
  { value: 'now()-6h', label: '6 hours' },
  { value: 'now()-12h', label: '12 hours' },
  { value: 'now()-24h', label: '24 hours' },
  { value: 'now()-3d', label: '3 days' },
  { value: 'now()-7d', label: '7 days' },
];

const PRESET_META: Record<DashboardPreset, { label: string; icon: string; color: string; desc: string }> = {
  developer:    { label: 'Developer',              icon: '🔧', color: '#e67e22', desc: 'Services · Requests · Errors · Latency · Traces · Logs · Endpoints' },
  operations:   { label: 'Operations',             icon: '⚙️', color: '#3498db', desc: 'CPU · Memory · Hosts · Processes · Network · Availability · Saturation' },
  executive:    { label: 'Executive',              icon: '👔', color: '#a78bfa', desc: 'Revenue · Customers · Orders · Trends · Impact' },
  intelligence: { label: 'Dynatrace Intelligence', icon: '🧠', color: '#e74c3c', desc: 'Problems · Root Cause · Anomalies · Impact · Resolution' },
  genai:        { label: 'GenAI Observability',    icon: '🤖', color: '#10b981', desc: 'LLM Calls · Tokens · Latency · Models · Embeddings · Errors' },
  security:     { label: 'Security',               icon: '🔒', color: '#f59e0b', desc: 'Security Events · Attacks · Categories · Trends · Affected Entities' },
  sre:          { label: 'SRE / Reliability',      icon: '📋', color: '#06b6d4', desc: 'Availability · Error Budget · SLOs · Percentiles · Deployments' },
  logs:         { label: 'Biz Events',             icon: '📝', color: '#8b5cf6', desc: 'Event Volume · Types · Errors · Journeys · Services · Companies' },
  vcarb:        { label: 'VCARB Race Ops',         icon: '🏎️', color: '#e10600', desc: 'Lap Times · Tyres · ERS · Pit Stops · Positions · Telemetry · Weather' },
};

/** Rich marketing overview for each dashboard — shown at the top of each preset */
const PRESET_OVERVIEW: Record<DashboardPreset, { headline: string; bullets: string[]; poweredBy: string }> = {
  developer: {
    headline: 'Full-stack service visibility powered by Dynatrace Grail — every request, every trace, every error in one view.',
    bullets: [
      'Real-time RED metrics (Rate, Errors, Duration) across all services using DPS-powered distributed tracing',
      'Latency percentiles (p50/p90/p99) surfaced from Grail to pinpoint performance degradation instantly',
      'Live exception traces and error logs correlated by Dynatrace Intelligence for faster root cause analysis',
      'Endpoint-level breakdown with direct deep links into Dynatrace Services & Distributed Traces',
    ],
    poweredBy: 'Dynatrace SmartScape, Distributed Traces, Grail DQL, PurePath',
  },
  operations: {
    headline: 'Infrastructure health at a glance — hosts, processes, network and resource saturation driven by Dynatrace OneAgent.',
    bullets: [
      'Host and process-level CPU, memory, and disk metrics collected automatically by OneAgent and stored in Grail',
      'Network traffic monitoring (in/out) with GC suspension and thread saturation for capacity planning',
      'Service availability calculations built from real request & failure counts — not synthetic checks',
      'Error log correlation across host → process → service powered by Dynatrace unified observability',
    ],
    poweredBy: 'OneAgent, Smartscape Topology, Grail Metrics, Log Analytics',
  },
  executive: {
    headline: 'Business impact intelligence for leadership — revenue, customers, orders, and IT risk quantified in real-time.',
    bullets: [
      'Revenue and order volume trends built from business events flowing through Grail in real-time',
      'Journey funnel analysis showing step-by-step conversion and drop-off rates across customer paths',
      'IT impact on business: Davis-detected problems mapped to estimated revenue at risk and affected customers',
      'SLA compliance tracking with processing time thresholds — correlating technical SLAs to business outcomes',
    ],
    poweredBy: 'Grail Biz Events, Davis Problems, DPS Business Analytics',
  },
  intelligence: {
    headline: 'Davis AI-powered problem detection and root cause analysis — automatic anomaly correlation across your full stack.',
    bullets: [
      'Active problem tracking with automatic root cause identification by Dynatrace Davis AI engine',
      'Problem categorization and affected service mapping using Smartscape topology dependencies',
      'Business impact quantification — errors mapped to revenue at risk and affected customer count',
      'Davis event timeline combining anomaly detection, problem correlation, and deployment tracking',
    ],
    poweredBy: 'Davis AI, Smartscape Topology, Grail Problem Store, Anomaly Detection',
  },
  genai: {
    headline: 'End-to-end LLM observability — monitor every AI call, token, and model response across your GenAI stack.',
    bullets: [
      'Total LLM call volume, latency, and error tracking surfaced from OpenTelemetry gen_ai spans in Grail',
      'Token usage analytics (input/output) broken down by model and operation for cost optimization',
      'Model performance comparison with latency percentiles and per-operation breakdowns',
      'Full call detail table with deep links to Dynatrace Distributed Traces for each LLM interaction',
    ],
    poweredBy: 'OpenTelemetry GenAI Spans, Grail, Distributed Tracing, DPS',
  },
  security: {
    headline: 'Security posture monitoring — track security events, attack patterns, and affected entities in real-time.',
    bullets: [
      'Security event volume and category tracking powered by Dynatrace Runtime Application Protection',
      'Attack event detection and classification with trend analysis over configurable time windows',
      'Affected entity mapping connecting security events to specific services and infrastructure components',
      'Full event detail table with status tracking for security incident response workflows',
    ],
    poweredBy: 'Runtime Application Protection, Grail Security Events, Davis AI',
  },
  sre: {
    headline: 'Site reliability engineering metrics — availability, error budgets, latency percentiles, and HTTP status tracking.',
    bullets: [
      'Global availability percentage computed from real request success/failure ratios across all services',
      'Latency percentile tracking (p50/p90/p99) at both global and per-service granularity from Grail',
      'Service reliability ranking by error rate — identify the weakest links in your architecture instantly',
      'HTTP status code breakdown (2xx/4xx/5xx) with active Davis problem correlation for incident context',
    ],
    poweredBy: 'Grail Metrics, Davis Problems, DPS Service Analytics',
  },
  logs: {
    headline: 'Business event analytics — complete visibility into event flow across journeys, services, and companies.',
    bullets: [
      'Total event volume and error rate tracking from business events stored in Dynatrace Grail',
      'Event type distribution and service-level breakdown for journey flow analysis',
      'Error event correlation by service, journey, and company — pinpoint where business processes fail',
      'Full event detail table with step-level granularity for end-to-end journey troubleshooting',
    ],
    poweredBy: 'Grail Biz Events, DQL Analytics, DPS Event Processing',
  },
  vcarb: {
    headline: 'Visa Cash App Racing Bulls F1 race operations — real-time telemetry, tyre strategy, pit stops, and race positions.',
    bullets: [
      'Live lap times, sector splits, and top speed tracking across all race weekend sessions for both drivers',
      'Tyre management analytics: surface temps, pressures, and wear across all four corners with compound tracking',
      'ERS energy flow, engine RPM, fuel burn rate, and power unit health monitoring in real-time',
      'Pit stop execution analysis, position tracking, gap management, and overtake success rate for race strategy',
    ],
    poweredBy: 'Grail Biz Events, Race Telemetry Pipeline, DQL Analytics',
  },
};

/* ═══════════════════════════════════════════════════════════════
   PROXY DQL HELPER
   ═══════════════════════════════════════════════════════════════ */

async function proxyDql(query: string, maxRecords = 100): Promise<{ success: boolean; records?: any[]; error?: string }> {
  try {
    const res = await functions.call('proxy-api', {
      data: { action: 'execute-dql', body: { query, timeoutMs: 30000, maxRecords } },
    });
    return (await res.json()) as any;
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/* ═══════════════════════════════════════════════════════════════
   FIELD DISCOVERY — fetches sample records, classifies fields
   ═══════════════════════════════════════════════════════════════ */

function useFieldDiscovery(companyName: string, journeyType: string): { profile: FieldProfile | null; discovering: boolean } {
  const [profile, setProfile] = useState<FieldProfile | null>(null);
  const [discovering, setDiscovering] = useState(false);

  useEffect(() => {
    setDiscovering(true);
    setProfile(null);

    let base = 'fetch bizevents';
    if (companyName) base += `\n| filter matchesPhrase(json.companyName, "${companyName}")`;
    if (journeyType) base += `\n| filter matchesPhrase(json.journeyType, "${journeyType}")`;
    base += '\n| limit 5';

    proxyDql(base, 5).then((result) => {
      if (result.success && result.records?.length) {
        const numericFields = new Set<string>();
        const categoricalFields = new Set<string>();
        const allFieldNames: string[] = [];

        // Inspect all records to build field profile
        for (const record of result.records) {
          for (const [key, value] of Object.entries(record)) {
            if (!key.startsWith('additionalfields.')) continue;
            const fieldName = key.replace('additionalfields.', '');

            if (value === null || value === undefined || value === '') continue;
            const strVal = String(value);
            if (strVal === '' || strVal === 'null') continue;

            const parsed = parseFloat(strVal);
            if (!isNaN(parsed) && parsed !== 0) {
              numericFields.add(fieldName);
            } else if (isNaN(parsed) && strVal.length > 0) {
              categoricalFields.add(fieldName);
            }
            // Note: fields with value "0" are skipped — they exist but have no useful data
          }
        }

        // Collect all unique keys from first record
        if (result.records[0]) {
          allFieldNames.push(...Object.keys(result.records[0]));
        }

        setProfile({ numericFields, categoricalFields, allFieldNames });
      }
      setDiscovering(false);
    });
  }, [companyName, journeyType]);

  return { profile, discovering };
}

/* ═══════════════════════════════════════════════════════════════
   TILE CANDIDATE CATALOG — each tile declares its field requirements
   Tiles with no requirements are always shown (core json.* tiles).
   Tiles with requirements are only shown when the fields have data.
   ═══════════════════════════════════════════════════════════════ */

function buildBase(companyName: string, journeyType: string, timeframe: Timeframe, serviceName?: string, eventType?: string): string {
  let q = `fetch bizevents, from:${timeframe}`;
  if (companyName) q += `\n| filter matchesPhrase(json.companyName, "${companyName}")`;
  if (journeyType) q += `\n| filter matchesPhrase(json.journeyType, "${journeyType}")`;
  if (serviceName) q += `\n| filter matchesPhrase(json.serviceName, "${serviceName}")`;
  if (eventType) q += `\n| filter matchesPhrase(event.type, "${eventType}")`;
  return q;
}

/* ═══════════════════════════════════════════════════════════════
   INDUSTRY VOCABULARY — maps detected industry to domain terms
   Enables the Executive preset to speak each industry's language.
   ═══════════════════════════════════════════════════════════════ */

type IndustryGroup = 'retail' | 'healthcare' | 'banking' | 'insurance' | 'telecom' | 'travel' | 'gaming' | 'government' | 'education' | 'automotive' | 'manufacturing' | 'logistics' | 'energy' | 'realestate' | 'foodservice' | 'media' | 'generic';

interface IndustryVocab {
  transaction: string; transactions: string; revenue: string;
  customer: string; customers: string;
  avgValueLabel: string; faultLabel: string; leakageSection: string;
  recentLabel: string; abandonLabel: string; abandonDesc: string;
  abandonStartSteps: string[]; abandonEndSteps: string[];
  failedLabel: string; failedDesc: string; failedSteps: string[];
  leakageLabel: string; faultTrendLabel: string;
  icons: { tx: string; cust: string; abandon: string };
}

const INDUSTRY_VOCABULARY: Record<IndustryGroup, IndustryVocab> = {
  retail: {
    transaction: 'Order', transactions: 'Orders', revenue: 'Revenue',
    customer: 'Customer', customers: 'Customers',
    avgValueLabel: 'Avg Order Value', faultLabel: 'Order Fault Rate',
    leakageSection: 'ORDER HEALTH & REVENUE LEAKAGE',
    recentLabel: 'Most Recent Orders',
    abandonLabel: 'Cart Abandonment Rate', abandonDesc: 'Of customers who started a cart, how many never completed checkout — the top source of revenue leakage in retail.',
    abandonStartSteps: ['cart', 'Cart', 'basket', 'Basket', 'add to cart'],
    abandonEndSteps: ['confirm', 'Confirm', 'complete', 'Complete', 'success', 'Success', 'purchase', 'Purchase'],
    failedLabel: 'Failed Checkouts', failedDesc: 'Orders that reached checkout but errored — revenue that was almost captured but lost to IT issues.',
    failedSteps: ['checkout', 'Checkout', 'payment', 'Payment'],
    leakageLabel: 'Revenue Leakage by Step', faultTrendLabel: 'Order Faults Over Time',
    icons: { tx: '🛒', cust: '👥', abandon: '🛒' },
  },
  healthcare: {
    transaction: 'Encounter', transactions: 'Encounters', revenue: 'Billable Value',
    customer: 'Patient', customers: 'Patients',
    avgValueLabel: 'Avg Encounter Value', faultLabel: 'Encounter Fault Rate',
    leakageSection: 'ENCOUNTER HEALTH & VALUE LEAKAGE',
    recentLabel: 'Most Recent Encounters',
    abandonLabel: 'No-Show Rate', abandonDesc: 'Of patients who scheduled an appointment, how many never completed their visit — impacts care delivery and facility utilisation.',
    abandonStartSteps: ['schedule', 'Schedule', 'appointment', 'Appointment', 'referral', 'Referral', 'register', 'Register', 'triage', 'Triage'],
    abandonEndSteps: ['discharge', 'Discharge', 'complete', 'Complete', 'follow-up', 'Follow-up', 'billing', 'Billing', 'checkout', 'Checkout'],
    failedLabel: 'Failed Referrals', failedDesc: 'Encounters that reached processing but errored — care that was almost delivered but lost to system issues.',
    failedSteps: ['referral', 'Referral', 'admission', 'Admission', 'consult', 'Consult', 'procedure', 'Procedure'],
    leakageLabel: 'Value Leakage by Step', faultTrendLabel: 'Encounter Faults Over Time',
    icons: { tx: '🏥', cust: '🧑‍⚕️', abandon: '📋' },
  },
  banking: {
    transaction: 'Transaction', transactions: 'Transactions', revenue: 'Revenue',
    customer: 'Account Holder', customers: 'Account Holders',
    avgValueLabel: 'Avg Transaction Value', faultLabel: 'Transaction Fault Rate',
    leakageSection: 'TRANSACTION HEALTH & REVENUE LEAKAGE',
    recentLabel: 'Most Recent Transactions',
    abandonLabel: 'Application Drop-off Rate', abandonDesc: 'Of customers who started an application, how many never completed — lost revenue from incomplete onboarding.',
    abandonStartSteps: ['application', 'Application', 'apply', 'Apply', 'inquiry', 'Inquiry', 'open account', 'Open Account'],
    abandonEndSteps: ['approval', 'Approval', 'approved', 'Approved', 'complete', 'Complete', 'funded', 'Funded', 'activated', 'Activated'],
    failedLabel: 'Failed Transfers', failedDesc: 'Transactions that reached processing but errored — funds that were almost transferred but lost to system failures.',
    failedSteps: ['transfer', 'Transfer', 'payment', 'Payment', 'settlement', 'Settlement', 'disbursement', 'Disbursement'],
    leakageLabel: 'Revenue Leakage by Step', faultTrendLabel: 'Transaction Faults Over Time',
    icons: { tx: '🏦', cust: '👤', abandon: '📝' },
  },
  insurance: {
    transaction: 'Policy', transactions: 'Policies', revenue: 'Premium Value',
    customer: 'Policyholder', customers: 'Policyholders',
    avgValueLabel: 'Avg Policy Premium', faultLabel: 'Policy Fault Rate',
    leakageSection: 'POLICY HEALTH & PREMIUM LEAKAGE',
    recentLabel: 'Most Recent Policies',
    abandonLabel: 'Quote Abandonment Rate', abandonDesc: 'Of prospects who requested a quote, how many never bound a policy — lost premium revenue from the sales funnel.',
    abandonStartSteps: ['quote', 'Quote', 'inquiry', 'Inquiry', 'application', 'Application', 'proposal', 'Proposal'],
    abandonEndSteps: ['bind', 'Bind', 'issue', 'Issue', 'activate', 'Activate', 'complete', 'Complete', 'policy issued', 'Policy Issued'],
    failedLabel: 'Failed Claims', failedDesc: 'Claims that reached processing but errored — policyholder satisfaction and regulatory risk.',
    failedSteps: ['claim', 'Claim', 'adjudication', 'Adjudication', 'payment', 'Payment', 'settlement', 'Settlement'],
    leakageLabel: 'Premium Leakage by Step', faultTrendLabel: 'Policy Faults Over Time',
    icons: { tx: '📑', cust: '🛡️', abandon: '📋' },
  },
  telecom: {
    transaction: 'Subscription', transactions: 'Subscriptions', revenue: 'Revenue',
    customer: 'Subscriber', customers: 'Subscribers',
    avgValueLabel: 'Avg Subscription Value', faultLabel: 'Subscription Fault Rate',
    leakageSection: 'SUBSCRIPTION HEALTH & REVENUE LEAKAGE',
    recentLabel: 'Most Recent Subscriptions',
    abandonLabel: 'Plan Abandonment Rate', abandonDesc: 'Of subscribers who started plan selection, how many never activated — lost recurring revenue from incomplete sign-ups.',
    abandonStartSteps: ['plan', 'Plan', 'select', 'Select', 'configure', 'Configure', 'browse plans', 'Browse Plans'],
    abandonEndSteps: ['activate', 'Activate', 'provision', 'Provision', 'complete', 'Complete', 'confirm', 'Confirm'],
    failedLabel: 'Failed Activations', failedDesc: 'Subscriptions that reached activation but errored — subscribers left without service due to IT issues.',
    failedSteps: ['activation', 'Activation', 'provision', 'Provision', 'porting', 'Porting', 'setup', 'Setup'],
    leakageLabel: 'Revenue Leakage by Step', faultTrendLabel: 'Subscription Faults Over Time',
    icons: { tx: '📱', cust: '📡', abandon: '📶' },
  },
  travel: {
    transaction: 'Booking', transactions: 'Bookings', revenue: 'Revenue',
    customer: 'Traveller', customers: 'Travellers',
    avgValueLabel: 'Avg Booking Value', faultLabel: 'Booking Fault Rate',
    leakageSection: 'BOOKING HEALTH & REVENUE LEAKAGE',
    recentLabel: 'Most Recent Bookings',
    abandonLabel: 'Booking Abandonment Rate', abandonDesc: 'Of travellers who started a booking, how many never confirmed — lost revenue from incomplete reservations.',
    abandonStartSteps: ['search', 'Search', 'select', 'Select', 'itinerary', 'Itinerary', 'flight', 'Flight', 'room', 'Room'],
    abandonEndSteps: ['confirm', 'Confirm', 'book', 'Book', 'complete', 'Complete', 'ticketed', 'Ticketed', 'reserved', 'Reserved'],
    failedLabel: 'Failed Reservations', failedDesc: 'Bookings that reached confirmation but errored — travellers left without confirmed reservations.',
    failedSteps: ['reservation', 'Reservation', 'booking', 'Booking', 'payment', 'Payment', 'ticketing', 'Ticketing'],
    leakageLabel: 'Revenue Leakage by Step', faultTrendLabel: 'Booking Faults Over Time',
    icons: { tx: '✈️', cust: '🧳', abandon: '🗓️' },
  },
  gaming: {
    transaction: 'Session', transactions: 'Sessions', revenue: 'Revenue',
    customer: 'Player', customers: 'Players',
    avgValueLabel: 'Avg Session Value', faultLabel: 'Session Fault Rate',
    leakageSection: 'SESSION HEALTH & REVENUE LEAKAGE',
    recentLabel: 'Most Recent Sessions',
    abandonLabel: 'Session Drop-off Rate', abandonDesc: 'Of players who started a session, how many dropped before completing key actions — lost engagement and monetisation.',
    abandonStartSteps: ['login', 'Login', 'launch', 'Launch', 'lobby', 'Lobby', 'deposit', 'Deposit', 'wager', 'Wager'],
    abandonEndSteps: ['cashout', 'Cashout', 'complete', 'Complete', 'payout', 'Payout', 'withdraw', 'Withdraw', 'settle', 'Settle'],
    failedLabel: 'Failed Transactions', failedDesc: 'In-game transactions that errored — players left unable to deposit, wager, or withdraw.',
    failedSteps: ['deposit', 'Deposit', 'wager', 'Wager', 'withdrawal', 'Withdrawal', 'payment', 'Payment'],
    leakageLabel: 'Revenue Leakage by Step', faultTrendLabel: 'Session Faults Over Time',
    icons: { tx: '🎮', cust: '🕹️', abandon: '🎰' },
  },
  government: {
    transaction: 'Application', transactions: 'Applications', revenue: 'Processing Value',
    customer: 'Citizen', customers: 'Citizens',
    avgValueLabel: 'Avg Processing Value', faultLabel: 'Application Fault Rate',
    leakageSection: 'APPLICATION HEALTH & PROCESSING LEAKAGE',
    recentLabel: 'Most Recent Applications',
    abandonLabel: 'Application Abandonment Rate', abandonDesc: 'Of citizens who started an application, how many never submitted — impacts service delivery and public trust.',
    abandonStartSteps: ['start', 'Start', 'begin', 'Begin', 'form', 'Form', 'application', 'Application', 'register', 'Register'],
    abandonEndSteps: ['submit', 'Submit', 'complete', 'Complete', 'approve', 'Approve', 'issue', 'Issue', 'certified', 'Certified'],
    failedLabel: 'Failed Submissions', failedDesc: 'Applications that reached submission but errored — citizens forced to retry or visit in person.',
    failedSteps: ['submit', 'Submit', 'review', 'Review', 'verify', 'Verify', 'process', 'Process'],
    leakageLabel: 'Value Leakage by Step', faultTrendLabel: 'Application Faults Over Time',
    icons: { tx: '🏛️', cust: '🧑‍💼', abandon: '📄' },
  },
  education: {
    transaction: 'Enrolment', transactions: 'Enrolments', revenue: 'Tuition Revenue',
    customer: 'Student', customers: 'Students',
    avgValueLabel: 'Avg Tuition Value', faultLabel: 'Enrolment Fault Rate',
    leakageSection: 'ENROLMENT HEALTH & TUITION LEAKAGE',
    recentLabel: 'Most Recent Enrolments',
    abandonLabel: 'Enrolment Drop-off Rate', abandonDesc: 'Of students who started enrolment, how many never completed — lost tuition revenue and student engagement.',
    abandonStartSteps: ['apply', 'Apply', 'application', 'Application', 'register', 'Register', 'enrol', 'Enrol', 'course select', 'Course Select'],
    abandonEndSteps: ['confirm', 'Confirm', 'enrol', 'Enrol', 'complete', 'Complete', 'pay tuition', 'Pay Tuition', 'registered', 'Registered'],
    failedLabel: 'Failed Registrations', failedDesc: 'Enrolments that reached processing but errored — students left unable to complete registration.',
    failedSteps: ['registration', 'Registration', 'payment', 'Payment', 'verification', 'Verification', 'enrolment', 'Enrolment'],
    leakageLabel: 'Tuition Leakage by Step', faultTrendLabel: 'Enrolment Faults Over Time',
    icons: { tx: '🎓', cust: '📚', abandon: '📝' },
  },
  automotive: {
    transaction: 'Deal', transactions: 'Deals', revenue: 'Revenue',
    customer: 'Buyer', customers: 'Buyers',
    avgValueLabel: 'Avg Deal Value', faultLabel: 'Deal Fault Rate',
    leakageSection: 'DEAL HEALTH & REVENUE LEAKAGE',
    recentLabel: 'Most Recent Deals',
    abandonLabel: 'Lead Drop-off Rate', abandonDesc: 'Of leads who started an inquiry, how many never completed a deal — lost sales revenue from the pipeline.',
    abandonStartSteps: ['inquiry', 'Inquiry', 'test drive', 'Test Drive', 'configure', 'Configure', 'quote', 'Quote', 'browse', 'Browse'],
    abandonEndSteps: ['purchase', 'Purchase', 'finance', 'Finance', 'complete', 'Complete', 'delivery', 'Delivery', 'contract', 'Contract'],
    failedLabel: 'Failed Finance Applications', failedDesc: 'Deals that reached finance/contract but errored — buyers left without completed purchases.',
    failedSteps: ['finance', 'Finance', 'contract', 'Contract', 'payment', 'Payment', 'lease', 'Lease'],
    leakageLabel: 'Revenue Leakage by Step', faultTrendLabel: 'Deal Faults Over Time',
    icons: { tx: '🚗', cust: '🔑', abandon: '🏷️' },
  },
  manufacturing: {
    transaction: 'Work Order', transactions: 'Work Orders', revenue: 'Production Value',
    customer: 'Client', customers: 'Clients',
    avgValueLabel: 'Avg Work Order Value', faultLabel: 'Work Order Fault Rate',
    leakageSection: 'WORK ORDER HEALTH & PRODUCTION LEAKAGE',
    recentLabel: 'Most Recent Work Orders',
    abandonLabel: 'Order Cancellation Rate', abandonDesc: 'Of work orders initiated, how many were cancelled before completion — lost production value from incomplete jobs.',
    abandonStartSteps: ['order', 'Order', 'requisition', 'Requisition', 'plan', 'Plan', 'schedule', 'Schedule'],
    abandonEndSteps: ['ship', 'Ship', 'complete', 'Complete', 'deliver', 'Deliver', 'quality check', 'Quality Check', 'dispatch', 'Dispatch'],
    failedLabel: 'Failed Production Steps', failedDesc: 'Work orders that encountered errors during production — impacting delivery timelines and client satisfaction.',
    failedSteps: ['assembly', 'Assembly', 'quality', 'Quality', 'packaging', 'Packaging', 'inspection', 'Inspection'],
    leakageLabel: 'Production Leakage by Step', faultTrendLabel: 'Work Order Faults Over Time',
    icons: { tx: '🏭', cust: '🔧', abandon: '📦' },
  },
  logistics: {
    transaction: 'Shipment', transactions: 'Shipments', revenue: 'Freight Revenue',
    customer: 'Shipper', customers: 'Shippers',
    avgValueLabel: 'Avg Shipment Value', faultLabel: 'Shipment Fault Rate',
    leakageSection: 'SHIPMENT HEALTH & REVENUE LEAKAGE',
    recentLabel: 'Most Recent Shipments',
    abandonLabel: 'Shipment Cancellation Rate', abandonDesc: 'Of shipments booked, how many were cancelled before delivery — lost freight revenue and capacity waste.',
    abandonStartSteps: ['book', 'Book', 'pickup', 'Pickup', 'dispatch', 'Dispatch', 'order', 'Order', 'schedule', 'Schedule'],
    abandonEndSteps: ['deliver', 'Deliver', 'complete', 'Complete', 'signed', 'Signed', 'received', 'Received'],
    failedLabel: 'Failed Deliveries', failedDesc: 'Shipments that encountered errors in transit — impacting delivery SLAs and shipper satisfaction.',
    failedSteps: ['transit', 'Transit', 'customs', 'Customs', 'delivery', 'Delivery', 'last mile', 'Last Mile'],
    leakageLabel: 'Revenue Leakage by Step', faultTrendLabel: 'Shipment Faults Over Time',
    icons: { tx: '🚛', cust: '📦', abandon: '🗺️' },
  },
  energy: {
    transaction: 'Service Request', transactions: 'Service Requests', revenue: 'Billing Revenue',
    customer: 'Account Holder', customers: 'Account Holders',
    avgValueLabel: 'Avg Billing Value', faultLabel: 'Service Request Fault Rate',
    leakageSection: 'SERVICE HEALTH & BILLING LEAKAGE',
    recentLabel: 'Most Recent Service Requests',
    abandonLabel: 'Application Drop-off Rate', abandonDesc: 'Of customers who started a service application, how many never completed — lost billing revenue from incomplete activations.',
    abandonStartSteps: ['apply', 'Apply', 'request', 'Request', 'signup', 'Signup', 'transfer', 'Transfer', 'meter', 'Meter'],
    abandonEndSteps: ['activate', 'Activate', 'connect', 'Connect', 'complete', 'Complete', 'provision', 'Provision'],
    failedLabel: 'Failed Activations', failedDesc: 'Service requests that reached activation but errored — customers left without service.',
    failedSteps: ['activation', 'Activation', 'connection', 'Connection', 'metering', 'Metering', 'billing', 'Billing'],
    leakageLabel: 'Billing Leakage by Step', faultTrendLabel: 'Service Request Faults Over Time',
    icons: { tx: '⚡', cust: '🏠', abandon: '🔌' },
  },
  realestate: {
    transaction: 'Listing', transactions: 'Listings', revenue: 'Transaction Value',
    customer: 'Buyer', customers: 'Buyers',
    avgValueLabel: 'Avg Listing Value', faultLabel: 'Listing Fault Rate',
    leakageSection: 'LISTING HEALTH & VALUE LEAKAGE',
    recentLabel: 'Most Recent Listings',
    abandonLabel: 'Lead Drop-off Rate', abandonDesc: 'Of leads who started property inquiries, how many never progressed to offer — lost commission revenue from the pipeline.',
    abandonStartSteps: ['inquiry', 'Inquiry', 'viewing', 'Viewing', 'tour', 'Tour', 'search', 'Search', 'register', 'Register'],
    abandonEndSteps: ['offer', 'Offer', 'contract', 'Contract', 'closing', 'Closing', 'complete', 'Complete', 'settle', 'Settle'],
    failedLabel: 'Failed Closings', failedDesc: 'Listings that reached closing but errored — deals lost at the final stage of the transaction.',
    failedSteps: ['closing', 'Closing', 'contract', 'Contract', 'escrow', 'Escrow', 'settlement', 'Settlement'],
    leakageLabel: 'Value Leakage by Step', faultTrendLabel: 'Listing Faults Over Time',
    icons: { tx: '🏠', cust: '🔑', abandon: '🏢' },
  },
  foodservice: {
    transaction: 'Order', transactions: 'Orders', revenue: 'Revenue',
    customer: 'Guest', customers: 'Guests',
    avgValueLabel: 'Avg Order Value', faultLabel: 'Order Fault Rate',
    leakageSection: 'ORDER HEALTH & REVENUE LEAKAGE',
    recentLabel: 'Most Recent Orders',
    abandonLabel: 'Order Abandonment Rate', abandonDesc: 'Of guests who started an order, how many never completed — lost revenue from incomplete transactions.',
    abandonStartSteps: ['menu', 'Menu', 'browse', 'Browse', 'add item', 'Add Item', 'cart', 'Cart', 'customise', 'Customise'],
    abandonEndSteps: ['confirm', 'Confirm', 'place order', 'Place Order', 'complete', 'Complete', 'payment', 'Payment', 'pickup', 'Pickup'],
    failedLabel: 'Failed Orders', failedDesc: 'Orders that reached payment but errored — guests left unable to complete their food order.',
    failedSteps: ['payment', 'Payment', 'checkout', 'Checkout', 'processing', 'Processing', 'fulfilment', 'Fulfilment'],
    leakageLabel: 'Revenue Leakage by Step', faultTrendLabel: 'Order Faults Over Time',
    icons: { tx: '🍔', cust: '🍽️', abandon: '📋' },
  },
  media: {
    transaction: 'Subscription', transactions: 'Subscriptions', revenue: 'Revenue',
    customer: 'Subscriber', customers: 'Subscribers',
    avgValueLabel: 'Avg Subscription Value', faultLabel: 'Subscription Fault Rate',
    leakageSection: 'SUBSCRIPTION HEALTH & REVENUE LEAKAGE',
    recentLabel: 'Most Recent Subscriptions',
    abandonLabel: 'Signup Drop-off Rate', abandonDesc: 'Of users who started signup, how many never activated — lost recurring revenue from incomplete onboarding.',
    abandonStartSteps: ['signup', 'Signup', 'register', 'Register', 'trial', 'Trial', 'browse', 'Browse', 'plan select', 'Plan Select'],
    abandonEndSteps: ['activate', 'Activate', 'subscribe', 'Subscribe', 'complete', 'Complete', 'confirm', 'Confirm', 'payment', 'Payment'],
    failedLabel: 'Failed Activations', failedDesc: 'Subscriptions that reached activation but errored — users left without access to content.',
    failedSteps: ['activation', 'Activation', 'payment', 'Payment', 'provision', 'Provision', 'billing', 'Billing'],
    leakageLabel: 'Revenue Leakage by Step', faultTrendLabel: 'Subscription Faults Over Time',
    icons: { tx: '📺', cust: '🎬', abandon: '📡' },
  },
  generic: {
    transaction: 'Transaction', transactions: 'Transactions', revenue: 'Revenue',
    customer: 'Customer', customers: 'Customers',
    avgValueLabel: 'Avg Transaction Value', faultLabel: 'Transaction Fault Rate',
    leakageSection: 'TRANSACTION HEALTH & REVENUE LEAKAGE',
    recentLabel: 'Most Recent Transactions',
    abandonLabel: 'Process Abandonment Rate', abandonDesc: 'Of customers who started a process, how many never completed — revenue lost from incomplete journeys.',
    abandonStartSteps: ['start', 'Start', 'begin', 'Begin', 'initiate', 'Initiate', 'cart', 'Cart', 'apply', 'Apply'],
    abandonEndSteps: ['confirm', 'Confirm', 'complete', 'Complete', 'success', 'Success', 'finish', 'Finish', 'done', 'Done'],
    failedLabel: 'Failed Completions', failedDesc: 'Transactions that reached a critical step but errored — value lost to system issues.',
    failedSteps: ['checkout', 'Checkout', 'payment', 'Payment', 'process', 'Process', 'submit', 'Submit'],
    leakageLabel: 'Revenue Leakage by Step', faultTrendLabel: 'Transaction Faults Over Time',
    icons: { tx: '📊', cust: '👥', abandon: '📉' },
  },
};

/** Detect industry group from journey type and company name keywords */
function detectIndustry(journeyType: string, companyName: string): IndustryGroup {
  const combined = `${journeyType} ${companyName}`.toLowerCase();
  if (/patient|clinic|hospital|healthcare|health care|medical|pharma|encounter|prescription|diagnosis|referral|ehr|hipaa|dental|veterinar|care access|care pathway/.test(combined)) return 'healthcare';
  if (/insurance|policy|claim|premium|underwriting|actuari|reinsur|annuit|insurtech/.test(combined)) return 'insurance';
  if (/bank|loan|mortgage|deposit|atm|branch|account open|kyc|wealth|portfolio|trading|fintech|payment gateway|merchant|lending|credit union|neobank/.test(combined)) return 'banking';
  if (/telecom|mobile operator|isp|broadband|5g|fibre|wireless|cellul|subscriber|porting/.test(combined)) return 'telecom';
  if (/airline|flight|hotel|cruise|travel|booking|reservation|hospitality|resort|car rental|tourism/.test(combined)) return 'travel';
  if (/gaming|casino|igaming|esport|wager|betting|slot|poker|player|gambl/.test(combined)) return 'gaming';
  if (/government|public sector|citizen|municipal|federal|council|permit|licens|defense|civic/.test(combined)) return 'government';
  if (/universit|college|school|education|student|enrol|tuition|edtech|k-12|campus|academic|course/.test(combined)) return 'education';
  if (/automotive|dealership|vehicle|car purchase|test drive|ev charging|motor/.test(combined)) return 'automotive';
  if (/manufactur|industrial|factory|assembly|production|plant|raw material/.test(combined)) return 'manufacturing';
  if (/logistic|freight|shipping|cargo|warehouse|last mile|courier|trucking|fleet|delivery service|3pl/.test(combined)) return 'logistics';
  if (/energy|utilit|oil|gas|renewable|solar|wind|grid|power|electricity|meter/.test(combined)) return 'energy';
  if (/real estate|property|proptech|listing|mortgage broker|closing|escrow|tenant|landlord/.test(combined)) return 'realestate';
  if (/restaurant|food delivery|qsr|catering|fast food|dine|takeaway|meal|kitchen|food order/.test(combined)) return 'foodservice';
  if (/media|streaming|broadcast|publish|content|entertainment|news|podcast|music|video|ott/.test(combined)) return 'media';
  if (/retail|e-?commerce|shop|fashion|beauty|grocer|luxury|marketplace|purchase|cart|checkout|order/.test(combined)) return 'retail';
  return 'generic';
}

function getVocab(journeyType: string, companyName: string): IndustryVocab {
  return INDUSTRY_VOCABULARY[detectIndustry(journeyType, companyName)];
}

/** Build matchesPhrase DQL clause for an array of step name patterns */
function buildStepMatch(steps: string[]): string {
  return steps.map(s => `matchesPhrase(toString(json.stepName), "${s}")`).join(' or ');
}

/** Executive tiles with industry-aware vocabulary */
function getExecutiveTiles(b: string, timeframe: Timeframe, journeyType: string, companyName: string): TileCandidate[] {
  const v = getVocab(journeyType, companyName);

  return [
    // ══════ KEY BUSINESS METRICS ══════
    { id: 'ex-kpi-banner', title: 'KEY BUSINESS METRICS', vizType: 'sectionBanner', width: 3, icon: '📊', accent: '#a78bfa', dql: '' },
    { id: 'ex-revenue', title: `Total ${v.revenue}`, vizType: 'heroMetric', width: 1, icon: '💰', accent: '#00d4aa', desc: `Aggregate ${v.revenue.toLowerCase()} captured across all business events — compare against targets to gauge performance.`,
      dql: `${b}\n| summarize totalRevenue = round(sum(toDouble(additionalfields.transactionValue)), decimals:0)` },
    { id: 'ex-orders', title: `Total ${v.transactions}`, vizType: 'heroMetric', width: 1, icon: v.icons.tx, accent: '#3498db', desc: `Total ${v.transaction.toLowerCase()} volume for the period — track against historical averages to spot trends.`,
      dql: `${b}\n| summarize totalOrders = count()` },
    { id: 'ex-customers', title: `Unique ${v.customers}`, vizType: 'heroMetric', width: 1, icon: v.icons.cust, accent: '#a78bfa', desc: `Distinct ${v.customer.toLowerCase()} identifiers in the period — a proxy for reach and engagement breadth.`,
      dql: `${b}\n| summarize customers = countDistinct(json.customerId)` },
    { id: 'ex-avg-order', title: v.avgValueLabel, vizType: 'heroMetric', width: 1, icon: '💵', accent: '#1abc9c', desc: `Average value per ${v.transaction.toLowerCase()} — rising values signal effective upselling or premium mix shifts.`,
      dql: `${b}\n| summarize avgOrder = round(avg(toDouble(additionalfields.transactionValue)), decimals:2)`,
      requiresNumeric: ['transactionValue'] },
    { id: 'ex-error-rate', title: 'Error Rate %', vizType: 'heroMetric', width: 1, icon: '⚠️', accent: '#e74c3c', desc: `Percentage of business events flagged as errors — directly correlates with ${v.revenue.toLowerCase()} leakage and ${v.customer.toLowerCase()} churn.`,
      dql: `${b}\n| summarize total = count(), errors = countIf(json.hasError == true)\n| fieldsAdd rate = round(100.0 * toDouble(errors) / toDouble(total), decimals:1)` },
    { id: 'ex-services', title: 'Active Services', vizType: 'heroMetric', width: 1, icon: '🔧', accent: '#e67e22', desc: `Count of distinct services processing business events — shows the operational surface area supporting ${v.revenue.toLowerCase()}.`,
      dql: `${b}\n| summarize services = countDistinct(json.serviceName)` },

    // ══════ HEALTH & LEAKAGE ══════
    { id: 'ex-leakage-banner', title: v.leakageSection, vizType: 'sectionBanner', width: 3, icon: '🚨', accent: '#ae132d', dql: '' },
    { id: 'ex-order-fault-rate', title: `${v.faultLabel} %`, vizType: 'heroMetric', width: 1, icon: '💔', accent: '#e74c3c', desc: `Percentage of ${v.transactions.toLowerCase()} that faulted — a key quality metric; every fault risks losing a ${v.customer.toLowerCase()}.`,
      dql: `${b}\n| summarize totalOrders = count(), faultedOrders = countIf(json.hasError == true)\n| fieldsAdd faultRate = round(100.0 * toDouble(faultedOrders) / toDouble(totalOrders), decimals:2)` },
    { id: 'ex-abandonment', title: `${v.abandonLabel} %`, vizType: 'heroMetric', width: 1, icon: v.icons.abandon, accent: '#d56b1a', desc: v.abandonDesc,
      dql: `${b}\n| summarize starts = countIf(${buildStepMatch(v.abandonStartSteps)}), completions = countIf(${buildStepMatch(v.abandonEndSteps)})\n| fieldsAdd abandonmentRate = if(starts > 0, round(100.0 * (1.0 - toDouble(completions) / toDouble(starts)), decimals:1), else: 0.0)` },
    { id: 'ex-failed', title: v.failedLabel, vizType: 'heroMetric', width: 1, icon: '❌', accent: '#ae132d', desc: v.failedDesc,
      dql: `${b}\n| filter json.hasError == true\n| filter ${buildStepMatch(v.failedSteps)}\n| summarize failed = count()` },
    { id: 'ex-leakage-by-step', title: v.leakageLabel, vizType: 'categoricalBar', width: 2, icon: '💸', accent: '#ae132d', desc: `Where in the journey are errors causing ${v.revenue.toLowerCase()} loss — pinpoint the exact step where value leaks out.`,
      dql: `${b}\n| filter json.hasError == true\n| summarize lostRevenue = round(sum(toDouble(additionalfields.transactionValue)), decimals:0), faults = count(), by:{json.stepName}\n| sort lostRevenue desc\n| limit 15` },
    { id: 'ex-fault-trend', title: v.faultTrendLabel, vizType: 'timeseries', width: 1, icon: '📈', accent: '#e74c3c', desc: `${v.transaction} fault volume trend — compare with baselines to determine if current fault rates are normal.`,
      dql: `${b}\n| makeTimeseries faults = countIf(json.hasError == true)` },

    // ══════ REVENUE & VOLUME TRENDS ══════
    { id: 'ex-trends-banner', title: `${v.revenue.toUpperCase()} & VOLUME TRENDS`, vizType: 'sectionBanner', width: 3, icon: '📈', accent: '#00d4aa', dql: '' },
    { id: 'ex-revenue-ts', title: `${v.revenue} Over Time`, vizType: 'timeseries', width: 2, icon: '📈', accent: '#00d4aa', desc: `${v.revenue} trend line — compare against seasonal averages to spot anomalies.`,
      dql: `${b}\n| makeTimeseries revenue = sum(toDouble(additionalfields.transactionValue))` },
    { id: 'ex-impact', title: `${v.revenue} at Risk`, vizType: 'impactCard', width: 1, icon: '🔥', accent: '#e74c3c', desc: `Estimated monetary impact of errored ${v.transactions.toLowerCase()} — quantifies how much ${v.revenue.toLowerCase()} IT issues are putting at risk.`,
      dql: `${b}\n| summarize errors = countIf(json.hasError == true), totalTxns = count(), avgValue = avg(toDouble(additionalfields.transactionValue))\n| fieldsAdd estimatedImpact = round(toDouble(errors) * avgValue, decimals:0), errorRate = round(100.0 * toDouble(errors) / toDouble(totalTxns), decimals:1)` },
    { id: 'ex-volume-ts', title: `${v.transaction} Volume Over Time`, vizType: 'timeseries', width: 1, icon: '📊', accent: '#3498db', desc: `${v.transaction} count over time — overlay with campaign dates to measure impact.`,
      dql: `${b}\n| makeTimeseries orders = count()` },
    { id: 'ex-customers-ts', title: `Unique ${v.customers} Over Time`, vizType: 'timeseries', width: 1, icon: v.icons.cust, accent: '#a78bfa', desc: `${v.customer} reach trend — dips may indicate accessibility issues; growth shows effectiveness.`,
      dql: `${b}\n| makeTimeseries customers = countDistinct(json.customerId)` },
    { id: 'ex-rev-by-svc-ts', title: `${v.revenue} by Service Over Time`, vizType: 'timeseries', width: 1, icon: '💰', accent: '#1abc9c', desc: `${v.revenue} attribution per service — identify which backend services drive the most business value.`,
      dql: `${b}\n| makeTimeseries revenue = sum(toDouble(additionalfields.transactionValue)), by:{json.serviceName}` },

    // ══════ JOURNEY FLOW ══════
    { id: 'ex-journey-banner', title: 'JOURNEY FLOW', vizType: 'sectionBanner', width: 3, icon: '🔻', accent: '#a78bfa', dql: '' },
    { id: 'ex-funnel', title: 'Journey Steps Funnel', vizType: 'categoricalBar', width: 2, icon: '🔻', accent: '#a78bfa', desc: `Visualises the ${v.customer.toLowerCase()} journey funnel — each bar is a stage; steep drops reveal where ${v.customers.toLowerCase()} abandon.`,
      dql: `${b}\n| summarize count = count(), by:{json.stepName, json.stepIndex}\n| sort toDouble(json.stepIndex) asc\n| limit 20` },
    { id: 'ex-step-conversion', title: 'Drop-off by Step', vizType: 'categoricalBar', width: 1, icon: '📉', accent: '#e74c3c', desc: `Error-driven drop-off rate per journey step — high drop-off at critical steps means direct ${v.revenue.toLowerCase()} leakage.`,
      dql: `${b}\n| summarize total = count(), errors = countIf(json.hasError == true), by:{json.stepName, json.stepIndex}\n| fieldsAdd dropRate = round(100.0 * toDouble(errors) / toDouble(total), decimals:1)\n| sort toDouble(json.stepIndex) asc\n| limit 20` },
    { id: 'ex-step-revenue', title: `${v.revenue} by Journey Step`, vizType: 'categoricalBar', width: 2, icon: '💰', accent: '#00d4aa', desc: `${v.revenue} attributed to each journey step — shows where business value accumulates across the ${v.customer.toLowerCase()} flow.`,
      dql: `${b}\n| summarize revenue = sum(toDouble(additionalfields.transactionValue)), count = count(), by:{json.stepName, json.stepIndex}\n| sort toDouble(json.stepIndex) asc\n| limit 20` },
    { id: 'ex-step-time', title: 'Avg Processing Time by Step', vizType: 'categoricalBar', width: 1, icon: '⏱️', accent: '#f39c12', desc: `Average processing latency at each journey step — slow steps reduce conversion and increase abandonment.`,
      dql: `${b}\n| summarize avgTime = round(avg(toDouble(additionalfields.processingTime)), decimals:0), by:{json.stepName, json.stepIndex}\n| sort toDouble(json.stepIndex) asc\n| limit 20`,
      requiresNumeric: ['processingTime'] },

    // ══════ REVENUE BREAKDOWN ══════
    { id: 'ex-bd-banner', title: `${v.revenue.toUpperCase()} BREAKDOWN`, vizType: 'sectionBanner', width: 3, icon: '💰', accent: '#1abc9c', dql: '' },
    { id: 'ex-rev-journey', title: `${v.revenue} by Journey Type`, vizType: 'categoricalBar', width: 2, icon: '📊', accent: '#1abc9c', desc: `${v.revenue} split across journey types — shows which ${v.customer.toLowerCase()} paths generate the most value.`,
      dql: `${b}\n| summarize revenue = sum(toDouble(additionalfields.transactionValue)), by:{json.journeyType}\n| sort revenue desc\n| limit 15` },
    { id: 'ex-events-journey', title: 'Events by Journey', vizType: 'donut', width: 1, icon: '🎯', desc: 'Proportional event distribution by journey type — understand the traffic mix driving your business.',
      dql: `${b}\n| summarize count = count(), by:{json.journeyType}\n| sort count desc\n| limit 10` },
    { id: 'ex-rev-service', title: `${v.revenue} by Service`, vizType: 'categoricalBar', width: 2, icon: '🔧', accent: '#1abc9c', desc: `${v.revenue} attributed to each backend service — helps prioritise SLA investments on the highest-value services.`,
      dql: `${b}\n| summarize revenue = sum(toDouble(additionalfields.transactionValue)), by:{json.serviceName}\n| sort revenue desc\n| limit 15` },
    { id: 'ex-events-type', title: 'Events by Type', vizType: 'donut', width: 1, icon: '🏷️', desc: 'Breakdown of event types — reveals the composition of your digital activity.',
      dql: `${b}\n| summarize count = count(), by:{event.type}\n| sort count desc\n| limit 10` },

    // ══════ SLA & PERFORMANCE ══════
    { id: 'ex-sla-banner', title: 'SLA & PERFORMANCE', vizType: 'sectionBanner', width: 3, icon: '⏱️', accent: '#f39c12', dql: '' },
    { id: 'ex-sla-met', title: 'SLA Met vs Not Met', vizType: 'timeseries', width: 2, icon: '✅', accent: '#27ae60', desc: `SLA compliance trend (5s threshold) — of all ${v.transactions.toLowerCase()}, how many were processed within SLA?`,
      dql: `${b}\n| fieldsAdd sla = if(toDouble(additionalfields.processingTime) > 5000, "Not Met", else: "Met")\n| makeTimeseries met = countIf(sla == "Met"), notMet = countIf(sla == "Not Met")`,
      requiresNumeric: ['processingTime'] },
    { id: 'ex-sla-pct', title: 'SLA Compliance %', vizType: 'heroMetric', width: 1, icon: '📋', accent: '#27ae60', desc: `Overall SLA compliance percentage — of total ${v.transactions.toLowerCase()}, what % completed inside the SLA threshold.`,
      dql: `${b}\n| fieldsAdd sla = if(toDouble(additionalfields.processingTime) > 5000, "Not Met", else: "Met")\n| summarize slaPercentage = round(100.0 * toDouble(countIf(sla == "Met")) / toDouble(count()), decimals:1)`,
      requiresNumeric: ['processingTime'] },
    { id: 'ex-latency-by-svc', title: 'Avg Latency by Service', vizType: 'categoricalBar', width: 2, icon: '⏱️', accent: '#f39c12', desc: 'Per-service average processing latency — services with high latency drag down the overall SLA compliance rate.',
      dql: `${b}\n| summarize avgLatency = round(avg(toDouble(additionalfields.processingTime)), decimals:0), by:{json.serviceName}\n| sort avgLatency desc\n| limit 15`,
      requiresNumeric: ['processingTime'] },
    { id: 'ex-latency-ts', title: 'Avg Processing Time', vizType: 'timeseries', width: 1, icon: '📈', accent: '#f39c12', desc: 'Processing time trend — a rising baseline indicates infrastructure degradation or growing data volumes.',
      dql: `${b}\n| makeTimeseries avgLatency = avg(toDouble(additionalfields.processingTime))`,
      requiresNumeric: ['processingTime'] },

    // ══════ IT IMPACT ON BUSINESS ══════
    { id: 'ex-it-banner', title: 'IT IMPACT ON BUSINESS', vizType: 'sectionBanner', width: 3, icon: '🛠️', accent: '#e74c3c', dql: '' },
    { id: 'ex-it-problems', title: 'Open IT Problems', vizType: 'heroMetric', width: 1, icon: '🔴', accent: '#e74c3c', desc: `Active Dynatrace Intelligence problems — open problems directly correlate with ${v.transaction.toLowerCase()} faults and SLA breaches.`,
      dql: `fetch dt.davis.problems, from:${timeframe}\n| filter dt.davis.is_duplicate == false\n| filter event.status == "ACTIVE"\n| summarize openProblems = count()` },
    { id: 'ex-it-loss', title: 'Est. Loss from Errors', vizType: 'heroMetric', width: 1, icon: '💸', accent: '#ae132d', desc: `${v.revenue} directly lost to errored ${v.transactions.toLowerCase()} — the business cost of IT issues.`,
      dql: `${b}\n| filter json.hasError == true\n| summarize lostRevenue = round(sum(toDouble(additionalfields.transactionValue)), decimals:0)` },
    { id: 'ex-it-affected', title: `Affected ${v.customers}`, vizType: 'heroMetric', width: 1, icon: v.icons.cust, accent: '#d56b1a', desc: `Unique ${v.customers.toLowerCase()} impacted by errors — ${v.customer.toLowerCase()}-level blast radius of IT faults.`,
      dql: `${b}\n| filter json.hasError == true\n| summarize affectedCustomers = countDistinct(json.customerId)` },
    { id: 'ex-problems-ts', title: 'Problems Over Time', vizType: 'timeseries', width: 2, icon: '📈', accent: '#e74c3c', desc: `Dynatrace Intelligence problem creation rate — correlate with ${v.revenue.toLowerCase()} dips to measure business impact.`,
      dql: `fetch dt.davis.problems, from:${timeframe}\n| filter dt.davis.is_duplicate == false\n| makeTimeseries count = count()` },
    { id: 'ex-errors-ts', title: 'Business Errors Over Time', vizType: 'timeseries', width: 1, icon: '📈', accent: '#ae132d', desc: `Business event errors over time — each spike represents potential ${v.transaction.toLowerCase()} faults and ${v.revenue.toLowerCase()} leakage.`,
      dql: `${b}\n| makeTimeseries errors = countIf(json.hasError == true)` },

    // ══════ TOP CUSTOMERS & RECENT ACTIVITY ══════
    { id: 'ex-activity-banner', title: `TOP ${v.customers.toUpperCase()} & RECENT ACTIVITY`, vizType: 'sectionBanner', width: 3, icon: '👤', accent: '#3498db', dql: '' },
    { id: 'ex-top-customers', title: `Top ${v.customers} by ${v.revenue}`, vizType: 'categoricalBar', width: 2, icon: '👤', accent: '#3498db', desc: `Highest-value ${v.customers.toLowerCase()} ranked by spend — protect these VIPs from error-impacted experiences first.`,
      dql: `${b}\n| summarize revenue = round(sum(toDouble(additionalfields.transactionValue)), decimals:2), orders = count(), by:{json.customerId}\n| sort revenue desc\n| limit 15` },
    { id: 'ex-customer-dist', title: `${v.customer} Activity Distribution`, vizType: 'honeycomb', width: 1, icon: '🔥', desc: `Heatmap of ${v.customer.toLowerCase()} activity volume — larger cells indicate power users or high-frequency ${v.customers.toLowerCase()}.`,
      dql: `${b}\n| summarize count = count(), by:{json.customerId}\n| sort count desc\n| limit 30` },
    { id: 'ex-recent-orders', title: v.recentLabel, vizType: 'table', width: 3, icon: '📋', accent: '#3498db', desc: `Live feed of the latest ${v.transactions.toLowerCase()} with ${v.customer.toLowerCase()}, journey, service, and error status — real-time operational awareness.`,
      dql: `${b}\n| fields Time = timestamp, Customer = json.customerId, Journey = json.journeyType, Step = json.stepName, Service = json.serviceName, Value = additionalfields.transactionValue, EventType = event.type, HasError = json.hasError\n| sort Time desc\n| limit 50` },

    // ══════ SERVICE PERFORMANCE ══════
    { id: 'ex-svc-banner', title: 'SERVICE PERFORMANCE', vizType: 'sectionBanner', width: 3, icon: '🔧', accent: '#e67e22', dql: '' },
    { id: 'ex-svc-table', title: 'Service Business Performance', vizType: 'table', width: 3, icon: '📋', accent: '#e67e22', desc: `Full service scorecard — ${v.revenue.toLowerCase()}, volume, errors, failure rate, and ${v.customer.toLowerCase()} reach per service.`,
      dql: `${b}\n| summarize EventCount = count(), Errors = countIf(json.hasError == true), Revenue = round(sum(toDouble(additionalfields.transactionValue)), decimals:2), AvgValue = round(avg(toDouble(additionalfields.transactionValue)), decimals:2), Customers = countDistinct(json.customerId), by:{json.serviceName}\n| fieldsAdd FailRate = round(100.0 * toDouble(Errors) / toDouble(EventCount), decimals:2)\n| fieldsAdd Service = concat("[", json.serviceName, "](${TENANT_BASE}/ui/apps/dynatrace.services)")\n| fields Service, Revenue, EventCount, Errors, FailRate, AvgValue, Customers\n| sort Revenue desc\n| limit 25` },
    { id: 'ex-svc-errors', title: 'Error Rate by Service', vizType: 'categoricalBar', width: 2, icon: '⚠️', accent: '#e74c3c', desc: `Per-service error rate ranking — services at the top are the biggest contributors to ${v.transaction.toLowerCase()} faults.`,
      dql: `${b}\n| summarize total = count(), errors = countIf(json.hasError == true), by:{json.serviceName}\n| fieldsAdd errorRate = round(100.0 * toDouble(errors) / toDouble(total), decimals:1)\n| sort errorRate desc\n| limit 15` },
    { id: 'ex-heatmap', title: 'Event Activity Heatmap', vizType: 'honeycomb', width: 1, icon: '🔥', desc: 'Event type distribution heatmap — see the relative weight of different event types at a glance.',
      dql: `${b}\n| summarize count = count(), by:{event.type}\n| sort count desc\n| limit 20` },
  ];
}

function getCandidates(companyName: string, journeyType: string, preset: DashboardPreset, timeframe: Timeframe, serviceName?: string, eventType?: string, companyServices?: string[]): TileCandidate[] {
  const b = buildBase(companyName, journeyType, timeframe, serviceName, eventType);

  // Service filter helpers for metric/timeseries queries — all values lowercased to match lower(entityName(...))
  // When a specific service is picked, filter to it; otherwise if a company is selected, filter to its services
  const svcInList = !serviceName && companyServices?.length
    ? companyServices.map(s => `"${s.toLowerCase()}"`).join(', ') : '';
  const svcF = serviceName ? `\n| filter contains(service, "${serviceName.toLowerCase()}")`
    : svcInList ? `\n| filter in(service, ${svcInList})` : '';
  const svcFSN = serviceName ? `\n| filter contains(ServiceName, "${serviceName.toLowerCase()}")`
    : svcInList ? `\n| filter in(ServiceName, ${svcInList})` : '';

  switch (preset) {

    /* ══════════════════════════════════════════════════════════════
       DEVELOPER — Services · RED · Traffic · Latency · Errors ·
                   Traces · Logs · Endpoints
       ══════════════════════════════════════════════════════════════ */
    case 'developer': return [
      // ── SERVICE OVERVIEW ──
      { id: 'dev-overview-banner', title: 'SERVICE OVERVIEW', vizType: 'sectionBanner', width: 3, icon: '📊', accent: '#e67e22', dql: '' },
      { id: 'dev-total-req', title: 'Total Requests', vizType: 'heroMetric', width: 1, icon: '📈', accent: '#e67e22', desc: 'Aggregate request count across all monitored services — the primary throughput indicator for your application stack.',
        dql: `timeseries requests = sum(dt.service.request.count), by:{dt.entity.service}, from:${timeframe}\n| fieldsAdd service = lower(entityName(dt.entity.service))${svcF}\n| fieldsAdd reqTotal = arraySum(requests)\n| summarize totalRequests = sum(reqTotal)` },
      { id: 'dev-error-rate', title: 'Error Rate %', vizType: 'heroMetric', width: 1, icon: '⚠️', accent: '#e74c3c', desc: 'Percentage of failed requests vs total — a spike here signals degraded user experience requiring immediate attention.',
        dql: `timeseries requests = sum(dt.service.request.count), errors = sum(dt.service.request.failure_count), by:{dt.entity.service}, from:${timeframe}\n| fieldsAdd service = lower(entityName(dt.entity.service))${svcF}\n| fieldsAdd r = arraySum(requests), e = arraySum(errors)\n| summarize totalR = sum(r), totalE = sum(e)\n| fieldsAdd errorRate = round(100.0 * totalE / totalR, decimals:2)` },
      { id: 'dev-active-svc', title: 'Active Services', vizType: 'heroMetric', width: 1, icon: '🔧', accent: '#3498db', desc: 'Count of services actively processing requests — tracks the breadth of your running microservice topology.',
        dql: `timeseries requests = sum(dt.service.request.count), by:{dt.entity.service}, from:${timeframe}\n| fieldsAdd service = lower(entityName(dt.entity.service))${svcF}\n| summarize activeServices = count()` },

      // ── SERVICE HEALTH: RED TABLE ──
      { id: 'dev-health-banner', title: 'SERVICE HEALTH: Full RED Metrics', vizType: 'sectionBanner', width: 3, icon: '🔍', accent: '#3498db', dql: '' },
      { id: 'dev-red-table', title: 'Service Health (RED Metrics)', vizType: 'table', width: 3, icon: '🏥', accent: '#e67e22', desc: 'Complete Rate-Errors-Duration table per service — the golden signals of microservice health with deep links into Dynatrace.',
        dql: `timeseries {latency_p50 = median(dt.service.request.response_time), latency_p90 = percentile(dt.service.request.response_time, 90), latency_p99 = percentile(dt.service.request.response_time, 99), requests = sum(dt.service.request.count), errors = sum(dt.service.request.failure_count)}, by:{dt.entity.service}, from:${timeframe}\n| lookup [timeseries http_5xx = sum(dt.service.request.count, default:0.0), by:{dt.entity.service}, from:${timeframe}, filter: http.response.status_code >= 500 and http.response.status_code <= 599], sourceField:dt.entity.service, lookupField:dt.entity.service, prefix:"http5xx."\n| lookup [timeseries http_4xx = sum(dt.service.request.count, default:0.0), by:{dt.entity.service}, from:${timeframe}, filter: http.response.status_code >= 400 and http.response.status_code <= 499], sourceField:dt.entity.service, lookupField:dt.entity.service, prefix:"http4xx."\n| fieldsAdd Latency_p50 = arrayAvg(latency_p50), Latency_p90 = arrayAvg(latency_p90), Latency_p99 = arrayAvg(latency_p99), Requests = arraySum(requests), Errors = arraySum(errors), Http5xx = arraySum(http5xx.http_5xx), Http4xx = arraySum(http4xx.http_4xx)\n| fieldsAdd FailureRate = round((Errors/Requests) * 100, decimals:2)\n| fieldsAdd ServiceName = lower(entityName(dt.entity.service))${svcFSN}\n| fieldsAdd Service = concat("[", ServiceName, "](${TENANT_BASE}/ui/apps/dynatrace.services/explorer?detailsId=", dt.entity.service, ")")\n| fields Service, Requests, FailureRate, Errors, Http5xx, Http4xx, Latency_p50, Latency_p90, Latency_p99\n| sort FailureRate desc\n| limit 25` },

      // ── TRAFFIC ──
      { id: 'dev-traffic-banner', title: 'TRAFFIC', vizType: 'sectionBanner', width: 3, icon: '📊', accent: '#438fb1', dql: '' },
      { id: 'dev-req-by-svc', title: 'Requests by Service', vizType: 'timeseries', width: 1, icon: '📈', accent: '#438fb1', desc: 'Request volume trend per service over time — identify traffic patterns, peak loads, and load distribution.',
        dql: `timeseries requests = sum(dt.service.request.count), by:{dt.entity.service}, from:${timeframe}\n| fieldsAdd service = lower(entityName(dt.entity.service))${svcF}\n| fields timeframe, interval, service, requests\n| sort arraySum(requests) desc\n| limit 15` },
      { id: 'dev-success-fail', title: 'Success vs Failed', vizType: 'timeseries', width: 1, icon: '📊', accent: '#0D9C29', desc: 'Success vs failure request comparison — quickly spot when failure rates begin to diverge from the healthy baseline.',
        dql: `timeseries total = sum(dt.service.request.count, default:0), failed = sum(dt.service.request.failure_count, default:0), from:${timeframe}\n| fieldsAdd success = total[] - failed[]\n| fields timeframe, interval, success, failed` },
      { id: 'dev-endpoints', title: 'Key Endpoints', vizType: 'timeseries', width: 1, icon: '🔗', accent: '#438fb1', desc: 'Traffic distribution across key API endpoints — identify the most critical paths in your application.',
        dql: `timeseries requests = sum(dt.service.request.count), by:{endpoint.name}, from:${timeframe}, filter: endpoint.name != "NON_KEY_REQUESTS"\n| fields timeframe, interval, endpoint.name, requests\n| sort arraySum(requests) desc\n| limit 15` },
      { id: 'dev-req-dist', title: 'Request Distribution by Service', vizType: 'categoricalBar', width: 3, icon: '📊', accent: '#438fb1', desc: 'Bar chart of request volume per service — see which services carry the most load at a glance.',
        dql: `timeseries requests = sum(dt.service.request.count), by:{dt.entity.service}, from:${timeframe}\n| fieldsAdd service = lower(entityName(dt.entity.service))${svcF}\n| fieldsAdd totalReq = arraySum(requests)\n| fields service, totalReq\n| sort totalReq desc\n| limit 20` },

      // ── LATENCY ──
      { id: 'dev-lat-banner', title: 'LATENCY', vizType: 'sectionBanner', width: 3, icon: '⏱️', accent: '#f1c40f', dql: '' },
      { id: 'dev-p50', title: 'Latency p50', vizType: 'timeseries', width: 1, icon: '⏱️', accent: '#f1c40f', desc: 'Median response time per service — represents the experience of the typical user. DPS-powered.',
        dql: `timeseries latency_p50 = median(dt.service.request.response_time), by:{dt.entity.service}, from:${timeframe}\n| fieldsAdd service = lower(entityName(dt.entity.service))${svcF}\n| fields timeframe, interval, service, latency_p50\n| sort arrayAvg(latency_p50) desc\n| limit 15` },
      { id: 'dev-p90', title: 'Latency p90', vizType: 'timeseries', width: 1, icon: '⏱️', accent: '#eca440', desc: '90th percentile response time — 10% of users experience latency at or above this level.',
        dql: `timeseries latency_p90 = percentile(dt.service.request.response_time, 90), by:{dt.entity.service}, from:${timeframe}\n| fieldsAdd service = lower(entityName(dt.entity.service))${svcF}\n| fields timeframe, interval, service, latency_p90\n| sort arrayAvg(latency_p90) desc\n| limit 15` },
      { id: 'dev-p99', title: 'Latency p99', vizType: 'timeseries', width: 1, icon: '⏱️', accent: '#c4233b', desc: '99th percentile response time — tail latency that reveals worst-case performance outliers.',
        dql: `timeseries latency_p99 = percentile(dt.service.request.response_time, 99), by:{dt.entity.service}, from:${timeframe}\n| fieldsAdd service = lower(entityName(dt.entity.service))${svcF}\n| fields timeframe, interval, service, latency_p99\n| sort arrayAvg(latency_p99) desc\n| limit 15` },

      // ── ERRORS ──
      { id: 'dev-err-banner', title: 'ERRORS', vizType: 'sectionBanner', width: 3, icon: '❌', accent: '#e74c3c', dql: '' },
      { id: 'dev-failed', title: 'Failed Requests', vizType: 'timeseries', width: 1, icon: '❌', accent: '#e74c3c', desc: 'Failed request volume by service over time — helps identify error spikes and correlate with deployments.',
        dql: `timeseries errors = sum(dt.service.request.failure_count, default:0), nonempty:true, by:{dt.entity.service}, from:${timeframe}\n| fieldsAdd service = lower(entityName(dt.entity.service))${svcF}\n| fields timeframe, interval, service, errors\n| sort arraySum(errors) desc\n| limit 15` },
      { id: 'dev-5xx', title: '5xx Server Errors', vizType: 'timeseries', width: 1, icon: '🔴', accent: '#ae132d', desc: 'Server-side 5xx errors indicate backend failures — often the first sign of infrastructure or code issues.',
        dql: `timeseries errors = sum(dt.service.request.count, default:0), nonempty:true, by:{dt.entity.service}, from:${timeframe}, filter: http.response.status_code >= 500 and http.response.status_code <= 599\n| fieldsAdd service = lower(entityName(dt.entity.service))${svcF}\n| fields timeframe, interval, service, errors\n| sort arraySum(errors) desc\n| limit 15` },
      { id: 'dev-4xx', title: '4xx Client Errors', vizType: 'timeseries', width: 1, icon: '🟠', accent: '#d56b1a', desc: 'Client-side 4xx errors may signal broken links, changed APIs, or misconfigured clients.',
        dql: `timeseries errors = sum(dt.service.request.count, default:0), nonempty:true, by:{dt.entity.service}, from:${timeframe}, filter: http.response.status_code >= 400 and http.response.status_code <= 499\n| fieldsAdd service = lower(entityName(dt.entity.service))${svcF}\n| fields timeframe, interval, service, errors\n| sort arraySum(errors) desc\n| limit 15` },

      // ── TRACES & EXCEPTIONS ──
      { id: 'dev-traces-banner', title: 'TRACES & EXCEPTIONS', vizType: 'sectionBanner', width: 3, icon: '📡', accent: '#d56b1a', dql: '' },
      { id: 'dev-traces', title: 'Exception Traces', vizType: 'table', width: 3, icon: '📡', accent: '#d56b1a', desc: 'Live exception traces with service, endpoint, and exception class — deep links into Dynatrace Distributed Tracing.',
        dql: `fetch spans, from:${timeframe}\n| fieldsAdd exceptionType = span.events[0][exception.type]\n| fieldsAdd eventname = span.events[0][span_event.name]\n| filter eventname == "exception"\n| filter isNotNull(span.exit_by_exception_id)\n| fieldsAdd ServiceName = lower(entityName(dt.entity.service))${svcFSN}\n| fieldsAdd ExceptionMessage = toString(span.events[][exception.message])\n| fieldsAdd Service = concat("[", ServiceName, "](${TENANT_BASE}/ui/apps/dynatrace.services/explorer?detailsId=", dt.entity.service, ")")\n| fieldsAdd Endpoint = concat("[", endpoint.name, "](${TENANT_BASE}/ui/apps/dynatrace.distributedtracing/explorer?filter=dt.entity.service+%3D+", dt.entity.service, "&traceId=", trace_id, "&spanId=", span_id, ")")\n| fields Time = start_time, Service, Endpoint, ExceptionClass = exceptionType, ExceptionMessage, Duration = duration\n| sort Time desc\n| limit 100` },
      { id: 'dev-exception-types', title: 'Top Exception Types', vizType: 'categoricalBar', width: 3, icon: '🐛', accent: '#d56b1a', desc: 'Most frequently thrown exception classes — prioritize fixes by impact frequency.',
        dql: `fetch spans, from:${timeframe}\n| fieldsAdd exceptionType = span.events[0][exception.type]\n| fieldsAdd eventname = span.events[0][span_event.name]\n| filter eventname == "exception"\n| fieldsAdd ServiceName = lower(entityName(dt.entity.service))${svcFSN}\n| summarize count = count(), by:{exceptionType}\n| sort count desc\n| limit 15` },

      // ── LOGS ──
      { id: 'dev-logs-banner', title: 'LOGS', vizType: 'sectionBanner', width: 3, icon: '📋', accent: '#cd3741', dql: '' },
      { id: 'dev-logs', title: 'Error & Warning Logs', vizType: 'table', width: 3, icon: '📋', accent: '#cd3741', desc: 'Recent ERROR and WARN log entries with trace correlation — jump straight from a log line to the full distributed trace.',
        dql: `fetch logs, from:${timeframe}\n| filter in(status, "WARN", "ERROR")\n| filter isNotNull(trace_id)\n| fieldsAdd Process = lower(entityName(dt.entity.process_group_instance))\n| fieldsAdd TraceLink = concat("[", trace_id, "](${TENANT_BASE}/ui/apps/dynatrace.distributedtracing/explorer?traceId=", trace_id, ")")\n| fields Time = timestamp, Status = status, Process, Content = content, TraceId = TraceLink\n| sort Time desc\n| limit 100` },
      { id: 'dev-log-volume', title: 'Log Volume by Severity', vizType: 'timeseries', width: 2, icon: '📊', accent: '#cd3741', desc: 'Log ingestion rate broken down by severity level — detect abnormal spikes in error or warning logs.',
        dql: `fetch logs, from:${timeframe}\n| makeTimeseries count = count(), by:{status}` },
      { id: 'dev-log-dist', title: 'Log Distribution', vizType: 'donut', width: 1, icon: '📊', accent: '#cd3741', desc: 'Proportional split of log severities — a healthy system should be overwhelmingly INFO.',
        dql: `fetch logs, from:${timeframe}\n| summarize count = count(), by:{status}\n| sort count desc` },

      // ── SLOWEST ENDPOINTS ──
      { id: 'dev-slow-banner', title: 'SLOWEST ENDPOINTS', vizType: 'sectionBanner', width: 3, icon: '🐌', accent: '#27ae60', dql: '' },
      { id: 'dev-slow-table', title: 'Slowest Endpoints by Avg Latency', vizType: 'table', width: 3, icon: '🐌', accent: '#27ae60', desc: 'Ranked list of endpoints by average response time — find and fix the bottlenecks impacting user experience.',
        dql: `timeseries {latency = avg(dt.service.request.response_time), count = sum(dt.service.request.count)}, by:{dt.entity.service, endpoint.name}, from:${timeframe}\n| filter endpoint.name != "NON_KEY_REQUESTS"\n| fieldsAdd ServiceName = lower(entityName(dt.entity.service))${svcFSN}\n| fieldsAdd Service = concat("[", ServiceName, "](${TENANT_BASE}/ui/apps/dynatrace.services/explorer?detailsId=", dt.entity.service, ")")\n| fieldsAdd AvgLatency = arrayAvg(latency), Requests = arraySum(count)\n| fields Service, Endpoint = endpoint.name, AvgLatency, Requests\n| sort AvgLatency desc\n| limit 25` },
    ];

    /* ══════════════════════════════════════════════════════════════
       OPERATIONS — CPU · Memory · Hosts · Processes · Network ·
                    Availability · Saturation · Logs
       ══════════════════════════════════════════════════════════════ */
    case 'operations': return [
      // ── INFRASTRUCTURE OVERVIEW ──
      { id: 'ops-overview-banner', title: 'INFRASTRUCTURE OVERVIEW', vizType: 'sectionBanner', width: 3, icon: '🏗️', accent: '#3498db', dql: '' },
      { id: 'ops-hosts', title: 'Active Hosts', vizType: 'heroMetric', width: 1, icon: '🖥️', accent: '#3498db', desc: 'Number of monitored hosts actively reporting CPU metrics — your infrastructure footprint at a glance.',
        dql: `timeseries cpu = avg(dt.host.cpu.usage), by:{dt.entity.host}, from:${timeframe}\n| summarize activeHosts = count()` },
      { id: 'ops-pgs', title: 'Process Groups', vizType: 'heroMetric', width: 1, icon: '⚙️', accent: '#27ae60', desc: 'Distinct process group instances reporting CPU — shows the breadth of your application landscape.',
        dql: `timeseries cpu = avg(dt.process.cpu.usage), by:{dt.entity.process_group_instance}, from:${timeframe}\n| summarize activePGs = count()` },
      { id: 'ops-avg-cpu', title: 'Avg Host CPU %', vizType: 'heroMetric', width: 1, icon: '💻', accent: '#e67e22', desc: 'Fleet-wide average CPU utilisation — sustained values above 80% signal a need for capacity planning.',
        dql: `timeseries cpu = avg(dt.host.cpu.usage), by:{dt.entity.host}, from:${timeframe}\n| fieldsAdd avgCpu = arrayAvg(cpu)\n| summarize overallCpu = round(avg(avgCpu), decimals:1)` },

      // ── CPU & COMPUTE ──
      { id: 'ops-cpu-banner', title: 'CPU & COMPUTE', vizType: 'sectionBanner', width: 3, icon: '💻', accent: '#e67e22', dql: '' },
      { id: 'ops-cpu-host', title: 'CPU by Host', vizType: 'timeseries', width: 2, icon: '🖥️', accent: '#e67e22', desc: 'Per-host CPU utilisation over time — spot hot hosts and correlate with deployment or traffic changes.',
        dql: `timeseries cpu = avg(dt.host.cpu.usage), by:{dt.entity.host}, from:${timeframe}\n| fieldsAdd host = lower(entityName(dt.entity.host))\n| fields timeframe, interval, host, cpu\n| sort arrayAvg(cpu) desc\n| limit 15` },
      { id: 'ops-cpu-pg', title: 'CPU by Process Group', vizType: 'timeseries', width: 1, icon: '⚙️', accent: '#e67e22', desc: 'Process-level CPU consumption — pinpoint which application components drive compute costs.',
        dql: `timeseries cpu = avg(dt.process.cpu.usage), by:{dt.entity.process_group_instance}, from:${timeframe}\n| fieldsAdd process = lower(entityName(dt.entity.process_group_instance))\n| fields timeframe, interval, process, cpu\n| sort arrayAvg(cpu) desc\n| limit 15` },
      { id: 'ops-cpu-dist', title: 'CPU Distribution by Host', vizType: 'categoricalBar', width: 3, icon: '📊', accent: '#e67e22', desc: 'Ranked CPU usage across all hosts — quickly identify outliers and resource imbalances.',
        dql: `timeseries cpu = avg(dt.host.cpu.usage), by:{dt.entity.host}, from:${timeframe}\n| fieldsAdd host = lower(entityName(dt.entity.host)), avgCpu = round(arrayAvg(cpu), decimals:1)\n| fields host, avgCpu\n| sort avgCpu desc\n| limit 20` },

      // ── MEMORY ──
      { id: 'ops-mem-banner', title: 'MEMORY', vizType: 'sectionBanner', width: 3, icon: '🧠', accent: '#a78bfa', dql: '' },
      { id: 'ops-mem-host', title: 'Memory by Host', vizType: 'timeseries', width: 2, icon: '🖥️', accent: '#a78bfa', desc: 'Per-host memory utilisation trend — rising baselines can indicate memory leaks or growing workloads.',
        dql: `timeseries memory = avg(dt.host.memory.usage), by:{dt.entity.host}, from:${timeframe}\n| fieldsAdd host = lower(entityName(dt.entity.host))\n| fields timeframe, interval, host, memory\n| sort arrayAvg(memory) desc\n| limit 15` },
      { id: 'ops-mem-pg', title: 'Memory by Process Group', vizType: 'timeseries', width: 1, icon: '⚙️', accent: '#a78bfa', desc: 'Process-level working-set memory — detect heap bloat before it triggers OOM kills.',
        dql: `timeseries memory = avg(dt.process.memory.working_set_size), by:{dt.entity.process_group_instance}, from:${timeframe}\n| fieldsAdd process = lower(entityName(dt.entity.process_group_instance))\n| fields timeframe, interval, process, memory\n| sort arrayAvg(memory) desc\n| limit 15` },

      // ── SERVICE AVAILABILITY ──
      { id: 'ops-avail-banner', title: 'SERVICE AVAILABILITY', vizType: 'sectionBanner', width: 3, icon: '✅', accent: '#27ae60', dql: '' },
      { id: 'ops-avail-table', title: 'Service Availability & Error Rate', vizType: 'table', width: 3, icon: '✅', accent: '#27ae60', desc: 'Per-service availability and error rate with deep links — the single view ops teams check first.',
        dql: `timeseries {requests = sum(dt.service.request.count), errors = sum(dt.service.request.failure_count)}, by:{dt.entity.service}, from:${timeframe}\n| fieldsAdd ServiceName = lower(entityName(dt.entity.service))${svcFSN}\n| fieldsAdd TotalRequests = arraySum(requests), TotalErrors = arraySum(errors)\n| fieldsAdd ErrorRate = round((TotalErrors / TotalRequests) * 100, decimals:2)\n| fieldsAdd Availability = round(100 - ErrorRate, decimals:2)\n| fieldsAdd Service = concat("[", ServiceName, "](${TENANT_BASE}/ui/apps/dynatrace.services/explorer?detailsId=", dt.entity.service, ")")\n| fields Service, TotalRequests, TotalErrors, ErrorRate, Availability\n| sort ErrorRate desc\n| limit 25` },
      { id: 'ops-error-trend', title: 'Error Rate Trend by Service', vizType: 'timeseries', width: 3, icon: '📈', accent: '#e74c3c', desc: 'Service failure counts over time — overlay with deployments to pinpoint regression windows.',
        dql: `timeseries errors = sum(dt.service.request.failure_count), by:{dt.entity.service}, from:${timeframe}\n| fieldsAdd service = lower(entityName(dt.entity.service))${svcF}\n| fields timeframe, interval, service, errors\n| sort arraySum(errors) desc\n| limit 10` },

      // ── NETWORK ──
      { id: 'ops-net-banner', title: 'NETWORK', vizType: 'sectionBanner', width: 3, icon: '🌐', accent: '#1abc9c', dql: '' },
      { id: 'ops-net-in', title: 'Network Traffic In', vizType: 'timeseries', width: 1, icon: '📥', accent: '#1abc9c', desc: 'Inbound network throughput per host — spikes may indicate DDoS, traffic bursts, or data imports.',
        dql: `timeseries traffic_in = avg(dt.host.network.nic.traffic.in), by:{dt.entity.host}, from:${timeframe}\n| fieldsAdd host = lower(entityName(dt.entity.host))\n| fields timeframe, interval, host, traffic_in\n| sort arrayAvg(traffic_in) desc\n| limit 10` },
      { id: 'ops-net-out', title: 'Network Traffic Out', vizType: 'timeseries', width: 1, icon: '📤', accent: '#1abc9c', desc: 'Outbound network throughput per host — useful for spotting data exfiltration or excessive API responses.',
        dql: `timeseries traffic_out = avg(dt.host.network.nic.traffic.out), by:{dt.entity.host}, from:${timeframe}\n| fieldsAdd host = lower(entityName(dt.entity.host))\n| fields timeframe, interval, host, traffic_out\n| sort arrayAvg(traffic_out) desc\n| limit 10` },
      { id: 'ops-connections', title: 'TCP Connections', vizType: 'timeseries', width: 1, icon: '🔗', accent: '#1abc9c', desc: 'Active TCP connections per host — connection pool exhaustion is a top cause of intermittent failures.',
        dql: `timeseries conns = avg(dt.host.network.nic.traffic.in), by:{dt.entity.host}, from:${timeframe}\n| fieldsAdd host = lower(entityName(dt.entity.host))\n| fields timeframe, interval, host, conns\n| sort arrayAvg(conns) desc\n| limit 10` },

      // ── RESOURCE SATURATION ──
      { id: 'ops-sat-banner', title: 'RESOURCE SATURATION', vizType: 'sectionBanner', width: 3, icon: '📦', accent: '#f39c12', dql: '' },
      { id: 'ops-gc', title: 'GC Suspension Time', vizType: 'timeseries', width: 1, icon: '♻️', accent: '#f39c12', desc: 'Garbage collection pause time by process — high GC pressure directly impacts response times and throughput.',
        dql: `timeseries gc_time = avg(dt.runtime.jvm.gc.suspension_time), by:{dt.entity.process_group_instance}, from:${timeframe}\n| append [timeseries gc_time = avg(dt.runtime.clr.gc.suspension_time), by:{dt.entity.process_group_instance}, from:${timeframe}]\n| append [timeseries gc_time = avg(dt.runtime.go.gc.suspension_time), by:{dt.entity.process_group_instance}, from:${timeframe}]\n| append [timeseries gc_time = avg(dt.runtime.nodejs.gc.suspension_time), by:{dt.entity.process_group_instance}, from:${timeframe}]\n| fieldsAdd process = lower(entityName(dt.entity.process_group_instance))\n| fields timeframe, interval, process, gc_time\n| sort arrayAvg(gc_time) desc\n| limit 15` },
      { id: 'ops-threads', title: 'Thread Count by Process', vizType: 'timeseries', width: 1, icon: '🧵', accent: '#f39c12', desc: 'Thread count trends per process — unbounded growth often signals thread leaks or deadlocked pools.',
        dql: `timeseries threads = avg(dt.process.threads), by:{dt.entity.process_group_instance}, from:${timeframe}\n| fieldsAdd process = lower(entityName(dt.entity.process_group_instance))\n| fields timeframe, interval, process, threads\n| sort arrayAvg(threads) desc\n| limit 15` },
      { id: 'ops-disk', title: 'Disk Usage by Host', vizType: 'timeseries', width: 1, icon: '💾', accent: '#f39c12', desc: 'Disk utilisation trend per host — approaching 100% will cause write failures and service outages.',
        dql: `timeseries disk = avg(dt.host.disk.usage), by:{dt.entity.host}, from:${timeframe}\n| fieldsAdd host = lower(entityName(dt.entity.host))\n| fields timeframe, interval, host, disk\n| sort arrayAvg(disk) desc\n| limit 15` },

      // ── LOGS & EVENTS ──
      { id: 'ops-logs-banner', title: 'LOGS & EVENTS', vizType: 'sectionBanner', width: 3, icon: '📋', accent: '#cd3741', dql: '' },
      { id: 'ops-log-volume', title: 'Log Volume by Severity', vizType: 'timeseries', width: 2, icon: '📊', accent: '#cd3741', desc: 'Log ingestion broken down by severity — abnormal ERROR spikes often precede customer-facing incidents.',
        dql: `fetch logs, from:${timeframe}\n| makeTimeseries count = count(), by:{status}` },
      { id: 'ops-recent-errors', title: 'Recent Error Logs', vizType: 'table', width: 3, icon: '📋', accent: '#cd3741', desc: 'Latest error-level log entries with host and process context — start your triage from here.',
        dql: `fetch logs, from:${timeframe}\n| filter in(status, "ERROR")\n| fieldsAdd Process = lower(entityName(dt.entity.process_group_instance))\n| fieldsAdd Host = lower(entityName(dt.entity.host))\n| fields Time = timestamp, Status = status, Host, Process, Content = content\n| sort Time desc\n| limit 100` },
      { id: 'ops-log-dist', title: 'Log Severity Distribution', vizType: 'donut', width: 1, icon: '📊', accent: '#cd3741', desc: 'Proportional split of log levels — healthy systems are overwhelmingly INFO; watch for ERROR creep.',
        dql: `fetch logs, from:${timeframe}\n| summarize count = count(), by:{status}\n| sort count desc` },
    ];

    /* ══════════════════════════════════════════════════════════════
       EXECUTIVE — Industry-Aware C-Level Business Impact Dashboard
       Vocabulary adapts to detected industry from journey/company.
       Revenue · Volume · SLA · Journey Flow · IT Impact · Trends
       ══════════════════════════════════════════════════════════════ */
    case 'executive': return getExecutiveTiles(b, timeframe, journeyType, companyName);
    /* ── Old retail-centric tiles superseded by industry-aware getExecutiveTiles() ──
      // ══════ KEY BUSINESS METRICS ══════
      { id: 'ex-kpi-banner', title: 'KEY BUSINESS METRICS', vizType: 'sectionBanner', width: 3, icon: '📊', accent: '#a78bfa', dql: '' },
      { id: 'ex-revenue', title: 'Total Revenue', vizType: 'heroMetric', width: 1, icon: '💰', accent: '#00d4aa', desc: 'Aggregate revenue captured across all business events in the selected timeframe — compare against seasonal targets to gauge performance.',
        dql: `${b}\n| summarize totalRevenue = round(sum(toDouble(additionalfields.transactionValue)), decimals:0)` },
      { id: 'ex-orders', title: 'Total Orders', vizType: 'heroMetric', width: 1, icon: '🛒', accent: '#3498db', desc: 'Total order volume for the period — track against historical averages to spot seasonal trends or campaign impact.',
        dql: `${b}\n| summarize totalOrders = count()` },
      { id: 'ex-customers', title: 'Unique Customers', vizType: 'heroMetric', width: 1, icon: '👥', accent: '#a78bfa', desc: 'Distinct customer identifiers in the period — a proxy for reach and engagement breadth.',
        dql: `${b}\n| summarize customers = countDistinct(json.customerId)` },
      { id: 'ex-avg-order', title: 'Avg Order Value', vizType: 'heroMetric', width: 1, icon: '💵', accent: '#1abc9c', desc: 'Average transaction value per order — rising AOV signals effective upselling or premium mix shifts.',
        dql: `${b}\n| summarize avgOrder = round(avg(toDouble(additionalfields.transactionValue)), decimals:2)`,
        requiresNumeric: ['transactionValue'] },
      { id: 'ex-error-rate', title: 'Error Rate %', vizType: 'heroMetric', width: 1, icon: '⚠️', accent: '#e74c3c', desc: 'Percentage of business events flagged as errors — directly correlates with revenue leakage and customer churn.',
        dql: `${b}\n| summarize total = count(), errors = countIf(json.hasError == true)\n| fieldsAdd rate = round(100.0 * toDouble(errors) / toDouble(total), decimals:1)` },
      { id: 'ex-services', title: 'Active Services', vizType: 'heroMetric', width: 1, icon: '🔧', accent: '#e67e22', desc: 'Count of distinct services processing business events — shows the operational surface area supporting revenue.',
        dql: `${b}\n| summarize services = countDistinct(json.serviceName)` },

      // ══════ ORDER HEALTH & REVENUE LEAKAGE ══════
      { id: 'ex-leakage-banner', title: 'ORDER HEALTH & REVENUE LEAKAGE', vizType: 'sectionBanner', width: 3, icon: '🚨', accent: '#ae132d', dql: '' },
      { id: 'ex-order-fault-rate', title: 'Order Fault Rate %', vizType: 'heroMetric', width: 1, icon: '💔', accent: '#e74c3c', desc: 'Percentage of orders that faulted (encountered errors) — a key quality metric; every fault risks losing a customer.',
        dql: `${b}\n| summarize totalOrders = count(), faultedOrders = countIf(json.hasError == true)\n| fieldsAdd faultRate = round(100.0 * toDouble(faultedOrders) / toDouble(totalOrders), decimals:2)` },
      { id: 'ex-cart-abandonment', title: 'Cart Abandonment Rate %', vizType: 'heroMetric', width: 1, icon: '🛒', accent: '#d56b1a', desc: 'Of customers who started a cart, how many never completed checkout — the top source of revenue leakage in retail.',
        dql: `${b}\n| summarize cartStarts = countIf(matchesPhrase(toString(json.stepName), "cart") or matchesPhrase(toString(json.stepName), "Cart") or matchesPhrase(toString(json.stepName), "basket")), checkoutComplete = countIf(matchesPhrase(toString(json.stepName), "confirm") or matchesPhrase(toString(json.stepName), "Confirm") or matchesPhrase(toString(json.stepName), "complete") or matchesPhrase(toString(json.stepName), "Complete") or matchesPhrase(toString(json.stepName), "success") or matchesPhrase(toString(json.stepName), "Success"))\n| fieldsAdd abandonmentRate = if(cartStarts > 0, round(100.0 * (1.0 - toDouble(checkoutComplete) / toDouble(cartStarts)), decimals:1), else: 0.0)` },
      { id: 'ex-failed-checkout', title: 'Failed Checkouts', vizType: 'heroMetric', width: 1, icon: '❌', accent: '#ae132d', desc: 'Orders that reached checkout but errored — revenue that was almost captured but lost to IT issues.',
        dql: `${b}\n| filter json.hasError == true\n| filter matchesPhrase(toString(json.stepName), "checkout") or matchesPhrase(toString(json.stepName), "Checkout") or matchesPhrase(toString(json.stepName), "payment") or matchesPhrase(toString(json.stepName), "Payment")\n| summarize failedCheckouts = count()` },
      { id: 'ex-leakage-by-step', title: 'Revenue Leakage by Step', vizType: 'categoricalBar', width: 2, icon: '💸', accent: '#ae132d', desc: 'Where in the journey are errors causing revenue loss — pinpoint the exact step where money leaks out of the funnel.',
        dql: `${b}\n| filter json.hasError == true\n| summarize lostRevenue = round(sum(toDouble(additionalfields.transactionValue)), decimals:0), faults = count(), by:{json.stepName}\n| sort lostRevenue desc\n| limit 15` },
      { id: 'ex-fault-trend', title: 'Order Faults Over Time', vizType: 'timeseries', width: 1, icon: '📈', accent: '#e74c3c', desc: 'Order fault volume trend — compare with seasonal baselines to determine if current fault rates are normal.',
        dql: `${b}\n| makeTimeseries faults = countIf(json.hasError == true)` },

      // ══════ REVENUE & VOLUME TRENDS ══════
      { id: 'ex-trends-banner', title: 'REVENUE & VOLUME TRENDS', vizType: 'sectionBanner', width: 3, icon: '📈', accent: '#00d4aa', dql: '' },
      { id: 'ex-revenue-ts', title: 'Revenue Over Time', vizType: 'timeseries', width: 2, icon: '📈', accent: '#00d4aa', desc: 'Revenue trend line for the selected window — compare curve shape against the seasonal average to spot anomalies.',
        dql: `${b}\n| makeTimeseries revenue = sum(toDouble(additionalfields.transactionValue))` },
      { id: 'ex-impact', title: 'Revenue at Risk', vizType: 'impactCard', width: 1, icon: '🔥', accent: '#e74c3c', desc: 'Estimated monetary impact of errored transactions — quantifies how much revenue IT issues are putting at risk.',
        dql: `${b}\n| summarize errors = countIf(json.hasError == true), totalTxns = count(), avgValue = avg(toDouble(additionalfields.transactionValue))\n| fieldsAdd estimatedImpact = round(toDouble(errors) * avgValue, decimals:0), errorRate = round(100.0 * toDouble(errors) / toDouble(totalTxns), decimals:1)` },
      { id: 'ex-volume-ts', title: 'Order Volume Over Time', vizType: 'timeseries', width: 1, icon: '📊', accent: '#3498db', desc: 'Order count over time — overlay with marketing campaign dates to measure conversion lift.',
        dql: `${b}\n| makeTimeseries orders = count()` },
      { id: 'ex-customers-ts', title: 'Unique Customers Over Time', vizType: 'timeseries', width: 1, icon: '👥', accent: '#a78bfa', desc: 'Customer reach trend — dips may indicate accessibility issues; growth shows campaign effectiveness.',
        dql: `${b}\n| makeTimeseries customers = countDistinct(json.customerId)` },
      { id: 'ex-rev-by-svc-ts', title: 'Revenue by Service Over Time', vizType: 'timeseries', width: 1, icon: '💰', accent: '#1abc9c', desc: 'Revenue attribution per service — identify which backend services drive the most business value.',
        dql: `${b}\n| makeTimeseries revenue = sum(toDouble(additionalfields.transactionValue)), by:{json.serviceName}` },

      // ══════ JOURNEY FLOW (Retail-inspired stage view) ══════
      { id: 'ex-journey-banner', title: 'JOURNEY FLOW', vizType: 'sectionBanner', width: 3, icon: '🔻', accent: '#a78bfa', dql: '' },
      { id: 'ex-funnel', title: 'Journey Steps Funnel', vizType: 'categoricalBar', width: 2, icon: '🔻', accent: '#a78bfa', desc: 'Visualises the customer journey funnel — each bar represents a stage; steep drops reveal where customers abandon.',
        dql: `${b}\n| summarize count = count(), by:{json.stepName, json.stepIndex}\n| sort toDouble(json.stepIndex) asc\n| limit 20` },
      { id: 'ex-step-conversion', title: 'Drop-off by Step', vizType: 'categoricalBar', width: 1, icon: '📉', accent: '#e74c3c', desc: 'Error-driven drop-off rate per journey step — high drop-off at checkout means direct revenue leakage.',
        dql: `${b}\n| summarize total = count(), errors = countIf(json.hasError == true), by:{json.stepName, json.stepIndex}\n| fieldsAdd dropRate = round(100.0 * toDouble(errors) / toDouble(total), decimals:1)\n| sort toDouble(json.stepIndex) asc\n| limit 20` },
      { id: 'ex-step-revenue', title: 'Revenue by Journey Step', vizType: 'categoricalBar', width: 2, icon: '💰', accent: '#00d4aa', desc: 'Revenue attributed to each journey step — shows where business value accumulates across the customer flow.',
        dql: `${b}\n| summarize revenue = sum(toDouble(additionalfields.transactionValue)), count = count(), by:{json.stepName, json.stepIndex}\n| sort toDouble(json.stepIndex) asc\n| limit 20` },
      { id: 'ex-step-time', title: 'Avg Processing Time by Step', vizType: 'categoricalBar', width: 1, icon: '⏱️', accent: '#f39c12', desc: 'Average processing latency at each journey step — slow steps cause cart abandonment and reduce conversion.',
        dql: `${b}\n| summarize avgTime = round(avg(toDouble(additionalfields.processingTime)), decimals:0), by:{json.stepName, json.stepIndex}\n| sort toDouble(json.stepIndex) asc\n| limit 20`,
        requiresNumeric: ['processingTime'] },

      // ══════ REVENUE BREAKDOWN ══════
      { id: 'ex-bd-banner', title: 'REVENUE BREAKDOWN', vizType: 'sectionBanner', width: 3, icon: '💰', accent: '#1abc9c', dql: '' },
      { id: 'ex-rev-journey', title: 'Revenue by Journey Type', vizType: 'categoricalBar', width: 2, icon: '📊', accent: '#1abc9c', desc: 'Revenue split across journey types (purchase, browse, etc.) — shows which customer paths generate the most value.',
        dql: `${b}\n| summarize revenue = sum(toDouble(additionalfields.transactionValue)), by:{json.journeyType}\n| sort revenue desc\n| limit 15` },
      { id: 'ex-events-journey', title: 'Events by Journey', vizType: 'donut', width: 1, icon: '🎯', desc: 'Proportional event distribution by journey type — understand the traffic mix driving your business.',
        dql: `${b}\n| summarize count = count(), by:{json.journeyType}\n| sort count desc\n| limit 10` },
      { id: 'ex-rev-service', title: 'Revenue by Service', vizType: 'categoricalBar', width: 2, icon: '🔧', accent: '#1abc9c', desc: 'Revenue attributed to each backend service — helps prioritise SLA investments on the highest-value services.',
        dql: `${b}\n| summarize revenue = sum(toDouble(additionalfields.transactionValue)), by:{json.serviceName}\n| sort revenue desc\n| limit 15` },
      { id: 'ex-events-type', title: 'Events by Type', vizType: 'donut', width: 1, icon: '🏷️', desc: 'Breakdown of event types (purchase, cart, browse) — reveals the composition of your digital activity.',
        dql: `${b}\n| summarize count = count(), by:{event.type}\n| sort count desc\n| limit 10` },

      // ══════ SLA & PERFORMANCE (EasyTrade-inspired) ══════
      { id: 'ex-sla-banner', title: 'SLA & PERFORMANCE', vizType: 'sectionBanner', width: 3, icon: '⏱️', accent: '#f39c12', dql: '' },
      { id: 'ex-sla-met', title: 'SLA Met vs Not Met', vizType: 'timeseries', width: 2, icon: '✅', accent: '#27ae60', desc: 'SLA compliance trend (5s threshold) — of all orders, how many were processed within SLA? Watch for degradation patterns.',
        dql: `${b}\n| fieldsAdd sla = if(toDouble(additionalfields.processingTime) > 5000, "Not Met", else: "Met")\n| makeTimeseries met = countIf(sla == "Met"), notMet = countIf(sla == "Not Met")`,
        requiresNumeric: ['processingTime'] },
      { id: 'ex-sla-pct', title: 'SLA Compliance %', vizType: 'heroMetric', width: 1, icon: '📋', accent: '#27ae60', desc: 'Overall SLA compliance percentage — the single number executives need: of total orders, what % completed inside the SLA threshold.',
        dql: `${b}\n| fieldsAdd sla = if(toDouble(additionalfields.processingTime) > 5000, "Not Met", else: "Met")\n| summarize slaPercentage = round(100.0 * toDouble(countIf(sla == "Met")) / toDouble(count()), decimals:1)`,
        requiresNumeric: ['processingTime'] },
      { id: 'ex-latency-by-svc', title: 'Avg Latency by Service', vizType: 'categoricalBar', width: 2, icon: '⏱️', accent: '#f39c12', desc: 'Per-service average processing latency — services with high latency drag down the overall SLA compliance rate.',
        dql: `${b}\n| summarize avgLatency = round(avg(toDouble(additionalfields.processingTime)), decimals:0), by:{json.serviceName}\n| sort avgLatency desc\n| limit 15`,
        requiresNumeric: ['processingTime'] },
      { id: 'ex-latency-ts', title: 'Avg Processing Time', vizType: 'timeseries', width: 1, icon: '📈', accent: '#f39c12', desc: 'Processing time trend — a rising baseline indicates infrastructure degradation or growing data volumes.',
        dql: `${b}\n| makeTimeseries avgLatency = avg(toDouble(additionalfields.processingTime))`,
        requiresNumeric: ['processingTime'] },

      // ══════ IT IMPACT ON BUSINESS (Retail-inspired) ══════
      { id: 'ex-it-banner', title: 'IT IMPACT ON BUSINESS', vizType: 'sectionBanner', width: 3, icon: '🛠️', accent: '#e74c3c', dql: '' },
      { id: 'ex-it-problems', title: 'Open IT Problems', vizType: 'heroMetric', width: 1, icon: '🔴', accent: '#e74c3c', desc: 'Active Dynatrace Intelligence problems — open problems directly correlate with order faults and SLA breaches.',
        dql: `fetch dt.davis.problems, from:${timeframe}\n| filter dt.davis.is_duplicate == false\n| filter event.status == "ACTIVE"\n| summarize openProblems = count()` },
      { id: 'ex-it-loss', title: 'Est. Loss from Errors', vizType: 'heroMetric', width: 1, icon: '💸', accent: '#ae132d', desc: 'Revenue directly lost to errored transactions — the business cost of IT issues, calculated from actual transaction values.',
        dql: `${b}\n| filter json.hasError == true\n| summarize lostRevenue = round(sum(toDouble(additionalfields.transactionValue)), decimals:0)` },
      { id: 'ex-it-affected', title: 'Affected Customers', vizType: 'heroMetric', width: 1, icon: '👥', accent: '#d56b1a', desc: 'Unique customers impacted by errors — customer-level blast radius of IT faults.',
        dql: `${b}\n| filter json.hasError == true\n| summarize affectedCustomers = countDistinct(json.customerId)` },
      { id: 'ex-problems-ts', title: 'Problems Over Time', vizType: 'timeseries', width: 2, icon: '📈', accent: '#e74c3c', desc: 'Dynatrace Intelligence problem creation rate — correlate with revenue dips to measure business impact.',
        dql: `fetch dt.davis.problems, from:${timeframe}\n| filter dt.davis.is_duplicate == false\n| makeTimeseries count = count()` },
      { id: 'ex-errors-ts', title: 'Business Errors Over Time', vizType: 'timeseries', width: 1, icon: '📈', accent: '#ae132d', desc: 'Business event errors over time — each spike represents potential order faults and revenue leakage.',
        dql: `${b}\n| makeTimeseries errors = countIf(json.hasError == true)` },

      // ══════ TOP CUSTOMERS & RECENT ACTIVITY (EasyTrade-inspired) ══════
      { id: 'ex-activity-banner', title: 'TOP CUSTOMERS & RECENT ACTIVITY', vizType: 'sectionBanner', width: 3, icon: '👤', accent: '#3498db', dql: '' },
      { id: 'ex-top-customers', title: 'Top Customers by Revenue', vizType: 'categoricalBar', width: 2, icon: '👤', accent: '#3498db', desc: 'Highest-value customers ranked by spend — protect these VIPs from error-impacted experiences first.',
        dql: `${b}\n| summarize revenue = round(sum(toDouble(additionalfields.transactionValue)), decimals:2), orders = count(), by:{json.customerId}\n| sort revenue desc\n| limit 15` },
      { id: 'ex-customer-dist', title: 'Customer Activity Distribution', vizType: 'honeycomb', width: 1, icon: '🔥', desc: 'Heatmap of customer activity volume — larger cells indicate power users or high-frequency buyers.',
        dql: `${b}\n| summarize count = count(), by:{json.customerId}\n| sort count desc\n| limit 30` },
      { id: 'ex-recent-orders', title: 'Most Recent Orders', vizType: 'table', width: 3, icon: '📋', accent: '#3498db', desc: 'Live feed of the latest orders with customer, journey, service, and error status — real-time operational awareness.',
        dql: `${b}\n| fields Time = timestamp, Customer = json.customerId, Journey = json.journeyType, Step = json.stepName, Service = json.serviceName, Value = additionalfields.transactionValue, EventType = event.type, HasError = json.hasError\n| sort Time desc\n| limit 50` },

      // ══════ SERVICE PERFORMANCE ══════
      { id: 'ex-svc-banner', title: 'SERVICE PERFORMANCE', vizType: 'sectionBanner', width: 3, icon: '🔧', accent: '#e67e22', dql: '' },
      { id: 'ex-svc-table', title: 'Service Business Performance', vizType: 'table', width: 3, icon: '📋', accent: '#e67e22', desc: 'Full service scorecard — revenue, volume, errors, failure rate, and customer reach per service with deep links.',
        dql: `${b}\n| summarize EventCount = count(), Errors = countIf(json.hasError == true), Revenue = round(sum(toDouble(additionalfields.transactionValue)), decimals:2), AvgValue = round(avg(toDouble(additionalfields.transactionValue)), decimals:2), Customers = countDistinct(json.customerId), by:{json.serviceName}\n| fieldsAdd FailRate = round(100.0 * toDouble(Errors) / toDouble(EventCount), decimals:2)\n| fieldsAdd Service = concat("[", json.serviceName, "](${TENANT_BASE}/ui/apps/dynatrace.services)")\n| fields Service, Revenue, EventCount, Errors, FailRate, AvgValue, Customers\n| sort Revenue desc\n| limit 25` },
      { id: 'ex-svc-errors', title: 'Error Rate by Service', vizType: 'categoricalBar', width: 2, icon: '⚠️', accent: '#e74c3c', desc: 'Per-service error rate ranking — services at the top are the biggest contributors to order faults.',
        dql: `${b}\n| summarize total = count(), errors = countIf(json.hasError == true), by:{json.serviceName}\n| fieldsAdd errorRate = round(100.0 * toDouble(errors) / toDouble(total), decimals:1)\n| sort errorRate desc\n| limit 15` },
      { id: 'ex-heatmap', title: 'Event Activity Heatmap', vizType: 'honeycomb', width: 1, icon: '🔥', desc: 'Event type distribution heatmap — see the relative weight of purchase, cart, browse, and error events at a glance.',
        dql: `${b}\n| summarize count = count(), by:{event.type}\n| sort count desc\n| limit 20` },
    ── end of superseded tiles ── */

    /* ══════════════════════════════════════════════════════════════
       DYNATRACE INTELLIGENCE — Problems · Root Cause · Anomalies ·
                                Impact · Resolution
       ══════════════════════════════════════════════════════════════ */
    case 'intelligence': return [
      // ── PROBLEM OVERVIEW ──
      { id: 'di-overview-banner', title: 'PROBLEM OVERVIEW', vizType: 'sectionBanner', width: 3, icon: '🔴', accent: '#e74c3c', dql: '' },
      { id: 'di-active', title: 'Active Problems', vizType: 'heroMetric', width: 1, icon: '🔥', accent: '#e74c3c', desc: 'Currently open Dynatrace Intelligence problems — the primary indicator of ongoing infrastructure or application issues.',
        dql: `fetch dt.davis.problems, from:${timeframe}\n| filter dt.davis.is_duplicate == false\n| filter event.status == "ACTIVE"\n| summarize activeProblems = count()` },
      { id: 'di-total', title: 'Total Problems', vizType: 'heroMetric', width: 1, icon: '📊', accent: '#f39c12', desc: 'Total problem count (active + resolved) in the selected period — measure your environment’s overall stability.',
        dql: `fetch dt.davis.problems, from:${timeframe}\n| filter dt.davis.is_duplicate == false\n| summarize totalProblems = count()` },
      { id: 'di-affected-svc', title: 'Affected Services', vizType: 'heroMetric', width: 1, icon: '🔧', accent: '#a78bfa', desc: 'Distinct services referenced in problem entities — a wide blast radius means higher business risk.',
        dql: `fetch dt.davis.problems, from:${timeframe}\n| filter dt.davis.is_duplicate == false\n| expand affected_entity_ids\n| filter matchesPhrase(toString(affected_entity_ids), "SERVICE")\n| summarize affectedServices = countDistinct(affected_entity_ids)` },

      // ── PROBLEM DETAIL ──
      { id: 'di-detail-banner', title: 'PROBLEM DETAIL', vizType: 'sectionBanner', width: 3, icon: '🔍', accent: '#e74c3c', dql: '' },
      { id: 'di-problems-table', title: 'Dynatrace Intelligence Problems', vizType: 'table', width: 3, icon: '🔥', accent: '#e74c3c', desc: 'Detailed problem list with status, root cause, affected services, and deep links into Dynatrace Intelligence.',
        dql: `fetch dt.davis.problems, from:${timeframe}\n| filter dt.davis.is_duplicate == false\n| sort timestamp desc\n| expand affected_entity_ids\n| lookup [fetch dt.entity.service], sourceField:affected_entity_ids, lookupField:id, prefix:"svc."\n| summarize {startTime = takeFirst(event.start), endTime = takeFirst(event.end), status = takeFirst(event.status), eventName = takeFirst(event.name), category = takeFirst(event.category), rootCause = takeFirst(root_cause_entity_name), affectedServices = collectDistinct(svc.entity.name), eventId = takeFirst(event.id)}, by:{display_id, event.kind}\n| fieldsAdd Description = concat("[", display_id, " - ", eventName, "](${TENANT_BASE}/ui/apps/dynatrace.davis.problems/problem/", eventId, ")")\n| fields Status = status, Description, RootCause = rootCause, Category = category, AffectedServices = affectedServices, StartTime = startTime\n| sort StartTime desc\n| limit 25` },
      { id: 'di-problems-ts', title: 'Problems Over Time', vizType: 'timeseries', width: 3, icon: '📈', accent: '#e74c3c', desc: 'Problem creation rate trend — spikes correspond to incidents; a flat line near zero is your reliability target.',
        dql: `fetch dt.davis.problems, from:${timeframe}\n| filter dt.davis.is_duplicate == false\n| makeTimeseries count = count()` },

      // ── PROBLEM ANALYSIS ──
      { id: 'di-analysis-banner', title: 'PROBLEM ANALYSIS', vizType: 'sectionBanner', width: 3, icon: '🧠', accent: '#a78bfa', dql: '' },
      { id: 'di-by-category', title: 'Problems by Category', vizType: 'donut', width: 1, icon: '🎯', accent: '#a78bfa', desc: 'Problem distribution by category (availability, error, slowdown) — reveals your top failure mode.',
        dql: `fetch dt.davis.problems, from:${timeframe}\n| filter dt.davis.is_duplicate == false\n| summarize count = count(), by:{event.category}\n| sort count desc\n| limit 10` },
      { id: 'di-by-root-cause', title: 'Top Root Causes', vizType: 'categoricalBar', width: 2, icon: '🔎', accent: '#e74c3c', desc: 'Most frequent root cause entities identified by Dynatrace Intelligence — fix these to eliminate recurring problems.',
        dql: `fetch dt.davis.problems, from:${timeframe}\n| filter dt.davis.is_duplicate == false\n| filter isNotNull(root_cause_entity_name)\n| summarize count = count(), by:{root_cause_entity_name}\n| sort count desc\n| limit 15` },
      { id: 'di-by-service', title: 'Affected Services', vizType: 'categoricalBar', width: 2, icon: '🔧', accent: '#a78bfa', desc: 'Services most frequently impacted by problems — high counts indicate fragile services needing hardening.',
        dql: `fetch dt.davis.problems, from:${timeframe}\n| filter dt.davis.is_duplicate == false\n| expand affected_entity_ids\n| lookup [fetch dt.entity.service], sourceField:affected_entity_ids, lookupField:id, prefix:"svc."\n| filter isNotNull(svc.entity.name)\n| summarize count = count(), by:{svc.entity.name}\n| sort count desc\n| limit 15` },
      { id: 'di-severity-heatmap', title: 'Problem Severity Heatmap', vizType: 'honeycomb', width: 1, icon: '🔥', accent: '#e74c3c', desc: 'Visual heatmap of problem severity by event name — larger cells indicate more frequent issue types.',
        dql: `fetch dt.davis.problems, from:${timeframe}\n| filter dt.davis.is_duplicate == false\n| summarize count = count(), by:{event.name}\n| sort count desc\n| limit 20` },

      // ── BUSINESS IMPACT ──
      { id: 'di-impact-banner', title: 'BUSINESS IMPACT', vizType: 'sectionBanner', width: 3, icon: '💰', accent: '#f39c12', dql: '' },
      { id: 'di-rev-impact', title: 'Revenue at Risk', vizType: 'impactCard', width: 1, icon: '💥', accent: '#e74c3c', desc: 'Estimated monetary value at risk from errored business transactions — the financial face of IT problems.',
        dql: `${b}\n| summarize errors = countIf(json.hasError == true), totalTxns = count(), avgValue = avg(toDouble(additionalfields.transactionValue))\n| fieldsAdd estimatedImpact = round(toDouble(errors) * avgValue, decimals:0), errorRate = round(100.0 * toDouble(errors) / toDouble(totalTxns), decimals:1)` },
      { id: 'di-error-orders', title: 'Error-Affected Orders', vizType: 'heroMetric', width: 1, icon: '⚠️', accent: '#e74c3c', desc: 'Total order count impacted by errors — each is a customer who may not return.',
        dql: `${b}\n| summarize errorOrders = countIf(json.hasError == true)` },
      { id: 'di-errors-ts', title: 'Business Errors Over Time', vizType: 'timeseries', width: 1, icon: '📈', accent: '#e74c3c', desc: 'Error event volume trend — correlate with problem timeline to attribute business impact to specific incidents.',
        dql: `${b}\n| makeTimeseries errors = countIf(json.hasError == true)` },

      // ── ANOMALY EVENTS ──
      { id: 'di-anomaly-banner', title: 'ANOMALY EVENTS', vizType: 'sectionBanner', width: 3, icon: '📡', accent: '#4fc3f7', dql: '' },
      { id: 'di-events-ts', title: 'Davis Event Timeline', vizType: 'timeseries', width: 2, icon: '📊', accent: '#4fc3f7', desc: 'Dynatrace Intelligence event timeline — includes anomaly detections and problem events for root cause correlation.',
        dql: `fetch events, from:${timeframe}\n| filter event.kind == "DAVIS_EVENT" or event.kind == "DAVIS_PROBLEM"\n| makeTimeseries count = count(), by:{event.kind}` },
      { id: 'di-event-types', title: 'Event Type Distribution', vizType: 'donut', width: 1, icon: '🎯', accent: '#4fc3f7', desc: 'Anomaly event categories breakdown — shows whether issues are primarily availability, performance, or error-related.',
        dql: `fetch events, from:${timeframe}\n| filter event.kind == "DAVIS_EVENT" or event.kind == "DAVIS_PROBLEM"\n| summarize count = count(), by:{event.category}\n| sort count desc\n| limit 10` },
      { id: 'di-recent-events', title: 'Recent Anomaly Events', vizType: 'table', width: 3, icon: '📡', accent: '#4fc3f7', desc: 'Latest anomaly events with category, affected entity, and status — your real-time intelligence feed.',
        dql: `fetch events, from:${timeframe}\n| filter event.kind == "DAVIS_EVENT"\n| fieldsAdd AffectedEntity = affected_entity_ids[0]\n| fields Time = timestamp, Category = event.category, Name = event.name, Status = event.status, AffectedEntity\n| sort Time desc\n| limit 50` },
    ];

    /* ══════════════════════════════════════════════════════════════
       GENAI OBSERVABILITY — LLM Calls · Tokens · Latency · Models ·
                             Embeddings · Errors
       ══════════════════════════════════════════════════════════════ */
    case 'genai': return [
      // ── LLM OVERVIEW ──
      { id: 'ai-overview-banner', title: 'LLM OVERVIEW', vizType: 'sectionBanner', width: 3, icon: '🤖', accent: '#10b981', dql: '' },
      { id: 'ai-total-calls', title: 'Total LLM Calls', vizType: 'heroMetric', width: 1, icon: '📞', accent: '#10b981', desc: 'Total number of LLM API invocations in the period — the primary throughput measure for your AI workloads.',
        dql: `fetch spans, from:${timeframe}\n| filter isNotNull(gen_ai.system)\n| summarize totalCalls = count()` },
      { id: 'ai-avg-latency', title: 'Avg LLM Latency', vizType: 'heroMetric', width: 1, icon: '⏱️', accent: '#f59e0b', desc: 'Average end-to-end LLM call duration — high latency degrades the user experience of AI-powered features.',
        dql: `fetch spans, from:${timeframe}\n| filter isNotNull(gen_ai.system)\n| summarize avgLatency = round(avg(duration), decimals:0)` },
      { id: 'ai-error-count', title: 'LLM Errors', vizType: 'heroMetric', width: 1, icon: '❌', accent: '#e74c3c', desc: 'Failed LLM calls (error finish reason or error.type) — each error is a degraded user experience or fallback invocation.',
        dql: `fetch spans, from:${timeframe}\n| filter isNotNull(gen_ai.system)\n| filter gen_ai.response.finish_reason == "error" or isNotNull(error.type)\n| summarize errors = count()` },

      // ── LLM ACTIVITY ──
      { id: 'ai-activity-banner', title: 'LLM ACTIVITY', vizType: 'sectionBanner', width: 3, icon: '📊', accent: '#10b981', dql: '' },
      { id: 'ai-calls-ts', title: 'LLM Calls Over Time', vizType: 'timeseries', width: 2, icon: '📈', accent: '#10b981', desc: 'LLM call volume trend — correlate with feature launches and user activity to understand AI adoption.',
        dql: `fetch spans, from:${timeframe}\n| filter isNotNull(gen_ai.system)\n| makeTimeseries calls = count()` },
      { id: 'ai-latency-ts', title: 'LLM Latency Over Time', vizType: 'timeseries', width: 1, icon: '⏱️', accent: '#f59e0b', desc: 'Latency trend over time — watch for provider throttling or model degradation patterns.',
        dql: `fetch spans, from:${timeframe}\n| filter isNotNull(gen_ai.system)\n| makeTimeseries avgLatency = avg(duration)` },
      { id: 'ai-by-model', title: 'Calls by Model', vizType: 'categoricalBar', width: 2, icon: '🧠', accent: '#10b981', desc: 'Call volume per LLM model — understand which models handle the most traffic and plan capacity accordingly.',
        dql: `fetch spans, from:${timeframe}\n| filter isNotNull(gen_ai.system)\n| summarize count = count(), by:{gen_ai.request.model}\n| sort count desc\n| limit 15` },
      { id: 'ai-by-operation', title: 'Calls by Operation', vizType: 'donut', width: 1, icon: '🎯', accent: '#06b6d4', desc: 'LLM call distribution by operation type (chat, completion, embedding) — reveals your AI usage patterns.',
        dql: `fetch spans, from:${timeframe}\n| filter isNotNull(gen_ai.system)\n| summarize count = count(), by:{gen_ai.operation.name}\n| sort count desc\n| limit 10` },

      // ── TOKEN USAGE ──
      { id: 'ai-tokens-banner', title: 'TOKEN USAGE', vizType: 'sectionBanner', width: 3, icon: '🔢', accent: '#8b5cf6', dql: '' },
      { id: 'ai-total-tokens', title: 'Total Tokens', vizType: 'heroMetric', width: 1, icon: '🔢', accent: '#8b5cf6', desc: 'Aggregate token consumption (input + output) — directly correlates with your LLM provider costs.',
        dql: `fetch spans, from:${timeframe}\n| filter isNotNull(gen_ai.system)\n| summarize totalTokens = sum(gen_ai.usage.output_tokens) + sum(gen_ai.usage.input_tokens)` },
      { id: 'ai-tokens-ts', title: 'Token Usage Over Time', vizType: 'timeseries', width: 2, icon: '📈', accent: '#8b5cf6', desc: 'Input vs output token trend — output-heavy patterns drive higher costs; monitor for unexpected spikes.',
        dql: `fetch spans, from:${timeframe}\n| filter isNotNull(gen_ai.system)\n| makeTimeseries inputTokens = sum(gen_ai.usage.input_tokens), outputTokens = sum(gen_ai.usage.output_tokens)` },
      { id: 'ai-tokens-by-model', title: 'Tokens by Model', vizType: 'categoricalBar', width: 2, icon: '🧠', accent: '#8b5cf6', desc: 'Token consumption per model — identifies which models are the most expensive from a token perspective.',
        dql: `fetch spans, from:${timeframe}\n| filter isNotNull(gen_ai.system)\n| summarize tokens = sum(gen_ai.usage.output_tokens) + sum(gen_ai.usage.input_tokens), by:{gen_ai.request.model}\n| sort tokens desc\n| limit 10` },
      { id: 'ai-avg-tokens', title: 'Avg Tokens per Call', vizType: 'heroMetric', width: 1, icon: '📊', accent: '#06b6d4', desc: 'Average token payload per LLM call — large averages may indicate unoptimised prompts or excessive context windows.',
        dql: `fetch spans, from:${timeframe}\n| filter isNotNull(gen_ai.system)\n| fieldsAdd total_tokens = gen_ai.usage.output_tokens + gen_ai.usage.input_tokens\n| summarize avgTokens = round(avg(total_tokens), decimals:0)` },

      // ── MODEL PERFORMANCE ──
      { id: 'ai-perf-banner', title: 'MODEL PERFORMANCE', vizType: 'sectionBanner', width: 3, icon: '⚡', accent: '#f59e0b', dql: '' },
      { id: 'ai-latency-by-model', title: 'Latency by Model', vizType: 'categoricalBar', width: 2, icon: '⏱️', accent: '#f59e0b', desc: 'Average, p90, and max latency per model — compare models to choose the best speed/quality trade-off.',
        dql: `fetch spans, from:${timeframe}\n| filter isNotNull(gen_ai.system)\n| summarize avgLatency = round(avg(duration), decimals:0), p90 = round(percentile(duration, 90), decimals:0), maxLatency = round(max(duration), decimals:0), by:{gen_ai.request.model}\n| sort avgLatency desc\n| limit 10` },
      { id: 'ai-latency-by-op', title: 'Latency by Operation', vizType: 'categoricalBar', width: 1, icon: '🎯', accent: '#f59e0b', desc: 'Latency breakdown by operation type — embeddings are typically fast; completions are slower.',
        dql: `fetch spans, from:${timeframe}\n| filter isNotNull(gen_ai.system)\n| summarize avgLatency = round(avg(duration), decimals:0), calls = count(), by:{gen_ai.operation.name}\n| sort avgLatency desc\n| limit 10` },
      { id: 'ai-detail-table', title: 'LLM Call Details', vizType: 'table', width: 3, icon: '📋', accent: '#10b981', desc: 'Individual LLM calls with service, model, tokens, duration, and trace links — your GenAI observability audit trail.',
        dql: `fetch spans, from:${timeframe}\n| filter isNotNull(gen_ai.system)\n| fieldsAdd ServiceName = entityName(dt.entity.service)\n| fieldsAdd Service = concat("[", ServiceName, "](${TENANT_BASE}/ui/apps/dynatrace.services/explorer?detailsId=", dt.entity.service, ")")\n| fieldsAdd Trace = concat("[", trace_id, "](${TENANT_BASE}/ui/apps/dynatrace.distributedtracing/explorer?traceId=", trace_id, ")")\n| fields Time = start_time, Service, Model = gen_ai.request.model, Operation = gen_ai.operation.name, InputTokens = gen_ai.usage.input_tokens, OutputTokens = gen_ai.usage.output_tokens, Duration = duration, Trace\n| sort Time desc\n| limit 100` },
    ];

    /* ══════════════════════════════════════════════════════════════
       SECURITY — Security Events · Attacks · Categories ·
                  Trends · Affected Entities
       ══════════════════════════════════════════════════════════════ */
    case 'security': return [
      // ── SECURITY OVERVIEW ──
      { id: 'sec-overview-banner', title: 'SECURITY OVERVIEW', vizType: 'sectionBanner', width: 3, icon: '🔒', accent: '#f59e0b', dql: '' },
      { id: 'sec-total-events', title: 'Total Security Events', vizType: 'heroMetric', width: 1, icon: '🛡️', accent: '#f59e0b', desc: 'Total security events detected by Dynatrace in the period — the baseline measure of your security posture.',
        dql: `fetch events, from:${timeframe}\n| filter event.kind == "SECURITY_EVENT"\n| summarize total = count()` },
      { id: 'sec-categories', title: 'Event Categories', vizType: 'heroMetric', width: 1, icon: '📊', accent: '#3498db', desc: 'Distinct security event categories observed — diversification indicates a broader threat landscape.',
        dql: `fetch events, from:${timeframe}\n| filter event.kind == "SECURITY_EVENT"\n| summarize categories = countDistinct(event.category)` },
      { id: 'sec-attack-count', title: 'Attack Events', vizType: 'heroMetric', width: 1, icon: '⚔️', accent: '#ae132d', desc: 'Number of events classified as ATTACK — these represent active exploitation attempts against your services.',
        dql: `fetch events, from:${timeframe}\n| filter event.kind == "SECURITY_EVENT"\n| filter event.category == "ATTACK"\n| summarize attacks = count()` },

      // ── SECURITY TRENDS ──
      { id: 'sec-trend-banner', title: 'SECURITY TRENDS', vizType: 'sectionBanner', width: 3, icon: '📈', accent: '#f59e0b', dql: '' },
      { id: 'sec-events-ts', title: 'Security Events Over Time', vizType: 'timeseries', width: 2, icon: '📈', accent: '#f59e0b', desc: 'Security event volume trend — sudden spikes may indicate active attacks or newly discovered vulnerabilities.',
        dql: `fetch events, from:${timeframe}\n| filter event.kind == "SECURITY_EVENT"\n| makeTimeseries count = count()` },
      { id: 'sec-by-category', title: 'By Category', vizType: 'donut', width: 1, icon: '🎯', accent: '#e74c3c', desc: 'Security events broken down by category — shows the proportional mix of vulnerability types in your environment.',
        dql: `fetch events, from:${timeframe}\n| filter event.kind == "SECURITY_EVENT"\n| summarize count = count(), by:{event.category}\n| sort count desc` },
      { id: 'sec-by-category-ts', title: 'Categories Over Time', vizType: 'timeseries', width: 2, icon: '📊', accent: '#3498db', desc: 'Category-level trend lines — monitor whether attack volumes are growing relative to other security events.',
        dql: `fetch events, from:${timeframe}\n| filter event.kind == "SECURITY_EVENT"\n| makeTimeseries count = count(), by:{event.category}` },
      { id: 'sec-by-status', title: 'By Status', vizType: 'donut', width: 1, icon: '🏷️', accent: '#a78bfa', desc: 'Event status distribution (active, resolved, etc.) — a large active slice means unresolved security issues.',
        dql: `fetch events, from:${timeframe}\n| filter event.kind == "SECURITY_EVENT"\n| summarize count = count(), by:{event.status}\n| sort count desc\n| limit 10` },

      // ── SECURITY EVENT DETAILS ──
      { id: 'sec-detail-banner', title: 'SECURITY EVENT DETAILS', vizType: 'sectionBanner', width: 3, icon: '🔍', accent: '#f59e0b', dql: '' },
      { id: 'sec-events-table', title: 'Recent Security Events', vizType: 'table', width: 3, icon: '📋', accent: '#f59e0b', desc: 'Latest security events with full detail — the starting point for security incident investigation.',
        dql: `fetch events, from:${timeframe}\n| filter event.kind == "SECURITY_EVENT"\n| fields Time = timestamp, Category = event.category, Name = event.name, Status = event.status, Entity = affected_entity_ids[0]\n| sort Time desc\n| limit 50` },
      { id: 'sec-top-names', title: 'Top Event Names', vizType: 'categoricalBar', width: 2, icon: '📊', accent: '#e74c3c', desc: 'Most frequently occurring security event types — prioritise mitigation of the most common threats.',
        dql: `fetch events, from:${timeframe}\n| filter event.kind == "SECURITY_EVENT"\n| summarize count = count(), by:{event.name}\n| sort count desc\n| limit 15` },
      { id: 'sec-affected-entities', title: 'Affected Entities', vizType: 'categoricalBar', width: 1, icon: '🎯', accent: '#f59e0b', desc: 'Entities most frequently targeted by security events — harden these high-risk assets first.',
        dql: `fetch events, from:${timeframe}\n| filter event.kind == "SECURITY_EVENT"\n| expand affected_entity_ids\n| summarize count = count(), by:{affected_entity_ids}\n| sort count desc\n| limit 15` },

      // ── ATTACK ANALYSIS ──
      { id: 'sec-attack-banner', title: 'ATTACK ANALYSIS', vizType: 'sectionBanner', width: 3, icon: '⚔️', accent: '#ae132d', dql: '' },
      { id: 'sec-attack-ts', title: 'Attack Events Over Time', vizType: 'timeseries', width: 2, icon: '📈', accent: '#ae132d', desc: 'Attack event trend line — rising volumes warrant immediate investigation and potential incident response.',
        dql: `fetch events, from:${timeframe}\n| filter event.kind == "SECURITY_EVENT"\n| filter event.category == "ATTACK"\n| makeTimeseries count = count()` },
      { id: 'sec-attack-types', title: 'Attack Types', vizType: 'donut', width: 1, icon: '🎯', accent: '#ae132d', desc: 'Breakdown of attack techniques (SQL injection, XSS, etc.) — understand your attack surface.',
        dql: `fetch events, from:${timeframe}\n| filter event.kind == "SECURITY_EVENT"\n| filter event.category == "ATTACK"\n| summarize count = count(), by:{event.name}\n| sort count desc\n| limit 10` },
    ];

    /* ══════════════════════════════════════════════════════════════
       SRE / RELIABILITY — Availability · Error Budget · SLOs ·
                           Percentiles · Deployments
       ══════════════════════════════════════════════════════════════ */
    case 'sre': return [
      // ── RELIABILITY OVERVIEW ──
      { id: 'sre-overview-banner', title: 'RELIABILITY OVERVIEW', vizType: 'sectionBanner', width: 3, icon: '📋', accent: '#06b6d4', dql: '' },
      { id: 'sre-availability', title: 'Overall Availability %', vizType: 'heroMetric', width: 1, icon: '✅', accent: '#10b981', desc: 'Fleet-wide availability calculated from request success ratio — your primary SLO target metric.',
        dql: `timeseries requests = sum(dt.service.request.count), errors = sum(dt.service.request.failure_count), from:${timeframe}\n| fieldsAdd r = arraySum(requests), e = arraySum(errors)\n| summarize totalR = sum(r), totalE = sum(e)\n| fieldsAdd availability = round(100.0 * (1.0 - toDouble(totalE) / toDouble(totalR)), decimals:3)` },
      { id: 'sre-error-rate', title: 'Global Error Rate %', vizType: 'heroMetric', width: 1, icon: '⚠️', accent: '#e74c3c', desc: 'Overall error rate across all services — the inverse of availability; budget burn rate for your error SLO.',
        dql: `timeseries requests = sum(dt.service.request.count), errors = sum(dt.service.request.failure_count), from:${timeframe}\n| fieldsAdd r = arraySum(requests), e = arraySum(errors)\n| summarize totalR = sum(r), totalE = sum(e)\n| fieldsAdd errorRate = round(100.0 * toDouble(totalE) / toDouble(totalR), decimals:3)` },
      { id: 'sre-service-count', title: 'Total Services', vizType: 'heroMetric', width: 1, icon: '🔧', accent: '#06b6d4', desc: 'Number of instrumented services reporting metrics — your observability coverage footprint.',
        dql: `timeseries r = sum(dt.service.request.count), by:{dt.entity.service}, from:${timeframe}\n| summarize serviceCount = count()` },

      // ── AVAILABILITY TREND ──
      { id: 'sre-trend-banner', title: 'AVAILABILITY TREND', vizType: 'sectionBanner', width: 3, icon: '📈', accent: '#10b981', dql: '' },
      { id: 'sre-avail-ts', title: 'Availability Over Time', vizType: 'timeseries', width: 2, icon: '📈', accent: '#10b981', desc: 'Availability trend — dips below your SLO target indicate error budget consumption and potential customer impact.',
        dql: `timeseries requests = sum(dt.service.request.count), errors = sum(dt.service.request.failure_count), from:${timeframe}\n| fieldsAdd availability = 100.0 * (requests[] - errors[]) / requests[]\n| fields timeframe, interval, availability` },
      { id: 'sre-error-ts', title: 'Error Rate Over Time', vizType: 'timeseries', width: 1, icon: '📉', accent: '#e74c3c', desc: 'Error rate trend — the mirror of availability; sharp spikes correspond to incidents visible to users.',
        dql: `timeseries requests = sum(dt.service.request.count), errors = sum(dt.service.request.failure_count), from:${timeframe}\n| fieldsAdd errorRate = 100.0 * errors[] / requests[]\n| fields timeframe, interval, errorRate` },

      // ── LATENCY PERCENTILES ──
      { id: 'sre-lat-banner', title: 'LATENCY PERCENTILES', vizType: 'sectionBanner', width: 3, icon: '⏱️', accent: '#f59e0b', dql: '' },
      { id: 'sre-p50-ts', title: 'Global p50 Latency', vizType: 'timeseries', width: 1, icon: '⏱️', accent: '#f1c40f', desc: 'Median (p50) response time — represents the typical user experience; most users see this latency or better.',
        dql: `timeseries p50 = median(dt.service.request.response_time), from:${timeframe}` },
      { id: 'sre-p90-ts', title: 'Global p90 Latency', vizType: 'timeseries', width: 1, icon: '⏱️', accent: '#eca440', desc: '90th percentile latency — 1 in 10 users experience this or worse; a key SLO boundary for latency targets.',
        dql: `timeseries p90 = percentile(dt.service.request.response_time, 90), from:${timeframe}` },
      { id: 'sre-p99-ts', title: 'Global p99 Latency', vizType: 'timeseries', width: 1, icon: '⏱️', accent: '#c4233b', desc: '99th percentile latency — the tail latency that affects your most unlucky 1% of users; critical for SLO compliance.',
        dql: `timeseries p99 = percentile(dt.service.request.response_time, 99), from:${timeframe}` },
      { id: 'sre-lat-table', title: 'Service Latency Percentiles', vizType: 'table', width: 3, icon: '📋', accent: '#f59e0b', desc: 'Per-service latency percentiles with deep links — identify which services contribute most to tail latency.',
        dql: `timeseries {p50 = median(dt.service.request.response_time), p90 = percentile(dt.service.request.response_time, 90), p99 = percentile(dt.service.request.response_time, 99), requests = sum(dt.service.request.count)}, by:{dt.entity.service}, from:${timeframe}\n| fieldsAdd ServiceName = lower(entityName(dt.entity.service))${svcFSN}\n| fieldsAdd Service = concat("[", ServiceName, "](${TENANT_BASE}/ui/apps/dynatrace.services/explorer?detailsId=", dt.entity.service, ")")\n| fieldsAdd P50 = round(arrayAvg(p50), decimals:0), P90 = round(arrayAvg(p90), decimals:0), P99 = round(arrayAvg(p99), decimals:0), Requests = arraySum(requests)\n| fields Service, Requests, P50, P90, P99\n| sort P99 desc\n| limit 25` },

      // ── SERVICE RELIABILITY RANKING ──
      { id: 'sre-rank-banner', title: 'SERVICE RELIABILITY RANKING', vizType: 'sectionBanner', width: 3, icon: '🏆', accent: '#06b6d4', dql: '' },
      { id: 'sre-rank-table', title: 'Services by Reliability', vizType: 'table', width: 3, icon: '🏆', accent: '#06b6d4', desc: 'Service reliability leaderboard — sorted by availability to spotlight the weakest links in your chain.',
        dql: `timeseries {requests = sum(dt.service.request.count), errors = sum(dt.service.request.failure_count)}, by:{dt.entity.service}, from:${timeframe}\n| fieldsAdd ServiceName = lower(entityName(dt.entity.service))${svcFSN}\n| fieldsAdd Service = concat("[", ServiceName, "](${TENANT_BASE}/ui/apps/dynatrace.services/explorer?detailsId=", dt.entity.service, ")")\n| fieldsAdd TotalRequests = arraySum(requests), TotalErrors = arraySum(errors)\n| fieldsAdd ErrorRate = round((TotalErrors / TotalRequests) * 100, decimals:3)\n| fieldsAdd Availability = round(100 - ErrorRate, decimals:3)\n| fields Service, TotalRequests, TotalErrors, ErrorRate, Availability\n| sort Availability asc\n| limit 25` },
      { id: 'sre-worst-svc', title: 'Worst Error Rates', vizType: 'categoricalBar', width: 2, icon: '⚠️', accent: '#e74c3c', desc: 'Services with the highest error rates — these are consuming the most error budget and need priority attention.',
        dql: `timeseries {requests = sum(dt.service.request.count), errors = sum(dt.service.request.failure_count)}, by:{dt.entity.service}, from:${timeframe}\n| fieldsAdd service = lower(entityName(dt.entity.service))${svcF}\n| fieldsAdd totalR = arraySum(requests), totalE = arraySum(errors)\n| fieldsAdd errorRate = round((totalE / totalR) * 100, decimals:2)\n| fields service, errorRate\n| sort errorRate desc\n| limit 15` },
      { id: 'sre-svc-req-dist', title: 'Request Volume by Service', vizType: 'donut', width: 1, icon: '📊', accent: '#06b6d4', desc: 'Traffic distribution across services — weight error rates by volume to understand true user impact.',
        dql: `timeseries requests = sum(dt.service.request.count), by:{dt.entity.service}, from:${timeframe}\n| fieldsAdd service = lower(entityName(dt.entity.service))${svcF}\n| fieldsAdd total = arraySum(requests)\n| fields service, total\n| sort total desc\n| limit 15` },

      // ── HTTP STATUS CODES ──
      { id: 'sre-http-banner', title: 'HTTP STATUS CODES', vizType: 'sectionBanner', width: 3, icon: '🌐', accent: '#3498db', dql: '' },
      { id: 'sre-2xx-ts', title: '2xx Success', vizType: 'timeseries', width: 1, icon: '✅', accent: '#10b981', desc: 'Successful 2xx response volume — the happy path; this should dominate your HTTP status mix.',
        dql: `timeseries success = sum(dt.service.request.count), from:${timeframe}, filter: http.response.status_code >= 200 and http.response.status_code <= 299` },
      { id: 'sre-4xx-ts', title: '4xx Client Errors', vizType: 'timeseries', width: 1, icon: '🟠', accent: '#f59e0b', desc: 'Client error volume — broken links, auth failures, or API misuse; often caused by frontend changes.',
        dql: `timeseries clientErrors = sum(dt.service.request.count), from:${timeframe}, filter: http.response.status_code >= 400 and http.response.status_code <= 499` },
      { id: 'sre-5xx-ts', title: '5xx Server Errors', vizType: 'timeseries', width: 1, icon: '🔴', accent: '#e74c3c', desc: 'Server error volume — 5xx errors indicate backend failures; direct availability impact.',
        dql: `timeseries serverErrors = sum(dt.service.request.count), from:${timeframe}, filter: http.response.status_code >= 500 and http.response.status_code <= 599` },

      // ── PROBLEMS IMPACTING SRE ──
      { id: 'sre-problem-banner', title: 'PROBLEMS IMPACTING RELIABILITY', vizType: 'sectionBanner', width: 3, icon: '🔥', accent: '#e74c3c', dql: '' },
      { id: 'sre-problems-table', title: 'Active Problems', vizType: 'table', width: 3, icon: '🔥', accent: '#e74c3c', desc: 'Current Dynatrace Intelligence problems with root cause and affected services — the SRE’s incident response view.',
        dql: `fetch dt.davis.problems, from:${timeframe}\n| filter dt.davis.is_duplicate == false\n| sort timestamp desc\n| expand affected_entity_ids\n| lookup [fetch dt.entity.service], sourceField:affected_entity_ids, lookupField:id, prefix:"svc."\n| summarize {startTime = takeFirst(event.start), status = takeFirst(event.status), eventName = takeFirst(event.name), rootCause = takeFirst(root_cause_entity_name), affectedServices = collectDistinct(svc.entity.name), eventId = takeFirst(event.id)}, by:{display_id, event.kind}\n| fieldsAdd Problem = concat("[", display_id, " - ", eventName, "](${TENANT_BASE}/ui/apps/dynatrace.davis.problems/problem/", eventId, ")")\n| fields Status = status, Problem, RootCause = rootCause, AffectedServices = affectedServices, StartTime = startTime\n| sort StartTime desc\n| limit 25` },
    ];

    /* ══════════════════════════════════════════════════════════════
       BIZ EVENTS — Event Volume · Types · Errors · Journeys ·
                    Services · Companies
       ══════════════════════════════════════════════════════════════ */
    case 'logs': return [
      // ── EVENT OVERVIEW ──
      { id: 'log-overview-banner', title: 'EVENT OVERVIEW', vizType: 'sectionBanner', width: 3, icon: '📝', accent: '#8b5cf6', dql: '' },
      { id: 'log-total', title: 'Total Events', vizType: 'heroMetric', width: 1, icon: '📝', accent: '#8b5cf6', desc: 'Total business event count for the selected period — the baseline throughput measure for your event pipeline.',
        dql: `${b}\n| summarize totalEvents = count()` },
      { id: 'log-errors', title: 'Error Events', vizType: 'heroMetric', width: 1, icon: '❌', accent: '#e74c3c', desc: 'Business events flagged with errors — each represents a disrupted customer journey or failed transaction.',
        dql: `${b}\n| filter json.hasError == true\n| summarize errorEvents = count()` },
      { id: 'log-types', title: 'Unique Event Types', vizType: 'heroMetric', width: 1, icon: '🏷️', accent: '#f59e0b', desc: 'Count of distinct event types being captured — measures the richness of your business event instrumentation.',
        dql: `${b}\n| summarize types = countDistinct(event.type)` },

      // ── EVENT VOLUME ──
      { id: 'log-volume-banner', title: 'EVENT VOLUME', vizType: 'sectionBanner', width: 3, icon: '📊', accent: '#8b5cf6', dql: '' },
      { id: 'log-volume-ts', title: 'Event Volume Over Time', vizType: 'timeseries', width: 2, icon: '📈', accent: '#8b5cf6', desc: 'Event ingestion rate trend — flat-lines may indicate pipeline issues; spikes correlate with traffic bursts.',
        dql: `${b}\n| makeTimeseries count = count()` },
      { id: 'log-type-dist', title: 'Events by Type', vizType: 'donut', width: 1, icon: '🎯', accent: '#8b5cf6', desc: 'Proportional breakdown of event types — understand the composition of your business event stream.',
        dql: `${b}\n| summarize count = count(), by:{event.type}\n| sort count desc` },
      { id: 'log-by-type-ts', title: 'Volume by Type', vizType: 'timeseries', width: 2, icon: '📊', accent: '#e74c3c', desc: 'Per-type event volume trend — reveals which event types drive the most traffic over time.',
        dql: `${b}\n| makeTimeseries count = count(), by:{event.type}` },
      { id: 'log-by-service', title: 'Events by Service', vizType: 'categoricalBar', width: 1, icon: '🔧', accent: '#06b6d4', desc: 'Event volume per service — identifies your busiest services from a business event perspective.',
        dql: `${b}\n| summarize count = count(), by:{json.serviceName}\n| sort count desc\n| limit 15` },

      // ── ERROR ANALYSIS ──
      { id: 'log-error-banner', title: 'ERROR ANALYSIS', vizType: 'sectionBanner', width: 3, icon: '🔍', accent: '#e74c3c', dql: '' },
      { id: 'log-error-table', title: 'Recent Error Events', vizType: 'table', width: 3, icon: '❌', accent: '#e74c3c', desc: 'Latest error events with service, journey, step, and company context — your error investigation starting point.',
        dql: `${b}\n| filter json.hasError == true\n| fields Time = timestamp, Service = json.serviceName, Journey = json.journeyType, Step = json.stepName, Company = json.companyName, Type = event.type\n| sort Time desc\n| limit 100` },
      { id: 'log-error-by-service', title: 'Errors by Service', vizType: 'categoricalBar', width: 2, icon: '🐛', accent: '#e74c3c', desc: 'Error distribution by service — the tallest bars indicate the most problematic services for your business events.',
        dql: `${b}\n| filter json.hasError == true\n| summarize count = count(), by:{json.serviceName}\n| sort count desc\n| limit 15` },
      { id: 'log-error-by-journey', title: 'Errors by Journey', vizType: 'donut', width: 1, icon: '🛣️', accent: '#e74c3c', desc: 'Which journey types generate the most errors — focus improvement efforts on the highest-error journeys.',
        dql: `${b}\n| filter json.hasError == true\n| summarize count = count(), by:{json.journeyType}\n| sort count desc\n| limit 10` },

      // ── EVENT BREAKDOWN ──
      { id: 'log-breakdown-banner', title: 'EVENT BREAKDOWN', vizType: 'sectionBanner', width: 3, icon: '🔗', accent: '#06b6d4', dql: '' },
      { id: 'log-errors-ts', title: 'Error Events Over Time', vizType: 'timeseries', width: 2, icon: '❌', accent: '#e74c3c', desc: 'Error event volume trend — correlate spikes with deployments, config changes, or traffic surges.',
        dql: `${b}\n| makeTimeseries errors = countIf(json.hasError == true)` },
      { id: 'log-by-journey', title: 'Events by Journey', vizType: 'categoricalBar', width: 1, icon: '🛣️', accent: '#a78bfa', desc: 'Event distribution by journey type — shows which customer journeys generate the most activity.',
        dql: `${b}\n| summarize count = count(), by:{json.journeyType}\n| sort count desc\n| limit 15` },
      { id: 'log-by-step', title: 'Events by Step', vizType: 'categoricalBar', width: 2, icon: '👣', accent: '#8b5cf6', desc: 'Event volume per journey step — high-volume steps are the most critical touchpoints in your customer flow.',
        dql: `${b}\n| summarize count = count(), by:{json.stepName}\n| sort count desc\n| limit 15` },
      { id: 'log-by-company', title: 'Events by Company', vizType: 'categoricalBar', width: 1, icon: '🏢', accent: '#a78bfa', desc: 'Event volume per company — identifies your most active tenants or business units.',
        dql: `${b}\n| summarize count = count(), by:{json.companyName}\n| sort count desc\n| limit 15` },

      // ── EVENT DETAILS ──
      { id: 'log-detail-banner', title: 'EVENT DETAILS', vizType: 'sectionBanner', width: 3, icon: '📋', accent: '#a78bfa', dql: '' },
      { id: 'log-detail-table', title: 'Event Detail Table', vizType: 'table', width: 3, icon: '📋', accent: '#a78bfa', desc: 'Full event detail view with all key fields — the comprehensive audit trail for your business events.',
        dql: `${b}\n| fields Time = timestamp, Type = event.type, Service = json.serviceName, Journey = json.journeyType, Step = json.stepName, Company = json.companyName, Error = json.hasError\n| sort Time desc\n| limit 100` },
    ];

    /* ══════════════════════════════════════════════════════════════
       VCARB RACE OPS — Lap Performance · Tyres · ERS · Pit Stops ·
                         Positions · Weather · Telemetry Pipeline
       ══════════════════════════════════════════════════════════════ */
    case 'vcarb': return [
      // ── RACE OVERVIEW ──
      { id: 'vc-overview-banner', title: 'RACE OVERVIEW', vizType: 'sectionBanner', width: 3, icon: '🏁', accent: '#e10600', dql: '' },
      { id: 'vc-total-events', title: 'Total Telemetry Events', vizType: 'heroMetric', width: 1, icon: '📡', accent: '#e10600', desc: 'Total business events generated across the race weekend — measures overall telemetry pipeline throughput.',
        dql: `${b}\n| summarize totalEvents = count()` },
      { id: 'vc-pos-car30', title: 'Car #30 Position', vizType: 'heroMetric', width: 1, icon: '🏎️', accent: '#1e3a5f', desc: 'Latest race position for Liam Lawson (#30) — lower is better.',
        dql: `${b}\n| filter isNotNull(additionalfields.positionCar30)\n| sort timestamp desc\n| fieldsAdd pos = toDouble(additionalfields.positionCar30)\n| summarize latestPos = last(pos)` },
      { id: 'vc-pos-car41', title: 'Car #41 Position', vizType: 'heroMetric', width: 1, icon: '🏎️', accent: '#e10600', desc: 'Latest race position for Arvid Lindblad (#41) — lower is better.',
        dql: `${b}\n| filter isNotNull(additionalfields.positionCar41)\n| sort timestamp desc\n| fieldsAdd pos = toDouble(additionalfields.positionCar41)\n| summarize latestPos = last(pos)` },

      // ── LAP PERFORMANCE ──
      { id: 'vc-lap-banner', title: 'LAP PERFORMANCE', vizType: 'sectionBanner', width: 3, icon: '⏱️', accent: '#f5a623', dql: '' },
      { id: 'vc-avg-lap', title: 'Avg Lap Time (sec)', vizType: 'heroMetric', width: 1, icon: '⏱️', accent: '#f5a623', desc: 'Average lap time across all events — the primary pace indicator for the session.',
        dql: `${b}\n| filter isNotNull(additionalfields.lapTimeSec)\n| summarize avgLap = round(avg(toDouble(additionalfields.lapTimeSec)), decimals:3)` },
      { id: 'vc-best-lap', title: 'Best Lap Time (sec)', vizType: 'heroMetric', width: 1, icon: '🏆', accent: '#27ae60', desc: 'Fastest lap recorded in the period — benchmark for qualifying and race pace targets.',
        dql: `${b}\n| filter isNotNull(additionalfields.lapTimeSec)\n| summarize bestLap = round(min(toDouble(additionalfields.lapTimeSec)), decimals:3)` },
      { id: 'vc-top-speed', title: 'Max Top Speed (kph)', vizType: 'heroMetric', width: 1, icon: '💨', accent: '#3498db', desc: 'Highest top speed trap reading — indicates power unit performance and drag efficiency.',
        dql: `${b}\n| filter isNotNull(additionalfields.topSpeedKph)\n| summarize maxSpeed = round(max(toDouble(additionalfields.topSpeedKph)), decimals:1)` },
      { id: 'vc-lap-ts', title: 'Lap Times Over Time', vizType: 'timeseries', width: 2, icon: '📈', accent: '#f5a623', desc: 'Lap time trend — track pace evolution through stints, tyre degradation, and fuel burn.',
        dql: `${b}\n| filter isNotNull(additionalfields.lapTimeSec)\n| makeTimeseries lapTime = avg(toDouble(additionalfields.lapTimeSec))` },
      { id: 'vc-sectors', title: 'Sector Times', vizType: 'categoricalBar', width: 1, icon: '🔀', accent: '#e67e22', desc: 'Average sector split times — reveals which parts of the circuit offer the most time gain.',
        dql: `${b}\n| filter isNotNull(additionalfields.sectorOneTimeSec)\n| summarize S1 = round(avg(toDouble(additionalfields.sectorOneTimeSec)), decimals:3), S2 = round(avg(toDouble(additionalfields.sectorTwoTimeSec)), decimals:3), S3 = round(avg(toDouble(additionalfields.sectorThreeTimeSec)), decimals:3)\n| fieldsAdd record(Sector1 = S1, Sector2 = S2, Sector3 = S3)` },

      // ── TYRE MANAGEMENT ──
      { id: 'vc-tyre-banner', title: 'TYRE MANAGEMENT', vizType: 'sectionBanner', width: 3, icon: '🛞', accent: '#a78bfa', dql: '' },
      { id: 'vc-tyre-temp-ts', title: 'Tyre Surface Temps (°C)', vizType: 'timeseries', width: 2, icon: '🌡️', accent: '#e74c3c', desc: 'Surface temperature across all four tyres — optimal window is critical for grip and degradation management.',
        dql: `${b}\n| filter isNotNull(additionalfields.tyreSurfaceTempFL)\n| makeTimeseries FL = avg(toDouble(additionalfields.tyreSurfaceTempFL)), FR = avg(toDouble(additionalfields.tyreSurfaceTempFR)), RL = avg(toDouble(additionalfields.tyreSurfaceTempRL)), RR = avg(toDouble(additionalfields.tyreSurfaceTempRR))` },
      { id: 'vc-tyre-wear', title: 'Tyre Wear %', vizType: 'timeseries', width: 1, icon: '📉', accent: '#a78bfa', desc: 'Tyre wear progression per corner — determines pit window timing and strategy calls.',
        dql: `${b}\n| filter isNotNull(additionalfields.tyreWearPercentFL)\n| makeTimeseries FL = avg(toDouble(additionalfields.tyreWearPercentFL)), FR = avg(toDouble(additionalfields.tyreWearPercentFR)), RL = avg(toDouble(additionalfields.tyreWearPercentRL)), RR = avg(toDouble(additionalfields.tyreWearPercentRR))` },
      { id: 'vc-tyre-pressure', title: 'Tyre Pressures (PSI)', vizType: 'timeseries', width: 2, icon: '🎈', accent: '#3498db', desc: 'Tyre pressure trend across all four corners — pressure rise indicates overheating; drops signal puncture risk.',
        dql: `${b}\n| filter isNotNull(additionalfields.tyrePressurePsiFL)\n| makeTimeseries FL = avg(toDouble(additionalfields.tyrePressurePsiFL)), FR = avg(toDouble(additionalfields.tyrePressurePsiFR)), RL = avg(toDouble(additionalfields.tyrePressurePsiRL)), RR = avg(toDouble(additionalfields.tyrePressurePsiRR))` },
      { id: 'vc-brake-temps', title: 'Brake Disc Temps (°C)', vizType: 'timeseries', width: 1, icon: '🔥', accent: '#e74c3c', desc: 'Front and rear brake disc temperatures — excessive heat causes brake fade and increased stopping distance.',
        dql: `${b}\n| filter isNotNull(additionalfields.brakeDiscTempFrontC)\n| makeTimeseries Front = avg(toDouble(additionalfields.brakeDiscTempFrontC)), Rear = avg(toDouble(additionalfields.brakeDiscTempRearC))` },

      // ── POWER UNIT & ERS ──
      { id: 'vc-pu-banner', title: 'POWER UNIT & ERS', vizType: 'sectionBanner', width: 3, icon: '⚡', accent: '#10b981', dql: '' },
      { id: 'vc-ers-charge', title: 'ERS State of Charge %', vizType: 'timeseries', width: 1, icon: '🔋', accent: '#10b981', desc: 'Energy Recovery System charge level — managing deployment vs harvesting is key to overtake and defence strategy.',
        dql: `${b}\n| filter isNotNull(additionalfields.ersStateOfChargePercent)\n| makeTimeseries ersCharge = avg(toDouble(additionalfields.ersStateOfChargePercent))` },
      { id: 'vc-ers-flow', title: 'ERS Deploy vs Harvest (kW)', vizType: 'timeseries', width: 1, icon: '⚡', accent: '#f59e0b', desc: 'Energy deployment and harvesting rates — balance determines available boost per lap.',
        dql: `${b}\n| filter isNotNull(additionalfields.ersDeployKW)\n| makeTimeseries deploy = avg(toDouble(additionalfields.ersDeployKW)), harvest = avg(toDouble(additionalfields.ersHarvestKW))` },
      { id: 'vc-engine-rpm', title: 'Engine RPM', vizType: 'timeseries', width: 1, icon: '🔧', accent: '#e67e22', desc: 'Engine RPM trend — sustained high RPM indicates full-power mode; dips may signal lift-and-coast fuel saving.',
        dql: `${b}\n| filter isNotNull(additionalfields.engineRPM)\n| makeTimeseries rpm = avg(toDouble(additionalfields.engineRPM))` },
      { id: 'vc-fuel', title: 'Fuel Remaining (kg)', vizType: 'timeseries', width: 1, icon: '⛽', accent: '#06b6d4', desc: 'Fuel load trend — must reach zero at the finish with minimum margin for weight optimisation.',
        dql: `${b}\n| filter isNotNull(additionalfields.fuelRemainingKg)\n| makeTimeseries fuel = avg(toDouble(additionalfields.fuelRemainingKg))` },
      { id: 'vc-engine-temps', title: 'Engine Temps (°C)', vizType: 'timeseries', width: 1, icon: '🌡️', accent: '#e74c3c', desc: 'Oil and coolant temperature — overheating triggers engine mode restrictions or retirement.',
        dql: `${b}\n| filter isNotNull(additionalfields.engineTempOilC)\n| makeTimeseries Oil = avg(toDouble(additionalfields.engineTempOilC)), Coolant = avg(toDouble(additionalfields.engineTempCoolantC))` },
      { id: 'vc-fuel-burn', title: 'Fuel Burn Rate (kg/lap)', vizType: 'heroMetric', width: 1, icon: '🔥', accent: '#f59e0b', desc: 'Average fuel consumption per lap — informs lift-and-coast strategy and pit window calculations.',
        dql: `${b}\n| filter isNotNull(additionalfields.fuelBurnRateKgPerLap)\n| summarize avgBurn = round(avg(toDouble(additionalfields.fuelBurnRateKgPerLap)), decimals:2)` },

      // ── PIT STOP OPERATIONS ──
      { id: 'vc-pit-banner', title: 'PIT STOP OPERATIONS', vizType: 'sectionBanner', width: 3, icon: '🔧', accent: '#8b5cf6', dql: '' },
      { id: 'vc-pit-avg', title: 'Avg Pit Stop Time (sec)', vizType: 'heroMetric', width: 1, icon: '⏱️', accent: '#8b5cf6', desc: 'Average stationary pit stop time — sub-2.5s is elite; slow stops lose positions and race outcomes.',
        dql: `${b}\n| filter isNotNull(additionalfields.pitStopTimeSec)\n| summarize avgPit = round(avg(toDouble(additionalfields.pitStopTimeSec)), decimals:2)` },
      { id: 'vc-pit-best', title: 'Best Pit Stop (sec)', vizType: 'heroMetric', width: 1, icon: '🏆', accent: '#27ae60', desc: 'Fastest pit stop execution — represents crew peak performance under race pressure.',
        dql: `${b}\n| filter isNotNull(additionalfields.pitStopTimeSec)\n| summarize bestPit = round(min(toDouble(additionalfields.pitStopTimeSec)), decimals:2)` },
      { id: 'vc-pit-crew', title: 'Crew Readiness %', vizType: 'heroMetric', width: 1, icon: '👷', accent: '#3498db', desc: 'Pit crew readiness index — low readiness correlates with slower stops and increased fumble risk.',
        dql: `${b}\n| filter isNotNull(additionalfields.pitCrewReadinessPercent)\n| summarize readiness = round(avg(toDouble(additionalfields.pitCrewReadinessPercent)), decimals:1)` },

      // ── RACE POSITIONS & STRATEGY ──
      { id: 'vc-pos-banner', title: 'RACE POSITIONS & STRATEGY', vizType: 'sectionBanner', width: 3, icon: '🏁', accent: '#1e3a5f', dql: '' },
      { id: 'vc-pos-ts', title: 'Position Tracking', vizType: 'timeseries', width: 2, icon: '📊', accent: '#1e3a5f', desc: 'Race position for both cars over time — visualise overtakes, undercuts, and strategy calls.',
        dql: `${b}\n| filter isNotNull(additionalfields.positionCar30)\n| makeTimeseries Car30 = avg(toDouble(additionalfields.positionCar30)), Car41 = avg(toDouble(additionalfields.positionCar41))` },
      { id: 'vc-gap-leader', title: 'Gap to Leader (sec)', vizType: 'timeseries', width: 1, icon: '📏', accent: '#e67e22', desc: 'Time gap to the race leader — decreasing gaps indicate a charge through the field.',
        dql: `${b}\n| filter isNotNull(additionalfields.gapToLeaderSec)\n| makeTimeseries gapToLeader = avg(toDouble(additionalfields.gapToLeaderSec))` },
      { id: 'vc-overtakes', title: 'Overtake Success Rate', vizType: 'heroMetric', width: 1, icon: '🏎️', accent: '#27ae60', desc: 'Percentage of overtake attempts that succeeded — a key indicator of race-craft and car pace advantage.',
        dql: `${b}\n| filter isNotNull(additionalfields.overtakeAttempts)\n| summarize attempts = sum(toDouble(additionalfields.overtakeAttempts)), success = sum(toDouble(additionalfields.overtakeSuccessful))\n| fieldsAdd rate = round(100.0 * success / attempts, decimals:1)` },
      { id: 'vc-drs', title: 'DRS Activations / Lap', vizType: 'heroMetric', width: 1, icon: '📡', accent: '#3498db', desc: 'Average DRS activations per lap — more activations indicate proximity to cars ahead and overtaking opportunity.',
        dql: `${b}\n| filter isNotNull(additionalfields.drsActivationsPerLap)\n| summarize avgDRS = round(avg(toDouble(additionalfields.drsActivationsPerLap)), decimals:1)` },
      { id: 'vc-gap-ahead', title: 'Gap to Car Ahead (sec)', vizType: 'timeseries', width: 1, icon: '📏', accent: '#a78bfa', desc: 'Time gap to the car immediately ahead — under 1 second enables DRS activation.',
        dql: `${b}\n| filter isNotNull(additionalfields.gapToCarAheadSec)\n| makeTimeseries gapAhead = avg(toDouble(additionalfields.gapToCarAheadSec))` },

      // ── WEATHER & TRACK CONDITIONS ──
      { id: 'vc-wx-banner', title: 'WEATHER & TRACK CONDITIONS', vizType: 'sectionBanner', width: 3, icon: '🌤️', accent: '#06b6d4', dql: '' },
      { id: 'vc-track-temp', title: 'Track & Ambient Temp (°C)', vizType: 'timeseries', width: 1, icon: '🌡️', accent: '#e74c3c', desc: 'Track surface and air temperature — directly affects tyre grip, degradation rate, and engine cooling.',
        dql: `${b}\n| filter isNotNull(additionalfields.trackTempC)\n| makeTimeseries Track = avg(toDouble(additionalfields.trackTempC)), Ambient = avg(toDouble(additionalfields.ambientTempC))` },
      { id: 'vc-wind', title: 'Wind Speed (kph)', vizType: 'timeseries', width: 1, icon: '💨', accent: '#06b6d4', desc: 'Wind speed trend — headwinds reduce top speed; crosswinds affect aero balance and car stability.',
        dql: `${b}\n| filter isNotNull(additionalfields.windSpeedKph)\n| makeTimeseries wind = avg(toDouble(additionalfields.windSpeedKph))` },
      { id: 'vc-rain', title: 'Rain Probability %', vizType: 'heroMetric', width: 1, icon: '🌧️', accent: '#3498db', desc: 'Current rain probability — triggers strategic decisions on tyre compound, pit timing, and setup changes.',
        dql: `${b}\n| filter isNotNull(additionalfields.rainProbabilityPercent)\n| sort timestamp desc\n| summarize rainProb = last(toDouble(additionalfields.rainProbabilityPercent))` },

      // ── TELEMETRY PIPELINE ──
      { id: 'vc-tel-banner', title: 'TELEMETRY PIPELINE', vizType: 'sectionBanner', width: 3, icon: '📡', accent: '#f59e0b', dql: '' },
      { id: 'vc-tel-latency', title: 'Telemetry Latency (ms)', vizType: 'timeseries', width: 1, icon: '⏱️', accent: '#f59e0b', desc: 'End-to-end latency from car sensors to pit wall — low latency is critical for real-time strategy decisions.',
        dql: `${b}\n| filter isNotNull(additionalfields.telemetryLatencyMs)\n| makeTimeseries latency = avg(toDouble(additionalfields.telemetryLatencyMs))` },
      { id: 'vc-tel-channels', title: 'Active Channels', vizType: 'heroMetric', width: 1, icon: '📊', accent: '#10b981', desc: 'Number of active telemetry channels — full channel count confirms car-to-pit data link health.',
        dql: `${b}\n| filter isNotNull(additionalfields.telemetryChannelsActive)\n| sort timestamp desc\n| summarize channels = last(toDouble(additionalfields.telemetryChannelsActive))` },
      { id: 'vc-tel-data-rate', title: 'Data Rate (Gbps)', vizType: 'heroMetric', width: 1, icon: '🌐', accent: '#06b6d4', desc: 'Telemetry data throughput — drops indicate bandwidth issues or sensor failures on the car.',
        dql: `${b}\n| filter isNotNull(additionalfields.dataRateGbps)\n| sort timestamp desc\n| summarize dataRate = last(toDouble(additionalfields.dataRateGbps))` },

      // ── RACE EVENT TABLE ──
      { id: 'vc-events-banner', title: 'RACE EVENT LOG', vizType: 'sectionBanner', width: 3, icon: '📋', accent: '#e10600', dql: '' },
      { id: 'vc-event-table', title: 'Race Weekend Event Log', vizType: 'table', width: 3, icon: '📋', accent: '#e10600', desc: 'Full event log with step, service, lap time, position, and tyre compound — the complete race weekend audit trail.',
        dql: `${b}\n| fields Time = timestamp, Step = json.stepName, Service = json.serviceName, LapTime = additionalfields.lapTimeSec, TopSpeed = additionalfields.topSpeedKph, Pos30 = additionalfields.positionCar30, Pos41 = additionalfields.positionCar41, Compound = additionalfields.tyreCompound, Fuel = additionalfields.fuelRemainingKg\n| sort Time desc\n| limit 100` },
    ];

    default: return [];
  }
}

/* ═══════════════════════════════════════════════════════════════
   FIELD-AWARE TILE FILTER
   If no profile yet (still discovering), show all tiles.
   Once profile arrives, filter tiles to only those whose required
   fields are present with real data values.
   ═══════════════════════════════════════════════════════════════ */

function filterTiles(candidates: TileCandidate[], profile: FieldProfile | null): TileDefinition[] {
  if (!profile) return candidates; // before discovery completes, show everything

  return candidates.filter((tile) => {
    // Check numeric requirements
    if (tile.requiresNumeric?.length) {
      const numOk = tile.requiresNumeric.every((f) => profile.numericFields.has(f));
      if (!numOk) return false;
    }
    // Check categorical requirements
    if (tile.requiresCategorical?.length) {
      const catOk = tile.requiresCategorical.every((f) => profile.categoricalFields.has(f));
      if (!catOk) return false;
    }
    return true;
  });
}

/* ═══════════════════════════════════════════════════════════════
   SECTION BANNER COMPONENT — visual section headers (no DQL query)
   ═══════════════════════════════════════════════════════════════ */

function SectionBanner({ tile }: { tile: TileDefinition }) {
  const accent = tile.accent || '#4fc3f7';
  return (
    <div style={{
      gridColumn: '1 / -1',
      padding: '10px 18px',
      background: `linear-gradient(135deg, ${accent}15, ${accent}05)`,
      border: `1px solid ${accent}33`,
      borderLeft: `4px solid ${accent}`,
      borderRadius: 8,
      display: 'flex',
      alignItems: 'center',
      gap: 10,
    }}>
      <span style={{ fontSize: 16 }}>{tile.icon}</span>
      <span style={{ color: accent, fontWeight: 700, fontSize: 13, letterSpacing: '0.05em' }}>{tile.title}</span>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   DQL TILE COMPONENT
   ═══════════════════════════════════════════════════════════════ */

function DqlTile({ tile, timeframe }: { tile: TileDefinition; timeframe: Timeframe }) {
  const [showDql, setShowDql] = useState(false);
  const [copied, setCopied] = useState(false);

  const { data, isLoading, isError, error } = useDqlQuery(
    { body: { query: tile.dql, requestTimeoutMilliseconds: 30000, maxResultRecords: 1000 } },
    { autoFetch: true, autoFetchOnUpdate: true },
  );

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(tile.dql);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [tile.dql]);

  const colSpan = tile.width === 3 ? '1 / -1' : tile.width === 2 ? 'span 2' : 'span 1';
  const accentColor = tile.accent || 'rgba(100,120,200,0.5)';
  const isCompact = tile.vizType === 'singleValue' || tile.vizType === 'gauge' || tile.vizType === 'meterBar' || tile.vizType === 'heroMetric' || tile.vizType === 'impactCard';

  return (
    <div style={{
      gridColumn: colSpan,
      background: 'linear-gradient(135deg, rgba(20,22,40,0.85) 0%, rgba(30,32,55,0.75) 100%)',
      border: '1px solid rgba(100,120,200,0.18)',
      borderTop: `3px solid ${accentColor}`,
      borderRadius: 14,
      padding: 18,
      display: 'flex',
      flexDirection: 'column',
      minHeight: isCompact ? 160 : 330,
      boxShadow: `0 4px 24px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.04), 0 0 40px ${accentColor}08`,
      backdropFilter: 'blur(12px)',
      transition: 'box-shadow 0.3s ease, border-color 0.3s ease',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tile.desc ? 4 : 10 }}>
        <span style={{ fontWeight: 600, fontSize: 13, color: '#e0e4ff', display: 'flex', alignItems: 'center', gap: 6 }}>
          {tile.icon && <span style={{ fontSize: 15 }}>{tile.icon}</span>}
          {tile.title}
        </span>
        <button onClick={() => setShowDql(!showDql)} style={{
          background: 'rgba(100,120,200,0.15)', border: '1px solid rgba(100,120,200,0.3)',
          borderRadius: 6, color: '#8899cc', fontSize: 10, padding: '3px 8px', cursor: 'pointer',
        }}>
          {showDql ? 'Hide DQL' : 'Show DQL'}
        </button>
      </div>
      {tile.desc && (
        <div style={{ color: '#8899bb', fontSize: 10, lineHeight: 1.4, marginBottom: 10, paddingRight: 8 }}>
          {tile.desc}
        </div>
      )}

      {showDql && (
        <div style={{
          background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(100,120,200,0.2)',
          borderRadius: 6, padding: 10, marginBottom: 10, fontSize: 11,
          fontFamily: 'monospace', color: '#99aadd', whiteSpace: 'pre-wrap',
          wordBreak: 'break-all', position: 'relative',
        }}>
          {tile.dql}
          <button onClick={handleCopy} style={{
            position: 'absolute', top: 6, right: 6,
            background: copied ? 'rgba(39,174,96,0.3)' : 'rgba(100,120,200,0.2)',
            border: '1px solid rgba(100,120,200,0.3)', borderRadius: 4,
            color: copied ? '#27ae60' : '#8899cc', fontSize: 10, padding: '2px 8px', cursor: 'pointer',
          }}>
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>
      )}

      <div style={{ flex: 1, minHeight: isCompact ? 80 : 250, position: 'relative' }}>
        {isLoading && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: accentColor, fontSize: 12, gap: 8 }}>
            <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: accentColor, animation: 'pulse 1.2s ease-in-out infinite' }} />
            Loading…
          </div>
        )}
        {isError && (
          <div style={{ color: '#e74c3c', fontSize: 11, padding: 8 }}>Error: {error?.message || 'Query failed'}</div>
        )}
        {!isLoading && !isError && data && <ChartRenderer vizType={tile.vizType} data={data} tile={tile} />}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   CHART RENDERER
   ═══════════════════════════════════════════════════════════════ */

/** Extract the last numeric-looking value from a DQL record.
 *  DQL `fieldsAdd` appends derived fields at the end, so the last numeric
 *  column is almost always the computed result (e.g. rate, average). */
function extractNumeric(record: Record<string, any>): number {
  let last = 0;
  for (const k of Object.keys(record)) {
    const v = record[k];
    if (typeof v === 'number' && isFinite(v)) { last = v; }
    else if (typeof v === 'string') { const n = Number(v); if (isFinite(n)) last = n; }
  }
  return last;
}

/** Find the dimension (string category) and metric (numeric) keys in a DQL record. */
function classifyRecordKeys(record: Record<string, any>): { dimKey: string | null; metricKey: string | null } {
  let dimKey: string | null = null;
  let metricKey: string | null = null;
  for (const k of Object.keys(record)) {
    const v = record[k];
    if (metricKey === null && (typeof v === 'number' || (typeof v === 'string' && isFinite(Number(v)) && v !== ''))) {
      metricKey = k;
    } else if (dimKey === null && typeof v === 'string') {
      dimKey = k;
    }
  }
  if (!dimKey && metricKey) {
    for (const k of Object.keys(record)) {
      if (k !== metricKey) { dimKey = k; break; }
    }
  }
  return { dimKey, metricKey };
}

/** Format large numbers nicely: 63200 → "63.2K", 1200000 → "1.2M" */
function fmtNum(n: number): string {
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (abs >= 10_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  if (abs >= 1_000) return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(2);
}

/* ─────── REGION → LAT/LNG LOOKUP ─────── */
const REGION_COORDS: Record<string, [number, number]> = {
  'north america': [-100, 45], 'south america': [-60, -15], 'europe': [15, 50],
  'asia': [100, 35], 'africa': [25, 5], 'oceania': [135, -25], 'australia': [135, -25],
  'middle east': [45, 28], 'central america': [-85, 14], 'caribbean': [-72, 18],
  'southeast asia': [110, 5], 'east asia': [120, 35], 'south asia': [78, 22],
  'central asia': [65, 42], 'eastern europe': [30, 52], 'western europe': [5, 48],
  'northern europe': [15, 60], 'southern europe': [15, 42],
  'usa': [-98, 38], 'united states': [-98, 38], 'us': [-98, 38],
  'canada': [-105, 56], 'mexico': [-102, 23], 'brazil': [-51, -14],
  'argentina': [-64, -34], 'uk': [-1, 53], 'united kingdom': [-1, 53],
  'france': [2, 46], 'germany': [10, 51], 'spain': [-3, 40], 'italy': [12, 42],
  'netherlands': [5, 52], 'switzerland': [8, 47], 'austria': [14, 47],
  'poland': [20, 52], 'sweden': [15, 62], 'norway': [10, 62],
  'finland': [26, 64], 'ireland': [-8, 53], 'portugal': [-8, 39],
  'russia': [100, 60], 'china': [105, 35], 'japan': [138, 36], 'south korea': [127, 36],
  'india': [78, 22], 'indonesia': [118, -2], 'thailand': [100, 15],
  'singapore': [103, 1], 'taiwan': [121, 24], 'turkey': [32, 39],
  'saudi arabia': [45, 24], 'uae': [54, 24], 'israel': [34, 31],
  'egypt': [30, 27], 'south africa': [25, -30], 'nigeria': [8, 10], 'kenya': [37, 0],
  'new zealand': [174, -41], 'pakistan': [69, 30],
  'emea': [15, 48], 'apac': [110, 20], 'latam': [-60, -10], 'amer': [-90, 35],
  'northeast': [-73, 42], 'southeast': [-83, 33], 'midwest': [-90, 42],
  'southwest': [-110, 33], 'northwest': [-120, 46], 'west': [-118, 37], 'east': [-77, 39],
  'global': [0, 20], 'worldwide': [0, 20],
};
function resolveCoords(regionName: string): [number, number] | null {
  const lower = regionName.toLowerCase().trim();
  if (REGION_COORDS[lower]) return REGION_COORDS[lower];
  for (const [key, coords] of Object.entries(REGION_COORDS)) {
    if (lower.includes(key) || key.includes(lower)) return coords;
  }
  return null;
}
function project(lon: number, lat: number): [number, number] {
  const x = ((lon + 180) / 360) * 800;
  const latRad = (lat * Math.PI) / 180;
  const mercN = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  const y = 200 - (mercN / Math.PI) * 200;
  return [Math.max(5, Math.min(795, x)), Math.max(5, Math.min(395, y))];
}

/* Continent outlines as [lon,lat] polygons — projected via same Mercator fn */
const CONTINENT_POLYS: Array<[number, number][]> = [
  /* North America */
  [[-130,55],[-125,48],[-122,37],[-117,33],[-112,30],[-105,20],[-98,18],[-92,18],[-87,15],[-83,10],[-80,8],[-79,9],[-82,17],[-81,25],[-82,30],[-78,35],[-75,39],[-70,42],[-67,45],[-64,47],[-59,47],[-55,50],[-58,53],[-62,57],[-68,60],[-75,62],[-85,65],[-100,65],[-120,62],[-138,60],[-148,61],[-155,62],[-162,64],[-165,62],[-165,57],[-157,56],[-145,58],[-135,57],[-130,55]],
  /* South America */
  [[-80,9],[-76,7],[-72,11],[-67,11],[-62,8],[-55,5],[-50,1],[-44,-2],[-38,-4],[-35,-8],[-35,-13],[-38,-17],[-40,-22],[-44,-24],[-48,-28],[-53,-33],[-57,-38],[-62,-42],[-66,-46],[-68,-53],[-72,-48],[-73,-42],[-71,-35],[-72,-28],[-74,-20],[-77,-12],[-79,-5],[-78,0],[-77,4],[-80,9]],
  /* Europe */
  [[-9,36],[-5,36],[0,38],[3,43],[-2,44],[-5,44],[-9,43],[-10,44],[-5,48],[2,49],[6,52],[0,53],[-5,56],[-3,58],[5,59],[9,56],[12,55],[10,59],[12,62],[18,64],[25,66],[30,65],[32,60],[30,55],[24,52],[20,48],[25,45],[28,42],[26,38],[22,35],[15,38],[12,44],[8,46],[5,44],[2,43],[0,38],[-5,36],[-9,36]],
  /* Africa */
  [[-17,15],[-17,21],[-14,26],[-10,30],[-5,35],[0,35],[10,37],[12,34],[20,32],[25,31],[32,30],[36,28],[40,18],[44,12],[48,8],[50,2],[48,-1],[42,-5],[40,-11],[37,-18],[34,-25],[30,-30],[26,-34],[20,-34],[17,-30],[15,-22],[12,-12],[10,-5],[5,5],[0,6],[-5,5],[-10,6],[-14,10],[-17,15]],
  /* Asia (mainland) */
  [[30,40],[35,37],[40,38],[48,30],[55,27],[60,28],[62,38],[68,38],[72,22],[78,8],[80,12],[85,22],[90,22],[95,17],[100,14],[102,20],[105,22],[108,12],[112,10],[115,15],[118,22],[122,25],[128,34],[132,33],[140,36],[142,38],[145,42],[150,46],[158,50],[167,52],[170,60],[175,65],[180,66],[180,55],[170,50],[160,48],[152,45],[145,42],[142,38],[140,36],[133,33],[128,35],[125,30],[122,25],[118,20],[115,15],[112,10],[108,12],[105,10],[100,14],[98,18],[102,20],[105,22],[100,22],[95,18],[90,22],[85,22],[80,15],[78,8],[73,17],[72,22],[68,28],[60,28],[55,27],[50,28],[48,30],[42,33],[38,35],[35,37],[30,40]],
  /* Australia */
  [[115,-14],[122,-13],[130,-12],[136,-12],[141,-15],[146,-16],[149,-20],[152,-25],[153,-28],[150,-33],[147,-38],[142,-38],[137,-35],[132,-33],[128,-30],[124,-26],[120,-22],[116,-20],[114,-23],[115,-27],[118,-33],[116,-35],[113,-33],[113,-25],[114,-20],[115,-14]],
  /* Greenland */
  [[-52,60],[-45,60],[-38,65],[-22,70],[-18,76],[-20,80],[-35,82],[-45,82],[-55,80],[-55,75],[-50,68],[-52,60]],
];
function buildContinentPaths(): string[] {
  return CONTINENT_POLYS.map((poly) =>
    poly.map((p, i) => { const [x, y] = project(p[0], p[1]); return `${i === 0 ? 'M' : 'L'}${x.toFixed(0)},${y.toFixed(0)}`; }).join(' ') + ' Z'
  );
}

/** SVG World Map with real continent outlines and animated data points */
function WorldMapChart({ data, tile }: { data: any; tile?: TileDefinition }) {
  if (!data?.records?.length) return <div style={{ color: '#8899aa', fontSize: 11, padding: 8 }}>No region data</div>;
  const { dimKey, metricKey } = classifyRecordKeys(data.records[0]);
  const points: Array<{ name: string; value: number; x: number; y: number }> = [];
  let maxVal = 1;
  for (const r of data.records) {
    const name = dimKey ? String(r[dimKey] ?? '') : '';
    const value = metricKey ? (typeof r[metricKey] === 'number' ? r[metricKey] : Number(r[metricKey]) || 0) : 0;
    if (!name || value <= 0) continue;
    const coords = resolveCoords(name);
    if (!coords) continue;
    const [x, y] = project(coords[0], coords[1]);
    points.push({ name, value, x, y });
    if (value > maxVal) maxVal = value;
  }
  const accent = tile?.accent || '#1abc9c';
  const continentPaths = buildContinentPaths();
  return (
    <div style={{ width: '100%', height: 280, position: 'relative' }}>
      <svg viewBox="0 0 800 400" style={{ width: '100%', height: '100%' }} preserveAspectRatio="xMidYMid meet">
        <defs>
          <radialGradient id="glow-grad">
            <stop offset="0%" stopColor={accent} stopOpacity="0.6" />
            <stop offset="100%" stopColor={accent} stopOpacity="0" />
          </radialGradient>
          <filter id="land-glow" x="-5%" y="-5%" width="110%" height="110%">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        {/* Ocean */}
        <rect x="0" y="0" width="800" height="400" fill="#080c18" rx="8" />
        {/* Subtle grid */}
        {[160, 320, 480, 640].map(x => (
          <line key={`vg${x}`} x1={x} y1="0" x2={x} y2="400" stroke="rgba(80,120,200,0.05)" strokeWidth="0.5" strokeDasharray="4,8" />
        ))}
        {/* Equator */}
        <line x1="0" y1="200" x2="800" y2="200" stroke="rgba(80,120,200,0.08)" strokeWidth="0.5" strokeDasharray="6,6" />
        {/* Continent outlines */}
        {continentPaths.map((d, i) => (
          <path key={i} d={d} fill="rgba(60,100,180,0.08)" stroke="rgba(80,130,220,0.25)" strokeWidth="0.8" strokeLinejoin="round" />
        ))}
        {/* Connection lines from data points to their labels (for depth) */}
        {points.map((p, i) => {
          const frac = p.value / maxVal;
          const r = 6 + frac * 16;
          return <line key={`conn${i}`} x1={p.x} y1={p.y} x2={p.x} y2={p.y - r - 10} stroke={accent} strokeWidth="0.4" opacity="0.2" />;
        })}
        {/* Data points */}
        {points.map((p, i) => {
          const frac = p.value / maxVal;
          const r = 6 + frac * 16;
          const op = 0.4 + frac * 0.5;
          return (
            <g key={i}>
              {/* Outer pulse */}
              <circle cx={p.x} cy={p.y} r={r * 1.5} fill="none" stroke={accent} strokeWidth="0.5" opacity="0">
                <animate attributeName="r" from={String(r)} to={String(r * 3)} dur="2.5s" repeatCount="indefinite" />
                <animate attributeName="opacity" from={String(op * 0.5)} to="0" dur="2.5s" repeatCount="indefinite" />
              </circle>
              {/* Glow halo */}
              <circle cx={p.x} cy={p.y} r={r * 1.8} fill="url(#glow-grad)" opacity={op * 0.3} />
              {/* Main dot */}
              <circle cx={p.x} cy={p.y} r={r} fill={accent} opacity={op} stroke="rgba(255,255,255,0.5)" strokeWidth="0.8" />
              {/* Inner highlight */}
              <circle cx={p.x - r * 0.2} cy={p.y - r * 0.2} r={r * 0.3} fill="rgba(255,255,255,0.3)" />
              {/* Label */}
              <text x={p.x} y={p.y - r - 6} textAnchor="middle" fill="rgba(255,255,255,0.92)" fontSize="10" fontWeight="600" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.8)' }}>{p.name}</text>
              {/* Value inside dot */}
              <text x={p.x} y={p.y + 3.5} textAnchor="middle" fill="#fff" fontSize={r > 12 ? '9' : '7'} fontWeight="700">{fmtNum(p.value)}</text>
            </g>
          );
        })}
        {points.length === 0 && (
          <text x="400" y="200" textAnchor="middle" fill="#556" fontSize="13">No recognized regions in data</text>
        )}
      </svg>
    </div>
  );
}

/** Rich single-value display with large formatted number and accent color */
function RichSingleValue({ data: queryData, tile }: { data: any; tile?: TileDefinition }) {
  if (!queryData?.records?.length) return <div style={{ color: '#8899aa', fontSize: 11, padding: 8 }}>—</div>;
  const val = extractNumeric(queryData.records[0]);
  const accent = tile?.accent || '#3498db';
  const isPercent = (tile?.title || '').toLowerCase().includes('rate') || (tile?.title || '').toLowerCase().includes('%');
  const display = isPercent ? (val <= 1 ? (val * 100).toFixed(1) + '%' : val.toFixed(1) + '%') : fmtNum(val);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '100%', padding: '8px 0' }}>
      <div style={{ fontSize: 42, fontWeight: 700, color: accent, lineHeight: 1.1, textShadow: `0 0 24px ${accent}44`, letterSpacing: '-0.02em' }}>
        {display}
      </div>
    </div>
  );
}

/** Extract a numeric value from a record by trying multiple field names */
function extractFieldValue(record: Record<string, any>, fieldNames: string[]): number {
  for (const name of fieldNames) {
    if (record[name] !== undefined && record[name] !== null) {
      const val = Number(record[name]);
      if (isFinite(val)) return val;
    }
  }
  return 0;
}

/** Hero metric — premium large-number display for key business KPIs */
function HeroMetric({ data, tile }: { data: any; tile?: TileDefinition }) {
  if (!data?.records?.length) return <div style={{ color: '#7788aa', fontSize: 13, textAlign: 'center', padding: 20 }}>—</div>;
  const val = extractNumeric(data.records[0]);
  const accent = tile?.accent || '#00d4aa';
  const title = (tile?.title || '').toLowerCase();
  const isCurrency = title.includes('revenue') || title.includes('value') || title.includes('cost') || title.includes('spend');
  const isPercent = title.includes('rate') || title.includes('%') || title.includes('resolution') || title.includes('abandonment');
  const isTime = title.includes('time') || title.includes('duration') || title.includes('(s)') || title.includes('(ms)');

  let display: string;
  let unit = '';
  if (isPercent) {
    const pctVal = val > 0 && val <= 1 ? val * 100 : val;
    display = pctVal.toFixed(1);
    unit = '%';
  } else if (isCurrency) {
    display = '$' + fmtNum(val);
  } else if (isTime) {
    display = fmtNum(val);
    unit = title.includes('(ms)') ? 'ms' : 's';
  } else {
    display = fmtNum(val);
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
      height: '100%', position: 'relative', overflow: 'hidden',
    }}>
      <div style={{
        position: 'absolute', width: 160, height: 160, borderRadius: '50%',
        background: `radial-gradient(circle, ${accent}18 0%, transparent 70%)`,
        filter: 'blur(30px)', pointerEvents: 'none',
      }} />
      <div style={{
        fontSize: 56, fontWeight: 800, color: accent, lineHeight: 1,
        letterSpacing: '-0.03em',
        textShadow: `0 0 40px ${accent}55, 0 2px 8px rgba(0,0,0,0.3)`,
        position: 'relative', zIndex: 1,
      }}>
        {display}
        {unit && <span style={{ fontSize: 22, fontWeight: 600, opacity: 0.6, marginLeft: 2 }}>{unit}</span>}
      </div>
    </div>
  );
}

/** Impact card — shows business impact of errors in plain language */
function ImpactCard({ data, tile }: { data: any; tile?: TileDefinition }) {
  if (!data?.records?.length) return <div style={{ color: '#7788aa', fontSize: 12, textAlign: 'center', padding: 20 }}>No data</div>;
  const record = data.records[0];
  const errors = Math.round(extractFieldValue(record, ['errors', 'errorCount']));
  const impact = Math.round(extractFieldValue(record, ['estimatedImpact', 'impact']));
  const rate = extractFieldValue(record, ['errorRate', 'rate']);

  const isHealthy = errors === 0;
  const severity: 'healthy' | 'warning' | 'critical' = isHealthy ? 'healthy' : rate > 5 ? 'critical' : 'warning';
  const sColor = { healthy: '#00d4aa', warning: '#f39c12', critical: '#e74c3c' }[severity];

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
      height: '100%', gap: 8, textAlign: 'center', padding: '12px 16px',
      position: 'relative', overflow: 'hidden',
    }}>
      <div style={{
        position: 'absolute', inset: 0, opacity: 0.06,
        background: `radial-gradient(ellipse at center, ${sColor} 0%, transparent 70%)`,
        pointerEvents: 'none',
      }} />
      {isHealthy ? (
        <>
          <div style={{ fontSize: 40, lineHeight: 1 }}>✓</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#00d4aa', position: 'relative', zIndex: 1 }}>All Clear</div>
          <div style={{ fontSize: 11, color: '#8899aa', position: 'relative', zIndex: 1 }}>No errors impacting revenue</div>
        </>
      ) : (
        <>
          {impact > 0 ? (
            <div style={{
              fontSize: 36, fontWeight: 800, color: sColor, lineHeight: 1,
              textShadow: `0 0 30px ${sColor}44`, position: 'relative', zIndex: 1,
            }}>
              ${fmtNum(impact)}
            </div>
          ) : (
            <div style={{
              fontSize: 36, fontWeight: 800, color: sColor, lineHeight: 1,
              position: 'relative', zIndex: 1,
            }}>
              {fmtNum(errors)}
            </div>
          )}
          <div style={{ fontSize: 12, color: '#c0c8e8', lineHeight: 1.5, position: 'relative', zIndex: 1 }}>
            <strong style={{ color: sColor }}>{fmtNum(errors)}</strong> errors
            {rate > 0 && <> · {rate.toFixed(1)}% rate</>}
          </div>
          {impact > 0 && (
            <div style={{ fontSize: 11, color: '#8899cc', position: 'relative', zIndex: 1 }}>estimated revenue at risk</div>
          )}
        </>
      )}
    </div>
  );
}

function ChartRenderer({ vizType, data, tile }: { vizType: TileDefinition['vizType']; data: any; tile?: TileDefinition }) {
  if (!data?.records?.length) return <div style={{ color: '#8899aa', fontSize: 11, padding: 8 }}>No data</div>;

  switch (vizType) {
    case 'timeseries': {
      const ts = convertQueryResultToTimeseries(data);
      if (!ts?.length) return <div style={{ color: '#8899aa', fontSize: 11 }}>No timeseries data</div>;
      return <TimeseriesChart data={ts} height={250} />;
    }

    case 'pie': {
      const { dimKey, metricKey } = classifyRecordKeys(data.records[0]);
      const slices = data.records.map((r: any) => ({
        category: dimKey ? String(r[dimKey] ?? 'Unknown') : 'Unknown',
        value: metricKey ? (typeof r[metricKey] === 'number' ? r[metricKey] : Number(r[metricKey]) || 0) : 0,
      }));
      return <PieChart data={{ slices }} height={250} />;
    }

    case 'categoricalBar': {
      const { dimKey, metricKey } = classifyRecordKeys(data.records[0]);
      const chartData = data.records.map((r: any) => ({
        category: dimKey ? String(r[dimKey] ?? 'Unknown') : 'Unknown',
        value: metricKey ? (typeof r[metricKey] === 'number' ? r[metricKey] : Number(r[metricKey]) || 0) : 0,
      }));
      return <CategoricalBarChart data={chartData} height={250} />;
    }

    case 'singleValue':
      return <RichSingleValue data={data} tile={tile} />;

    case 'gauge': {
      const val = extractNumeric(data.records[0]);
      return <GaugeChart value={val} min={0} max={Math.max(100, val)} height={120} />;
    }

    case 'donut': {
      const { dimKey, metricKey } = classifyRecordKeys(data.records[0]);
      const slices = data.records.map((r: any) => ({
        category: dimKey ? String(r[dimKey] ?? 'Unknown') : 'Unknown',
        value: metricKey ? (typeof r[metricKey] === 'number' ? r[metricKey] : Number(r[metricKey]) || 0) : 0,
      }));
      return <DonutChart data={{ slices }} height={250}><DonutChart.Legend /></DonutChart>;
    }

    case 'honeycomb': {
      const hcData: Array<{ name: string; value: number }> = [];
      for (const r of data.records) {
        const { dimKey: dk, metricKey: mk } = classifyRecordKeys(r);
        const nm = dk ? String(r[dk] ?? 'Item') : 'Item';
        const vl = mk ? (typeof r[mk] === 'number' ? r[mk] : Number(r[mk]) || 0) : 0;
        if (vl > 0) hcData.push({ name: nm, value: vl });
      }
      if (!hcData.length) return <div style={{ color: '#8899aa', fontSize: 11 }}>No numeric data</div>;
      return <HoneycombChart data={hcData} height={250} shape="hexagon" showLabels />;
    }

    case 'meterBar': {
      const val = extractNumeric(data.records[0]);
      const isPercent = (tile?.title || '').toLowerCase().includes('rate') || (tile?.title || '').toLowerCase().includes('%');
      const display = isPercent ? (val <= 1 ? (val * 100).toFixed(1) + '%' : val.toFixed(1) + '%') : fmtNum(val);
      return (
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', height: '100%', gap: 8, padding: '4px 12px' }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: tile?.accent || '#1abc9c', textAlign: 'center', textShadow: `0 0 16px ${tile?.accent || '#1abc9c'}44` }}>
            {display}
          </div>
          <MeterBarChart value={isPercent && val <= 1 ? val * 100 : val} min={0} max={100} color={tile?.accent || undefined} />
        </div>
      );
    }

    case 'worldMap':
      return <WorldMapChart data={data} tile={tile} />;

    case 'heroMetric':
      return <HeroMetric data={data} tile={tile} />;

    case 'impactCard':
      return <ImpactCard data={data} tile={tile} />;

    case 'table': {
      const records = data.records;
      const keys = Object.keys(records[0]).filter(k => !k.startsWith('__'));
      const isCurrencyCol = (k: string) => /revenue|value|cost|spend|impact/i.test(k) && !/rate|count|fail/i.test(k);
      // Parse markdown links: [text](url) → { text, url }
      const mdLinkRe = /^\[([^\]]+)\]\(([^)]+)\)$/;
      const inlineMdLinkRe = /\[([^\]]+)\]\(([^)]+)\)/g;

      return (
        <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 280, fontSize: 11 }}>
          <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
            <thead>
              <tr>
                {keys.map(k => (
                  <th key={k} style={{
                    padding: '6px 10px', textAlign: 'left', whiteSpace: 'nowrap',
                    background: 'rgba(100,120,200,0.12)', color: '#8899cc',
                    borderBottom: '1px solid rgba(100,120,200,0.25)', fontWeight: 600, fontSize: 10,
                    position: 'sticky', top: 0, zIndex: 1,
                  }}>{k}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.slice(0, 50).map((r: any, i: number) => (
                <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(100,120,200,0.04)' }}>
                  {keys.map(k => {
                    const val = r[k];
                    const isNum = typeof val === 'number';
                    const isHighFailRate = k.toLowerCase().includes('fail') && isNum && val > 2;
                    let display: string | React.ReactNode = val === null || val === undefined ? '—' : isNum ? (isCurrencyCol(k) ? '$' + fmtNum(val) : fmtNum(val)) : String(val);
                    // Render markdown links as clickable <a> tags
                    if (typeof display === 'string') {
                      const str = display;
                      const fullMatch = str.match(mdLinkRe);
                      if (fullMatch) {
                        display = <a href={fullMatch[2]} target="_blank" rel="noopener noreferrer" style={{ color: '#4fc3f7', textDecoration: 'underline', cursor: 'pointer' }}>{fullMatch[1]}</a>;
                      } else if (inlineMdLinkRe.test(str)) {
                        // Multiple inline links mixed with text
                        inlineMdLinkRe.lastIndex = 0;
                        const parts: React.ReactNode[] = [];
                        let last = 0;
                        str.replace(inlineMdLinkRe, (match: string, text: string, url: string, offset: number) => {
                          if (offset > last) parts.push(str.slice(last, offset));
                          parts.push(<a key={offset} href={url} target="_blank" rel="noopener noreferrer" style={{ color: '#4fc3f7', textDecoration: 'underline', cursor: 'pointer' }}>{text}</a>);
                          last = offset + match.length;
                          return match;
                        });
                        if (last < str.length) parts.push(str.slice(last));
                        display = <>{parts}</>;
                      }
                    }
                    return (
                      <td key={k} style={{
                        padding: '5px 10px', borderBottom: '1px solid rgba(100,120,200,0.08)',
                        color: isHighFailRate ? '#e74c3c' : isNum ? '#e0e4ff' : '#b0b8d8',
                        whiteSpace: 'nowrap', fontFamily: isNum ? 'monospace' : 'inherit', fontSize: 11,
                      }}>{display}</td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    default: return <div style={{ color: '#8899aa', fontSize: 11 }}>Unsupported: {vizType}</div>;
  }
}

/* ═══════════════════════════════════════════════════════════════
   NOTEBOOK EXPORT
   ═══════════════════════════════════════════════════════════════ */

async function exportToNotebook(tiles: TileDefinition[], presetLabel: string) {
  const sections = tiles.map((t) => ({
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    type: 'dql' as const,
    title: t.title,
    state: {
      input: { value: t.dql, timeframe: { from: 'now()-2h', to: 'now()' } },
      visualization: t.vizType === 'timeseries' ? 'lineChart'
        : t.vizType === 'categoricalBar' ? 'barChart'
        : t.vizType === 'pie' || t.vizType === 'donut' ? 'pieChart'
        : t.vizType === 'gauge' || t.vizType === 'meterBar' ? 'gauge'
        : t.vizType === 'honeycomb' ? 'honeycomb' : 'table',
      davis: { includeLogs: false, dapiQuery: '' },
    },
  }));
  try {
    const res = await functions.call('proxy-api', {
      data: {
        action: 'create-notebook',
        body: { name: `Engine — ${presetLabel} — ${new Date().toISOString().slice(0, 16)}`, content: JSON.stringify({ version: '1', defaultTimeframe: { from: 'now()-2h', to: 'now()' }, sections }) },
      },
    });
    const result = (await res.json()) as any;
    return result.success ? { success: true, id: result.id } : { success: false, error: result.error || 'Unknown' };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/* ═══════════════════════════════════════════════════════════════
   DROPDOWN HOOKS — server-side via proxy
   ═══════════════════════════════════════════════════════════════ */

function useCompanyValues() {
  const [values, setValues] = useState<string[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    proxyDql(`fetch bizevents\n| summarize count = count(), by:{json.companyName}\n| fields json.companyName\n| dedup json.companyName`).then((result) => {
      if (cancelled) return;
      if (result.success && Array.isArray(result.records)) {
        setValues(result.records.map((r: any) => String(r['json.companyName'] ?? '')).filter(Boolean));
      } else { setError(result.error || 'Query failed'); }
    });
    return () => { cancelled = true; };
  }, []);
  return { values, error };
}

function useJourneyValues(companyName: string) {
  const [values, setValues] = useState<string[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    const dql = companyName
      ? `fetch bizevents\n| filter matchesPhrase(json.companyName, "${companyName}")\n| summarize count = count(), by:{json.journeyType}\n| fields json.journeyType\n| dedup json.journeyType`
      : `fetch bizevents\n| summarize count = count(), by:{json.journeyType}\n| fields json.journeyType\n| dedup json.journeyType`;
    proxyDql(dql).then((result) => {
      if (cancelled) return;
      if (result.success && Array.isArray(result.records)) {
        setValues(result.records.map((r: any) => String(r['json.journeyType'] ?? '')).filter(Boolean));
      } else { setError(result.error || 'Query failed'); }
    });
    return () => { cancelled = true; };
  }, [companyName]);
  return { values, error };
}

function useServiceNames(companyName: string, journeyType: string) {
  const [values, setValues] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (companyName) {
      // Get services from bizevents for this company
      let q = `fetch bizevents\n| filter matchesPhrase(json.companyName, "${companyName}")`;
      if (journeyType) q += `\n| filter matchesPhrase(json.journeyType, "${journeyType}")`;
      q += `\n| summarize count = count(), by:{json.serviceName}\n| sort count desc\n| fields json.serviceName\n| limit 50`;
      proxyDql(q, 50).then((result) => {
        if (cancelled) return;
        if (result.success && Array.isArray(result.records)) {
          setValues(result.records.map((r: any) => String(r['json.serviceName'] ?? '').toLowerCase()).filter(Boolean));
        }
      });
    } else {
      // No company selected — get all services from timeseries (already lowercase from DQL)
      proxyDql(`timeseries r = sum(dt.service.request.count), by:{dt.entity.service}\n| fieldsAdd Service = lower(entityName(dt.entity.service))\n| fields Service\n| sort Service asc\n| limit 100`, 100).then((result) => {
        if (cancelled) return;
        if (result.success && Array.isArray(result.records)) {
          setValues(result.records.map((r: any) => String(r['Service'] ?? '').toLowerCase()).filter(Boolean));
        }
      });
    }
    return () => { cancelled = true; };
  }, [companyName, journeyType]);
  return { values };
}

function useEventTypeValues(companyName: string) {
  const [values, setValues] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    const dql = companyName
      ? `fetch bizevents\n| filter matchesPhrase(json.companyName, "${companyName}")\n| summarize count = count(), by:{event.type}\n| sort count desc\n| fields event.type\n| limit 50`
      : `fetch bizevents\n| summarize count = count(), by:{event.type}\n| sort count desc\n| fields event.type\n| limit 50`;
    proxyDql(dql, 50).then((result) => {
      if (cancelled) return;
      if (result.success && Array.isArray(result.records)) {
        setValues(result.records.map((r: any) => String(r['event.type'] ?? '')).filter(Boolean));
      }
    });
    return () => { cancelled = true; };
  }, [companyName]);
  return { values };
}

/* ═══════════════════════════════════════════════════════════════
   FIELD PROFILE BADGE — shows discovered fields
   ═══════════════════════════════════════════════════════════════ */

function FieldProfileBadge({ profile, discovering }: { profile: FieldProfile | null; discovering: boolean }) {
  const [expanded, setExpanded] = useState(false);

  if (discovering) {
    return (
      <div style={{
        margin: '0 24px 8px', padding: '8px 14px', borderRadius: 8,
        background: 'rgba(0,180,220,0.08)', border: '1px solid rgba(0,180,220,0.25)',
        color: '#00b4dc', fontSize: 11, display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span>
        Discovering available fields…
      </div>
    );
  }

  if (!profile) return null;

  const numCount = profile.numericFields.size;
  const catCount = profile.categoricalFields.size;

  return (
    <div style={{
      margin: '0 24px 8px', padding: '8px 14px', borderRadius: 8,
      background: 'rgba(39,174,96,0.06)', border: '1px solid rgba(39,174,96,0.2)',
      fontSize: 11,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ color: '#27ae60' }}>
          🔍 Discovered: <strong>{numCount}</strong> numeric · <strong>{catCount}</strong> categorical fields
        </span>
        <button onClick={() => setExpanded(!expanded)} style={{
          background: 'none', border: 'none', color: '#8899cc', fontSize: 10, cursor: 'pointer', padding: '2px 6px',
        }}>
          {expanded ? '▲ Hide' : '▼ Show fields'}
        </button>
      </div>
      {expanded && (
        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {[...profile.numericFields].sort().map((f) => (
            <span key={f} style={{
              background: 'rgba(39,174,96,0.12)', border: '1px solid rgba(39,174,96,0.3)',
              borderRadius: 4, padding: '1px 6px', color: '#27ae60', fontSize: 10,
            }}>📊 {f}</span>
          ))}
          {[...profile.categoricalFields].sort().map((f) => (
            <span key={f} style={{
              background: 'rgba(52,152,219,0.12)', border: '1px solid rgba(52,152,219,0.3)',
              borderRadius: 4, padding: '1px 6px', color: '#3498db', fontSize: 10,
            }}>🏷️ {f}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   AI TILES HOOK — calls Ollama via proxy to generate DQL tiles
   ═══════════════════════════════════════════════════════════════ */

interface LibrarianInsight {
  category: string;
  title: string;
  detail: string;
  severity: 'info' | 'warning' | 'critical';
}
interface LibrarianPattern {
  pattern: string;
  frequency: number;
  recommendation: string;
}
interface LibrarianEvent {
  id: string;
  timestamp: string;
  agent: string;
  kind: string;
  summary: string;
}
interface LibrarianState {
  open: boolean;
  loading: boolean;
  error: string | null;
  summary: string;
  events: LibrarianEvent[];
  stats: { totalEvents: number; vectorEntries: number; byKind: Record<string, number> } | null;
  insights: LibrarianInsight[];
  patterns: LibrarianPattern[];
}

function useLibrarian() {
  const [state, setState] = useState<LibrarianState>({
    open: false, loading: false, error: null, summary: '',
    events: [], stats: null, insights: [], patterns: [],
  });

  const toggle = useCallback(() => {
    setState(prev => ({ ...prev, open: !prev.open }));
  }, []);

  const load = useCallback(async (settings?: AppSettings | null) => {
    setState(prev => ({ ...prev, loading: true, error: null }));

    const connSettings = {
      apiHost: settings?.apiHost || 'localhost',
      apiPort: settings?.apiPort || '8080',
      apiProtocol: settings?.apiProtocol || 'http',
    };

    try {
      // Fetch history + stats in parallel via proxy
      const [histRes, statsRes] = await Promise.all([
        functions.call('proxy-api', { data: { action: 'librarian-history' as const, ...connSettings, body: { limit: 200 } } }),
        functions.call('proxy-api', { data: { action: 'librarian-stats' as const, ...connSettings } }),
      ]);
      const histData = (await histRes.json()) as any;
      const statsData = (await statsRes.json()) as any;

      const events: LibrarianEvent[] = Array.isArray(histData.events) ? histData.events : [];
      const stats = statsData.success !== false ? { totalEvents: statsData.totalEvents || 0, vectorEntries: statsData.vectorEntries || 0, byKind: statsData.byKind || {} } : null;

      setState(prev => ({ ...prev, events, stats, open: true }));

      // Now call Ollama analysis
      setState(prev => ({ ...prev, loading: true, error: null }));
      const analyzeRes = await functions.call('proxy-api', { data: { action: 'librarian-analyze' as const, ...connSettings } });
      const analyzeData = (await analyzeRes.json()) as any;

      if (analyzeData.success) {
        setState(prev => ({
          ...prev,
          loading: false,
          summary: analyzeData.summary || '',
          insights: Array.isArray(analyzeData.insights) ? analyzeData.insights : [],
          patterns: Array.isArray(analyzeData.patterns) ? analyzeData.patterns : [],
          // Use analysis timeline if richer
          events: Array.isArray(analyzeData.timeline) && analyzeData.timeline.length > 0 ? analyzeData.timeline : prev.events,
          stats: analyzeData.stats || prev.stats,
        }));
      } else {
        // Analysis failed but we still have raw history
        setState(prev => ({
          ...prev,
          loading: false,
          summary: `${events.length} events loaded. AI analysis unavailable: ${analyzeData.error || 'unknown error'}`,
        }));
      }
    } catch (err: any) {
      setState(prev => ({ ...prev, loading: false, error: err.message || 'Failed to load librarian data' }));
    }
  }, []);

  const close = useCallback(() => {
    setState(prev => ({ ...prev, open: false }));
  }, []);

  return { ...state, toggle, load, close };
}

/* ═══════════════════════════════════════════════════════════════
   MAIN PAGE COMPONENT
   ═══════════════════════════════════════════════════════════════ */

export const EngineDashboardsPage = () => {
  const [preset, setPreset] = useState<DashboardPreset>('developer');
  const [companyName, setCompanyName] = useState('');
  const [journeyType, setJourneyType] = useState('');
  const [serviceName, setServiceName] = useState('');
  const [eventType, setEventType] = useState('');
  const [timeframe, setTimeframe] = useState<Timeframe>('now()-2h');
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [nbStatus, setNbStatus] = useState<{ msg: string; ok: boolean } | null>(null);

  useEffect(() => {
    loadAppSettings().then(({ settings: s }) => { setSettings(s); setLoading(false); });
  }, []);

  const { values: companyValues, error: companyError } = useCompanyValues();
  const { values: journeyValues, error: journeyError } = useJourneyValues(companyName);
  const { values: serviceValues } = useServiceNames(companyName, journeyType);
  const { values: eventTypeValues } = useEventTypeValues(companyName);

  // Field discovery — runs when company/journey changes
  const { profile, discovering } = useFieldDiscovery(companyName, journeyType);

  // Librarian operational memory dashboard
  const librarian = useLibrarian();

  // Build candidates then filter by discovered fields
  const tiles = useMemo(() => {
    const candidates = getCandidates(companyName, journeyType, preset, timeframe, serviceName, eventType, serviceValues);
    return filterTiles(candidates, profile);
  }, [companyName, journeyType, preset, profile, timeframe, serviceName, eventType, serviceValues]);

  // Count how many were filtered out
  const totalCandidates = useMemo(
    () => getCandidates(companyName, journeyType, preset, timeframe, serviceName, eventType, serviceValues).length,
    [companyName, journeyType, preset, timeframe, serviceName, eventType, serviceValues],
  );
  const filteredOut = totalCandidates - tiles.length;

  const handleRefresh = useCallback(() => { setRefreshKey((k) => k + 1); }, []);

  const handleExportNotebook = useCallback(async () => {
    setNbStatus(null);
    const result = await exportToNotebook(tiles, PRESET_META[preset].label);
    setNbStatus(result.success ? { msg: `Notebook created (${result.id})`, ok: true } : { msg: `Export failed: ${result.error}`, ok: false });
  }, [tiles, preset]);

  const handleLibrarian = useCallback(() => {
    if (librarian.open) {
      librarian.close();
    } else {
      librarian.load(settings);
    }
  }, [librarian.open, librarian.load, librarian.close, settings]);

  if (loading) return <div style={{ padding: 40, color: '#8899cc', textAlign: 'center' }}>Loading settings…</div>;

  const meta = PRESET_META[preset];

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(180deg, #0e0e1a 0%, #14142a 100%)', padding: '0 0 40px 0' }}>

      {/* ── TOP BAR ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 24px', background: 'rgba(20,20,40,0.85)',
        borderBottom: '1px solid rgba(100,120,200,0.2)',
      }}>
        <Link to="/" style={{ color: '#8899cc', fontSize: 12, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
          ← Back to Home
        </Link>
        <span style={{ color: '#e0e0ff', fontWeight: 700, fontSize: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          📊 {companyName ? `${companyName} Dashboards` : 'Engine Dashboards'}
          <InfoButton
            align="left"
            title="📊 Engine Dashboards"
            description="Nine persona-based preset dashboards with live DQL-powered tiles, all filterable by company, journey, service, and timeframe."
            sections={[
              { label: '🔧 Developer', detail: '~28 tiles: RED metrics, latency p50/p90/p99, errors, traces, logs, endpoints' },
              { label: '⚙️ Operations', detail: '~26 tiles: host health, CPU/memory, processes, network, availability' },
              { label: '👔 Executive', detail: '~38 tiles: revenue, SLA, journey funnel, customer churn, IT impact' },
              { label: '🧠 Intelligence', detail: '~19 tiles: problems, root cause, anomalies, MTTD/MTTR' },
              { label: '🤖 GenAI', detail: '~20 tiles: LLM calls, tokens, model latency, embeddings, operation breakdown' },
              { label: '🔒 Security', detail: '~18 tiles: security events, attacks, categories, trends, affected entities' },
              { label: '📋 SRE', detail: '~22 tiles: availability, error budget, latency percentiles, HTTP status codes' },
              { label: '📝 Biz Events', detail: '~22 tiles: event volume, types, errors by service/journey/company, details' },
              { label: '🏎️ VCARB Race Ops', detail: '~40 tiles: lap times, tyres, ERS, pit stops, positions, weather, telemetry' },
              { label: '🔄 Refresh', detail: 'Re-run all DQL queries with current filters' },
              { label: '📓 Export to Notebook', detail: 'Export all tiles as a Dynatrace Notebook with DQL sections' },
              { label: '📚 Librarian', detail: 'View operational history, chaos events, fixes, and AI-powered incident analysis via Ollama' },
            ]}
            footer="Filter dropdowns scope all tiles dynamically. Every tile runs a live DQL query."
            color="#a78bfa"
            width={340}
          />
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handleRefresh} style={{
            background: 'linear-gradient(135deg, rgba(0,180,220,0.15), rgba(108,44,156,0.08))',
            border: '1.5px solid rgba(0,180,220,0.5)', borderRadius: 8, padding: '6px 16px',
            color: '#00b4dc', fontWeight: 600, fontSize: 12, cursor: 'pointer',
          }}>🔄 Refresh</button>
          <button onClick={handleExportNotebook} style={{
            background: 'linear-gradient(135deg, rgba(39,174,96,0.2), rgba(0,180,220,0.1))',
            border: '1.5px solid rgba(39,174,96,0.5)', borderRadius: 8, padding: '6px 16px',
            color: '#27ae60', fontWeight: 600, fontSize: 12, cursor: 'pointer',
          }}>📓 Export to Notebook</button>
          <button onClick={handleLibrarian} disabled={librarian.loading} style={{
            background: librarian.open
              ? 'linear-gradient(135deg, rgba(245,166,35,0.25), rgba(108,44,156,0.15))'
              : 'linear-gradient(135deg, rgba(245,166,35,0.15), rgba(108,44,156,0.08))',
            border: `1.5px solid ${librarian.open ? 'rgba(245,166,35,0.7)' : 'rgba(245,166,35,0.5)'}`,
            borderRadius: 8, padding: '6px 16px',
            color: '#f5a623', fontWeight: 600, fontSize: 12,
            cursor: librarian.loading ? 'wait' : 'pointer',
            opacity: librarian.loading ? 0.6 : 1,
          }}>{librarian.loading ? '⏳ Analyzing…' : librarian.open ? '📚 Hide Librarian' : '📚 Librarian'}</button>
        </div>
      </div>

      {nbStatus && (
        <div style={{
          margin: '8px 24px 0', padding: '8px 14px', borderRadius: 8,
          background: nbStatus.ok ? 'rgba(39,174,96,0.12)' : 'rgba(231,76,60,0.12)',
          border: `1px solid ${nbStatus.ok ? 'rgba(39,174,96,0.4)' : 'rgba(231,76,60,0.4)'}`,
          color: nbStatus.ok ? '#27ae60' : '#e74c3c', fontSize: 12,
        }}>{nbStatus.msg}</div>
      )}

      {/* ── FILTERS ROW ── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, padding: '16px 24px', alignItems: 'flex-end' }}>
        <div>
          <label style={{ color: companyError ? '#e74c3c' : '#8899cc', fontSize: 11, display: 'block', marginBottom: 4 }}>
            Company {companyError && `⚠ ${companyError}`}
          </label>
          <select value={companyName} onChange={(e) => { setCompanyName(e.target.value); setJourneyType(''); }} style={{
            background: 'rgba(30,30,50,0.8)', border: `1px solid ${companyError ? 'rgba(231,76,60,0.5)' : 'rgba(100,120,200,0.3)'}`,
            borderRadius: 6, color: '#e0e0ff', padding: '6px 12px', fontSize: 12, minWidth: 180,
          }}>
            <option value="">All Companies</option>
            {companyValues.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div>
          <label style={{ color: journeyError ? '#e74c3c' : '#8899cc', fontSize: 11, display: 'block', marginBottom: 4 }}>
            Journey Type {journeyError && `⚠ ${journeyError}`}
          </label>
          <select value={journeyType} onChange={(e) => setJourneyType(e.target.value)} style={{
            background: 'rgba(30,30,50,0.8)', border: '1px solid rgba(100,120,200,0.3)',
            borderRadius: 6, color: '#e0e0ff', padding: '6px 12px', fontSize: 12, minWidth: 220,
          }}>
            <option value="">All Journeys</option>
            {journeyValues.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div>
          <label style={{ color: '#e67e22', fontSize: 11, display: 'block', marginBottom: 4 }}>Service Name</label>
          <select value={serviceName} onChange={(e) => setServiceName(e.target.value)} style={{
            background: 'rgba(30,30,50,0.8)', border: '1px solid rgba(230,126,34,0.3)',
            borderRadius: 6, color: '#e0e0ff', padding: '6px 12px', fontSize: 12, minWidth: 200,
          }}>
            <option value="">All Services</option>
            {serviceValues.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div>
          <label style={{ color: '#1abc9c', fontSize: 11, display: 'block', marginBottom: 4 }}>Event Type</label>
          <select value={eventType} onChange={(e) => setEventType(e.target.value)} style={{
            background: 'rgba(30,30,50,0.8)', border: '1px solid rgba(26,188,156,0.3)',
            borderRadius: 6, color: '#e0e0ff', padding: '6px 12px', fontSize: 12, minWidth: 200,
          }}>
            <option value="">All Event Types</option>
            {eventTypeValues.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div>
          <label style={{ color: '#8899cc', fontSize: 11, display: 'block', marginBottom: 4 }}>Timeframe</label>
          <select value={timeframe} onChange={(e) => setTimeframe(e.target.value as Timeframe)} style={{
            background: 'rgba(30,30,50,0.8)', border: '1px solid rgba(100,120,200,0.3)',
            borderRadius: 6, color: '#e0e0ff', padding: '6px 12px', fontSize: 12, minWidth: 120,
          }}>
            {TIMEFRAME_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
        </div>
      </div>

      {/* ── FIELD DISCOVERY STATUS ── */}
      <FieldProfileBadge profile={profile} discovering={discovering} />

      {/* ── DASHBOARD PRESET TABS ── */}
      <div style={{ padding: '0 24px 12px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {(Object.keys(PRESET_META) as DashboardPreset[]).map((p) => {
          const m = PRESET_META[p];
          const active = preset === p;
          return (
            <button key={p} onClick={() => { setPreset(p); if (p === 'vcarb') { setCompanyName('Visa Cash App Racing Bulls'); setJourneyType('2026 Dynatrace Linz Grand Prix'); } }} title={m.desc} style={{
              background: active ? `linear-gradient(135deg, ${m.color}33, ${m.color}11)` : 'rgba(30,30,50,0.5)',
              border: `1.5px solid ${active ? m.color + '88' : 'rgba(100,120,200,0.2)'}`,
              borderRadius: 8, padding: '7px 14px',
              color: active ? m.color : '#8899bb', fontWeight: active ? 700 : 400,
              fontSize: 12, cursor: 'pointer', transition: 'all 0.2s ease',
            }}>
              {m.icon} {m.label}
            </button>
          );
        })}
      </div>

      {/* ── PRESET BANNER ── */}
      <div style={{
        margin: '0 24px 16px', padding: '12px 18px', borderRadius: 10,
        background: `linear-gradient(135deg, ${meta.color}18, ${meta.color}08)`,
        border: `1px solid ${meta.color}44`,
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <span style={{ fontSize: 22 }}>{meta.icon}</span>
        <div>
          <span style={{ color: meta.color, fontWeight: 700, fontSize: 14 }}>{meta.label} Dashboard</span>
          <span style={{ color: '#8899cc', fontSize: 11, marginLeft: 12 }}>
            {tiles.length} tiles{filteredOut > 0 && ` (${filteredOut} hidden — no data)`}
            {companyName && ` · ${companyName}`}{journeyType && ` · ${journeyType}`}{serviceName && ` · ${serviceName}`}{eventType && ` · ${eventType}`}
          </span>
          <div style={{ color: '#99aacc', fontSize: 10, marginTop: 2 }}>{meta.desc}</div>
        </div>
      </div>

      {/* ── PRESET OVERVIEW PANEL ── */}
      {PRESET_OVERVIEW[preset] && (
        <div style={{
          margin: '0 24px 16px', padding: '14px 20px', borderRadius: 10,
          background: 'linear-gradient(135deg, rgba(20,22,40,0.7) 0%, rgba(30,32,55,0.5) 100%)',
          border: '1px solid rgba(100,120,200,0.18)',
        }}>
          <div style={{ color: '#c8d0f0', fontSize: 12, fontWeight: 600, marginBottom: 8, lineHeight: 1.5 }}>
            {PRESET_OVERVIEW[preset].headline}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {PRESET_OVERVIEW[preset].bullets.map((b: string, i: number) => (
              <span key={i} style={{
                background: `${meta.color}15`, border: `1px solid ${meta.color}33`,
                borderRadius: 6, padding: '3px 10px', fontSize: 10, color: '#b0b8d8',
              }}>
                {b}
              </span>
            ))}
          </div>
          <div style={{ color: '#7888aa', fontSize: 10, fontStyle: 'italic' }}>
            {PRESET_OVERVIEW[preset].poweredBy}
          </div>
        </div>
      )}

      {/* ── TILE GRID ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, padding: '0 24px' }}>
        {tiles.map((tile) => (
          tile.vizType === 'sectionBanner'
            ? <SectionBanner key={`${preset}-${tile.id}-${refreshKey}`} tile={tile} />
            : <DqlTile key={`${preset}-${tile.id}-${companyName}-${journeyType}-${serviceName}-${eventType}-${timeframe}-${refreshKey}`} tile={tile} timeframe={timeframe} />
        ))}
      </div>

      {/* ── LIBRARIAN MODAL OVERLAY ── */}
      {librarian.open && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999,
          background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '24px',
        }} onClick={(e) => { if (e.target === e.currentTarget) librarian.close(); }}>
          <div style={{
            width: '90vw', maxWidth: 1100, maxHeight: '88vh',
            background: 'linear-gradient(180deg, #12122a 0%, #0e0e1a 100%)',
            border: '1.5px solid rgba(245,166,35,0.4)',
            borderRadius: 16, boxShadow: '0 24px 80px rgba(0,0,0,0.6), 0 0 40px rgba(245,166,35,0.08)',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
            {/* Modal Header */}
            <div style={{
              padding: '16px 24px', flexShrink: 0,
              background: 'linear-gradient(135deg, rgba(245,166,35,0.12), rgba(108,44,156,0.06))',
              borderBottom: '1px solid rgba(245,166,35,0.25)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 26 }}>📚</span>
                <div>
                  <div style={{ color: '#f5a623', fontWeight: 700, fontSize: 16 }}>Librarian — Operational Memory</div>
                  <div style={{ color: '#8899cc', fontSize: 11, marginTop: 2 }}>
                    {librarian.loading ? 'Ollama is analyzing history…' :
                     librarian.stats ? `${librarian.stats.totalEvents} events · ${librarian.stats.vectorEntries} embeddings` : 'AI-powered incident analysis'}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button onClick={() => librarian.load(settings)} disabled={librarian.loading} style={{
                  background: 'rgba(245,166,35,0.1)', border: '1px solid rgba(245,166,35,0.3)', borderRadius: 8,
                  color: '#f5a623', fontSize: 11, padding: '6px 14px', cursor: librarian.loading ? 'wait' : 'pointer',
                  fontWeight: 600,
                }}>🔄 Refresh</button>
                <button onClick={librarian.close} style={{
                  background: 'rgba(231,76,60,0.1)', border: '1px solid rgba(231,76,60,0.3)', borderRadius: 8,
                  color: '#e74c3c', fontSize: 16, padding: '4px 12px', cursor: 'pointer', lineHeight: 1,
                }}>✕</button>
              </div>
            </div>

            {/* Modal Body — scrollable */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>

              {/* Loading */}
              {librarian.loading && (
                <div style={{
                  padding: '40px 24px', borderRadius: 10, textAlign: 'center',
                  background: 'rgba(245,166,35,0.05)', border: '1px solid rgba(245,166,35,0.15)',
                  color: '#f5a623', fontSize: 14,
                }}>
                  <div style={{ fontSize: 36, marginBottom: 14, animation: 'spin 2s linear infinite', display: 'inline-block' }}>📚</div>
                  <div>Ollama is analyzing operational history…</div>
                  <div style={{ color: '#8899aa', fontSize: 11, marginTop: 8 }}>Reviewing chaos events, fixes, and incident patterns</div>
                </div>
              )}

              {/* Error */}
              {librarian.error && !librarian.loading && (
                <div style={{
                  marginBottom: 14, padding: '12px 18px', borderRadius: 8,
                  background: 'rgba(231,76,60,0.08)', border: '1px solid rgba(231,76,60,0.3)',
                  color: '#e74c3c', fontSize: 12,
                }}>⚠️ {librarian.error}</div>
              )}

              {/* Summary */}
              {librarian.summary && !librarian.loading && (
                <div style={{
                  marginBottom: 16, padding: '16px 20px', borderRadius: 12,
                  background: 'linear-gradient(135deg, rgba(245,166,35,0.08), rgba(20,20,40,0.5))',
                  border: '1px solid rgba(245,166,35,0.25)',
                }}>
                  <div style={{ color: '#f5a623', fontWeight: 700, fontSize: 13, marginBottom: 8 }}>🤖 AI Summary</div>
                  <div style={{ color: '#c8d0f0', fontSize: 13, lineHeight: 1.7 }}>{librarian.summary}</div>
                </div>
              )}

              {/* Stats Cards */}
              {librarian.stats && !librarian.loading && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 10, marginBottom: 16 }}>
                  {Object.entries(librarian.stats.byKind).map(([kind, count]) => {
                    const kindMeta: Record<string, { icon: string; color: string }> = {
                      chaos_injected: { icon: '💥', color: '#e74c3c' },
                      chaos_reverted: { icon: '↩️', color: '#27ae60' },
                      problem_detected: { icon: '🚨', color: '#e67e22' },
                      diagnosis_started: { icon: '🔍', color: '#3498db' },
                      diagnosis_complete: { icon: '🧪', color: '#1abc9c' },
                      fix_proposed: { icon: '💡', color: '#9b59b6' },
                      fix_executed: { icon: '✅', color: '#27ae60' },
                      fix_verified: { icon: '✔️', color: '#2ecc71' },
                      fix_failed: { icon: '❌', color: '#e74c3c' },
                      learning_stored: { icon: '📖', color: '#f5a623' },
                    };
                    const km = kindMeta[kind] || { icon: '📋', color: '#8899cc' };
                    return (
                      <div key={kind} style={{
                        padding: '14px 14px', borderRadius: 10,
                        background: `linear-gradient(135deg, ${km.color}15, rgba(20,20,40,0.5))`,
                        border: `1px solid ${km.color}44`,
                        textAlign: 'center',
                      }}>
                        <div style={{ fontSize: 22 }}>{km.icon}</div>
                        <div style={{ color: km.color, fontWeight: 700, fontSize: 22, marginTop: 4 }}>{count}</div>
                        <div style={{ color: '#8899cc', fontSize: 10, marginTop: 2, textTransform: 'capitalize' }}>
                          {kind.replace(/_/g, ' ')}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Insights Grid */}
              {librarian.insights.length > 0 && !librarian.loading && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#f5a623', fontWeight: 700, fontSize: 13, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>💡</span> AI Insights
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
                    {librarian.insights.map((insight, i) => {
                      const sevColors: Record<string, { bg: string; border: string; badge: string }> = {
                        critical: { bg: 'rgba(231,76,60,0.08)', border: 'rgba(231,76,60,0.35)', badge: '#e74c3c' },
                        warning: { bg: 'rgba(230,126,34,0.08)', border: 'rgba(230,126,34,0.35)', badge: '#e67e22' },
                        info: { bg: 'rgba(52,152,219,0.08)', border: 'rgba(52,152,219,0.35)', badge: '#3498db' },
                      };
                      const sc = sevColors[insight.severity] || sevColors.info;
                      const catIcons: Record<string, string> = {
                        chaos: '💥', remediation: '🔧', performance: '⚡', reliability: '🛡️', audit: '📋',
                      };
                      return (
                        <div key={i} style={{
                          padding: '12px 16px', borderRadius: 10,
                          background: sc.bg, border: `1px solid ${sc.border}`,
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                            <span style={{ fontSize: 14 }}>{catIcons[insight.category] || '📋'}</span>
                            <span style={{ color: sc.badge, fontWeight: 700, fontSize: 12 }}>{insight.title}</span>
                            <span style={{
                              marginLeft: 'auto', padding: '1px 8px', borderRadius: 8,
                              background: `${sc.badge}22`, color: sc.badge, fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
                            }}>{insight.severity}</span>
                          </div>
                          <div style={{ color: '#b0b8d8', fontSize: 11, lineHeight: 1.5 }}>{insight.detail}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Patterns */}
              {librarian.patterns.length > 0 && !librarian.loading && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#f5a623', fontWeight: 700, fontSize: 13, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>🔄</span> Detected Patterns
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10 }}>
                    {librarian.patterns.map((pat, i) => (
                      <div key={i} style={{
                        padding: '12px 16px', borderRadius: 10,
                        background: 'rgba(155,89,182,0.08)', border: '1px solid rgba(155,89,182,0.3)',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                          <span style={{ color: '#bb86fc', fontWeight: 700, fontSize: 12 }}>{pat.pattern}</span>
                          <span style={{
                            padding: '1px 8px', borderRadius: 8,
                            background: 'rgba(155,89,182,0.2)', color: '#bb86fc', fontSize: 10, fontWeight: 600,
                          }}>×{pat.frequency}</span>
                        </div>
                        <div style={{ color: '#8899cc', fontSize: 11, lineHeight: 1.5 }}>
                          💡 {pat.recommendation}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Event Timeline */}
              {librarian.events.length > 0 && !librarian.loading && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ color: '#f5a623', fontWeight: 700, fontSize: 13, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>📜</span> Event Timeline
                    <span style={{ color: '#8899cc', fontWeight: 400, fontSize: 11, marginLeft: 4 }}>
                      (latest {Math.min(librarian.events.length, 50)})
                    </span>
                  </div>
                  <div style={{
                    maxHeight: 340, overflowY: 'auto', borderRadius: 10,
                    background: 'rgba(20,22,40,0.5)', border: '1px solid rgba(100,120,200,0.15)',
                    padding: '2px 0',
                  }}>
                    {librarian.events.slice(-50).reverse().map((ev, i) => {
                      const kindIcons: Record<string, string> = {
                        chaos_injected: '💥', chaos_reverted: '↩️', problem_detected: '🚨',
                        diagnosis_started: '🔍', diagnosis_complete: '🧪', fix_proposed: '💡',
                        fix_executed: '✅', fix_verified: '✔️', fix_failed: '❌', learning_stored: '📖',
                      };
                      const agentColors: Record<string, string> = {
                        nemesis: '#e74c3c', fixit: '#27ae60', librarian: '#f5a623',
                      };
                      return (
                        <div key={i} style={{
                          display: 'flex', alignItems: 'flex-start', gap: 10,
                          padding: '8px 14px', borderBottom: '1px solid rgba(100,120,200,0.08)',
                          fontSize: 11,
                        }}>
                          <span style={{ fontSize: 14, flexShrink: 0, marginTop: 1 }}>{kindIcons[ev.kind] || '📋'}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span style={{
                                color: agentColors[ev.agent] || '#8899cc', fontWeight: 600, fontSize: 10,
                                textTransform: 'uppercase', letterSpacing: '0.5px',
                              }}>{ev.agent}</span>
                              <span style={{ color: '#556688', fontSize: 9 }}>
                                {new Date(ev.timestamp).toLocaleString()}
                              </span>
                            </div>
                            <div style={{ color: '#b0b8d8', marginTop: 2, lineHeight: 1.4, wordBreak: 'break-word' }}>
                              {ev.summary}
                            </div>
                          </div>
                          <span style={{
                            flexShrink: 0, padding: '1px 6px', borderRadius: 4,
                            background: 'rgba(100,120,200,0.1)', color: '#7888aa', fontSize: 8,
                            textTransform: 'capitalize',
                          }}>{ev.kind.replace(/_/g, ' ')}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Empty state */}
              {!librarian.loading && librarian.events.length === 0 && !librarian.error && (
                <div style={{
                  padding: '40px 24px', borderRadius: 10, textAlign: 'center',
                  background: 'rgba(245,166,35,0.05)', border: '1px solid rgba(245,166,35,0.15)',
                  color: '#f5a623', fontSize: 14,
                }}>
                  <div style={{ fontSize: 36, marginBottom: 12 }}>📚</div>
                  <div>No operational events recorded yet.</div>
                  <div style={{ color: '#8899aa', fontSize: 12, marginTop: 8 }}>
                    Start a journey and inject some chaos via the Chaos Control tab to build history.
                  </div>
                </div>
              )}

            </div>{/* end modal body */}
          </div>{/* end modal card */}
        </div>
      )}

      {tiles.length === 0 && !librarian.open && (
        <div style={{
          margin: '40px 24px', padding: '24px', borderRadius: 10, textAlign: 'center',
          background: 'rgba(30,30,50,0.4)', border: '1px solid rgba(100,120,200,0.15)',
          color: '#8899aa', fontSize: 13,
        }}>
          No tiles available for this preset — the selected company/journey doesn't have the required fields.
          Try selecting a different company or switching to another dashboard preset.
        </div>
      )}

      {/* ── FOOTER ── */}
      <div style={{
        margin: '24px 24px 0', padding: '12px 18px', borderRadius: 8,
        background: 'rgba(30,30,50,0.4)', border: '1px solid rgba(100,120,200,0.15)',
        color: '#8899aa', fontSize: 11, textAlign: 'center',
      }}>
        Engine Dashboards — 7 vertical dashboards · People · Time · Money · Powered by Strato & DQL
      </div>
    </div>
  );
};
