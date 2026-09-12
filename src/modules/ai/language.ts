/** Choose the dominant script of the latest message, never the source documents. */
export function replyLanguage(text: string): 'en'|'ar' {
  const ar = (text.match(/[\u0621-\u064a\u0660-\u0669]/g) ?? []).length;
  const latin = (text.match(/[a-z]/gi) ?? []).length;
  return ar > 0 && ar >= latin ? 'ar' : 'en';
}
