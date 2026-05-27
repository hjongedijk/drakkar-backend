export class LocalTtlCache<T> {
  private readonly values = new Map<string, { value: T; expiresAt: number }>();

  get(key: string) {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number) {
    this.values.set(key, {
      value,
      expiresAt: Date.now() + Math.max(1, ttlMs)
    });
    return value;
  }

  delete(key: string) {
    this.values.delete(key);
  }

  clear() {
    this.values.clear();
  }
}
