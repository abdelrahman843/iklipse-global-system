import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, PackageCheck, Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { relativeTime } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { Heading, StateBadge, Thumb, useTeamUrls } from "./parts";
import { NewDeliveryModal } from "./DeliveryModals";
import { fileKey, type Delivery } from "@/lib/deliveriesApi";

// -----------------------------------------------------------------------------
// The project page's Deliveries tab: what was sent to this client, each
// delivery with a strip of its files (its feedback is inside it). Everyone on
// the project makes deliveries and puts the work in them; admins and delivery
// managers send them.
// -----------------------------------------------------------------------------

const STRIP = 8;

export function ProjectDeliveries({ projectId, deliveries }: { projectId: string; deliveries: Delivery[] }) {
  const { canDeliver } = useAuth();
  const [creating, setCreating] = useState(false);
  const { urls, drive } = useTeamUrls(
    useMemo(
      () => deliveries.flatMap((d) => d.items.filter((i) => !i.removed_at && (i.kind === "image" || i.kind === "video")).slice(0, STRIP).map((i) => fileKey(i))),
      [deliveries],
    ),
  );

  return (
    <div>
      <Heading
        title="Sent to the client"
        count={deliveries.length}
        action={
          <Button size="sm" variant="primary" iconLeft={<Plus size={14} />} onClick={() => setCreating(true)}>
            New delivery
          </Button>
        }
      />
      {!deliveries.length ? (
        <EmptyState
          icon={<PackageCheck size={20} />}
          title="Nothing sent yet"
          description={canDeliver ? "Make a delivery for this project, upload the work and send the client a link." : "Make a delivery for this project and put the work in it. An admin sends it to the client."}
        />
      ) : (
        <ul className="divide-y divide-line border-b border-line">
          {deliveries.map((d, n) => {
            const active = d.items.filter((i) => !i.removed_at).sort((a, b) => a.position - b.position);
            const more = active.length - STRIP;
            return (
              <li key={d.id} style={{ "--i": Math.min(n, 12) } as React.CSSProperties} className="rise -mx-2 px-2 py-4 rounded-md hover:bg-hover transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to={`/deliveries/${d.id}`} className="text-base font-semibold text-ink hover:text-accent break-words">
                        {d.title}
                      </Link>
                      <StateBadge state={d.state} />
                    </div>
                    <div className="mt-0.5 text-sm text-muted">
                      Round {d.round} · {active.length} {active.length === 1 ? "file" : "files"} · updated {relativeTime(d.updated_at)}
                    </div>
                  </div>
                  <Link
                    to={`/deliveries/${d.id}`}
                    className="shrink-0 inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-sm font-medium text-ink hover:bg-hover"
                  >
                    Open <ArrowRight size={14} />
                  </Link>
                </div>
                {active.length > 0 && (
                  <Link to={`/deliveries/${d.id}`} className="mt-3 flex flex-wrap gap-2" aria-label={`Open ${d.title}`}>
                    {active.slice(0, STRIP).map((i) => (
                      <Thumb key={i.id} item={i} url={urls[fileKey(i) ?? ""] ?? null} drive={drive[fileKey(i) ?? ""]} className="h-14 w-24 shrink-0" iconSize={16} />
                    ))}
                    {more > 0 && <span className="h-14 w-14 grid place-items-center rounded-lg bg-inset text-sm font-medium text-muted">+{more}</span>}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {creating && <NewDeliveryModal projectId={projectId} onClose={() => setCreating(false)} />}
    </div>
  );
}
