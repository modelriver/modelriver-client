/**
 * ModelRiver Client SDK Types
 * 
 * TypeScript interfaces for the ModelRiver WebSocket client.
 */

/**
 * Configuration options for ModelRiverClient
 */
export interface ModelRiverClientOptions {
  /**
   * WebSocket base URL for ModelRiver
   * @default 'wss://api.modelriver.com/socket'
   */
  baseUrl?: string;

  /**
   * Optional HTTP API base URL for reconnection.
   *
   * When provided, the client can call your backend's
   * `/api/v1/ai/reconnect` endpoint to obtain a fresh
   * `ws_token` for an existing async request after a
   * page refresh, instead of reusing a stale token
   * from localStorage.
   *
   * Example: 'https://your-app.com'
   */
  apiBaseUrl?: string;

  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;

  /**
   * Enable localStorage persistence for reconnection on page refresh
   * @default true
   */
  persist?: boolean;

  /**
   * Storage key prefix for localStorage
   * @default 'modelriver_'
   */
  storageKeyPrefix?: string;

  /**
   * Heartbeat interval in milliseconds
   * @default 30000 (30 seconds)
   */
  heartbeatInterval?: number;

  /**
   * Request timeout in milliseconds
   * @default 300000 (5 minutes)
   */
  requestTimeout?: number;
}

/**
 * Connection options for connect()
 */
export interface ConnectOptions {
  /**
   * Channel ID from /api/ai/async response
   */
  channelId: string;
  /**
   * One-time WebSocket token for authentication (from /api/ai/async response)
   */
  wsToken: string;
  /**
   * WebSocket URL (optional, defaults to baseUrl)
   */
  websocketUrl?: string;
  /**
   * Full channel name to join (optional, defaults to ai_response:{channelId})
   */
  websocketChannel?: string;
}

/**
 * Response from /api/ai/async endpoint
 */
export interface AsyncResponse {
  /** Response message (always "success" for successful requests) */
  message: string;
  /** Request status ("pending" for async requests) */
  status: 'pending';
  /** Unique channel ID for this request */
  channel_id: string;
  /** One-time WebSocket token for authentication */
  ws_token: string;
  /** WebSocket URL to connect to */
  websocket_url: string;
  /** Full channel name to join (e.g., "ai_response:uuid") */
  websocket_channel: string;
  /** Optional instructions for connecting */
  instructions?: {
    websocket?: string;
    webhook?: string;
  };
  /** Test mode indicator (only present in test mode) */
  test_mode?: boolean;
}

/**
 * Decoded token payload
 */
export interface TokenPayload {
  /** Project ID */
  project_id: string;
  /** Channel ID */
  channel_id: string;
  /** Channel topic (e.g., ai_response:project_id:channel_id) */
  topic: string;
  /** Token expiration timestamp */
  exp?: number;
}

/**
 * Workflow step status
 */
export type WorkflowStepStatus = 'pending' | 'success' | 'error';

/**
 * Workflow step for progress tracking
 */
export interface WorkflowStep {
  /** Step identifier */
  id: string;
  /** Step display name */
  name: string;
  /** Current status */
  status: WorkflowStepStatus;
  /** Duration in milliseconds (if completed) */
  duration?: number;
  /** Error message (if failed) */
  errorMessage?: string;
}

/**
 * Token usage information
 */
export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/**
 * Response metadata
 */
export interface ResponseMeta {
  workflow?: string;
  status?: string;
  duration_ms?: number;
  usage?: TokenUsage;
}

/**
 * Error details in response
 */
export interface ResponseError {
  message: string;
  details?: unknown;
}

/**
 * AI response payload from WebSocket
 */
