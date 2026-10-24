/**
 * 界面缩放（字号设置）的唯一写入口。
 *
 * 为什么必须集中：`zoom` 挂在 `<html>` 上时，**视口单位不跟着缩放**。
 * `height: 100vh` 在 zoom=1.1 下渲染成 1.1 × 视口高，文档就多出 ~10% 的
 * 可滚动溢出——滚轮能把整条顶栏（标签栏 / 标题栏）滚到屏幕外，zoom=0.9
 * 时又反过来在底部留一条空白。所以设 zoom 的同时必须写 `--ui-zoom`，
 * 让外壳高度用 `calc(100dvh / var(--ui-zoom))` 抵掉这段倍率
 * （见 app/globals.css 的 `.app-shell-height`）。
 */
export const UI_SCALE_STORAGE_KEY = "pi-ui-scale";

export const UI_ZOOM_VAR = "--ui-zoom";

export function applyUiScale(scale: number): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const normalized = Number.isFinite(scale) && scale > 0 ? scale : 1;
  root.style.setProperty(UI_ZOOM_VAR, String(normalized));
  root.style.zoom = normalized === 1 ? "" : String(normalized);
}

export function readStoredUiScale(): number {
  if (typeof window === "undefined") return 1;
  try {
    const raw = Number(window.localStorage.getItem(UI_SCALE_STORAGE_KEY));
    return Number.isFinite(raw) && raw > 0 ? raw : 1;
  } catch {
    return 1;
  }
}
