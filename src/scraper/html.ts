const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '\uFFFD';
  return String.fromCodePoint(code);
}

/** Turn LIHKG's HTML body into the plain text the archive stores and displays. */
export function decodeHtml(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
      if (entity.startsWith('#x') || entity.startsWith('#X')) {
        return safeCodePoint(Number.parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith('#')) {
        return safeCodePoint(Number.parseInt(entity.slice(1), 10));
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    })
    .replace(/\u0000/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** LIHKG bodies are mostly Cantonese; everything else is treated as English. */
export function detectLang(body: string): 'zh-HK' | 'en' {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(body) ? 'zh-HK' : 'en';
}
