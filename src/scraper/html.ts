/** LIHKG bodies are mostly Cantonese; everything else is treated as English. */
export function detectLang(body: string): 'zh-HK' | 'en' {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(body) ? 'zh-HK' : 'en';
}
