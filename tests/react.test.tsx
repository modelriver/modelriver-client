/**
 * React Hook Unit Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useModelRiver } from '../src/react';

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
});
