// Client hook for subscribing to progress event SSE streams (EPIC-003 SPEC.md §3.4, §4.2, T-0044, T-0051).
// Subscribes to /v1/runs/:runId/events, enforces monotonic sequence deduplication,
// reconnects automatically on dropped connections, and handles terminal state transitions.

import { useEffect, useRef, useState, useCallback } from "react";
import {
  parseProgressEvent,
  type ProgressEvent,
  type RunState,
} from "@m365-assess/contracts/events";

export interface UseRunEventsOptions {
  /** Single run ID to stream progress events for */
  readonly runId?: string;
  /** Multiple run IDs to stream progress events for (concurrent multi-run streams) */
  readonly runIds?: readonly string[];
  /** Base API URL prefix (default: "") */
  readonly baseUrl?: string;
  /** Whether the SSE connection is active (default: true) */
  readonly enabled?: boolean;
  /** Callback fired for each valid, deduplicated progress event */
  readonly onEvent?: (event: ProgressEvent) => void;
  /** Callback fired on stream errors */
  readonly onError?: (error: unknown) => void;
  /** Milliseconds to wait before attempting reconnection on drop (default: 1000) */
  readonly reconnectIntervalMs?: number;
  /** Maximum number of reconnection attempts before stopping (default: 10) */
  readonly maxReconnectAttempts?: number;
  /** Optional custom EventSource constructor for DI/testing */
  readonly eventSourceImpl?: {
    new (url: string, eventSourceInitDict?: EventSourceInit): EventSource;
  };
}

export interface UseRunEventsResult {
  /** All received events (deduplicated by monotonic sequence per run) */
  readonly events: readonly ProgressEvent[];
  /** Most recently received valid event */
  readonly latestEvent: ProgressEvent | null;
  /** Whether at least one SSE stream is connected */
  readonly connected: boolean;
  /** Whether any stream is currently connecting or attempting reconnection */
  readonly connecting: boolean;
  /** Last error message, if any */
  readonly error: string | null;
  /** Total number of reconnection attempts */
  readonly reconnectCount: number;
  /** Manually trigger reconnection */
  readonly reconnect: () => void;
  /** Manually close all active streams */
  readonly close: () => void;
}

const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.has(state);
}

