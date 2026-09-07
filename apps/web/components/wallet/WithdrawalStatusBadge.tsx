import type { WithdrawalStatus } from "@verdictvaut/shared-types";
import { AlertTriangle, CheckCircle2, Clock, Hourglass, Send, XCircle } from "lucide-react";
import { Badge, BadgeTone } from "../ui/Badge";
import { WITHDRAWAL_STATUS_LABEL } from "../../lib/wallet/withdrawal-status";

const TONE: Record<WithdrawalStatus, BadgeTone> = {
  REQUESTED: "info",
  VALIDATED: "info",
  RISK_REVIEW: "info",
  APPROVED: "gold",
  PENDING_MANUAL_BROADCAST: "gold",
  BROADCASTING: "gold",
  BROADCAST: "gold",
  CONFIRMING: "gold",
  CONFIRMED: "gold",
  CREDITED: "up",
  REJECTED: "down",
  FAILED: "down",
  CANCELLED: "neutral",
};

const ICON: Record<WithdrawalStatus, typeof Clock> = {
  REQUESTED: Clock,
  VALIDATED: Clock,
  RISK_REVIEW: Hourglass,
  APPROVED: Hourglass,
  PENDING_MANUAL_BROADCAST: Hourglass,
  BROADCASTING: Send,
  BROADCAST: Send,
  CONFIRMING: Clock,
  CONFIRMED: CheckCircle2,
  CREDITED: CheckCircle2,
  REJECTED: XCircle,
  FAILED: AlertTriangle,
  CANCELLED: XCircle,
};

export function WithdrawalStatusBadge({ status }: { status: WithdrawalStatus }) {
  const Icon = ICON[status];
  return (
    <Badge tone={TONE[status]}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {WITHDRAWAL_STATUS_LABEL[status]}
    </Badge>
  );
}
