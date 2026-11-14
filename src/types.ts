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
   * Optional HTTP base URL of your own backend for reconnection.
   *
   * The client POSTs `{ channel_id }` to `${apiBaseUrl}/api/v1/ai/reconnect`
   * (on your backend, without credentials) and expects ModelRiver's
   * `/api/v1/ai/reconnect` JSON back.
   *
   * @deprecated Use `getToken`, which lets you choose the route, send your
   * own auth and check that the signed-in user owns the request.
   */
  apiBaseUrl?: string;

  /**
   * Fetches a new listening token from your backend when the client can't
   * reconnect with the resume token it already holds (gaps longer than about
   * 5 minutes, or ModelRiver restarting). Your backend checks that the
   * signed-in user owns `channelId`, then calls ModelRiver's
   * `POST /api/v1/ai/reconnect` with its API key and returns the JSON as is
   * (snake_case or camelCase).
   *
   * Return `null` when the request no longer exists (ModelRiver answered 404):
   * the client stops with an error. Throwing makes the client wait and retry.
   */
  getToken?: (request: ReconnectRequest) => Promise<ReconnectInfo | null>;

  /**
   * Waits between reconnection attempts in ms; the last one repeats.
   * @default [1000, 2000, 5000, 10000, 30000]
   */
  retryDelaysMs?: number[];

  /**
   * How often a connected client asks ModelRiver for a fresh resume token,
   * in ms. Resume tokens expire 5 minutes after they're issued, so keep this
   * well under that. Set to 0 to turn refreshing off.
   * @default 120000 (2 minutes)
   */
  tokenRefreshInterval?: number;

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
 * What the client passes to `getToken`
 */
export interface ReconnectRequest {
  /** Channel ID of the async request to resume */
  channelId: string;
  /** Channel topic the client was following, if known */
  websocketChannel?: string;
}

/**
 * What `getToken` returns: the JSON from ModelRiver's
 * `POST /api/v1/ai/reconnect`, passed through as is. camelCase keys work too.
 */
export interface ReconnectInfo {
  channel_id?: string;
  project_id?: string;
  ws_token?: string;
  websocket_url?: string;
  websocket_channel?: string;
  channelId?: string;
  projectId?: string;
  wsToken?: string;
  websocketUrl?: string;
  websocketChannel?: string;
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
  /**
   * Hosted tools: how many model rounds and tool calls the request used.
   * Each round counts as one request on your plan.
   */
  tool_loop?: {
    rounds: number;
    tool_calls: number;
  };
}

/**
 * Error details in response
 */
