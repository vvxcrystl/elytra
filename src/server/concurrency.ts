import "server-only";
import { AppError } from "./errors";

export const overloaded = () => new AppError(503, "overloaded", "Server is busy. Try again shortly.", { retryAfter: 1 });

/** Fixed capacity, bounded FIFO waiting, and a deadline. No unbounded promises. */
export class Capacity {
  private active = 0;
  private queue: { grant: () => void; timer: ReturnType<typeof setTimeout> }[] = [];
  private readonly limit: number;
  private readonly maxQueue: number;
  private readonly waitMs: number;
  constructor(limit: number, maxQueue = 0, waitMs = 2000) { this.limit = limit; this.maxQueue = maxQueue; this.waitMs = waitMs; }
  snapshot() { return { active: this.active, queued: this.queue.length, limit: this.limit }; }
  acquire(): Promise<() => void> {
    if (this.active < this.limit) { this.active++; return Promise.resolve(this.releaseOnce()); }
    if (this.queue.length >= this.maxQueue) return Promise.reject(overloaded());
    return new Promise((resolve, reject) => {
      const waiter = { grant: () => resolve(this.releaseOnce()), timer: setTimeout(() => {
        const index = this.queue.indexOf(waiter);
        if (index !== -1) this.queue.splice(index, 1);
        reject(overloaded());
      }, this.waitMs) };
      this.queue.push(waiter);
    });
  }
  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) { clearTimeout(next.timer); next.grant(); }
      else this.active--;
    };
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try { return await fn(); } finally { release(); }
  }
}

// Next can load separate route/action bundles; budgets must span those bundles.
const shared = globalThis as typeof globalThis & { elytraCapacities?: Map<string, Capacity> };
export function sharedCapacity(name: string, limit: number, maxQueue = 0, waitMs = 2000): Capacity {
  const capacities = shared.elytraCapacities ??= new Map();
  let capacity = capacities.get(name);
  if (!capacity) { capacity = new Capacity(limit, maxQueue, waitMs); capacities.set(name, capacity); }
  return capacity;
}
