// Loads each provider independently (PLAN.md §3.7, §5.9). A slow provider never holds back
// the others, a request that runs past the deadline counts as failed, and answers that a
// newer request or a reset replaced are dropped. Pure: no DOM or `hass` access.

export type LoaderHooks<T> = {
  /** The answer to the current request for a key. */
  result(key: string, value: T): void;
  /** The current request for a key failed, or ran past the deadline (`"timeout"`). */
  error(key: string, reason: unknown): void;
  /** A key settled: it answered, failed, timed out or was skipped. */
  settled(key: string): void;
  /** A key was asked for while a request for it was running; load it once more now. */
  again(key: string): void;
};

export class Loader<T> {
  private gen = 0;
  /** Id of the newest request per key; only its answer is used. */
  private seq = new Map<string, number>();
  /**
   * The request running per key, until it answers or times out. It survives a reset, so a
   * new view queues behind it instead of sending a second request to the same source.
   */
  private running = new Map<string, number>();
  private queued = new Set<string>();
  /** Keys asked for since the last reset that haven't answered (a timeout doesn't count). */
  private waiting = new Set<string>();
  private done = new Set<string>();

  constructor(
    private readonly hooks: LoaderHooks<T>,
    private readonly timeoutMs: number,
  ) {}

  /** Starts over: answers to requests made before this point are ignored. */
  reset(): void {
    this.gen++;
    this.waiting.clear();
    this.done.clear();
  }

  /** True while a key asked for since the last reset hasn't answered, even after a timeout. */
  get pending(): boolean {
    return this.waiting.size > 0;
  }

  /** True once every key has settled since the last reset. */
  settledAll(keys: Iterable<string>): boolean {
    for (const key of keys) if (!this.done.has(key)) return false;
    return true;
  }

  /** Settles a key without loading it (an inactive provider) and drops its running request. */
  skip(key: string): void {
    this.seq.set(key, (this.seq.get(key) ?? 0) + 1);
    this.queued.delete(key);
    this.waiting.delete(key);
    this.done.add(key);
    this.hooks.settled(key);
  }

  /**
   * Loads a key. While a request for it runs, this only marks the key to load once more when
   * that request answers or times out, so a source never gets two requests at once.
   */
  load(key: string, run: () => Promise<T>): void {
    this.waiting.add(key);
    if (this.running.has(key)) {
      this.queued.add(key);
      return;
    }
    this.queued.delete(key);
    const gen = this.gen;
    const id = (this.seq.get(key) ?? 0) + 1;
    this.seq.set(key, id);
    this.running.set(key, id);
    const current = () => gen === this.gen && id === this.seq.get(key);
    const settle = () => {
      this.done.add(key);
      this.hooks.settled(key);
    };
    /** Frees the source for the next request; returns whether this request held it. */
    const release = () => {
      if (this.running.get(key) !== id) return false;
      this.running.delete(key);
      return true;
    };

    // A timed-out request may still answer; its answer is used while nothing replaced it.
    const timer = setTimeout(() => {
      if (!release()) return;
      if (current()) {
        this.hooks.error(key, "timeout");
        settle();
      }
      if (this.queued.delete(key)) this.hooks.again(key);
    }, this.timeoutMs);

    void (async () => {
      let ok = false;
      let value: T | undefined;
      let reason: unknown;
      try {
        value = await run();
        ok = true;
      } catch (err) {
        reason = err;
      }
      clearTimeout(timer);
      const held = release();
      try {
        if (current()) {
          this.waiting.delete(key);
          if (ok) this.hooks.result(key, value as T);
          else this.hooks.error(key, reason);
          settle();
        }
      } finally {
        if (held && this.queued.delete(key)) this.hooks.again(key);
      }
    })();
  }
}
