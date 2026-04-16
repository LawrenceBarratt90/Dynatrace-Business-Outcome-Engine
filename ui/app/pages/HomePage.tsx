import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Page } from '@dynatrace/strato-components-preview/layouts';
import { Flex } from '@dynatrace/strato-components/layouts';
import { Heading, Paragraph, Strong } from '@dynatrace/strato-components/typography';
import { Button } from '@dynatrace/strato-components/buttons';
import { TextInput } from '@dynatrace/strato-components-preview/forms';
import { TitleBar } from '@dynatrace/strato-components-preview/layouts';
import Colors from '@dynatrace/strato-design-tokens/colors';
import { loadAppSettings, saveAppSettings, type AppSettings } from '../services/app-settings';
import { edgeConnectClient } from '@dynatrace-sdk/client-app-engine-edge-connect';

import { functions } from '@dynatrace-sdk/app-utils';
import { getEnvironmentUrl } from '@dynatrace-sdk/app-environment';

import { generateCsuitePrompt, generateJourneyPrompt, PROMPT_DESCRIPTIONS } from '../constants/promptTemplates';
import { INITIAL_TEMPLATES, InitialTemplate } from '../constants/initialTemplates';
import { DEMONSTRATOR_LOGO } from '../constants/demonstratorLogo';
import { VCARB_CAR } from '../constants/vcarbCar';
import { InfoButton } from '../components/InfoButton';
import appConfig from '../../../app.config.json';

const APP_VERSION = appConfig.app.version;
const LOCAL_STORAGE_KEY = 'bizobs_api_settings';

