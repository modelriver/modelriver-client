/**
 * ModelRiver Svelte Store
 * 
 * Svelte store factory for connecting to ModelRiver's WebSocket-based AI response streaming.
 * 
 * @example
 * ```svelte
 * <script>
 *   import { createModelRiver } from '@modelriver/client/svelte';
 *   import { onDestroy } from 'svelte';
 * 
 *   const modelRiver = createModelRiver({
 *     baseUrl: 'wss://api.modelriver.com/socket'
 *   });
 * 
 *   const { response, error, isConnected, connect, disconnect } = modelRiver;
 * 
 *   async function send() {
 *     const { channel_id, websocket_url } = await backendAPI.createRequest(message);
 *     connect({ channelId: channel_id, websocketUrl: websocket_url });
 *   }
 * 
 *   onDestroy(() => disconnect());
 * </script>
 * 
 * {#if $isConnected}
 *   <span>Connected</span>
 * {/if}
 * 
 * {#if $response}
 *   <pre>{JSON.stringify($response, null, 2)}</pre>
 * {/if}
 * 
 * {#if $error}
 *   <p class="error">{$error}</p>
 * {/if}
 * ```
 */

import { writable, derived, type Readable } from 'svelte/store';
import { ModelRiverClient } from './client';
import { clearStoredRequest } from './utils';
import type {
  ModelRiverClientOptions,
  ConnectOptions,
  ConnectionState,
  WorkflowStep,
  AIResponse,
  ToolCall,
  ToolRound,
  ToolApproval,
  ModelRiverSvelteStore,
} from './types';

/**
 * Create a ModelRiver Svelte store
 * 
 * @param options - Client configuration options
 * @returns Svelte store with reactive state and methods
 */
