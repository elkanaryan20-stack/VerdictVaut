import type { OrderStatus } from "@verdictvaut/shared-types";
import { CheckCircle2, Clock, Hourglass, TimerOff, XCircle } from "lucide-react";
import { Badge, BadgeTone } from "../ui/Badge";
import { ORDER_STATUS_LABEL } from "../../lib/trading/order-status";

const TONE: Record<OrderStatus, BadgeTone> = {
  OPEN: "info",
  PARTIALLY_FILLED: "gold",
  FILLED: "up",
  CANCELLED: "neutral",
  EXPIRED: "neutral",
  REJECTED: "down",
};

const ICON: Record<OrderStatus, typeof Clock> = {
  OPEN: Clock,
  PARTIALLY_FILLED: Hourglass,
  FILLED: CheckCircle2,
  CANCELLED: XCircle,
  EXPIRED: TimerOff,
  REJECTED: XCircle,
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const Icon = ICON[status];
  return (
    <Badge tone={TONE[status]}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {ORDER_STATUS_LABEL[status]}
    </Badge>
  );
}
