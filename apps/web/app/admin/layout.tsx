import { AuthGuard } from "../../components/layout/AuthGuard";
import { WalletMobileNav, WalletSidebar } from "../../components/layout/WalletNav";

// SUPER_ADMIN-only mutations still enforce their own role server-side
// (RolesGuard) regardless of this gate — see AuthGuard's docblock. This
// `allow` only controls whether an ADMIN/SUPER_ADMIN sees the page shell
// at all instead of a guaranteed wall of 403s.
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard allow={["ADMIN", "SUPER_ADMIN"]}>
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
