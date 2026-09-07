import { WithdrawalDetail } from "../../../../components/wallet/WithdrawalDetail";

export default async function WithdrawalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WithdrawalDetail withdrawalId={id} />;
}
