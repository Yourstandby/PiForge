import type { Metadata, Viewport } from "next";
import "./globals.css";
import "katex/dist/katex.min.css";
import { I18nProvider } from "@/components/I18nProvider";

export const metadata: Metadata = {
  title: "PiForge",
  description: "PiForge — a desktop forge for the Pi coding agent",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#FAFAFA",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="min-h-dvh">
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
