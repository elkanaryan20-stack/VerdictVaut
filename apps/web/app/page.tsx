export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6">
      <div className="flex items-center gap-3">
        <span className="h-2 w-2 rounded-full bg-vault-gold" />
        <span className="font-display text-sm uppercase tracking-[0.3em] text-vault-gold">
          VerdictVaut
        </span>
      </div>

      <h1 className="mt-6 max-w-2xl text-center font-display text-4xl font-semibold tracking-tight text-white sm:text-5xl">
        Premium global markets, built on a real ledger.
      </h1>

      <p className="mt-4 max-w-xl text-center text-sm text-white/60 sm:text-base">
        This is the foundation build — authentication, ledger, wallet, and admin
        scaffolding are in place. The markets discovery and trading UI ship next.
      </p>

      <div className="mt-10 rounded-lg border border-vault-border bg-vault-surface px-4 py-3 text-xs text-white/40">
        Sandbox environment — balances and transactions shown anywhere in this app
        will only ever reflect real ledger and testnet activity, never simulated data.
      </div>
    </main>
  );
}
