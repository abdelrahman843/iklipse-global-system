import { Map as MapIcon, Minus, Plus } from "lucide-react";
import { Menu, MenuItem } from "@/components/ui/Menu";
import { cn } from "@/lib/cn";
import { useWb, animateViewport, viewCenter, zoomAt, zoomToFit } from "@/lib/wb/store";

// Bottom-right zoom bar of a board (also on boards shared by link).

const S = useWb.getState;
const set = useWb.setState;

export function ZoomControls({ map = true }: { map?: boolean }) {
  const zoom = useWb((s) => s.viewport.zoom);
  const minimap = useWb((s) => s.showMinimap);
  const at = () => ({ x: S().screen.w / 2, y: S().screen.h / 2 });
  const to = (z: number) => {
    const s = S();
    const c = viewCenter();
    animateViewport({ zoom: z, x: s.screen.w / 2 - c.x * z, y: s.screen.h / 2 - c.y * z }, 200);
  };
  const btn = "h-8 w-8 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink";
  return (
    <div
      data-wb-ui
      className="absolute z-20 right-3 bottom-3 max-md:bottom-[4.5rem] flex items-center gap-0.5 p-1 bg-surface border border-border rounded-lg shadow-pop animate-slide-up"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {map && (
        <button className={cn(btn, minimap && "bg-accent-soft text-accent")} onClick={() => set({ showMinimap: !minimap })} title="Map" aria-label="Map">
          <MapIcon size={16} />
        </button>
      )}
      <button className={cn(btn, "max-sm:hidden")} onClick={() => zoomAt(at(), zoom / 1.25)} title="Zoom out (Ctrl+-)" aria-label="Zoom out">
        <Minus size={16} />
      </button>
      <Menu
        align="right"
        trigger={
          <button className="h-8 min-w-14 px-1 rounded-md text-sm text-ink tabular-nums hover:bg-inset" title="Zoom" aria-label="Zoom level">
            {Math.round(zoom * 100)}%
          </button>
        }
      >
        {(close) => (
          <div className="min-w-[200px]">
            <MenuItem onClick={() => (zoomToFit(), close())}>
              <span className="flex justify-between gap-4 w-full">
                Zoom to fit <span className="text-xs text-subtle">Shift+1</span>
              </span>
            </MenuItem>
            {[0.5, 1, 2].map((z) => (
              <MenuItem key={z} onClick={() => (to(z), close())}>
                <span className="flex justify-between gap-4 w-full">
                  Zoom to {z * 100}% {z === 1 && <span className="text-xs text-subtle">Ctrl+0</span>}
                </span>
              </MenuItem>
            ))}
          </div>
        )}
      </Menu>
      <button className={cn(btn, "max-sm:hidden")} onClick={() => zoomAt(at(), zoom * 1.25)} title="Zoom in (Ctrl+=)" aria-label="Zoom in">
        <Plus size={16} />
      </button>
    </div>
  );
}
