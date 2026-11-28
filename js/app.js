'use strict';
/* ===== 화면: 라우터, 페이지, 이벤트 처리 ===== */

const $app = () => document.getElementById('app');
const ui = { editor: null, editors: {}, after: [] };

/* ---------- 아이콘 (Lucide) ---------- */
const ICON_CACHE = new Map();
/** Lucide 아이콘을 인라인 SVG로. 크기·선 두께는 전체에서 통일한다. */
function icon(name, size = 16) {
  const key = name + size;
  if (!ICON_CACHE.has(key)) {
    const node = window.lucide?.icons?.[name];
    const kids = node ? node[2].map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('') : '';
    ICON_CACHE.set(key, `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${kids}</svg>`);
  }
  return raw(ICON_CACHE.get(key));
}

/* ---------- 공용 조각 ---------- */
// 직책(복수 보유). 표시 이름은 store.js 의 ROLE_DEFS. 직책이 없으면 "부원".
const ROLE_LABEL = Object.fromEntries(ROLE_DEFS.map((r) => [r.code, r.label]));
// 화면 표시용 도우미 (보이고 숨기는 용도일 뿐, 실제 권한 검사는 서버가 한다)
const hasRole = (u, code) => Api.hasRole(u, code);
const isAdmin = (u) => Api.isAdmin(u);
const isStaff = (u) => Api.isStaff(u);
const STATUS_LABEL = { active: '활동', pending: '승인 대기', graduated: '졸업생' };
const PERM_LABEL = { free: '수정 자유', approval: '승인 필요', view: '보기만 가능' };
const PERM_DESC = { free: '누구나 수정본을 만들 수 있습니다', approval: '수정본을 만들려면 원작자 승인이 필요합니다', view: '보기와 다운로드만 가능합니다' };
const PERM_ICON = { free: 'GitFork', approval: 'ShieldCheck', view: 'Lock' };
const MR_LABEL = { pending: '대기', approved: '승인', rejected: '거절', closed: '닫힘' };
const MR_BADGE = { pending: 'badge-warn', approved: 'badge-ok', rejected: 'badge-muted', closed: 'badge-muted' };

function avatarColor(id) {
  let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 28% 46%)`;
}
function avatar(u, cls = '') {
  return html`<span class="avatar ${cls}" style="background:${avatarColor(u.id)}" aria-hidden="true">${(u.name || '?')[0]}</span>`;
}
function userChip(u) {
  return html`<a class="user-chip" href="#/u/${u.id}">${avatar(u)}<span class="user-name">${u.name}</span>${u.status === 'graduated' ? html`<span class="badge badge-muted">졸업생</span>` : ''}</a>`;
}
const roleText = (u) => (roleCodesOf(u).length ? roleCodesOf(u).map((c) => ROLE_LABEL[c]).join(' · ') : '부원');
const roleBadge = (u) => (roleCodesOf(u).length ? roleCodesOf(u).map((c) => html`<span class="badge">${ROLE_LABEL[c]}</span> `) : html`<span class="badge badge-muted">부원</span>`);
const typeBadge = (p) => (p.parentId ? html`<span class="badge badge-fork">${icon('GitFork', 12)}수정본</span>` : html`<span class="badge badge-root">원본</span>`);
const permBadge = (p) => html`<span class="badge" title="${PERM_DESC[p.permission]}">${icon(PERM_ICON[p.permission], 12)}${PERM_LABEL[p.permission]}</span>`;
const genText = (g) => (g != null ? `${g}기` : '기수 미지정');
function projTitle(p) {
  if (!p) return '(없음)';
  if (p.hidden && !Api.isStaff(Api.me())) return '(숨김 처리된 프로젝트)';
  return p.title;
}
function projLink(p) {
  if (!p) return html`<span class="faint">(없음)</span>`;
  if (!Api.canSee(p)) return html`<span class="faint">숨김 처리된 프로젝트</span>`;
  return html`<a class="link" href="#/p/${p.id}">${p.title}</a>${p.deleted ? html` <span class="badge badge-danger">삭제됨</span>` : ''}`;
}
/** 간결한 빈 상태: 거대한 상자 대신 한 줄 제목 + 설명 + (선택) 행동 */
function empty(title, desc = '', action = '') {
  return html`<div class="empty"><div class="empty-title">${icon('Inbox')}${title}</div>${desc ? html`<div>${desc}</div>` : ''}${action}</div>`;
}
const emptyInline = (text) => html`<div class="empty-inline">${text}</div>`;
function fileIconName(path) {
  const ext = path.split('.').pop().toLowerCase();
  if (['md', 'txt'].includes(ext)) return 'FileText';
  if (['py', 'js', 'ts', 'html', 'htm', 'css', 'json', 'c', 'cpp', 'h', 'java', 'sh'].includes(ext)) return 'FileCode';
  return 'File';
}
const fileIcon = (path) => icon(fileIconName(path), 15);

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = icon(type === 'error' ? 'CircleAlert' : 'Check', 15).s;
  const t = document.createElement('span'); t.textContent = msg; el.appendChild(t);
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3600);
}

/* ---------- 라우터 ---------- */
function parseHash() {
  const h = decodeURI(location.hash.slice(1)) || '/';
  const qi = h.indexOf('?');
  const path = qi >= 0 ? h.slice(0, qi) : h;
  const q = Object.fromEntries(new URLSearchParams(qi >= 0 ? location.hash.slice(location.hash.indexOf('?') + 1) : ''));
  return { parts: path.split('/').filter(Boolean), q };
}
function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }

function render() {
  if (ui.bootFailed) { renderBootFailure(); return; }
  const u = Api.me();
  ui.after = [];
  document.body.classList.remove('nav-open');
  let body, parts = [];
  try {
    let q;
    try { ({ parts, q } = parseHash()); } catch { throw new Error('잘못된 주소입니다.'); }
    if (!u) body = parts[0] === 'status' ? html`<div style="max-width:640px;margin:32px auto;padding:0 16px;width:100%">${viewStatus()}</div>` : viewLogin();
    else if (u.status === 'pending') body = viewPending(u);
    else body = route(parts, q, u);
  } catch (e) {
    console.error(e);
    body = html`<div class="page-header"><div><h1>페이지를 열 수 없습니다</h1><p>${e.message}</p></div></div>
      <a class="btn" href="#/">${icon('ArrowLeft')}탐색으로 돌아가기</a>`;
  }
  $app().innerHTML = layout(u, body, parts[0] || '').s;
  const h1 = ($app().querySelector('h1 .t-text') || $app().querySelector('h1'))?.textContent.trim().replace(/\s+/g, ' ');
  const club = Api.settings().clubName;
  document.title = h1 && h1 !== club ? `${h1} · ${club}` : club;
  ui.after.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
}
function route(parts, q, u) {
  const [a, b, c] = parts;
  switch (a) {
    case undefined: return viewHome(q);
    case 'archive': return viewArchive();
    case 'activity': return b ? (c ? viewSession(b, c, q) : viewYear(b)) : viewYears();
    case 'status': return viewStatus();
    case 'me': return viewActivity(u.id, q);
    case 'u': return viewActivity(b, q);
    case 'new': return viewNew();
    case 'notifications': return viewNotifications();
    case 'admin': return viewAdmin(q);
    case 'p':
      if (c === 'edit') return viewEdit(b);
      if (c === 'fork') return viewFork(b);
      return viewProject(b, c || 'code', q);
    default: throw new Error('페이지를 찾을 수 없습니다.');
  }
}

/* ---------- 공통 레이아웃 ---------- */
function brand(club) {
  return html`<span class="brand-mark">${icon('GitFork', 14)}</span><span>${club}</span>`;
}
function layout(u, body, section) {
  const club = Api.settings().clubName;
  if (!u || u.status === 'pending') return html`<main class="auth-wrap">${body}</main>`;
  const unread = Api.unreadCount();
  const staff = Api.isStaff(u);
  const incoming = incomingTransfers(u);
  const items = [['#/', '탐색', '', 'Compass'], ['#/activity', '활동', 'activity', 'CalendarDays'], ['#/archive', '기수 아카이브', 'archive', 'Layers'], ['#/me', '내 기여', 'me', 'User']];
  if (staff) items.push(['#/admin', '관리', 'admin', 'Settings']);
  const isOn = (key) => section === key || (key === '' && section === 'p');
  return html`
  <button class="skip-link" data-act="skipToMain">본문으로 건너뛰기</button>
  <header class="topbar"><div class="topbar-in">
    <a class="brand" href="#/" aria-label="${club} 처음으로">${brand(club)}</a>
    <nav class="nav" aria-label="주 메뉴">
      ${items.map(([href, label, key]) => html`<a href="${href}" class="${isOn(key) ? 'on' : ''}" ${isOn(key) ? raw('aria-current="page"') : ''}>${label}</a>`)}
    </nav>
    <div class="nav-right">
      ${u.status === 'active' ? html`<a href="#/new" class="btn btn-primary btn-sm" aria-label="새 프로젝트">${icon('Plus', 15)}<span class="new-label">새 프로젝트</span></a>` : ''}
      <a href="#/notifications" class="icon-btn" aria-label="알림${unread ? ` ${unread}개 안 읽음` : ''}">${icon('Bell', 18)}${unread ? html`<span class="dot">${unread > 9 ? '9+' : unread}</span>` : ''}</a>
      <details class="dropdown">
        <summary class="user-trigger">${avatar(u)}<span class="name ellipsis">${u.name}</span><span class="sr-only">계정 메뉴</span>${icon('ChevronDown', 14)}</summary>
        <div class="dropdown-menu">
          <div class="menu-head"><b>${u.name}</b><span class="xs faint">${u.email}</span>
            <div class="row" style="margin-top:6px">${roleBadge(u)}${u.memberNo ? html`<span class="badge mono">${u.memberNo}</span>` : ''}${u.generation ? html`<span class="badge">${u.generation}기</span>` : ''}</div></div>
          <a href="#/me">${icon('User', 15)}내 기여</a>
          <a href="#/notifications">${icon('Bell', 15)}알림</a>
          <hr>
          <button data-act="logout">${icon('LogOut', 15)}로그아웃</button>
        </div>
      </details>
      <button class="icon-btn menu-toggle" data-act="toggleMenu" aria-label="메뉴" aria-expanded="false" aria-controls="mobile-nav">${icon('Menu', 20)}</button>
    </div>
  </div></header>
  <nav class="mobile-nav" id="mobile-nav" aria-label="모바일 메뉴">
    ${items.map(([href, label, key, ic]) => html`<a href="${href}" class="${isOn(key) ? 'on' : ''}" ${isOn(key) ? raw('aria-current="page"') : ''}>${icon(ic, 18)}${label}</a>`)}
    ${u.status === 'active' ? html`<a href="#/new">${icon('Plus', 18)}새 프로젝트</a>` : ''}
    <a href="#/notifications">${icon('Bell', 18)}알림${unread ? html` <span class="counter counter-accent">${unread}</span>` : ''}</a>
  </nav>
  ${Remote.enabled && Remote.failed ? html`<div class="banner banner-warn" role="status">${icon('TriangleAlert', 15)}서버에서 최신 내용을 불러오지 못했습니다. 화면은 마지막으로 불러온 내용입니다. <a class="link" href="#/status">서버 상태 확인</a></div>` : ''}
  ${incoming.map((t) => html`<div class="banner banner-warn" role="status">${icon('Info', 15)}<span><b>${Api.user(t.fromMember).name}</b> 님이 최고 관리자 이양을 제안했습니다.</span>
    <button class="btn btn-sm btn-primary" data-act="acceptTransfer" data-id="${t.id}">수락</button><button class="btn btn-sm" data-act="cancelTransfer" data-id="${t.id}">거절</button></div>`)}
  ${u.status === 'graduated' ? html`<div class="banner">${icon('Info', 15)}졸업생 계정입니다. 올린 프로젝트는 그대로 남아 있으며, 읽기만 가능합니다.</div>` : ''}
  <main id="main" tabindex="-1" class="container ${section === 'p' ? 'wide' : ''}">${body}</main>
  ${Remote.enabled
    ? html`<footer class="foot"><span class="status-dot" aria-hidden="true"></span>서버에 연결됨<span class="dot-sep"></span><button data-act="reloadData">새로 불러오기</button><span class="dot-sep"></span><a href="#/status">서버 상태</a><span class="dot-sep"></span><a href="privacy.html">개인정보처리방침</a></footer>`
    : html`<footer class="foot">데모 모드 · 데이터는 이 브라우저에만 저장됩니다<span class="dot-sep"></span><button data-act="resetDemo">데모 데이터 초기화</button><span class="dot-sep"></span><a href="#/status">서버 상태</a><span class="dot-sep"></span><a href="privacy.html">개인정보처리방침</a></footer>`}`;
}
/** 페이지 머리: 설명은 꼭 필요한 화면에만. 개수는 제목 옆에 작게 붙인다 */
function pageHeader(title, desc = '', actions = '', count = null) {
  return html`<header class="page-header"><div><h1><span class="t-text">${title}</span>${count != null ? html`<span class="h-count">${count}</span>` : ''}</h1>${desc ? html`<p>${desc}</p>` : ''}</div>${actions ? html`<div class="actions">${actions}</div>` : ''}</header>`;
}

/* ---------- 로그인 ---------- */
const GOOGLE_G = raw('<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.2l7.9 6.2C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.8c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-2.9-.8-4.6s.3-3.2.8-4.6l-7.9-6.2C1 16.6 0 20.2 0 24s.9 7.4 2.6 10.8l7.9-6.2z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.8c-2.1 1.4-4.8 2.3-8.5 2.3-6.3 0-11.6-4.1-13.5-9.7l-7.9 6.2C6.6 42.6 14.6 48 24 48z"/></svg>');

function viewLogin() {
  const s = Api.settings();
  const foot = html`<p class="auth-foot"><b>@${s.domain}</b> 계정만 가입할 수 있습니다.
    ${s.signupMode === 'approval' ? '처음 로그인하면 운영진 승인 후 이용할 수 있습니다.' : '운영진이 등록한 부원 명단에 있어야 가입할 수 있습니다.'}
    <br><a class="link" href="privacy.html">개인정보처리방침</a> · <a class="link" href="#/status">서버 상태</a></p>`;
  if (Remote.enabled) {
    return html`<div class="auth">
      <div class="auth-brand">${brand(s.clubName)}</div>
      <div class="auth-box">
        <h1>로그인</h1>
        <p>부원의 코드를 모으고, 원본과 수정본의 관계를 계보로 기록합니다.</p>
        ${Remote.loginError ? html`<div class="callout callout-danger" style="margin-top:16px">${icon('CircleAlert')}<div>${Remote.loginError}</div></div>` : ''}
        ${Remote.orphanSession ? html`<div class="callout callout-warn" style="margin-top:16px">${icon('TriangleAlert')}<div>로그인은 되었지만 가입 정보가 없습니다. 운영진에게 Supabase의 Authentication → Users에서 이 계정을 지워 달라고 요청한 뒤 다시 로그인하세요.
          <div style="margin-top:8px"><button class="btn btn-sm" data-act="logout">로그아웃</button></div></div></div>` : ''}
        <button class="btn btn-google wide" data-act="googleLogin">${GOOGLE_G}학교 Google 계정으로 계속하기</button>
        ${foot}
      </div></div>`;
  }
  const demo = Store.db.users;
  return html`<div class="auth">
    <div class="auth-brand">${brand(s.clubName)}</div>
    <div class="auth-box">
      <h1>로그인</h1>
      <p>데모 모드에서는 Google 로그인 대신 학교 이메일을 입력합니다.</p>
      <form data-form="login" class="stack" style="margin-top:20px">
        <label class="field"><span>학교 이메일</span><input name="email" type="email" placeholder="이름@${s.domain}" required autocomplete="off"></label>
        <label class="field"><span>이름 <span class="faint">(처음 로그인할 때만)</span></span><input name="name" placeholder="홍길동"></label>
        <button class="btn btn-primary wide btn-lg">계속하기</button>
      </form>
      ${foot}
      <div class="demo-list">
        <div class="label">데모 계정으로 바로 들어가기</div>
        ${demo.map((u) => html`<button class="demo-btn" data-act="quickLogin" data-email="${u.email}">${avatar(u)}<span class="n">${u.name}</span><span class="r">${roleText(u)} · ${STATUS_LABEL[u.status] || u.status}</span></button>`)}
      </div>
    </div></div>`;
}
function viewPending(u) {
  return html`<div class="auth">
    <div class="auth-brand">${brand(Api.settings().clubName)}</div>
    <div class="auth-box">
      <h1>가입 승인을 기다리는 중입니다</h1>
      <p>${u.name} 님(${u.email})의 가입 요청이 운영진에게 전달되었습니다. 승인되면 바로 이용할 수 있습니다.</p>
      <div class="row" style="margin-top:20px">
        ${Remote.enabled ? html`<button class="btn btn-primary" data-act="reloadData">${icon('RefreshCw', 15)}승인 여부 확인</button>` : ''}
        <button class="btn btn-tertiary" data-act="logout">다른 계정으로 로그인</button></div>
    </div></div>`;
}

/* ---------- 탐색 ---------- */
function viewHome(q) {
  const me = Api.me();
  // 범위: 전체 / 원본만 / 내 프로젝트 (내 프로젝트는 화면에서만 거르는 필터 — API 변경 없음)
  const scope = q.mine === '1' ? 'mine' : q.roots === '1' ? 'roots' : '';
  let list = Api.listProjects({ q: q.q || '', gen: q.gen || '', rootsOnly: scope === 'roots' });
  if (scope === 'mine') list = list.filter((p) => p.ownerId === me.id);
  const all = Api.listProjects({});
  const gens = Api.generations();
  const filtered = !!(q.q || q.gen || scope);
  const canCreate = me.status === 'active';
  const scopes = [['', '전체'], ['roots', '원본'], ['mine', '내 프로젝트']];
  return html`
  ${pageHeader('프로젝트', '', '', all.length)}
  <form class="toolbar" data-form="search" role="search">
    <label class="input-icon search-field"><span class="sr-only">검색</span>${icon('Search', 15)}<input type="search" name="q" value="${q.q || ''}" placeholder="제목, 설명, 작성자 검색" aria-keyshortcuts="/"><kbd class="kbd" aria-hidden="true">/</kbd></label>
    <div class="segmented" role="radiogroup" aria-label="보기 범위">
      ${scopes.map(([v, label]) => html`<label><input type="radio" name="scope" value="${v}" data-change="submitForm" ${scope === v ? raw('checked') : ''}><span>${label}</span></label>`)}
    </div>
    <label><span class="sr-only">기수</span><select name="gen" data-change="submitForm">
      <option value="">모든 기수</option>${gens.map((g) => html`<option value="${g}" ${String(g) === q.gen ? raw('selected') : ''}>${g}기</option>`)}</select></label>
    <button class="btn btn-tertiary search-btn">검색</button>
    ${filtered ? html`<span class="result-count" aria-live="polite">${list.length}개 · <a class="link" href="#/">초기화</a></span>` : ''}
  </form>
  ${list.length ? html`<div class="plist">
      <div class="plist-head" aria-hidden="true"><span>프로젝트</span><span>작성자</span><span>기수</span><span class="r">수정본</span><span class="r">업데이트</span></div>
      <ul style="list-style:none;margin:0;padding:0" aria-label="프로젝트 목록">${list.map((p) => html`<li>${projectRow(p)}</li>`)}</ul></div>`
    : filtered ? empty('조건에 맞는 프로젝트가 없습니다', '검색어나 기수 필터를 바꿔 보세요.', html`<a class="btn btn-sm" href="#/">필터 초기화</a>`)
    : empty('아직 올라온 프로젝트가 없습니다', '첫 번째 원본 프로젝트를 올려 계보를 시작해 보세요.', canCreate ? html`<a class="btn btn-primary btn-sm" href="#/new">${icon('Plus', 15)}새 프로젝트</a>` : '')}`;
}
function projectRow(p) {
  const parent = p.parentId ? Api.rawProject(p.parentId) : null;
  const forks = Api.childrenOf(p.id).length;
  const owner = Api.user(p.ownerId);
  return html`<a class="prow" href="#/p/${p.id}">
    <div class="prow-main">
      <div class="prow-title">${p.parentId ? icon('GitFork', 15) : icon('BookMarked', 15)}<span class="t">${p.title}</span>
        ${p.permission !== 'free' ? html`<span class="badge" title="${PERM_DESC[p.permission]}">${icon(PERM_ICON[p.permission], 12)}${PERM_LABEL[p.permission]}</span>` : ''}</div>
      ${p.description ? html`<div class="prow-desc">${p.description}</div>` : ''}
      ${parent ? html`<div class="prow-lineage">${icon('CornerDownRight', 13)}<span class="ellipsis">${projTitle(parent)}에서 이어짐</span>${parent.deleted ? html`<span class="badge badge-muted">원본 삭제됨</span>` : ''}</div>` : ''}
      <div class="prow-mobile meta"><span>${owner.name}</span><span>${genText(p.generation)}</span></div>
    </div>
    <div class="prow-cell c-owner"><span class="user-chip">${avatar(owner)}<span class="ellipsis">${owner.name}</span></span></div>
    <div class="prow-cell c-gen">${p.generation != null ? `${p.generation}기` : '—'}</div>
    <div class="prow-cell c-forks r"><span class="fork-count ${forks ? '' : 'zero'}" title="수정본 ${forks}개">${icon('GitFork', 13)}<span class="num">${forks}</span></span></div>
    <div class="prow-cell c-updated r faint">${timeAgo(p.updatedAt)}</div>
  </a>`;
}

/* ---------- 프로젝트 상세 ---------- */
const TABS = [['code', '코드', 'FileCode'], ['tree', '계보', 'GitBranch'], ['versions', '버전 기록', 'History'], ['compare', '비교', 'GitCompare'], ['merge', '반영 요청', 'GitPullRequest'], ['sessions', '차시', 'CalendarDays'], ['run', '실행', 'Play']];

function viewProject(id, tab, q) {
  const p = Api.getProject(id);
  const u = Api.me();
  if (p.deleted && !Api.isStaff(u)) {
    return html`
    <div class="eyebrow"><a href="#/">프로젝트</a>${icon('ChevronRight', 13)}<span>${p.title}</span></div>
    ${pageHeader(`삭제된 프로젝트: ${p.title}`, `${fmtDate(p.deletedAt)}에 삭제되었습니다. 이 프로젝트에서 이어진 수정본은 그대로 남아 있습니다.`)}
    <section class="section"><div class="section-head"><h2>계보</h2></div>${renderTree(p.rootId, p.id)}</section>`;
  }
  if (!TABS.some(([k]) => k === tab)) throw new Error('없는 탭입니다.');
  const pendingIn = Api.mergeRequestsTo(p.id).filter((m) => m.status === 'pending').length
    + (Api.canResolveFor(p) ? Api.forkRequestsFor(p.id).filter((r) => r.status === 'pending').length : 0);
  const body = { code: tabCode, tree: tabTree, versions: tabVersions, compare: tabCompare, merge: tabMerge, sessions: tabSessions, run: tabRun }[tab](p, q);
  return html`
  ${projectHeader(p, u)}
  <nav class="tabs" aria-label="프로젝트 메뉴">${TABS.map(([k, label, ic]) => html`<a href="#/p/${p.id}${k === 'code' ? '' : '/' + k}" class="${k === tab ? 'on' : ''}" ${k === tab ? raw('aria-current="page"') : ''}>${icon(ic, 15)}${label}${k === 'merge' && pendingIn ? html` <span class="counter counter-accent">${pendingIn}</span>` : ''}</a>`)}</nav>
  <section>${body}</section>`;
}

function projectHeader(p, u) {
  const owner = Api.user(p.ownerId);
  const root = Api.rawProject(p.rootId);
  const rootOwner = root && root.ownerId ? Api.user(root.ownerId) : null;
  const parent = p.parentId ? Api.rawProject(p.parentId) : null;
  const contributors = Api.contributors(p.id);
  const lineage = Api.lineage(p).reverse(); // 최초 원본 → 바로 위 원본
  const isOwner = u.id === p.ownerId;
  const active = u.status === 'active';
  const fc = Api.forkCheck(p, u);
  const staff = Api.isStaff(u);
  const primary = isOwner && active && !p.deleted ? html`<a class="btn btn-primary" href="#/p/${p.id}/edit">${icon('Pencil', 15)}편집</a>`
    : !isOwner && active && !p.deleted ? (fc.ok
      ? html`<a class="btn btn-primary" href="#/p/${p.id}/fork">${icon('GitFork', 15)}${fc.needsApproval ? '수정본 요청' : '수정본 만들기'}</a>`
      : html`<button class="btn" disabled aria-describedby="fork-reason">${icon('Lock', 15)}수정본 불가</button>`) : '';
  const forkNote = !isOwner && active && !p.deleted && !fc.ok ? html`<p class="proj-note" id="fork-reason">${icon('Info', 14)}${fc.reason}</p>` : '';
  return html`
  <div class="eyebrow"><a href="#/">프로젝트</a>${icon('ChevronRight', 13)}<a href="#/u/${owner.id}">${owner.name}</a>${icon('ChevronRight', 13)}<span>${p.title}</span></div>
  <div class="proj-head">
    <div class="grow">
      <h1><span class="t-text">${p.title}</span> ${typeBadge(p)}${p.hidden ? html`<span class="badge badge-warn">${icon('EyeOff', 12)}숨김 처리됨</span>` : ''}${p.deleted ? html`<span class="badge badge-danger">삭제됨 · 운영진에게만 보임</span>` : ''}</h1>
      ${p.parentId ? html`<div class="origin">
        ${icon('CornerDownRight', 14)}<span class="path">${lineage.map((x, i) => html`${i ? html`<span class="sep" aria-hidden="true">/</span>` : ''}${projLink(x)}`)}</span>
        ${rootOwner ? html`<span class="faint">원작자 <a class="link" href="#/u/${rootOwner.id}">${rootOwner.name}</a></span>` : ''}
        ${parent && parent.deleted ? html`<span class="badge badge-muted">바로 위 원본 삭제됨</span>` : ''}
        <span class="badge" title="원본의 권리는 원작자에게 있으며, 출처 표기는 자동으로 기록되어 지우거나 바꿀 수 없습니다.">${icon('Lock', 11)}출처 자동 표기</span>
      </div>` : ''}
      ${p.description ? html`<p class="desc">${p.description}</p>` : ''}
      <div class="meta">${userChip(owner)}<span>${genText(p.generation)}</span><span title="${PERM_DESC[p.permission]}">${icon(PERM_ICON[p.permission], 13)}${PERM_LABEL[p.permission]}</span><span>${fmtDate(p.createdAt).slice(0, 10)} 생성</span>${Api.sessionsOfProject(p.id).length ? html`<span>${icon('CalendarDays', 13)}${Api.sessionsOfProject(p.id).map((s, i) => html`${i ? ', ' : ''}<a class="link" href="#/activity/${s.year}/${s.no}">${s.year} ${s.no}차시</a>`)}</span>` : ''}${contributors.length ? html`<span>기여 ${contributors.map((c, i) => html`${i ? ', ' : ''}<a class="link" href="#/u/${c.userId}">${Api.user(c.userId).name}</a>`)}</span>` : ''}</div>
      ${forkNote}
    </div>
    <div class="proj-actions">
      ${isOwner && active && p.parentId && !p.deleted ? html`<a class="btn" href="#/p/${p.id}/merge">${icon('GitPullRequest', 15)}반영 요청</a>` : ''}
      ${primary}
      <button class="btn btn-icon" data-act="zip" data-id="${p.id}" aria-label="ZIP으로 내려받기" title="ZIP으로 내려받기">${icon('Download', 15)}</button>
      <details class="dropdown more"><summary class="btn btn-icon" aria-label="더 보기">${icon('Ellipsis', 16)}</summary><div class="dropdown-menu">
        ${isOwner && active ? html`<button data-act="editInfo" data-id="${p.id}">${icon('Settings2', 15)}정보·허용 범위 변경</button>` : ''}
        ${staff && !isOwner && !p.deleted ? html`<button data-act="editGen" data-id="${p.id}">${icon('Layers', 15)}아카이브 기수 변경</button>` : ''}
        ${staff ? html`<button data-act="hide" data-id="${p.id}" data-v="${p.hidden ? '0' : '1'}">${icon(p.hidden ? 'Eye' : 'EyeOff', 15)}${p.hidden ? '숨김 해제' : '숨김 처리'}</button>
          <button data-act="hideTree" data-id="${p.id}">${icon('EyeOff', 15)}하위 수정본까지 숨김</button>` : ''}
        ${!isOwner && active ? html`<button data-act="report" data-id="${p.id}">${icon('Flag', 15)}신고</button>` : ''}
        ${((isOwner && active) || staff) && !p.deleted ? html`<hr><button class="danger" data-act="delete" data-id="${p.id}">${icon('Trash2', 15)}삭제</button>` : ''}
        ${!active && !staff ? html`<div class="menu-head xs faint">읽기 전용 계정입니다</div>` : ''}
      </div></details>
    </div>
  </div>`;
}

/* --- 코드 탭 --- */
function tabCode(p, q) {
  const versions = Api.versionsOf(p.id);
  const v = q.v ? Api.getVersion(q.v) : Api.headOf(p);
  if (v.projectId !== p.id) throw new Error('이 프로젝트의 버전이 아닙니다.');
  const files = sortFiles(v.files);
  const path = q.file && files.some((f) => f.path === q.file) ? q.file : null;
  const readme = files.find((f) => /^readme\.md$/i.test(f.path));
  const isHead = v.id === p.headVersionId;
  const vq = isHead ? '' : `v=${v.id}&`;
  return html`
  ${!isHead ? html`<div class="callout callout-warn" style="margin-bottom:12px">${icon('History')}<div>과거 버전 <b>v${Api.versionNumber(v)}</b>을 보고 있습니다. <a class="inline-link" href="#/p/${p.id}">최신 버전으로 이동</a></div></div>` : ''}
  <div class="code-browser">
    <div class="cb-bar">
      <div class="cb-commit">${userChip(Api.user(v.authorId))}<span class="cb-msg ellipsis">${v.message}</span></div>
      <div class="cb-side">
        <span class="faint xs">${timeAgo(v.createdAt)}</span>
        <label><span class="sr-only">버전 선택</span><select class="cb-select" data-change="pickVersion" data-id="${p.id}">
          ${versions.map((x, i) => html`<option value="${x.id}" ${x.id === v.id ? raw('selected') : ''}>v${versions.length - i}${x.id === p.headVersionId ? ' (최신)' : ''} · ${x.message.slice(0, 24)}</option>`)}
        </select></label>
        <a class="btn btn-sm btn-tertiary" href="#/p/${p.id}/versions">${icon('History', 14)}버전 ${versions.length}</a>
      </div>
    </div>
    <aside class="file-side" aria-label="파일 목록">
      ${fileTree(files, path, (f) => `#/p/${p.id}?${vq}file=${encodeURIComponent(f.path)}`)}
    </aside>
    <div class="code-main">
      ${path ? codeView(p, v, files.find((f) => f.path === path), q)
        : readme ? html`<div class="panel-head"><span class="title">${icon('BookOpen', 15)}README.md</span></div><div class="readme md">${renderMarkdown(readme.content)}</div>`
        : html`<div class="panel-body">${empty('README가 없습니다', '왼쪽 목록에서 파일을 선택하세요.')}</div>`}
    </div>
  </div>`;
}
function fileTree(files, current, hrefOf) {
  let lastDir = null;
  return html`<ul class="ftree">${files.map((f) => {
    const dir = dirName(f.path); const depth = f.path.split('/').length - 1;
    const dirRow = dir !== lastDir && dir ? html`<li class="fdir" style="padding-left:${(depth - 1) * 14 + 8}px">${icon('Folder', 15)}${dir.split('/').pop()}</li>` : '';
    lastDir = dir;
    return html`${dirRow}<li><a href="${hrefOf(f)}" class="${f.path === current ? 'on' : ''}" ${f.path === current ? raw('aria-current="true"') : ''} style="padding-left:${depth * 14 + 8}px">${fileIcon(f.path)}${baseName(f.path)}</a></li>`;
  })}</ul>`;
}
function codeView(p, v, file, q) {
  const lines = highlightLines(file.content, file.path);
  const comments = Api.commentsOf(v.id, file.path);
  const byLine = {};
  comments.forEach((c) => { (byLine[c.line] = byLine[c.line] || []).push(c); });
  const u = Api.me();
  const canComment = u.status === 'active' && !p.deleted;
  const formLine = Number(q.cl || 0);
  if (q.line) ui.after.push(() => document.getElementById('L' + q.line)?.scrollIntoView({ block: 'center' }));
  if (formLine) ui.after.push(() => document.querySelector('.cmt-form textarea')?.focus());
  const base = `#/p/${p.id}?${v.id === p.headVersionId ? '' : `v=${v.id}&`}file=${encodeURIComponent(file.path)}`;
  return html`
    <div class="panel-head"><span class="title ellipsis">${fileIcon(file.path)}${file.path}</span>
      <span class="faint xs">${file.content.split('\n').length}줄 · ${fmtSize(byteSize(file.content))}${canComment ? ' · 줄 번호를 눌러 댓글' : ''}</span></div>
    <div class="code-scroll"><table class="code hljs">${lines.map((l, i) => {
      const n = i + 1;
      const cs = byLine[n] || [];
      return html`<tr id="L${n}" class="${String(n) === q.line ? 'hl' : ''}">
        <td class="ln">${canComment ? html`<a href="${base}&cl=${n}" aria-label="${n}번 줄에 댓글">${n}</a>` : n}</td>
        <td class="lc"><code>${raw(l || ' ')}</code></td></tr>
        ${cs.length ? html`<tr class="cmt-row"><td></td><td>${cs.map((c) => commentBox(c, u))}</td></tr>` : ''}
        ${formLine === n ? html`<tr class="cmt-row"><td></td><td>
          <form class="cmt-form" data-form="comment" data-version="${v.id}" data-path="${file.path}" data-line="${n}" data-back="${base}">
            <label><span class="sr-only">${n}번 줄 댓글</span><textarea name="text" rows="2" placeholder="${n}번 줄에 대한 리뷰를 남겨 주세요"></textarea></label>
            <div class="row-end"><a class="btn btn-sm btn-tertiary" href="${base}">취소</a><button class="btn btn-sm btn-primary">댓글 달기</button></div>
          </form></td></tr>` : ''}`;
    })}</table></div>`;
}
function commentBox(c, u) {
  const a = Api.user(c.authorId);
  return html`<div class="cmt"><div class="cmt-head">${userChip(a)}<span class="faint xs">${timeAgo(c.createdAt)}</span>
    ${(c.authorId === u.id || Api.isStaff(u)) && u.status === 'active' ? html`<button class="text-btn" data-act="delComment" data-id="${c.id}">삭제</button>` : ''}</div>
    <div class="cmt-text">${c.text}</div></div>`;
}

