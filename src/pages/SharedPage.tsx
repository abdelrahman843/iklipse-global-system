import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { HardDrive, Mail } from "lucide-react";
import { PillTabs, type PillTab } from "@/components/ui/PillTabs";
import { PageSpinner } from "@/components/ui/Spinner";
import { fetchSharedWithMe } from "@/lib/mailShareApi";
import { fetchDriveSharedWithMe } from "@/lib/driveApi";

// -----------------------------------------------------------------------------
// Shared: everything other people in iklipse shared with me, one tab per kind
// (Gmail accounts and emails, Google Drives, files and folders; more kinds
// join as tabs). The tab switch is Center's (its Services page). ?tab= picks
// the tab, so notifications open the right one.
// -----------------------------------------------------------------------------

const SharedMailView = lazy(() => import("@/pages/MailPage").then((m) => ({ default: m.SharedMailView })));
const SharedDriveView = lazy(() => import("@/pages/DrivePage").then((m) => ({ default: m.SharedDriveView })));

type Tab = "mail" | "drive";

export default function SharedPage() {
  const [params, setParams] = useSearchParams();
  const mail = useQuery({ queryKey: ["mail-shared-with-me"], queryFn: fetchSharedWithMe, refetchInterval: 60_000 });
  const drive = useQuery({ queryKey: ["drive-shared-with-me"], queryFn: fetchDriveSharedWithMe, refetchInterval: 60_000 });

  const asked = params.get("tab");
  // No tab asked for: the first one that has something in it.
  const tab: Tab =
    asked === "drive" || asked === "mail" ? asked : !(mail.data?.length ?? 0) && (drive.data?.length ?? 0) > 0 ? "drive" : "mail";
  const setTab = (t: Tab) => setParams({ tab: t }, { replace: true });

  const tabs: PillTab<Tab>[] = [
    { value: "mail", label: "Mail", icon: <Mail />, count: mail.data?.length },
    { value: "drive", label: "Drive", icon: <HardDrive />, count: drive.data?.length },
  ];

  return (
    <div className="h-full flex flex-col min-h-0">
      <header className="shrink-0 px-3 sm:px-4 md:px-6 pt-4 sm:pt-5 pb-4 border-b border-border bg-surface flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold text-ink tracking-tight">Shared with you</h1>
          <p className="mt-1 text-sm text-muted">What people in iklipse shared with you, within what each of them allows.</p>
        </div>
        <PillTabs value={tab} tabs={tabs} onChange={setTab} label="Shared kinds" />
      </header>
      <div className="flex-1 min-h-0">
        <Suspense fallback={<PageSpinner />}>{tab === "mail" ? <SharedMailView /> : <SharedDriveView />}</Suspense>
      </div>
    </div>
  );
}
