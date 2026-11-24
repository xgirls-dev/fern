export function isComposingKey(event: Pick<KeyboardEvent, "isComposing" | "keyCode">) {
  // Some IMEs emit a key with code 229 even when isComposing is false.
  return event.isComposing || event.keyCode === 229;
}
