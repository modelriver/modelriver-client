/**
 * ModelRiver Angular Service
 * 
 * Angular injectable service for connecting to ModelRiver's WebSocket-based AI response streaming.
 * 
 * @example
 * ```typescript
 * import { Component, OnDestroy } from '@angular/core';
 * import { ModelRiverService } from '@modelriver/client/angular';
 * 
 * @Component({
 *   selector: 'app-chat',
 *   providers: [ModelRiverService],
 *   template: `
 *     <div *ngIf="modelRiver.response$ | async as response">
 *       {{ response | json }}
 *     </div>
 *   `
 * })
 * export class ChatComponent implements OnDestroy {
 *   constructor(public modelRiver: ModelRiverService) {
 *     this.modelRiver.init({ baseUrl: 'wss://api.modelriver.com/socket' });
 *   }
 * 
 *   async send() {
 *     const { channel_id, websocket_url } = await this.backendService.createRequest(message);
 *     this.modelRiver.connect({ channelId: channel_id, websocketUrl: websocket_url });
 *   }
 * 
 *   ngOnDestroy() {
 *     this.modelRiver.disconnect();
 *   }
 * }
 * ```
 */

import { BehaviorSubject, Observable } from 'rxjs';
import { ModelRiverClient } from './client';
import { clearActiveRequest } from './utils';
import type {
  ModelRiverClientOptions,
  ConnectOptions,
  ConnectionState,
  WorkflowStep,
  AIResponse,
} from './types';

/**
 * Angular service for ModelRiver WebSocket client
 * 
 * Use with `providers: [ModelRiverService]` in your component or module.
 */
export class ModelRiverService {
  private client: ModelRiverClient | null = null;
  private unsubscribers: (() => void)[] = [];

  // BehaviorSubjects for reactive state
  private connectionStateSubject = new BehaviorSubject<ConnectionState>('disconnected');
  private stepsSubject = new BehaviorSubject<WorkflowStep[]>([]);
  private responseSubject = new BehaviorSubject<AIResponse | null>(null);
  private errorSubject = new BehaviorSubject<string | null>(null);
  private hasPendingRequestSubject = new BehaviorSubject<boolean>(false);

  // Public observables
  readonly connectionState$: Observable<ConnectionState> = this.connectionStateSubject.asObservable();
  readonly steps$: Observable<WorkflowStep[]> = this.stepsSubject.asObservable();
  readonly response$: Observable<AIResponse | null> = this.responseSubject.asObservable();
  readonly error$: Observable<string | null> = this.errorSubject.asObservable();
  readonly hasPendingRequest$: Observable<boolean> = this.hasPendingRequestSubject.asObservable();

  // Convenience getters for current values
  get isConnected(): boolean {
    return this.connectionStateSubject.value === 'connected';
  }

  get isConnecting(): boolean {
    return this.connectionStateSubject.value === 'connecting';
  }

  /**
   * Initialize the ModelRiver client
   * Must be called before using connect()
   */
  init(options: ModelRiverClientOptions = {}): void {
    if (this.client) {
      this.cleanup();
    }

    this.client = new ModelRiverClient(options);

    // Set up event listeners
    this.unsubscribers.push(
      this.client.on('connecting', () => {
        this.connectionStateSubject.next('connecting');
      })
    );

    this.unsubscribers.push(
      this.client.on('connected', () => {
        this.connectionStateSubject.next('connected');
      })
    );

    this.unsubscribers.push(
      this.client.on('disconnected', () => {
        this.connectionStateSubject.next('disconnected');
      })
    );

    this.unsubscribers.push(
      this.client.on('response', (data) => {
        this.responseSubject.next(data);
        // Check for both 'completed' and 'success' statuses (both indicate workflow completion)
        // Also check meta.status for completion indicators
        const status = data.status || data.meta?.status;
        const isCompleted = status === 'completed' || status === 'success' || status === 'SUCCESS';

        if (isCompleted) {
          this.hasPendingRequestSubject.next(false);
          // Clear from localStorage if persist is enabled
          if (options.persist) {
            clearActiveRequest(options.storageKeyPrefix || 'modelriver');
          }
          // Disconnect immediately to prevent any further connection attempts
          if (this.client) {
            this.client.disconnect();
          }
        } else {
          // Intermediate statuses (ai_generated, pipeline steps) keep the request pending
          this.hasPendingRequestSubject.next(this.client?.hasPendingRequest() ?? false);
        }
      })
    );

    this.unsubscribers.push(
      this.client.on('error', (err) => {
        this.errorSubject.next(typeof err === 'string' ? err : err.message);
        this.connectionStateSubject.next('error');
      })
    );

    this.unsubscribers.push(
      this.client.on('step', () => {
        if (this.client) {
          const state = this.client.getState();
          this.stepsSubject.next([...state.steps]);
        }
      })
    );

    // Check for pending request on init
    // First check if workflow is already completed - if so, skip all reconnection logic
    const currentState = this.client.getState();
    if (currentState.isCompleted) {
      // Workflow is already completed, clear any pending request
      this.hasPendingRequestSubject.next(false);
      if (options.persist) {
        clearActiveRequest(options.storageKeyPrefix || 'modelriver');
      }
    } else if (this.client && this.client.hasPendingRequest()) {
      // Check if response status indicates completion (both 'completed' and 'success')
      const responseStatus = currentState.response?.status || currentState.response?.meta?.status;
      if (responseStatus === 'completed' || responseStatus === 'success' || responseStatus === 'SUCCESS') {
        // Response is already completed, clear the pending request
        this.hasPendingRequestSubject.next(false);
        if (options.persist) {
          clearActiveRequest(options.storageKeyPrefix || 'modelriver');
        }
      } else {
        // Not completed, safe to attempt reconnection
        this.hasPendingRequestSubject.next(true);
        // Attempt reconnection
        if (this.client) {
          this.client.reconnect();
        }
      }
    }
  }

  /**
   * Connect to WebSocket with channel ID
   */
  connect(options: ConnectOptions): void {
    if (!this.client) {
      console.error('[ModelRiver] Client not initialized. Call init() first.');
      return;
    }

    this.errorSubject.next(null);
    this.responseSubject.next(null);
    this.stepsSubject.next([]);
    this.hasPendingRequestSubject.next(true);

    this.client.connect(options);
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    if (!this.client) return;

    this.client.disconnect();
    this.hasPendingRequestSubject.next(false);
  }

  /**
   * Reset state and clear stored data
   */
  reset(): void {
    if (!this.client) return;

    this.client.reset();
    this.connectionStateSubject.next('disconnected');
    this.stepsSubject.next([]);
    this.responseSubject.next(null);
    this.errorSubject.next(null);
    this.hasPendingRequestSubject.next(false);
  }

  /**
   * Clean up resources (call in ngOnDestroy)
   */
  destroy(): void {
    this.cleanup();
    this.connectionStateSubject.complete();
    this.stepsSubject.complete();
    this.responseSubject.complete();
    this.errorSubject.complete();
    this.hasPendingRequestSubject.complete();
  }

  private cleanup(): void {
    this.unsubscribers.forEach((unsub) => unsub());
    this.unsubscribers.length = 0;

    // Only destroy if there's no pending request and workflow is not already completed
    if (this.client) {
      const state = this.client.getState();
      if (!this.client.hasPendingRequest() && !state.isCompleted) {
        this.client.destroy();
      }
    }
    this.client = null;
  }
}

// Factory function for easier testing
export function createModelRiverService(options?: ModelRiverClientOptions): ModelRiverService {
  const service = new ModelRiverService();
  if (options) {
    service.init(options);
  }
  return service;
}

