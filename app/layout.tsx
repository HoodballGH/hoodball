import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import AnimatedMarquee from "@/components/AnimatedMarquee";
import { LiveProvider } from "@/components/live/LiveProvider";

const SITE = process.env.SITE_URL ?? "https://hoodball.net";
const DESCRIPTION =
  "Automated holder lottery on Robinhood Chain. Hold $HOODBALL, win the pot.";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  alternates: { canonical: SITE },
  title: { default: "Hoodball", template: "%s · Hoodball" },
  description: DESCRIPTION,
  applicationName: "Hoodball",
  openGraph: {
    siteName: "Hoodball",
    title: "Hoodball",
    description: DESCRIPTION,
    url: SITE,
    type: "website",
    images: [
      { url: "/brand/og.png", width: 1200, height: 630, alt: "Hoodball" },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Hoodball",
    description: DESCRIPTION,
    images: ["/brand/og.png"],
  },
  icons: {
    icon: [{ url: "/brand/icon.png", type: "image/png" }],
    apple: [{ url: "/brand/icon.png", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#15161B",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <LiveProvider>
          <AnimatedMarquee />
          {children}
        </LiveProvider>
      </body>
    </html>
  );
}
