import { useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, CheckSquare, Clock, Paperclip, Search, Tag, User, X } from "lucide-react";
import type { Card, Label as LabelT, Profile } from "@/lib/database.types";
import { Avatar } from "@/components/ui/Avatar";
import { supabase } from "@/lib/supabase";
import { between } from "@/lib/lexorank";
import { useToast } from "@/components/ui/Toast";
import { DatesPanel } from "@/components/pm/card/DatesPanel";
import { cn } from "@/lib/cn";

// -----------------------------------------------------------------------------
// CardActionPanel — the content of every card popover (Trello's "+ Add" menu
// and the Labels / Dates / Checklist / Members / Attachment buttons). One
// component with internal views, so "+ Add → Labels" can step into the labels
// view with a back arrow instead of stacking popovers.
// -----------------------------------------------------------------------------

export type ActionView = "add" | "labels" | "dates" | "checklist" | "members" | "attachment";

const LABEL_COLORS = ["#4bce97", "#f5cd47", "#fea362", "#f87168", "#9f8fef", "#579dff", "#6cc3e0", "#94c748", "#e774bb", "#8590a2"];

interface Props {
  initial: ActionView;
  close: () => void;
  card: Card;
  boardId: string;
  boardLabels: LabelT[];
  boardMembers: Profile[];
  labelIds: string[];
  memberIds: string[];
  perms: { labels: boolean; members: boolean; dates: boolean; checklists: boolean; attachments: boolean; createLabels: boolean };
  onToggleLabel: (id: string, on: boolean) => void;
  onToggleMember: (uid: string, on: boolean) => void;
  onSaveDates: (v: { start_date: string | null; due_date: string | null }) => void;
  onRemoveDates: () => void;
  onAddChecklist: (name: string) => void;
  onUploadFiles: (files: FileList) => void;
  onAddLink: (url: string, text: string) => Promise<void>;
}

export function CardActionPanel(p: Props) {
  const [view, setView] = useState<ActionView>(p.initial);
  const fromAdd = p.initial === "add" && view !== "add";
  const titles: Record<ActionView, string> = {
    add: "Add to card",
    labels: "Labels",
    dates: "Dates",
    checklist: "Add checklist",
    members: "Members",
    attachment: "Attach",
  };

  return (
    <div className="w-[304px] max-w-[calc(100vw-1rem)]">
      <div className="relative flex items-center justify-center h-10 px-10">
        {fromAdd && (
          <button
            type="button"
            onClick={() => setView("add")}
            aria-label="Back"
            className="absolute left-2 grid place-items-center w-7 h-7 rounded-md text-muted hover:bg-inset hover:text-ink"
          >
            <ArrowLeft size={16} />
          </button>
        )}
        <div className="text-sm font-semibold text-muted">{titles[view]}</div>
        <button
          type="button"
          onClick={p.close}
          aria-label="Close"
          className="absolute right-2 grid place-items-center w-7 h-7 rounded-md text-muted hover:bg-inset hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>

      {view === "add" && (
        <div className="pb-2">
          <AddItem icon={<Tag size={16} />} title="Labels" hint="Organize, categorize, and prioritize" disabled={!p.perms.labels} onClick={() => setView("labels")} />
          <AddItem icon={<Clock size={16} />} title="Dates" hint="Start dates and due dates" disabled={!p.perms.dates} onClick={() => setView("dates")} />
          <AddItem icon={<CheckSquare size={16} />} title="Checklist" hint="Add subtasks" disabled={!p.perms.checklists} onClick={() => setView("checklist")} />
          <AddItem icon={<User size={16} />} title="Members" hint="Assign members" disabled={!p.perms.members} onClick={() => setView("members")} />
          <AddItem icon={<Paperclip size={16} />} title="Attachment" hint="Add files and links" disabled={!p.perms.attachments} onClick={() => setView("attachment")} />
        </div>
      )}

      {view === "labels" && <LabelsView {...p} />}
      {view === "members" && <MembersView {...p} />}
      {view === "dates" && (
        <DatesPanel
          startDate={p.card.start_date}
          dueDate={p.card.due_date}
          onSave={(v) => {
            p.onSaveDates(v);
            p.close();
          }}
          onRemove={() => {
            p.onRemoveDates();
            p.close();
          }}
        />
      )}
      {view === "checklist" && <ChecklistView {...p} />}
      {view === "attachment" && <AttachmentView {...p} />}
    </div>
  );
}

