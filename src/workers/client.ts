import type { FriendlyError } from '../models/issues';
import type { ProgressInfo } from '../models/session';
import type { ResponseMap, WorkerMessageIn, WorkerMessageOut, WorkerRequest } from './protocol';

export class WorkerRequestError extends Error {
  constructor(readonly friendly: FriendlyError) {
    super(friendly.message);
    this.name = 'WorkerRequestError';
  }
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: unknown): void;
  onProgress?: (p: ProgressInfo) => void;
}

/**
 * Promise-based wrapper around the comparator worker. `terminate()` is the
 * hard cancel: it kills the worker (freeing all file data) and the next call
 * starts a fresh one.
 */
export class ComparatorClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  private ensure(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./comparator.worker.ts', import.meta.url), { type: 'module', name: 'comparator' });
      this.worker.onmessage = (e: MessageEvent<WorkerMessageOut>) => this.handle(e.data);
      this.worker.onerror = (e) => {
        e.preventDefault();
        this.failAll({ code: 'WORKER_CRASHED', message: 'The processing engine stopped unexpectedly (often because the browser ran out of memory). Reload the files and try again.', details: e.message });
      };
    }
    return this.worker;
  }

  private handle(m: WorkerMessageOut) {
    const p = this.pending.get(m.id);
    if (!p) return;
    if (m.kind === 'progress') {
      p.onProgress?.(m.progress);
      return;
    }
    this.pending.delete(m.id);
    if (m.kind === 'result') p.resolve(m.payload);
    else p.reject(new WorkerRequestError(m.error));
  }

  private failAll(err: FriendlyError) {
    for (const p of this.pending.values()) p.reject(new WorkerRequestError(err));
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  request<T extends WorkerRequest['type']>(req: Extract<WorkerRequest, { type: T }>, onProgress?: (p: ProgressInfo) => void): Promise<ResponseMap[T]> {
    const id = this.nextId++;
    const worker = this.ensure();
    return new Promise<ResponseMap[T]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      worker.postMessage({ ...req, id } as WorkerMessageIn);
    });
  }

  /** Kill the worker and all in-memory data. Pending requests reject with CANCELLED. */
  terminate(): void {
    this.failAll({ code: 'CANCELLED', message: 'Cancelled.' });
  }

  get alive(): boolean {
    return this.worker !== null;
  }
}
