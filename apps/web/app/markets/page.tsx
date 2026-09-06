import { MarketList } from "../../components/markets/MarketList";

export default function MarketsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-xl font-semibold text-white sm:text-2xl">Markets</h1>
        <p className="mt-1 text-sm text-white/50">Browse live prediction markets.</p>
      </div>
      <MarketList />
    </div>
  );
}
