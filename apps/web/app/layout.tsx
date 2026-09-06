import type { Metadata } from "next";
import { JetBrains_Mono, Sora } from "next/font/google";
import { AuthProvider } from "../lib/auth/auth-context";
import { QueryProvider } from "../lib/query-provider";
import "./globals.css";

const sora = Sora({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const jetBrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "VerdictVaut",
  description: "VerdictVaut — premium global markets platform.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${sora.variable} ${jetBrainsMono.variable}`}>
      <body className="min-h-screen bg-vault-bg font-sans antialiased">
        <QueryProvider>
          <AuthProvider>{children}</AuthProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
