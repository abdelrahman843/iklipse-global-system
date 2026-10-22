import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Power, RefreshCw, RotateCw, Save, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Section } from "@/components/ui/Section";
import { NumberRow, SettingGroup, SettingRow, SwitchRow } from "@/components/ui/SettingRows";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { relativeTime } from "@/lib/format";
import {
  bridgeInfo,
  bridgeRestart,
  bridgeStart,
  bridgeStop,
  saveBridgeProfile,
  saveBridgeSettings,
  type BridgeInfo,
  type BridgeSettings,
} from "@/lib/watchApi";

// -----------------------------------------------------------------------------
// Connected accounts > WhatsApp, under the QR code (admins only, 0098): all an
// admin controls of the bot's WhatsApp bridge. How fast the bot answers (for
// Green API too), what the number does before it writes (marks the chat read,
// shows "typing…"), whether it shows online, the number's profile, WhatsApp's
// limits on it, and the bridge itself (restart, stop, where its messages go).
// -----------------------------------------------------------------------------

const KEY = ["whatsapp-bridge-info"];

/** Saved together with the Save button (online is switched on its own). */
type Draft = Omit<BridgeSettings, "wa_online">;
const FIELDS: (keyof Draft)[] = [
  "reply_quiet_sec",
  "reply_max_sec",
  "group_quiet_sec",
  "group_max_sec",
  "wa_seen",
  "wa_typing",
  "typing_cps",
  "typing_min_sec",
  "typing_max_sec",
];

/** "75" -> "1 min 15 s" next to a number of seconds. */
function spell(sec: number) {
  if (!Number.isFinite(sec)) return "";
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}

const CAPPING: Record<string, { text: string; tone: "success" | "warn" | "danger" | "neutral" }> = {
  NONE: { text: "No limit reached", tone: "success" },
  FIRST_WARNING: { text: "First warning", tone: "warn" },
  SECOND_WARNING: { text: "Second warning", tone: "warn" },
  CAPPED: { text: "Capped: can't start new chats", tone: "danger" },
};

const day = (sec: number | null) => (sec ? new Date(sec * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

function readFile(f: File): Promise<{ mimetype: string; data: string }> {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok({ mimetype: f.type, data: String(r.result).split(",")[1] ?? "" });
    r.onerror = () => fail(new Error("Couldn't read the picture"));
    r.readAsDataURL(f);
  });
}

