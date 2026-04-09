/**
 * App-wide settings persistence via Dynatrace Grail Documents API.
 * 
 * Uses a shared document (visible to ALL users on the tenant) so that
 * when one user configures the EC2 IP / port / protocol, every other
 * user sees the same settings without needing to configure again.
 * 
 * Fallback chain:
 *   LOAD:  Document API → localStorage
 *   SAVE:  Document API + localStorage (both written)
 */
import { functions } from '@dynatrace-sdk/app-utils';

// Well-known document name shared across all users
const APP_SETTINGS_DOC_NAME = 'bizobs-engine-app-settings';
const LOCAL_STORAGE_KEY = 'bizobs_api_settings';

export interface AppSettings {
  apiHost: string;
  apiPort: string;
  apiProtocol: string;
  enableAutoGeneration: boolean;
  checklistState?: string;
  promptTemplates?: string;
  connectionTested?: boolean;
}

const DEFAULTS: AppSettings = {
  apiHost: 'localhost',
  apiPort: '8080',
  apiProtocol: 'http',
  enableAutoGeneration: false,
};

/**
 * Load app-wide settings from the shared Grail Document via the serverless proxy.
 * Falls back to localStorage if the document doesn't exist or can't be read.
 */
export async function loadAppSettings(): Promise<{ settings: AppSettings; source: 'document' | 'localStorage' | 'defaults' }> {
  // Try Document API via serverless proxy
  try {
    const res = await functions.call('proxy-api', {
      data: { action: 'load-app-settings' },
    });
    const result = await res.json() as any;
    if (result.success && result.settings) {
      const s = result.settings;
      const settings: AppSettings = {
        apiHost: s.apiHost || DEFAULTS.apiHost,
        apiPort: s.apiPort || DEFAULTS.apiPort,
        apiProtocol: s.apiProtocol || DEFAULTS.apiProtocol,
        enableAutoGeneration: s.enableAutoGeneration || false,
        checklistState: s.checklistState,
        promptTemplates: s.promptTemplates,
        connectionTested: s.connectionTested,
      };
      // Sync to localStorage for fast initial render next time
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(settings));
      console.log('[AppSettings] ✅ Loaded from shared document:', settings.apiHost);
      return { settings, source: 'document' };
    }
  } catch (err: any) {
    console.warn('[AppSettings] Document load failed:', err.message);
  }

  // Fallback to localStorage
  try {
    const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        settings: { ...DEFAULTS, ...parsed },
        source: 'localStorage',
      };
    }
  } catch { /* ignore */ }

  return { settings: DEFAULTS, source: 'defaults' };
}

/**
 * Save settings to the shared Grail Document (app-wide) AND localStorage.
 * Returns true if the document write succeeded.
 */
export async function saveAppSettings(settings: AppSettings): Promise<boolean> {
  // Always write localStorage immediately
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(settings));
  localStorage.setItem('bizobs_api_host', settings.apiHost);
  localStorage.setItem('bizobs_api_port', settings.apiPort);

  // Write to shared Document via serverless proxy
  try {
    const res = await functions.call('proxy-api', {
      data: {
        action: 'save-app-settings',
        body: settings,
      },
    });
    const result = await res.json() as any;
    if (result.success) {
      console.log('[AppSettings] ✅ Saved to shared document');
      return true;
    } else {
      console.warn('[AppSettings] Document save returned:', result.error);
      return false;
    }
  } catch (err: any) {
    console.warn('[AppSettings] Document save failed:', err.message);
    return false;
  }
}
