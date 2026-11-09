/**
 * ModelRiverClient Unit Tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// A Phoenix double the tests can drive (replies with payloads, open/close/error)
vi.mock('phoenix', async () => {
  const { MockSocket, MockChannel } = await import('./mocks/phoenix');
  return { Socket: MockSocket, Channel: MockChannel };
});

import { Socket } from 'phoenix';
import { ModelRiverClient } from '../src/client';
import { saveActiveRequest, getActiveRequest } from '../src/utils';
import { MockSocket } from './mocks/phoenix';

describe('ModelRiverClient', () => {
  let client: ModelRiverClient;

  // Create a valid test JWT
  const createTestToken = (payload: object): string => {
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const body = btoa(JSON.stringify(payload))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const signature = 'test-signature';
    return `${header}.${body}.${signature}`;
  };

  const validToken = createTestToken({
    project_id: 'proj-123',
    channel_id: 'chan-456',
    topic: 'ai_response:proj-123:chan-456',
    exp: Math.floor(Date.now() / 1000) + 3600,
  });

  beforeEach(() => {
    // Clear localStorage before each test
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
    client = new ModelRiverClient({
      debug: false,
      persist: false,
    });
  });

  afterEach(() => {
    // Clear localStorage after each test
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
  });

  describe('constructor', () => {
    it('should create client with default options', () => {
      const defaultClient = new ModelRiverClient();
      const state = defaultClient.getState();

      expect(state.connectionState).toBe('disconnected');
      expect(state.isConnected).toBe(false);
      expect(state.steps).toEqual([]);
      expect(state.response).toBeNull();
      expect(state.error).toBeNull();
    });

    it('should accept custom options', () => {
      const customClient = new ModelRiverClient({
        baseUrl: 'wss://custom.url/socket',
        debug: true,
        persist: false,
      });

      expect(customClient).toBeDefined();
    });
  });

  describe('getState', () => {
    it('should return current state', () => {
      const state = client.getState();

      expect(state).toHaveProperty('connectionState');
      expect(state).toHaveProperty('isConnected');
      expect(state).toHaveProperty('isConnecting');
      expect(state).toHaveProperty('steps');
      expect(state).toHaveProperty('response');
      expect(state).toHaveProperty('error');
      expect(state).toHaveProperty('hasPendingRequest');
    });
  });

  describe('connect', () => {
    it('should emit error when wsToken is missing', () => {
      const errorHandler = vi.fn();
      client.on('error', errorHandler);

      client.connect({ channelId: 'test-chan', wsToken: '' });

      expect(errorHandler).toHaveBeenCalledWith('wsToken is required for WebSocket authentication');
    });

    it('should emit error when channelId is missing', () => {
      const errorHandler = vi.fn();
      client.on('error', errorHandler);

      client.connect({ channelId: '', wsToken: validToken });

      expect(errorHandler).toHaveBeenCalledWith('channelId is required');
    });

    it('should emit connecting event', () => {
      const connectingHandler = vi.fn();
      client.on('connecting', connectingHandler);

      client.connect({ channelId: 'test-chan', wsToken: validToken });

      expect(connectingHandler).toHaveBeenCalled();
    });

    it('should initialize steps on connect', () => {
      client.connect({ channelId: 'test-chan', wsToken: validToken });

      const state = client.getState();
      expect(state.steps).toHaveLength(4);
      expect(state.steps[0].id).toBe('queue');
      expect(state.steps[0].status).toBe('pending');
    });
  });

  describe('disconnect', () => {
    it('should emit disconnected event', () => {
      const disconnectedHandler = vi.fn();
      client.on('disconnected', disconnectedHandler);

      client.disconnect();

      expect(disconnectedHandler).toHaveBeenCalled();
    });

    it('should update connection state', () => {
      client.disconnect();

      const state = client.getState();
      expect(state.connectionState).toBe('disconnected');
    });
  });

  describe('reset', () => {
    it('should clear all state', () => {
      // Set up some state
      client.connect({ channelId: 'test-chan', wsToken: validToken });
      client.reset();

      const state = client.getState();
      expect(state.connectionState).toBe('disconnected');
      expect(state.steps).toEqual([]);
      expect(state.response).toBeNull();
      expect(state.error).toBeNull();
    });
  });

  describe('event listeners', () => {
    it('should add and remove listeners', () => {
      const handler = vi.fn();

      const unsubscribe = client.on('connected', handler);
      expect(typeof unsubscribe).toBe('function');

      unsubscribe();
      // Handler should be removed (we can't easily test this without triggering the event)
    });

    it('should support off method', () => {
      const handler = vi.fn();

      client.on('connected', handler);
      client.off('connected', handler);
      // Handler should be removed
    });

    it('should call step handler on step updates', () => {
      const stepHandler = vi.fn();
      client.on('step', stepHandler);

      client.connect({ channelId: 'test-chan', wsToken: validToken });

      // Step handler should be called when steps are updated
      expect(stepHandler).toHaveBeenCalled();
    });
  });

  describe('hasPendingRequest', () => {
    it('should return false when persistence is disabled', () => {
      expect(client.hasPendingRequest()).toBe(false);
    });

    it('should return false when no active request stored', () => {
      const persistentClient = new ModelRiverClient({ persist: true });
      expect(persistentClient.hasPendingRequest()).toBe(false);
    });
  });

  describe('destroy', () => {
    it('should clean up all resources', () => {
      const handler = vi.fn();
      client.on('connected', handler);

      client.destroy();

      const state = client.getState();
      expect(state.connectionState).toBe('disconnected');
    });
  });

  describe('completed status handling', () => {
    it('should clear localStorage when receiving completed status with persist enabled', () => {
      const persistentClient = new ModelRiverClient({
        debug: false,
        persist: true,
        storageKeyPrefix: 'test_modelriver',
      });

      // Simulate a pending request in localStorage
      saveActiveRequest('test_modelriver', 'test-channel-id', 'test-token', 'test-url', 'test-channel');
      expect(persistentClient.hasPendingRequest()).toBe(true);

      // Simulate receiving a completed status response by calling handleResponse directly
      const completedPayload = {
        status: 'completed',
        channel_id: 'test-channel-id',
        data: { result: 'success' },
      };

      // Call handleResponse which is the internal method that processes responses
      (persistentClient as any).handleResponse(completedPayload);

      // Check that localStorage was cleared
      expect(persistentClient.hasPendingRequest()).toBe(false);
      expect(getActiveRequest('test_modelriver')).toBeNull();
    });

    it('should set hasPendingRequest to false when receiving completed status', () => {
      const persistentClient = new ModelRiverClient({
        debug: false,
        persist: true,
        storageKeyPrefix: 'test_modelriver',
      });

      // Simulate a pending request
      saveActiveRequest('test_modelriver', 'test-channel-id', 'test-token', 'test-url', 'test-channel');
      expect(persistentClient.hasPendingRequest()).toBe(true);

      // Simulate completed status
      const completedPayload = {
        status: 'completed',
        channel_id: 'test-channel-id',
        data: { result: 'success' },
      };

      (persistentClient as any).handleResponse(completedPayload);

      const state = persistentClient.getState();
      expect(state.hasPendingRequest).toBe(false);
    });

    it('should not attempt reconnection after completed status', () => {
      const persistentClient = new ModelRiverClient({
        debug: false,
        persist: true,
        storageKeyPrefix: 'test_modelriver',
      });

      // Simulate a pending request
      saveActiveRequest('test_modelriver', 'test-channel-id', 'test-token', 'test-url', 'test-channel');

      const reconnectSpy = vi.spyOn(persistentClient, 'reconnect');

      // Simulate completed status
      const completedPayload = {
        status: 'completed',
        channel_id: 'test-channel-id',
        data: { result: 'success' },
      };

      (persistentClient as any).handleResponse(completedPayload);

      // Verify reconnect was not called
      expect(reconnectSpy).not.toHaveBeenCalled();

      // Verify hasPendingRequest is false, so reconnect won't be called on mount
      expect(persistentClient.hasPendingRequest()).toBe(false);
    });

    it('should handle completed status without persist enabled', () => {
      const nonPersistentClient = new ModelRiverClient({
        debug: false,
        persist: false,
      });

      const responseHandler = vi.fn();
      nonPersistentClient.on('response', responseHandler);

      const completedPayload = {
        status: 'completed',
        channel_id: 'test-channel-id',
        data: { result: 'success' },
      };

      (nonPersistentClient as any).handleResponse(completedPayload);

      expect(responseHandler).toHaveBeenCalledWith(completedPayload);
      const state = nonPersistentClient.getState();
      expect(state.hasPendingRequest).toBe(false);
    });

    it('should clear connection immediately on completed status', () => {
      const testClient = new ModelRiverClient({
        debug: false,
        persist: true,
        storageKeyPrefix: 'test_modelriver',
      });

      // Save a pending request
      saveActiveRequest('test_modelriver', 'test-channel-id', 'test-token', 'test-url', 'test-channel');

      const cleanupSpy = vi.spyOn(testClient as any, 'cleanupConnection');

      const completedPayload = {
        status: 'completed',
        channel_id: 'test-channel-id',
        data: { result: 'success' },
      };

      // Simulate the handleResponse method being called with completed status
      // This should trigger cleanupConnection
      (testClient as any).handleResponse(completedPayload);

      // Verify cleanupConnection was called
      expect(cleanupSpy).toHaveBeenCalled();
    });
  });

  describe('backend pipeline progress statuses', () => {
    const progressStatuses = [
      'step_ready',
      'step_completed',
      'step_received',
      'callback_ai_started',
      'callback_ai_completed',
    ];

    it.each(progressStatuses)('should keep the connection open on %s', (status) => {
      const testClient = new ModelRiverClient({
        debug: false,
        persist: true,
        storageKeyPrefix: 'test_modelriver',
      });

      saveActiveRequest('test_modelriver', 'test-channel-id', 'test-token', 'test-url', 'test-channel');

      const cleanupSpy = vi.spyOn(testClient as any, 'cleanupConnection');
      const responseHandler = vi.fn();
      testClient.on('response', responseHandler);

      const payload = {
        status,
        channel_id: 'test-channel-id',
        step_index: 0,
        total_steps: 2,
        event_name: 'lookup_order',
        message: 'Waiting for backend callback at step lookup_order.',
      };

      (testClient as any).handleResponse(payload);

      expect(cleanupSpy).not.toHaveBeenCalled();
      expect(responseHandler).toHaveBeenCalledWith(payload);

      const state = testClient.getState();
      expect(state.error).toBeNull();
      expect(state.response).toEqual(payload);
      expect(state.hasPendingRequest).toBe(true);
      expect(state.steps.find((s) => s.id === 'backend')).toMatchObject({
        status: 'pending',
        name: payload.message,
      });
    });

    it('should finish on completed after a multi-step pipeline', () => {
      const testClient = new ModelRiverClient({
        debug: false,
        persist: false,
      });

      const cleanupSpy = vi.spyOn(testClient as any, 'cleanupConnection');

      (testClient as any).handleResponse({ status: 'ai_generated', channel_id: 'test-channel-id' });
      (testClient as any).handleResponse({ status: 'step_ready', channel_id: 'test-channel-id', step_index: 0 });
      (testClient as any).handleResponse({ status: 'step_completed', channel_id: 'test-channel-id', step_index: 0 });
      (testClient as any).handleResponse({ status: 'step_ready', channel_id: 'test-channel-id', step_index: 1 });

      expect(cleanupSpy).not.toHaveBeenCalled();

      const completedPayload = {
        status: 'completed',
        channel_id: 'test-channel-id',
        data: { order_status: 'shipped' },
      };
      (testClient as any).handleResponse(completedPayload);

      expect(cleanupSpy).toHaveBeenCalled();
      const state = testClient.getState();
      expect(state.error).toBeNull();
      expect(state.response).toEqual(completedPayload);
      expect(state.steps.find((s) => s.id === 'backend')?.status).toBe('success');
    });
  });

  describe('reconnect method', () => {
    it('should not reconnect if response status is completed', () => {
      const persistentClient = new ModelRiverClient({
        debug: false,
        persist: true,
        storageKeyPrefix: 'test_modelriver',
      });

      // Save a pending request
      saveActiveRequest('test_modelriver', 'test-channel-id', validToken, 'wss://test.com/socket', 'test-channel');

      // Simulate completed status
      const completedPayload = {
        status: 'completed',
        channel_id: 'test-channel-id',
        data: { result: 'success' },
      };
      (persistentClient as any).handleResponse(completedPayload);

      // Attempt reconnect - should return false and not connect
      const connectSpy = vi.spyOn(persistentClient, 'connect');
      const result = persistentClient.reconnect();

      expect(result).toBe(false);
      expect(connectSpy).not.toHaveBeenCalled();
      expect(persistentClient.getState().isCompleted).toBe(true);
    });

    it('should clear localStorage if response is completed when reconnect is called', () => {
      const persistentClient = new ModelRiverClient({
        debug: false,
        persist: true,
        storageKeyPrefix: 'test_modelriver',
      });

      // Save a pending request
      saveActiveRequest('test_modelriver', 'test-channel-id', validToken, 'wss://test.com/socket', 'test-channel');
      expect(getActiveRequest('test_modelriver')).not.toBeNull();

      // Simulate completed status
      const completedPayload = {
        status: 'completed',
        channel_id: 'test-channel-id',
        data: { result: 'success' },
      };
      (persistentClient as any).handleResponse(completedPayload);

      // Attempt reconnect
      persistentClient.reconnect();

      // localStorage should be cleared
      expect(getActiveRequest('test_modelriver')).toBeNull();
    });

    it('should not reconnect if isCompleted flag is true', () => {
      const persistentClient = new ModelRiverClient({
        debug: false,
        persist: true,
        storageKeyPrefix: 'test_modelriver',
      });

      // Manually set isCompleted flag
      (persistentClient as any).isCompleted = true;

      // Save a pending request
      saveActiveRequest('test_modelriver', 'test-channel-id', validToken, 'wss://test.com/socket', 'test-channel');

      // Attempt reconnect - should return false
      const connectSpy = vi.spyOn(persistentClient, 'connect');
      const result = persistentClient.reconnect();

      expect(result).toBe(false);
      expect(connectSpy).not.toHaveBeenCalled();
      expect(getActiveRequest('test_modelriver')).toBeNull(); // Should be cleared
    });

    it('should reconnect if response is not completed and hasPendingRequest is true', () => {
      const persistentClient = new ModelRiverClient({
        debug: false,
        persist: true,
        storageKeyPrefix: 'test_modelriver',
      });

      // Save a pending request
      saveActiveRequest('test_modelriver', 'test-channel-id', validToken, 'wss://test.com/socket', 'test-channel');

      // Ensure isCompleted is false
      (persistentClient as any).isCompleted = false;
      (persistentClient as any).response = null;

      // Attempt reconnect - should return true and open a socket with the stored token
      MockSocket.instances = [];
      const result = persistentClient.reconnect();

      expect(result).toBe(true);
      expect(MockSocket.instances).toHaveLength(1);
      expect(MockSocket.instances[0].token).toBe(validToken);
    });

    it('should reset isCompleted flag when starting a new connection', () => {
      const persistentClient = new ModelRiverClient({
        debug: false,
        persist: true,
        storageKeyPrefix: 'test_modelriver',
      });

      // Simulate completed status
      const completedPayload = {
        status: 'completed',
        channel_id: 'test-channel-id',
        data: { result: 'success' },
      };
      (persistentClient as any).handleResponse(completedPayload);

      expect(persistentClient.getState().isCompleted).toBe(true);

      // Start a new connection
      persistentClient.connect({
        channelId: 'new-channel-id',
        wsToken: validToken,
      });

      // isCompleted should be reset
      expect(persistentClient.getState().isCompleted).toBe(false);
    });

    it('should handle race condition: completed status received but localStorage not cleared yet', () => {
      const persistentClient = new ModelRiverClient({
        debug: false,
        persist: true,
        storageKeyPrefix: 'test_modelriver',
      });

      // Save a pending request
      saveActiveRequest('test_modelriver', 'test-channel-id', validToken, 'wss://test.com/socket', 'test-channel');

      // Simulate completed status (this clears localStorage)
      const completedPayload = {
        status: 'completed',
        channel_id: 'test-channel-id',
        data: { result: 'success' },
      };
      (persistentClient as any).handleResponse(completedPayload);

      // Even if localStorage somehow still has the request, reconnect should fail
      // because isCompleted flag is set
      const connectSpy = vi.spyOn(persistentClient, 'connect');
      const result = persistentClient.reconnect();

      expect(result).toBe(false);
      expect(connectSpy).not.toHaveBeenCalled();
      expect(persistentClient.getState().isCompleted).toBe(true);
    });

    it('should prevent multiple reconnection attempts after completed status', () => {
      const persistentClient = new ModelRiverClient({
        debug: false,
        persist: true,
        storageKeyPrefix: 'test_modelriver',
      });

      // Save a pending request
      saveActiveRequest('test_modelriver', 'test-channel-id', validToken, 'wss://test.com/socket', 'test-channel');

      // Simulate completed status
      const completedPayload = {
        status: 'completed',
        channel_id: 'test-channel-id',
        data: { result: 'success' },
      };
      (persistentClient as any).handleResponse(completedPayload);

      // Attempt multiple reconnects
      const connectSpy = vi.spyOn(persistentClient, 'connect');
      const result1 = persistentClient.reconnect();
      const result2 = persistentClient.reconnect();
      const result3 = persistentClient.reconnect();

      expect(result1).toBe(false);
      expect(result2).toBe(false);
      expect(result3).toBe(false);
      expect(connectSpy).not.toHaveBeenCalled();
    });
  });

  describe('stream events', () => {
    // Join a channel on a mocked socket and return the handlers registered with channel.on
    function joinWithHandlers(testClient: ModelRiverClient) {
      (testClient as any).socket = new Socket('wss://example.test/socket');
      (testClient as any).joinChannel('ai_response:project:channel');
      const channel = (testClient as any).channel;
      const handlers = new Map<string, (payload: unknown) => void>();
      for (const [event, handler] of channel.on.mock.calls) handlers.set(event, handler);
      return handlers;
    }

    it('should subscribe to stream events when joining a channel', () => {
      const handlers = joinWithHandlers(new ModelRiverClient({ persist: false }));
      expect([...handlers.keys()]).toEqual(
        expect.arrayContaining(['response', 'error', 'stream_start', 'stream_delta', 'stream_done', 'stream_error'])
      );
    });

    it('should emit deltas with the accumulated text', () => {
      const testClient = new ModelRiverClient({ persist: false });
      const handlers = joinWithHandlers(testClient);
      const onDelta = vi.fn();
      const onStart = vi.fn();
      testClient.on('stream_start', onStart);
      testClient.on('stream_delta', onDelta);

      handlers.get('stream_start')!({ provider: 'openai', model: 'gpt-x' });
      handlers.get('stream_delta')!({ text: 'Hel', index: 0 });
      handlers.get('stream_delta')!({ text: 'lo', index: 1 });

      expect(onStart).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-x' });
      expect(onDelta).toHaveBeenNthCalledWith(1, { text: 'Hel', index: 0 }, 'Hel');
      expect(onDelta).toHaveBeenNthCalledWith(2, { text: 'lo', index: 1 }, 'Hello');
      expect(testClient.getState().streamText).toBe('Hello');
    });

    it('should use accumulated_text from stream_done', () => {
      const testClient = new ModelRiverClient({ persist: false });
      const handlers = joinWithHandlers(testClient);
      const onDone = vi.fn();
      testClient.on('stream_done', onDone);

      handlers.get('stream_delta')!({ text: 'Hel' });
      handlers.get('stream_done')!({ finish_reason: 'stop', accumulated_text: 'Hello there' });

      expect(onDone).toHaveBeenCalledWith({ finish_reason: 'stop', accumulated_text: 'Hello there' });
      expect(testClient.getState().streamText).toBe('Hello there');
    });

    it('should emit stream_error without closing the connection', () => {
      const testClient = new ModelRiverClient({ persist: false });
      const handlers = joinWithHandlers(testClient);
      const onStreamError = vi.fn();
      const cleanupSpy = vi.spyOn(testClient as any, 'cleanupConnection');
      testClient.on('stream_error', onStreamError);

      handlers.get('stream_error')!({ message: 'provider failed', recoverable: false });

      expect(onStreamError).toHaveBeenCalledWith({ message: 'provider failed', recoverable: false });
      // The final `response` event that follows owns error state and cleanup
      expect(cleanupSpy).not.toHaveBeenCalled();
    });

    it('should reset streamed text on a new connection', () => {
      const testClient = new ModelRiverClient({ persist: false });
      const handlers = joinWithHandlers(testClient);
      handlers.get('stream_delta')!({ text: 'old answer' });

      testClient.connect({ channelId: 'next-channel', wsToken: 'next-token' });

      expect(testClient.getState().streamText).toBe('');
    });
  });

  describe('automatic reconnect with resume tokens', () => {
    const PREFIX = 'rt_';
    const TOPIC = 'ai_response:proj-1:chan-1';
    const WS_URL = 'wss://mr.test/socket';

    const sockets = () => MockSocket.instances;
    const lastSocket = () => sockets()[sockets().length - 1];

    function makeClient(options: Record<string, unknown> = {}) {
      return new ModelRiverClient({ persist: true, storageKeyPrefix: PREFIX, ...options });
    }

    function connectAndJoin(
      testClient: ModelRiverClient,
      { token = 'first-token', resume = 'resume-1' as string | null } = {}
    ) {
      testClient.connect({ channelId: 'chan-1', wsToken: token, websocketUrl: WS_URL, websocketChannel: TOPIC });
      const socket = lastSocket();
      socket.simulateOpen();
      const channel = socket.getChannel(TOPIC)!;
      channel.simulateJoinOk(resume ? { resume_token: resume } : {});
      return { socket, channel };
    }

    const reconnectInfo = (token: string) => ({
      channel_id: 'chan-1',
      project_id: 'proj-1',
      ws_token: token,
      websocket_url: WS_URL,
      websocket_channel: TOPIC,
    });

    beforeEach(() => {
      vi.useFakeTimers();
      MockSocket.instances = [];
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('stores and persists the resume token from the join reply', () => {
      const testClient = makeClient();
      testClient.connect({ channelId: 'chan-1', wsToken: 'first-token', websocketUrl: WS_URL, websocketChannel: TOPIC });
      const socket = lastSocket();
      expect(socket.token).toBe('first-token');

      // Spent once the socket opens: no longer kept anywhere
      socket.simulateOpen();
      expect(getActiveRequest(PREFIX)?.wsToken).toBe('');

      socket.getChannel(TOPIC)!.simulateJoinOk({ resume_token: 'resume-1' });
      expect(getActiveRequest(PREFIX)).toMatchObject({ channelId: 'chan-1', wsToken: 'resume-1', websocketChannel: TOPIC });
      expect((testClient as any).heldToken.value).toBe('resume-1');
    });

    it('reconnects with the resume token after a drop, keeping steps and streamed text', async () => {
      const getToken = vi.fn();
      const testClient = makeClient({ getToken });
      const reconnecting = vi.fn();
      testClient.on('reconnecting', reconnecting);
      const { socket, channel } = connectAndJoin(testClient);
      channel.simulateMessage('stream_delta', { text: 'Hel' });

      socket.simulateClose({ code: 1006 });

      expect(socket.disconnect).toHaveBeenCalled(); // cancels phoenix's own retry with the spent token
      expect(testClient.getState().connectionState).toBe('reconnecting');
      expect(reconnecting).toHaveBeenCalledWith(1, 1000);
      expect(sockets()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1000);

      expect(sockets()).toHaveLength(2);
      const next = lastSocket();
      expect(next.token).toBe('resume-1');
      expect(next.url).toBe(WS_URL);
      expect(getToken).not.toHaveBeenCalled();

      next.simulateOpen();
      next.getChannel(TOPIC)!.simulateJoinOk({ resume_token: 'resume-2' });

      const state = testClient.getState();
      expect(state.connectionState).toBe('connected');
      expect(state.steps.find((s) => s.id === 'queue')?.status).toBe('success');
      expect(state.streamText).toBe('Hel');
      expect(getActiveRequest(PREFIX)?.wsToken).toBe('resume-2');
    });

    it("disables the dropped socket's own reconnect", () => {
      const testClient = makeClient();
      const { socket } = connectAndJoin(testClient);
      const phoenixConnect = socket.connect;
      expect(phoenixConnect).toHaveBeenCalledTimes(1);

      socket.simulateClose();
      // What phoenix's reconnect timer would call after a late teardown
      socket.connect();
      expect(phoenixConnect).toHaveBeenCalledTimes(1);
    });

    it('does not regress steps when rejoining after ai_generated', async () => {
      const testClient = makeClient();
      const { socket, channel } = connectAndJoin(testClient);
      channel.simulateResponse({ status: 'ai_generated', channel_id: 'chan-1', meta: { duration_ms: 5 } });
      expect(testClient.getState().steps.find((s) => s.id === 'process')?.status).toBe('success');

      socket.simulateClose();
      await vi.advanceTimersByTimeAsync(1000);
      lastSocket().simulateOpen();
      lastSocket().getChannel(TOPIC)!.simulateJoinOk({ resume_token: 'resume-2' });

      const steps = testClient.getState().steps;
      expect(steps.find((s) => s.id === 'process')?.status).toBe('success');
      expect(steps.find((s) => s.id === 'backend')?.status).toBe('pending');
    });

    it('falls back to getToken exactly once when the resume token is refused', async () => {
      const getToken = vi.fn().mockResolvedValue(reconnectInfo('fresh-1'));
      const testClient = makeClient({ getToken });
      const { socket } = connectAndJoin(testClient);

      socket.simulateClose();
      await vi.advanceTimersByTimeAsync(1000);
      const refused = lastSocket();
      expect(refused.token).toBe('resume-1');

      // The server refuses the token: the socket fails without ever opening
      refused.simulateError();
      refused.simulateClose();
      await vi.advanceTimersByTimeAsync(2000);

      expect(getToken).toHaveBeenCalledTimes(1);
      expect(getToken).toHaveBeenCalledWith({ channelId: 'chan-1', websocketChannel: TOPIC });
      expect(sockets()).toHaveLength(3);
      expect(lastSocket().token).toBe('fresh-1');

      lastSocket().simulateOpen();
      lastSocket().getChannel(TOPIC)!.simulateJoinOk({ resume_token: 'resume-2' });
      expect(testClient.getState().connectionState).toBe('connected');
      expect(getToken).toHaveBeenCalledTimes(1);
    });

    it('stops with a final error when getToken returns null', async () => {
      const getToken = vi.fn().mockResolvedValue(null);
      const testClient = makeClient({ getToken });
      const onError = vi.fn();
      testClient.on('error', onError);
      const { socket } = connectAndJoin(testClient, { resume: null });

      socket.simulateClose();
      await vi.advanceTimersByTimeAsync(1000);

      expect(getToken).toHaveBeenCalledTimes(1);
      const state = testClient.getState();
      expect(state.connectionState).toBe('error');
      expect(state.error).toMatch(/no longer available/);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(getActiveRequest(PREFIX)).toBeNull();

      await vi.advanceTimersByTimeAsync(120_000);
      expect(getToken).toHaveBeenCalledTimes(1);
      expect(sockets()).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('backs off and retries when getToken throws', async () => {
      const getToken = vi
        .fn()
        .mockRejectedValueOnce(new Error('backend down'))
        .mockResolvedValueOnce(reconnectInfo('fresh-1'));
      const testClient = makeClient({ getToken });
      const reconnecting = vi.fn();
      testClient.on('reconnecting', reconnecting);
      const { socket } = connectAndJoin(testClient, { resume: null });

      socket.simulateClose();
      await vi.advanceTimersByTimeAsync(1000);
      expect(getToken).toHaveBeenCalledTimes(1);
      expect(reconnecting).toHaveBeenLastCalledWith(2, 2000);
      expect(testClient.getState().connectionState).toBe('reconnecting');
      expect(sockets()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1999);
      expect(getToken).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(getToken).toHaveBeenCalledTimes(2);
      expect(lastSocket().token).toBe('fresh-1');
    });

    it('uses retryDelaysMs when given', async () => {
      const testClient = makeClient({ retryDelaysMs: [50] });
      const reconnecting = vi.fn();
      testClient.on('reconnecting', reconnecting);
      const { socket } = connectAndJoin(testClient);

      socket.simulateClose();
      expect(reconnecting).toHaveBeenCalledWith(1, 50);
      await vi.advanceTimersByTimeAsync(50);
      expect(lastSocket().token).toBe('resume-1');
    });

    it('stops with a final error, without looping, when there is no way to get a token', async () => {
      const testClient = makeClient();
      const { socket } = connectAndJoin(testClient, { resume: null }); // older server: no resume token

      socket.simulateClose();
      await vi.advanceTimersByTimeAsync(1000);

      expect(testClient.getState().connectionState).toBe('error');
      expect(testClient.getState().error).toMatch(/getToken/);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(sockets()).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps trying an unopened token while offline instead of asking getToken', async () => {
      const getToken = vi.fn().mockResolvedValue(reconnectInfo('fresh-1'));
      const testClient = makeClient({ getToken });
      const { socket } = connectAndJoin(testClient);
      const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

      socket.simulateClose();
      await vi.advanceTimersByTimeAsync(1000);
      lastSocket().simulateClose(); // still offline: never opened
      await vi.advanceTimersByTimeAsync(2000);

      expect(getToken).not.toHaveBeenCalled();
      expect(sockets()).toHaveLength(3);
      expect(lastSocket().token).toBe('resume-1');

      onLine.mockReturnValue(true);
      lastSocket().simulateOpen();
      lastSocket().getChannel(TOPIC)!.simulateJoinOk({ resume_token: 'resume-2' });
      expect(testClient.getState().connectionState).toBe('connected');
    });

    it.each(['unauthorized_channel', 'unauthorized_project_access', 'invalid_channel_uuid'])(
      'treats join error %s as final',
      async (reason) => {
        const getToken = vi.fn().mockResolvedValue(reconnectInfo('fresh-1'));
        const testClient = makeClient({ getToken });
        testClient.connect({ channelId: 'chan-1', wsToken: 'first-token', websocketUrl: WS_URL, websocketChannel: TOPIC });
        const socket = lastSocket();
        socket.simulateOpen();
        socket.getChannel(TOPIC)!.simulateJoinError({ reason });

        expect(testClient.getState().connectionState).toBe('error');
        expect(socket.disconnect).toHaveBeenCalled(); // no endless phoenix rejoin
        await vi.advanceTimersByTimeAsync(60_000);
        expect(getToken).not.toHaveBeenCalled();
        expect(sockets()).toHaveLength(1);
      }
    );

    it('reconnects with a new token after a transient join error', async () => {
      const getToken = vi.fn().mockResolvedValue(reconnectInfo('fresh-1'));
      const testClient = makeClient({ getToken });
      testClient.connect({ channelId: 'chan-1', wsToken: 'first-token', websocketUrl: WS_URL, websocketChannel: TOPIC });
      lastSocket().simulateOpen();
      lastSocket().getChannel(TOPIC)!.simulateJoinError({ reason: 'join_crashed' });

      expect(testClient.getState().connectionState).toBe('reconnecting');
      await vi.advanceTimersByTimeAsync(1000);
      expect(getToken).toHaveBeenCalledTimes(1);
      expect(lastSocket().token).toBe('fresh-1');
    });

    it.each([
      { status: 'success' },
      { status: 'completed' },
      { status: 'error', error: { message: 'provider failed' } },
    ])('does not reconnect and stops timers after a terminal $status response', async (payload) => {
      const getToken = vi.fn();
      const testClient = makeClient({ getToken });
      const { socket, channel } = connectAndJoin(testClient);
      expect(vi.getTimerCount()).toBeGreaterThan(0); // heartbeat + token refresh

      channel.simulateResponse({ channel_id: 'chan-1', ...payload });

      expect(vi.getTimerCount()).toBe(0);
      expect(socket.disconnect).toHaveBeenCalled();
      socket.simulateClose();
      socket.simulateError();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(sockets()).toHaveLength(1);
      expect(getToken).not.toHaveBeenCalled();
      expect(getActiveRequest(PREFIX)).toBeNull();
    });

    it('replaces the token with each refresh_token reply', async () => {
      const testClient = makeClient();
      const { channel } = connectAndJoin(testClient);

      await vi.advanceTimersByTimeAsync(120_000);
      const refreshes = channel.pushesOf('refresh_token');
      expect(refreshes).toHaveLength(1);
      expect(refreshes[0].payload).toEqual({});

      refreshes[0].reply('ok', { resume_token: 'resume-2' });
      expect(getActiveRequest(PREFIX)?.wsToken).toBe('resume-2');
      expect((testClient as any).heldToken.value).toBe('resume-2');
    });

    it('honours tokenRefreshInterval', async () => {
      const testClient = makeClient({ tokenRefreshInterval: 30_000 });
      const { channel } = connectAndJoin(testClient);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(channel.pushesOf('refresh_token')).toHaveLength(1);
    });

    it.each(['unhandled_event', 'not_supported'])('stops refreshing after a %s reply', async (reason) => {
      const testClient = makeClient();
      const { channel } = connectAndJoin(testClient);

      await vi.advanceTimersByTimeAsync(120_000);
      channel.pushesOf('refresh_token')[0].reply('error', { reason, event: 'refresh_token' });

      await vi.advanceTimersByTimeAsync(600_000);
      expect(channel.pushesOf('refresh_token')).toHaveLength(1);
      expect((testClient as any).heldToken.value).toBe('resume-1');
    });

    it('does not refresh when the join reply has no resume token (older server)', async () => {
      const testClient = makeClient();
      const { channel } = connectAndJoin(testClient, { resume: null });
      await vi.advanceTimersByTimeAsync(600_000);
      expect(channel.pushesOf('refresh_token')).toHaveLength(0);
    });

    it('reconnect() after a reload uses the persisted resume token', () => {
      connectAndJoin(makeClient());
      expect(getActiveRequest(PREFIX)?.wsToken).toBe('resume-1');

      // A new page: a fresh client reads the stored request
      const getToken = vi.fn();
      const reloaded = makeClient({ getToken });
      expect(reloaded.hasPendingRequest()).toBe(true);
      expect(reloaded.reconnect()).toBe(true);

      const socket = lastSocket();
      expect(socket.token).toBe('resume-1');
      expect(socket.url).toBe(WS_URL);
      socket.simulateOpen();
      socket.getChannel(TOPIC)!.simulateJoinOk({ resume_token: 'resume-2' });

      expect(reloaded.getState().connectionState).toBe('connected');
      expect(reloaded.getState().steps.find((s) => s.id === 'queue')?.status).toBe('success');
      expect(getToken).not.toHaveBeenCalled();
    });

    it('reconnect() falls back to getToken when the persisted token is refused', async () => {
      connectAndJoin(makeClient());
      const getToken = vi.fn().mockResolvedValue(reconnectInfo('fresh-1'));
      const reloaded = makeClient({ getToken });
      reloaded.reconnect();

      lastSocket().simulateError();
      lastSocket().simulateClose();
      await vi.advanceTimersByTimeAsync(1000);

      expect(getToken).toHaveBeenCalledTimes(1);
      expect(lastSocket().token).toBe('fresh-1');
    });

    it('reconnect() goes straight to getToken when the stored token has expired', async () => {
      connectAndJoin(makeClient());
      vi.advanceTimersByTime(6 * 60_000); // tab closed for 6 minutes (timers stop with the page)

      const getToken = vi.fn().mockResolvedValue(reconnectInfo('fresh-1'));
      const reloaded = makeClient({ getToken });
      expect(reloaded.hasPendingRequest()).toBe(true);
      expect(reloaded.reconnect()).toBe(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(getToken).toHaveBeenCalledTimes(1);
      expect(sockets().map((s) => s.token)).not.toContain(undefined);
      expect(lastSocket().token).toBe('fresh-1');
    });

    it('reconnect() returns false for an expired token without getToken', () => {
      saveActiveRequest(PREFIX, 'chan-1', 'old-token', WS_URL, TOPIC);
      vi.advanceTimersByTime(6 * 60_000);
      const reloaded = makeClient();
      expect(reloaded.reconnect()).toBe(false);
      expect(sockets()).toHaveLength(0);
    });

    it('ignores a getToken result that arrives after disconnect()', async () => {
      let resolve!: (info: unknown) => void;
      const getToken = vi.fn(() => new Promise((r) => (resolve = r)));
      const testClient = makeClient({ getToken });
      const { socket } = connectAndJoin(testClient, { resume: null });

      socket.simulateClose();
      await vi.advanceTimersByTimeAsync(1000);
      expect(getToken).toHaveBeenCalledTimes(1);

      testClient.disconnect();
      resolve(reconnectInfo('fresh-1'));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(sockets()).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['disconnect', 'reset', 'destroy'] as const)('%s() cancels a scheduled reconnect', async (method) => {
      const testClient = makeClient();
      const { socket } = connectAndJoin(testClient);
      socket.simulateClose();
      expect(vi.getTimerCount()).toBe(1);

      testClient[method]();

      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sockets()).toHaveLength(1);
    });

    it('connect() for a new request replaces a reconnect in progress', async () => {
      const testClient = makeClient();
      const { socket } = connectAndJoin(testClient);
      socket.simulateClose();

      testClient.connect({ channelId: 'chan-2', wsToken: 'second-token', websocketUrl: WS_URL });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(sockets().map((s) => s.token)).toEqual(['first-token', 'second-token']);
      expect(getActiveRequest(PREFIX)?.channelId).toBe('chan-2');
    });

    it('detach() keeps the stored request and stops all timers', async () => {
      const testClient = makeClient();
      const { socket, channel } = connectAndJoin(testClient);

      testClient.detach();

      expect(socket.disconnect).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(getActiveRequest(PREFIX)?.wsToken).toBe('resume-1');
      await vi.advanceTimersByTimeAsync(150_000);
      expect(channel.pushesOf('refresh_token')).toHaveLength(0);
      expect(sockets()).toHaveLength(1);

      // Another client (a remount) resumes with the kept token
      expect(makeClient().reconnect()).toBe(true);
      expect(lastSocket().token).toBe('resume-1');
    });

    it('stops after 3 fetched tokens in a row are refused', async () => {
      let n = 0;
      const getToken = vi.fn(async () => reconnectInfo(`fresh-${++n}`));
      const testClient = makeClient({ getToken });
      const { socket } = connectAndJoin(testClient);
      socket.simulateClose();

      const failed = new Set([socket]);
      for (let i = 0; i < 40; i++) {
        await vi.advanceTimersByTimeAsync(31_000);
        const current = lastSocket();
        if (!failed.has(current)) {
          failed.add(current);
          current.simulateError();
          current.simulateClose();
        }
      }

      expect(testClient.getState().connectionState).toBe('error');
      expect(testClient.getState().error).toMatch(/refused/);
      expect(getToken.mock.calls.length).toBeLessThanOrEqual(3);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('stops after 3 fetched tokens in a row fail a non-final join', async () => {
      let n = 0;
      const getToken = vi.fn(async () => reconnectInfo(`fresh-${++n}`));
      const testClient = makeClient({ getToken });
      const { socket } = connectAndJoin(testClient, { resume: null });
      socket.simulateClose();

      const handled = new Set([socket]);
      for (let i = 0; i < 40; i++) {
        await vi.advanceTimersByTimeAsync(31_000);
        const current = lastSocket();
        if (!handled.has(current)) {
          handled.add(current);
          current.simulateOpen();
          current.getChannel(TOPIC)!.simulateJoinError({ reason: 'join_crashed' });
        }
      }

      expect(testClient.getState().connectionState).toBe('error');
      expect(getToken.mock.calls.length).toBeLessThanOrEqual(3);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('a getToken that keeps throwing stops after an hour without a join', async () => {
      const getToken = vi.fn().mockRejectedValue(new Error('backend down'));
      const testClient = makeClient({ getToken });
      const { socket } = connectAndJoin(testClient, { resume: null });
      socket.simulateClose();

      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(testClient.getState().connectionState).toBe('reconnecting');

      await vi.advanceTimersByTimeAsync(31 * 60_000);
      expect(testClient.getState().connectionState).toBe('error');
      expect(vi.getTimerCount()).toBe(0);
      const calls = getToken.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(getToken.mock.calls.length).toBe(calls);
    });

    it('reconnects after a drop that follows more than an hour joined', async () => {
      const getToken = vi.fn().mockResolvedValue(reconnectInfo('fresh-1'));
      const testClient = makeClient({ getToken, tokenRefreshInterval: 0 });
      const onError = vi.fn();
      const reconnecting = vi.fn();
      testClient.on('error', onError);
      testClient.on('reconnecting', reconnecting);
      const { socket } = connectAndJoin(testClient);

      await vi.advanceTimersByTimeAsync(61 * 60_000);
      socket.simulateClose();
      expect(reconnecting).toHaveBeenCalledWith(1, 1000);
      await vi.advanceTimersByTimeAsync(1000);

      expect(onError).not.toHaveBeenCalled();
      expect(getToken).toHaveBeenCalledTimes(1); // the held token is past 270s
      expect(lastSocket().token).toBe('fresh-1');
      expect(sockets()).toHaveLength(2);
    });

    it('does not reuse a resume token within 30s of its expiry', async () => {
      const getToken = vi.fn().mockResolvedValue(reconnectInfo('fresh-1'));
      const testClient = makeClient({ getToken, tokenRefreshInterval: 0 });
      const { socket } = connectAndJoin(testClient);
      vi.advanceTimersByTime(275_000); // no refresh: resume-1 is 275s old
      socket.simulateClose();
      await vi.advanceTimersByTimeAsync(1000);

      expect(getToken).toHaveBeenCalledTimes(1);
      expect(sockets().map((s) => s.token)).not.toContain('resume-1');
    });

    it('on open, leaves a newer token another tab stored', () => {
      const testClient = makeClient();
      testClient.connect({ channelId: 'chan-1', wsToken: 'first-token', websocketUrl: WS_URL, websocketChannel: TOPIC });
      saveActiveRequest(PREFIX, 'chan-1', 'other-tab-token', WS_URL, TOPIC);

      lastSocket().simulateOpen();

      expect(getActiveRequest(PREFIX)?.wsToken).toBe('other-tab-token');
    });

    it('ignores channel events from a dropped connection', async () => {
      const testClient = makeClient();
      const onResponse = vi.fn();
      testClient.on('response', onResponse);
      const { socket, channel } = connectAndJoin(testClient);
      socket.simulateClose();

      channel.simulateMessage('stream_delta', { text: 'late' });
      channel.simulateResponse({ status: 'success', channel_id: 'chan-1' });

      expect(onResponse).not.toHaveBeenCalled();
      expect(testClient.getState().streamText).toBe('');
    });

    it('never logs token values', async () => {
      const logged: unknown[] = [];
      const capture = (...args: unknown[]) => void logged.push(...args);
      vi.spyOn(console, 'log').mockImplementation(capture);
      vi.spyOn(console, 'warn').mockImplementation(capture);
      vi.spyOn(console, 'error').mockImplementation(capture);

      const getToken = vi.fn().mockResolvedValue(reconnectInfo('fresh-secret'));
      const testClient = makeClient({ debug: true, getToken });
      const { socket, channel } = connectAndJoin(testClient, { token: 'first-secret', resume: 'resume-secret' });
      await vi.advanceTimersByTimeAsync(120_000);
      channel.pushesOf('refresh_token')[0].reply('ok', { resume_token: 'refreshed-secret' });
      socket.simulateClose();
      await vi.advanceTimersByTimeAsync(1000);
      lastSocket().simulateError();
      lastSocket().simulateClose();
      await vi.advanceTimersByTimeAsync(2000);
      lastSocket().simulateOpen();
      lastSocket().getChannel(TOPIC)!.simulateJoinError({ reason: 'unauthorized_channel' });

      expect(logged.length).toBeGreaterThan(0);
      const text = logged.map((v) => (v instanceof Error ? v.message : JSON.stringify(v))).join(' ');
      expect(text).not.toMatch(/secret/);
    });
  });
});