// Dynamic tenant URL — works in any environment
const TENANT_URL = (() => {
  try { return getEnvironmentUrl().replace(/\/$/, ''); } catch { return 'https://YOUR_TENANT_ID.apps.dynatracelabs.com'; }
})();
const TENANT_HOST = TENANT_URL.replace(/^https?:\/\//, '');
const TENANT_ID = TENANT_HOST.split('.')[0];
const SSO_ENDPOINT = TENANT_HOST.includes('sprint') || TENANT_HOST.includes('dynatracelabs')
  ? 'https://sso.dynatracelabs.com/sso/oauth2/token'
  : 'https://sso.dynatrace.com/sso/oauth2/token';

/** Build a URL to the Dynatrace Services Explorer filtered by [Environment] tags */
const getServicesUiUrl = (companyName: string, journeyType?: string) => {
  // Match the DT_TAGS encoding: replace non-alphanumeric chars with underscore, then lowercase
  const companyTag = companyName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  let filter = `tags = "[Environment]company:${companyTag}"`;
  if (journeyType) {
    const journeyTag = journeyType.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    filter += `  AND tags = "[Environment]journey-type:${journeyTag}" `;
  }
  return `${TENANT_URL}/ui/apps/dynatrace.services/explorer?perspective=performance&sort=entity%3Aascending#filtering=${encodeURIComponent(filter)}`;
};

interface ApiSettingsFull {
  apiHost: string;
  apiPort: string;
  apiProtocol: string;
  enableAutoGeneration: boolean;
}

const DEFAULT_SETTINGS: ApiSettingsFull = {
  apiHost: 'bizobs-demonstrator',
  apiPort: '8080',
  apiProtocol: 'http',
  enableAutoGeneration: false,
};

interface RunningService {
  service: string;
  running: boolean;
  pid: number;
  port?: number;
  companyName?: string;
  domain?: string;
  industryType?: string;
  journeyType?: string;
  stepName?: string;
  baseServiceName?: string;
  serviceVersion?: number;
  releaseStage?: string;
  startTime?: number;
}

interface PromptTemplate {
  id: string;
  name: string;
  companyName: string;
  domain: string;
  requirements: string;
  csuitePrompt: string;
  journeyPrompt: string;
  response?: string; // JSON response from Copilot
  originalConfig?: any; // Full config for pre-loaded templates
  createdAt: string;
  isPreloaded?: boolean;
}

const TEMPLATES_STORAGE_KEY = 'bizobs_prompt_templates';

export const HomePage = () => {
  const [activeTab, setActiveTab] = useState('welcome');
  const [companyName, setCompanyName] = useState('');
  const [domain, setDomain] = useState('');
  const [requirements, setRequirements] = useState('');
  const [copilotResponse, setCopilotResponse] = useState('');
  const [prompt1, setPrompt1] = useState('');
  const [prompt2, setPrompt2] = useState('');
  const [savedTemplates, setSavedTemplates] = useState<PromptTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [isGeneratingServices, setIsGeneratingServices] = useState(false);
  const [generationStatus, setGenerationStatus] = useState('');
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({ 
    appTemplates: false, 
    myTemplates: false,
    vcarbDemo: false 
  });
  // Initialize apiSettings from localStorage immediately (before SDK loads)
  const [apiSettings, setApiSettingsState] = useState(() => {
    try {
      const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (stored) {
        const p = JSON.parse(stored);
        return { host: p.apiHost || 'localhost', port: p.apiPort || '8080', protocol: p.apiProtocol || 'http' };
      }
    } catch { /* ignore */ }
    return { host: 'localhost', port: '8080', protocol: 'http' };
  });

  // ── Settings via shared Document Service ──────────────────────────────────

  // Settings modal state
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [settingsForm, setSettingsForm] = useState<ApiSettingsFull>(() => {
    try {
      const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (stored) {
        const p = JSON.parse(stored);
        return {
          apiHost: p.apiHost || 'localhost',
          apiPort: p.apiPort || '8080',
          apiProtocol: p.apiProtocol || 'http',
          enableAutoGeneration: p.enableAutoGeneration || false,
        };
      }
    } catch { /* ignore */ }
    return DEFAULT_SETTINGS;
  });
  const [settingsStatus, setSettingsStatus] = useState('');
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [detectedCallerIp, setDetectedCallerIp] = useState<string | null>(null);

  // Services modal state
  const [showServicesModal, setShowServicesModal] = useState(false);
  const [runningServices, setRunningServices] = useState<RunningService[]>([]);
  const [isLoadingServices, setIsLoadingServices] = useState(false);
  const [isStoppingServices, setIsStoppingServices] = useState(false);
  const [stoppingCompany, setStoppingCompany] = useState<string | null>(null);
  const [servicesStatus, setServicesStatus] = useState('');

  // Dormant services state
  const [dormantServices, setDormantServices] = useState<any[]>([]);
  const [isLoadingDormant, setIsLoadingDormant] = useState(false);
  const [isClearingDormant, setIsClearingDormant] = useState(false);
  const [showDormantWarning, setShowDormantWarning] = useState<string | null>(null); // company name or 'all'
  const [clearingDormantCompany, setClearingDormantCompany] = useState<string | null>(null);

  // Settings modal tab state
  const [settingsTab, setSettingsTab] = useState<'config' | 'edgeconnect' | 'system' | 'copilot'>('config');

  // System maintenance state
  const [systemHealth, setSystemHealth] = useState<any>(null);
  const [isLoadingHealth, setIsLoadingHealth] = useState(false);
  const [isRunningCleanup, setIsRunningCleanup] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<any>(null);

  // EdgeConnect state
  const [edgeConnects, setEdgeConnects] = useState<any[]>([]);
  const [isLoadingEC, setIsLoadingEC] = useState(false);
  const [ecStatus, setEcStatus] = useState('');
  const [isDeletingEC, setIsDeletingEC] = useState<string | null>(null);
  const [ecMatchResult, setEcMatchResult] = useState<{ matched: boolean; name?: string; pattern?: string } | null>(null);
  const [isCheckingMatch, setIsCheckingMatch] = useState(false);
  const [isCreatingEC, setIsCreatingEC] = useState(false);
  // EdgeConnect config inputs (for YAML generation & verification)
  const [ecName, setEcName] = useState('bizobs-demonstrator');
  const [ecHostPattern, setEcHostPattern] = useState('');
  const [ecClientId, setEcClientId] = useState('');
  const [ecClientSecret, setEcClientSecret] = useState('');

  // Tooltip state for header buttons
  const [showServicesTooltip, setShowServicesTooltip] = useState(false);
  const [showSettingsTooltip, setShowSettingsTooltip] = useState(false);
  const [showGetStartedTooltip, setShowGetStartedTooltip] = useState(false);
  const [showNavMenu, setShowNavMenu] = useState(false);
  const navMenuRef = useRef<HTMLDivElement>(null);

  // Close nav menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (navMenuRef.current && !navMenuRef.current.contains(e.target as Node)) {
        setShowNavMenu(false);
      }
    };
    if (showNavMenu) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showNavMenu]);

  // VCARB Race state
  const navigate = useNavigate();
  const [isStartingRace, setIsStartingRace] = useState(false);
  const [raceStatus, setRaceStatus] = useState<string | null>(null);

  // Journeys modal state
  const [showJourneysModal, setShowJourneysModal] = useState(false);
  const [journeysData, setJourneysData] = useState<RunningService[]>([]);
  const [isLoadingJourneys, setIsLoadingJourneys] = useState(false);
  const [journeysStatus, setJourneysStatus] = useState('');
  const [journeyAssets, setJourneyAssets] = useState<Record<string, { dashboard: { exists: boolean; id: string; url: string; name?: string }; bizflow: { exists: boolean; name?: string } }>>({});

  // Dashboard generation state
  const [dashboardUrl, setDashboardUrl] = useState<string | null>(null);
  const [isGeneratingDashboard, setIsGeneratingDashboard] = useState(false);

  // Generate Visuals modal sub-tab state
  const [visualsSubTab, setVisualsSubTab] = useState<'dashboard' | 'saved' | 'pdf'>('pdf');
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [pdfStatus, setPdfStatus] = useState('');
  const [dashboardStatus, setDashboardStatus] = useState('');
  const [generatedDashboardJson, setGeneratedDashboardJson] = useState<any>(null);

  // Saved dashboards state
  const [savedDashboards, setSavedDashboards] = useState<any[]>([]);
  const [isLoadingSavedDashboards, setIsLoadingSavedDashboards] = useState(false);

  // MCP custom prompt state
  const [mcpDashboardPrompt, setMcpDashboardPrompt] = useState('');

  // Dashboard template generation modal state
  const [showGenerateDashboardModal, setShowGenerateDashboardModal] = useState(false);
  const [dashboardCompanyName, setDashboardCompanyName] = useState('');
  const [dashboardJourneyType, setDashboardJourneyType] = useState('');
  const [availableCompanies, setAvailableCompanies] = useState<string[]>([]);
  const [availableJourneys, setAvailableJourneys] = useState<string[]>([]);
  const [isLoadingDashboardData, setIsLoadingDashboardData] = useState(false);
  const [dashboardGenerationStatus, setDashboardGenerationStatus] = useState('');



  // Chaos Nemesis Agent modal state
  const [showChaosModal, setShowChaosModal] = useState(false);
  const [chaosTab, setChaosTab] = useState<'active' | 'inject' | 'targeted' | 'smart'>('active');
  const [activeFaults, setActiveFaults] = useState<any[]>([]);
  const [chaosRecipes, setChaosRecipes] = useState<any[]>([]);
  const [targetedServices, setTargetedServices] = useState<Record<string, any>>({});
  const [isLoadingChaos, setIsLoadingChaos] = useState(false);
  const [chaosStatus, setChaosStatus] = useState('');
  const [isInjectingChaos, setIsInjectingChaos] = useState(false);
  const [isRevertingChaos, setIsRevertingChaos] = useState(false);
  const [smartChaosGoal, setSmartChaosGoal] = useState('');
  const [isSmartChaosRunning, setIsSmartChaosRunning] = useState(false);
  const [injectForm, setInjectForm] = useState({ type: 'enable_errors', target: '', intensity: 5, duration: 60 });

  // Step 2 guided sub-step state
  const [step2Phase, setStep2Phase] = useState<'prompts' | 'response' | 'generate'>(  'prompts');

  // GitHub Copilot AI generation state
  const [ghCopilotConfigured, setGhCopilotConfigured] = useState(false);
  const [ghCopilotChecking, setGhCopilotChecking] = useState(false);
  const [ghCopilotToken, setGhCopilotToken] = useState('');
  const [ghCopilotSaving, setGhCopilotSaving] = useState(false);
  const [ghCopilotStatus, setGhCopilotStatus] = useState('');
  const [ghCopilotModel, setGhCopilotModel] = useState('gpt-4.1');
  const [ghAvailableModels, setGhAvailableModels] = useState<Array<{ id: string; name: string; owned_by: string }>>([]);
  const [ghGenerating1, setGhGenerating1] = useState(false);
  const [ghGenerating2, setGhGenerating2] = useState(false);
  const [ghGeneratingAll, setGhGeneratingAll] = useState(false);
  const [ghResult1, setGhResult1] = useState('');
  const [ghResult2, setGhResult2] = useState('');

  // AI Generation Modal state — full automated pipeline
  const [showAiGenModal, setShowAiGenModal] = useState(false);
  const [aiGenSteps, setAiGenSteps] = useState<Array<{ label: string; status: 'pending' | 'running' | 'done' | 'error'; detail?: string }>>([]);
  const [aiGenComplete, setAiGenComplete] = useState(false);
  const [aiGenError, setAiGenError] = useState('');

  // "Use Your Own AI Prompt" (paste) flow state
  const [showPasteAiModal, setShowPasteAiModal] = useState(false);
  const [pastedAiResponse, setPastedAiResponse] = useState('');
  const [extractedJourneys, setExtractedJourneys] = useState<string[]>([]);
  const [selectedJourneyName, setSelectedJourneyName] = useState('');
  const [ownAiPhase, setOwnAiPhase] = useState<'details' | 'paste' | 'generate'>('details');

  // Toast notification state
  const [toastMessage, setToastMessage] = useState('');
  const [toastType, setToastType] = useState<'success' | 'error' | 'warning' | 'info'>('info');
  const [toastVisible, setToastVisible] = useState(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Confirm dialog state (replaces native confirm())
  const [confirmDialog, setConfirmDialog] = useState<{ message: string; onConfirm: () => void } | null>(null);

  // Builtin settings detection state (OpenPipeline, BizEvents capture, OneAgent features)
  const [builtinSettingsDetected, setBuiltinSettingsDetected] = useState<Record<string, boolean>>({});
  const [isDeployingConfigs, setIsDeployingConfigs] = useState(false);
  const [deployConfigsStatus, setDeployConfigsStatus] = useState('');
  const [connectionTestedOk, setConnectionTestedOk] = useState(() => {
    try { return localStorage.getItem('bizobs_connection_tested') === 'true'; } catch { return false; }
  });

  // Get Started checklist state — persisted to Dynatrace tenant settings
  const [showGetStartedModal, setShowGetStartedModal] = useState(false);
  const [checklist, setChecklist] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('bizobs_checklist') || '{}'); } catch { return {}; }
  });
  const checklistSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveChecklistToTenant = useCallback((next: Record<string, boolean>) => {
    // Debounced save to shared Document Service
    if (checklistSaveRef.current) clearTimeout(checklistSaveRef.current);
    checklistSaveRef.current = setTimeout(async () => {
      try {
        const current = await loadAppSettings();
        await saveAppSettings({ ...current.settings, checklistState: JSON.stringify(next) });
      } catch { /* silent — localStorage is fallback */ }
    }, 1500);
  }, []);

  // Generic helper: merge a partial value into the shared Document
  const tenantFieldSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTenantField = useCallback((partial: Record<string, unknown>, debounceMs = 500) => {
    if (tenantFieldSaveRef.current) clearTimeout(tenantFieldSaveRef.current);
    tenantFieldSaveRef.current = setTimeout(async () => {
      try {
        const current = await loadAppSettings();
        await saveAppSettings({ ...current.settings, ...partial } as AppSettings);
      } catch { /* silent — localStorage is fallback */ }
    }, debounceMs);
  }, []);

  const toggleCheck = (key: string) => {
    setChecklist(prev => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem('bizobs_checklist', JSON.stringify(next));
      saveChecklistToTenant(next);
      return next;
    });
  };
  const checklistSteps = [
    { key: 'server-ip', label: 'Configure Server IP', section: 'server' },
    { key: 'edgeconnect-create', label: 'Create EdgeConnect in Dynatrace', section: 'network' },
    { key: 'edgeconnect-deploy', label: 'Deploy EdgeConnect on Server', section: 'network' },
    { key: 'edgeconnect-online', label: 'Verify EdgeConnect is Online', section: 'network' },
    { key: 'oneagent', label: 'OneAgent Installed on Host', section: 'monitoring' },
    { key: 'test-connection', label: 'Test Connection from App', section: 'verify' },
    { key: 'openpipeline', label: 'OpenPipeline Pipeline Created', section: 'config' },
    { key: 'openpipeline-routing', label: 'OpenPipeline Routing Configured', section: 'config' },
    { key: 'biz-events', label: 'Business Event Capture Rule', section: 'config' },
    { key: 'feature-flags', label: 'OneAgent Feature Flag Enabled', section: 'config' },
    { key: 'outbound-github-models', label: 'GitHub Copilot Outbound Allowed', section: 'config' },
    { key: 'automation-workflow', label: 'Fix-It Agent Workflow Deployed', section: 'config' },
  ];

  // Auto-detected checklist state (merged with manual checks)
  // These are computed from live state and override manual toggles
  const autoDetected: Record<string, boolean> = {
    'server-ip': !!(apiSettings.host && apiSettings.host !== '' && apiSettings.host !== 'localhost'),
    'edgeconnect-create': builtinSettingsDetected['edgeconnect-create'] || edgeConnects.length > 0,
    'edgeconnect-deploy': builtinSettingsDetected['edgeconnect-deploy'] || edgeConnects.some((ec: any) => (ec.metadata?.instances || []).length > 0),
    'edgeconnect-online': builtinSettingsDetected['edgeconnect-online'] || edgeConnects.some((ec: any) => (ec.metadata?.instances || []).length > 0),
    'oneagent': builtinSettingsDetected['oneagent'] || false,
    'test-connection': builtinSettingsDetected['test-connection'] || connectionTestedOk || ecMatchResult?.matched === true,
    'openpipeline': builtinSettingsDetected['openpipeline'] || false,
    'openpipeline-routing': builtinSettingsDetected['openpipeline-routing'] || false,
    'biz-events': builtinSettingsDetected['biz-events'] || false,
    'feature-flags': builtinSettingsDetected['feature-flags'] || false,
    'outbound-github-models': builtinSettingsDetected['outbound-github-models'] || false,
    'automation-workflow': builtinSettingsDetected['automation-workflow'] || false,
  };
  const isStepComplete = (key: string) => autoDetected[key] || checklist[key];
  const completedCount = checklistSteps.filter(s => isStepComplete(s.key)).length;
  const totalSteps = checklistSteps.length;

  /** Show toast notification at bottom of app */
  const showToast = useCallback((message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info', duration = 4000) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMessage(message);
    setToastType(type);
    setToastVisible(true);
    toastTimerRef.current = setTimeout(() => setToastVisible(false), duration);
  }, []);



  // Load saved templates from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(TEMPLATES_STORAGE_KEY);
      if (stored) {
        setSavedTemplates(JSON.parse(stored));
      } else {
        // First time running - load initial templates from saved-configs
        const initialTemplates = INITIAL_TEMPLATES.map(t => ({
          ...t,
          // Generate prompts on demand when loaded
          csuitePrompt: t.csuitePrompt || '',
          journeyPrompt: t.journeyPrompt || ''
        }));
        setSavedTemplates(initialTemplates);
        localStorage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(initialTemplates));
        saveTenantField({ promptTemplates: JSON.stringify(initialTemplates) });
        console.log(`✅ Loaded ${initialTemplates.length} initial templates`);
        console.log(`[BizObs] App version: v${APP_VERSION}`);
      }
    } catch (error) {
      console.error('Error loading templates:', error);
    }
  }, []);

  // Sync settings from shared Document → local state
  const settingsLoadedRef = useRef(false);
  useEffect(() => {
    if (settingsLoadedRef.current) return;
    settingsLoadedRef.current = true;

    loadAppSettings().then(({ settings: loaded, source }) => {
      console.log('[BizObs] Settings loaded from', source, ':', loaded.apiHost);

      if (source !== 'defaults' && loaded.apiHost !== 'localhost') {
        setApiSettingsState({ host: loaded.apiHost, port: loaded.apiPort, protocol: loaded.apiProtocol });
        setSettingsForm({
          apiHost: loaded.apiHost,
          apiPort: loaded.apiPort,
          apiProtocol: loaded.apiProtocol,
          enableAutoGeneration: loaded.enableAutoGeneration,
        });
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(loaded));
        console.log('[BizObs] Applied shared settings → apiHost:', loaded.apiHost);
      } else {
        console.log('[BizObs] Shared doc has localhost — keeping localStorage values');
      }

      // Restore checklist
      if (loaded.checklistState) {
        try {
          const restored = JSON.parse(loaded.checklistState);
          if (restored && typeof restored === 'object') {
            setChecklist(restored);
            localStorage.setItem('bizobs_checklist', loaded.checklistState);
          }
        } catch { /* ignore */ }
      }
      // Restore prompt templates
      if (loaded.promptTemplates) {
        try {
          const restoredTemplates = JSON.parse(loaded.promptTemplates);
          if (Array.isArray(restoredTemplates) && restoredTemplates.length > 0) {
            setSavedTemplates(restoredTemplates);
            localStorage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(restoredTemplates));
            console.log(`[BizObs] Restored ${restoredTemplates.length} templates from shared doc`);
          }
        } catch { /* ignore */ }
      }
      // Restore connectionTested
      if (loaded.connectionTested === true) {
        setConnectionTestedOk(true);
        localStorage.setItem('bizobs_connection_tested', 'true');
      }
    }).catch(err => {
      console.warn('[BizObs] Settings load failed:', err);
    });
  }, []);

  // ── Check if GitHub Copilot credential is configured + fetch available models ──
  useEffect(() => {
    (async () => {
      setGhCopilotChecking(true);
      try {
        const resp = await functions.call('proxy-api', { data: { action: 'github-copilot-check-credential', apiHost: '', apiPort: '', apiProtocol: '' } });
        const res = await resp.json();
        if (res.success && res.data?.configured) {
          setGhCopilotConfigured(true);
          // Fetch available models
          try {
            const modelsResp = await functions.call('proxy-api', { data: { action: 'github-copilot-list-models', apiHost: '', apiPort: '', apiProtocol: '' } });
            const modelsRes = await modelsResp.json();
            if (modelsRes.success && modelsRes.data?.models?.length > 0) {
              setGhAvailableModels(modelsRes.data.models);
              // If current model not in list, default to first available
              const ids = modelsRes.data.models.map((m: any) => m.id);
              if (!ids.includes(ghCopilotModel)) {
                const preferred = ids.find((id: string) => id === 'gpt-4o') || ids[0];
                setGhCopilotModel(preferred);
              }
            }
          } catch { /* models fetch failed — use hardcoded defaults */ }
        }
      } catch { /* ignore */ }
      setGhCopilotChecking(false);
    })();
  }, []);

  // ── Detect builtin Dynatrace settings via serverless function ──
  // Runs once on load if stale (>1 hour), or when forced via Refresh button
  const DETECT_CACHE_KEY = 'bizobs_detect_timestamp';
  const DETECT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  const lastDetectRef = useRef<number>(0);
  const [isDetecting, setIsDetecting] = useState(false);

  const detectBuiltinSettings = useCallback(async (force = false) => {
    // Skip if already ran recently (within 1 hour) unless forced
    const now = Date.now();
    if (!force) {
      const lastRun = lastDetectRef.current || (() => {
        try { return parseInt(localStorage.getItem(DETECT_CACHE_KEY) || '0', 10); } catch { return 0; }
      })();
      if (now - lastRun < DETECT_INTERVAL_MS) return;
    }

    console.log('[BizObs] Running detect with host:', apiSettings.host, 'force:', force);
    setIsDetecting(true);
    try {
      const result = await callProxyWithRetry(
        { action: 'detect-builtin-settings', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol, body: { hostIp: apiSettings.host } }
      ) as { success: boolean; data?: Record<string, boolean> };
      console.log('[BizObs] Detect result:', result);
      if (result.success && result.data) {
        setBuiltinSettingsDetected(result.data);
        // If test-connection came back true from server, persist it
        if (result.data['test-connection']) {
          setConnectionTestedOk(true);
          localStorage.setItem('bizobs_connection_tested', 'true');
          saveTenantField({ connectionTested: true });
        }
        // Merge detected true values into persisted checklist
        setChecklist(prev => {
          const merged = { ...prev };
          for (const [k, v] of Object.entries(result.data!)) {
            if (v === true) merged[k] = true;
          }
          localStorage.setItem('bizobs_checklist', JSON.stringify(merged));
          saveChecklistToTenant(merged);
          return merged;
        });
        // Record successful detect timestamp
        lastDetectRef.current = now;
        localStorage.setItem(DETECT_CACHE_KEY, String(now));

        // Auto-deploy outbound allowlist if not yet configured (required for Copilot AI)
        if (result.data['outbound-github-models'] === false) {
          console.log('[BizObs] Auto-deploying outbound allowlist for GitHub Copilot hosts...');
          try {
            await callProxyWithRetry(
              { action: 'deploy-builtin-settings', body: { configs: ['outbound-github-models'] } },
              3, 2000
            );
            console.log('[BizObs] Outbound allowlist auto-deployed successfully');
          } catch (e: any) {
            console.warn('[BizObs] Outbound allowlist auto-deploy failed:', e.message);
          }
        }
      }
    } catch (err) {
      console.warn('Failed to detect builtin settings:', err);
    }
    setIsDetecting(false);
  }, [apiSettings.host, apiSettings.port, apiSettings.protocol, saveChecklistToTenant]);

  // Auto-detect on mount (respects 1-hour cache)
  // Only runs after settings have been loaded from SDK/localStorage
  const detectRanRef = useRef(false);
  useEffect(() => {
    if (!detectRanRef.current && settingsLoadedRef.current && apiSettings.host && apiSettings.host !== 'localhost') {
      detectRanRef.current = true;
      console.log('[BizObs] Auto-detect triggered with host:', apiSettings.host);
      detectBuiltinSettings(false);
    }
  }, [detectBuiltinSettings, apiSettings.host]);

  // ── Deploy builtin Dynatrace settings from Get Started ──
  const deployBuiltinConfigs = async (configKeys: string[]) => {
    setIsDeployingConfigs(true);
    setDeployConfigsStatus('⏳ Deploying configurations...');
    try {
      const result = await callProxyWithRetry(
        { action: 'deploy-builtin-settings', body: { configs: configKeys } },
        5, 2000, setDeployConfigsStatus
      ) as { success: boolean; data?: Record<string, { success: boolean; error?: string }> };
      if (result.success && result.data) {
        const succeeded = Object.entries(result.data).filter(([, v]) => v.success).map(([k]) => k);
        const failed = Object.entries(result.data).filter(([, v]) => !v.success).map(([k, v]) => `${k}: ${v.error}`);
        if (failed.length === 0) {
          setDeployConfigsStatus(`✅ Deployed ${succeeded.length} config(s) successfully!`);
          showToast(`Deployed: ${succeeded.join(', ')}`, 'success');
        } else {
          setDeployConfigsStatus(`⚠️ ${succeeded.length} deployed, ${failed.length} failed: ${failed.join('; ')}`);
        }
      } else {
        setDeployConfigsStatus('❌ Deployment failed');
      }
    } catch (err: any) {
      setDeployConfigsStatus(`❌ ${err.message}`);
    }
    setIsDeployingConfigs(false);
    // Re-detect after deployment
    await detectBuiltinSettings(true);
  };

  // ── EdgeConnect Logic ──────────────────────────────────
  const loadEdgeConnects = async () => {
    setIsLoadingEC(true);
    setEcStatus('');
    try {
      const result = await edgeConnectClient.listEdgeConnects({ addFields: 'metadata' });
      setEdgeConnects(result.edgeConnects || []);
    } catch (err: any) {
      setEcStatus(`❌ Failed to load EdgeConnects: ${err.message}`);
      setEdgeConnects([]);
    }
    setIsLoadingEC(false);
  };

  // Load EdgeConnects on mount for checklist auto-detection
  useEffect(() => { loadEdgeConnects(); }, []);

  // Auto-populate API host from EdgeConnect host patterns on first install
  const ecAutoPopulatedRef = useRef(false);
  useEffect(() => {
    if (ecAutoPopulatedRef.current || edgeConnects.length === 0) return;
    // Only auto-populate if settings are still at defaults (no user-saved value)
    const currentHost = apiSettings.host;
    if (currentHost && currentHost !== 'localhost' && currentHost !== 'bizobs-demonstrator') return;
    // Extract the first valid host pattern from an online EdgeConnect (prefer online, fallback to any)
    const onlineEc = edgeConnects.find((ec: any) => (ec.metadata?.instances || []).length > 0) || edgeConnects[0];
    const patterns: string[] = onlineEc?.hostPatterns || [];
    const hostIp = patterns.find((p: string) => p && p !== 'localhost' && p !== '127.0.0.1');
    if (!hostIp) return;
    ecAutoPopulatedRef.current = true;
    console.log('[BizObs] Auto-populating API host from EdgeConnect hostPattern:', hostIp);
    const autoSettings = { apiHost: hostIp, apiPort: '8080', apiProtocol: 'http', enableAutoGeneration: false };
    setApiSettingsState({ host: hostIp, port: '8080', protocol: 'http' });
    setSettingsForm(autoSettings);
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(autoSettings));
  }, [edgeConnects, apiSettings.host]);

  const deleteEdgeConnect = async (ecId: string, ecName: string) => {
    if (!confirm(`Delete EdgeConnect "${ecName}"? This cannot be undone.`)) return;
    setIsDeletingEC(ecId);
    setEcStatus(`🗑️ Deleting ${ecName}...`);
    try {
      await edgeConnectClient.deleteEdgeConnect({ edgeConnectId: ecId });
      setEcStatus(`✅ Deleted "${ecName}"`);
      await loadEdgeConnects();
    } catch (err: any) {
      setEcStatus(`❌ Failed to delete: ${err.message}`);
    }
    setIsDeletingEC(null);
  };

  // Create EdgeConnect via SDK — auto-generates OAuth credentials
  const createEdgeConnect = async () => {
    const name = ecName.trim();
    const host = (ecHostPattern.trim() || settingsForm.apiHost || '').trim();
    if (!name || !host) {
      setEcStatus('❌ Name and host pattern / IP are required');
      return;
    }
    setIsCreatingEC(true);
    setEcStatus('⏳ Creating EdgeConnect & generating credentials...');
    try {
      const result = await callProxyWithRetry({
          action: 'ec-create',
          apiHost: '', apiPort: '', apiProtocol: '',
          body: { ecName: name, hostPatterns: [host] },
      }) as any;
      if (!result.success) {
        const rawErr = result.debug?.rawError || '';
        if (rawErr.includes('already exist') || rawErr.includes('constraintViolations')) {
          setEcStatus('⚠️ An EdgeConnect with that name or host pattern already exists. Delete it first (below) or use different values.');
        } else {
          setEcStatus(`❌ ${result.error}`);
        }
        setIsCreatingEC(false);
        return;
      }
      // Auto-populate the credentials from SDK response
      setEcClientId(result.data?.oauthClientId || '');
      setEcClientSecret(result.data?.oauthClientSecret || '');
      setEcStatus('✅ EdgeConnect created! Credentials auto-filled below. Copy the YAML and deploy on your server.');
      await loadEdgeConnects();
      await checkEdgeConnectMatch();
    } catch (err: any) {
      setEcStatus(`❌ Failed: ${err.message}`);
    }
    setIsCreatingEC(false);
  };

  // Generate YAML from EdgeConnect credentials
  const generateEcYaml = () => {
    return `name: ${ecName.trim() || 'bizobs-demonstrator'}\napi_endpoint_host: ${TENANT_HOST}\noauth:\n  client_id: ${ecClientId.trim() || '<your-client-id>'}\n  client_secret: ${ecClientSecret.trim() || '<your-client-secret>'}\n  resource: urn:dtenvironment:${TENANT_ID}\n  endpoint: ${SSO_ENDPOINT}`;
  };

  // Derived: is any EdgeConnect online?
  const isAnyEcOnline = edgeConnects.some((ec: any) => (ec.metadata?.instances || []).length > 0);
  // Derived: is EdgeConnect route matched?
  const isEcRouteActive = ecMatchResult?.matched === true;

  const checkEdgeConnectMatch = async () => {
    const host = ecHostPattern || apiSettings.host || 'localhost';
    const port = apiSettings.port || '8080';
    const proto = apiSettings.protocol || 'http';
    setIsCheckingMatch(true);
    setEcMatchResult(null);
    try {
      const result = await edgeConnectClient.getMatchedEdgeConnects({ url: `${proto}://${host}:${port}/api/health` });
      if (result.matched) {
        setEcMatchResult({ matched: true, name: result.matched.name, pattern: result.matched.matchedPattern });
      } else {
        setEcMatchResult({ matched: false });
      }
    } catch (err: any) {
      setEcMatchResult({ matched: false });
    }
    setIsCheckingMatch(false);
  };

  // ── Settings Modal Logic ──────────────────────────────────
  const openSettingsModal = () => {
    setSettingsForm({
      apiHost: apiSettings.host,
      apiPort: apiSettings.port,
      apiProtocol: apiSettings.protocol,
      enableAutoGeneration: settingsForm.enableAutoGeneration,
    });
    setSettingsStatus('');
    setShowSettingsModal(true);

  };

  const saveSettingsFromModal = async () => {
    setIsSavingSettings(true);
    setSettingsStatus('💾 Saving to shared app config...');

    // Build the full settings payload including tenant-scoped extras
    const fullSettings: AppSettings = {
      ...settingsForm,
      checklistState: JSON.stringify(checklist),
      promptTemplates: JSON.stringify(savedTemplates),
      connectionTested: connectionTestedOk,
    };

    const docSaved = await saveAppSettings(fullSettings);

    if (docSaved) {
      setSettingsStatus('✅ Settings saved to shared app config (all users will see these)');
    } else {
      setSettingsStatus('⚠️ Saved locally only — shared document write failed');
    }

    setApiSettingsState({ host: settingsForm.apiHost, port: settingsForm.apiPort, protocol: settingsForm.apiProtocol });

    // Auto-register host pattern with EdgeConnect so the serverless proxy can reach the server
    const newHost = settingsForm.apiHost.trim();
    if (newHost && newHost !== 'localhost' && newHost !== '127.0.0.1') {
      try {
        const ecResult = await callProxyWithRetry({
            action: 'ec-update-patterns',
            apiHost: '', apiPort: '', apiProtocol: '',
            body: { hostPatterns: [newHost] },
        }) as any;
        if (ecResult.success && ecResult.data?.added?.length > 0) {
          setSettingsStatus(prev => `${prev}\n🔌 Auto-registered ${newHost} as EdgeConnect host pattern`);
        }
        // Silently succeed if pattern already existed
      } catch {
        // Non-fatal — EdgeConnect may not exist yet or user hasn't set it up
        console.warn('[BizObs] Could not auto-register EdgeConnect host pattern (non-fatal)');
      }
    }

    setIsSavingSettings(false);
    // Re-detect builtin settings after saving config (force since settings changed)
    detectBuiltinSettings(true);
    setTimeout(() => setShowSettingsModal(false), 800);
  };

  // ── System Maintenance Logic ──────────────────────────────
  const loadSystemHealth = async () => {
    setIsLoadingHealth(true);
    setCleanupResult(null);
    try {
      const result = await callProxyWithRetry(
        { action: 'system-health', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol }
      ) as any;
      if (result.success) {
        setSystemHealth(result);
      } else {
        setSystemHealth({ error: result.error || 'Failed to load system health' });
      }
    } catch (err: any) {
      setSystemHealth({ error: err.message || 'Connection failed' });
    }
    setIsLoadingHealth(false);
  };

  const runSystemCleanup = async (itemIds?: string[]) => {
    setIsRunningCleanup(true);
    setCleanupResult(null);
    try {
      const result = await callProxyWithRetry(
        { action: 'system-cleanup', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol, body: itemIds ? { itemIds } : {} }
      ) as any;
      setCleanupResult(result);
      // Refresh health after cleanup
      loadSystemHealth();
    } catch (err: any) {
      setCleanupResult({ success: false, error: err.message || 'Cleanup failed' });
    }
    setIsRunningCleanup(false);
  };

  const testConnectionFromModal = async () => {
    setIsTestingConnection(true);
    setSettingsStatus('🔄 Testing connection...');
    try {
      const result = await callProxyWithRetry(
        { action: 'test-connection', apiHost: settingsForm.apiHost, apiPort: settingsForm.apiPort, apiProtocol: settingsForm.apiProtocol },
        5, 2000, setSettingsStatus
      ) as any;
      // Capture caller IP reported by the BizObs server (the actual source IP that reached it)
      if (result.callerIp) setDetectedCallerIp(result.callerIp);
      if (result.success) {
        const ipNote = result.callerIp ? ` (source IP: ${result.callerIp})` : '';
        setSettingsStatus(`✅ ${result.message}${ipNote}`);
        // Persist successful test so checklist stays green
        setConnectionTestedOk(true);
        localStorage.setItem('bizobs_connection_tested', 'true');
        saveTenantField({ connectionTested: true });
      } else {
        setSettingsStatus(`❌ ${result.error || result.details}`);
        setConnectionTestedOk(false);
        localStorage.setItem('bizobs_connection_tested', 'false');
        saveTenantField({ connectionTested: false });
      }
    } catch (error: any) {
      setSettingsStatus(`❌ ${error.message}`);
    }
    setIsTestingConnection(false);
  };

  // ── Business Flow Management ──────────────────────────────────
  const [bizFlows, setBizFlows] = useState<{ objectId: string; name: string; isSmartscapeTopologyEnabled: boolean; stepsCount: number }[]>([]);
  const [isLoadingBizFlows, setIsLoadingBizFlows] = useState(false);
  const [isDeletingBizFlows, setIsDeletingBizFlows] = useState(false);
  const [bizFlowStatus, setBizFlowStatus] = useState('');

  const loadBizFlows = async () => {
    setIsLoadingBizFlows(true);
    setBizFlowStatus('⏳ Loading business flows...');
    try {
      const result = await callProxyWithRetry({ action: 'list-business-flows', apiHost: '', apiPort: '', apiProtocol: '' }) as any;
      if (result.success && result.data?.flows) {
        setBizFlows(result.data.flows);
        setBizFlowStatus(`Found ${result.data.flows.length} business flow(s)`);
      } else {
        setBizFlowStatus(`❌ ${result.error || 'Failed to list business flows'}`);
      }
    } catch (err: any) {
      setBizFlowStatus(`❌ ${err.message}`);
    }
    setIsLoadingBizFlows(false);
  };

  const deleteNonEntityBizFlows = async () => {
    const toDelete = bizFlows.filter(f => !f.isSmartscapeTopologyEnabled);
    if (toDelete.length === 0) {
      setBizFlowStatus('ℹ️ No non-entity business flows to delete');
      return;
    }
    setIsDeletingBizFlows(true);
    setBizFlowStatus(`🗑️ Deleting ${toDelete.length} non-entity business flow(s)...`);
    try {
      const result = await callProxyWithRetry({
        action: 'delete-business-flows', apiHost: '', apiPort: '', apiProtocol: '',
        body: { objectIds: toDelete.map(f => f.objectId) },
      }) as any;
      if (result.success) {
        setBizFlowStatus(`✅ Deleted ${result.data?.deletedCount || toDelete.length} business flow(s). Entity flows preserved.`);
        await loadBizFlows();
      } else {
        setBizFlowStatus(`❌ ${result.error}`);
      }
    } catch (err: any) {
      setBizFlowStatus(`❌ ${err.message}`);
    }
    setIsDeletingBizFlows(false);
  };

  // ── Services Modal Logic ──────────────────────────────────
  const openServicesModal = async () => {
    setShowServicesModal(true);
    setServicesStatus('');
    await Promise.all([loadRunningServices(), loadDormantServices()]);
  };

  const loadRunningServices = async () => {
    setIsLoadingServices(true);
    try {
      const result = await callProxyWithRetry(
        { action: 'get-services', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol }
      ) as any;
      if (result.success && result.data?.childServices) {
        setRunningServices(result.data.childServices);
        setServicesStatus(result.data.childServices.length > 0
          ? `${result.data.childServices.length} service(s) running`
          : 'No services running');
      } else {
        setRunningServices([]);
        setServicesStatus('Could not retrieve services');
      }
    } catch (error: any) {
      setRunningServices([]);
      setServicesStatus(`❌ ${error.message}`);
    }
    setIsLoadingServices(false);
  };

  const stopAllServices = async () => {
    setConfirmDialog({
      message: '⚠️ Stop ALL running services? This will kill every child service on the server.',
      onConfirm: () => doStopAllServices()
    });
  };

  const doStopAllServices = async () => {
    setIsStoppingServices(true);
    setServicesStatus('🛑 Stopping all services...');
    try {
      const result = await callProxyWithRetry(
        { action: 'stop-all-services', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol },
        5, 2000, setServicesStatus
      ) as any;
      setServicesStatus(result.success ? '✅ All services stopped!' : `❌ ${result.data?.error || 'Failed'}`);
      await Promise.all([loadRunningServices(), loadDormantServices()]);
    } catch (error: any) {
      setServicesStatus(`❌ ${error.message}`);
    }
    setIsStoppingServices(false);
  };

  const stopCompanyServices = async (company: string) => {
    setIsStoppingServices(true);
    setStoppingCompany(company);
    setServicesStatus(`🛑 Stopping services for ${company}...`);
    try {
      const result = await callProxyWithRetry(
        { action: 'stop-company-services', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol, body: { companyName: company } },
        5, 2000, setServicesStatus
      ) as any;
      setServicesStatus(result.success ? `✅ Stopped ${result.data?.stoppedServices?.length || 0} service(s) for ${company}` : `❌ ${result.data?.error || 'Failed'}`);
      await Promise.all([loadRunningServices(), loadDormantServices()]);
    } catch (error: any) {
      setServicesStatus(`❌ ${error.message}`);
    }
    setStoppingCompany(null);
    setIsStoppingServices(false);
  };

  // ── Dormant Services Logic ────────────────────────────────
  const loadDormantServices = async () => {
    setIsLoadingDormant(true);
    try {
      const result = await callProxyWithRetry(
        { action: 'get-dormant-services', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol }
      ) as any;
      if (result.success && result.data?.dormantServices) {
        setDormantServices(result.data.dormantServices);
      } else {
        setDormantServices([]);
      }
    } catch {
      setDormantServices([]);
    }
    setIsLoadingDormant(false);
  };

  const clearAllDormantServices = async () => {
    setIsClearingDormant(true);
    try {
      await callProxyWithRetry(
        { action: 'clear-dormant-services', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol }
      );
      setServicesStatus('🧹 Dormant services cleared');
      await loadDormantServices();
    } catch (error: any) {
      setServicesStatus(`❌ ${error.message}`);
    }
    setIsClearingDormant(false);
    setShowDormantWarning(null);
  };

  const clearCompanyDormantServices = async (company: string) => {
    setClearingDormantCompany(company);
    try {
      await callProxyWithRetry(
        { action: 'clear-company-dormant', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol, body: { companyName: company } }
      );
      setServicesStatus(`🧹 Dormant services cleared for ${company}`);
      await loadDormantServices();
    } catch (error: any) {
      setServicesStatus(`❌ ${error.message}`);
    }
    setClearingDormantCompany(null);
    setShowDormantWarning(null);
  };

  // ── Journeys Modal Logic ──────────────────────────────────
  const openJourneysModal = async () => {
    setShowJourneysModal(true);
    setJourneysStatus('');
    await Promise.all([loadJourneysData(), loadDormantServices()]);
  };

  const loadJourneysData = async () => {
    setIsLoadingJourneys(true);
    try {
      const result = await callProxyWithRetry(
        { action: 'get-services', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol }
      ) as any;
      if (result.success && result.data?.childServices) {
        const services: RunningService[] = result.data.childServices;
        setJourneysData(services);
        const count = services.length;
        setJourneysStatus(count > 0 ? `${count} service(s) across active journeys` : 'No active journeys');

        // Build unique company+journey pairs and check assets
        if (count > 0) {
          const pairs = new Map<string, { company: string; journeyType: string }>();
          services.forEach(s => {
            const company = s.companyName || 'Unknown';
            const jType = s.journeyType || 'Unknown';
            pairs.set(`${company}::${jType}`, { company, journeyType: jType });
          });
          try {
            const assetResult = await callProxyWithRetry({
              action: 'check-journey-assets',
              apiHost: '', apiPort: '', apiProtocol: '',
              body: { journeys: Array.from(pairs.values()) },
            }) as any;
            if (assetResult.success && assetResult.data) {
              setJourneyAssets(assetResult.data);
            }
          } catch { /* non-fatal */ }
        }
      } else {
        setJourneysData([]);
        setJourneysStatus('Could not retrieve journey data');
      }
    } catch (error: any) {
      setJourneysData([]);
      setJourneysStatus(`❌ ${error.message}`);
    }
    setIsLoadingJourneys(false);
  };



  /** Build a URL to the Dynatrace Dashboards app filtered by company */
  const getDashboardSearchUrl = (company: string) => {
    const q = encodeURIComponent(company);
    return `${TENANT_URL}/ui/apps/dynatrace.dashboards/?query=${q}`;
  };

  // Download dashboard JSON to browser
  const downloadDashboardJson = () => {
    if (!generatedDashboardJson) return;
    const dashboardName = generatedDashboardJson.name || generatedDashboardJson.metadata?.company || 'dashboard';
    const filename = `${dashboardName.replace(/\s+/g, '_')}.json`;
    // Export inner content only — Dynatrace import expects the content object, not the full doc wrapper
    const exportData = generatedDashboardJson.content || generatedDashboardJson;
    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  const chaosProxy = async (action: string, body?: any) => {
    return await callProxyWithRetry(
      { action, apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol, body }
    ) as any;
  };

  const openChaosModal = async () => {
    setShowChaosModal(true);
    setChaosStatus('');
    setChaosTab('active');
    await Promise.all([loadChaosData(), loadRunningServices()]);
  };

  const loadChaosData = async () => {
    setIsLoadingChaos(true);
    try {
      const [activeRes, recipesRes, targetedRes] = await Promise.all([
        chaosProxy('chaos-get-active'),
        chaosProxy('chaos-get-recipes'),
        chaosProxy('chaos-get-targeted'),
      ]);
      if (activeRes.success) setActiveFaults(activeRes.data?.activeFaults || activeRes.data || []);
      if (recipesRes.success) setChaosRecipes(activeRes.data?.recipes || recipesRes.data?.recipes || recipesRes.data || []);
      if (targetedRes.success) setTargetedServices(targetedRes.data?.serviceOverrides || targetedRes.data || {});
    } catch (error: any) {
      setChaosStatus(`❌ ${error.message}`);
    }
    setIsLoadingChaos(false);
  };

  const injectChaos = async () => {
    if (!injectForm.target) { setChaosStatus('⚠️ Select a target service'); return; }
    setIsInjectingChaos(true);
    setChaosStatus(`💉 Injecting chaos on ${injectForm.target}...`);
    try {
      const payload = { type: injectForm.type, target: injectForm.target, intensity: injectForm.intensity, duration: injectForm.duration };
      const result = await chaosProxy('chaos-inject', payload);
      if (result.success) {
        setChaosStatus(`✅ Chaos injected: ${injectForm.type} on ${injectForm.target} (intensity ${injectForm.intensity}, ${injectForm.duration}s)`);
        showToast(`💉 Nemesis injected on ${injectForm.target}`, 'warning', 5000);
        await loadChaosData();
      } else {
        setChaosStatus(`❌ ${result.data?.error || result.error || 'Injection failed'}`);
      }
    } catch (error: any) {
      setChaosStatus(`❌ ${error.message}`);
    }
    setIsInjectingChaos(false);
  };

  const revertFault = async (faultId: string) => {
    setIsRevertingChaos(true);
    setChaosStatus('🔄 Reverting fault...');
    try {
      const result = await chaosProxy('chaos-revert', { faultId });
      if (result.success) {
        setChaosStatus('✅ Fault reverted');
        showToast('✅ Chaos fault reverted', 'success');
        await loadChaosData();
      } else {
        setChaosStatus(`❌ ${result.data?.error || 'Revert failed'}`);
      }
    } catch (error: any) {
      setChaosStatus(`❌ ${error.message}`);
    }
    setIsRevertingChaos(false);
  };

  const revertAllFaults = async () => {
    setIsRevertingChaos(true);
    setChaosStatus('🔄 Reverting all faults...');
    try {
      const result = await chaosProxy('chaos-revert-all');
      if (result.success) {
        setChaosStatus('✅ All faults reverted');
        showToast('✅ All chaos faults reverted', 'success');
        await loadChaosData();
      } else {
        setChaosStatus(`❌ ${result.data?.error || 'Revert failed'}`);
      }
    } catch (error: any) {
      setChaosStatus(`❌ ${error.message}`);
    }
    setIsRevertingChaos(false);
  };

  const removeTargetedService = async (serviceName: string) => {
    try {
      const result = await chaosProxy('chaos-remove-target', { serviceName });
      if (result.success) {
        setChaosStatus(`✅ Removed override for ${serviceName}`);
        showToast(`✅ ${serviceName} error override removed`, 'success');
        await loadChaosData();
      } else {
        setChaosStatus(`❌ ${result.data?.error || 'Remove failed'}`);
      }
    } catch (error: any) {
      setChaosStatus(`❌ ${error.message}`);
    }
  };

  // ============================================================================
  // DASHBOARD GENERATION & DEPLOYMENT (Using Dynatrace SDK)
  // ============================================================================

  const openGenerateDashboardModal = async () => {
    setShowGenerateDashboardModal(true);
    setDashboardCompanyName('');
    setDashboardJourneyType('');
    setDashboardGenerationStatus('');
    setPdfStatus('');
    setVisualsSubTab('pdf');
    setIsLoadingDashboardData(true);

    try {
      const result = await callProxyWithRetry(
        { action: 'get-services', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol }
      ) as any;
      if (result.success && result.data?.childServices) {
        const services = result.data.childServices as RunningService[];
        const companies = Array.from(new Set(services.map(s => s.companyName).filter(Boolean))) as string[];
        const journeys = Array.from(new Set(services.map(s => s.journeyType).filter(Boolean))) as string[];
        setAvailableCompanies(companies.sort());
        setAvailableJourneys(journeys.sort());
        setRunningServices(services);
      } else {
        setAvailableCompanies([]);
        setAvailableJourneys([]);
      }
    } catch (error: any) {
      console.warn('[Generate Visuals] Failed to load services:', error.message);
      setAvailableCompanies([]);
      setAvailableJourneys([]);
    }
    setIsLoadingDashboardData(false);
  };

  // Load saved dashboards from EC2 host
  const loadSavedDashboards = async () => {
    setIsLoadingSavedDashboards(true);
    try {
      const result = await callProxyWithRetry({
        action: 'list-saved-dashboards',
        apiHost: apiSettings.host,
        apiPort: apiSettings.port,
        apiProtocol: apiSettings.protocol,
      }) as any;
      if (result.success && result.dashboards) {
        setSavedDashboards(result.dashboards);
      }
    } catch (err: any) {
      console.warn('[Saved Dashboards] Failed to load:', err.message);
    }
    setIsLoadingSavedDashboards(false);
  };

  // Deploy a saved dashboard to Dynatrace (re-use MCP deploy)
  const deploySavedDashboard = async (item: any) => {
    setDashboardGenerationStatus(`⏳ Deploying saved dashboard: ${item.company} / ${item.journeyType}...`);
    setVisualsSubTab('pdf');
    try {
      const result = await callProxyWithRetry({
        action: 'mcp-generate-deploy-dashboard',
        apiHost: apiSettings.host,
        apiPort: apiSettings.port,
        apiProtocol: apiSettings.protocol,
        body: { company: item.company, journeyType: item.journeyType, useAI: true },
      }, 5, 3000, setDashboardGenerationStatus) as any;
      if (result.success && result.data?.dashboardUrl) {
        const { dashboardUrl, tileCount, alreadyExisted } = result.data;
        const verb = alreadyExisted ? 'updated' : 'deployed';
        setDashboardGenerationStatus(`✅ ${tileCount} tiles ${verb} for ${item.company}`);
        setDashboardUrl(`${TENANT_URL}${dashboardUrl}`);
        showToast(`📊 Dashboard ${verb}! Click the link to open.`, 'success', 8000);
      } else {
        setDashboardGenerationStatus(`❌ ${result.error || 'Deploy failed'}`);
      }
    } catch (err: any) {
      setDashboardGenerationStatus(`❌ ${err.message}`);
    }
  };

  // Delete a saved dashboard from EC2 host
  const deleteSavedDashboard = async (id: string) => {
    try {
      await callProxyWithRetry({
        action: 'delete-saved-dashboard',
        apiHost: apiSettings.host,
        apiPort: apiSettings.port,
        apiProtocol: apiSettings.protocol,
        body: { dashboardId: id },
      }) as any;
      setSavedDashboards(prev => prev.filter(d => d.id !== id));
      showToast('🗑️ Dashboard removed.', 'info', 3000);
    } catch (err: any) {
      console.warn('[Saved Dashboards] Delete failed:', err.message);
    }
  };

  // Retry helper for EdgeConnect calls — retries with exponential backoff to survive reconnection gaps and timeouts.
  const callProxyWithRetry = async (payload: any, attempts = 5, initialDelayMs = 2000, statusSetter?: (msg: string) => void) => {
    let lastErr: any;
    for (let i = 1; i <= attempts; i++) {
      try {
        const res = await functions.call('proxy-api', { data: payload });
        return await res.json();
      } catch (err: any) {
        lastErr = err;
        const isRetryable = err.message?.includes('Connection error') || err.message?.includes('EdgeConnect') || err.message?.includes('timed out') || err.message?.includes('Signal');
        console.warn(`[Proxy retry] Attempt ${i}/${attempts} failed:`, err.message);
        if (i < attempts && isRetryable) {
          const delay = initialDelayMs * Math.pow(1.5, i - 1); // 2s, 3s, 4.5s, 6.75s
          if (statusSetter) statusSetter(`⏳ Retrying — attempt ${i}/${attempts - 1}...`);
          await new Promise(r => setTimeout(r, delay));
        } else if (!isRetryable) {
          throw err; // Non-retryable errors should not retry
        }
      }
    }
    throw lastErr;
  };

  // Shared helper — generates dashboard via MCP server and deploys directly to Dynatrace.
  // Called both manually (Generate Dashboard button) and automatically after a new journey is created.
  // When customPrompt is provided, the MCP server uses the prompt_dashboard tool to shape the dashboard via Ollama.
  const autoDownloadDashboard = async (company: string, journeyType: string, customPrompt?: string) => {
    try {
      const label = customPrompt ? '⏳ AI is crafting your custom dashboard via MCP...' : '⏳ Generating & deploying dashboard via MCP...';
      setDashboardStatus(label);
      const bodyPayload: any = { company, journeyType, useAI: true };
      if (customPrompt) bodyPayload.customPrompt = customPrompt;
      const result = await callProxyWithRetry({
          action: 'mcp-generate-deploy-dashboard',
          apiHost: apiSettings.host,
          apiPort: apiSettings.port,
          apiProtocol: apiSettings.protocol,
          body: bodyPayload
      }, 3, 5000, setDashboardStatus) as any;

      if (result.success && result.data?.dashboardUrl) {
        const { dashboardUrl, tileCount, dashboardName, generationMethod, alreadyExisted } = result.data;
        setGeneratedDashboardJson(null); // No local JSON needed — it's deployed
        const verb = alreadyExisted ? 'updated' : 'deployed';
        setDashboardStatus(`✅ ${tileCount} tiles ${verb} for ${company} via ${generationMethod}`);
        setDashboardUrl(`${TENANT_URL}${dashboardUrl}`);
        showToast(`📊 Dashboard ${verb}! Click the link to open it in Dynatrace.`, 'success', 8000);
      } else {
        throw new Error(result.error || result.data?.error || 'MCP dashboard generation failed');
      }
    } catch (err: any) {
      console.error('[Dashboard MCP deploy] ❌', err);
      // Fallback: try the old download approach
      console.log('[Dashboard] Falling back to download mode...');
      try {
        setDashboardStatus('⏳ Falling back to download mode...');
        const fallbackBody: any = { journeyData: { company, journeyType, tenantUrl: TENANT_URL }, useAI: true };
        if (customPrompt) fallbackBody.customPrompt = customPrompt;
        const generateData = await callProxyWithRetry({
            action: 'generate-dashboard',
            apiHost: apiSettings.host,
            apiPort: apiSettings.port,
            apiProtocol: apiSettings.protocol,
            body: fallbackBody
        }, 3, 5000, setDashboardStatus) as any;
        let dashboard = null;
        if (generateData.success && generateData.dashboard) {
          dashboard = generateData.dashboard;
        } else if (generateData.success && generateData.data?.dashboard) {
          dashboard = generateData.data.dashboard;
        } else {
          throw new Error(generateData.error || generateData.data?.error || 'Dashboard generation failed');
        }
        setGeneratedDashboardJson(dashboard);
        const dashboardName = dashboard.name || `${company}-${journeyType}`;
        const tileCount = dashboard.content?.tiles ? Object.keys(dashboard.content.tiles || {}).length : '?';
        const exportJson = JSON.stringify(dashboard.content, null, 2);
        const blob = new Blob([exportJson], { type: 'application/json' });
        const downloadUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = `${dashboardName.replace(/[\s/]+/g, '-').toLowerCase()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(downloadUrl);
        setDashboardStatus(`✅ ${tileCount} tiles generated for ${company} — ready to import`);
        setDashboardUrl(`${TENANT_URL}/ui/apps/dynatrace.dashboards`);
        showToast(`📥 Dashboard downloaded! Import it via Dynatrace → Dashboards → Upload.`, 'success', 8000);
      } catch (fallbackErr: any) {
        console.error('[Dashboard fallback download] ❌', fallbackErr);
        showToast(`⚠️ Dashboard failed: ${fallbackErr.message}`, 'warning', 6000);
      }
    }
  };
  // Auto-deploy a tailored Business Flow to Dynatrace whenever a journey is created.
  const autoDeployBusinessFlow = async (company: string, journeyType: string, steps: Array<{stepName?: string; name?: string; hasError?: boolean}>) => {
    try {
      const result = await callProxyWithRetry({
          action: 'deploy-business-flow',
          apiHost: apiSettings.host,
          apiPort: apiSettings.port,
          apiProtocol: apiSettings.protocol,
          body: { companyName: company, journeyType, steps }
      }) as any;
      if (result.success && result.data?.ok) {
        showToast(`🔄 Business Flow "${company} - ${journeyType}" deployed to Dynatrace!`, 'success', 6000);
      } else {
        const err = result.data?.error || result.error || 'Unknown error';
        console.warn('[Business Flow] Auto-deploy failed:', err);
        showToast(`⚠️ Business Flow deploy failed: ${err}`, 'warning', 5000);
      }
    } catch (err: any) {
      console.warn('[Business Flow] Auto-deploy error:', err.message);
    }
  };

  const generateAndDeployDashboard = async () => {
    if (!dashboardCompanyName || !dashboardJourneyType) {
      setDashboardGenerationStatus('⚠️ Please select both company and journey type');
      return;
    }

    setIsGeneratingDashboard(true);
    const hasPrompt = !!mcpDashboardPrompt.trim();
    setDashboardGenerationStatus(hasPrompt
      ? '🧠 AI is crafting your custom dashboard — this may take a minute...'
      : '🚀 Generating & deploying dashboard via MCP...');

    try {
      console.log('[Dashboard] 📊 MCP generate+deploy via proxy:', {
        company: dashboardCompanyName,
        journeyType: dashboardJourneyType,
        customPrompt: hasPrompt ? mcpDashboardPrompt.trim() : undefined,
      });

      // Use the MCP-powered seamless generate+deploy flow
      await autoDownloadDashboard(
        dashboardCompanyName,
        dashboardJourneyType,
        hasPrompt ? mcpDashboardPrompt.trim() : undefined
      );
      setDashboardGenerationStatus(`✅ Dashboard deployed to Dynatrace!`);
      setTimeout(() => setShowGenerateDashboardModal(false), 5000);
    } catch (error: any) {
      console.error('[Dashboard] ❌ Error:', error);
      setDashboardGenerationStatus(`❌ ${error.message}`);
      showToast(`❌ ${error.message}`, 'error', 5000);
    } finally {
      setIsGeneratingDashboard(false);
    }
  };

  const runSmartChaos = async () => {
    if (!smartChaosGoal.trim()) { setChaosStatus('⚠️ Enter a chaos goal'); return; }
    setIsSmartChaosRunning(true);
    setChaosStatus('🤖 Nemesis AI analysing and injecting chaos...');
    try {
      const result = await chaosProxy('chaos-smart', { goal: smartChaosGoal });
      if (result.success && result.data) {
        const d = result.data;
        setChaosStatus(`✅ Nemesis AI: ${d.type || 'injected'} on ${d.target || 'auto'} (intensity ${d.intensity || '?'})`);
        showToast(`👹 Nemesis unleashed: ${d.type || 'auto'}`, 'warning', 5000);
        setSmartChaosGoal('');
        await loadChaosData();
      } else {
        setChaosStatus(`❌ ${result.data?.error || result.error || 'Smart chaos failed'}`);
      }
    } catch (error: any) {
      setChaosStatus(`❌ ${error.message}`);
    }
    setIsSmartChaosRunning(false);
  };


  // Generate prompts when moving to step 2
  useEffect(() => {
    if (activeTab === 'step2' && companyName && domain) {
      const csuite = generateCsuitePrompt({ companyName, domain, requirements });
      const journey = generateJourneyPrompt({ companyName, domain, requirements });
      setPrompt1(csuite);
      setPrompt2(journey);
    }
  }, [activeTab, companyName, domain, requirements]);

  const copyToClipboard = (text: string, promptName: string) => {
    navigator.clipboard.writeText(text);
    showToast(`${promptName} copied to clipboard!`, 'success', 2500);
  };

  const processResponse = async () => {
    if (!copilotResponse.trim()) {
      showToast('Please paste the AI response before proceeding.', 'warning');
      return;
    }
    
    try {
      // Strip markdown code fences if present
      let cleanResponse = copilotResponse.trim();
      if (cleanResponse.startsWith('```')) {
        cleanResponse = cleanResponse.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      const parsedResponse = JSON.parse(cleanResponse);
      setGenerationStatus('✅ JSON validated successfully');
      
      // Check if it looks like a journey config
      if (!parsedResponse.journey && !parsedResponse.steps) {
        showToast('Response is valid JSON, but might be missing journey data. Expected "journey" or "steps" field.', 'warning', 6000);
        return;
      }
      
      showToast('Response validated! JSON is ready for service generation.', 'success');
    } catch (error) {
      showToast('Invalid JSON response. Please check the format and try again.', 'error');
      setGenerationStatus('❌ JSON validation failed');
    }
  };

  // Start VCARB Race Operations — loads saved config and triggers journey simulation
  const startVcarbRace = async () => {
    try {
      setIsStartingRace(true);
      setRaceStatus('🏎️ Loading VCARB config...');

      setRaceStatus('🏁 Starting race simulation...');

      const result = await callProxyWithRetry({
        action: 'simulate-vcarb-race',
        apiHost: apiSettings.host,
        apiPort: apiSettings.port,
        apiProtocol: apiSettings.protocol,
        body: { configName: 'vcarb-race-operations' },
      }, 5, 2000) as any;

      if (!result.success) {
        throw new Error(result.error || 'Failed to start VCARB race');
      }

      // Store the raceId so dashboards filter to this specific race
      if (result.raceId) {
        localStorage.setItem('vcarb-active-raceId', result.raceId);
      }

      setRaceStatus('✅ Race is live!');
      showToast('🏎️ VCARB Race Operations started! Opening dashboard...', 'success', 3000);
      setTimeout(() => { setRaceStatus(null); navigate('/vcarb'); }, 1500);
    } catch (err: any) {
      console.error('[VCARB] Start race error:', err);
      setRaceStatus(`❌ ${err.message}`);
      showToast(`Failed to start VCARB race: ${err.message}`, 'error', 8000);
      setTimeout(() => setRaceStatus(null), 8000);
    } finally {
      setIsStartingRace(false);
    }
  };

  const generateServices = async () => {
    if (!copilotResponse.trim()) {
      showToast('Please paste the AI response before generating services.', 'warning');
      return;
    }

    try {
      setIsGeneratingServices(true);
      setGenerationStatus('🔄 Parsing journey data...');
      
      // Strip markdown code fences if present
      let cleanResponse = copilotResponse.trim();
      if (cleanResponse.startsWith('```')) {
        cleanResponse = cleanResponse.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      const parsedResponse = JSON.parse(cleanResponse);
      
      // Validate journey structure
      if (!parsedResponse.journey && !parsedResponse.steps) {
        throw new Error('Missing journey or steps data in response');
      }

      setGenerationStatus(`🚀 Creating services on ${apiSettings.host}:${apiSettings.port}...`);
      
      // Call via serverless proxy function (bypasses CSP)
      const result = await callProxyWithRetry({
          action: 'simulate-journey',
          apiHost: apiSettings.host,
          apiPort: apiSettings.port,
          apiProtocol: apiSettings.protocol,
          body: parsedResponse,
      }, 5, 2000, setGenerationStatus) as any;

      if (!result.success) {
        throw new Error(result.error || `API call failed (status ${result.status})`);
      }

      const data = result.data as any;
      const journey = data?.journey;
      const jId = journey?.journeyId || data?.journeyId || 'N/A';
      const jCompany = journey?.steps?.[0]?.companyName || data?.companyName || companyName;
      setGenerationStatus(`✅ Services created successfully! Journey ID: ${jId}`);
      showToast(`Services generated! Journey: ${jId} • Company: ${jCompany}`, 'success', 6000);

      // Build full steps for business flow deployment
      const journeyConfig = parsedResponse.journey || parsedResponse;
      const fullSteps = (journeyConfig.steps || parsedResponse.steps || []).map((s: any) => ({
        ...s,
        stepName: s.stepName || s.name,
        serviceName: s.serviceName || s.service,
        companyName: s.companyName || jCompany,
      }));

      // Auto-deploy Business Flow to Dynatrace for this journey
      autoDeployBusinessFlow(
        jCompany,
        journeyConfig.journeyType || parsedResponse.journey?.journeyType || domain,
        fullSteps
      );
      
    } catch (error: any) {
      console.error('Service generation error:', error);
      setGenerationStatus(`❌ Failed: ${error.message}`);
      showToast(`Failed to generate services: ${error.message}`, 'error', 8000);
    } finally {
      setIsGeneratingServices(false);
    }
  };

  const saveTemplate = () => {
    if (!templateName.trim()) {
      showToast('Please enter a template name.', 'warning');
      return;
    }

    const newTemplate: PromptTemplate = {
      id: `template_${Date.now()}`,
      name: templateName,
      companyName,
      domain,
      requirements,
      csuitePrompt: prompt1,
      journeyPrompt: prompt2,
      response: copilotResponse, // Save the JSON response
      createdAt: new Date().toISOString(),
      isPreloaded: false // User-created template
    };

    const updated = [...savedTemplates, newTemplate];
    setSavedTemplates(updated);
    localStorage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(updated));
    saveTenantField({ promptTemplates: JSON.stringify(updated) });
    setTemplateName('');
    setShowSaveDialog(false);
    showToast(`Template "${templateName}" saved!`, 'success');
  };

  // ── Full AI Generation Pipeline (modal flow) ─────────────
  const runAiGenerationPipeline = async () => {
    type StepObj = { label: string; status: 'pending' | 'running' | 'done' | 'error'; detail?: string };
    const steps: StepObj[] = [
      { label: 'Generating C-Suite Analysis', status: 'pending' },
      { label: 'Generating Journey Config', status: 'pending' },
      { label: 'Validating JSON', status: 'pending' },
      { label: 'Creating Services', status: 'pending' },
      { label: 'Saving to My Templates', status: 'pending' },
    ];
    setAiGenSteps([...steps]);
    setAiGenComplete(false);
    setAiGenError('');
    setShowAiGenModal(true);

    const updateStep = (idx: number, update: Partial<StepObj>) => {
      steps[idx] = { ...steps[idx], ...update };
      setAiGenSteps([...steps]);
    };

    try {
      // Build prompts
      const csuite = generateCsuitePrompt({ companyName, domain, requirements });
      const journey = generateJourneyPrompt({ companyName, domain, requirements });
      setPrompt1(csuite);
      setPrompt2(journey);

      // Step 1: Generate C-Suite Analysis
      updateStep(0, { status: 'running' });
      setGhGenerating1(true);
      setGhResult1('');
      const res1 = await callProxyWithRetry({
        action: 'github-copilot-generate',
        apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol,
        body: { prompt: csuite, model: ghCopilotModel },
      });
      setGhGenerating1(false);
      if (!res1.success) {
        throw new Error(`C-Suite generation failed: ${res1.error}`);
      }
      setGhResult1(res1.data.content);
      const g1 = res1.data.genai;
      updateStep(0, { status: 'done', detail: g1 ? `${g1.model} · ${g1.totalTokens} tokens · ${(g1.durationMs / 1000).toFixed(1)}s` : `Model: ${res1.data.model}` });

      // Step 2: Generate Journey Config
      updateStep(1, { status: 'running' });
      setGhGenerating2(true);
      setGhResult2('');
      const contextPrefix = `Here is the C-suite analysis from the previous step:\n\n${res1.data.content}\n\nNow, based on that context:\n\n`;
      const res2 = await callProxyWithRetry({
        action: 'github-copilot-generate',
        apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol,
        body: { prompt: contextPrefix + journey, model: ghCopilotModel },
      });
      setGhGenerating2(false);
      if (!res2.success) {
        throw new Error(`Journey generation failed: ${res2.error}`);
      }
      setGhResult2(res2.data.content);
      const g2 = res2.data.genai;
      updateStep(1, { status: 'done', detail: g2 ? `${g2.model} · ${g2.totalTokens} tokens · ${(g2.durationMs / 1000).toFixed(1)}s` : `Model: ${res2.data.model}` });

      // Step 3: Validate JSON
      updateStep(2, { status: 'running' });
      let cleanJson = res2.data.content.trim();
      if (cleanJson.startsWith('```')) {
        cleanJson = cleanJson.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      const parsedResponse = JSON.parse(cleanJson);
      if (!parsedResponse.journey && !parsedResponse.steps) {
        throw new Error('Invalid response: missing "journey" or "steps" field');
      }
      setCopilotResponse(cleanJson);
      const journeyConfig = parsedResponse.journey || parsedResponse;
      const jType = journeyConfig.journeyType || parsedResponse.journey?.journeyType || domain;
      const stepCount = (journeyConfig.steps || parsedResponse.steps || []).length;
      updateStep(2, { status: 'done', detail: `${stepCount} steps · ${jType}` });

      // Step 4: Generate Services
      updateStep(3, { status: 'running' });
      setIsGeneratingServices(true);
      const result = await callProxyWithRetry({
        action: 'simulate-journey',
        apiHost: apiSettings.host,
        apiPort: apiSettings.port,
        apiProtocol: apiSettings.protocol,
        body: parsedResponse,
      }, 5, 2000) as any;
      setIsGeneratingServices(false);
      if (!result.success) {
        throw new Error(result.error || `Service creation failed (status ${result.status})`);
      }
      const data = result.data as any;
      const jObj = data?.journey;
      const jId = jObj?.journeyId || data?.journeyId || 'N/A';
      const jCompany = jObj?.steps?.[0]?.companyName || data?.companyName || companyName;
      updateStep(3, { status: 'done', detail: `Journey: ${jId}` });

      // Auto-deploy Business Flow
      const fullSteps = (journeyConfig.steps || parsedResponse.steps || []).map((s: any) => ({
        ...s,
        stepName: s.stepName || s.name,
        serviceName: s.serviceName || s.service,
        companyName: s.companyName || jCompany,
      }));
      autoDeployBusinessFlow(jCompany, jType, fullSteps);

      // Step 5: Auto-save to My Templates
      updateStep(4, { status: 'running' });
      const autoTemplateName = `${companyName} - ${jType}`;
      const newTemplate: PromptTemplate = {
        id: `template_${Date.now()}`,
        name: autoTemplateName,
        companyName,
        domain,
        requirements,
        csuitePrompt: csuite,
        journeyPrompt: journey,
        response: cleanJson,
        createdAt: new Date().toISOString(),
        isPreloaded: false,
      };
      const updated = [...savedTemplates, newTemplate];
      setSavedTemplates(updated);
      localStorage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(updated));
      saveTenantField({ promptTemplates: JSON.stringify(updated) });
      updateStep(4, { status: 'done', detail: `Saved as "${autoTemplateName}"` });

      setAiGenComplete(true);
      setGenerationStatus(`✅ Services created successfully! Journey ID: ${jId}`);
      setActiveTab('step2');
      setStep2Phase('generate');
    } catch (err: any) {
      setGhGenerating1(false);
      setGhGenerating2(false);
      setIsGeneratingServices(false);
      const failedIdx = steps.findIndex(s => s.status === 'running');
      if (failedIdx >= 0) updateStep(failedIdx, { status: 'error', detail: err.message });
      setAiGenError(err.message);
    }
  };

  // ── Extract journey names from a pasted C-Suite AI response ─────────────
  const extractJourneysFromText = (text: string): string[] => {
    const journeys: string[] = [];
    // Look for quoted journey names after "Journey Names" or "Journey Classification"
    const classificationMatch = text.match(/Journey (?:Names|Classification)[:\s]*\n([\s\S]*?)(?:\n###|\n##|\n\*\*[A-Z]|\n---|\n$)/i);
    if (classificationMatch) {
      const block = classificationMatch[1];
      // Match quoted strings like "Vehicle Purchase Journey"
      const quoted = block.match(/"([^"]+)"/g);
      if (quoted) {
        quoted.forEach(q => {
          const name = q.replace(/"/g, '').trim();
          if (name && !name.toLowerCase().includes('industry type')) journeys.push(name);
        });
      }
      // Also match bullet items like - Vehicle Purchase Journey (without quotes)
      if (journeys.length === 0) {
        const bullets = block.match(/[-•]\s+(.+)/g);
        if (bullets) {
          bullets.forEach(b => {
            const name = b.replace(/^[-•]\s+/, '').replace(/\*\*/g, '').trim();
            if (name && name.length < 80 && !name.toLowerCase().includes('industry type')) journeys.push(name);
          });
        }
      }
    }
    // Fallback: look for "Critical User Journeys" section
    if (journeys.length === 0) {
      const criticalMatch = text.match(/Critical User (?:Journeys|Flows)[:\s]*\n([\s\S]*?)(?:\n###|\n##|\n\*\*[A-Z]|\n---|\n$)/i);
      if (criticalMatch) {
        const block = criticalMatch[1];
        const bullets = block.match(/[-•]\s+\*\*([^*]+)\*\*/g);
        if (bullets) {
          bullets.forEach(b => {
            const name = b.replace(/^[-•]\s+\*\*/, '').replace(/\*\*$/, '').trim();
            if (name) journeys.push(name);
          });
        }
      }
    }
    return journeys;
  };

  // ── Pipeline using pasted C-Suite analysis + selected journey ─────────────
  const runPastedAiPipeline = async (csuiteText: string, journeyName: string) => {
    type StepObj = { label: string; status: 'pending' | 'running' | 'done' | 'error'; detail?: string };
    const steps: StepObj[] = [
      { label: 'Using Pasted C-Suite Analysis', status: 'pending' },
      { label: `Generating "${journeyName}" Config`, status: 'pending' },
      { label: 'Validating JSON', status: 'pending' },
      { label: 'Creating Services', status: 'pending' },
      { label: 'Saving to My Templates', status: 'pending' },
    ];
    setAiGenSteps([...steps]);
    setAiGenComplete(false);
    setAiGenError('');
    setShowPasteAiModal(false);
    setShowAiGenModal(true);

    const updateStep = (idx: number, update: Partial<StepObj>) => {
      steps[idx] = { ...steps[idx], ...update };
      setAiGenSteps([...steps]);
    };

    try {
      // Step 1: Use pasted analysis (already have it)
      updateStep(0, { status: 'running' });
      setGhResult1(csuiteText);
      const csuite = `[Pasted from external AI]\n\n${csuiteText.substring(0, 200)}...`;
      setPrompt1(csuite);
      updateStep(0, { status: 'done', detail: `${csuiteText.length.toLocaleString()} chars · ${extractedJourneys.length} journeys found` });

      // Step 2: Generate Journey Config with selected journey
      updateStep(1, { status: 'running' });
      setGhGenerating2(true);
      setGhResult2('');
      // Override requirements with the selected journey name
      const journeyReqs = `${journeyName} — based on the C-suite analysis provided`;
      const journey = generateJourneyPrompt({ companyName, domain, requirements: journeyReqs });
      setPrompt2(journey);
      const contextPrefix = `Here is the C-suite analysis from the previous step:\n\n${csuiteText}\n\nNow, based on that context, generate the "${journeyName}" journey:\n\n`;
      const res2 = await callProxyWithRetry({
        action: 'github-copilot-generate',
        apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol,
        body: { prompt: contextPrefix + journey, model: ghCopilotModel },
      });
      setGhGenerating2(false);
      if (!res2.success) {
        throw new Error(`Journey generation failed: ${res2.error}`);
      }
      setGhResult2(res2.data.content);
      const g2 = res2.data.genai;
      updateStep(1, { status: 'done', detail: g2 ? `${g2.model} · ${g2.totalTokens} tokens · ${(g2.durationMs / 1000).toFixed(1)}s` : `Model: ${res2.data.model}` });

      // Step 3: Validate JSON
      updateStep(2, { status: 'running' });
      let cleanJson = res2.data.content.trim();
      if (cleanJson.startsWith('```')) {
        cleanJson = cleanJson.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      const parsedResponse = JSON.parse(cleanJson);
      if (!parsedResponse.journey && !parsedResponse.steps) {
        throw new Error('Invalid response: missing "journey" or "steps" field');
      }
      setCopilotResponse(cleanJson);
      const journeyConfig = parsedResponse.journey || parsedResponse;
      const jType = journeyConfig.journeyType || parsedResponse.journey?.journeyType || domain;
      const stepCount = (journeyConfig.steps || parsedResponse.steps || []).length;
      updateStep(2, { status: 'done', detail: `${stepCount} steps · ${jType}` });

      // Step 4: Generate Services
      updateStep(3, { status: 'running' });
      setIsGeneratingServices(true);
      const result = await callProxyWithRetry({
        action: 'simulate-journey',
        apiHost: apiSettings.host,
        apiPort: apiSettings.port,
        apiProtocol: apiSettings.protocol,
        body: parsedResponse,
      }, 5, 2000) as any;
      setIsGeneratingServices(false);
      if (!result.success) {
        throw new Error(result.error || `Service creation failed (status ${result.status})`);
      }
      const data = result.data as any;
      const jObj = data?.journey;
      const jId = jObj?.journeyId || data?.journeyId || 'N/A';
      const jCompany = jObj?.steps?.[0]?.companyName || data?.companyName || companyName;
      updateStep(3, { status: 'done', detail: `Journey: ${jId}` });

      // Auto-deploy Business Flow
      const fullSteps = (journeyConfig.steps || parsedResponse.steps || []).map((s: any) => ({
        ...s,
        stepName: s.stepName || s.name,
        serviceName: s.serviceName || s.service,
        companyName: s.companyName || jCompany,
      }));
      autoDeployBusinessFlow(jCompany, jType, fullSteps);

      // Step 5: Auto-save to My Templates
      updateStep(4, { status: 'running' });
      const autoTemplateName = `${companyName} - ${jType}`;
      const newTemplate: PromptTemplate = {
        id: `template_${Date.now()}`,
        name: autoTemplateName,
        companyName,
        domain,
        requirements: journeyReqs,
        csuitePrompt: csuite,
        journeyPrompt: journey,
        response: cleanJson,
        createdAt: new Date().toISOString(),
        isPreloaded: false,
      };
      const updated = [...savedTemplates, newTemplate];
      setSavedTemplates(updated);
      localStorage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(updated));
      saveTenantField({ promptTemplates: JSON.stringify(updated) });
      updateStep(4, { status: 'done', detail: `Saved as "${autoTemplateName}"` });

      setAiGenComplete(true);
      setGenerationStatus(`✅ Services created successfully! Journey ID: ${jId}`);
      setActiveTab('step2');
      setStep2Phase('generate');
    } catch (err: any) {
      setGhGenerating2(false);
      setIsGeneratingServices(false);
      const failedIdx = steps.findIndex(s => s.status === 'running');
      if (failedIdx >= 0) updateStep(failedIdx, { status: 'error', detail: err.message });
      setAiGenError(err.message);
    }
  };

  const loadTemplate = (templateId: string) => {
    const template = savedTemplates.find(t => t.id === templateId);
    if (template) {
      setCompanyName(template.companyName);
      setDomain(template.domain);
      setRequirements(template.requirements);
      setPrompt1(template.csuitePrompt);
      setPrompt2(template.journeyPrompt);
      // Load response - either from response field or originalConfig
      if (template.response) {
        setCopilotResponse(template.response);
      } else if (template.originalConfig) {
        // For pre-loaded templates, check for copilotResponseStep2 field
        const configResponse = template.originalConfig.copilotResponseStep2 
          || template.originalConfig.copilotResponse 
          || JSON.stringify(template.originalConfig, null, 2);
        setCopilotResponse(configResponse);
      } else {
        setCopilotResponse('');
      }
      setSelectedTemplate(templateId);
      setActiveTab('step1'); // Navigate to step 1 to see the loaded data
    }
  };

  const deleteTemplate = (templateId: string) => {
    setConfirmDialog({
      message: 'Are you sure you want to delete this template?',
      onConfirm: () => {
        const updated = savedTemplates.filter(t => t.id !== templateId);
        setSavedTemplates(updated);
        localStorage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(updated));
        saveTenantField({ promptTemplates: JSON.stringify(updated) });
        if (selectedTemplate === templateId) {
          setSelectedTemplate('');
        }
        showToast('Template deleted.', 'success');
      }
    });
  };

  const exportTemplate = (templateId: string) => {
    const template = savedTemplates.find(t => t.id === templateId);
    if (template) {
      const dataStr = JSON.stringify(template, null, 2);
      const dataBlob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(dataBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${template.companyName.replace(/\s+/g, '-')}-${template.name.replace(/\s+/g, '-')}.json`;
      link.click();
      URL.revokeObjectURL(url);
    }
  };

  const exportAllTemplates = () => {
    const dataStr = JSON.stringify(savedTemplates, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `all-templates-${new Date().toISOString().split('T')[0]}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const importTemplates = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const imported = JSON.parse(content);
        
        // Check if it's a single template or array
        const templates = Array.isArray(imported) ? imported : [imported];
        
        // Merge with existing templates, avoiding duplicates
        const merged = [...savedTemplates];
        templates.forEach((t: PromptTemplate) => {
          if (!merged.find(existing => existing.id === t.id)) {
            merged.push(t);
          }
        });
        
        setSavedTemplates(merged);
        localStorage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(merged));
        saveTenantField({ promptTemplates: JSON.stringify(merged) });
        showToast(`Imported ${templates.length} template(s) successfully!`, 'success');
      } catch (error) {
        showToast('Failed to import templates. Please check the file format.', 'error');
      }
    };
    reader.readAsText(file);

    // Reset the input so the same file can be re-imported
    event.target.value = '';
  };

  // Separate pre-loaded and user-created templates
  const preloadedTemplates = savedTemplates.filter(t => t.isPreloaded);
  const userTemplates = savedTemplates.filter(t => !t.isPreloaded);

  // Group templates by company name
  const groupTemplatesByCompany = (templates: PromptTemplate[]) => {
    return templates.reduce((acc, template) => {
      const company = template.companyName || 'Uncategorized';
      if (!acc[company]) {
        acc[company] = [];
      }
      acc[company].push(template);
      return acc;
    }, {} as Record<string, PromptTemplate[]>);
  };

  const preloadedByCompany = groupTemplatesByCompany(preloadedTemplates);
  const userTemplatesByCompany = groupTemplatesByCompany(userTemplates);

  const [expandedCompanies, setExpandedCompanies] = useState<Record<string, boolean>>({});
  const [templateSearch, setTemplateSearch] = useState('');

  // Filter templates by search term (matches company name or template name)
  const filterBySearch = (grouped: Record<string, PromptTemplate[]>) => {
    if (!templateSearch.trim()) return grouped;
    const q = templateSearch.toLowerCase();
    const result: Record<string, PromptTemplate[]> = {};
    for (const [company, templates] of Object.entries(grouped)) {
      if (company.toLowerCase().includes(q)) {
        result[company] = templates;
      } else {
        const matched = templates.filter(t => t.name.toLowerCase().includes(q));
        if (matched.length) result[company] = matched;
      }
    }
    return result;
  };

  const filteredPreloaded = filterBySearch(preloadedByCompany);
  const filteredUserTemplates = filterBySearch(userTemplatesByCompany);

  const toggleCompany = (company: string) => {
    setExpandedCompanies(prev => ({
      ...prev,
      [company]: !prev[company]
    }));
  };

  const toggleSection = (section: string) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }));
  };

  const renderSidebar = () => (
    <div style={{
      width: 260,
      height: '100%',
      position: 'relative',
      background: Colors.Background.Surface.Default,
      borderRight: `2px solid ${Colors.Border.Neutral.Default}`,
      overflowY: 'auto',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0
    }}>
      {/* Sidebar Header */}
      <div style={{ 
        padding: 16,
        borderBottom: `2px solid ${Colors.Border.Neutral.Default}`,
        background: `linear-gradient(135deg, ${Colors.Theme.Primary['70']}, rgba(0, 212, 255, 0.8))`,
      }}>
        <Flex alignItems="center" gap={8} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 22 }}>📁</div>
          <Heading level={5} style={{ marginBottom: 0, color: 'white' }}>Template Library</Heading>
        </Flex>
        <Paragraph style={{ fontSize: 10, marginBottom: 0, color: 'rgba(255,255,255,0.9)', lineHeight: 1.4 }}>
          {preloadedTemplates.length} Preset • {userTemplates.length} Custom
        </Paragraph>
      </div>

      {/* Save Current Button */}
      <div style={{ padding: 12, borderBottom: `1px solid ${Colors.Border.Neutral.Default}` }}>
        <Button 
          variant="emphasized"
          onClick={() => setShowSaveDialog(true)}
          disabled={!companyName || !domain}
          style={{ width: '100%', marginBottom: 6 }}
        >
          💾 Save to My Templates
        </Button>
        <Flex gap={6}>
          <Button onClick={() => fileInputRef.current?.click()} style={{ flex: 1, fontSize: 11, padding: '6px' }}>📥 Import</Button>
          <input ref={fileInputRef} type="file" accept=".json" onChange={importTemplates} style={{ display: 'none' }} />
          <Button onClick={exportAllTemplates} disabled={savedTemplates.length === 0} style={{ flex: 1, fontSize: 11, padding: '6px' }}>📤 Export</Button>
        </Flex>
      </div>

      {/* Save Dialog */}
      {showSaveDialog && (
        <div style={{ 
          padding: 16,
          background: 'rgba(108, 44, 156, 0.15)',
          borderBottom: `2px solid ${Colors.Theme.Primary['70']}`
        }}>
          <Heading level={6} style={{ marginBottom: 12 }}>Save New Template</Heading>
          <TextInput 
            value={templateName}
            onChange={(value) => setTemplateName(value)}
            placeholder="Template name..."
            style={{ marginBottom: 8 }}
          />
          <Flex gap={8}>
            <Button variant="emphasized" onClick={saveTemplate} style={{ flex: 1 }}>Save</Button>
            <Button onClick={() => setShowSaveDialog(false)} style={{ flex: 1 }}>Cancel</Button>
          </Flex>
        </div>
      )}

      {/* Search */}
      <div style={{ padding: '8px 12px', borderBottom: `1px solid ${Colors.Border.Neutral.Default}` }}>
        <TextInput
          value={templateSearch}
          onChange={(value: string) => setTemplateSearch(value)}
          placeholder="🔍 Search templates..."
        />
      </div>

      {/* Templates List - Separated by Type */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {/* App Templates Section */}
        <div style={{ marginBottom: 24 }}>
          <div 
            onClick={() => toggleSection('appTemplates')}
            style={{
              padding: 14,
              background: 'linear-gradient(135deg, rgba(0, 161, 201, 0.25), rgba(0, 161, 201, 0.15))',
              borderRadius: 10,
              border: '2px solid rgba(0, 161, 201, 0.6)',
              cursor: 'pointer',
              marginBottom: 12,
              boxShadow: '0 2px 8px rgba(0, 161, 201, 0.2)'
            }}
          >
            <Flex justifyContent="space-between" alignItems="center">
              <Flex alignItems="center" gap={12}>
                <div style={{ fontSize: 20 }}>{expandedSections.appTemplates ? '📂' : '📁'}</div>
                <div>
                  <Strong style={{ fontSize: 15, display: 'block' }}>🏛️ App Templates</Strong>
                  <Paragraph style={{ fontSize: 11, marginBottom: 0, marginTop: 2, opacity: 0.8 }}>
                    Preset templates included with the app
                  </Paragraph>
                </div>
              </Flex>
              <div style={{
                background: 'rgba(0, 161, 201, 0.8)',
                color: 'white',
                padding: '4px 12px',
                borderRadius: 14,
                fontSize: 12,
                fontWeight: 700
              }}>
                {preloadedTemplates.length}
              </div>
            </Flex>
          </div>

          {(expandedSections.appTemplates || templateSearch.trim()) && (
            <div style={{ paddingLeft: 8 }}>
              {Object.keys(filteredPreloaded).sort().map(company => (
            <div key={company} style={{ marginBottom: 16 }}>
              {/* Company Header */}
              <div 
                onClick={() => toggleCompany(company)}
                style={{
                  padding: 12,
                  background: `linear-gradient(135deg, rgba(108, 44, 156, 0.2), rgba(0, 212, 255, 0.1))`,
                  borderRadius: 8,
                  border: `1px solid ${Colors.Theme.Primary['70']}`,
                  cursor: 'pointer',
                  marginBottom: 8
                }}
              >
                <Flex justifyContent="space-between" alignItems="center">
                  <Flex alignItems="center" gap={8}>
                    <div style={{ fontSize: 16 }}>{expandedCompanies[company] ? '📂' : '📁'}</div>
                    <Strong style={{ fontSize: 14 }}>{company}</Strong>
                  </Flex>
                  <div style={{
                    background: Colors.Theme.Primary['70'],
                    color: 'white',
                    padding: '2px 8px',
                    borderRadius: 12,
                    fontSize: 11,
                    fontWeight: 600
                  }}>
                    {filteredPreloaded[company].length}
                  </div>
                </Flex>
              </div>

              {/* Templates under this company */}
              {(expandedCompanies[company] || templateSearch.trim()) && (
                <div style={{ paddingLeft: 8 }}>
                  {filteredPreloaded[company].map(template => (
                    <div 
                      key={template.id}
                      style={{
                        padding: 12,
                        marginBottom: 8,
                        background: selectedTemplate === template.id 
                          ? 'rgba(115, 190, 40, 0.2)' 
                          : Colors.Background.Base.Default,
                        borderRadius: 6,
                        border: `1px solid ${
                          selectedTemplate === template.id 
                            ? Colors.Theme.Success['70'] 
                            : Colors.Border.Neutral.Default
                        }`,
                        cursor: 'pointer',
                        transition: 'all 0.2s ease'
                      }}
                      onClick={() => loadTemplate(template.id)}
                    >
                      <Flex alignItems="flex-start" gap={8}>
                        <div style={{ fontSize: 16, marginTop: 2 }}>
                          {selectedTemplate === template.id ? '✅' : '📄'}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <Strong style={{ 
                            fontSize: 13, 
                            display: 'block',
                            marginBottom: 4,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}>
                            {template.name}
                          </Strong>
                          <Paragraph style={{ 
                            fontSize: 11, 
                            marginBottom: 4,
                            opacity: 0.7,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}>
                            {template.domain}
                          </Paragraph>
                          <Paragraph style={{ fontSize: 10, marginBottom: 0, opacity: 0.5 }}>
                            {new Date(template.createdAt).toLocaleDateString()}
                          </Paragraph>
                        </div>
                      </Flex>
                      
                      {/* Action Buttons */}
                      <Flex gap={4} style={{ marginTop: 8 }}>
                        <Button 
                          onClick={(e) => {
                            e.stopPropagation();
                            loadTemplate(template.id);
                          }}
                          style={{ flex: 1, fontSize: 11, padding: '6px' }}
                        >
                          📂 Load
                        </Button>
                        <Button 
                          onClick={(e) => {
                            e.stopPropagation();
                            exportTemplate(template.id);
                          }}
                          style={{ flex: 1, fontSize: 11, padding: '6px' }}
                        >
                          📤 Export
                        </Button>
                        {!template.isPreloaded && (
                          <Button 
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteTemplate(template.id);
                            }}
                            style={{ fontSize: 11, padding: '6px' }}
                          >
                            🗑️
                          </Button>
                        )}
                      </Flex>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
            </div>
          )}
        </div>

        {/* My Templates Section */}
        <div style={{ marginBottom: 24 }}>
          <div 
            onClick={() => toggleSection('myTemplates')}
            style={{
              padding: 14,
              background: 'linear-gradient(135deg, rgba(108, 44, 156, 0.25), rgba(108, 44, 156, 0.15))',
              borderRadius: 10,
              border: '2px solid rgba(108, 44, 156, 0.6)',
              cursor: 'pointer',
              marginBottom: 12,
              boxShadow: '0 2px 8px rgba(108, 44, 156, 0.2)'
            }}
          >
            <Flex justifyContent="space-between" alignItems="center">
              <Flex alignItems="center" gap={12}>
                <div style={{ fontSize: 20 }}>{expandedSections.myTemplates ? '📂' : '📁'}</div>
                <div>
                  <Strong style={{ fontSize: 15, display: 'block' }}>✨ My Templates</Strong>
                  <Paragraph style={{ fontSize: 11, marginBottom: 0, marginTop: 2, opacity: 0.8 }}>
                    Templates you create and save
                  </Paragraph>
                </div>
              </Flex>
              <div style={{
                background: 'rgba(108, 44, 156, 0.8)',
                color: 'white',
                padding: '4px 12px',
                borderRadius: 14,
                fontSize: 12,
                fontWeight: 700
              }}>
                {userTemplates.length}
              </div>
            </Flex>
          </div>

          {(expandedSections.myTemplates || templateSearch.trim()) && (
            <div style={{ paddingLeft: 8 }}>
              {userTemplates.length === 0 && !templateSearch.trim() ? (
                <div style={{
                  padding: 20,
                  textAlign: 'center',
                  background: 'rgba(108, 44, 156, 0.1)',
                  borderRadius: 8,
                  border: `1px dashed ${Colors.Border.Neutral.Default}`,
                  marginBottom: 12
                }}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>✨</div>
                  <Paragraph style={{ fontSize: 12, marginBottom: 0, lineHeight: 1.5 }}>
                    <Strong>No custom templates yet</Strong><br/>
                    Click "💾 Save Current" above to create your first template!
                  </Paragraph>
                </div>
              ) : (
                Object.keys(filteredUserTemplates).sort().map(company => (
                  <div key={company} style={{ marginBottom: 12 }}>
                    {/* Company Header */}
                    <div 
                      onClick={() => toggleCompany(`user_${company}`)}
                      style={{
                        padding: 12,
                        background: `linear-gradient(135deg, rgba(108, 44, 156, 0.2), rgba(0, 212, 255, 0.1))`,
                        borderRadius: 8,
                        border: `1px solid ${Colors.Theme.Primary['70']}`,
                        cursor: 'pointer',
                        marginBottom: 8
                      }}
                    >
                      <Flex justifyContent="space-between" alignItems="center">
                        <Flex alignItems="center" gap={8}>
                          <div style={{ fontSize: 16 }}>{expandedCompanies[`user_${company}`] ? '📂' : '📁'}</div>
                          <Strong style={{ fontSize: 14 }}>{company}</Strong>
                        </Flex>
                        <div style={{
                          background: Colors.Theme.Primary['70'],
                          color: 'white',
                          padding: '2px 8px',
                          borderRadius: 12,
                          fontSize: 11,
                          fontWeight: 600
                        }}>
                          {filteredUserTemplates[company].length}
                        </div>
                      </Flex>
                    </div>

                    {/* Templates under this company */}
                    {(expandedCompanies[`user_${company}`] || templateSearch.trim()) && (
                      <div style={{ paddingLeft: 8 }}>
                        {filteredUserTemplates[company].map(template => (
                          <div 
                            key={template.id}
                            style={{
                              padding: 12,
                              marginBottom: 8,
                              background: selectedTemplate === template.id 
                                ? 'rgba(115, 190, 40, 0.2)' 
                                : Colors.Background.Base.Default,
                              borderRadius: 6,
                              border: `1px solid ${
                                selectedTemplate === template.id 
                                  ? Colors.Theme.Success['70'] 
                                  : Colors.Border.Neutral.Default
                              }`,
                              cursor: 'pointer',
                              transition: 'all 0.2s ease'
                            }}
                            onClick={() => loadTemplate(template.id)}
                          >
                            <Flex alignItems="flex-start" gap={8}>
                              <div style={{ fontSize: 16, marginTop: 2 }}>
                                {selectedTemplate === template.id ? '✅' : '📄'}
                              </div>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <Strong style={{ 
                                  fontSize: 13, 
                                  display: 'block',
                                  marginBottom: 4,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap'
                                }}>
                                  {template.name}
                                </Strong>
                                <Paragraph style={{ 
                                  fontSize: 11, 
                                  marginBottom: 4,
                                  opacity: 0.7,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap'
                                }}>
                                  {template.domain}
                                </Paragraph>
                                <Paragraph style={{ fontSize: 10, marginBottom: 0, opacity: 0.5 }}>
                                  {new Date(template.createdAt).toLocaleDateString()}
                                </Paragraph>
                              </div>
                            </Flex>
                            
                            {/* Action Buttons */}
                            <Flex gap={4} style={{ marginTop: 8 }}>
                              <Button 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  loadTemplate(template.id);
                                }}
                                style={{ flex: 1, fontSize: 11, padding: '6px' }}
                              >
                                📂 Load
                              </Button>
                              <Button 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  exportTemplate(template.id);
                                }}
                                style={{ flex: 1, fontSize: 11, padding: '6px' }}
                              >
                                📤 Export
                              </Button>
                              <Button 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  deleteTemplate(template.id);
                                }}
                                style={{ fontSize: 11, padding: '6px' }}
                              >
                                🗑️
                              </Button>
                            </Flex>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        {/* vCarb Demo Section */}
        <div style={{ marginBottom: 16 }}>
          <div 
            onClick={() => toggleSection('vcarbDemo')}
            style={{
              padding: 14,
              background: 'linear-gradient(135deg, rgba(225, 6, 0, 0.25), rgba(30, 144, 255, 0.15))',
              borderRadius: 10,
              border: '2px solid rgba(225, 6, 0, 0.6)',
              cursor: 'pointer',
              marginBottom: 12,
              boxShadow: '0 2px 8px rgba(225, 6, 0, 0.2)'
            }}
          >
            <Flex justifyContent="space-between" alignItems="center">
              <Flex alignItems="center" gap={12}>
                <div style={{ fontSize: 20 }}>{expandedSections.vcarbDemo ? '📂' : '📁'}</div>
                <div>
                  <Strong style={{ fontSize: 15, display: 'block' }}>🏎️ vCarb Demo</Strong>
                  <Paragraph style={{ fontSize: 11, marginBottom: 0, marginTop: 2, opacity: 0.8 }}>
                    F1 Race Weekend Operations demo
                  </Paragraph>
                </div>
              </Flex>
              <div style={{
                background: 'rgba(225, 6, 0, 0.8)',
                color: 'white',
                padding: '4px 12px',
                borderRadius: 14,
                fontSize: 12,
                fontWeight: 700
              }}>
                1
              </div>
            </Flex>
          </div>

          {expandedSections.vcarbDemo && (
            <div style={{ paddingLeft: 8 }}>
              <div style={{
                padding: 16,
                background: 'linear-gradient(135deg, rgba(225, 6, 0, 0.08), rgba(30, 144, 255, 0.08))',
                borderRadius: 10,
                border: '1px solid rgba(225, 6, 0, 0.3)',
                marginBottom: 12
              }}>
                <Flex alignItems="center" gap={12} style={{ marginBottom: 12 }}>
                  <img
                    src={VCARB_CAR}
                    alt="VCARB Race Car"
                    style={{
                      height: 48, borderRadius: 8, objectFit: 'cover',
                      border: '2px solid rgba(225,6,0,0.4)',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
                    }}
                  />
                  <div>
                    <Strong style={{ fontSize: 14, display: 'block' }}>VCARB Race Weekend</Strong>
                    <Paragraph style={{ fontSize: 11, marginBottom: 0, opacity: 0.7 }}>
                      Simulate a full F1 race weekend with telemetry, pit stops, and strategy
                    </Paragraph>
                  </div>
                </Flex>
                <Flex gap={8}>
                  <button
                    onClick={startVcarbRace}
                    disabled={isStartingRace}
                    style={{
                      flex: 1, padding: '10px 16px', borderRadius: 8, border: 'none',
                      background: isStartingRace ? 'rgba(225,6,0,0.4)' : 'linear-gradient(135deg, #e10600, #ff4136)',
                      color: 'white', fontWeight: 700, fontSize: 13,
                      cursor: isStartingRace ? 'wait' : 'pointer',
                      transition: 'all 0.2s ease',
                      boxShadow: '0 2px 8px rgba(225,6,0,0.3)',
                    }}
                    onMouseOver={e => { if (!isStartingRace) { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 4px 12px rgba(225,6,0,0.4)'; } }}
                    onMouseOut={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(225,6,0,0.3)'; }}
                  >
                    {isStartingRace ? '🏁 Starting...' : '🏎️ Start the Race'}
                  </button>
                  <Link to="/vcarb" style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '10px 16px', borderRadius: 8,
                    textDecoration: 'none',
                    background: 'rgba(30,144,255,0.1)',
                    border: '1px solid rgba(30,144,255,0.4)',
                    color: '#1e90ff', fontWeight: 600, fontSize: 13,
                    transition: 'all 0.2s ease',
                  }}>
                    🏎️ Race Hub
                  </Link>
                </Flex>
                {raceStatus && (
                  <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: 'rgba(225,6,0,0.1)', border: '1px solid rgba(225,6,0,0.3)', fontSize: 12, fontFamily: 'monospace' }}>
                    {raceStatus}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const renderWelcomeTab = () => (
    <Flex flexDirection="column" gap={20}>
      <Flex flexDirection="row" gap={20}>
        {/* Left Column: App Overview */}
        <div style={{ flex: 1, padding: 20, background: Colors.Background.Surface.Default, borderRadius: 8 }}>
          <Heading level={3} style={{ marginBottom: 12 }}>🎯 Application Overview</Heading>
          <Paragraph style={{ marginBottom: 12, fontSize: 14, lineHeight: 1.5 }}>
            <Strong style={{ color: Colors.Theme.Primary['70'] }}>Business Observability Demonstrator</Strong> creates realistic customer journey scenarios 
            for performance testing and business intelligence demonstrations.
          </Paragraph>
          
          <div style={{ background: 'rgba(108, 44, 156, 0.2)', padding: 16, borderRadius: 8, border: '1px solid rgba(108, 44, 156, 0.6)' }}>
            <Heading level={5} style={{ marginBottom: 10, color: Colors.Theme.Primary['70'] }}>🔧 Core Functionality</Heading>
            <ul style={{ fontSize: 13, lineHeight: 1.7, color: Colors.Text.Neutral.Default, margin: 0, paddingLeft: 20 }}>
              <li><Strong>AI-Generated Journeys:</Strong> Realistic customer paths using AI-generated prompts</li>
              <li><Strong>Business Intelligence:</Strong> Revenue metrics, KPIs, and competitive insights</li>
              <li><Strong>Performance Testing:</Strong> LoadRunner integration with load profiles</li>
              <li><Strong>Real-time Simulation:</Strong> Customer journeys with Dynatrace correlation</li>
            </ul>
          </div>
        </div>

        {/* Right Column: Business Use Cases */}
        <div style={{ flex: 1, padding: 20, background: Colors.Background.Surface.Default, borderRadius: 8 }}>
          <Heading level={3} style={{ marginBottom: 12 }}>💼 Business Use Cases</Heading>
          
          <Flex flexDirection="column" gap={12}>
            <div style={{ background: 'rgba(115, 190, 40, 0.2)', padding: 14, borderRadius: 8, border: '1px solid rgba(115, 190, 40, 0.6)' }}>
              <Heading level={5} style={{ marginBottom: 6 }}>🛍️ E-Commerce Scenarios</Heading>
              <Paragraph style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 0 }}>
                Customer shopping experiences, cart abandonment, payment processing, and seasonal traffic.
              </Paragraph>
            </div>

            <div style={{ background: 'rgba(0, 161, 201, 0.2)', padding: 14, borderRadius: 8, border: '1px solid rgba(0, 161, 201, 0.6)' }}>
              <Heading level={5} style={{ marginBottom: 6 }}>🏢 Enterprise Applications</Heading>
              <Paragraph style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 0 }}>
                B2B workflows, employee onboarding, CRM interactions, and resource management.
              </Paragraph>
            </div>

            <div style={{ background: 'rgba(255, 210, 63, 0.2)', padding: 14, borderRadius: 8, border: '1px solid rgba(255, 210, 63, 0.6)' }}>
              <Heading level={5} style={{ marginBottom: 6 }}>📱 Digital Services</Heading>
              <Paragraph style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 0 }}>
                SaaS platforms, mobile app backends, API performance, and multi-tenant architectures.
              </Paragraph>
            </div>
          </Flex>
        </div>
      </Flex>

      {/* ── Choose Your Pathway ───────────────── */}
      <div style={{ padding: 24, background: 'linear-gradient(135deg, rgba(0, 212, 255, 0.08), rgba(108, 44, 156, 0.08))', borderRadius: 12, border: `1px solid ${Colors.Theme.Primary['70']}` }}>
        <Heading level={3} style={{ marginBottom: 8, textAlign: 'center' }}>🚀 Choose Your Pathway</Heading>
        <Paragraph style={{ textAlign: 'center', fontSize: 13, marginBottom: 24, opacity: 0.8 }}>
          Two ways to create business observability journeys — pick the one that fits your workflow
        </Paragraph>

        <Flex gap={20}>
          {/* Pathway 1: Generate with GitHub Copilot AI */}
          <div
            onClick={() => setActiveTab('step1')}
            style={{
              flex: 1, padding: 24, borderRadius: 16, cursor: 'pointer',
              background: 'linear-gradient(135deg, rgba(115,190,40,0.08), rgba(0,161,201,0.08))',
              border: '2px solid rgba(115,190,40,0.4)',
              boxShadow: '0 4px 16px rgba(115,190,40,0.1)',
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(115,190,40,0.8)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(115,190,40,0.4)'; e.currentTarget.style.transform = 'translateY(0)'; }}
          >
            <div style={{ textAlign: 'center', marginBottom: 16 }}>
              <div style={{
                width: 64, height: 64, borderRadius: '50%', margin: '0 auto 12px',
                background: 'linear-gradient(135deg, rgba(115,190,40,0.2), rgba(0,161,201,0.2))',
                border: '2px solid rgba(115,190,40,0.5)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32,
              }}>✨</div>
              <Heading level={4} style={{ marginBottom: 4 }}>Generate with GitHub Copilot AI</Heading>
              <Paragraph style={{ fontSize: 12, opacity: 0.7, marginBottom: 0 }}>Fully automated — AI generates everything</Paragraph>
            </div>
            <Flex flexDirection="column" gap={10}>
              <Flex alignItems="center" gap={8}>
                <div style={{ fontSize: 14, width: 24, textAlign: 'center' }}>1️⃣</div>
                <Paragraph style={{ fontSize: 13, marginBottom: 0 }}>Enter company name &amp; domain</Paragraph>
              </Flex>
              <Flex alignItems="center" gap={8}>
                <div style={{ fontSize: 14, width: 24, textAlign: 'center' }}>2️⃣</div>
                <Paragraph style={{ fontSize: 13, marginBottom: 0 }}>AI generates C-Suite analysis</Paragraph>
              </Flex>
              <Flex alignItems="center" gap={8}>
                <div style={{ fontSize: 14, width: 24, textAlign: 'center' }}>3️⃣</div>
                <Paragraph style={{ fontSize: 13, marginBottom: 0 }}>AI generates journey config &amp; deploys</Paragraph>
              </Flex>
            </Flex>
            <div style={{ marginTop: 16, textAlign: 'center' }}>
              <div style={{
                display: 'inline-block', padding: '10px 24px', borderRadius: 10, fontWeight: 700, fontSize: 14,
                background: 'linear-gradient(135deg, rgba(115,190,40,0.9), rgba(0,161,201,0.9))',
                color: 'white',
              }}>
                Start with AI →
              </div>
            </div>
          </div>

          {/* Pathway 2: Use Your Own AI Prompt */}
          <div
            onClick={() => { setOwnAiPhase('details'); setPastedAiResponse(''); setExtractedJourneys([]); setSelectedJourneyName(''); setActiveTab('ownai'); }}
            style={{
              flex: 1, padding: 24, borderRadius: 16, cursor: 'pointer',
              background: 'linear-gradient(135deg, rgba(108,44,156,0.08), rgba(0,161,201,0.08))',
              border: '2px solid rgba(108,44,156,0.4)',
              boxShadow: '0 4px 16px rgba(108,44,156,0.1)',
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(108,44,156,0.8)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(108,44,156,0.4)'; e.currentTarget.style.transform = 'translateY(0)'; }}
          >
            <div style={{ textAlign: 'center', marginBottom: 16 }}>
              <div style={{
                width: 64, height: 64, borderRadius: '50%', margin: '0 auto 12px',
                background: 'linear-gradient(135deg, rgba(108,44,156,0.2), rgba(0,161,201,0.2))',
                border: '2px solid rgba(108,44,156,0.5)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32,
              }}>📋</div>
              <Heading level={4} style={{ marginBottom: 4 }}>Use Your Own AI Prompt</Heading>
              <Paragraph style={{ fontSize: 12, opacity: 0.7, marginBottom: 0 }}>Already have a GenAI analysis? Paste it here</Paragraph>
            </div>
            <Flex flexDirection="column" gap={10}>
              <Flex alignItems="center" gap={8}>
                <div style={{ fontSize: 14, width: 24, textAlign: 'center' }}>1️⃣</div>
                <Paragraph style={{ fontSize: 13, marginBottom: 0 }}>Enter company name &amp; domain</Paragraph>
              </Flex>
              <Flex alignItems="center" gap={8}>
                <div style={{ fontSize: 14, width: 24, textAlign: 'center' }}>2️⃣</div>
                <Paragraph style={{ fontSize: 13, marginBottom: 0 }}>Paste your ChatGPT / Gemini / Claude response</Paragraph>
              </Flex>
              <Flex alignItems="center" gap={8}>
                <div style={{ fontSize: 14, width: 24, textAlign: 'center' }}>3️⃣</div>
                <Paragraph style={{ fontSize: 13, marginBottom: 0 }}>Pick a journey &amp; AI generates the config</Paragraph>
              </Flex>
            </Flex>
            <div style={{ marginTop: 16, textAlign: 'center' }}>
              <div style={{
                display: 'inline-block', padding: '10px 24px', borderRadius: 10, fontWeight: 700, fontSize: 14,
                background: 'linear-gradient(135deg, rgba(108,44,156,0.9), rgba(0,161,201,0.9))',
                color: 'white',
              }}>
                Paste Your Analysis →
              </div>
            </div>
          </div>
        </Flex>
      </div>
    </Flex>
  );

  // ── "Use Your Own AI Prompt" stepped flow ─────────────
  const renderOwnAiTab = () => (
    <Flex flexDirection="column" gap={20}>
      {/* Phase indicator */}
      <Flex justifyContent="center" alignItems="center" gap={0}>
        {[
          { id: 'details' as const, label: 'Company Details', icon: '👤', num: 1 },
          { id: 'paste' as const, label: 'Paste AI Analysis', icon: '📋', num: 2 },
          { id: 'generate' as const, label: 'Pick Journey & Generate', icon: '🚀', num: 3 },
        ].map((phase, index) => (
          <React.Fragment key={phase.id}>
            <Flex
              alignItems="center" gap={8}
              style={{
                padding: '8px 18px', borderRadius: 8,
                background: ownAiPhase === phase.id
                  ? 'linear-gradient(135deg, rgba(108,44,156,0.9), rgba(0,161,201,0.8))'
                  : 'transparent',
                opacity: ownAiPhase === phase.id ? 1 : 0.5,
                cursor: 'pointer',
              }}
              onClick={() => {
                if (phase.id === 'details') setOwnAiPhase('details');
                else if (phase.id === 'paste' && companyName && domain) setOwnAiPhase('paste');
                else if (phase.id === 'generate' && pastedAiResponse.length > 50 && selectedJourneyName) setOwnAiPhase('generate');
              }}
            >
              <div style={{ fontSize: 16 }}>{phase.icon}</div>
              <Strong style={{ fontSize: 13, color: ownAiPhase === phase.id ? 'white' : Colors.Text.Neutral.Default }}>
                {phase.label}
              </Strong>
            </Flex>
            {index < 2 && (
              <div style={{
                width: 40, height: 2, margin: '0 4px',
                background: ['details', 'paste', 'generate'].indexOf(ownAiPhase) > index
                  ? 'rgba(108,44,156,0.7)' : Colors.Border.Neutral.Default,
              }} />
            )}
          </React.Fragment>
        ))}
      </Flex>

      {/* Phase 1: Company Details */}
      {ownAiPhase === 'details' && (
        <Flex gap={24}>
          <div style={{ flex: 3, padding: 20, background: Colors.Background.Surface.Default, borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
            <Flex alignItems="center" gap={12} style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 28 }}>📋</div>
              <div>
                <Heading level={3} style={{ marginBottom: 0 }}>Step 1 — Company Details</Heading>
                <Paragraph style={{ fontSize: 12, marginBottom: 0, marginTop: 4, opacity: 0.7 }}>Enter the company you've already analysed with your own AI</Paragraph>
              </div>
            </Flex>
            <Flex flexDirection="column" gap={16}>
              <div>
                <Heading level={5} style={{ marginBottom: 8 }}>🏢 Company Name</Heading>
                <TextInput
                  value={companyName}
                  onChange={(value) => setCompanyName(value)}
                  placeholder="e.g., BMW, ShopMart, HealthPlus"
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <Heading level={5} style={{ marginBottom: 8 }}>🌐 Website Domain</Heading>
                <TextInput
                  value={domain}
                  onChange={(value) => setDomain(value)}
                  placeholder="e.g., bmw.co.uk, shopmart.com"
                  style={{ width: '100%' }}
                />
              </div>
              <Flex justifyContent="space-between" alignItems="center" style={{ marginTop: 16 }}>
                <Button onClick={() => setActiveTab('welcome')} style={{ padding: '8px 16px' }}>← Back</Button>
                <Button
                  variant="accent"
                  disabled={!companyName || !domain}
                  onClick={() => setOwnAiPhase('paste')}
                  style={{
                    padding: '10px 24px', fontWeight: 700, fontSize: 14, borderRadius: 10,
                    background: companyName && domain ? 'linear-gradient(135deg, rgba(108,44,156,0.9), rgba(0,161,201,0.9))' : undefined,
                    color: companyName && domain ? 'white' : undefined,
                    border: companyName && domain ? 'none' : undefined,
                  }}
                >
                  Next: Paste AI Analysis →
                </Button>
              </Flex>
            </Flex>
          </div>
          <div style={{ flex: 2, padding: 20, background: Colors.Background.Surface.Default, borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
            <Heading level={4} style={{ marginBottom: 12 }}>💡 How This Works</Heading>
            <Flex flexDirection="column" gap={12}>
              <div style={{ padding: 14, background: 'rgba(108,44,156,0.1)', borderRadius: 8, border: '1px solid rgba(108,44,156,0.3)' }}>
                <Strong style={{ fontSize: 13 }}>Already used ChatGPT, Gemini, or Claude?</Strong>
                <Paragraph style={{ fontSize: 12, marginBottom: 0, marginTop: 6, lineHeight: 1.5 }}>
                  If you've generated a C-Suite business analysis with any AI tool, paste it in the next step.
                  We'll extract the journey names and let you pick which one to build.
                </Paragraph>
              </div>
              <div style={{ padding: 14, background: 'rgba(0,161,201,0.1)', borderRadius: 8, border: '1px solid rgba(0,161,201,0.3)' }}>
                <Strong style={{ fontSize: 13 }}>What happens next?</Strong>
                <Paragraph style={{ fontSize: 12, marginBottom: 0, marginTop: 6, lineHeight: 1.5 }}>
                  GitHub Copilot AI reads your pasted analysis and generates the journey configuration JSON — then automatically deploys the services.
                </Paragraph>
              </div>
            </Flex>
          </div>
        </Flex>
      )}

      {/* Phase 2: Paste AI Analysis */}
      {ownAiPhase === 'paste' && (
        <Flex gap={24}>
          <div style={{ flex: 3, padding: 20, background: Colors.Background.Surface.Default, borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
            <Flex alignItems="center" gap={12} style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 28 }}>📋</div>
              <div>
                <Heading level={3} style={{ marginBottom: 0 }}>Step 2 — Paste Your AI Analysis</Heading>
                <Paragraph style={{ fontSize: 12, marginBottom: 0, marginTop: 4, opacity: 0.7 }}>
                  Paste the C-Suite / business analysis from your AI tool below
                </Paragraph>
              </div>
            </Flex>
            <textarea
              value={pastedAiResponse}
              onChange={(e) => {
                const text = e.target.value;
                setPastedAiResponse(text);
                const journeys = extractJourneysFromText(text);
                setExtractedJourneys(journeys);
                setSelectedJourneyName(journeys[0] || '');
              }}
              placeholder={'Paste your AI response here...\n\nExample output from ChatGPT / Gemini / Claude:\n\n### 3. Journey Classification\n- **Industry Type**: Automotive Retail & Services\n- **Journey Names**:\n    - "Vehicle Purchase Journey"\n    - "Finance Application Journey"\n    - "Aftersales Purchase Journey"'}
              style={{
                width: '100%', minHeight: 280, padding: 14,
                background: Colors.Background.Base.Default,
                border: `1px solid ${Colors.Border.Neutral.Default}`,
                borderRadius: 8, color: Colors.Text.Neutral.Default,
                fontFamily: 'monospace', fontSize: 12, lineHeight: 1.5, resize: 'vertical',
              }}
            />
            <Flex justifyContent="space-between" alignItems="center" style={{ marginTop: 16 }}>
              <Button onClick={() => setOwnAiPhase('details')} style={{ padding: '8px 16px' }}>← Back</Button>
              <Button
                variant="accent"
                disabled={pastedAiResponse.length < 50}
                onClick={() => setOwnAiPhase('generate')}
                style={{
                  padding: '10px 24px', fontWeight: 700, fontSize: 14, borderRadius: 10,
                  background: pastedAiResponse.length >= 50 ? 'linear-gradient(135deg, rgba(108,44,156,0.9), rgba(0,161,201,0.9))' : undefined,
                  color: pastedAiResponse.length >= 50 ? 'white' : undefined,
                  border: pastedAiResponse.length >= 50 ? 'none' : undefined,
                }}
              >
                Next: Pick Journey →
              </Button>
            </Flex>
          </div>
          <div style={{ flex: 2, padding: 20, background: Colors.Background.Surface.Default, borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
            <Heading level={4} style={{ marginBottom: 12 }}>📊 Analysis Preview</Heading>
            {pastedAiResponse.length > 50 ? (
              <Flex flexDirection="column" gap={12}>
                <div style={{ padding: 12, background: 'rgba(115,190,40,0.1)', borderRadius: 8, border: '1px solid rgba(115,190,40,0.3)' }}>
                  <Strong style={{ fontSize: 13 }}>📝 {pastedAiResponse.length.toLocaleString()} characters pasted</Strong>
                </div>
                {extractedJourneys.length > 0 && (
                  <div style={{ padding: 12, background: 'rgba(108,44,156,0.1)', borderRadius: 8, border: '1px solid rgba(108,44,156,0.3)' }}>
                    <Strong style={{ fontSize: 13, display: 'block', marginBottom: 8 }}>🎯 Journeys Detected:</Strong>
                    {extractedJourneys.map((j, i) => (
                      <div key={i} style={{ fontSize: 13, padding: '4px 0', paddingLeft: 8, borderLeft: '3px solid rgba(108,44,156,0.5)' }}>
                        {j}
                      </div>
                    ))}
                  </div>
                )}
              </Flex>
            ) : (
              <Paragraph style={{ fontSize: 13, opacity: 0.5, fontStyle: 'italic' }}>
                Paste your AI analysis on the left to see a preview...
              </Paragraph>
            )}
          </div>
        </Flex>
      )}

      {/* Phase 3: Pick Journey & Generate */}
      {ownAiPhase === 'generate' && (
        <Flex gap={24}>
          <div style={{ flex: 3, padding: 20, background: Colors.Background.Surface.Default, borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
            <Flex alignItems="center" gap={12} style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 28 }}>🚀</div>
              <div>
                <Heading level={3} style={{ marginBottom: 0 }}>Step 3 — Pick Journey &amp; Generate</Heading>
                <Paragraph style={{ fontSize: 12, marginBottom: 0, marginTop: 4, opacity: 0.7 }}>
                  Select which journey to build, then let AI generate the full configuration
                </Paragraph>
              </div>
            </Flex>

            {/* Journey Selection */}
            <div style={{ marginBottom: 20 }}>
              <Heading level={5} style={{ marginBottom: 10 }}>🎯 Select Journey</Heading>
              {extractedJourneys.length > 0 ? (
                <Flex flexDirection="column" gap={8}>
                  {extractedJourneys.map((j, idx) => (
                    <div
                      key={idx}
                      onClick={() => setSelectedJourneyName(j)}
                      style={{
                        padding: '12px 16px', borderRadius: 10, cursor: 'pointer',
                        background: selectedJourneyName === j
                          ? 'linear-gradient(135deg, rgba(108,44,156,0.15), rgba(0,161,201,0.15))'
                          : Colors.Background.Base.Default,
                        border: `2px solid ${selectedJourneyName === j ? 'rgba(108,44,156,0.6)' : Colors.Border.Neutral.Default}`,
                        transition: 'all 0.15s ease',
                      }}
                    >
                      <Flex alignItems="center" gap={10}>
                        <div style={{
                          width: 24, height: 24, borderRadius: '50%',
                          border: `2px solid ${selectedJourneyName === j ? 'rgba(108,44,156,0.8)' : Colors.Border.Neutral.Default}`,
                          background: selectedJourneyName === j ? 'rgba(108,44,156,0.8)' : 'transparent',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          color: 'white', fontSize: 12, fontWeight: 700,
                        }}>
                          {selectedJourneyName === j ? '✓' : ''}
                        </div>
                        <Strong style={{ fontSize: 14 }}>{j}</Strong>
                      </Flex>
                    </div>
                  ))}
                </Flex>
              ) : (
                <div style={{ padding: 14, background: 'rgba(220,180,0,0.1)', borderRadius: 8, border: '1px solid rgba(220,180,0,0.3)' }}>
                  <Paragraph style={{ fontSize: 13, marginBottom: 8 }}>
                    No journeys were auto-detected. Type a journey name:
                  </Paragraph>
                  <TextInput
                    value={selectedJourneyName}
                    onChange={(value) => setSelectedJourneyName(value)}
                    placeholder="e.g., Purchase Journey, Subscription Flow"
                    style={{ width: '100%' }}
                  />
                </div>
              )}
            </div>

            {/* Model selector + Generate button */}
            <Flex justifyContent="space-between" alignItems="center">
              <Button onClick={() => setOwnAiPhase('paste')} style={{ padding: '8px 16px' }}>← Back</Button>
              <Flex alignItems="center" gap={12}>
                {ghCopilotConfigured && (
                  <select
                    value={ghCopilotModel}
                    onChange={(e: any) => setGhCopilotModel(e.target.value)}
                    style={{
                      padding: '7px 10px', borderRadius: 6,
                      background: Colors.Background.Base.Default,
                      border: `1px solid ${Colors.Border.Neutral.Default}`,
                      color: Colors.Text.Neutral.Default, fontSize: 12,
                      cursor: 'pointer', minWidth: 140,
                    }}
                  >
                    {ghAvailableModels.length > 0
                      ? ghAvailableModels.map(m => (
                          <option key={m.id} value={m.id}>{m.id}</option>
                        ))
                      : ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'o4-mini', 'claude-sonnet-4'].map(id => (
                          <option key={id} value={id}>{id}</option>
                        ))
                    }
                  </select>
                )}
                <Button
                  variant="accent"
                  disabled={!selectedJourneyName || !ghCopilotConfigured}
                  onClick={() => runPastedAiPipeline(pastedAiResponse, selectedJourneyName)}
                  title={!ghCopilotConfigured ? 'Configure GitHub PAT in Settings first' : `Generate "${selectedJourneyName}" journey config`}
                  style={{
                    padding: '12px 28px', fontWeight: 700, fontSize: 15, borderRadius: 10,
                    background: selectedJourneyName && ghCopilotConfigured
                      ? 'linear-gradient(135deg, rgba(108,44,156,0.9), rgba(0,161,201,0.9))' : undefined,
                    color: selectedJourneyName && ghCopilotConfigured ? 'white' : undefined,
                    border: selectedJourneyName && ghCopilotConfigured ? 'none' : undefined,
                    boxShadow: selectedJourneyName && ghCopilotConfigured ? '0 4px 16px rgba(108,44,156,0.3)' : undefined,
                    opacity: (!selectedJourneyName || !ghCopilotConfigured) ? 0.4 : 1,
                  }}
                >
                  🚀 Generate &amp; Deploy Journey
                </Button>
              </Flex>
            </Flex>
            {!ghCopilotConfigured && (
              <Paragraph style={{ fontSize: 12, marginTop: 12, color: 'rgba(220,50,47,0.8)' }}>
                ⚠️ Configure your GitHub PAT in Settings → GitHub Copilot to enable generation
              </Paragraph>
            )}
          </div>
          <div style={{ flex: 2, padding: 20, background: Colors.Background.Surface.Default, borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
            <Heading level={4} style={{ marginBottom: 12 }}>📋 Summary</Heading>
            <Flex flexDirection="column" gap={10}>
              <div style={{ padding: 12, background: 'rgba(0,161,201,0.1)', borderRadius: 8 }}>
                <Paragraph style={{ fontSize: 11, marginBottom: 4, opacity: 0.7 }}>Company</Paragraph>
                <Strong style={{ fontSize: 14 }}>{companyName}</Strong>
              </div>
              <div style={{ padding: 12, background: 'rgba(0,161,201,0.1)', borderRadius: 8 }}>
                <Paragraph style={{ fontSize: 11, marginBottom: 4, opacity: 0.7 }}>Domain</Paragraph>
                <Strong style={{ fontSize: 14 }}>{domain}</Strong>
              </div>
              <div style={{ padding: 12, background: 'rgba(108,44,156,0.1)', borderRadius: 8 }}>
                <Paragraph style={{ fontSize: 11, marginBottom: 4, opacity: 0.7 }}>Analysis</Paragraph>
                <Strong style={{ fontSize: 14 }}>{pastedAiResponse.length.toLocaleString()} chars · {extractedJourneys.length} journeys</Strong>
              </div>
              {selectedJourneyName && (
                <div style={{ padding: 12, background: 'rgba(115,190,40,0.1)', borderRadius: 8, border: '2px solid rgba(115,190,40,0.4)' }}>
                  <Paragraph style={{ fontSize: 11, marginBottom: 4, opacity: 0.7 }}>Selected Journey</Paragraph>
                  <Strong style={{ fontSize: 14, color: '#73be28' }}>{selectedJourneyName}</Strong>
                </div>
              )}
            </Flex>
          </div>
        </Flex>
      )}
    </Flex>
  );

  const renderStep1Tab = () => (
    <Flex flexDirection="column" gap={20}>
      <Flex gap={24}>
        {/* Left Column: Form */}
        <div style={{ flex: 3, padding: 20, background: Colors.Background.Surface.Default, borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
          <Flex alignItems="center" gap={12} style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 28 }}>👤</div>
            <Heading level={3} style={{ marginBottom: 0 }}>Step 1 - Customer Details</Heading>
          </Flex>
          
          <Flex flexDirection="column" gap={16}>
            <div>
              <Heading level={5} style={{ marginBottom: 8 }}>🏢 Company Name</Heading>
              <TextInput 
                value={companyName}
                onChange={(value) => setCompanyName(value)}
                placeholder="e.g., ShopMart, TechCorp, HealthPlus"
                style={{ width: '100%' }}
              />
              <Paragraph style={{ fontSize: 12, marginTop: 4, opacity: 0.7, lineHeight: 1.4 }}>
                Company name for your business scenario
              </Paragraph>
            </div>

            <div>
              <Heading level={5} style={{ marginBottom: 8 }}>🌐 Website Domain</Heading>
              <TextInput 
                value={domain}
                onChange={(value) => setDomain(value)}
                placeholder="e.g., shopmart.com, techcorp.io"
                style={{ width: '100%' }}
              />
              <Paragraph style={{ fontSize: 12, marginTop: 4, opacity: 0.7, lineHeight: 1.4 }}>
                Domain for the customer journey simulation
              </Paragraph>
            </div>

            <div>
              <Heading level={5} style={{ marginBottom: 8 }}>🎯 Journey Requirements</Heading>
              <textarea 
                value={requirements}
                onChange={(e) => setRequirements(e.target.value)}
                placeholder="e.g., Order journey from website to delivery, Banking loan application process"
                style={{ 
                  width: '100%', 
                  minHeight: 80,
                  padding: 12,
                  background: Colors.Background.Base.Default,
                  border: `1px solid ${Colors.Border.Neutral.Default}`,
                  borderRadius: 4,
                  color: Colors.Text.Neutral.Default,
                  fontFamily: 'inherit',
                  fontSize: 13,
                  lineHeight: 1.5,
                  resize: 'vertical'
                }}
              />
            </div>

            <Flex justifyContent="space-between" alignItems="center" gap={12} style={{ marginTop: 16 }}>
              <Button onClick={() => setActiveTab('welcome')} style={{ padding: '8px 16px' }}>
                ← Back
              </Button>
              <Flex alignItems="center" gap={12}>
                {/* Model dropdown — only shown when PAT is configured */}
                {ghCopilotConfigured && (
                  <select
                    value={ghCopilotModel}
                    onChange={(e: any) => setGhCopilotModel(e.target.value)}
                    style={{
                      padding: '7px 10px', borderRadius: 6,
                      background: Colors.Background.Base.Default,
                      border: `1px solid ${Colors.Border.Neutral.Default}`,
                      color: Colors.Text.Neutral.Default, fontSize: 12,
                      cursor: 'pointer', minWidth: 140,
                    }}
                  >
                    {ghAvailableModels.length > 0
                      ? ghAvailableModels.map(m => (
                          <option key={m.id} value={m.id}>{m.id}</option>
                        ))
                      : ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'o4-mini', 'claude-sonnet-4'].map(id => (
                          <option key={id} value={id}>{id}</option>
                        ))
                    }
                  </select>
                )}
                {/* Generate with AI button — opens automated pipeline modal */}
                <Button
                  variant="accent"
                  disabled={!companyName || !domain || !ghCopilotConfigured || ghGeneratingAll}
                  onClick={() => runAiGenerationPipeline()}
                  title={!ghCopilotConfigured ? 'Configure GitHub PAT in Settings → GitHub Copilot first' : `Generate, validate & deploy with AI using ${ghCopilotModel}`}
                  style={{
                    padding: '10px 24px', opacity: !ghCopilotConfigured ? 0.4 : 1,
                    fontWeight: 700, fontSize: 14,
                    background: ghCopilotConfigured ? 'linear-gradient(135deg, rgba(115,190,40,0.9), rgba(0,161,201,0.9))' : undefined,
                    color: ghCopilotConfigured ? 'white' : undefined,
                    border: ghCopilotConfigured ? 'none' : undefined,
                    borderRadius: 10,
                    boxShadow: ghCopilotConfigured ? '0 4px 16px rgba(115,190,40,0.3)' : undefined,
                  }}
                >
                  ✨ Generate with AI
                </Button>
                {/* Use Your Own AI Prompt — paste from external GenAI */}
                <Button
                  disabled={!companyName || !domain || !ghCopilotConfigured}
                  onClick={() => { setPastedAiResponse(''); setExtractedJourneys([]); setSelectedJourneyName(''); setShowPasteAiModal(true); }}
                  title={!ghCopilotConfigured ? 'Configure GitHub PAT in Settings first' : 'Paste a C-Suite analysis from ChatGPT, Gemini, Claude, etc.'}
                  style={{
                    padding: '10px 20px', opacity: !ghCopilotConfigured ? 0.4 : 1,
                    fontWeight: 700, fontSize: 14,
                    background: ghCopilotConfigured ? 'linear-gradient(135deg, rgba(108,44,156,0.9), rgba(0,161,201,0.9))' : undefined,
                    color: ghCopilotConfigured ? 'white' : undefined,
                    border: ghCopilotConfigured ? 'none' : undefined,
                    borderRadius: 10,
                    boxShadow: ghCopilotConfigured ? '0 4px 16px rgba(108,44,156,0.3)' : undefined,
                  }}
                >
                  📋 Use Your Own AI Prompt
                </Button>
                {/* Manual path */}
                <Button 
                  color="primary"
                  variant="emphasized"
                  onClick={() => setActiveTab('step2')}
                  disabled={!companyName || !domain}
                  style={{ padding: '8px 20px' }}
                >
                  Next: Generate Prompts →
                </Button>
              </Flex>
            </Flex>
          </Flex>
        </div>

        {/* Right Column: Instructions & Stats */}
        <div style={{ flex: 2 }}>
          <div style={{ 
            padding: 20, 
            background: `linear-gradient(135deg, ${Colors.Background.Surface.Default}, rgba(0, 161, 201, 0.05))`,
            borderRadius: 12,
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
            marginBottom: 16
          }}>
            <Heading level={4} style={{ marginBottom: 16 }}>📊 Template Statistics</Heading>
            <Flex gap={12}>
              <div style={{ 
                flex: 1,
                padding: 16,
                background: 'linear-gradient(135deg, rgba(108, 44, 156, 0.2), rgba(108, 44, 156, 0.1))',
                borderRadius: 10,
                textAlign: 'center',
                border: '2px solid rgba(108, 44, 156, 0.4)'
              }}>
                <div style={{ fontSize: 28, fontWeight: 700, color: Colors.Theme.Primary['70'] }}>{savedTemplates.length}</div>
                <Paragraph style={{ fontSize: 11, marginBottom: 0, marginTop: 4 }}>Saved Templates</Paragraph>
              </div>
              <div style={{ 
                flex: 1,
                padding: 16,
                background: 'linear-gradient(135deg, rgba(115, 190, 40, 0.2), rgba(115, 190, 40, 0.1))',
                borderRadius: 10,
                textAlign: 'center',
                border: '2px solid rgba(115, 190, 40, 0.4)'
              }}>
                <div style={{ fontSize: 28, fontWeight: 700, color: Colors.Theme.Success['70'] }}>{companyName && domain ? '✓' : '○'}</div>
                <Paragraph style={{ fontSize: 11, marginBottom: 0, marginTop: 4 }}>Form Complete</Paragraph>
              </div>
            </Flex>
          </div>

          <div style={{ padding: 20, background: Colors.Background.Surface.Default, borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
            <Heading level={4} style={{ marginBottom: 12 }}>📋 What We'll Create</Heading>
            <Flex flexDirection="column" gap={12}>
              <div style={{ padding: 14, background: 'rgba(0, 161, 201, 0.15)', borderRadius: 8, border: '2px solid rgba(0, 161, 201, 0.5)' }}>
                <Flex alignItems="center" gap={8} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 20 }}>🤖</div>
                  <Heading level={5} style={{ marginBottom: 0 }}>AI-Generated Journey</Heading>
                </Flex>
                <ul style={{ fontSize: 13, lineHeight: 1.6, margin: 0, paddingLeft: 20 }}>
                  <li>Realistic customer interaction patterns</li>
                  <li>Business intelligence & revenue metrics</li>
                  <li>Industry-specific journey steps</li>
                  <li>Performance testing configurations</li>
                </ul>
              </div>

              <div style={{ padding: 14, background: 'rgba(255, 210, 63, 0.15)', borderRadius: 8, border: '2px solid rgba(255, 210, 63, 0.5)' }}>
                <Flex alignItems="center" gap={8} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 20 }}>🚀</div>
                  <Heading level={5} style={{ marginBottom: 0 }}>Next Steps</Heading>
                </Flex>
                <Paragraph style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 0 }}>
                  Generate tailored AI prompts to create realistic business scenarios.
                </Paragraph>
              </div>
            </Flex>
          </div>
        </div>
      </Flex>
    </Flex>
  );

  const step2Phases = [
    { key: 'prompts' as const, label: 'Copy Prompts', icon: '📝', number: 1 },
    { key: 'response' as const, label: 'Paste Response', icon: '📥', number: 2 },
    { key: 'generate' as const, label: 'Generate Services', icon: '🚀', number: 3 },
  ];

  const step2PhaseIndex = step2Phases.findIndex(p => p.key === step2Phase);

  const renderStep2Tab = () => (
    <Flex flexDirection="column" gap={16}>
      <div style={{ padding: 20, background: Colors.Background.Surface.Default, borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
        {/* Header */}
        <Flex alignItems="center" gap={12} style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 28 }}>🤖</div>
          <div style={{ flex: 1 }}>
            <Heading level={3} style={{ marginBottom: 0 }}>Step 2 — AI Prompt Generation</Heading>
            <Paragraph style={{ fontSize: 12, marginBottom: 0, marginTop: 2, opacity: 0.7 }}>
              {companyName} • {domain}
            </Paragraph>
          </div>
        </Flex>

        {/* ── Sub-step progress bar ─── */}
        <Flex gap={0} style={{ marginBottom: 24 }}>
          {step2Phases.map((phase, idx) => {
            const isActive = phase.key === step2Phase;
            const isCompleted = idx < step2PhaseIndex;
            const isClickable = idx <= step2PhaseIndex || (idx === step2PhaseIndex + 1);
            return (
              <div
                key={phase.key}
                onClick={() => isClickable && setStep2Phase(phase.key)}
                style={{
                  flex: 1,
                  padding: '12px 16px',
                  cursor: isClickable ? 'pointer' : 'default',
                  background: isActive
                    ? 'linear-gradient(135deg, rgba(108,44,156,0.2), rgba(0,212,255,0.15))'
                    : isCompleted
                    ? 'rgba(115,190,40,0.1)'
                    : 'rgba(0,0,0,0.02)',
                  borderBottom: isActive ? '3px solid #6c2c9c' : isCompleted ? '3px solid rgba(115,190,40,0.5)' : '3px solid transparent',
                  borderRadius: idx === 0 ? '10px 0 0 0' : idx === step2Phases.length - 1 ? '0 10px 0 0' : 0,
                  transition: 'all 0.2s ease',
                  opacity: (!isActive && !isCompleted && !isClickable) ? 0.4 : 1,
                }}
              >
                <Flex alignItems="center" gap={8}>
                  <div style={{
                    width: 28, height: 28, borderRadius: '50%',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 13, fontWeight: 700,
                    background: isCompleted ? Colors.Theme.Success['70'] : isActive ? '#6c2c9c' : 'rgba(0,0,0,0.1)',
                    color: (isCompleted || isActive) ? 'white' : Colors.Text.Neutral.Default,
                  }}>
                    {isCompleted ? '✓' : phase.number}
                  </div>
                  <div>
                    <Strong style={{ fontSize: 13 }}>{phase.label}</Strong>
                  </div>
                </Flex>
              </div>
            );
          })}
        </Flex>

        {/* ════════ SUB-STEP 1: Copy Prompts ════════ */}
        {step2Phase === 'prompts' && (
          <div>
            <Paragraph style={{ fontSize: 13, marginBottom: 16, lineHeight: 1.6 }}>
              Copy each prompt below into an <Strong>external AI assistant</Strong> (e.g. ChatGPT, Gemini, or Microsoft Copilot — <em>not</em> Dynatrace Copilot). Run Prompt 1 first, then Prompt 2 in the <Strong>same conversation</Strong>.
              {ghCopilotConfigured && <> Or use <Strong>✨ Generate with AI</Strong> to run them directly using your GitHub Copilot subscription.</>}
            </Paragraph>

            {/* GitHub Copilot not configured banner */}
            {!ghCopilotConfigured && !ghCopilotChecking && (
              <div style={{
                padding: 10, marginBottom: 12, borderRadius: 8,
                background: 'rgba(0,161,201,0.06)', border: '1px solid rgba(0,161,201,0.2)',
                cursor: 'pointer',
              }} onClick={() => { setShowSettingsModal(true); setSettingsTab('copilot'); }}>
                <Flex alignItems="center" gap={8}>
                  <span style={{ fontSize: 16 }}>💡</span>
                  <Paragraph style={{ fontSize: 12, marginBottom: 0, lineHeight: 1.4 }}>
                    <Strong>Tip:</Strong> Configure a GitHub Personal Access Token in <Strong>Settings → GitHub Copilot</Strong> to generate AI responses directly in the app — no copy/paste needed.
                  </Paragraph>
                </Flex>
              </div>
            )}

            {/* Prompt 1 */}
            <div style={{
              marginBottom: 16, padding: 16,
              background: 'linear-gradient(135deg, rgba(0,161,201,0.08), rgba(0,161,201,0.03))',
              borderRadius: 10, border: '2px solid rgba(0,161,201,0.4)',
            }}>
              <Flex justifyContent="space-between" alignItems="center" style={{ marginBottom: 8 }}>
                <Flex alignItems="center" gap={8}>
                  <div style={{ fontSize: 18 }}>💼</div>
                  <Strong style={{ fontSize: 14 }}>Prompt 1 — C-suite Analysis</Strong>
                </Flex>
                <Flex gap={8}>
                  <Button onClick={() => copyToClipboard(prompt1, 'Prompt 1')} variant="emphasized">📋 Copy</Button>
                  <Button
                    disabled={!ghCopilotConfigured || ghGenerating1}
                    variant="accent"
                    onClick={async () => {
                      setGhGenerating1(true);
                      setGhResult1('');
                      try {
                        const res = await callProxyWithRetry({
                          action: 'github-copilot-generate',
                          apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol,
                          body: { prompt: prompt1, model: ghCopilotModel },
                        });
                        if (res.success) {
                          setGhResult1(res.data.content);
                          showToast(`✅ C-suite analysis generated (${res.data.model})`, 'success');
                        } else {
                          setGhResult1('');
                          if (res.code === 'NO_CREDENTIAL') {
                            setShowSettingsModal(true);
                            setSettingsTab('copilot');
                          }
                          showToast(`❌ ${res.error}`, 'error', 6000);
                        }
                      } catch (err: any) {
                        showToast(`❌ ${err.message}`, 'error');
                      }
                      setGhGenerating1(false);
                    }}
                    title={!ghCopilotConfigured ? 'Configure GitHub PAT in Settings → GitHub Copilot first' : 'Generate with AI using your GitHub Copilot'}
                    style={{ opacity: !ghCopilotConfigured ? 0.5 : 1 }}
                  >
                    {ghGenerating1 ? '⏳ Generating...' : '✨ Generate with AI'}
                  </Button>
                </Flex>
              </Flex>
              <Paragraph style={{ fontSize: 12, marginBottom: 8, opacity: 0.8, padding: '6px 10px', background: 'rgba(0,161,201,0.12)', borderRadius: 6 }}>
                {PROMPT_DESCRIPTIONS.csuite.description}
              </Paragraph>
              <textarea
                readOnly value={prompt1}
                style={{
                  width: '100%', height: 130, padding: 12,
                  background: Colors.Background.Base.Default,
                  border: '1px solid rgba(0,161,201,0.4)', borderRadius: 8,
                  color: Colors.Text.Neutral.Default, fontFamily: 'monospace', fontSize: 12,
                  resize: 'vertical', lineHeight: 1.5,
                }}
              />
              {/* AI Generated Result */}
              {ghResult1 && (
                <div style={{ marginTop: 12 }}>
                  <Flex justifyContent="space-between" alignItems="center" style={{ marginBottom: 6 }}>
                    <Flex alignItems="center" gap={6}>
                      <span style={{ fontSize: 14 }}>🤖</span>
                      <Strong style={{ fontSize: 12, color: 'rgba(115,190,40,0.9)' }}>AI-Generated Response</Strong>
                    </Flex>
                    <Button onClick={() => copyToClipboard(ghResult1, 'AI Response 1')} variant="default" style={{ fontSize: 11 }}>📋 Copy Result</Button>
                  </Flex>
                  <textarea
                    readOnly value={ghResult1}
                    style={{
                      width: '100%', height: 200, padding: 12,
                      background: 'rgba(115,190,40,0.04)',
                      border: '1px solid rgba(115,190,40,0.3)', borderRadius: 8,
                      color: Colors.Text.Neutral.Default, fontFamily: 'monospace', fontSize: 12,
                      resize: 'vertical', lineHeight: 1.5,
                    }}
                  />
                </div>
              )}
            </div>

            {/* Prompt 2 */}
            <div style={{
              marginBottom: 16, padding: 16,
              background: 'linear-gradient(135deg, rgba(108,44,156,0.08), rgba(108,44,156,0.03))',
              borderRadius: 10, border: '2px solid rgba(108,44,156,0.4)',
            }}>
              <Flex justifyContent="space-between" alignItems="center" style={{ marginBottom: 8 }}>
                <Flex alignItems="center" gap={8}>
                  <div style={{ fontSize: 18 }}>🗺️</div>
                  <Strong style={{ fontSize: 14 }}>Prompt 2 — Customer Journey</Strong>
                </Flex>
                <Flex gap={8}>
                  <Button onClick={() => copyToClipboard(prompt2, 'Prompt 2')} variant="emphasized">📋 Copy</Button>
                  <Button
                    disabled={!ghCopilotConfigured || ghGenerating2}
                    variant="accent"
                    onClick={async () => {
                      setGhGenerating2(true);
                      setGhResult2('');
                      try {
                        // Include the C-suite result as context so Prompt 2 builds on Prompt 1
                        const contextPrefix = ghResult1 ? `Here is the C-suite analysis from the previous step:\n\n${ghResult1}\n\nNow, based on that context:\n\n` : '';
                        const res = await callProxyWithRetry({
                          action: 'github-copilot-generate',
                          apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol,
                          body: { prompt: contextPrefix + prompt2, model: ghCopilotModel },
                        });
                        if (res.success) {
                          setGhResult2(res.data.content);
                          showToast(`✅ Journey config generated (${res.data.model})`, 'success');
                        } else {
                          setGhResult2('');
                          if (res.code === 'NO_CREDENTIAL') {
                            setShowSettingsModal(true);
                            setSettingsTab('copilot');
                          }
                          showToast(`❌ ${res.error}`, 'error', 6000);
                        }
                      } catch (err: any) {
                        showToast(`❌ ${err.message}`, 'error');
                      }
                      setGhGenerating2(false);
                    }}
                    title={!ghCopilotConfigured ? 'Configure GitHub PAT in Settings → GitHub Copilot first' : 'Generate with AI using your GitHub Copilot'}
                    style={{ opacity: !ghCopilotConfigured ? 0.5 : 1 }}
                  >
                    {ghGenerating2 ? '⏳ Generating...' : '✨ Generate with AI'}
                  </Button>
                </Flex>
              </Flex>
              <Paragraph style={{ fontSize: 12, marginBottom: 8, opacity: 0.8, padding: '6px 10px', background: 'rgba(108,44,156,0.12)', borderRadius: 6 }}>
                {PROMPT_DESCRIPTIONS.journey.description}
              </Paragraph>
              <textarea
                readOnly value={prompt2}
                style={{
                  width: '100%', height: 130, padding: 12,
                  background: Colors.Background.Base.Default,
                  border: '1px solid rgba(108,44,156,0.4)', borderRadius: 8,
                  color: Colors.Text.Neutral.Default, fontFamily: 'monospace', fontSize: 12,
                  resize: 'vertical', lineHeight: 1.5,
                }}
              />
              {/* AI Generated Result */}
              {ghResult2 && (
                <div style={{ marginTop: 12 }}>
                  <Flex justifyContent="space-between" alignItems="center" style={{ marginBottom: 6 }}>
                    <Flex alignItems="center" gap={6}>
                      <span style={{ fontSize: 14 }}>🤖</span>
                      <Strong style={{ fontSize: 12, color: 'rgba(115,190,40,0.9)' }}>AI-Generated Response</Strong>
                    </Flex>
                    <Flex gap={8}>
                      <Button onClick={() => copyToClipboard(ghResult2, 'AI Response 2')} variant="default" style={{ fontSize: 11 }}>📋 Copy Result</Button>
                      <Button
                        variant="emphasized"
                        style={{ fontSize: 11 }}
                        onClick={() => {
                          // Strip markdown code fences if present
                          let cleanJson = ghResult2.trim();
                          if (cleanJson.startsWith('```')) {
                            cleanJson = cleanJson.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
                          }
                          setCopilotResponse(cleanJson);
                          setStep2Phase('response');
                          showToast('✅ AI response loaded into paste area — click Validate', 'success');
                        }}
                      >
                        📥 Use as Journey Response
                      </Button>
                    </Flex>
                  </Flex>
                  <textarea
                    readOnly value={ghResult2}
                    style={{
                      width: '100%', height: 200, padding: 12,
                      background: 'rgba(115,190,40,0.04)',
                      border: '1px solid rgba(115,190,40,0.3)', borderRadius: 8,
                      color: Colors.Text.Neutral.Default, fontFamily: 'monospace', fontSize: 12,
                      resize: 'vertical', lineHeight: 1.5,
                    }}
                  />
                </div>
              )}
            </div>

            <Flex justifyContent="space-between" style={{ marginTop: 8 }}>
              <Button onClick={() => setActiveTab('step1')}>← Back to Details</Button>
              <Button variant="emphasized" onClick={() => setStep2Phase('response')} style={{ padding: '10px 24px', fontWeight: 600 }}>
                Continue to Paste Response →
              </Button>
            </Flex>
          </div>
        )}

        {/* ════════ SUB-STEP 2: Paste Response ════════ */}
        {step2Phase === 'response' && (
          <div>
            <Paragraph style={{ fontSize: 13, marginBottom: 16, lineHeight: 1.6 }}>
              Paste the <Strong>JSON response</Strong> from your AI assistant below, then click <Strong>Validate</Strong> to check the format.
            </Paragraph>

            <div style={{
              padding: 16, borderRadius: 10,
              border: `2px solid ${copilotResponse.trim() ? Colors.Theme.Success['70'] : Colors.Border.Neutral.Default}`,
              background: Colors.Background.Surface.Default,
              boxShadow: copilotResponse.trim() ? '0 2px 8px rgba(115,190,40,0.15)' : 'none',
            }}>
              <Flex alignItems="center" gap={8} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 16 }}>{copilotResponse.trim() ? '✅' : '📝'}</div>
                <Strong style={{ fontSize: 13 }}>
                  {copilotResponse.trim() ? 'Response Received' : 'Awaiting Response'}
                </Strong>
                {copilotResponse.trim() && (
                  <Button onClick={() => setCopilotResponse('')} style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 8px' }}>🗑️ Clear</Button>
                )}
              </Flex>
              <textarea
                value={copilotResponse}
                onChange={(e) => setCopilotResponse(e.target.value)}
                placeholder="Paste the JSON response from the AI assistant here..."
                style={{
                  width: '100%', height: 260, padding: 16,
                  background: Colors.Background.Base.Default,
                  border: `1px solid ${Colors.Border.Neutral.Default}`, borderRadius: 8,
                  color: Colors.Text.Neutral.Default, fontFamily: 'monospace', fontSize: 12,
                  resize: 'vertical', lineHeight: 1.5,
                }}
              />

              {generationStatus && (
                <div style={{
                  marginTop: 10, padding: 10, borderRadius: 6, fontSize: 13, fontFamily: 'monospace',
                  background: generationStatus.includes('✅') ? 'rgba(115,190,40,0.1)' : generationStatus.includes('❌') ? 'rgba(220,50,47,0.1)' : 'rgba(0,161,201,0.1)',
                  border: `1px solid ${generationStatus.includes('✅') ? Colors.Theme.Success['70'] : generationStatus.includes('❌') ? '#dc322f' : Colors.Theme.Primary['70']}`,
                }}>
                  {generationStatus}
                </div>
              )}
            </div>

            <Flex justifyContent="space-between" style={{ marginTop: 16 }}>
              <Button onClick={() => setStep2Phase('prompts')}>← Back to Prompts</Button>
              <Flex gap={8}>
                <Button variant="emphasized" onClick={processResponse} disabled={!copilotResponse.trim()} style={{ padding: '10px 20px', fontWeight: 600 }}>
                  ⚡ Validate Response
                </Button>
                <Button onClick={() => setStep2Phase('generate')} disabled={!copilotResponse.trim()} style={{ padding: '10px 24px', fontWeight: 600 }}>
                  Continue to Generate →
                </Button>
              </Flex>
            </Flex>
          </div>
        )}

        {/* ════════ SUB-STEP 3: Generate Services ════════ */}
        {step2Phase === 'generate' && (
          <div>
            <Paragraph style={{ fontSize: 13, marginBottom: 16, lineHeight: 1.6 }}>
              Everything is ready. Click <Strong>Generate Services</Strong> to create live services on your configured host.
            </Paragraph>

            {/* Summary card */}
            <div style={{
              padding: 16, marginBottom: 20, borderRadius: 10,
              background: 'linear-gradient(135deg, rgba(115,190,40,0.1), rgba(0,212,255,0.08))',
              border: `1px solid ${Colors.Theme.Success['70']}`,
            }}>
              <Flex gap={20}>
                <div>
                  <Strong style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase' as const }}>Company</Strong>
                  <Paragraph style={{ fontSize: 14, marginBottom: 0, marginTop: 2 }}>{companyName}</Paragraph>
                </div>
                <div>
                  <Strong style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase' as const }}>Domain</Strong>
                  <Paragraph style={{ fontSize: 14, marginBottom: 0, marginTop: 2 }}>{domain}</Paragraph>
                </div>
                <div>
                  <Strong style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase' as const }}>Target</Strong>
                  <Paragraph style={{ fontSize: 14, marginBottom: 0, marginTop: 2 }}>{apiSettings.host}:{apiSettings.port}</Paragraph>
                </div>
                <div>
                  <Strong style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase' as const }}>Response</Strong>
                  <Paragraph style={{ fontSize: 14, marginBottom: 0, marginTop: 2, color: Colors.Theme.Success['70'] }}>✓ Pasted</Paragraph>
                </div>
              </Flex>
            </div>

            <Flex justifyContent="center" style={{ marginBottom: 16 }}>
              <Button
                onClick={generateServices}
                disabled={!copilotResponse.trim() || isGeneratingServices}
                style={{
                  padding: '14px 40px', fontWeight: 700, fontSize: 15,
                  background: isGeneratingServices ? 'rgba(0,161,201,0.2)' : 'linear-gradient(135deg, rgba(115,190,40,0.9), rgba(0,161,201,0.9))',
                  color: 'white', borderRadius: 10, border: 'none',
                }}
              >
                {isGeneratingServices ? '🔄 Generating...' : '🚀 Generate Services'}
              </Button>
            </Flex>

            {generationStatus && (
              <div style={{
                padding: 12, borderRadius: 8, fontSize: 13, fontFamily: 'monospace', textAlign: 'center' as const,
                background: generationStatus.includes('✅') ? 'rgba(115,190,40,0.1)' : generationStatus.includes('❌') ? 'rgba(220,50,47,0.1)' : 'rgba(0,161,201,0.1)',
                border: `1px solid ${generationStatus.includes('✅') ? Colors.Theme.Success['70'] : generationStatus.includes('❌') ? '#dc322f' : Colors.Theme.Primary['70']}`,
              }}>
                {generationStatus}
              </div>
            )}

            <Flex justifyContent="space-between" style={{ marginTop: 20 }}>
              <Button onClick={() => setStep2Phase('response')}>← Back to Response</Button>
              <Button onClick={openSettingsModal}>⚙️ API Settings</Button>
            </Flex>
          </div>
        )}
      </div>
    </Flex>
  );

  return (
    <Page>
      <Page.Header>
        <TitleBar>
          <TitleBar.Title>
            <Flex alignItems="center" gap={8}>
              <img src={DEMONSTRATOR_LOGO} alt="BizObs Demonstrator" style={{ width: 32, height: 32, borderRadius: 6 }} />
              <span style={{ background: 'linear-gradient(135deg, #6c2c9c, #00d4ff)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', fontWeight: 700 }}>
                Business Observability Demonstrator
              </span>
            </Flex>
          </TitleBar.Title>
          <TitleBar.Subtitle>
            <span>AI-powered journey simulation &amp; observability — built on </span>
            <span style={{ fontWeight: 700 }}>Dynatrace SaaS</span>
            <span>, </span>
            <span style={{ fontWeight: 700 }}>Grail</span>
            <span>, </span>
            <span style={{ fontWeight: 700 }}>DPS</span>
            <span> &amp; </span>
            <span style={{ fontWeight: 700 }}>Dynatrace Intelligence</span>
          </TitleBar.Subtitle>
          <TitleBar.Action>
            <Flex gap={8} alignItems="center">
              {/* Connection Status Indicator — always visible */}
              {(() => {
                const isConnected = connectionTestedOk || builtinSettingsDetected['test-connection'];
                const hasIp = apiSettings.host && apiSettings.host !== 'localhost' && apiSettings.host !== '';
                return (
                  <div
                    onClick={openSettingsModal}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 14px', borderRadius: 20,
                      background: isConnected
                        ? 'linear-gradient(135deg, rgba(0,180,0,0.12), rgba(115,190,40,0.08))'
                        : hasIp
                          ? 'linear-gradient(135deg, rgba(220,160,0,0.12), rgba(220,160,0,0.06))'
                          : 'linear-gradient(135deg, rgba(120,120,120,0.12), rgba(120,120,120,0.06))',
                      border: isConnected
                        ? '1.5px solid rgba(0,180,0,0.4)'
                        : hasIp
                          ? '1.5px solid rgba(220,160,0,0.4)'
                          : '1.5px solid rgba(120,120,120,0.3)',
                      cursor: 'pointer',
                      transition: 'all 0.2s ease',
                    }}
                    title={isConnected ? `Connected to ${apiSettings.host}:${apiSettings.port}` : hasIp ? `Configured: ${apiSettings.host} — not verified` : 'No server configured'}
                  >
                    <span style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: isConnected ? '#00b400' : hasIp ? '#dca000' : '#888',
                      boxShadow: isConnected ? '0 0 6px rgba(0,180,0,0.6)' : 'none',
                    }} />
                    <span style={{
                      fontSize: 11, fontWeight: 600, fontFamily: 'monospace',
                      color: isConnected ? '#2e7d32' : hasIp ? '#b58900' : '#888',
                    }}>
                      {hasIp ? apiSettings.host : 'Not configured'}
                    </span>
                    <span style={{
                      fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: 0.5,
                      color: isConnected ? '#2e7d32' : hasIp ? '#b58900' : '#888',
                    }}>
                      {isConnected ? '● Online' : hasIp ? '○ Unverified' : '○ Offline'}
                    </span>
                  </div>
                );
              })()}

              {/* === Uniform header buttons — each 140px wide, same height, consistent style === */}

              {/* Get Started */}
              <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <button
                  onClick={() => setShowGetStartedModal(true)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    width: 140, padding: '8px 0', borderRadius: 8,
                    background: completedCount === totalSteps
                      ? 'linear-gradient(135deg, rgba(0,180,0,0.15), rgba(115,190,40,0.08))'
                      : 'linear-gradient(135deg, #6c2c9c, #00a1c9)',
                    border: completedCount === totalSteps
                      ? '1.5px solid rgba(0,180,0,0.5)'
                      : '1.5px solid rgba(108,44,156,0.7)',
                    color: completedCount === totalSteps ? '#2e7d32' : 'white',
                    fontWeight: 600, fontSize: 12,
                    cursor: 'pointer', transition: 'all 0.2s ease',
                    boxShadow: completedCount < totalSteps ? '0 2px 8px rgba(108,44,156,0.3)' : 'none',
                  }}
                  onMouseOver={e => { e.currentTarget.style.transform = 'translateY(-1px)'; }}
                  onMouseOut={e => { e.currentTarget.style.transform = 'none'; }}
                >
                  <span style={{ fontSize: 14 }}>{completedCount === totalSteps ? '✅' : '🚀'}</span>
                  Get Started
                  <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 6, background: completedCount === totalSteps ? 'rgba(0,180,0,0.2)' : 'rgba(255,255,255,0.25)', fontWeight: 700 }}>{completedCount}/{totalSteps}</span>
                </button>
                <div style={{ position: 'relative', display: 'inline-block' }}
                  onMouseEnter={() => setShowGetStartedTooltip(true)}
                  onMouseLeave={() => setShowGetStartedTooltip(false)}
                >
                  <div style={{ width: 18, height: 18, borderRadius: '50%', background: 'rgba(108,44,156,0.12)', border: '1.5px solid rgba(108,44,156,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'help', fontSize: 10, fontWeight: 700, color: Colors.Theme.Primary['70'] }}>?</div>
                  {showGetStartedTooltip && (
                    <div style={{ position: 'absolute', top: 24, right: 0, width: 260, padding: 12, borderRadius: 10, background: Colors.Background.Surface.Default, border: `1.5px solid ${Colors.Border.Neutral.Default}`, boxShadow: '0 8px 24px rgba(0,0,0,0.25)', zIndex: 10000, fontSize: 12, lineHeight: 1.6 }}>
                      <Strong style={{ fontSize: 13, marginBottom: 6, display: 'block' }}>🚀 Get Started Checklist</Strong>
                      <div>Step-by-step guide to configure your BizObs Demonstrator environment.</div>
                      <div style={{ marginTop: 6 }}><Strong>Server</Strong> — Connect to your BizObs backend</div>
                      <div><Strong>EdgeConnect</Strong> — Set up Dynatrace connectivity</div>
                      <div><Strong>Settings</Strong> — Deploy capture rules &amp; feature flags</div>
                      <div style={{ marginTop: 6, opacity: 0.6 }}>Complete all steps for full functionality.</div>
                    </div>
                  )}
                </div>
              </div>

              {/* Navigation Dropdown */}
              <div ref={navMenuRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
                <button
                  onClick={() => setShowNavMenu(prev => !prev)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                    padding: '8px 18px', borderRadius: 8,
                    background: showNavMenu
                      ? 'linear-gradient(135deg, rgba(108,44,156,0.25), rgba(0,161,201,0.15))'
                      : 'linear-gradient(135deg, rgba(108,44,156,0.12), rgba(0,161,201,0.06))',
                    border: '1.5px solid rgba(108,44,156,0.5)',
                    color: Colors.Theme.Primary['70'], fontWeight: 600, fontSize: 12,
                    cursor: 'pointer', transition: 'all 0.2s ease',
                  }}
                  onMouseOver={e => { if (!showNavMenu) e.currentTarget.style.transform = 'translateY(-1px)'; }}
                  onMouseOut={e => { e.currentTarget.style.transform = 'none'; }}
                >
                  <span style={{ fontSize: 14 }}>☰</span>
                  Navigate
                  <span style={{
                    fontSize: 10, transition: 'transform 0.2s ease',
                    display: 'inline-block',
                    transform: showNavMenu ? 'rotate(180deg)' : 'rotate(0deg)',
                  }}>▼</span>
                </button>

                {showNavMenu && (
                  <div style={{
                    position: 'absolute', top: '100%', right: 0, marginTop: 6,
                    width: 260, borderRadius: 12,
                    background: Colors.Background.Surface.Default,
                    border: `1.5px solid ${Colors.Border.Neutral.Default}`,
                    boxShadow: '0 12px 40px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.05)',
                    zIndex: 10001, overflow: 'hidden',
                    animation: 'navMenuSlideIn 0.15s ease-out',
                  }}>
                    <div style={{ padding: '10px 14px 6px', borderBottom: `1px solid ${Colors.Border.Neutral.Default}` }}>
                      <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: 1.2, color: Colors.Theme.Primary['70'], opacity: 0.7 }}>Navigation</span>
                    </div>
                    {[
                      { icon: '🗺️', label: 'Journeys', color: '#00a1c9', action: () => { openJourneysModal(); setShowNavMenu(false); } },
                      { icon: '👹', label: 'Nemesis', color: '#b58900', badge: activeFaults.length > 0 ? activeFaults.length : undefined, action: () => { openChaosModal(); setShowNavMenu(false); } },
                      { icon: '🎨', label: 'Generate Visuals', color: '#00a1c9', action: () => { openGenerateDashboardModal(); setShowNavMenu(false); } },
                      { icon: '📖', label: 'Demo Guide', color: '#00b4dc', route: '/demo-guide' },
                      { icon: '🏢', label: 'Solutions', color: '#27ae60', route: '/solutions' },
                      { icon: '📊', label: 'Dashboards', color: '#3498db', route: '/demonstrator-dashboards' },
                      { icon: '⚙️', label: 'Settings', color: Colors.Theme.Primary['70'] as string, action: () => { openSettingsModal(); setShowNavMenu(false); } },
                    ].map((item, idx) => (
                      <div
                        key={idx}
                        onClick={() => {
                          if (item.route) { navigate(item.route); setShowNavMenu(false); }
                          else if (item.action) item.action();
                        }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 12,
                          padding: '10px 16px', cursor: 'pointer',
                          transition: 'background 0.15s ease',
                          borderBottom: idx < 6 ? `1px solid rgba(255,255,255,0.04)` : 'none',
                        }}
                        onMouseOver={e => { e.currentTarget.style.background = `linear-gradient(90deg, ${item.color}18, transparent)`; }}
                        onMouseOut={e => { e.currentTarget.style.background = 'transparent'; }}
                      >
                        <span style={{
                          width: 32, height: 32, borderRadius: 8,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          background: `${item.color}18`,
                          border: `1px solid ${item.color}40`,
                          fontSize: 16,
                        }}>{item.icon}</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: item.color }}>{item.label}</div>
                        </div>
                        {item.badge && (
                          <span style={{
                            background: '#dc322f', color: 'white', borderRadius: 8,
                            padding: '2px 7px', fontSize: 10, fontWeight: 700,
                          }}>{item.badge}</span>
                        )}
                        <span style={{ fontSize: 12, opacity: 0.3 }}>›</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Feedback */}
              <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <a
                href="https://forms.office.com/r/bTZPypxQh9"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  width: 140, padding: '8px 0', borderRadius: 8,
                  background: 'linear-gradient(135deg, rgba(243,156,18,0.12), rgba(230,126,34,0.06))',
                  border: '1.5px solid rgba(243,156,18,0.4)',
                  color: '#f39c12', fontWeight: 600, fontSize: 12,
                  cursor: 'pointer', transition: 'all 0.2s ease',
                  textDecoration: 'none',
                }}
                onMouseOver={e => { e.currentTarget.style.transform = 'translateY(-1px)'; }}
                onMouseOut={e => { e.currentTarget.style.transform = 'none'; }}
              >
                <span style={{ fontSize: 14 }}>💬</span> Feedback
              </a>
              </div>


            </Flex>
          </TitleBar.Action>
        </TitleBar>
      </Page.Header>

      <Page.Main>
        <Flex style={{ height: '100%' }}>
          {/* Sidebar */}
          {renderSidebar()}

          {/* Main Content */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
          {/* Progress Indicator - compact, fixed at top */}
          <div style={{ 
            padding: '12px 24px',
            flexShrink: 0,
            background: 'linear-gradient(135deg, rgba(108, 44, 156, 0.08), rgba(0, 212, 255, 0.08))',
            borderBottom: `1px solid ${Colors.Border.Neutral.Default}`
          }}>
            <Flex justifyContent="center" alignItems="center" gap={0}>
              {[
                { id: 'welcome', label: 'Welcome', icon: '🏠', step: 0 },
                { id: 'step1', label: 'AI Generate', icon: '✨', step: 1 },
                { id: 'ownai', label: 'Own AI Prompt', icon: '📋', step: 1 },
                { id: 'step2', label: 'Generate Prompts', icon: '🤖', step: 2 }
              ].map((item, index, arr) => (
                <React.Fragment key={item.id}>
                  <Flex 
                    alignItems="center" 
                    gap={8}
                    style={{ 
                      cursor: (item.id === 'step2' && (!companyName || !domain)) ? 'not-allowed' : 'pointer',
                      opacity: (item.id === 'step2' && (!companyName || !domain)) ? 0.5 : 1,
                      padding: '8px 20px',
                      borderRadius: 8,
                      background: activeTab === item.id 
                        ? `linear-gradient(135deg, ${Colors.Theme.Primary['70']}, rgba(0, 212, 255, 0.8))` 
                        : 'transparent',
                      transition: 'all 0.3s ease',
                    }}
                    onClick={() => {
                      if (item.id !== 'step2' || (companyName && domain)) {
                        setActiveTab(item.id);
                      }
                    }}
                  >
                    <div style={{ fontSize: 18 }}>{item.icon}</div>
                    <Strong style={{ 
                      fontSize: 13,
                      color: activeTab === item.id ? 'white' : Colors.Text.Neutral.Default
                    }}>
                      {item.label}
                    </Strong>
                  </Flex>
                  {index < arr.length - 1 && (
                    <div style={{ 
                      width: 40, 
                      height: 2, 
                      background: index < (['welcome', 'step1', 'ownai', 'step2'].indexOf(activeTab)) 
                        ? Colors.Theme.Primary['70'] 
                        : Colors.Border.Neutral.Default,
                      margin: '0 4px',
                      transition: 'all 0.3s ease'
                    }} />
                  )}
                </React.Fragment>
              ))}
            </Flex>
          </div>

          {/* Tab Content - fills remaining space */}
          <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>
          {activeTab === 'welcome' && renderWelcomeTab()}
          {activeTab === 'step1' && renderStep1Tab()}
          {activeTab === 'ownai' && renderOwnAiTab()}
          {activeTab === 'step2' && renderStep2Tab()}
          </div>
          </div>
        </Flex>
      </Page.Main>

      {/* ── Settings Modal ─────────────────────────────── */}
      {showSettingsModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)' }} onClick={() => setShowSettingsModal(false)} />
          <div style={{ position: 'relative', width: 860, maxHeight: '85vh', overflow: 'auto', background: Colors.Background.Surface.Default, borderRadius: 16, border: `2px solid ${Colors.Border.Neutral.Default}`, boxShadow: '0 24px 48px rgba(0,0,0,0.3)' }}>
            {/* Header */}
            <div style={{ padding: '16px 24px', background: `linear-gradient(135deg, ${Colors.Theme.Primary['70']}, rgba(108,44,156,0.9))`, borderRadius: '14px 14px 0 0' }}>
              <Flex alignItems="center" justifyContent="space-between">
                <Flex alignItems="center" gap={12}>
                  <span style={{ fontSize: 24 }}>⚙️</span>
                  <div>
                    <Strong style={{ color: 'white', fontSize: 16 }}>Settings</Strong>
                    <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>Configuration & System Maintenance</div>
                  </div>
                </Flex>
                <Flex alignItems="center" gap={8}>
                  <button onClick={() => setShowSettingsModal(false)} style={{ background: 'none', border: 'none', color: 'white', fontSize: 20, cursor: 'pointer', padding: 4, marginLeft: 8 }}>✕</button>
                </Flex>
              </Flex>
            </div>

            {/* Tab Navigation */}
            <div style={{ padding: '0 24px', borderBottom: `1px solid ${Colors.Border.Neutral.Default}`, background: 'rgba(0,0,0,0.02)' }}>
              <Flex gap={0}>
                {([
                  { id: 'config', icon: '🔌', label: 'API Config' },
                  { id: 'copilot', icon: '🤖', label: 'GitHub Copilot' },
                  { id: 'system', icon: '💾', label: 'System' },
                ] as const).map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => { setSettingsTab(tab.id); if (tab.id === 'system' && !systemHealth) loadSystemHealth(); }}
                    style={{
                      padding: '12px 20px', border: 'none', cursor: 'pointer',
                      background: settingsTab === tab.id ? 'transparent' : 'transparent',
                      borderBottom: settingsTab === tab.id ? `2px solid ${Colors.Theme.Primary['70']}` : '2px solid transparent',
                      color: settingsTab === tab.id ? Colors.Theme.Primary['70'] : Colors.Text.Neutral.Default,
                      fontWeight: settingsTab === tab.id ? 700 : 400,
                      fontSize: 13, transition: 'all 0.2s ease',
                    }}
                  >
                    <span style={{ marginRight: 6 }}>{tab.icon}</span>{tab.label}
                  </button>
                ))}
              </Flex>
            </div>

            {/* Config Tab */}
            {settingsTab === 'config' && (
            <div style={{ padding: 24 }}>
              {/* Status */}
              {settingsStatus && (
                <div style={{ padding: 10, marginBottom: 16, borderRadius: 8, fontSize: 13, fontFamily: 'monospace',
                  background: settingsStatus.includes('✅') ? 'rgba(115,190,40,0.12)' : settingsStatus.includes('❌') ? 'rgba(220,50,47,0.12)' : 'rgba(0,161,201,0.12)',
                  border: `1px solid ${settingsStatus.includes('✅') ? Colors.Theme.Success['70'] : settingsStatus.includes('❌') ? '#dc322f' : Colors.Theme.Primary['70']}` }}>
                  {settingsStatus}
                </div>
              )}

              {/* Protocol */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Protocol</label>
                <Flex gap={8}>
                  <Button variant={settingsForm.apiProtocol === 'http' ? 'emphasized' : 'default'} onClick={() => setSettingsForm(p => ({ ...p, apiProtocol: 'http' }))} style={{ flex: 1 }}>HTTP</Button>
                  <Button variant={settingsForm.apiProtocol === 'https' ? 'emphasized' : 'default'} onClick={() => setSettingsForm(p => ({ ...p, apiProtocol: 'https' }))} style={{ flex: 1 }}>HTTPS</Button>
                </Flex>
              </div>

              {/* Host */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Host / IP Address</label>
                <TextInput value={settingsForm.apiHost} onChange={(v: string) => setSettingsForm(p => ({ ...p, apiHost: v }))} placeholder="localhost or IP address" />
              </div>

              {/* Port */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Port</label>
                <TextInput value={settingsForm.apiPort} onChange={(v: string) => setSettingsForm(p => ({ ...p, apiPort: v }))} placeholder="8080" />
              </div>

              {/* URL Preview */}
              <div style={{ padding: 12, background: 'rgba(0,161,201,0.08)', border: `1px solid ${Colors.Theme.Primary['70']}`, borderRadius: 8, marginBottom: 16 }}>
                <Strong style={{ fontSize: 11, marginBottom: 4, display: 'block' }}>Full API URL:</Strong>
                <code style={{ fontSize: 11, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                  {settingsForm.apiProtocol}://{settingsForm.apiHost}:{settingsForm.apiPort}/api/journey-simulation/simulate-journey
                </code>
              </div>

              {/* Actions */}
              <Flex gap={8}>
                <Button variant="emphasized" onClick={saveSettingsFromModal} disabled={isSavingSettings} style={{ flex: 2, fontWeight: 600 }}>
                  {isSavingSettings ? '💾 Saving...' : '💾 Save'}
                </Button>
                <Button onClick={testConnectionFromModal} disabled={isTestingConnection} style={{ flex: 1 }}>
                  {isTestingConnection ? '🔄...' : '🔌 Test'}
                </Button>
                <Button onClick={() => { setSettingsForm(DEFAULT_SETTINGS); setSettingsStatus('🔄 Reset to defaults'); }} style={{ flex: 1 }}>🔄 Reset</Button>
              </Flex>

              {/* ── Business Flow Management ── */}
              <div style={{ marginTop: 24, padding: 16, background: 'rgba(0,161,201,0.06)', border: `1px solid ${Colors.Border.Neutral.Default}`, borderRadius: 10 }}>
                <Flex alignItems="center" justifyContent="space-between" style={{ marginBottom: 12 }}>
                  <Strong style={{ fontSize: 13 }}>🔄 Business Flows</Strong>
                  <button onClick={loadBizFlows} disabled={isLoadingBizFlows} style={{ padding: '3px 10px', borderRadius: 6, border: `1px solid ${Colors.Border.Neutral.Default}`, background: 'transparent', cursor: isLoadingBizFlows ? 'wait' : 'pointer', fontSize: 11, fontWeight: 600 }}>
                    {isLoadingBizFlows ? '⏳ Loading...' : '📋 List Flows'}
                  </button>
                </Flex>
                {bizFlowStatus && (
                  <div style={{ padding: 8, marginBottom: 10, borderRadius: 6, fontSize: 12, fontFamily: 'monospace',
                    background: bizFlowStatus.includes('✅') ? 'rgba(115,190,40,0.12)' : bizFlowStatus.includes('❌') ? 'rgba(220,50,47,0.12)' : 'rgba(0,161,201,0.08)',
                    border: `1px solid ${bizFlowStatus.includes('✅') ? Colors.Theme.Success['70'] : bizFlowStatus.includes('❌') ? '#dc322f' : Colors.Border.Neutral.Default}` }}>
                    {bizFlowStatus}
                  </div>
                )}
                {bizFlows.length > 0 && (
                  <>
                    <div style={{ maxHeight: 200, overflow: 'auto', marginBottom: 10 }}>
                      {bizFlows.map(f => (
                        <div key={f.objectId} style={{ padding: '6px 10px', marginBottom: 4, borderRadius: 6, fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          background: f.isSmartscapeTopologyEnabled ? 'rgba(115,190,40,0.1)' : 'rgba(220,50,47,0.06)',
                          border: `1px solid ${f.isSmartscapeTopologyEnabled ? 'rgba(115,190,40,0.3)' : 'rgba(220,50,47,0.2)'}` }}>
                          <span>{f.isSmartscapeTopologyEnabled ? '🟢' : '⚪'} <strong>{f.name}</strong> ({f.stepsCount} steps)</span>
                          <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4,
                            background: f.isSmartscapeTopologyEnabled ? 'rgba(115,190,40,0.2)' : 'transparent',
                            color: f.isSmartscapeTopologyEnabled ? '#2e7d32' : '#888' }}>
                            {f.isSmartscapeTopologyEnabled ? 'ENTITY' : 'non-entity'}
                          </span>
                        </div>
                      ))}
                    </div>
                    <Flex gap={8}>
                      <button onClick={deleteNonEntityBizFlows} disabled={isDeletingBizFlows || bizFlows.filter(f => !f.isSmartscapeTopologyEnabled).length === 0}
                        style={{ flex: 1, padding: '6px 12px', borderRadius: 6, border: '1px solid rgba(220,50,47,0.4)', background: 'rgba(220,50,47,0.08)', cursor: isDeletingBizFlows ? 'wait' : 'pointer', fontSize: 12, fontWeight: 600, color: '#dc322f' }}>
                        {isDeletingBizFlows ? '🗑️ Deleting...' : `🗑️ Delete ${bizFlows.filter(f => !f.isSmartscapeTopologyEnabled).length} Non-Entity Flow(s)`}
                      </button>
                    </Flex>
                  </>
                )}
              </div>
            </div>
            )}

            {/* GitHub Copilot Tab */}
            {settingsTab === 'copilot' && (
            <div style={{ padding: 24 }}>
              <Strong style={{ fontSize: 15, display: 'block', marginBottom: 4 }}>🤖 GitHub Copilot AI Generation</Strong>
              <Paragraph style={{ fontSize: 12, marginBottom: 16, opacity: 0.7, lineHeight: 1.5 }}>
                Use your GitHub Copilot subscription to generate executive summaries and journey configs directly in the app — no copy/paste needed.
                Your GitHub Personal Access Token is stored securely in the Dynatrace Credential Vault.
              </Paragraph>

              {/* Status indicator */}
              <div style={{
                padding: 12, marginBottom: 16, borderRadius: 8,
                background: ghCopilotConfigured ? 'rgba(115,190,40,0.1)' : 'rgba(220,50,47,0.08)',
                border: `1px solid ${ghCopilotConfigured ? 'rgba(115,190,40,0.4)' : 'rgba(220,50,47,0.3)'}`,
              }}>
                <Flex alignItems="center" gap={8}>
                  <span style={{ fontSize: 18 }}>{ghCopilotChecking ? '⏳' : ghCopilotConfigured ? '✅' : '⚠️'}</span>
                  <div>
                    <Strong style={{ fontSize: 13 }}>
                      {ghCopilotChecking ? 'Checking credential vault...' : ghCopilotConfigured ? 'GitHub PAT configured — ready to generate' : 'Not configured — Generate with AI buttons will be disabled'}
                    </Strong>
                    {!ghCopilotConfigured && !ghCopilotChecking && (
                      <Paragraph style={{ fontSize: 11, marginBottom: 0, marginTop: 2, opacity: 0.8 }}>
                        Enter your GitHub Personal Access Token below to enable AI-powered generation.
                      </Paragraph>
                    )}
                  </div>
                </Flex>
              </div>

              {/* How to get a token */}
              <div style={{
                padding: 12, marginBottom: 16, borderRadius: 8,
                background: 'rgba(0,161,201,0.06)', border: '1px solid rgba(0,161,201,0.2)',
              }}>
                <Strong style={{ fontSize: 13, display: 'block', marginBottom: 6 }}>📋 How to create a GitHub Personal Access Token</Strong>
                <ol style={{ margin: 0, paddingLeft: 20, fontSize: 12, lineHeight: 1.8, opacity: 0.9 }}>
                  <li>Go to <Strong>github.com → Settings → Developer Settings → Personal Access Tokens → Fine-grained tokens</Strong></li>
                  <li>Click <Strong>Generate new token</Strong></li>
                  <li>Give it a name like <Strong>BizObs Demonstrator</Strong></li>
                  <li>No special permissions needed — just the default (read-only access to your public profile)</li>
                  <li>Copy the token (starts with <code style={{ background: 'rgba(0,0,0,0.2)', padding: '1px 4px', borderRadius: 3 }}>ghp_</code> or <code style={{ background: 'rgba(0,0,0,0.2)', padding: '1px 4px', borderRadius: 3 }}>github_pat_</code>)</li>
                </ol>
              </div>

              {/* Token input */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>GitHub Personal Access Token</label>
                <Flex gap={8}>
                  <input
                    type="password"
                    placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                    value={ghCopilotToken}
                    onChange={(e: any) => setGhCopilotToken(e.target.value)}
                    style={{
                      flex: 1, padding: '8px 12px', borderRadius: 6,
                      background: Colors.Background.Base.Default,
                      border: `1px solid ${Colors.Border.Neutral.Default}`,
                      color: Colors.Text.Neutral.Default, fontSize: 13,
                      fontFamily: 'monospace',
                    }}
                  />
                  <Button
                    variant="emphasized"
                    disabled={!ghCopilotToken.trim() || ghCopilotSaving}
                    onClick={async () => {
                      setGhCopilotSaving(true);
                      setGhCopilotStatus('⏳ Saving to Credential Vault...');
                      try {
                        const res = await callProxyWithRetry({
                          action: 'github-copilot-save-credential',
                          apiHost: '', apiPort: '', apiProtocol: '',
                          body: { token: ghCopilotToken.trim() },
                        });
                        if (res.success) {
                          setGhCopilotStatus(`✅ Token ${res.data?.updated ? 'updated' : 'saved'} in Credential Vault`);
                          setGhCopilotConfigured(true);
                          setGhCopilotToken('');
                          // Refresh available models list
                          try {
                            const modelsResp = await functions.call('proxy-api', { data: { action: 'github-copilot-list-models', apiHost: '', apiPort: '', apiProtocol: '' } });
                            const modelsRes = await modelsResp.json();
                            if (modelsRes.success && modelsRes.data?.models?.length > 0) {
                              setGhAvailableModels(modelsRes.data.models);
                              setGhCopilotStatus(`✅ Token ${res.data?.updated ? 'updated' : 'saved'} — ${modelsRes.data.models.length} models available`);
                            }
                          } catch { /* models fetch failed */ }
                        } else {
                          setGhCopilotStatus(`❌ ${res.error}`);
                        }
                      } catch (err: any) {
                        setGhCopilotStatus(`❌ ${err.message}`);
                      }
                      setGhCopilotSaving(false);
                    }}
                  >
                    {ghCopilotSaving ? '⏳ Saving...' : '🔐 Save to Vault'}
                  </Button>
                </Flex>
              </div>

              {/* Status message */}
              {ghCopilotStatus && (
                <div style={{
                  padding: 10, marginBottom: 16, borderRadius: 8, fontSize: 13, fontFamily: 'monospace',
                  background: ghCopilotStatus.includes('✅') ? 'rgba(115,190,40,0.12)' : ghCopilotStatus.includes('❌') ? 'rgba(220,50,47,0.12)' : 'rgba(0,161,201,0.12)',
                  border: `1px solid ${ghCopilotStatus.includes('✅') ? 'rgba(115,190,40,0.4)' : ghCopilotStatus.includes('❌') ? 'rgba(220,50,47,0.4)' : 'rgba(0,161,201,0.4)'}`,
                }}>
                  {ghCopilotStatus}
                </div>
              )}

              {/* Model selector */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>AI Model</label>
                <select
                  value={ghCopilotModel}
                  onChange={(e: any) => setGhCopilotModel(e.target.value)}
                  style={{
                    width: '100%', padding: '8px 12px', borderRadius: 6,
                    background: Colors.Background.Base.Default,
                    border: `1px solid ${Colors.Border.Neutral.Default}`,
                    color: Colors.Text.Neutral.Default, fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  {ghAvailableModels.length > 0
                    ? ghAvailableModels.map(m => (
                        <option key={m.id} value={m.id}>{m.id}{m.owned_by ? ` (${m.owned_by})` : ''}</option>
                      ))
                    : ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'o4-mini', 'claude-sonnet-4'].map(id => (
                        <option key={id} value={id}>{id}</option>
                      ))
                  }
                </select>
                <Paragraph style={{ fontSize: 11, marginTop: 4, marginBottom: 0, opacity: 0.6 }}>
                  {ghAvailableModels.length > 0
                    ? `${ghAvailableModels.length} models available via GitHub Copilot`
                    : 'Save a valid PAT with copilot scope to enable AI generation'}
                </Paragraph>
              </div>
            </div>
            )}

            {/* System Maintenance Tab */}
            {settingsTab === 'system' && (
            <div style={{ padding: 24 }}>
              <Flex alignItems="center" justifyContent="space-between" style={{ marginBottom: 16 }}>
                <div>
                  <Strong style={{ fontSize: 15, display: 'block' }}>💾 System Health & Disk Cleanup</Strong>
                  <Paragraph style={{ fontSize: 12, marginBottom: 0, marginTop: 4, opacity: 0.7 }}>
                    Cross-platform — works on Linux, macOS & Windows. Auto-cleans on server boot when disk {'>'} 90%.
                  </Paragraph>
                </div>
                <button onClick={loadSystemHealth} disabled={isLoadingHealth}
                  style={{ padding: '6px 14px', borderRadius: 8, border: `1px solid ${Colors.Border.Neutral.Default}`, background: 'transparent', cursor: isLoadingHealth ? 'wait' : 'pointer', fontSize: 12, fontWeight: 600 }}>
                  {isLoadingHealth ? '⏳ Scanning...' : '🔍 Scan'}
                </button>
              </Flex>

              {/* Cleanup Result */}
              {cleanupResult && (
                <div style={{ padding: 12, marginBottom: 16, borderRadius: 8, fontSize: 12, fontFamily: 'monospace',
                  background: cleanupResult.success ? 'rgba(115,190,40,0.12)' : 'rgba(220,50,47,0.12)',
                  border: `1px solid ${cleanupResult.success ? Colors.Theme.Success['70'] : '#dc322f'}` }}>
                  {cleanupResult.success
                    ? `✅ Cleanup complete — freed ${cleanupResult.totalFreedFormatted}`
                    : `❌ ${cleanupResult.error}`}
                  {cleanupResult.cleaned && cleanupResult.cleaned.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      {cleanupResult.cleaned.map((c: any, i: number) => (
                        <div key={i} style={{ marginTop: 2, fontSize: 11 }}>
                          {c.success ? '✅' : '⚠️'} {c.message}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {systemHealth?.error && (
                <div style={{ padding: 12, borderRadius: 8, background: 'rgba(220,50,47,0.08)', border: '1px solid rgba(220,50,47,0.3)', fontSize: 13, marginBottom: 16 }}>
                  ❌ {systemHealth.error}
                </div>
              )}

              {systemHealth && !systemHealth.error && (
                <>
                  {/* Disk Usage Bar */}
                  <div style={{ marginBottom: 20, padding: 16, borderRadius: 10, border: `1px solid ${Colors.Border.Neutral.Default}`, background: 'rgba(0,0,0,0.02)' }}>
                    <Flex justifyContent="space-between" alignItems="center" style={{ marginBottom: 8 }}>
                      <Strong style={{ fontSize: 13 }}>Disk Usage</Strong>
                      <span style={{ fontSize: 12, fontFamily: 'monospace',
                        color: systemHealth.disk?.percent >= 95 ? '#dc322f' : systemHealth.disk?.percent >= 85 ? '#f39c12' : Colors.Theme.Success['70'],
                        fontWeight: 700 }}>
                        {systemHealth.disk?.percent}%
                      </span>
                    </Flex>
                    <div style={{ width: '100%', height: 12, borderRadius: 6, background: 'rgba(0,0,0,0.08)', overflow: 'hidden' }}>
                      <div style={{
                        width: `${Math.min(systemHealth.disk?.percent || 0, 100)}%`, height: '100%', borderRadius: 6,
                        background: systemHealth.disk?.percent >= 95 ? 'linear-gradient(90deg, #dc322f, #ff4136)'
                          : systemHealth.disk?.percent >= 85 ? 'linear-gradient(90deg, #f39c12, #e67e22)'
                          : `linear-gradient(90deg, ${Colors.Theme.Success['70']}, #2ecc71)`,
                        transition: 'width 0.5s ease',
                      }} />
                    </div>
                    <Flex justifyContent="space-between" style={{ marginTop: 6, fontSize: 11, opacity: 0.6 }}>
                      <span>Free: {systemHealth.disk?.free ? (systemHealth.disk.free / 1024 / 1024 / 1024).toFixed(1) + ' GB' : '?'}</span>
                      <span>Total: {systemHealth.disk?.total ? (systemHealth.disk.total / 1024 / 1024 / 1024).toFixed(1) + ' GB' : '?'}</span>
                    </Flex>
                    {systemHealth.criticalThreshold && (
                      <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: 'rgba(220,50,47,0.1)', border: '1px solid rgba(220,50,47,0.3)', fontSize: 12, fontWeight: 600, color: '#dc322f' }}>
                        ⚠️ CRITICAL — Disk nearly full! Run cleanup immediately.
                      </div>
                    )}
                  </div>

                  {/* System Info */}
                  <Flex gap={12} style={{ marginBottom: 20 }}>
                    <div style={{ flex: 1, padding: 12, borderRadius: 8, border: `1px solid ${Colors.Border.Neutral.Default}`, background: 'rgba(0,0,0,0.02)' }}>
                      <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 4 }}>Platform</div>
                      <Strong style={{ fontSize: 13 }}>{systemHealth.platform === 'linux' ? '🐧 Linux' : systemHealth.platform === 'darwin' ? '🍎 macOS' : systemHealth.platform === 'win32' ? '🪟 Windows' : systemHealth.platform}</Strong>
                    </div>
                    <div style={{ flex: 1, padding: 12, borderRadius: 8, border: `1px solid ${Colors.Border.Neutral.Default}`, background: 'rgba(0,0,0,0.02)' }}>
                      <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 4 }}>Memory</div>
                      <Strong style={{ fontSize: 13 }}>{systemHealth.memory?.usedPercent}% used</Strong>
                    </div>
                    <div style={{ flex: 1, padding: 12, borderRadius: 8, border: `1px solid ${Colors.Border.Neutral.Default}`, background: 'rgba(0,0,0,0.02)' }}>
                      <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 4 }}>Reclaimable</div>
                      <Strong style={{ fontSize: 13, color: Colors.Theme.Success['70'] }}>{systemHealth.totalCleanableFormatted}</Strong>
                    </div>
                  </Flex>

                  {/* Cleanable Items */}
                  {systemHealth.cleanable && systemHealth.cleanable.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <Flex justifyContent="space-between" alignItems="center" style={{ marginBottom: 10 }}>
                        <Strong style={{ fontSize: 13 }}>🗂️ Cleanable Items</Strong>
                        <button onClick={() => runSystemCleanup()} disabled={isRunningCleanup}
                          style={{
                            padding: '8px 20px', borderRadius: 8, border: 'none',
                            background: isRunningCleanup ? 'rgba(115,190,40,0.3)' : `linear-gradient(135deg, ${Colors.Theme.Success['70']}, #2ecc71)`,
                            color: 'white', fontWeight: 700, fontSize: 13, cursor: isRunningCleanup ? 'wait' : 'pointer',
                            boxShadow: '0 2px 8px rgba(115,190,40,0.2)', transition: 'all 0.2s ease',
                          }}>
                          {isRunningCleanup ? '🧹 Cleaning...' : `🧹 Clean All Safe (${systemHealth.totalCleanableFormatted})`}
                        </button>
                      </Flex>
                      <div style={{ maxHeight: 300, overflow: 'auto' }}>
                        {systemHealth.cleanable.map((item: any) => (
                          <Flex key={item.id} alignItems="center" justifyContent="space-between"
                            style={{ padding: '8px 12px', marginBottom: 4, borderRadius: 8,
                              border: `1px solid ${item.safe ? 'rgba(115,190,40,0.2)' : 'rgba(220,160,0,0.3)'}`,
                              background: item.safe ? 'rgba(115,190,40,0.04)' : 'rgba(220,160,0,0.04)' }}>
                            <Flex alignItems="center" gap={8}>
                              <span style={{ fontSize: 14 }}>
                                {item.category === 'logs' ? '📋' : item.category === 'cache' ? '💽' : item.category === 'temp' ? '🗑️' : item.category === 'build' ? '🔨' : '📦'}
                              </span>
                              <div>
                                <div style={{ fontSize: 13, fontWeight: 600 }}>{item.label}</div>
                                {item.note && <div style={{ fontSize: 10, opacity: 0.5 }}>{item.note}</div>}
                              </div>
                            </Flex>
                            <Flex alignItems="center" gap={8}>
                              <span style={{ fontSize: 12, fontFamily: 'monospace', fontWeight: 600 }}>
                                {item.size > 0 ? (item.size >= 1073741824 ? (item.size / 1073741824).toFixed(1) + ' GB' : item.size >= 1048576 ? (item.size / 1048576).toFixed(1) + ' MB' : (item.size / 1024).toFixed(0) + ' KB') : '—'}
                              </span>
                              {item.safe ? (
                                <button onClick={() => runSystemCleanup([item.id])} disabled={isRunningCleanup}
                                  style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${Colors.Theme.Success['70']}`, background: 'rgba(115,190,40,0.08)', cursor: isRunningCleanup ? 'wait' : 'pointer', fontSize: 11, fontWeight: 600, color: Colors.Theme.Success['70'] }}>
                                  Clean
                                </button>
                              ) : (
                                <span style={{ fontSize: 11, opacity: 0.4, fontStyle: 'italic' }}>manual</span>
                              )}
                            </Flex>
                          </Flex>
                        ))}
                      </div>
                    </div>
                  )}

                  {systemHealth.cleanable && systemHealth.cleanable.length === 0 && (
                    <div style={{ textAlign: 'center', padding: 32, opacity: 0.5 }}>
                      <div style={{ fontSize: 40, marginBottom: 12 }}>✨</div>
                      <Paragraph>System is clean — nothing to reclaim.</Paragraph>
                    </div>
                  )}
                </>
              )}

              {!systemHealth && !isLoadingHealth && (
                <div style={{ textAlign: 'center', padding: 32, opacity: 0.5 }}>
                  <div style={{ fontSize: 40, marginBottom: 12 }}>💾</div>
                  <Paragraph>Click <strong>Scan</strong> to analyze server disk usage and find reclaimable space.</Paragraph>
                </div>
              )}

              {isLoadingHealth && (
                <div style={{ textAlign: 'center', padding: 32 }}>
                  <div style={{ fontSize: 40, marginBottom: 12 }}>⏳</div>
                  <Paragraph>Scanning file system...</Paragraph>
                </div>
              )}
            </div>
            )}

          </div>
        </div>
      )}

      {/* ── Services Modal ─────────────────────────────── */}
      {showServicesModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)' }} onClick={() => setShowServicesModal(false)} />
          <div style={{ position: 'relative', width: 720, maxHeight: '85vh', overflow: 'auto', background: Colors.Background.Surface.Default, borderRadius: 16, border: `2px solid ${Colors.Border.Neutral.Default}`, boxShadow: '0 24px 48px rgba(0,0,0,0.3)' }}>
            {/* Header */}
            <div style={{ padding: '16px 24px', background: 'linear-gradient(135deg, rgba(220,50,47,0.9), rgba(180,30,30,0.95))', borderRadius: '14px 14px 0 0' }}>
              <Flex alignItems="center" justifyContent="space-between">
                <Flex alignItems="center" gap={12}>
                  <span style={{ fontSize: 24 }}>🖥️</span>
                  <div>
                    <Strong style={{ color: 'white', fontSize: 16 }}>Running Services</Strong>
                    <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>Manage active child services</div>
                  </div>
                </Flex>
                <button onClick={() => setShowServicesModal(false)} style={{ background: 'none', border: 'none', color: 'white', fontSize: 20, cursor: 'pointer', padding: 4 }}>✕</button>
              </Flex>
            </div>

            <div style={{ padding: 24 }}>
              {/* Status */}
              {servicesStatus && (
                <div style={{ padding: 10, marginBottom: 16, borderRadius: 8, fontSize: 13, fontFamily: 'monospace',
                  background: servicesStatus.includes('✅') ? 'rgba(115,190,40,0.12)' : servicesStatus.includes('❌') ? 'rgba(220,50,47,0.12)' : 'rgba(0,161,201,0.12)',
                  border: `1px solid ${servicesStatus.includes('✅') ? Colors.Theme.Success['70'] : servicesStatus.includes('❌') ? '#dc322f' : Colors.Theme.Primary['70']}` }}>
                  {servicesStatus}
                </div>
              )}

              {isLoadingServices ? (
                <Flex justifyContent="center" style={{ padding: 32 }}><span style={{ fontSize: 32 }}>⏳</span></Flex>
              ) : runningServices.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 32, opacity: 0.6 }}>
                  <div style={{ fontSize: 40, marginBottom: 12 }}>🟢</div>
                  <Paragraph>No services currently running.</Paragraph>
                </div>
              ) : (
                <>
                  {/* Group by company */}
                  {(() => {
                    const groups: Record<string, RunningService[]> = {};
                    runningServices.forEach(s => {
                      const company = s.companyName || (s.service.includes('-') ? s.service.split('-').pop()! : 'Unknown');
                      if (!groups[company]) groups[company] = [];
                      groups[company].push(s);
                    });
                    return Object.entries(groups).map(([company, services]) => (
                      <div key={company} style={{ marginBottom: 16, border: `1px solid ${Colors.Border.Neutral.Default}`, borderRadius: 12, overflow: 'hidden' }}>
                        <div style={{ padding: '10px 16px', background: 'rgba(0,161,201,0.08)', borderBottom: `1px solid ${Colors.Border.Neutral.Default}` }}>
                          <Flex alignItems="center" justifyContent="space-between">
                            <Flex alignItems="center" gap={8}>
                              <span style={{ fontSize: 16 }}>🏢</span>
                              <a href={getServicesUiUrl(company, services[0]?.journeyType)} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', color: 'inherit' }}>
                                <Strong style={{ fontSize: 14, cursor: 'pointer', borderBottom: '1px dashed rgba(0,161,201,0.5)' }}>{company}</Strong>
                              </a>
                              <span style={{ fontSize: 12, opacity: 0.6 }}>({services.length} service{services.length !== 1 ? 's' : ''})</span>
                              {services[0]?.releaseStage && (
                                <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(108,44,156,0.15)', color: '#6c2c9c', fontFamily: 'monospace' }}>
                                  stage:{services[0].releaseStage}
                                </span>
                              )}
                            </Flex>
                            <Flex gap={4}>
                              <Button onClick={() => stopCompanyServices(company)} disabled={isStoppingServices} style={{ fontSize: 12, padding: '4px 12px' }}>
                                {stoppingCompany === company ? `⏳ Stopping ${company}...` : `🛑 Stop ${company}`}
                              </Button>
                            </Flex>
                          </Flex>
                        </div>
                        <div style={{ padding: 12 }}>
                          {services.map(s => (
                            <Flex key={s.pid} alignItems="center" justifyContent="space-between" style={{ padding: '6px 8px', borderRadius: 6, marginBottom: 4, background: s.running ? 'rgba(115,190,40,0.06)' : 'rgba(220,50,47,0.06)' }}>
                              <Flex alignItems="center" gap={8}>
                                <span style={{ fontSize: 10, color: s.running ? Colors.Theme.Success['70'] : '#dc322f' }}>●</span>
                                <span style={{ fontSize: 13 }}>{s.baseServiceName || s.service}</span>
                                {s.serviceVersion && (
                                  <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: 'rgba(115,190,40,0.15)', color: Colors.Theme.Success['70'], fontFamily: 'monospace', fontWeight: 600 }}>
                                    v{s.serviceVersion}.0.0
                                  </span>
                                )}
                              </Flex>
                              <Flex alignItems="center" gap={8}>
                                <span style={{ fontSize: 10, opacity: 0.4, fontFamily: 'monospace' }}>:{s.port || '?'}</span>
                                <span style={{ fontSize: 11, opacity: 0.5, fontFamily: 'monospace' }}>PID {s.pid}</span>
                              </Flex>
                            </Flex>
                          ))}
                        </div>
                      </div>
                    ));
                  })()}
                </>
              )}

              {/* Actions */}
              <Flex gap={8} style={{ marginTop: 16 }}>
                <Button onClick={() => { loadRunningServices(); loadDormantServices(); }} disabled={isLoadingServices} style={{ flex: 1 }}>🔄 Refresh</Button>
                {runningServices.length > 0 && (
                  <Button onClick={stopAllServices} disabled={isStoppingServices} style={{ flex: 1, background: 'rgba(220,50,47,0.15)', color: '#dc322f' }}>
                    {isStoppingServices ? '🛑 Stopping...' : '🛑 Stop All Services'}
                  </Button>
                )}
              </Flex>

              {/* ── Dormant Services Section ──── */}
              <div style={{ marginTop: 24, borderTop: `1px solid ${Colors.Border.Neutral.Default}`, paddingTop: 20 }}>
                <Flex alignItems="center" justifyContent="space-between" style={{ marginBottom: 12 }}>
                  <Flex alignItems="center" gap={8}>
                    <span style={{ fontSize: 18 }}>💤</span>
                    <Strong style={{ fontSize: 14 }}>Dormant Services</Strong>
                    <span style={{ fontSize: 12, opacity: 0.5 }}>({dormantServices.length})</span>
                  </Flex>
                  {dormantServices.length > 0 && (
                    <Button onClick={() => setShowDormantWarning('all')} disabled={isClearingDormant} style={{ fontSize: 12, padding: '4px 14px', background: 'rgba(220,160,0,0.12)', color: '#b58900' }}>
                      {isClearingDormant ? '🧹 Clearing...' : '🧹 Clear All Dormant'}
                    </Button>
                  )}
                </Flex>

                {isLoadingDormant ? (
                  <Flex justifyContent="center" style={{ padding: 16 }}><span style={{ fontSize: 20 }}>⏳</span></Flex>
                ) : dormantServices.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 16, opacity: 0.5, fontSize: 13 }}>
                    No dormant services. Services that are stopped will appear here for quick restart.
                  </div>
                ) : (
                  <>
                    {/* Group dormant by company */}
                    {(() => {
                      const groups: Record<string, any[]> = {};
                      dormantServices.forEach((s: any) => {
                        const company = s.companyName || 'Unknown';
                        if (!groups[company]) groups[company] = [];
                        groups[company].push(s);
                      });
                      return Object.entries(groups).map(([company, services]) => (
                        <div key={`dormant-${company}`} style={{ marginBottom: 12, border: `1px dashed rgba(181,137,0,0.4)`, borderRadius: 10, overflow: 'hidden' }}>
                          <div style={{ padding: '8px 14px', background: 'rgba(181,137,0,0.06)', borderBottom: `1px dashed rgba(181,137,0,0.3)` }}>
                            <Flex alignItems="center" justifyContent="space-between">
                              <Flex alignItems="center" gap={8}>
                                <span style={{ fontSize: 14 }}>💤</span>
                                <a href={getServicesUiUrl(company, services[0]?.journeyType)} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', color: 'inherit' }}>
                                  <Strong style={{ fontSize: 13, cursor: 'pointer', borderBottom: '1px dashed rgba(181,137,0,0.5)' }}>{company}</Strong>
                                </a>
                                <span style={{ fontSize: 11, opacity: 0.5 }}>({services.length} dormant)</span>
                              </Flex>
                              <Button onClick={() => setShowDormantWarning(company)} disabled={clearingDormantCompany === company} style={{ fontSize: 10, padding: '2px 8px', background: 'rgba(220,160,0,0.1)', color: '#b58900' }}>
                                {clearingDormantCompany === company ? '⏳...' : '🧹 Clear'}
                              </Button>
                            </Flex>
                          </div>
                          <div style={{ padding: 10 }}>
                            {services.map((s: any, idx: number) => (
                              <Flex key={idx} alignItems="center" justifyContent="space-between" style={{ padding: '5px 8px', borderRadius: 6, marginBottom: 3, background: 'rgba(181,137,0,0.04)' }}>
                                <Flex alignItems="center" gap={8}>
                                  <span style={{ fontSize: 10, color: '#b58900' }}>○</span>
                                  <span style={{ fontSize: 12 }}>{s.baseServiceName || s.serviceName}</span>
                                  {s.serviceVersion && (
                                    <span style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3, background: 'rgba(181,137,0,0.1)', color: '#b58900', fontFamily: 'monospace' }}>
                                      v{s.serviceVersion}
                                    </span>
                                  )}
                                </Flex>
                                <span style={{ fontSize: 10, opacity: 0.4, fontFamily: 'monospace' }}>port {s.previousPort}</span>
                              </Flex>
                            ))}
                          </div>
                        </div>
                      ));
                    })()}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Journeys Modal ─────────────────────────────── */}
      {showJourneysModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)' }} onClick={() => setShowJourneysModal(false)} />
          <div style={{ position: 'relative', width: '95vw', maxWidth: 1200, maxHeight: '92vh', overflow: 'auto', background: Colors.Background.Surface.Default, borderRadius: 16, border: `2px solid ${Colors.Border.Neutral.Default}`, boxShadow: '0 24px 48px rgba(0,0,0,0.3)' }}>
            {/* Header */}
            <div style={{ padding: '16px 24px', background: 'linear-gradient(135deg, rgba(0,161,201,0.9), rgba(0,140,180,0.95))', borderRadius: '14px 14px 0 0' }}>
              <Flex alignItems="center" justifyContent="space-between">
                <Flex alignItems="center" gap={12}>
                  <span style={{ fontSize: 24 }}>🗺️</span>
                  <div>
                    <Strong style={{ color: 'white', fontSize: 16 }}>Active Journeys</Strong>
                    <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>Running journeys grouped by company &amp; journey type</div>
                  </div>
                </Flex>
                <Flex alignItems="center" gap={8}>
                  <button onClick={() => { loadJourneysData(); loadDormantServices(); }} disabled={isLoadingJourneys} style={{ background: 'rgba(255,255,255,0.2)', border: '1px solid rgba(255,255,255,0.3)', color: 'white', borderRadius: 6, padding: '4px 12px', fontSize: 12, cursor: 'pointer' }}>🔄 Refresh</button>
                  <button onClick={() => setShowJourneysModal(false)} style={{ background: 'none', border: 'none', color: 'white', fontSize: 20, cursor: 'pointer', padding: 4 }}>✕</button>
                </Flex>
              </Flex>
            </div>

            <div style={{ padding: 24 }}>
              {/* Status bar */}
              {journeysStatus && (
                <div style={{ padding: 10, marginBottom: 16, borderRadius: 8, fontSize: 13, fontFamily: 'monospace',
                  background: journeysStatus.includes('❌') ? 'rgba(220,50,47,0.12)' : 'rgba(0,161,201,0.08)',
                  border: `1px solid ${journeysStatus.includes('❌') ? '#dc322f' : 'rgba(0,161,201,0.3)'}` }}>
                  {journeysStatus}
                </div>
              )}

              {isLoadingJourneys ? (
                <Flex justifyContent="center" style={{ padding: 32 }}><span style={{ fontSize: 32 }}>⏳</span></Flex>
              ) : journeysData.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 40, opacity: 0.6 }}>
                  <div style={{ fontSize: 48, marginBottom: 12 }}>🗺️</div>
                  <Paragraph style={{ fontSize: 14 }}>No active journeys. Generate services in Step 3 to see journeys here.</Paragraph>
                </div>
              ) : (
                <>
                  {/* Summary cards */}
                  {(() => {
                    // Group by companyName → journeyType
                    const grouped: Record<string, Record<string, RunningService[]>> = {};
                    journeysData.forEach(s => {
                      const company = s.companyName || 'Unknown';
                      const jType = s.journeyType || 'Unknown';
                      if (!grouped[company]) grouped[company] = {};
                      if (!grouped[company][jType]) grouped[company][jType] = [];
                      grouped[company][jType].push(s);
                    });
                    const totalJourneys = Object.values(grouped).reduce((sum, company) => sum + Object.keys(company).length, 0);
                    const totalCompanies = Object.keys(grouped).length;

                    return (
                      <div>
                        {/* Overview summary */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
                          <div style={{ padding: 14, borderRadius: 10, background: 'linear-gradient(135deg, rgba(0,161,201,0.1), rgba(0,212,255,0.06))', border: '1px solid rgba(0,161,201,0.25)', textAlign: 'center' }}>
                            <div style={{ fontSize: 28, fontWeight: 700, color: '#00a1c9' }}>{totalCompanies}</div>
                            <div style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase', fontWeight: 600, letterSpacing: 0.5 }}>Companies</div>
                          </div>
                          <div style={{ padding: 14, borderRadius: 10, background: 'linear-gradient(135deg, rgba(115,190,40,0.1), rgba(0,212,255,0.06))', border: '1px solid rgba(115,190,40,0.25)', textAlign: 'center' }}>
                            <div style={{ fontSize: 28, fontWeight: 700, color: Colors.Theme.Success['70'] }}>{totalJourneys}</div>
                            <div style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase', fontWeight: 600, letterSpacing: 0.5 }}>Journeys</div>
                          </div>
                          <div style={{ padding: 14, borderRadius: 10, background: 'linear-gradient(135deg, rgba(108,44,156,0.1), rgba(0,212,255,0.06))', border: '1px solid rgba(108,44,156,0.25)', textAlign: 'center' }}>
                            <div style={{ fontSize: 28, fontWeight: 700, color: '#6c2c9c' }}>{journeysData.length}</div>
                            <div style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase', fontWeight: 600, letterSpacing: 0.5 }}>Total Services</div>
                          </div>
                        </div>

                        {/* Company → Journey Type breakdown */}
                        {Object.entries(grouped).map(([company, journeyTypes]) => (
                          <div key={company} style={{ marginBottom: 16, border: `1px solid ${Colors.Border.Neutral.Default}`, borderRadius: 12, overflow: 'hidden' }}>
                            {/* Company header */}
                            <div style={{ padding: '12px 16px', background: 'linear-gradient(135deg, rgba(0,161,201,0.08), rgba(0,212,255,0.04))', borderBottom: `1px solid ${Colors.Border.Neutral.Default}` }}>
                              <Flex alignItems="center" justifyContent="space-between">
                                <Flex alignItems="center" gap={8}>
                                  <span style={{ fontSize: 18 }}>🏢</span>
                                  <Strong style={{ fontSize: 15 }}>{company}</Strong>
                                  <span style={{ fontSize: 12, opacity: 0.5 }}>
                                    ({Object.keys(journeyTypes).length} journey{Object.keys(journeyTypes).length !== 1 ? 's' : ''}, {Object.values(journeyTypes).reduce((sum, svcs) => sum + svcs.length, 0)} services)
                                  </span>
                                </Flex>
                                <Flex gap={6}>
                                  <button
                                    onClick={() => stopCompanyServices(company)}
                                    disabled={isStoppingServices}
                                    style={{
                                      display: 'inline-flex', alignItems: 'center', gap: 4,
                                      padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                                      background: 'rgba(220,50,47,0.08)', border: '1px solid rgba(220,50,47,0.25)', color: '#dc322f',
                                      cursor: isStoppingServices ? 'not-allowed' : 'pointer',
                                    }}
                                  >
                                    {stoppingCompany === company ? '⏳ Stopping...' : `🛑 Stop ${company}`}
                                  </button>
                                  <a
                                    href={getServicesUiUrl(company)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{
                                      display: 'inline-flex', alignItems: 'center', gap: 4,
                                      padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                                      background: 'rgba(0,161,201,0.08)', border: '1px solid rgba(0,161,201,0.25)', color: '#00a1c9',
                                      textDecoration: 'none', cursor: 'pointer',
                                    }}
                                  >
                                    🖥️ Services
                                  </a>
                                  <a
                                    href={getDashboardSearchUrl(company)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{
                                      display: 'inline-flex', alignItems: 'center', gap: 4,
                                      padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                                      background: 'rgba(108,44,156,0.08)', border: '1px solid rgba(108,44,156,0.25)', color: '#6c2c9c',
                                      textDecoration: 'none', cursor: 'pointer',
                                    }}
                                  >
                                    📊 Dashboards
                                  </a>
                                </Flex>
                              </Flex>
                            </div>

                            {/* Journey types within this company */}
                            <div style={{ padding: 12 }}>
                              {Object.entries(journeyTypes).map(([jType, services]) => (
                                <div key={jType} style={{ marginBottom: 10, padding: 10, borderRadius: 8, background: 'rgba(115,190,40,0.04)', border: '1px dashed rgba(115,190,40,0.2)' }}>
                                  <Flex alignItems="center" justifyContent="space-between" style={{ marginBottom: 6 }}>
                                    <Flex alignItems="center" gap={8}>
                                      <span style={{ fontSize: 14 }}>🗺️</span>
                                      <Strong style={{ fontSize: 13 }}>{jType}</Strong>
                                      <span style={{ fontSize: 11, opacity: 0.5 }}>({services.length} service{services.length !== 1 ? 's' : ''})</span>
                                    </Flex>
                                    <a
                                      href={getServicesUiUrl(company, jType)}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      style={{
                                        fontSize: 10, padding: '2px 8px', borderRadius: 4,
                                        background: 'rgba(0,161,201,0.08)', border: '1px solid rgba(0,161,201,0.2)', color: '#00a1c9',
                                        textDecoration: 'none', cursor: 'pointer',
                                      }}
                                    >
                                      View in DT →
                                    </a>
                                  </Flex>
                                  {/* Service list */}
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                    {services.map(s => (
                                      <Flex key={s.pid} alignItems="center" gap={6} style={{ padding: '5px 12px', borderRadius: 6, background: s.running ? 'rgba(115,190,40,0.06)' : 'rgba(220,50,47,0.06)', whiteSpace: 'nowrap' }}>
                                        <span style={{ fontSize: 8, color: s.running ? Colors.Theme.Success['70'] : '#dc322f' }}>●</span>
                                        <span style={{ fontSize: 12 }}>{s.baseServiceName || s.service}</span>
                                        {s.serviceVersion && (
                                          <span style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3, background: 'rgba(115,190,40,0.12)', color: Colors.Theme.Success['70'], fontFamily: 'monospace', fontWeight: 600 }}>
                                            v{s.serviceVersion}.0.0
                                          </span>
                                        )}
                                        <span style={{ fontSize: 9, opacity: 0.4, fontFamily: 'monospace' }}>:{s.port || '?'}</span>
                                      </Flex>
                                    ))}
                                  </div>

                                  {/* ── Deployment Status ── */}
                                  {(() => {
                                    const assetKey = `${company}::${jType}`;
                                    const asset = journeyAssets[assetKey];
                                    if (!asset) return null;
                                    return (
                                      <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 8 }}>
                                        {/* Services link */}
                                        <a
                                          href={getServicesUiUrl(company, jType)}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          style={{
                                            display: 'inline-flex', alignItems: 'center', gap: 4,
                                            padding: '3px 10px', borderRadius: 14, fontSize: 11, fontWeight: 600,
                                            background: 'rgba(115,190,40,0.1)', border: '1px solid rgba(115,190,40,0.3)', color: Colors.Theme.Success['70'],
                                            textDecoration: 'none',
                                          }}
                                        >
                                          <span style={{ fontSize: 8 }}>●</span> Services active
                                        </a>

                                        {/* Dashboard status */}
                                        {asset.dashboard.exists ? (
                                          <a
                                            href={`${TENANT_URL}${asset.dashboard.url}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            title={asset.dashboard.name || asset.dashboard.id}
                                            style={{
                                              display: 'inline-flex', alignItems: 'center', gap: 4,
                                              padding: '3px 10px', borderRadius: 14, fontSize: 11, fontWeight: 600,
                                              background: 'rgba(108,44,156,0.1)', border: '1px solid rgba(108,44,156,0.3)', color: '#9b59b6',
                                              textDecoration: 'none',
                                            }}
                                          >
                                            📊 Dashboard deployed
                                          </a>
                                        ) : (
                                          <span style={{
                                            display: 'inline-flex', alignItems: 'center', gap: 4,
                                            padding: '3px 10px', borderRadius: 14, fontSize: 11, fontWeight: 600,
                                            background: 'rgba(220,50,47,0.06)', border: '1px dashed rgba(220,50,47,0.25)', color: '#dc322f',
                                            opacity: 0.85,
                                          }}>
                                            📊 Dashboard not deployed
                                          </span>
                                        )}

                                        {/* BizFlow status */}
                                        {asset.bizflow.exists ? (
                                          <a
                                            href={`${TENANT_URL}/ui/apps/dynatrace.biz.flow/`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            style={{
                                              display: 'inline-flex', alignItems: 'center', gap: 4,
                                              padding: '3px 10px', borderRadius: 14, fontSize: 11, fontWeight: 600,
                                              background: 'rgba(0,161,201,0.1)', border: '1px solid rgba(0,161,201,0.3)', color: '#00a1c9',
                                              textDecoration: 'none',
                                            }}
                                          >
                                            🔄 BizFlow deployed
                                          </a>
                                        ) : (
                                          <span style={{
                                            display: 'inline-flex', alignItems: 'center', gap: 4,
                                            padding: '3px 10px', borderRadius: 14, fontSize: 11, fontWeight: 600,
                                            background: 'rgba(220,50,47,0.06)', border: '1px dashed rgba(220,50,47,0.25)', color: '#dc322f',
                                            opacity: 0.85,
                                          }}>
                                            🔄 BizFlow not deployed
                                          </span>
                                        )}
                                      </div>
                                    );
                                  })()}
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </>
              )}

              {/* ── Actions: Stop All ── */}
              {journeysData.length > 0 && (
                <Flex gap={8} style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${Colors.Border.Neutral.Default}` }}>
                  <Button onClick={stopAllServices} disabled={isStoppingServices} style={{ flex: 1, background: 'rgba(220,50,47,0.15)', color: '#dc322f' }}>
                    {isStoppingServices ? '🛑 Stopping...' : '🛑 Stop All Services'}
                  </Button>
                </Flex>
              )}

              {/* ── Dormant Services Section ── */}
              <div style={{ marginTop: 24, borderTop: `1px solid ${Colors.Border.Neutral.Default}`, paddingTop: 20 }}>
                <Flex alignItems="center" justifyContent="space-between" style={{ marginBottom: 12 }}>
                  <Flex alignItems="center" gap={8}>
                    <span style={{ fontSize: 18 }}>💤</span>
                    <Strong style={{ fontSize: 14 }}>Dormant Services</Strong>
                    <span style={{ fontSize: 12, opacity: 0.5 }}>({dormantServices.length})</span>
                  </Flex>
                  {dormantServices.length > 0 && (
                    <Button onClick={() => setShowDormantWarning('all')} disabled={isClearingDormant} style={{ fontSize: 12, padding: '4px 14px', background: 'rgba(220,160,0,0.12)', color: '#b58900' }}>
                      {isClearingDormant ? '🧹 Clearing...' : '🧹 Clear All Dormant'}
                    </Button>
                  )}
                </Flex>

                {isLoadingDormant ? (
                  <Flex justifyContent="center" style={{ padding: 16 }}><span style={{ fontSize: 20 }}>⏳</span></Flex>
                ) : dormantServices.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 16, opacity: 0.5, fontSize: 13 }}>
                    No dormant services. Services that are stopped will appear here for quick restart.
                  </div>
                ) : (
                  <>
                    {(() => {
                      const groups: Record<string, any[]> = {};
                      dormantServices.forEach((s: any) => {
                        const company = s.companyName || 'Unknown';
                        if (!groups[company]) groups[company] = [];
                        groups[company].push(s);
                      });
                      return Object.entries(groups).map(([company, services]) => (
                        <div key={`dormant-${company}`} style={{ marginBottom: 12, border: `1px dashed rgba(181,137,0,0.4)`, borderRadius: 10, overflow: 'hidden' }}>
                          <div style={{ padding: '8px 14px', background: 'rgba(181,137,0,0.06)', borderBottom: `1px dashed rgba(181,137,0,0.3)` }}>
                            <Flex alignItems="center" justifyContent="space-between">
                              <Flex alignItems="center" gap={8}>
                                <span style={{ fontSize: 14 }}>💤</span>
                                <Strong style={{ fontSize: 13 }}>{company}</Strong>
                                <span style={{ fontSize: 11, opacity: 0.5 }}>({services.length} dormant)</span>
                              </Flex>
                              <Button onClick={() => setShowDormantWarning(company)} disabled={clearingDormantCompany === company} style={{ fontSize: 10, padding: '2px 8px', background: 'rgba(220,160,0,0.1)', color: '#b58900' }}>
                                {clearingDormantCompany === company ? '⏳...' : '🧹 Clear'}
                              </Button>
                            </Flex>
                          </div>
                          <div style={{ padding: 10 }}>
                            {services.map((s: any, idx: number) => (
                              <Flex key={idx} alignItems="center" justifyContent="space-between" style={{ padding: '5px 8px', borderRadius: 6, marginBottom: 3, background: 'rgba(181,137,0,0.04)' }}>
                                <Flex alignItems="center" gap={8}>
                                  <span style={{ fontSize: 10, color: '#b58900' }}>○</span>
                                  <span style={{ fontSize: 12 }}>{s.baseServiceName || s.serviceName}</span>
                                  {s.serviceVersion && (
                                    <span style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3, background: 'rgba(181,137,0,0.1)', color: '#b58900', fontFamily: 'monospace' }}>
                                      v{s.serviceVersion}
                                    </span>
                                  )}
                                </Flex>
                                <span style={{ fontSize: 10, opacity: 0.4, fontFamily: 'monospace' }}>port {s.previousPort}</span>
                              </Flex>
                            ))}
                          </div>
                        </div>
                      ));
                    })()}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Dormant Warning Confirmation Modal ──── */}
      {showDormantWarning && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 10001, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)' }} onClick={() => setShowDormantWarning(null)} />
          <div style={{ position: 'relative', width: 440, background: Colors.Background.Surface.Default, borderRadius: 14, border: `2px solid #b58900`, boxShadow: '0 16px 40px rgba(0,0,0,0.3)' }}>
            <div style={{ padding: '16px 20px', background: 'linear-gradient(135deg, rgba(181,137,0,0.15), rgba(220,160,0,0.1))', borderRadius: '12px 12px 0 0', borderBottom: `1px solid rgba(181,137,0,0.3)` }}>
              <Flex alignItems="center" gap={8}>
                <span style={{ fontSize: 22 }}>⚠️</span>
                <Strong style={{ fontSize: 15 }}>Clear Dormant Services</Strong>
              </Flex>
            </div>
            <div style={{ padding: 20 }}>
              <Paragraph style={{ fontSize: 13, marginBottom: 12, lineHeight: 1.6 }}>
                {showDormantWarning === 'all'
                  ? 'You are about to clear ALL dormant services.'
                  : `You are about to clear dormant services for "${showDormantWarning}".`}
              </Paragraph>
              <div style={{ padding: 12, borderRadius: 8, background: 'rgba(220,50,47,0.08)', border: '1px solid rgba(220,50,47,0.3)', marginBottom: 16 }}>
                <Strong style={{ fontSize: 12, color: '#dc322f', display: 'block', marginBottom: 6 }}>⚠️ Duplicate Service Warning</Strong>
                <Paragraph style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.5, margin: 0 }}>
                  If you re-enable these services within <Strong>24 hours</Strong>, Dynatrace may detect them as <Strong>duplicate services</Strong> because OneAgent remembers the previous process group. This can cause:
                </Paragraph>
                <ul style={{ fontSize: 11, opacity: 0.8, margin: '6px 0 0 0', paddingLeft: 20, lineHeight: 1.6 }}>
                  <li>Split service metrics (old vs new instance)</li>
                  <li>Confusing service topology in Smartscape</li>
                  <li>Duplicate entries in the Services screen</li>
                </ul>
                <Paragraph style={{ fontSize: 12, opacity: 0.85, marginTop: 8, marginBottom: 0 }}>
                  <Strong>Tip:</Strong> Use the <code style={{ fontSize: 11, background: 'rgba(0,0,0,0.1)', padding: '1px 4px', borderRadius: 3 }}>version</code> and <code style={{ fontSize: 11, background: 'rgba(0,0,0,0.1)', padding: '1px 4px', borderRadius: 3 }}>stage</code> tags in Dynatrace to filter by generation.
                </Paragraph>
              </div>
              <Flex gap={8}>
                <Button onClick={() => setShowDormantWarning(null)} style={{ flex: 1 }}>Cancel</Button>
                <Button onClick={() => showDormantWarning === 'all' ? clearAllDormantServices() : clearCompanyDormantServices(showDormantWarning)} style={{ flex: 1, background: 'rgba(220,50,47,0.15)', color: '#dc322f', fontWeight: 600 }}>
                  🗑️ Clear {showDormantWarning === 'all' ? 'All' : showDormantWarning} Dormant
                </Button>
              </Flex>
            </div>
          </div>
        </div>
      )}

      {/* ── Chaos Nemesis Agent Modal ─────────────────────────────── */}
      {showChaosModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)' }} onClick={() => setShowChaosModal(false)} />
          <div style={{ position: 'relative', width: 760, maxHeight: '85vh', overflow: 'auto', background: Colors.Background.Surface.Default, borderRadius: 16, border: '2px solid rgba(181,137,0,0.5)', boxShadow: '0 24px 48px rgba(0,0,0,0.3)' }}>
            {/* Header */}
            <div style={{ padding: '16px 24px', background: 'linear-gradient(135deg, rgba(107,142,35,0.85), rgba(181,137,0,0.9))', borderRadius: '14px 14px 0 0' }}>
              <Flex alignItems="center" justifyContent="space-between">
                <Flex alignItems="center" gap={12}>
                  <svg width="32" height="32" viewBox="0 0 64 64">
                    <circle cx="32" cy="34" r="22" fill="#6b8e23"/>
                    <ellipse cx="22" cy="28" rx="6" ry="7" fill="white"/>
                    <ellipse cx="42" cy="28" rx="6" ry="7" fill="white"/>
                    <circle cx="23" cy="28" r="3.5" fill="#dc322f"/>
                    <circle cx="43" cy="28" r="3.5" fill="#dc322f"/>
                    <path d="M22 42 Q32 50 42 42" stroke="white" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
                    <rect x="24" y="42" width="3" height="4" rx="1" fill="white" transform="rotate(-8 25.5 44)"/>
                    <rect x="30.5" y="43" width="3" height="4.5" rx="1" fill="white"/>
                    <rect x="37" y="42" width="3" height="4" rx="1" fill="white" transform="rotate(8 38.5 44)"/>
                    <path d="M14 16 Q18 24 22 22" stroke="#6b8e23" strokeWidth="3" fill="none" strokeLinecap="round"/>
                    <path d="M50 16 Q46 24 42 22" stroke="#6b8e23" strokeWidth="3" fill="none" strokeLinecap="round"/>
                    <ellipse cx="12" cy="14" rx="4" ry="5" fill="#6b8e23"/>
                    <ellipse cx="52" cy="14" rx="4" ry="5" fill="#6b8e23"/>
                  </svg>
                  <div>
                    <Strong style={{ color: 'white', fontSize: 16 }}>Chaos Nemesis Agent</Strong>
                    <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>Inject faults · Test resilience · Observe recovery</div>
                  </div>
                </Flex>
                <Flex alignItems="center" gap={8}>
                  <button onClick={loadChaosData} disabled={isLoadingChaos} style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)', color: 'white', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 12 }}>
                    {isLoadingChaos ? '⏳' : '🔄'} Refresh
                  </button>
                  <button onClick={() => setShowChaosModal(false)} style={{ background: 'none', border: 'none', color: 'white', fontSize: 20, cursor: 'pointer', padding: 4 }}>✕</button>
                </Flex>
              </Flex>
            </div>

            {/* Tabs */}
            <div style={{ display: 'flex', borderBottom: `1px solid ${Colors.Border.Neutral.Default}`, background: 'rgba(181,137,0,0.04)' }}>
              {([
                { key: 'active', label: '🔥 Active Faults', badge: activeFaults.length },
                { key: 'inject', label: '💉 Inject' },
                { key: 'targeted', label: '🎯 Targeted', badge: Object.keys(targetedServices).length },
                { key: 'smart', label: '🤖 Smart Chaos' },
              ] as { key: typeof chaosTab; label: string; badge?: number }[]).map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setChaosTab(tab.key)}
                  style={{
                    flex: 1, padding: '10px 0', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: chaosTab === tab.key ? 700 : 500,
                    background: chaosTab === tab.key ? 'rgba(181,137,0,0.12)' : 'transparent',
                    borderBottom: chaosTab === tab.key ? '2px solid #b58900' : '2px solid transparent',
                    color: chaosTab === tab.key ? '#b58900' : 'inherit',
                    transition: 'all 0.15s ease',
                  }}
                >
                  {tab.label}
                  {tab.badge != null && tab.badge > 0 && (
                    <span style={{ marginLeft: 6, background: '#dc322f', color: 'white', borderRadius: 8, padding: '1px 6px', fontSize: 10, fontWeight: 700 }}>{tab.badge}</span>
                  )}
                </button>
              ))}
            </div>

            {/* Status bar */}
            {chaosStatus && (
              <div style={{ padding: '8px 24px', fontSize: 12, fontFamily: 'monospace',
                background: chaosStatus.includes('✅') ? 'rgba(115,190,40,0.1)' : chaosStatus.includes('❌') ? 'rgba(220,50,47,0.1)' : chaosStatus.includes('⚠️') ? 'rgba(181,137,0,0.1)' : 'rgba(0,161,201,0.08)',
                borderBottom: `1px solid ${Colors.Border.Neutral.Default}` }}>
                {chaosStatus}
              </div>
            )}

            <div style={{ padding: 24 }}>
              {isLoadingChaos ? (
                <Flex justifyContent="center" style={{ padding: 32 }}><span style={{ fontSize: 32 }}>⏳</span></Flex>
              ) : (
                <>
                  {/* ─── Tab 1: Active Faults ─── */}
                  {chaosTab === 'active' && (
                    <div>
                      {activeFaults.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: 40, opacity: 0.5 }}>
                          <div style={{ fontSize: 48, marginBottom: 12 }}>😇</div>
                          <Paragraph>No active faults. All services running clean.</Paragraph>
                        </div>
                      ) : (
                        <>
                          {activeFaults.map((fault: any, idx: number) => (
                            <div key={fault.id || idx} style={{ marginBottom: 12, border: `1px solid rgba(220,50,47,0.3)`, borderRadius: 10, overflow: 'hidden' }}>
                              <div style={{ padding: '10px 16px', background: 'rgba(220,50,47,0.06)' }}>
                                <Flex alignItems="center" justifyContent="space-between">
                                  <Flex alignItems="center" gap={8}>
                                    <span style={{ fontSize: 16 }}>🔥</span>
                                    <div>
                                      <Strong style={{ fontSize: 13 }}>{fault.type || 'unknown'}</Strong>
                                      {fault.target && <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.7 }}>→ {fault.target}</span>}
                                    </div>
                                  </Flex>
                                  <button
                                    onClick={() => revertFault(fault.id)}
                                    disabled={isRevertingChaos}
                                    style={{ background: 'rgba(115,190,40,0.12)', border: '1px solid rgba(115,190,40,0.4)', color: Colors.Theme.Success['70'], borderRadius: 6, padding: '4px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
                                  >
                                    {isRevertingChaos ? '⏳' : '↩️'} Revert
                                  </button>
                                </Flex>
                              </div>
                              <div style={{ padding: '8px 16px', display: 'flex', gap: 16, fontSize: 11, opacity: 0.7, fontFamily: 'monospace' }}>
                                {fault.intensity != null && <span>intensity: {fault.intensity}</span>}
                                {fault.durationMs != null && <span>duration: {Math.round(fault.durationMs / 1000)}s</span>}
                                {fault.injectedAt && <span>injected: {new Date(fault.injectedAt).toLocaleTimeString()}</span>}
                                {fault.status && <span>status: {fault.status}</span>}
                              </div>
                            </div>
                          ))}
                          <div style={{ marginTop: 16 }}>
                            <button
                              onClick={revertAllFaults}
                              disabled={isRevertingChaos}
                              style={{ width: '100%', padding: '10px 0', borderRadius: 8, border: '2px solid rgba(220,50,47,0.5)', background: 'rgba(220,50,47,0.08)', color: '#dc322f', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}
                            >
                              {isRevertingChaos ? '⏳ Reverting...' : '🚨 Revert All Faults (Panic)'}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {/* ─── Tab 2: Inject ─── */}
                  {chaosTab === 'inject' && (
                    <div>
                      {/* Target Service Dropdown */}
                      <div style={{ marginBottom: 16 }}>
                        <Strong style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>🔧 Target Service</Strong>
                        <select
                          value={injectForm.target}
                          onChange={e => setInjectForm(prev => ({ ...prev, target: e.target.value }))}
                          style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1px solid ${Colors.Border.Neutral.Default}`, background: Colors.Background.Surface.Default, color: 'inherit', fontSize: 13 }}
                        >
                          <option value="">— Select a service —</option>
                          {runningServices.map((s: any) => (
                            <option key={s.pid || s.service} value={s.baseServiceName || s.service}>{s.baseServiceName || s.service} ({s.companyName || 'unknown'})</option>
                          ))}
                        </select>
                      </div>

                      {/* Chaos Type */}
                      <div style={{ marginBottom: 16 }}>
                        <Strong style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>⚡ Chaos Type</Strong>
                        <select
                          value={injectForm.type}
                          onChange={e => setInjectForm(prev => ({ ...prev, type: e.target.value }))}
                          style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1px solid ${Colors.Border.Neutral.Default}`, background: Colors.Background.Surface.Default, color: 'inherit', fontSize: 13 }}
                        >
                          <option value="enable_errors">🔴 Enable Errors — Turn on error injection</option>
                          <option value="increase_error_rate">📈 Increase Error Rate — Raise error rate</option>
                          <option value="slow_responses">🐌 Slow Responses — Add latency</option>
                          <option value="disable_circuit_breaker">💥 Disable Circuit Breaker — Remove protection</option>
                          <option value="disable_cache">🗑️ Disable Cache — Increase load</option>
                          <option value="custom_flag">🏴 Custom Flag — Set any feature flag</option>
                        </select>
                      </div>

                      {/* Intensity */}
                      <div style={{ marginBottom: 16 }}>
                        <Flex justifyContent="space-between" alignItems="center" style={{ marginBottom: 6 }}>
                          <Strong style={{ fontSize: 12 }}>🔥 Intensity</Strong>
                          <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'monospace', color: injectForm.intensity >= 8 ? '#dc322f' : injectForm.intensity >= 5 ? '#b58900' : Colors.Theme.Success['70'] }}>
                            {injectForm.intensity}/10 ({injectForm.intensity * 10}%)
                          </span>
                        </Flex>
                        <input
                          type="range"
                          min={1} max={10} step={1}
                          value={injectForm.intensity}
                          onChange={e => setInjectForm(prev => ({ ...prev, intensity: Number(e.target.value) }))}
                          style={{ width: '100%', accentColor: '#b58900' }}
                        />
                        <Flex justifyContent="space-between" style={{ fontSize: 10, opacity: 0.5, marginTop: 2 }}>
                          <span>1 — Low</span><span>5 — Moderate</span><span>10 — Catastrophic</span>
                        </Flex>
                      </div>

                      {/* Duration */}
                      <div style={{ marginBottom: 20 }}>
                        <Strong style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>⏱️ Duration (seconds)</Strong>
                        <Flex gap={8} alignItems="center">
                          <input
                            type="number"
                            min={10} max={3600}
                            value={injectForm.duration}
                            onChange={e => setInjectForm(prev => ({ ...prev, duration: Number(e.target.value) }))}
                            style={{ width: 100, padding: '8px 12px', borderRadius: 8, border: `1px solid ${Colors.Border.Neutral.Default}`, background: Colors.Background.Surface.Default, color: 'inherit', fontSize: 13 }}
                          />
                          <Flex gap={4}>
                            {[30, 60, 120, 300].map(d => (
                              <button key={d} onClick={() => setInjectForm(prev => ({ ...prev, duration: d }))}
                                style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${injectForm.duration === d ? '#b58900' : Colors.Border.Neutral.Default}`, background: injectForm.duration === d ? 'rgba(181,137,0,0.15)' : 'transparent', color: injectForm.duration === d ? '#b58900' : 'inherit', cursor: 'pointer', fontSize: 11, fontWeight: injectForm.duration === d ? 700 : 400 }}
                              >{d < 60 ? `${d}s` : `${d / 60}m`}</button>
                            ))}
                          </Flex>
                        </Flex>
                      </div>

                      {/* Inject Button */}
                      <button
                        onClick={injectChaos}
                        disabled={isInjectingChaos || !injectForm.target}
                        style={{
                          width: '100%', padding: '12px 0', borderRadius: 10,
                          border: '2px solid rgba(181,137,0,0.6)',
                          background: !injectForm.target ? 'rgba(128,128,128,0.1)' : 'linear-gradient(135deg, rgba(181,137,0,0.15), rgba(220,50,47,0.1))',
                          color: !injectForm.target ? 'rgba(128,128,128,0.5)' : '#b58900',
                          fontWeight: 700, fontSize: 15, cursor: injectForm.target ? 'pointer' : 'not-allowed',
                          transition: 'all 0.2s ease',
                        }}
                      >
                        {isInjectingChaos ? '⏳ Injecting...' : '👹 Unleash Nemesis'}
                      </button>
                    </div>
                  )}

                  {/* ─── Tab 3: Targeted Services ─── */}
                  {chaosTab === 'targeted' && (
                    <div>
                      {Object.keys(targetedServices).length === 0 ? (
                        <div style={{ textAlign: 'center', padding: 40, opacity: 0.5 }}>
                          <div style={{ fontSize: 48, marginBottom: 12 }}>🎯</div>
                          <Paragraph>No per-service overrides active.</Paragraph>
                          <div style={{ fontSize: 12, marginTop: 8, opacity: 0.7 }}>When you inject faults targeting specific services, their overrides will appear here.</div>
                        </div>
                      ) : (
                        <>
                          {Object.entries(targetedServices).map(([serviceName, flags]: [string, any]) => (
                            <div key={serviceName} style={{ marginBottom: 12, border: `1px solid rgba(181,137,0,0.3)`, borderRadius: 10, overflow: 'hidden' }}>
                              <div style={{ padding: '10px 16px', background: 'rgba(181,137,0,0.06)' }}>
                                <Flex alignItems="center" justifyContent="space-between">
                                  <Flex alignItems="center" gap={8}>
                                    <span style={{ fontSize: 16 }}>🎯</span>
                                    <Strong style={{ fontSize: 13 }}>{serviceName}</Strong>
                                  </Flex>
                                  <button
                                    onClick={() => removeTargetedService(serviceName)}
                                    style={{ background: 'rgba(220,50,47,0.1)', border: '1px solid rgba(220,50,47,0.3)', color: '#dc322f', borderRadius: 6, padding: '4px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
                                  >
                                    🗑️ Remove
                                  </button>
                                </Flex>
                              </div>
                              <div style={{ padding: '8px 16px' }}>
                                {typeof flags === 'object' && flags !== null ? (
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                    {Object.entries(flags).map(([flag, value]: [string, any]) => (
                                      <span key={flag} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6, background: 'rgba(181,137,0,0.08)', border: '1px solid rgba(181,137,0,0.2)', fontFamily: 'monospace' }}>
                                        {flag}: <Strong>{String(value)}</Strong>
                                      </span>
                                    ))}
                                  </div>
                                ) : (
                                  <span style={{ fontSize: 12, opacity: 0.6, fontFamily: 'monospace' }}>{JSON.stringify(flags)}</span>
                                )}
                              </div>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  )}

                  {/* ─── Tab 4: Smart Chaos ─── */}
                  {chaosTab === 'smart' && (
                    <div>
                      <div style={{ textAlign: 'center', marginBottom: 20 }}>
                        <span style={{ fontSize: 40 }}>🤖</span>
                        <div style={{ fontSize: 14, marginTop: 8, opacity: 0.8 }}>Describe what you want to break in plain English.</div>
                        <div style={{ fontSize: 12, marginTop: 4, opacity: 0.5 }}>The AI agent will pick the right recipe, target, intensity, and duration.</div>
                      </div>

                      <div style={{ marginBottom: 16 }}>
                        <textarea
                          value={smartChaosGoal}
                          onChange={e => setSmartChaosGoal(e.target.value)}
                          placeholder="e.g. &quot;Cause high errors on the checkout service for 2 minutes&quot; or &quot;Slow down all services to test circuit breakers&quot;"
                          rows={3}
                          style={{ width: '100%', padding: '12px 14px', borderRadius: 10, border: `1px solid ${Colors.Border.Neutral.Default}`, background: Colors.Background.Surface.Default, color: 'inherit', fontSize: 13, resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' }}
                        />
                      </div>

                      <button
                        onClick={runSmartChaos}
                        disabled={isSmartChaosRunning || !smartChaosGoal.trim()}
                        style={{
                          width: '100%', padding: '12px 0', borderRadius: 10,
                          border: '2px solid rgba(0,161,201,0.5)',
                          background: !smartChaosGoal.trim() ? 'rgba(128,128,128,0.1)' : 'linear-gradient(135deg, rgba(0,161,201,0.15), rgba(108,44,156,0.1))',
                          color: !smartChaosGoal.trim() ? 'rgba(128,128,128,0.5)' : Colors.Theme.Primary['70'],
                          fontWeight: 700, fontSize: 15, cursor: smartChaosGoal.trim() ? 'pointer' : 'not-allowed',
                          transition: 'all 0.2s ease',
                        }}
                      >
                        {isSmartChaosRunning ? '⏳ AI is thinking...' : '🤖 Run Smart Chaos'}
                      </button>

                      {/* Example goals */}
                      <div style={{ marginTop: 20 }}>
                        <Strong style={{ fontSize: 11, display: 'block', marginBottom: 8, opacity: 0.5 }}>EXAMPLE GOALS</Strong>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {[
                            'Cause high errors on the payment service for 2 minutes',
                            'Slow down all services to test timeout handling',
                            'Disable circuit breakers to see error propagation',
                            'Target Acme Corp with intermittent errors',
                            'Run a moderate cache failure for 5 minutes',
                          ].map((example, idx) => (
                            <button
                              key={idx}
                              onClick={() => setSmartChaosGoal(example)}
                              style={{ textAlign: 'left', padding: '8px 12px', borderRadius: 8, border: `1px solid ${Colors.Border.Neutral.Default}`, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12, opacity: 0.7, transition: 'all 0.15s ease' }}
                              onMouseOver={e => { e.currentTarget.style.background = 'rgba(0,161,201,0.08)'; e.currentTarget.style.opacity = '1'; }}
                              onMouseOut={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.opacity = '0.7'; }}
                            >
                              💡 {example}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}



      {/* ── Generate Visuals Modal (Dashboard + Executive Summary) ─────────────────── */}
      {showGenerateDashboardModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)' }} onClick={() => setShowGenerateDashboardModal(false)} />
          <div style={{ position: 'relative', width: 580, maxHeight: '85vh', overflow: 'auto', background: Colors.Background.Surface.Default, borderRadius: 16, border: `2px solid ${Colors.Theme.Primary['70']}`, boxShadow: '0 24px 48px rgba(0,0,0,0.3)' }}>
            {/* Header */}
            <div style={{ padding: '16px 24px', background: 'linear-gradient(135deg, #00a1c9, #00d4ff)', borderRadius: '14px 14px 0 0' }}>
              <Flex alignItems="center" justifyContent="space-between">
                <Flex alignItems="center" gap={12}>
                  <span style={{ fontSize: 24 }}>🎨</span>
                  <div>
                    <Strong style={{ color: 'white', fontSize: 16 }}>Generate Visuals</Strong>
                    <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>Executive Summary Documents</div>
                  </div>
                </Flex>
                <button onClick={() => setShowGenerateDashboardModal(false)} style={{ background: 'none', border: 'none', color: 'white', fontSize: 20, cursor: 'pointer', padding: 4 }}>✕</button>
              </Flex>
            </div>

            {/* Sub-tab Selector — only Executive Summary visible */}

            {/* Content */}
            <div style={{ padding: 24 }}>

              {/* ===== Dashboard Sub-Tab (hidden) ===== */}
              {false && visualsSubTab === 'dashboard' && (
                <>
                  {/* Status Message */}
                  {dashboardGenerationStatus && (
                    <div style={{ padding: 12, marginBottom: 16, borderRadius: 8, fontSize: 13, fontFamily: 'monospace',
                      background: dashboardGenerationStatus.includes('✅') ? 'rgba(115,190,40,0.12)' : dashboardGenerationStatus.includes('❌') ? 'rgba(220,50,47,0.12)' : 'rgba(0,161,201,0.12)',
                      border: `1px solid ${dashboardGenerationStatus.includes('✅') ? Colors.Theme.Success['70'] : dashboardGenerationStatus.includes('❌') ? '#dc322f' : Colors.Theme.Primary['70']}` }}>
                      {dashboardGenerationStatus}
                      {dashboardUrl && dashboardGenerationStatus.includes('✅') && (
                        <div style={{ marginTop: 8 }}>
                          <a
                            href={dashboardUrl ?? undefined}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: '#00a1c9', fontWeight: 700, textDecoration: 'none', fontSize: 14 }}
                          >
                            📊 Open Dashboard in Dynatrace →
                          </a>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Company Selector */}
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 8, color: Colors.Theme.Primary['70'] }}>🏢 Company</label>
                    {isLoadingDashboardData ? (
                      <div style={{ padding: 12, textAlign: 'center', opacity: 0.6 }}>⏳ Loading companies...</div>
                    ) : availableCompanies.length === 0 ? (
                      <div style={{ padding: 12, textAlign: 'center', opacity: 0.6, fontSize: 12 }}>No companies found. Deploy services first.</div>
                    ) : (
                      <select
                        value={dashboardCompanyName}
                        onChange={(e) => { setDashboardCompanyName(e.target.value); setDashboardJourneyType(''); }}
                        style={{
                          width: '100%', padding: '10px 14px', borderRadius: 8,
                          border: `1px solid ${Colors.Border.Neutral.Default}`,
                          background: Colors.Background.Surface.Default,
                          color: 'inherit', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
                        }}
                      >
                        <option value="">-- Select a company --</option>
                        {availableCompanies.map(company => (
                          <option key={company} value={company}>{company}</option>
                        ))}
                      </select>
                    )}
                  </div>

                  {/* Journey Type Selector */}
                  <div style={{ marginBottom: 20 }}>
                    <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 8, color: Colors.Theme.Primary['70'] }}>🗺️ Journey Type</label>
                    {isLoadingDashboardData ? (
                      <div style={{ padding: 12, textAlign: 'center', opacity: 0.6 }}>⏳ Loading journeys...</div>
                    ) : !dashboardCompanyName ? (
                      <div style={{ padding: 12, textAlign: 'center', opacity: 0.6, fontSize: 12 }}>Select a company first.</div>
                    ) : (() => {
                      const filtered = Array.from(new Set(runningServices.filter(s => s.companyName === dashboardCompanyName).map(s => s.journeyType).filter(Boolean))).sort();
                      return filtered.length === 0 ? (
                        <div style={{ padding: 12, textAlign: 'center', opacity: 0.6, fontSize: 12 }}>No journey types found for {dashboardCompanyName}.</div>
                      ) : (
                        <select
                          value={dashboardJourneyType}
                          onChange={(e) => setDashboardJourneyType(e.target.value)}
                          style={{
                            width: '100%', padding: '10px 14px', borderRadius: 8,
                            border: `1px solid ${Colors.Border.Neutral.Default}`,
                            background: Colors.Background.Surface.Default,
                            color: 'inherit', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
                          }}
                        >
                          <option value="">-- Select a journey type --</option>
                          {filtered.map(journey => (
                            <option key={journey} value={journey}>{journey}</option>
                          ))}
                        </select>
                      );
                    })()}
                  </div>

                  {/* MCP Dashboard Prompt — Preset Dropdown + Free Text */}
                  <div style={{ marginBottom: 20 }}>
                    <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 8, color: '#6c2c9c' }}>
                      🧠 Dashboard Focus <span style={{ fontWeight: 400, opacity: 0.6 }}>(select a preset or write your own — each produces a distinct dashboard)</span>
                    </label>

                    {/* Preset Prompt Dropdown */}
                    <select
                      value={mcpDashboardPrompt}
                      onChange={(e) => setMcpDashboardPrompt(e.target.value)}
                      style={{
                        width: '100%', padding: '10px 14px', borderRadius: 8, marginBottom: 10,
                        border: `1px solid ${mcpDashboardPrompt ? '#6c2c9c' : Colors.Border.Neutral.Default}`,
                        background: Colors.Background.Surface.Default,
                        color: 'inherit', fontSize: 13, fontFamily: 'inherit', cursor: 'pointer',
                      }}
                    >
                      <option value="">— Select a dashboard preset (or type your own below) —</option>
                      <optgroup label="📊 Executive & Leadership">
                        <option value="Create a C-level executive dashboard focused on revenue impact, customer lifetime value, churn risk, and strategic business KPIs. Use singleValue tiles for headline metrics, donut charts for distribution breakdowns, and area charts showing revenue trends over time. Minimal technical detail — this is for the boardroom.">
                          C-Level Executive — Revenue & Strategic KPIs
                        </option>
                        <option value="Build a CFO financial operations dashboard highlighting total revenue, average order value, revenue by journey step, payment method breakdown, and pricing analysis. Include SLA compliance rates and error-driven revenue loss estimates. Use tables and single-value tiles.">
                          CFO Financial Operations — Revenue & Pricing
                        </option>
                        <option value="Create a board-ready business health dashboard with a high-level journey funnel overview, success rate trends, total event volume, and customer satisfaction scores. Use clean singleValue KPIs and area charts. No infrastructure metrics — purely business outcomes.">
                          Board Summary — Business Health Overview
                        </option>
                      </optgroup>
                      <optgroup label="👥 Customer Experience">
                        <option value="Build a customer experience deep-dive dashboard analyzing churn risk, NPS and satisfaction scores, loyalty tier or status distribution, and customer lifetime value. Include segment analysis, device type breakdown, and channel attribution. Use a mix of bar charts, donut charts, and tables. Use whichever field names actually exist in the data.">
                          Customer 360 — Churn, NPS & Loyalty Deep Dive
                        </option>
                        <option value="Create a customer journey funnel dashboard showing step-by-step conversion rates, drop-off analysis by step name, error rate per step, and average processing time. Highlight which steps lose the most customers. Use a table for step metrics and area charts for time trends.">
                          Journey Funnel — Conversion & Drop-off Analysis
                        </option>
                        <option value="Build a customer segmentation dashboard breaking down events by loyalty tier or status, customer segment, device type, browser, and acquisition channel. Show revenue per segment and conversion rates per channel using bar charts and donut charts. Use whichever field names actually exist in the data.">
                          Customer Segmentation — Tiers, Channels & Devices
                        </option>
                      </optgroup>
                      <optgroup label="⚙️ Operations & SRE">
                        <option value="Create an SRE reliability dashboard with all four golden signals: traffic (request count), latency (response time with P50/P90/P99), errors (failure count and error flags), and saturation (CPU/memory). Include error message breakdown, step-level error rates, and SLA compliance. Use line charts for time series and tables for details.">
                          SRE Golden Signals — Traffic, Latency, Errors, Saturation
                        </option>
                        <option value="Build an operations error analysis dashboard focused on error rate trends over time, errors by journey step, top error messages, error details table, and service failure counts. Include a heatmap of errors by step and hour. Use line charts, tables, and a heatmap.">
                          Ops Error Analysis — Error Trends & Root Cause
                        </option>
                        <option value="Create a performance and SLA monitoring dashboard showing P90 response times, SLA compliance rates by step, step performance table with success rates, hourly activity patterns, and service-level latency trends. Use line charts for latency, tables for SLA, and a pie chart for hourly patterns.">
                          Performance & SLA — Latency, Compliance & Patterns
                        </option>
                      </optgroup>
                      <optgroup label="📈 Analytics & Trends">
                        <option value="Build a trend analysis and forecasting dashboard with hourly activity patterns, volume histograms by step, event volume distribution, step-by-hour heatmap, weekly trend comparison, and geographic or regional distribution. Use heatmaps, pie charts, and area charts for time-series patterns.">
                          Trend Analysis — Patterns, Heatmaps & Forecasting
                        </option>
                        <option value="Create a comprehensive full-stack dashboard including ALL available sections: executive KPIs, journey funnel overview, filtered step drill-downs, performance SLA, error analysis, all four golden signals (traffic, latency, errors, saturation), traces and observability, customer dynamic metrics, geographic view, and trend analysis. This is the complete picture.">
                          Full Comprehensive — All Sections Combined
                        </option>
                        <option value="Build a product and subscription analytics dashboard showing product or plan selection breakdown, pricing analysis, subscription or membership types, conversion probability distribution, and revenue by product. Use bar charts for comparisons and tables for detail. Use whichever field names actually exist in the data.">
                          Product Analytics — Plans, Subscriptions & Conversions
                        </option>
                      </optgroup>
                    </select>

                    {/* Free-text Custom Prompt */}
                    <textarea
                      value={mcpDashboardPrompt}
                      onChange={(e) => setMcpDashboardPrompt(e.target.value)}
                      placeholder="Or type a custom prompt: e.g. &quot;Show me churn risk vs revenue by customer segment, with error hotspots per journey step&quot;"
                      style={{
                        width: '100%', minHeight: 72, padding: '10px 14px', borderRadius: 8,
                        border: `1px solid ${mcpDashboardPrompt ? '#6c2c9c' : Colors.Border.Neutral.Default}`,
                        background: mcpDashboardPrompt ? 'rgba(108,44,156,0.04)' : Colors.Background.Surface.Default,
                        color: 'inherit', fontSize: 13, fontFamily: 'inherit', resize: 'vertical',
                        transition: 'border-color 0.2s, background 0.2s',
                      }}
                    />
                    {mcpDashboardPrompt && (
                      <div style={{ fontSize: 11, marginTop: 4, color: '#6c2c9c', opacity: 0.8 }}>
                        🎯 AI will use knowledge of bizevents fields (additionalfields.*, json.*, golden signals) to build a tailored dashboard
                      </div>
                    )}
                    {mcpDashboardPrompt && (
                      <button
                        onClick={() => setMcpDashboardPrompt('')}
                        style={{ marginTop: 6, padding: '4px 12px', fontSize: 11, borderRadius: 6, border: '1px solid #ccc', background: 'transparent', color: 'inherit', cursor: 'pointer' }}
                      >✕ Clear prompt</button>
                    )}
                  </div>

                  {/* Generate & Deploy Button */}
                  <Flex gap={8}>
                    <Button
                      onClick={generateAndDeployDashboard}
                      disabled={isGeneratingDashboard || isLoadingDashboardData || !dashboardCompanyName || !dashboardJourneyType}
                      variant="emphasized"
                      style={{ flex: 1, fontWeight: 700 }}
                    >
                      {isGeneratingDashboard ? '⏳ Deploying...' : mcpDashboardPrompt ? '🧠 Ask MCP & Deploy' : '🚀 Generate & Deploy'}
                    </Button>
                    <Button onClick={() => setShowGenerateDashboardModal(false)} style={{ flex: 1 }}>Cancel</Button>
                  </Flex>

                  {/* Info Box */}
                  <div style={{ marginTop: 16, padding: 12, borderRadius: 8, background: 'rgba(0,161,201,0.08)', border: `1px solid ${Colors.Theme.Primary['70']}`, fontSize: 12, lineHeight: 1.6 }}>
                    <Strong style={{ color: Colors.Theme.Primary['70'], display: 'block', marginBottom: 8 }}>✨ How it works</Strong>
                    <ul style={{ margin: 0, paddingLeft: 20 }}>
                      <li><strong>Preset prompts</strong> are tuned to produce distinct dashboards — each targets a different audience and data focus</li>
                      <li>AI knows the full bizevents field schema: <code>additionalfields.*</code>, <code>json.*</code>, golden signals, and DQL query patterns</li>
                      <li>Each prompt generates a <strong>unique dashboard ID</strong> — different prompts won't overwrite each other</li>
                      <li>Free-text prompts can reference specific fields like <code>additionalfields.churnRisk</code>, <code>additionalfields.orderTotal</code></li>
                      <li>Dashboard is deployed directly to Dynatrace — click the link to open it</li>
                    </ul>
                  </div>
                </>
              )}

              {/* ===== Saved Dashboards Sub-Tab (hidden) ===== */}
              {false && visualsSubTab === 'saved' && (
                <>
                  {isLoadingSavedDashboards ? (
                    <div style={{ padding: 24, textAlign: 'center', opacity: 0.6 }}>⏳ Loading saved dashboards...</div>
                  ) : savedDashboards.length === 0 ? (
                    <div style={{ padding: 24, textAlign: 'center', opacity: 0.6, fontSize: 13 }}>
                      No saved dashboards yet. Generate a dashboard first — it will auto-save here.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 4 }}>
                        {savedDashboards.length} dashboard{savedDashboards.length !== 1 ? 's' : ''} saved on host
                      </div>
                      {savedDashboards.map((item: any) => (
                        <div
                          key={item.id}
                          style={{
                            padding: '12px 16px', borderRadius: 10,
                            border: `1px solid ${Colors.Border.Neutral.Default}`,
                            background: 'rgba(0,161,201,0.04)',
                            transition: 'border-color 0.2s',
                          }}
                        >
                          <Flex justifyContent="space-between" alignItems="center">
                            <div style={{ flex: 1 }}>
                              <Strong style={{ fontSize: 13 }}>{item.dashboardName || item.id}</Strong>
                              <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>
                                {item.tileCount} tiles · {item.generationMethod} · {item.savedAt ? new Date(item.savedAt).toLocaleString() : '—'}
                              </div>
                            </div>
                            <Flex gap={6}>
                              <button
                                onClick={() => deploySavedDashboard(item)}
                                title="Deploy to Dynatrace"
                                style={{
                                  padding: '6px 12px', borderRadius: 6, border: '1px solid #00a1c9',
                                  background: 'rgba(0,161,201,0.1)', color: '#00a1c9',
                                  fontSize: 12, fontWeight: 600, cursor: 'pointer',
                                }}
                              >
                                🚀 Deploy
                              </button>
                              <button
                                onClick={() => deleteSavedDashboard(item.id)}
                                title="Delete from host"
                                style={{
                                  padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(220,50,47,0.3)',
                                  background: 'rgba(220,50,47,0.08)', color: '#dc322f',
                                  fontSize: 12, cursor: 'pointer',
                                }}
                              >
                                🗑️
                              </button>
                            </Flex>
                          </Flex>
                        </div>
                      ))}
                      <div style={{ marginTop: 8, padding: 10, borderRadius: 8, background: 'rgba(115,190,40,0.08)', border: '1px solid rgba(115,190,40,0.3)', fontSize: 11, lineHeight: 1.5 }}>
                        💾 Dashboards are auto-saved to the EC2 host after every generation. Deploy any saved dashboard to your Dynatrace tenant in one click.
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* ===== Executive Summary Document Sub-Tab ===== */}
              {visualsSubTab === 'pdf' && (
                <>
                  {/* Doc Status Message */}
                  {pdfStatus && (
                    <div style={{ padding: 12, marginBottom: 16, borderRadius: 8, fontSize: 13, fontFamily: 'monospace',
                      background: pdfStatus.includes('✅') ? 'rgba(115,190,40,0.12)' : pdfStatus.includes('❌') ? 'rgba(220,50,47,0.12)' : 'rgba(108,44,156,0.12)',
                      border: `1px solid ${pdfStatus.includes('✅') ? Colors.Theme.Success['70'] : pdfStatus.includes('❌') ? '#dc322f' : '#6c2c9c'}` }}>
                      {pdfStatus}
                    </div>
                  )}

                  <div style={{ marginBottom: 20, padding: 16, borderRadius: 10, background: 'rgba(108,44,156,0.06)', border: '1px solid rgba(108,44,156,0.2)' }}>
                    <Heading level={5} style={{ marginBottom: 8, color: '#6c2c9c' }}>📄 Executive Summary Document</Heading>
                    <Paragraph style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 12 }}>
                      Generate a professional executive summary as a clean HTML document you can open in Word or Google Docs:
                    </Paragraph>
                    <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12, lineHeight: 2 }}>
                      <li><Strong>Executive Overview</Strong> — Company, industry challenges, journey scope</li>
                      <li><Strong>Step-by-Step Intelligence</Strong> — Business rationale, substeps, observability mapping</li>
                      <li><Strong>Why Dynatrace</Strong> — Platform capabilities aligned to this journey</li>
                      <li><Strong>Value Alignment</Strong> — Objectives and use cases for the account</li>
                      <li><Strong>Projected Outcomes &amp; Next Steps</Strong> — MTTR, visibility, implementation phases</li>
                    </ul>
                    <Paragraph style={{ fontSize: 11, color: '#888', marginTop: 8 }}>
                      💡 Tip: Open the downloaded .html file directly in Microsoft Word or Google Docs, then save as .docx
                    </Paragraph>
                  </div>

                  {/* Company Selector */}
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 8, color: '#6c2c9c' }}>🏢 Company</label>
                    {isLoadingDashboardData ? (
                      <div style={{ padding: 12, textAlign: 'center', opacity: 0.6 }}>⏳ Loading companies...</div>
                    ) : availableCompanies.length === 0 ? (
                      <div style={{ padding: 12, textAlign: 'center', opacity: 0.6, fontSize: 12 }}>No companies found. Deploy services first.</div>
                    ) : (
                      <select
                        value={dashboardCompanyName}
                        onChange={(e) => { setDashboardCompanyName(e.target.value); setDashboardJourneyType(''); }}
                        style={{
                          width: '100%', padding: '10px 14px', borderRadius: 8,
                          border: `1px solid ${Colors.Border.Neutral.Default}`,
                          background: Colors.Background.Surface.Default,
                          color: 'inherit', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
                        }}
                      >
                        <option value="">-- Select a company --</option>
                        {availableCompanies.map(company => (
                          <option key={company} value={company}>{company}</option>
                        ))}
                      </select>
                    )}
                  </div>

                  {/* Journey Type Selector */}
                  <div style={{ marginBottom: 20 }}>
                    <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 8, color: '#6c2c9c' }}>🗺️ Journey Type</label>
                    {isLoadingDashboardData ? (
                      <div style={{ padding: 12, textAlign: 'center', opacity: 0.6 }}>⏳ Loading journeys...</div>
                    ) : !dashboardCompanyName ? (
                      <div style={{ padding: 12, textAlign: 'center', opacity: 0.6, fontSize: 12 }}>Select a company first.</div>
                    ) : (() => {
                      const filtered = Array.from(new Set(runningServices.filter(s => s.companyName === dashboardCompanyName).map(s => s.journeyType).filter(Boolean))).sort();
                      return filtered.length === 0 ? (
                        <div style={{ padding: 12, textAlign: 'center', opacity: 0.6, fontSize: 12 }}>No journey types found for {dashboardCompanyName}.</div>
                      ) : (
                        <select
                          value={dashboardJourneyType}
                          onChange={(e) => setDashboardJourneyType(e.target.value)}
                          style={{
                            width: '100%', padding: '10px 14px', borderRadius: 8,
                            border: `1px solid ${Colors.Border.Neutral.Default}`,
                            background: Colors.Background.Surface.Default,
                            color: 'inherit', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
                          }}
                        >
                          <option value="">-- Select a journey type --</option>
                          {filtered.map(journey => (
                            <option key={journey} value={journey}>{journey}</option>
                          ))}
                        </select>
                      );
                    })()}
                  </div>

                  {/* Generate Document Button */}
                  <Flex gap={8}>
                    <Button
                      onClick={async () => {
                        if (!dashboardCompanyName || !dashboardJourneyType) {
                          setPdfStatus('⚠️ Please select both company and journey type');
                          return;
                        }
                        setIsGeneratingPdf(true);
                        setPdfStatus('🚀 Generating executive summary document...');
                        try {
                          const result = await callProxyWithRetry({
                              action: 'generate-doc',
                              apiHost: apiSettings.host,
                              apiPort: apiSettings.port,
                              apiProtocol: apiSettings.protocol,
                              body: {
                                journeyData: {
                                  companyName: dashboardCompanyName,
                                  industryType: runningServices.find(s => s.companyName === dashboardCompanyName)?.industryType || 'Enterprise',
                                  journeyType: dashboardJourneyType,
                                  steps: runningServices
                                    .filter(s => s.companyName === dashboardCompanyName)
                                    .map(s => ({ stepName: s.stepName || s.service, name: s.service })),
                                },
                                dashboardData: generatedDashboardJson || {},
                              },
                          }, 5, 2000, setPdfStatus) as any;
                          if (result.success && result.data?.html) {
                            const blob = new Blob([result.data.html], { type: 'text/html; charset=utf-8' });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = result.data.filename || `${dashboardCompanyName}-Executive-Summary.html`;
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            URL.revokeObjectURL(url);
                            setPdfStatus(`✅ Downloaded ${result.data.filename} (${result.data.sizeKb}KB)`);
                            showToast(`📄 Executive Summary downloaded!`, 'success', 6000);
                          } else {
                            throw new Error(result.error || 'Document generation failed');
                          }
                        } catch (err: any) {
                          console.error('[Doc] ❌', err);
                          setPdfStatus(`❌ ${err.message}`);
                          showToast(`❌ Document generation failed: ${err.message}`, 'error', 5000);
                        } finally {
                          setIsGeneratingPdf(false);
                        }
                      }}
                      disabled={isGeneratingPdf || isLoadingDashboardData || !dashboardCompanyName || !dashboardJourneyType}
                      variant="emphasized"
                      style={{ flex: 1, fontWeight: 700 }}
                    >
                      {isGeneratingPdf ? '⏳ Generating Document...' : '📄 Download Executive Summary'}
                    </Button>
                    <Button onClick={() => setShowGenerateDashboardModal(false)} style={{ flex: 1 }}>Cancel</Button>
                  </Flex>
                </>
              )}

            </div>
          </div>
        </div>
      )}



      {/* ── Get Started Checklist Modal ─────────────────── */}
      {showGetStartedModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)' }} onClick={() => setShowGetStartedModal(false)} />
          <div style={{ position: 'relative', width: 640, maxHeight: '85vh', overflow: 'auto', background: Colors.Background.Surface.Default, borderRadius: 16, border: '2px solid rgba(108,44,156,0.5)', boxShadow: '0 24px 48px rgba(0,0,0,0.3)' }}>
            {/* Header */}
            <div style={{ padding: '16px 24px', background: 'linear-gradient(135deg, #6c2c9c, #00a1c9)', borderRadius: '14px 14px 0 0' }}>
              <Flex alignItems="center" justifyContent="space-between">
                <Flex alignItems="center" gap={12}>
                  <span style={{ fontSize: 24 }}>🚀</span>
                  <div>
                    <Strong style={{ color: 'white', fontSize: 16 }}>Get Started</Strong>
                    <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>{completedCount}/{totalSteps} steps completed</div>
                  </div>
                </Flex>
                <Flex alignItems="center" gap={8}>
                  {/* Progress bar */}
                  <div style={{ width: 120, height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.2)', overflow: 'hidden' }}>
                    <div style={{ width: `${(completedCount / totalSteps) * 100}%`, height: '100%', borderRadius: 4, background: completedCount === totalSteps ? '#73be28' : 'white', transition: 'width 0.3s ease' }} />
                  </div>
                  <button onClick={() => detectBuiltinSettings(true)} disabled={isDetecting} style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)', color: 'white', fontSize: 11, fontWeight: 600, cursor: isDetecting ? 'wait' : 'pointer', padding: '3px 10px', borderRadius: 6, opacity: isDetecting ? 0.5 : 1, transition: 'all 0.2s' }}>{isDetecting ? '⏳ Checking...' : '🔄 Refresh'}</button>
                  <button onClick={() => setShowGetStartedModal(false)} style={{ background: 'none', border: 'none', color: 'white', fontSize: 20, cursor: 'pointer', padding: 4 }}>✕</button>
                </Flex>
              </Flex>
            </div>

            <div style={{ padding: 24 }}>
              {/* ── Section: Server Setup ── */}
              <div style={{ marginBottom: 20 }}>
                <Flex alignItems="center" gap={6} style={{ marginBottom: 10 }}>
                  <span style={{ fontSize: 14 }}>🖥️</span>
                  <Strong style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.6 }}>Server Setup</Strong>
                </Flex>

                {/* Step: Configure Server IP */}
                <div onClick={() => toggleCheck('server-ip')} style={{ padding: '12px 14px', borderRadius: 10, border: `1px solid ${checklist['server-ip'] ? 'rgba(0,180,0,0.3)' : Colors.Border.Neutral.Default}`, background: checklist['server-ip'] ? 'rgba(0,180,0,0.04)' : 'transparent', cursor: 'pointer', marginBottom: 8, transition: 'all 0.2s' }}>
                  <Flex alignItems="center" gap={12}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, border: `2px solid ${isStepComplete('server-ip') ? '#2e7d32' : Colors.Border.Neutral.Default}`, background: isStepComplete('server-ip') ? '#2e7d32' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s' }}>
                      {isStepComplete('server-ip') && <span style={{ color: 'white', fontSize: 14, fontWeight: 700 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <Strong style={{ fontSize: 13, textDecoration: isStepComplete('server-ip') ? 'line-through' : 'none', opacity: isStepComplete('server-ip') ? 0.6 : 1 }}>Configure Server IP & Port</Strong>
                      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Set your BizObs Demonstrator server host and port in Settings → Config tab</div>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); openSettingsModal(); setShowGetStartedModal(false); }} style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${Colors.Theme.Primary['70']}`, background: 'rgba(108,44,156,0.08)', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: Colors.Theme.Primary['70'] }}>⚙️ Settings</button>
                  </Flex>
                </div>
              </div>

              {/* ── Section: Network / EdgeConnect ── */}
              <div style={{ marginBottom: 20 }}>
                <Flex alignItems="center" gap={6} style={{ marginBottom: 10 }}>
                  <span style={{ fontSize: 14 }}>🔌</span>
                  <Strong style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.6 }}>Network — EdgeConnect</Strong>
                </Flex>

                {/* Step: Create EdgeConnect */}
                <div onClick={() => toggleCheck('edgeconnect-create')} style={{ padding: '12px 14px', borderRadius: 10, border: `1px solid ${checklist['edgeconnect-create'] ? 'rgba(0,180,0,0.3)' : Colors.Border.Neutral.Default}`, background: checklist['edgeconnect-create'] ? 'rgba(0,180,0,0.04)' : 'transparent', cursor: 'pointer', marginBottom: 8, transition: 'all 0.2s' }}>
                  <Flex alignItems="center" gap={12}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, border: `2px solid ${isStepComplete('edgeconnect-create') ? '#2e7d32' : Colors.Border.Neutral.Default}`, background: isStepComplete('edgeconnect-create') ? '#2e7d32' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s' }}>
                      {isStepComplete('edgeconnect-create') && <span style={{ color: 'white', fontSize: 14, fontWeight: 700 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <Strong style={{ fontSize: 13, textDecoration: isStepComplete('edgeconnect-create') ? 'line-through' : 'none', opacity: isStepComplete('edgeconnect-create') ? 0.6 : 1 }}>Create EdgeConnect in Dynatrace</Strong>
                      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Open Dynatrace Settings → External Requests → EdgeConnect → New EdgeConnect</div>
                    </div>
                    <a href={`${TENANT_URL}/ui/apps/dynatrace.settings/settings/external-requests/?tab=edge-connect`} target="_blank" rel="noopener noreferrer" style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(65,105,225,0.3)', background: 'rgba(65,105,225,0.06)', fontSize: 11, fontWeight: 600, color: '#4169e1', textDecoration: 'none' }}>🔌 Open →</a>
                  </Flex>
                </div>

                {/* Step: Deploy EdgeConnect */}
                <div onClick={() => toggleCheck('edgeconnect-deploy')} style={{ padding: '12px 14px', borderRadius: 10, border: `1px solid ${checklist['edgeconnect-deploy'] ? 'rgba(0,180,0,0.3)' : Colors.Border.Neutral.Default}`, background: checklist['edgeconnect-deploy'] ? 'rgba(0,180,0,0.04)' : 'transparent', cursor: 'pointer', marginBottom: 8, transition: 'all 0.2s' }}>
                  <Flex alignItems="center" gap={12}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, border: `2px solid ${isStepComplete('edgeconnect-deploy') ? '#2e7d32' : Colors.Border.Neutral.Default}`, background: isStepComplete('edgeconnect-deploy') ? '#2e7d32' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s' }}>
                      {isStepComplete('edgeconnect-deploy') && <span style={{ color: 'white', fontSize: 14, fontWeight: 700 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <Strong style={{ fontSize: 13, textDecoration: isStepComplete('edgeconnect-deploy') ? 'line-through' : 'none', opacity: isStepComplete('edgeconnect-deploy') ? 0.6 : 1 }}>Deploy EdgeConnect on Server</Strong>
                      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Enter credentials in Settings → EdgeConnect tab, copy YAML, run <code style={{ fontSize: 10, background: 'rgba(0,0,0,0.06)', padding: '1px 4px', borderRadius: 3 }}>./run-edgeconnect.sh</code> on server</div>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); setSettingsTab('edgeconnect'); openSettingsModal(); setShowGetStartedModal(false); }} style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${Colors.Theme.Primary['70']}`, background: 'rgba(108,44,156,0.08)', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: Colors.Theme.Primary['70'] }}>⚙️ Setup</button>
                  </Flex>
                </div>

                {/* Step: Verify EdgeConnect Online */}
                <div onClick={() => toggleCheck('edgeconnect-online')} style={{ padding: '12px 14px', borderRadius: 10, border: `1px solid ${checklist['edgeconnect-online'] ? 'rgba(0,180,0,0.3)' : Colors.Border.Neutral.Default}`, background: checklist['edgeconnect-online'] ? 'rgba(0,180,0,0.04)' : 'transparent', cursor: 'pointer', marginBottom: 8, transition: 'all 0.2s' }}>
                  <Flex alignItems="center" gap={12}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, border: `2px solid ${isStepComplete('edgeconnect-online') ? '#2e7d32' : Colors.Border.Neutral.Default}`, background: isStepComplete('edgeconnect-online') ? '#2e7d32' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s' }}>
                      {isStepComplete('edgeconnect-online') && <span style={{ color: 'white', fontSize: 14, fontWeight: 700 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <Strong style={{ fontSize: 13, textDecoration: isStepComplete('edgeconnect-online') ? 'line-through' : 'none', opacity: isStepComplete('edgeconnect-online') ? 0.6 : 1 }}>Verify EdgeConnect is Online</Strong>
                      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Settings → EdgeConnect tab → Check Connection — status should show ONLINE</div>
                    </div>
                  </Flex>
                </div>
              </div>

              {/* ── Section: Monitoring ── */}
              <div style={{ marginBottom: 20 }}>
                <Flex alignItems="center" gap={6} style={{ marginBottom: 10 }}>
                  <span style={{ fontSize: 14 }}>📡</span>
                  <Strong style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.6 }}>Monitoring</Strong>
                </Flex>

                {/* Step: OneAgent */}
                <div onClick={() => toggleCheck('oneagent')} style={{ padding: '12px 14px', borderRadius: 10, border: `1px solid ${checklist['oneagent'] ? 'rgba(0,180,0,0.3)' : Colors.Border.Neutral.Default}`, background: checklist['oneagent'] ? 'rgba(0,180,0,0.04)' : 'transparent', cursor: 'pointer', marginBottom: 8, transition: 'all 0.2s' }}>
                  <Flex alignItems="center" gap={12}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, border: `2px solid ${isStepComplete('oneagent') ? '#2e7d32' : Colors.Border.Neutral.Default}`, background: isStepComplete('oneagent') ? '#2e7d32' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s' }}>
                      {isStepComplete('oneagent') && <span style={{ color: 'white', fontSize: 14, fontWeight: 700 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <Strong style={{ fontSize: 13, textDecoration: isStepComplete('oneagent') ? 'line-through' : 'none', opacity: isStepComplete('oneagent') ? 0.6 : 1 }}>OneAgent Installed on Host</Strong>
                      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Ensure Dynatrace OneAgent is running on the BizObs server to monitor generated services</div>
                    </div>
                    <a href={`${TENANT_URL}/ui/apps/dynatrace.discovery.coverage/install/oneagent`} target="_blank" rel="noopener noreferrer" style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(65,105,225,0.3)', background: 'rgba(65,105,225,0.06)', fontSize: 11, fontWeight: 600, color: '#4169e1', textDecoration: 'none' }}>📥 Deploy →</a>
                  </Flex>
                </div>
              </div>

              {/* ── Section: Verify ── */}
              <div style={{ marginBottom: 20 }}>
                <Flex alignItems="center" gap={6} style={{ marginBottom: 10 }}>
                  <span style={{ fontSize: 14 }}>✅</span>
                  <Strong style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.6 }}>Verify</Strong>
                </Flex>

                {/* Step: Test Connection */}
                <div onClick={() => toggleCheck('test-connection')} style={{ padding: '12px 14px', borderRadius: 10, border: `1px solid ${checklist['test-connection'] ? 'rgba(0,180,0,0.3)' : Colors.Border.Neutral.Default}`, background: checklist['test-connection'] ? 'rgba(0,180,0,0.04)' : 'transparent', cursor: 'pointer', marginBottom: 8, transition: 'all 0.2s' }}>
                  <Flex alignItems="center" gap={12}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, border: `2px solid ${isStepComplete('test-connection') ? '#2e7d32' : Colors.Border.Neutral.Default}`, background: isStepComplete('test-connection') ? '#2e7d32' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s' }}>
                      {isStepComplete('test-connection') && <span style={{ color: 'white', fontSize: 14, fontWeight: 700 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <Strong style={{ fontSize: 13, textDecoration: isStepComplete('test-connection') ? 'line-through' : 'none', opacity: isStepComplete('test-connection') ? 0.6 : 1 }}>Test Connection from App</Strong>
                      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Settings → Config → click Test to verify the app can reach your server through EdgeConnect</div>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); setSettingsTab('config'); openSettingsModal(); setShowGetStartedModal(false); }} style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${Colors.Theme.Primary['70']}`, background: 'rgba(108,44,156,0.08)', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: Colors.Theme.Primary['70'] }}>🔌 Test</button>
                  </Flex>
                </div>
              </div>

              {/* ── Section: Dynatrace Configuration ── */}
              <div style={{ marginBottom: 8 }}>
                <Flex alignItems="center" justifyContent="space-between" style={{ marginBottom: 10 }}>
                  <Flex alignItems="center" gap={6}>
                    <span style={{ fontSize: 14 }}>⚙️</span>
                    <Strong style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.6 }}>Dynatrace Configuration</Strong>
                  </Flex>
                  <Flex gap={6}>
                    <button onClick={() => detectBuiltinSettings(true)} disabled={isDetecting} style={{ padding: '3px 8px', borderRadius: 5, border: `1px solid ${Colors.Border.Neutral.Default}`, background: 'transparent', cursor: 'pointer', fontSize: 10, fontWeight: 600, opacity: isDetecting ? 0.4 : 0.7 }}>{isDetecting ? '⏳' : '🔄'} Refresh</button>
                    {(!isStepComplete('biz-events') || !isStepComplete('openpipeline') || !isStepComplete('openpipeline-routing') || !isStepComplete('feature-flags') || !isStepComplete('outbound-github-models')) && (
                      <button
                        onClick={() => {
                          const toDeploy: string[] = [];
                          if (!isStepComplete('biz-events')) toDeploy.push('biz-events');
                          if (!isStepComplete('feature-flags')) toDeploy.push('feature-flags');
                          if (!isStepComplete('openpipeline')) toDeploy.push('openpipeline');
                          if (!isStepComplete('openpipeline-routing')) toDeploy.push('openpipeline-routing');
                          if (!isStepComplete('outbound-github-models')) toDeploy.push('outbound-github-models');
                          deployBuiltinConfigs(toDeploy);
                        }}
                        disabled={isDeployingConfigs}
                        style={{ padding: '3px 10px', borderRadius: 5, border: '1px solid rgba(0,161,201,0.4)', background: 'rgba(0,161,201,0.08)', cursor: isDeployingConfigs ? 'wait' : 'pointer', fontSize: 10, fontWeight: 700, color: '#00a1c9' }}
                      >
                        {isDeployingConfigs ? '⏳ Deploying...' : '🚀 Deploy All'}
                      </button>
                    )}
                  </Flex>
                </Flex>

                {deployConfigsStatus && (
                  <div style={{ padding: 8, borderRadius: 6, fontSize: 11, marginBottom: 8, background: deployConfigsStatus.startsWith('✅') ? 'rgba(0,180,0,0.06)' : deployConfigsStatus.startsWith('❌') ? 'rgba(220,50,47,0.06)' : 'rgba(0,161,201,0.06)', border: `1px solid ${deployConfigsStatus.startsWith('✅') ? 'rgba(0,180,0,0.2)' : deployConfigsStatus.startsWith('❌') ? 'rgba(220,50,47,0.2)' : 'rgba(0,161,201,0.2)'}` }}>
                    {deployConfigsStatus}
                  </div>
                )}

                {/* Step: BizEvents Capture Rule */}
                <div onClick={() => toggleCheck('biz-events')} style={{ padding: '12px 14px', borderRadius: 10, border: `1px solid ${isStepComplete('biz-events') ? 'rgba(0,180,0,0.3)' : Colors.Border.Neutral.Default}`, background: isStepComplete('biz-events') ? 'rgba(0,180,0,0.04)' : 'transparent', cursor: 'pointer', marginBottom: 8, transition: 'all 0.2s' }}>
                  <Flex alignItems="center" gap={12}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, border: `2px solid ${isStepComplete('biz-events') ? '#2e7d32' : Colors.Border.Neutral.Default}`, background: isStepComplete('biz-events') ? '#2e7d32' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s' }}>
                      {isStepComplete('biz-events') && <span style={{ color: 'white', fontSize: 14, fontWeight: 700 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <Strong style={{ fontSize: 13, textDecoration: isStepComplete('biz-events') ? 'line-through' : 'none', opacity: isStepComplete('biz-events') ? 0.6 : 1 }}>Business Event Capture Rule</Strong>
                      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Capture rule "BizObs App2" for HTTP incoming business events (test mode)</div>
                      {isStepComplete('biz-events') && <div style={{ fontSize: 10, marginTop: 3, color: '#2e7d32' }}>✅ Detected — <a href={`${TENANT_URL}/ui/apps/dynatrace.settings/settings/bizevents/incoming`} target="_blank" rel="noopener noreferrer" style={{ color: '#4169e1', fontSize: 10 }}>View in Settings →</a></div>}
                    </div>
                    {!isStepComplete('biz-events') ? (
                      <button onClick={(e) => { e.stopPropagation(); deployBuiltinConfigs(['biz-events']); }} disabled={isDeployingConfigs} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(0,161,201,0.4)', background: 'rgba(0,161,201,0.08)', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: '#00a1c9' }}>🚀 Deploy</button>
                    ) : (
                      <a href={`${TENANT_URL}/ui/apps/dynatrace.settings/settings/bizevents/incoming`} target="_blank" rel="noopener noreferrer" style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(65,105,225,0.3)', background: 'rgba(65,105,225,0.06)', fontSize: 11, fontWeight: 600, color: '#4169e1', textDecoration: 'none' }}>Open →</a>
                    )}
                  </Flex>
                </div>

                {/* Step: OneAgent Feature Flag */}
                <div onClick={() => toggleCheck('feature-flags')} style={{ padding: '12px 14px', borderRadius: 10, border: `1px solid ${isStepComplete('feature-flags') ? 'rgba(0,180,0,0.3)' : Colors.Border.Neutral.Default}`, background: isStepComplete('feature-flags') ? 'rgba(0,180,0,0.04)' : 'transparent', cursor: 'pointer', marginBottom: 8, transition: 'all 0.2s' }}>
                  <Flex alignItems="center" gap={12}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, border: `2px solid ${isStepComplete('feature-flags') ? '#2e7d32' : Colors.Border.Neutral.Default}`, background: isStepComplete('feature-flags') ? '#2e7d32' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s' }}>
                      {isStepComplete('feature-flags') && <span style={{ color: 'white', fontSize: 14, fontWeight: 700 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <Strong style={{ fontSize: 13, textDecoration: isStepComplete('feature-flags') ? 'line-through' : 'none', opacity: isStepComplete('feature-flags') ? 0.6 : 1 }}>OneAgent Feature Flag Enabled</Strong>
                      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>SENSOR_NODEJS_BIZEVENTS_HTTP_INCOMING — enables Node.js business event capture</div>
                      {isStepComplete('feature-flags') && <div style={{ fontSize: 10, marginTop: 3, color: '#2e7d32' }}>✅ Detected — <a href={`${TENANT_URL}/ui/apps/dynatrace.settings/settings/oneagent-features`} target="_blank" rel="noopener noreferrer" style={{ color: '#4169e1', fontSize: 10 }}>View in Settings →</a></div>}
                    </div>
                    {!isStepComplete('feature-flags') ? (
                      <button onClick={(e) => { e.stopPropagation(); deployBuiltinConfigs(['feature-flags']); }} disabled={isDeployingConfigs} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(0,161,201,0.4)', background: 'rgba(0,161,201,0.08)', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: '#00a1c9' }}>🚀 Deploy</button>
                    ) : (
                      <a href={`${TENANT_URL}/ui/apps/dynatrace.settings/settings/oneagent-features`} target="_blank" rel="noopener noreferrer" style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(65,105,225,0.3)', background: 'rgba(65,105,225,0.06)', fontSize: 11, fontWeight: 600, color: '#4169e1', textDecoration: 'none' }}>Open →</a>
                    )}
                  </Flex>
                </div>

                {/* Step: OpenPipeline Pipeline */}
                <div onClick={() => toggleCheck('openpipeline')} style={{ padding: '12px 14px', borderRadius: 10, border: `1px solid ${isStepComplete('openpipeline') ? 'rgba(0,180,0,0.3)' : Colors.Border.Neutral.Default}`, background: isStepComplete('openpipeline') ? 'rgba(0,180,0,0.04)' : 'transparent', cursor: 'pointer', marginBottom: 8, transition: 'all 0.2s' }}>
                  <Flex alignItems="center" gap={12}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, border: `2px solid ${isStepComplete('openpipeline') ? '#2e7d32' : Colors.Border.Neutral.Default}`, background: isStepComplete('openpipeline') ? '#2e7d32' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s' }}>
                      {isStepComplete('openpipeline') && <span style={{ color: 'white', fontSize: 14, fontWeight: 700 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <Strong style={{ fontSize: 13, textDecoration: isStepComplete('openpipeline') ? 'line-through' : 'none', opacity: isStepComplete('openpipeline') ? 0.6 : 1 }}>OpenPipeline Pipeline Created</Strong>
                      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Pipeline "BizObs Template Pipeline2" for bizevents ingestion (test mode)</div>
                      {isStepComplete('openpipeline') && <div style={{ fontSize: 10, marginTop: 3, color: '#2e7d32' }}>✅ Detected — <a href={`${TENANT_URL}/ui/apps/dynatrace.settings/settings/openpipeline-bizevents/pipelines?page=1&pageSize=50`} target="_blank" rel="noopener noreferrer" style={{ color: '#4169e1', fontSize: 10 }}>View in Settings →</a></div>}
                    </div>
                    {!isStepComplete('openpipeline') ? (
                      <button onClick={(e) => { e.stopPropagation(); deployBuiltinConfigs(['openpipeline']); }} disabled={isDeployingConfigs} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(0,161,201,0.4)', background: 'rgba(0,161,201,0.08)', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: '#00a1c9' }}>🚀 Deploy</button>
                    ) : (
                      <a href={`${TENANT_URL}/ui/apps/dynatrace.settings/settings/openpipeline-bizevents/pipelines?page=1&pageSize=50`} target="_blank" rel="noopener noreferrer" style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(65,105,225,0.3)', background: 'rgba(65,105,225,0.06)', fontSize: 11, fontWeight: 600, color: '#4169e1', textDecoration: 'none' }}>Open →</a>
                    )}
                  </Flex>
                </div>

                {/* Step: OpenPipeline Routing */}
                <div onClick={() => toggleCheck('openpipeline-routing')} style={{ padding: '12px 14px', borderRadius: 10, border: `1px solid ${isStepComplete('openpipeline-routing') ? 'rgba(0,180,0,0.3)' : Colors.Border.Neutral.Default}`, background: isStepComplete('openpipeline-routing') ? 'rgba(0,180,0,0.04)' : 'transparent', cursor: 'pointer', marginBottom: 8, transition: 'all 0.2s' }}>
                  <Flex alignItems="center" gap={12}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, border: `2px solid ${isStepComplete('openpipeline-routing') ? '#2e7d32' : Colors.Border.Neutral.Default}`, background: isStepComplete('openpipeline-routing') ? '#2e7d32' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s' }}>
                      {isStepComplete('openpipeline-routing') && <span style={{ color: 'white', fontSize: 14, fontWeight: 700 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <Strong style={{ fontSize: 13, textDecoration: isStepComplete('openpipeline-routing') ? 'line-through' : 'none', opacity: isStepComplete('openpipeline-routing') ? 0.6 : 1 }}>OpenPipeline Routing Configured</Strong>
                      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Routing rule description "BizObs App2" to direct events to the pipeline (test mode)</div>
                      {isStepComplete('openpipeline-routing') && <div style={{ fontSize: 10, marginTop: 3, color: '#2e7d32' }}>✅ Detected — <a href={`${TENANT_URL}/ui/apps/dynatrace.settings/settings/openpipeline-bizevents/routing?page=1&pageSize=50`} target="_blank" rel="noopener noreferrer" style={{ color: '#4169e1', fontSize: 10 }}>View in Settings →</a></div>}
                    </div>
                    {!isStepComplete('openpipeline-routing') ? (
                      <button onClick={(e) => { e.stopPropagation(); deployBuiltinConfigs(['openpipeline-routing']); }} disabled={isDeployingConfigs} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(0,161,201,0.4)', background: 'rgba(0,161,201,0.08)', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: '#00a1c9' }}>🚀 Deploy</button>
                    ) : (
                      <a href={`${TENANT_URL}/ui/apps/dynatrace.settings/settings/openpipeline-bizevents/routing?page=1&pageSize=50`} target="_blank" rel="noopener noreferrer" style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(65,105,225,0.3)', background: 'rgba(65,105,225,0.06)', fontSize: 11, fontWeight: 600, color: '#4169e1', textDecoration: 'none' }}>Open →</a>
                    )}
                  </Flex>
                </div>

                {/* Step: GitHub Copilot Outbound Allowlist */}
                <div onClick={() => toggleCheck('outbound-github-models')} style={{ padding: '12px 14px', borderRadius: 10, border: `1px solid ${isStepComplete('outbound-github-models') ? 'rgba(0,180,0,0.3)' : Colors.Border.Neutral.Default}`, background: isStepComplete('outbound-github-models') ? 'rgba(0,180,0,0.04)' : 'transparent', cursor: 'pointer', marginBottom: 8, transition: 'all 0.2s' }}>
                  <Flex alignItems="center" gap={12}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, border: `2px solid ${isStepComplete('outbound-github-models') ? '#2e7d32' : Colors.Border.Neutral.Default}`, background: isStepComplete('outbound-github-models') ? '#2e7d32' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s' }}>
                      {isStepComplete('outbound-github-models') && <span style={{ color: 'white', fontSize: 14, fontWeight: 700 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <Strong style={{ fontSize: 13, textDecoration: isStepComplete('outbound-github-models') ? 'line-through' : 'none', opacity: isStepComplete('outbound-github-models') ? 0.6 : 1 }}>GitHub Copilot Outbound Allowed</Strong>
                      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Allow models.inference.ai.azure.com in AppEngine outbound connections for AI generation</div>
                      {isStepComplete('outbound-github-models') && <div style={{ fontSize: 10, marginTop: 3, color: '#2e7d32' }}>✅ Detected</div>}
                    </div>
                    {!isStepComplete('outbound-github-models') ? (
                      <button onClick={(e) => { e.stopPropagation(); deployBuiltinConfigs(['outbound-github-models']); }} disabled={isDeployingConfigs} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(0,161,201,0.4)', background: 'rgba(0,161,201,0.08)', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: '#00a1c9' }}>🚀 Deploy</button>
                    ) : (
                      <a href={`${TENANT_URL}/ui/apps/dynatrace.settings/settings/dt-javascript-runtime.allowed-outbound-connections`} target="_blank" rel="noopener noreferrer" style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(65,105,225,0.3)', background: 'rgba(65,105,225,0.06)', fontSize: 11, fontWeight: 600, color: '#4169e1', textDecoration: 'none' }}>Open →</a>
                    )}
                  </Flex>
                </div>

                {/* Step: Automation Workflow */}
                <div onClick={() => toggleCheck('automation-workflow')} style={{ padding: '12px 14px', borderRadius: 10, border: `1px solid ${isStepComplete('automation-workflow') ? 'rgba(0,180,0,0.3)' : Colors.Border.Neutral.Default}`, background: isStepComplete('automation-workflow') ? 'rgba(0,180,0,0.04)' : 'transparent', cursor: 'pointer', marginBottom: 8, transition: 'all 0.2s' }}>
                  <Flex alignItems="center" gap={12}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, border: `2px solid ${isStepComplete('automation-workflow') ? '#2e7d32' : Colors.Border.Neutral.Default}`, background: isStepComplete('automation-workflow') ? '#2e7d32' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s' }}>
                      {isStepComplete('automation-workflow') && <span style={{ color: 'white', fontSize: 14, fontWeight: 700 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <Strong style={{ fontSize: 13, textDecoration: isStepComplete('automation-workflow') ? 'line-through' : 'none', opacity: isStepComplete('automation-workflow') ? 0.6 : 1 }}>Fix-It Agent Workflow Deployed</Strong>
                      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Dynatrace Intelligence problem → analysis → autonomous remediation via HTTP</div>
                      {isStepComplete('automation-workflow') && <div style={{ fontSize: 10, marginTop: 3, color: '#2e7d32' }}>✅ Detected — <a href={`${TENANT_URL}/ui/apps/dynatrace.automations`} target="_blank" rel="noopener noreferrer" style={{ color: '#4169e1', fontSize: 10 }}>View in Workflows →</a></div>}
                      {!isStepComplete('automation-workflow') && <div style={{ fontSize: 10, marginTop: 3, opacity: 0.5 }}>Download the workflow JSON → upload in Dynatrace Workflows</div>}
                    </div>
                    {!isStepComplete('automation-workflow') ? (
                      <Flex gap={4}>
                        <button onClick={async (e) => {
                          e.stopPropagation();
                          try {
                            const result = await callProxyWithRetry(
                              { action: 'deploy-workflow', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol || 'http' }
                            ) as any;
                            if (result.success && result.data?.workflowTemplate) {
                              const json = JSON.stringify(result.data.workflowTemplate, null, 2);
                              const blob = new Blob([json], { type: 'application/json' });
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = 'bizobs-fix-it-agent-workflow.json';
                              document.body.appendChild(a);
                              a.click();
                              document.body.removeChild(a);
                              URL.revokeObjectURL(url);
                              showToast('Workflow JSON downloaded — upload it in Dynatrace Workflows', 'success', 5000);
                            } else {
                              showToast('Failed to generate workflow template', 'error');
                            }
                          } catch (err: any) { showToast(err.message, 'error'); }
                        }} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(0,161,201,0.4)', background: 'rgba(0,161,201,0.08)', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: '#00a1c9' }}>⬇️ Download</button>
                        <a href={`${TENANT_URL}/ui/apps/dynatrace.automations`} target="_blank" rel="noopener noreferrer" style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(65,105,225,0.3)', background: 'rgba(65,105,225,0.06)', fontSize: 11, fontWeight: 600, color: '#4169e1', textDecoration: 'none' }}>Open →</a>
                      </Flex>
                    ) : (
                      <a href={`${TENANT_URL}/ui/apps/dynatrace.automations`} target="_blank" rel="noopener noreferrer" style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(65,105,225,0.3)', background: 'rgba(65,105,225,0.06)', fontSize: 11, fontWeight: 600, color: '#4169e1', textDecoration: 'none' }}>Open →</a>
                    )}
                  </Flex>
                </div>
              </div>

              {/* Reset */}
              <Flex justifyContent="flex-end" style={{ marginTop: 8 }}>
                <button onClick={() => { setChecklist({}); localStorage.removeItem('bizobs_checklist'); localStorage.removeItem('bizobs_connection_tested'); setConnectionTestedOk(false); }} style={{ padding: '4px 12px', borderRadius: 6, border: `1px solid ${Colors.Border.Neutral.Default}`, background: 'transparent', cursor: 'pointer', fontSize: 11, fontWeight: 600, opacity: 0.5 }}>🔄 Reset checklist</button>
              </Flex>
            </div>
          </div>
        </div>
      )}

      {/* ── Confirm Dialog (replaces native confirm()) ──── */}
      {confirmDialog && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 10002, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)' }} onClick={() => setConfirmDialog(null)} />
          <div style={{ position: 'relative', width: 380, background: Colors.Background.Surface.Default, borderRadius: 14, border: `2px solid ${Colors.Theme.Primary['70']}`, boxShadow: '0 16px 40px rgba(0,0,0,0.3)' }}>
            <div style={{ padding: '16px 20px', background: 'linear-gradient(135deg, rgba(108,44,156,0.12), rgba(0,161,201,0.08))', borderRadius: '12px 12px 0 0', borderBottom: `1px solid ${Colors.Border.Neutral.Default}` }}>
              <Flex alignItems="center" gap={8}>
                <span style={{ fontSize: 20 }}>⚠️</span>
                <Strong style={{ fontSize: 15 }}>Confirm</Strong>
              </Flex>
            </div>
            <div style={{ padding: 20 }}>
              <Paragraph style={{ fontSize: 13, marginBottom: 20, lineHeight: 1.6 }}>{confirmDialog.message}</Paragraph>
              <Flex gap={8}>
                <Button onClick={() => setConfirmDialog(null)} style={{ flex: 1 }}>Cancel</Button>
                <Button onClick={() => { confirmDialog.onConfirm(); setConfirmDialog(null); }} style={{ flex: 1, background: 'rgba(220,50,47,0.15)', color: '#dc322f', fontWeight: 600 }}>Confirm</Button>
              </Flex>
            </div>
          </div>
        </div>
      )}

      {/* ── Toast Notification ──── */}
      {toastVisible && (
        <div
          style={{
            position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
            zIndex: 10003, minWidth: 320, maxWidth: 600,
            padding: '12px 20px', borderRadius: 10,
            display: 'flex', alignItems: 'center', gap: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
            background: toastType === 'success' ? 'linear-gradient(135deg, rgba(115,190,40,0.95), rgba(80,160,20,0.95))'
              : toastType === 'error' ? 'linear-gradient(135deg, rgba(220,50,47,0.95), rgba(180,30,30,0.95))'
              : toastType === 'warning' ? 'linear-gradient(135deg, rgba(181,137,0,0.95), rgba(200,160,10,0.95))'
              : 'linear-gradient(135deg, rgba(0,161,201,0.95), rgba(0,130,170,0.95))',
            color: 'white', fontSize: 13, fontWeight: 500,
            animation: 'fadeInUp 0.3s ease',
          }}
        >
          <span style={{ fontSize: 16 }}>
            {toastType === 'success' ? '✅' : toastType === 'error' ? '❌' : toastType === 'warning' ? '⚠️' : 'ℹ️'}
          </span>
          <span style={{ flex: 1 }}>{toastMessage}</span>
          <button
            onClick={() => setToastVisible(false)}
            style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.8)', fontSize: 16, cursor: 'pointer', padding: '0 4px' }}
          >
            ✕
          </button>
        </div>
      )}
      {/* ── AI Generation Pipeline Modal ───────────────── */}
      {showAiGenModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 10003, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.65)' }} />
          <div style={{
            position: 'relative', width: 520, background: Colors.Background.Surface.Default,
            borderRadius: 20, border: `2px solid ${aiGenComplete ? 'rgba(115,190,40,0.6)' : aiGenError ? 'rgba(220,50,47,0.6)' : 'rgba(0,161,201,0.4)'}`,
            boxShadow: '0 24px 64px rgba(0,0,0,0.4)', overflow: 'hidden',
          }}>
            {/* Header */}
            <div style={{
              padding: '20px 24px',
              background: aiGenComplete
                ? 'linear-gradient(135deg, rgba(115,190,40,0.9), rgba(0,180,0,0.8))'
                : aiGenError
                  ? 'linear-gradient(135deg, rgba(220,50,47,0.9), rgba(180,30,30,0.8))'
                  : 'linear-gradient(135deg, rgba(0,161,201,0.9), rgba(108,44,156,0.9))',
            }}>
              <Flex alignItems="center" gap={12}>
                <div style={{ fontSize: 32 }}>{aiGenComplete ? '🎉' : aiGenError ? '⚠️' : '✨'}</div>
                <div>
                  <Strong style={{ color: 'white', fontSize: 18 }}>
                    {aiGenComplete ? 'Generation Complete!' : aiGenError ? 'Generation Failed' : 'AI Generation Pipeline'}
                  </Strong>
                  <div style={{ color: 'rgba(255,255,255,0.8)', fontSize: 12, marginTop: 2 }}>
                    {aiGenComplete ? 'Services are live and template saved' : aiGenError ? 'Check the error below and retry' : `Model: ${ghCopilotModel} • ${companyName}`}
                  </div>
                </div>
              </Flex>
            </div>

            {/* Steps */}
            <div style={{ padding: '20px 24px' }}>
              {aiGenSteps.map((step, idx) => (
                <div key={idx} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: idx < aiGenSteps.length - 1 ? 16 : 0,
                  opacity: step.status === 'pending' ? 0.4 : 1,
                  transition: 'opacity 0.3s ease',
                }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 16, fontWeight: 700,
                    background: step.status === 'done' ? 'rgba(115,190,40,0.15)' : step.status === 'error' ? 'rgba(220,50,47,0.15)' : step.status === 'running' ? 'rgba(0,161,201,0.15)' : 'rgba(120,120,120,0.1)',
                    border: `2px solid ${step.status === 'done' ? 'rgba(115,190,40,0.5)' : step.status === 'error' ? 'rgba(220,50,47,0.5)' : step.status === 'running' ? 'rgba(0,161,201,0.5)' : 'rgba(120,120,120,0.2)'}`,
                    color: step.status === 'done' ? '#73be28' : step.status === 'error' ? '#dc322f' : step.status === 'running' ? '#00a1c9' : Colors.Text.Neutral.Subdued,
                  }}>
                    {step.status === 'done' ? '✓' : step.status === 'error' ? '✕' : step.status === 'running' ? '⏳' : idx + 1}
                  </div>
                  <div style={{ flex: 1, paddingTop: 4 }}>
                    <div style={{
                      fontSize: 14, fontWeight: step.status === 'running' ? 700 : 600,
                      color: step.status === 'running' ? Colors.Text.Neutral.Default : step.status === 'done' ? Colors.Text.Neutral.Default : Colors.Text.Neutral.Subdued,
                    }}>
                      {step.label}
                      {step.status === 'running' && <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.7 }}>...</span>}
                    </div>
                    {step.detail && (
                      <div style={{
                        fontSize: 11, marginTop: 3,
                        color: step.status === 'error' ? '#dc322f' : 'rgba(115,190,40,0.9)',
                        fontFamily: step.status === 'error' ? 'monospace' : 'inherit',
                        wordBreak: 'break-word',
                      }}>
                        {step.detail}
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {/* Progress bar */}
              {!aiGenComplete && !aiGenError && (
                <div style={{ marginTop: 20, height: 4, borderRadius: 2, background: 'rgba(120,120,120,0.15)', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', borderRadius: 2,
                    background: 'linear-gradient(90deg, #00a1c9, #73be28)',
                    width: `${(aiGenSteps.filter(s => s.status === 'done').length / aiGenSteps.length) * 100}%`,
                    transition: 'width 0.5s ease',
                  }} />
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{ padding: '16px 24px', borderTop: `1px solid ${Colors.Border.Neutral.Default}`, display: 'flex', justifyContent: aiGenComplete || aiGenError ? 'space-between' : 'flex-end' }}>
              {aiGenComplete && (
                <Button
                  variant="emphasized"
                  onClick={() => { setShowAiGenModal(false); setActiveTab('step2'); setStep2Phase('generate'); }}
                  style={{ padding: '8px 20px' }}
                >
                  View Results
                </Button>
              )}
              {aiGenError && (
                <Button
                  variant="accent"
                  onClick={() => runAiGenerationPipeline()}
                  style={{ padding: '8px 20px' }}
                >
                  🔄 Retry
                </Button>
              )}
              {(aiGenComplete || aiGenError) && (
                <Button onClick={() => setShowAiGenModal(false)} style={{ padding: '8px 16px' }}>
                  Close
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Paste Your Own AI Prompt Modal ───────────────── */}
      {showPasteAiModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 10003, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.65)' }} onClick={() => setShowPasteAiModal(false)} />
          <div style={{
            position: 'relative', width: 620, maxHeight: '85vh', background: Colors.Background.Surface.Default,
            borderRadius: 20, border: '2px solid rgba(108,44,156,0.4)',
            boxShadow: '0 24px 64px rgba(0,0,0,0.4)', overflow: 'hidden', display: 'flex', flexDirection: 'column',
          }}>
            {/* Header */}
            <div style={{
              padding: '20px 24px',
              background: 'linear-gradient(135deg, rgba(108,44,156,0.9), rgba(0,161,201,0.9))',
            }}>
              <Flex alignItems="center" gap={12}>
                <div style={{ fontSize: 32 }}>📋</div>
                <div>
                  <Strong style={{ color: 'white', fontSize: 18 }}>Use Your Own AI Prompt</Strong>
                  <div style={{ color: 'rgba(255,255,255,0.8)', fontSize: 12, marginTop: 2 }}>
                    Paste a C-Suite analysis from ChatGPT, Gemini, Claude, or any AI — we'll extract the journeys
                  </div>
                </div>
              </Flex>
            </div>

            {/* Body */}
            <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1 }}>
              <Paragraph style={{ fontSize: 13, marginBottom: 12, lineHeight: 1.5 }}>
                Paste the AI-generated C-Suite / business analysis below. The app will look for journey names in the
                <Strong> "Journey Classification"</Strong> or <Strong>"Critical User Journeys"</Strong> section and let you pick one.
              </Paragraph>
              <textarea
                value={pastedAiResponse}
                onChange={(e) => {
                  const text = e.target.value;
                  setPastedAiResponse(text);
                  const journeys = extractJourneysFromText(text);
                  setExtractedJourneys(journeys);
                  setSelectedJourneyName(journeys[0] || '');
                }}
                placeholder={'Paste your AI response here...\n\nExample:\n### 3. Journey Classification\n- **Journey Names**:\n    - "Vehicle Purchase Journey"\n    - "Finance Application Journey"'}
                style={{
                  width: '100%', minHeight: 200, maxHeight: 300, padding: 14,
                  background: Colors.Background.Base.Default,
                  border: `1px solid ${Colors.Border.Neutral.Default}`,
                  borderRadius: 8, color: Colors.Text.Neutral.Default,
                  fontFamily: 'monospace', fontSize: 12, lineHeight: 1.5, resize: 'vertical',
                }}
              />

              {/* Extracted journeys */}
              {pastedAiResponse.length > 50 && (
                <div style={{ marginTop: 16 }}>
                  {extractedJourneys.length > 0 ? (
                    <>
                      <Flex alignItems="center" gap={8} style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 18 }}>🎯</div>
                        <Strong style={{ fontSize: 14 }}>
                          {extractedJourneys.length} Journey{extractedJourneys.length > 1 ? 's' : ''} Found
                        </Strong>
                      </Flex>
                      <Paragraph style={{ fontSize: 12, marginBottom: 10, opacity: 0.7 }}>
                        Select which journey to generate the observability configuration for:
                      </Paragraph>
                      <select
                        value={selectedJourneyName}
                        onChange={(e: any) => setSelectedJourneyName(e.target.value)}
                        style={{
                          width: '100%', padding: '10px 14px', borderRadius: 8,
                          background: Colors.Background.Base.Default,
                          border: '2px solid rgba(115,190,40,0.5)',
                          color: Colors.Text.Neutral.Default, fontSize: 14,
                          cursor: 'pointer', fontWeight: 600,
                        }}
                      >
                        {extractedJourneys.map((j, idx) => (
                          <option key={idx} value={j}>{j}</option>
                        ))}
                      </select>
                    </>
                  ) : (
                    <div style={{
                      padding: 14, borderRadius: 8,
                      background: 'rgba(220,180,0,0.1)', border: '1px solid rgba(220,180,0,0.3)',
                    }}>
                      <Flex alignItems="center" gap={8}>
                        <div style={{ fontSize: 16 }}>⚠️</div>
                        <div>
                          <Strong style={{ fontSize: 13 }}>No journeys detected</Strong>
                          <Paragraph style={{ fontSize: 12, marginBottom: 0, marginTop: 4, opacity: 0.8 }}>
                            Make sure your analysis includes a "Journey Classification" or "Journey Names" section with named journeys.
                            You can also type a custom journey name below.
                          </Paragraph>
                        </div>
                      </Flex>
                      <TextInput
                        value={selectedJourneyName}
                        onChange={(value) => setSelectedJourneyName(value)}
                        placeholder="e.g., Purchase Journey, Subscription Flow"
                        style={{ width: '100%', marginTop: 10 }}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{ padding: '16px 24px', borderTop: `1px solid ${Colors.Border.Neutral.Default}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Button onClick={() => setShowPasteAiModal(false)} style={{ padding: '8px 16px' }}>
                Cancel
              </Button>
              <Flex alignItems="center" gap={12}>
                {ghCopilotConfigured && (
                  <select
                    value={ghCopilotModel}
                    onChange={(e: any) => setGhCopilotModel(e.target.value)}
                    style={{
                      padding: '7px 10px', borderRadius: 6,
                      background: Colors.Background.Base.Default,
                      border: `1px solid ${Colors.Border.Neutral.Default}`,
                      color: Colors.Text.Neutral.Default, fontSize: 12,
                      cursor: 'pointer', minWidth: 120,
                    }}
                  >
                    {ghAvailableModels.length > 0
                      ? ghAvailableModels.map(m => (
                          <option key={m.id} value={m.id}>{m.id}</option>
                        ))
                      : ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'o4-mini', 'claude-sonnet-4'].map(id => (
                          <option key={id} value={id}>{id}</option>
                        ))
                    }
                  </select>
                )}
                <Button
                  variant="accent"
                  disabled={!selectedJourneyName || !pastedAiResponse || pastedAiResponse.length < 50 || !ghCopilotConfigured}
                  onClick={() => runPastedAiPipeline(pastedAiResponse, selectedJourneyName)}
                  title={!ghCopilotConfigured ? 'Configure GitHub PAT in Settings first' : `Generate "${selectedJourneyName}" config`}
                  style={{
                    padding: '10px 24px', fontWeight: 700, fontSize: 14,
                    background: ghCopilotConfigured && selectedJourneyName ? 'linear-gradient(135deg, rgba(108,44,156,0.9), rgba(0,161,201,0.9))' : undefined,
                    color: ghCopilotConfigured && selectedJourneyName ? 'white' : undefined,
                    border: ghCopilotConfigured && selectedJourneyName ? 'none' : undefined,
                    borderRadius: 10,
                    opacity: (!selectedJourneyName || !ghCopilotConfigured) ? 0.4 : 1,
                  }}
                >
                  🚀 Generate Journey Config
                </Button>
              </Flex>
            </div>
          </div>
        </div>
      )}

      <div style={{ position: 'fixed', bottom: 4, right: 8, fontSize: 9, color: 'rgba(255,255,255,0.18)', zIndex: 1, pointerEvents: 'none', fontFamily: 'monospace' }}>v{APP_VERSION}</div>
    </Page>
  );
};
