import { supabase } from "@/lib/supabase";
import { callFunction } from "@/lib/connectionsApi";

// -----------------------------------------------------------------------------
// The iklipse apps host this web app: the Android app (android/, a WebView)
// and the Windows app (desktop/, WebView2). They add what a browser can't:
// Ikli's calls ring like real ones, every notification comes through the app,
// and the apps update themselves. This is the page's side of that: the apps
// add "iklipseApp/<platform>" to the user agent and listen for messages
// ({ id, t, ... }), answering with the same id.
// The apps are downloaded from inside iklipse only (apps function, 0072).
// -----------------------------------------------------------------------------

type Msg = Record<string, unknown>;
interface AndroidPort {
  postMessage(s: string): void;
  addEventListener(type: "message", f: (e: { data: string }) => void): void;
}
interface WebView2Port {
  postMessage(m: unknown): void;
  addEventListener(type: "message", f: (e: { data: unknown }) => void): void;
}

export type AppPlatform = "android" | "windows";

const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
/** Running inside one of the iklipse apps (null: a browser). */
export const appPlatform: AppPlatform | null = /iklipseApp\/android/.test(ua) ? "android" : /iklipseApp\/windows/.test(ua) ? "windows" : null;
export const inApp = appPlatform !== null;

const androidPort = () => (window as unknown as { IklipseApp?: AndroidPort }).IklipseApp;
const webview2Port = () => (window as unknown as { chrome?: { webview?: WebView2Port } }).chrome?.webview;

let seq = 0;
let listening = false;
const waiting = new Map<number, (m: Msg) => void>();

function listen() {
  if (listening) return;
  listening = true;
  const got = (m: Msg) => {
    const f = waiting.get(Number(m.id));
    if (!f) return;
    waiting.delete(Number(m.id));
    f(m);
  };
  androidPort()?.addEventListener("message", (e) => {
    try {
      got(JSON.parse(e.data) as Msg);
    } catch {
      /* not ours */
    }
  });
  webview2Port()?.addEventListener("message", (e) => {
    const d = typeof e.data === "string" ? (JSON.parse(e.data) as Msg) : (e.data as Msg);
    if (d) got(d);
  });
}

/** Tells the app something; with waitMs, resolves with its answer (null when there is none). */
function toApp(t: string, extra: Msg = {}, waitMs = 0): Promise<Msg | null> {
  const a = androidPort();
  const w = webview2Port();
  if (!a && !w) return Promise.resolve(null);
  listen();
  const id = ++seq;
  const msg = { id, t, ...extra };
  if (a) a.postMessage(JSON.stringify(msg));
  else w!.postMessage(msg);
  if (!waitMs) return Promise.resolve(null);
  return new Promise((res) => {
    waiting.set(id, res);
    window.setTimeout(() => waiting.delete(id) && res(null), waitMs);
  });
}

export interface AppInfo {
  platform: AppPlatform;
  version: string;
  code: number;
  /** Android: who this phone is linked to (calls and notifications). */
  user?: string | null;
}

export async function appInfo(): Promise<AppInfo | null> {
  return (await toApp("info", {}, 4000)) as AppInfo | null;
}

/**
 * Signed in, in the Android app: this phone gets that person's calls and
 * notifications (linked once per person, with a one-time code).
 */
export async function linkThisPhone(userId: string): Promise<boolean> {
  if (appPlatform !== "android") return false;
  const info = await appInfo();
  if (!info || info.user === userId) return !!info;
  const { data: code, error } = await supabase.rpc("native_pair_start");
  if (error || typeof code !== "string") return false;
  const r = await toApp("link", { code }, 30_000);
  return r?.ok === true;
}

/** Signed out: the phone stops getting that person's calls; the Windows app forgets the login. */
export async function appSignedOut() {
  if (appPlatform === "android") await toApp("unlink", {}, 5000);
  if (appPlatform === "windows") await toApp("token", { token: null });
}

/** The Windows app checks for updates as the signed-in person (the downloads are team-only). */
export function appToken(token: string | null) {
  if (appPlatform === "windows") void toApp("token", { token });
}

/** Ikli is calling: the Windows app comes to the front and stays on top until it stops ringing. */
export function appRing(on: boolean) {
  if (appPlatform === "windows") void toApp("ring", { on });
}

/** A notification on the computer (the Windows app; Android gets them through Firebase). */
export function appNotify(n: { title: string; body: string; url: string }) {
  if (appPlatform === "windows") void toApp("notify", n);
}

/** Android: the phone's settings for Ikli's calls (permissions, ring test). */
export function openPhoneSettings() {
  void toApp("settings");
}

const MAX_SAVE = 60 * 1024 * 1024;

/**
 * Saves a file the page made (a blob): a download in a browser, the phone's
 * Downloads folder in the Android app (a WebView can't download blobs itself).
 */
export async function saveBlob(blob: Blob, name: string) {
  if (appPlatform === "android") {
    if (blob.size > MAX_SAVE) throw new Error("This file is too big to save in the app. Open iklipse in Chrome to download it.");
    const b64 = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1] ?? "");
      r.onerror = () => rej(r.error ?? new Error("Couldn't read the file"));
      r.readAsDataURL(blob);
    });
    const ok = await toApp("save", { name, mime: blob.type || "application/octet-stream", b64 }, 60_000);
    if (ok?.ok !== true) throw new Error(String(ok?.error ?? "Couldn't save the file"));
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// ------------------------------------------------------------- downloads --

/** The device this browser runs on, for "Get the app" (null: no app for it yet). */
export function appForThisDevice(): AppPlatform | null {
  if (inApp) return null;
  if (/android/i.test(ua)) return "android";
  if (/windows/i.test(ua)) return "windows";
  return null;
}

/** A download link for the app, for signed-in team members only (works a few minutes). */
export async function appDownload(platform: AppPlatform): Promise<{ code: number; name: string; url: string }> {
  return callFunction<{ code: number; name: string; url: string }>("apps", { platform });
}
