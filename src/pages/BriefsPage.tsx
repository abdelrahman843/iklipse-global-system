import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Eye, FileText, MoreHorizontal, Plus, Power, RotateCcw, Share2, Smartphone, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { Menu, MenuDivider, MenuItem } from "@/components/ui/Menu";
import { Input, Label, Textarea, Hint } from "@/components/ui/Input";
import { SearchField } from "@/components/ui/SearchField";
import { Select } from "@/components/ui/Select";
import { PageSpinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/format";
import { supabase } from "@/lib/supabase";
import { BRIEF_FORMS, briefFormByKey } from "@/lib/brief/forms";
import { briefStatus, briefUrl, createBrief, deleteBrief, listBriefs, updateBrief, type BriefLink, type BriefStatus } from "@/lib/brief/api";

// -----------------------------------------------------------------------------
// Briefs: make a one-time link for a questionnaire (the Brand Workshop), send
// it yourself, and read the answers when they come back. Who can make links
// and who can only read answers is set per person on the Users page.
// -----------------------------------------------------------------------------

type Row = Awaited<ReturnType<typeof listBriefs>>[number];

export const STATUS: Record<BriefStatus, { label: string; tone: "neutral" | "accent" | "success" | "warn" | "danger" }> = {
  waiting: { label: "Not opened", tone: "neutral" },
  progress: { label: "In progress", tone: "warn" },
  answered: { label: "Answered", tone: "success" },
  off: { label: "Closed", tone: "danger" },
};

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

/** Live: a link opened or answered elsewhere updates the list and the answers page. */
export function useBriefsRealtime() {
  const qc = useQueryClient();
  useEffect(() => {
    const ch = supabase
      .channel(`briefs:${Math.random().toString(36).slice(2, 10)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "brief_link" }, () => {
        qc.invalidateQueries({ queryKey: ["briefs"] });
        qc.invalidateQueries({ queryKey: ["brief"] });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [qc]);
}

export function usePeopleNames() {
  return useQuery({
    queryKey: ["people-names"],
    queryFn: async () => {
      const { data } = await supabase.from("profile").select("id, display_name");
      return new Map((data ?? []).map((p) => [p.id as string, p.display_name as string]));
    },
    staleTime: 5 * 60_000,
  });
}

export function BriefsPage() {
  const { briefRole } = useAuth();
  const canCreate = briefRole === "create";
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<BriefStatus | "all">("all");
  const [creating, setCreating] = useState(false);
  const [shared, setShared] = useState<BriefLink | null>(null);

  const { data, isLoading, error } = useQuery({ queryKey: ["briefs"], queryFn: listBriefs, refetchOnWindowFocus: true });
  const people = usePeopleNames();
  useBriefsRealtime();

  const counts = useMemo(() => {
    const c: Record<BriefStatus | "all", number> = { all: 0, waiting: 0, progress: 0, answered: 0, off: 0 };
    for (const r of data ?? []) {
      c.all++;
      c[briefStatus(r)]++;
    }
    return c;
  }, [data]);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data ?? []).filter((r) => (filter === "all" || briefStatus(r) === filter) && (!s || r.label.toLowerCase().includes(s)));
  }, [data, q, filter]);

  const act = useMutation({
    mutationFn: async ({ r, what }: { r: Row; what: "off" | "on" | "unlock" | "delete" }) => {
      if (what === "off") await updateBrief(r.id, { revoked_at: new Date().toISOString() });
      if (what === "on") await updateBrief(r.id, { revoked_at: null });
      if (what === "unlock") await updateBrief(r.id, { device_id: null });
      if (what === "delete") await deleteBrief(r.id);
      return what;
    },
    onSuccess: (what) => {
      qc.invalidateQueries({ queryKey: ["briefs"] });
      toast.push({
        kind: "success",
        title:
          what === "off" ? "Link closed" : what === "on" ? "Link open again" : what === "unlock" ? "Unlocked for a new device" : "Brief deleted",
        description: what === "unlock" ? "The next device that opens the link keeps it. Their answers so far are kept." : undefined,
      });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't change the link", description: e.message }),
  });

  const copy = async (r: Pick<Row, "token" | "label">) => {
    await copyText(briefUrl(r.token));
    toast.push({ kind: "success", title: "Link copied", description: `Send it to ${r.label}. It works on the first device that opens it.` });
  };

  if (isLoading) return <PageSpinner />;
  if (error)
    return (
      <div className="p-6">
        <EmptyState title="Couldn't load briefs" description={(error as Error).message} />
      </div>
    );

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-3 sm:p-4 md:p-6 max-w-4xl mx-auto">
        <div className="flex flex-col sm:flex-row sm:items-end gap-3 mb-5">
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl sm:text-3xl font-semibold text-ink tracking-tight">Briefs</h1>
            <p className="text-sm text-muted mt-1">
              Send someone a brief by link. It opens on one device only, every question needs an answer, and it closes once they send it.
            </p>
          </div>
          {canCreate && (
            <Button variant="primary" iconLeft={<Plus size={15} />} onClick={() => setCreating(true)} className="shrink-0 max-sm:h-10">
              New brief link
            </Button>
          )}
        </div>

        {(data ?? []).length > 0 && (
          <div className="flex flex-col sm:flex-row gap-2 mb-4">
            <SearchField value={q} onChange={setQ} placeholder="Search by name" aria-label="Search briefs" className="flex-1" />
            <Select
              className="sm:w-48 shrink-0"
              align="right"
              aria-label="Show"
              value={filter}
              onChange={(v) => setFilter(v as BriefStatus | "all")}
              options={[
                { value: "all", label: `All (${counts.all})` },
                { value: "waiting", label: `Not opened (${counts.waiting})` },
                { value: "progress", label: `In progress (${counts.progress})` },
                { value: "answered", label: `Answered (${counts.answered})` },
                { value: "off", label: `Closed (${counts.off})` },
              ]}
            />
          </div>
        )}

        {(data ?? []).length === 0 ? (
          <EmptyState
            icon={<FileText size={28} />}
            title="No brief links yet."
            description={
              canCreate
                ? "Make a link, send it to your client, and their answers show up here."
                : "When someone sends a brief link, the answers show up here."
            }
            action={
              canCreate ? (
                <Button variant="primary" iconLeft={<Plus size={15} />} onClick={() => setCreating(true)}>
                  New brief link
                </Button>
              ) : undefined
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState title="Nothing matches." />
        ) : (
          <ul className="space-y-2.5">
            {rows.map((r, i) => {
              const st = briefStatus(r);
              const form = briefFormByKey(r.form);
              const by = (r.created_by && people.data?.get(r.created_by)) || null;
              const live = st === "waiting" || st === "progress";
              return (
                <li
                  key={r.id}
                  className="rise rounded-lg border border-border bg-surface shadow-card p-3.5 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-3 hover:border-rule transition-colors"
                  style={{ ["--i" as string]: i }}
                >
                  <Link to={`/briefs/${r.id}`} className="min-w-0 flex-1 group">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-ink truncate group-hover:text-accent transition-colors">{r.label}</span>
                      <Badge tone={STATUS[st].tone}>{STATUS[st].label}</Badge>
                    </div>
                    <div className="mt-1 text-xs text-subtle flex flex-wrap gap-x-1.5">
                      <span>{form?.title ?? "Brief"}</span>
                      <span aria-hidden>·</span>
                      <span>
                        {by ? `${by}, ` : ""}
                        {relativeTime(r.created_at)}
                      </span>
                      {r.submitted_at ? (
                        <>
                          <span aria-hidden>·</span>
                          <span className="text-success">sent {relativeTime(r.submitted_at)}</span>
                        </>
                      ) : r.device_name && r.opened_at ? (
                        <>
                          <span aria-hidden>·</span>
                          <span className="inline-flex items-center gap-1">
                            <Smartphone size={11} /> {r.device_name}, {relativeTime(r.last_seen_at ?? r.opened_at)}
                          </span>
                        </>
                      ) : null}
                    </div>
                    {st === "progress" && (
                      <div className="mt-2.5 flex items-center gap-2 max-w-xs">
                        <div className="h-1.5 flex-1 rounded-full bg-inset overflow-hidden">
                          <div className="h-full bg-warn rounded-full grow-x" style={{ width: `${r.progress}%` }} />
                        </div>
                        <span className="text-xs tabular-nums text-muted">{r.progress}%</span>
                      </div>
                    )}
                  </Link>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {canCreate && live && (
                      <Button size="sm" iconLeft={<Copy size={14} />} onClick={() => copy(r)} className="max-sm:h-10 max-sm:flex-1">
                        Copy link
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant={st === "answered" ? "primary" : "secondary"}
                      iconLeft={<Eye size={14} />}
                      onClick={() => nav(`/briefs/${r.id}`)}
                      className="max-sm:h-10 max-sm:flex-1"
                    >
                      {st === "answered" ? "Answers" : "Open"}
                    </Button>
                    {canCreate && (
                      <Menu
                        align="right"
                        trigger={
                          <button
                            type="button"
                            aria-label={`More for ${r.label}`}
                            className="h-8 w-8 max-sm:h-10 max-sm:w-10 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink"
                          >
                            <MoreHorizontal size={16} />
                          </button>
                        }
                      >
                        {(close) => (
                          <>
                            {live && (
                              <MenuItem
                                onClick={() => {
                                  close();
                                  void copy(r);
                                }}
                              >
                                <span className="inline-flex items-center gap-2">
                                  <Copy size={14} /> Copy link
                                </span>
                              </MenuItem>
                            )}
                            {st === "progress" && r.device_id && (
                              <MenuItem
                                onClick={async () => {
                                  close();
                                  const ok = await confirm({
                                    title: `Unlock for a new device?`,
                                    message: `${r.label}'s link is open on ${r.device_name ?? "one device"}. Unlocking lets the next device that opens it take over, and the old one stops working. Their answers so far are kept.`,
                                    confirmLabel: "Unlock",
                                  });
                                  if (ok) act.mutate({ r, what: "unlock" });
                                }}
                              >
                                <span className="inline-flex items-center gap-2">
                                  <RotateCcw size={14} /> Unlock for a new device
                                </span>
                              </MenuItem>
                            )}
                            {st !== "answered" && (
                              <MenuItem
                                onClick={async () => {
                                  close();
                                  if (st === "off") return act.mutate({ r, what: "on" });
                                  const ok = await confirm({
                                    title: "Close this link?",
                                    message: "They won't be able to open it. You can open it again later.",
                                    confirmLabel: "Close link",
                                  });
                                  if (ok) act.mutate({ r, what: "off" });
                                }}
                              >
                                <span className="inline-flex items-center gap-2">
                                  <Power size={14} /> {st === "off" ? "Open the link again" : "Close the link"}
                                </span>
                              </MenuItem>
                            )}
                            {(live || st === "off") && <MenuDivider />}
                            <MenuItem
                              destructive
                              onClick={async () => {
                                close();
                                const ok = await confirm({
                                  title: `Delete ${r.label}'s brief?`,
                                  message: "The link, the answers and the images are deleted for good.",
                                  confirmLabel: "Delete",
                                  danger: true,
                                });
                                if (ok) act.mutate({ r, what: "delete" });
                              }}
                            >
                              <span className="inline-flex items-center gap-2">
                                <Trash2 size={14} /> Delete
                              </span>
                            </MenuItem>
                          </>
                        )}
                      </Menu>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <CreateBriefModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(l) => {
          setCreating(false);
          setShared(l);
          qc.invalidateQueries({ queryKey: ["briefs"] });
        }}
      />
      <ShareBriefModal link={shared} onClose={() => setShared(null)} />
    </div>
  );
}

