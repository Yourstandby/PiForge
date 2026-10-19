import type { Metadata } from "next";
import { Noto_Sans_Mono, Inter } from "next/font/google";
import "./globals.css";
import { I18nProvider } from "@/components/I18nProvider";
import GlobalRuntimeErrorReporter from "@/components/GlobalRuntimeErrorReporter";

const notoSansMono = Noto_Sans_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-noto-mono",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "PiForge",
  description: "PiForge — a desktop forge for the Pi coding agent",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${notoSansMono.variable} ${inter.variable}`} suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("pi-theme");var d=document.documentElement;d.classList.toggle("dark",t==="dark"||t==="glacier");d.classList.toggle("theme-glacier",t==="glacier")}catch(e){}})();`,
          }}
        />
      </head>
      <body style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
        <I18nProvider>
          {/* Window-level unhandledrejection/error net; inside the provider so the toast copy can be translated. */}
          <GlobalRuntimeErrorReporter />
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
