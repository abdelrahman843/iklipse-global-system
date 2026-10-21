import { useState } from "react";
import { Check, Copy, Plug } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PillTabs } from "@/components/ui/PillTabs";
import { Section } from "@/components/ui/Section";
import { useToast } from "@/components/ui/Toast";

// -----------------------------------------------------------------------------
// Connected accounts > Claude and ChatGPT: the iklipse MCP server's address and
// how to add it. Each person signs in with their own iklipse account, so the
// assistant sees only the boards they can see.
// -----------------------------------------------------------------------------

export const MCP_URL = `${String(import.meta.env.VITE_SUPABASE_URL ?? "").replace(/\/$/, "")}/functions/v1/mcp`;

type App = "claude" | "chatgpt";

const STEPS: Record<App, string[]> = {
  claude: [
    "In Claude (web or desktop), open Settings, then Connectors.",
    "Choose Add custom connector, name it iklipse and paste the link.",
    "Press Connect, sign in to iklipse and press Allow.",
  ],
  chatgpt: [
    "In ChatGPT, open Settings, then Apps and Connectors, then Advanced, and turn on Developer mode.",
    "Back in Apps and Connectors, choose Create, name it iklipse and paste the link. Authentication: OAuth.",
    "Press Create, sign in to iklipse and press Allow.",
  ],
};

export function McpSection() {
  const toast = useToast();
  const [app, setApp] = useState<App>("claude");
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(MCP_URL);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.push({ kind: "error", title: "Couldn't copy", description: "Select the link and copy it by hand." });
    }
  };

  return (
    <Section
      title={
        <span className="inline-flex items-center gap-2">
          <span className="grid place-items-center h-5 w-5 rounded bg-accent-soft text-accent">
            <Plug size={12} />
          </span>
          Claude and ChatGPT
        </span>
      }
      info="Let Claude or ChatGPT read and update your Trello and Miro boards. They only see what your account can see."
    >
      <div className="divide-y divide-line border-b border-line">
        <div className="py-3">
          <div className="text-sm font-medium text-ink">MCP server link</div>
          <div className="mt-1 flex flex-col sm:flex-row gap-2">
            <input
              readOnly
              value={MCP_URL}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="MCP server link"
              className="flex-1 min-w-0 h-10 sm:h-9 rounded-md border border-border bg-inset px-3 font-mono text-[13px] text-ink outline-none focus:border-accent"
            />
            <Button variant="primary" size="sm" className="h-10 sm:h-9 shrink-0" iconLeft={copied ? <Check size={14} /> : <Copy size={14} />} onClick={copy}>
              {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
        </div>
        <div className="py-3">
          <PillTabs
            value={app}
            onChange={setApp}
            label="Add it to"
            tabs={[
              { value: "claude", label: "Claude" },
              { value: "chatgpt", label: "ChatGPT" },
            ]}
          />
          <ol className="mt-3 space-y-2">
            {STEPS[app].map((s, i) => (
              <li key={i} className="flex gap-2.5 text-sm text-ink">
                <span className="mt-px h-5 w-5 shrink-0 rounded-full bg-accent-soft text-accent text-xs font-semibold grid place-items-center">{i + 1}</span>
                <span className="leading-snug">{s}</span>
              </li>
            ))}
          </ol>
          <div className="mt-3 text-xs text-subtle">
            To take access away later, remove the connector in Claude or ChatGPT.
          </div>
        </div>
      </div>
    </Section>
  );
}
