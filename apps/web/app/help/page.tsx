import Link from "next/link";
import { Card, CardBody, CardHeader, CardTitle } from "../../components/ui/Card";

const SECTIONS = [
  { id: "markets", label: "Markets & outcomes" },
  { id: "trading", label: "BUY, SELL & limit orders" },
  { id: "order-book", label: "The order book" },
  { id: "funds", label: "Available vs. reserved funds" },
  { id: "deposits", label: "Deposits & confirmations" },
  { id: "resolution", label: "Resolution & settlement" },
  { id: "risks", label: "Risk disclosures" },
];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <Card id={id} className="scroll-mt-20">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3 text-sm leading-relaxed text-white/70">{children}</CardBody>
    </Card>
  );
}

export default function HelpPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-xl font-semibold text-white sm:text-2xl">Help &amp; FAQ</h1>
        <p className="mt-1 text-sm text-white/50">How VerdictVaut&apos;s markets, orders, deposits, and settlement actually work.</p>
      </div>

      <nav aria-label="On this page" className="rounded-xl border border-vault-border bg-vault-surface p-4">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-white/40">On this page</p>
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="text-vault-gold hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vault-gold">
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <Section id="markets" title="Markets & outcomes">
        <p>
          A <strong className="text-white">market</strong> on VerdictVaut asks a specific, resolvable question (e.g. &quot;Will X happen by
          date Y?&quot;). Each market has two or more mutually exclusive <strong className="text-white">outcomes</strong> — exactly one of
          which is declared the winner when the market resolves.
        </p>
        <p>
          A market moves through a fixed lifecycle: <strong className="text-white">OPEN</strong> (trading allowed) →{" "}
          <strong className="text-white">CLOSED</strong> (trading has stopped, awaiting resolution) →{" "}
          <strong className="text-white">RESOLVING</strong> (a winner has been declared, payouts are being processed) →{" "}
          <strong className="text-white">RESOLVED</strong> (every position has been paid out). The UI never lets you place an order
          against a market that isn&apos;t OPEN.
        </p>
      </Section>

      <Section id="trading" title="BUY, SELL & limit orders">
        <p>
          Every order is either <strong className="text-white">BUY</strong> (you want to acquire quantity of an outcome) or{" "}
          <strong className="text-white">SELL</strong> (you want to dispose of quantity you hold, or take a short position in that
          outcome). VerdictVaut currently supports only <strong className="text-white">LIMIT</strong> orders — you name the price
          you&apos;re willing to trade at, and the order rests on the book until it matches an opposite order at that price or better,
          or you cancel it. There is no market-order type.
        </p>
        <p>An order can be fully filled, partially filled (some quantity executed, the rest still resting), cancelled, expired, or rejected.</p>
      </Section>

      <Section id="order-book" title="The order book">
        <p>
          Each outcome has its own order book: resting BUY orders (bids) and resting SELL orders (asks). When a new order&apos;s price
          crosses an existing resting order&apos;s price, they match and a <strong className="text-white">fill</strong> is executed at
          the resting order&apos;s price. Fills are the authoritative record of what actually traded — separate from, and never to be
          confused with, the order itself or your resulting position.
        </p>
      </Section>

      <Section id="funds" title="Available vs. reserved funds">
        <p>
          Placing a BUY order reserves the cash it could cost if fully filled; placing a SELL order (against a position you hold)
          reserves that quantity of shares. Reserved funds aren&apos;t spent yet — they&apos;re earmarked so you can&apos;t
          simultaneously commit the same funds to two different orders. Your{" "}
          <strong className="text-white">available balance</strong> is what&apos;s left to place new orders with;{" "}
          <strong className="text-white">reserved balance</strong> is what&apos;s currently backing your resting orders. Cancelling an
          order releases its reservation immediately.
        </p>
      </Section>

      <Section id="deposits" title="Deposits & confirmations">
        <p>
          Deposits are detected on-chain and must accumulate a required number of network confirmations before they&apos;re considered
          final. A deposit&apos;s status moves from <strong className="text-white">PENDING</strong> (detected, accumulating
          confirmations) to <strong className="text-white">CONFIRMED</strong> to <strong className="text-white">CREDITED</strong> (your
          balance actually reflects it) — or, rarely, <strong className="text-white">REJECTED</strong> if the chain later invalidates the
          transaction (e.g. a reorg) before it was credited.
        </p>
      </Section>

      <Section id="resolution" title="Resolution & settlement">
        <p>
          When a market&apos;s question is answered, a platform resolver declares the winning outcome — this is a manual,
          highly-restricted action, never automatic and never something an ordinary user can trigger. Every position in the winning
          outcome is then paid out at a fixed payout-per-share rate; positions in a losing outcome settle for a payout of exactly
          zero. Settlement can take some time to process every position — a market sits in RESOLVING until every position has been
          paid out, at which point it becomes RESOLVED. Your own settlement results (including zero-payout ones) are always shown
          exactly as the backend recorded them, on the Settlement tab of your Portfolio.
        </p>
      </Section>

      <Section id="risks" title="Risk disclosures">
        <p className="text-xs text-white/40">
          The following are product disclosures about how this platform works, not legal or financial advice, and not a statement
          that VerdictVaut is authorized to operate in any particular jurisdiction.
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-white">Trading risk.</strong> Prediction-market outcomes are not investments with a guaranteed
            return. A position can settle for less than you paid for it, including a full loss of the amount committed to that
            position.
          </li>
          <li>
            <strong className="text-white">Blockchain transaction risk.</strong> On-chain transactions are generally irreversible. A
            deposit sent to the wrong address, on the wrong network, or without a required destination tag may be unrecoverable.
          </li>
          <li>
            <strong className="text-white">Confirmation / reorg risk.</strong> A transaction with fewer confirmations than required
            can still be reversed by the underlying blockchain (a reorg). Funds are not credited to your balance until the required
            confirmation threshold is met.
          </li>
          <li>
            <strong className="text-white">Market-resolution risk.</strong> A market&apos;s outcome is determined by a resolver
            applying that market&apos;s stated resolution criteria — a real judgment call in ambiguous cases, not an automated
            calculation.
          </li>
          <li>
            <strong className="text-white">Settlement timing.</strong> Settlement of every position in a resolved market is not
            necessarily instantaneous; a market can remain in RESOLVING while payouts are still being processed.
          </li>
          <li>
            <strong className="text-white">Supported asset/network requirements.</strong> Only the specific assets and networks
            VerdictVaut lists as supported can be deposited safely. Sending an unsupported asset, or the right asset on the wrong
            network, risks loss of funds.
          </li>
        </ul>
      </Section>

      <p className="text-center text-xs text-white/30">
        Have a question this page didn&apos;t answer? Check your{" "}
        <Link href="/activity" className="text-vault-gold hover:underline">
          activity
        </Link>{" "}
        or{" "}
        <Link href="/portfolio" className="text-vault-gold hover:underline">
          portfolio
        </Link>{" "}
        for the authoritative record of your own account.
      </p>
    </div>
  );
}
