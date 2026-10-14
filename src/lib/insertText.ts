// Dictation into Spechy's own window. The backend cannot paste into its own webview
// (Ctrl+V after refocusing the top-level window lands nowhere), so it sends the text
// as EV_INSERT_TEXT and this module types it into the field the user was in.
import { isTauri } from "@tauri-apps/api/core";
import { api, type Toast } from "./ipc";

type TextField = HTMLInputElement | HTMLTextAreaElement;
type Editable = TextField | HTMLElement;

/** Input types that hold free text. Password fields are never filled. */
const TEXT_INPUT_TYPES = new Set(["", "text", "search", "url", "tel", "email"]);

function isTextField(el: Element): el is TextField {
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type.toLowerCase());
}

function isPassword(el: Element | null): boolean {
  return el instanceof HTMLInputElement && el.type.toLowerCase() === "password";
}

/** A field the dictation may go into right now. */
function isWritable(el: Element | null): el is Editable {
  if (!el || !el.isConnected) return false;
  if (isTextField(el)) return !el.disabled && !el.readOnly;
  return el instanceof HTMLElement && el.isContentEditable;
}

// ---------- Focus tracking ----------
// document.activeElement is not reliable when the event arrives: the backend may have
// moved the OS focus around, and clicking plain page areas moves it to <body>.

let lastField: Editable | null = null;
/** Last caret inside a contenteditable, it is lost when the element blurs. */
let lastRange: Range | null = null;
let tracking = false;

function onFocusIn(e: FocusEvent) {
  const el = e.target instanceof Element ? e.target : null;
  lastField = isWritable(el) ? el : null;
  if (!lastField) lastRange = null;
}

function onFocusOut() {
  // Focus leaving the whole window (another app, the backend refocusing) keeps the field.
  // Focus moving to plain page content inside a focused window forgets it, so a
  // dictation after clicking elsewhere does not land in a field the user already left.
  window.setTimeout(() => {
    if (!document.hasFocus()) return;
    const active = document.activeElement;
    if (!active || active === document.body || !isWritable(active)) {
      lastField = null;
      lastRange = null;
    }
  }, 0);
}

function onSelectionChange() {
  if (!lastField || isTextField(lastField)) return;
  const sel = document.getSelection();
  if (sel && sel.rangeCount > 0 && lastField.contains(sel.anchorNode)) lastRange = sel.getRangeAt(0).cloneRange();
}

/** Start remembering the last focused text field. Returns a cleanup function. */
export function trackFocusedField(): () => void {
  if (tracking) return () => {};
  tracking = true;
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  document.addEventListener("selectionchange", onSelectionChange);
  const active = document.activeElement;
  if (isWritable(active)) lastField = active;
  return () => {
    tracking = false;
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
    document.removeEventListener("selectionchange", onSelectionChange);
  };
}

// ---------- Insertion ----------

/** Like Wispr Flow: glue a space in front when the caret sits right after a word. */
function withLeadingSpace(before: string, text: string): string {
  if (!before || !text) return text;
  const prev = before[before.length - 1];
  if (/\s/.test(prev) || "([{".includes(prev)) return text;
  if (/^[\s.,;:!?)\]}]/.test(text)) return text;
  return ` ${text}`;
}

const nativeValueSetter = (el: TextField) =>
  Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")?.set;

function insertIntoField(el: TextField, text: string): boolean {
  const value = el.value;
  // email inputs have no selection API (null); insert at the end there.
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? start;
  const insert = withLeadingSpace(value.slice(0, start), text);
  const expected = value.slice(0, start) + insert + value.slice(end);
  const caret = start + insert.length;

  el.focus({ preventScroll: true });
  try { el.setSelectionRange(start, end); } catch { /* type without selection API */ }

  // execCommand keeps the native undo stack and fires a real input event React sees.
  let done = false;
  try { done = document.execCommand("insertText", false, insert) && el.value === expected; } catch { done = false; }

  if (!done) {
    // React-controlled fields: write through the prototype setter so React's value
    // tracker notices the change, then announce it with a bubbling input event.
    const setter = nativeValueSetter(el);
    if (setter) setter.call(el, expected);
    else el.value = expected;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    if (el.value !== expected) return false;
  }

  try { el.setSelectionRange(caret, caret); } catch { /* type without selection API */ }
  return true;
}

function insertIntoEditable(el: HTMLElement, text: string): boolean {
  el.focus({ preventScroll: true });
  const sel = document.getSelection();
  if (!sel) return false;
  if (lastRange && el.contains(lastRange.startContainer)) {
    sel.removeAllRanges();
    sel.addRange(lastRange);
  } else if (sel.rangeCount === 0 || !el.contains(sel.anchorNode)) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  let before = "";
  if (sel.rangeCount > 0) {
    const probe = document.createRange();
    probe.selectNodeContents(el);
    const current = sel.getRangeAt(0);
    probe.setEnd(current.startContainer, current.startOffset);
    before = probe.toString();
  }
  const insert = withLeadingSpace(before, text);
  let done = false;
  try { done = document.execCommand("insertText", false, insert); } catch { done = false; }
  if (!done && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(insert);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: insert }));
    done = true;
  }
  if (done && sel.rangeCount > 0) lastRange = sel.getRangeAt(0).cloneRange();
  return done;
}

/** Put the text into the field the user was in. False when there is no usable field. */
export function insertAtCursor(text: string): boolean {
  const active = document.activeElement;
  if (isPassword(active)) return false;
  const target = isWritable(active) ? active : lastField;
  if (!target || !isWritable(target)) return false;
  try {
    return isTextField(target) ? insertIntoField(target, text) : insertIntoEditable(target, text);
  } catch {
    return false;
  }
}

async function copyText(text: string): Promise<boolean> {
  if (isTauri()) {
    try { await api.copyToClipboard(text); return true; } catch { /* try the web API */ }
  }
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/** Handler for EV_INSERT_TEXT: insert at the cursor, otherwise hand the text over via the clipboard. */
export async function deliverDictation(text: string, toast: (t: Toast) => void): Promise<void> {
  if (!text) return;
  if (insertAtCursor(text)) return;
  if (await copyText(text)) toast({ kind: "success", message: "The dictation is on your clipboard." });
  else toast({ kind: "error", message: "The dictation could not be inserted. It is saved in your history on Home." });
}
