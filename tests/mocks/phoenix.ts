/**
 * Mock Phoenix Socket for Testing
 *
 * A Phoenix Socket/Channel double the tests can drive: open, close and fail
 * sockets, answer joins and pushes with payloads, and deliver channel events.
 *
 * Use it in a test file with:
 *   vi.mock('phoenix', async () => {
 *     const { MockSocket, MockChannel } = await import('./mocks/phoenix');
 *     return { Socket: MockSocket, Channel: MockChannel };
 *   });
 */

import { vi } from 'vitest';

type Callback = (...args: any[]) => void;
type ReplyStatus = 'ok' | 'error' | 'timeout';

/**
 * Mock Phoenix Push (what join() and push() return)
 */
export class MockPush {
  event: string;
  payload: unknown;
  private hooks = new Map<ReplyStatus, Callback[]>();

  constructor(event: string, payload?: unknown) {
    this.event = event;
    this.payload = payload;
  }

  receive(status: ReplyStatus, callback: Callback) {
    if (!this.hooks.has(status)) this.hooks.set(status, []);
    this.hooks.get(status)!.push(callback);
    return this;
  }

  /** Answer the push, as the server would */
  reply(status: ReplyStatus, payload?: unknown) {
    this.hooks.get(status)?.forEach((cb) => cb(payload));
  }
}

/**
 * Mock Phoenix Channel
 */
export class MockChannel {
  topic: string;
  params: unknown;
  joinPush = new MockPush('phx_join');
  /** Every push(), in order */
  pushes: MockPush[] = [];
  private listeners: Map<string, Set<Callback>> = new Map();

  constructor(topic: string, params?: unknown) {
    this.topic = topic;
    this.params = params;
  }

  /**
   * Join the channel
   */
  join() {
    return this.joinPush;
  }

  /**
   * Leave the channel
   */
  leave = vi.fn();

  /**
   * Subscribe to events
   */
  on = vi.fn((event: string, callback: Callback) => {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  });

  /**
   * Push message to channel
   */
  push = vi.fn((event: string, payload?: unknown) => {
    const push = new MockPush(event, payload);
    this.pushes.push(push);
    return push;
  });

  // Test helpers

  /** Pushes sent with this event name */
  pushesOf(event: string): MockPush[] {
    return this.pushes.filter((p) => p.event === event);
  }

  /**
   * Simulate successful join (optionally with a reply payload)
   */
  simulateJoinOk(payload?: unknown) {
    this.joinPush.reply('ok', payload);
  }

  /**
   * Simulate join error
   */
  simulateJoinError(error: { reason?: string } = {}) {
    this.joinPush.reply('error', error);
  }

  /**
   * Simulate join timeout
   */
  simulateJoinTimeout() {
    this.joinPush.reply('timeout');
  }

  /**
   * Simulate receiving a message
   */
  simulateMessage(event: string, payload: any) {
    this.listeners.get(event)?.forEach((cb) => cb(payload));
  }

  /**
   * Simulate error event
   */
  simulateError(error: { message?: string } = {}) {
    this.simulateMessage('error', error);
  }

  /**
   * Simulate AI response
   */
  simulateResponse(payload: any) {
    this.simulateMessage('response', payload);
  }
}

/**
 * Mock Phoenix Socket
 */
export class MockSocket {
  /** Every socket built, in order (reset it in beforeEach) */
  static instances: MockSocket[] = [];

  url: string;
  opts?: any;
  channels: MockChannel[] = [];
  private openCallbacks: Callback[] = [];
  private closeCallbacks: Callback[] = [];
  private errorCallbacks: Callback[] = [];
  private connected = false;

  constructor(url: string, opts?: any) {
    this.url = url;
    this.opts = opts;
    MockSocket.instances.push(this);
  }

  /**
   * Connect to socket. Nothing happens until the test calls simulateOpen().
   */
  connect = vi.fn();

  /**
   * Disconnect from socket. Like Phoenix, this fires the close callbacks.
   */
  disconnect = vi.fn(() => {
    this.connected = false;
    this.closeCallbacks.forEach((cb) => cb({ code: 1000, reason: 'Normal closure' }));
  });

  /**
   * Register open callback
   */
  onOpen(callback: Callback) {
    this.openCallbacks.push(callback);
  }

  /**
   * Register close callback
   */
  onClose(callback: Callback) {
    this.closeCallbacks.push(callback);
  }

  /**
   * Register error callback
   */
  onError(callback: Callback) {
    this.errorCallbacks.push(callback);
  }

  /**
   * Create a channel
   */
  channel(topic: string, params?: unknown) {
    const channel = new MockChannel(topic, params);
    this.channels.push(channel);
    return channel;
  }

  // Test helpers

  /** The token this socket was built with */
  get token(): string | undefined {
    return this.opts?.params?.token;
  }

  /**
   * Simulate connection open
   */
  simulateOpen() {
    this.connected = true;
    this.openCallbacks.forEach((cb) => cb());
  }

  /**
   * Simulate connection close
   */
  simulateClose(event: { code?: number; reason?: string } = { code: 1006 }) {
    this.connected = false;
    this.closeCallbacks.forEach((cb) => cb(event));
  }

  /**
   * Simulate connection error
   */
  simulateError(error: any = new Error('Connection error')) {
    this.errorCallbacks.forEach((cb) => cb(error));
  }

  /**
   * Get the latest channel for a topic
   */
  getChannel(topic: string): MockChannel | undefined {
    return [...this.channels].reverse().find((c) => c.topic === topic);
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }
}

/**
 * Create mock Phoenix module
 */
export function createMockPhoenix() {
  let currentSocket: MockSocket | null = null;

  return {
    Socket: vi.fn().mockImplementation((url: string, opts?: any) => {
      currentSocket = new MockSocket(url, opts);
      return currentSocket;
    }),
    Channel: MockChannel,
    getCurrentSocket: () => currentSocket,
  };
}
