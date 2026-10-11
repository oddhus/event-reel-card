import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Loader } from "../src/core/loader";

/** A promise resolved or rejected from the test. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const never = () => new Promise<string>(() => undefined);

/** Lets pending promise callbacks run. */
const flush = () => vi.advanceTimersByTimeAsync(0);

const TIMEOUT = 20_000;

function setup() {
  const log: string[] = [];
  const loader = new Loader<string>(
    {
      result: (key, value) => log.push(`result ${key}=${value}`),
      error: (key, reason) => log.push(`error ${key}=${String(reason)}`),
      settled: (key) => log.push(`settled ${key}`),
      again: (key) => log.push(`again ${key}`),
    },
    TIMEOUT,
  );
  return { loader, log };
}

describe("Loader", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("delivers each answer as it arrives, without waiting for a slower key", async () => {
    const { loader, log } = setup();
    const entity = deferred<string>();
    const frigate = deferred<string>();
    loader.load("entity", () => entity.promise);
    loader.load("frigate", () => frigate.promise);

    entity.resolve("doors");
    await flush();
    expect(log).toEqual(["result entity=doors", "settled entity"]);
    expect(loader.settledAll(["entity", "frigate"])).toBe(false);
    expect(loader.pending).toBe(true);

    frigate.resolve("reviews");
    await flush();
    expect(log.slice(2)).toEqual(["result frigate=reviews", "settled frigate"]);
    expect(loader.settledAll(["entity", "frigate"])).toBe(true);
    expect(loader.pending).toBe(false);
  });

  it("settles a key that doesn't answer in time, but keeps it pending", async () => {
    const { loader, log } = setup();
    loader.load("frigate", never);

    await vi.advanceTimersByTimeAsync(TIMEOUT - 1);
    expect(log).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(log).toEqual(["error frigate=timeout", "settled frigate"]);
    expect(loader.settledAll(["frigate"])).toBe(true);
    expect(loader.pending).toBe(true); // a late answer may still come
  });

  it("still uses a late answer when no newer request replaced it", async () => {
    const { loader, log } = setup();
    const slow = deferred<string>();
    loader.load("frigate", () => slow.promise);
    await vi.advanceTimersByTimeAsync(TIMEOUT);

    slow.resolve("late reviews");
    await flush();
    expect(log).toEqual([
      "error frigate=timeout",
      "settled frigate",
      "result frigate=late reviews",
      "settled frigate",
    ]);
    expect(loader.pending).toBe(false);
  });

  it("drops a late answer once a newer request for the key has started", async () => {
    const { loader, log } = setup();
    const first = deferred<string>();
    const second = deferred<string>();
    loader.load("frigate", () => first.promise);
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    loader.load("frigate", () => second.promise);

    first.resolve("old");
    await flush();
    second.resolve("new");
    await flush();
    expect(log).toEqual([
      "error frigate=timeout",
      "settled frigate",
      "result frigate=new",
      "settled frigate",
    ]);
  });

  it("drops a failure from a request that a newer one replaced", async () => {
    const { loader, log } = setup();
    const first = deferred<string>();
    loader.load("llmvision", () => first.promise);
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    loader.load("llmvision", () => Promise.resolve("fresh"));
    await flush();

    first.reject(new Error("old request failed"));
    await flush();
    expect(log).toEqual([
      "error llmvision=timeout",
      "settled llmvision",
      "result llmvision=fresh",
      "settled llmvision",
    ]);
  });

  it("drops answers to requests made before a reset", async () => {
    const { loader, log } = setup();
    const before = deferred<string>();
    loader.load("frigate", () => before.promise);
    loader.reset();
    expect(loader.pending).toBe(false);
    expect(loader.settledAll(["frigate"])).toBe(false);

    before.resolve("from the old view");
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    expect(log).toEqual([]);
  });

  it("queues a new view's request behind one still running for the same key", async () => {
    const { loader, log } = setup();
    const old = deferred<string>();
    const run = vi.fn(() => old.promise);
    loader.load("entity", run);
    loader.reset();
    loader.load("entity", () => Promise.resolve("new day"));
    expect(run).toHaveBeenCalledTimes(1);
    expect(loader.pending).toBe(true);

    old.resolve("old day");
    await flush();
    expect(log).toEqual(["again entity"]);
  });

  it("frees the key when a request from before a reset times out", async () => {
    const { loader, log } = setup();
    loader.load("frigate", never);
    loader.reset();
    loader.load("frigate", never);

    await vi.advanceTimersByTimeAsync(TIMEOUT);
    expect(log).toEqual(["again frigate"]);
  });

  it("runs one request per key and loads it once more when asked again meanwhile", async () => {
    const { loader, log } = setup();
    const running = deferred<string>();
    const run = vi.fn(() => running.promise);
    loader.load("llmvision", run);
    loader.load("llmvision", run);
    loader.load("llmvision", run);
    expect(run).toHaveBeenCalledTimes(1);

    running.resolve("events");
    await flush();
    expect(log).toEqual(["result llmvision=events", "settled llmvision", "again llmvision"]);
  });

  it("loads a key asked for meanwhile once its running request times out", async () => {
    const { loader, log } = setup();
    loader.load("frigate", never);
    loader.load("frigate", never);

    await vi.advanceTimersByTimeAsync(TIMEOUT);
    expect(log).toEqual(["error frigate=timeout", "settled frigate", "again frigate"]);
  });

  it("reports a failed request and settles it", async () => {
    const { loader, log } = setup();
    loader.load("llmvision", () => Promise.reject(new Error("service missing")));
    await flush();
    expect(log).toEqual(["error llmvision=Error: service missing", "settled llmvision"]);
    expect(loader.settledAll(["llmvision"])).toBe(true);
    expect(loader.pending).toBe(false);
  });

  it("settles a skipped key at once and drops its running request", async () => {
    const { loader, log } = setup();
    const running = deferred<string>();
    loader.load("frigate", () => running.promise);
    loader.skip("frigate");
    expect(log).toEqual(["settled frigate"]);
    expect(loader.pending).toBe(false);

    running.resolve("reviews of a disabled provider");
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    expect(log).toEqual(["settled frigate"]);
  });
});
