import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { FieldError, Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { EMAIL_RE, EMAIL_TAKEN, WHATSAPP_RE, fetchTeamContacts, hasNumber, normalizeWhatsapp, saveContact, type TeamContact } from "@/lib/integrationsApi";

// -----------------------------------------------------------------------------
// The team's WhatsApp numbers and emails (0086). The bot knows who is on the
// team by their numbers, and invites them to meetings by their emails. Admins
// see who is missing one and fill them all in at once.
// -----------------------------------------------------------------------------

/** Above the members: who has no number or no email, and a way to fill them in. Nothing when everyone has both. */
export function TeamContactsNote() {
  const q = useQuery({ queryKey: ["team-contacts"], queryFn: fetchTeamContacts });
  const [open, setOpen] = useState(false);
  const missing = (q.data ?? []).filter((c) => c.active && (!hasNumber(c) || !c.email));
  if (!missing.length) return null;
  const noNumber = missing.filter((c) => !hasNumber(c)).length;
  const noEmail = missing.filter((c) => !c.email).length;
  const what = [noNumber && `${noNumber} without a WhatsApp number`, noEmail && `${noEmail} without an email`].filter(Boolean).join(", ");

  return (
    <div className="mb-4 flex flex-col gap-2 rounded-lg border border-border bg-surface px-3 py-2.5 sm:flex-row sm:items-center">
      <p className="flex-1 min-w-0 text-sm text-muted">
        <span className="text-ink">{what}.</span> The bot knows the team by their numbers and invites them to meetings by email.
      </p>
      <Button size="sm" className="shrink-0 max-sm:h-10" onClick={() => setOpen(true)}>
        Fill them in
      </Button>
      {open && <FillModal people={missing} onClose={() => setOpen(false)} />}
    </div>
  );
}

interface Row {
  whatsapp: string;
  email: string;
  error?: string;
}

function FillModal({ people, onClose }: { people: TeamContact[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [rows, setRows] = useState<Record<string, Row>>(() =>
    Object.fromEntries(people.map((c) => [c.user_id, { whatsapp: c.whatsapp ?? c.linked[0] ?? "", email: c.email ?? "" }])),
  );
  const set = (id: string, patch: Partial<Row>) => setRows((r) => ({ ...r, [id]: { ...r[id]!, ...patch, error: undefined } }));

  const save = useMutation({
    mutationFn: async () => {
      let saved = 0;
      const errors: Record<string, string> = {};
      for (const c of people) {
        const r = rows[c.user_id]!;
        const wa = r.whatsapp.trim() ? normalizeWhatsapp(r.whatsapp) : "";
        const email = r.email.trim().toLowerCase();
        if ((wa || null) === (c.whatsapp ?? null) && (email || null) === (c.email ?? null)) continue;
        if (wa && !WHATSAPP_RE.test(wa)) {
          errors[c.user_id] = "Check the number: digits with the country code.";
          continue;
        }
        if (email && !EMAIL_RE.test(email)) {
          errors[c.user_id] = "Check the email.";
          continue;
        }
        try {
          await saveContact({
            user_id: c.user_id,
            whatsapp: wa || null,
            email: email || null,
            notify_whatsapp: c.notify_whatsapp && !!wa,
            notify_email: c.notify_email && !!email,
          });
          saved++;
        } catch (e) {
          errors[c.user_id] = (e as Error).message === EMAIL_TAKEN ? EMAIL_TAKEN : (e as Error).message;
        }
      }
      return { saved, errors };
    },
    onSuccess: ({ saved, errors }) => {
      void qc.invalidateQueries({ queryKey: ["team-contacts"] });
      void qc.invalidateQueries({ queryKey: ["profile-contact"] });
      if (Object.keys(errors).length) {
        setRows((r) => Object.fromEntries(Object.entries(r).map(([id, row]) => [id, { ...row, error: errors[id] }])));
        if (saved) toast.push({ kind: "success", title: `Saved ${saved}`, description: "Some still need a look." });
        return;
      }
      toast.push({ kind: "success", title: saved ? "Saved" : "Nothing changed" });
      onClose();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't save", description: e.message }),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="The team's numbers and emails"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted mb-3">The WhatsApp number they use in the groups, with the country code, and their work email.</p>
      <ul className="divide-y divide-line">
        {people.map((c) => {
          const r = rows[c.user_id]!;
          return (
            <li key={c.user_id} className="py-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="flex items-center gap-2.5 sm:w-44 min-w-0">
                  <Avatar name={c.name} src={c.avatar_url} size={28} />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-ink truncate">{c.name}</div>
                    <div className="text-xs text-subtle truncate">@{c.username}</div>
                  </div>
                </div>
                <Input
                  inputMode="tel"
                  value={r.whatsapp}
                  onChange={(e) => set(c.user_id, { whatsapp: e.target.value })}
                  placeholder="+20 100 123 4567"
                  aria-label={`${c.name}'s WhatsApp number`}
                  className="sm:flex-1"
                />
                <Input
                  type="email"
                  value={r.email}
                  onChange={(e) => set(c.user_id, { email: e.target.value })}
                  placeholder="name@company.com"
                  aria-label={`${c.name}'s email`}
                  className="sm:flex-1"
                />
              </div>
              {r.error && <FieldError>{r.error}</FieldError>}
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
