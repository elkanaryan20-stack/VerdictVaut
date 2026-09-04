import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VerdictVaut",
  description: "VerdictVaut — premium global markets platform.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-vault-bg font-sans antialiased">{children}</body>
    </html>
  );
}
