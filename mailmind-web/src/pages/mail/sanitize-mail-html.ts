import DOMPurify from 'dompurify';

// Mail içinde her `<a>` etiketinin yeni sekmede ve opener referansını
// sızdırmadan açılmasını garantilemek için DOMPurify hook'u kuruyoruz.
// Hook bir kez kurulması yeterlidir (modül yüklenirken kurulur).
let hooksInstalled = false;
function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element)) return;

    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

/** Okuyucuda gösterilecek HTML’i XSS’e karşı temizler (pazarlama / tablo düzenleri dahil). */
export function sanitizeMailHtml(html: string): string {
  installHooks();
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_TAGS: ['style'],
    ADD_ATTR: ['style', 'class', 'target', 'align', 'role', 'border', 'cellpadding', 'cellspacing', 'valign', 'bgcolor', 'width', 'height'],
  });
}
