/**
 * Live session updates
 *
 * Follows one conversation session over the WebSocket: new turns, signals
 * from your backend, and deletion. Tokens are single-use, so every
 * (re)connection asks your backend for a fresh one via `getSubscription`
 * (your backend calls `POST /v1/sessions/:id/subscribe` with its API key).
 */

import { Socket } from 'phoenix';
import type {
  SessionMessage,
  SessionSignal,
  SessionSubscription,
  SessionSubscriptionInfo,
  SessionSubscriptionOptions,
  SessionSubscriptionStatus,
} from './types';
import { DEFAULT_BASE_URL } from './utils';

/** Waits between reconnection attempts; the last one repeats. */
export const DEFAULT_SESSION_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

// Join failures that a new token won't fix.
const FINAL_JOIN_ERRORS = new Set(['session_not_found', 'unauthorized_session']);

function readInfo(info: SessionSubscriptionInfo) {
  const url = info.websocketUrl ?? info.websocket_url ?? DEFAULT_BASE_URL;
  return {
    socketUrl: url.endsWith('/socket') ? url : `${url}/socket`,
    token: info.wsToken ?? info.ws_token,
    topic: info.websocketChannel ?? info.websocket_channel,
  };
}

/**
 * Subscribe to a session's live updates.
 *
 * @example
 * ```typescript
 * const subscription = subscribeToSession({
 *   getSubscription: () => fetch('/api/chat/live', { method: 'POST' }).then((r) => r.json()),
 *   onMessage: (message) => addMessage(message),
 *   onLive: () => reloadHistory(), // after each (re)connection, catch up on anything missed
 * });
 * subscription.close();
 * ```
 */
export function subscribeToSession(options: SessionSubscriptionOptions): SessionSubscription {
  const delays = options.retryDelaysMs?.length ? options.retryDelaysMs : DEFAULT_SESSION_RETRY_DELAYS_MS;
  const log = (...args: unknown[]) => options.debug && console.log('[ModelRiver session]', ...args);

  let status: SessionSubscriptionStatus = 'connecting';
  let socket: Socket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  // Bumped whenever a connection is abandoned, so its late callbacks are ignored.
  let generation = 0;

  // A function, not an inline check: status changes in callbacks TypeScript can't see.
  const closed = () => status === 'closed';
  const setStatus = (next: SessionSubscriptionStatus) => {
    if (status === next) return;
    status = next;
    options.onStatus?.(next);
  };

  const dropSocket = () => {
    generation++;
    const old = socket;
    socket = null;
    // disconnect() also cancels phoenix's own reconnect, which would reuse the spent token.
    old?.disconnect();
  };

  const stop = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    dropSocket();
    setStatus('closed');
  };

  const retry = () => {
    if (closed()) return;
    dropSocket();
    const delay = delays[Math.min(attempt, delays.length - 1)]!;
    attempt++;
    setStatus('reconnecting');
    log(`reconnecting in ${delay}ms`);
    retryTimer = setTimeout(() => void open(), delay);
  };

  const fail = (error: unknown, final: boolean) => {
    options.onError?.(error instanceof Error ? error : new Error(String(error)));
    if (final) stop();
    else retry();
  };

  async function open() {
    retryTimer = null;
    if (closed()) return;
    const mine = ++generation;

    let info: SessionSubscriptionInfo | null;
    try {
      info = await options.getSubscription();
    } catch (error) {
      if (mine === generation) fail(error, false);
      return;
    }
    if (mine !== generation || closed()) return;
    // Nothing to follow (yet): the caller can subscribe again later.
    if (!info) return stop();

    const { socketUrl, token, topic } = readInfo(info);
    if (!token || !topic) return fail(new Error('getSubscription must return ws_token and websocket_channel'), true);

    const current = new Socket(socketUrl, { params: { token } });
    socket = current;
    let failed = false;
    const lost = (reason: string) => {
      if (failed || mine !== generation) return;
      failed = true;
      log('connection lost:', reason);
      retry();
    };
    current.onError(() => lost('socket error'));
    current.onClose(() => lost('socket closed'));

    const channel = current.channel(topic, {});
    channel.on('message', (payload: SessionMessage) => options.onMessage?.(payload));
    channel.on('signal', (payload: SessionSignal) => options.onSignal?.(payload));
    channel.on('deleted', (payload: { session_id: string }) => {
      options.onDeleted?.(payload);
      stop();
    });

    channel
      .join()
      .receive('ok', () => {
        if (mine !== generation) return;
        attempt = 0;
        setStatus('live');
        options.onLive?.();
      })
      .receive('error', (response: { reason?: string }) => {
        if (mine !== generation || failed) return;
        failed = true;
        const reason = response?.reason ?? 'join_failed';
        fail(new Error(`Could not join the session: ${reason}`), FINAL_JOIN_ERRORS.has(reason));
      })
      .receive('timeout', () => lost('join timeout'));

    current.connect();
  }

  options.onStatus?.(status);
  void open();

  return {
    close: stop,
    get status() {
      return status;
    },
  };
}
