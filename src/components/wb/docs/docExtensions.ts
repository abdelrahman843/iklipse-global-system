import { mergeAttributes, type Editor } from "@tiptap/react";
import ImageExt from "@tiptap/extension-image";
import Mention from "@tiptap/extension-mention";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import { cachedImageUrl, imageUrl, isUploadableImage, sendImage, uploadImage } from "@/lib/wb/api";
import { IMG_PATH } from "@/lib/wb/docBlocks";
import type { WbPerson } from "@/lib/wb/people";

// -----------------------------------------------------------------------------
// Doc editor pieces: images stored in the board's private bucket (the node
// keeps the storage path; a signed URL is fetched to show it), and @mentions
// with a people picker.
// -----------------------------------------------------------------------------

/** Image node that stores a storage path, never a URL (signed URLs expire). */
export const DocImage = ImageExt.extend({
  addAttributes() {
    return {
      path: { default: null },
      alt: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "img[data-path]", getAttrs: (el) => ({ path: (el as HTMLElement).getAttribute("data-path") }) }];
  },
  renderHTML({ HTMLAttributes }) {
    const { path, ...rest } = HTMLAttributes as { path?: string };
    return ["img", mergeAttributes(rest, { "data-path": path ?? "" })];
  },
  addNodeView() {
    return ({ node }) => {
      const img = document.createElement("img");
      img.className = "wb-doc-img";
      img.draggable = false;
      let shown: string | null = null;
      const show = (path: unknown) => {
        if (typeof path !== "string" || !IMG_PATH.test(path) || path === shown) return;
        shown = path;
        const hit = cachedImageUrl(path);
        if (hit) img.src = hit;
        else void imageUrl(path).then((u) => u && shown === path && (img.src = u));
      };
      show(node.attrs.path);
      return {
        dom: img,
        update: (n) => {
          if (n.type.name !== node.type.name) return false;
          show(n.attrs.path);
          return true;
        },
      };
    };
  },
}).configure({ inline: false, allowBase64: false });

/** Upload images, then put them in the doc (at `pos`, or at the caret). */
export async function insertDocImages(editor: Editor, boardId: string, files: File[], onError: (msg: string) => void, onBusy: (d: number) => void, pos?: number) {
  const list = files.filter(isUploadableImage);
  if (list.length < files.length) onError("Only PNG, JPEG, GIF and WebP images can go in a doc.");
  for (const f of list) {
    onBusy(1);
    try {
      const { path } = await uploadImage(boardId, f);
      // Upload first, so everyone else can load the image as soon as it appears.
      await sendImage(path, f);
      if (editor.isDestroyed) return;
      // A line after the image takes the caret, so typing never replaces the image.
      const content = [{ type: "image", attrs: { path } }, { type: "paragraph" }];
      const sel = editor.state.selection;
      const at = pos ?? ("node" in sel ? sel.to : undefined);
      const chain = editor.chain().focus();
      (at != null ? chain.insertContentAt(at, content) : chain.insertContent(content)).run();
      pos = undefined;
    } catch (e) {
      onError((e as Error).message);
    } finally {
      onBusy(-1);
    }
  }
}

// ---------------------------------------------------------------- mentions --
export interface MentionMenu {
  items: WbPerson[];
  index: number;
  rect: DOMRect | null;
  pick: (p: WbPerson) => void;
}

/**
 * @mentions. `people()` is read at typing time; `show` drives the picker the
 * editor renders; `picked` runs after a mention goes in (to notify).
 */
export function docMention(opts: { people: () => WbPerson[]; show: (m: MentionMenu | null) => void; picked: (p: WbPerson, editor: Editor) => void }) {
  return Mention.configure({
    HTMLAttributes: { class: "wb-mention" },
    renderText: ({ node }) => `@${node.attrs.label ?? "someone"}`,
    renderHTML: ({ options, node }) => ["span", mergeAttributes({ "data-type": "mention" }, options.HTMLAttributes), `@${node.attrs.label ?? "someone"}`],
    suggestion: {
      char: "@",
      items: ({ query }) => {
        const q = query.toLowerCase();
        return opts
          .people()
          .filter((p) => p.is_active && (p.display_name.toLowerCase().includes(q) || p.username.toLowerCase().includes(q)))
          .slice(0, 6);
      },
      command: ({ editor, range, props }) => {
        const p = props as unknown as WbPerson;
        editor
          .chain()
          .focus()
          .insertContentAt(range, [
            { type: "mention", attrs: { id: p.id, label: p.display_name } },
            { type: "text", text: " " },
          ])
          .run();
        opts.picked(p, editor);
      },
      render: () => {
        let menu: MentionMenu | null = null;
        let props: SuggestionProps<WbPerson> | null = null;
        const publish = (index: number) => {
          if (!props) return;
          const cur = props;
          menu = {
            items: cur.items,
            index: Math.max(0, Math.min(index, cur.items.length - 1)),
            rect: cur.clientRect?.() ?? null,
            pick: (p) => cur.command(p as never),
          };
          opts.show(menu);
        };
        return {
          onStart: (p: SuggestionProps<WbPerson>) => {
            props = p;
            publish(0);
          },
          onUpdate: (p: SuggestionProps<WbPerson>) => {
            props = p;
            publish(menu?.index ?? 0);
          },
          onKeyDown: ({ event }: SuggestionKeyDownProps) => {
            if (!menu || !menu.items.length) return false;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              publish((menu.index + (event.key === "ArrowDown" ? 1 : -1) + menu.items.length) % menu.items.length);
              return true;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              menu.pick(menu.items[menu.index]!);
              return true;
            }
            if (event.key === "Escape") {
              menu = null;
              opts.show(null);
              return true;
            }
            return false;
          },
          onExit: () => {
            menu = null;
            props = null;
            opts.show(null);
          },
        };
      },
    },
  });
}
