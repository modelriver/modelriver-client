# @modelriver/client

Official ModelRiver client SDK for real-time AI response streaming via WebSockets.

## Features

- **WebSocket streaming** - Receive AI responses in real-time via Phoenix Channels
- **Live sessions** - Follow a conversation as it happens: new turns, app signals and deletion (`subscribeToSession`)
- **Automatic reconnect** - Rejoins an async request on its own after network drops, ModelRiver's 1-hour connection cutoff and page reloads within about 5 minutes, using single-use resume tokens (no backend route needed)
- **Longer gaps** - An optional `getToken` callback to your backend covers longer gaps and ModelRiver restarts (see [Reconnecting](#reconnecting))
- **Hosted tools** - Show which of your tools ModelRiver is calling while a request runs, ask the user before a tool changes something, and let the user stop it (`toolCalls`, `pendingApprovals`, `cancel()`)
- **Framework adapters** - First-class support for React, Vue, Angular, and Svelte
- **CDN ready** - Use via script tag without a build step
- **TypeScript** - Full type definitions included
- **Lightweight** - ~15KB minified (including Phoenix.js)

## Installation

### npm / yarn / pnpm

```bash
npm install @modelriver/client
# or
yarn add @modelriver/client
# or
pnpm add @modelriver/client
```

### CDN

```html
<script src="https://cdn.modelriver.com/client/v1.10.0/modelriver.min.js"></script>
<!-- or latest -->
<script src="https://cdn.modelriver.com/client/latest/modelriver.min.js"></script>
```

## Quick Start

### 1. Get async connection details from your backend

Your backend calls the ModelRiver `/api/v1/ai/async` endpoint and receives connection details:

```javascript
// Your backend endpoint proxies to ModelRiver
const response = await fetch('/api/ai/request', {
  method: 'POST',
  body: JSON.stringify({ message: 'Hello AI' }),
});

// Response from /api/v1/ai/async:
// {
//   "message": "success",
//   "status": "pending",
//   "channel_id": "a1b2c3d4-...",
//   "ws_token": "one-time-websocket-token",
//   "websocket_url": "wss://api.modelriver.com/socket",
//   "websocket_channel": "ai_response:PROJECT_ID:a1b2c3d4-..."
// }
const { channel_id, ws_token, websocket_url, websocket_channel } = await response.json();
```

### 2. Connect to ModelRiver WebSocket

```javascript
import { ModelRiverClient } from '@modelriver/client';

const client = new ModelRiverClient({
  baseUrl: 'wss://api.modelriver.com/socket',
});

client.on('response', (data) => {
  console.log('AI Response:', data);
});

client.on('error', (error) => {
  console.error('Error:', error);
});

client.connect({
  channelId: channel_id,
  wsToken: ws_token,
  websocketUrl: websocket_url,
  websocketChannel: websocket_channel,
});
```

### 3. Stream tokens as they arrive (optional)

When your backend sends the async request with `"stream": true`, ModelRiver pushes the answer token by token before the final `response` event:

```javascript
client.on('stream_delta', (chunk, text) => {
  // chunk.text is the new piece; text is everything streamed so far
  renderAnswer(text);
});

client.on('stream_done', (done) => {
  renderAnswer(done.accumulated_text);
});

client.on('stream_error', (err) => {
  console.error('Stream failed:', err.message); // a final `response` with an error status follows
});
```

The accumulated text is also available as `client.getState().streamText`.

### 4. Show tool progress (optional)

When the workflow has [hosted tools](https://modelriver.com/docs/hosted-tools), ModelRiver calls your tool endpoints while the request runs. The client tells you which tool is running, so you can show "Reading this week's sales…" instead of a bare spinner:

```javascript
client.on('tool_calls', (calls, round) => {
  // Every call so far, in the order they started
  // { id, name, label, round, status, duration_ms?, user_message? }
  // status: 'running' | 'ok' | 'error' | 'timeout' | 'ended', and for tools that
  // change something 'awaiting_approval' | 'approved' | 'rejected' | 'expired' | 'unknown'
  renderProgress(calls);
});

// A Stop button: ModelRiver starts no further round, then sends the final response
stopButton.onclick = () => client.cancel();

client.on('response', (data) => {
  if (data.status === 'error' && data.error?.type === 'cancelled') {
    showStopped();
  }
});
```

See [Hosted tools](#hosted-tools) for the details, and [Hosted tools approvals](#hosted-tools-approvals) for tools that change something.

## Framework Usage

### React

```tsx
import { useModelRiver } from '@modelriver/client/react';

function ChatComponent() {
  const { 
    connect, 
    disconnect, 
    response, 
    error, 
    isConnected, 
    steps 
  } = useModelRiver({
    baseUrl: 'wss://api.modelriver.com/socket',
    persist: true,
  });

  const handleSend = async () => {
    const {
      channel_id,
      ws_token,
      websocket_url,
      websocket_channel,
    } = await yourBackendAPI.createRequest(message); // calls /api/v1/ai/async

    connect({
      channelId: channel_id,
      wsToken: ws_token,
      websocketUrl: websocket_url,
      websocketChannel: websocket_channel,
    });
  };

  return (
    <div>
      <button onClick={handleSend} disabled={isConnected}>
        Send
      </button>
      
      {/* Show workflow progress */}
      {steps.map((step) => (
        <div key={step.id} className={step.status}>
          {step.name}
        </div>
      ))}
      
      {/* Show response */}
      {response && (
        <pre>{JSON.stringify(response.data, null, 2)}</pre>
      )}
      
      {/* Show error */}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
```

### Vue

```vue
<script setup>
import { useModelRiver } from '@modelriver/client/vue';

const { 
  connect, 
  disconnect, 
  response, 
  error, 
  isConnected, 
  steps 
} = useModelRiver({
  baseUrl: 'wss://api.modelriver.com/socket',
});

async function handleSend() {
  const {
    channel_id,
    ws_token,
    websocket_url,
    websocket_channel,
  } = await yourBackendAPI.createRequest(message); // calls /api/v1/ai/async

  connect({
    channelId: channel_id,
    wsToken: ws_token,
    websocketUrl: websocket_url,
    websocketChannel: websocket_channel,
  });
}
</script>

<template>
  <div>
    <button @click="handleSend" :disabled="isConnected">Send</button>
    
    <div v-for="step in steps" :key="step.id" :class="step.status">
      {{ step.name }}
    </div>
    
    <pre v-if="response">{{ response.data }}</pre>
    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>
```

### Angular

```typescript
import { Component, OnDestroy } from '@angular/core';
import { ModelRiverService } from '@modelriver/client/angular';

@Component({
  selector: 'app-chat',
  providers: [ModelRiverService],
  template: `
    <button (click)="send()" [disabled]="modelRiver.isConnected">
      Send
    </button>
    
    <div *ngFor="let step of modelRiver.steps$ | async" [class]="step.status">
      {{ step.name }}
    </div>
    
    <pre *ngIf="modelRiver.response$ | async as res">
      {{ res.data | json }}
    </pre>
    
    <p *ngIf="modelRiver.error$ | async as err" class="error">
      {{ err }}
    </p>
  `,
})
export class ChatComponent implements OnDestroy {
  constructor(public modelRiver: ModelRiverService) {
    this.modelRiver.init({ 
      baseUrl: 'wss://api.modelriver.com/socket' 
    });
  }

  async send() {
    const {
      channel_id,
      ws_token,
      websocket_url,
      websocket_channel,
    } = await this.backendService.createRequest(message); // calls /api/v1/ai/async

    this.modelRiver.connect({
      channelId: channel_id,
      wsToken: ws_token,
      websocketUrl: websocket_url,
      websocketChannel: websocket_channel,
    });
  }

  ngOnDestroy() {
    this.modelRiver.destroy();
  }
}
```

### Svelte

```svelte
<script>
  import { createModelRiver } from '@modelriver/client/svelte';
  import { onDestroy } from 'svelte';

  const modelRiver = createModelRiver({
    baseUrl: 'wss://api.modelriver.com/socket',
  });

  const { response, error, isConnected, steps, connect, disconnect } = modelRiver;

  async function send() {
    const {
      channel_id,
      ws_token,
      websocket_url,
      websocket_channel,
    } = await backendAPI.createRequest(message); // calls /api/v1/ai/async

    connect({
      channelId: channel_id,
      wsToken: ws_token,
      websocketUrl: websocket_url,
      websocketChannel: websocket_channel,
    });
  }

  onDestroy(() => disconnect());
</script>

<button on:click={send} disabled={$isConnected}>Send</button>

{#each $steps as step}
  <div class={step.status}>{step.name}</div>
{/each}

{#if $response}
  <pre>{JSON.stringify($response.data, null, 2)}</pre>
{/if}

{#if $error}
  <p class="error">{$error}</p>
{/if}
```

### Vanilla JavaScript (CDN)

```html
<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.modelriver.com/client/latest/modelriver.min.js"></script>
</head>
<body>
  <button id="send">Send</button>
  <pre id="response"></pre>

  <script>
    const client = new ModelRiver.ModelRiverClient({
      baseUrl: 'wss://api.modelriver.com/socket',
    });

    client.on('response', (data) => {
      document.getElementById('response').textContent = 
        JSON.stringify(data, null, 2);
    });

    client.on('error', (error) => {
      console.error('Error:', error);
    });

    document.getElementById('send').addEventListener('click', async () => {
      // Get async connection info from your backend
      const res = await fetch('/api/ai/request', { method: 'POST' });
      const {
        channel_id,
        ws_token,
        websocket_url,
        websocket_channel,
      } = await res.json(); // your backend calls /api/v1/ai/async
      
      client.connect({
        channelId: channel_id,
        wsToken: ws_token,
        websocketUrl: websocket_url,
        websocketChannel: websocket_channel,
      });
    });
  </script>
</body>
</html>
```

## API Reference

### ModelRiverClient

#### Constructor Options

```typescript
interface ModelRiverClientOptions {
  baseUrl?: string;           // WebSocket URL (default: 'wss://api.modelriver.com/socket')
  getToken?: (request: { channelId: string; websocketChannel?: string }) =>
    Promise<ReconnectInfo | null>; // New token from your backend for longer gaps (see Reconnecting)
  retryDelaysMs?: number[];   // Waits between reconnect attempts (default: [1000, 2000, 5000, 10000, 30000]; the last repeats)
  tokenRefreshInterval?: number; // How often to rotate the resume token in ms (default: 120000; 0 turns it off)
  apiBaseUrl?: string;        // Deprecated: use getToken. POSTs to `${apiBaseUrl}/api/v1/ai/reconnect` on your backend
  debug?: boolean;            // Enable debug logging (default: false)
  persist?: boolean;          // Enable localStorage persistence (default: true)
  storageKeyPrefix?: string;  // Storage key prefix (default: 'modelriver_')
  heartbeatInterval?: number; // Heartbeat interval in ms (default: 30000)
  requestTimeout?: number;    // Request timeout in ms (default: 300000)
}
```

#### Methods

| Method | Description |
|--------|-------------|
| `connect({ channelId, wsToken, websocketUrl?, websocketChannel? })` | Connect to WebSocket with channel ID and one-time token |
| `disconnect()` | Disconnect from WebSocket |
| `reset()` | Reset state and clear stored data |
| `cancel()` | (1.9.0+) Hosted tools: ask ModelRiver to stop the request. Returns `Promise<boolean>`; the final `response` (an error of type `cancelled`) still arrives. Calls waiting for approval are declined and never run. See [Hosted tools](#hosted-tools) |
| `detach()` | (1.8.0+) Close the socket and stop all timers but keep the stored request and resume token, so another client or the next page load can resume it. The React, Vue and Angular adapters call it on unmount while a request is pending |
| `reconnect()` | Resume the request stored in `localStorage` (call it on page load; the framework adapters do). Uses the stored resume token, then `getToken` if that token is stale or refused. Returns `false` when there's nothing to resume |
| `reconnectWithBackend()` | Deprecated: use `reconnect()` with `getToken`. Gets a token from `${apiBaseUrl}/api/v1/ai/reconnect` on your backend and reconnects |
| `getState()` | Get current client state |
| `hasPendingRequest()` | Check if there's a pending request |
| `on(event, callback)` | Add event listener (returns unsubscribe function) |
| `off(event, callback)` | Remove event listener |
| `destroy()` | Clean up all resources |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connecting` | - | Connection attempt started |
| `connected` | - | Successfully connected |
| `disconnected` | `reason?: string` | Disconnected from WebSocket (`'Connection lost'` before an automatic reconnect) |
| `reconnecting` | `attempt: number`, `delayMs: number` | (1.8.0+) The connection dropped; the next attempt starts in `delayMs` |
| `response` | `AIResponse` | AI response received |
| `error` | `Error` or `string` | Error occurred. Connection errors are only reported once the client has stopped retrying |
| `step` | `WorkflowStep` | Workflow step updated |
| `channel_joined` | - | Successfully joined channel |
| `channel_error` | `reason: string` | Channel join failed |
| `stream_start` | `StreamStartPayload` | Token streaming started (`stream: true` requests) |
| `stream_delta` | `StreamDeltaPayload`, `text: string` | New chunk; second argument is the text accumulated so far |
| `stream_done` | `StreamDonePayload` | Streaming finished; the final `response` event follows |
| `stream_error` | `StreamErrorPayload` | Streaming failed; a final `response` with an error status follows |
| `tool_calls` | `calls: ToolCall[]`, `round: ToolRound \| null` | (1.9.0+) Hosted tools: the list of tool calls changed. Every call so far, in the order they started |
| `tool_round_started` | `ToolRoundStartedPayload` | (1.9.0+) Hosted tools: a model round started |
| `tool_call_started` | `ToolCallStartedPayload` | (1.9.0+) Hosted tools: ModelRiver started calling one of your tools |
| `tool_call_completed` | `ToolCallCompletedPayload` | (1.9.0+) Hosted tools: a tool call finished, whatever the outcome |
| `tool_state` | `ToolStatePayload` | (1.9.0+) Hosted tools: where the request stands, sent when the client joins part-way |
| `tool_approvals` | `approvals: ToolApproval[]` | (1.10.0+) Hosted tools: the list of calls waiting for the end user's approval changed. Every call still waiting |
| `tool_approval_required` | `ToolApprovalRequiredPayload` | (1.10.0+) Hosted tools: a call that changes something needs the end user's approval |
| `tool_approval_resolved` | `ToolApprovalResolvedPayload` | (1.10.0+) Hosted tools: a call that needed approval was approved, declined or expired |

`getState().connectionState` is one of `'disconnected'`, `'connecting'`, `'connected'`, `'reconnecting'` (1.8.0+) or `'error'`.

### Types

```typescript
// What getToken returns: ModelRiver's /v1/ai/reconnect JSON as is (camelCase works too)
interface ReconnectInfo {
  channel_id?: string;
  project_id?: string;
  ws_token?: string;
  websocket_url?: string;
  websocket_channel?: string;
}

// Response from /api/ai/async endpoint
interface AsyncResponse {
  message: string;              // "success"
  status: 'pending';            // Always "pending" for async
  channel_id: string;           // Unique channel ID
  ws_token: string;             // One-time WebSocket token for authentication
  websocket_url: string;        // WebSocket URL to connect to
  websocket_channel: string;    // Full channel name (e.g., "ai_response:uuid")
  instructions?: {
    websocket?: string;
    webhook?: string;
  };
  test_mode?: boolean;          // Present in test mode
}

// AI response received via WebSocket
interface AIResponse {
  status: string;               // "success", "error", "ai_generated", or "completed"
  channel_id?: string;
  content?: string;             // AI response text
  model?: string;               // Model used (e.g., "gpt-4")
  data?: unknown;               // Structured output data
  meta?: {
    workflow?: string;
    status?: string;
    duration_ms?: number;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
    tool_loop?: {               // Hosted tools: what the request used
      rounds: number;
      tool_calls: number;
    };
  };
  error?: {
    message: string;            // Safe to show the end user
    type?: string;              // e.g. "cancelled", "tool_loop_limit", "tool_loop_timeout"
    details?: unknown;
  };
  // Event-driven workflow fields
  ai_response?: {
    data?: unknown;
    meta?: {
      workflow?: string;
      status?: string;
      duration_ms?: number;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };
  };
  event_name?: string;
  task_id?: string;
  callback_metadata?: Record<string, unknown>;
  customer_data?: Record<string, unknown>;
}

interface WorkflowStep {
  id: string;
  name: string;
  status: 'pending' | 'loading' | 'success' | 'error';
  duration?: number;
  errorMessage?: string;
}

// Token streaming events (requests sent with "stream": true)
interface StreamStartPayload {
  provider?: string;
  model?: string;
  request_id?: string;
  session_id?: string;
}

interface StreamDeltaPayload {
  text: string;                 // New text to append
  index?: number;
  request_id?: string;
}

interface StreamDonePayload {
  finish_reason?: string;
  accumulated_text?: string;    // Full streamed answer
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  duration_ms?: number;
  request_id?: string;
}

interface StreamErrorPayload {
  message: string;
  code?: string;
  recoverable?: boolean;
  request_id?: string;
}

// Hosted tools (1.9.0+; approval statuses 1.10.0+)
type ToolCallStatus =
  | 'awaiting_approval'         // Waiting for the end user (see pendingApprovals)
  | 'approved'                  // Approved, not started yet (set by the client, and in tool_state)
  | 'rejected'                  // Declined, or the request was stopped while it waited; not run
  | 'expired'                   // Nobody decided in time; not run
  | 'running'
  | 'ok'
  | 'error'
  | 'timeout'
  | 'unknown'                   // Sent, but the outcome isn't known; never sent again
  | 'ended';                    // The request ended before this client saw the call finish

interface ToolCall {
  id: string;                   // Stable for the call, across retries and reconnects
  name: string;                 // The tool's name
  label?: string | null;        // The tool's progress label from the console
  round?: number;               // The model round it belongs to (1-based)
  status: ToolCallStatus;
  duration_ms?: number;         // Once finished
  user_message?: string | null; // A message your endpoint marked safe to show
}

interface ToolRound {
  round: number;
  max_rounds: number;
}

type ToolRoundStartedPayload = ToolRound;

interface ToolCallStartedPayload {
  id: string;
  name: string;
  label?: string | null;
  round: number;
}

interface ToolCallCompletedPayload {
  id: string;
  name: string;
  round: number;
  status: 'ok' | 'error' | 'timeout' | 'unknown';
  duration_ms: number;
  user_message?: string | null;
}

interface ToolStatePayload extends ToolRound {
  calls: ToolStateCall[];
}

// A call in tool_state; one awaiting approval also carries prompt, arguments and expires_at
interface ToolStateCall extends ToolCall {
  prompt?: string;
  arguments?: Record<string, unknown>;
  expires_at?: string;
}

// Hosted tools approvals (1.10.0+)
interface ToolApproval {
  id: string;                   // The call id (tc_…): send it to your backend
  name: string;                 // The tool's name
  label: string | null;         // The tool's progress label from the console
  round: number;                // The model round it belongs to (1-based)
  prompt: string;               // The tool's approval prompt from the console
  arguments: Record<string, unknown>; // Only the arguments the developer chose to show
  expires_at: string;           // ISO 8601; the call becomes 'expired' after this
}

type ToolApprovalRequiredPayload = ToolApproval;

interface ToolApprovalResolvedPayload {
  id: string;
  name: string;
  round: number;
  decision: 'approved' | 'rejected' | 'expired';
}
```

## Hosted Tools

A workflow with hosted tools lets the model call HTTPS endpoints you registered, and ModelRiver runs the calls. Your frontend connects exactly as before; while the request runs it also receives progress. Tool results never reach the browser: only each tool's name, its progress label from the console, how it ended and how long it took. Arguments reach the browser only for a call that needs approval, and only the ones the developer chose to show (see [Hosted tools approvals](#hosted-tools-approvals)).

| Where | Tool calls | Current round | Waiting for approval | Stop the request |
|-------|-----------|---------------|----------------------|------------------|
| `ModelRiverClient` | `getState().toolCalls`, `tool_calls` event | `getState().toolRound` | `getState().pendingApprovals`, `tool_approvals` event | `cancel()` |
| React `useModelRiver` | `toolCalls` | `toolRound` | `pendingApprovals` | `cancel()` |
| Vue `useModelRiver` | `toolCalls` (ref) | `toolRound` (ref) | `pendingApprovals` (ref) | `cancel()` |
| Angular `ModelRiverService` | `toolCalls$` | `toolRound$` | `pendingApprovals$` | `cancel()` |
| Svelte `createModelRiver` | `toolCalls` (store) | `toolRound` (store) | `pendingApprovals` (store) | `cancel()` |

```tsx
import { useModelRiver } from '@modelriver/client/react';

function Answer() {
  const { toolCalls, response, error, hasPendingRequest, cancel } = useModelRiver();

  return (
    <div>
      {toolCalls.map((call) => (
        <p key={call.id} className={call.status}>
          {call.label ?? call.name}
          {call.status === 'error' && call.user_message ? `: ${call.user_message}` : null}
        </p>
      ))}

      {hasPendingRequest && <button onClick={() => cancel()}>Stop</button>}
      {response?.status === 'success' && <pre>{JSON.stringify(response.data, null, 2)}</pre>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
```

How it behaves:

- **Order.** `toolCalls` lists calls in the order they started. Calls of one round can run at the same time and finish in any order.
- **Statuses.** `running`, then `ok`, `error` or `timeout`. A failed call does not fail the request: the model is told and usually still answers. `ended` is set by the client when the request finishes before it saw a call finish (for example after a reconnect), so a spinner never runs forever. Tools that change something add `awaiting_approval`, `approved`, `rejected`, `expired` and `unknown` (see [Hosted tools approvals](#hosted-tools-approvals)).
- **`user_message`.** Your endpoint can return a message that is safe to show the end user when it refuses a call. It is the only text from your endpoint that reaches the browser.
- **Reconnects.** The list is kept across a reconnect. If the request is still running (or waiting for approval) when the client rejoins, ModelRiver sends where things stand (`tool_state`). The client takes the calls it lists, drops any call it still showed as running or waiting that isn't listed, and keeps calls it already saw finish (ModelRiver keeps a call's progress for ten minutes, so a later snapshot can leave earlier calls out). `pendingApprovals` is rebuilt from it. While a request waits for approval, calls from earlier rounds are listed from the request's log, with `label: null` and `user_message: null`; the client keeps the label and message it already had, and a call it never saw has none, so fall back to `name`.
- **`cancel()`.** Resolves `true` when ModelRiver took the request to stop. ModelRiver starts no further model round; a tool call already under way is left to finish, and calls waiting for approval are declined and never run. The final `response` then arrives with `status: "error"` and `error.type: "cancelled"`, so keep the connection open. Model rounds that already ran are still counted. It resolves `false` when the client isn't joined to a request, or on a server without hosted tools.
- **Other endings.** `error.type` is `tool_loop_limit` when the model kept asking for tools past the workflow's limits, `tool_loop_timeout` when the request ran out of time. A request that waits for approval can also end with `tool_pause_failed` (it couldn't be saved to wait), `tool_unavailable` (hosted tools were turned off, or the workflow was deleted or its tools switched off, while it waited; nothing approved was sent) or `tool_resume_failed` (it could not carry on after the wait); their `error.message` is "This request could not be completed." `error.message` is written for end users in each case.
- **Usage.** A successful or stopped response carries `meta.tool_loop` (`{ rounds, tool_calls }`). Each model round counts as one request on your plan; tool calls are free.

Older SDK versions ignore these events and still receive the final response.

## Hosted Tools Approvals

A tool marked "Changes something" in the console runs only after the end user approves that call. When the model asks for one, ModelRiver pauses the request and the client receives the call in `pendingApprovals`, with the tool's approval prompt and the arguments the developer chose to show. Your app shows them with Approve and Decline buttons. The request carries on once every such call of the round is decided, or when the wait runs out (set per workflow; 10 minutes by default).

The SDK has no approve method, on purpose. Approving needs your API key and the end user's id, so it goes through your backend:

1. The browser shows the approval and sends the decision to your own route.
2. Your route checks who is signed in, then calls `POST /v1/ai/tool-calls/:id/approve` (or `/reject`) with your API key and `end_user.id`, the same id you sent with the request.
3. ModelRiver sends `tool_approval_resolved`; the client takes the call out of `pendingApprovals`. An approved call then runs as usual (`tool_call_started`, `tool_call_completed`).

```tsx
import { Fragment } from 'react';
import { useModelRiver } from '@modelriver/client/react';

function Answer() {
  // getToken: see Reconnecting. A wait can outlast a resume token
  const { pendingApprovals } = useModelRiver({ getToken });

  // Your route; it knows who is signed in, so the browser sends no user id
  const decide = (id: string, decision: 'approve' | 'reject') =>
    fetch(`/api/tool-calls/${encodeURIComponent(id)}/${decision}`, { method: 'POST' });

  return (
    <div>
      {pendingApprovals.map((approval) => (
        <div key={approval.id}>
          {/* Plain text only: React escapes it. Never render these as HTML. */}
          <p>{approval.prompt}</p>
          <dl>
            {Object.entries(approval.arguments).map(([name, value]) => (
              <Fragment key={name}>
                <dt>{name}</dt>
                {/* Show the whole value: a cut-off value can hide what is being approved */}
                <dd style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {typeof value === 'string' ? value : JSON.stringify(value)}
                </dd>
              </Fragment>
            ))}
          </dl>
          <button onClick={() => decide(approval.id, 'approve')}>Approve</button>
          <button onClick={() => decide(approval.id, 'reject')}>Decline</button>
        </div>
      ))}
    </div>
  );
}
```

Your backend (Node.js / Express here):

```javascript
app.post('/api/tool-calls/:id/:decision', requireSignedIn, async (req, res) => {
  const { id, decision } = req.params;
  if (decision !== 'approve' && decision !== 'reject') return res.sendStatus(404);

  const response = await fetch(
    `https://api.modelriver.com/v1/ai/tool-calls/${encodeURIComponent(id)}/${decision}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.MODELRIVER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      // From your session, never from the browser: ModelRiver checks it is the
      // end_user.id the request was sent with
      body: JSON.stringify({ end_user: { id: req.user.id } }),
    }
  );
  // Pass ModelRiver's answer through as is (a proxy error may not be JSON)
  res.status(response.status).type(response.headers.get('content-type') ?? 'text/plain').send(await response.text());
});
```

How it behaves:

- **What the browser sees.** Only the approval prompt and the arguments listed in the tool's approval fields. Other arguments and all results stay on the server. The model wrote the argument values, so render the prompt and the values as plain text (never HTML, Markdown or links), in full.
- **Statuses in `toolCalls`.** A waiting call shows as `awaiting_approval`. After the decision it becomes `approved` (until it starts, which happens once every call of the round is decided), `rejected` or `expired`. A declined or expired call is not run; the model is told and carries on, so the request does not fail because of it. `unknown` means the call was sent but ModelRiver can't tell whether it finished (no answer in time, the connection dropped, or the endpoint returned a `5xx`); it is never sent again, so check before trying it again.
- **Answers from the approve route.** Repeating the same decision returns the same `200`. A call already decided the other way returns `409 tool_call_already_decided` (`details.status` is the decision that stands; a call of a stopped request shows `rejected`), one past its wait returns `410 tool_approval_expired`, a different end user returns `409 end_user_mismatch`, and an id the API key's project has no waiting call for returns `404 tool_call_not_found`.
- **Stopping.** `cancel()` while calls wait ends the request straight away; waiting calls are declined and never run.
- **Reconnects and reloads.** `pendingApprovals` is kept across a reconnect and rebuilt from `tool_state` when the client rejoins. A wait can be longer than a resume token lives (5 minutes), so pass `getToken` if the page may be reloaded or offline for longer. While calls wait, the stored request stays resumable until the latest `expires_at` plus 5 minutes. Prompts and arguments are kept in memory only, never in `localStorage`.
- **When the request ends.** Calls still waiting or approved are marked `ended`, and `pendingApprovals` is emptied.
- **`ok` without a readable result.** A call to a tool that changes something that your endpoint answered `2xx` is `ok` even when ModelRiver couldn't read its result (not JSON, or too large): the action ran, and the model is told so. A `5xx`, a timeout, a dropped connection or an answer cut off for its size is `unknown`.
- **Older SDKs** ignore the approval events: the request just seems to take longer. On a rejoin, 1.9.x copies `tool_state` calls as they are, so `toolCalls` can hold statuses it doesn't know (`awaiting_approval`, `approved`) that are never marked `ended`. It also drops a stored request after 5 minutes (60 with `getToken`), so a reload during a longer wait can't rejoin. To show the approval with them, use the `tool.approval_required` webhook or `GET /v1/ai/tool-calls/:id` from your backend, or upgrade.
- **Stopping to follow.** After `disconnect()`, or when the client gives up reconnecting, `pendingApprovals` is emptied: the client would not see the decision or the outcome. Calls in `toolCalls` keep their status.

## Live Sessions

For workflows with session memory, `subscribeToSession` follows one conversation as it happens: AI turns, user or human-agent turns your backend appends, signals your backend sends, and deletion. Use it to show an agent's reply in a customer's chat, or a customer's new message in your team's dashboard, without polling.

Your backend asks ModelRiver for a single-use token with `POST /v1/sessions/:id/subscribe` (API key, server side only) and returns the response. The SDK calls your backend again for each reconnection.

```typescript
import { subscribeToSession } from '@modelriver/client';

const subscription = subscribeToSession({
  // Your route that checks the user may see this conversation, then calls
  // POST /v1/sessions/:id/subscribe and returns the JSON as is.
  getSubscription: () => fetch(`/api/chats/${chatId}/live`, { method: 'POST' }).then((r) => r.json()),

  onMessage: (message) => addMessage(message), // merge by message.id
  onSignal: (signal) => {
    if (signal.name === 'agent.joined') showAgent(signal.data);
  },
  onDeleted: () => closeChat(),
  // Joined (first time and after every reconnection). Events sent while
  // disconnected aren't replayed, so reload the conversation here.
  onLive: () => reloadMessages(),
  onStatus: (status) => setConnectionBadge(status), // connecting | live | reconnecting | closed
});

// When the chat closes
subscription.close();
```

| Option | Description |
|--------|-------------|
| `getSubscription` | Returns `{ ws_token, websocket_url, websocket_channel }` (camelCase works too) from your backend, or `null` when there's nothing to follow. Called for every (re)connection |
| `onMessage(message)` | A new turn: `{ id, session_id, role, author: 'user' \| 'ai' \| 'agent', author_name, content, created_at }`. Ids match `GET /v1/sessions/:id` |
| `onSignal(signal)` | `{ session_id, name, data, sent_at }`, sent by your backend with `POST /v1/sessions/:id/signals`. Not stored |
| `onDeleted(payload)` | The session was deleted; the subscription closes |
| `onLive()` | Joined, the first time and after each reconnection |
| `onStatus(status)` | `connecting`, `live`, `reconnecting` or `closed` |
| `onError(error)` | A connection or join failed. The subscription retries (1s, 2s, 5s, 10s, then every 30s) unless the session is gone or the token is for another session |
| `retryDelaysMs` | Custom retry waits in ms; the last one repeats |

Failed AI requests and test-mode runs aren't announced. Connections close after an hour and reconnect with a new token.

## Reconnecting

Listening tokens are single-use: ModelRiver consumes a `ws_token` when a socket connects with it. So after joining, ModelRiver hands the client its next token, a **resume token**, over the channel it already authenticated, and the client asks for a fresh one every 2 minutes. When the connection drops, the client reconnects with that token and backoff (1s, 2s, 5s, 10s, then every 30s).

**Reconnects on its own** (no backend route needed):

- Network drops (Wi-Fi blips, going offline and back)
- ModelRiver's 1-hour connection cutoff
- Page reloads within about 5 minutes: the resume token is kept in `localStorage` (with `persist`, the default), and `reconnect()` uses it on load. The framework adapters call `reconnect()` on mount

**Needs `getToken`:**

- Gaps longer than about 5 minutes (a closed tab, a laptop asleep): resume tokens expire 5 minutes after they're issued
- ModelRiver deploys and restarts: tokens live in server memory, so a restart erases them

Without `getToken`, the client stops with a clear `error` once it has no usable token. It doesn't retry forever. With `getToken`, it also stops after 3 new tokens in a row fail to get it rejoined, or after an hour without a successful join (a `getToken` that throws is retried until then).

What happens during a gap: `stream_delta` events sent while disconnected are lost (`getState().streamText` keeps what arrived before the drop). The final `response` is buffered on the server for 10 minutes and delivered when the client rejoins.

### getToken

`getToken` asks your backend for a new token. Your backend calls ModelRiver's `POST /v1/ai/reconnect` with its API key and returns the JSON as is. Return `null` when the request is gone (ModelRiver answered 404): the client stops with an error. Throw for anything temporary: the client waits and tries again.

```typescript
const client = new ModelRiverClient({
  getToken: async ({ channelId }) => {
    const res = await fetch(`/api/ai/requests/${channelId}/token`, { method: 'POST' });
    if (res.status === 404) return null; // the request is gone: stop
    if (!res.ok) throw new Error(`Token route failed: ${res.status}`); // retried with backoff
    return res.json();
  },
});
```

ModelRiver only checks that the channel belongs to your project, not which of your users started it. Your route must check that the signed-in user owns the `channel_id` **before** it asks ModelRiver for a token. Save the `channel_id` with the user when you start the request:

```javascript
// Express example
app.post('/api/ai/requests/:channelId/token', requireUser, async (req, res) => {
  const { channelId } = req.params;

  // 1. Only the user who started this request may listen to it
  const owned = await db.aiRequests.findOne({ channelId, userId: req.user.id });
  if (!owned) return res.status(404).end();

  // 2. Ask ModelRiver for a new single-use token (API key stays on the server)
  const mr = await fetch('https://api.modelriver.com/v1/ai/reconnect', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.MODELRIVER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel_id: channelId }),
  });
  if (mr.status === 404) return res.status(404).end(); // finished long ago, or never existed
  if (!mr.ok) return res.status(502).end();

  // { channel_id, project_id, ws_token, websocket_url, websocket_channel }
  res.json(await mr.json());
});
```

With `getToken` set, a stored request stays resumable for up to an hour after the page last saved it; without it, only as long as its stored token lives (5 minutes).

## How It Works

1. **Your backend** calls ModelRiver's `/api/v1/ai/async` endpoint
2. **ModelRiver** returns `channel_id`, `ws_token`, `websocket_url`, and `websocket_channel`
3. **Your backend** returns these fields to the frontend (never the API key)
4. **Your frontend** uses this SDK to connect via WebSocket using `channel_id` + `ws_token`
5. **AI responses** are delivered in real-time to your frontend
6. **The SDK** handles heartbeats and channel joins, and reconnects with single-use resume tokens after network drops, the 1-hour cutoff and page reloads within about 5 minutes.
7. For **longer gaps** and ModelRiver restarts, pass `getToken`: your backend checks the user owns the request, then calls ModelRiver's `/v1/ai/reconnect` (see [Reconnecting](#reconnecting)).

```
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│   Frontend   │       │ Your Backend │       │  ModelRiver  │
└──────┬───────┘       └──────┬───────┘       └──────┬───────┘
       │                      │                      │
       │  1. Request AI       │                      │
       │─────────────────────>│                      │
       │                      │  2. Create request   │
       │                      │─────────────────────>│
       │                      │                      │
       │                      │  3. Return channel_id│
       │                      │<─────────────────────│
       │  4. Return channel_id│                      │
       │<─────────────────────│                      │
       │                      │                      │
       │  5. Connect WebSocket (SDK)                 │
       │─────────────────────────────────────────────>│
       │                      │                      │
       │  6. Stream AI response                      │
       │<─────────────────────────────────────────────│
       │                      │                      │
```

### Backend pipelines

Workflows with backend steps send progress statuses while ModelRiver waits for your backend callbacks:

- `ai_generated` - the AI step finished and the pipeline started
- `step_ready` - ModelRiver sent a webhook and is waiting for your callback
- `step_received`, `step_completed` - your callback was received and the step finished
- `callback_ai_started`, `callback_ai_completed` - an AI step inside the pipeline is running or done

The SDK keeps the connection open through these statuses, emits each one as a `response` event, and updates the `backend` step. The final result arrives with `status: "completed"`, after which the connection closes.

## Security

The `/api/v1/ai/async` response contains:
- `channel_id` - Unique identifier for this request
- `ws_token` - Short-lived, one-time WebSocket token (per user + project)
- `websocket_url` - WebSocket endpoint URL
- `websocket_channel` - Channel name to join

The client SDK uses `channel_id` and `ws_token` to connect to the WebSocket.  
The `ws_token` is:

- Short-lived (≈5 minutes)
- Single-use (consumed on first successful WebSocket authentication)

Resume tokens are the same kind of credential:

- Single-use, and they expire 5 minutes after they're issued
- Scoped to one request: they can only join that request's channel, can't start requests and can't reach other channels
- One at a time per connection: each refresh revokes the previous token, and the final response revokes the last one
- Only issued to sockets that connected with a listening token

For page refresh recovery, the SDK keeps the request's `channel_id` and its latest unused resume token in `localStorage` (by default). On reload, `client.reconnect()` resumes with that token, or asks `getToken` when it's stale or refused.

**Important**: Always obtain `channel_id` and `ws_token` from your backend.  
Never expose your ModelRiver API key in frontend code. Your backend should be the only component that talks to ModelRiver's HTTP API (`/v1/ai/async`, `/v1/ai/reconnect`, etc.), and your `getToken` route must check that the signed-in user owns the `channel_id` before calling `/v1/ai/reconnect`.

## Browser Support

- Chrome 60+
- Firefox 55+
- Safari 12+
- Edge 79+

## Changelog

### 1.10.0

- Hosted tools approvals. A tool that changes something waits for the end user before each call. The client keeps the calls waiting in `getState().pendingApprovals` (`{ id, name, label, round, prompt, arguments, expires_at }`) and emits `tool_approvals` whenever that list changes. The raw messages are also emitted: `tool_approval_required` and `tool_approval_resolved`
- `ToolCallStatus` adds `awaiting_approval`, `approved` (approved, not started yet), `rejected`, `expired` and `unknown` (sent, outcome unknown). `tool_call_completed` can now carry `unknown`
- `tool_state` rebuilds `pendingApprovals` too, so a client that rejoins (or reloads) while the request waits shows the approval again. While calls wait, the stored request stays resumable until the latest `expires_at` plus 5 minutes
- A `tool_state` that leaves out calls the client already saw finish (ModelRiver keeps a call's progress for ten minutes; a wait can last an hour) no longer removes them from `toolCalls`
- When the request ends, calls still waiting or approved are marked `ended` and `pendingApprovals` is emptied
- The React, Vue and Svelte adapters expose `pendingApprovals`; Angular exposes `pendingApprovals$`
- No approve method: approving goes through your backend (`POST /v1/ai/tool-calls/:id/approve` or `/reject`, with your API key and `end_user.id`). See [Hosted tools approvals](#hosted-tools-approvals)
- Exported the `ToolApproval`, `ToolApprovalRequiredPayload`, `ToolApprovalResolvedPayload`, `ToolApprovalDecision` and `ToolStateCall` types
- Nothing changes for workflows without tools that change something

### 1.9.0

- Hosted tools progress. While ModelRiver runs a workflow's tools, the client keeps the list of tool calls (`getState().toolCalls`) and the current model round (`getState().toolRound`), and emits `tool_calls` whenever either changes. The raw messages are also emitted: `tool_round_started`, `tool_call_started`, `tool_call_completed` and `tool_state` (where the request stands, sent when the client joins part-way). No tool arguments or results are sent to the browser
- Added `cancel()`: asks ModelRiver to stop the request the client is following. It resolves `true` when the server took it; the final `response` still arrives, with `error.type` `"cancelled"`
- A call still shown as `running` when the final response arrives is marked `ended`, so progress indicators always stop
- The React, Vue, Angular and Svelte adapters expose `toolCalls`, `toolRound` and `cancel()` (`toolCalls$` and `toolRound$` in Angular)
- The React hook now returns `streamText`, the text streamed so far for `stream: true` requests
- Typed `meta.tool_loop` (`{ rounds, tool_calls }`) and `error.type` on `AIResponse`
- Exported the `ToolCall`, `ToolCallStatus`, `ToolRound`, `ToolRoundStartedPayload`, `ToolCallStartedPayload`, `ToolCallCompletedPayload` and `ToolStatePayload` types
- Nothing changes for workflows without hosted tools

### 1.8.0

- Async requests reconnect on their own. After joining, ModelRiver sends a single-use resume token, which the client rotates every 2 minutes (`tokenRefreshInterval`) and keeps in `localStorage`. After a network drop, ModelRiver's 1-hour cutoff or a page reload within about 5 minutes, the client reconnects with it, with backoff (`retryDelaysMs`)
- Added the `getToken` option: a callback to your backend for a new token when the resume token is stale or refused (longer gaps, ModelRiver restarts). It returns ModelRiver's `/v1/ai/reconnect` JSON, or `null` when the request is gone
- `reconnect()` now resumes with the stored resume token instead of the spent `ws_token`, and falls back to `getToken` on its own
- Added the `reconnecting` connection state and event (`attempt`, `delayMs`). Dropped connections no longer emit `error` while the client is still retrying; it stops with one clear `error` when it has no way to get a token, instead of retrying a spent token forever
- A reconnect keeps the request's steps, response and streamed text; only `connect()` starts from scratch
- The socket now closes after the final response, so Phoenix can't retry it with a spent token
- A dropped socket can no longer reconnect on its own with its spent token (also fixed for `subscribeToSession`)
- Deprecated `apiBaseUrl` and `reconnectWithBackend()` in favour of `getToken`. `apiBaseUrl` still works as a fallback token source
- Added `detach()`: closes the socket and stops all timers while keeping the stored request and resume token
- The React, Vue and Angular adapters now `detach()` on unmount while a request is pending, instead of leaving the client running; Svelte's `disconnect()` still ends the request. All four start the mount-time `reconnect()` a tick later, so React StrictMode's double mount spends the stored token only once
- Fixed the adapters clearing the stored request under the wrong key (`modelriver` instead of the default `modelriver_` prefix) and only when `persist: true` was passed explicitly
- A resume token is not reused in the last 30 seconds before it expires
- Exported the `ReconnectInfo` and `ReconnectRequest` types
- Build: `deepmerge` (a dev dependency of the Rollup resolver) is pinned to 4.1.2 through `overrides`, because advisory GHSA-gcqx-w48m-w2h4 has no patched release. Remove the override once a fixed `deepmerge` ships

### 1.7.0

- Added `subscribeToSession` for live session updates: new turns (`message`), app-defined `signal`s and `deleted`, with single-use tokens fetched from your backend on every reconnection and backoff while it's unavailable
- Exported the `SessionMessage`, `SessionSignal`, `SessionSubscription`, `SessionSubscriptionInfo`, `SessionSubscriptionOptions` and `SessionSubscriptionStatus` types

### 1.6.0

- Added token streaming events for async requests sent with `stream: true`: `stream_start`, `stream_delta` (with the accumulated text as a second argument), `stream_done` and `stream_error`
- Added `streamText` to `getState()`, holding the text streamed so far for the current request
- Exported the `StreamStartPayload`, `StreamDeltaPayload`, `StreamDonePayload` and `StreamErrorPayload` types

### 1.5.1

- Fixed backend pipeline workflows: `step_ready`, `step_completed`, `step_received`, `callback_ai_started`, and `callback_ai_completed` no longer close the connection with "Unknown error". The SDK now waits for `completed`
- Added `step_index`, `total_steps`, `step_type`, and `pipeline_workflow_name` to `AIResponse`

### 1.4.0

- Updated dependencies to latest stable versions (Phoenix.js 1.8.9, Vitest 4, TypeScript 5.9, jsdom 29, and related build tooling)
- `connect()` requires `wsToken` from the `/api/v1/ai/async` response; the client validates presence of `channelId` and `wsToken` before connecting (token verification is handled server-side)
- React adapter dev dependencies updated to React 19; peer dependency remains `react >= 16.8.0`

## License

MIT

## Links

- [Client SDK Documentation](https://modelriver.com/docs/client-sdk)
- [API Reference](https://modelriver.com/docs/api)
- [Getting Started](https://modelriver.com/docs/getting-started)
- [Dashboard](https://modelriver.com/dashboard)
- [GitHub Issues](https://github.com/modelriver/client/issues)

