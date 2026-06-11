/** Strips null bytes + control chars, collapses whitespace, caps length. */
export function sanitizeInput(text: string): string {
  return text
    .replace(/\x00/g, '')
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .substring(0, 500);
}
