/**
 * Hosted tools: approvals for tools that change something (pendingApprovals,
 * the approval events and how they move the toolCalls list)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('phoenix', async () => {
  const { MockSocket, MockChannel } = await import('./mocks/phoenix');
  return { Socket: MockSocket, Channel: MockChannel };
});

import { ModelRiverClient } from '../src/client';
import type { ToolApproval, ToolCall } from '../src/types';
import { getActiveRequest, saveActiveRequest } from '../src/utils';
import { MockSocket } from './mocks/phoenix';

const TOPIC = 'ai_response:proj-1:chan-1';
const WS_URL = 'wss://mr.test/socket';
const PREFIX = 'approvals_';

// What the server sends (contract section 6)
const ROUND_1 = { round: 1, max_rounds: 5 };
const LOOKUP_STARTED = { id: 'tc_r1', name: 'get_order', label: 'Finding your order…', round: 1 };
const LOOKUP_DONE = { id: 'tc_r1', name: 'get_order', round: 1, status: 'ok', duration_ms: 90, user_message: null };
const CANCEL_REQUIRED = {
  id: 'tc_w1',
  name: 'cancel_order',
  label: 'Cancelling the order…',
  round: 1,
  prompt: "Cancel this order? This can't be undone.",
  arguments: { order_id: '1041' },
  expires_at: '2026-11-14T10:20:00Z',
};
const REFUND_REQUIRED = {
  id: 'tc_w2',
  name: 'refund_order',
  label: null,
  round: 1,
  prompt: 'Refund this order?',
  arguments: { order_id: '1041', amount: { value: 42, currency: 'EUR' } },
  expires_at: '2026-11-14T10:25:00Z',
};
const resolved = (call: { id: string; name: string }, decision: string) => ({
  id: call.id,
  name: call.name,
  round: 1,
  decision,
});

const ANSWER = {
  status: 'success',
  channel_id: 'chan-1',
  data: { choices: [{ message: { role: 'assistant', content: 'Your order is cancelled.' } }] },
  meta: { status: 'success', workflow: 'orders', tool_loop: { rounds: 2, tool_calls: 2 } },
};

const CANCELLED = {
  status: 'error',
  error: { type: 'cancelled', message: 'The request was cancelled.' },
  meta: { status: 'error', workflow: 'orders' },
};

/** The approval the client keeps for CANCEL_REQUIRED */
const CANCEL_APPROVAL: ToolApproval = { ...CANCEL_REQUIRED };

