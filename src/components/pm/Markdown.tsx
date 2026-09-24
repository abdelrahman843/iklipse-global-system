import { Children, isValidElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { LinkChip } from "@/components/pm/RichText";
import { cn } from "@/lib/cn";

// -----------------------------------------------------------------------------
// Markdown — renders comment / description bodies written in the rich editor
// (stored as Markdown). Raw HTML is never rendered (react-markdown default), so
// it stays XSS-safe; links become favicon preview chips, and single newlines
// are kept as line breaks so older plain-text comments still read correctly.
// -----------------------------------------------------------------------------

const isHttp = (u?: string) => !!u && /^https?:\/\//i.test(u);

function textOf(node: ReactNode): string {
  return Children.toArray(node)
    .map((c) => (typeof c === "string" || typeof c === "number" ? String(c) : isValidElement(c) ? textOf((c.props as { children?: ReactNode }).children) : ""))
    .join("");
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("md", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: ({ href, children }) => {
            if (!isHttp(href)) return <>{children}</>;
            const label = textOf(children);
            return <LinkChip href={href!} label={label && label !== href ? label : undefined} />;
          },
          img: ({ src, alt }) =>
            isHttp(src) ? (
              <a href={src} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                <img src={src} alt={alt ?? ""} loading="lazy" className="max-w-full max-h-80 rounded-md border border-border" />
              </a>
            ) : null,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
