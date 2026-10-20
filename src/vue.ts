/**
 * ModelRiver Vue Composable
 * 
 * Vue composable for connecting to ModelRiver's WebSocket-based AI response streaming.
 * 
 * @example
 * ```vue
 * <script setup>
 * import { useModelRiver } from '@modelriver/client/vue';
 * 
 * const { connect, response, error, isConnected, steps } = useModelRiver({
 *   baseUrl: 'wss://api.modelriver.com/socket',
 * });
 * 
 * async function handleSend() {
 *   const { channel_id, websocket_url } = await yourBackendAPI.createRequest(message);
 *   connect({ channelId: channel_id, websocketUrl: websocket_url });
 * }
 * </script>
 * 
 * <template>
 *   <div>
 *     <button @click="handleSend">Send</button>
 *     <span v-if="isConnected">Connected</span>
 *     <pre v-if="response">{{ response }}</pre>
 *     <p v-if="error" class="error">{{ error }}</p>
 *   </div>
 * </template>
 * ```
 */

import { ref, onMounted, onUnmounted } from 'vue';
import { ModelRiverClient } from './client';
import { clearActiveRequest } from './utils';
import type {
  ModelRiverClientOptions,
  ConnectOptions,
  ConnectionState,
  WorkflowStep,
  AIResponse,
  UseModelRiverVueReturn,
} from './types';

/**
 * Vue composable for ModelRiver WebSocket client
 * 
 * @param options - Client configuration options
 * @returns Composable return value with reactive state and methods
 */
export function useModelRiver(
  options: ModelRiverClientOptions = {}
): UseModelRiverVueReturn {
  // Reactive state
  const connectionState = ref<ConnectionState>('disconnected');
  const steps = ref<WorkflowStep[]>([]);
  const response = ref<AIResponse | null>(null);
  const error = ref<string | null>(null);
  const hasPendingRequest = ref(false);
  const isConnected = ref(false);
  const isConnecting = ref(false);

  // Client instance
  let client: ModelRiverClient | null = null;
  const unsubscribers: (() => void)[] = [];

  // Initialize client
  const initClient = () => {
    client = new ModelRiverClient(options);

    // Set up event listeners
    unsubscribers.push(
      client.on('connecting', () => {
        connectionState.value = 'connecting';
        isConnecting.value = true;
        isConnected.value = false;
      })
    );

    unsubscribers.push(
      client.on('connected', () => {
        connectionState.value = 'connected';
        isConnected.value = true;
        isConnecting.value = false;
      })
    );

    unsubscribers.push(
      client.on('disconnected', () => {
        connectionState.value = 'disconnected';
        isConnected.value = false;
        isConnecting.value = false;
      })
    );

    unsubscribers.push(
      client.on('response', (data) => {
        response.value = data;
        // Check for both 'completed' and 'success' statuses (both indicate workflow completion)
        // Also check meta.status for completion indicators
        const status = data.status || data.meta?.status;
        const isCompleted = status === 'completed' || status === 'success' || status === 'SUCCESS';

        if (isCompleted) {
          hasPendingRequest.value = false;
          // Clear from localStorage if persist is enabled
          if (options.persist) {
            clearActiveRequest(options.storageKeyPrefix || 'modelriver');
          }
          // Disconnect immediately to prevent any further connection attempts
          if (client) {
            client.disconnect();
          }
        } else {
          // Intermediate statuses (ai_generated, pipeline steps) keep the request pending
          hasPendingRequest.value = client?.hasPendingRequest() ?? false;
        }
      })
    );

    unsubscribers.push(
      client.on('error', (err) => {
        error.value = typeof err === 'string' ? err : err.message;
        connectionState.value = 'error';
        isConnecting.value = false;
      })
    );

    unsubscribers.push(
      client.on('step', () => {
        if (client) {
          const state = client.getState();
          steps.value = [...state.steps];
        }
      })
    );

    // Check for pending request on mount
    // First check if workflow is already completed - if so, skip all reconnection logic
    const currentState = client.getState();
    if (currentState.isCompleted) {
      // Workflow is already completed, clear any pending request
      hasPendingRequest.value = false;
      if (options.persist) {
        clearActiveRequest(options.storageKeyPrefix || 'modelriver');
      }
    } else if (client && client.hasPendingRequest()) {
      // Check if response status indicates completion (both 'completed' and 'success')
      const responseStatus = currentState.response?.status || currentState.response?.meta?.status;
      if (responseStatus === 'completed' || responseStatus === 'success' || responseStatus === 'SUCCESS') {
        // Response is already completed, clear the pending request
        hasPendingRequest.value = false;
        if (options.persist) {
          clearActiveRequest(options.storageKeyPrefix || 'modelriver');
        }
      } else {
        // Not completed, safe to attempt reconnection
        hasPendingRequest.value = true;
        // Attempt reconnection
        if (client) {
          client.reconnect();
        }
      }
    }
  };

  // Cleanup
  const cleanup = () => {
    unsubscribers.forEach((unsub) => unsub());
    unsubscribers.length = 0;

    // Only destroy if there's no pending request and workflow is not already completed
    if (client) {
      const state = client.getState();
      if (!client.hasPendingRequest() && !state.isCompleted) {
        client.destroy();
      }
    }
    client = null;
  };

  // Connect method
  const connect = (connectOptions: ConnectOptions) => {
    if (!client) return;

    error.value = null;
    response.value = null;
    steps.value = [];
    hasPendingRequest.value = true;

    client.connect(connectOptions);
  };

  // Disconnect method
  const disconnect = () => {
    if (!client) return;

    client.disconnect();
    hasPendingRequest.value = false;
  };

  // Reset method
  const reset = () => {
    if (!client) return;

    client.reset();
    connectionState.value = 'disconnected';
    isConnected.value = false;
    isConnecting.value = false;
    steps.value = [];
    response.value = null;
    error.value = null;
    hasPendingRequest.value = false;
  };

  // Lifecycle hooks
  onMounted(() => {
    initClient();
  });

  onUnmounted(() => {
    cleanup();
  });

  return {
    connectionState,
    isConnected,
    isConnecting,
    steps,
    response,
    error,
    hasPendingRequest,
    connect,
    disconnect,
    reset,
  };
}

// Re-export types for convenience
export type { UseModelRiverVueReturn } from './types';