/* --- 계보 트리 --- */
function tabTree(p) {
  const all = Api.treeOf(p.rootId);
  return html`<div class="section-head"><h2>계보<span class="count">${all.filter((x) => !x.deleted).length}개 프로젝트</span></h2>
    <span class="faint small">「${projTitle(Api.rawProject(p.rootId))}」에서 이어진 원본–수정본 관계</span></div>
    ${renderTree(p.rootId, p.id)}
    <p class="tree-note">${icon('Lock', 13)}원본의 권리는 원작자에게 있습니다. 출처 표기는 자동으로 기록되어 지우거나 바꿀 수 없고, 각 수정본에서 바뀐 부분의 기여는 그 수정본의 작성자에게 기록됩니다.</p>`;
}
/** 원본에서 이어진 수정본을 계보선으로 그린다. compact: 아카이브용 작은 크기 */
function renderTree(rootId, currentId, { compact = false, skipRoot = false } = {}) {
  const all = Api.treeOf(rootId);
  const kids = {};
  all.forEach((x) => { if (x.parentId) (kids[x.parentId] = kids[x.parentId] || []).push(x); });
  Object.values(kids).forEach((arr) => arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  const staff = Api.isStaff(Api.me());
  const node = (x) => {
    const hiddenForMe = x.hidden && !staff;
    const label = hiddenForMe ? html`<span class="tname gone">숨김 처리된 프로젝트</span>`
      : x.deleted && !staff ? html`<span class="tname gone">삭제됨 · <s>${x.title}</s></span>`
      : html`<a class="tname" href="#/p/${x.id}">${x.title}</a>`;
    const ch = kids[x.id] || [];
    const owner = !hiddenForMe && x.ownerId ? Api.user(x.ownerId) : null;
    return html`<li><div class="tnode ${x.parentId ? '' : 'is-root'} ${x.id === currentId ? 'current' : ''}" ${x.id === currentId ? raw('aria-current="true"') : ''}>
      <span class="tdot" aria-hidden="true"></span>${label}
      ${owner ? html`<span class="tmeta">${owner.name}${x.generation != null ? ` · ${x.generation}기` : ''} · ${fmtDate(x.createdAt).slice(0, 10)}</span>` : ''}
      ${!x.parentId && !compact ? html`<span class="badge badge-root">원본</span>` : ''}
      ${x.deleted && staff ? html`<span class="badge badge-danger">삭제됨</span>` : ''}
      ${x.hidden && staff ? html`<span class="badge badge-warn">숨김</span>` : ''}
      ${x.id === currentId ? html`<span class="badge badge-accent">현재</span>` : ''}
    </div>${ch.length ? html`<ul>${ch.map(node)}</ul>` : ''}</li>`;
  };
  const root = all.find((x) => x.id === rootId);
  if (!root) return emptyInline('계보를 찾을 수 없습니다.');
  const cls = `tree ${compact ? 'tree-compact' : ''}`;
  if (skipRoot) {
    const ch = kids[root.id] || [];
    return ch.length ? html`<ul class="${cls} tree-branches">${ch.map(node)}</ul>` : '';
  }
  return html`<ul class="${cls}">${node(root)}</ul>`;
}

/* --- 버전 기록 --- */
function tabVersions(p) {
  const versions = Api.versionsOf(p.id);
  const parent = p.parentId ? Api.rawProject(p.parentId) : null;
  const parentAlive = parent && !parent.deleted && Api.canSee(parent);
  return html`<div class="section-head"><h2>버전 기록<span class="count">${versions.length}</span></h2></div>
  <div>${versions.map((v, i) => {
    const prev = versions[i + 1];
    const n = versions.length - i;
    return html`<div class="vrow">
      <div class="vnum">v${n}</div>
      <div class="grow"><div class="vmsg">${v.message}${v.id === p.headVersionId ? html`<span class="badge badge-root">최신</span>` : ''}${v.mergeRequestId ? html`<span class="badge badge-ok">${icon('GitMerge', 12)}반영됨</span>` : ''}</div>
        <div class="meta" style="margin-top:4px">${userChip(Api.user(v.authorId))}<span>${fmtDate(v.createdAt)}</span><span>파일 ${v.files.length}개</span>${v.approvedBy ? html`<span>승인 ${Api.user(v.approvedBy).name}</span>` : ''}</div></div>
      <div class="vact"><a class="btn btn-sm" href="#/p/${p.id}?v=${v.id}">보기</a>
        ${prev ? html`<a class="btn btn-sm btn-tertiary" href="#/p/${p.id}/compare?a=${prev.id}&b=${v.id}">${icon('GitCompare', 14)}이전과 비교</a>` : ''}
        ${!prev && v.forkedFromVersionId && parentAlive ? html`<a class="btn btn-sm btn-tertiary" href="#/p/${p.id}/compare?a=${v.forkedFromVersionId}&b=${v.id}">${icon('GitCompare', 14)}원본과 비교</a>` : ''}</div>
    </div>`;
  })}</div>`;
}

/* --- 비교 --- */
function compareOptions(p) {
  const opts = [];
  const add = (proj, label) => {
    if (!proj || proj.deleted || !Api.canSee(proj)) return;
    const vs = Api.versionsOf(proj.id);
    vs.forEach((v, i) => opts.push({ id: v.id, label: `${label} · ${proj.title} v${vs.length - i} · ${v.message.slice(0, 30)}` }));
  };
  add(p, '이 프로젝트');
  if (p.parentId) add(Api.rawProject(p.parentId), '원본');
  Api.childrenOf(p.id).forEach((c) => add(c, '수정본'));
  return opts;
}
function tabCompare(p, q) {
  const versions = Api.versionsOf(p.id);
  const parent = p.parentId ? Api.rawProject(p.parentId) : null;
  let a = q.a, b = q.b;
  if (!a || !b) {
    if (parent && !parent.deleted && Api.canSee(parent)) { a = parent.headVersionId; b = p.headVersionId; }
    else if (versions.length > 1) { a = versions[1].id; b = versions[0].id; }
    else { a = b = versions[0].id; }
  }
  let va, vb;
  try { va = Api.getVersion(a); vb = Api.getVersion(b); }
  catch (e) {
    return html`<div class="callout callout-warn">${icon('TriangleAlert')}<div>비교할 버전을 열 수 없습니다: ${e.message} 원본이 삭제되었거나 숨김 처리되었을 수 있습니다.
      <div style="margin-top:8px"><a class="btn btn-sm" href="#/p/${p.id}/compare?a=${versions[versions.length - 1].id}&b=${versions[0].id}">이 프로젝트의 첫 버전과 최신 버전 비교</a></div></div></div>`;
  }
  const opts = compareOptions(p);
  [va, vb].forEach((v) => { if (!opts.some((o) => o.id === v.id)) { const pr = Api.rawProject(v.projectId); opts.push({ id: v.id, label: `${pr.title} v${Api.versionNumber(v)} · ${v.message.slice(0, 30)}` }); } });
  const sel = (name, cur) => html`<select name="${name}">${opts.map((o) => html`<option value="${o.id}" ${o.id === cur ? raw('selected') : ''}>${o.label}</option>`)}</select>`;
  return html`
  <form class="compare-form" data-form="compare" data-id="${p.id}">
    <label class="field"><span>기준</span>${sel('a', va.id)}</label>
    <span class="arrow" aria-hidden="true">${icon('ArrowRight')}</span>
    <label class="field"><span>비교 대상</span>${sel('b', vb.id)}</label>
    <button class="btn">${icon('GitCompare', 15)}비교</button>
  </form>
  ${renderDiff(va.files, vb.files)}`;
}
function renderDiff(aFiles, bFiles) {
  const cmp = compareFileSets(aFiles, bFiles);
  const changed = cmp.filter((x) => x.status !== 'same');
  if (!changed.length) return empty('두 버전의 내용이 같습니다');
  const count = (s) => cmp.filter((x) => x.status === s).length;
  const ST = { added: ['추가', 'badge-ok'], removed: ['삭제', 'badge-danger'], modified: ['수정', 'badge'] };
  return html`
  <div class="diff-summary"><span>바뀐 파일 <b>${changed.length}</b>개</span><span class="faint">수정 ${count('modified')} · 추가 ${count('added')} · 삭제 ${count('removed')} · 같음 ${count('same')}</span></div>
  ${changed.map((f) => {
    const ops = diffLines(f.a, f.b);
    const plus = ops.filter((o) => o.t === 'add').length, minus = ops.filter((o) => o.t === 'del').length;
    return html`<div class="panel diff-file">
      <div class="panel-head"><span class="title ellipsis">${fileIcon(f.path)}${f.path}<span class="badge ${ST[f.status][1]}">${ST[f.status][0]}</span></span>
        <span class="xs num"><span class="plus">+${plus}</span> <span class="minus">−${minus}</span></span></div>
      ${diffTable(sideBySide(ops))}</div>`;
  })}`;
}
function diffTable(rows) {
  const CONTEXT = 3;
  const changed = rows.map((r) => !(r.l && r.r && r.l.t === 'eq'));
  const show = rows.map((_, i) => {
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(rows.length - 1, i + CONTEXT); k++) if (changed[k]) return true;
    return false;
  });
  const out = []; let skip = 0;
  const cell = (c) => (c ? html`<td class="ln">${c.n}</td><td class="dc d-${c.t}"><code>${c.t === 'del' ? '- ' : c.t === 'add' ? '+ ' : '  '}${c.text}</code></td>` : html`<td class="ln"></td><td class="dc d-empty"></td>`);
  rows.forEach((r, i) => {
    if (!show[i]) { skip++; return; }
    if (skip) { out.push(html`<tr class="d-skip"><td colspan="4">같은 줄 ${skip}개 생략</td></tr>`); skip = 0; }
    out.push(html`<tr>${cell(r.l)}${cell(r.r)}</tr>`);
  });
  if (skip) out.push(html`<tr class="d-skip"><td colspan="4">같은 줄 ${skip}개 생략</td></tr>`);
  return html`<div class="code-scroll"><table class="diff">${out}</table></div>`;
}

