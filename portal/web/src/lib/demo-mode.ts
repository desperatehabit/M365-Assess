// System-wide demo mode preference and fetch interceptor (T-0892).
// Opt-in only: demo mode never engages implicitly. When active (explicit toggle
// persisted in localStorage or ?demo=1 query param), intercepts /v1/* fetch calls
// and serves simulated responses from demo-dataset.ts without touching the network.
// When disabled or uninstalled, the original fetch implementation is restored untouched.

import { resolveDemoResponse } from "../data/demo-dataset";

export const DEMO_MODE_STORAGE_KEY = "m365-assess.demo-mode";
export const DEMO_MODE_CHANGED_EVENT = "m365:demo-mode-changed";

const DEMO_FETCH_MARKER = Symbol.for("m365-assess.demo-fetch");

type MarkedFetch = typeof fetch & { [DEMO_FETCH_MARKER]?: true };

let savedWindowFetch: typeof fetch | null = null;
let savedGlobalFetch: typeof fetch | null = null;

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function isWrappedFetch(fn: unknown): fn is MarkedFetch {
  return typeof fn === "function" && (fn as MarkedFetch)[DEMO_FETCH_MARKER] === true;
}

/** Reads the persisted explicit demo-mode preference from localStorage. */
export function readDemoModePreference(): boolean {
  if (!isBrowser() || typeof window.localStorage === "undefined") return false;
  try {
    return window.localStorage.getItem(DEMO_MODE_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** Persists the explicit demo-mode preference in localStorage and notifies listeners. */
export function writeDemoModePreference(enabled: boolean): void {
  if (!isBrowser() || typeof window.localStorage === "undefined") return;
  try {
    if (enabled) {
      window.localStorage.setItem(DEMO_MODE_STORAGE_KEY, "true");
    } else {
      window.localStorage.removeItem(DEMO_MODE_STORAGE_KEY);
    }
    window.dispatchEvent(new CustomEvent(DEMO_MODE_CHANGED_EVENT, { detail: { enabled } }));
  } catch {
    // Ignore storage quota or private-browsing errors.
  }
}

/** Returns true only when ?demo=1 is explicitly present in the query string. */
export function hasDemoQueryParam(search?: string): boolean {
  if (search !== undefined) {
    return new URLSearchParams(search).get("demo") === "1";
  }
  if (!isBrowser()) return false;
  try {
    return new URLSearchParams(window.location.search).get("demo") === "1";
  } catch {
    return false;
  }
}

/** Returns true only when demo mode was explicitly opted into via preference or ?demo=1. */
export function isDemoModeEnabled(): boolean {
  return readDemoModePreference() || hasDemoQueryParam();
}

/** Removes ?demo=1 from the address bar without reloading when exiting demo mode. */
export function clearDemoQueryParam(): void {
  if (!isBrowser() || typeof window.history === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get("demo") === "1") {
      url.searchParams.delete("demo");
      const next = `${url.pathname}${url.search}${url.hash}`;
      window.history.replaceState(window.history.state, "", next);
    }
  } catch {
    // Ignore history errors in restricted environments.
  }
}

/** Returns true if the demo fetch interceptor is currently active on fetch. */
export function isDemoFetchInterceptorInstalled(): boolean {
  const winFetch = isBrowser() ? window.fetch : undefined;
  const globFetch = typeof globalThis !== "undefined" ? globalThis.fetch : undefined;
  return isWrappedFetch(winFetch) || isWrappedFetch(globFetch);
}

/** Installs the window/global fetch interceptor for /v1/* requests. */
export function installDemoFetchInterceptor(): void {
  const win = isBrowser() ? window : undefined;
  const currentWinFetch = win?.fetch;
  const currentGlobalFetch = typeof globalThis !== "undefined" ? globalThis.fetch : undefined;

  if (isWrappedFetch(currentWinFetch) || isWrappedFetch(currentGlobalFetch)) {
    return;
  }

  const fallbackFetch = currentWinFetch ?? currentGlobalFetch;
  if (typeof fallbackFetch !== "function") {
    return;
  }

  savedWindowFetch = currentWinFetch ?? null;
  savedGlobalFetch = currentGlobalFetch ?? null;

  const demoFetch: MarkedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    const method = (
      init?.method ??
      (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")
    ).toUpperCase();

    const resolved = resolveDemoResponse(rawUrl, method);
    if (resolved !== null) {
      return new Response(JSON.stringify(resolved.body), {
        status: resolved.status,
        headers: {
          "Content-Type": "application/json",
          "X-M365-Demo": "true",
        },
      });
    }

    const original = savedWindowFetch ?? savedGlobalFetch ?? fallbackFetch;
    return original.call(win ?? globalThis, input, init);
  };

  demoFetch[DEMO_FETCH_MARKER] = true;

  if (win) {
    win.fetch = demoFetch;
  }
  if (typeof globalThis !== "undefined") {
    globalThis.fetch = demoFetch;
  }
}

/** Restores the original fetch implementation cleanly. */
export function uninstallDemoFetchInterceptor(): void {
  const win = isBrowser() ? window : undefined;

  if (typeof globalThis !== "undefined" && savedGlobalFetch !== null && isWrappedFetch(globalThis.fetch)) {
    globalThis.fetch = savedGlobalFetch;
  }
  if (win && savedWindowFetch !== null && isWrappedFetch(win.fetch)) {
    win.fetch = savedWindowFetch;
  }

  savedWindowFetch = null;
  savedGlobalFetch = null;
}
