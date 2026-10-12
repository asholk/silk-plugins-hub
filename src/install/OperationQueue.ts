import { devLog } from "../devLog";

/** What is happening to a plugin: waiting for its turn, or running now. */
export interface Operation {
  label: string;
  running: boolean;
}

interface Job {
  id: string;
  label: string;
  task: () => Promise<unknown>;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/** Pause between operations, so a phone gets to draw the screen and handle taps before the next plugin loads. */
const BREATHE_MS = 50;

/**
 * Runs plugin installs, updates, switches and removals one at a time.
 * Loading several plugins at once makes a phone unresponsive for tens of seconds, and parallel
 * changes to the same plugin folder or to Obsidian's plugin registry can race.
 * State lives here, not in the settings page, so a redrawn row still shows what's going on.
 */
export class OperationQueue {
  private jobs: Job[] = [];
  private current: Job | null = null;
  private draining = false;
  private listeners = new Set<() => void>();

  /** The operation queued or running for this plugin, if any. */
  get(id: string): Operation | null {
    if (this.current?.id === id) return { label: this.current.label, running: true };
    const job = this.jobs.find((j) => j.id === id);
    return job ? { label: job.label, running: false } : null;
  }

  /** Promise of the operation queued or running for this plugin, if any. */
  pending(id: string): Promise<unknown> | null {
    if (this.current?.id === id) return this.current.promise;
    return this.jobs.find((j) => j.id === id)?.promise ?? null;
  }

  /**
   * Queues an operation on a plugin. While one is queued or running for the same plugin,
   * a second request waits for it instead of starting another.
   */
  run<T>(id: string, label: string, task: () => Promise<T>): Promise<T> {
    const existing = this.pending(id);
    if (existing) {
      devLog.log(`queue: ${id} already queued, joining`);
      return existing as Promise<T>;
    }
    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.jobs.push({ id, label, task, promise, resolve, reject });
    devLog.log(`queue: + ${id} "${label}", waiting ${this.jobs.length}, running ${this.current?.id ?? "nothing"}`);
    this.changed();
    if (!this.draining) void this.drain();
    return promise as Promise<T>;
  }

  /** Changes what the running operation on this plugin shows, e.g. "Downloading…" → "Installing…". */
  setLabel(id: string, label: string): void {
    if (this.current?.id !== id || this.current.label === label) return;
    this.current.label = label;
    this.changed();
  }

  /** Called on every change of the queue; returns a function that unsubscribes. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async drain(): Promise<void> {
    this.draining = true;
    while (this.jobs.length > 0) {
      const job = this.jobs.shift() as Job;
      this.current = job;
      this.changed();
      // Let the "queued" state reach the screen before the heavy work starts.
      await breathe();
      try {
        job.resolve(await devLog.step(`job ${job.id} "${job.label}"`, job.task));
      } catch (err) {
        job.reject(err);
      }
      this.current = null;
      this.changed();
      await breathe();
    }
    this.draining = false;
  }

  private changed(): void {
    const startedAt = performance.now();
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (err) {
        console.error("Silk Hub: queue listener failed", err);
      }
    }
    devLog.log(`queue: notified ${this.listeners.size} listeners in ${Math.round(performance.now() - startedAt)}ms`);
  }
}

function breathe(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, BREATHE_MS));
}
