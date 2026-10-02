/** Safari can send the composition-confirming key with isComposing=false. */
export function isComposingKey(event: { isComposing: boolean; keyCode: number }) {
  return event.isComposing || event.keyCode === 229;
}
