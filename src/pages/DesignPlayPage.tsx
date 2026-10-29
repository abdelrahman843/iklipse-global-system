import { useMemo } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PageSpinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { PrototypePlayer } from "@/components/design/PrototypePlayer";
import { useBoardAccess } from "@/lib/pm/boardAccess";
import { fetchDesign } from "@/lib/design/sync";
import { normalizeData } from "@/lib/design/store";
import type { DesignDoc, DNode } from "@/lib/design/types";

// -----------------------------------------------------------------------------
// Stand-alone prototype player (/wb/:boardId/play?page=..&start=..), the
// link the Prototype tab copies. Same access as the board: anyone who can
// view the whiteboard can play its design. Reads the document once; it
// doesn't follow live edits (reload for the latest).
// -----------------------------------------------------------------------------

export function DesignPlayPage() {
  const { boardId = "" } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const access = useBoardAccess(boardId);
  const q = useQuery({
    queryKey: ["design-play", boardId],
    queryFn: () => fetchDesign(boardId),
    enabled: !!boardId && !!access.access,
    staleTime: 30_000,
  });

  const doc = useMemo<DesignDoc | null>(() => {
    if (!q.data) return null;
    const nodes: Record<string, DNode> = {};
    for (const n of q.data.nodes) nodes[n.id] = n;
    return { data: normalizeData(q.data.data ?? {}), nodes };
  }, [q.data]);

  if (access.loading || (!!access.access && q.isLoading)) return <PageSpinner />;
  if (!access.access || q.error || !doc)
    return (
      <div className="p-6">
        <EmptyState title="Prototype not found" description="The board may have been deleted, or you don't have access." />
      </div>
    );

  const want = params.get("page");
  const page = doc.data.pages.find((p) => p.id === want)?.id ?? doc.data.pages[0]!.id;
  return (
    <PrototypePlayer
      doc={doc}
      page={page}
      startId={params.get("start")}
      embedded={false}
      onClose={() => nav(`/wb/${boardId}?mode=design`)}
    />
  );
}

export default DesignPlayPage;
