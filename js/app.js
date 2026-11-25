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
const ROLE_LABEL = { member: '부원', admin: '운영진', teacher: '부장' };
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
const roleBadge = (u) => (u.role === 'member' ? '' : html`<span class="badge">${ROLE_LABEL[u.role]}</span>`);
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
  const u = Api.me();
  ui.after = [];
  document.body.classList.remove('nav-open');
  let body, parts = [];
  try {
    let q;
    try { ({ parts, q } = parseHash()); } catch { throw new Error('잘못된 주소입니다.'); }
    if (!u) body = viewLogin();
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
  const items = [['#/', '탐색', '', 'Compass'], ['#/archive', '기수 아카이브', 'archive', 'Layers'], ['#/me', '내 기여', 'me', 'User']];
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
            <div class="row" style="margin-top:6px">${roleBadge(u)}${u.generation ? html`<span class="badge">${u.generation}기</span>` : ''}</div></div>
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
  ${u.status === 'graduated' ? html`<div class="banner">${icon('Info', 15)}졸업생 계정입니다. 올린 프로젝트는 그대로 남아 있으며, 읽기만 가능합니다.</div>` : ''}
  <main id="main" tabindex="-1" class="container ${section === 'p' ? 'wide' : ''}">${body}</main>
  ${Remote.enabled
    ? html`<footer class="foot"><span class="status-dot" aria-hidden="true"></span>서버에 연결됨<span class="dot-sep"></span><button data-act="reloadData">새로 불러오기</button><span class="dot-sep"></span><a href="privacy.html">개인정보처리방침</a></footer>`
    : html`<footer class="foot">데모 모드 · 데이터는 이 브라우저에만 저장됩니다<span class="dot-sep"></span><button data-act="resetDemo">데모 데이터 초기화</button><span class="dot-sep"></span><a href="privacy.html">개인정보처리방침</a></footer>`}`;
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
    <br><a class="link" href="privacy.html">개인정보처리방침</a></p>`;
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
        ${demo.map((u) => html`<button class="demo-btn" data-act="quickLogin" data-email="${u.email}">${avatar(u)}<span class="n">${u.name}</span><span class="r">${ROLE_LABEL[u.role]} · ${STATUS_LABEL[u.status] || u.status}</span></button>`)}
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
const TABS = [['code', '코드', 'FileCode'], ['tree', '계보', 'GitBranch'], ['versions', '버전 기록', 'History'], ['compare', '비교', 'GitCompare'], ['merge', '반영 요청', 'GitPullRequest'], ['run', '실행', 'Play']];

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
  const body = { code: tabCode, tree: tabTree, versions: tabVersions, compare: tabCompare, merge: tabMerge, run: tabRun }[tab](p, q);
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
      <div class="meta">${userChip(owner)}<span>${genText(p.generation)}</span><span title="${PERM_DESC[p.permission]}">${icon(PERM_ICON[p.permission], 13)}${PERM_LABEL[p.permission]}</span><span>${fmtDate(p.createdAt).slice(0, 10)} 생성</span>${contributors.length ? html`<span>기여 ${contributors.map((c, i) => html`${i ? ', ' : ''}<a class="link" href="#/u/${c.userId}">${Api.user(c.userId).name}</a>`)}</span>` : ''}</div>
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
      <div class="meta" style="margin-top:4px">${mine || Api.isStaff(me) ? html`<span>${target.email}</span>` : ''}<span>${ROLE_LABEL[target.role]}</span>${target.generation ? html`<span>${target.generation}기</span>` : ''}${target.status !== 'active' ? html`<span>${STATUS_LABEL[target.status] || ''}</span>` : ''}</div>
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
function viewAdmin(q) {
  const u = Api.me();
  if (!Api.isStaff(u)) throw new Error('운영진만 볼 수 있습니다.');
  const users = Api.listUsers();
  const reports = Api.listReports();
  const pending = users.filter((x) => x.status === 'pending');
  const tab = q.tab || 'pending';
  const openReports = reports.filter((r) => r.status !== 'resolved').length;
  const T = [['pending', '가입 승인', pending.length], ['users', '부원', users.length - pending.length], ['reports', '신고', openReports], ['hidden', '숨김 프로젝트', null], ['settings', '설정', null]];
  const REPORT = { open: ['접수', 'badge-danger'], escalated: ['부장 판단 대기', 'badge-warn'], resolved: ['처리 완료', 'badge-muted'] };
  let body;
  if (tab === 'pending') {
    body = pending.length ? html`<div>${pending.map((x) => html`<div class="req">
      <div class="req-main"><div class="req-line">${userChip(x)}<span class="faint small">${x.email}</span></div><div class="meta" style="margin-top:4px"><span>${timeAgo(x.createdAt)} 요청</span></div></div>
      <form class="row" data-form="approveUser" data-id="${x.id}"><label><span class="sr-only">기수</span><input name="generation" type="number" min="1" placeholder="기수" style="width:84px;height:28px"></label>
        <button type="button" class="btn btn-sm" data-act="rejectUser" data-id="${x.id}">거절</button><button class="btn btn-sm btn-primary">승인</button></form></div>`)}</div>`
      : empty('승인을 기다리는 사람이 없습니다', '새로 가입한 학교 계정이 있으면 여기에 표시됩니다.');
  } else if (tab === 'users') {
    const teacher = Api.isTeacher(u);
    body = html`<div class="table-wrap"><table class="tbl"><thead><tr><th>이름</th><th>이메일</th><th>역할</th><th>기수</th><th>상태</th><th></th></tr></thead><tbody>
      ${users.filter((x) => x.status !== 'pending').map((x) => html`<tr>
        <td>${userChip(x)}</td><td class="muted">${x.email}</td>
        <td>${teacher && x.id !== u.id ? html`<label><span class="sr-only">${x.name} 역할</span><select data-change="setRole" data-id="${x.id}" style="width:auto">${Object.entries(ROLE_LABEL).map(([k, v]) => html`<option value="${k}" ${x.role === k ? raw('selected') : ''}>${v}</option>`)}</select></label>` : ROLE_LABEL[x.role]}</td>
        <td><label><span class="sr-only">${x.name} 기수</span><input type="number" min="1" value="${x.generation ?? ''}" data-change="setGen" data-id="${x.id}" style="width:72px"></label></td>
        <td>${x.status === 'active' ? html`<span class="badge badge-ok">활동</span>` : html`<span class="badge badge-muted">${STATUS_LABEL[x.status]}</span>`}</td>
        <td style="text-align:right">${x.id !== u.id && (x.role !== 'teacher' || teacher) ? (x.status === 'active'
          ? html`<button class="btn btn-sm btn-tertiary" data-act="setStatus" data-id="${x.id}" data-v="graduated">졸업 처리</button>`
          : html`<button class="btn btn-sm btn-tertiary" data-act="setStatus" data-id="${x.id}" data-v="active">활동으로 복귀</button>`) : ''}</td></tr>`)}
      </tbody></table></div>
      <p class="faint xs" style="margin-top:12px">역할 변경은 부장만 할 수 있습니다. 졸업 처리해도 올린 프로젝트와 출처 표기는 그대로 남습니다.</p>`;
  } else if (tab === 'reports') {
    body = reports.length ? html`<div>${reports.map((r) => html`<div class="req"><div class="req-main">
      <div class="req-line"><span class="badge ${REPORT[r.status][1]}">${REPORT[r.status][0]}</span>${projLink(Api.rawProject(r.projectId))}</div>
      <div class="req-msg">${r.reason}</div>
      <div class="meta" style="margin-top:6px"><span>신고자 ${Api.user(r.reporterId).name}</span><span>${timeAgo(r.createdAt)}</span>${r.action ? html`<span>결과: ${r.action === 'hide' ? '숨김' : '문제없음'}</span>` : ''}</div></div>
      ${r.status !== 'resolved' && (r.status === 'open' || Api.isTeacher(u)) ? html`<div class="row-end">
        ${!Api.isTeacher(u) ? html`<button class="btn btn-sm btn-tertiary" data-act="report2" data-id="${r.id}" data-v="escalate">부장에게 넘기기</button>` : ''}
        <button class="btn btn-sm" data-act="report2" data-id="${r.id}" data-v="dismiss">문제없음</button>
        <button class="btn btn-sm btn-danger" data-act="report2" data-id="${r.id}" data-v="hide">${icon('EyeOff', 14)}숨김 처리</button></div>` : ''}</div>`)}</div>`
      : empty('접수된 신고가 없습니다');
  } else if (tab === 'hidden') {
    const hp = Api.hiddenProjects();
    body = hp.length ? html`<div>${hp.map((p) => html`<div class="req"><div class="req-main"><div class="req-line">${projLink(p)}<span class="faint small">${p.ownerId ? Api.user(p.ownerId).name : ''}</span></div></div>
      <button class="btn btn-sm" data-act="hide" data-id="${p.id}" data-v="0">${icon('Eye', 14)}숨김 해제</button></div>`)}</div>` : empty('숨김 처리된 프로젝트가 없습니다');
  } else {
    const s = Api.settings();
    const teacher = Api.isTeacher(u);
    body = html`<form data-form="settings" class="stack narrow">
      <label class="field"><span>동아리 이름</span><input name="clubName" value="${s.clubName}" maxlength="40"></label>
      <label class="field"><span>허용 학교 도메인</span><input name="domain" value="${s.domain}" ${teacher ? '' : raw('readonly')}><span class="hint">이 도메인의 Google 계정만 가입할 수 있습니다. 서버에서도 다시 검사합니다.${teacher ? '' : ' 부장만 바꿀 수 있습니다.'}</span></label>
      <fieldset ${teacher ? '' : raw('disabled')}><legend>가입 방식</legend><div class="choice-list">
        <label class="choice"><input type="radio" name="signupMode" value="approval" ${s.signupMode === 'approval' ? raw('checked') : ''}><div><b>운영진 승인</b><span>학교 계정으로 로그인하면 승인 대기 상태가 되고, 운영진이 승인합니다. 명단에 있는 이메일은 바로 가입됩니다.</span></div></label>
        <label class="choice"><input type="radio" name="signupMode" value="whitelist" ${s.signupMode === 'whitelist' ? raw('checked') : ''}><div><b>부원 명단만</b><span>아래 명단에 있는 이메일만 가입할 수 있습니다.</span></div></label>
      </div></fieldset>
      <label class="field"><span>부원 이메일 명단</span><textarea name="whitelist" rows="5" placeholder="한 줄에 하나씩">${s.whitelist.join('\n')}</textarea><span class="hint">한 줄에 이메일 하나씩 적습니다.</span></label>
      <label class="field" style="max-width:320px"><span>파일당 용량 제한 (KB)</span><input name="maxFileKB" type="number" min="1" max="10240" value="${s.maxFileKB}"><span class="hint">1~10240KB(10MB). 프로젝트 하나의 전체 크기는 10MB까지입니다.</span></label>
      <div class="form-footer" style="justify-content:flex-start"><button class="btn btn-primary">설정 저장</button></div></form>`;
  }
  return html`
  ${pageHeader('관리')}
  <nav class="tabs" aria-label="관리 메뉴">${T.map(([k, label, n]) => html`<a href="#/admin?tab=${k}" class="${k === tab ? 'on' : ''}" ${k === tab ? raw('aria-current="page"') : ''}>${label}${n ? html`<span class="counter ${k === 'pending' || k === 'reports' ? 'counter-accent' : ''}">${n}</span>` : ''}</a>`)}</nav>
  <section>${body}</section>`;
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
const resetUi = () => { ui.editors = {}; ui.editor = null; ui.newDraft = null; };
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
  async setRole(el) { await Api.setUserRole(el.dataset.id, el.value); render(); toast('역할을 바꿨습니다.', 'ok'); },
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
    Remote.refresh().then(() => { if (!isEditing()) render(); }).catch(console.error);
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
    $app().innerHTML = html`<main class="auth-wrap"><div class="auth"><div class="auth-box">
      <h1>서버에 연결하지 못했습니다</h1>
      <p>${e.message}</p><p class="auth-foot">js/config.js 의 Supabase 주소·키와 SETUP.md 의 설정을 확인하세요.</p>
      <button class="btn" style="margin-top:16px" onclick="location.reload()">다시 시도</button></div></div></main>`.s;
  }
})();
