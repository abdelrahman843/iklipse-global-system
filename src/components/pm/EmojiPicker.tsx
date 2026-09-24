import { lazy, Suspense } from "react";
import { useTheme } from "@/lib/theme";
import { Spinner } from "@/components/ui/Spinner";

// emoji-mart (picker + its ~400 KB emoji dataset) is loaded on first open only,
// so it never weighs on the initial bundle.
const Picker = lazy(async () => {
  const [{ default: P }, { default: data }] = await Promise.all([
    import("@emoji-mart/react"),
    import("@emoji-mart/data"),
  ]);
  function Loaded(props: { theme: string; onEmojiSelect: (e: { native: string }) => void }) {
    return <P data={data} previewPosition="bottom" skinTonePosition="preview" maxFrequentRows={1} {...props} />;
  }
  return { default: Loaded };
});

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const { theme } = useTheme();
  return (
    <Suspense
      fallback={
        <div className="w-[352px] max-w-full h-[435px] grid place-items-center">
          <Spinner size={16} />
        </div>
      }
    >
      <Picker theme={theme} onEmojiSelect={(e) => onPick(e.native)} />
    </Suspense>
  );
}
