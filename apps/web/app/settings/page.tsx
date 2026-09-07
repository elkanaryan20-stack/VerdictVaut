import Link from "next/link";
import { ChangePasswordForm } from "../../components/account/ChangePasswordForm";
import { SessionsList } from "../../components/account/SessionsList";
import { Card, CardBody } from "../../components/ui/Card";

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="font-display text-xs font-semibold uppercase tracking-[0.2em] text-white/40">{children}</h2>;
}

export default function SettingsPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-xl font-semibold text-white sm:text-2xl">Settings</h1>
        <p className="mt-1 text-sm text-white/50">Manage your account, security, and preferences.</p>
      </div>

      <section className="space-y-3">
        <SectionHeading>Account</SectionHeading>
        <Card>
          <CardBody className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-white/70">Your email, role, and account status live on the Account page.</p>
            <Link
              href="/account"
              className="rounded-md border border-vault-border px-3 py-1.5 text-xs font-medium text-white hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vault-gold"
            >
              View account
            </Link>
          </CardBody>
        </Card>
      </section>

      <section className="space-y-3">
        <SectionHeading>Security</SectionHeading>
        <ChangePasswordForm />
        <SessionsList />
      </section>

      <section className="space-y-3">
        <SectionHeading>Notifications</SectionHeading>
        <Card>
          <CardBody className="text-sm text-white/50">
            Notification preferences aren&apos;t available yet — VerdictVaut doesn&apos;t currently persist per-user notification
            settings. Check the Activity page for your real security and account events in the meantime.
          </CardBody>
        </Card>
      </section>

      <section className="space-y-3">
        <SectionHeading>Preferences</SectionHeading>
        <Card>
          <CardBody className="text-sm text-white/50">No configurable platform preferences exist yet.</CardBody>
        </Card>
      </section>
    </div>
  );
}
