import { useEffect, useState } from 'react';

import { resolveApiUrl } from '../utils/apiUrl';

export interface AgentEventsStatus {
  pendingCount: number;
  wakeAvailable: boolean;
  wakeOutstanding: boolean;
  /** ISO time when the queued wake fires on its own; absent while none is scheduled. */
  wakeScheduledAt?: string;
}

interface UseAgentEventsStatusOptions {
  /** Bump to refetch immediately, e.g. after posting a comment or flushing. */
  refreshSignal?: number;
}

const POLL_INTERVAL_MS = 5_000;

function parseStatus(value: unknown): AgentEventsStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.pendingCount !== 'number' ||
    !Number.isInteger(candidate.pendingCount) ||
    candidate.pendingCount < 0 ||
    typeof candidate.wakeAvailable !== 'boolean'
  ) {
    return null;
  }
  return {
    pendingCount: candidate.pendingCount,
    wakeAvailable: candidate.wakeAvailable,
    wakeOutstanding: candidate.wakeOutstanding === true,
    wakeScheduledAt:
      typeof candidate.wakeScheduledAt === 'string' &&
      Number.isFinite(Date.parse(candidate.wakeScheduledAt))
        ? candidate.wakeScheduledAt
        : undefined,
  };
}

/**
 * Tracks how many review events are queued for the attached agent and whether
 * a wake is in flight. Returns null when the inbox is unavailable (no agent
 * attached, or the endpoint does not exist), so callers can hide the UI.
 */
export function useAgentEventsStatus({
  refreshSignal = 0,
}: UseAgentEventsStatusOptions = {}): AgentEventsStatus | null {
  const [status, setStatus] = useState<AgentEventsStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(resolveApiUrl('/api/agent-events/status'));
        const parsed = response.ok ? parseStatus(await response.json()) : null;
        if (!cancelled) setStatus(parsed);
      } catch {
        if (!cancelled) setStatus(null);
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refreshSignal]);

  return status;
}
