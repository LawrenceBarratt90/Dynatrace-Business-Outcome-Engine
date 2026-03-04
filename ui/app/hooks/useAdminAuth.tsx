/**
 * Admin Auth Context — identity-based access control for the Forge UI.
 *
 * Uses `getCurrentUserDetails()` from the Dynatrace AppEngine runtime
 * to identify the logged-in user. Admin state is persisted in the shared
 * app settings using the imperative SDK client (not React hooks) to avoid
 * conflicts with the SettingsPage hooks.
 *
 * Roles:
 *   Admin  — the user whose ID matches `adminUserId` in app settings.
 *            Can perform all destructive actions (stop services, delete
 *            EdgeConnect, inject/revert chaos, change settings, etc.)
 *   Owner  — the user who created a specific config/template.
 *            Can edit/delete their own configs.
 *   User   — anyone else. Can view everything, create/run journeys,
 *            save new templates. Cannot perform destructive actions.
 */
import React, { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import { getCurrentUserDetails } from '@dynatrace-sdk/app-environment';
import { appSettingsObjectsClient } from '@dynatrace-sdk/client-app-settings-v2';

// ── Types ────────────────────────────────────────────────────
export interface AppUser {
  id: string;
  name: string;
  email: string;
}

export interface AdminAuthContextType {
  /** The currently logged-in Dynatrace user */
  currentUser: AppUser;
  /** True if the current user is the app admin */
  isAdmin: boolean;
  /** The admin user, or null if no admin is claimed */
  adminUser: { id: string; name: string } | null;
  /** True while loading admin state from Dynatrace settings */
  isLoading: boolean;
  /** Claim admin for the current user (only if no admin exists yet) */
  claimAdmin: () => Promise<boolean>;
  /** Release admin (only the current admin can do this) */
  releaseAdmin: () => Promise<boolean>;
  /** True if the current user created the item identified by creatorId */
  isOwner: (creatorId?: string) => boolean;
  /** True if the current user can delete/edit the item (admin OR owner) */
  canModify: (creatorId?: string) => boolean;
}

// ── Helpers ──────────────────────────────────────────────────
const SCHEMA_ID = 'app:my.bizobs.generator.test:api-config';
const DEV_USER_ID = 'dt.missing.user.id';

function resolveUser(): AppUser {
  try {
    const details = getCurrentUserDetails();
    return {
      id: details.id || DEV_USER_ID,
      name: details.name || 'Developer',
      email: details.email || 'dev@local',
    };
  } catch {
    return { id: DEV_USER_ID, name: 'Developer', email: 'dev@local' };
  }
}

// ── Context ──────────────────────────────────────────────────
const AdminAuthContext = createContext<AdminAuthContextType | null>(null);

export const AdminAuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const currentUser = useRef(resolveUser()).current;

  // Admin state
  const [adminId, setAdminId] = useState<string | null>(null);
  const [adminName, setAdminName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Load admin state from DT app settings using imperative client (no hooks)
  const loadedRef = useRef(false);
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;

    (async () => {
      try {
        const result = await appSettingsObjectsClient.getEffectiveAppSettingsValues({
          schemaId: SCHEMA_ID,
          addFields: 'value',
        });
        const val = (result?.items?.[0] as any)?.value;
        if (val?.adminUserId) {
          setAdminId(val.adminUserId);
          setAdminName(val.adminUserName || '');
        }
      } catch (err) {
        console.warn('[AdminAuth] Could not load admin state:', err);
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const isDev = currentUser.id === DEV_USER_ID;
  // When no admin is claimed yet, everyone is effectively admin (first-use bootstrap).
  // Once someone claims admin, only that user has admin powers.
  const isAdmin = isDev || !adminId || currentUser.id === adminId;
  const adminUser = adminId ? { id: adminId, name: adminName || 'Unknown' } : null;

  const isOwner = useCallback(
    (creatorId?: string) => !!creatorId && creatorId === currentUser.id,
    [currentUser.id],
  );

  const canModify = useCallback(
    (creatorId?: string) => isAdmin || isOwner(creatorId),
    [isAdmin, isOwner],
  );

  /** Persist admin user into the shared app settings */
  const persistAdmin = useCallback(
    async (userId: string, userName: string) => {
      try {
        // Fetch the current settings object (need objectId + version for update)
        const objects = await appSettingsObjectsClient.getAppSettingsObjects({
          schemaId: SCHEMA_ID,
          addFields: 'value,objectId,version',
        });

        const existing = objects?.items?.[0] as any;
        const currentVal = existing?.value || {};
        const newVal = {
          ...currentVal,
          adminUserId: userId,
          adminUserName: userName,
        };

        if (existing?.objectId && existing?.version) {
          await appSettingsObjectsClient.putAppSettingsObjectByObjectId({
            objectId: existing.objectId,
            optimisticLockingVersion: existing.version,
            body: { value: newVal },
          });
        } else {
          await appSettingsObjectsClient.postAppSettingsObject({
            body: { schemaId: SCHEMA_ID, value: newVal },
          });
        }
        return true;
      } catch (err) {
        console.error('[AdminAuth] Failed to persist admin:', err);
        return false;
      }
    },
    [],
  );

  const claimAdmin = useCallback(async () => {
    if (adminId && adminId !== currentUser.id) {
      return false; // Already claimed by someone else
    }
    const ok = await persistAdmin(currentUser.id, currentUser.name || currentUser.email);
    if (ok) {
      setAdminId(currentUser.id);
      setAdminName(currentUser.name || currentUser.email);
    }
    return ok;
  }, [adminId, currentUser, persistAdmin]);

  const releaseAdmin = useCallback(async () => {
    if (!isAdmin) return false;
    const ok = await persistAdmin('', '');
    if (ok) {
      setAdminId(null);
      setAdminName(null);
    }
    return ok;
  }, [isAdmin, persistAdmin]);

  const value: AdminAuthContextType = {
    currentUser,
    isAdmin,
    adminUser,
    isLoading,
    claimAdmin,
    releaseAdmin,
    isOwner,
    canModify,
  };

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
};

/**
 * Hook to access admin auth state. Must be called inside <AdminAuthProvider>.
 */
export function useAdminAuth(): AdminAuthContextType {
  const ctx = useContext(AdminAuthContext);
  if (!ctx) {
    throw new Error('useAdminAuth must be used within an AdminAuthProvider');
  }
  return ctx;
}
