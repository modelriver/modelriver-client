/**
 * ModelRiver Client SDK
 * 
 * Core client class for connecting to ModelRiver's WebSocket-based AI response streaming.
 */

import { Socket, Channel } from 'phoenix';
import type {
  ModelRiverClientOptions,
  ConnectOptions,
  ModelRiverEventType,
  ModelRiverEventMap,
  ConnectionState,
  WorkflowStep,
  AIResponse,
  ModelRiverState,
} from './types';
import {
  DEFAULT_BASE_URL,
  DEFAULT_STORAGE_KEY_PREFIX,
  DEFAULT_HEARTBEAT_INTERVAL,
  DEFAULT_REQUEST_TIMEOUT,
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
  private options: Required<ModelRiverClientOptions>;
  private socket: Socket | null = null;
  private channel: Channel | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private connectionState: ConnectionState = 'disconnected';
  private steps: WorkflowStep[] = [];
  private response: AIResponse | null = null;
  private error: string | null = null;
  private currentWebsocketChannel: string | null = null;
  private isConnecting = false;
  private isCompleted = false; // Flag to track if workflow is completed, preventing reconnection
  private logger: ReturnType<typeof createLogger>;

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
      // Optional HTTP base URL for reconnect endpoint
      apiBaseUrl: options.apiBaseUrl ?? '',
    };

    this.logger = createLogger(this.options.debug);
    this.logger.log('Client initialized with options:', this.options);
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
    };
  }

  /**
   * Check if there's a pending request that can be reconnected
   */
  hasPendingRequest(): boolean {
    if (!this.options.persist) return false;
    const request = getActiveRequest(this.options.storageKeyPrefix);
    return request !== null;
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

    if (this.isConnecting) {
      this.logger.warn('Connection already in progress, skipping...');
      return;
    }

    this.isConnecting = true;
    this.currentWebsocketChannel = websocketChannel || `ai_response:${channelId}`;
    this.emit('connecting');

    // Clean up any existing connection
    this.cleanupConnection();

    // Initialize steps
    this.steps = createInitialSteps();
    this.error = null;
    this.response = null;
    this.isCompleted = false; // Reset completed flag for new connection

    // Save to localStorage for persistence
    if (this.options.persist) {
      saveActiveRequest(
        this.options.storageKeyPrefix,
        channelId,
        wsToken,
        websocketUrl,
        websocketChannel
      );
    }

    // Update queue step to pending
    this.updateStepAndEmit('queue', { status: 'pending' });

    // Determine WebSocket URL
    const wsUrl = websocketUrl || this.options.baseUrl;
    const socketUrl = wsUrl.endsWith('/socket') ? wsUrl : `${wsUrl}/socket`;
    this.logger.log('Connecting to:', socketUrl);

    // Pass token to Phoenix Socket for authentication
    this.socket = new Socket(socketUrl, {
      params: { token: wsToken },
    });

    this.socket.onOpen(() => {
      this.logger.log('Socket connected');
      this.connectionState = 'connected';
      this.isConnecting = false;
      this.emit('connected');

      // Join channel
      this.joinChannel(this.currentWebsocketChannel!);
    });

    this.socket.onError((error: unknown) => {
      this.logger.error('Socket error:', error);

      // Don't trigger error state or reconnection if workflow is already completed
      if (this.isCompleted) {
        this.logger.log('Workflow is already completed, ignoring socket error');
        return;
      }

      this.connectionState = 'error';
      this.isConnecting = false;
      const errorMsg = 'WebSocket connection error';
      this.setError(errorMsg);
      this.updateStepAndEmit('queue', { status: 'error', errorMessage: errorMsg });
      this.emit('error', errorMsg);
    });

    this.socket.onClose((event: CloseEvent | unknown) => {
      this.logger.log('Socket closed:', event);
      this.connectionState = 'disconnected';
      this.isConnecting = false;
      this.stopHeartbeat();
      this.emit('disconnected', 'Socket closed');
    });

    this.socket.connect();
  }

  /**
   * Join the Phoenix channel
   */
  private joinChannel(topic: string): void {
    if (!this.socket) return;

    this.logger.log('Joining channel:', topic);
    this.channel = this.socket.channel(topic, {});

    this.channel.join()
      .receive('ok', () => {
        this.logger.log('Channel joined successfully');
        this.updateStepAndEmit('queue', { status: 'success', duration: 100 });
        this.updateStepAndEmit('process', { status: 'pending' });
        this.updateStepAndEmit('receive', { status: 'pending' });
        this.emit('channel_joined');
        this.startHeartbeat();
      })
      .receive('error', (error: { reason?: string }) => {
        const reason = error?.reason || 'unknown';
        this.logger.error('Channel join failed:', reason);

        let errorMsg = 'Failed to join channel';
        if (reason === 'unauthorized_project_access') {
          errorMsg = 'Unauthorized: You do not have access to this project';
        } else if (reason === 'invalid_channel_format') {
          errorMsg = 'Invalid channel format';
        } else if (reason === 'invalid_project_uuid' || reason === 'invalid_channel_uuid') {
          errorMsg = 'Invalid project or channel ID';
        } else if (reason !== 'unknown') {
          errorMsg = `Channel join failed: ${reason}`;
        }

        this.setError(errorMsg);
        this.updateStepAndEmit('queue', { status: 'error', errorMessage: errorMsg });
        this.emit('channel_error', reason);
      });

    // Listen for AI response
    this.channel.on('response', (payload: AIResponse) => {
      this.logger.log('AI Response received:', payload);
      this.handleResponse(payload);
    });

    // Listen for errors
    this.channel.on('error', (payload: { message?: string }) => {
      const errorMsg = payload?.message || 'An error occurred';
      this.logger.error('Channel error:', errorMsg);
      this.handleError(errorMsg);
    });
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
   * Disconnect from WebSocket
   */
  disconnect(): void {
    this.logger.log('Disconnecting...');
    this.isConnecting = false;
    this.cleanupConnection();

    if (this.options.persist) {
      clearActiveRequest(this.options.storageKeyPrefix);
    }

    this.emit('disconnected', 'Manual disconnect');
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
  }

  /**
   * Try to reconnect using stored channel ID
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

    const activeRequest = getActiveRequest(this.options.storageKeyPrefix);
    if (!activeRequest) {
      this.logger.log('No active request found for reconnection');
      return false;
    }

    if (!activeRequest.wsToken) {
      this.logger.warn('No wsToken found in stored request, cannot reconnect');
      clearActiveRequest(this.options.storageKeyPrefix);
      return false;
    }

    this.logger.log('Reconnecting with stored channel ID...');
    this.connect({
      channelId: activeRequest.channelId,
      wsToken: activeRequest.wsToken,
      websocketUrl: activeRequest.websocketUrl,
      websocketChannel: activeRequest.websocketChannel,
    });
    return true;
  }

  /**
   * Try to reconnect using your backend `/api/v1/ai/reconnect` endpoint.
   *
   * This helper is intended for use with the official ModelRiver backend
   * endpoint which issues a fresh one-time `ws_token` for an existing
   * async request. It should be used instead of `reconnect()` in cases
   * where WebSocket tokens are strictly single-use (the default).
   *
   * Requirements:
   * - `persist` enabled (so the client can read the stored channel ID)
   * - `apiBaseUrl` configured in `ModelRiverClientOptions`
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

    const activeRequest = getActiveRequest(this.options.storageKeyPrefix);
    if (!activeRequest) {
      this.logger.log('No active request found for backend reconnection');
      return false;
    }

    const base = this.options.apiBaseUrl.replace(/\/+$/, '');
    const url = `${base}/api/v1/ai/reconnect`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel_id: activeRequest.channelId,
        }),
      });

      if (!response.ok) {
        this.logger.error('Backend reconnect failed with HTTP status', response.status);
        return false;
      }

      const data = (await response.json()) as {
        channel_id: string;
        project_id: string;
        ws_token: string;
        websocket_url: string;
        websocket_channel: string;
      };

      if (!data?.channel_id || !data?.ws_token) {
        this.logger.error(
          'Backend reconnect response missing channel_id or ws_token',
          data
        );
        return false;
      }

      // Save updated request to localStorage for future persistence
      saveActiveRequest(
        this.options.storageKeyPrefix,
        data.channel_id,
        data.ws_token,
        data.websocket_url,
        data.websocket_channel
      );

      // Initiate WebSocket reconnection with the fresh token
      this.connect({
        channelId: data.channel_id,
        wsToken: data.ws_token,
        websocketUrl: data.websocket_url,
        websocketChannel: data.websocket_channel,
      });

      return true;
    } catch (error) {
      this.logger.error('Backend reconnect request failed', error);
      return false;
    }
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
   * Clean up connection resources
   */
  private cleanupConnection(): void {
    this.stopHeartbeat();

    // If workflow is completed, socket is already closed, skip socket operations
    // This prevents errors when trying to disconnect an already-closed connection
    const skipSocketOps = this.isCompleted;

    if (this.channel) {
      try {
        if (!skipSocketOps) {
          this.channel.leave();
        }
      } catch {
        // Ignore errors during cleanup
      }
      this.channel = null;
    }

    if (this.socket) {
      try {
        if (!skipSocketOps) {
          this.socket.disconnect();
        }
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

