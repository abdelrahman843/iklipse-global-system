import { useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox, Mail, Plus, Send, Unplug, Video } from "lucide-react";
import { BackButton } from "@/components/ui/BackButton";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useAuth } from "@/lib/auth";
import { relativeTime } from "@/lib/format";
import {
  RETURN_MESSAGES,
  disconnectGmail,
  disconnectZoom,
  fetchConnections,
  setNotifyGmail,
  startConnect,
  type GmailAccount,
} from "@/lib/connectionsApi";

// -----------------------------------------------------------------------------
// Connected accounts: each person's own Zoom account and Gmail accounts (as
// many as they like). Zoom / Google send the browser back here with
// ?zoom=... / ?gmail=..., which turns into a toast.
// -----------------------------------------------------------------------------

export function ConnectionsPage() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const q = useQuery({ queryKey: ["connections"], queryFn: fetchConnections });

  // Back from Zoom / Google.
  useEffect(() => {
    let back = false;
    for (const p of ["zoom", "gmail"]) {
      const v = params.get(p);
      if (!v) continue;
      back = true;
      const m = RETURN_MESSAGES[`${p}:${v}`];
      if (m) toast.push(m);
    }
    if (back) {
      void qc.invalidateQueries({ queryKey: ["connections"] });
      setParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = useMutation({
    mutationFn: startConnect,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't start connecting", description: e.message }),
  });

  const dropZoom = useMutation({
    mutationFn: disconnectZoom,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["connections"] });
      toast.push({ kind: "success", title: "Zoom disconnected" });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't disconnect Zoom", description: e.message }),
  });

  const dropGmail = useMutation({
    mutationFn: (a: GmailAccount) => disconnectGmail(a.id),
    onSuccess: (_d, a) => {
      void qc.invalidateQueries({ queryKey: ["connections"] });
      void qc.invalidateQueries({ queryKey: ["mail"] });
      toast.push({ kind: "success", title: `${a.email} disconnected` });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't disconnect", description: e.message }),
  });

  const sender = useMutation({
    mutationFn: (id: string | null) => setNotifyGmail(id),
    onSuccess: (_d, id) => {
      void qc.invalidateQueries({ queryKey: ["connections"] });
      void qc.invalidateQueries({ queryKey: ["integrations"] });
      toast.push(
        id
          ? { kind: "success", title: "Notification emails now come from this account" }
          : { kind: "success", title: "Notification emails back on the n8n connection" },
      );
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't change the sender", description: e.message }),
  });

  if (q.isLoading) return <PageSpinner />;
  if (!q.data)
    return (
      <div className="p-6">
        <EmptyState title="Couldn't load your connected accounts" description={(q.error as Error | null)?.message} />
      </div>
    );
  const { zoom, gmail } = q.data;
  const busy = connect.isPending;

  return (
    <div className="p-3 sm:p-4 md:p-6 max-w-3xl mx-auto">
      <div className="mb-6 flex items-start gap-3">
        <BackButton fallback="/" />
        <div className="flex-1 min-w-0">
          <div className="eyebrow text-subtle mb-1">Account</div>
          <h1 className="text-2xl sm:text-3xl font-semibold text-ink tracking-tight">Connected accounts</h1>
          <p className="text-sm text-muted mt-1">Your own Zoom and Gmail accounts. Only you use them; nobody else sees your mail.</p>
        </div>
      </div>

      {/* ------------------------------------------------------------ Zoom */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-ink mb-2 flex items-center gap-2">
          <span className="grid place-items-center h-5 w-5 rounded bg-accent-soft text-accent">
            <Video size={12} />
          </span>
          Zoom
        </h2>
        <div className="rounded-lg border border-border bg-surface shadow-card px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-ink flex flex-wrap items-center gap-2">
              {zoom ? <Badge tone="success">Connected</Badge> : <Badge tone="neutral">Not connected</Badge>}
              {zoom?.email && <span className="truncate">{zoom.email}</span>}
            </div>
            <div className="text-xs text-muted mt-0.5">
              {zoom
                ? `Connected ${relativeTime(zoom.connected_at)}. iklipse can make Zoom meetings on your account.`
                : "Lets iklipse make Zoom meetings on your account."}
            </div>
          </div>
          {zoom ? (
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<Unplug size={14} />}
              loading={dropZoom.isPending}
              className="max-sm:h-10"
              onClick={async () => {
                const ok = await confirm({
                  title: "Disconnect Zoom?",
                  message: "iklipse loses access to your Zoom account. You can connect it again any time.",
                  confirmLabel: "Disconnect",
                  danger: true,
                });
                if (ok) dropZoom.mutate();
              }}
            >
              Disconnect
            </Button>
          ) : (
            <Button variant="primary" size="sm" iconLeft={<Video size={14} />} loading={busy && connect.variables === "zoom"} disabled={busy} className="max-sm:h-10" onClick={() => connect.mutate("zoom")}>
              Connect Zoom
            </Button>
          )}
        </div>
      </section>

      {/* ----------------------------------------------------------- Gmail */}
      <section>
        <div className="flex items-center gap-2 mb-2">
          <h2 className="text-sm font-semibold text-ink flex items-center gap-2 flex-1">
            <span className="grid place-items-center h-5 w-5 rounded bg-accent-soft text-accent">
              <Mail size={12} />
            </span>
            Gmail
            {gmail.length > 0 && <span className="text-xs font-normal text-subtle">{gmail.length} connected</span>}
          </h2>
          {gmail.length > 0 && (
            <Link to="/mail" className="text-sm font-medium text-accent hover:underline underline-offset-2 inline-flex items-center gap-1">
              <Inbox size={14} /> Open Mail
            </Link>
          )}
        </div>
        <div className="rounded-lg border border-border bg-surface shadow-card divide-y divide-line">
          {gmail.length === 0 && (
            <div className="px-4 py-4 text-sm text-muted">
              Connect one or more Gmail accounts to read and answer their mail in iklipse.
            </div>
          )}
          {gmail.map((a) => (
            <div key={a.id} className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-ink flex flex-wrap items-center gap-2 min-w-0">
                  <span className="truncate">{a.email}</span>
                  {a.sends_notifications && (
                    <Badge tone="accent">
                      <Send size={10} className="inline -mt-px mr-1" />
                      Sends notifications
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted mt-0.5">
                  {a.name ? `${a.name} · ` : ""}Connected {relativeTime(a.connected_at)}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {isAdmin && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="max-sm:h-10"
                    loading={sender.isPending && sender.variables === (a.sends_notifications ? null : a.id)}
                    onClick={() => sender.mutate(a.sends_notifications ? null : a.id)}
                    title="The workspace's notification emails go out from this account"
                  >
                    {a.sends_notifications ? "Stop sending notifications" : "Send notifications from it"}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  iconLeft={<Unplug size={14} />}
                  className="max-sm:h-10"
                  loading={dropGmail.isPending && dropGmail.variables?.id === a.id}
                  onClick={async () => {
                    const ok = await confirm({
                      title: `Disconnect ${a.email}?`,
                      message: a.sends_notifications
                        ? "Its mail leaves iklipse, and notification emails go back to the n8n connection."
                        : "Its mail leaves iklipse. You can connect it again any time.",
                      confirmLabel: "Disconnect",
                      danger: true,
                    });
                    if (ok) dropGmail.mutate(a);
                  }}
                >
                  Disconnect
                </Button>
              </div>
            </div>
          ))}
          <div className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2">
            <div className="flex-1 text-xs text-muted">
              {gmail.length ? "Add another account: Google asks which one." : "Google asks which account to connect."} Up to 10.
            </div>
            <Button
              variant={gmail.length ? "secondary" : "primary"}
              size="sm"
              iconLeft={<Plus size={14} />}
              loading={busy && connect.variables === "gmail"}
              disabled={busy || gmail.length >= 10}
              className="max-sm:h-10"
              onClick={() => connect.mutate("gmail")}
            >
              {gmail.length ? "Add Gmail account" : "Connect Gmail"}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
