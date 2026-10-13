import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { BrandMark } from "@/components/Brand";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner } from "@/components/ui/Spinner";
import { MeetingView } from "@/components/meetings/MeetingView";
import { fetchPublicMeeting } from "@/lib/firefliesApi";

// -----------------------------------------------------------------------------
// A meeting someone shared by email (/meeting/<token>): the summary and the
// transcript, no account needed. The owner can turn the link off.
// -----------------------------------------------------------------------------

export default function PublicMeetingPage() {
  const { token = "" } = useParams();
  const q = useQuery({ queryKey: ["public-meeting", token], queryFn: () => fetchPublicMeeting(token), retry: false, staleTime: Infinity });
  const m = q.data;
  return (
    <div className="h-[100dvh] overflow-auto bg-bg">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto max-w-5xl px-4 h-14 flex items-center justify-between gap-3">
          <BrandMark />
          {m && <span className="text-xs text-muted truncate">Shared by {m.shared_by}</span>}
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        {q.isLoading ? (
          <PageSpinner />
        ) : !m ? (
          <EmptyState icon={<AlertTriangle size={20} />} title="This link doesn't open anything" description={(q.error as Error | null)?.message ?? "It was turned off or doesn't exist."} />
        ) : (
          <MeetingView
            m={{ title: m.title, started_at: m.started_at, duration: m.duration, speakers: m.speakers, attendees: m.attendees, summary: m.summary }}
            sentences={m.sentences}
          />
        )}
      </main>
    </div>
  );
}
