import { useCallback, useEffect, useRef, useState } from 'react';

import { DiffMode, type ClientWatchState, type WatchEvent } from '../../types/watch.js';
import { resolveEventSourceUrl } from '../utils/eventSourceUrl';

const AUTO_RELOAD_DELAY_MS = 200;

interface FileWatchHook {
  shouldReload: boolean;
  isConnected: boolean;
  error: string | null;
  reload: () => void;
  watchState: ClientWatchState;
}

export function useFileWatch(
  onReload?: () => Promise<void>,
  onCommentsChanged?: () => Promise<void>,
): FileWatchHook {
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const autoReloadTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reloadInFlightRef = useRef(false);
  const reloadQueuedRef = useRef(false);
  const onReloadRef = useRef(onReload);
  const autoReloadRef = useRef<() => void>(() => undefined);
  onReloadRef.current = onReload;
  const maxReconnectAttempts = 5;
  const reconnectDelay = 3000; // 3 seconds

  const [watchState, setWatchState] = useState<ClientWatchState>({
    isWatchEnabled: false,
    diffMode: DiffMode.DEFAULT,
    shouldReload: false,
    isReloading: false,
    lastChangeTime: null,
    lastChangeType: null,
    connectionStatus: 'disconnected',
  });

  const [error, setError] = useState<string | null>(null);

  const connectToWatch = useCallback(() => {
    if (eventSourceRef.current) {
      return; // Already connected
    }

    try {
      const eventSource = new EventSource(resolveEventSourceUrl('/api/watch'));
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        console.log('Connected to file watch service');
        setWatchState((prev) => ({
          ...prev,
          connectionStatus: 'connected',
        }));
        reconnectAttemptsRef.current = 0;
        setError(null);
      };

      eventSource.onmessage = (event) => {
        try {
          // oxlint-disable-next-line typescript/no-unsafe-assignment
          const data: WatchEvent = JSON.parse(event.data as string);

          switch (data.type) {
            case 'connected':
              setWatchState((prev) => ({
                ...prev,
                isWatchEnabled: true,
                diffMode: data.diffMode,
                connectionStatus: 'connected',
              }));
              break;

            case 'reload':
              console.log('File changes detected:', data.changeType);
              setWatchState((prev) => ({
                ...prev,
                shouldReload: !onReloadRef.current,
                lastChangeTime: new Date(),
                lastChangeType: data.changeType,
              }));
              if (onReloadRef.current) {
                if (autoReloadTimeoutRef.current) {
                  clearTimeout(autoReloadTimeoutRef.current);
                }
                autoReloadTimeoutRef.current = setTimeout(() => {
                  autoReloadTimeoutRef.current = null;
                  autoReloadRef.current();
                }, AUTO_RELOAD_DELAY_MS);
              }
              break;

            case 'error':
              console.error('File watch error:', data.message);
              setError(data.message || 'File watch error occurred');
              break;

            case 'commentsChanged':
              if (onCommentsChanged) {
                void onCommentsChanged();
              }
              break;
          }
        } catch (parseError) {
          console.error('Error parsing watch event:', parseError);
        }
      };

      eventSource.onerror = () => {
        console.log('File watch connection lost');
        setWatchState((prev) => ({
          ...prev,
          connectionStatus: 'disconnected',
        }));

        // Close the current connection
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
          eventSourceRef.current = null;
        }

        // Attempt to reconnect
        if (reconnectAttemptsRef.current < maxReconnectAttempts) {
          setWatchState((prev) => ({
            ...prev,
            connectionStatus: 'reconnecting',
          }));

          reconnectAttemptsRef.current += 1;

          reconnectTimeoutRef.current = setTimeout(() => {
            console.log(
              `Attempting to reconnect to file watch service (${reconnectAttemptsRef.current}/${maxReconnectAttempts})...`,
            );
            // oxlint-disable-next-line react-hooks-js/immutability -- connectToWatch is defined when setTimeout callback runs
            connectToWatch();
          }, reconnectDelay);
        } else {
          console.error('Max reconnection attempts reached');
          setError('Lost connection to file watch service');
        }
      };
    } catch (connectionError) {
      console.error('Failed to connect to file watch service:', connectionError);
      setError('Failed to connect to file watch service');
    }
  }, [maxReconnectAttempts, onCommentsChanged, reconnectDelay]);

  const handleReload = useCallback(async () => {
    if (reloadInFlightRef.current) {
      reloadQueuedRef.current = true;
      return;
    }
    reloadInFlightRef.current = true;

    setWatchState((prev) => ({
      ...prev,
      isReloading: true,
    }));

    try {
      if (onReloadRef.current) {
        await onReloadRef.current();
      }

      // Reset reload state after successful reload
      setWatchState((prev) => ({
        ...prev,
        shouldReload: false,
        isReloading: false,
        lastChangeTime: null,
        lastChangeType: null,
      }));
    } catch (reloadError) {
      console.error('Reload failed:', reloadError);
      setError('Failed to reload diff data');

      setWatchState((prev) => ({
        ...prev,
        shouldReload: true,
        isReloading: false,
      }));
    } finally {
      reloadInFlightRef.current = false;
      if (reloadQueuedRef.current) {
        reloadQueuedRef.current = false;
        queueMicrotask(() => autoReloadRef.current());
      }
    }
  }, []);
  autoReloadRef.current = () => void handleReload();

  const cleanup = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (autoReloadTimeoutRef.current) {
      clearTimeout(autoReloadTimeoutRef.current);
      autoReloadTimeoutRef.current = null;
    }
  };

  // Initialize connection
  useEffect(() => {
    connectToWatch();

    return cleanup;
  }, [connectToWatch]);

  // Cleanup on unmount
  useEffect(() => {
    return cleanup;
  }, []);

  return {
    shouldReload: watchState.shouldReload,
    isConnected: watchState.connectionStatus === 'connected',
    error,
    reload: handleReload,
    watchState,
  };
}