describe('hosted tools: approvals', () => {
  const lastSocket = () => MockSocket.instances[MockSocket.instances.length - 1]!;

  function connectAndJoin(target: ModelRiverClient = client, resume: string | null = 'resume-1') {
    target.connect({ channelId: 'chan-1', wsToken: 'first-token', websocketUrl: WS_URL, websocketChannel: TOPIC });
    const socket = lastSocket();
    socket.simulateOpen();
    const channel = socket.getChannel(TOPIC)!;
    channel.simulateJoinOk(resume ? { resume_token: resume } : {});
    return { socket, channel };
  }

  const statuses = () => client.getState().toolCalls!.map((call) => [call.id, call.status]);

  let client: ModelRiverClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-14T10:10:00Z'));
    localStorage.clear();
    MockSocket.instances = [];
    client = new ModelRiverClient({ persist: true, storageKeyPrefix: PREFIX });
  });

  afterEach(() => {
    client.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  describe('waiting for approval', () => {
    it('starts with nothing pending', () => {
      expect(client.getState().pendingApprovals).toEqual([]);
    });

    it('adds the call to pendingApprovals and to toolCalls as awaiting_approval', () => {
      const { channel } = connectAndJoin();
      const onRequired = vi.fn();
      const seenApprovals: ToolApproval[][] = [];
      const seenCalls: ToolCall[][] = [];
      client.on('tool_approval_required', onRequired);
      client.on('tool_approvals', (approvals) => seenApprovals.push(approvals));
      client.on('tool_calls', (calls) => seenCalls.push(calls));

      channel.simulateMessage('tool_round_started', ROUND_1);
      channel.simulateMessage('tool_call_started', LOOKUP_STARTED);
      channel.simulateMessage('tool_call_completed', LOOKUP_DONE);
      channel.simulateMessage('tool_approval_required', CANCEL_REQUIRED);

      expect(onRequired).toHaveBeenCalledWith(CANCEL_REQUIRED);
      expect(client.getState().pendingApprovals).toEqual([CANCEL_APPROVAL]);
      expect(client.getState().toolCalls).toEqual([
        { id: 'tc_r1', name: 'get_order', label: 'Finding your order…', round: 1, status: 'ok', duration_ms: 90, user_message: null },
        { id: 'tc_w1', name: 'cancel_order', label: 'Cancelling the order…', round: 1, status: 'awaiting_approval' },
      ]);
      // tool_approvals fires only when the pending list changes
      expect(seenApprovals).toEqual([[CANCEL_APPROVAL]]);
      expect(seenCalls).toHaveLength(4);
    });

    it('keeps several calls of one round, in the order they were asked', () => {
      const { channel } = connectAndJoin();

      channel.simulateMessage('tool_approval_required', CANCEL_REQUIRED);
      channel.simulateMessage('tool_approval_required', REFUND_REQUIRED);

      expect(client.getState().pendingApprovals!.map((approval) => approval.id)).toEqual(['tc_w1', 'tc_w2']);
    });

    it('fills in missing fields so the app can always render the approval', () => {
      const { channel } = connectAndJoin();
      channel.simulateMessage('tool_round_started', { round: 3, max_rounds: 5 });

      channel.simulateMessage('tool_approval_required', { id: 'tc_w9', name: 'send_email' });

      expect(client.getState().pendingApprovals).toEqual([
        { id: 'tc_w9', name: 'send_email', label: null, round: 3, prompt: '', arguments: {}, expires_at: '' },
      ]);
    });

    it('treats a repeated message as the same call', () => {
      const { channel } = connectAndJoin();

      channel.simulateMessage('tool_approval_required', CANCEL_REQUIRED);
      channel.simulateMessage('tool_approval_required', CANCEL_REQUIRED);

      expect(client.getState().pendingApprovals).toHaveLength(1);
      expect(client.getState().toolCalls).toHaveLength(1);
    });

    it('hands out copies, so a listener cannot change the client’s state', () => {
      const { channel } = connectAndJoin();
      client.on('tool_approvals', (approvals) => {
        approvals[0]!.prompt = 'changed';
        (approvals[0]!.arguments.amount as { value: number }).value = 0;
      });

      channel.simulateMessage('tool_approval_required', REFUND_REQUIRED);

      const [approval] = client.getState().pendingApprovals!;
      expect(approval!.prompt).toBe('Refund this order?');
      expect(approval!.arguments).toEqual({ order_id: '1041', amount: { value: 42, currency: 'EUR' } });
    });

    it('never stores the prompt or the arguments', () => {
      const { channel } = connectAndJoin();

      channel.simulateMessage('tool_approval_required', CANCEL_REQUIRED);

      const stored = localStorage.getItem(`${PREFIX}active_request`);
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!).approvalsUntil).toEqual(expect.any(Number));
      expect(stored).not.toContain('1041');
      expect(stored).not.toContain('Cancel this order');
    });
  });

  describe('decisions', () => {
    it('approved: leaves the pending list, shows approved until the call starts, then runs as usual', () => {
      const { channel } = connectAndJoin();
      const onResolved = vi.fn();
      const onApprovals = vi.fn();
      client.on('tool_approval_resolved', onResolved);
      channel.simulateMessage('tool_approval_required', CANCEL_REQUIRED);
      client.on('tool_approvals', onApprovals);

      channel.simulateMessage('tool_approval_resolved', resolved(CANCEL_REQUIRED, 'approved'));

      expect(onResolved).toHaveBeenCalledWith(resolved(CANCEL_REQUIRED, 'approved'));
      expect(onApprovals).toHaveBeenCalledWith([]);
      expect(client.getState().pendingApprovals).toEqual([]);
      // Not running yet: ModelRiver waits until every call of the round is decided
      expect(client.getState().toolCalls).toEqual([
        { id: 'tc_w1', name: 'cancel_order', label: 'Cancelling the order…', round: 1, status: 'approved' },
      ]);

      channel.simulateMessage('tool_call_started', { id: 'tc_w1', name: 'cancel_order', label: 'Cancelling the order…', round: 1 });
      expect(statuses()).toEqual([['tc_w1', 'running']]);

      channel.simulateMessage('tool_call_completed', { id: 'tc_w1', name: 'cancel_order', round: 1, status: 'ok', duration_ms: 310 });
      expect(client.getState().toolCalls![0]).toMatchObject({ status: 'ok', label: 'Cancelling the order…' });
    });

    it('rejected and expired: the call is not run and shows how it ended', () => {
      const { channel } = connectAndJoin();
      channel.simulateMessage('tool_approval_required', CANCEL_REQUIRED);
      channel.simulateMessage('tool_approval_required', REFUND_REQUIRED);

      channel.simulateMessage('tool_approval_resolved', resolved(CANCEL_REQUIRED, 'rejected'));
      expect(client.getState().pendingApprovals!.map((approval) => approval.id)).toEqual(['tc_w2']);

      channel.simulateMessage('tool_approval_resolved', resolved(REFUND_REQUIRED, 'expired'));
      expect(client.getState().pendingApprovals).toEqual([]);
      expect(statuses()).toEqual([
        ['tc_w1', 'rejected'],
        ['tc_w2', 'expired'],
      ]);
    });

    it('one approved and one declined in the same round', () => {
      const { channel } = connectAndJoin();
      channel.simulateMessage('tool_approval_required', CANCEL_REQUIRED);
      channel.simulateMessage('tool_approval_required', REFUND_REQUIRED);

      channel.simulateMessage('tool_approval_resolved', resolved(REFUND_REQUIRED, 'rejected'));
      channel.simulateMessage('tool_approval_resolved', resolved(CANCEL_REQUIRED, 'approved'));
      channel.simulateMessage('tool_call_started', { id: 'tc_w1', name: 'cancel_order', label: null, round: 1 });

      expect(statuses()).toEqual([
        ['tc_w1', 'running'],
        ['tc_w2', 'rejected'],
      ]);
    });

    it('records an unknown outcome', () => {
      const { channel } = connectAndJoin();
      channel.simulateMessage('tool_approval_required', CANCEL_REQUIRED);
      channel.simulateMessage('tool_approval_resolved', resolved(CANCEL_REQUIRED, 'approved'));
      channel.simulateMessage('tool_call_started', { id: 'tc_w1', name: 'cancel_order', label: null, round: 1 });

      channel.simulateMessage('tool_call_completed', { id: 'tc_w1', name: 'cancel_order', round: 1, status: 'unknown', duration_ms: 30000 });

      expect(statuses()).toEqual([['tc_w1', 'unknown']]);
    });

    it('adds a decided call it never saw waiting', () => {
      const { channel } = connectAndJoin();

      channel.simulateMessage('tool_approval_resolved', resolved(CANCEL_REQUIRED, 'expired'));

      expect(client.getState().toolCalls).toEqual([{ id: 'tc_w1', name: 'cancel_order', round: 1, status: 'expired' }]);
    });

    it('a call that starts or finishes is no longer pending, even if the decision was missed', () => {
      const { channel } = connectAndJoin();
      channel.simulateMessage('tool_approval_required', CANCEL_REQUIRED);
      channel.simulateMessage('tool_approval_required', REFUND_REQUIRED);

      channel.simulateMessage('tool_call_started', { id: 'tc_w1', name: 'cancel_order', label: null, round: 1 });
      channel.simulateMessage('tool_call_completed', { id: 'tc_w2', name: 'refund_order', round: 1, status: 'ok', duration_ms: 50 });

      expect(client.getState().pendingApprovals).toEqual([]);
    });

    it('ignores late messages for a call that already moved on', () => {
      const { channel } = connectAndJoin();
      channel.simulateMessage('tool_approval_required', CANCEL_REQUIRED);
      channel.simulateMessage('tool_approval_resolved', resolved(CANCEL_REQUIRED, 'approved'));
      channel.simulateMessage('tool_call_started', { id: 'tc_w1', name: 'cancel_order', label: null, round: 1 });

      channel.simulateMessage('tool_approval_required', CANCEL_REQUIRED);
      channel.simulateMessage('tool_approval_resolved', resolved(CANCEL_REQUIRED, 'expired'));

      expect(statuses()).toEqual([['tc_w1', 'running']]);
      expect(client.getState().pendingApprovals).toEqual([]);
    });

    it('a decision it does not know ends the wait', () => {
      const { channel } = connectAndJoin();
      channel.simulateMessage('tool_approval_required', CANCEL_REQUIRED);

      channel.simulateMessage('tool_approval_resolved', resolved(CANCEL_REQUIRED, 'withdrawn'));

      expect(client.getState().pendingApprovals).toEqual([]);
      expect(statuses()).toEqual([['tc_w1', 'ended']]);
    });

    it('sends no approval events for requests without approvals', () => {
      const { channel } = connectAndJoin();
      const onApprovals = vi.fn();
      client.on('tool_approvals', onApprovals);

      channel.simulateMessage('tool_round_started', ROUND_1);
      channel.simulateMessage('tool_call_started', LOOKUP_STARTED);
      channel.simulateMessage('tool_call_completed', LOOKUP_DONE);
      channel.simulateMessage('tool_state', { ...ROUND_1, calls: [{ ...LOOKUP_STARTED, status: 'ok' }] });
      channel.simulateResponse(ANSWER);

      expect(onApprovals).not.toHaveBeenCalled();
    });
  });

  describe('joining part-way', () => {
    const PAUSED_STATE = {
      round: 1,
      max_rounds: 5,
      calls: [
        { ...LOOKUP_STARTED, status: 'ok', duration_ms: 90, user_message: null },
        { ...CANCEL_REQUIRED, status: 'awaiting_approval' },
        { id: 'tc_w2', name: 'refund_order', label: null, round: 1, status: 'approved' },
      ],
    };

    it('rebuilds both lists from tool_state, the same as if it had seen every event', () => {
      const { channel } = connectAndJoin();
      const onApprovals = vi.fn();
      client.on('tool_approvals', onApprovals);

      channel.simulateMessage('tool_state', PAUSED_STATE);

      expect(client.getState().pendingApprovals).toEqual([CANCEL_APPROVAL]);
      // What the approver sees stays out of toolCalls
      expect(client.getState().toolCalls).toEqual([
        { id: 'tc_r1', name: 'get_order', label: 'Finding your order…', round: 1, status: 'ok', duration_ms: 90, user_message: null },
        { id: 'tc_w1', name: 'cancel_order', label: 'Cancelling the order…', round: 1, status: 'awaiting_approval' },
        { id: 'tc_w2', name: 'refund_order', label: null, round: 1, status: 'approved' },
      ]);
      expect(onApprovals).toHaveBeenCalledWith([CANCEL_APPROVAL]);
    });

    it('matches the state built from live events', () => {
      const live = connectAndJoin();
      live.channel.simulateMessage('tool_approval_required', CANCEL_REQUIRED);
      const fromEvents = client.getState();

      const other = new ModelRiverClient({ persist: false });
      const joined = connectAndJoin(other);
      joined.channel.simulateMessage('tool_state', { ...ROUND_1, calls: [{ ...CANCEL_REQUIRED, status: 'awaiting_approval' }] });

      expect(other.getState().pendingApprovals).toEqual(fromEvents.pendingApprovals);
      expect(other.getState().toolCalls).toEqual(fromEvents.toolCalls);
      other.destroy();
    });

    it('keeps pending approvals across a reconnect, then takes the server’s state', async () => {
      const { socket, channel } = connectAndJoin();
      channel.simulateMessage('tool_approval_required', CANCEL_REQUIRED);
      channel.simulateMessage('tool_approval_required', REFUND_REQUIRED);

      socket.simulateClose({ code: 1006 });
      expect(client.getState().pendingApprovals).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(1000);
      const next = lastSocket();
      next.simulateOpen();
      const rejoined = next.getChannel(TOPIC)!;
      rejoined.simulateJoinOk({ resume_token: 'resume-2' });
      expect(client.getState().pendingApprovals).toHaveLength(2);

      // The refund was declined while the client was away
      rejoined.simulateMessage('tool_state', {
        ...ROUND_1,
        calls: [
          { ...CANCEL_REQUIRED, status: 'awaiting_approval' },
          { id: 'tc_w2', name: 'refund_order', label: null, round: 1, status: 'rejected' },
        ],
      });

      expect(client.getState().pendingApprovals!.map((approval) => approval.id)).toEqual(['tc_w1']);
      expect(statuses()).toEqual([
        ['tc_w1', 'awaiting_approval'],
        ['tc_w2', 'rejected'],
      ]);
    });

    it('clears pending approvals when tool_state has none', () => {
      const { channel } = connectAndJoin();
      channel.simulateMessage('tool_approval_required', CANCEL_REQUIRED);
      const onApprovals = vi.fn();
      client.on('tool_approvals', onApprovals);

      channel.simulateMessage('tool_state', { ...ROUND_1, calls: [{ id: 'tc_w1', name: 'cancel_order', label: null, round: 1, status: 'expired' }] });

      expect(client.getState().pendingApprovals).toEqual([]);
      expect(onApprovals).toHaveBeenCalledWith([]);
    });

    // The server keeps a call's progress for ten minutes, and a wait can last
    // an hour: a snapshot sent on a later rejoin lists only the paused round's
    // approval calls
    it('keeps calls that finished earlier when a later tool_state no longer lists them', () => {
      const { channel } = connectAndJoin();
      channel.simulateMessage('tool_round_started', ROUND_1);
      channel.simulateMessage('tool_call_started', LOOKUP_STARTED);
      channel.simulateMessage('tool_call_completed', LOOKUP_DONE);
      channel.simulateMessage('tool_approval_required', CANCEL_REQUIRED);

      channel.simulateMessage('tool_state', { ...ROUND_1, calls: [{ ...CANCEL_REQUIRED, status: 'awaiting_approval' }] });

      expect(statuses()).toEqual([
        ['tc_r1', 'ok'],
        ['tc_w1', 'awaiting_approval'],
      ]);
      expect(client.getState().toolCalls![0]).toMatchObject({ label: 'Finding your order…', duration_ms: 90 });
      expect(client.getState().pendingApprovals!.map((approval) => approval.id)).toEqual(['tc_w1']);
    });

    // While a request waits, the server lists earlier calls from its log,
    // which has no progress label and no user message
    it('keeps a call’s label and user message when tool_state lists it without them', () => {
      const { channel } = connectAndJoin();
      channel.simulateMessage('tool_call_started', LOOKUP_STARTED);
      channel.simulateMessage('tool_call_completed', { ...LOOKUP_DONE, user_message: 'Order 1041 found.' });

      channel.simulateMessage('tool_state', {
        ...ROUND_1,
        calls: [
          { id: 'tc_r1', name: 'get_order', label: null, round: 1, status: 'ok', duration_ms: 90, user_message: null },
          { id: 'tc_r0', name: 'get_customer', label: null, round: 1, status: 'ok', duration_ms: 40, user_message: null },
          { ...CANCEL_REQUIRED, status: 'awaiting_approval' },
        ],
      });

      const calls = client.getState().toolCalls!;
      expect(calls.map((call) => [call.id, call.status])).toEqual([
        ['tc_r1', 'ok'],
        ['tc_r0', 'ok'],
        ['tc_w1', 'awaiting_approval'],
      ]);
      expect(calls[0]).toMatchObject({ label: 'Finding your order…', user_message: 'Order 1041 found.' });
      // A call this client never saw has no label: the app shows its name
      expect(calls[1]).toMatchObject({ name: 'get_customer', label: null, user_message: null });
    });

    it('drops a call still shown as in flight that tool_state no longer lists', () => {
      const { channel } = connectAndJoin();
      channel.simulateMessage('tool_call_started', LOOKUP_STARTED);
      channel.simulateMessage('tool_approval_required', CANCEL_REQUIRED);

      channel.simulateMessage('tool_state', { ...ROUND_1, calls: [{ ...REFUND_REQUIRED, status: 'awaiting_approval' }] });

      expect(statuses()).toEqual([['tc_w2', 'awaiting_approval']]);
      expect(client.getState().pendingApprovals!.map((approval) => approval.id)).toEqual(['tc_w2']);
    });
  });

  describe('when the request ends', () => {
    it('stops calls still waiting or approved, and clears pending approvals', () => {
      const { channel } = connectAndJoin();
      channel.simulateMessage('tool_approval_required', CANCEL_REQUIRED);
      channel.simulateMessage('tool_approval_required', REFUND_REQUIRED);
      channel.simulateMessage('tool_approval_resolved', resolved(REFUND_REQUIRED, 'approved'));
      const onApprovals = vi.fn();
      client.on('tool_approvals', onApprovals);

      channel.simulateResponse(CANCELLED);

      expect(statuses()).toEqual([
        ['tc_w1', 'ended'],
        ['tc_w2', 'ended'],
      ]);
      expect(client.getState().pendingApprovals).toEqual([]);
      expect(onApprovals).toHaveBeenCalledWith([]);
    });

    it('keeps decided calls as they were', () => {
      const { channel } = connectAndJoin();
      channel.simulateMessage('tool_approval_required', CANCEL_REQUIRED);
      channel.simulateMessage('tool_approval_resolved', resolved(CANCEL_REQUIRED, 'rejected'));

      channel.simulateResponse(ANSWER);

      expect(statuses()).toEqual([['tc_w1', 'rejected']]);
    });

    it('disconnect() empties pendingApprovals and keeps the call statuses', () => {
      const { channel } = connectAndJoin();
      channel.simulateMessage('tool_approval_required', CANCEL_REQUIRED);
      const onApprovals = vi.fn();
      client.on('tool_approvals', onApprovals);

      client.disconnect();

      expect(client.getState().pendingApprovals).toEqual([]);
      expect(onApprovals).toHaveBeenCalledWith([]);
      expect(statuses()).toEqual([['tc_w1', 'awaiting_approval']]);
    });

    it('giving up on reconnecting empties pendingApprovals', async () => {
      // No resume token and no way to fetch one: the first retry gives up
      const { socket, channel } = connectAndJoin(client, null);
      channel.simulateMessage('tool_approval_required', CANCEL_REQUIRED);
      const onError = vi.fn();
      client.on('error', onError);

      socket.simulateClose({ code: 1006 });
      await vi.advanceTimersByTimeAsync(1000);

      expect(onError).toHaveBeenCalled();
      expect(client.getState().pendingApprovals).toEqual([]);
    });

    it('connect() and reset() start with nothing pending', () => {
      const { channel } = connectAndJoin();
      channel.simulateMessage('tool_approval_required', CANCEL_REQUIRED);
      const onApprovals = vi.fn();
      client.on('tool_approvals', onApprovals);

      client.connect({ channelId: 'chan-2', wsToken: 'second-token', websocketUrl: WS_URL });
      expect(client.getState().pendingApprovals).toEqual([]);
      expect(onApprovals).toHaveBeenCalledWith([]);

      const joined = connectAndJoin();
      joined.channel.simulateMessage('tool_approval_required', CANCEL_REQUIRED);
      client.reset();
      expect(client.getState().pendingApprovals).toEqual([]);
    });
  });

  describe('staying resumable while paused', () => {
    // CANCEL_REQUIRED expires at 10:20, REFUND_REQUIRED at 10:25; the margin is 5 minutes
    const REFUND_DEADLINE = Date.parse('2026-11-14T10:30:00Z');

    it('stores the latest expiry plus 5 minutes, and nothing more', () => {
      const { channel } = connectAndJoin();
      const before = getActiveRequest(PREFIX)!;

      channel.simulateMessage('tool_approval_required', CANCEL_REQUIRED);
      channel.simulateMessage('tool_approval_required', REFUND_REQUIRED);

      const stored = getActiveRequest(PREFIX)!;
      expect(stored.approvalsUntil).toBe(REFUND_DEADLINE);
      // The token and its issue time are unchanged
      expect(stored.wsToken).toBe(before.wsToken);
      expect(stored.timestamp).toBe(before.timestamp);

      channel.simulateMessage('tool_approval_resolved', resolved(REFUND_REQUIRED, 'rejected'));
      expect(getActiveRequest(PREFIX)!.approvalsUntil).toBe(Date.parse('2026-11-14T10:25:00Z'));

      channel.simulateMessage('tool_approval_resolved', resolved(CANCEL_REQUIRED, 'approved'));
      expect(getActiveRequest(PREFIX)!.approvalsUntil).toBeUndefined();
    });

    it('caps the deadline at an hour from now, so a wrong expiry can’t keep the request forever', () => {
      const { channel } = connectAndJoin();

      channel.simulateMessage('tool_approval_required', { ...CANCEL_REQUIRED, expires_at: '2030-01-01T00:00:00Z' });

      expect(getActiveRequest(PREFIX)!.approvalsUntil).toBe(Date.now() + 65 * 60_000);
    });

    it('drops a deadline from storage once the rejoined request has nothing waiting', () => {
      const withToken = new ModelRiverClient({ persist: true, storageKeyPrefix: 'reload_', getToken: vi.fn() });
      saveActiveRequest('reload_', 'chan-1', 'resume-1', WS_URL, TOPIC, { approvalsUntil: REFUND_DEADLINE });

      expect(withToken.reconnect()).toBe(true);
      const socket = lastSocket();
      socket.simulateOpen();
      const channel = socket.getChannel(TOPIC)!;
      channel.simulateJoinOk({ resume_token: 'resume-2' });
      expect(getActiveRequest('reload_')!.approvalsUntil).toBe(REFUND_DEADLINE);

      // Decided while the page was closed
      channel.simulateMessage('tool_state', { ...ROUND_1, calls: [{ id: 'tc_w1', name: 'cancel_order', label: null, round: 1, status: 'approved' }] });

      expect(getActiveRequest('reload_')!.approvalsUntil).toBeUndefined();
      expect(getActiveRequest('reload_')!.wsToken).toBe('resume-2');
      withToken.destroy();
    });

    it('a stored request waiting for approval outlives the usual limit', () => {
      saveActiveRequest(PREFIX, 'chan-1', 'resume-1', WS_URL, TOPIC, { approvalsUntil: REFUND_DEADLINE });

      // Stored at 10:10; at 10:29 it is past the 5-minute limit, before the deadline
      vi.setSystemTime(Date.parse('2026-11-14T10:29:00Z'));
      expect(getActiveRequest(PREFIX, 60 * 60_000)).not.toBeNull();
      expect(getActiveRequest(PREFIX, 5 * 60_000)).not.toBeNull();

      vi.setSystemTime(REFUND_DEADLINE + 1);
      expect(getActiveRequest(PREFIX, 5 * 60_000)).toBeNull();
    });

    it('keeps retrying past the hour without a join while approvals can still be decided', async () => {
      const getToken = vi.fn().mockRejectedValue(new Error('backend down'));
      const paused = new ModelRiverClient({ persist: true, storageKeyPrefix: 'paused_', getToken, retryDelaysMs: [60_000] });
      const onError = vi.fn();
      paused.on('error', onError);
      // No resume token, so every retry asks getToken (which keeps failing)
      const { socket, channel } = connectAndJoin(paused, null);
      // Resumable until 11:15 (an hour from now at most, plus 5 minutes); the hour without a join ends at 11:10
      channel.simulateMessage('tool_approval_required', { ...CANCEL_REQUIRED, expires_at: '2026-11-14T11:30:00Z' });

      socket.simulateClose({ code: 1006 });
      await vi.advanceTimersByTimeAsync(62 * 60_000);
      expect(onError).not.toHaveBeenCalled();
      expect(getToken).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(onError).toHaveBeenCalledWith('Could not reconnect to the request within an hour');
      paused.destroy();
    });
  });
});
