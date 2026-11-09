/**
 * ModelRiver Client SDK
 * 
 * Core client class for connecting to ModelRiver's WebSocket-based AI response streaming.
 */

import { Socket, Channel } from 'phoenix';
import type {
  ModelRiverClientOptions,
  ConnectOptions,
  ReconnectInfo,
  ReconnectRequest,
  ModelRiverEventType,
  ModelRiverEventMap,
  ConnectionState,
  WorkflowStep,
  AIResponse,
  ModelRiverState,
  StreamStartPayload,
  StreamDeltaPayload,
  StreamDonePayload,
  StreamErrorPayload,
} from './types';
import {
  DEFAULT_BASE_URL,
  DEFAULT_STORAGE_KEY_PREFIX,
  DEFAULT_HEARTBEAT_INTERVAL,
  DEFAULT_REQUEST_TIMEOUT,
  DEFAULT_SESSION_RETRY_DELAYS_MS,
  DEFAULT_TOKEN_REFRESH_INTERVAL,
  LISTENING_TOKEN_USABLE_MS,
  RESUMABLE_REQUEST_MAX_AGE_MS,
  readInfo,
  retireSocket,
  saveActiveRequest,
  getActiveRequest,
  clearActiveRequest,
  createInitialSteps,
  updateStep,
  createLogger,
} from './utils';

/**
 * Statuses sent between steps of a backend pipeline workflow.
 * The workflow is still running, so the connection stays open until "completed".
 */
const PIPELINE_PROGRESS_STATUSES = new Set([
  'step_ready',
  'step_completed',
  'step_received',
  'callback_ai_started',
  'callback_ai_completed',
]);

/**
 * Join failures that a new token won't fix: stop instead of retrying.
 * Any other join failure drops the socket and reconnects with a new token.
 */
const FINAL_JOIN_ERRORS = new Set([
  'unauthorized_channel',
  'unauthorized_project_access',
  'unexpected_topic_format',
]);

/**
 * Consecutive fetched tokens (from getToken or apiBaseUrl) that may fail to
 * get the client joined before it gives up, so a broken token route or a
 * server that keeps refusing the join can't loop forever.
 */
const MAX_FETCHED_TOKEN_FAILURES = 3;

function isFinalJoinError(reason: string): boolean {
  return FINAL_JOIN_ERRORS.has(reason) || reason.startsWith('invalid_');
}

/** A single-use listening token the client hasn't spent yet. */
interface HeldToken {
  value: string;
  /** When ModelRiver issued it (ms); tokens expire 5 minutes later */
  issuedAt: number;
  /** Times a socket failed to open with it while the browser was online */
  failures: number;
  /** Fetched from getToken / apiBaseUrl (rather than a resume token) */
  fetched?: boolean;
}

/** The async request the client is following. */
interface RequestInfo {
  channelId: string;
  websocketUrl?: string;
  websocketChannel?: string;
}

type ResolvedOptions = Required<Omit<ModelRiverClientOptions, 'getToken'>> &
  Pick<ModelRiverClientOptions, 'getToken'>;

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * ModelRiver WebSocket Client
 * 
 * Connects to ModelRiver's Phoenix Channels for real-time AI response streaming.
 * 
 * @example
 * ```typescript
 * const client = new ModelRiverClient({
 *   baseUrl: 'wss://api.modelriver.com/socket',
 *   debug: true,
 * });
 * 
 * client.on('response', (data) => {
 *   console.log('AI Response:', data);
 * });
 * 
 * client.connect({ channelId: 'channel-id', wsToken: 'ws-token-from-api' });
 * ```
 */
export class ModelRiverClient {
  private options: ResolvedOptions;
  private socket: Socket | null = null;
  private channel: Channel | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionState: ConnectionState = 'disconnected';
  private steps: WorkflowStep[] = [];
  private response: AIResponse | null = null;
  private error: string | null = null;
  private currentWebsocketChannel: string | null = null;
  private isConnecting = false;
  private isCompleted = false; // Flag to track if workflow is completed, preventing reconnection
  private streamText = ''; // Text accumulated from stream_delta events
  private logger: ReturnType<typeof createLogger>;

  // Reconnection state
  /** The request being followed, kept so a reconnect can rejoin it */
  private request: RequestInfo | null = null;
  /** The next token to connect with: the latest resume token, not yet used */
  private heldToken: HeldToken | null = null;
  /** Tokens already spent (or given up on); never sent again */
  private usedTokens = new Set<string>();
  /** True once the request ended (terminal response, final error, manual disconnect) */
  private stopped = true;
  /** True once the channel was joined for the current request */
  private hasJoined = false;
  private retryAttempt = 0;
  /** Consecutive fetched tokens that failed to get the client joined */
  private fetchedTokenFailures = 0;
  /** When the client last stopped being joined (null while joined) */
  private unjoinedSince: number | null = null;
  /** Bumped whenever a connection is abandoned, so its late callbacks are ignored */
  private generation = 0;

