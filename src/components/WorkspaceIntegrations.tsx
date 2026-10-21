import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Inbox, KeyRound, Mail, MessageCircle, Send, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { InfoTip } from "@/components/ui/InfoTip";
import { Input, Label } from "@/components/ui/Input";
import { Section } from "@/components/ui/Section";
import { Select } from "@/components/ui/Select";
import { PageSpinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import {
  SEND_LIMIT_PER_HOUR,
  fetchIntegrationStatus,
  inboxTargets,
  setEmailInbox,
  setGreenApi,
  testEmail,
  testWhatsapp,
  type IntegrationStatus,
} from "@/lib/integrationsApi";

// -----------------------------------------------------------------------------
// Connected accounts > WhatsApp and email (admins): the workspace's WhatsApp
// (Green API, the bot's number too), notification email (Gmail through n8n)
// and email to card. The secrets are write-only (Vault).
// -----------------------------------------------------------------------------

export function WorkspaceIntegrations() {
  const status = useQuery({ queryKey: ["integrations"], queryFn: fetchIntegrationStatus });
  if (status.isLoading) return <PageSpinner />;
  if (!status.data)
    return <EmptyState title="Couldn't load integrations" description={(status.error as Error | null)?.message} />;
  return (
    <div className="space-y-8">
      <WhatsAppSettings s={status.data} />
      <EmailSettings s={status.data} />
      <EmailInboxSettings s={status.data} />
    </div>
  );
}

function IntegrationTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="grid place-items-center h-5 w-5 rounded bg-accent-soft text-accent">{icon}</span>
      {children}
    </span>
  );
}

