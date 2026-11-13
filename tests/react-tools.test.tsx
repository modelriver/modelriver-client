/**
 * React hook: hosted tools state, cancel() and streamed text
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('phoenix', async () => {
  const { MockSocket, MockChannel } = await import('./mocks/phoenix');
  return { Socket: MockSocket, Channel: MockChannel };
});

import { renderHook, act } from '@testing-library/react';
import { useModelRiver } from '../src/react';
import { MockSocket } from './mocks/phoenix';

const TOPIC = 'ai_response:proj-1:chan-1';
const WS_URL = 'wss://mr.test/socket';

describe('useModelRiver: hosted tools and streaming', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    MockSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  function mountAndJoin() {
    const hook = renderHook(() => useModelRiver({ persist: false }));
    act(() => {
      hook.result.current.connect({
        channelId: 'chan-1',
        wsToken: 'first-token',
        websocketUrl: WS_URL,
        websocketChannel: TOPIC,
      });
    });
    const socket = MockSocket.instances[MockSocket.instances.length - 1]!;
    act(() => {
      socket.simulateOpen();
      socket.getChannel(TOPIC)!.simulateJoinOk({});
    });
    return { ...hook, channel: socket.getChannel(TOPIC)! };
  }

  it('starts with no tool calls, no round and no streamed text', () => {
    const { result } = renderHook(() => useModelRiver({ persist: false }));

    expect(result.current.toolCalls).toEqual([]);
    expect(result.current.toolRound).toBeNull();
    expect(result.current.streamText).toBe('');
    expect(typeof result.current.cancel).toBe('function');
  });

  it('shows tool calls as they run and finish', () => {
    const { result, channel } = mountAndJoin();

    act(() => {
      channel.simulateMessage('tool_round_started', { round: 1, max_rounds: 5 });
      channel.simulateMessage('tool_call_started', {
        id: 'tc_a1',
        name: 'get_sales_summary',
        label: 'Reading this week’s sales…',
        round: 1,
      });
    });

    expect(result.current.toolRound).toEqual({ round: 1, max_rounds: 5 });
    expect(result.current.toolCalls).toEqual([
      { id: 'tc_a1', name: 'get_sales_summary', label: 'Reading this week’s sales…', round: 1, status: 'running' },
    ]);

    act(() => {
      channel.simulateMessage('tool_call_completed', {
        id: 'tc_a1',
        name: 'get_sales_summary',
        round: 1,
        status: 'ok',
        duration_ms: 182,
        user_message: null,
      });
    });

    expect(result.current.toolCalls[0]).toMatchObject({ status: 'ok', duration_ms: 182 });
  });

  it('clears tool calls and streamed text for the next request', () => {
    const { result, channel } = mountAndJoin();
    act(() => {
      channel.simulateMessage('tool_call_started', { id: 'tc_a1', name: 'get_sales_summary', label: null, round: 1 });
      channel.simulateMessage('stream_delta', { text: 'Sales are up' });
    });
    expect(result.current.toolCalls).toHaveLength(1);
    expect(result.current.streamText).toBe('Sales are up');

    act(() => {
      result.current.connect({ channelId: 'chan-2', wsToken: 'second-token', websocketUrl: WS_URL });
    });

    expect(result.current.toolCalls).toEqual([]);
    expect(result.current.toolRound).toBeNull();
    expect(result.current.streamText).toBe('');
  });

  it('cancel() asks the server to stop', async () => {
    const { result, channel } = mountAndJoin();

    let stopped: boolean | undefined;
    await act(async () => {
      const stopping = result.current.cancel();
      channel.pushesOf('cancel')[0]!.reply('ok', { status: 'cancel_requested' });
      stopped = await stopping;
    });

    expect(stopped).toBe(true);
  });

  it('streamText follows the stream and ends on the full text', () => {
    const { result, channel } = mountAndJoin();

    act(() => {
      channel.simulateMessage('stream_start', { provider: 'openai', model: 'gpt-x' });
      channel.simulateMessage('stream_delta', { text: 'Sales are ' });
      channel.simulateMessage('stream_delta', { text: 'up' });
    });
    expect(result.current.streamText).toBe('Sales are up');

    act(() => {
      channel.simulateMessage('stream_done', { finish_reason: 'stop', accumulated_text: 'Sales are up 12% this week.' });
    });
    expect(result.current.streamText).toBe('Sales are up 12% this week.');
  });
});