  // Event listeners
  private listeners: Map<ModelRiverEventType, Set<Function>> = new Map();

  constructor(options: ModelRiverClientOptions = {}) {
    this.options = {
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      debug: options.debug ?? false,
      persist: options.persist ?? true,
      storageKeyPrefix: options.storageKeyPrefix ?? DEFAULT_STORAGE_KEY_PREFIX,
      heartbeatInterval: options.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL,
      requestTimeout: options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT,
      // Optional HTTP base URL for the legacy reconnect route
      apiBaseUrl: options.apiBaseUrl ?? '',
      getToken: options.getToken,
      retryDelaysMs: options.retryDelaysMs?.length ? options.retryDelaysMs : DEFAULT_SESSION_RETRY_DELAYS_MS,
      tokenRefreshInterval: options.tokenRefreshInterval ?? DEFAULT_TOKEN_REFRESH_INTERVAL,
    };

    this.logger = createLogger(this.options.debug);
    // Options hold no secrets, but log only what helps debugging
    this.logger.log('Client initialized with options:', {
      baseUrl: this.options.baseUrl,
      persist: this.options.persist,
      storageKeyPrefix: this.options.storageKeyPrefix,
      apiBaseUrl: this.options.apiBaseUrl || undefined,
      getToken: Boolean(this.options.getToken),
      retryDelaysMs: this.options.retryDelaysMs,
      tokenRefreshInterval: this.options.tokenRefreshInterval,
    });
  }

  /**
   * Get current client state
   */
  getState(): ModelRiverState {
    return {
      connectionState: this.connectionState,
      isConnected: this.connectionState === 'connected',
      isConnecting: this.isConnecting,
      steps: [...this.steps],
      response: this.response,
      error: this.error,
      hasPendingRequest: this.hasPendingRequest(),
      isCompleted: this.isCompleted,
      streamText: this.streamText,
    };
  }

  /**
   * Check if there's a pending request that can be reconnected
   */
  hasPendingRequest(): boolean {
    if (!this.options.persist) return false;
    return this.getStoredRequest() !== null;
  }

  /**
   * Connect to WebSocket with channel ID
   */
  connect(options: ConnectOptions): void {
    const { channelId, wsToken, websocketUrl, websocketChannel } = options;

    if (!channelId) {
      const errorMsg = 'channelId is required';
      this.setError(errorMsg);
      this.emit('error', errorMsg);
      return;
    }

    if (!wsToken) {
      const errorMsg = 'wsToken is required for WebSocket authentication';
      this.setError(errorMsg);
      this.emit('error', errorMsg);
      return;
    }

    // A second connect() for the request already being (re)connected is a no-op;
    // a different request replaces it
    if (this.isConnecting && !this.stopped && this.request?.channelId === channelId) {
      this.logger.warn('Connection already in progress, skipping...');
      return;
    }

    this.isConnecting = true;
    this.connectionState = 'connecting';
    this.emit('connecting');

    // Clean up any existing connection and pending retries
    this.stopTimers();
    this.cleanupConnection();

    // A new request: start from scratch
    this.steps = createInitialSteps();
    this.error = null;
    this.response = null;
    this.isCompleted = false; // Reset completed flag for new connection
    this.streamText = '';
    this.startRequest({ channelId, websocketUrl, websocketChannel });

    // Save to localStorage for persistence
    this.persistToken(wsToken);

    // Update queue step to pending
    this.updateStepAndEmit('queue', { status: 'pending' });

    this.openSocket({ value: wsToken, issuedAt: Date.now(), failures: 0 });
  }

  /**
   * Reset the reconnection state for a request the client starts following
   */
  private startRequest(request: RequestInfo): void {
    this.request = request;
    this.currentWebsocketChannel = request.websocketChannel || `ai_response:${request.channelId}`;
    this.heldToken = null;
    this.usedTokens.clear();
    this.stopped = false;
    this.hasJoined = false;
    this.retryAttempt = 0;
    this.fetchedTokenFailures = 0;
    this.unjoinedSince = Date.now();
  }