export function useRunEvents(options: UseRunEventsOptions = {}): UseRunEventsResult {
  const {
    runId,
    runIds,
    baseUrl = "",
    enabled = true,
    onEvent,
    onError,
    reconnectIntervalMs = 1000,
    maxReconnectAttempts = 10,
    eventSourceImpl,
  } = options;

  // Resolve target run IDs (either single runId or array of runIds)
  const targetRunIds: string[] = [];
  if (runId && runId.trim().length > 0) {
    targetRunIds.push(runId.trim());
  }
  if (runIds && Array.isArray(runIds)) {
    for (const id of runIds) {
      if (id && id.trim().length > 0 && !targetRunIds.includes(id.trim())) {
        targetRunIds.push(id.trim());
      }
    }
  }

  const [events, setEvents] = useState<readonly ProgressEvent[]>([]);
  const [latestEvent, setLatestEvent] = useState<ProgressEvent | null>(null);
  const [connected, setConnected] = useState<boolean>(false);
  const [connecting, setConnecting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [reconnectCount, setReconnectCount] = useState<number>(0);

  // Monotonic sequence tracking per run ID
  const lastSequenceMapRef = useRef<Map<string, number>>(new Map());
  // Active EventSource instances per run ID
  const activeSourcesRef = useRef<Map<string, EventSource>>(new Map());
  // Reconnect timers per run ID
  const reconnectTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Terminal runs set
  const terminalRunsRef = useRef<Set<string>>(new Set());
  // Keep latest callbacks in refs to avoid reconnection loops
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const closeRunStream = useCallback((id: string) => {
    const timer = reconnectTimersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      reconnectTimersRef.current.delete(id);
    }
    const es = activeSourcesRef.current.get(id);
    if (es) {
      try {
        es.close();
      } catch {
        // Ignore close errors
      }
      activeSourcesRef.current.delete(id);
    }
  }, []);

  const closeAll = useCallback(() => {
    for (const id of Array.from(activeSourcesRef.current.keys())) {
      closeRunStream(id);
    }
    for (const id of Array.from(reconnectTimersRef.current.keys())) {
      const timer = reconnectTimersRef.current.get(id);
      if (timer) clearTimeout(timer);
      reconnectTimersRef.current.delete(id);
    }
    setConnected(false);
    setConnecting(false);
  }, [closeRunStream]);

  // Handle incoming progress message payload
  const handleRawPayload = useCallback((raw: string | unknown) => {
    try {
      const parsed = parseProgressEvent(raw);
      const runIdKey = parsed.runId;
      const lastSeq = lastSequenceMapRef.current.get(runIdKey) ?? -1;

      // Monotonic sequence deduplication:
      // Drop if sequence is <= last seen sequence for this run
      if (parsed.sequence <= lastSeq) {
        return;
      }

      // Record highest monotonic sequence seen
      lastSequenceMapRef.current.set(runIdKey, parsed.sequence);

      // Check for terminal state
      if (isTerminalRunState(parsed.state)) {
        terminalRunsRef.current.add(runIdKey);
        closeRunStream(runIdKey);
      }

      setLatestEvent(parsed);
      setEvents((prev) => [...prev, parsed]);
      onEventRef.current?.(parsed);
    } catch (err) {
      // Discard invalid event format
      onErrorRef.current?.(err);
    }
  }, [closeRunStream]);

  // Connect single run SSE stream
  const connectRunStream = useCallback(
    (id: string, attempt: number = 0) => {
      // If run reached terminal state, do not connect or reconnect
      if (terminalRunsRef.current.has(id)) {
        return;
      }

      // Clean up any existing connection for this run
      closeRunStream(id);

      const ES = eventSourceImpl || (typeof window !== "undefined" ? window.EventSource : undefined);
      if (!ES) {
        setError("EventSource is not available in current environment");
        return;
      }

      setConnecting(true);
      const url = `${baseUrl}/v1/runs/${encodeURIComponent(id)}/events`;

      let esInstance: EventSource;
      try {
        esInstance = new ES(url);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        onErrorRef.current?.(err);
        return;
      }

      activeSourcesRef.current.set(id, esInstance);

      esInstance.onopen = () => {
        setConnected(true);
        setConnecting(false);
        setError(null);
      };

      const handleMessage = (e: MessageEvent) => {
        handleRawPayload(e.data);
      };

      // T-0044 BFF emits SSE with event: "progress", standard events may emit "message"
      esInstance.addEventListener("progress", handleMessage as EventListener);
      esInstance.addEventListener("message", handleMessage as EventListener);

      esInstance.onerror = (e) => {
        // Drop state
        activeSourcesRef.current.delete(id);
        try {
          esInstance.close();
        } catch {
          // Ignore
        }

        const isAnyOtherConnected = activeSourcesRef.current.size > 0;
        setConnected(isAnyOtherConnected);

        // Do not reconnect if terminal or disabled
        if (terminalRunsRef.current.has(id) || !enabled) {
          setConnecting(false);
          return;
        }

        if (attempt < maxReconnectAttempts) {
          setConnecting(true);
          setReconnectCount((c) => c + 1);
          const nextAttempt = attempt + 1;
          const timer = setTimeout(() => {
            connectRunStream(id, nextAttempt);
          }, reconnectIntervalMs);
          reconnectTimersRef.current.set(id, timer);
        } else {
          setConnecting(false);
          const errMsg = `Connection to run '${id}' closed after ${attempt} attempts`;
          setError(errMsg);
          onErrorRef.current?.(new Error(errMsg));
        }
      };
    },
    [baseUrl, closeRunStream, enabled, eventSourceImpl, handleRawPayload, maxReconnectAttempts, reconnectIntervalMs]
  );

  const reconnect = useCallback(() => {
    closeAll();
    setError(null);
    for (const id of targetRunIds) {
      terminalRunsRef.current.delete(id);
      connectRunStream(id, 0);
    }
  }, [closeAll, connectRunStream, targetRunIds]);

  // Main lifecycle effect
  useEffect(() => {
    if (!enabled || targetRunIds.length === 0) {
      closeAll();
      return;
    }

    for (const id of targetRunIds) {
      if (!activeSourcesRef.current.has(id) && !terminalRunsRef.current.has(id)) {
        connectRunStream(id, 0);
      }
    }

    // Clean up removed run IDs
    for (const existingId of Array.from(activeSourcesRef.current.keys())) {
      if (!targetRunIds.includes(existingId)) {
        closeRunStream(existingId);
      }
    }

    return () => {
      closeAll();
    };
  }, [enabled, targetRunIds.join(","), connectRunStream, closeRunStream, closeAll]);

  return {
    events,
    latestEvent,
    connected,
    connecting,
    error,
    reconnectCount,
    reconnect,
    close: closeAll,
  };
}
