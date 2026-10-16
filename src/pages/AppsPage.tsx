import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, PhoneCall, Smartphone, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Hint } from "@/components/ui/Input";
import { PageSpinner } from "@/components/ui/Spinner";
import { PageTitle } from "@/components/ui/PageTitle";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { ROWS, Section } from "@/components/ui/Section";
import { relativeTime } from "@/lib/format";
import { isIOS } from "@/lib/pwa";
import { appDownload, appPlatform, openPhoneSettings, type AppPlatform } from "@/lib/nativeApp";
import { fetchLinkedPhones, fetchWatchOverview, testCall, unlinkPhone } from "@/lib/watchApi";

// -----------------------------------------------------------------------------
// Apps: the iklipse apps for the team (downloaded here, signed in only).
// Android rings Ikli's calls like real ones and brings every notification;
// Windows keeps iklipse next to the clock. Phones linked to me, to unlink.
// iPhone: add to the home screen.
// -----------------------------------------------------------------------------

const AFTER_DOWNLOAD: Record<AppPlatform, string> = {
  android: "Open the downloaded file to install it. Allow installing from Chrome when asked, and if Play Protect warns, tap Install anyway.",
  windows: "Open iklipse-setup.exe. If Windows says it protected your PC, tap More info, then Run anyway.",
};

export default function AppsPage() {
  const ov = useQuery({ queryKey: ["watch-overview"], queryFn: fetchWatchOverview, staleTime: 60_000 });
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const phones = useQuery({ queryKey: ["linked-phones"], queryFn: fetchLinkedPhones });
  const count = phones.data?.length ?? 0;
  const unlink = useMutation({
    mutationFn: unlinkPhone,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["linked-phones"] });
      void qc.invalidateQueries({ queryKey: ["watch-overview"] });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't unlink it", description: e.message }),
  });
  const test = useMutation({
    mutationFn: testCall,
    onSuccess: () => toast.push({ kind: "success", title: "Ikli is calling you" }),
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't call", description: e.message }),
  });
  const get = useMutation({
    mutationFn: (p: AppPlatform) => appDownload(p),
    onSuccess: (r, p) => {
      window.location.assign(r.url);
      toast.push({ kind: "success", title: `Downloading iklipse ${r.name}`, description: AFTER_DOWNLOAD[p] });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't download the app", description: e.message }),
  });
  const iphone = isIOS();

  const testButton = (
    <Button size="sm" iconLeft={<PhoneCall size={14} />} loading={test.isPending} onClick={() => test.mutate()}>
      Test call to me
    </Button>
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-3 sm:p-4 md:p-6">
        <div className="mb-6">
          <PageTitle>Apps</PageTitle>
          <p className="text-sm text-muted mt-1">iklipse on your phone and computer: Ikli's calls ring like real ones, and notifications come through.</p>
        </div>
        <div className="max-w-2xl space-y-8 pb-12">
          <Section
            title="On your phone"
            hint="A browser can only send a notification. The iklipse app rings like a real call: full screen, even on a locked phone, with your ringtone until you answer. It's for the team only: it downloads from here, when you're signed in."
          >
            <div className="space-y-3 pt-3 text-sm text-muted">
              {appPlatform === "android" ? (
                <>
                  <p className="text-ink">You're in the iklipse app: Ikli's calls and your notifications come to this phone.</p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" iconLeft={<Smartphone size={14} />} onClick={openPhoneSettings}>
                      Phone settings
                    </Button>
                    {testButton}
                  </div>
                  <Hint>In Phone settings, turn on everything under Ready to ring. Then lock the phone and call yourself.</Hint>
                </>
              ) : iphone ? (
                <>
                  <p className="text-ink">iPhone: add iklipse to your home screen.</p>
                  <ol className="list-decimal space-y-1 pl-5">
                    <li>Open iklipse in Safari, tap Share, then Add to Home Screen.</li>
                    <li>Open it from the new icon and sign in.</li>
                    <li>Turn on notifications (your profile menu, Notifications).</li>
                  </ol>
                  <Hint>With the app closed, Ikli's calls arrive as notifications that ring. The full call screen shows while it's open.</Hint>
                </>
              ) : (
                <>
                  <p className="text-ink">Android: get the iklipse app, then sign in inside it. It links itself to you.</p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="primary" iconLeft={<Download size={14} />} loading={get.isPending && get.variables === "android"} onClick={() => get.mutate("android")}>
                      Download for Android
                    </Button>
                    {testButton}
                  </div>
                  <Hint>Download it on the phone itself (open iklipse in Chrome there). After installing, remove the iklipse you added from Chrome, so things don't come twice.</Hint>
                </>
              )}
            </div>
          </Section>

          <Section title="On your computer" hint="The Windows app keeps iklipse running next to the clock: notifications show even with the window closed, and Ikli's call comes to the front and rings. It updates itself.">
            <div className="space-y-3 pt-3 text-sm text-muted">
              {appPlatform === "windows" ? (
                <p className="text-ink">You're in the iklipse app for Windows.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" iconLeft={<Download size={14} />} loading={get.isPending && get.variables === "windows"} onClick={() => get.mutate("windows")}>
                    Download for Windows
                  </Button>
                </div>
              )}
            </div>
          </Section>

          <Section title="Linked phones" count={count || null}>
            {phones.isLoading ? (
              <PageSpinner />
            ) : !count ? (
              <p className="py-3 text-sm text-muted">{ov.data?.my_push ? "No phone with the app yet: calls reach you as notifications." : "No phone with the app yet."}</p>
            ) : (
              <ul className={ROWS}>
                {phones.data!.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 py-3">
                    <Smartphone size={18} className="shrink-0 text-muted" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-ink">{p.device ?? "Android phone"}</div>
                      <div className="text-xs text-subtle">
                        Linked {relativeTime(p.created_at)} · seen {relativeTime(p.last_seen_at)}
                        {p.app_version ? ` · v${p.app_version}` : ""}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      iconLeft={<Trash2 size={14} />}
                      loading={unlink.isPending && unlink.variables === p.id}
                      onClick={async () => {
                        if (await confirm({ title: "Unlink this phone?", message: "Ikli's calls and your notifications stop coming to it, until you sign in there again.", confirmLabel: "Unlink", danger: true })) unlink.mutate(p.id);
                      }}
                    >
                      Unlink
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
