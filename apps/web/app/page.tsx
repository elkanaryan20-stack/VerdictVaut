import Link from "next/link";

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

      <div className="mt-8 flex items-center gap-3">
        <Link
          href="/wallet"
          className="rounded-md bg-vault-gold px-5 py-2.5 text-sm font-medium text-black transition-colors hover:bg-vault-gold/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vault-gold"
        >
          Go to wallet
        </Link>
        <Link
          href="/login"
          className="rounded-md border border-vault-border px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/40"
        >
          Sign in
        </Link>
      </div>

      <div className="mt-10 rounded-lg border border-vault-border bg-vault-surface px-4 py-3 text-xs text-white/40">
        Sandbox environment — balances and transactions shown anywhere in this app
        will only ever reflect real ledger and testnet activity, never simulated data.
      </div>
    </main>
  );
}