function AddItem({ icon, title, hint, onClick, disabled }: { icon: ReactNode; title: string; hint: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-inset transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <span className="grid place-items-center w-9 h-9 shrink-0 rounded-md border border-border bg-inset text-muted">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm text-ink">{title}</span>
        <span className="block text-xs text-subtle">{hint}</span>
      </span>
    </button>
  );
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="mx-3 mb-2 flex items-center gap-2 rounded-md border border-rule bg-inset px-2 h-9 focus-within:border-accent">
      <Search size={14} className="text-subtle shrink-0" />
      <input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 min-w-0 bg-transparent outline-none text-sm text-ink placeholder:text-subtle"
      />
    </div>
  );
}

function LabelsView(p: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(LABEL_COLORS[0]!);
  const shown = p.boardLabels.filter((l) => (l.name || "").toLowerCase().includes(q.trim().toLowerCase()));

  const create = async () => {
    const last = [...p.boardLabels].sort((a, b) => (a.position < b.position ? -1 : 1)).at(-1)?.position ?? null;
    const { data, error } = await supabase
      .from("label")
      .insert({ board_id: p.boardId, name: name.trim(), color, position: between(last, null) })
      .select("id")
      .single();
    if (error) {
      toast.push({ kind: "error", title: "Couldn't create label", description: error.message });
      return;
    }
    await qc.invalidateQueries({ queryKey: ["board", p.boardId] });
    p.onToggleLabel((data as { id: string }).id, true);
    setCreating(false);
    setName("");
  };

  if (creating) {
    return (
      <div className="px-3 pb-3 space-y-3">
        <div className="h-9 rounded-md grid place-items-center text-sm font-medium text-white" style={{ background: color }}>
          {name || " "}
        </div>
        <div>
          <div className="text-xs font-semibold text-subtle mb-1">Title</div>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void create()}
            className="w-full h-9 rounded-md border border-rule bg-inset px-2 text-sm text-ink outline-none focus:border-accent"
          />
        </div>
        <div>
          <div className="text-xs font-semibold text-subtle mb-1">Select a color</div>
          <div className="grid grid-cols-5 gap-1.5">
            {LABEL_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={cn("h-8 rounded-md", color === c && "ring-2 ring-offset-2 ring-offset-surface ring-accent")}
                style={{ background: c }}
                aria-label={c}
              />
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => void create()} className="flex-1 h-9 rounded-md bg-accent text-white text-sm font-semibold hover:bg-accent-hover">
            Create
          </button>
          <button type="button" onClick={() => setCreating(false)} className="h-9 px-3 rounded-md text-sm text-muted hover:bg-inset">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pb-3">
      <SearchBox value={q} onChange={setQ} placeholder="Search labels…" />
      <div className="px-3 text-xs font-semibold text-subtle mb-1">Labels</div>
      <div className="px-3 space-y-1 max-h-64 overflow-y-auto">
        {shown.map((l) => {
          const on = p.labelIds.includes(l.id);
          return (
            <label key={l.id} className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" className="accent-accent w-4 h-4" checked={on} onChange={() => p.onToggleLabel(l.id, !on)} />
              <span className="flex-1 h-8 rounded-md px-2.5 flex items-center text-sm font-medium text-white truncate hover:opacity-90" style={{ background: l.color }}>
                {l.name || " "}
              </span>
            </label>
          );
        })}
        {shown.length === 0 && <div className="text-sm text-subtle py-1">No labels.</div>}
      </div>
      {p.perms.createLabels && (
        <div className="px-3 mt-3">
          <button type="button" onClick={() => setCreating(true)} className="w-full h-9 rounded-md bg-inset text-sm text-ink hover:bg-line transition-colors">
            Create a new label
          </button>
        </div>
      )}
    </div>
  );
}

