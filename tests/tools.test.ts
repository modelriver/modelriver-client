/**
 * Hosted tools: tool progress events, the toolCalls state and cancel()
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('phoenix', async () => {
  const { MockSocket, MockChannel } = await import('./mocks/phoenix');
  return { Socket: MockSocket, Channel: MockChannel };
});

import { ModelRiverClient } from '../src/client';
import type { ToolCall, ToolRound } from '../src/types';
import { MockSocket } from './mocks/phoenix';

const TOPIC = 'ai_response:proj-1:chan-1';
const WS_URL = 'wss://mr.test/socket';

// The payloads below are what the server sends (lib/modelriver/tool_loop/progress.ex)
const ROUND_1 = { round: 1, max_rounds: 5 };
const SALES_STARTED = { id: 'tc_a1', name: 'get_sales_summary', label: 'Reading this week’s sales…', round: 1 };
const SALES_DONE = { id: 'tc_a1', name: 'get_sales_summary', round: 1, status: 'ok', duration_ms: 182, user_message: null };
const STOCK_STARTED = { id: 'tc_b2', name: 'get_stock_levels', label: null, round: 1 };
const STOCK_FAILED = {
  id: 'tc_b2',
  name: 'get_stock_levels',
  round: 1,
  status: 'error',
  duration_ms: 40,
  user_message: 'Stock levels are being updated. Try again in a minute.',
};

const ANSWER = {
  status: 'success',
  channel_id: 'chan-1',
  data: { choices: [{ message: { role: 'assistant', content: 'Sales are up 12% this week.' } }] },
  meta: { status: 'success', workflow: 'sales_chat', duration_ms: 2140, tool_loop: { rounds: 2, tool_calls: 2 } },
};

const CANCELLED = {
  status: 'error',
  message: 'The request was cancelled.',
  error: { type: 'cancelled', message: 'The request was cancelled.', details: 'The request was cancelled.', workflow: 'sales_chat' },
  meta: { status: 'error', http_status: 422, workflow: 'sales_chat', tool_loop: { rounds: 1, tool_calls: 1 } },
};

describe('hosted tools', () => {
  const lastSocket = () => MockSocket.instances[MockSocket.instances.length - 1];

  function connectAndJoin(client: ModelRiverClient, resume: string | null = 'resume-1') {
    client.connect({ channelId: 'chan-1', wsToken: 'first-token', websocketUrl: WS_URL, websocketChannel: TOPIC });
    const socket = lastSocket();
    socket.simulateOpen();
    const channel = socket.getChannel(TOPIC)!;
    channel.simulateJoinOk(resume ? { resume_token: resume } : {});
    return { socket, channel };
  }

  let client: ModelRiverClient;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    MockSocket.instances = [];
    client = new ModelRiverClient({ persist: true, storageKeyPrefix: 'tools_' });
  });

  afterEach(() => {
    client.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  describe('progress', () => {
    it('starts with no tool calls and no round', () => {
      expect(client.getState().toolCalls).toEqual([]);
      expect(client.getState().toolRound).toBeNull();
    });

    it('tracks each call from running to finished, in the order they started', () => {
      const { channel } = connectAndJoin(client);
      const seen: Array<{ calls: ToolCall[]; round: ToolRound | null }> = [];
      client.on('tool_calls', (calls, round) => seen.push({ calls, round }));

      channel.simulateMessage('tool_round_started', ROUND_1);
      channel.simulateMessage('tool_call_started', SALES_STARTED);
      channel.simulateMessage('tool_call_started', STOCK_STARTED);

      expect(client.getState().toolRound).toEqual(ROUND_1);
      expect(client.getState().toolCalls).toEqual([
        { id: 'tc_a1', name: 'get_sales_summary', label: 'Reading this week’s sales…', round: 1, status: 'running' },
        { id: 'tc_b2', name: 'get_stock_levels', label: null, round: 1, status: 'running' },
      ]);

      // The second call finishes first: the order stays the order they started
      channel.simulateMessage('tool_call_completed', STOCK_FAILED);
      channel.simulateMessage('tool_call_completed', SALES_DONE);

      expect(client.getState().toolCalls).toEqual([
        {
          id: 'tc_a1',
          name: 'get_sales_summary',
          label: 'Reading this week’s sales…',
          round: 1,
          status: 'ok',
          duration_ms: 182,
          user_message: null,
        },
        {
          id: 'tc_b2',
          name: 'get_stock_levels',
          label: null,
          round: 1,
          status: 'error',
          duration_ms: 40,
          user_message: 'Stock levels are being updated. Try again in a minute.',
        },
      ]);

      // One tool_calls event per change, each with the whole list
      expect(seen).toHaveLength(5);
      expect(seen[4].calls).toEqual(client.getState().toolCalls);
      expect(seen[4].round).toEqual(ROUND_1);
    });

    it('also emits the raw events', () => {
      const { channel } = connectAndJoin(client);
      const onRound = vi.fn();
      const onStarted = vi.fn();
      const onCompleted = vi.fn();
      client.on('tool_round_started', onRound);
      client.on('tool_call_started', onStarted);
      client.on('tool_call_completed', onCompleted);

      channel.simulateMessage('tool_round_started', ROUND_1);
      channel.simulateMessage('tool_call_started', SALES_STARTED);
      channel.simulateMessage('tool_call_completed', SALES_DONE);

      expect(onRound).toHaveBeenCalledWith(ROUND_1);
      expect(onStarted).toHaveBeenCalledWith(SALES_STARTED);
      expect(onCompleted).toHaveBeenCalledWith(SALES_DONE);
    });

    it('adds a call whose start it never saw', () => {
      const { channel } = connectAndJoin(client);

      channel.simulateMessage('tool_call_completed', SALES_DONE);

      expect(client.getState().toolCalls).toEqual([
        { id: 'tc_a1', name: 'get_sales_summary', round: 1, status: 'ok', duration_ms: 182, user_message: null },
      ]);
    });

    it('hands out copies, so a listener cannot change the client’s state', () => {
      const { channel } = connectAndJoin(client);
      client.on('tool_calls', (calls) => {
        calls[0]!.status = 'error';
      });

      channel.simulateMessage('tool_call_started', SALES_STARTED);

      expect(client.getState().toolCalls![0]!.status).toBe('running');
    });

    it('keeps the round and the calls across later rounds', () => {
      const { channel } = connectAndJoin(client);
      channel.simulateMessage('tool_round_started', ROUND_1);
      channel.simulateMessage('tool_call_started', SALES_STARTED);
      channel.simulateMessage('tool_call_completed', SALES_DONE);
      channel.simulateMessage('tool_round_started', { round: 2, max_rounds: 5 });

      expect(client.getState().toolRound).toEqual({ round: 2, max_rounds: 5 });
      expect(client.getState().toolCalls).toHaveLength(1);
    });
  });

  describe('joining part-way', () => {
    it('takes the server’s tool_state as where things stand', () => {
      const { channel } = connectAndJoin(client);
      const onState = vi.fn();
      client.on('tool_state', onState);

      const snapshot = {
        round: 2,
        max_rounds: 5,
        calls: [
          { ...SALES_STARTED, status: 'ok', duration_ms: 182, user_message: null },
          { id: 'tc_c3', name: 'get_top_products', label: 'Finding top products…', round: 2, status: 'running' },
        ],
      };
      channel.simulateMessage('tool_state', snapshot);

      expect(onState).toHaveBeenCalledWith(snapshot);
      expect(client.getState().toolRound).toEqual({ round: 2, max_rounds: 5 });
      expect(client.getState().toolCalls!.map((call) => [call.name, call.status])).toEqual([
        ['get_sales_summary', 'ok'],
        ['get_top_products', 'running'],
      ]);
    });

    it('replaces what it had with the snapshot after a reconnect', async () => {
      const { socket, channel } = connectAndJoin(client);
      channel.simulateMessage('tool_round_started', ROUND_1);
      channel.simulateMessage('tool_call_started', SALES_STARTED);

      socket.simulateClose({ code: 1006 });
      // Nothing is thrown away while the client is away
      expect(client.getState().toolCalls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1000);
      const next = lastSocket();
      next.simulateOpen();
      const rejoined = next.getChannel(TOPIC)!;
      rejoined.simulateJoinOk({ resume_token: 'resume-2' });

      // No snapshot yet (it is kept on one server node): the list is as it was
      expect(client.getState().toolCalls!.map((call) => call.status)).toEqual(['running']);

      rejoined.simulateMessage('tool_state', {
        round: 1,
        max_rounds: 5,
        calls: [{ ...SALES_STARTED, status: 'ok', duration_ms: 182, user_message: null }],
      });

      expect(client.getState().toolCalls!.map((call) => call.status)).toEqual(['ok']);
    });
  });

  describe('when the request ends', () => {
    it('keeps the finished calls next to the answer', () => {
      const { channel } = connectAndJoin(client);
      channel.simulateMessage('tool_call_started', SALES_STARTED);
      channel.simulateMessage('tool_call_completed', SALES_DONE);

      channel.simulateResponse(ANSWER);

      const state = client.getState();
      expect(state.response?.meta?.tool_loop).toEqual({ rounds: 2, tool_calls: 2 });
      expect(state.toolCalls!.map((call) => call.status)).toEqual(['ok']);
    });

    it('stops the spinner of a call it never saw finish', () => {
      const { channel } = connectAndJoin(client);
      const onToolCalls = vi.fn();
      channel.simulateMessage('tool_call_started', SALES_STARTED);
      client.on('tool_calls', onToolCalls);

      channel.simulateResponse(ANSWER);

      expect(client.getState().toolCalls!.map((call) => call.status)).toEqual(['ended']);
      expect(onToolCalls).toHaveBeenCalledTimes(1);
    });

    it('starts the next request with an empty list', () => {
      const { channel } = connectAndJoin(client);
      channel.simulateMessage('tool_round_started', ROUND_1);
      channel.simulateMessage('tool_call_started', SALES_STARTED);
      channel.simulateResponse(ANSWER);
      const onToolCalls = vi.fn();
      client.on('tool_calls', onToolCalls);

      client.connect({ channelId: 'chan-2', wsToken: 'second-token', websocketUrl: WS_URL });

      expect(client.getState().toolCalls).toEqual([]);
      expect(client.getState().toolRound).toBeNull();
      expect(onToolCalls).toHaveBeenCalledWith([], null);
    });

    it('reset() clears the list', () => {
      const { channel } = connectAndJoin(client);
      channel.simulateMessage('tool_call_started', SALES_STARTED);

      client.reset();

      expect(client.getState().toolCalls).toEqual([]);
    });
  });

  describe('cancel()', () => {
    it('asks the server to stop and resolves true when it agrees', async () => {
      const { channel } = connectAndJoin(client);

      const stopping = client.cancel();
      const [push] = channel.pushesOf('cancel');
      expect(push).toBeDefined();
      push!.reply('ok', { status: 'cancel_requested' });

      await expect(stopping).resolves.toBe(true);
    });

    it('keeps listening: the final response says the request was cancelled', async () => {
      const { channel } = connectAndJoin(client);
      const onResponse = vi.fn();
      client.on('response', onResponse);
      channel.simulateMessage('tool_call_started', SALES_STARTED);

      const stopping = client.cancel();
      channel.pushesOf('cancel')[0]!.reply('ok', { status: 'cancel_requested' });
      await stopping;

      // Still connected and waiting
      expect(client.getState().connectionState).toBe('connected');
      expect(onResponse).not.toHaveBeenCalled();

      // The call under way finished, then the request ended
      channel.simulateMessage('tool_call_completed', SALES_DONE);
      channel.simulateResponse(CANCELLED);

      expect(onResponse).toHaveBeenCalledWith(CANCELLED);
      const state = client.getState();
      expect(state.error).toBe('The request was cancelled.');
      expect(state.toolCalls!.map((call) => call.status)).toEqual(['ok']);
      expect(client.hasPendingRequest()).toBe(false);
    });

    it('resolves false on a server without hosted tools', async () => {
      const { channel } = connectAndJoin(client);

      const stopping = client.cancel();
      channel.pushesOf('cancel')[0]!.reply('error', { reason: 'unhandled_event', event: 'cancel' });

      await expect(stopping).resolves.toBe(false);
    });

    it('resolves false when the server does not answer', async () => {
      const { channel } = connectAndJoin(client);

      const stopping = client.cancel();
      channel.pushesOf('cancel')[0]!.reply('timeout');

      await expect(stopping).resolves.toBe(false);
    });

    it('resolves false, and sends nothing, without a joined request', async () => {
      await expect(client.cancel()).resolves.toBe(false);

      client.connect({ channelId: 'chan-1', wsToken: 'first-token', websocketUrl: WS_URL, websocketChannel: TOPIC });
      const socket = lastSocket();
      socket.simulateOpen();
      // Socket open, channel not joined yet
      await expect(client.cancel()).resolves.toBe(false);
      expect(socket.getChannel(TOPIC)!.pushesOf('cancel')).toHaveLength(0);
    });

    it('resolves false once the request has ended', async () => {
      const { channel } = connectAndJoin(client);
      channel.simulateResponse(ANSWER);

      await expect(client.cancel()).resolves.toBe(false);
    });
  });
});
