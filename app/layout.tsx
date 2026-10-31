import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";

export const metadata: Metadata = {
  title: "FINN",
  description: "Your portfolio, filtered. What changed, why it matters, and research grounded in primary filings.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "FINN", statusBarStyle: "default" },
  icons: { icon: "/icon.svg", apple: "/icon-192.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eef2f0" },
    { media: "(prefers-color-scheme: dark)", color: "#0d1311" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;600;700;800&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap"
        />
      </head>
      <body>
        <div className="mx-auto min-h-dvh max-w-[560px] pb-[calc(76px+env(safe-area-inset-bottom))]">{children}</div>
        <Nav />
      </body>
    </html>
  );
}
