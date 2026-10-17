// 배포 직후 캐시된 index 가 사라진 번들을 가리키면 한 번 자동 새로고침.
// 인라인 스크립트를 쓰지 않으려고(CSP script-src 'self') 파일로 뺐다. 번들보다 먼저 돌아야 해서 classic script 로 둔다.
window.addEventListener('error', function (e) {
  var t = e.target; if (t && t.tagName === 'SCRIPT' && !sessionStorage.getItem('sp-reloaded')) { sessionStorage.setItem('sp-reloaded', '1'); location.reload(); }
}, true);
