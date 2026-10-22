import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, MessageCircle, Play, QrCode, RefreshCw, Unplug } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Section } from "@/components/ui/Section";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { WhatsAppBridgeControls } from "@/components/WhatsAppBridgeControls";
import { bridgeCode, bridgeLogout, bridgeStart, bridgeStatus, setBotProvider, type BridgeStatus } from "@/lib/watchApi";

// -----------------------------------------------------------------------------
// Connected accounts > WhatsApp (admins only): the bot's own WhatsApp bridge
// (WAHA on the claude-vps server, 0097). Start it, scan its QR code from the
// phone's Linked devices (or type a code there), then choose whether the bot
// uses this number or Green API. While it waits for a scan the QR code is
// fetched again every few seconds (WhatsApp changes it).
// -----------------------------------------------------------------------------

const KEY = ["whatsapp-bridge"];

function stateBadge(s: BridgeStatus) {
  if (!s.ready) return <Badge tone="danger">Not set up</Badge>;
  switch (s.status) {
    case "WORKING":
      return <Badge tone="success">Linked</Badge>;
    case "SCAN_QR_CODE":
    case "PASSKEY_REQUIRED":
    case "PASSKEY_CONFIRMATION_REQUIRED":
      return <Badge tone="warn">Waiting for a scan</Badge>;
    case "STARTING":
      return <Badge tone="neutral">Starting</Badge>;
    case "FAILED":
      return <Badge tone="danger">Stopped with an error</Badge>;
    case "STOPPED":
      return <Badge tone="neutral">Stopped</Badge>;
    default:
      return <Badge tone="neutral">Not started</Badge>;
  }
}

const pretty = (phone: string | null) => (phone ? `+${phone}` : "");

