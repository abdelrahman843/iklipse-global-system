import { Fragment, type ReactNode } from "react";

// -----------------------------------------------------------------------------
// RichText — turns plain user text into clickable links without a Markdown
// engine. It recognises two shapes:
//   1. Markdown links:  [label](https://…)   → renders `label`
//   2. Bare URLs:       https://…            → renders the URL
// Only http/https is linkified (no javascript:/data: URIs), every link opens in
// a new tab with rel="noopener noreferrer", and clicks stop propagation so a
// link inside a clickable card/description doesn't also trigger the parent.
// Everything else is rendered as literal text, so it's XSS-safe by construction.
// -----------------------------------------------------------------------------

const MD_LINK = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL = /(https?:\/\/[^\s<]+)/g;
// Trailing punctuation that almost never belongs to the URL itself.
const TRAILING = /[.,;:!?)\]]+$/;

function LinkAnchor({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent hover:underline break-words"
      onClick={(e) => e.stopPropagation()}
    >
      {children}
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
    out.push(
      <LinkAnchor key={`${keyBase}-u${i}`} href={url}>
        {url}
      </LinkAnchor>,
    );
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
    const label = m[1].trim() || m[2];
    nodes.push(
      <LinkAnchor key={`md${i}`} href={m[2]}>
        {label}
      </LinkAnchor>,
    );
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
