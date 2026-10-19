import type { Metadata } from "next";
import { Inter } from "next/font/google";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
import "./globals.css";
import { I18nProvider } from "@/components/I18nProvider";
import GlobalRuntimeErrorReporter from "@/components/GlobalRuntimeErrorReporter";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

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
    <html
      lang="en"
      suppressHydrationWarning className={cn("font-sans", geist.variable)}
    >
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
