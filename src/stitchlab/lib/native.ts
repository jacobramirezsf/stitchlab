// Native (Capacitor/iOS) shims. On the web these are inert pass-throughs; in
// the app wrap they route downloads through the iOS share sheet and point
// relative /api/* calls at production (the app's origin is capacitor://).
// Capacitor is imported dynamically so the web bundle only pays for it when
// actually running native.

const PROD = "https://connect.baysidesf.org";

export function isNative(): boolean {
  if (typeof window === "undefined") return false; // node harnesses / SSR
  const w = window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } };
  return Boolean(w.Capacitor?.isNativePlatform?.());
}

/** Prefix for API calls. Set VITE_API_BASE to point the web build at a
 *  backend (accounts, remove-bg, inquiry); unset, those features are offline. */
export function apiBase(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE;
  if (env) return env.replace(/\/$/, "");
  return isNative() ? PROD : "";
}

/** Save/share a blob. Web: normal <a download>. Native: write to the app's
 *  cache and open the share sheet (Save to Files, AirDrop, Messages…). */
export async function saveBlob(blob: Blob, filename: string): Promise<void> {
  if (!isNative()) {
    const u = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = u;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(u);
    return;
  }
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import("@capacitor/filesystem"),
    import("@capacitor/share"),
  ]);
  const b64 = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] ?? "");
    r.onerror = () => rej(new Error("read"));
    r.readAsDataURL(blob);
  });
  const write = await Filesystem.writeFile({ path: filename, data: b64, directory: Directory.Cache });
  await Share.share({ files: [write.uri], title: filename });
}
