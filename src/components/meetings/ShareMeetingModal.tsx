import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, Link2, Mail, Send, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Label, Hint, Textarea } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Avatar } from "@/components/ui/Avatar";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useAuth } from "@/lib/auth";
import { relativeTime } from "@/lib/format";
import { supabase } from "@/lib/supabase";
import { useWbPeople } from "@/lib/wb/people";
import { fetchConnections } from "@/lib/connectionsApi";
import {
  emailMeetingFromGmail,
  emailMeetingFromWorkspace,
  meetingLink,
  revokeMeetingLink,
  shareMeeting,
  unshareMeeting,
  type MeetingDetail,
} from "@/lib/firefliesApi";

// -----------------------------------------------------------------------------
// Share a meeting: with people in iklipse (they get a notification and see it
// in Meetings and on their Shared page), or by email: a private link that
// opens the summary and transcript without signing in, sent from one of my
// Gmail accounts or the workspace's notification sender. Links can be turned
// off here.
// -----------------------------------------------------------------------------

const WORKSPACE = "workspace";

export function ShareMeetingModal({ m, onClose }: { m: MeetingDetail; onClose: () => void }) {
  const { profile } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const people = useWbPeople();
  const conns = useQuery({ queryKey: ["connections"], queryFn: fetchConnections, staleTime: 60_000 });
  const gmail = conns.data?.gmail ?? [];

  const [picked, setPicked] = useState<string[]>([]);
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [from, setFrom] = useState<string>("");
  const sender = from || gmail[0]?.id || WORKSPACE;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["meeting", m.id] });
    void qc.invalidateQueries({ queryKey: ["meetings"] });
  };

  const already = new Set(m.people.map((p) => p.user_id));
  const options = useMemo(
    () =>
      (people.data?.list ?? [])
        .filter((p) => p.is_active && p.id !== profile?.id && !already.has(p.id) && !picked.includes(p.id))
        .map((p) => ({ value: p.id, label: p.display_name, icon: <Avatar src={p.avatar_url} name={p.display_name} size={20} /> })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [people.data, profile?.id, m.people, picked],
  );

  const share = useMutation({
    mutationFn: () => shareMeeting(m.id, picked),
    onSuccess: (n) => {
      setPicked([]);
      refresh();
      toast.push({ kind: "success", title: n === 1 ? "Shared with 1 person" : `Shared with ${n} people`, description: "They got a notification." });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't share it", description: e.message }),
  });

  const unshare = useMutation({
    mutationFn: (user: string) => unshareMeeting(m.id, user),
    onSuccess: refresh,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't stop sharing", description: e.message }),
  });

  const emailBad = !!email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const send = useMutation({
    mutationFn: async () => {
      if (sender === WORKSPACE) await emailMeetingFromWorkspace(m.id, email.trim(), note);
      else await emailMeetingFromGmail(m, sender, email.trim(), note, profile?.display_name ?? "Someone");
    },
    onSuccess: () => {
      toast.push({ kind: "success", title: `Sent to ${email.trim()}`, description: "With the summary and a link to the transcript." });
      setEmail("");
      setNote("");
      refresh();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't send it", description: e.message }),
  });

  const copyLink = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("meeting_link_create", { p_id: m.id, p_email: null });
      if (error) throw error;
      const url = meetingLink(data as string);
      await navigator.clipboard.writeText(url).catch(() => undefined);
      return url;
    },
    onSuccess: () => {
      refresh();
      toast.push({ kind: "success", title: "Link copied", description: "Anyone with it can open the summary and transcript." });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't make a link", description: e.message }),
  });

  const revoke = useMutation({
    mutationFn: revokeMeetingLink,
    onSuccess: refresh,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't turn it off", description: e.message }),
  });

  const byId = people.data?.byId;

  return (
    <Modal open onClose={onClose} title="Share the meeting" size="lg">
      <div className="space-y-7">
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-ink">People in iklipse</h3>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select
              className="flex-1"
              value=""
              placeholder="Add someone…"
              searchable
              options={options}
              onChange={(id) => setPicked((p) => [...p, id])}
              aria-label="Add someone"
            />
            <Button variant="primary" iconLeft={<Send size={14} />} disabled={!picked.length} loading={share.isPending} onClick={() => share.mutate()}>
              Share
            </Button>
          </div>
          {picked.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {picked.map((id) => {
                const p = byId?.get(id);
                return (
                  <span key={id} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface pl-1 pr-1 py-0.5 text-sm text-ink">
                    <Avatar src={p?.avatar_url} name={p?.display_name ?? "?"} size={20} />
                    {p?.display_name ?? "Someone"}
                    <button type="button" aria-label="Remove" onClick={() => setPicked((x) => x.filter((y) => y !== id))} className="h-6 w-6 grid place-items-center rounded-full text-subtle hover:text-ink hover:bg-inset">
                      <X size={12} />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          {m.people.length > 0 && (
            <ul className="rounded-lg border border-border divide-y divide-line">
              {m.people.map((p) => (
                <li key={p.user_id} className="px-3 py-2 flex items-center gap-2.5">
                  <Avatar src={p.avatar_url} name={p.name} size={26} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-ink truncate">{p.name}</div>
                    <div className="text-xs text-muted">Shared {relativeTime(p.shared_at)}</div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={unshare.isPending && unshare.variables === p.user_id}
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Stop sharing with ${p.name}?`,
                        message: "They lose the access you gave them to this meeting. You can share it with them again later.",
                        confirmLabel: "Stop sharing",
                        danger: true,
                      });
                      if (ok) unshare.mutate(p.user_id);
                    }}
                  >
                    Stop sharing
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-ink">By email</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="mt-email">To</Label>
              <Input id="mt-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" aria-invalid={emailBad} />
            </div>
            <div>
              <Label>Send from</Label>
              <Select
                className="w-full"
                value={sender}
                onChange={setFrom}
                aria-label="Send from"
                options={[...gmail.map((g) => ({ value: g.id, label: g.email })), { value: WORKSPACE, label: "iklipse (notification email)" }]}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="mt-note">Message</Label>
            <Textarea id="mt-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Here are the notes from our call." />
            <Hint>The email has the summary, the action items and a private link to the full transcript (no sign-in needed).</Hint>
          </div>
          <div className="flex flex-wrap justify-between gap-2">
            <Button iconLeft={<Link2 size={14} />} loading={copyLink.isPending} onClick={() => copyLink.mutate()}>
              Copy a link instead
            </Button>
            <Button
              variant="primary"
              iconLeft={<Mail size={14} />}
              disabled={!email.trim() || emailBad}
              loading={send.isPending}
              onClick={async () => {
                const fromLabel = sender === WORKSPACE ? "the iklipse notification email" : (gmail.find((g) => g.id === sender)?.email ?? "your Gmail");
                const ok = await confirm({
                  title: `Send the meeting to ${email.trim()}?`,
                  message: `It goes from ${fromLabel}, with the summary, the action items and a private link to the full transcript that opens without signing in.`,
                  confirmLabel: "Send",
                });
                if (ok) send.mutate();
              }}
            >
              Send email
            </Button>
          </div>
          {m.links.length > 0 && (
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted">Links that work now</div>
              <ul className="rounded-lg border border-border divide-y divide-line">
                {m.links.map((l) => (
                  <li key={l.id} className="px-3 py-2 flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-ink truncate">{l.email ?? "Copied link"}</div>
                      <div className="text-xs text-muted inline-flex items-center gap-1">
                        {relativeTime(l.created_at)}
                        {l.opened_at && (
                          <>
                            <span aria-hidden>·</span>
                            <Eye size={11} /> opened
                          </>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-label="Copy the link"
                      onClick={() => {
                        void navigator.clipboard.writeText(meetingLink(l.token));
                        toast.push({ kind: "success", title: "Link copied" });
                      }}
                      className="h-8 w-8 grid place-items-center rounded-md text-subtle hover:text-ink hover:bg-inset"
                    >
                      <Copy size={14} />
                    </button>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={revoke.isPending && revoke.variables === l.id}
                      onClick={async () => {
                        const ok = await confirm({
                          title: "Turn off this link?",
                          message: `${l.email ? `${l.email} can't` : "Nobody can"} open the meeting with it anymore. It can't be turned back on, but you can make a new link.`,
                          confirmLabel: "Turn off",
                          danger: true,
                        });
                        if (ok) revoke.mutate(l.id);
                      }}
                    >
                      Turn off
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