export interface AIResponse {
  /**
   * Response status: "success", "error", "ai_generated", "completed", or a backend
   * pipeline progress status ("step_ready", "step_completed", "step_received",
   * "callback_ai_started", "callback_ai_completed")
   */
  status: string;
  /** Channel ID */
  channel_id?: string;
  /** AI response content (text) */
  content?: string;
  /** Model used for the response */
  model?: string;
  /** Response data (structured output) */
  data?: unknown;
  /** Response metadata */
  meta?: ResponseMeta;
  /** Error information (if failed) */
  error?: ResponseError;
  /** AI response (for event-driven workflows with ai_generated status) */
  ai_response?: {
    data?: unknown;
    meta?: ResponseMeta;
  };
  /** Event name (for event-driven workflows) */
  event_name?: string;
  /** Current step position (for backend pipeline progress statuses) */
  step_index?: number;
  /** Total number of pipeline steps (for backend pipeline progress statuses) */
  total_steps?: number;
  /** Step type, "backend" or "callback_ai" (for backend pipeline progress statuses) */
  step_type?: string;
  /** Pipeline workflow name (for completed backend pipelines) */
  pipeline_workflow_name?: string;
  /** Message (for intermediate statuses) */
  message?: string;
  /** Task ID (for event-driven workflows with callback) */
  task_id?: string;
  /** Callback metadata (for event-driven workflows with callback) */
  callback_metadata?: Record<string, unknown>;
  /** Customer data (cached from original request) */
  customer_data?: Record<string, unknown>;
}

/**
 * Connection state
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Active request stored in localStorage for persistence
 */
export interface ActiveRequest {
  /** Channel ID */
  channelId: string;
  /** One-time WebSocket token */
  wsToken: string;
  /** Timestamp when request was created */
  timestamp: number;
  /** WebSocket URL */
  websocketUrl?: string;
  /** Full channel name to join */
  websocketChannel?: string;
}

/**
 * Sent once when a streaming request (`stream: true`) starts producing tokens
 */
export interface StreamStartPayload {
  provider?: string;
  model?: string;
  request_id?: string;
  session_id?: string;
}

/**
 * One chunk of streamed text
 */
export interface StreamDeltaPayload {
  /** Text to append */
  text: string;
  index?: number;
  request_id?: string;
}

/**
 * Sent when streaming finishes, just before the final `response` event
 */
export interface StreamDonePayload {
  finish_reason?: string;
  /** Full text of the streamed answer */
  accumulated_text?: string;
  usage?: TokenUsage;
  duration_ms?: number;
  request_id?: string;
  data?: unknown;
  customer_data?: Record<string, unknown>;
  meta?: ResponseMeta;
}

/**
 * Sent when streaming fails. A final `response` event with an error status follows.
 */
export interface StreamErrorPayload {
  message: string;
  code?: string;
  recoverable?: boolean;
  request_id?: string;
}

/**
 * Event types emitted by ModelRiverClient
 */
export type ModelRiverEventType =
  | 'connected'
  | 'disconnected'
  | 'response'
  | 'error'
  | 'step'
  | 'connecting'
  | 'channel_joined'
  | 'channel_error'
  | 'stream_start'
  | 'stream_delta'
  | 'stream_done'
  | 'stream_error';

/**
 * Event listener callback types
 */
export interface ModelRiverEventMap {
  connected: () => void;
  disconnected: (reason?: string) => void;
  response: (data: AIResponse) => void;
  error: (error: Error | string) => void;
  step: (step: WorkflowStep) => void;
  connecting: () => void;
  channel_joined: () => void;
  channel_error: (reason: string) => void;
  stream_start: (data: StreamStartPayload) => void;
  /** Receives the chunk and the text accumulated so far */
  stream_delta: (data: StreamDeltaPayload, text: string) => void;
  stream_done: (data: StreamDonePayload) => void;
  stream_error: (data: StreamErrorPayload) => void;
}

/**
 * Client state exposed to consumers
 */
export interface ModelRiverState {
  /** Current connection state */
  connectionState: ConnectionState;
  /** Whether connected to WebSocket */
  isConnected: boolean;
  /** Whether currently connecting */
  isConnecting: boolean;
  /** Current workflow steps */
  steps: WorkflowStep[];
  /** Latest response */
  response: AIResponse | null;
  /** Latest error */
  error: string | null;
  /** Whether there's a pending request that can be reconnected */
  hasPendingRequest: boolean;
  /** Whether the workflow is completed (prevents reconnection) */
  isCompleted?: boolean;
  /** Text streamed so far for the current request (`stream: true` requests only) */
  streamText?: string;
}

/**
 * Return type for React hook
 */
export interface UseModelRiverReturn extends ModelRiverState {
  /** Connect to WebSocket with token */
  connect: (options: ConnectOptions) => void;
  /** Disconnect from WebSocket */
  disconnect: () => void;
  /** Reset state and clear stored data */
  reset: () => void;
}

