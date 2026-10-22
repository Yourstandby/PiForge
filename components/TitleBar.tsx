"use client";

/**
 * The app draws its own title bar: `electron/main.ts` creates the window with
 * `titleBarStyle: "hidden"` and a 36px overlay, so without a drag strip the
 * window cannot be moved at all. `h-9` must stay in sync with the overlay
 * height in `electron/main.ts`.
 *
 * Horizontal padding lives in `app/globals.css` (`.app-titlebar-inner`): the
 * native window buttons sit at the right edge on Windows and at the left edge
 * on macOS, and the browser dev preview needs neither.
 */
import { SystemStatusMenu } from "./SystemStatusMenu";

export function TitleBar() {
  return (
    <header className="app-titlebar relative z-40 flex h-9 shrink-0 items-center border-b border-black/[0.06] bg-white/70 backdrop-blur-md">
      <div className="app-titlebar-inner flex min-w-0 items-center gap-2">
        {/* Brand mark. Served as SVG: some managed Windows setups mangle .png at
            rest, and the SVG twin embeds the same raster. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo.svg"
          alt=""
          width={22}
          height={22}
          draggable={false}
          className="pointer-events-none shrink-0 select-none"
        />
        <span className="shrink-0 text-[12px] font-semibold tracking-[0.08em] text-ink-soft">
          PiForge
        </span>
        {/* 引擎状态 + pi 核心版本：低频系统信息，放这里不再和底栏余额抢宽度。 */}
        <div className="ml-auto flex shrink-0 items-center">
          <SystemStatusMenu />
        </div>
      </div>
    </header>
  );
}

export default TitleBar;
