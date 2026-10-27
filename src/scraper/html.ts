/** LIHKG bodies are mostly Cantonese; everything else is treated as English. */
export function detectLang(body: string): 'zh-HK' | 'en' {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(body) ? 'zh-HK' : 'en';
}

/**
 * LIHKG returns comment bodies as HTML. The archive stores plain text: line breaks
 * are preserved, emoticons become `[表情]`, attachments become `[圖片]`, and every
 * other tag is dropped.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<img\b[^>]*class="[^"]*hkgmoji[^"]*"[^>]*>/gi, '[表情]')
    .replace(/<img\b[^>]*>/gi, '[圖片]')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
