import { DepositDetail } from "../../../../components/wallet/DepositDetail";

export default async function DepositDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DepositDetail depositId={id} />;
}
