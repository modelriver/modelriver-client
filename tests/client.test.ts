/**
 * ModelRiverClient Unit Tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ModelRiverClient } from '../src/client';
import { clearActiveRequest, saveActiveRequest, getActiveRequest } from '../src/utils';

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

      // Attempt reconnect - should return true and call connect
      const connectSpy = vi.spyOn(persistentClient, 'connect');
      const result = persistentClient.reconnect();

      expect(result).toBe(true);
      expect(connectSpy).toHaveBeenCalled();
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
});

