/**
 * PiForge 启动页（electron/startup.html）的运行时脚本。
 *
 * 职责只有三件：
 *   1. 按主进程传入的 `#state=…&message=…` 切换正常 / 失败 / 已停止三种画面；
 *   2. 暴露 `__piforgeFadeOut()`，供主进程在真正加载应用 URL 之前调用，
 *      让启动页平滑淡出（动画在加载期间一直循环，不会卡住）；
 *   3. 不引入任何外部资源（CSP 为 default-src 'none'）。
 */
(function () {
  var params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  var state = params.get("state");
  var message = params.get("message");
  var title = document.getElementById("title");
  var description = document.getElementById("description");
  var stateText = document.getElementById("stateText");
  var panel = document.getElementById("panel");

  /**
   * 平滑淡出：等 opacity 过渡跑完再 resolve，主进程拿到 Promise 后才导航。
   * 重复调用是幂等的（已淡出则立刻返回）。
   */
  window.__piforgeFadeOut = function () {
    return new Promise(function (resolve) {
      if (!document.body || document.body.classList.contains("is-leaving")) {
        resolve();
        return;
      }
      document.body.classList.add("is-leaving");
      window.setTimeout(resolve, 240);
    });
  };

  if (!title || !description || !stateText || !panel) return;

  if (state === "error") {
    document.title = "启动失败";
    title.textContent = "启动失败";
    description.textContent =
      "本地服务没有正常启动。请重启应用；如果问题仍然存在，请查看应用日志。";
    stateText.textContent = message || "后端服务不可用";
    panel.classList.add("error");
  } else if (state === "stopped") {
    document.title = "后端服务已停止";
    title.textContent = "后端服务已停止";
    description.textContent = "PiForge 的本地服务异常退出。请重启应用以恢复使用。";
    stateText.textContent = message || "服务进程已退出";
    panel.classList.add("stopped");
  } else {
    // state === "starting"（或未知）：保持品牌动画 + 进度文案
    document.title = "正在启动 PiForge…";
    stateText.textContent = message || "正在准备本地服务…";
  }
})();
