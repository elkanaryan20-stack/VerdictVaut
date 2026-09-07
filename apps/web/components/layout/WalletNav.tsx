"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Briefcase,
  CircleUserRound,
  HelpCircle,
  History,
  LayoutDashboard,
  LogIn,
  LogOut,
  ShieldAlert,
  TrendingUp,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { useAuth } from "../../lib/auth/auth-context";

/** Shown in both the desktop sidebar and the mobile bottom nav — kept to 5 so the mobile bar stays usable (see requirement #15). */
const PRIMARY_NAV_ITEMS = [
  { href: "/markets", label: "Markets", icon: TrendingUp, exact: false },
  { href: "/wallet", label: "Wallet", icon: LayoutDashboard, exact: true },
  { href: "/portfolio", label: "Portfolio", icon: Briefcase, exact: false },
  { href: "/activity", label: "Activity", icon: Activity, exact: false },
  { href: "/account", label: "Account", icon: CircleUserRound, exact: false },
];

/** Desktop sidebar only — still reachable on mobile via links on the Wallet/Account pages themselves, so nothing here is orphaned. */
const SECONDARY_NAV_ITEMS = [
  { href: "/wallet/deposit", label: "Deposit", icon: ArrowDownToLine, exact: false },
  { href: "/wallet/deposits", label: "Deposit history", icon: History, exact: false },
  // exact: true so viewing /wallet/withdrawals/* never lights up "Withdraw" too (both share the "/wallet/withdraw" prefix).
  { href: "/wallet/withdraw", label: "Withdraw", icon: ArrowUpFromLine, exact: true },
  { href: "/wallet/withdrawals", label: "Withdrawal history", icon: History, exact: false },
  { href: "/help", label: "Help & FAQ", icon: HelpCircle, exact: false },
];

export const ADMIN_NAV_ITEM = { href: "/admin", label: "Admin", icon: ShieldAlert, exact: false };

function isActive(pathname: string, href: string, exact: boolean) {
  return exact ? pathname === href : pathname.startsWith(href);
}

function NavLink({
  item,
  pathname,
  onNavigate,
  tone = "default",
}: {
  item: { href: string; label: string; icon: typeof TrendingUp; exact: boolean };
  pathname: string;
  onNavigate?: () => void;
  tone?: "default" | "admin";
}) {
  const active = isActive(pathname, item.href, item.exact);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vault-gold",
        active
          ? tone === "admin"
            ? "bg-amber-400/10 text-amber-300"
            : "bg-vault-gold/10 text-vault-gold"
          : tone === "admin"
            ? "text-amber-300/70 hover:bg-amber-400/5 hover:text-amber-300"
            : "text-white/70 hover:bg-white/5 hover:text-white",
      )}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      {item.label}
    </Link>
  );
}

function NavLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <>
      {PRIMARY_NAV_ITEMS.map((item) => (
        <NavLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />
      ))}
    </>
  );
}

export function WalletSidebar() {
  const pathname = usePathname();
  const { status, user, logout } = useAuth();
  const router = useRouter();
  const isPrivileged = user?.role === "ADMIN" || user?.role === "SUPER_ADMIN";

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
      <nav className="flex flex-1 flex-col gap-1 p-3" aria-label="Primary navigation">
        <NavLinks pathname={pathname} />
        <div className="my-2 border-t border-vault-border" />
        {SECONDARY_NAV_ITEMS.map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} />
        ))}
        {isPrivileged && (
          <>
            <div className="my-2 border-t border-vault-border" />
            <NavLink item={ADMIN_NAV_ITEM} pathname={pathname} tone="admin" />
          </>
        )}
      </nav>
      <div className="border-t border-vault-border p-3">
        {status === "authenticated" ? (
          <>
            {user && <p className="truncate px-3 pb-2 text-xs text-white/40">{user.email}</p>}
            <button
              type="button"
              onClick={handleLogout}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-white/60 transition-colors hover:bg-white/5 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vault-gold"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              Sign out
            </button>
          </>
        ) : (
          <Link
            href="/login"
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-white/60 transition-colors hover:bg-white/5 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vault-gold"
          >
            <LogIn className="h-4 w-4" aria-hidden="true" />
            Log in
          </Link>
        )}
      </div>
    </aside>
  );
}

/**
 * Deliberately always exactly PRIMARY_NAV_ITEMS (5), even for an
 * ADMIN/SUPER_ADMIN — the whole point of capping this list at 5 (see
 * PRIMARY_NAV_ITEMS's docblock) is defeated if a 6th item gets appended
 * for some users. Admins reach /admin via the desktop sidebar's separate
 * admin section, or the "Admin" quick-link card on /account on mobile —
 * never by growing this bar.
 */
export function WalletMobileNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary navigation"
      className="fixed inset-x-0 bottom-0 z-30 flex border-t border-vault-border bg-vault-surface/95 backdrop-blur md:hidden"
    >
      {PRIMARY_NAV_ITEMS.map((item) => {
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
