# @modelriver/client

Official ModelRiver client SDK for real-time AI response streaming via WebSockets.

## Features

- **WebSocket streaming** - Receive AI responses in real-time via Phoenix Channels
- **Live sessions** - Follow a conversation as it happens: new turns, app signals and deletion (`subscribeToSession`)
- **Auto-reconnection** - Automatically reconnects on connection loss
- **Persistence + reconnect** - Survives page refreshes with localStorage + backend reconnect
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
<script src="https://cdn.modelriver.com/client/v1.7.0/modelriver.min.js"></script>
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
  apiBaseUrl?: string;        // Optional HTTP base URL for backend reconnect (/api/v1/ai/reconnect)
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
| `reconnect()` | Reconnect using stored channel ID |
| `reconnectWithBackend()` | Call your backend `/api/v1/ai/reconnect` to get a fresh `ws_token` and reconnect |
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
| `disconnected` | `reason?: string` | Disconnected from WebSocket |
| `response` | `AIResponse` | AI response received |
| `error` | `Error` or `string` | Error occurred |
| `step` | `WorkflowStep` | Workflow step updated |
| `channel_joined` | - | Successfully joined channel |
| `channel_error` | `reason: string` | Channel join failed |
| `stream_start` | `StreamStartPayload` | Token streaming started (`stream: true` requests) |
| `stream_delta` | `StreamDeltaPayload`, `text: string` | New chunk; second argument is the text accumulated so far |
| `stream_done` | `StreamDonePayload` | Streaming finished; the final `response` event follows |
| `stream_error` | `StreamErrorPayload` | Streaming failed; a final `response` with an error status follows |

### Types

```typescript
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
  };
  error?: {
    message: string;
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
```

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

## How It Works

1. **Your backend** calls ModelRiver's `/api/v1/ai/async` endpoint
2. **ModelRiver** returns `channel_id`, `ws_token`, `websocket_url`, and `websocket_channel`
3. **Your backend** returns these fields to the frontend (never the API key)
4. **Your frontend** uses this SDK to connect via WebSocket using `channel_id` + `ws_token`
5. **AI responses** are delivered in real-time to your frontend
6. **The SDK** handles heartbeats, channel joins, and automatic reconnection for transient network issues.  
7. For **page refresh recovery**, use the persistence + reconnect helpers (`persist`, `hasPendingRequest`, `reconnect`, `reconnectWithBackend`) together with your backend `/api/v1/ai/reconnect` endpoint.

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

For page refresh recovery:

- The SDK persists the active request (by default) to `localStorage`
- On reload, you can:
  - either call `client.reconnect()` to reuse the stored `ws_token` (if still valid)
  - or call `client.reconnectWithBackend()` to have your backend issue a **fresh** `ws_token` via `/api/v1/ai/reconnect`

**Important**: Always obtain `channel_id` and `ws_token` from your backend.  
Never expose your ModelRiver API key in frontend code. Your backend should be the only component that talks to ModelRiver's HTTP API (`/api/v1/ai/async`, `/api/v1/ai/reconnect`, etc.).

## Browser Support

- Chrome 60+
- Firefox 55+
- Safari 12+
- Edge 79+

## Changelog

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