export function createModelRiver(
  options: ModelRiverClientOptions = {}
): ModelRiverSvelteStore {
  // Create writable stores for internal state
  const connectionStateStore = writable<ConnectionState>('disconnected');
  const stepsStore = writable<WorkflowStep[]>([]);
  const responseStore = writable<AIResponse | null>(null);
  const errorStore = writable<string | null>(null);
  const hasPendingRequestStore = writable<boolean>(false);
  const toolCallsStore = writable<ToolCall[]>([]);
  const toolRoundStore = writable<ToolRound | null>(null);
  const pendingApprovalsStore = writable<ToolApproval[]>([]);

  // Derived stores for convenience
  const isConnectedStore = derived(
    connectionStateStore,
    ($state) => $state === 'connected'
  );
  const isConnectingStore = derived(
    connectionStateStore,
    ($state) => $state === 'connecting'
  );

  // Create client
  const client = new ModelRiverClient(options);
  const unsubscribers: (() => void)[] = [];
  // Init-time reconnect runs a tick later and is cancelled by disconnect()
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Set up event listeners
  unsubscribers.push(
    client.on('connecting', () => {
      connectionStateStore.set('connecting');
    })
  );

  unsubscribers.push(
    client.on('connected', () => {
      connectionStateStore.set('connected');
    })
  );

  unsubscribers.push(
    client.on('disconnected', () => {
      connectionStateStore.set('disconnected');
    })
  );

  unsubscribers.push(
    client.on('reconnecting', () => {
      connectionStateStore.set('reconnecting');
    })
  );

  unsubscribers.push(
    client.on('response', (data) => {
      responseStore.set(data);
      // Check for both 'completed' and 'success' statuses (both indicate workflow completion)
      // Also check meta.status for completion indicators
      const status = data.status || data.meta?.status;
      const isCompleted = status === 'completed' || status === 'success' || status === 'SUCCESS';

      if (isCompleted) {
        hasPendingRequestStore.set(false);
        // Clear from localStorage if persist is enabled
        clearStoredRequest(options);
        // Disconnect immediately to prevent any further connection attempts
        if (client) {
          client.disconnect();
        }
      } else {
        // Intermediate statuses (ai_generated, pipeline steps) keep the request pending
        hasPendingRequestStore.set(client.hasPendingRequest());
      }
    })
  );

  unsubscribers.push(
    client.on('error', (err) => {
      errorStore.set(typeof err === 'string' ? err : err.message);
      connectionStateStore.set('error');
    })
  );

  unsubscribers.push(
    client.on('step', () => {
      const state = client.getState();
      stepsStore.set([...state.steps]);
    })
  );

  // Hosted tools: the request's tool calls and the round it is on
  unsubscribers.push(
    client.on('tool_calls', (calls, round) => {
      toolCallsStore.set(calls);
      toolRoundStore.set(round);
    })
  );

  // Hosted tools: calls waiting for the end user's approval
  unsubscribers.push(
    client.on('tool_approvals', (approvals) => {
      pendingApprovalsStore.set(approvals);
    })
  );

  // Check for pending request on init
  // First check if workflow is already completed - if so, skip all reconnection logic
  const currentState = client.getState();
  if (currentState.isCompleted) {
    // Workflow is already completed, clear any pending request
    hasPendingRequestStore.set(false);
    clearStoredRequest(options);
  } else if (client && client.hasPendingRequest()) {
    // Check if response status indicates completion (both 'completed' and 'success')
    const responseStatus = currentState.response?.status || currentState.response?.meta?.status;
    if (responseStatus === 'completed' || responseStatus === 'success' || responseStatus === 'SUCCESS') {
      // Response is already completed, clear the pending request
      hasPendingRequestStore.set(false);
      clearStoredRequest(options);
    } else {
      // Not completed, safe to attempt reconnection
      hasPendingRequestStore.set(true);
      // Attempt reconnection (false when the stored request can't be resumed)
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!client.reconnect()) hasPendingRequestStore.set(false);
      }, 0);
    }
  }

  // Connect method
  const connect = (connectOptions: ConnectOptions): void => {
    errorStore.set(null);
    responseStore.set(null);
    stepsStore.set([]);
    toolCallsStore.set([]);
    toolRoundStore.set(null);
    pendingApprovalsStore.set([]);
    hasPendingRequestStore.set(true);

    client.connect(connectOptions);
  };

  // Disconnect method
  const disconnect = (): void => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    client.disconnect();
    hasPendingRequestStore.set(false);

    // Cleanup listeners
    unsubscribers.forEach((unsub) => unsub());
    unsubscribers.length = 0;

    // disconnect() ended the request (and cleared it from storage): release everything
    client.destroy();
  };

  // Reset method
  const reset = (): void => {
    client.reset();
    connectionStateStore.set('disconnected');
    stepsStore.set([]);
    responseStore.set(null);
    errorStore.set(null);
    toolCallsStore.set([]);
    toolRoundStore.set(null);
    pendingApprovalsStore.set([]);
    hasPendingRequestStore.set(false);
  };

  // Hosted tools: ask ModelRiver to stop the request (the final response still arrives)
  const cancel = (): Promise<boolean> => client.cancel();

  return {
    connectionState: { subscribe: connectionStateStore.subscribe } as Readable<ConnectionState>,
    isConnected: isConnectedStore,
    isConnecting: isConnectingStore,
    steps: { subscribe: stepsStore.subscribe } as Readable<WorkflowStep[]>,
    response: { subscribe: responseStore.subscribe } as Readable<AIResponse | null>,
    error: { subscribe: errorStore.subscribe } as Readable<string | null>,
    hasPendingRequest: { subscribe: hasPendingRequestStore.subscribe } as Readable<boolean>,
    toolCalls: { subscribe: toolCallsStore.subscribe } as Readable<ToolCall[]>,
    toolRound: { subscribe: toolRoundStore.subscribe } as Readable<ToolRound | null>,
    pendingApprovals: { subscribe: pendingApprovalsStore.subscribe } as Readable<ToolApproval[]>,
    connect,
    disconnect,
    reset,
    cancel,
  };
}

// Re-export types for convenience
export type { ModelRiverSvelteStore } from './types';

