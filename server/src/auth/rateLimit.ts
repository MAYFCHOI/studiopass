export class LoginLimiter {
  private m = new Map<string, number[]>();
  constructor(private max = 5, private windowMs = 600000) {}
  hit(key: string, now = Date.now()) { const a = (this.m.get(key) ?? []).filter((t) => now - t < this.windowMs); if (a.length >= this.max) { this.m.set(key, a); return false; } a.push(now); this.m.set(key, a); return true; }
  reset(key: string) { this.m.delete(key); }
}