// ---------------------------------------------------------------- create --
function CreateBriefModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (l: BriefLink) => void }) {
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [formKey, setFormKey] = useState(BRIEF_FORMS[0].key);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setLabel("");
    setNote("");
    setErr(null);
  }, [open]);
  const create = useMutation({
    mutationFn: () => createBrief({ form: briefFormByKey(formKey) ?? BRIEF_FORMS[0], label: label.trim(), note: note.trim() || null }),
    onSuccess: onCreated,
    onError: (e: Error) => setErr(e.message),
  });
  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!label.trim()) return setErr("Write who it's for.");
    create.mutate();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New brief link"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => submit()} loading={create.isPending}>
            Make the link
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <Label htmlFor="brief-for">Who is it for?</Label>
          <Input
            id="brief-for"
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
              setErr(null);
            }}
            maxLength={80}
            placeholder="e.g. OneClickAway, Ahmed"
            autoFocus
          />
          <Hint>They see it on the first screen: "Prepared for …".</Hint>
        </div>
        {BRIEF_FORMS.length > 1 && (
          <div>
            <Label>Questions</Label>
            <Select value={formKey} onChange={setFormKey} options={BRIEF_FORMS.map((f) => ({ value: f.key, label: f.title }))} />
          </div>
        )}
        <div>
          <Label htmlFor="brief-note">A note for them (optional)</Label>
          <Textarea id="brief-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={600} rows={3} placeholder="Hi Ahmed, here's the brand workshop we talked about…" />
        </div>
        <div className="rounded-md bg-inset border border-line px-3 py-2.5 text-xs text-muted leading-relaxed">
          {(briefFormByKey(formKey) ?? BRIEF_FORMS[0]).title}: {(briefFormByKey(formKey) ?? BRIEF_FORMS[0]).sections.length} sections, about{" "}
          {(briefFormByKey(formKey) ?? BRIEF_FORMS[0]).minutes} minutes. The link has no expiry. It works on the first device that opens it and closes when
          they send their answers.{" "}
          <Link to={`/brief-preview?form=${formKey}`} target="_blank" className="text-accent hover:underline">
            Preview the questions
          </Link>
        </div>
        {err && <p className="text-sm text-danger">{err}</p>}
      </form>
    </Modal>
  );
}