export function WhatsAppBridgeSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [byCode, setByCode] = useState(false);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState<string | null>(null);

  const q = useQuery({
    queryKey: KEY,
    queryFn: bridgeStatus,
    // Waiting for a scan or starting: looked at again (a new QR code, or linked).
    refetchInterval: (query) => {
      const st = query.state.data?.status;
      return st === "SCAN_QR_CODE" || st === "STARTING" || st?.startsWith("PASSKEY") ? 4000 : false;
    },
    refetchOnWindowFocus: true,
  });
  const put = (s: BridgeStatus) => qc.setQueryData(KEY, s);
  const fail = (title: string) => (e: Error) => toast.push({ kind: "error", title, description: e.message });

  const start = useMutation({ mutationFn: bridgeStart, onSuccess: put, onError: fail("Couldn't start the bridge") });
  const logout = useMutation({
    mutationFn: bridgeLogout,
    onSuccess: (s) => {
      put(s);
      setCode(null);
      toast.push({ kind: "success", title: "Number unlinked" });
    },
    onError: fail("Couldn't unlink"),
  });
  const pair = useMutation({
    mutationFn: () => bridgeCode(phone),
    onSuccess: (r) => setCode(r.code),
    onError: fail("Couldn't get a code"),
  });
  const use = useMutation({
    mutationFn: setBotProvider,
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["watch-overview"] });
      toast.push({
        kind: "success",
        title: r.provider === "waha" ? "The bot now uses this number" : "The bot is back on Green API",
        description: "Sync the groups in Alerts > Groups so it knows which groups this number is in.",
      });
    },
    onError: fail("Couldn't switch"),
  });

  const s = q.data;
  const linked = s?.status === "WORKING";
  const waiting = s?.status === "SCAN_QR_CODE";
  const off = !!s?.ready && (!s.status || s.status === "STOPPED" || s.status === "FAILED");

  return (
    <div className="space-y-8">
      <Section
        title={
          <span className="inline-flex items-center gap-2">
            <span className="grid place-items-center h-5 w-5 rounded bg-accent-soft text-accent">
              <MessageCircle size={12} />
            </span>
            WhatsApp bridge
          </span>
        }
        info="The bot's own WhatsApp connection, on iklipse's server instead of Green API. Link a number by scanning its QR code from the phone, then choose which one the bot uses. Only admins see this. It isn't WhatsApp's official API: use a number you can afford to have restricted."
        action={
          <Button variant="ghost" size="sm" iconLeft={<RefreshCw size={14} />} loading={q.isFetching && !q.isLoading} onClick={() => void q.refetch()}>
            Refresh
          </Button>
        }
      >
        <div className="divide-y divide-line border-b border-line">
          {q.isLoading && (
            <div className="py-6 flex justify-center">
              <Spinner />
            </div>
          )}
          {q.error && !s && <div className="py-4 text-sm text-danger">{(q.error as Error).message}</div>}

          {s && (
            <div className="py-3 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-ink flex flex-wrap items-center gap-2">
                  {linked ? <span className="truncate">{pretty(s.phone)}</span> : <span>Bridge</span>}
                  {stateBadge(s)}
                  {s.provider === "waha" && linked && <Badge tone="accent">The bot uses it</Badge>}
                </div>
                <div className="text-xs text-muted mt-0.5">
                  {!s.ready
                    ? "The whatsapp-bot function doesn't have the bridge's address and key (WAHA_URL, WAHA_API_KEY)."
                    : linked
                      ? `${s.name ? `${s.name} · ` : ""}${s.provider === "waha" ? "The bot reads and writes through this number." : "Linked. The bot still uses Green API."}`
                      : off
                        ? "Start it, then scan its QR code from the phone."
                        : waiting
                          ? "Scan the QR code below from the phone."
                          : "Getting ready…"}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {off && (
                  <Button variant="primary" size="sm" iconLeft={<Play size={14} />} className="max-sm:h-10" loading={start.isPending} onClick={() => start.mutate()}>
                    Start the bridge
                  </Button>
                )}
                {linked && s.provider !== "waha" && (
                  <Button
                    variant="primary"
                    size="sm"
                    className="max-sm:h-10"
                    loading={use.isPending}
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Let the bot use ${pretty(s.phone)}?`,
                        message:
                          "From now on the bot reads groups and private chats, and writes, through this number instead of Green API. It only sees groups this number is in. You can switch back any time.",
                        confirmLabel: "Use this number",
                      });
                      if (ok) use.mutate("waha");
                    }}
                  >
                    Use for the bot
                  </Button>
                )}
                {s.provider === "waha" && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="max-sm:h-10"
                    loading={use.isPending}
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Back to Green API?",
                        message: "The bot reads and writes through the Green API number again. This number stays linked.",
                        confirmLabel: "Back to Green API",
                      });
                      if (ok) use.mutate("green");
                    }}
                  >
                    Back to Green API
                  </Button>
                )}
                {(linked || waiting) && (
                  <Button
                    variant="secondary"
                    size="sm"
                    iconLeft={<Unplug size={14} />}
                    className="max-sm:h-10"
                    loading={logout.isPending}
                    onClick={async () => {
                      const ok = await confirm({
                        title: linked ? `Unlink ${pretty(s.phone)}?` : "Start over?",
                        message: linked
                          ? `It leaves the phone's Linked devices.${s.provider === "waha" ? " The bot uses this number now: it goes back to Green API first." : ""} You can link it, or another number, again.`
                          : "A new QR code comes.",
                        confirmLabel: linked ? "Unlink" : "Start over",
                        danger: linked,
                      });
                      if (!ok) return;
                      if (s.provider === "waha") await use.mutateAsync("green");
                      logout.mutate();
                    }}
                  >
                    {linked ? "Unlink" : "Start over"}
                  </Button>
                )}
              </div>
            </div>
          )}

          {s && waiting && (
            <div className="py-4 flex flex-col md:flex-row gap-6">
              <div className="shrink-0 self-center md:self-start">
                {s.qr ? (
                  <img src={s.qr} alt="QR code to link WhatsApp" width={240} height={240} className="h-60 w-60 rounded-lg bg-white p-2 border border-line" />
                ) : (
                  <div className="h-60 w-60 rounded-lg border border-line grid place-items-center text-muted">
                    <Spinner />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0 space-y-3 text-sm text-ink">
                <ol className="list-decimal pl-5 space-y-1.5">
                  <li>Open WhatsApp on the phone with the bot's number.</li>
                  <li>
                    Settings <span className="text-muted">(iPhone)</span> or ⋮ <span className="text-muted">(Android)</span> → <b>Linked devices</b> → <b>Link a device</b>.
                  </li>
                  <li>Point the phone at this QR code. It changes every few seconds; this page keeps up.</li>
                </ol>
                {!byCode ? (
                  <button type="button" className="text-sm font-medium text-accent hover:underline underline-offset-2 inline-flex items-center gap-1" onClick={() => setByCode(true)}>
                    <KeyRound size={14} /> Link with the phone number instead
                  </button>
                ) : (
                  <div className="space-y-2">
                    <div className="text-xs text-muted">The number with its country code. WhatsApp shows a notification on the phone: type the code there.</div>
                    <div className="flex flex-col sm:flex-row gap-2 max-w-md">
                      <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="2010..." inputMode="tel" aria-label="Phone number" />
                      <Button variant="secondary" size="sm" className="max-sm:h-10 sm:h-9" loading={pair.isPending} disabled={phone.replace(/\D/g, "").length < 8} onClick={() => pair.mutate()}>
                        Get a code
                      </Button>
                    </div>
                    {code && (
                      <div className="text-sm">
                        Code: <span className="font-mono text-lg tracking-widest text-ink">{code}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {s && !s.ready && (
            <div className="py-4 text-sm text-muted inline-flex items-center gap-2">
              <QrCode size={14} /> Nothing to scan until the bridge is set up.
            </div>
          )}
        </div>
      </Section>
      {s?.ready && <WhatsAppBridgeControls linked={linked} botUses={s.provider === "waha"} />}
    </div>
  );
}
