import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { cn } from "@/lib/cn";
import { useAuth } from "@/lib/auth";
import { useWbPeople, type WbPerson } from "@/lib/wb/people";

// -----------------------------------------------------------------------------
// Plain-text comment box with @mention autocomplete (inserts "@username", the
// form the database trigger notifies on), and the matching body renderer that
// highlights mentions of real people.
// -----------------------------------------------------------------------------

/** Same pattern as wb_comment_notify(). */
const MENTION_SPLIT = /(@[A-Za-z0-9._-]{3,32})/g;
/** "@que" right before the caret, at a word start. */
const TYPING = /(^|[^A-Za-z0-9._-])@([A-Za-z0-9._-]{0,32})$/;

const MAX_H = 160;

export function MentionInput({
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder,
  focus,
  className,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Enter (Shift+Enter is a new line). */
  onSubmit: () => void;
  /** Esc. */
  onCancel?: () => void;
  placeholder?: string;
  /** Take focus on mount (without scrolling the canvas). */
  focus?: boolean;
  className?: string;
  label: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const { user } = useAuth();
  const people = useWbPeople().data?.list;
  const [q, setQ] = useState<{ start: number; text: string } | null>(null);
  const [active, setActive] = useState(0);
  const [below, setBelow] = useState(false);

  const matches = useMemo(() => {
    if (!q || !people) return [];
    const t = q.text.toLowerCase();
    return people
      .filter(
        (p) =>
          p.is_active &&
          p.id !== user?.id &&
          (p.username.toLowerCase().startsWith(t) || p.display_name.toLowerCase().split(/\s+/).some((w) => w.startsWith(t))),
      )
      .slice(0, 6);
  }, [q, people, user?.id]);

  // Grow with the text, up to a few lines.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, MAX_H)}px`;
  }, [value]);

  useEffect(() => {
    if (!focus) return;
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const detect = (el: HTMLTextAreaElement) => {
    const caret = el.selectionStart;
    if (caret !== el.selectionEnd) return setQ(null);
    const m = TYPING.exec(el.value.slice(0, caret));
    if (!m) return setQ(null);
    setQ({ start: caret - m[2]!.length - 1, text: m[2]! });
    setActive(0);
    // Open the list downwards when there's no room above (composer near the top).
    setBelow(el.getBoundingClientRect().top < 240);
  };

  const pick = (p: WbPerson) => {
    const el = ref.current;
    if (!el || !q) return;
    const caret = el.selectionStart;
    const next = `${value.slice(0, q.start)}@${p.username} ${value.slice(caret)}`;
    const pos = q.start + p.username.length + 2;
    onChange(next);
    setQ(null);
    requestAnimationFrame(() => {
      el.focus({ preventScroll: true });
      el.setSelectionRange(pos, pos);
    });
  };

  const listOpen = !!q && matches.length > 0;

  return (
    <div className={cn("relative", className)}>
      <textarea
        ref={ref}
        rows={1}
        value={value}
        aria-label={label}
        placeholder={placeholder}
        maxLength={10000}
        onChange={(e) => {
          onChange(e.target.value);
          detect(e.target);
        }}
        onSelect={(e) => detect(e.currentTarget)}
        onBlur={() => setTimeout(() => setQ(null), 150)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (listOpen) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const d = e.key === "ArrowDown" ? 1 : -1;
              setActive((a) => (a + d + matches.length) % matches.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              pick(matches[active] ?? matches[0]!);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setQ(null);
              return;
            }
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel?.();
          }
        }}
        className="block w-full min-w-0 resize-none overflow-y-auto bg-surface border border-border rounded-md px-2.5 py-[7px] text-lg sm:text-base leading-snug text-ink placeholder:text-subtle focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:outline-none transition-[border-color,box-shadow] duration-150"
      />
      {listOpen && (
        <div
          role="listbox"
          aria-label="People"
          data-wb-scroll
          className={cn(
            "absolute left-0 right-0 z-10 py-1 max-h-56 overflow-y-auto bg-surface border border-border rounded-md shadow-pop animate-menu-in",
            below ? "top-full mt-1" : "bottom-full mb-1",
          )}
        >
          {matches.map((p, i) => (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={i === active}
              // Keep the caret in the textarea.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(p)}
              className={cn("flex w-full items-center gap-2 h-9 px-2.5 text-left text-sm", i === active ? "bg-inset" : "hover:bg-inset")}
            >
              <Avatar name={p.display_name} src={p.avatar_url} size={22} className="shrink-0" />
              <span className="min-w-0 truncate text-ink">{p.display_name}</span>
              <span className="min-w-0 truncate text-xs text-subtle">@{p.username}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Comment text with @mentions of real people highlighted. */
export function CommentBody({ text, className }: { text: string; className?: string }) {
  const people = useWbPeople().data?.list;
  const byName = useMemo(() => new Map((people ?? []).map((p) => [p.username.toLowerCase(), p])), [people]);
  const parts = text.split(MENTION_SPLIT);
  return (
    <p className={cn("text-base text-ink whitespace-pre-wrap [overflow-wrap:anywhere] select-text", className)}>
      {parts.map((part, i) => {
        if (i % 2 === 0) return part;
        const p = byName.get(part.slice(1).toLowerCase());
        return p ? (
          <span key={i} className="rounded-sm px-0.5 bg-accent-soft text-accent font-medium" title={p.display_name}>
            {part}
          </span>
        ) : (
          part
        );
      })}
    </p>
  );
}
