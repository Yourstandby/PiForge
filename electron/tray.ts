import { app, Menu, Tray, BrowserWindow, nativeImage } from "electron";
import { setQuitting } from "./main";
import { getAppIconPath } from "./app-icon";
import type { CloseAction } from "./close-preference";

const FALLBACK_ICON_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFElEQVQ4y2N" +
    "kwAT/GYYBYwYDAKLuAf8LSXNHAAAAABJRU5ErkJggg==",
  "base64"
);

export interface TrayClosePreference {
  get(): CloseAction;
  set(action: CloseAction): void;
}

export function createTray(
  mainWindow: BrowserWindow,
  options: { onNewWindow?: () => void; closePreference?: TrayClosePreference } = {}
): Tray {
  const iconPath = getAppIconPath(app.getAppPath());

  let icon: Electron.NativeImage;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      // Fallback: create a minimal 16x16 transparent PNG
      icon = nativeImage.createFromBuffer(FALLBACK_ICON_PNG);
    }
  } catch {
    icon = nativeImage.createFromBuffer(FALLBACK_ICON_PNG);
  }

  const tray = new Tray(icon);
  tray.setToolTip("PiForge");

  // 「关闭窗口时」偏好可以从询问框（勾了记住）+ 这里两处改，勾选态每次重建菜单，
  // 免得用户改了之后托盘里还显示旧值。
  const closeMenuItems = (): Electron.MenuItemConstructorOptions[] => {
    const pref = options.closePreference;
    if (!pref) return [];
    const current = pref.get();
    const item = (action: CloseAction, label: string): Electron.MenuItemConstructorOptions => ({
      label,
      type: "radio",
      checked: current === action,
      click: () => {
        pref.set(action);
        tray.setContextMenu(buildContextMenu());
      },
    });
    return [
      {
        label: "关闭窗口时",
        submenu: [
          item("ask", "每次询问"),
          item("minimize", "最小化到托盘"),
          item("quit", "退出程序"),
        ],
      },
    ];
  };

  const buildContextMenu = () =>
    Menu.buildFromTemplate([
      {
        label: "显示窗口",
        click: () => {
          mainWindow.show();
          mainWindow.focus();
        },
      },
      {
        label: "新建窗口",
        click: () => {
          options.onNewWindow?.();
        },
      },
      ...closeMenuItems(),
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          setQuitting(true);
          app.quit();
        },
      },
    ]);

  tray.setContextMenu(buildContextMenu());
  tray.on("double-click", () => {
    mainWindow.show();
    mainWindow.focus();
  });

  return tray;
}
