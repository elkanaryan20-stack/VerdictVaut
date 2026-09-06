"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowDownToLine, LayoutDashboard, History, LogOut } from "lucide-react";
import { cn } from "../../lib/cn";
import { useAuth } from "../../lib/auth/auth-context";

const NAV_ITEMS = [
  { href: "/wallet", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/wallet/deposit", label: "Deposit", icon: ArrowDownToLine, exact: false },
  { href: "/wallet/deposits", label: "History", icon: History, exact: false },
];

function isActive(pathname: string, href: string, exact: boolean) {
  return exact ? pathname === href : pathname.startsWith(href);
}

function NavLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <>
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item.href, item.exact);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vault-gold",
              active ? "bg-vault-gold/10 text-vault-gold" : "text-white/70 hover:bg-white/5 hover:text-white",
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {item.label}
          </Link>
        );
      })}
    </>
  );
}

export function WalletSidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const router = useRouter();

  async function handleLogout() {
    await logout();
    router.replace("/login");
  }

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-vault-border bg-vault-surface/60 md:flex">
      <div className="flex h-16 items-center gap-2 border-b border-vault-border px-5">
        <span className="h-2 w-2 rounded-full bg-vault-gold" aria-hidden="true" />
        <span className="font-display text-sm font-semibold uppercase tracking-[0.2em] text-white">VerdictVaut</span>
      </div>
      <nav className="flex flex-1 flex-col gap-1 p-3" aria-label="Wallet navigation">
        <NavLinks pathname={pathname} />
      </nav>
      <div className="border-t border-vault-border p-3">
        {user && <p className="truncate px-3 pb-2 text-xs text-white/40">{user.email}</p>}
        <button
          type="button"
          onClick={handleLogout}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-white/60 transition-colors hover:bg-white/5 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vault-gold"
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
          Sign out
        </button>
      </div>
    </aside>
  );
}

export function WalletMobileNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Wallet navigation"
      className="fixed inset-x-0 bottom-0 z-30 flex border-t border-vault-border bg-vault-surface/95 backdrop-blur md:hidden"
    >
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item.href, item.exact);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-medium",
              "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-vault-gold",
              active ? "text-vault-gold" : "text-white/60",
            )}
          >
            <Icon className="h-5 w-5" aria-hidden="true" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
