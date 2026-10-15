import { useState } from "react";
import { Check, Send } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Textarea } from "@/components/ui/Input";

// -----------------------------------------------------------------------------
// While the round is open: send the comments to the team, or approve.
// -----------------------------------------------------------------------------

type Kind = "feedback" | "approved";

export function SubmitBar({
  myComments,
  guestComments,
  onSubmit,
}: {
  /** Mine: only for the "You left N" text. */
  myComments: number;
  /** Everyone on the link this round: what the server checks before feedback. */
  guestComments: number;
  onSubmit: (kind: Kind, note: string) => Promise<void>;
}) {
  const [dialog, setDialog] = useState<Kind | null>(null);
  const hasComments = myComments > 0;

  return (
    <>
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg/90 backdrop-blur pb-[env(safe-area-inset-bottom)]">
        <div className="px-4 sm:px-6 h-16 flex items-center gap-3">
          <p className="min-w-0 flex-1 text-base text-muted truncate">
            {hasComments ? (
              <>
                <span className="hidden sm:inline">You left </span>
                <span className="font-semibold text-ink">{myComments}</span> comment{myComments === 1 ? "" : "s"}
              </>
            ) : (
              <span className="hidden sm:inline">Open an image or video to comment on it.</span>
            )}
          </p>
          <Button variant={guestComments > 0 ? "primary" : "secondary"} iconLeft={<Send size={15} />} onClick={() => setDialog("feedback")}>
            Send feedback
          </Button>
          <Button variant={guestComments > 0 ? "secondary" : "primary"} iconLeft={<Check size={16} />} onClick={() => setDialog("approved")}>
            Approve
          </Button>
        </div>
      </div>
      {dialog && <SubmitDialog kind={dialog} myComments={myComments} guestComments={guestComments} onClose={() => setDialog(null)} onSubmit={onSubmit} />}
    </>
  );
}

function SubmitDialog({
  kind,
  myComments,
  guestComments,
  onClose,
  onSubmit,
}: {
  kind: Kind;
  myComments: number;
  guestComments: number;
  onClose: () => void;
  onSubmit: (kind: Kind, note: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const feedback = kind === "feedback";
  const canSend = !feedback || guestComments > 0 || note.trim() !== "";

  const send = async () => {
    setBusy(true);
    try {
      await onSubmit(kind, note);
      onClose();
    } catch {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      size="sm"
      title={feedback ? "Send feedback" : "Approve this delivery"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!canSend} onClick={() => void send()}>
            {feedback ? "Send feedback" : "Approve"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {feedback ? (
          <p className="text-base text-ink">
            {myComments > 0 ? (
              <>
                You left <span className="font-semibold">{myComments}</span> comment{myComments === 1 ? "" : "s"}.
              </>
            ) : guestComments > 0 ? (
              <>
                This round has <span className="font-semibold">{guestComments}</span> comment{guestComments === 1 ? "" : "s"} from
                people with this link.
              </>
            ) : (
              "You haven't left any comments yet. Add a note below, or go back and comment on the images and videos."
            )}
          </p>
        ) : (
          <p className="text-base text-ink">Let the team know everything looks good.</p>
        )}
        <div>
          <label htmlFor="dv-note" className="block text-sm font-medium text-ink mb-1">
            {feedback ? "Overall note" : "Note"} <span className="font-normal text-subtle">(optional)</span>
          </label>
          <Textarea
            id="dv-note"
            rows={4}
            maxLength={4000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={feedback ? "Anything that applies to the whole delivery" : "Anything you'd like to add"}
          />
        </div>
        <p className="text-sm text-muted">
          {feedback
            ? "The team will see it, and this link becomes read only until the next round."
            : "The team will see it, and this link becomes read only."}
        </p>
      </div>
    </Modal>
  );
}