export function WhatsAppBridgeControls({ linked, botUses }: { linked: boolean; botUses: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: KEY, queryFn: bridgeInfo, refetchOnWindowFocus: true });
  const info = q.data;

  // The settings, edited here until saved.
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    if (info?.settings && !draft) setDraft(pick(info.settings));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.settings]);
  const saved = info?.settings ? pick(info.settings) : null;
  const changed = !!draft && !!saved && FIELDS.some((k) => draft[k] !== saved[k]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));

  const after = (i: BridgeInfo) => {
    qc.setQueryData(KEY, i);
    if (i.settings) setDraft(pick(i.settings));
  };
  const fail = (title: string) => (e: Error) => toast.push({ kind: "error", title, description: e.message });

  const save = useMutation({
    mutationFn: () => saveBridgeSettings(draft!),
    onSuccess: (i) => {
      after(i);
      toast.push({ kind: "success", title: "Saved" });
    },
    onError: fail("Couldn't save"),
  });
  const online = useMutation({
    mutationFn: (v: boolean) => saveBridgeSettings({ wa_online: v }),
    // Only the switch: what's being edited above stays.
    onSuccess: (i) => qc.setQueryData(KEY, i),
    onError: fail("Couldn't change it"),
  });
  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: KEY });
    void qc.invalidateQueries({ queryKey: ["whatsapp-bridge"] });
  };
  const restart = useMutation({
    mutationFn: bridgeRestart,
    onSuccess: () => {
      refreshAll();
      toast.push({ kind: "success", title: "Restarting the bridge", description: "It's back in a few seconds, without a new QR code." });
    },
    onError: fail("Couldn't restart"),
  });
  const stop = useMutation({ mutationFn: bridgeStop, onSuccess: refreshAll, onError: fail("Couldn't stop") });
  const repoint = useMutation({
    mutationFn: bridgeStart,
    onSuccess: () => {
      refreshAll();
      toast.push({ kind: "success", title: "Its messages come to iklipse again" });
    },
    onError: fail("Couldn't set it"),
  });

  // The number's profile.
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const profile = useMutation({
    mutationFn: saveBridgeProfile,
    onSuccess: (_r, p) => {
      void qc.invalidateQueries({ queryKey: KEY });
      if (p.name) setName("");
      if (p.about !== undefined) setAbout("");
      toast.push({ kind: "success", title: "Profile updated", description: "WhatsApp may take a minute to show it." });
    },
    onError: fail("Couldn't update the profile"),
  });

  if (q.isLoading || !draft) {
    return (
      <div className="py-6 flex justify-center">
        {q.error ? <span className="text-sm text-danger">{(q.error as Error).message}</span> : <Spinner />}
      </div>
    );
  }

  const cap = info?.capping;
  const lock = info?.timelock;
  const capInfo = cap?.status ? CAPPING[cap.status] ?? { text: cap.status, tone: "neutral" as const } : null;

  return (
    <div className="space-y-8">
      {/* ---------------------------------------------------- speed */}
      <SettingGroup
        title="How fast the bot answers"
        info="The bot waits for someone to stop writing before it reads what they said, so it answers everything at once. A minute or more is read on the bot's minute-by-minute run; less than a minute is read right after the wait. These hold for Green API too."
        hint={!info?.settings?.dm_enabled ? "Answering private chats is off (Alerts > Settings): the private chat times wait for it." : undefined}
      >
        <NumberRow
          id="reply-quiet"
          label="Private chats: answer after they're quiet for"
          info="How long after their last message. Short feels quick, but it may answer before they finish. Under 15 seconds isn't advised."
          value={draft.reply_quiet_sec}
          onChange={(v) => set("reply_quiet_sec", v)}
          min={5}
          max={600}
          unit={`seconds${Number.isFinite(draft.reply_quiet_sec) && draft.reply_quiet_sec >= 60 ? ` (${spell(draft.reply_quiet_sec)})` : ""}`}
          dim={!info?.settings?.dm_enabled}
        />
        <NumberRow
          id="reply-max"
          label="Private chats: answer anyway after"
          info="Someone who keeps writing without a pause gets an answer this long after their first message."
          value={draft.reply_max_sec}
          onChange={(v) => set("reply_max_sec", v)}
          min={30}
          max={3600}
          unit={`seconds${Number.isFinite(draft.reply_max_sec) ? ` (${spell(draft.reply_max_sec)})` : ""}`}
          dim={!info?.settings?.dm_enabled}
        />
        <NumberRow
          id="group-quiet"
          label="Client groups: read after they're quiet for"
          info="When a client group's new messages are read for alerts (no reply, promises). The bot answers a mention right away; this is only the reading for alerts."
          value={draft.group_quiet_sec}
          onChange={(v) => set("group_quiet_sec", v)}
          min={15}
          max={1800}
          unit={`seconds${Number.isFinite(draft.group_quiet_sec) && draft.group_quiet_sec >= 60 ? ` (${spell(draft.group_quiet_sec)})` : ""}`}
        />
        <NumberRow
          id="group-max"
          label="Client groups: read anyway after"
          value={draft.group_max_sec}
          onChange={(v) => set("group_max_sec", v)}
          min={60}
          max={7200}
          unit={`seconds${Number.isFinite(draft.group_max_sec) ? ` (${spell(draft.group_max_sec)})` : ""}`}
        />
      </SettingGroup>

      {/* ---------------------------------------------------- like a person */}
      <SettingGroup
        title="Before it writes"
        info="What the number does before each message, so it looks like a person and WhatsApp is less likely to flag it. Only on the bridge, not Green API."
      >
        <SwitchRow
          id="wa-seen"
          label="Mark the chat as read (blue ticks)"
          info="The messages it answers show as read."
          checked={draft.wa_seen}
          onChange={(v) => set("wa_seen", v)}
        />
        <SwitchRow
          id="wa-typing"
          label='Show "typing…" in private chats'
          info="For as long as a person would take to write the reply: its length at the speed below, between the shortest and longest times. Not in groups."
          checked={draft.wa_typing}
          onChange={(v) => set("wa_typing", v)}
        />
        <NumberRow
          id="typing-cps"
          label="Typing speed"
          value={draft.typing_cps}
          onChange={(v) => set("typing_cps", v)}
          min={3}
          max={100}
          unit="letters a second"
          dim={!draft.wa_typing}
        />
        <NumberRow
          id="typing-min"
          label="Typing at least"
          value={draft.typing_min_sec}
          onChange={(v) => set("typing_min_sec", v)}
          min={0}
          max={30}
          unit="seconds"
          dim={!draft.wa_typing}
        />
        <NumberRow
          id="typing-max"
          label="Typing at most"
          info="Long replies stop at this. Kept short: the bot waits while it types."
          value={draft.typing_max_sec}
          onChange={(v) => set("typing_max_sec", v)}
          min={0}
          max={30}
          unit="seconds"
          dim={!draft.wa_typing}
        />
      </SettingGroup>

      {changed && (
        <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-end gap-2 rounded-lg border border-line bg-surface/95 backdrop-blur px-3 py-2 shadow-sm">
          <span className="text-sm text-muted mr-auto">Unsaved changes</span>
          <Button variant="ghost" size="sm" onClick={() => saved && setDraft(saved)}>
            Undo
          </Button>
          <Button
            variant="primary"
            size="sm"
            iconLeft={<Save size={14} />}
            loading={save.isPending}
            disabled={FIELDS.some((k) => typeof draft[k] === "number" && !Number.isFinite(draft[k] as number))}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
        </div>
      )}

      {/* ---------------------------------------------------- presence */}
      <SettingGroup title="Online" info="Whether the number shows as online to everyone.">
        <SwitchRow
          id="wa-online"
          label="Always show as online"
          info="Off: it shows 'last seen' like a phone left alone. On: always online, and WhatsApp stops sending notifications to the phone for this number while it is."
          checked={info?.settings?.wa_online ?? false}
          onChange={(v) => online.mutate(v)}
          disabled={!linked || online.isPending}
        />
        <SettingRow label="Now">
          <span className="text-sm text-muted">{info?.presence === "online" ? "Online" : info?.presence ? "Offline" : "—"}</span>
        </SettingRow>
      </SettingGroup>

      {/* ---------------------------------------------------- profile */}
      <Section title="The number's profile" info="What people see on the bot's number in WhatsApp.">
        <div className="divide-y divide-line border-b border-line">
          <div className="py-3 flex items-center gap-4">
            {info?.profile?.picture ? (
              <img src={info.profile.picture} alt="" className="h-14 w-14 rounded-full object-cover border border-line" />
            ) : (
              <div className="h-14 w-14 rounded-full bg-inset border border-line" />
            )}
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-ink truncate">{info?.profile?.name ?? "—"}</div>
              <div className="text-xs text-muted">{info?.phone ? `+${info.phone}` : "Not linked"}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                ref={file}
                type="file"
                accept="image/jpeg,image/png"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  if (f.size > 5 * 1024 * 1024) return toast.push({ kind: "error", title: "The picture is too big", description: "5 MB at most." });
                  try {
                    profile.mutate({ picture: await readFile(f) });
                  } catch (err) {
                    toast.push({ kind: "error", title: (err as Error).message });
                  }
                }}
              />
              <Button variant="secondary" size="sm" iconLeft={<ImagePlus size={14} />} className="max-sm:h-10" disabled={!linked} loading={profile.isPending && !!profile.variables?.picture} onClick={() => file.current?.click()}>
                Picture
              </Button>
              {info?.profile?.picture && (
                <Button
                  variant="ghost"
                  size="sm"
                  iconLeft={<Trash2 size={14} />}
                  className="max-sm:h-10"
                  disabled={!linked}
                  onClick={async () => {
                    if (await confirm({ title: "Remove the picture?", message: "The number shows no picture.", confirmLabel: "Remove", danger: true })) profile.mutate({ picture: null });
                  }}
                >
                  Remove
                </Button>
              )}
            </div>
          </div>
          <SettingRow label="Name" info="Up to 25 letters. WhatsApp shows it to people who haven't saved the number." stack>
            <div className="flex flex-col sm:flex-row gap-2 max-w-lg">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={25} placeholder={info?.profile?.name ?? "The bot's name"} disabled={!linked} />
              <Button variant="secondary" size="sm" className="max-sm:h-10 sm:h-9" disabled={!linked || !name.trim()} loading={profile.isPending && !!profile.variables?.name} onClick={() => profile.mutate({ name: name.trim() })}>
                Change
              </Button>
            </div>
          </SettingRow>
          <SettingRow label="About" info="The line under the name. WhatsApp doesn't say what it is now, so this only sets it." stack>
            <div className="flex flex-col sm:flex-row gap-2 max-w-lg">
              <Input value={about} onChange={(e) => setAbout(e.target.value)} maxLength={139} placeholder="Available · iklipse" disabled={!linked} />
              <Button variant="secondary" size="sm" className="max-sm:h-10 sm:h-9" disabled={!linked || !about.trim()} loading={profile.isPending && profile.variables?.about !== undefined} onClick={() => profile.mutate({ about: about.trim() })}>
                Set
              </Button>
            </div>
          </SettingRow>
        </div>
      </Section>

      {/* ---------------------------------------------------- WhatsApp's limits */}
      <SettingGroup
        title="WhatsApp's limits on the number"
        info="What WhatsApp tells the bridge about this number. A cap or a restriction means WhatsApp thinks it writes to too many new people: slow down."
      >
        <SettingRow label="New chats this month" info="How many people it started a chat with, of what WhatsApp allows. No cap: WhatsApp hasn't set one.">
          <span className="text-sm text-ink inline-flex flex-wrap items-center gap-2">
            {capInfo ? <Badge tone={capInfo.tone}>{capInfo.text}</Badge> : <span className="text-muted">—</span>}
            {cap && (cap.total < 0 ? <span className="text-muted">No cap</span> : <span>{cap.used} of {cap.total}</span>)}
            {cap?.ends && cap.total >= 0 ? <span className="text-xs text-muted">until {day(cap.ends)}</span> : null}
          </span>
        </SettingRow>
        <SettingRow label="Restricted from reaching out">
          {lock?.active ? (
            <span className="text-sm inline-flex flex-wrap items-center gap-2">
              <Badge tone="danger">Restricted</Badge>
              {lock.ends ? <span className="text-xs text-muted">until {day(lock.ends)}</span> : null}
            </span>
          ) : (
            <Badge tone="success">No</Badge>
          )}
        </SettingRow>
      </SettingGroup>

      {/* ---------------------------------------------------- the bridge */}
      <Section
        title="The bridge"
        info="WAHA on iklipse's server (claude-vps). Restart it if messages stop coming; the number stays linked."
        action={
          <Button variant="ghost" size="sm" iconLeft={<RefreshCw size={14} />} loading={q.isFetching} onClick={() => void q.refetch()}>
            Refresh
          </Button>
        }
      >
        <div className="divide-y divide-line border-b border-line">
          <SettingRow label="Server">
            <span className="text-sm text-muted">
              {info?.server.version ? `WAHA ${info.server.version}` : "—"}
              {info?.server.engine ? ` · ${info.server.engine}` : ""}
            </span>
          </SettingRow>
          <SettingRow label="Last activity">
            <span className="text-sm text-muted">{info?.activity ? relativeTime(new Date(info.activity).toISOString()) : "—"}</span>
          </SettingRow>
          <SettingRow label="Its messages go to" info="Where the bridge sends what comes in. It should be iklipse; if not, send them here again.">
            <span className="text-sm inline-flex flex-wrap items-center gap-2">
              {info?.webhook ? (
                <>
                  <Badge tone={info.webhook.ours ? "success" : "danger"}>{info.webhook.ours ? "iklipse" : "Somewhere else"}</Badge>
                  <span className="text-xs text-muted">{info.webhook.events.join(", ")}</span>
                </>
              ) : (
                <Badge tone="danger">Nowhere</Badge>
              )}
              {(!info?.webhook || !info.webhook.ours) && (
                <Button variant="secondary" size="sm" loading={repoint.isPending} onClick={() => repoint.mutate()}>
                  Send them to iklipse
                </Button>
              )}
            </span>
          </SettingRow>
          <SettingRow label="Left out" info="What the bridge doesn't pass on: WhatsApp statuses (stories) and channels.">
            <span className="text-sm text-muted">
              {info?.ignore
                ? Object.entries(info.ignore)
                    .filter(([, v]) => v)
                    .map(([k]) => (k === "status" ? "Statuses" : k === "channels" ? "Channels" : k === "broadcast" ? "Broadcast lists" : k))
                    .join(", ") || "Nothing"
                : "—"}
            </span>
          </SettingRow>
          <div className="py-3 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<RotateCw size={14} />}
              className="max-sm:h-10"
              loading={restart.isPending}
              disabled={!info?.status}
              onClick={async () => {
                if (await confirm({ title: "Restart the bridge?", message: "It's off for a few seconds; messages that come meanwhile arrive after. The number stays linked.", confirmLabel: "Restart" }))
                  restart.mutate();
              }}
            >
              Restart
            </Button>
            <Button
              variant="ghost"
              size="sm"
              iconLeft={<Power size={14} />}
              className="max-sm:h-10"
              loading={stop.isPending}
              disabled={botUses || !info?.status || info.status === "STOPPED"}
              title={botUses ? "The bot uses this number: go back to Green API first" : undefined}
              onClick={async () => {
                if (await confirm({ title: "Stop the bridge?", message: "Nothing comes in or goes out on this number until it's started again. It stays linked.", confirmLabel: "Stop", danger: true }))
                  stop.mutate();
              }}
            >
              Stop
            </Button>
          </div>
        </div>
      </Section>
    </div>
  );
}

function pick(s: BridgeSettings): Draft {
  return Object.fromEntries(FIELDS.map((k) => [k, s[k]])) as unknown as Draft;
}
