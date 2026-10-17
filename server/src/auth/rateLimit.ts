/**
 * Sliding-window attempt counter. Keys are kept in last-activity order, so expired keys sit at the front and are
 * swept on every hit; the map is also capped at maxKeys (oldest activity evicted first) so it cannot grow without bound.
 */
export class LoginLimiter {
  private m = new Map<string, number[]>();
  constructor(private max = 5, private windowMs = 600000, private maxKeys = 10000) {}
  hit(key: string, now = Date.now()) {
    this.sweep(now);
    const a = (this.m.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.m.delete(key);
    if (a.length >= this.max) { this.m.set(key, a); return false; }
    a.push(now); this.m.set(key, a);
    while (this.m.size > this.maxKeys) this.m.delete(this.m.keys().next().value!);
    return true;
  }
  /** True when key already has max attempts in the window (does not record one). */
  blocked(key: string, now = Date.now()) {
    this.sweep(now);
    return (this.m.get(key) ?? []).filter((t) => now - t < this.windowMs).length >= this.max;
  }
  reset(key: string) { this.m.delete(key); }
  get size() { return this.m.size; }
  private sweep(now: number) {
    for (const [k, a] of this.m) {
      if (now - a[a.length - 1] < this.windowMs) break; // the rest were active more recently
      this.m.delete(k);
    }
  }
}

/** At most `limit` tasks in flight; tryRun returns null at once (no queue) when the gate is full. */
export class Gate {
  private n = 0;
  constructor(private limit = 2) {}
  get inFlight() { return this.n; }
  async tryRun<T>(f: () => Promise<T>): Promise<{ value: T } | null> {
    if (this.n >= this.limit) return null;
    this.n++;
    try { return { value: await f() }; } finally { this.n--; }
  }
}
