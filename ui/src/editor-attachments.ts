import type { BlockNoteEditor, PartialBlock } from "@blocknote/core";

/** Own the async insertion so a navigation/deletion cannot update a foreign document. */
export function insertAttachmentFiles(event: ClipboardEvent | DragEvent, editor: BlockNoteEditor<any, any, any>) {
  const transfer = "clipboardData" in event ? event.clipboardData : event.dataTransfer;
  // Match BlockNote's format priority for mixed HTML/text/file clipboards.
  // Rich clipboard content continues through its existing paste/drop handler.
  if (["vscode-editor-data", "blocknote/html", "text/markdown", "text/html", "text/plain"].some((type) => transfer?.types.includes(type))) return false;
  const files = Array.from(transfer?.files ?? []);
  if (!files.length || !editor.uploadFile || !editor.isEditable) return false;
  event.preventDefault();
  event.stopPropagation();
  const targetId = event.type === "drop" && event.target instanceof Element
    ? event.target.closest("[data-id]")?.getAttribute("data-id") : null;
  let reference = (targetId && editor.getBlock(targetId)) || editor.getTextCursorPosition().block;
  // Insert all placeholders synchronously; each upload captures its page before
  // the user can navigate. Do not wait for the first file before starting others.
  for (const file of files) {
    const type = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : "file";
    const block: PartialBlock = { type, props: { name: file.name, url: "" } };
    const inserted = Array.isArray(reference.content) && reference.content.length === 0
      ? editor.updateBlock(reference, block) : editor.insertBlocks([block], reference, "after")[0];
    reference = inserted;
    void editor.uploadFile(file, inserted.id).then((result) => {
      // The upload callback checks document ownership and handles a departed page.
      if (!editor.getBlock(inserted.id)) return;
      editor.updateBlock(inserted.id, typeof result === "string" ? { props: { url: result, name: file.name } } : result);
    }).catch(() => {
      // uploadNodiAttachment reports failures; the owner callback removes only
      // its own empty placeholder. Handled uploads after navigation also reject.
    });
  }
  return true;
}

export function updateAttachmentBlock(blocks: PartialBlock[], id: string, url: string | null): PartialBlock[] {
  return blocks.flatMap((block): PartialBlock[] => {
    if (block.id === id) {
      if (url === null) return (block.props as { url?: string } | undefined)?.url ? [block] : [];
      return [{ ...block, props: { ...block.props, url } } as PartialBlock];
    }
    return [{ ...block, ...(block.children ? { children: updateAttachmentBlock(block.children as PartialBlock[], id, url) } : {}) }];
  });
}