/* --- 반영 요청 --- */
function tabMerge(p) {
  const u = Api.me();
  const incoming = Api.mergeRequestsTo(p.id);
  const outgoing = Api.mergeRequestsFrom(p.id);
  const parent = p.parentId ? Api.rawProject(p.parentId) : null;
  const canResolve = Api.canResolveFor(p, u);
  const forkReqs = Api.forkRequestsFor(p.id).filter((r) => canResolve || r.requesterId === u.id);
  const isOwner = u.id === p.ownerId && u.status === 'active';
  const pendingOut = outgoing.some((m) => m.status === 'pending');
  return html`
  ${isOwner && parent ? html`<section class="section">
    <div class="section-head"><h2>원본에 반영 요청 보내기</h2></div>
    ${parent.deleted ? html`<p class="muted small">원본이 삭제되어 반영 요청을 보낼 수 없습니다.</p>`
      : pendingOut ? html`<p class="muted small">이미 대기 중인 요청이 있습니다. 원작자가 처리하면 알림이 옵니다.</p>`
      : html`<div class="narrow stack">
        <p class="muted small">원본 「${parent.title}」의 작성자가 변경점을 확인하고 승인하면, 원본의 새 버전이 이 수정본 내용으로 교체되고 기여자 목록에 이름이 올라갑니다. 자동 병합은 하지 않습니다.</p>
        <a class="inline-link small" href="#/p/${p.id}/compare?a=${parent.headVersionId}&b=${p.headVersionId}">원본과 지금 내 코드 비교하기</a>
        <form data-form="createMR" data-id="${p.id}" class="stack-sm">
          <label class="field"><span>요청 설명</span><textarea name="message" rows="3" placeholder="무엇을, 왜 바꿨는지 적어 주세요" required></textarea></label>
          <div><button class="btn btn-primary">${icon('GitPullRequest', 15)}반영 요청 보내기</button></div>
        </form></div>`}
  </section>` : ''}
  ${p.permission === 'approval' || forkReqs.length ? html`<section class="section">
    <div class="section-head"><h2>수정본 만들기 요청<span class="count">${forkReqs.length}</span></h2></div>
    ${canResolve && u.id !== p.ownerId ? html`<div class="callout" style="margin-bottom:12px">${icon('Info')}<div>원작자가 졸업생이어서 운영진이 대신 처리할 수 있습니다.</div></div>` : ''}
    ${forkReqs.length ? html`<div>${forkReqs.map((r) => html`<div class="req">
      <div class="req-main">
        <div class="req-line">${userChip(Api.user(r.requesterId))}<b>${r.title || '(제목 없음)'}</b><span class="badge ${MR_BADGE[r.status]}">${MR_LABEL[r.status]}</span></div>
        ${r.message ? html`<div class="req-msg muted small">${r.message}</div>` : ''}
        <div class="meta" style="margin-top:6px"><span>${timeAgo(r.createdAt)}</span>${r.forkId ? html`<span>${projLink(Api.rawProject(r.forkId))}</span>` : ''}</div></div>
      ${r.status === 'pending' && canResolve ? html`<div class="row-end"><button class="btn btn-sm" data-act="forkReq" data-id="${r.id}" data-v="0">거절</button>
        <button class="btn btn-sm btn-primary" data-act="forkReq" data-id="${r.id}" data-v="1">승인</button></div>` : ''}
    </div>`)}</div>` : emptyInline('수정본 만들기 요청이 없습니다.')}</section>` : ''}
  <section class="section">
    <div class="section-head"><h2>들어온 반영 요청<span class="count">${incoming.length}</span></h2></div>
    ${incoming.length ? html`<div>${incoming.map((m) => mrItem(m, p, canResolve))}</div>` : emptyInline('이 프로젝트로 들어온 반영 요청이 없습니다.')}</section>
  ${outgoing.length ? html`<section class="section"><div class="section-head"><h2>보낸 반영 요청<span class="count">${outgoing.length}</span></h2></div><div>${outgoing.map((m) => mrItem(m, p, false))}</div></section>` : ''}`;
}
function mrItem(m, p, canResolve) {
  const from = Api.rawProject(m.fromProjectId), to = Api.rawProject(m.toProjectId);
  const baseChanged = m.status === 'pending' && to.headVersionId !== m.baseVersionId;
  return html`<div class="req">
    <div class="req-main">
      <div class="req-line"><span class="badge ${MR_BADGE[m.status]}">${MR_LABEL[m.status]}</span>${projLink(from)}${icon('ArrowRight', 14)}${projLink(to)}</div>
      <div class="req-msg">${m.message}</div>
      <div class="meta" style="margin-top:6px">${userChip(Api.user(m.authorId))}<span>${fmtDate(m.createdAt)}</span>${m.resolvedBy ? html`<span>처리 ${Api.user(m.resolvedBy).name}</span>` : ''}${m.note ? html`<span>사유: ${m.note}</span>` : ''}</div>
      ${baseChanged ? html`<div class="callout callout-warn">${icon('TriangleAlert')}<div>요청 이후 원본에 새 버전이 올라왔습니다. 승인하면 원본의 최신 변경은 이 수정본 내용으로 교체됩니다.</div></div>` : ''}
    </div>
    <div class="row-end">
      ${!to.deleted && Api.canSee(to) ? html`<a class="btn btn-sm btn-tertiary" href="#/p/${to.id}/compare?a=${to.headVersionId}&b=${m.fromVersionId}">${icon('GitCompare', 14)}변경점</a>` : ''}
      ${m.status === 'pending' && canResolve ? html`<button class="btn btn-sm" data-act="mr" data-id="${m.id}" data-v="0">거절</button>
        <button class="btn btn-sm btn-primary" data-act="mr" data-id="${m.id}" data-v="1">${icon('GitMerge', 14)}승인하고 반영</button>` : ''}
    </div></div>`;
}

/* --- 실행 --- */
function tabRun(p) {
  const files = Api.headOf(p).files;
  const htmlEntry = files.find((f) => /^index\.html?$/i.test(f.path)) || files.find((f) => /\.html?$/i.test(f.path));
  const pyFiles = files.filter((f) => /\.py$/i.test(f.path));
  if (!htmlEntry && !pyFiles.length) return empty('브라우저에서 실행할 수 있는 파일이 없습니다', '.py 또는 .html 파일이 있으면 여기서 바로 실행할 수 있습니다.');
  const pyDefault = pyFiles.find((f) => /(^|\/)main\.py$/i.test(f.path)) || pyFiles[0];
  return html`
  ${pyFiles.length ? html`<section class="run-block">
    <div class="section-head"><h2>Python 실행</h2><span class="faint xs">Pyodide · 앱과 분리된 격리 환경에서 실행</span></div>
    <div class="row"><label><span class="sr-only">실행할 파일</span><select id="pyEntry" style="width:auto;min-width:180px">${pyFiles.map((f) => html`<option ${f === pyDefault ? raw('selected') : ''}>${f.path}</option>`)}</select></label>
      <button class="btn btn-primary" data-act="runPy" data-id="${p.id}">${icon('Play', 15)}실행</button>
      <button class="btn" data-act="stopPy">${icon('Square', 14)}중지</button>
      <span class="faint xs">처음 실행할 때 Python 엔진(약 10MB)을 내려받습니다.</span></div>
    <details class="stdin"><summary>${icon('Keyboard', 15)}input() 입력값 (한 줄에 하나)</summary><textarea id="pyStdin" rows="3" placeholder="예:&#10;10&#10;홍길동"></textarea></details>
    <pre id="pyOut" class="console" aria-live="polite">실행 버튼을 누르세요.</pre></section>` : ''}
  ${htmlEntry ? html`<section class="run-block">
    <div class="section-head"><h2>HTML 미리보기</h2><span class="faint xs">격리된 iframe에서 실행</span></div>
    <button class="btn btn-primary" data-act="runHtml" data-id="${p.id}" data-entry="${htmlEntry.path}">${icon('Play', 15)}${htmlEntry.path} 실행</button>
    <iframe id="htmlOut" class="preview" sandbox="allow-scripts allow-modals allow-forms" title="HTML 미리보기"></iframe></section>` : ''}`;
}
/* Python 실행: 부원이 올린 코드는 앱 데이터(localStorage)에 손댈 수 없도록
 * 출처가 분리된 sandbox iframe 안의 Web Worker에서 돌린다. 무한 루프는 [중지]로 iframe째 없앤다. */
