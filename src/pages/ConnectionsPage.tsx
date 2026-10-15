import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AudioLines, FolderOpen, HardDrive, Inbox, Mail, Plug, Plus, Send, Share2, Unplug, Video } from "lucide-react";
import { BackButton } from "@/components/ui/BackButton";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SharingPanel } from "@/components/mail/SharingPanel";
import { DriveSharingPanel } from "@/components/drive/DriveSharingPanel";
import { FirefliesSection } from "@/components/meetings/FirefliesSection";
import { McpSection } from "@/components/McpSection";
import { LineTabs, type LineTab } from "@/components/ui/LineTabs";
import { Section } from "@/components/ui/Section";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useAuth } from "@/lib/auth";
import { relativeTime } from "@/lib/format";
import {
  RETURN_MESSAGES,
  disconnectDrive,
  disconnectGmail,
  disconnectZoom,
  fetchConnections,
  setNotifyGmail,
  startConnect,
  type DriveAccount,
  type GmailAccount,
} from "@/lib/connectionsApi";

// -----------------------------------------------------------------------------
// Connected accounts: each person's own Zoom account, and Gmail and Google
// Drive accounts (as many as they like), one tab per kind; Gmail and Drive
// also hold who they're shared with. Zoom / Google send the browser back here
// with ?zoom=... / ?gmail=... / ?drive=..., which turns into a toast and opens
// that tab.
// -----------------------------------------------------------------------------

