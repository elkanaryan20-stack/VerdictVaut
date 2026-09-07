import Link from "next/link";
import { ArrowDownToLine, Briefcase, ReceiptText } from "lucide-react";
import { SecurityEventsList } from "../../components/account/SecurityEventsList";

const FINANCIAL_LINKS = [
  { href: "/wallet/deposits", label: "Deposit history", description: "Every deposit, its confirmations, and when it was credited.", icon: ArrowDownToLine },
  { href: "/portfolio", label: "Orders & fills", description: "Open orders, order history, and your trade-by-trade fills.", icon: ReceiptText },
  { href: "/portfolio", label: "Settlement history", description: "Payouts from resolved markets — open the Settlement tab.", icon: Briefcase },
];

export default function ActivityPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-xl font-semibold text-white sm:text-2xl">Activity</h1>
        <p className="mt-1 text-sm text-white/50">Your security events, plus quick links to your authoritative financial history.</p>
      </div>

      <section className="space-y-3">
        <h2 className="font-display text-xs font-semibold uppercase tracking-[0.2em] text-white/40">Financial history</h2>
        <p className="text-xs text-white/40">
          Deposits, orders, fills, and settlements are always shown from their own dedicated pages — never duplicated here — so
          what you see is always the backend&apos;s current, authoritative record.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {FINANCIAL_LINKS.map((link) => {
            const Icon = link.icon;
            return (
              <Link
                key={link.label}
                href={link.href}
                className="group rounded-xl border border-vault-border bg-vault-surface p-4 transition-colors hover:border-vault-gold/40 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vault-gold"
              >
                <Icon className="h-5 w-5 text-white/50 transition-colors group-hover:text-vault-gold" aria-hidden="true" />
                <p className="mt-2 text-sm font-medium text-white">{link.label}</p>
                <p className="mt-0.5 text-xs text-white/40">{link.description}</p>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xs font-semibold uppercase tracking-[0.2em] text-white/40">Security &amp; account</h2>
        <SecurityEventsList />
      </section>
    </div>
  );
}
