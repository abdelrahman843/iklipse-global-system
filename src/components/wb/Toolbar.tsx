import { useRef, useState, type ReactNode } from "react";
import {
  MousePointer2,
  Hand,
  LayoutTemplate,
  Type,
  StickyNote,
  Shapes,
  Spline,
  PenTool,
  Highlighter,
  Eraser,
  Frame,
  MessageCircle,
  CreditCard,
  FileText,
  Stamp,
  ImagePlus,
  Undo2,
  Redo2,
  Minus,
  MoveRight,
  CornerDownRight,
  Link2,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useWb, setTool, setToolOpts, undo, redo, viewCenter, commit } from "@/lib/wb/store";
import { withFrameMembership } from "@/lib/wb/actions";
import { makeEmbed } from "@/lib/wb/factory";
import { asLink } from "@/lib/wb/embed";
import { SHAPES, shapePath } from "@/lib/wb/shapes";
import { cssColor, type Cap, type ConnectorKind, type Tool } from "@/lib/wb/types";
import { Swatches, STICKY_COLORS } from "./Swatches";
import { insertImages } from "./useWbKeys";

// -----------------------------------------------------------------------------
// Creation toolbar, Miro layout: a floating column on the left (a scrollable
// row along the bottom on phones). Tools with options open a flyout beside it.
// -----------------------------------------------------------------------------

const S = useWb.getState;

const STAMPS = ["👍", "👎", "❤️", "🎉", "🔥", "⭐", "✅", "❌", "❓", "💡", "👀", "🚀", "😀", "😂", "😍", "🤔", "😮", "😢", "🙏", "👏", "💯", "📌", "⚠️", "🏆"];
const PEN_COLORS = ["ink", "#f87168", "#579dff", "#4bce97", "#f5cd47", "#9f8fef", "#fea362", "#8590a2"];
const FRAME_PRESETS: { label: string; w: number; h: number }[] = [
  { label: "16:9", w: 1280, h: 720 },
  { label: "4:3", w: 1024, h: 768 },
  { label: "1:1", w: 800, h: 800 },
  { label: "A4", w: 794, h: 1123 },
  { label: "Letter", w: 816, h: 1056 },
  { label: "Phone", w: 390, h: 844 },
  { label: "Tablet", w: 834, h: 1194 },
  { label: "Desktop", w: 1440, h: 1024 },
];

function ToolButton({
  active,
  onClick,
  label,
  shortcut,
  children,
  disabled,
}: {
  active?: boolean;
  onClick: () => void;
  label: string;
  shortcut?: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "h-10 w-10 shrink-0 grid place-items-center rounded-md transition-colors",
        active ? "bg-accent-soft text-accent" : "text-muted hover:bg-inset hover:text-ink",
        "disabled:opacity-40 disabled:hover:bg-transparent",
      )}
    >
      {children}
    </button>
  );
}

function Flyout({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div
      data-wb-ui
      className={cn(
        "absolute z-30 bg-surface border border-border rounded-lg shadow-raise p-3 animate-menu-in",
        // Beside the column on desktop; on phones a sheet above the tool row
        // (fixed, so the scrolling row doesn't clip it).
        "max-md:fixed max-md:left-2 max-md:right-2 max-md:bottom-[calc(7.75rem+env(safe-area-inset-bottom))] max-md:overflow-x-auto md:left-full md:ml-2 md:top-0",
      )}
    >
      <div className="eyebrow text-subtle text-xs mb-2">{title}</div>
      {children}
    </div>
  );
}

