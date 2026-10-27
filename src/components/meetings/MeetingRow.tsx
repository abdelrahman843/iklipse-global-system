import { Copy, ExternalLink, MessageCircle } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ROW } from "@/components/ui/Section";
import { useToast } from "@/components/ui/Toast";
import { lengthText } from "@/components/meetings/CalendlySection";
import { cn } from "@/lib/cn";
import { timeText } from "@/lib/attendanceApi";
import { placeName, type CalendlyMeeting } from "@/lib/calendlyApi";

// One meeting in the list view of the Calendly and Calendar pages: its time,
// who it's with, and its link to copy or join.

export const copy = async (text: string, toast: ReturnType<typeof useToast>, what = "Link") => {
  try {
    await navigator.clipboard.writeText(text);
    toast.push({ kind: "success", title: `${what} copied` });
  } catch {
    toast.push({ kind: "error", title: "Couldn't copy it" });
  }
};

export function MeetingRow({ m, i, past, onOpen }: { m: CalendlyMeeting; i: number; past: boolean; onOpen: () => void }) {
  const toast = useToast();
  return (
    <li style={{ "--i": Math.min(i, 12) } as React.CSSProperties} className={cn("rise", ROW, "-mx-2 px-2 flex items-center gap-3 min-w-0", past && "opacity-70")}>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left flex items-center gap-4">
        <div className="w-20 shrink-0">
          <div className="text-sm font-semibold text-ink tabular-nums">{timeText(m.start)}</div>
          <div className="text-xs text-subtle">{lengthText(m.minutes)}</div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold text-ink truncate">{m.name}</span>
            {m.whatsapp && (
              <Badge tone="success">
                <MessageCircle size={10} /> WhatsApp
              </Badge>
            )}
          </div>
          <div className="text-sm text-muted truncate">{[m.with && `With ${m.with}`, placeName(m.location)].filter(Boolean).join(" · ") || "Open for who's in it"}</div>
        </div>
      </button>
      {m.join_url && !past && (
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => void copy(m.join_url!, toast)}
            title="Copy the link"
            aria-label="Copy the link"
            className="h-9 w-9 grid place-items-center rounded-md text-muted hover:bg-hover hover:text-ink"
          >
            <Copy size={15} />
          </button>
          <a href={m.join_url} target="_blank" rel="noreferrer">
            <Button size="sm" iconLeft={<ExternalLink size={13} />}>
              Join
            </Button>
          </a>
        </div>
      )}
    </li>
  );
}
