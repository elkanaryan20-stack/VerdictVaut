import type { MarketStatus } from "@verdictvaut/shared-types";
import { CheckCircle2, Hourglass, Lock, PauseCircle, TrendingUp, XCircle } from "lucide-react";
import { Badge, BadgeTone } from "../ui/Badge";
import { MARKET_STATUS_LABEL } from "../../lib/trading/order-status";

const TONE: Record<MarketStatus, BadgeTone> = {
  DRAFT: "neutral",
  OPEN: "up",
  PAUSED: "neutral",
  CLOSED: "neutral",
  RESOLVING: "info",
  RESOLVED: "gold",
  CANCELLED: "down",
};

const ICON: Record<MarketStatus, typeof TrendingUp> = {
  DRAFT: PauseCircle,
  OPEN: TrendingUp,
  PAUSED: PauseCircle,
  CLOSED: Lock,
  RESOLVING: Hourglass,
  RESOLVED: CheckCircle2,
  CANCELLED: XCircle,
};

export function MarketStatusBadge({ status }: { status: MarketStatus }) {
  const Icon = ICON[status];
  return (
    <Badge tone={TONE[status]}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {MARKET_STATUS_LABEL[status]}
    </Badge>
  );
}
