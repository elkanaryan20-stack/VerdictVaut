"use client";

import Link from "next/link";
import { Activity, HelpCircle, Settings as SettingsIcon } from "lucide-react";
import { ADMIN_NAV_ITEM } from "../../components/layout/WalletNav";
import { ProfileSummary } from "../../components/account/ProfileSummary";
import { Card } from "../../components/ui/Card";
import { Skeleton } from "../../components/ui/Skeleton";
import { useAuth } from "../../lib/auth/auth-context";

const QUICK_LINKS = [
  { href: "/settings", label: "Settings", description: "Password, sessions, and preferences.", icon: SettingsIcon },
  { href: "/activity", label: "Activity", description: "Security events and links to your financial history.", icon: Activity },
  { href: "/help", label: "Help & FAQ", description: "How markets, orders, and settlement work.", icon: HelpCircle },
];

export default function AccountPage() {
  const { user } = useAuth();
  const isPrivileged = user?.role === "ADMIN" || user?.role === "SUPER_ADMIN";
  // The mobile bottom nav deliberately never grows past 5 items (see
  // WalletMobileNav) — this is how an admin reaches /admin on mobile
  // instead, without cramping the primary nav for everyone else.
  const quickLinks = isPrivileged
    ? [...QUICK_LINKS, { href: ADMIN_NAV_ITEM.href, label: ADMIN_NAV_ITEM.label, description: "Restricted operations dashboard.", icon: ADMIN_NAV_ITEM.icon }]
    : QUICK_LINKS;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-xl font-semibold text-white sm:text-2xl">Account</h1>
        <p className="mt-1 text-sm text-white/50">Your profile as VerdictVaut has it on record.</p>
      </div>

      {user ? (
        <ProfileSummary user={user} />
      ) : (
        <Card>
          <div className="space-y-3 p-5">
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-5 w-1/2" />
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {quickLinks.map((link) => {
          const Icon = link.icon;
          return (
            <Link
              key={link.href}
              href={link.href}
              className="group rounded-xl border border-vault-border bg-vault-surface p-4 transition-colors hover:border-vault-gold/40 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vault-gold"
            >
              <Icon className="h-5 w-5 text-white/50 transition-colors group-hover:text-vault-gold" aria-hidden="true" />
              <p className="mt-2 text-sm font-medium text-white">{link.label}</p>
              <p className="mt-0.5 text-xs text-white/40">{link.description}</p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
