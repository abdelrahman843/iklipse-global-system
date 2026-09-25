import { Fragment, type ReactNode } from "react";

// -----------------------------------------------------------------------------
// RichText — turns plain user text into clickable link "preview" chips without a
// Markdown engine or a network unfurl. It recognises two shapes:
//   1. Markdown links:  [label](https://…)   → chip showing `label`
//   2. Bare URLs:       https://…            → chip showing the host + path
// Each chip shows the site's favicon (Google's public favicon CDN) so links read
// as previews. Only http/https is linkified (no javascript:/data: URIs), links
// open in a new tab with rel="noopener noreferrer", and clicks stop propagation
// so a link inside a clickable card/description doesn't also trigger the parent.
// Everything else renders as literal text, so it's XSS-safe by construction.
// -----------------------------------------------------------------------------

const MD_LINK = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL = /(https?:\/\/[^\s<]+)/g;
// Trailing punctuation that almost never belongs to the URL itself.
const TRAILING = /[.,;:!?)\]]+$/;

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// A compact link-preview chip: favicon + label. The favicon hints the
// destination (Drive, Docs, Figma, YouTube…) at a glance.
export function LinkChip({ href, label }: { href: string; label?: string }) {
  const host = hostOf(href);
  const text = label && label.trim() ? label.trim() : href.replace(/^https?:\/\//, "");
  const favicon = `https://www.google.com/s2/favicons?domain=${host}&sz=32`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={href}
      onClick={(e) => e.stopPropagation()}
      className="inline-flex max-w-[18rem] items-center gap-1 align-middle rounded-md border border-border bg-inset px-1.5 py-0.5 text-accent hover:bg-border/70 hover:border-rule transition-colors"
    >
      <img
        src={favicon}
        alt=""
        width={14}
        height={14}
        className="w-3.5 h-3.5 rounded-sm shrink-0"
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = "none";
        }}
      />
      <span className="truncate">{text}</span>
    </a>
  );
}

function linkifyBare(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  BARE_URL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BARE_URL.exec(text))) {
    let url = m[0];
    let tail = "";
    const t = url.match(TRAILING);
    if (t) {
      tail = t[0];
      url = url.slice(0, -tail.length);
    }
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<LinkChip key={`${keyBase}-u${i}`} href={url} />);
    if (tail) out.push(tail);
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function RichText({ text, className }: { text: string; className?: string }) {
  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  MD_LINK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MD_LINK.exec(text))) {
    if (m.index > last) nodes.push(...linkifyBare(text.slice(last, m.index), `seg${i}`));
    const label = m[1].trim() || hostOf(m[2]);
    nodes.push(<LinkChip key={`md${i}`} href={m[2]} label={label} />);
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) nodes.push(...linkifyBare(text.slice(last), "tail"));

  return (
    <span className={className}>
      {nodes.map((n, idx) => (
        <Fragment key={idx}>{n}</Fragment>
      ))}
    </span>
  );
}
