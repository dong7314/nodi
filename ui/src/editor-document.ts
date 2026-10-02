import type { BlockNoteEditor, PartialBlock } from "@blocknote/core";
import { HistoryExtension } from "@blocknote/core/extensions";

/** Load a persisted document without making navigation an undoable edit. */
export function replacePageDocument(
  editor: BlockNoteEditor<any, any, any>,
  blocks: PartialBlock[],
) {
  editor.transact((transaction) => {
    transaction.setMeta("addToHistory", false);
    editor.replaceBlocks(
      editor.document,
      blocks.length ? blocks : [{ type: "paragraph", content: "" }],
    );
  });

  // addToHistory=false alone still maps the old undo/redo steps through the
  // replacement. Discard only the history plugin's state; keep the document,
  // selection and every other BlockNote plugin intact. Update the view once.
  const history = editor.getExtension(HistoryExtension);
  if (!history) return;
  const historyPlugins = new Set(history.prosemirrorPlugins);
  const state = editor.prosemirrorState;
  const withoutHistory = state.reconfigure({
    plugins: state.plugins.filter((plugin) => !historyPlugins.has(plugin)),
  });
  editor.prosemirrorView.updateState(withoutHistory.reconfigure({ plugins: state.plugins }));
}
