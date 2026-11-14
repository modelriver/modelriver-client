/**
 * Vue, Svelte and Angular adapters: pendingApprovals
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('phoenix', async () => {
  const { MockSocket, MockChannel } = await import('./mocks/phoenix');
  return { Socket: MockSocket, Channel: MockChannel };
});

import { createApp, defineComponent, nextTick } from 'vue';
import { get } from 'svelte/store';
import { useModelRiver } from '../src/vue';
import { createModelRiver } from '../src/svelte';
import { ModelRiverService } from '../src/angular';
import type { ConnectOptions, ToolApproval, UseModelRiverVueReturn } from '../src/types';
import { MockSocket } from './mocks/phoenix';

const TOPIC = 'ai_response:proj-1:chan-1';
const WS_URL = 'wss://mr.test/socket';
const CONNECT: ConnectOptions = { channelId: 'chan-1', wsToken: 'first-token', websocketUrl: WS_URL, websocketChannel: TOPIC };

const REQUIRED: ToolApproval = {
  id: 'tc_w1',
  name: 'cancel_order',
  label: 'Cancelling the order…',
  round: 1,
  prompt: "Cancel this order? This can't be undone.",
  arguments: { order_id: '1041' },
  expires_at: '2026-11-14T10:20:00Z',
};
const RESOLVED = { id: 'tc_w1', name: 'cancel_order', round: 1, decision: 'approved' };

/** Open the latest socket and join its channel, as the server would */
function join() {
  const socket = MockSocket.instances[MockSocket.instances.length - 1]!;
  socket.simulateOpen();
  const channel = socket.getChannel(TOPIC)!;
  channel.simulateJoinOk({});
  return channel;
}

describe('adapters: pendingApprovals', () => {
  beforeEach(() => {
    localStorage.clear();
    MockSocket.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('Vue: a ref that follows the approval events and resets', async () => {
    let state!: UseModelRiverVueReturn;
    const app = createApp(
      defineComponent({
        setup() {
          state = useModelRiver({ persist: false });
          return () => null;
        },
      })
    );
    app.mount(document.createElement('div'));
    await nextTick();

    expect(state.pendingApprovals.value).toEqual([]);
    state.connect(CONNECT);
    const channel = join();

    channel.simulateMessage('tool_approval_required', REQUIRED);
    expect(state.pendingApprovals.value).toEqual([REQUIRED]);

    channel.simulateMessage('tool_approval_resolved', RESOLVED);
    expect(state.pendingApprovals.value).toEqual([]);

    channel.simulateMessage('tool_approval_required', { ...REQUIRED, id: 'tc_w2' });
    state.reset();
    expect(state.pendingApprovals.value).toEqual([]);
    app.unmount();
  });

  it('Svelte: a readable store that follows the approval events and resets', () => {
    const store = createModelRiver({ persist: false });
    expect(get(store.pendingApprovals)).toEqual([]);

    store.connect(CONNECT);
    const channel = join();

    channel.simulateMessage('tool_approval_required', REQUIRED);
    expect(get(store.pendingApprovals)).toEqual([REQUIRED]);

    channel.simulateMessage('tool_approval_resolved', RESOLVED);
    expect(get(store.pendingApprovals)).toEqual([]);

    channel.simulateMessage('tool_approval_required', { ...REQUIRED, id: 'tc_w2' });
    store.reset();
    expect(get(store.pendingApprovals)).toEqual([]);
    store.disconnect();
  });

  it('Angular: pendingApprovals$ follows the approval events and resets', () => {
    const service = new ModelRiverService();
    service.init({ persist: false });
    const seen: ToolApproval[][] = [];
    const subscription = service.pendingApprovals$.subscribe((approvals) => seen.push(approvals));

    service.connect(CONNECT);
    const channel = join();

    channel.simulateMessage('tool_approval_required', REQUIRED);
    channel.simulateMessage('tool_approval_resolved', RESOLVED);
    channel.simulateMessage('tool_approval_required', { ...REQUIRED, id: 'tc_w2' });
    service.reset();

    // Initial value, cleared by connect(), then each change; reset() ends empty
    expect(seen.slice(0, 5)).toEqual([[], [], [REQUIRED], [], [{ ...REQUIRED, id: 'tc_w2' }]]);
    expect(seen[seen.length - 1]).toEqual([]);
    subscription.unsubscribe();
    service.destroy();
  });
});
