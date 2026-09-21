import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * 채팅 마크다운 렌더 (2026-09-21 사용자: *"애널리스트와 대화 부분 마크다운 파서 붙여줘"*)
 *
 * ## 🔴 모델이 쓴 글을 **HTML 로 화면에 넣는다** — 그래서 반드시 소독한다
 *
 * 애널리스트의 답에는 **웹 검색 결과가 섞여 들어온다**(외부에서 온 글이다).
 * 거기에 `<img onerror=…>` 나 `<script>` 가 있으면 그대로 실행된다.
 * ⇒ `marked` 로 변환한 뒤 **`DOMPurify` 로 한 번 더** 거른다. 순서를 바꾸면 안 된다.
 *
 * ⚠️ 링크는 살리되 **새 창 + `rel=noopener`** 로 연다 — 원래 탭을 남이 조종하지 못하게.
 */
marked.setOptions({ breaks: true, gfm: true });

/** 새 창으로 열되 opener 를 넘기지 않는다 */
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function renderMarkdown(text) {
  const src = String(text || '');
  if (!src.trim()) return '';
  let html;
  try {
    html = marked.parse(src);
  } catch {
    // 🔴 파싱이 깨져도 **글을 잃지 않는다** — 원문을 그대로 보여준다(빈 말풍선이 최악이다)
    return escapeHtml(src);
  }
  return DOMPurify.sanitize(html, {
    // 표·목록·코드까지는 받는다(애널리스트가 실제로 표를 쓴다). 그 밖은 막는다.
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
      'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4',
      'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr',
    ],
    ALLOWED_ATTR: ['href', 'title', 'target', 'rel'],
    // ⚠️ `javascript:` 같은 스킴을 막는다 — 링크는 http(s) 만
    ALLOWED_URI_REGEXP: /^https?:\/\//i,
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