  /**
   * Open a socket with a single-use token. Used by `connect()` and by every
   * reconnect; unlike `connect()` it keeps steps, response and streamed text.
   */
  private openSocket(token: HeldToken): void {
    if (!this.request) return;

    const reconnecting = this.connectionState === 'reconnecting';
    this.cleanupConnection();
    const mine = ++this.generation;
    this.isConnecting = true;
    this.connectionState = reconnecting ? 'reconnecting' : 'connecting';

    const { socketUrl } = readInfo({ websocketUrl: this.request.websocketUrl }, this.options.baseUrl);
    this.logger.log('Connecting to:', socketUrl);

    // Pass token to Phoenix Socket for authentication
    const socket = new Socket(socketUrl, {
      params: { token: token.value },
    });
    this.socket = socket;

    let opened = false;
    let lost = false;
    const onLost = (reason: string) => {
      if (lost || mine !== this.generation) return;
      lost = true;
      this.handleConnectionLost(reason, token, opened);
    };

    socket.onOpen(() => {
      if (mine !== this.generation) return;
      this.logger.log('Socket connected');
      // The server consumed the token when it accepted the socket: never send it again
      opened = true;
      this.usedTokens.add(token.value);
      if (this.heldToken?.value === token.value) this.heldToken = null;
      // Mark it spent in storage, unless another tab has stored a newer token since
      if (this.options.persist) {
        const stored = getActiveRequest(this.options.storageKeyPrefix, Number.POSITIVE_INFINITY);
        if (!stored || stored.wsToken === token.value) this.persistToken('');
      }

      this.connectionState = 'connected';
      this.isConnecting = false;
      this.emit('connected');

      // Join channel
      this.joinChannel(this.currentWebsocketChannel!, mine, onLost);
    });

    socket.onError((error: unknown) => {
      if (mine !== this.generation) return;
      this.logger.warn('Socket error:', error instanceof Error ? error.message : 'connection error');
      onLost('socket error');
    });

    socket.onClose(() => {
      if (mine !== this.generation) return;
      this.logger.log('Socket closed');
      onLost('socket closed');
    });

    socket.connect();
  }

  /**
   * Join the Phoenix channel
   */
  private joinChannel(
    topic: string,
    mine: number = this.generation,
    onLost: (reason: string) => void = () => {}
  ): void {
    if (!this.socket) return;

    this.logger.log('Joining channel:', topic);
    const channel = this.socket.channel(topic, {});
    this.channel = channel;

    channel.join()
      .receive('ok', (reply?: { resume_token?: unknown }) => {
        if (mine !== this.generation) return;
        this.logger.log('Channel joined successfully');
        this.retryAttempt = 0;
        this.fetchedTokenFailures = 0;
        this.unjoinedSince = null;

        // Older servers and console sockets send no resume token
        const hasResumeToken = this.storeResumeToken(reply?.resume_token);

        if (!this.hasJoined) {
          this.hasJoined = true;
          this.updateStepAndEmit('queue', { status: 'success', duration: 100 });
          this.updateStepAndEmit('process', { status: 'pending' });
          this.updateStepAndEmit('receive', { status: 'pending' });
        }
        this.emit('channel_joined');
        this.startHeartbeat();
        if (hasResumeToken) this.startTokenRefresh(channel, mine);
      })
      .receive('error', (error: { reason?: string }) => {
        if (mine !== this.generation) return;
        const reason = error?.reason || 'unknown';
        this.logger.error('Channel join failed:', reason);
        this.emit('channel_error', reason);

        if (isFinalJoinError(reason)) {
          let errorMsg = `Channel join failed: ${reason}`;
          if (reason === 'unauthorized_project_access') {
            errorMsg = 'Unauthorized: You do not have access to this project';
          } else if (reason === 'unauthorized_channel') {
            errorMsg = 'Unauthorized: this token cannot join this channel';
          } else if (reason === 'invalid_channel_format') {
            errorMsg = 'Invalid channel format';
          } else if (reason === 'invalid_project_uuid' || reason === 'invalid_channel_uuid') {
            errorMsg = 'Invalid project or channel ID';
          }
          this.fail(errorMsg);
          return;
        }

        // Phoenix would rejoin this socket on its own forever; reconnect with backoff instead
        onLost(`join failed: ${reason}`);
      })
      .receive('timeout', () => {
        if (mine !== this.generation) return;
        onLost('join timeout');
      });

    // Listen for AI response
    channel.on('response', (payload: AIResponse) => {
      if (mine !== this.generation) return;
      this.logger.log('AI Response received:', payload);
      this.handleResponse(payload);
    });

    // Listen for errors
    channel.on('error', (payload: { message?: string }) => {
      if (mine !== this.generation) return;
      const errorMsg = payload?.message || 'An error occurred';
      this.logger.error('Channel error:', errorMsg);
      this.handleError(errorMsg);
    });

    // Token streaming (requests sent with `stream: true`). The final `response`
    // event still follows `stream_done` / `stream_error` and closes the request.
    channel.on('stream_start', (payload: StreamStartPayload) => {
      if (mine !== this.generation) return;
      this.logger.log('Stream started:', payload);
      this.streamText = '';
      this.emit('stream_start', payload);
    });

    channel.on('stream_delta', (payload: StreamDeltaPayload) => {
      if (mine !== this.generation) return;
      this.streamText += payload?.text ?? '';
      this.emit('stream_delta', payload, this.streamText);
    });

    channel.on('stream_done', (payload: StreamDonePayload) => {
      if (mine !== this.generation) return;
      this.logger.log('Stream done:', payload?.finish_reason);
      if (typeof payload?.accumulated_text === 'string') {
        this.streamText = payload.accumulated_text;
      }
      this.emit('stream_done', payload);
    });

    channel.on('stream_error', (payload: StreamErrorPayload) => {
      if (mine !== this.generation) return;
      this.logger.error('Stream error:', payload?.message);
      this.emit('stream_error', payload);
    });
  }

