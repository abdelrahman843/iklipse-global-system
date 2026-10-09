import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { isIOS, isStandalone } from "@/lib/pwa";

// -----------------------------------------------------------------------------
// Push notifications on this device (Web Push). The browser gives a
// subscription (an endpoint plus keys) once the person allows notifications;
// it is saved with push_register() and the push-send edge function delivers
// to it. Each device has its own Trello / Miro switches.
// iPhone / iPad only allow this inside the installed app (home-screen icon).
// -----------------------------------------------------------------------------

/** VAPID public key (the private half is a Supabase secret). */
const VAPID_PUBLIC = "BPelT9VjkNPtXHL6sauna3OdXTjlRSfUGhctla2KmaSbDUpgGeZz2NmI65kp8Y7XbcAgaD8TDtdeoDSzbAiDKRk";

export type PushSupport = "ok" | "unsupported" | "install-first" | "dev";

export function pushSupport(): PushSupport {
  if (!import.meta.env.PROD) return "dev"; // the service worker only runs in the built app
  if (isIOS() && !isStandalone()) return "install-first";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  return "ok";
}

function keyBytes(b64url: string) {
  const b64 = (b64url + "=".repeat((4 - (b64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function deviceName() {
  const ua = navigator.userAgent;
  const os = /iphone/i.test(ua) ? "iPhone" : /ipad/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ? "iPad"
    : /android/i.test(ua) ? "Android" : /windows/i.test(ua) ? "Windows" : /mac/i.test(ua) ? "Mac" : /linux/i.test(ua) ? "Linux" : "Device";
  const br = /edg\//i.test(ua) ? "Edge" : /samsungbrowser/i.test(ua) ? "Samsung Internet" : /firefox|fxios/i.test(ua) ? "Firefox"
    : /chrome|crios/i.test(ua) ? "Chrome" : /safari/i.test(ua) ? "Safari" : "";
  return isStandalone() ? `${os} · app` : br ? `${os} · ${br}` : os;
}

async function registration() {
  const ready = navigator.serviceWorker.ready;
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 8000));
  return (await Promise.race([ready, timeout])) as ServiceWorkerRegistration | null;
}

async function save(sub: PushSubscription) {
  const j = sub.toJSON();
  const { error } = await supabase.rpc("push_register", {
    p_endpoint: sub.endpoint,
    p_p256dh: j.keys?.p256dh ?? "",
    p_auth: j.keys?.auth ?? "",
    p_device: deviceName(),
  });
  if (error) throw new Error(error.message);
}

/** Asks for permission (if needed), subscribes this device and saves it. */
export async function enablePush(): Promise<void> {
  const support = pushSupport();
  if (support === "install-first") throw new Error("Install the app on your home screen first, then turn notifications on from there.");
  if (support === "dev") throw new Error("Push notifications work in the published app only.");
  if (support !== "ok") throw new Error("This browser can't receive push notifications.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications are blocked for this site. Allow them in the browser's site settings, then try again.");
  const reg = await registration();
  if (!reg) throw new Error("The app isn't ready yet. Reload the page and try again.");
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC) }));
  await save(sub);
}

/** Stops push on this device. */
export async function disablePush(): Promise<void> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await supabase.from("push_subscription").delete().eq("endpoint", sub.endpoint);
  await sub.unsubscribe().catch(() => undefined);
}

/**
 * On start (signed in): a device that already allowed notifications keeps its
 * subscription saved under whoever is signed in now, and a subscription the
 * browser renewed is saved again.
 */
export async function syncPush() {
  if (pushSupport() !== "ok" || Notification.permission !== "granted") return;
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) await save(sub).catch(() => undefined);
}

/** Tapping a notification while the app is open moves it to the card / board. */
if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    const d = e.data as { type?: string; url?: string } | null;
    if (d?.type === "open-url" && d.url && d.url.startsWith(location.origin)) location.href = d.url;
  });
}

export interface PushState {
  support: PushSupport;
  permission: NotificationPermission | "unsupported";
  /** This device's saved row (null: push is off here). */
  device: { endpoint: string; trello: boolean; miro: boolean } | null;
  loading: boolean;
}

export function usePush() {
  const [state, setState] = useState<PushState>({ support: pushSupport(), permission: "default", device: null, loading: true });

  const refresh = useCallback(async () => {
    const support = pushSupport();
    const permission = "Notification" in window ? Notification.permission : "unsupported";
    if (support !== "ok") return setState({ support, permission, device: null, loading: false });
    const reg = await registration();
    const sub = await reg?.pushManager.getSubscription();
    let device: PushState["device"] = null;
    if (sub && permission === "granted") {
      const { data } = await supabase.from("push_subscription").select("endpoint, trello, miro").eq("endpoint", sub.endpoint).maybeSingle();
      device = data ?? null;
    }
    setState({ support, permission, device, loading: false });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setProduct = useCallback(
    async (product: "trello" | "miro", on: boolean) => {
      const ep = state.device?.endpoint;
      if (!ep) return;
      setState((s) => (s.device ? { ...s, device: { ...s.device, [product]: on } } : s));
      const { error } = await supabase.from("push_subscription").update({ [product]: on }).eq("endpoint", ep);
      if (error) {
        await refresh();
        throw new Error(error.message);
      }
    },
    [state.device?.endpoint, refresh],
  );

  return { ...state, refresh, setProduct };
}
