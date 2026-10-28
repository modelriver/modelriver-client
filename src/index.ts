/**
 * @modelriver/client
 * 
 * Official ModelRiver client SDK for real-time AI response streaming via WebSockets.
 * 
 * @example
 * ```typescript
 * import { ModelRiverClient } from '@modelriver/client';
 * 
 * const client = new ModelRiverClient({
 *   baseUrl: 'wss://api.modelriver.com/socket',
 * });
 * 
 * client.on('response', (data) => {
 *   console.log('AI Response:', data);
 * });
 * 
 * client.connect({ channelId: 'channel-id-from-api' });
 * ```
 */

// Core client
export { ModelRiverClient } from './client';

// Live session updates
export { subscribeToSession, DEFAULT_SESSION_RETRY_DELAYS_MS } from './session';

// Types
export type {
  ModelRiverClientOptions,
  ConnectOptions,
  AsyncResponse,
  TokenPayload,
  WorkflowStep,
  WorkflowStepStatus,
  TokenUsage,
  ResponseMeta,
  ResponseError,
  AIResponse,
  ConnectionState,
  ActiveRequest,
  ModelRiverEventType,
  ModelRiverEventMap,
  ModelRiverState,
  StreamStartPayload,
  StreamDeltaPayload,
  StreamDonePayload,
  StreamErrorPayload,
  UseModelRiverReturn,
  UseModelRiverVueReturn,
  ModelRiverSvelteStore,
  SessionMessage,
  SessionSignal,
  SessionSubscription,
  SessionSubscriptionInfo,
  SessionSubscriptionOptions,
  SessionSubscriptionStatus,
} from './types';

// Utilities (for advanced usage)
export {
  decodeToken,
  isTokenExpired,
  buildWebSocketUrl,
  isStorageAvailable,
  DEFAULT_BASE_URL,
  DEFAULT_HEARTBEAT_INTERVAL,
  DEFAULT_REQUEST_TIMEOUT,
} from './utils';

