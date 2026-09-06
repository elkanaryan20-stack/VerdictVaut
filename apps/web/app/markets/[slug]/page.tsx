import { MarketDetail } from "../../../components/markets/MarketDetail";

export default async function MarketDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <MarketDetail slug={slug} />;
}