function pyWorkerMain() {
  /* global importScripts, loadPyodide */
  let pyP = null;
  onmessage = async (e) => {
    const { files, entry, stdin } = e.data;
    try {
      if (!pyP) {
        postMessage({ t: 'status', s: 'Python 엔진을 준비하는 중입니다… (처음 한 번만)' });
        importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js');
        pyP = loadPyodide();
      }
      const py = await pyP;
      postMessage({ t: 'clear' });
      py.setStdout({ batched: (s) => postMessage({ t: 'out', s }) });
      py.setStderr({ batched: (s) => postMessage({ t: 'err', s }) });
      const lines = String(stdin || '').split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      py.setStdin({ stdin: () => (lines.length ? lines.shift() : null) });
      const dir = '/home/pyodide/run_' + Date.now();
      for (const f of files) {
        const full = dir + '/' + f.path;
        py.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
        py.FS.writeFile(full, f.content);
      }
      const entryDir = (dir + '/' + entry).slice(0, (dir + '/' + entry).lastIndexOf('/'));
      // 이전 실행에서 불러온 프로젝트 모듈을 지워 새 코드가 쓰이도록 한다
      py.runPython(`
import sys, os
for _k in [k for k, m in list(sys.modules.items()) if (getattr(m, '__file__', '') or '').startswith('/home/pyodide/run_')]:
    del sys.modules[_k]
sys.path = [p for p in sys.path if not p.startswith('/home/pyodide/run_')]
sys.path.insert(0, ${JSON.stringify(entryDir)})
os.chdir(${JSON.stringify(dir)})
`);
      const g = py.toPy({ __name__: '__main__' });
      const t0 = performance.now();
      try {
        await py.runPythonAsync(files.find((f) => f.path === entry).content, { globals: g, filename: entry });
        postMessage({ t: 'done', ms: Math.round(performance.now() - t0) });
      } finally { g.destroy(); }
    } catch (err) {
      if (!pyP || String(err).includes('importScripts')) pyP = null;
      postMessage({ t: 'err', s: String((err && err.message) || err) });
      postMessage({ t: 'fail' });
    }
  };
}
const PY_FRAME_DOC = `<!DOCTYPE html><meta charset="utf-8"><script>
const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify('(' + pyWorkerMain.toString() + ')()')}], { type: 'text/javascript' })));
w.onmessage = (e) => parent.postMessage(e.data, '*');
w.onerror = (e) => { e.preventDefault(); parent.postMessage({ t: 'err', s: 'Python 엔진을 불러오지 못했습니다. 인터넷 연결을 확인하세요. (' + e.message + ')' }, '*'); parent.postMessage({ t: 'fail' }, '*'); };
onmessage = (e) => { if (e.source === parent) w.postMessage(e.data); };
<\/script>`;
const PyRunner = { frame: null, ready: null, onMsg: null };
window.addEventListener('message', (e) => {
  if (PyRunner.frame && e.source === PyRunner.frame.contentWindow && e.data && typeof e.data.t === 'string') PyRunner.onMsg?.(e.data);
});
function getPyFrame() {
  if (PyRunner.frame) return PyRunner.frame;
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-scripts');
  f.style.display = 'none';
  PyRunner.ready = new Promise((r) => { f.onload = r; });
  f.srcdoc = PY_FRAME_DOC;
  document.body.appendChild(f);
  return (PyRunner.frame = f);
}
function stopPython() {
  if (!PyRunner.frame) return;
  PyRunner.frame.remove(); PyRunner.frame = null;
  PyRunner.onMsg?.({ t: 'stopped' });
}
async function runPython(projectId, entry, out, stdin) {
  const files = Api.headOf(Api.getProject(projectId)).files.map((f) => ({ path: f.path, content: f.content }));
  const frame = getPyFrame();
  await PyRunner.ready;
  out.textContent = '';
  const write = (s, err) => { const span = document.createElement('span'); if (err) span.className = 'err'; span.textContent = s + '\n'; out.appendChild(span); out.scrollTop = out.scrollHeight; };
  return new Promise((resolve) => {
    PyRunner.onMsg = (m) => {
      if (m.t === 'status') out.textContent = m.s;
      else if (m.t === 'clear') out.textContent = '';
      else if (m.t === 'out') write(m.s);
      else if (m.t === 'err') write(m.s, true);
      else if (m.t === 'done') { write(`\n실행 완료 · ${m.ms}ms`); resolve(); }
      else if (m.t === 'fail') resolve();
      else if (m.t === 'stopped') { write('\n실행을 중지했습니다.', true); resolve(); }
    };
    frame.contentWindow.postMessage({ files, entry, stdin }, '*');
  });
}
function buildHtmlDoc(files, entry) {
  const find = (rel) => { const p = resolvePath(dirName(entry), rel); return p ? files.find((f) => f.path === p) : null; };
  let doc = files.find((f) => f.path === entry).content;
  doc = doc.replace(/<link\b[^>]*>/gi, (m) => {
    if (!/rel=["']?stylesheet/i.test(m)) return m;
    const href = (m.match(/href=["']([^"']+)["']/i) || [])[1];
    const f = href && find(href);
    return f ? `<style>\n${f.content}\n</style>` : m;
  });
  doc = doc.replace(/<script\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (m, a, src, b) => {
    const f = find(src);
    return f ? `<script${a}${b}>\n${f.content.replace(/<\/script/gi, '<\\/script')}\n</script>` : m;
  });
  return doc;
}

/* ---------- 수정본 만들기 ---------- */
function viewFork(id) {
  const p = Api.getProject(id);
  const c = Api.forkCheck(p);
  if (!c.ok) throw new Error(c.reason);
  const root = Api.rawProject(p.rootId);
  return html`
  <div class="eyebrow"><a href="#/">프로젝트</a>${icon('ChevronRight', 13)}<a href="#/p/${p.id}">${p.title}</a>${icon('ChevronRight', 13)}<span>${c.needsApproval ? '수정본 요청' : '수정본 만들기'}</span></div>
  ${pageHeader(c.needsApproval ? '수정본 만들기 요청' : '수정본 만들기',
    `「${p.title}」의 최신 버전을 복사해 내 프로젝트를 만듭니다. 새 프로젝트는 원본 아래에 이어지고, 최초 원작자(${Api.user(root.ownerId).name})가 자동으로 표기됩니다.`)}
  <div class="narrow stack">
    ${c.needsApproval ? html`<div class="callout callout-warn">${icon('ShieldCheck')}<div>원작자가 <b>승인 필요</b>로 설정한 프로젝트입니다. 요청을 보내면 원작자가 승인한 뒤 수정본이 만들어집니다.</div></div>` : ''}
    <form data-form="${c.needsApproval ? 'forkRequest' : 'fork'}" data-id="${p.id}" class="stack">
      <label class="field"><span>수정본 제목</span><input name="title" value="${p.title} 수정본" required maxlength="100"></label>
      <label class="field"><span>${c.needsApproval ? '요청 메시지' : '설명'}</span><textarea name="description" rows="3" placeholder="${c.needsApproval ? '무엇을 바꾸고 싶은지 적어 주세요' : '어떤 점을 발전시킬 예정인가요?'}"></textarea></label>
      <div class="form-footer"><a class="btn btn-tertiary" href="#/p/${p.id}">취소</a><button class="btn btn-primary">${icon('GitFork', 15)}${c.needsApproval ? '요청 보내기' : '수정본 만들기'}</button></div>
    </form></div>`;
}

/* ---------- 파일 편집기 (새 프로젝트 · 새 버전 공용) ---------- */
function ensureEditor(key, files) {
  // 편집기마다 따로 보관해서, 다른 화면에 다녀와도 저장 전 편집 내용이 남도록 한다
  if (!ui.editors[key]) {
    const list = sortFiles(files.map((f) => ({ ...f })));
    ui.editors[key] = { key, files: list, current: list[0]?.path || null, message: '' };
  }
  return (ui.editor = ui.editors[key]);
}
function editorPane(st) {
  const cur = st.files.find((f) => f.path === st.current);
  // 용량 현황: 전체 한도 대비 사용량과, 파일당 한도를 넘는 파일 수
  const total = st.files.reduce((n, f) => n + byteSize(f.content), 0);
  const perFile = Api.settings().maxFileKB * 1024;
  const tooBig = st.files.filter((f) => byteSize(f.content) > perFile).length;
  const pct = Math.min(100, Math.round((total / PROJECT_LIMIT) * 100));
  return html`<div class="editor">
    <aside class="ed-side" aria-label="파일">
      <div class="ed-head">
        <span class="faint xs">파일 ${st.files.length}개</span>
        <button type="button" class="btn btn-sm btn-tertiary btn-danger" data-act="edClearAll" ${st.files.length ? '' : raw('disabled')}>${icon('Trash2', 13)}전체 삭제</button>
      </div>
      <div class="ed-list">${sortFiles(st.files).map((f) => html`<div class="ed-file ${f.path === st.current ? 'on' : ''}">
        <a href="#" data-act="edSelect" data-path="${f.path}">${fileIcon(f.path)}<span class="ellipsis">${f.path}</span></a>
        <span class="ed-tools"><button type="button" aria-label="${f.path} 이름 바꾸기" title="이름 바꾸기" data-act="edRename" data-path="${f.path}">${icon('Pencil', 13)}</button>
        <button type="button" aria-label="${f.path} 빼기" title="목록에서 빼기" data-act="edDelete" data-path="${f.path}">${icon('X', 13)}</button></span></div>`)}
        ${st.files.length ? '' : html`<div class="empty-inline" style="padding:12px">파일이 없습니다.</div>`}</div>
      <div class="ed-buttons">
        <button type="button" class="btn btn-sm btn-tertiary" data-act="edAdd">${icon('FilePlus', 14)}새 파일</button>
        <label class="btn btn-sm btn-tertiary file-label">${icon('Upload', 14)}파일·ZIP 올리기<input type="file" multiple data-change="edUpload"></label>
        <label class="btn btn-sm btn-tertiary file-label">${icon('FolderUp', 14)}폴더 올리기<input type="file" webkitdirectory data-change="edUpload"></label>
      </div>
      <div class="ed-usage ${total > PROJECT_LIMIT || tooBig ? 'over' : ''}">
        <div class="row-between"><span>용량</span><span class="num">${fmtSize(total)} / ${fmtSize(PROJECT_LIMIT)}</span></div>
        <div class="bar" role="progressbar" aria-label="프로젝트 용량" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
        ${tooBig ? html`<div class="warn">파일당 한도(${fmtSize(perFile)})를 넘는 파일이 ${tooBig}개 있습니다.</div>` : ''}
      </div>
      <div class="drop-hint">파일이나 ZIP을 여기로 끌어다 놓아도 됩니다.</div>
    </aside>
    <div class="ed-main">${cur ? html`<div class="ed-path">${fileIcon(cur.path)}${cur.path}</div>
      <label class="sr-only" for="ed-text">${cur.path} 내용</label>
      <textarea id="ed-text" class="ed-text" data-input="edText" spellcheck="false">${cur.content}</textarea>`
      : empty('편집할 파일이 없습니다', '왼쪽에서 파일을 추가하세요. README.md는 꼭 있어야 합니다.')}</div>
  </div>`;
}
async function editorAddFiles(fileList) {
  const st = ui.editor; if (!st) return;
  const { files, skipped } = await readUploadFiles(fileList);
  files.forEach((f) => {
    const i = st.files.findIndex((x) => x.path === f.path);
    if (i >= 0) st.files[i] = f; else st.files.push(f);
  });
  if (files.length) st.current = files.find((f) => /^readme\.md$/i.test(f.path))?.path || files[0].path;
  render();
  toast(`${files.length}개 파일을 추가했습니다.${skipped.length ? ` 이미지 등 텍스트가 아닌 파일 ${skipped.length}개는 제외했습니다.` : ''}`, 'ok');
}

/* ---------- 새 프로젝트 ---------- */
const TEMPLATE_README = (title) => `# ${title || '프로젝트 제목'}

어떤 프로그램인지 소개해 주세요.

## 실행 방법
\`python main.py\`
`;
function viewNew() {
  const u = Api.me();
  if (u.status !== 'active') throw new Error('활동 중인 부원만 업로드할 수 있습니다.');
  const st = ensureEditor('new', [{ path: 'README.md', content: TEMPLATE_README('') }, { path: 'main.py', content: 'print("Hello, 동아리!")\n' }]);
  const d = ui.newDraft || (ui.newDraft = { title: '', description: '', permission: 'free', generation: u.generation || '' });
  return html`
  ${pageHeader('새 프로젝트', '여러 파일을 한 프로젝트로 올립니다. 이 프로젝트가 계보의 원본이 됩니다.')}
  <form data-form="newProject" class="stack" style="gap:28px">
    <div class="split split-form">
      <div class="stack">
        <div class="field-row">
          <label class="field"><span>제목</span><input name="title" value="${d.title}" data-input="draft" required maxlength="100" placeholder="예: 로켓 시뮬레이션"></label>
          <label class="field"><span>기수</span><input name="generation" type="number" min="1" value="${d.generation}" data-input="draft" placeholder="예: 4"></label>
        </div>
        <label class="field"><span>한 줄 설명</span><input name="description" value="${d.description}" data-input="draft" maxlength="1000" placeholder="어떤 프로그램인가요?"></label>
      </div>
      <fieldset><legend>다른 부원의 수정 허용 범위</legend><div class="choice-list">
        ${['free', 'approval', 'view'].map((k) => html`<label class="choice"><input type="radio" name="permission" value="${k}" data-input="draft" ${d.permission === k ? raw('checked') : ''}>
          <div><b>${PERM_LABEL[k]}</b><span>${PERM_DESC[k]}</span></div></label>`)}
      </div></fieldset>
    </div>
    <div class="stack-sm">
      <div class="row-between"><span class="field-label">파일</span><span class="faint xs">파일당 최대 ${fmtSize(Api.settings().maxFileKB * 1024)} · 프로젝트 전체 ${fmtSize(PROJECT_LIMIT)} · README.md 필수</span></div>
      ${editorPane(st)}
    </div>
    <div class="form-footer"><a class="btn btn-tertiary" href="#/">취소</a><button class="btn btn-primary btn-lg">${icon('Upload', 15)}업로드</button></div>
  </form>`;
}

/* ---------- 편집 (새 버전) ---------- */
function viewEdit(id) {
  const p = Api.getProject(id);
  const u = Api.me();
  if (p.ownerId !== u.id || u.status !== 'active') throw new Error('작성자만 편집할 수 있습니다.');
  if (p.deleted) throw new Error('삭제된 프로젝트입니다.');
  const st = ensureEditor('edit:' + p.headVersionId, Api.headOf(p).files);
  return html`
  <div class="eyebrow"><a href="#/">프로젝트</a>${icon('ChevronRight', 13)}<a href="#/p/${p.id}">${p.title}</a>${icon('ChevronRight', 13)}<span>편집</span></div>
  ${pageHeader(`${p.title} 편집`, `저장하면 새 버전(v${Api.versionsOf(p.id).length + 1})이 만들어지고, 이전 버전은 기록에 남습니다.`)}
  <form data-form="commit" data-id="${p.id}" class="stack">
    ${editorPane(st)}
    <div class="commit-bar"><label class="grow"><span class="sr-only">변경 설명</span><input name="message" value="${st.message}" data-input="edMessage" maxlength="500" placeholder="변경 설명 (예: 점수 계산 버그 수정)" required></label>
      <a class="btn btn-tertiary" href="#/p/${p.id}" data-act="edCancel">취소</a><button class="btn btn-primary">새 버전 저장</button></div>
  </form>`;
}

/* ---------- 기수 아카이브 ---------- */
function viewArchive() {
  const roots = Api.listProjects({ rootsOnly: true });
  const groups = {};
  roots.forEach((p) => { const k = p.generation ?? '미지정'; (groups[k] = groups[k] || []).push(p); });
  const keys = Object.keys(groups).sort((a, b) => (a === '미지정') - (b === '미지정') || Number(b) - Number(a));
  const forkCount = (rootId) => Api.treeOf(rootId).filter((x) => x.parentId && !x.deleted && Api.canSee(x)).length;
  const header = pageHeader('기수 아카이브', '선배의 원본과, 그 위에 이어진 수정본의 계보');
  if (!keys.length) {
    return html`${header}${empty('아직 아카이브에 올라온 원본이 없습니다', '원본 프로젝트를 올리면 작성자의 기수에 맞춰 이곳에 정리됩니다.',
      Api.me().status === 'active' ? html`<a class="btn btn-primary btn-sm" href="#/new">${icon('Plus', 15)}새 프로젝트</a>` : '')}`;
  }
  const genId = (k) => `gen-${k}`;
  return html`${header}
  <div class="archive">
    <nav class="gen-index" aria-label="기수 목록"><div class="label">기수</div>
      ${keys.map((k) => html`<button data-act="scrollTo" data-target="${genId(k)}"><span>${k === '미지정' ? '기수 미지정' : `${k}기`}</span><span class="num">${groups[k].length}</span></button>`)}
    </nav>
    <div>${keys.map((k) => {
      const list = groups[k].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const forks = list.reduce((n, p) => n + forkCount(p.id), 0);
      return html`<section class="gen" id="${genId(k)}">
        <div class="gen-head"><h2>${k === '미지정' ? '기수 미지정' : `${k}기`}</h2><div class="meta"><span>원본 ${list.length}개</span><span>이어진 수정본 ${forks}개</span></div></div>
        ${list.map((p) => {
          const owner = Api.user(p.ownerId);
          const n = forkCount(p.id);
          return html`<article class="lineage">
            <div class="lineage-root">
              <a class="title" href="#/p/${p.id}">${p.title}</a>
              ${p.description ? html`<p>${p.description}</p>` : ''}
              <div class="meta">${userChip(owner)}<span>${fmtDate(p.createdAt).slice(0, 10)}</span>${p.permission !== 'free' ? html`<span>${PERM_LABEL[p.permission]}</span>` : ''}</div>
            </div>
            <div class="lineage-body">
              ${n ? html`<div class="branch-label">이어진 수정본 ${n}</div>${renderTree(p.id, null, { compact: true, skipRoot: true })}` : html`<p class="none">아직 이어진 수정본이 없습니다.${p.permission !== 'view' && Api.me().status === 'active' && p.ownerId !== Api.me().id ? html` <a class="inline-link" href="#/p/${p.id}/fork">첫 수정본 만들기</a>` : ''}</p>`}
            </div>
          </article>`;
        })}
      </section>`;
    })}</div>
  </div>`;
}

/* ---------- 내 기여 ---------- */
const TL = {
  // 제목 뒤에 붙는 조사(을/를)가 어긋나지 않도록 "제목 + 명사형" 문장으로 쓴다
  create: ['BookMarked', (e) => html`원본 등록 · ${projLink(Api.rawProject(e.projectId))}`],
  fork: ['GitFork', (e) => html`수정본 생성 · ${projLink(Api.rawProject(e.projectId))} <span class="faint">(${projTitle(Api.rawProject(e.refId))}에서)</span>`],
  commit: ['History', (e) => html`새 버전 · ${projLink(Api.rawProject(e.projectId))} <span class="muted">— ${e.text}</span>`],
  mr: ['GitPullRequest', (e) => html`반영 요청 · ${projLink(Api.rawProject(e.projectId))}`],
  merged: ['GitMerge', (e) => html`반영 승인됨 · ${projLink(Api.rawProject(e.projectId))}`],
  comment: ['MessageSquare', (e) => html`리뷰 댓글 · ${projLink(Api.rawProject(e.projectId))} <span class="mono faint">${e.text}</span>`],
};
function viewActivity(userId, q = {}) {
  const me = Api.me();
  const target = Api.user(userId);
  if (target.status === 'deleted') throw new Error('사용자를 찾을 수 없습니다.');
  const a = Api.activity(userId);
  const mine = userId === me.id;
  const tab = ['originals', 'forks', 'merged', 'contributed'].includes(q.tab) ? q.tab : 'originals';
  const base = mine ? '#/me' : `#/u/${userId}`;
  const projItem = (p) => html`<div class="item"><div class="item-main">
      <div class="item-title"><a href="#/p/${p.id}">${p.title}</a>${p.generation != null ? html`<span class="badge">${p.generation}기</span>` : ''}</div>
      <div class="item-sub">${p.parentId ? html`${icon('CornerDownRight', 13)} ${projTitle(Api.rawProject(p.parentId))}에서 이어짐` : html`이어진 수정본 ${Api.childrenOf(p.id).length}개`}${p.description ? html` · ${p.description}` : ''}</div>
    </div><div class="item-side">${fmtDate(p.createdAt).slice(0, 10)}</div></div>`;
  const panes = {
    originals: [a.originals, projItem, '아직 올린 원본이 없습니다.'],
    forks: [a.forks, projItem, '아직 만든 수정본이 없습니다.'],
    merged: [a.mergedRequests, (m) => html`<div class="item"><div class="item-main">
        <div class="item-title">${projLink(Api.rawProject(m.fromProjectId))}${icon('ArrowRight', 14)}${projLink(Api.rawProject(m.toProjectId))}</div>
        <div class="item-sub">${m.message}</div></div><div class="item-side">${fmtDate(m.resolvedAt || m.createdAt).slice(0, 10)}</div></div>`, '아직 원본에 반영된 요청이 없습니다.'],
    contributed: [a.contributedTo, (p) => html`<div class="item"><div class="item-main">
        <div class="item-title"><a href="#/p/${p.id}">${p.title}</a></div>
        <div class="item-sub">${Api.user(p.ownerId).name} 님의 프로젝트</div></div></div>`, '기여자로 등록된 프로젝트가 없습니다.'],
  };
  const [items, renderItem, none] = panes[tab];
  const TABS2 = [['originals', '만든 원본', a.originals.length], ['forks', '만든 수정본', a.forks.length], ['merged', '반영된 요청', a.mergedRequests.length], ['contributed', '기여한 프로젝트', a.contributedTo.length]];
  return html`
  <header class="page-header">
    <div class="profile-head">${avatar(target, 'avatar-lg')}<div>
      <div class="eyebrow" style="margin-bottom:2px">${mine ? '내 기여' : '기여 내역'}</div>
      <h1>${target.name}</h1>
      <div class="meta" style="margin-top:4px">${mine || Api.isStaff(me) ? html`<span>${target.email}</span>` : ''}<span>${roleText(target)}</span>${target.memberNo ? html`<span class="mono">${target.memberNo}</span>` : ''}${target.generation ? html`<span>${target.generation}기</span>` : ''}${target.status !== 'active' ? html`<span>${STATUS_LABEL[target.status] || ''}</span>` : ''}</div>
    </div></div>
    <div class="actions"><button class="btn" data-act="copyReport" data-id="${userId}">${icon('Copy', 15)}활동 보고서 복사</button></div>
  </header>
  <p class="impact">
    <span>내 작품에서 이어진 수정본 <b class="num">${a.forksOfMine}</b></span>
    <span>올린 버전 <b class="num">${a.versions}</b></span>
    <span>리뷰 댓글 <b class="num">${a.comments}</b></span>
  </p>
  <div class="split">
    <div>
      <nav class="stat-tabs" aria-label="기여 종류">${TABS2.map(([k, label, n]) => html`<a href="${base}?tab=${k}" class="${k === tab ? 'on' : ''}" ${k === tab ? raw('aria-current="page"') : ''}><span class="v num">${n}</span><span class="k">${label}</span></a>`)}</nav>
      ${items.length ? html`<div class="item-list">${items.map(renderItem)}</div>` : emptyInline(none)}
    </div>
    <aside>
      <div class="aside-title">최근 활동</div>
      ${a.timeline.length ? html`<ol class="timeline">${a.timeline.map((e) => html`<li><span class="ticon">${icon(TL[e.type][0], 12)}</span>
        <div><div class="ttext">${TL[e.type][1](e)}</div><div class="twhen">${timeAgo(e.at)}</div></div></li>`)}</ol>`
        : emptyInline('아직 기록된 활동이 없습니다.')}
    </aside>
  </div>`;
}
function activityReport(userId) {
  const t = Api.user(userId); const a = Api.activity(userId);
  const L = [`[${Api.settings().clubName} 코드 저장소 활동 보고서]`, `이름: ${t.name}${t.generation ? ` (${t.generation}기)` : ''}`, `작성일: ${fmtDate(new Date().toISOString()).slice(0, 10)}`, ''];
  L.push(`■ 만든 원본 ${a.originals.length}개`); a.originals.forEach((p) => L.push(`  - ${p.title}: ${p.description} (수정본 ${Api.childrenOf(p.id).length}개 파생)`));
  L.push(`■ 만든 수정본 ${a.forks.length}개`); a.forks.forEach((p) => L.push(`  - ${p.title} (원본: ${projTitle(Api.rawProject(p.parentId))}): ${p.description}`));
  L.push(`■ 원본에 반영된 개선 ${a.mergedRequests.length}건`); a.mergedRequests.forEach((m) => L.push(`  - ${projTitle(Api.rawProject(m.toProjectId))}에 반영: ${m.message}`));
  L.push(`■ 기타: 버전 ${a.versions}회 업로드, 코드 리뷰 댓글 ${a.comments}개`);
  return L.join('\n');
}

/* ---------- 알림 ---------- */
function viewNotifications() {
  const list = Api.notifications();
  const unread = list.filter((n) => !n.read).length;
  return html`
  ${pageHeader('알림', '', unread ? html`<button class="btn btn-tertiary" data-act="readAll">${icon('Check', 15)}모두 읽음</button>` : '', unread || null)}
  ${list.length ? html`<div class="nlist">${list.map((n) => html`<div class="nrow ${n.read ? '' : 'unread'}">
    <span class="ndot" aria-hidden="true"></span>
    <a href="${n.link || '#/'}" data-act="openNoti" data-id="${n.id}" data-link="${n.link || '#/'}">${n.read ? '' : html`<span class="sr-only">읽지 않음: </span>`}${n.text}</a>
    <span class="faint xs">${timeAgo(n.createdAt)}</span></div>`)}</div>`
    : empty('알림이 없습니다', '내 프로젝트에 수정본·댓글·반영 요청이 생기면 여기에 표시됩니다.')}`;
}

/* ---------- 관리 ---------- */
const AUDIT_LABEL = {
  'member.approved': '가입 승인', 'member.rejected': '가입 거절', 'member.status': '회원 상태 변경',
  'role.appointed': '직책 임명', 'role.revoked': '직책 해임', 'role.permission': '직책 권한 설정', 'role.emergency_owner': '긴급 복구(최고 관리자 지정)',
  'owner.transfer_proposed': '최고 관리자 이양 제안', 'owner.transferred': '최고 관리자 이양 완료', 'owner.transfer_cancelled': '최고 관리자 이양 취소',
  'account.invited': '계정 사전 등록', 'account.linked': '계정 연결', 'account.merged': '계정 병합', 'account.unlinked': '계정 연결 해제',
  'settings.updated': '설정 변경', 'project.deleted': '프로젝트 삭제(운영진)', 'project.hidden': '프로젝트 숨김', 'project.unhidden': '프로젝트 숨김 해제',
  'report.resolved': '신고 처리', 'session.updated_past': '지난 연도 차시 수정', 'session.link_past': '지난 연도 차시 연결',
  'session.unlink_past': '지난 연도 차시 연결 해제', 'membership.updated_past': '지난 연도 명단 수정',
};
const DETAIL_KEY = {
  role: '직책', email: '이메일', emails: '이메일', from: '이전', to: '변경', title: '제목', year: '연도', no: '차시', perm: '권한', enabled: '켬', count: '개수',
  domain: '도메인', signup_mode: '가입 방식', club_name: '동아리 이름', max_file_kb: '파일 용량(KB)', whitelist_count: '명단 수', name: '이름',
  from_name: '병합된 대기 회원', member_no: '회원 번호', generation: '기수', grade: '학년', action: '처리', reason: '사유',
};
function detailText(d) {
  return Object.entries(d || {}).filter(([k]) => DETAIL_KEY[k]).map(([k, v]) => {
    if ((k === 'from' || k === 'to') && !STATUS_LABEL[v]) return null;
    let t = v;
    if (k === 'role') t = ROLE_LABEL[v] || v;
    else if (k === 'from' || k === 'to') t = STATUS_LABEL[v];
    else if (Array.isArray(v)) t = v.join(', ');
    else if (typeof v === 'boolean') t = v ? '예' : '아니오';
    return `${DETAIL_KEY[k]}: ${t}`;
  }).filter(Boolean).join(' · ');
}
const memberOptions = (list) => list.map((x) => html`<option value="${x.id}">${x.name}${x.memberNo ? ` (${x.memberNo})` : ''}</option>`);
function incomingTransfers(u) {
  try { return Api.ownerTransfers().filter((t) => t.status === 'pending' && t.toMember === u.id); } catch { return []; }
}
function transferBox(t) {
  const from = Api.user(t.fromMember);
  return html`<div class="callout callout-warn">${icon('Info')}<div><b>${from.name}</b> 님이 최고 관리자 이양을 제안했습니다. 수락하면 내가 최고 관리자가 되고, ${from.name} 님은 관리자로 남습니다.
    <div class="row" style="margin-top:8px"><button class="btn btn-sm btn-primary" data-act="acceptTransfer" data-id="${t.id}">수락</button><button class="btn btn-sm" data-act="cancelTransfer" data-id="${t.id}">거절</button></div></div></div>`;
}
function viewTransferOnly(list) {
  return html`${pageHeader('최고 관리자 이양 제안')}<div class="stack narrow">${list.map(transferBox)}</div>`;
}

function viewAdmin(q) {
  const u = Api.me();
  if (!Api.isStaff(u)) {
    const inc = incomingTransfers(u);
    if (inc.length) return viewTransferOnly(inc);
    throw new Error('운영진만 볼 수 있습니다.');
  }
  const admin = isAdmin(u);
  const manager = Api.hasPerm(u, 'accounts.link');
  const users = Api.listUsers();
  const reports = Api.listReports();
  const pending = users.filter((x) => x.status === 'pending');
  const openReports = reports.filter((r) => r.status !== 'resolved').length;
  const T = [['dashboard', '대시보드', null], ['pending', '가입 승인', pending.length], ['users', '부원', users.length - pending.length], ['roles', '직책', null]];
  if (admin) T.push(['perms', '서버 관리자 권한', null]);
  if (manager) T.push(['accounts', '계정 연결', null]);
  if (admin) T.push(['years', '연도', null]);
  T.push(['reports', '신고', openReports], ['hidden', '숨김 프로젝트', null]);
  if (admin) T.push(['audit', '감사 기록', null]);
  T.push(['settings', '설정', null]);
  const tab = T.some(([k]) => k === q.tab) ? q.tab : 'dashboard';
  const REPORT = { open: ['접수', 'badge-danger'], escalated: ['관리자 판단 대기', 'badge-warn'], resolved: ['처리 완료', 'badge-muted'] };
  let body;
  if (tab === 'dashboard') {
    body = adminDashboard(u, users);
  } else if (tab === 'pending') {
    body = pending.length ? html`<div>${pending.map((x) => html`<div class="req">
      <div class="req-main"><div class="req-line">${userChip(x)}<span class="faint small">${x.email}</span></div><div class="meta" style="margin-top:4px"><span>${timeAgo(x.createdAt)} 요청</span></div></div>
      <form class="row" data-form="approveUser" data-id="${x.id}"><label><span class="sr-only">기수</span><input name="generation" type="number" min="1" placeholder="기수" style="width:84px;height:28px"></label>
        <button type="button" class="btn btn-sm" data-act="rejectUser" data-id="${x.id}">거절</button><button class="btn btn-sm btn-primary">승인</button></form></div>`)}</div>
      ${manager ? html`<p class="faint xs" style="margin-top:12px">새 학년에 계정이 바뀐 기존 회원이라면 승인하지 말고 <a class="link" href="#/admin?tab=accounts">계정 연결</a>에서 기존 회원에 연결하세요.</p>` : ''}`
      : empty('승인을 기다리는 사람이 없습니다', '새로 가입한 학교 계정이 있으면 여기에 표시됩니다.');
  } else if (tab === 'users') {
    body = html`<div class="table-wrap"><table class="tbl"><thead><tr><th>이름</th><th>회원 번호</th><th>이메일</th><th>직책</th><th>기수</th><th>상태</th><th></th></tr></thead><tbody>
      ${users.filter((x) => x.status !== 'pending').map((x) => html`<tr>
        <td>${userChip(x)}</td><td class="muted mono">${x.memberNo}</td><td class="muted">${x.email}</td>
        <td>${roleChips(x)}</td>
        <td><label><span class="sr-only">${x.name} 기수</span><input type="number" min="1" value="${x.generation ?? ''}" data-change="setGen" data-id="${x.id}" style="width:72px"></label></td>
        <td>${x.status === 'active' ? html`<span class="badge badge-ok">활동</span>` : html`<span class="badge badge-muted">${STATUS_LABEL[x.status]}</span>`}</td>
        <td style="text-align:right">${x.id !== u.id && (!isAdmin(x) || admin) ? (x.status === 'active'
          ? html`<button class="btn btn-sm btn-tertiary" data-act="setStatus" data-id="${x.id}" data-v="graduated">졸업 처리</button>`
          : html`<button class="btn btn-sm btn-tertiary" data-act="setStatus" data-id="${x.id}" data-v="active">활동으로 복귀</button>`) : ''}</td></tr>`)}
      </tbody></table></div>
      <p class="faint xs" style="margin-top:12px">직책은 <a class="link" href="#/admin?tab=roles">직책</a> 탭에서 바꿉니다. 졸업 처리해도 올린 프로젝트와 출처 표기는 그대로 남고, 마지막 관리자는 졸업 처리할 수 없습니다.</p>`;
  } else if (tab === 'roles') {
    body = adminRolesTab(u, users);
  } else if (tab === 'perms') {
    body = adminPermsTab();
  } else if (tab === 'accounts') {
    body = adminAccountsTab(users);
  } else if (tab === 'years') {
    body = adminYearsTab(q, users);
  } else if (tab === 'audit') {
    const logs = Api.auditLogs();
    body = logs.length ? html`<div class="table-wrap"><table class="tbl"><thead><tr><th>시각</th><th>행위자</th><th>내용</th><th>대상</th><th>상세</th></tr></thead><tbody>
      ${logs.map((l) => html`<tr><td class="muted xs" style="white-space:nowrap">${fmtDate(l.at)}</td>
        <td>${l.actor ? Api.user(l.actor).name : html`<span class="faint">시스템</span>`}</td>
        <td>${AUDIT_LABEL[l.action] || l.action}</td>
        <td>${l.target ? Api.user(l.target).name : ''}</td>
        <td class="muted small">${detailText(l.detail)}</td></tr>`)}</tbody></table></div>
      <p class="faint xs" style="margin-top:12px">최근 200건입니다. 감사 기록은 수정하거나 지울 수 없고 관리자만 볼 수 있습니다.</p>`
      : empty('아직 기록이 없습니다');
  } else if (tab === 'reports') {
    body = reports.length ? html`<div>${reports.map((r) => html`<div class="req"><div class="req-main">
      <div class="req-line"><span class="badge ${REPORT[r.status][1]}">${REPORT[r.status][0]}</span>${projLink(Api.rawProject(r.projectId))}</div>
      <div class="req-msg">${r.reason}</div>
      <div class="meta" style="margin-top:6px"><span>신고자 ${Api.user(r.reporterId).name}</span><span>${timeAgo(r.createdAt)}</span>${r.action ? html`<span>결과: ${r.action === 'hide' ? '숨김' : '문제없음'}</span>` : ''}</div></div>
      ${r.status !== 'resolved' && (r.status === 'open' || admin) ? html`<div class="row-end">
        ${!admin ? html`<button class="btn btn-sm btn-tertiary" data-act="report2" data-id="${r.id}" data-v="escalate">관리자에게 넘기기</button>` : ''}
        <button class="btn btn-sm" data-act="report2" data-id="${r.id}" data-v="dismiss">문제없음</button>
        <button class="btn btn-sm btn-danger" data-act="report2" data-id="${r.id}" data-v="hide">${icon('EyeOff', 14)}숨김 처리</button></div>` : ''}</div>`)}</div>`
      : empty('접수된 신고가 없습니다');
  } else if (tab === 'hidden') {
    const hp = Api.hiddenProjects();
    body = hp.length ? html`<div>${hp.map((p) => html`<div class="req"><div class="req-main"><div class="req-line">${projLink(p)}<span class="faint small">${p.ownerId ? Api.user(p.ownerId).name : ''}</span></div></div>
      <button class="btn btn-sm" data-act="hide" data-id="${p.id}" data-v="0">${icon('Eye', 14)}숨김 해제</button></div>`)}</div>` : empty('숨김 처리된 프로젝트가 없습니다');
  } else {
    const s = Api.settings();
    body = html`<form data-form="settings" class="stack narrow">
      <label class="field"><span>동아리 이름</span><input name="clubName" value="${s.clubName}" maxlength="40"></label>
      <label class="field"><span>허용 학교 도메인</span><input name="domain" value="${s.domain}" ${admin ? '' : raw('readonly')}><span class="hint">이 도메인의 Google 계정만 가입할 수 있습니다. 서버에서도 다시 검사합니다.${admin ? '' : ' 관리자만 바꿀 수 있습니다.'}</span></label>
      <fieldset ${admin ? '' : raw('disabled')}><legend>가입 방식</legend><div class="choice-list">
        <label class="choice"><input type="radio" name="signupMode" value="approval" ${s.signupMode === 'approval' ? raw('checked') : ''}><div><b>운영진 승인</b><span>학교 계정으로 로그인하면 승인 대기 상태가 되고, 운영진이 승인합니다. 명단에 있는 이메일은 바로 가입됩니다.</span></div></label>
        <label class="choice"><input type="radio" name="signupMode" value="whitelist" ${s.signupMode === 'whitelist' ? raw('checked') : ''}><div><b>부원 명단만</b><span>아래 명단에 있는 이메일만 가입할 수 있습니다.</span></div></label>
      </div></fieldset>
      <label class="field"><span>부원 이메일 명단</span><textarea name="whitelist" rows="5" placeholder="한 줄에 하나씩">${s.whitelist.join('\n')}</textarea><span class="hint">한 줄에 이메일 하나씩 적습니다.</span></label>
      <label class="field" style="max-width:320px"><span>파일당 용량 제한 (KB)</span><input name="maxFileKB" type="number" min="1" max="10240" value="${s.maxFileKB}"><span class="hint">1~10240KB(10MB). 프로젝트 하나의 전체 크기는 10MB까지입니다.</span></label>
      <div class="form-footer" style="justify-content:flex-start"><button class="btn btn-primary">설정 저장</button></div></form>`;
  }
  return html`
  ${pageHeader('관리')}
  ${incomingTransfers(u).map(transferBox)}
  <nav class="tabs" aria-label="관리 메뉴">${T.map(([k, label, n]) => html`<a href="#/admin?tab=${k}" class="${k === tab ? 'on' : ''}" ${k === tab ? raw('aria-current="page"') : ''}>${label}${n ? html`<span class="counter ${k === 'pending' || k === 'reports' ? 'counter-accent' : ''}">${n}</span>` : ''}</a>`)}</nav>
  <section>${body}</section>`;
}
const roleCodesOf = (u) => ROLE_DEFS.map((r) => r.code).filter((c) => (u.roles || []).includes(c));
const roleChips = (u) => (roleCodesOf(u).length ? roleCodesOf(u).map((c) => html`<span class="badge">${ROLE_LABEL[c]}</span> `) : html`<span class="faint small">부원</span>`);

function adminDashboard(u, users) {
  const y = Api.currentYear();
  const active = users.filter((x) => x.status === 'active').length;
  const all = Api.listProjects({});
  const thisYear = all.filter((p) => p.year === y).length;
  const admin = isAdmin(u);
  const logs = admin ? Api.auditLogs().slice(0, 6) : [];
  const unclassified = admin ? Api.unclassifiedProjects().length : null;
  const st = ui.serverStatus;
  if (Api.canServerDetail(u)) ui.after.push(() => loadServerStatus());
  const lastPing = st?.pings?.[0];
  return html`
  <p class="impact">
    <span>운영 연도 <b class="num">${y}</b></span>
    <span>활동 회원 <b class="num">${active}</b></span>
    <span>올해 프로젝트 <b class="num">${thisYear}</b></span>
    <span>전체 프로젝트 <b class="num">${all.length}</b></span>
    ${unclassified != null ? html`<span>차시 미분류 <b class="num">${unclassified}</b></span>` : ''}
  </p>
  <div class="split">
    <div>
      <section class="section"><div class="section-head"><h2>현재 직책</h2><a class="link small" href="#/admin?tab=roles">직책 관리</a></div>
        <div class="item-list">${ROLE_DEFS.map((r) => { const hs = Api.holdersOf(r.code); return html`<div class="item"><div class="item-main"><div class="item-title">${r.label}</div>
          <div class="item-sub">${hs.length ? hs.map((h, i) => html`${i ? ', ' : ''}<a class="link" href="#/u/${h.id}">${h.name}</a>`) : html`<span class="faint">없음</span>`}</div></div></div>`; })}</div></section>
      <section class="section"><div class="section-head"><h2>서버 상태</h2><a class="link small" href="#/status">서버 상태 페이지</a></div>
        ${st ? html`<div class="item-list">
          <div class="item"><div class="item-main"><div class="item-title">최근 연결 확인</div><div class="item-sub">${lastPing ? `${fmtDate(lastPing.at)} · ${lastPing.ok ? '정상' : '실패'}` : '기록 없음'}</div></div></div>
          <div class="item"><div class="item-main"><div class="item-title">DB 크기</div><div class="item-sub">${fmtSize(st.dbSize)} (무료 요금제 500MB)</div></div></div>
          <div class="item"><div class="item-main"><div class="item-title">최근 백업</div><div class="item-sub">${st.canBackup ? (st.backup ? `${fmtDate(st.backup.at)} · ${st.backup.ok ? '성공' : '실패'}` : '기록 없음') : '권한 없음'}</div></div></div></div>`
          : html`<p class="faint small">${Api.canServerDetail(u) ? (ui.serverStatusErr || '불러오는 중…') : '서버 상태 페이지에서 연결을 확인할 수 있습니다.'}</p>`}</section>
    </div>
    <aside>
      <div class="aside-title">최근 감사 기록</div>
      ${admin ? (logs.length ? html`<ol class="timeline">${logs.map((l) => html`<li><span class="ticon">${icon('ShieldCheck', 12)}</span>
        <div><div class="ttext">${AUDIT_LABEL[l.action] || l.action}${l.target ? html` <span class="muted">· ${Api.user(l.target).name}</span>` : ''}</div><div class="twhen">${timeAgo(l.at)}</div></div></li>`)}</ol>
        <a class="link small" href="#/admin?tab=audit">전체 보기</a>` : emptyInline('아직 기록이 없습니다.')) : emptyInline('감사 기록은 관리자만 볼 수 있습니다.')}
    </aside>
  </div>`;
}

function adminRolesTab(u, users) {
  const admin = isAdmin(u), owner = Api.isOwner(u);
  const active = users.filter((x) => x.status === 'active');
  const transfers = Api.ownerTransfers();
  const pendingT = transfers.filter((t) => t.status === 'pending');
  const outgoing = pendingT.filter((t) => t.fromMember === u.id);
  const DESC = {
    owner: '관리자 권한 + 관리자 임명·해임, 최고 관리자 이양. 한 명입니다.',
    admin: '전체 운영(설정·연도·계정 연결·감사 기록 등). 여러 명 가능하며 최고 관리자만 임명·해임합니다.',
    president: '동아리 활동·프로젝트 운영. 한 명이며, 새로 임명하면 기존 부장은 부장 직책만 내려놓습니다.',
    vice: '부장 보조. 한 명이며, 새로 임명하면 기존 차장은 차장 직책만 내려놓습니다. 부장과 같은 사람이 맡아도 됩니다.',
    server: '서버·DB 상태 확인. 여러 명 가능. 개인정보와 관리 기능은 어떤 설정으로도 받을 수 없습니다.',
  };
  const canManage = (code) => (code === 'admin' ? owner : admin);
  const section = (code) => {
    const holders = Api.holdersOf(code);
    const single = code === 'president' || code === 'vice';
    const candidates = active.filter((x) => !(x.roles || []).includes(code));
    return html`<section class="section"><div class="section-head"><h2>${ROLE_LABEL[code]}<span class="count">${holders.length}명</span></h2></div>
      <p class="faint small" style="margin:-4px 0 8px">${DESC[code]}</p>
      ${holders.length ? html`<div class="item-list">${holders.map((h) => html`<div class="item"><div class="item-main"><div class="item-title">${userChip(h)}${roleChips(h)}</div></div>
        <div class="item-side">${code !== 'owner' && canManage(code) ? html`<button class="btn btn-sm btn-tertiary" data-act="revokeRole" data-id="${h.id}" data-role="${code}">해임</button>` : ''}</div></div>`)}</div>` : emptyInline('보유자가 없습니다.')}
      ${code !== 'owner' && canManage(code) ? html`<form class="row" data-form="appointRole" data-role="${code}" style="margin-top:12px">
        <label><span class="sr-only">${ROLE_LABEL[code]} 임명할 회원</span><select name="member" style="width:auto;min-width:200px"><option value="">회원 선택</option>${memberOptions(candidates)}</select></label>
        <button class="btn btn-sm btn-primary">${single && holders.length ? '임명(양도)' : '임명'}</button></form>`
        : code !== 'owner' ? html`<p class="faint xs" style="margin-top:8px">${code === 'admin' ? '관리자 임명·해임은 최고 관리자만 할 수 있습니다.' : '관리자만 임명할 수 있습니다.'}</p>` : ''}
    </section>`;
  };
  const history = transfers.filter((t) => t.status !== 'pending').slice(0, 5);
  return html`${['owner', 'admin', 'president', 'vice', 'server'].map(section)}
  <section class="section"><div class="section-head"><h2>최고 관리자 이양</h2></div>
    <p class="faint small" style="margin:-4px 0 8px">이양은 2단계입니다. 현 최고 관리자가 제안하고, 받는 사람이 본인 계정으로 로그인해 <b>수락</b>해야 완료됩니다. 수락 전에는 취소할 수 있고, 이전 최고 관리자는 관리자 직책을 유지합니다.</p>
    ${pendingT.map((t) => (t.toMember === u.id ? transferBox(t) : html`<div class="callout callout-warn" style="margin-bottom:8px">${icon('Info')}<div>${Api.user(t.fromMember).name} 님 → ${Api.user(t.toMember).name} 님 최고 관리자 이양 제안이 수락을 기다리고 있습니다.
      ${t.fromMember === u.id || t.toMember === u.id ? html`<div style="margin-top:8px"><button class="btn btn-sm" data-act="cancelTransfer" data-id="${t.id}">제안 취소</button></div>` : ''}</div></div>`))}
    ${owner && !outgoing.length ? html`<form class="row" data-form="proposeTransfer"><label><span class="sr-only">이양할 회원</span><select name="member" style="width:auto;min-width:200px"><option value="">회원 선택</option>${memberOptions(active.filter((x) => x.id !== u.id))}</select></label>
      <button class="btn btn-sm btn-danger">이양 제안</button></form>` : !owner ? html`<p class="faint xs">최고 관리자만 이양을 제안할 수 있습니다.</p>` : ''}
    ${history.length ? html`<div class="aside-title" style="margin-top:16px">최근 이양 기록</div><div class="item-list">${history.map((t) => html`<div class="item"><div class="item-main"><div class="item-title">${Api.user(t.fromMember).name} → ${Api.user(t.toMember).name}</div></div>
      <div class="item-side">${t.status === 'accepted' ? '수락' : '취소'} · ${fmtDate(t.decidedAt || t.createdAt).slice(0, 10)}</div></div>`)}</div>` : ''}
  </section>
  <p class="faint xs" style="margin-top:16px">관리자(최고 관리자 포함)는 항상 한 명 이상 있어야 합니다. 마지막 관리자의 해임·졸업 처리는 서버가 거부합니다. 모든 직책 변경은 감사 기록에 남습니다.</p>`;
}

function adminPermsTab() {
  const perms = Api.rolePermissions();
  const order = [];
  Object.entries(PERM_ALLOWED).forEach(([role, list]) => list.forEach((perm) => order.push([role, perm])));
  return html`<p class="faint small" style="margin-bottom:12px">직책별로 켜고 끌 수 있는 권한입니다. 목록 안에서만 고를 수 있으며, 서버 관리자에게는 회원 개인정보(이메일 등)와 관리 기능을 어떤 설정으로도 줄 수 없습니다. 관리자는 항상 모든 권한을 가집니다.</p>
  <div class="table-wrap"><table class="tbl"><thead><tr><th>직책</th><th>권한</th><th>사용</th></tr></thead><tbody>
    ${order.map(([role, perm]) => { const row = perms.find((p) => p.role === role && p.perm === perm); return html`<tr><td>${ROLE_LABEL[role]}</td><td>${PERM_NAME[perm]}</td>
      <td><label class="row" style="gap:6px"><input type="checkbox" data-change="setPerm" data-role="${role}" data-perm="${perm}" ${row?.enabled ? raw('checked') : ''}><span class="small">${row?.enabled ? '켜짐' : '꺼짐'}</span></label></td></tr>`; })}
  </tbody></table></div>`;
}

function adminAccountsTab(users) {
  const accounts = Api.listAccounts();
  const invites = Api.listInvites();
  const pending = users.filter((x) => x.status === 'pending');
  const members = users.filter((x) => x.status !== 'pending');
  const accOf = (id) => accounts.filter((a) => a.memberId === id);
  return html`
  <section class="section"><div class="section-head"><h2>새 계정 사전 등록</h2></div>
    <p class="faint small" style="margin:-4px 0 8px">새 학년에 학교 계정이 바뀐 기존 회원의 새 이메일을 미리 등록하면, 그 계정으로 첫 로그인할 때 <b>새 회원이 만들어지지 않고 기존 회원에 자동 연결</b>됩니다. 이름이 같다는 이유로 합치지는 않습니다.</p>
    <form class="row" data-form="inviteAccount"><label><span class="sr-only">기존 회원</span><select name="member" style="width:auto;min-width:200px"><option value="">기존 회원 선택</option>${memberOptions(members)}</select></label>
      <label><span class="sr-only">새 이메일</span><input name="email" type="email" placeholder="새 학교 이메일" style="min-width:240px" required></label><button class="btn btn-sm btn-primary">등록</button></form>
    ${invites.length ? html`<div class="item-list" style="margin-top:12px">${invites.map((i) => html`<div class="item"><div class="item-main"><div class="item-title">${i.email}</div><div class="item-sub">${Api.user(i.memberId).name} 님에게 연결 예정</div></div></div>`)}</div>` : ''}
  </section>
  <section class="section"><div class="section-head"><h2>승인 대기 회원을 기존 회원에 연결</h2></div>
    <p class="faint small" style="margin:-4px 0 8px">새 계정으로 먼저 로그인해 승인 대기 중인 경우, 그 계정을 기존 회원에 옮기고 빈 대기 회원은 정리합니다. 올린 기록이 있는 회원은 연결할 수 없습니다.</p>
    ${pending.length ? pending.map((x) => html`<form class="req" data-form="linkAccount" data-id="${x.id}"><div class="req-main"><div class="req-line">${userChip(x)}<span class="faint small">${x.email}</span></div></div>
      <div class="row"><label><span class="sr-only">연결할 기존 회원</span><select name="target" style="width:auto;min-width:200px"><option value="">기존 회원 선택</option>${memberOptions(members)}</select></label>
      <button class="btn btn-sm btn-primary">기존 회원에 연결</button></div></form>`) : emptyInline('승인 대기 중인 회원이 없습니다.')}
  </section>
  <section class="section"><div class="section-head"><h2>회원별 로그인 계정</h2></div>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>회원</th><th>로그인 계정</th></tr></thead><tbody>
      ${members.map((x) => { const list = accOf(x.id); const act = list.filter((a) => a.status === 'active').length; return html`<tr><td>${userChip(x)}<div class="faint xs mono">${x.memberNo}</div></td>
        <td>${list.length ? list.map((a) => html`<div class="row" style="margin-bottom:4px"><span>${a.email || '(이메일 없음)'}</span>
          ${a.status === 'active' ? html`<span class="badge badge-ok">연결됨</span>${act > 1 ? html`<button class="btn btn-sm btn-tertiary" data-act="unlinkAccount" data-id="${a.authId}">해제</button>` : html`<span class="faint xs">마지막 계정</span>`}`
            : html`<span class="badge badge-muted">${a.status === 'unlinked' ? '해제됨' : '계정 삭제됨'}</span>`}</div>`) : html`<span class="faint small">없음</span>`}</td></tr>`; })}
    </tbody></table></div>
    <p class="faint xs" style="margin-top:12px">회원의 마지막 로그인 계정은 해제할 수 없습니다. 관리자는 Google 계정을 2개 이상 연결해 두는 것을 권장합니다. 모든 연결·해제·병합은 감사 기록에 남습니다.</p>
  </section>`;
}

function adminYearsTab(q, users) {
  const years = Api.years();
  const cur = Api.currentYear();
  const sel = years.some((y) => y.year === Number(q.year)) ? Number(q.year) : cur;
  const rows = Api.membershipOf(sel);
  const byId = new Map(users.map((x) => [x.id, x]));
  const inList = new Set(rows.map((r) => r.memberId));
  const addable = users.filter((x) => x.status === 'active' && !inList.has(x.id));
  return html`
  <section class="section"><div class="section-head"><h2>운영 연도</h2>
    <button class="btn btn-sm" data-act="ensureYear">${icon('RefreshCw', 14)}연도 확인·생성 실행</button></div>
    <p class="faint small" style="margin:-4px 0 8px">운영 연도는 3월 1일부터 다음 해 2월 말일까지(한국 시간)입니다. 새 연도는 매일 자동으로 확인되며, 여러 번 실행해도 같은 연도·차시가 중복 생성되지 않고 기존 데이터는 지워지지 않습니다.</p>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>연도</th><th>기간</th><th>상태</th><th>회원 명단</th><th></th></tr></thead><tbody>
      ${years.map((y) => html`<tr><td><b>${y.year}</b></td><td class="muted small">${y.startsOn} ~ ${y.endsOn}</td>
        <td>${y.year === cur ? html`<span class="badge badge-ok">현재</span>` : html`<span class="badge badge-muted">보관</span>`}</td>
        <td class="num">${Api.membershipOf(y.year).length}명</td>
        <td style="text-align:right"><a class="btn btn-sm btn-tertiary" href="#/admin?tab=years&year=${y.year}">명단</a> <a class="btn btn-sm btn-tertiary" href="#/activity/${y.year}">차시</a></td></tr>`)}
    </tbody></table></div></section>
  <section class="section"><div class="section-head"><h2>${sel}년 회원 명단<span class="count">${rows.length}명</span></h2>
    ${sel !== cur ? html`<span class="badge badge-warn">지난 연도 · 수정하면 감사 기록에 남습니다</span>` : ''}</div>
    <p class="faint small" style="margin:-4px 0 8px">연도별로 따로 저장되어, 다음 해에 학년·직책이 바뀌어도 이 해의 기록은 그대로 남습니다. 직책은 그 해 명단이 만들어질 때의 기록입니다.</p>
    ${rows.length ? html`<div class="table-wrap"><table class="tbl"><thead><tr><th>이름</th><th>기수</th><th>학년</th><th>직책(기록)</th><th>상태</th><th></th></tr></thead><tbody>
      ${rows.map((r) => { const m = byId.get(r.memberId) || { id: r.memberId, name: '(알 수 없음)', status: 'deleted' }; return html`<tr>
        <td>${userChip(m)}</td>
        <td colspan="3" style="padding:0"><form class="row" data-form="membership" data-id="${r.memberId}" data-year="${sel}" style="padding:8px 12px">
          <label><span class="sr-only">${m.name} 기수</span><input name="generation" type="number" min="1" value="${r.generation ?? ''}" style="width:72px" placeholder="기수"></label>
          <label><span class="sr-only">${m.name} 학년</span><input name="grade" type="number" min="1" max="6" value="${r.grade ?? ''}" style="width:64px" placeholder="학년"></label>
          <span class="faint small" style="min-width:120px">${(r.roles || []).length ? r.roles.map((c) => ROLE_LABEL[c] || c).join(', ') : '부원'}</span>
          <button class="btn btn-sm">저장</button></form></td>
        <td>${r.status === 'active' ? html`<span class="badge badge-ok">활동</span>` : html`<span class="badge badge-muted">${STATUS_LABEL[r.status] || r.status}</span>`}</td></tr>`; })}</tbody></table></div>` : emptyInline('이 연도의 명단이 비어 있습니다.')}
    ${addable.length ? html`<form class="row" data-form="membershipAdd" data-year="${sel}" style="margin-top:12px">
      <label><span class="sr-only">명단에 추가할 회원</span><select name="member" style="width:auto;min-width:200px"><option value="">명단에 추가할 회원</option>${memberOptions(addable)}</select></label>
      <label><span class="sr-only">기수</span><input name="generation" type="number" min="1" placeholder="기수" style="width:72px"></label>
      <label><span class="sr-only">학년</span><input name="grade" type="number" min="1" max="6" placeholder="학년" style="width:64px"></label>
      <button class="btn btn-sm btn-primary">추가</button></form>` : ''}
  </section>`;
}

/* ---------- 활동: 연도 → 차시 → 결과물 ---------- */
const readOnlyBadge = (year) => (Api.isPastYear(year) && !isAdmin(Api.me()) ? html`<span class="badge badge-muted">지난 연도 · 읽기 전용</span>` : '');
function creditsOf(p) {
  const owner = Api.user(p.ownerId);
  const others = Api.contributors(p.id).map((c) => Api.user(c.userId)).filter((x) => x.id !== owner.id);
  return { owner, others, all: [owner, ...others] };
}
function viewYears() {
  const years = Api.years();
  const cur = Api.currentYear();
  const count = (y) => Api.sessionsOf(y).reduce((n, s) => n + Api.projectsOfSession(s.id).length, 0);
  return html`
  ${pageHeader('활동', '운영 연도별로 차시(1~10)와 그 차시의 결과물을 모아 봅니다. 운영 연도는 3월 1일부터 다음 해 2월 말일까지입니다.')}
  ${years.length ? html`<div class="table-wrap"><table class="tbl"><thead><tr><th>운영 연도</th><th>기간</th><th>결과물</th><th></th></tr></thead><tbody>
    ${years.map((y) => html`<tr><td><a class="link" href="#/activity/${y.year}"><b>${y.year}년</b></a></td><td class="muted small">${y.startsOn} ~ ${y.endsOn}</td>
      <td class="num">${count(y.year)}개</td>
      <td>${y.year === cur ? html`<span class="badge badge-ok">현재 연도</span>` : html`<span class="badge badge-muted">지난 연도${isAdmin(Api.me()) ? '' : ' · 읽기 전용'}</span>`}</td></tr>`)}</tbody></table></div>`
    : empty('아직 운영 연도가 없습니다', '잠시 후 다시 확인하세요.')}`;
}
function viewYear(yearStr) {
  const year = Number(yearStr);
  const sessions = Api.sessionsOf(year);
  const y = Api.years().find((x) => x.year === year);
  if (!y || !sessions.length) throw new Error('없는 운영 연도입니다.');
  const admin = isAdmin(Api.me());
  const unclassified = admin && !Api.isPastYear(year) ? Api.unclassifiedProjects() : [];
  return html`
  <div class="eyebrow"><a href="#/activity">활동</a>${icon('ChevronRight', 13)}<span>${year}년</span></div>
  ${pageHeader(`${year}년 운영 연도`, `${y.startsOn} ~ ${y.endsOn}`, readOnlyBadge(year))}
  <div class="table-wrap"><table class="tbl"><thead><tr><th>차시</th><th>제목</th><th>날짜</th><th>결과물</th></tr></thead><tbody>
    ${sessions.map((s) => html`<tr><td><a class="link" href="#/activity/${year}/${s.no}"><b>${s.no}차시</b></a></td><td>${s.title}</td>
      <td class="muted small">${s.heldOn || '—'}</td><td class="num">${Api.projectsOfSession(s.id).length}개</td></tr>`)}</tbody></table></div>
  ${admin && !Api.isPastYear(year) ? html`<section class="section"><div class="section-head"><h2>차시 미분류<span class="count">${unclassified.length}</span></h2></div>
    <p class="faint small" style="margin:-4px 0 8px">올해 올라왔지만 아직 어느 차시에도 연결되지 않은 프로젝트입니다. 차시는 자동으로 추정하지 않으며, 프로젝트의 [차시] 탭에서 연결합니다.</p>
    ${unclassified.length ? html`<div class="item-list">${unclassified.map((p) => html`<div class="item"><div class="item-main"><div class="item-title"><a href="#/p/${p.id}">${p.title}</a>${typeBadge(p)}</div>
      <div class="item-sub">${Api.user(p.ownerId).name} · ${fmtDate(p.createdAt).slice(0, 10)}</div></div><div class="item-side"><a class="btn btn-sm btn-tertiary" href="#/p/${p.id}/sessions">차시 연결</a></div></div>`)}</div>` : emptyInline('미분류 프로젝트가 없습니다.')}</section>` : ''}`;
}
function viewSession(yearStr, noStr, q) {
  const year = Number(yearStr); const no = Number(noStr);
  const s = Api.sessionsOf(year).find((x) => x.no === no);
  if (!s) throw new Error('없는 차시입니다.');
  const me = Api.me();
  const past = Api.isPastYear(year);
  const canEdit = me.status === 'active' && (past ? isAdmin(me) : isStaff(me));
  const all = Api.projectsOfSession(s.id);
  const authors = new Map();
  all.forEach((p) => creditsOf(p).all.forEach((a) => authors.set(a.id, a)));
  const kw = (q.q || '').trim().toLowerCase();
  const list = all.filter((p) => !q.author || creditsOf(p).all.some((a) => a.id === q.author))
    .filter((p) => !kw || (p.title + ' ' + p.description + ' ' + creditsOf(p).all.map((a) => a.name).join(' ')).toLowerCase().includes(kw));
  const base = `#/activity/${year}/${no}`;
  const editing = canEdit && q.edit === '1';
  return html`
  <div class="eyebrow"><a href="#/activity">활동</a>${icon('ChevronRight', 13)}<a href="#/activity/${year}">${year}년</a>${icon('ChevronRight', 13)}<span>${no}차시</span></div>
  ${pageHeader(s.title, s.heldOn ? `${s.heldOn}${s.description ? ' · ' : ''}${s.description}` : s.description,
    html`${readOnlyBadge(year)}${canEdit && !editing ? html`<a class="btn btn-sm" href="${base}?edit=1">${icon('Pencil', 14)}차시 정보 수정</a>` : ''}`, all.length)}
  ${past && canEdit ? html`<div class="callout callout-warn" style="margin-bottom:12px">${icon('TriangleAlert')}<div>지난 연도의 차시입니다. 수정하면 감사 기록에 남습니다.</div></div>` : ''}
  ${editing ? html`<form data-form="session" data-id="${s.id}" data-back="${base}" class="stack narrow" style="margin-bottom:24px">
    <label class="field"><span>제목</span><input name="title" value="${s.title}" maxlength="100" required></label>
    <label class="field" style="max-width:220px"><span>날짜</span><input name="heldOn" type="date" value="${s.heldOn || ''}"></label>
    <label class="field"><span>설명</span><textarea name="description" rows="3" maxlength="1000">${s.description}</textarea></label>
    <div class="row"><button class="btn btn-primary">저장</button><a class="btn btn-tertiary" href="${base}">취소</a></div></form>` : ''}
  <form class="toolbar" data-form="sessionSearch" data-base="${base}" role="search">
    <label class="input-icon search-field"><span class="sr-only">차시 안에서 검색</span>${icon('Search', 15)}<input type="search" name="q" value="${q.q || ''}" placeholder="제목, 설명, 제작자 검색"></label>
    <label><span class="sr-only">제작자</span><select name="author" data-change="submitForm"><option value="">모든 제작자</option>
      ${[...authors.values()].sort((a, b) => a.name.localeCompare(b.name)).map((a) => html`<option value="${a.id}" ${a.id === q.author ? raw('selected') : ''}>${a.name}</option>`)}</select></label>
    <button class="btn btn-tertiary search-btn">검색</button>
    ${q.q || q.author ? html`<span class="result-count">${list.length}개 · <a class="link" href="${base}">초기화</a></span>` : ''}
  </form>
  ${list.length ? html`<div class="item-list">${list.map((p) => { const c = creditsOf(p); return html`<div class="item"><div class="item-main">
      <div class="item-title"><a href="#/p/${p.id}">${p.title}</a>${typeBadge(p)}${p.generation != null ? html`<span class="badge">${p.generation}기</span>` : ''}</div>
      ${p.description ? html`<div class="item-sub">${p.description}</div>` : ''}
      <div class="item-sub">제작 <a class="link" href="#/u/${c.owner.id}">${c.owner.name}</a>${c.others.length ? html` · 기여 ${c.others.map((a, i) => html`${i ? ', ' : ''}<a class="link" href="#/u/${a.id}">${a.name}</a>`)}` : ''}</div>
    </div><div class="item-side">${fmtDate(p.createdAt).slice(0, 10)}</div></div>`; })}</div>`
    : all.length ? empty('조건에 맞는 결과물이 없습니다', '검색어나 제작자 필터를 바꿔 보세요.', html`<a class="btn btn-sm" href="${base}">필터 초기화</a>`)
    : empty('이 차시에 연결된 결과물이 없습니다', '프로젝트 화면의 [차시] 탭에서 작성자나 운영진이 연결할 수 있습니다.')}`;
}
/** 프로젝트 화면의 [차시] 탭: 이 프로젝트가 연결된 차시와, 연결·해제 */
function tabSessions(p) {
  const u = Api.me();
  const admin = isAdmin(u);
  const cur = Api.currentYear();
  const linked = Api.sessionsOfProject(p.id);
  const linkedIds = new Set(linked.map((s) => s.id));
  const active = u.status === 'active' && !p.deleted;
  const canCur = active && (p.ownerId === u.id || isStaff(u));
  const yearBlock = (y) => {
    const can = y.year === cur ? canCur : active && admin;
    return html`<div class="table-wrap" style="margin-bottom:12px"><table class="tbl"><thead><tr><th style="width:56px"></th><th>${y.year}년 차시</th><th>날짜</th></tr></thead><tbody>
      ${Api.sessionsOf(y.year).map((s) => html`<tr><td><label><span class="sr-only">${y.year}년 ${s.no}차시에 연결</span><input type="checkbox" data-change="toggleSession" data-pid="${p.id}" data-sid="${s.id}" ${linkedIds.has(s.id) ? raw('checked') : ''} ${can ? '' : raw('disabled')}></label></td>
        <td><a class="link" href="#/activity/${y.year}/${s.no}">${s.no}차시</a> <span class="muted">${s.title === `${s.no}차시` ? '' : s.title}</span></td><td class="muted small">${s.heldOn || '—'}</td></tr>`)}</tbody></table></div>`;
  };
  const years = Api.years();
  return html`
  <div class="section-head"><h2>연결된 차시<span class="count">${linked.length}</span></h2></div>
  ${linked.length ? html`<div class="item-list">${linked.map((s) => html`<div class="item"><div class="item-main"><div class="item-title"><a href="#/activity/${s.year}/${s.no}">${s.year}년 ${s.no}차시</a><span class="muted">${s.title}</span></div></div>
    <div class="item-side">${s.year !== cur ? html`<span class="badge badge-muted">지난 연도${admin ? '' : ' · 읽기 전용'}</span>` : ''}</div></div>`)}</div>` : emptyInline('아직 어느 차시에도 연결되지 않았습니다.')}
  <section class="section"><div class="section-head"><h2>${cur}년 차시에 연결</h2></div>
    ${canCur ? html`<p class="faint small" style="margin:-4px 0 8px">체크하면 연결되고, 해제하면 연결이 끊어집니다. 결과물은 한 번만 저장되고 여러 차시가 참조합니다.</p>` : html`<p class="faint small" style="margin:-4px 0 8px">작성자 또는 운영진만 연결할 수 있습니다.</p>`}
    ${years.filter((y) => y.year === cur).map(yearBlock)}
    ${admin && years.some((y) => y.year !== cur) ? html`<details class="section"><summary class="small muted" style="cursor:pointer;margin-bottom:8px">지난 연도 차시 (관리자만 · 감사 기록에 남음)</summary>
      ${years.filter((y) => y.year !== cur).map(yearBlock)}</details>` : ''}
  </section>`;
}

/* ---------- 서버 상태 ---------- */
function lastOkLocal() { try { return localStorage.getItem('pophub.lastOk'); } catch { return null; } }
function saveLastOk(iso) { try { localStorage.setItem('pophub.lastOk', iso); } catch { /* 저장소를 못 쓰면 건너뜀 */ } }
const canStatusDetail = () => { try { return !!Store.db && !!Api.me() && Api.canServerDetail(Api.me()); } catch { return false; } };
function loadServerStatus(force = false) {
  if (!canStatusDetail()) return;
  if (!force && (ui.serverStatus || ui.serverStatusTried)) return;
  if (ui.serverStatusLoading) return;
  ui.serverStatusLoading = true; ui.serverStatusTried = true;
  Promise.resolve().then(() => (Remote.enabled ? Remote.serverStatus() : Api.serverStatus()))
    .then((r) => { ui.serverStatus = r; ui.serverStatusErr = null; })
    .catch((e) => { ui.serverStatusErr = e.message; })
    .finally(() => { ui.serverStatusLoading = false; if (/^#\/(status|admin)/.test(location.hash) && !ui.bootFailed) render(); });
}
function viewStatus() {
  const p = ui.ping;
  const last = lastOkLocal();
  const detail = canStatusDetail();
  if (detail) ui.after.push(() => loadServerStatus());
  const st = ui.serverStatus;
  return html`
  ${pageHeader('서버 상태', '서버와 DB 가 응답하는지 확인합니다.')}
  <div class="callout" style="margin-bottom:16px">${icon('Info')}<div><b>연결 확인은 서버가 응답하는지만 확인하며, 데이터를 바꾸지 않습니다.</b> 삭제·초기화와는 아무 관계가 없습니다(응답 시각 기록 한 줄만 남습니다).
    ${Remote.enabled ? '' : ' 지금은 데모 모드라 서버에 연결되어 있지 않습니다.'}</div></div>
  <section class="section"><div class="row"><button class="btn btn-primary" data-act="pingCheck">${icon('Activity', 15)}연결 확인</button>
    <span class="faint small">${last ? `이 브라우저에서 마지막으로 정상 확인한 시각: ${fmtDate(last)}` : '아직 확인한 기록이 없습니다.'}</span></div>
    <div aria-live="polite" style="margin-top:12px">
    ${p ? (p.ok ? html`<div class="callout"><span class="badge badge-ok">정상</span><div>서버가 응답했습니다. 응답 시간 <b class="num">${p.ms}ms</b>${p.lastPing ? html` · 서버에 기록된 마지막 연결 확인 ${fmtDate(p.lastPing)}` : ''}</div></div>`
      : html`<div class="callout callout-danger">${icon('CircleAlert')}<div><b>서버에 연결하지 못했습니다.</b> ${p.error ? html`<span class="muted">(${p.error})</span>` : ''}
        <ul style="margin:8px 0 0;padding-left:18px">
          <li>서버가 <b>일시 정지</b>되었을 수 있습니다. Supabase 무료 요금제는 7일 동안 요청이 없으면 프로젝트를 일시 정지합니다. 데이터는 지워지지 않습니다.</li>
          <li><b>서버 관리자에게 알려 주세요.</b> 서버 관리자는 Supabase 대시보드(supabase.com/dashboard)에서 해당 프로젝트의 <b>Restore project</b> 를 눌러 다시 켤 수 있습니다.</li>
          <li>이 화면에서는 서버를 깨울 수 없습니다. (깨우려면 비밀 관리 토큰이 필요한데, 웹페이지에 넣으면 보안 사고가 되기 때문입니다.)</li>
          <li>학교 네트워크·인터넷 연결 문제일 수도 있으니 잠시 뒤 다시 확인해 보세요.</li>
        </ul></div></div>`) : ''}</div></section>
  ${detail ? html`<section class="section"><div class="section-head"><h2>서버 상세</h2><button class="btn btn-sm btn-tertiary" data-act="loadStatus">${icon('RefreshCw', 14)}새로 불러오기</button></div>
    ${st ? html`
      <div class="table-wrap"><table class="tbl"><tbody>
        <tr><td>DB 크기</td><td class="num">${fmtSize(st.dbSize)} <span class="faint xs">(무료 요금제 500MB)</span></td></tr>
        <tr><td>현재 운영 연도</td><td class="num">${st.year}</td></tr>
        ${Object.entries(st.counts).map(([k, v]) => html`<tr><td>${{ profiles: '회원', projects: '프로젝트', versions: '버전', comments: '댓글', notifications: '알림', sessions: '차시', audit_logs: '감사 기록' }[k] || k}</td><td class="num">${v}행</td></tr>`)}
      </tbody></table></div>
      <div class="section-head" style="margin-top:20px"><h3>최근 연결 확인</h3></div>
      ${st.pings.length ? html`<div class="item-list">${st.pings.map((x) => html`<div class="item"><div class="item-main">${fmtDate(x.at)}</div><div class="item-side">${x.ok ? '정상' : '실패'}</div></div>`)}</div>` : emptyInline('기록이 없습니다.')}
      <div class="section-head" style="margin-top:20px"><h3>최근 백업</h3></div>
      ${st.canBackup ? (st.backup ? html`<div class="item-list"><div class="item"><div class="item-main">${fmtDate(st.backup.at)} · ${st.backup.ok ? '성공' : '실패'}${st.backup.detail?.bytes ? html` <span class="faint xs">(${fmtSize(Number(st.backup.detail.bytes))})</span>` : ''}</div></div></div>` : emptyInline('백업 기록이 없습니다. 백업 작업(GitHub Actions)이 아직 실행되지 않았습니다.')) : emptyInline('백업 상태를 볼 권한이 없습니다.')}
      <div class="section-head" style="margin-top:20px"><h3>최근 오류</h3></div>
      ${st.canErrors ? (st.errors?.length ? html`<div class="item-list">${st.errors.map((x) => html`<div class="item"><div class="item-main">${fmtDate(x.at)} <span class="muted small">${JSON.stringify(x.detail)}</span></div></div>`)}</div>` : emptyInline('기록된 오류가 없습니다.')) : emptyInline('오류 기록을 볼 권한이 없습니다.')}`
      : html`<p class="faint small">${ui.serverStatusErr ? ui.serverStatusErr : '불러오는 중…'}</p>`}
  </section>` : ''}`;
}
/** 서버에 연결하지 못해 앱을 시작할 수 없을 때 보여 주는 화면 (상태 페이지는 그래도 열린다) */
function renderBootFailure() {
  const err = ui.bootError ? ui.bootError.message : '';
  const onStatus = /^#\/status/.test(location.hash);
  $app().innerHTML = (onStatus
    ? html`<main id="main" class="container"><div class="eyebrow"><a href="#/">처음으로</a></div>${viewStatus()}</main>`
    : html`<main class="auth-wrap"><div class="auth"><div class="auth-box">
      <h1>서버에 연결하지 못했습니다</h1>
      <p>${err}</p><p class="auth-foot">서버가 일시 정지되었을 수 있습니다. <a class="link" href="#/status">서버 상태 확인</a>에서 연결을 확인하고 안내를 따르세요. (js/config.js 의 Supabase 주소·키와 SETUP.md 의 설정도 확인하세요.)</p>
      <button class="btn" style="margin-top:16px" onclick="location.reload()">다시 시도</button></div></div></main>`).s;
}

/* ===================== 이벤트 처리 ===================== */
// 서버 모드에서는 Api 변경 함수가 Promise를 돌려주므로 모든 처리기는 await 한다 (데모 모드에서도 그대로 동작).
let busy = 0;
function setBusy(delta) {
  busy += delta;
  document.body.classList.toggle('busy', busy > 0);
}
function safe(fn, lockEl) {
  // 처리 중에는 버튼을 잠가 두 번 누르기를 막는다
  const btns = !lockEl ? [] : lockEl.matches('button') ? [lockEl] : [...lockEl.querySelectorAll('button')];
  // 실제로 누른(또는 제출) 버튼에는 로딩 표시를 붙여 단순 비활성과 구분한다
  const main = !lockEl ? null : lockEl.matches('button') ? lockEl : lockEl.querySelector('button:not([type=button])');
  const done = () => {
    btns.forEach((b) => { b.disabled = false; });
    if (main) { main.classList.remove('is-loading'); main.removeAttribute('aria-busy'); }
    setBusy(-1);
  };
  btns.forEach((b) => { b.disabled = true; });
  if (main) { main.classList.add('is-loading'); main.setAttribute('aria-busy', 'true'); }
  setBusy(1);
  let r;
  try { r = fn(); } catch (e) { console.error(e); toast(e.message, 'error'); done(); return; }
  Promise.resolve(r).catch((e) => { console.error(e); toast(e.message, 'error'); }).finally(done);
}
const resetUi = () => { ui.editors = {}; ui.editor = null; ui.newDraft = null; ui.serverStatus = null; ui.serverStatusTried = false; ui.serverStatusErr = null; ui.ping = null; };
const Actions = {
  toggleMenu(el) {
    const open = document.body.classList.toggle('nav-open');
    el.setAttribute('aria-expanded', String(open));
    if (open) document.querySelector('.mobile-nav a')?.focus();
  },
  skipToMain() { document.getElementById('main')?.focus(); },
  scrollTo(el) { document.getElementById(el.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
  async logout() { await Api.logout(); resetUi(); go('#/'); },
  async googleLogin() { Remote.clearLoginError(); await Remote.signIn(); },
  quickLogin(el) { Api.login(el.dataset.email); go('#/'); },
  resetDemo() { if (confirm('모든 데이터를 처음 예시 상태로 되돌릴까요?')) { Store.reset(); resetUi(); go('#/'); toast('데모 데이터를 초기화했습니다.', 'ok'); } },
  async reloadData() { await Remote.refresh(); render(); toast('새로 불러왔습니다.', 'ok'); },
  async zip(el) {
    const p = Api.getProject(el.dataset.id);
    await downloadZip(p.title, Api.headOf(p).files);
  },
  async editInfo(el) {
    const p = Api.getProject(el.dataset.id);
    const title = prompt('제목', p.title); if (title == null) return;
    const description = prompt('설명', p.description); if (description == null) return;
    const perm = prompt('수정 허용 범위: 1 = 수정 자유, 2 = 승인 필요, 3 = 보기만 가능', { free: '1', approval: '2', view: '3' }[p.permission]);
    if (perm == null) return;
    const permission = { 1: 'free', 2: 'approval', 3: 'view' }[perm.trim()];
    if (!permission) throw new Error('1, 2, 3 중 하나를 입력하세요.');
    const generation = prompt('기수 (비우면 미지정)', p.generation ?? ''); if (generation == null) return;
    await Api.updateProjectInfo(p.id, { title, description, permission, generation: generation.trim() }); render(); toast('저장했습니다.', 'ok');
  },
  async editGen(el) {
    const p = Api.getProject(el.dataset.id);
    const generation = prompt('아카이브 기수 (비우면 미지정)', p.generation ?? ''); if (generation == null) return;
    await Api.updateProjectInfo(p.id, { generation: generation.trim() }); render(); toast('기수를 바꿨습니다.', 'ok');
  },
  async report(el) {
    const reason = prompt('신고 사유를 적어 주세요 (예: 표절, 부적절한 내용)'); if (reason == null) return;
    await Api.report(el.dataset.id, reason); toast('신고가 접수되었습니다. 운영진이 확인합니다.', 'ok');
  },
  async hide(el) {
    await Api.setHidden(el.dataset.id, el.dataset.v === '1'); render();
    toast(el.dataset.v === '1' ? '숨김 처리했습니다.' : '숨김을 해제했습니다.', 'ok');
  },
  async hideTree(el) {
    if (!confirm('이 프로젝트와 모든 하위 수정본을 숨길까요?')) return;
    const n = await Api.setHidden(el.dataset.id, true, true); render(); toast(`${n}개 프로젝트를 숨겼습니다.`, 'ok');
  },
  async delete(el) {
    const p = Api.getProject(el.dataset.id);
    const kids = Api.childrenOf(p.id).length;
    if (!confirm(`「${p.title}」을 삭제할까요?${kids ? `\n하위 수정본 ${kids}개는 그대로 남고 "원본 삭제됨"으로 표시됩니다.` : ''}`)) return;
    await Api.deleteProject(p.id); toast('삭제했습니다.', 'ok'); go(Api.isStaff(Api.me()) ? `#/p/${p.id}/tree` : '#/');
  },
  async delComment(el) { if (confirm('댓글을 삭제할까요?')) { await Api.deleteComment(el.dataset.id); render(); } },
  async forkReq(el) {
    const ok = el.dataset.v === '1';
    if (!confirm(ok ? '요청을 승인하고 수정본을 만들어 줄까요?' : '요청을 거절할까요?')) return;
    await Api.resolveForkRequest(el.dataset.id, ok); render(); toast(ok ? '승인했습니다. 수정본이 만들어졌습니다.' : '거절했습니다.', 'ok');
  },
  async mr(el) {
    if (el.dataset.v === '1') {
      if (!confirm('승인하면 원본의 새 버전이 수정본 내용으로 교체됩니다. 계속할까요?')) return;
      await Api.resolveMergeRequest(el.dataset.id, true); render(); toast('반영했습니다. 새 버전이 만들어졌습니다.', 'ok');
    } else {
      const note = prompt('거절 사유 (선택)'); if (note == null) return;
      await Api.resolveMergeRequest(el.dataset.id, false, note); render(); toast('거절했습니다.', 'ok');
    }
  },
  async runPy(el) {
    const out = document.getElementById('pyOut');
    el.disabled = true;
    try { await runPython(el.dataset.id, document.getElementById('pyEntry').value, out, document.getElementById('pyStdin').value); }
    catch (e) { out.textContent = '오류: ' + e.message; }
    finally { el.disabled = false; }
  },
  stopPy() { stopPython(); },
  runHtml(el) {
    const p = Api.getProject(el.dataset.id);
    document.getElementById('htmlOut').srcdoc = buildHtmlDoc(Api.headOf(p).files, el.dataset.entry);
  },
  edSelect(el) { ui.editor.current = el.dataset.path; render(); },
  edAdd() {
    const name = prompt('새 파일 경로 (예: utils.py, src/game.js)'); if (!name) return;
    const path = normalizePath(name); if (!path) throw new Error('올바른 경로가 아닙니다.');
    if (ui.editor.files.some((f) => f.path === path)) throw new Error('같은 이름의 파일이 이미 있습니다.');
    ui.editor.files.push({ path, content: '' }); ui.editor.current = path; render();
  },
  edRename(el) {
    const f = ui.editor.files.find((x) => x.path === el.dataset.path);
    const name = prompt('새 경로', f.path); if (!name) return;
    const path = normalizePath(name); if (!path) throw new Error('올바른 경로가 아닙니다.');
    if (path !== f.path && ui.editor.files.some((x) => x.path === path)) throw new Error('같은 이름의 파일이 이미 있습니다.');
    if (ui.editor.current === f.path) ui.editor.current = path;
    f.path = path; render();
  },
  edDelete(el) {
    if (!confirm(`${el.dataset.path} 파일을 목록에서 뺄까요?`)) return;
    ui.editor.files = ui.editor.files.filter((x) => x.path !== el.dataset.path);
    if (ui.editor.current === el.dataset.path) ui.editor.current = ui.editor.files[0]?.path || null;
    render();
  },
  /** 잘못 올린 파일을 한 번에 비운다 (저장 전 편집 목록만 비우며, 서버에 이미 올라간 버전은 그대로) */
  edClearAll() {
    const n = ui.editor?.files.length || 0;
    if (!n) return;
    if (!confirm(`목록의 파일 ${n}개를 모두 뺄까요?\n아직 저장하지 않은 목록만 비우며, 이미 저장된 버전에는 영향이 없습니다.`)) return;
    ui.editor.files = []; ui.editor.current = null;
    render();
    toast(`파일 ${n}개를 목록에서 뺐습니다.`, 'ok');
  },
  edCancel() { delete ui.editors[ui.editor?.key]; ui.editor = null; go(location.hash.replace(/\/edit$/, '')); },
  async setStatus(el) {
    const grad = el.dataset.v === 'graduated';
    if (!confirm(grad ? '졸업생으로 전환할까요? 프로젝트와 출처 표기는 유지되고, 계정은 읽기 전용이 됩니다.' : '활동 부원으로 되돌릴까요?')) return;
    await Api.setUserStatus(el.dataset.id, el.dataset.v); render();
  },
  async rejectUser(el) { if (confirm('가입 요청을 거절할까요?')) { await Api.rejectUser(el.dataset.id); render(); } },
  async report2(el) { await Api.resolveReport(el.dataset.id, el.dataset.v); render(); toast('처리했습니다.', 'ok'); },
  async readAll() { await Api.markAllRead(); render(); },
  /** 연결 확인: 서버가 응답하는지만 본다 (데이터를 바꾸지 않음) */
  async pingCheck() {
    ui.ping = await (Remote.enabled ? Remote.ping() : Api.ping());
    if (ui.ping.ok) saveLastOk(new Date().toISOString());
    render();
  },
  loadStatus() { ui.serverStatusTried = false; ui.serverStatus = null; loadServerStatus(true); render(); },
  async ensureYear() { const y = await Api.ensureAcademicYear(); render(); toast(`${y}년 운영 연도를 확인했습니다. 이미 있으면 아무것도 바꾸지 않습니다.`, 'ok'); },
  async revokeRole(el) {
    const t = Api.user(el.dataset.id); const label = ROLE_LABEL[el.dataset.role];
    if (!confirm(`${t.name} 님의 ${label} 직책을 해임할까요?\n계정과 올린 기록은 그대로 남습니다.`)) return;
    await Api.revokeRole(el.dataset.id, el.dataset.role); render(); toast(`${label} 직책을 해임했습니다.`, 'ok');
  },
  async acceptTransfer(el) {
    if (!confirm('최고 관리자 이양을 수락할까요?\n수락하면 내가 최고 관리자가 되고, 이전 최고 관리자는 관리자로 남습니다.')) return;
    await Api.acceptOwnerTransfer(el.dataset.id); render(); toast('최고 관리자가 되었습니다.', 'ok');
  },
  async cancelTransfer(el) {
    if (!confirm('최고 관리자 이양 제안을 취소(거절)할까요?')) return;
    await Api.cancelOwnerTransfer(el.dataset.id); render(); toast('이양 제안을 취소했습니다.', 'ok');
  },
  async unlinkAccount(el) {
    if (!confirm('이 로그인 계정의 연결을 해제할까요?\n회원과 기록은 그대로이며, 이 계정으로는 더 이상 이 회원으로 로그인되지 않습니다.')) return;
    await Api.unlinkAccount(el.dataset.id); render(); toast('연결을 해제했습니다.', 'ok');
  },
  async openNoti(el) {
    const link = el.dataset.link;
    try { await Api.markRead(el.dataset.id); } finally { go(link); }
  },
  async copyReport(el) {
    const text = activityReport(el.dataset.id);
    try { await navigator.clipboard.writeText(text); toast('활동 보고서를 클립보드에 복사했습니다.', 'ok'); }
    catch { prompt('아래 내용을 복사하세요', text); }
  },
};
const Changes = {
  submitForm(el) { el.form?.requestSubmit(); },
  pickVersion(el) { go(`#/p/${el.dataset.id}?v=${el.value}`); },
  edUpload(el) { const files = [...el.files]; el.value = ''; return editorAddFiles(files); },
  async setPerm(el) {
    try { await Api.setRolePermission(el.dataset.role, el.dataset.perm, el.checked); }
    catch (e) { el.checked = !el.checked; throw e; }
    render(); toast('권한을 바꿨습니다.', 'ok');
  },
  async toggleSession(el) {
    try {
      if (el.checked) await Api.linkProjectSession(el.dataset.pid, el.dataset.sid);
      else await Api.unlinkProjectSession(el.dataset.pid, el.dataset.sid);
    } catch (e) { el.checked = !el.checked; throw e; }
    render(); toast(el.checked ? '차시에 연결했습니다.' : '차시 연결을 해제했습니다.', 'ok');
  },
  async setGen(el) { await Api.setUserGeneration(el.dataset.id, el.value); toast('기수를 저장했습니다.', 'ok'); },
};
const Inputs = {
  edText(el) { const f = ui.editor.files.find((x) => x.path === ui.editor.current); if (f) f.content = el.value; },
  edMessage(el) { if (ui.editor) ui.editor.message = el.value; },
  draft(el) { if (ui.newDraft) ui.newDraft[el.name] = el.value; },
};
const Forms = {
  login(f, fd) { Api.login(fd.get('email'), fd.get('name')); go('#/'); },
  search(f, fd) {
    const params = new URLSearchParams();
    ['q', 'gen'].forEach((k) => { if (fd.get(k)) params.set(k, fd.get(k)); });
    const scope = fd.get('scope');
    if (scope === 'roots') params.set('roots', '1');
    if (scope === 'mine') params.set('mine', '1');
    go('#/' + (params.toString() ? '?' + params : ''));
  },
  async comment(f, fd) {
    await Api.addComment(f.dataset.version, f.dataset.path, f.dataset.line, fd.get('text'));
    go(f.dataset.back + '&line=' + f.dataset.line); toast('댓글을 남겼습니다.', 'ok');
  },
  compare(f, fd) { go(`#/p/${f.dataset.id}/compare?a=${fd.get('a')}&b=${fd.get('b')}`); },
  async createMR(f, fd) { await Api.createMergeRequest(f.dataset.id, fd.get('message')); render(); toast('반영 요청을 보냈습니다.', 'ok'); },
  async fork(f, fd) {
    const p = await Api.forkProject(f.dataset.id, { title: fd.get('title'), description: fd.get('description') });
    toast('수정본을 만들었습니다. 이제 자유롭게 고쳐 보세요!', 'ok'); go(`#/p/${p.id}`);
  },
  async forkRequest(f, fd) {
    await Api.requestFork(f.dataset.id, { title: fd.get('title'), message: fd.get('description') });
    toast('수정본 요청을 보냈습니다. 원작자가 승인하면 알림이 옵니다.', 'ok'); go(`#/p/${f.dataset.id}`);
  },
  async newProject(f, fd) {
    const p = await Api.createProject({ title: fd.get('title'), description: fd.get('description'), permission: fd.get('permission'),
      generation: fd.get('generation'), files: ui.editor.files });
    delete ui.editors.new; ui.editor = null; ui.newDraft = null;
    toast('업로드했습니다!', 'ok'); go(`#/p/${p.id}`);
  },
  async commit(f, fd) {
    const key = ui.editor.key;
    await Api.commitVersion(f.dataset.id, ui.editor.files, fd.get('message'));
    delete ui.editors[key]; ui.editor = null; toast('새 버전을 저장했습니다.', 'ok'); go(`#/p/${f.dataset.id}/versions`);
  },
  async appointRole(f, fd) {
    const role = f.dataset.role; const id = fd.get('member');
    if (!id) throw new Error('회원을 고르세요.');
    const t = Api.user(id); const label = ROLE_LABEL[role];
    const prev = role === 'president' || role === 'vice' ? Api.holdersOf(role).filter((h) => h.id !== id) : [];
    const msg = prev.length
      ? `기존 ${label} ${prev.map((h) => h.name).join(', ')}은(는) 일반 부원이 됩니다.${prev.some((h) => (h.roles || []).length > 1) ? '\n(그 사람의 다른 직책은 그대로 유지됩니다.)' : ''}\n\n새 ${label}: ${t.name}\n계속할까요?`
      : `${t.name} 님에게 ${label} 직책을 줄까요?`;
    if (!confirm(msg)) return;
    await Api.appointRole(id, role); render(); toast(`${label} 직책을 임명했습니다.`, 'ok');
  },
  async proposeTransfer(f, fd) {
    const id = fd.get('member'); if (!id) throw new Error('이양할 회원을 고르세요.');
    const t = Api.user(id);
    if (!confirm(`${t.name} 님에게 최고 관리자 이양을 제안할까요?\n상대방이 본인 계정으로 로그인해 수락해야 완료되며, 그 전에는 취소할 수 있습니다. 완료되면 나는 관리자로 남습니다.`)) return;
    await Api.proposeOwnerTransfer(id); render(); toast('이양을 제안했습니다. 상대방의 수락을 기다립니다.', 'ok');
  },
  async inviteAccount(f, fd) {
    if (!fd.get('member')) throw new Error('기존 회원을 고르세요.');
    await Api.inviteAccount(fd.get('member'), fd.get('email')); render(); toast('사전 등록했습니다. 그 이메일로 첫 로그인하면 기존 회원에 연결됩니다.', 'ok');
  },
  async linkAccount(f, fd) {
    const target = fd.get('target'); if (!target) throw new Error('연결할 기존 회원을 고르세요.');
    const t = Api.user(target); const pe = Api.user(f.dataset.id);
    if (!confirm(`${pe.name}(${pe.email}) 계정을 기존 회원 ${t.name}에 연결할까요?\n빈 대기 회원은 정리되며, 이후 이 계정으로 로그인하면 ${t.name} 회원으로 들어갑니다.`)) return;
    await Api.linkAccount(f.dataset.id, target); render(); toast('계정을 기존 회원에 연결했습니다.', 'ok');
  },
  async session(f, fd) {
    await Api.updateSession(f.dataset.id, { title: fd.get('title'), heldOn: fd.get('heldOn'), description: fd.get('description') });
    go(f.dataset.back); toast('차시 정보를 저장했습니다.', 'ok');
  },
  sessionSearch(f, fd) {
    const params = new URLSearchParams();
    ['q', 'author'].forEach((k) => { if (fd.get(k)) params.set(k, fd.get(k)); });
    go(f.dataset.base + (params.toString() ? '?' + params : ''));
  },
  async membership(f, fd) {
    await Api.upsertMembership(f.dataset.id, f.dataset.year, fd.get('generation'), fd.get('grade')); render(); toast('명단을 저장했습니다.', 'ok');
  },
  async membershipAdd(f, fd) {
    if (!fd.get('member')) throw new Error('추가할 회원을 고르세요.');
    await Api.upsertMembership(fd.get('member'), f.dataset.year, fd.get('generation'), fd.get('grade')); render(); toast('명단에 추가했습니다.', 'ok');
  },
  async approveUser(f, fd) { await Api.approveUser(f.dataset.id, fd.get('generation')); render(); toast('승인했습니다.', 'ok'); },
  async settings(f, fd) {
    await Api.updateSettings({ clubName: fd.get('clubName'), domain: fd.get('domain'), signupMode: fd.get('signupMode'),
      maxFileKB: fd.get('maxFileKB'), whitelist: String(fd.get('whitelist')).split(/\s+/) });
    render(); toast('설정을 저장했습니다.', 'ok');
  },
};

document.addEventListener('click', (e) => {
  // 바깥을 누르면 열린 드롭다운을 닫는다
  document.querySelectorAll('details.dropdown[open]').forEach((d) => { if (!d.contains(e.target)) d.removeAttribute('open'); });
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled || el.closest('.md')) return; // README 등 사용자 콘텐츠 안의 요소는 앱 동작을 실행하지 않음
  const fn = Actions[el.dataset.act]; if (!fn) return;
  e.preventDefault();
  el.closest('details')?.removeAttribute('open');
  safe(() => fn(el, e), el.dataset.act === 'stopPy' ? null : el);
});
document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-form]'); if (!f) return;
  e.preventDefault();
  safe(() => Forms[f.dataset.form](f, new FormData(f)), f); // 처리 중에는 버튼을 잠가 두 번 제출을 막는다
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]'); if (!el) return;
  safe(() => Changes[el.dataset.change](el));
});
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-input]'); if (!el) return;
  Inputs[el.dataset.input]?.(el);
});
let edTabEscape = false; // 편집기에서 Esc 를 누르면 다음 Tab 은 포커스 이동에 쓴다 (키보드 함정 방지)
document.addEventListener('keydown', (e) => {
  // "/" 로 어디서든 프로젝트 검색으로 이동 (입력 중일 때는 제외)
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && !e.target.isContentEditable && Api.me()) {
    e.preventDefault();
    const box = document.querySelector('input[name=q]');
    if (box) box.focus(); else { go('#/'); setTimeout(() => document.querySelector('input[name=q]')?.focus(), 60); }
    return;
  }
  if (e.key === 'Escape') {
    if (e.target.classList?.contains('ed-text')) { edTabEscape = true; return; }
    document.querySelectorAll('details.dropdown[open]').forEach((d) => { d.removeAttribute('open'); d.querySelector('summary')?.focus(); });
    if (document.body.classList.contains('nav-open')) {
      document.body.classList.remove('nav-open');
      const t = document.querySelector('.menu-toggle'); t?.setAttribute('aria-expanded', 'false'); t?.focus();
    }
    return;
  }
  if (e.key === 'Tab' && e.target.classList?.contains('ed-text')) {
    if (edTabEscape) { edTabEscape = false; return; }
    e.preventDefault();
    const t = e.target; const s = t.selectionStart;
    t.setRangeText('    ', s, t.selectionEnd, 'end');
    Inputs.edText(t);
  }
});
document.addEventListener('dragover', (e) => { if (e.target.closest?.('.editor')) { e.preventDefault(); e.target.closest('.editor').classList.add('drag'); } });
document.addEventListener('dragleave', (e) => { e.target.closest?.('.editor')?.classList.remove('drag'); });
document.addEventListener('drop', (e) => {
  const ed = e.target.closest?.('.editor'); if (!ed) return;
  e.preventDefault(); ed.classList.remove('drag');
  safe(() => editorAddFiles([...e.dataTransfer.files]));
});
// 화면이 바뀌면: 다시 그리고, 문서 제목을 맞추고, 스크린리더 사용자를 위해 본문으로 포커스를 옮긴다
window.addEventListener('hashchange', () => {
  render();
  document.getElementById('main')?.focus({ preventScroll: true });
});
// 모바일 메뉴의 링크를 누르면(같은 주소여도) 메뉴를 닫는다
document.addEventListener('click', (e) => {
  if (e.target.closest('.mobile-nav a')) {
    document.body.classList.remove('nav-open');
    document.querySelector('.menu-toggle')?.setAttribute('aria-expanded', 'false');
  }
});

