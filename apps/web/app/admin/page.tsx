import { AdminDepositsTable } from "../../components/admin/AdminDepositsTable";
import { AdminWithdrawalsTable } from "../../components/admin/AdminWithdrawalsTable";
import { AuditLogFeed } from "../../components/admin/AuditLogFeed";
import { MarketsNeedingAttention } from "../../components/admin/MarketsNeedingAttention";
import { OperationsStatus } from "../../components/admin/OperationsStatus";

export default function AdminPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-xl font-semibold text-white sm:text-2xl">Restricted operations</h1>
        <p className="mt-1 text-sm text-white/50">
          Read-only platform status. Sensitive actions remain SUPER_ADMIN-only and are always enforced by the backend, never by
          this page.
        </p>
      </div>

      <MarketsNeedingAttention />
      <AdminWithdrawalsTable />
      <OperationsStatus />
      <AdminDepositsTable />
      <AuditLogFeed />
    </div>
  );
}
