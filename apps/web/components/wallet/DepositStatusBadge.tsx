import type { DepositStatus } from "@verdictvaut/shared-types";
import { CheckCircle2, Clock, XCircle, AlertTriangle } from "lucide-react";
import { Badge, BadgeTone } from "../ui/Badge";
import { DEPOSIT_STATUS_LABEL } from "../../lib/wallet/deposit-status";

const TONE: Record<DepositStatus, BadgeTone> = {
  PENDING: "info",
  CONFIRMED: "gold",
  CREDITED: "up",
  REJECTED: "down",
  FAILED: "down",
};

const ICON: Record<DepositStatus, typeof Clock> = {
  PENDING: Clock,
  CONFIRMED: Clock,
  CREDITED: CheckCircle2,
  REJECTED: XCircle,
  FAILED: AlertTriangle,
};

export function DepositStatusBadge({ status }: { status: DepositStatus }) {
  const Icon = ICON[status];
  return (
    <Badge tone={TONE[status]}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {DEPOSIT_STATUS_LABEL[status]}
    </Badge>
  );
}
