/**
 * Strips emoji and unsupported non-LVGL characters while preserving ASCII
 * plus verified G2 LVGL symbols (arrows, bullets, block bars, box lines).
 */
export function sanitizeForG2(input: string): string {
  // Remove Extended_Pictographic / emoji sequences
  const noEmoji = input.replace(/\p{Extended_Pictographic}/gu, '').replace(/\uFE0F/g, '');
  // Keep printable ASCII, newline, middle dot, arrows, block elements, box drawing
  return noEmoji
    .replace(/[^\x20-\x7E\n\u00B7\u2190-\u2195\u2500-\u257F\u2580-\u259F\u25A0-\u25FF]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function hasEmoji(input: string): boolean {
  return /\p{Extended_Pictographic}/u.test(input);
}
