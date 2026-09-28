import { KeyedSerialQueue } from "./keyed-serial-queue";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("KeyedSerialQueue (Phase 38)", () => {
  it("runs tasks for the SAME key strictly one at a time, in submission order", async () => {
    const queue = new KeyedSerialQueue();
    const events: string[] = [];
    const gate = deferred();

    const a = queue.run("m1", async () => {
      events.push("a:start");
      await gate.promise;
      events.push("a:end");
    });
    const b = queue.run("m1", async () => {
      events.push("b:start");
    });

    await new Promise((r) => setImmediate(r));
    expect(events).toEqual(["a:start"]); // b waits for a
    gate.resolve();
    await Promise.all([a, b]);
    expect(events).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("never blocks a DIFFERENT key (a hot market cannot stall an unrelated one)", async () => {
    const queue = new KeyedSerialQueue();
    const gate = deferred();
    const slow = queue.run("hot", () => gate.promise);

    let otherRan = false;
    await queue.run("other", async () => {
      otherRan = true;
    });
    expect(otherRan).toBe(true);

    gate.resolve();
    await slow;
  });

  it("a failed task propagates its error to its own caller but never wedges the key", async () => {
    const queue = new KeyedSerialQueue();
    await expect(queue.run("m1", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(queue.run("m1", async () => "next")).resolves.toBe("next");
  });

  it("holds no state for a key once its work has settled (no growth with market count)", async () => {
    const queue = new KeyedSerialQueue();
    await Promise.all(Array.from({ length: 50 }, (_, i) => queue.run(`m${i}`, async () => i)));
    await new Promise((r) => setImmediate(r));
    expect(queue.activeKeys).toBe(0);
  });
});