/**
 * Return type for Vue composable
 */
export interface UseModelRiverVueReturn {
  /** Reactive connection state */
  connectionState: import('vue').Ref<ConnectionState>;
  /** Reactive connected status */
  isConnected: import('vue').Ref<boolean>;
  /** Reactive connecting status */
  isConnecting: import('vue').Ref<boolean>;
  /** Reactive workflow steps */
  steps: import('vue').Ref<WorkflowStep[]>;
  /** Reactive response */
  response: import('vue').Ref<AIResponse | null>;
  /** Reactive error */
  error: import('vue').Ref<string | null>;
  /** Reactive pending request status */
  hasPendingRequest: import('vue').Ref<boolean>;
  /** Connect to WebSocket with token */
  connect: (options: ConnectOptions) => void;
  /** Disconnect from WebSocket */
  disconnect: () => void;
  /** Reset state and clear stored data */
  reset: () => void;
}

/**
 * Svelte store return type
 */
export interface ModelRiverSvelteStore {
  /** Readable store for connection state */
  connectionState: import('svelte/store').Readable<ConnectionState>;
  /** Readable store for connected status */
  isConnected: import('svelte/store').Readable<boolean>;
  /** Readable store for connecting status */
  isConnecting: import('svelte/store').Readable<boolean>;
  /** Readable store for workflow steps */
  steps: import('svelte/store').Readable<WorkflowStep[]>;
  /** Readable store for response */
  response: import('svelte/store').Readable<AIResponse | null>;
  /** Readable store for error */
  error: import('svelte/store').Readable<string | null>;
  /** Readable store for pending request status */
  hasPendingRequest: import('svelte/store').Readable<boolean>;
  /** Connect to WebSocket with token */
  connect: (options: ConnectOptions) => void;
  /** Disconnect from WebSocket */
  disconnect: () => void;
  /** Reset state and clear stored data */
  reset: () => void;
}


/**
 * A conversation turn, as `GET /v1/sessions/:id` returns it.
 */
export interface SessionMessage {
  /** Stable per turn (`"<log_id>:user"` / `"<log_id>:assistant"`): merge by id */
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  /** `ai` for model replies, `agent` for human replies appended through the API */
  author: 'user' | 'ai' | 'agent';
  author_name: string | null;
  content: string;
  created_at: string;
}

/**
 * An app-defined event sent with `POST /v1/sessions/:id/signals`. Not stored.
 */
export interface SessionSignal<T = unknown> {
  session_id: string;
  name: string;
  data: T;
  sent_at: string;
}

/**
 * What your backend returns from `POST /v1/sessions/:id/subscribe` (pass the
 * API response through as is; camelCase keys work too).
 */
export interface SessionSubscriptionInfo {
  ws_token?: string;
  websocket_url?: string;
  websocket_channel?: string;
  wsToken?: string;
  websocketUrl?: string;
  websocketChannel?: string;
}

export type SessionSubscriptionStatus = 'connecting' | 'live' | 'reconnecting' | 'closed';

export interface SessionSubscriptionOptions {
  /**
   * Fetches a fresh subscription from your backend. Called for the first
   * connection and every reconnection (tokens are single-use). Return null
   * when there is nothing to follow; the subscription then closes.
   */
  getSubscription: () => Promise<SessionSubscriptionInfo | null>;
  /** A new turn: a user message, an AI reply or a human agent's reply */
  onMessage?: (message: SessionMessage) => void;
  /** A signal from your backend */
  onSignal?: (signal: SessionSignal) => void;
  /** The session was deleted; the subscription closes */
  onDeleted?: (payload: { session_id: string }) => void;
  /**
   * Joined, first time and after every reconnection. Events sent while
   * disconnected are not replayed, so reload the conversation here.
   */
  onLive?: () => void;
  onStatus?: (status: SessionSubscriptionStatus) => void;
  /** A failed connection or join (the subscription retries unless it's final) */
  onError?: (error: Error) => void;
  /** Waits between reconnection attempts in ms; the last one repeats. Default 1s, 2s, 5s, 10s, 30s */
  retryDelaysMs?: number[];
  debug?: boolean;
}

export interface SessionSubscription {
  /** Stop following the session */
  close: () => void;
  readonly status: SessionSubscriptionStatus;
}