export function Toolbar({ onTemplates }: { onTemplates: () => void }) {
  const tool = useWb((s) => s.tool);
  const opts = useWb((s) => s.toolOpts);
  const canEdit = useWb((s) => s.canEdit);
  const canComment = useWb((s) => s.canComment);
  const canUndo = useWb((s) => s.past.length > 0);
  const canRedo = useWb((s) => s.future.length > 0);
  // The slides view's rail takes the left edge.
  const slideMode = useWb((s) => s.slideMode);
  const [flyout, setFlyout] = useState<Tool | "link" | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const pick = (t: Tool, hasFlyout = false) => {
    if (tool === t && hasFlyout) setFlyout(flyout === t ? null : t);
    else setFlyout(hasFlyout ? t : null);
    setTool(t);
  };
  const isPen = tool === "pen" || tool === "highlighter" || tool === "eraser";

  return (
    <div
      data-wb-ui
      className={cn(
        "absolute z-20 bg-surface border border-border rounded-lg shadow-pop flex p-1 gap-0.5",
        slideMode ? "md:left-[236px]" : "md:left-3",
        "md:top-1/2 md:-translate-y-1/2 md:flex-col",
        "max-md:left-2 max-md:right-2 max-md:bottom-2 max-md:overflow-x-auto max-md:[scrollbar-width:none]",
      )}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="relative flex md:flex-col gap-0.5">
        <ToolButton active={tool === "select"} onClick={() => pick("select")} label="Select">
          <MousePointer2 size={18} />
        </ToolButton>
        <ToolButton active={tool === "hand"} onClick={() => pick("hand")} label="Hand">
          <Hand size={18} />
        </ToolButton>
      </div>

      {canEdit && (
        <>
          <Divider />
          <ToolButton onClick={onTemplates} label="Templates">
            <LayoutTemplate size={18} />
          </ToolButton>
          <ToolButton active={tool === "text"} onClick={() => pick("text")} label="Text">
            <Type size={18} />
          </ToolButton>

          <div className="relative">
            <ToolButton active={tool === "sticky"} onClick={() => pick("sticky", true)} label="Sticky note">
              <span className="relative">
                <StickyNote size={18} />
                <span className="absolute -right-1 -bottom-1 h-2 w-2 rounded-full ring-1 ring-surface" style={{ background: cssColor(opts.stickyColor) }} />
              </span>
            </ToolButton>
            {flyout === "sticky" && tool === "sticky" && (
              <Flyout title="Sticky notes">
                <Swatches
                  value={opts.stickyColor}
                  colors={STICKY_COLORS}
                  columns={7}
                  onChange={(c) => {
                    setToolOpts({ stickyColor: c });
                    setFlyout(null);
                  }}
                />
              </Flyout>
            )}
          </div>

          <div className="relative">
            <ToolButton active={tool === "shape"} onClick={() => pick("shape", true)} label="Shapes">
              <Shapes size={18} />
            </ToolButton>
            {flyout === "shape" && tool === "shape" && (
              <Flyout title="Shapes">
                <div className="grid grid-cols-5 gap-1 w-[220px]">
                  {SHAPES.map((sh) => (
                    <button
                      key={sh.kind}
                      title={sh.label}
                      aria-label={sh.label}
                      onClick={() => {
                        setToolOpts({ shape: sh.kind });
                        setFlyout(null);
                      }}
                      className={cn("h-10 w-10 grid place-items-center rounded-md hover:bg-inset", opts.shape === sh.kind && "bg-accent-soft")}
                    >
                      <svg width="24" height="24" viewBox="-2 -2 28 28" className="overflow-visible">
                        <path d={shapePath(sh.kind, 24, 24)} fill="none" stroke="rgb(var(--c-ink))" strokeWidth="1.6" strokeLinejoin="round" />
                      </svg>
                    </button>
                  ))}
                </div>
              </Flyout>
            )}
          </div>

          <div className="relative">
            <ToolButton active={tool === "connector"} onClick={() => pick("connector", true)} label="Connection line">
              <Spline size={18} />
            </ToolButton>
            {flyout === "connector" && tool === "connector" && (
              <Flyout title="Lines">
                <div className="flex gap-1 mb-2">
                  {(
                    [
                      ["straight", <Minus key="s" size={18} className="-rotate-45" />, "Straight"],
                      ["elbow", <CornerDownRight key="e" size={18} />, "Elbowed"],
                      ["curved", <Spline key="c" size={18} />, "Curved"],
                    ] as [ConnectorKind, ReactNode, string][]
                  ).map(([k, icon, label]) => (
                    <button
                      key={k}
                      title={label}
                      aria-label={label}
                      onClick={() => setToolOpts({ connectorKind: k })}
                      className={cn("h-9 w-9 grid place-items-center rounded-md hover:bg-inset text-ink", opts.connectorKind === k && "bg-accent-soft text-accent")}
                    >
                      {icon}
                    </button>
                  ))}
                </div>
                <div className="flex gap-1">
                  {(
                    [
                      ["none", <Minus key="n" size={18} />, "No arrow"],
                      ["arrow", <MoveRight key="a" size={18} />, "Arrow"],
                    ] as [Cap, ReactNode, string][]
                  ).map(([c, icon, label]) => (
                    <button
                      key={c}
                      title={label}
                      aria-label={label}
                      onClick={() => setToolOpts({ endCap: c })}
                      className={cn("h-9 w-9 grid place-items-center rounded-md hover:bg-inset text-ink", opts.endCap === c && "bg-accent-soft text-accent")}
                    >
                      {icon}
                    </button>
                  ))}
                </div>
              </Flyout>
            )}
          </div>

          <div className="relative">
            <ToolButton active={isPen} onClick={() => pick(isPen ? tool : "pen", true)} label="Pen">
              {tool === "highlighter" ? <Highlighter size={18} /> : tool === "eraser" ? <Eraser size={18} /> : <PenTool size={18} />}
            </ToolButton>
            {flyout && isPen && (
              <Flyout title="Draw">
                <div className="flex gap-1 mb-3">
                  {(
                    [
                      ["pen", <PenTool key="p" size={18} />, "Pen"],
                      ["highlighter", <Highlighter key="h" size={18} />, "Highlighter"],
                      ["eraser", <Eraser key="e" size={18} />, "Eraser"],
                    ] as [Tool, ReactNode, string][]
                  ).map(([t, icon, label]) => (
                    <button
                      key={t}
                      title={label}
                      aria-label={label}
                      onClick={() => {
                        setTool(t);
                        setFlyout(t);
                      }}
                      className={cn("h-9 w-9 grid place-items-center rounded-md hover:bg-inset text-ink", tool === t && "bg-accent-soft text-accent")}
                    >
                      {icon}
                    </button>
                  ))}
                </div>
                {tool !== "eraser" && (
                  <>
                    <Swatches
                      value={tool === "highlighter" ? opts.highlighterColor : opts.penColor}
                      colors={PEN_COLORS}
                      columns={8}
                      size={22}
                      onChange={(c) => setToolOpts(tool === "highlighter" ? { highlighterColor: c } : { penColor: c })}
                    />
                    {tool === "pen" && (
                      <div className="flex items-center gap-1 mt-3">
                        {[2, 3, 6, 10].map((w) => (
                          <button
                            key={w}
                            title={`${w}px`}
                            aria-label={`Width ${w}`}
                            onClick={() => setToolOpts({ penWidth: w })}
                            className={cn("h-8 w-8 grid place-items-center rounded-md hover:bg-inset", opts.penWidth === w && "bg-accent-soft")}
                          >
                            <span className="rounded-full bg-ink" style={{ width: w + 2, height: w + 2 }} />
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </Flyout>
            )}
          </div>

          <div className="relative">
            <ToolButton active={tool === "frame"} onClick={() => pick("frame", true)} label="Frame">
              <Frame size={18} />
            </ToolButton>
            {flyout === "frame" && tool === "frame" && (
              <Flyout title="Frame size">
                <p className="text-xs text-subtle mb-2 max-w-[200px]">Drag on the board for any size, or click to drop one of these.</p>
                <div className="grid grid-cols-2 gap-1 w-[200px]">
                  {FRAME_PRESETS.map((f) => (
                    <button
                      key={f.label}
                      onClick={() => {
                        setToolOpts({ frame: { w: f.w, h: f.h } });
                        setFlyout(null);
                      }}
                      className={cn(
                        "h-8 px-2 rounded-md text-sm text-left hover:bg-inset text-ink",
                        opts.frame.w === f.w && opts.frame.h === f.h && "bg-accent-soft text-accent",
                      )}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </Flyout>
            )}
          </div>
        </>
      )}

      {canComment && (
        <ToolButton active={tool === "comment"} onClick={() => pick("comment")} label="Comment">
          <MessageCircle size={18} />
        </ToolButton>
      )}

      {canEdit && (
        <>
          <ToolButton active={tool === "card"} onClick={() => pick("card")} label="Card">
            <CreditCard size={18} />
          </ToolButton>
          <ToolButton active={tool === "doc"} onClick={() => pick("doc")} label="Doc">
            <FileText size={18} />
          </ToolButton>
          <div className="relative">
            <ToolButton active={tool === "emoji"} onClick={() => pick("emoji", true)} label="Stamps and emoji">
              <Stamp size={18} />
            </ToolButton>
            {flyout === "emoji" && tool === "emoji" && (
              <Flyout title="Stamps">
                <div className="grid grid-cols-6 gap-1 w-[228px]">
                  {STAMPS.map((em) => (
                    <button
                      key={em}
                      onClick={() => {
                        setToolOpts({ emoji: em });
                        setFlyout(null);
                      }}
                      className={cn("h-9 w-9 text-xl rounded-md hover:bg-inset", opts.emoji === em && "bg-accent-soft")}
                    >
                      {em}
                    </button>
                  ))}
                </div>
              </Flyout>
            )}
          </div>
          <div className="relative">
            <ToolButton active={flyout === "link"} onClick={() => setFlyout(flyout === "link" ? null : "link")} label="Embed a link">
              <Link2 size={18} />
            </ToolButton>
            {flyout === "link" && <LinkFlyout onDone={() => setFlyout(null)} />}
          </div>
          <ToolButton onClick={() => fileRef.current?.click()} label="Upload image">
            <ImagePlus size={18} />
          </ToolButton>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              if (files.length) void insertImages(files, viewCenter(S()));
            }}
          />
          <Divider />
          <ToolButton onClick={undo} label="Undo" shortcut="Ctrl+Z" disabled={!canUndo}>
            <Undo2 size={18} />
          </ToolButton>
          <ToolButton onClick={redo} label="Redo" shortcut="Ctrl+Shift+Z" disabled={!canRedo}>
            <Redo2 size={18} />
          </ToolButton>
        </>
      )}
    </div>
  );
}

/** Paste a link: videos and posts play on the board, other links become link cards. */
function LinkFlyout({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState("");
  const ok = !!asLink(url);
  const add = () => {
    if (!ok) return;
    const c = viewCenter(S());
    const it = makeEmbed(c.x, c.y, url.trim());
    commit(withFrameMembership({ [it.id]: it }), { select: [it.id] });
    setTool("select");
    onDone();
  };
  return (
    <Flyout title="Embed a link">
      <form
        className="w-[260px] max-md:w-full"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          autoFocus
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onDone()}
          placeholder="https://"
          aria-label="Link"
          className="w-full h-9 px-2.5 rounded-md bg-inset border border-border text-sm text-ink placeholder:text-subtle outline-none focus:border-accent"
        />
        <p className="text-xs text-subtle mt-2">YouTube, Instagram, TikTok, Vimeo, Facebook, Loom and Google Drive play right on the board. Tip: you can also paste a link straight onto the board.</p>
        <button
          type="submit"
          disabled={!ok}
          className="mt-2 h-8 w-full rounded-md bg-accent text-white text-sm font-medium hover:bg-accent-hover disabled:opacity-40 disabled:hover:bg-accent"
        >
          Add to board
        </button>
      </form>
    </Flyout>
  );
}

function Divider() {
  return <div className="shrink-0 bg-line md:h-px md:w-7 md:mx-auto md:my-1 max-md:w-px max-md:h-7 max-md:my-auto max-md:mx-1" />;
}
