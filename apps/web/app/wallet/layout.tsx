import { AuthGuard } from "../../components/layout/AuthGuard";
import { WalletMobileNav, WalletSidebar } from "../../components/layout/WalletNav";

export default function WalletLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <div className="flex min-h-screen">
        <WalletSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 pb-20 sm:px-6 md:pb-6">{children}</main>
        </div>
        <WalletMobileNav />
      </div>
    </AuthGuard>
  );
}
