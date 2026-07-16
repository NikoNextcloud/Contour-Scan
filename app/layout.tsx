import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { AppProvider } from "@/lib/store";
import Sidebar from "@/components/Sidebar";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  weight: ["500", "700"],
});
const plexSans = IBM_Plex_Sans({
  subsets: ["latin", "cyrillic"],
  variable: "--font-plex-sans",
  weight: ["400", "500", "600"],
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-plex-mono",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "ContourScan AI — от снимка до DXF",
  description:
    "Извличане на контури от снимки директно в браузъра. Експорт към DXF, SVG и PNG за CNC, лазер и винил.",
  manifest: "/manifest.json",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#10151b",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="bg" className="dark" suppressHydrationWarning>
      <body className={`${spaceGrotesk.variable} ${plexSans.variable} ${plexMono.variable}`}>
        <AppProvider>
          <div className="flex min-h-screen flex-col md:flex-row">
            <Sidebar />
            <main className="min-w-0 flex-1 px-4 pb-16 pt-6 md:px-8 md:pt-8">{children}</main>
          </div>
        </AppProvider>
      </body>
    </html>
  );
}
