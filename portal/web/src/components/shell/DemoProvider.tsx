"use client";

// System-wide demo mode React context and synchronous fetch interceptor wiring (T-0892).
// Never engages implicitly: initializes from explicit localStorage preference or ?demo=1.
// Installs the /v1/* fetch interceptor synchronously before child effects mount so pages
// and shell components receive simulated demo payloads seamlessly without network calls.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  DEMO_MODE_CHANGED_EVENT,
  DEMO_MODE_STORAGE_KEY,
  clearDemoQueryParam,
  installDemoFetchInterceptor,
  isDemoFetchInterceptorInstalled,
  isDemoModeEnabled,
  readDemoModePreference,
  uninstallDemoFetchInterceptor,
  writeDemoModePreference,
} from "../../lib/demo-mode";
import { getCurrentTenantId, setCurrentTenantId } from "../../lib/tenant-preference";

export interface DemoModeContextValue {
  readonly enabled: boolean;
  readonly setEnabled: (enabled: boolean) => void;
  readonly toggle: () => void;
}

const DEFAULT_DEMO_MODE_CONTEXT: DemoModeContextValue = {
  enabled: false,
  setEnabled: () => {},
  toggle: () => {},
};

const DemoModeContext = createContext<DemoModeContextValue>(DEFAULT_DEMO_MODE_CONTEXT);

export interface DemoProviderProps {
  readonly children: ReactNode;
}

export function DemoProvider({ children }: DemoProviderProps): ReactElement {
  const [enabled, setEnabledState] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const active = isDemoModeEnabled();
    if (active) {
      installDemoFetchInterceptor();
    }
    return active;
  });

  // Ensure the interceptor stays synchronously aligned before child effects run.
  if (typeof window !== "undefined") {
    if (enabled && !isDemoFetchInterceptorInstalled()) {
      installDemoFetchInterceptor();
    } else if (!enabled && isDemoFetchInterceptorInstalled()) {
      uninstallDemoFetchInterceptor();
    }
  }

  const setEnabled = useCallback((next: boolean): void => {
    if (next) {
      installDemoFetchInterceptor();
      writeDemoModePreference(true);
      setEnabledState(true);
      return;
    }

    uninstallDemoFetchInterceptor();
    writeDemoModePreference(false);
    clearDemoQueryParam();
    const currentTenant = getCurrentTenantId();
    if (currentTenant && currentTenant.startsWith("demo-tenant-")) {
      setCurrentTenantId(null);
    }
    setEnabledState(false);
  }, []);

  const toggle = useCallback((): void => {
    setEnabled(!enabled);
  }, [enabled, setEnabled]);

  useEffect(() => {
    const syncFromExternal = (next: boolean): void => {
      if (next) {
        installDemoFetchInterceptor();
      } else {
        uninstallDemoFetchInterceptor();
      }
      setEnabledState(next);
    };

    const onStorage = (event: StorageEvent): void => {
      if (event.key === DEMO_MODE_STORAGE_KEY || event.key === null) {
        syncFromExternal(readDemoModePreference());
      }
    };

    const onCustomChange = (event: Event): void => {
      const detail = (event as CustomEvent<{ enabled?: boolean }>).detail;
      if (typeof detail?.enabled === "boolean") {
        syncFromExternal(detail.enabled);
      }
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener(DEMO_MODE_CHANGED_EVENT, onCustomChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(DEMO_MODE_CHANGED_EVENT, onCustomChange);
    };
  }, []);

  const value = useMemo<DemoModeContextValue>(
    () => ({ enabled, setEnabled, toggle }),
    [enabled, setEnabled, toggle],
  );

  return <DemoModeContext.Provider value={value}>{children}</DemoModeContext.Provider>;
}

/**
 * Reads the current demo mode state and controls.
 * Returns safe disabled defaults when rendered outside DemoProvider (e.g. isolated shell tests).
 */
export function useDemoMode(): DemoModeContextValue {
  return useContext(DemoModeContext);
}
