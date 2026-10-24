import type { Metadata, Viewport } from "next";
import "./globals.css";
import "katex/dist/katex.min.css";
import { HydrationMarker } from "@/components/HydrationMarker";
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
      {/* 不要给 body 加 `min-h-dvh`：界面缩放把 `zoom` 接在 <html> 上时，视口单位
          不跟着缩放，`min-h-dvh` 会被放大成 1.1×视口高，文档凭空多出可滚动溢出
          （滚轮能把整条顶栏滚出屏幕）。外壳高度由 `.app-shell-height` 负责。 */}
      <body>
        <HydrationMarker />
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
