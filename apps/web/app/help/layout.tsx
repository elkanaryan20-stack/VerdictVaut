import { WalletMobileNav, WalletSidebar } from "../../components/layout/WalletNav";

// Deliberately NOT wrapped in AuthGuard — same reasoning as /markets:
// help/FAQ and risk-disclosure content is educational, not account data,
// so a logged-out visitor should be able to read it too.
export default function HelpLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <WalletSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 pb-20 sm:px-6 md:pb-6">{children}</main>
      </div>
      <WalletMobileNav />
    </div>
  );
}
