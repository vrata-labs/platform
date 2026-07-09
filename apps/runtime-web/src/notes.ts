export type NotesSaveState = "idle" | "loading" | "ready" | "pending" | "saving" | "saved" | "failed";

export type NotesSaveEvent = "load" | "load_ok" | "edit" | "save_start" | "save_ok" | "save_failed";

export type SafeMarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "listItem"; text: string }
  | { type: "code"; text: string };

export function nextNotesSaveState(state: NotesSaveState, event: NotesSaveEvent): NotesSaveState {
  if (event === "load") return "loading";
  if (event === "load_ok") return "ready";
  if (event === "edit") return state === "loading" ? "loading" : "pending";
  if (event === "save_start") return "saving";
  if (event === "save_ok") return "saved";
  if (event === "save_failed") return "failed";
  return state;
}

export function parseSafeMarkdown(input: string): SafeMarkdownBlock[] {
  const blocks: SafeMarkdownBlock[] = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };

  const flushCode = (): void => {
    if (!code) return;
    blocks.push({ type: "code", text: code.join("\n") });
    code = null;
  };

  for (const line of input.replace(/\r\n/g, "\n").split("\n")) {
    if (line.trim().startsWith("```")) {
      if (code) {
        flushCode();
      } else {
        flushParagraph();
        code = [];
      }
      continue;
    }

    if (code) {
      code.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      blocks.push({ type: "heading", level: headingMatch[1].length as 1 | 2 | 3, text: headingMatch[2] });
      continue;
    }

    const listMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (listMatch) {
      flushParagraph();
      blocks.push({ type: "listItem", text: listMatch[1] });
      continue;
    }

    paragraph.push(trimmed);
  }

  flushCode();
  flushParagraph();
  return blocks;
}
