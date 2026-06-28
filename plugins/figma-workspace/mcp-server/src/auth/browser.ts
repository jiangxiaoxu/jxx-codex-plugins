import { spawn } from "node:child_process";
import { platform } from "node:os";

export async function openBrowser(url: URL | string): Promise<boolean> {
  const href = url.toString();
  const os = platform();
  const command =
    os === "darwin"
      ? "open"
      : os === "win32"
        ? "cmd.exe"
        : "xdg-open";
  const args = os === "win32" ? ["/c", "start", "", href] : [href];

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => resolve(false));
    child.on("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}
