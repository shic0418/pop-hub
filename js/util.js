'use strict';
/* ===== 공용 유틸: HTML 이스케이프, 템플릿, 날짜, 문법 강조, diff, 파일 처리 ===== */

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(s);
function fmt(v) {
  if (v == null || v === false || v === true) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(fmt).join('');
  return esc(String(v));
}
/** 안전한 HTML 템플릿: 보간값은 자동 이스케이프, raw()/html``은 그대로 */
function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s; if (i < vals.length) out += fmt(vals[i]); });
  return raw(out);
}

const pad = (n) => String(n).padStart(2, '0');
function fmtDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function timeAgo(iso) {
  const sec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (sec < 60) return '방금 전';
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
  if (sec < 86400 * 30) return `${Math.floor(sec / 86400)}일 전`;
  return fmtDate(iso).slice(0, 10);
}
function uid(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}

/* ---------- 파일 경로 ---------- */
const baseName = (p) => p.split('/').pop();
const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
function normalizePath(p) {
  const parts = [];
  for (const seg of String(p).replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}
function resolvePath(dir, rel) {
  if (/^([a-z]+:)?\/\//i.test(rel) || rel.startsWith('data:')) return null;
  return normalizePath((rel.startsWith('/') ? '' : (dir ? dir + '/' : '')) + rel.split(/[?#]/)[0]);
}
function sortFiles(files) {
  return [...files].sort((a, b) => {
    const da = a.path.split('/').length, db = b.path.split('/').length;
    const ra = /^readme\.md$/i.test(a.path) ? 0 : 1, rb = /^readme\.md$/i.test(b.path) ? 0 : 1;
    return ra - rb || a.path.localeCompare(b.path) || da - db;
  });
}
const byteSize = (s) => new TextEncoder().encode(s).length;
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/* ---------- 문법 강조 (highlight.js) ---------- */
const EXT_LANG = {
  py: 'python', js: 'javascript', mjs: 'javascript', ts: 'typescript', html: 'xml', htm: 'xml', xml: 'xml',
  css: 'css', json: 'json', md: 'markdown', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', java: 'java',
  sh: 'bash', yml: 'yaml', yaml: 'yaml', sql: 'sql', kt: 'kotlin', rs: 'rust', go: 'go', cs: 'csharp',
};
function langOf(path) {
  const ext = baseName(path).split('.').pop().toLowerCase();
  return EXT_LANG[ext] || null;
}
/** 강조된 HTML을 줄 단위로 나누되, 여러 줄에 걸친 <span>을 줄마다 닫고 다시 연다 */
function splitHtmlLines(s) {
  const lines = []; const stack = []; let cur = ''; let last = 0; let m;
  const re = /(<span[^>]*>|<\/span>|\n)/g;
  while ((m = re.exec(s))) {
    cur += s.slice(last, m.index); last = re.lastIndex;
    const t = m[0];
    if (t === '\n') { cur += '</span>'.repeat(stack.length); lines.push(cur); cur = stack.join(''); }
    else if (t === '</span>') { stack.pop(); cur += t; }
    else { stack.push(t); cur += t; }
  }
  cur += s.slice(last); lines.push(cur);
  return lines;
}
function highlightLines(code, path) {
  const lang = langOf(path);
  let out;
  try {
    out = (window.hljs && lang && hljs.getLanguage(lang))
      ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
      : esc(code);
  } catch { out = esc(code); }
  return splitHtmlLines(out);
}

/* ---------- 줄 단위 diff (LCS) ---------- */
function diffLines(aText, bText) {
  const a = aText.split('\n'), b = bText.split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const ops = [];
  for (let i = 0; i < s; i++) ops.push({ t: 'eq', a: i + 1, b: i + 1, text: a[i] });
  const A = a.slice(s, ea), B = b.slice(s, eb), n = A.length, m = B.length;
  if (n * m > 4e6) {
    A.forEach((x, i) => ops.push({ t: 'del', a: s + i + 1, text: x }));
    B.forEach((x, j) => ops.push({ t: 'add', b: s + j + 1, text: x }));
  } else {
    const w = m + 1; const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { ops.push({ t: 'eq', a: s + i + 1, b: s + j + 1, text: A[i] }); i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { ops.push({ t: 'del', a: s + i + 1, text: A[i] }); i++; }
      else { ops.push({ t: 'add', b: s + j + 1, text: B[j] }); j++; }
    }
    while (i < n) { ops.push({ t: 'del', a: s + i + 1, text: A[i] }); i++; }
    while (j < m) { ops.push({ t: 'add', b: s + j + 1, text: B[j] }); j++; }
  }
  for (let k = 0; k < a.length - ea; k++) ops.push({ t: 'eq', a: ea + k + 1, b: eb + k + 1, text: a[ea + k] });
  return ops;
}
/** diff 결과를 좌우 나란히 보기용 행으로 변환 */
function sideBySide(ops) {
  const rows = []; let i = 0;
  while (i < ops.length) {
    if (ops[i].t === 'eq') { rows.push({ l: { n: ops[i].a, text: ops[i].text, t: 'eq' }, r: { n: ops[i].b, text: ops[i].text, t: 'eq' } }); i++; continue; }
    const dels = [], adds = [];
    while (i < ops.length && ops[i].t === 'del') dels.push(ops[i++]);
    while (i < ops.length && ops[i].t === 'add') adds.push(ops[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      rows.push({
        l: dels[k] ? { n: dels[k].a, text: dels[k].text, t: 'del' } : null,
        r: adds[k] ? { n: adds[k].b, text: adds[k].text, t: 'add' } : null,
      });
    }
  }
  return rows;
}
/** 두 파일 묶음 비교 → [{path, status: added|removed|modified|same, a, b}] */
function compareFileSets(aFiles, bFiles) {
  const am = new Map(aFiles.map((f) => [f.path, f.content]));
  const bm = new Map(bFiles.map((f) => [f.path, f.content]));
  const paths = [...new Set([...am.keys(), ...bm.keys()])].sort();
  return paths.map((path) => {
    const a = am.get(path), b = bm.get(path);
    const status = a == null ? 'added' : b == null ? 'removed' : a === b ? 'same' : 'modified';
    return { path, status, a: a ?? '', b: b ?? '' };
  });
}
function sameFileSet(aFiles, bFiles) {
  return compareFileSets(aFiles, bFiles).every((x) => x.status === 'same');
}

/* ---------- 업로드 파일 읽기 (일반 파일 + ZIP) ---------- */
const BINARY_EXT = /\.(png|jpe?g|gif|bmp|ico|webp|pdf|zip|exe|dll|so|pyc|class|jar|mp3|mp4|wav|ogg|woff2?|ttf|otf|psd)$/i;
function isTextBytes(bytes) {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return false;
  return true;
}
async function readUploadFiles(fileList) {
  const files = [], skipped = [];
  const isFolder = [...fileList].some((f) => f.webkitRelativePath);
  for (const f of fileList) {
    if (/\.zip$/i.test(f.name)) {
      const r = await readZip(f); files.push(...r.files); skipped.push(...r.skipped); continue;
    }
    const bytes = new Uint8Array(await f.arrayBuffer());
    const path = normalizePath(f.webkitRelativePath || f.name);
    if (BINARY_EXT.test(path) || !isTextBytes(bytes)) { skipped.push(path); continue; }
    files.push({ path, content: new TextDecoder().decode(bytes) });
  }
  if (isFolder) stripCommonTop(files);
  return { files, skipped };
}
async function readZip(file) {
  if (!window.JSZip) throw new Error('ZIP 라이브러리를 불러오지 못했습니다(인터넷 연결 확인).');
  const zip = await JSZip.loadAsync(file);
  const files = [], skipped = [];
  const entries = Object.values(zip.files).filter((e) => !e.dir && !/(^|\/)(__MACOSX|\.git)\//.test(e.name) && !/(^|\/)\.DS_Store$/.test(e.name));
  for (const e of entries) {
    const path = normalizePath(e.name);
    const bytes = await e.async('uint8array');
    if (BINARY_EXT.test(path) || !isTextBytes(bytes)) { skipped.push(path); continue; }
    files.push({ path, content: new TextDecoder().decode(bytes) });
  }
  stripCommonTop(files);
  return { files, skipped };
}
/** 모든 파일이 같은 최상위 폴더 안에 있으면 그 폴더를 벗겨낸다 (ZIP·폴더 업로드 공통) */
function stripCommonTop(files) {
  const tops = new Set(files.map((f) => (f.path.includes('/') ? f.path.split('/')[0] : '')));
  if (tops.size === 1 && !tops.has('')) {
    const top = [...tops][0] + '/';
    files.forEach((f) => { f.path = f.path.slice(top.length); });
  }
}
async function downloadZip(name, files) {
  if (!window.JSZip) throw new Error('ZIP 라이브러리를 불러오지 못했습니다(인터넷 연결 확인).');
  const zip = new JSZip();
  files.forEach((f) => zip.file(f.path, f.content));
  const blob = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name.replace(/[\\/:*?"<>|]/g, '_') + '.zip';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- Markdown ---------- */
function renderMarkdown(md) {
  if (window.marked && window.DOMPurify) {
    // 앱 화면을 덮거나 앱 버튼(data-act)을 흉내 내지 못하도록 위험한 태그·속성을 제거
    return raw(DOMPurify.sanitize(marked.parse(md), {
      ALLOW_DATA_ATTR: false,
      FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
      FORBID_ATTR: ['style', 'action', 'formaction', 'id', 'class'],
    }));
  }
  return html`<pre class="plain">${md}</pre>`;
}