function MembersView(p: Props) {
  const [q, setQ] = useState("");
  const ql = q.trim().toLowerCase();
  const shown = p.boardMembers.filter((m) => m.display_name.toLowerCase().includes(ql) || m.username.toLowerCase().includes(ql));
  const onCard = shown.filter((m) => p.memberIds.includes(m.id));
  const rest = shown.filter((m) => !p.memberIds.includes(m.id));
  const row = (m: Profile, on: boolean) => (
    <button
      key={m.id}
      type="button"
      onClick={() => p.onToggleMember(m.id, !on)}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-inset transition-colors"
    >
      <Avatar name={m.display_name} src={m.avatar_url} size={28} />
      <span className="flex-1 min-w-0 text-sm text-ink truncate">{m.display_name}</span>
      {on && <Check size={14} className="text-accent" />}
    </button>
  );
  return (
    <div className="pb-2">
      <SearchBox value={q} onChange={setQ} placeholder="Search members" />
      <div className="max-h-72 overflow-y-auto">
        {onCard.length > 0 && (
          <>
            <div className="px-3 pt-1 text-xs font-semibold text-subtle">Card members</div>
            {onCard.map((m) => row(m, true))}
          </>
        )}
        {rest.length > 0 && (
          <>
            <div className="px-3 pt-2 text-xs font-semibold text-subtle">Board members</div>
            {rest.map((m) => row(m, false))}
          </>
        )}
        {shown.length === 0 && <div className="px-3 py-1 text-sm text-subtle">No members.</div>}
      </div>
    </div>
  );
}

function ChecklistView(p: Props) {
  const [name, setName] = useState("Checklist");
  const add = () => {
    if (!name.trim()) return;
    p.onAddChecklist(name.trim());
    p.close();
  };
  return (
    <div className="px-3 pb-3 space-y-2">
      <div className="text-xs font-semibold text-subtle">Title</div>
      <input
        autoFocus
        value={name}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && add()}
        className="w-full h-9 rounded-md border border-rule bg-inset px-2 text-sm text-ink outline-none focus:border-accent"
      />
      <button type="button" onClick={add} className="h-9 px-4 rounded-md bg-accent text-white text-sm font-semibold hover:bg-accent-hover">
        Add
      </button>
    </div>
  );
}

function AttachmentView(p: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const insert = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      await p.onAddLink(url, text);
      p.close();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="px-3 pb-3 space-y-3">
      <div>
        <div className="text-xs font-semibold text-subtle mb-1">Attach a file from your computer</div>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="w-full h-9 rounded-md bg-inset text-sm text-ink hover:bg-line transition-colors"
        >
          Choose a file
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) {
              p.onUploadFiles(e.target.files);
              p.close();
            }
            e.target.value = "";
          }}
        />
      </div>
      <div className="h-px bg-line" />
      <div>
        <div className="text-xs font-semibold text-subtle mb-1">Search or paste a link</div>
        <input
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void insert()}
          placeholder="https://…"
          className="w-full h-9 rounded-md border border-rule bg-inset px-2 text-sm text-ink outline-none focus:border-accent"
        />
      </div>
      <div>
        <div className="text-xs font-semibold text-subtle mb-1">Display text (optional)</div>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void insert()}
          placeholder="Text to display"
          className="w-full h-9 rounded-md border border-rule bg-inset px-2 text-sm text-ink outline-none focus:border-accent"
        />
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={p.close} className="h-9 px-3 rounded-md text-sm text-muted hover:bg-inset">
          Cancel
        </button>
        <button
          type="button"
          disabled={!url.trim() || busy}
          onClick={() => void insert()}
          className="h-9 px-4 rounded-md bg-accent text-white text-sm font-semibold hover:bg-accent-hover disabled:opacity-50"
        >
          Insert
        </button>
      </div>
    </div>
  );
}
