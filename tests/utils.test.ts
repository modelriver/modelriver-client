/**
 * Utils Unit Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  decodeToken,
  isTokenExpired,
  buildWebSocketUrl,
  isStorageAvailable,
  saveActiveRequest,
  getActiveRequest,
  clearActiveRequest,
  createInitialSteps,
  updateStep,
  createLogger,
} from '../src/utils';

describe('decodeToken', () => {
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

  it('should decode a valid token with all fields', () => {
    const token = createTestToken({
      project_id: 'proj-123',
      channel_id: 'chan-456',
      topic: 'ai_response:proj-123:chan-456',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const result = decodeToken(token);

    expect(result.project_id).toBe('proj-123');
    expect(result.channel_id).toBe('chan-456');
    expect(result.topic).toBe('ai_response:proj-123:chan-456');
    expect(result.exp).toBeDefined();
  });

  it('should build topic if not present', () => {
    const token = createTestToken({
      project_id: 'proj-123',
      channel_id: 'chan-456',
    });

    const result = decodeToken(token);

    expect(result.topic).toBe('ai_response:proj-123:chan-456');
  });

  it('should throw for empty token', () => {
    expect(() => decodeToken('')).toThrow('Invalid token: token must be a non-empty string');
  });

  it('should throw for malformed token', () => {
    expect(() => decodeToken('not.valid')).toThrow('Invalid token: JWT must have 3 parts');
  });

  it('should throw for token missing required fields', () => {
    const token = createTestToken({ foo: 'bar' });
    expect(() => decodeToken(token)).toThrow('Invalid token: missing required fields');
  });
});

describe('isTokenExpired', () => {
  it('should return false if no expiration set', () => {
    const payload = { project_id: 'p', channel_id: 'c', topic: 't' };
    expect(isTokenExpired(payload)).toBe(false);
  });

  it('should return false if token is not expired', () => {
    const payload = {
      project_id: 'p',
      channel_id: 'c',
      topic: 't',
      exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    };
    expect(isTokenExpired(payload)).toBe(false);
  });

  it('should return true if token is expired', () => {
    const payload = {
      project_id: 'p',
      channel_id: 'c',
      topic: 't',
      exp: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
    };
    expect(isTokenExpired(payload)).toBe(true);
  });
});

describe('buildWebSocketUrl', () => {
  it('should build URL with token', () => {
    const url = buildWebSocketUrl('wss://api.modelriver.com/socket', 'test-token');
    expect(url).toBe('wss://api.modelriver.com/socket/websocket?token=test-token&vsn=2.0.0');
  });

  it('should not duplicate /websocket suffix', () => {
    const url = buildWebSocketUrl('wss://api.modelriver.com/socket/websocket', 'test-token');
    expect(url).toBe('wss://api.modelriver.com/socket/websocket?token=test-token&vsn=2.0.0');
  });

  it('should encode special characters in token', () => {
    const url = buildWebSocketUrl('wss://example.com/socket', 'token=with&special');
    expect(url).toContain('token=token%3Dwith%26special');
  });
});

describe('isStorageAvailable', () => {
  it('should return true when localStorage is available', () => {
    expect(isStorageAvailable()).toBe(true);
  });
});

describe('localStorage helpers', () => {
  const prefix = 'test_';

  beforeEach(() => {
    localStorage.clear();
  });

  describe('saveActiveRequest', () => {
    it('should save request to localStorage', () => {
      saveActiveRequest(prefix, 'chan-1', 'token-1', 'wss://api.modelriver.com/socket', 'ai_response:chan-1');

      const stored = localStorage.getItem(`${prefix}active_request`);
      expect(stored).toBeDefined();

      const parsed = JSON.parse(stored!);
      expect(parsed.channelId).toBe('chan-1');
      expect(parsed.wsToken).toBe('token-1');
      expect(parsed.websocketUrl).toBe('wss://api.modelriver.com/socket');
      expect(parsed.websocketChannel).toBe('ai_response:chan-1');
      expect(parsed.timestamp).toBeDefined();
    });
  });

  describe('getActiveRequest', () => {
    it('should return null when no request stored', () => {
      expect(getActiveRequest(prefix)).toBeNull();
    });

    it('should return stored request', () => {
      saveActiveRequest(prefix, 'chan-1', 'token-1');

      const result = getActiveRequest(prefix);

      expect(result).not.toBeNull();
      expect(result!.channelId).toBe('chan-1');
      expect(result!.wsToken).toBe('token-1');
    });

    it('should return null for expired request', () => {
      // Manually save an old request
      const oldRequest = {
        channelId: 'chan-1',
        wsToken: 'token-1',
        timestamp: Date.now() - 400000, // 6+ minutes ago
      };
      localStorage.setItem(`${prefix}active_request`, JSON.stringify(oldRequest));

      expect(getActiveRequest(prefix)).toBeNull();
    });
  });

  describe('clearActiveRequest', () => {
    it('should remove stored request', () => {
      saveActiveRequest(prefix, 'chan-1', 'token-1');
      clearActiveRequest(prefix);

      expect(localStorage.getItem(`${prefix}active_request`)).toBeNull();
    });
  });
});

describe('createInitialSteps', () => {
  it('should create 4 pending steps', () => {
    const steps = createInitialSteps();

    expect(steps).toHaveLength(4);
    expect(steps[0]).toEqual({ id: 'queue', name: 'Queueing request', status: 'pending' });
    expect(steps[1]).toEqual({ id: 'process', name: 'Processing AI request', status: 'pending' });
    expect(steps[2]).toEqual({ id: 'receive', name: 'Waiting for response', status: 'pending' });
    expect(steps[3]).toEqual({ id: 'complete', name: 'Response received', status: 'pending' });
  });
});

describe('updateStep', () => {
  it('should update matching step', () => {
    const steps = createInitialSteps();
    const updated = updateStep(steps, 'queue', { status: 'loading' });

    expect(updated[0].status).toBe('loading');
    expect(updated[1].status).toBe('pending'); // Others unchanged
  });

  it('should not mutate original array', () => {
    const steps = createInitialSteps();
    const updated = updateStep(steps, 'queue', { status: 'loading' });

    expect(steps[0].status).toBe('pending');
    expect(updated).not.toBe(steps);
  });
});

describe('createLogger', () => {
  it('should log when debug is true', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger(true);

    logger.log('test message');

    expect(consoleSpy).toHaveBeenCalledWith('[ModelRiver]', 'test message');
    consoleSpy.mockRestore();
  });

  it('should not log when debug is false', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger(false);

    logger.log('test message');

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('should always log errors', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger(false);

    logger.error('error message');

    expect(consoleSpy).toHaveBeenCalledWith('[ModelRiver]', 'error message');
    consoleSpy.mockRestore();
  });
});

