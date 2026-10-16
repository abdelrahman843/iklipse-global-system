import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { appNotify, appPlatform, appToken, linkThisPhone } from "@/lib/nativeApp";
import { listNotifications } from "@/lib/pm/notificationsApi";
import { notificationHref, notificationText } from "@/components/notifications/kinds";

// -----------------------------------------------------------------------------
// Signed in inside one of the iklipse apps (src/lib/nativeApp.ts):
// - Android: this phone is linked to the person, so their calls and
//   notifications come to it (Firebase).
// - Windows: the app gets the login (for its updates) and a notification for
//   everything new (it keeps iklipse running in the tray; WebView2 has no Web
//   Push). The realtime feed refreshes the list the moment one lands.
// -----------------------------------------------------------------------------

export function AppBridge({ userId }: { userId: string }) {
  useEffect(() => {
    if (appPlatform === "android") void linkThisPhone(userId);
  }, [userId]);

  useEffect(() => {
    if (appPlatform !== "windows") return;
    void supabase.auth.getSession().then(({ data }) => appToken(data.session?.access_token ?? null));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => appToken(s?.access_token ?? null));
    return () => data.subscription.unsubscribe();
  }, [userId]);

  return appPlatform === "windows" ? <DesktopNotifier /> : null;
}

const APP_URL = `${location.origin}${import.meta.env.BASE_URL}`;

/** Windows app: one notification for each new one (not the ones already there when it opened). */
function DesktopNotifier() {
  const list = useQuery({ queryKey: ["notifications", "app"], queryFn: () => listNotifications(20), refetchInterval: 60_000 });
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const rows = list.data;
    if (!rows) return;
    if (!seen.current) {
      seen.current = new Set(rows.map((n) => n.id));
      return;
    }
    for (const n of [...rows].reverse()) {
      if (seen.current.has(n.id)) continue;
      seen.current.add(n.id);
      if (n.read_at) continue;
      const t = notificationText(n);
      appNotify({ title: t.head, body: t.detail ?? "", url: `${APP_URL}#${notificationHref(n, "/notifications")}` });
    }
  }, [list.data]);
  return null;
}
