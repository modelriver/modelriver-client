/**
 * subscribeToSession Unit Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Callback = (...args: any[]) => void;

// A Phoenix mock the tests can drive: open/close sockets, answer joins, push events.
vi.mock('phoenix', () => {
  class FakeChannel {
    topic: string;
    handlers = new Map<string, Callback>();
    joinReplies = new Map<string, Callback>();
    constructor(topic: string) {
      this.topic = topic;
    }
    on(event: string, cb: Callback) {
      this.handlers.set(event, cb);
    }
    join() {
      const push = {
        receive: (status: string, cb: Callback) => {
          this.joinReplies.set(status, cb);
          return push;
        },
      };
      return push;
    }
    reply(status: 'ok' | 'error' | 'timeout', payload?: unknown) {
      this.joinReplies.get(status)?.(payload);
    }
    emit(event: string, payload: unknown) {
      this.handlers.get(event)?.(payload);
    }
  }

  class FakeSocket {
    static all: FakeSocket[] = [];
    url: string;
    opts: any;
    channels: FakeChannel[] = [];
    closeCbs: Callback[] = [];
    errorCbs: Callback[] = [];
    connect = vi.fn();
    disconnect = vi.fn(() => this.closeCbs.forEach((cb) => cb({ code: 1000 })));
    constructor(url: string, opts: any) {
      this.url = url;
      this.opts = opts;
      FakeSocket.all.push(this);
    }
    onOpen() {}
    onClose(cb: Callback) {
      this.closeCbs.push(cb);
    }
    onError(cb: Callback) {
      this.errorCbs.push(cb);
    }
    channel(topic: string) {
      const channel = new FakeChannel(topic);
      this.channels.push(channel);
      return channel;
    }
    drop() {
      this.closeCbs.forEach((cb) => cb({ code: 1006 }));
    }
  }

  return { Socket: FakeSocket, Channel: FakeChannel };
});

import { Socket } from 'phoenix';
import { subscribeToSession } from '../src/session';

const sockets = () => (Socket as any).all as any[];
const lastSocket = () => sockets()[sockets().length - 1];
const channelOf = (socket: any) => socket.channels[0];

const info = (n = 1) => ({
  ws_token: `token-${n}`,
  websocket_url: 'wss://api.example.com/socket',
  websocket_channel: 'session:proj:sess',
});

// Lets the awaited getSubscription() settle.
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('subscribeToSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (Socket as any).all.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects with a fresh token, joins the session and forwards events', async () => {
    const onMessage = vi.fn();
    const onSignal = vi.fn();
    const onLive = vi.fn();
    const statuses: string[] = [];
    const sub = subscribeToSession({
      getSubscription: async () => info(),
      onMessage,
      onSignal,
      onLive,
      onStatus: (s) => statuses.push(s),
    });
    await settle();

    const socket = lastSocket();
    expect(socket.url).toBe('wss://api.example.com/socket');
    expect(socket.opts.params).toEqual({ token: 'token-1' });
    expect(socket.connect).toHaveBeenCalled();
    expect(channelOf(socket).topic).toBe('session:proj:sess');

    channelOf(socket).reply('ok');
    expect(sub.status).toBe('live');
    expect(onLive).toHaveBeenCalledTimes(1);

    const message = { id: 'log:assistant', session_id: 'sess', role: 'assistant', author: 'agent', content: 'Hi' };
    channelOf(socket).emit('message', message);
    channelOf(socket).emit('signal', { name: 'agent.joined', data: { name: 'Dana' } });
    expect(onMessage).toHaveBeenCalledWith(message);
    expect(onSignal).toHaveBeenCalledWith({ name: 'agent.joined', data: { name: 'Dana' } });
    expect(statuses).toEqual(['connecting', 'live']);
  });

  it('accepts camelCase subscription info and adds /socket', async () => {
    subscribeToSession({
      getSubscription: async () => ({ wsToken: 't', websocketUrl: 'ws://localhost:4000', websocketChannel: 'session:p:s' }),
    });
    await settle();
    expect(lastSocket().url).toBe('ws://localhost:4000/socket');
    expect(lastSocket().opts.params).toEqual({ token: 't' });
  });

  it('reconnects with a new token after the connection drops, and catches up', async () => {
    let n = 0;
    const getSubscription = vi.fn(async () => info(++n));
    const onLive = vi.fn();
    const sub = subscribeToSession({ getSubscription, onLive, retryDelaysMs: [1000, 5000] });
    await settle();
    const first = lastSocket();
    channelOf(first).reply('ok');

    first.drop();
    // The spent token is never reused: phoenix's own reconnect is cancelled.
    expect(first.disconnect).toHaveBeenCalled();
    expect(sub.status).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(999);
    expect(getSubscription).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getSubscription).toHaveBeenCalledTimes(2);

    const second = lastSocket();
    expect(second).not.toBe(first);
    expect(second.opts.params).toEqual({ token: 'token-2' });
    channelOf(second).reply('ok');
    expect(sub.status).toBe('live');
    expect(onLive).toHaveBeenCalledTimes(2);
  });

  it('backs off while the backend can’t give a token, then recovers', async () => {
    let fails = 2;
    const getSubscription = vi.fn(async () => {
      if (fails-- > 0) throw new Error('backend down');
      return info();
    });
    const onError = vi.fn();
    subscribeToSession({ getSubscription, onError, retryDelaysMs: [100, 300] });
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(sockets()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(100); // first retry, fails again
    expect(getSubscription).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(299);
    expect(getSubscription).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); // second retry waits the longer delay
    expect(getSubscription).toHaveBeenCalledTimes(3);
    expect(sockets()).toHaveLength(1);
  });

  it('stops for good when the session is gone or the token doesn’t fit', async () => {
    for (const reason of ['session_not_found', 'unauthorized_session']) {
      const getSubscription = vi.fn(async () => info());
      const onError = vi.fn();
      const sub = subscribeToSession({ getSubscription, onError });
      await settle();
      channelOf(lastSocket()).reply('error', { reason });

      expect(sub.status).toBe('closed');
      expect(onError.mock.calls[0]![0].message).toContain(reason);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getSubscription).toHaveBeenCalledTimes(1);
    }
  });

  it('retries other join failures', async () => {
    const getSubscription = vi.fn(async () => info());
    const sub = subscribeToSession({ getSubscription, retryDelaysMs: [10] });
    await settle();
    channelOf(lastSocket()).reply('error', { reason: 'join_crashed' });
    expect(sub.status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(10);
    expect(getSubscription).toHaveBeenCalledTimes(2);
  });

  it('closes when the session is deleted', async () => {
    const onDeleted = vi.fn();
    const sub = subscribeToSession({ getSubscription: async () => info(), onDeleted });
    await settle();
    const socket = lastSocket();
    channelOf(socket).reply('ok');
    channelOf(socket).emit('deleted', { session_id: 'sess' });

    expect(onDeleted).toHaveBeenCalledWith({ session_id: 'sess' });
    expect(sub.status).toBe('closed');
    expect(socket.disconnect).toHaveBeenCalled();
  });

  it('close() ends it, even while a token is on its way', async () => {
    let resolve!: (value: ReturnType<typeof info>) => void;
    const sub = subscribeToSession({ getSubscription: () => new Promise((r) => (resolve = r)) });
    sub.close();
    resolve(info());
    await settle();
    expect(sockets()).toHaveLength(0);
    expect(sub.status).toBe('closed');
  });

  it('does nothing when there is no session to follow', async () => {
    const sub = subscribeToSession({ getSubscription: async () => null });
    await settle();
    expect(sockets()).toHaveLength(0);
    expect(sub.status).toBe('closed');
  });
});
