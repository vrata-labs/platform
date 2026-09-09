export interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

export function parseMultipartBoundary(contentType: string | undefined): string | null {
  const match = contentType?.match(/(?:^|;)\s*boundary=("([^"]+)"|[^;]+)/i);
  return match ? (match[2] ?? match[1]).replace(/^"|"$/g, "") : null;
}

function parseContentDisposition(value: string | undefined): { name?: string; filename?: string } {
  const result: { name?: string; filename?: string } = {};
  for (const part of value?.split(";") ?? []) {
    const [rawKey, ...rawValueParts] = part.trim().split("=");
    const key = rawKey?.trim().toLowerCase();
    if (!key || rawValueParts.length === 0) continue;
    const rawValue = rawValueParts.join("=").trim();
    const valueText = rawValue.replace(/^"|"$/g, "");
    if (key === "name") result.name = valueText;
    if (key === "filename") result.filename = valueText;
  }
  return result;
}

export function parseMultipartFormData(buffer: Buffer, boundary: string): MultipartPart[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const prefixedDelimiter = Buffer.from(`\r\n--${boundary}`);
  const headerTerminator = Buffer.from("\r\n\r\n");
  const parts: MultipartPart[] = [];
  let cursor = buffer.indexOf(delimiter);
  if (cursor < 0) throw new Error("invalid_multipart_body");

  while (cursor >= 0) {
    cursor += delimiter.byteLength;
    if (buffer.subarray(cursor, cursor + 2).toString("utf8") === "--") break;
    if (buffer.subarray(cursor, cursor + 2).toString("utf8") === "\r\n") cursor += 2;
    const headerEnd = buffer.indexOf(headerTerminator, cursor);
    if (headerEnd < 0) throw new Error("invalid_multipart_part_headers");
    const headers = new Map<string, string>();
    const headerText = buffer.subarray(cursor, headerEnd).toString("utf8");
    for (const line of headerText.split("\r\n")) {
      const separator = line.indexOf(":");
      if (separator <= 0) continue;
      headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }
    const contentStart = headerEnd + headerTerminator.byteLength;
    const nextBoundary = buffer.indexOf(prefixedDelimiter, contentStart);
    if (nextBoundary < 0) throw new Error("invalid_multipart_part_body");
    const disposition = parseContentDisposition(headers.get("content-disposition"));
    if (disposition.name) {
      parts.push({
        name: disposition.name,
        filename: disposition.filename,
        contentType: headers.get("content-type"),
        data: buffer.subarray(contentStart, nextBoundary)
      });
    }
    cursor = nextBoundary + 2;
  }

  return parts;
}

export function textPart(parts: MultipartPart[], name: string): string | undefined {
  const value = parts.find((part) => part.name === name && !part.filename)?.data.toString("utf8").trim();
  return value && value.length > 0 ? value : undefined;
}

export function filePart(parts: MultipartPart[], name: string): MultipartPart | undefined {
  return parts.find((part) => part.name === name && Boolean(part.filename));
}
