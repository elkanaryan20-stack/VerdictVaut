import { Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "./prisma/prisma.service";
import { MetricsService } from "./observability/metrics.service";
import { DepositChainAdapterFactory } from "./wallet/chain-adapters/deposit-chain-adapter.factory";
import { ConfirmationPolicyService } from "./wallet/confirmation/confirmation-policy.service";
import { DepositsService } from "./wallet/deposits/deposits.service";
import { DepositWatcherService } from "./wallet/watchers/deposit-watcher.service";
import { CustodyProviderFactory } from "./wallet/custody/custody-provider.factory";
import { WithdrawalExecutorFactory } from "./wallet/executors/withdrawal-executor.factory";
import { WithdrawalsService } from "./wallet/withdrawals/withdrawals.service";
import { WithdrawalWatcherService } from "./wallet/watchers/withdrawal-watcher.service";

/**
 * Phase 16 fix for review finding M1 — proves the exact chain main.ts's
 * `app.enableShutdownHooks()` now relies on: a real Nest application
 * context, with the real DepositWatcherService/WithdrawalWatcherService
 * classes registered as providers (dependencies mocked — this is not a
 * DB/network integration test), actually invokes their onModuleDestroy
 * when a shutdown signal is received. This is the specific claim that
 * was FALSE before the fix (main.ts never called enableShutdownHooks,
 * so onModuleDestroy never ran for this process) and could not be
 * caught by DepositWatcherService.spec.ts/WithdrawalWatcherService.spec.ts
 * alone, since those call onModuleDestroy() directly rather than through
 * Nest's own signal-driven lifecycle.
 *
 * Safety note on how this triggers the signal: Nest's own shutdown-hook
 * implementation (see @nestjs/core's NestApplicationContext.
 * listenToShutdownSignals) ends its cleanup handler with a REAL
 * `process.kill(process.pid, signal)` call, re-delivering the signal to
 * this process's default OS handler once Nest's own listener has
 * unsubscribed — which would actually terminate the Jest worker if left
 * unmocked. `process.kill` is mocked for the duration of this test so
 * that real signal delivery never happens; `process.emit(signal)` (pure
 * in-process EventEmitter dispatch, never touching the OS) is what
 * actually invokes Nest's registered listener, exactly mirroring what a
 * real SIGTERM would do to the registered handler without this test
 * being able to kill its own process.
 */
describe("app.enableShutdownHooks() triggers the watcher graceful-shutdown lifecycle", () => {
  let processKillSpy: jest.SpyInstance;

  beforeEach(() => {
    // Prevents Nest's own shutdown-hook cleanup from ever issuing a real
    // OS-level kill against this test process — see docblock above.
    processKillSpy = jest.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    processKillSpy.mockRestore();
  });

  it("calls DepositWatcherService.onModuleDestroy and WithdrawalWatcherService.onModuleDestroy on SIGTERM", async () => {
    @Module({
      providers: [
        { provide: PrismaService, useValue: {} },
        { provide: DepositChainAdapterFactory, useValue: {} },
        { provide: ConfirmationPolicyService, useValue: {} },
        { provide: DepositsService, useValue: {} },
        { provide: CustodyProviderFactory, useValue: {} },
        { provide: WithdrawalExecutorFactory, useValue: {} },
        { provide: WithdrawalsService, useValue: {} },
        { provide: MetricsService, useValue: { increment: jest.fn(), gauge: jest.fn(), timing: jest.fn() } },
        // enabled: false — neither watcher starts a real polling timer;
        // this test proves onModuleDestroy fires regardless (a distinct
        // lifecycle hook from onModuleInit), not that a real poll was
        // gracefully interrupted (already covered by each service's own
        // spec).
        { provide: ConfigService, useValue: { get: () => ({ enabled: false, pollIntervalMs: 30000 }) } },
        DepositWatcherService,
        WithdrawalWatcherService,
      ],
    })
    class ShutdownHooksTestModule {}

    const moduleRef = await Test.createTestingModule({ imports: [ShutdownHooksTestModule] }).compile();
    await moduleRef.init();

    const depositWatcher = moduleRef.get(DepositWatcherService);
    const withdrawalWatcher = moduleRef.get(WithdrawalWatcherService);
    const depositDestroySpy = jest.spyOn(depositWatcher, "onModuleDestroy");
    const withdrawalDestroySpy = jest.spyOn(withdrawalWatcher, "onModuleDestroy");

    const sigtermListenersBefore = process.listenerCount("SIGTERM");

    // The exact call main.ts now makes.
    moduleRef.enableShutdownHooks();
    expect(process.listenerCount("SIGTERM")).toBeGreaterThan(sigtermListenersBefore);

    expect(depositDestroySpy).not.toHaveBeenCalled();
    expect(withdrawalDestroySpy).not.toHaveBeenCalled();

    // Pure in-process event dispatch — see docblock. This is what a real
    // SIGTERM delivery invokes on the listener Nest just registered.
    // Node itself always passes the signal name as the listener's first
    // argument on a real delivery (see the Node docs for 'process' signal
    // events) — passed explicitly here since .emit() doesn't infer it.
    process.emit("SIGTERM" as NodeJS.Signals, "SIGTERM" as NodeJS.Signals);

    // Nest's cleanup handler is async; give its promise chain a tick to
    // run (it calls callDestroyHook() before the mocked process.kill).
    await new Promise((resolve) => setImmediate(resolve));

    expect(depositDestroySpy).toHaveBeenCalledTimes(1);
    expect(withdrawalDestroySpy).toHaveBeenCalledTimes(1);
    // Confirms Nest's handler ran to completion (reached its own
    // process.kill re-delivery) rather than throwing partway through.
    expect(processKillSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
    // Nest's own cleanup handler unsubscribes all of its shutdown-signal
    // listeners (not just SIGTERM's) as part of running to completion —
    // confirms this test leaves no global process-level listener behind
    // for later, unrelated test files in the same Jest worker to trip
    // over.
    expect(process.listenerCount("SIGTERM")).toBe(sigtermListenersBefore);
  });
});