export function ConnectionsPage() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const q = useQuery({ queryKey: ["connections"], queryFn: fetchConnections });
  const asked = params.get("tab");
  const [tab, setTab] = useState<Tab>(
    TABS.includes(asked as Tab) ? (asked as Tab) : (["gmail", "drive", "zoom"] as const).find((p) => params.get(p)) ?? "gmail",
  );
  // Share (on an account): down to that kind's sharing, under its accounts.
  const toSharing = () => document.getElementById("sharing")?.scrollIntoView({ behavior: "smooth", block: "start" });

  // Back from Zoom / Google.
  useEffect(() => {
    let back = false;
    for (const p of ["zoom", "gmail", "drive"]) {
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

  const dropDrive = useMutation({
    mutationFn: (a: DriveAccount) => disconnectDrive(a.id),
    onSuccess: (_d, a) => {
      void qc.invalidateQueries({ queryKey: ["connections"] });
      void qc.invalidateQueries({ queryKey: ["drive"] });
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
  // Defaults: a copy saved by an older version may lack a field.
  const { zoom = null, gmail = [], drive = [], fireflies = [] } = q.data;
  const busy = connect.isPending;
  const tabs: LineTab<Tab>[] = [
    { value: "gmail", label: "Gmail", icon: <Mail />, count: gmail.length },
    { value: "drive", label: "Google Drive", short: "Drive", icon: <HardDrive />, count: drive.length },
    { value: "zoom", label: "Zoom", icon: <Video /> },
    { value: "fireflies", label: "Fireflies", icon: <AudioLines />, count: fireflies.length },
    { value: "ai", label: "Claude and ChatGPT", short: "AI", icon: <Plug /> },
  ];
  const pick = (t: Tab) => {
    setTab(t);
    setParams(t === "gmail" ? {} : { tab: t }, { replace: true });
  };

  return (
    <div className="p-3 sm:p-4 md:p-6">
      <div className="mb-4 flex items-start gap-3">
        <BackButton fallback="/" />
        <div className="flex-1 min-w-0">
          <div className="eyebrow text-subtle mb-1">Account</div>
          <h1 className="text-xl sm:text-2xl lg:text-3xl font-semibold text-ink tracking-tight">Connected accounts</h1>
          <p className="text-sm text-muted mt-1 hidden sm:block">
            Your own Gmail, Google Drive, Zoom and Fireflies accounts, and who you share them with. Nobody else sees your mail, files or meetings unless you share them.
          </p>
        </div>
      </div>
      <LineTabs value={tab} tabs={tabs} onChange={pick} label="Accounts" className="mb-6" />

      <div key={tab} className="view-enter space-y-8">
        {tab === "ai" && <McpSection />}

        {/* ------------------------------------------------------------ Zoom */}
        {tab === "zoom" && (
        <Section title={<ServiceTitle icon={<Video size={12} />}>Zoom</ServiceTitle>}>
          <div className="border-b border-line py-3 flex flex-col sm:flex-row sm:items-center gap-3">
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
        </Section>
        )}

        {/* ----------------------------------------------------------- Gmail */}
        {tab === "gmail" && (
        <>
        <Section
          title={<ServiceTitle icon={<Mail size={12} />}>Gmail</ServiceTitle>}
          count={gmail.length > 0 ? `${gmail.length} connected` : null}
          action={
            gmail.length > 0 && (
              <Link to="/mail" className="text-sm font-medium text-accent hover:underline underline-offset-2 inline-flex items-center gap-1">
                <Inbox size={14} /> Open Mail
              </Link>
            )
          }
        >
          <div className="divide-y divide-line border-b border-line">
            {gmail.length === 0 && (
              <div className="py-4 text-sm text-muted">
                Connect one or more Gmail accounts to read and answer their mail in iklipse.
              </div>
            )}
            {gmail.map((a, i) => (
              <div key={a.id} style={{ "--i": Math.min(i, 12) } as React.CSSProperties} className="rise py-3 flex flex-col sm:flex-row sm:items-center gap-3">
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
                  <Button
                    variant="ghost"
                    size="sm"
                    iconLeft={<Share2 size={14} />}
                    className="max-sm:h-10"
                    onClick={toSharing}
                  >
                    Share
                  </Button>
                  {isAdmin && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="max-sm:h-10"
                      loading={sender.isPending && sender.variables === (a.sends_notifications ? null : a.id)}
                      onClick={async () => {
                        const current = gmail.find((x) => x.sends_notifications && x.id !== a.id);
                        const ok = await confirm(
                          a.sends_notifications
                            ? {
                                title: "Stop sending notifications from it?",
                                message: `Everyone's notification emails stop coming from ${a.email} and go back to the n8n connection.`,
                                confirmLabel: "Stop sending",
                              }
                            : {
                                title: `Send notifications from ${a.email}?`,
                                message: `Everyone's notification emails will go out from this address instead of ${current ? current.email : "the n8n connection"}.`,
                                confirmLabel: "Send from it",
                              },
                        );
                        if (ok) sender.mutate(a.sends_notifications ? null : a.id);
                      }}
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
            <div className="py-3 flex flex-col sm:flex-row sm:items-center gap-2">
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
        </Section>
        <div id="sharing" className="scroll-mt-4">
          <SharingPanel />
        </div>
        </>
        )}

        {/* ----------------------------------------------------------- Drive */}
        {tab === "drive" && (
        <>
        <Section
          title={<ServiceTitle icon={<HardDrive size={12} />}>Google Drive</ServiceTitle>}
          count={drive.length > 0 ? `${drive.length} connected` : null}
          action={
            drive.length > 0 && (
              <Link to="/drive" className="text-sm font-medium text-accent hover:underline underline-offset-2 inline-flex items-center gap-1">
                <FolderOpen size={14} /> Open Drive
              </Link>
            )
          }
        >
          <div className="divide-y divide-line border-b border-line">
            {drive.length === 0 && (
              <div className="py-4 text-sm text-muted">
                Connect one or more Google Drive accounts to open, upload and share their files in iklipse.
              </div>
            )}
            {drive.map((a, i) => (
              <div key={a.id} style={{ "--i": Math.min(i, 12) } as React.CSSProperties} className="rise py-3 flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-ink truncate">{a.email}</div>
                  <div className="text-xs text-muted mt-0.5">
                    {a.name ? `${a.name} · ` : ""}Connected {relativeTime(a.connected_at)}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    iconLeft={<Share2 size={14} />}
                    className="max-sm:h-10"
                    onClick={toSharing}
                  >
                    Share
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    iconLeft={<Unplug size={14} />}
                    className="max-sm:h-10"
                    loading={dropDrive.isPending && dropDrive.variables?.id === a.id}
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Disconnect ${a.email}?`,
                        message: "Its files leave iklipse, and the people you shared it with lose access. Nothing is deleted from Google Drive.",
                        confirmLabel: "Disconnect",
                        danger: true,
                      });
                      if (ok) dropDrive.mutate(a);
                    }}
                  >
                    Disconnect
                  </Button>
                </div>
              </div>
            ))}
            <div className="py-3 flex flex-col sm:flex-row sm:items-center gap-2">
              <div className="flex-1 text-xs text-muted">
                {drive.length ? "Add another account: Google asks which one." : "Google asks which account to connect."} Up to 10.
              </div>
              <Button
                variant={drive.length ? "secondary" : "primary"}
                size="sm"
                iconLeft={<Plus size={14} />}
                loading={busy && connect.variables === "drive"}
                disabled={busy || drive.length >= 10}
                className="max-sm:h-10"
                onClick={() => connect.mutate("drive")}
              >
                {drive.length ? "Add Drive account" : "Connect Drive"}
              </Button>
            </div>
          </div>
        </Section>
        <div id="sharing" className="scroll-mt-4">
          <DriveSharingPanel />
        </div>
        </>
        )}

        {tab === "fireflies" && <FirefliesSection accounts={fireflies} />}
      </div>
    </div>
  );
}

type Tab = "gmail" | "drive" | "zoom" | "fireflies" | "ai";
const TABS: Tab[] = ["gmail", "drive", "zoom", "fireflies", "ai"];

function ServiceTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="grid place-items-center h-5 w-5 rounded bg-accent-soft text-accent">{icon}</span>
      {children}
    </span>
  );
}
