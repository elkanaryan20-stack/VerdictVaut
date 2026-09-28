import * as os from "os";
import { Worker } from "worker_threads";

/**
 * Phase 38 — bcrypt off the event loop.
 *
 * bcryptjs is pure JavaScript: at the production cost factor (12) one
 * hash/compare is ~1s of CPU, and its "async" API only chops that work into
 * chunks on the SAME thread. Measured through the real API
 * (test/perf/api-http.perf-spec.ts): while 4 logins ran, unrelated
 * `GET /markets` p95 went from 11ms to 600ms and throughput from 556/s to
 * 18/s — so a small login burst (or unauthenticated login attempts spread
 * across a few IPs, each within its own rate limit) stalled every request
 * on the replica.
 *
 * Same library, same cost factor, same `$2a$`/`$2b$` hash format — only the
 * thread changes: the synchronous bcryptjs calls run in a small pool of
 * worker threads, so the main event loop keeps serving other requests.
 * No new dependency (worker_threads is built in).
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("worker_threads");
const bcrypt = require(workerData.bcryptPath);
parentPort.on("message", (task) => {
  try {
    const result = task.op === "hash" ? bcrypt.hashSync(task.password, task.arg) : bcrypt.compareSync(task.password, task.arg);
    parentPort.postMessage({ id: task.id, result });
  } catch (error) {
    parentPort.postMessage({ id: task.id, error: String((error && error.message) || error) });
  }
});
`;

type Op = "hash" | "compare";
interface Task {
  id: number;
  op: Op;
  password: string;
  arg: number | string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}
interface PoolWorker {
  worker: Worker;
  task: Task | null;
}

class BcryptWorkerPool {
  private readonly workers: PoolWorker[] = [];
  private readonly queue: Task[] = [];
  private nextId = 1;
  private readonly bcryptPath = require.resolve("bcryptjs");

  constructor(private readonly size: number) {}

  run(op: Op, password: string, arg: number | string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, op, password, arg, resolve, reject });
      this.dispatch();
    });
  }

  private dispatch(): void {
    while (this.queue.length > 0) {
      const idle = this.workers.find((w) => w.task === null) ?? (this.workers.length < this.size ? this.spawn() : null);
      if (!idle) return;
      const task = this.queue.shift()!;
      idle.task = task;
      idle.worker.ref(); // keep the process alive only while work is in flight
      idle.worker.postMessage({ id: task.id, op: task.op, password: task.password, arg: task.arg });
    }
  }

  private spawn(): PoolWorker {
    const entry: PoolWorker = { worker: new Worker(WORKER_SOURCE, { eval: true, workerData: { bcryptPath: this.bcryptPath } }), task: null };
    entry.worker.unref();
    entry.worker.on("message", (msg: { id: number; result?: unknown; error?: string }) => {
      const task = entry.task;
      if (!task || task.id !== msg.id) return;
      entry.task = null;
      entry.worker.unref();
      if (msg.error !== undefined) task.reject(new Error(msg.error));
      else task.resolve(msg.result);
      this.dispatch();
    });
    const fail = (error: Error) => {
      // A crashed worker fails only its own in-flight task and is replaced.
      const index = this.workers.indexOf(entry);
      if (index >= 0) this.workers.splice(index, 1);
      entry.task?.reject(error);
      entry.task = null;
      this.dispatch();
    };
    entry.worker.on("error", fail);
    entry.worker.on("exit", (code) => {
      if (this.workers.includes(entry)) fail(new Error(`bcrypt worker exited with code ${code}`));
    });
    this.workers.push(entry);
    return entry;
  }
}

// One thread per spare core, capped: enough to keep logins moving without
// oversubscribing a small container. At least 1 (a single-vCPU task still
// gains a responsive main loop, since the OS time-slices the threads).
const POOL_SIZE = Math.max(1, Math.min(4, (os.availableParallelism?.() ?? os.cpus().length) - 1));
const pool = new BcryptWorkerPool(POOL_SIZE);

export function hashPassword(password: string, rounds: number): Promise<string> {
  return pool.run("hash", password, rounds) as Promise<string>;
}

export function comparePassword(password: string, hash: string): Promise<boolean> {
  return pool.run("compare", password, hash) as Promise<boolean>;
}
