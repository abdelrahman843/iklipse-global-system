import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { bridgeInfo, bridgeStatus, fetchAlerts, fetchMailWatchPeople, fetchSlackChannels, fetchWatchGroups, fetchWatchOverview } from "@/lib/watchApi";
import { fetchBrain } from "@/lib/brainApi";
import { fetchInvoicesMonth, fetchInvoicesNeedingFiles, fetchInvoicesOverview, thisMonth } from "@/lib/invoicesApi";
import { fetchProjectsOverview } from "@/lib/projectsApi";
import { listDeliveries } from "@/lib/deliveriesApi";
import { fetchMeetingsOverview } from "@/lib/firefliesApi";

// -----------------------------------------------------------------------------
// Everything ready before it's opened: a few seconds after the app starts
// (when the browser is idle; App.tsx fetches every page's code), the data of
// the pages that take longest (alerts, WhatsApp groups and the bridge, the
// brain, invoices, projects, deliveries, meetings) is loaded into the cache,
// under the same keys the pages use. A page opened later shows at once and
// refreshes behind the scenes. Nothing here is required: a failure is the
// page loading as before.
// -----------------------------------------------------------------------------

const idle = (f: () => void) => (typeof window.requestIdleCallback === "function" ? window.requestIdleCallback(f, { timeout: 4000 }) : setTimeout(f, 1500));

async function warm(qc: QueryClient, admin: boolean) {
  const get = (queryKey: unknown[], queryFn: () => Promise<unknown>) => qc.prefetchQuery({ queryKey, queryFn }).catch(() => undefined);
  await Promise.all([
    get(["watch-overview"], fetchWatchOverview),
    get(["watch-alerts", true], () => fetchAlerts(true)),
    get(["projects"], fetchProjectsOverview),
    get(["deliveries"], listDeliveries),
    get(["meetings"], fetchMeetingsOverview),
  ]);
  if (!admin) return;
  await Promise.all([
    get(["watch-groups"], fetchWatchGroups),
    get(["mail-watch-people"], fetchMailWatchPeople),
    get(["watch-slack"], fetchSlackChannels),
    get(["brain"], () => fetchBrain()),
    get(["whatsapp-bridge"], bridgeStatus),
    get(["whatsapp-bridge-info"], bridgeInfo),
    get(["invoices-overview"], fetchInvoicesOverview),
    get(["invoices-needing-files"], fetchInvoicesNeedingFiles),
    get(["invoices-month", thisMonth()], () => fetchInvoicesMonth(thisMonth())),
  ]);
}

/** Once per sign-in, when the app is idle. */
export function useWarmup() {
  const qc = useQueryClient();
  const { profile, isAdmin } = useAuth();
  const id = profile?.id;
  useEffect(() => {
    if (!id) return;
    let gone = false;
    const t = window.setTimeout(() => idle(() => !gone && void warm(qc, isAdmin)), 2500);
    return () => {
      gone = true;
      window.clearTimeout(t);
    };
  }, [id, isAdmin, qc]);
}
