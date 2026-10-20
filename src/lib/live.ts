import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

// -----------------------------------------------------------------------------
// Live updates for everything outside the boards (those have their own, see
// pm/useBoardRealtime.ts). A write to a watched table sends the table's name on
// the private broadcast channel "live" (migration 0094); here each name marks
// the queries that read it stale, and whatever is on screen refetches at once.
// Pages keep a slow refetch only as a safety net.
// -----------------------------------------------------------------------------

/** How long the safety-net refetch waits, for queries kept fresh by `live`. */
export const LIVE_FALLBACK = 5 * 60_000;

const ALERTS = [["watch-alerts"], ["watch-overview"], ["watch-ringing"], ["watch"], ["home-alerts"]];
const GROUPS = [["watch-groups"], ["watch-overview"]];
const SLACK = [["watch-slack"], ["watch-overview"]];
const PROJECTS = [["projects"], ["project"], ["projects-count"], ["home-deliveries"], ["my-work"]];
const DELIVERIES = [["deliveries"], ["delivery"], ["home-deliveries"], ["project"]];
const INVOICES = [["invoices-month"], ["invoices-overview"], ["invoices-needing-files"]];
const MEETINGS = [["meetings"], ["meetings-shared"], ["meeting"]];
const ACCOUNTS = [["connections"], ["watch-calendlys"], ["invoices-overview"], ["mail-watch-people"], ["watch-overview"], ["meetings"]];

/** Table -> the query keys (prefixes) that read it. */
const READS: Record<string, unknown[][]> = {
  watch_alert: ALERTS,
  watch_recipient: ALERTS,
  watch_event: ALERTS,
  watch_call: [["watch-call"], ["watch-ringing"]],
  wa_group: [...GROUPS, ["watch-alerts"]],
  wa_participant: GROUPS,
  wa_member: GROUPS,
  wa_member_lid: GROUPS,
  bot_order: GROUPS,
  slack_channel: [...SLACK, ["watch-alerts"]],
  slack_participant: SLACK,
  slack_member: SLACK,
  slack_user: SLACK,
  client: [...GROUPS, ...PROJECTS],
  profile_contact: [["profile-contact"], ["team-contacts"], ["users"]],
  work_session: [["attendance"]],
  work_break: [["attendance"]],
  project: PROJECTS,
  project_member: PROJECTS,
  project_note: [["project"]],
  project_file: [["project"], ["project-file-urls"]],
  project_invoice: [["project"], ["project-invoice-urls"]],
  project_delivery: [...DELIVERIES, ...PROJECTS],
  delivery_folder: DELIVERIES,
  delivery_round: DELIVERIES,
  delivery_item: [...DELIVERIES, ["delivery-urls"]],
  delivery_comment: DELIVERIES,
  delivery_link: DELIVERIES,
  invoice: INVOICES,
  invoice_target: INVOICES,
  invoice_folder: INVOICES,
  invoice_settings: INVOICES,
  gmail_share: [["mail-shared-with-me"], ["mail-shares"]],
  gmail_share_thread: [["mail-shared-with-me"], ["mail-shares"]],
  drive_share: [["drive-shared-with-me"], ["drive-shares"]],
  drive_share_item: [["drive-shared-with-me"], ["drive-shares"]],
  fireflies_share: MEETINGS,
  fireflies_meeting: MEETINGS,
  fireflies_link: MEETINGS,
  fireflies_account: MEETINGS,
  gmail_account: ACCOUNTS,
  drive_account: ACCOUNTS,
  calendly_account: ACCOUNTS,
  audit_log: [["activity-log"]],
};

// Writes come in bursts (one action touches several tables): gather the keys
// for a moment and refetch each once.
const pending = new Map<string, unknown[]>();
let timer: ReturnType<typeof setTimeout> | null = null;
function mark(qc: QueryClient, keys: unknown[][]) {
  for (const k of keys) pending.set(JSON.stringify(k), k);
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const batch = [...pending.values()];
    pending.clear();
    for (const k of batch) void qc.invalidateQueries({ queryKey: k });
  }, 150);
}

/** Mounted once for a signed-in person (AppShell). */
export function useLive(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let joined = false;
    const ch = supabase
      .channel("live", { config: { private: true } })
      .on("broadcast", { event: "change" }, ({ payload }) => {
        const keys = READS[(payload as { t?: string })?.t ?? ""];
        if (keys) mark(qc, keys);
      })
      .subscribe((status) => {
        if (status !== "SUBSCRIBED") return;
        // Back after a drop (sleep, network): what changed meanwhile was never sent.
        if (joined) mark(qc, Object.values(READS).flat());
        joined = true;
      });
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [enabled, qc]);
}