  /**
   * Keep a resume token from the server in memory and in storage.
   * Returns false when the value isn't a token.
   */
  private storeResumeToken(value: unknown): boolean {
    if (typeof value !== 'string' || !value) return false;
    this.heldToken = { value, issuedAt: Date.now(), failures: 0 };
    this.persistToken(value);
    return true;
  }

  /**
   * Ask the server for a fresh resume token every `tokenRefreshInterval`, so
   * the one held is never close to its 5-minute expiry.
   */
  private startTokenRefresh(channel: Channel, mine: number): void {
    this.stopTokenRefresh();
    const interval = this.options.tokenRefreshInterval;
    if (!(interval > 0)) return;

    this.refreshTimer = setInterval(() => {
      if (mine !== this.generation || this.stopped) {
        this.stopTokenRefresh();
        return;
      }
      channel
        .push('refresh_token', {})
        .receive('ok', (reply?: { resume_token?: unknown }) => {
          if (mine !== this.generation || this.stopped) return;
          this.storeResumeToken(reply?.resume_token);
        })
        .receive('error', (reply?: { reason?: string }) => {
          // "not_supported" (not a token socket) or "unhandled_event" (older server)
          if (mine !== this.generation) return;
          this.logger.log('Token refresh unavailable:', reply?.reason ?? 'unknown');
          this.stopTokenRefresh();
        });
    }, interval);
  }

  private stopTokenRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * The socket closed or failed, or the join failed, before the request ended
   */
  private handleConnectionLost(reason: string, token: HeldToken, opened: boolean): void {
    if (this.stopped || this.isCompleted) {
      this.cleanupConnection();
      return;
    }
    this.logger.log('Connection lost:', reason);
    // The hour without a join counts from when the connection was lost, not from the last join
    if (this.unjoinedSince === null) this.unjoinedSince = Date.now();

    // A socket that never opened didn't spend its token: it can be tried again.
    // While online that may mean the server refused it, so count the failure.
    if (!opened && !this.usedTokens.has(token.value)) {
      if (!isOffline()) token.failures++;
      if (!this.heldToken) this.heldToken = token;
    }

    // A fetched token that was refused (or got a failed join) while online
    const refused = !opened || reason.startsWith('join');
    if (token.fetched && refused && !isOffline()) {
      this.fetchedTokenFailures++;
      if (this.fetchedTokenFailures >= MAX_FETCHED_TOKEN_FAILURES) {
        this.fail(
          `Could not rejoin the request: ${this.fetchedTokenFailures} new tokens in a row were refused`
        );
        return;
      }
    }

    // disconnect() also cancels phoenix's own reconnect, which would reuse the spent token
    this.cleanupConnection();
    this.emit('disconnected', 'Connection lost');
    this.scheduleReconnect();
  }

  /**
   * Wait (with backoff), then reconnect with a new token
   */
  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.clearRetryTimer();

    // However retries fail (including a getToken that keeps throwing), stop once
    // the client has gone this long without being joined
    const unjoinedSince = this.unjoinedSince ?? Date.now();
    if (Date.now() - unjoinedSince >= RESUMABLE_REQUEST_MAX_AGE_MS) {
      this.fail('Could not reconnect to the request within an hour');
      return;
    }

