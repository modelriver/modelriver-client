/**
 * React Hook Unit Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StrictMode } from 'react';

// A Phoenix double the tests can drive (replies with payloads, open/close/error)
vi.mock('phoenix', async () => {
  const { MockSocket, MockChannel } = await import('./mocks/phoenix');
  return { Socket: MockSocket, Channel: MockChannel };
});

import { renderHook, act } from '@testing-library/react';
import { useModelRiver } from '../src/react';
import { ModelRiverClient } from '../src/client';
import { saveActiveRequest, getActiveRequest } from '../src/utils';
import { MockSocket } from './mocks/phoenix';

describe('useModelRiver', () => {
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
    localStorage.clear();
  });

  describe('initial state', () => {
    it('should return correct initial state', () => {
      const { result } = renderHook(() => useModelRiver({ persist: false }));

      expect(result.current.connectionState).toBe('disconnected');
      expect(result.current.isConnected).toBe(false);
      expect(result.current.isConnecting).toBe(false);
      expect(result.current.steps).toEqual([]);
      expect(result.current.response).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.hasPendingRequest).toBe(false);
    });

    it('should provide connect, disconnect, and reset functions', () => {
      const { result } = renderHook(() => useModelRiver({ persist: false }));

      expect(typeof result.current.connect).toBe('function');
      expect(typeof result.current.disconnect).toBe('function');
      expect(typeof result.current.reset).toBe('function');
    });
  });

  describe('connect', () => {
    it('should update state on connect', () => {
      const { result } = renderHook(() => useModelRiver({ persist: false }));

      act(() => {
        result.current.connect({ channelId: 'test-channel', wsToken: validToken });
      });

      // Should have pending request after connect is called
      expect(result.current.hasPendingRequest).toBe(true);
    });

    it('should set error when wsToken is missing', () => {
      const { result } = renderHook(() => useModelRiver({ persist: false }));

      act(() => {
        result.current.connect({ channelId: 'test-channel', wsToken: '' });
      });

      expect(result.current.error).toBe('wsToken is required for WebSocket authentication');
      expect(result.current.connectionState).toBe('error');
    });
  });

  describe('disconnect', () => {
    it('should reset hasPendingRequest', () => {
      const { result } = renderHook(() => useModelRiver({ persist: false }));

      act(() => {
        result.current.connect({ channelId: 'test-channel', wsToken: validToken });
      });

      act(() => {
        result.current.disconnect();
      });

      expect(result.current.hasPendingRequest).toBe(false);
    });
  });

  describe('backend pipeline progress', () => {
    it('should keep hasPendingRequest true on intermediate statuses', () => {
      const onSpy = vi.spyOn(ModelRiverClient.prototype, 'on');
      const { result } = renderHook(() =>
        useModelRiver({ persist: true, storageKeyPrefix: 'test_modelriver' })
      );

      const responseHandler = onSpy.mock.calls.find(([event]) => event === 'response')?.[1] as
        | ((data: unknown) => void)
        | undefined;
      expect(responseHandler).toBeDefined();

      saveActiveRequest('test_modelriver', 'test-channel', validToken, 'wss://test.com/socket', 'test-channel');

      act(() => {
        responseHandler!({ status: 'step_ready', channel_id: 'test-channel', step_index: 0 });
      });

      expect(result.current.response?.status).toBe('step_ready');
      expect(result.current.hasPendingRequest).toBe(true);

      onSpy.mockRestore();
    });
  });

  describe('reset', () => {
    it('should reset all state', () => {
      const { result } = renderHook(() => useModelRiver({ persist: false }));

      act(() => {
        result.current.connect({ channelId: 'test-channel', wsToken: validToken });
      });

      act(() => {
        result.current.reset();
      });

      expect(result.current.connectionState).toBe('disconnected');
      expect(result.current.steps).toEqual([]);
      expect(result.current.response).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.hasPendingRequest).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('should cleanup on unmount', () => {
      const { unmount } = renderHook(() => useModelRiver({ persist: false }));

      // Should not throw
      expect(() => unmount()).not.toThrow();
    });
  });

  describe('resuming a stored request', () => {
    const PREFIX = 'modelriver_'; // the default prefix
    const TOPIC = 'ai_response:proj-1:chan-1';
    const WS_URL = 'wss://mr.test/socket';

    beforeEach(() => {
      vi.useFakeTimers();
      MockSocket.instances = [];
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('spends the stored resume token exactly once under StrictMode', async () => {
      saveActiveRequest(PREFIX, 'chan-1', 'resume-1', WS_URL, TOPIC);
      const getToken = vi.fn();
      const detachSpy = vi.spyOn(ModelRiverClient.prototype, 'detach');

      const { result } = renderHook(() => useModelRiver({ getToken }), { wrapper: StrictMode });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // StrictMode mounted, unmounted and remounted: the first client detached without a socket
      expect(detachSpy).toHaveBeenCalledTimes(1);
      expect(MockSocket.instances).toHaveLength(1);
      expect(MockSocket.instances[0].token).toBe('resume-1');
      expect(getToken).not.toHaveBeenCalled();
      expect(result.current.hasPendingRequest).toBe(true);
    });

    it('detaches on unmount while pending: no timers left, stored request kept', async () => {
      saveActiveRequest(PREFIX, 'chan-1', 'resume-1', WS_URL, TOPIC);
      const { result, unmount } = renderHook(() => useModelRiver({}));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const socket = MockSocket.instances[0];
      act(() => {
        socket.simulateOpen();
        socket.getChannel(TOPIC)!.simulateJoinOk({ resume_token: 'resume-2' });
      });
      expect(result.current.connectionState).toBe('connected');
      expect(vi.getTimerCount()).toBeGreaterThan(0); // heartbeat + token refresh

      unmount();

      expect(vi.getTimerCount()).toBe(0);
      expect(socket.disconnect).toHaveBeenCalled();
      expect(getActiveRequest(PREFIX)?.wsToken).toBe('resume-2');
    });

    it('shows the reconnecting state after a drop', async () => {
      saveActiveRequest(PREFIX, 'chan-1', 'resume-1', WS_URL, TOPIC);
      const { result } = renderHook(() => useModelRiver({}));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const socket = MockSocket.instances[0];
      act(() => {
        socket.simulateOpen();
        socket.getChannel(TOPIC)!.simulateJoinOk({ resume_token: 'resume-2' });
      });

      act(() => socket.simulateClose());

      expect(result.current.connectionState).toBe('reconnecting');
    });

    it('clears the default-prefix stored request on a completed response', () => {
      const onSpy = vi.spyOn(ModelRiverClient.prototype, 'on');
      renderHook(() => useModelRiver({}));
      const responseHandler = onSpy.mock.calls.find(([event]) => event === 'response')?.[1] as
        | ((data: unknown) => void)
        | undefined;

      saveActiveRequest(PREFIX, 'chan-1', 'resume-1', WS_URL, TOPIC);
      expect(getActiveRequest(PREFIX)).not.toBeNull();

      act(() => {
        responseHandler!({ status: 'completed', channel_id: 'chan-1' });
      });

      expect(localStorage.getItem('modelriver_active_request')).toBeNull();
    });
  });
});