/** 편집 중인 화면은 다시 그리지 않는다 (입력 위치·스크롤 보존) */
const isEditing = () => /^#\/(new|p\/[^/?]+\/edit)/.test(location.hash) || !!document.querySelector('.cmt-form');

if (Remote.enabled) {
  // 다른 부원이 바꾼 내용을 반영: 창으로 돌아올 때와 1분마다 다시 읽는다
  let lastRefresh = Date.now();
  const autoRefresh = () => {
    if (document.hidden || busy || Date.now() - lastRefresh < 15000) return;
    lastRefresh = Date.now();
    // 실패하면 Remote.failed 가 켜져 화면 위쪽에 비차단 안내가 뜬다
    Remote.refresh().then(() => { if (!isEditing()) render(); }).catch((e) => { console.error(e); if (!isEditing()) render(); });
  };
  document.addEventListener('visibilitychange', autoRefresh);
  setInterval(autoRefresh, 60000);
} else {
  // 데모 모드: 다른 탭에서 데이터가 바뀌면 다시 읽어 와 덮어쓰기를 막는다
  window.addEventListener('storage', (e) => {
    if (e.key !== STORE_KEY) return;
    const before = Api.me()?.id;
    Store.load();
    if (Api.me()?.id !== before) ui.editors = {};
    render();
  });
}

(async function boot() {
  if (!Remote.enabled) { Store.load(); render(); return; }
  $app().innerHTML = '<div class="boot" role="status"><span class="spinner" aria-hidden="true"></span>서버에 연결하는 중…</div>';
  try {
    await Remote.init();
    render();
  } catch (e) {
    console.error(e);
    ui.bootFailed = true; ui.bootError = e;
    renderBootFailure();   // 서버 상태 페이지(#/status)는 이 상태에서도 열린다
  }
})();