    const delays = this.options.retryDelaysMs;
    const delay = delays[Math.min(this.retryAttempt, delays.length - 1)]!;
    this.retryAttempt++;
    this.connectionState = 'reconnecting';
    this.isConnecting = false;
    this.logger.log(`Reconnecting in ${delay}ms (attempt ${this.retryAttempt})`);
    this.emit('reconnecting', this.retryAttempt, delay);
    this.retryTimer = setTimeout(() => void this.attemptReconnect(), delay);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * Find a token and reconnect. Sources, in order:
   * 1. the resume token held in memory or storage (each one used once);
   * 2. `getToken`;
   * 3. the legacy `apiBaseUrl` route.
   * With none left, stop with an error instead of looping.
   */
  private async attemptReconnect(): Promise<void> {
    this.retryTimer = null;
    if (this.stopped || !this.request) return;
    const mine = ++this.generation;

    const held = this.takeUsableToken();
    if (held) {
      this.openSocket(held);
      return;
    }

    const request: ReconnectRequest = {
      channelId: this.request.channelId,
      websocketChannel: this.request.websocketChannel,
    };

    let fetchToken: (() => Promise<ReconnectInfo | null>) | null = null;
    if (this.options.getToken) {
      const getToken = this.options.getToken;
      fetchToken = () => getToken(request);
    } else if (this.options.apiBaseUrl) {
      fetchToken = () => this.fetchLegacyToken(request.channelId);
    }

    if (!fetchToken) {
      this.fail(
        'Connection lost and the client has no way to get a new token. ' +
          'Pass getToken to ModelRiverClient to reconnect after longer gaps.'
      );
      return;
    }

    this.isConnecting = true;
    let info: ReconnectInfo | null;
    try {
      info = await fetchToken();
    } catch (error) {
      if (mine !== this.generation || this.stopped) return;
      this.logger.warn('Could not fetch a new token:', error instanceof Error ? error.message : 'unknown error');
      this.scheduleReconnect();
      return;
    }
    if (mine !== this.generation || this.stopped) return;

    if (!info) {
      this.fail('Connection lost and the request is no longer available');
      return;
    }

    const { token, topic } = readInfo(info, this.options.baseUrl);
    if (!token) {
      this.fail('getToken must return ws_token (the /api/v1/ai/reconnect response)');
      return;
    }

    const websocketUrl = info.websocketUrl ?? info.websocket_url;
    this.request = {
      channelId: this.request.channelId,
      websocketUrl: websocketUrl ?? this.request.websocketUrl,
      websocketChannel: topic ?? this.request.websocketChannel,
    };
    if (topic) this.currentWebsocketChannel = topic;
    this.persistToken(token);
    this.openSocket({ value: token, issuedAt: Date.now(), failures: 0, fetched: true });
  }

  /**
   * The held (or stored) resume token, if one is still worth trying
   */
  private takeUsableToken(): HeldToken | null {
    const canFetch = this.hasTokenSource();
    const usable = (token: HeldToken) =>
      !this.usedTokens.has(token.value) &&
      Date.now() - token.issuedAt < LISTENING_TOKEN_USABLE_MS &&
      // A token that failed to open while online was probably refused: with a
      // way to fetch a new one, move on; without, keep trying until it expires.
      (token.failures === 0 || !canFetch);

    const held = this.heldToken;
    this.heldToken = null;
    if (held) {
      if (usable(held)) return held;
      this.usedTokens.add(held.value);
    }

    // After a reload, or a token another tab of this request stored
    if (this.options.persist && this.request) {
      const stored = this.getStoredRequest();
      if (stored?.wsToken && stored.channelId === this.request.channelId) {
        const token = { value: stored.wsToken, issuedAt: stored.timestamp, failures: 0 };
        if (usable(token)) return token;
      }
    }
    return null;
  }

  private hasTokenSource(): boolean {
    return Boolean(this.options.getToken || this.options.apiBaseUrl);
  }