export interface ResponseError {
  /** Safe to show to the end user */
  message: string;
  /**
   * What went wrong, when the server says: for example "cancelled",
   * "tool_loop_limit" or "tool_loop_timeout" on a hosted-tools request
   */
  type?: string;
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
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

/**
 * Active request stored in localStorage for persistence
 */
export interface ActiveRequest {
  /** Channel ID */
  channelId: string;
  /**
   * Single-use listening token for the next connection: the latest resume
   * token, or an empty string once it has been used
   */
  wsToken: string;
  /** Timestamp when request was created */
  timestamp: number;
  /** WebSocket URL */
  websocketUrl?: string;
  /** Full channel name to join */
  websocketChannel?: string;
  /**
   * Hosted tools: while calls wait for approval, the time (ms) until which the
   * request stays resumable: the latest `expires_at` plus 5 minutes
   */
  approvalsUntil?: number;
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
 * Where one tool call of a hosted-tools request stands.
 *
 * - `awaiting_approval`: a tool that changes something, waiting for the end
 *   user to approve or decline it (see `pendingApprovals`)
 * - `approved`: approved, not started yet. ModelRiver runs it once every call
 *   of the round has been decided. Set by the client.
 * - `rejected`: declined (or the request was stopped while it waited); not run
 * - `expired`: nobody decided in time; not run
 * - `running`: ModelRiver is calling your endpoint
 * - `ok`: the endpoint returned a result
 * - `error`: the call failed (the model is told, and may still answer)
 * - `timeout`: the endpoint did not answer in time
 * - `unknown`: a tool that changes something was sent, but ModelRiver can't
 *   tell whether it finished. It is never sent again; check before retrying.
 * - `ended`: the request finished before this client saw the call finish
 *   (for example after a reconnect); set by the client, never by the server
 */
export type ToolCallStatus =
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'running'
  | 'ok'
  | 'error'
  | 'timeout'
  | 'unknown'
  | 'ended';

/**
 * One tool call, as shown to the end user. Arguments and results stay out of
 * this list; a call that needs approval shows the arguments the developer
 * chose in `pendingApprovals` instead.
 */
export interface ToolCall {
  /** Stable for the call, across retries and reconnects */
  id: string;
  /** The tool's name */
  name: string;
  /** The tool's progress label from the console ("Looking up your orders…"), if it has one */
  label?: string | null;
  /** The model round the call belongs to (1-based) */
  round?: number;
  status: ToolCallStatus;
  /** Set once the call has finished */
  duration_ms?: number;
  /** A message your endpoint marked as safe to show the end user, if it sent one */
  user_message?: string | null;
}

/**
 * The model round a hosted-tools request is on
 */
export interface ToolRound {
  round: number;
  max_rounds: number;
}

/** Sent when a model round starts */
export type ToolRoundStartedPayload = ToolRound;

/** Sent when ModelRiver starts calling one of your tools */
export interface ToolCallStartedPayload {
  id: string;
  name: string;
  label?: string | null;
  round: number;
}

/** Sent when a tool call has finished, whatever the outcome */
export interface ToolCallCompletedPayload {
  id: string;
  name: string;
  round: number;
  /** `unknown`: a tool that changes something was sent, but the outcome isn't known */
  status: 'ok' | 'error' | 'timeout' | 'unknown';
  duration_ms: number;
  user_message?: string | null;
}

/**
 * A tool call that changes something, waiting for the end user's decision.
 * The client can't approve it: send the decision to your backend, which calls
 * `POST /v1/ai/tool-calls/:id/approve` (or `/reject`) with your API key.
 */
export interface ToolApproval {
  /** The call id (`tc_…`); pass it to your backend */
  id: string;
  /** The tool's name */
  name: string;
  /** The tool's progress label from the console, if it has one */
  label: string | null;
  /** The model round the call belongs to (1-based) */
  round: number;
  /** The tool's approval prompt from the console ("Cancel this order? This can't be undone.") */
  prompt: string;
  /**
   * Only the arguments the developer chose to show (approval fields), by
   * name. The model wrote these values: render them as text, never as HTML.
   */
  arguments: Record<string, unknown>;
  /** When ModelRiver stops waiting (ISO 8601); the call then becomes `expired` */
  expires_at: string;
}

/** Sent when a tool call needs the end user's approval before it runs */
export type ToolApprovalRequiredPayload = ToolApproval;

/** How an approval ended */
export type ToolApprovalDecision = 'approved' | 'rejected' | 'expired';

/** Sent when a call that needed approval was approved, declined or expired */
export interface ToolApprovalResolvedPayload {
  id: string;
  name: string;
  round: number;
  decision: ToolApprovalDecision;
}

/**
 * One call in `tool_state`. A call awaiting approval also carries what the
 * approver sees.
 */
export interface ToolStateCall extends ToolCall {
  prompt?: string;
  arguments?: Record<string, unknown>;
  expires_at?: string;
}

/**
 * Sent once when the client joins (or rejoins) a hosted-tools request that is
 * already under way, or paused for approval: where the request stands
 */
export interface ToolStatePayload extends ToolRound {
  calls: ToolStateCall[];
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
  | 'reconnecting'
  | 'channel_joined'
  | 'channel_error'
  | 'stream_start'
  | 'stream_delta'
  | 'stream_done'
  | 'stream_error'
  | 'tool_round_started'
  | 'tool_call_started'
  | 'tool_call_completed'
  | 'tool_state'
  | 'tool_calls'
  | 'tool_approval_required'
  | 'tool_approval_resolved'
  | 'tool_approvals';

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
  /** The connection dropped; the next attempt starts after `delayMs` */
  reconnecting: (attempt: number, delayMs: number) => void;
  channel_joined: () => void;
  channel_error: (reason: string) => void;
  stream_start: (data: StreamStartPayload) => void;
  /** Receives the chunk and the text accumulated so far */
  stream_delta: (data: StreamDeltaPayload, text: string) => void;
  stream_done: (data: StreamDonePayload) => void;
  stream_error: (data: StreamErrorPayload) => void;
  /** Hosted tools: a model round started */
  tool_round_started: (data: ToolRoundStartedPayload) => void;
  /** Hosted tools: ModelRiver started calling one of your tools */
  tool_call_started: (data: ToolCallStartedPayload) => void;
  /** Hosted tools: a tool call finished */
  tool_call_completed: (data: ToolCallCompletedPayload) => void;
  /** Hosted tools: where the request stands, sent when joining part-way */
  tool_state: (data: ToolStatePayload) => void;
  /**
   * Hosted tools: the list of tool calls changed. Receives every call so far,
   * in the order they started, and the current round. Listen to this one to
   * draw progress; the four events above are the raw messages behind it.
   */
  tool_calls: (calls: ToolCall[], round: ToolRound | null) => void;
  /** Hosted tools: a call that changes something needs the end user's approval */
  tool_approval_required: (data: ToolApprovalRequiredPayload) => void;
  /** Hosted tools: a call that needed approval was approved, declined or expired */
  tool_approval_resolved: (data: ToolApprovalResolvedPayload) => void;
  /**
   * Hosted tools: the list of calls waiting for approval changed. Receives
   * every call still waiting. Listen to this one to show Approve and Decline
   * buttons; the two events above are the raw messages behind it.
   */
  tool_approvals: (approvals: ToolApproval[]) => void;
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
  /** Hosted tools: every tool call of the current request, in the order they started */
  toolCalls?: ToolCall[];
  /** Hosted tools: the model round the current request is on */
  toolRound?: ToolRound | null;
  /** Hosted tools: calls waiting for the end user's approval, in the order they were asked */
  pendingApprovals?: ToolApproval[];
}

/**
 * Return type for React hook
 */
export interface UseModelRiverReturn extends ModelRiverState {
  /** Text streamed so far for the current request (`stream: true` requests only) */
  streamText: string;
  /** Hosted tools: every tool call of the current request, in the order they started */
  toolCalls: ToolCall[];
  /** Hosted tools: the model round the current request is on */
  toolRound: ToolRound | null;
  /** Hosted tools: calls waiting for the end user's approval */
  pendingApprovals: ToolApproval[];
  /** Connect to WebSocket with token */
  connect: (options: ConnectOptions) => void;
  /** Disconnect from WebSocket */
  disconnect: () => void;
  /** Reset state and clear stored data */
  reset: () => void;
  /**
   * Hosted tools: ask ModelRiver to stop the request. Resolves true when the
   * server took the request to stop; the final `response` (an error of type
   * "cancelled") still arrives afterwards.
   */
  cancel: () => Promise<boolean>;
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
  /** Hosted tools: reactive list of the current request's tool calls */
  toolCalls: import('vue').Ref<ToolCall[]>;
  /** Hosted tools: the model round the current request is on */
  toolRound: import('vue').Ref<ToolRound | null>;
  /** Hosted tools: calls waiting for the end user's approval */
  pendingApprovals: import('vue').Ref<ToolApproval[]>;
  /** Connect to WebSocket with token */
  connect: (options: ConnectOptions) => void;
  /** Disconnect from WebSocket */
  disconnect: () => void;
  /** Reset state and clear stored data */
  reset: () => void;
  /** Hosted tools: ask ModelRiver to stop the request */
  cancel: () => Promise<boolean>;
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
  /** Hosted tools: readable store for the current request's tool calls */
  toolCalls: import('svelte/store').Readable<ToolCall[]>;
  /** Hosted tools: readable store for the model round the request is on */
  toolRound: import('svelte/store').Readable<ToolRound | null>;
  /** Hosted tools: readable store for the calls waiting for the end user's approval */
  pendingApprovals: import('svelte/store').Readable<ToolApproval[]>;
  /** Connect to WebSocket with token */
  connect: (options: ConnectOptions) => void;
  /** Disconnect from WebSocket */
  disconnect: () => void;
  /** Reset state and clear stored data */
  reset: () => void;
  /** Hosted tools: ask ModelRiver to stop the request */
  cancel: () => Promise<boolean>;
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
