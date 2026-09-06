import { WalletMobileNav, WalletSidebar } from "../../components/layout/WalletNav";

// Deliberately NOT wrapped in AuthGuard — market browsing is public (see
// MarketsController: GET /markets and GET /markets/:slug require no
// auth). Trading itself still requires a session; OrderTicket enforces
// that on its own (see its "log in to place an order" state).
export default function MarketsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <WalletSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 pb-20 sm:px-6 md:pb-6">{children}</main>
      </div>
      <WalletMobileNav />
    </div>
  );
}