// ----------------------------------------------------------------- share --
function ShareBriefModal({ link, onClose }: { link: BriefLink | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [link?.id]);
  const url = link ? briefUrl(link.token) : "";
  const canShare = typeof navigator !== "undefined" && "share" in navigator;
  return (
    <Modal open={!!link} onClose={onClose} title="Your brief link is ready" size="md">
      {link && (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Send this to <b className="text-ink">{link.label}</b>. The answers show up on the Briefs page as soon as they send them, and you get a
            notification.
          </p>
          <div className="flex gap-2">
            <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="font-mono text-sm sm:text-sm" aria-label="Brief link" />
            <Button
              variant="primary"
              iconLeft={copied ? <Check size={14} /> : <Copy size={14} />}
              onClick={async () => {
                await copyText(url);
                setCopied(true);
              }}
              className="shrink-0 h-9"
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          {canShare && (
            <Button
              className="w-full"
              iconLeft={<Share2 size={14} />}
              onClick={() => navigator.share({ title: "Brand Workshop", text: `Hi ${link.label}, here's your brief from iklipse:`, url }).catch(() => undefined)}
            >
              Share…
            </Button>
          )}
          <div className={cn("rounded-md border px-3 py-2.5 text-xs leading-relaxed", "bg-warn/10 border-warn/25 text-ink")}>
            Don't open the link yourself: it belongs to the first device that opens it. To see what they'll get, use{" "}
            <Link to={`/brief-preview?form=${link.form}&for=${encodeURIComponent(link.label)}`} target="_blank" className="text-accent hover:underline">
              Preview
            </Link>
            .
          </div>
        </div>
      )}
    </Modal>
  );
}
