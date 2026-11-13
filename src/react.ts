/**
 * ModelRiver React Hook
 * 
 * React hook for connecting to ModelRiver's WebSocket-based AI response streaming.
 * 
 * @example
 * ```tsx
 * import { useModelRiver } from '@modelriver/client/react';
 * 
 * function App() {
 *   const { connect, response, error, isConnected, steps } = useModelRiver({
 *     baseUrl: 'wss://api.modelriver.com/socket',
 *   });
 * 
 *   const handleSend = async () => {
 *     const { channel_id, ws_token, websocket_url } = await yourBackendAPI.createRequest(message);
 *     connect({ channelId: channel_id, wsToken: ws_token, websocketUrl: websocket_url });
 *   };
 * 
 *   return (
 *     <div>
 *       <button onClick={handleSend}>Send</button>
 *       {isConnected && <span>Connected</span>}
 *       {response && <pre>{JSON.stringify(response, null, 2)}</pre>}
 *       {error && <p className="error">{error}</p>}
 *     </div>
 *   );
 * }
 * ```
 */

import { useState, useEffect, useCallback, useRef } from 'react';
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
  UseModelRiverReturn,
} from './types';

/**
 * React hook for ModelRiver WebSocket client
 * 
 * @param options - Client configuration options
 * @returns Hook return value with state and methods
 */
export function useModelRiver(
  options: ModelRiverClientOptions = {}
): UseModelRiverReturn {
  // State
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [response, setResponse] = useState<AIResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasPendingRequest, setHasPendingRequest] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [toolRound, setToolRound] = useState<ToolRound | null>(null);

  // Refs
  const clientRef = useRef<ModelRiverClient | null>(null);
  const optionsRef = useRef(options);

  // Update options ref when options change
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  // Initialize client
  useEffect(() => {
    const client = new ModelRiverClient(optionsRef.current);
    clientRef.current = client;

    // Set up event listeners
    const unsubConnecting = client.on('connecting', () => {
      setConnectionState('connecting');
    });

    const unsubConnected = client.on('connected', () => {
      setConnectionState('connected');
    });

    const unsubDisconnected = client.on('disconnected', () => {
      setConnectionState('disconnected');
    });

    // The connection dropped and the client is getting it back on its own
    const unsubReconnecting = client.on('reconnecting', () => {
      setConnectionState('reconnecting');
    });

    const unsubResponse = client.on('response', (data) => {
      setResponse(data);
      // Check for both 'completed' and 'success' statuses (both indicate workflow completion)
      // Also check meta.status for completion indicators
      const status = data.status || data.meta?.status;
      const isCompleted = status === 'completed' || status === 'success' || status === 'SUCCESS';

      if (isCompleted) {
        setHasPendingRequest(false);
        // Clear from localStorage if persist is enabled
        clearStoredRequest(optionsRef.current);
        // Disconnect immediately to prevent any further connection attempts
        if (client) {
          client.disconnect();
        }
      } else {
        // Intermediate statuses (ai_generated, pipeline steps) keep the request pending
        setHasPendingRequest(client.hasPendingRequest());
      }
    });

    const unsubError = client.on('error', (err) => {
      setError(typeof err === 'string' ? err : err.message);
      setConnectionState('error');
    });

    const unsubStep = client.on('step', () => {
      // Get updated steps from client state
      const state = client.getState();
      setSteps([...state.steps]);
    });

    // Token streaming (`stream: true` requests)
    const unsubStreamStart = client.on('stream_start', () => setStreamText(''));
    const unsubStreamDelta = client.on('stream_delta', (_delta, text) => setStreamText(text));
    const unsubStreamDone = client.on('stream_done', (data) => {
      if (typeof data?.accumulated_text === 'string') setStreamText(data.accumulated_text);
    });

    // Hosted tools: the request's tool calls and the round it is on
    const unsubToolCalls = client.on('tool_calls', (calls, round) => {
      setToolCalls(calls);
      setToolRound(round);
    });

    // Mount-time reconnect runs a tick later and is cancelled on unmount, so
    // StrictMode's mount -> unmount -> mount never spends the stored token twice
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    // Check for pending request on mount
    // First check if workflow is already completed - if so, skip all reconnection logic
    const currentState = client.getState();
    if (currentState.isCompleted) {
      // Workflow is already completed, clear any pending request
      setHasPendingRequest(false);
      clearStoredRequest(optionsRef.current);
    } else if (client && client.hasPendingRequest()) {
      // Check if response status indicates completion (both 'completed' and 'success')
      const responseStatus = currentState.response?.status || currentState.response?.meta?.status;
      if (responseStatus === 'completed' || responseStatus === 'success' || responseStatus === 'SUCCESS') {
        // Response is already completed, clear the pending request
        setHasPendingRequest(false);
        clearStoredRequest(optionsRef.current);
      } else {
        // Not completed, safe to attempt reconnection
        setHasPendingRequest(true);
        // Attempt reconnection (false when the stored request can't be resumed)
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (!client.reconnect()) setHasPendingRequest(false);
        }, 0);
      }
    }

    // Cleanup
    return () => {
      unsubConnecting();
      unsubConnected();
      unsubDisconnected();
      unsubReconnecting();
      unsubResponse();
      unsubError();
      unsubStep();
      unsubStreamStart();
      unsubStreamDelta();
      unsubStreamDone();
      unsubToolCalls();

      if (reconnectTimer) clearTimeout(reconnectTimer);

      // A pending request stays stored (with its resume token) for the next
      // mount or page load; otherwise release everything
      if (client.hasPendingRequest()) {
        client.detach();
      } else {
        client.destroy();
      }
      clientRef.current = null;
    };
  }, []); // Only run on mount/unmount

  // Connect method
  const connect = useCallback((connectOptions: ConnectOptions) => {
    if (!clientRef.current) return;

    setError(null);
    setResponse(null);
    setSteps([]);
    setStreamText('');
    setToolCalls([]);
    setToolRound(null);
    setHasPendingRequest(true);

    clientRef.current.connect(connectOptions);
  }, []);

  // Disconnect method
  const disconnect = useCallback(() => {
    if (!clientRef.current) return;

    clientRef.current.disconnect();
    setHasPendingRequest(false);
  }, []);

  // Reset method
  const reset = useCallback(() => {
    if (!clientRef.current) return;

    clientRef.current.reset();
    setConnectionState('disconnected');
    setSteps([]);
    setResponse(null);
    setError(null);
    setStreamText('');
    setToolCalls([]);
    setToolRound(null);
    setHasPendingRequest(false);
  }, []);

  // Hosted tools: ask ModelRiver to stop the request (the final response still arrives)
  const cancel = useCallback((): Promise<boolean> => {
    if (!clientRef.current) return Promise.resolve(false);
    return clientRef.current.cancel();
  }, []);

  return {
    connectionState,
    isConnected: connectionState === 'connected',
    isConnecting: connectionState === 'connecting',
    steps,
    response,
    error,
    hasPendingRequest,
    streamText,
    toolCalls,
    toolRound,
    connect,
    disconnect,
    reset,
    cancel,
  };
}

// Re-export types for convenience
export type { UseModelRiverReturn } from './types';

