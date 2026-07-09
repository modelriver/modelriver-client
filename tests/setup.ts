/**
 * Test Setup
 *
 * Configure jsdom and mock external dependencies for testing.
 */

import { beforeEach, vi } from 'vitest';

function createLocalStorageMock() {
  let store: Record<string, string> = {};

  return {
    getItem(key: string) {
      return store[key] ?? null;
    },
    setItem(key: string, value: string) {
      store[key] = value;
    },
    removeItem(key: string) {
      delete store[key];
    },
    clear() {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key(index: number) {
      return Object.keys(store)[index] ?? null;
    },
  };
}

const localStorageMock = createLocalStorageMock();

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
  configurable: true,
});

// Mock Phoenix Socket (Vitest 4 requires class mocks for `new Socket()`)
vi.mock('phoenix', () => {
  class MockSocket {
    url: string;
    opts: unknown;
    connect = vi.fn();
    disconnect = vi.fn();
    onOpen = vi.fn();
    onClose = vi.fn();
    onError = vi.fn();
    channel = vi.fn().mockReturnValue({
      join: vi.fn().mockReturnValue({
        receive: vi.fn().mockReturnThis(),
      }),
      leave: vi.fn(),
      on: vi.fn(),
      push: vi.fn(),
    });

    constructor(url: string, opts?: unknown) {
      this.url = url;
      this.opts = opts;
    }
  }

  return {
    Socket: MockSocket,
    Channel: vi.fn(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorageMock.clear();
});