  /**
   * The legacy route: POST `${apiBaseUrl}/api/v1/ai/reconnect` on your backend.
   * 404 means the request is gone (null); other failures throw so the client retries.
   */
  private async fetchLegacyToken(channelId: string): Promise<ReconnectInfo | null> {
    const base = this.options.apiBaseUrl.replace(/\/+$/, '');
    const response = await fetch(`${base}/api/v1/ai/reconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: channelId }),
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Backend reconnect failed with HTTP status ${response.status}`);
    }
    return (await response.json()) as ReconnectInfo;
  }

  /**
   * Stop for good: no further reconnect attempts
   */
  private fail(errorMsg: string): void {
    this.stopped = true;
    this.stopTimers();
    this.cleanupConnection();
    this.heldToken = null;
    this.isConnecting = false;
    this.connectionState = 'error';

    if (this.options.persist) {
      clearActiveRequest(this.options.storageKeyPrefix);
    }

    this.setError(errorMsg);
    const queue = this.steps.find((s) => s.id === 'queue');
    const stepId = queue && queue.status === 'success' ? 'receive' : 'queue';
    this.updateStepAndEmit(stepId, { status: 'error', errorMessage: errorMsg });
    this.emit('error', errorMsg);
  }

  /**
   * Save the request with the token to use next ('' once it's spent)
   */
  private persistToken(token: string): void {
    if (!this.options.persist || !this.request) return;
    saveActiveRequest(
      this.options.storageKeyPrefix,
      this.request.channelId,
      token,
      this.request.websocketUrl,
      this.request.websocketChannel
    );
  }

  /**
   * The stored request. It stays resumable for longer when the client can
   * fetch new tokens; otherwise only as long as its token lives.
   */
  private getStoredRequest() {
    const maxAge = this.hasTokenSource() ? RESUMABLE_REQUEST_MAX_AGE_MS : DEFAULT_REQUEST_TIMEOUT;
    return getActiveRequest(this.options.storageKeyPrefix, maxAge);
  }

  /**
   * Handle AI response
   */
  private handleResponse(payload: AIResponse): void {
    // Handle event-driven workflow: ai_generated status (intermediate state)
    if (payload.status === 'ai_generated') {
      const aiGeneratedTimestamp = new Date().toISOString();
      this.logger.log(`AI generated at ${aiGeneratedTimestamp}, waiting for backend callback`);
      this.logger.log(`Channel ID: ${payload.channel_id || 'N/A'}`);
      this.logger.log(`Event name: ${payload.event_name || 'N/A'}`);
      this.logger.log(`Duration: ${payload.meta?.duration_ms || 'N/A'}ms`);
      this.logger.log('WebSocket connection will remain open until callback is received');

      // AI processing is complete
      // Use payload.meta?.duration_ms since ai_response is no longer included in ai_generated status
      this.updateStepAndEmit('process', {
        status: 'success',
        duration: payload.meta?.duration_ms
      });

      // Add backend processing step if it doesn't exist
      const hasBackendStep = this.steps.some(s => s.id === 'backend');
      if (!hasBackendStep) {
        this.steps.push({
          id: 'backend',
          name: 'Backend processing...',
          status: 'pending'
        });
      }
      this.updateStepAndEmit('backend', {
        status: 'pending',
        name: 'Waiting for backend callback...'
      });

      // Store intermediate response but don't mark as complete
      this.response = payload;

      // Emit response event so consumers can see the ai_generated status
      this.emit('response', payload);

      // Don't close connection - keep waiting for final success/completed status
      return;
    }

    // Handle backend pipeline progress statuses (intermediate states between steps)
    if (PIPELINE_PROGRESS_STATUSES.has(payload.status)) {
      this.logger.log(`Pipeline progress: ${payload.status}`);
      this.logger.log(`Step: ${payload.event_name || 'N/A'} (${payload.step_index ?? 'N/A'}/${payload.total_steps ?? 'N/A'})`);

      this.updateStepAndEmit('process', { status: 'success' });

      const hasBackendStep = this.steps.some(s => s.id === 'backend');
      if (!hasBackendStep) {
        this.steps.push({
          id: 'backend',
          name: 'Backend processing...',
          status: 'pending'
        });
      }
      this.updateStepAndEmit('backend', {
        status: 'pending',
        name: payload.message || 'Backend processing...'
      });

      // Store intermediate response but don't mark as complete
      this.response = payload;

      this.emit('response', payload);

      // Don't close connection - keep waiting for the final completed status
      return;
    }

    // Handle completed status (after callback in event-driven workflows)
    if (payload.status === 'completed') {
      const completedTimestamp = new Date().toISOString();
      this.logger.log(`Workflow completed via callback at ${completedTimestamp}`);
      this.logger.log(`Channel ID: ${payload.channel_id || 'N/A'}`);
      this.logger.log(`Task ID: ${payload.task_id || 'N/A'}`);

      this.updateStepAndEmit('process', { status: 'success' });
      this.updateStepAndEmit('backend', { status: 'success', name: 'Backend processed' });
      this.updateStepAndEmit('receive', { status: 'success', duration: 50 });
      this.updateStepAndEmit('complete', { status: 'success' });
      this.response = payload;

      // Mark workflow as completed to prevent reconnection attempts
      this.isCompleted = true;
      this.finishRequest();

      // Clear active request from localStorage BEFORE emitting response
      // This prevents auto-reconnection attempts after completion
      if (this.options.persist) {
        clearActiveRequest(this.options.storageKeyPrefix);
      }

      // Emit response event
      this.emit('response', payload);

      // Close connection immediately when status is completed
      const closeTimestamp = new Date().toISOString();
      this.logger.log(`Closing websocket connection immediately at ${closeTimestamp} (status: completed)`);
      this.cleanupConnection();
      return;
    }

    // Handle standard success status
    const isSuccess =
      payload.status === 'success' ||
      payload.status === 'SUCCESS' ||
      payload.meta?.status === 'success' ||
      payload.status === 'ok';

    if (isSuccess) {
      // Mark workflow as completed to prevent reconnection attempts
      // "success" status indicates workflow completion (standard workflows)
      this.isCompleted = true;

      // If we were waiting for callback, mark backend as success
      const hasBackendStep = this.steps.some(s => s.id === 'backend');
      if (hasBackendStep) {
        this.updateStepAndEmit('backend', { status: 'success', name: 'No backend processing needed' });
      }

      this.updateStepAndEmit('process', { status: 'success', duration: payload.meta?.duration_ms });
      this.updateStepAndEmit('receive', { status: 'success', duration: 50 });
      this.updateStepAndEmit('complete', { status: 'success' });
      this.response = payload;
    } else {
      const errorMsg = payload.error?.message || 'Unknown error';
      this.updateStepAndEmit('process', { status: 'error', errorMessage: errorMsg });
      this.updateStepAndEmit('receive', { status: 'error' });
      this.updateStepAndEmit('complete', { status: 'error' });
      this.setError(errorMsg);
    }

    // A final response (success or error): the server revoked the resume token
    this.finishRequest();

    // Clear active request from localStorage
    if (this.options.persist) {
      clearActiveRequest(this.options.storageKeyPrefix);
    }

    // Emit response event
    this.emit('response', payload);

    // Close connection immediately for success status (same as completed)
    // This prevents any reconnection attempts
    this.cleanupConnection();
  }

  /**
   * Handle error
   */
  private handleError(errorMsg: string): void {
    this.setError(errorMsg);
    this.updateStepAndEmit('process', { status: 'error', errorMessage: errorMsg });
    this.emit('error', errorMsg);

    if (this.options.persist) {
      clearActiveRequest(this.options.storageKeyPrefix);
    }
  }

  /**
   * The request reached its final response: stop timers and never reconnect
   */
  private finishRequest(): void {
    this.stopped = true;
    this.stopTimers();
    this.heldToken = null;
    this.isConnecting = false;
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    this.logger.log('Disconnecting...');
    this.stopped = true;
    this.isConnecting = false;
    this.stopTimers();
    this.cleanupConnection();
    this.heldToken = null;

    if (this.options.persist) {
      clearActiveRequest(this.options.storageKeyPrefix);
    }

    this.emit('disconnected', 'Manual disconnect');
  }

  /**
   * Stop following the request in this client without ending it: closes the
   * socket and stops all timers, but keeps the stored request and resume token
   * so another client (a remounted component, a reloaded page) can resume it.
   * The framework adapters call this on unmount while a request is pending.
   */
  detach(): void {
    this.logger.log('Detaching...');
    this.stopped = true;
    this.isConnecting = false;
    this.stopTimers();
    this.cleanupConnection();
    this.heldToken = null;
  }

  /**
   * Reset state and clear stored data
   */
  reset(): void {
    this.logger.log('Resetting...');
    this.disconnect();
    this.steps = [];
    this.response = null;
    this.error = null;
    this.currentWebsocketChannel = null;
    this.request = null;
    this.usedTokens.clear();
  }

  /**
   * Resume the request saved in localStorage (call it on page load).
   *
   * Reconnects with the stored resume token. If that token is missing, stale
   * or refused, the client asks `getToken` (or the legacy `apiBaseUrl` route)
   * for a new one. Returns true when a reconnection attempt started.
   */
  reconnect(): boolean {
    if (!this.options.persist) {
      this.logger.warn('Persistence is disabled, cannot reconnect');
      return false;
    }

    // Prevent reconnection if workflow is already completed
    if (this.isCompleted) {
      this.logger.log('Workflow is already completed, preventing reconnection');
      clearActiveRequest(this.options.storageKeyPrefix);
      return false;
    }

    // Check if current response is completed or success (both indicate workflow completion)
    const responseStatus = this.response?.status || this.response?.meta?.status;
    if (responseStatus === 'completed' || responseStatus === 'success' || responseStatus === 'SUCCESS') {
      this.logger.log(`Response status is ${responseStatus}, preventing reconnection`);
      this.isCompleted = true;
      clearActiveRequest(this.options.storageKeyPrefix);
      return false;
    }

    const activeRequest = this.getStoredRequest();
    if (!activeRequest) {
      this.logger.log('No active request found for reconnection');
      return false;
    }

    const hasFreshToken =
      Boolean(activeRequest.wsToken) && Date.now() - activeRequest.timestamp < LISTENING_TOKEN_USABLE_MS;
    if (!hasFreshToken && !this.hasTokenSource()) {
      this.logger.warn('No usable token stored and no getToken configured, cannot reconnect');
      clearActiveRequest(this.options.storageKeyPrefix);
      return false;
    }

    this.logger.log('Reconnecting to the stored request...');
    this.resumeStoredRequest(activeRequest);
    return true;
  }

  /**
   * Start following a stored request again, keeping any steps already shown
   */
  private resumeStoredRequest(
    activeRequest: {
      channelId: string;
      websocketUrl?: string;
      websocketChannel?: string;
    },
    freshToken?: string
  ): void {
    this.stopTimers();
    this.cleanupConnection();
    this.error = null;
    this.startRequest({
      channelId: activeRequest.channelId,
      websocketUrl: activeRequest.websocketUrl,
      websocketChannel: activeRequest.websocketChannel,
    });

    this.isConnecting = true;
    this.connectionState = 'connecting';
    this.emit('connecting');
    if (this.steps.length === 0) {
      this.steps = createInitialSteps();
      this.updateStepAndEmit('queue', { status: 'pending' });
    }

    if (freshToken) {
      this.persistToken(freshToken);
      this.openSocket({ value: freshToken, issuedAt: Date.now(), failures: 0, fetched: true });
    } else {
      void this.attemptReconnect();
    }
  }

  /**
   * Resume the stored request with a token from the legacy `apiBaseUrl` route.
   *
   * @deprecated Use `reconnect()` with the `getToken` option. `reconnect()`
   * also falls back to `apiBaseUrl` on its own when `getToken` isn't set.
   *
   * Returns `true` if a reconnection attempt was started, `false` if no
   * pending request was found or configuration was missing.
   */
  async reconnectWithBackend(): Promise<boolean> {
    if (!this.options.persist) {
      this.logger.warn('Persistence is disabled, cannot reconnect with backend');
      return false;
    }

    if (!this.options.apiBaseUrl) {
      this.logger.warn('apiBaseUrl is not configured, cannot call /api/v1/ai/reconnect');
      return false;
    }

    const activeRequest = this.getStoredRequest();
    if (!activeRequest) {
      this.logger.log('No active request found for backend reconnection');
      return false;
    }

    let info: ReconnectInfo | null;
    try {
      info = await this.fetchLegacyToken(activeRequest.channelId);
    } catch (error) {
      this.logger.error('Backend reconnect request failed:', error instanceof Error ? error.message : 'unknown error');
      return false;
    }

    const { token, topic } = readInfo(info ?? {}, this.options.baseUrl);
    if (!info || !token) {
      this.logger.error('Backend reconnect returned no ws_token');
      return false;
    }

    // Use the fresh token right away instead of any stored one
    this.resumeStoredRequest(
      {
        channelId: activeRequest.channelId,
        websocketUrl: info.websocketUrl ?? info.websocket_url ?? activeRequest.websocketUrl,
        websocketChannel: topic ?? activeRequest.websocketChannel,
      },
      token
    );
    return true;
  }

  /**
   * Add event listener
   */
  on<K extends ModelRiverEventType>(
    event: K,
    callback: ModelRiverEventMap[K]
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);

    // Return unsubscribe function
    return () => {
      this.listeners.get(event)?.delete(callback);
    };
  }

  /**
   * Remove event listener
   */
  off<K extends ModelRiverEventType>(
    event: K,
    callback: ModelRiverEventMap[K]
  ): void {
    this.listeners.get(event)?.delete(callback);
  }

  /**
   * Emit event to listeners
   */
  private emit<K extends ModelRiverEventType>(
    event: K,
    ...args: Parameters<ModelRiverEventMap[K]>
  ): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach((callback) => {
        try {
          (callback as Function)(...args);
        } catch (err) {
          this.logger.error(`Error in ${event} listener:`, err);
        }
      });
    }
  }

  /**
   * Update step and emit event
   */
  private updateStepAndEmit(id: string, updates: Partial<WorkflowStep>): void {
    this.steps = updateStep(this.steps, id, updates);
    const step = this.steps.find((s) => s.id === id);
    if (step) {
      this.emit('step', step);
    }
  }

  /**
   * Set error state
   */
  private setError(error: string): void {
    this.error = error;
  }

  /**
   * Start heartbeat
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.channel) {
        this.channel.push('heartbeat', {});
      }
    }, this.options.heartbeatInterval);
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Stop the heartbeat, token refresh and pending reconnect
   */
  private stopTimers(): void {
    this.stopHeartbeat();
    this.stopTokenRefresh();
    this.clearRetryTimer();
  }

  /**
   * Clean up connection resources
   */
  private cleanupConnection(): void {
    this.stopHeartbeat();
    this.stopTokenRefresh();

    // Ignore late callbacks from the socket being dropped (including the
    // close event that disconnect() itself triggers)
    this.generation++;

    if (this.channel) {
      try {
        this.channel.leave();
      } catch {
        // Ignore errors during cleanup
      }
      this.channel = null;
    }

    if (this.socket) {
      try {
        // Also cancels phoenix's own reconnect, which would resend a spent token
        retireSocket(this.socket);
      } catch {
        // Ignore errors during cleanup
      }
      this.socket = null;
    }

    this.connectionState = 'disconnected';
  }

  /**
   * Destroy the client and clean up all resources
   */
  destroy(): void {
    this.reset();
    this.listeners.clear();
  }
}

