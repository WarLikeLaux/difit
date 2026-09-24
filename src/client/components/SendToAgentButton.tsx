import { Loader2, Send } from 'lucide-react';
import { useEffect, useState } from 'react';

interface SendToAgentButtonProps {
  pendingCount: number;
  wakeOutstanding: boolean;
  /** ISO time when the queued wake fires on its own; drives the seconds countdown. */
  wakeScheduledAt?: string;
  isFlushing: boolean;
  isMobile: boolean;
  onFlush: () => void;
}

/**
 * Header button that wakes the attached agent immediately instead of waiting
 * for the batch debounce. Shows the pending event count and, while a wake is
 * scheduled, a seconds countdown until it fires on its own. The countdown
 * ticks inside this component so the rest of the app does not re-render
 * every second.
 */
export function SendToAgentButton({
  pendingCount,
  wakeOutstanding,
  wakeScheduledAt,
  isFlushing,
  isMobile,
  onFlush,
}: SendToAgentButtonProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!wakeScheduledAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [wakeScheduledAt]);

  const scheduledTime = wakeScheduledAt ? Date.parse(wakeScheduledAt) : Number.NaN;
  const remainingSeconds =
    Number.isFinite(scheduledTime) && wakeScheduledAt
      ? Math.max(0, Math.ceil((scheduledTime - now) / 1000))
      : null;

  return (
    <button
      type="button"
      data-testid="send-to-agent"
      onClick={onFlush}
      title={`${pendingCount} event(s) queued for the agent, including older ones it has not acknowledged yet. Click to wake it now instead of waiting for the batch window.`}
      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-2 text-xs transition-colors ${
        wakeOutstanding
          ? 'border-github-border text-github-text-secondary hover:bg-github-bg-tertiary hover:text-github-text-primary'
          : 'border-blue-500 bg-blue-500/10 text-github-text-primary hover:bg-blue-500/20'
      }`}
    >
      {wakeOutstanding || isFlushing ? (
        <Loader2 size={14} className="animate-spin" />
      ) : (
        <Send size={14} />
      )}
      <span className={`whitespace-nowrap ${isMobile ? 'sr-only' : undefined}`}>
        Send to agent ({pendingCount})
        {remainingSeconds !== null && remainingSeconds > 0 ? ` · ${remainingSeconds}s` : ''}
      </span>
    </button>
  );
}
