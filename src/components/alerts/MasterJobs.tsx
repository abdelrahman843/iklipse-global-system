import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/Badge";
import { fetchMasterBoard, type MasterJob } from "@/lib/brainApi";
import { LIVE_FALLBACK } from "@/lib/live";

// -----------------------------------------------------------------------------
// What the master on the server is working on (Alerts > Brain): its chats of the
// last day and what it sent the brain, as it last said them. Only the super
// admin sees this: they're their own chats. Stopping it is the switch below.
// -----------------------------------------------------------------------------

const TONE: Record<MasterJob["state"], "neutral" | "accent" | "success" | "warn"> = {
  running: "accent",
  waiting: "neutral",
  "needs go": "warn",
  idle: "neutral",
  "at the brain": "accent",
};

const when = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Africa/Cairo" }) : "";

export function MasterJobs() {
  const board = useQuery({ queryKey: ["master-board"], queryFn: fetchMasterBoard, refetchInterval: LIVE_FALLBACK });
  if (!board.data) return null;
  const { jobs, at } = board.data;
  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-ink">The master's jobs</h2>
        <span className="text-xs text-muted">Updated {when(Date.parse(at))}</span>
      </div>
      {!jobs.length ? (
        <p className="mt-2 text-sm text-muted">Nothing in the last day.</p>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-left text-sm">
            <thead className="bg-inset text-xs text-muted">
              <tr>
                {["Job", "State", "Who", "Left to do", "Last"].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {jobs.map((j, i) => (
                <tr key={`${j.n ?? "t"}-${i}`} className="border-t border-line align-top">
                  <td className="px-3 py-2">
                    <div className="font-medium">{j.n ? `#${j.n} ` : ""}{j.title || "(no title)"}</div>
                    {j.goal && <div className="text-xs text-muted">{j.goal}</div>}
                  </td>
                  <td className="px-3 py-2"><Badge tone={TONE[j.state]}>{j.state}</Badge></td>
                  <td className="px-3 py-2 text-muted">{j.worker}{j.via === "slack" ? " · Slack" : ""}</td>
                  <td className="px-3 py-2">{j.left.length ? j.left.join("; ") : j.done ? `${j.done} done` : ""}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-muted">{when(j.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
