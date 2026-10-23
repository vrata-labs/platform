// Unicode General_Category: Format, Control, Line_Separator, Paragraph_Separator.
// No global flag: repeated checks must not depend on RegExp.lastIndex.
const forbiddenPlainTextCharacters = /[\p{Cf}\p{Cc}\p{Zl}\p{Zp}]/u;

/** Shared with the trusted Worker/broker. Does not trim, normalize or change byte limits. */
export function isRoomPluginPlainText(value: unknown): value is string {
  return typeof value === "string" && !forbiddenPlainTextCharacters.test(value);
}
