import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lottie Render",
  description: "Dynamic video generation — Lottie template render + footage composite",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="app">
          <Link href="/" className="brand">
            Lottie Render
          </Link>
          <nav>
            <Link href="/">Jobs</Link>
            <Link href="/new">New job</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
