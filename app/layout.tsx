import type { Metadata, Viewport } from "next";
import "./globals.css";
import "katex/dist/katex.min.css";
import { HydrationMarker } from "@/components/HydrationMarker";
import { I18nProvider } from "@/components/I18nProvider";
import { ThemeBoot } from "@/components/ThemeBoot";

/** 首屏防闪烁：在 React 之前把夜晚模式写到 <html data-theme>。
 *  偏好存 localStorage 的 `pi-theme`（见 lib/theme.ts），与 I18nProvider 的语言
 *  偏好同一套做法——服务端不参与，所以这里只能是内联脚本。 */
const THEME_BOOT_SCRIPT = `(function(){try{var p=localStorage.getItem("pi-theme");if(p!=="light"&&p!=="dark")p="system";var d=p==="dark"||(p==="system"&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.dataset.theme=d?"dark":"light";r.style.colorScheme=d?"dark":"light";}catch(e){}})();`;

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
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <ThemeBoot />
        <HydrationMarker />
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
