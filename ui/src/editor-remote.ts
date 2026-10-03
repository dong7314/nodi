import { blockToNode, type BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { Selection, TextSelection, type Transaction } from "prosemirror-state";

type Editor = BlockNoteEditor<any, any, any>;
type Document = Editor["prosemirrorState"]["doc"];

function blockPositions(doc: Document) {
  const positions = new Map<string, { pos: number; size: number }>();
  doc.descendants((node, pos) => {
    if (typeof node.attrs.id === "string") positions.set(node.attrs.id, { pos, size: node.nodeSize });
  });
  return positions;
}

function preserveReplacementSelection(transaction: Transaction, before: Document, selection: Selection) {
  const previous = blockPositions(before);
  const next = blockPositions(transaction.doc);
  const json = selection.toJSON();
  for (const key of ["anchor", "head"] as const) {
    if (typeof json[key] !== "number") continue;
    const position = before.resolve(json[key]);
    let id: string | undefined = before.nodeAt(position.pos)?.attrs.id;
    for (let depth = position.depth; !id && depth > 0; depth--) {
      if (typeof position.node(depth).attrs.id === "string") { id = position.node(depth).attrs.id; break; }
    }
    if (!id || !previous.has(id)) { json[key] = transaction.mapping.map(position.pos); continue; }
    const old = previous.get(id)!;
    const retained = next.get(id);
    if (retained) json[key] = retained.pos + Math.min(Math.max(0, position.pos - old.pos), retained.size - 1);
    else {
      // If the selected block was deleted, stay next to its former location
      // instead of mapping the entire replaced document to its end.
      const neighbor = [...previous].filter(([candidate]) => next.has(candidate))
        .sort((a, b) => Math.abs(a[1].pos - old.pos) - Math.abs(b[1].pos - old.pos))[0];
      json[key] = neighbor ? Selection.near(transaction.doc.resolve(next.get(neighbor[0])!.pos + 1)).head
        : Selection.atStart(transaction.doc).head;
    }
  }
  try {
    return json.type === "text"
      ? TextSelection.between(transaction.doc.resolve(json.anchor), transaction.doc.resolve(json.head))
      : Selection.fromJSON(transaction.doc, json);
  }
  catch { return selection.getBookmark().map(transaction.mapping).resolve(transaction.doc); }
}

/** Remote document changes must not adopt a command's editing selection or
 * move the reader's viewport. Navigation and local edits use their usual path. */
export function applyRemoteEditorChange(
  editor: Editor,
  change: (transaction: Transaction) => void,
  replacingDocument = false,
) {
  const view = editor.prosemirrorView;
  const stage = view.dom.closest<HTMLElement>(".editor-stage, .page-preview-content");
  const scrollTop = stage?.scrollTop ?? 0;
  const scrollLeft = stage?.scrollLeft ?? 0;
  const viewport = stage?.getBoundingClientRect();
  const anchors = new Map<string, number>();
  const partialAnchors = new Map<string, number>();
  // At the top, preserve the title/header viewport rather than following the
  // first body block down when a peer inserts content before it.
  if (viewport && scrollTop > 0) for (const element of view.dom.querySelectorAll<HTMLElement>("[data-id]")) {
    const id = element.dataset.id!;
    // BlockNote puts the same ID on a block's outer and inner wrappers.
    if (anchors.has(id) || partialAnchors.has(id)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.bottom > viewport.top && rect.top < viewport.bottom && rect.height > 0) {
      (rect.top >= viewport.top ? anchors : partialAnchors).set(id, rect.top);
    }
  }
  try {
    editor.transact(transaction => {
      const before = transaction.doc;
      const selection = transaction.selection;
      const bookmark = selection.getBookmark();
      const marks = transaction.storedMarks;
      transaction.setMeta("addToHistory", false);
      change(transaction);
      transaction.setSelection(replacingDocument
        ? preserveReplacementSelection(transaction, before, selection)
        : bookmark.map(transaction.mapping).resolve(transaction.doc));
      if (marks) transaction.setStoredMarks(marks);
    });
  } finally {
    if (stage) {
      let offset: number | undefined;
      for (const [id, top] of [...anchors, ...partialAnchors]) {
        const retained = view.dom.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
        if (retained) { offset = retained.getBoundingClientRect().top - top; break; }
      }
      // Account for content inserted above the viewport as well as any native
      // scroll anchoring already performed while the editor updated its DOM.
      stage.scrollTop = offset !== undefined ? stage.scrollTop + offset : scrollTop;
      stage.scrollLeft = scrollLeft;
    }
  }
}

export function replaceRemoteEditorDocument(editor: Editor, blocks: PartialBlock[]) {
  applyRemoteEditorChange(editor, transaction => {
    const group = transaction.doc.firstChild!;
    const nodes = blocks.map(block => blockToNode(block, transaction.doc.type.schema));
    nodes.forEach(node => node.check());
    let prefix = 0, suffix = 0, start = 1, end = group.content.size + 1;
    while (prefix < Math.min(group.childCount, nodes.length) && group.child(prefix).eq(nodes[prefix])) {
      start += group.child(prefix++).nodeSize;
    }
    while (suffix < Math.min(group.childCount, nodes.length) - prefix
      && group.child(group.childCount - suffix - 1).eq(nodes[nodes.length - suffix - 1])) {
      end -= group.child(group.childCount - ++suffix).nodeSize;
    }
    // Keep unchanged DOM (including an active composition) before/after the
    // changed range instead of removing and reinserting the entire document.
    if (start !== end || nodes.length !== prefix + suffix) {
      transaction.replaceWith(start, end, nodes.slice(prefix, nodes.length - suffix));
    }
  }, true);
}
