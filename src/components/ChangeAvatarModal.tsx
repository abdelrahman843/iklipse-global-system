import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Trash2, Upload } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Avatar } from "@/components/ui/Avatar";
import { useToast } from "@/components/ui/Toast";
import { useAuth } from "@/lib/auth";
import { AVATAR_ACCEPT, avatarFileError, removeAvatar, uploadAvatar } from "@/lib/profileApi";

// Everything that embeds profile pictures: board members, card members,
// comment authors, activity, member pickers, the users admin list.
const AVATAR_QUERIES = ["board", "board-members", "card", "activity", "profiles-active", "users"];

export function ChangeAvatarModal({
  open,
  onClose,
  current,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  /** The picture shown right now (may be ahead of the auth profile). */
  current: string | null | undefined;
  onChanged: (url: string | null) => void;
}) {
  const { user, profile } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);

  const done = (url: string | null, title: string) => {
    onChanged(url);
    for (const k of AVATAR_QUERIES) qc.invalidateQueries({ queryKey: [k] });
    toast.push({ kind: "success", title });
    onClose();
  };

  const pick = async (file: File) => {
    if (!user) return;
    const invalid = avatarFileError(file);
    if (invalid) {
      toast.push({ kind: "error", title: "Couldn't use that picture", description: invalid });
      return;
    }
    setBusy("upload");
    try {
      done(await uploadAvatar(user.id, file, current), "Profile picture updated");
    } catch (e) {
      toast.push({ kind: "error", title: "Couldn't upload picture", description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!user) return;
    setBusy("remove");
    try {
      await removeAvatar(user.id, current);
      done(null, "Profile picture removed");
    } catch (e) {
      toast.push({ kind: "error", title: "Couldn't remove picture", description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title="Profile picture"
      size="sm"
      footer={
        <Button variant="secondary" onClick={onClose} disabled={!!busy}>
          Cancel
        </Button>
      }
    >
      <div className="flex flex-col items-center gap-4 py-2">
        <Avatar name={profile?.display_name ?? "?"} src={current} size={96} />
        <p className="text-xs text-subtle text-center">PNG, JPEG, WebP or GIF, up to 2 MB.</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            variant="primary"
            iconLeft={<Upload size={14} />}
            loading={busy === "upload"}
            disabled={!!busy}
            onClick={() => fileRef.current?.click()}
          >
            Upload new
          </Button>
          {current && (
            <Button
              variant="secondary"
              iconLeft={<Trash2 size={14} />}
              loading={busy === "remove"}
              disabled={!!busy}
              onClick={remove}
            >
              Remove
            </Button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept={AVATAR_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void pick(file);
          }}
        />
      </div>
    </Modal>
  );
}