function WhatsAppSettings({ s }: { s: IntegrationStatus }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const wa = s.whatsapp;
  const [url, setUrl] = useState(wa.url ?? "");
  const [instance, setInstance] = useState(wa.instance ?? "");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const ready = !!(url.trim() && instance.trim() && token.trim());

  // All three empty = remove (see admin_set_greenapi).
  const save = useMutation({
    mutationFn: (v: { url: string; instance: string; token: string }) => setGreenApi(v.url, v.instance, v.token),
    onSuccess: async (_d, v) => {
      setToken("");
      if (!v.token) {
        setUrl("");
        setInstance("");
      }
      await qc.invalidateQueries({ queryKey: ["integrations"] });
      toast.push(
        v.token
          ? { kind: "success", title: "WhatsApp saved", description: "Send a test to check it works." }
          : { kind: "success", title: "WhatsApp removed" },
      );
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't save WhatsApp", description: e.message }),
  });

  const test = useMutation({
    mutationFn: testWhatsapp,
    onSuccess: (sent) => {
      void qc.invalidateQueries({ queryKey: ["integrations"] });
      toast.push(
        sent
          ? { kind: "success", title: "Test sent", description: "Check WhatsApp on your phone." }
          : { kind: "error", title: "Test not sent", description: "WhatsApp isn't connected, or the hourly limit was reached." },
      );
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Test failed", description: e.message }),
  });

  return (
    <Section
      title={<IntegrationTitle icon={<MessageCircle size={12} />}>WhatsApp (Green API)</IntegrationTitle>}
      info="Sends notifications to members who turn it on, and the WhatsApp messages from automation rules. Each person's number goes on their member card."
    >
      <div className="divide-y divide-line border-b border-line">
        <div className="py-3">
          <div className="text-sm font-medium text-ink flex flex-wrap items-center gap-2">
            <KeyRound size={14} /> Connection
            <InfoTip text="In the Green API console open your instance and copy apiUrl, idInstance and apiTokenInstance. The phone linked to the instance sends the messages." />
            {wa.configured ? (
              <Badge tone="success">Connected, instance {wa.instance}</Badge>
            ) : (
              <Badge tone="warn">Not connected</Badge>
            )}
          </div>
        </div>

        <form
          className="py-3 grid gap-3 md:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) save.mutate({ url: url.trim(), instance: instance.trim(), token: token.trim() });
          }}
        >
          <div>
            <Label htmlFor="ga-url">API URL</Label>
            <Input
              id="ga-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://7103.api.greenapi.com"
              autoComplete="off"
              spellCheck={false}
              className="max-sm:h-10"
            />
          </div>
          <div>
            <Label htmlFor="ga-id">
              Instance ID <span className="font-normal text-subtle">idInstance</span>
            </Label>
            <Input
              id="ga-id"
              inputMode="numeric"
              value={instance}
              onChange={(e) => setInstance(e.target.value.replace(/\s/g, ""))}
              placeholder="7103123456"
              autoComplete="off"
              spellCheck={false}
              className="max-sm:h-10"
            />
          </div>
          <div>
            <Label htmlFor="ga-token">
              API token <span className="font-normal text-subtle">apiTokenInstance</span>
            </Label>
            <div className="relative">
              <Input
                id="ga-token"
                type={showToken ? "text" : "password"}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={wa.configured ? "Saved. Paste it again to change" : "Paste the token"}
                autoComplete="off"
                spellCheck={false}
                className="pr-9 max-sm:h-10"
              />
              <button
                type="button"
                onClick={() => setShowToken((v) => !v)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 grid place-items-center h-7 w-7 rounded-md text-muted hover:bg-inset hover:text-ink transition-colors"
                aria-label={showToken ? "Hide token" : "Show token"}
              >
                {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>
          <div className="md:col-span-3 flex items-center justify-end gap-2">
            {wa.configured && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                iconLeft={<Trash2 size={14} />}
                disabled={save.isPending}
                className="max-sm:h-10"
                onClick={async () => {
                  const ok = await confirm({
                    title: "Remove the WhatsApp connection?",
                    message: "No WhatsApp messages are sent until it's connected again.",
                    confirmLabel: "Remove",
                    danger: true,
                  });
                  if (ok) save.mutate({ url: "", instance: "", token: "" });
                }}
              >
                Remove
              </Button>
            )}
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={save.isPending}
              disabled={!ready}
              className="max-sm:h-10"
            >
              Save
            </Button>
          </div>
        </form>

        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 py-3">
          <div className="flex-1 min-w-0 text-xs text-muted">
            Messages sent in the last hour: <span className="text-ink font-medium">{s.sent_last_hour}</span> (limit{" "}
            {SEND_LIMIT_PER_HOUR})
          </div>
          <Button
            variant="secondary"
            size="sm"
            iconLeft={<Send size={14} />}
            loading={test.isPending}
            disabled={!wa.configured}
            onClick={() => test.mutate()}
            className="max-sm:h-10"
          >
            Send a test to my WhatsApp
          </Button>
        </div>
      </div>
    </Section>
  );
}

function EmailSettings({ s }: { s: IntegrationStatus }) {
  const qc = useQueryClient();
  const toast = useToast();
  const on = s.email.configured;

  const test = useMutation({
    mutationFn: testEmail,
    onSuccess: (sent) => {
      void qc.invalidateQueries({ queryKey: ["integrations"] });
      toast.push(
        sent
          ? { kind: "success", title: "Test sent", description: "Check your inbox." }
          : { kind: "error", title: "Test not sent", description: "Email isn't connected, or the hourly limit was reached." },
      );
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Test failed", description: e.message }),
  });

  return (
    <Section
      title={<IntegrationTitle icon={<Mail size={12} />}>Email (Gmail)</IntegrationTitle>}
      info="Sends notifications to members who turn it on, and the emails from automation rules. Each person's address goes on their member card."
    >
      <div className="border-b border-line">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 py-3">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-ink flex flex-wrap items-center gap-2">
              <KeyRound size={14} /> Connection
              {on ? <Badge tone="success">Connected</Badge> : <Badge tone="warn">Not connected yet</Badge>}
            </div>
            <div className="text-xs text-muted">
              {s.email.gmail_sender
                ? `Sent from ${s.email.gmail_sender}. Shares the limit of ${SEND_LIMIT_PER_HOUR} messages an hour with WhatsApp.`
                : on
                  ? `Connected through n8n. Shares the limit of ${SEND_LIMIT_PER_HOUR} messages an hour with WhatsApp.`
                  : "Connected through n8n. Finish the Gmail setup in n8n and this turns on."}{" "}
              <Link to="/connections" className="text-accent hover:underline underline-offset-2">
                {s.email.gmail_sender ? "Change the sending account" : "Or send them from one of your Gmail accounts"}
              </Link>
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            iconLeft={<Send size={14} />}
            loading={test.isPending}
            disabled={!on}
            onClick={() => test.mutate()}
            className="max-sm:h-10"
          >
            Send a test to my email
          </Button>
        </div>
      </div>
    </Section>
  );
}

function EmailInboxSettings({ s }: { s: IntegrationStatus }) {
  const qc = useQueryClient();
  const toast = useToast();
  const targets = useQuery({ queryKey: ["inbox-targets"], queryFn: inboxTargets });

  const save = useMutation({
    mutationFn: (listId: string | null) => setEmailInbox(listId),
    onSuccess: async (_d, listId) => {
      await qc.invalidateQueries({ queryKey: ["integrations"] });
      toast.push({ kind: "success", title: listId ? "Email to card is on" : "Email to card is off" });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't save", description: e.message }),
  });

  const current = s.inbox.list_id ?? "";
  const options = [{ value: "", label: "Off" }, ...(targets.data ?? [])];
  // A list the picker doesn't offer (its board was archived): still show it.
  if (current && !options.some((o) => o.value === current))
    options.push({ value: current, label: `${s.inbox.board_title ?? "Board"} / ${s.inbox.list_title ?? "List"}` });

  return (
    <Section
      title={<IntegrationTitle icon={<Inbox size={12} />}>Email to card</IntegrationTitle>}
      info="Team members email the system's Gmail address, and each email becomes a card. Send from the email saved on your member card. The subject becomes the card's title and the text its description."
    >
      <div className="border-b border-line">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 py-3">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-ink flex flex-wrap items-center gap-2">
              List for new cards
              <InfoTip text="Only senders who can edit that board get a card." />
              {current ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}
            </div>
          </div>
          <Select
            className="w-full sm:w-72"
            aria-label="List for emailed cards"
            value={save.isPending ? (save.variables ?? "") : current}
            disabled={save.isPending || targets.isLoading}
            onChange={(v) => save.mutate(v || null)}
            options={options}
          />
        </div>
      </div>
    </Section>
  );
}
