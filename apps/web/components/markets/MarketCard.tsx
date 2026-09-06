import type { Market } from "@verdictvaut/shared-types";
import Link from "next/link";
import { Card, CardBody } from "../ui/Card";
import { formatDateTime } from "../../lib/format";
import { MarketStatusBadge } from "./MarketStatusBadge";

export function MarketCard({ market }: { market: Market }) {
  return (
    <Link
      href={`/markets/${market.slug}`}
      className="block rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vault-gold"
    >
      <Card className="h-full transition-colors hover:border-white/20">
        <CardBody className="flex h-full flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <span className="text-xs font-medium uppercase tracking-wide text-white/40">{market.category.name}</span>
            <MarketStatusBadge status={market.status} />
          </div>
          <h3 className="line-clamp-2 font-display text-base font-semibold text-white">{market.title}</h3>
          <p className="line-clamp-2 flex-1 text-sm text-white/50">{market.description}</p>
          <div className="flex items-center justify-between border-t border-vault-border pt-3 text-xs text-white/40">
            <span>
              {market.outcomes.length} outcome{market.outcomes.length === 1 ? "" : "s"}
            </span>
            {market.closeTime && <span className="truncate pl-3">Closes {formatDateTime(market.closeTime)}</span>}
          </div>
        </CardBody>
      </Card>
    </Link>
  );
}
