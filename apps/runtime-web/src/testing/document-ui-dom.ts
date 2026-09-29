import type { TestContext } from "node:test";

// Deliberately small browser boundary: unsupported selectors fail instead of
// silently pretending to implement a complete DOM.
export class DocumentTestElement extends EventTarget {
  hidden = false;
  disabled = false;
  checked = false;
  selected = false;
  value = "";
  max = "";
  type = "";
  className = "";
  textContent = "";
  href = "";
  download = "";
  width = 0;
  height = 0;
  files: ArrayLike<File> | null = null;
  dataset: Record<string, string> = {};
  children: unknown[] = [];
  attributes = new Map<string, string>();
  removed = false;
  clickCount = 0;
  constructor(readonly tagName = "div") { super(); }
  append(...nodes: unknown[]): void { this.children.push(...nodes); }
  replaceChildren(...nodes: unknown[]): void { this.children = nodes; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  remove(): void { this.removed = true; }
  click(): void { this.clickCount += 1; this.dispatchEvent(new Event("click")); }
  change(): void { this.dispatchEvent(new Event("change")); }
  elements(): DocumentTestElement[] {
    return this.children.filter((node): node is DocumentTestElement => node instanceof DocumentTestElement);
  }
  querySelectorAll<T extends Element = Element>(selector: string): NodeListOf<T> {
    if (selector !== ".presentation-thumbnail") throw new Error(`unsupported_test_selector:${selector}`);
    // The runtime only iterates this collection and uses the implemented button
    // fields. The cast is confined to this browser test-double boundary.
    return this.elements().filter((node) => node.className === "presentation-thumbnail") as unknown as NodeListOf<T>;
  }
}

export class DocumentTestStorage implements Storage {
  private readonly values = new Map<string, string>();
  readonly writes: Array<[string, string | null]> = [];
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); this.writes.push([key, null]); }
  setItem(key: string, value: string): void { this.values.set(key, String(value)); this.writes.push([key, String(value)]); }
}

export function installDocumentTestDom(t: TestContext) {
  const created: DocumentTestElement[] = [];
  const body = new DocumentTestElement("body");
  const storage = new DocumentTestStorage();
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const blobs: Blob[] = [];
  const revoked: string[] = [];
  const globals = {
    document: { body, createElement(tag: string) {
      const element = new DocumentTestElement(tag); created.push(element); return element;
    } },
    localStorage: storage,
    Option: class extends DocumentTestElement {
      constructor(text: string, value: string) { super("option"); this.textContent = text; this.value = value; }
    },
    window: { setTimeout(callback: () => void, delay: number) {
      timers.push({ callback, delay }); return timers.length;
    } }
  };
  for (const [name, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  t.mock.method(URL, "createObjectURL", (blob: Blob) => { blobs.push(blob); return "blob:document-test"; });
  t.mock.method(URL, "revokeObjectURL", (url: string) => { revoked.push(url); });
  return { created, body, storage, timers, blobs, revoked };
}
