import { useState } from "react";
import { ChevronDown, ChevronRight, Link2, MousePointerClick, Play, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Controls";
import { useToast } from "@/components/ui/Toast";
import { IconBtn, NumField, Section, Segmented, Select, TextField } from "@/components/design/fields";
import { prototypeUrl } from "@/components/design/PrototypePlayer";
import { cn } from "@/lib/cn";
import { isVirtual, shortId } from "@/lib/design/doc";
import { sortedChildren, type RNode } from "@/lib/design/layout";
import { patchSelection, resolved, tx, useDesign } from "@/lib/design/store";
import type { DesignDoc, DNode, Easing, Interaction, TransitionType, Trigger } from "@/lib/design/types";

// -----------------------------------------------------------------------------
// Right sidebar, "Prototype" tab. Nothing selected: the page's starting frame
// and Play. One layer selected: its interactions (trigger, action,
// destination, transition) and, for frames, how they scroll when played.
// Layers inside an instance get their interactions from the main component,
// so they're shown read-only with a way to jump there.
// -----------------------------------------------------------------------------

type Action = Interaction["action"];

const TRIGGERS: { value: Trigger; label: string }[] = [
  { value: "click", label: "On click" },
  { value: "hover", label: "On hover" },
  { value: "press", label: "On press" },
  { value: "delay", label: "After delay" },
];

const ACTIONS: { value: Action["type"]; label: string }[] = [
  { value: "navigate", label: "Navigate to" },
  { value: "overlay", label: "Open overlay" },
  { value: "back", label: "Back" },
  { value: "close-overlay", label: "Close overlay" },
  { value: "url", label: "Open link" },
];

const TRANSITIONS: { value: TransitionType; label: string }[] = [
  { value: "instant", label: "Instant" },
  { value: "dissolve", label: "Dissolve" },
  { value: "smart", label: "Smart animate (dissolve)" },
  { value: "slide-left", label: "Slide left" },
  { value: "slide-right", label: "Slide right" },
  { value: "slide-up", label: "Slide up" },
  { value: "slide-down", label: "Slide down" },
  { value: "push-left", label: "Push left" },
  { value: "push-right", label: "Push right" },
];

const EASINGS: { value: Easing; label: string }[] = [
  { value: "linear", label: "Linear" },
  { value: "ease-in", label: "Ease in" },
  { value: "ease-out", label: "Ease out" },
  { value: "ease-in-out", label: "Ease in and out" },
  { value: "spring", label: "Spring" },
];

const OVERFLOW: { value: NonNullable<DNode["overflow"]>; label: string }[] = [
  { value: "none", label: "No scrolling" },
  { value: "vertical", label: "Vertical" },
  { value: "horizontal", label: "Horizontal" },
  { value: "both", label: "Both directions" },
];

/** Frames a prototype can go to: the page's top-level frames and components. */
function screensOf(doc: DesignDoc, page: string): DNode[] {
  return sortedChildren(doc, null, page).filter((n) => n.type === "frame" || n.type === "component");
}

function label<T>(list: { value: T; label: string }[], v: T) {
  return list.find((x) => x.value === v)?.label ?? String(v);
}

function summary(it: Interaction, doc: DesignDoc): { trigger: string; action: string } {
  const trigger = it.trigger === "delay" ? `After ${it.delay ?? 800} ms` : label(TRIGGERS, it.trigger);
  const a = it.action;
  const name = (id: string) => (id ? (doc.nodes[id]?.name ?? "Missing frame") : "No destination");
  const action =
    a.type === "navigate"
      ? `Navigate to ${name(a.target)}`
      : a.type === "overlay"
        ? `Open ${name(a.target)}`
        : a.type === "url"
          ? a.url || "Open link"
          : label(ACTIONS, a.type);
  return { trigger, action };
}

export function PrototypePanel() {
  const doc = useDesign((s) => s.doc);
  const page = useDesign((s) => s.page);
  const selection = useDesign((s) => s.selection);
  const canEdit = useDesign((s) => s.canEdit);
  const { byId } = resolved(doc, page);

  if (selection.length === 0) return <StartPanel doc={doc} page={page} canEdit={canEdit} />;
  if (selection.length > 1)
    return (
      <div className="px-3 py-6 text-center text-xs text-muted">
        <MousePointerClick size={18} className="mx-auto mb-2 text-subtle" />
        Select one layer to see its interactions.
      </div>
    );
  const rid = selection[0]!;
  const n = byId.get(rid);
  if (!n) return null;
  return <LayerPanel key={rid} n={n} doc={doc} page={page} canEdit={canEdit} />;
}

// ---------------------------------------------------------- starting frame --
function StartPanel({ doc, page, canEdit }: { doc: DesignDoc; page: string; canEdit: boolean }) {
  const toast = useToast();
  const boardId = useDesign((s) => s.boardId);
  const frames = screensOf(doc, page);
  const pg = doc.data.pages.find((p) => p.id === page);
  const start = pg?.start && doc.nodes[pg.start] ? pg.start : "";
  const first = frames[0];

  const copyLink = async () => {
    if (!boardId) return;
    try {
      await navigator.clipboard.writeText(prototypeUrl(boardId, page, start || undefined));
      toast.push({ kind: "success", title: "Prototype link copied", description: "People with access to this board can open it." });
    } catch {
      toast.push({ kind: "error", title: "Couldn't copy the link" });
    }
  };

  return (
    <>
      <Section title="Starting frame">
        {frames.length === 0 ? (
          <p className="text-xs text-muted">Add a frame to this page to build a prototype.</p>
        ) : canEdit ? (
          <Select
            value={start}
            options={[{ value: "", label: `First frame${first ? ` (${first.name})` : ""}` }, ...frames.map((f) => ({ value: f.id, label: f.name }))]}
            onChange={(id) => setStart(page, id || null)}
          />
        ) : (
          <p className="text-xs text-ink truncate">{start ? doc.nodes[start]!.name : `First frame${first ? ` (${first.name})` : ""}`}</p>
        )}
        <p className="text-[11px] text-subtle leading-snug">Playback starts here. Select a layer to add interactions to it.</p>
      </Section>
      <div className="px-3 py-3 flex gap-2">
        <Button
          variant="primary"
          size="sm"
          className="flex-1"
          disabled={!frames.length}
          iconLeft={<Play size={14} />}
          onClick={() => useDesign.setState({ playing: true })}
        >
          Play
        </Button>
        {boardId && (
          <Button variant="secondary" size="sm" disabled={!frames.length} iconLeft={<Link2 size={14} />} onClick={() => void copyLink()} title="Copy prototype link">
            Link
          </Button>
        )}
      </div>
    </>
  );
}

function setStart(page: string, id: string | null) {
  tx("Set starting frame", (d) => d.setData((x) => ({ ...x, pages: x.pages.map((p) => (p.id === page ? { ...p, start: id } : p)) })));
}

// ------------------------------------------------------------------- layer --
function LayerPanel({ n, doc, page, canEdit }: { n: RNode; doc: DesignDoc; page: string; canEdit: boolean }) {
  const virtual = isVirtual(n.rid);
  const editable = canEdit && !virtual;
  const list = n.interactions ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const frames = screensOf(doc, page);
  const isScreen = !virtual && n.parent === null && (n.type === "frame" || n.type === "component");
  const pg = doc.data.pages.find((p) => p.id === page);

  const save = (next: Interaction[]) => patchSelection("Edit interaction", { interactions: next.length ? next : undefined }, [n.rid]);

  const add = () => {
    const target = frames.find((f) => f.id !== n.id && f.id !== topFrameOf(doc, n.id))?.id ?? "";
    const it: Interaction = {
      id: shortId(),
      trigger: "click",
      action: { type: "navigate", target },
      transition: { type: "instant", duration: 300, easing: "ease-out" },
    };
    save([...list, it]);
    setOpen(it.id);
  };

  // A layer inside an instance: the component's layer is the one to edit.
  const source = virtual ? n.rid.split("/").pop()! : null;
  const sourceNode = source ? doc.nodes[source] : undefined;

  return (
    <>
      <Section title="Interactions" action={editable ? <IconBtn title="Add interaction" onClick={add}><Plus size={14} /></IconBtn> : undefined}>
        {virtual && (
          <div className="rounded bg-inset px-2 py-1.5 text-[11px] text-muted leading-snug">
            This layer is part of an instance. Its interactions come from the main component, so edit them there.
            {sourceNode && (
              <button
                type="button"
                className="block mt-1 text-accent hover:underline"
                onClick={() => useDesign.setState({ page: sourceNode.page, selection: [sourceNode.id], editingText: null })}
              >
                Go to main component
              </button>
            )}
          </div>
        )}
        {list.length === 0 ? (
          !virtual && <p className="text-xs text-muted">{editable ? "No interactions yet. Add one with +." : "No interactions."}</p>
        ) : (
          <ul className="space-y-1">
            {list.map((it) => (
              <InteractionRow
                key={it.id}
                it={it}
                doc={doc}
                frames={frames}
                open={editable && open === it.id}
                editable={editable}
                onToggle={() => setOpen((o) => (o === it.id ? null : it.id))}
                onChange={(v) => save(list.map((x) => (x.id === it.id ? v : x)))}
                onDelete={() => save(list.filter((x) => x.id !== it.id))}
              />
            ))}
          </ul>
        )}
      </Section>

      {isScreen && (
        <Section title="Starting frame">
          <div className="flex items-center justify-between gap-2 h-7">
            <span className="text-xs text-ink">Start the prototype here</span>
            <Switch
              label="Starting frame"
              checked={pg?.start === n.id}
              disabled={!canEdit}
              onChange={(on) => setStart(page, on ? n.id : null)}
            />
          </div>
        </Section>
      )}

      {!virtual && (n.type === "frame" || n.type === "component") && (
        <Section title="Scrolling">
          {canEdit ? (
            <Select
              value={n.overflow ?? "none"}
              options={OVERFLOW}
              onChange={(v) => patchSelection("Scroll behaviour", { overflow: v === "none" ? undefined : v }, [n.rid])}
            />
          ) : (
            <p className="text-xs text-ink">{label(OVERFLOW, n.overflow ?? "none")}</p>
          )}
          <p className="text-[11px] text-subtle leading-snug">
            When played, a frame taller (or wider) than a device of its size scrolls inside a device-sized window.
          </p>
        </Section>
      )}

      {canEdit && (
        <div className="px-3 py-3">
          <Button variant="secondary" size="sm" className="w-full" iconLeft={<Play size={14} />} onClick={() => useDesign.setState({ playing: true })}>
            Play
          </Button>
        </div>
      )}
    </>
  );
}

/** The top-level frame a layer is in (it can't navigate to itself by default). */
function topFrameOf(doc: DesignDoc, id: string): string | null {
  let cur = doc.nodes[id];
  let guard = 0;
  while (cur?.parent && guard++ < 200) cur = doc.nodes[cur.parent];
  return cur?.id ?? null;
}

// ------------------------------------------------------------- interaction --
function InteractionRow({
  it,
  doc,
  frames,
  open,
  editable,
  onToggle,
  onChange,
  onDelete,
}: {
  it: Interaction;
  doc: DesignDoc;
  frames: DNode[];
  open: boolean;
  editable: boolean;
  onToggle: () => void;
  onChange: (v: Interaction) => void;
  onDelete: () => void;
}) {
  const s = summary(it, doc);
  const a = it.action;
  const broken = (a.type === "navigate" || a.type === "overlay") && (!a.target || !doc.nodes[a.target]);

  const setAction = (type: Action["type"]) => {
    const target = a.type === "navigate" || a.type === "overlay" ? a.target : (frames[0]?.id ?? "");
    const next: Action =
      type === "navigate"
        ? { type, target }
        : type === "overlay"
          ? { type, target, position: "center", closeOnOutside: true }
          : type === "url"
            ? { type, url: a.type === "url" ? a.url : "https://" }
            : { type };
    onChange({ ...it, action: next });
  };

  // Destinations: the page's frames, plus the current one if it lives elsewhere.
  const destOptions = [
    { value: "", label: "Choose a frame…" },
    ...frames.map((f) => ({ value: f.id, label: f.name })),
    ...((a.type === "navigate" || a.type === "overlay") && a.target && !frames.some((f) => f.id === a.target)
      ? [{ value: a.target, label: doc.nodes[a.target]?.name ?? "Missing frame" }]
      : []),
  ];
  const hasTransition = a.type === "navigate" || a.type === "overlay";

  return (
    <li className={cn("rounded border", open ? "border-border bg-surface" : "border-transparent bg-inset")}>
      <div className="flex items-center gap-1 pl-1 pr-0.5 min-h-8 py-1">
        {editable ? (
          <button type="button" onClick={onToggle} className="flex-1 min-w-0 flex items-center gap-1 text-left" aria-expanded={open}>
            {open ? <ChevronDown size={13} className="shrink-0 text-subtle" /> : <ChevronRight size={13} className="shrink-0 text-subtle" />}
            <Summary s={s} broken={broken} />
          </button>
        ) : (
          <div className="flex-1 min-w-0 flex items-center gap-1 pl-1">
            <Summary s={s} broken={broken} />
          </div>
        )}
        {editable && (
          <IconBtn title="Delete interaction" onClick={onDelete}>
            <Trash2 size={13} />
          </IconBtn>
        )}
      </div>

      {open && (
        <div className="px-2 pb-2 pt-0.5 space-y-1.5">
          <Row label="Trigger">
            <Select value={it.trigger} options={TRIGGERS} onChange={(v) => onChange({ ...it, trigger: v, delay: v === "delay" ? (it.delay ?? 800) : undefined })} />
          </Row>
          {it.trigger === "delay" && (
            <Row label="Delay">
              <NumField value={it.delay ?? 800} min={0} max={60_000} step={50} suffix="ms" onChange={(v) => onChange({ ...it, delay: Math.round(v) })} />
            </Row>
          )}
          <Row label="Action">
            <Select value={a.type} options={ACTIONS} onChange={setAction} />
          </Row>
          {(a.type === "navigate" || a.type === "overlay") && (
            <Row label="To">
              <Select value={a.target} options={destOptions} onChange={(v) => onChange({ ...it, action: { ...a, target: v } })} />
            </Row>
          )}
          {a.type === "overlay" && (
            <>
              <Row label="Position">
                <Segmented
                  value={a.position ?? "center"}
                  options={[
                    { value: "top", label: "Top", title: "Top" },
                    { value: "center", label: "Center", title: "Center" },
                    { value: "bottom", label: "Bottom", title: "Bottom" },
                  ]}
                  onChange={(v) => onChange({ ...it, action: { ...a, position: v } })}
                />
              </Row>
              <div className="flex items-center justify-between gap-2 h-7 pl-14">
                <span className="text-[11px] text-muted">Close when clicking outside</span>
                <Switch
                  label="Close when clicking outside"
                  checked={a.closeOnOutside !== false}
                  onChange={(v) => onChange({ ...it, action: { ...a, closeOnOutside: v } })}
                />
              </div>
            </>
          )}
          {a.type === "url" && (
            <Row label="URL">
              <TextField value={a.url} placeholder="https://" onChange={(v) => onChange({ ...it, action: { type: "url", url: v.trim() } })} />
            </Row>
          )}
          {hasTransition && (
            <>
              <Row label="Animation">
                <Select
                  value={it.transition.type}
                  options={TRANSITIONS}
                  onChange={(v) => onChange({ ...it, transition: { ...it.transition, type: v, duration: it.transition.duration || 300 } })}
                />
              </Row>
              {it.transition.type !== "instant" && (
                <>
                  <Row label="Duration">
                    <NumField
                      value={it.transition.duration}
                      min={0}
                      max={10_000}
                      step={10}
                      suffix="ms"
                      onChange={(v) => onChange({ ...it, transition: { ...it.transition, duration: Math.round(v) } })}
                    />
                  </Row>
                  <Row label="Easing">
                    <Select value={it.transition.easing} options={EASINGS} onChange={(v) => onChange({ ...it, transition: { ...it.transition, easing: v } })} />
                  </Row>
                </>
              )}
            </>
          )}
          {a.type === "back" && <p className="text-[11px] text-subtle leading-snug pl-14">Closes the top overlay, or goes back to the previous frame.</p>}
        </div>
      )}
    </li>
  );
}

function Summary({ s, broken }: { s: { trigger: string; action: string }; broken: boolean }) {
  return (
    <span className="min-w-0 flex-1 leading-tight">
      <span className="block text-[11px] text-subtle truncate">{s.trigger}</span>
      <span className={cn("block text-xs truncate", broken ? "text-danger" : "text-ink")}>{s.action}</span>
    </span>
  );
}

function Row({ label: text, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[11px] text-muted">{text}</span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
