import { lazyPage } from "@/lib/lazyPage";
import { Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AudioLines, HardDrive, Mail } from "lucide-react";
import { LineTabs, type LineTab } from "@/components/ui/LineTabs";
import { PageSpinner } from "@/components/ui/Spinner";
import { fetchSharedWithMe } from "@/lib/mailShareApi";
import { fetchDriveSharedWithMe } from "@/lib/driveApi";
import { fetchMeetingsSharedWithMe } from "@/lib/firefliesApi";

// -----------------------------------------------------------------------------
// Shared: everything other people in iklipse shared with me, one tab per kind
// (Gmail accounts and emails, Google Drives, files and folders; more kinds
// join as tabs). The tab switch is Center's (its Services page). ?tab= picks
// the tab, so notifications open the right one.
// -----------------------------------------------------------------------------

const SharedMailView = lazyPage(() => import("@/pages/MailPage").then((m) => ({ default: m.SharedMailView })));
const SharedDriveView = lazyPage(() => import("@/pages/DrivePage").then((m) => ({ default: m.SharedDriveView })));
const SharedMeetingsView = lazyPage(() => import("@/pages/MeetingsPage").then((m) => ({ default: m.SharedMeetingsView })));

type Tab = "mail" | "drive" | "meetings";

export default function SharedPage() {
  const [params, setParams] = useSearchParams();
  const mail = useQuery({ queryKey: ["mail-shared-with-me"], queryFn: fetchSharedWithMe, refetchInterval: 60_000 });
  const drive = useQuery({ queryKey: ["drive-shared-with-me"], queryFn: fetchDriveSharedWithMe, refetchInterval: 60_000 });
  const meetings = useQuery({ queryKey: ["meetings-shared"], queryFn: fetchMeetingsSharedWithMe, refetchInterval: 60_000 });

  const asked = params.get("tab");
  // No tab asked for: the first one that has something in it.
  const tab: Tab =
    asked === "drive" || asked === "mail" || asked === "meetings"
      ? asked
      : (mail.data?.length ?? 0) > 0
        ? "mail"
        : (drive.data?.length ?? 0) > 0
          ? "drive"
          : (meetings.data?.length ?? 0) > 0
            ? "meetings"
            : "mail";
  const setTab = (t: Tab) => setParams({ tab: t }, { replace: true });

  const tabs: LineTab<Tab>[] = [
    { value: "mail", label: "Mail", icon: <Mail />, count: mail.data?.length },
    { value: "drive", label: "Drive", icon: <HardDrive />, count: drive.data?.length },
    { value: "meetings", label: "Meetings", icon: <AudioLines />, count: meetings.data?.length },
  ];

  return (
    <div className="h-full flex flex-col min-h-0">
      <header className="shrink-0 px-3 sm:px-4 md:px-6 pt-3 sm:pt-4 md:pt-6">
        <div className="mb-4 min-w-0">
          <div className="eyebrow text-subtle mb-1">Workspace</div>
          <h1 className="text-2xl sm:text-3xl font-semibold text-ink tracking-tight">Shared with you</h1>
          <p className="text-sm text-muted mt-1 hidden sm:block">What people in iklipse shared with you, within what each of them allows.</p>
        </div>
        <LineTabs value={tab} tabs={tabs} onChange={setTab} label="Shared kinds" />
      </header>
      <div className="flex-1 min-h-0">
        <Suspense fallback={<PageSpinner />}>{tab === "mail" ? <SharedMailView /> : tab === "drive" ? <SharedDriveView /> : <SharedMeetingsView />}</Suspense>
      </div>
    </div>
  );
}
