'use strict';
/* ===== 데이터 계층 =====
 * 프로토타입은 브라우저 localStorage에 저장한다.
 * Api 객체는 "서버" 역할을 흉내 내며, 모든 권한 검사를 여기서 다시 한다.
 * 나중에 Supabase로 옮길 때는 Api 함수의 내부만 바꾸면 화면 코드는 그대로 쓸 수 있다.
 */
const SCHEMA = 2;
/** 직책 정의 (서버 schema.sql 의 roles 표와 같은 값). 부원은 직책이 하나도 없는 상태 */
const ROLE_DEFS = [
  { code: 'owner', label: '최고 관리자' }, { code: 'admin', label: '관리자' }, { code: 'president', label: '부장' },
  { code: 'vice', label: '차장' }, { code: 'server', label: '서버 관리자' },
];
/** 위임·세부 권한 목록 (서버 role_permissions 의 허용 목록과 같음) */
const PERM_ALLOWED = { server: ['server.detail', 'server.backup', 'server.errors'], president: ['accounts.link'], vice: ['accounts.link'] };
const PERM_NAME = { 'server.detail': '서버·DB 상세 상태 보기', 'server.backup': '백업 상태 보기', 'server.errors': '최근 오류 기록 보기', 'accounts.link': '계정 연결·병합 처리' };
/** 운영 연도: N년 3월 1일 ~ N+1년 2월 말일 (한국 시간). 서버 private.year_of 와 같은 규칙 */
function operatingYear(ts = Date.now()) {
  const k = new Date(new Date(ts).getTime() + 9 * 3600 * 1000);
  return k.getUTCMonth() >= 2 ? k.getUTCFullYear() : k.getUTCFullYear() - 1;
}
const yearBounds = (y) => ({ startsOn: `${y}-03-01`, endsOn: new Date(Date.UTC(y + 1, 2, 0)).toISOString().slice(0, 10) });
/** 새로 추가된 표들을 빈 상태로 채운다 */
function ensureV2Tables(db) {
  for (const k of ['accounts', 'invites', 'rolePerms', 'ownerTransfers', 'auditLogs', 'years', 'sessions', 'membership', 'projectSessions']) if (!Array.isArray(db[k])) db[k] = [];
  if (!db.rolePerms.length) {
    for (const [role, perms] of Object.entries(PERM_ALLOWED)) perms.forEach((perm) => db.rolePerms.push({ role, perm, enabled: role === 'server' }));
  }
  return db;
}
/** 예전(v1) 브라우저 데이터를 지우지 않고 새 구조로 옮긴다: teacher → 최고 관리자+관리자, admin → 차장 */
function migrateV1(db) {
  [...db.users].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).forEach((u, i) => {
    u.roles = u.role === 'teacher' ? ['owner', 'admin'] : u.role === 'admin' ? ['vice'] : [];
    u.role = 'member';
    u.memberNo = 'POP-' + String(i + 1).padStart(4, '0');
  });
  db.projects.forEach((p) => { p.year = operatingYear(new Date(p.createdAt).getTime()); });
  db.accounts = db.users.map((u) => ({ authId: 'au_' + u.id, memberId: u.id, email: u.email, status: 'active', linkedAt: u.createdAt }));
  ensureV2Tables(db);
  db.schema = 2;
  return db;
}
/** 프로젝트 하나의 전체 크기 한도 (서버 schema.sql 의 validate_files 와 같은 값) */
const PROJECT_LIMIT = 10 * 1024 * 1024;
const STORE_KEY = 'clubrepo.db.v1';

const Store = (() => {
  let db = null;
  function load() {
    try { db = JSON.parse(localStorage.getItem(STORE_KEY)); } catch { db = null; }
    if (db && db.schema === 1) { try { db = migrateV1(db); save(); } catch { db = null; } }
    if (!db || db.schema !== SCHEMA) { db = makeSeed(); save(); }
    ensureV2Tables(db);
    try { Api.ensureAcademicYear(); } catch (e) { console.warn('운영 연도 준비 실패', e); }   // 현재 운영 연도·차시를 만든다 (몇 번 불러도 같은 결과)
    return db;
  }
  function save() {
    if (Store.remote) return; // 서버 모드: 쓰기는 RPC가 하고, 캐시는 Remote.refresh() 가 채운다
    try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); }
    catch (e) {
      // 저장 실패 시 메모리 변경을 버리고 마지막으로 저장된 상태로 되돌린다
      db = JSON.parse(localStorage.getItem(STORE_KEY)) || makeSeed();
      throw new Error('브라우저 저장 공간이 부족해 저장하지 못했습니다. 큰 파일을 줄이거나 데모 데이터를 초기화하세요.');
    }
  }
  function reset() { localStorage.removeItem(STORE_KEY); load(); }
  function replace(next) { db = next; }
  return { load, save, reset, replace, remote: false, get db() { return db; } };
})();

class ApiError extends Error {}

const Api = (() => {
  const D = () => Store.db;
  const fail = (m) => { throw new ApiError(m); };
  const now = () => new Date().toISOString();
  const find = (table, id) => D()[table].find((x) => x.id === id);

  /* ---------- 세션·권한 ---------- */
  function me() { const id = D().session.userId; return id ? find('users', id) || null : null; }
  // 직책은 여러 개를 함께 가질 수 있고 권한은 합산된다 (서버 private.has_role / is_admin / is_staff 와 같은 규칙)
  const hasRole = (u, code) => !!u && u.status === 'active' && Array.isArray(u.roles) && u.roles.includes(code);
  const isOwner = (u) => hasRole(u, 'owner');
  const isAdmin = (u) => hasRole(u, 'owner') || hasRole(u, 'admin');
  const isStaff = (u) => ['owner', 'admin', 'president', 'vice'].some((c) => hasRole(u, c));
  const hasPerm = (u, perm) => isAdmin(u) || (!!u && u.status === 'active' && (u.roles || []).some((r) => (D().rolePerms || []).some((p) => p.role === r && p.perm === perm && p.enabled)));
  const roleLabel = (code) => (ROLE_DEFS.find((r) => r.code === code) || { label: code }).label;
  function audit(action, target, detail) {
    const cur = me();
    D().auditLogs.push({ id: uid('a'), at: now(), actor: cur ? cur.id : null, action, target: target || null, detail: detail || {} });
  }
  const isLastAdmin = (id) => isAdmin(find('users', id)) && !D().users.some((x) => x.id !== id && isAdmin(x));
  function requireReader() {
    const u = me();
    if (!u) fail('로그인이 필요합니다.');
    if (u.status === 'pending') fail('가입 승인 대기 중입니다.');
    if (u.status !== 'active' && u.status !== 'graduated') fail('접근할 수 없는 계정입니다.');
    return u;
  }
  function requireActive() {
    const u = requireReader();
    if (u.status === 'graduated') fail('졸업생 계정은 읽기 전용입니다.');
    return u;
  }
  function requireStaff() { const u = requireActive(); if (!isStaff(u)) fail('운영진 권한이 필요합니다.'); return u; }
  function requireAdmin() { const u = requireActive(); if (!isAdmin(u)) fail('관리자 권한이 필요합니다.'); return u; }
  function requireAccountManager() { const u = requireActive(); if (!hasPerm(u, 'accounts.link')) fail('계정 연결 권한이 필요합니다.'); return u; }

  /* ---------- 알림 ---------- */
  function notify(userId, text, link) {
    if (!userId) return;
    const cur = me();
    if (cur && cur.id === userId) return;
    D().notifications.push({ id: uid('n'), userId, text, link, read: false, createdAt: now() });
  }
  function notifyStaff(text, link) { D().users.filter(isStaff).forEach((u) => notify(u.id, text, link)); }

  /* ---------- 로그인 ---------- */
  function login(email, name) {
    email = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('올바른 이메일 형식이 아닙니다.');
    const domain = D().settings.domain.toLowerCase();
    // 서버 측 도메인 재검사 (클라이언트 검사를 믿지 않음)
    if (!email.endsWith('@' + domain)) fail(`학교 계정(@${domain})으로만 로그인할 수 있습니다.`);
    const acc = D().accounts.find((a) => a.email === email && a.status === 'active');
    let u = acc ? find('users', acc.memberId) : null;
    if (!u) {
      const inv = D().invites.find((i) => i.email === email);
      if (inv) {
        // 사전 등록된 이메일: 새 회원을 만들지 않고 기존 회원에 연결 (이름이 같다는 이유로는 합치지 않는다)
        u = find('users', inv.memberId);
        D().accounts.push({ authId: uid('au'), memberId: u.id, email, status: 'active', linkedAt: now(), linkedBy: inv.createdBy });
        D().invites = D().invites.filter((i) => i !== inv);
        D().auditLogs.push({ id: uid('a'), at: now(), actor: null, action: 'account.linked', target: u.id, detail: { email, via: 'invite' } });
      } else {
        name = String(name || '').trim();
        if (!name) fail('처음 로그인할 때는 이름을 입력해 주세요.');
        const listed = D().settings.whitelist.map((e) => e.toLowerCase()).includes(email);
        if (D().settings.signupMode === 'whitelist' && !listed) fail('부원 명단에 없는 계정입니다. 운영진에게 등록을 요청하세요.');
        const no = 'POP-' + String(D().users.length + 1).padStart(4, '0');
        u = { id: uid('u'), email, name, role: 'member', roles: [], memberNo: no, status: listed ? 'active' : 'pending', generation: null, createdAt: now() };
        D().users.push(u);
        D().accounts.push({ authId: uid('au'), memberId: u.id, email, status: 'active', linkedAt: now() });
        if (u.status === 'active') touchMembership(u);
        if (u.status === 'pending') notifyStaff(`${name}(${email}) 님이 가입 승인을 기다립니다.`, '#/admin?tab=pending');
      }
    }
    D().session.userId = u.id;
    Store.save();
    return u;
  }
  /** 현재 운영 연도 명단에 회원 한 명을 넣는다 (이미 있으면 그대로) */
  function touchMembership(u) {
    const cur = (D().years || []).find((y) => y.status === 'current');
    if (!cur || D().membership.some((m) => m.memberId === u.id && m.year === cur.year)) return;
    D().membership.push({ memberId: u.id, year: cur.year, generation: u.generation ?? null, grade: null, roles: [...(u.roles || [])], status: 'active' });
  }
  function logout() { D().session.userId = null; Store.save(); }

  /* ---------- 사용자 ---------- */
  function user(id) { return find('users', id) || { id, name: '(알 수 없음)', role: 'member', roles: [], status: 'deleted' }; }
  function listUsers() { requireStaff(); return [...D().users].sort((a, b) => a.name.localeCompare(b.name)); }
  function approveUser(id, generation) {
    requireStaff(); const u = find('users', id) || fail('사용자가 없습니다.');
    if (u.status !== 'pending') fail('승인 대기 중인 사용자가 아닙니다.');
    u.status = 'active'; if (generation) u.generation = Number(generation);
    touchMembership(u);
    audit('member.approved', u.id, { generation: generation ? Number(generation) : null });
    notify(u.id, '가입이 승인되었습니다. 환영합니다!', '#/');
    Store.save();
  }
  function rejectUser(id) {
    requireStaff(); const u = find('users', id) || fail('사용자가 없습니다.');
    if (u.status !== 'pending') fail('승인 대기 중인 사용자만 거절할 수 있습니다.');
    audit('member.rejected', null, { member: id, member_no: u.memberNo, name: u.name });
    D().users = D().users.filter((x) => x.id !== id);
    D().accounts = D().accounts.filter((a) => a.memberId !== id);
    Store.save();
  }
  function setUserStatus(id, status) {
    const cur = requireStaff(); const u = find('users', id) || fail('사용자가 없습니다.');
    if (!['active', 'graduated'].includes(status)) fail('잘못된 상태입니다.');
    if (u.status === 'pending') fail('승인 대기 중인 사용자는 먼저 승인하세요.');
    if (u.id === cur.id) fail('자기 자신의 상태는 바꿀 수 없습니다.');
    if (status === 'graduated' && isLastAdmin(id)) fail('마지막 관리자는 졸업 처리할 수 없습니다.');
    if ((u.roles || []).some((r) => r === 'owner' || r === 'admin') && !isAdmin(cur)) fail('관리자 계정은 관리자만 바꿀 수 있습니다.');
    const from = u.status;
    u.status = status;
    if (status === 'active') touchMembership(u);
    audit('member.status', u.id, { from, to: status });
    Store.save();
  }
  function setUserGeneration(id, gen) {
    requireStaff(); const u = find('users', id) || fail('사용자가 없습니다.');
    u.generation = gen ? Number(gen) : null; Store.save();
  }

  /* ---------- 설정 ---------- */
  function settings() { return D().settings; }
  function updateSettings(patch) {
    const cur = requireStaff();
    const s = D().settings;
    // 가입 보안의 핵심인 도메인·가입 방식은 관리자만 바꾼다
    const changing = (patch.domain != null && String(patch.domain).trim().toLowerCase().replace(/^@/, '') !== s.domain)
      || (patch.signupMode != null && patch.signupMode !== s.signupMode);
    if (changing && !isAdmin(cur)) fail('학교 도메인과 가입 방식은 관리자만 바꿀 수 있습니다.');
    if (patch.clubName != null) s.clubName = String(patch.clubName).trim() || s.clubName;
    if (patch.domain != null) {
      const d = String(patch.domain).trim().toLowerCase().replace(/^@/, '');
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) fail('도메인 형식이 올바르지 않습니다.');
      s.domain = d;
    }
    if (patch.signupMode != null) { if (!['approval', 'whitelist'].includes(patch.signupMode)) fail('잘못된 가입 방식'); s.signupMode = patch.signupMode; }
    if (patch.maxFileKB != null) { const n = Number(patch.maxFileKB); if (!(n >= 1 && n <= 10240)) fail('파일 용량 제한은 1~10240KB(10MB) 사이로 정하세요.'); s.maxFileKB = n; }
    if (patch.whitelist != null) s.whitelist = patch.whitelist.map((e) => e.trim().toLowerCase()).filter(Boolean);
    audit('settings.updated', null, Object.fromEntries(Object.entries({ club_name: patch.clubName, domain: patch.domain, signup_mode: patch.signupMode, max_file_kb: patch.maxFileKB, whitelist_count: patch.whitelist ? patch.whitelist.length : null }).filter(([, v]) => v != null && v !== '')));
    Store.save();
  }

  /* ---------- 프로젝트 조회 ---------- */
  function rawProject(id) { return find('projects', id) || null; }
  function canSee(p, u = me()) { return !!p && (!p.hidden || isStaff(u)); }
  function getProject(id) {
    requireReader();
    const p = rawProject(id) || fail('프로젝트를 찾을 수 없습니다.');
    if (!canSee(p)) fail('운영진이 숨김 처리한 프로젝트입니다.');
    return p;
  }
  function listProjects({ q = '', gen = '', rootsOnly = false } = {}) {
    requireReader();
    const kw = q.trim().toLowerCase();
    return D().projects
      .filter((p) => !p.deleted && canSee(p))
      .filter((p) => !rootsOnly || !p.parentId)
      .filter((p) => !gen || String(p.generation) === String(gen))
      .filter((p) => !kw || (p.title + ' ' + p.description + ' ' + user(p.ownerId).name).toLowerCase().includes(kw))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  function generations() {
    return [...new Set(D().projects.filter((p) => !p.deleted && canSee(p) && p.generation != null).map((p) => p.generation))].sort((a, b) => b - a);
  }
  function childrenOf(id) { return D().projects.filter((p) => p.parentId === id && !p.deleted && canSee(p)); }
  /** 트리 전체. 숨김 프로젝트는 일반 부원에게 제목·작성자 없이 자리만 돌려준다 */
  function treeOf(rootId) {
    requireReader();
    return D().projects.filter((p) => p.rootId === rootId)
      .map((p) => (canSee(p) ? p : { id: p.id, parentId: p.parentId, rootId: p.rootId, hidden: true, title: '', ownerId: null, createdAt: p.createdAt }));
  }
  function descendants(id) {
    const out = []; const stack = [id];
    while (stack.length) { const cur = stack.pop(); D().projects.filter((p) => p.parentId === cur).forEach((c) => { out.push(c); stack.push(c.id); }); }
    return out;
  }
  function lineage(p) { const out = []; let cur = p; while (cur && cur.parentId) { cur = rawProject(cur.parentId); if (cur) out.push(cur); } return out; }
  function contributors(projectId) { requireReader(); return D().contributors.filter((c) => c.projectId === projectId); }

  /* ---------- 버전 ---------- */
  function versionsOf(projectId) {
    requireReader();
    const p = rawProject(projectId);
    if (!canSee(p) || (p.deleted && !isStaff(me()))) return [];
    return D().versions.filter((v) => v.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  function getVersion(id) {
    requireReader();
    const v = find('versions', id) || fail('버전을 찾을 수 없습니다.');
    const p = rawProject(v.projectId);
    if (!canSee(p)) fail('숨김 처리된 프로젝트입니다.');
    if (p.deleted && !isStaff(me())) fail('삭제된 프로젝트의 코드는 볼 수 없습니다.');
    return v;
  }
  function headOf(p) { return p.headVersionId ? getVersion(p.headVersionId) : null; }
  function versionNumber(v) {
    const list = D().versions.filter((x) => x.projectId === v.projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return list.length - list.findIndex((x) => x.id === v.id);
  }

  function validateFiles(files) {
    if (!Array.isArray(files) || !files.length) fail('파일이 하나도 없습니다.');
    const seen = new Set();
    const limit = D().settings.maxFileKB * 1024;
    let total = 0;
    for (const f of files) {
      const p = normalizePath(f.path);
      if (!p || p !== f.path) fail(`잘못된 파일 경로: ${f.path}`);
      if (seen.has(p)) fail(`같은 경로의 파일이 두 개 있습니다: ${p}`);
      seen.add(p);
      const size = byteSize(f.content);
      if (size > limit) fail(`${p} 파일이 용량 제한(${D().settings.maxFileKB}KB)을 넘습니다.`);
      total += size;
    }
    for (const p of seen) {
      let d = dirName(p);
      while (d) { if (seen.has(d)) fail(`파일과 폴더 이름이 겹칩니다: ${d}`); d = dirName(d); }
    }
    if (total > PROJECT_LIMIT) fail('프로젝트 전체 크기가 10MB를 넘습니다.');
    if (!files.some((f) => /^readme\.md$/i.test(f.path))) fail('README.md 파일이 필요합니다. (프로젝트 설명·실행 방법)');
  }
  function addVersion(p, authorId, files, message, extra = {}) {
    const v = { id: uid('v'), projectId: p.id, message, authorId, createdAt: now(), files: files.map((f) => ({ path: f.path, content: f.content })), ...extra };
    D().versions.push(v);
    p.headVersionId = v.id; p.updatedAt = v.createdAt;
    return v;
  }

  /* ---------- 프로젝트 생성·수정 ---------- */
  const PERMS = ['free', 'approval', 'view'];
  function createProject({ title, description, permission, generation, files, message }) {
    const u = requireActive();
    title = String(title || '').trim(); if (!title) fail('제목을 입력하세요.');
    if (!PERMS.includes(permission)) fail('수정 허용 범위를 선택하세요.');
    validateFiles(files);
    const t = now();
    const p = { id: uid('p'), title, description: String(description || '').trim(), ownerId: u.id, parentId: null, rootId: null,
      permission, generation: generation ? Number(generation) : u.generation, year: operatingYear(), createdAt: t, updatedAt: t, deleted: false, hidden: false, headVersionId: null };
    p.rootId = p.id;
    D().projects.push(p);
    addVersion(p, u.id, files, String(message || '').trim() || '처음 업로드');
    Store.save();
    return p;
  }
  function updateProjectInfo(id, { title, description, permission, generation }) {
    const u = requireActive(); const p = getProject(id);
    if (p.deleted) fail('삭제된 프로젝트입니다.');
    // 기수(아카이브 분류)는 운영진도 바꿀 수 있다
    if (generation !== undefined) {
      if (p.ownerId !== u.id && !isStaff(u)) fail('작성자 또는 운영진만 기수를 바꿀 수 있습니다.');
      const g = generation === '' || generation == null ? null : Number(generation);
      if (g != null && !(Number.isInteger(g) && g > 0)) fail('기수는 1 이상의 숫자로 입력하세요.');
      p.generation = g;
    }
    if (title == null && description == null && permission == null) { Store.save(); return; }
    if (p.ownerId !== u.id) fail('작성자만 수정할 수 있습니다.');
    if (title != null) { title = title.trim(); if (!title) fail('제목을 입력하세요.'); p.title = title; }
    if (description != null) p.description = description.trim();
    if (permission != null) { if (!PERMS.includes(permission)) fail('잘못된 허용 범위'); p.permission = permission; }
    Store.save();
  }
  function commitVersion(projectId, files, message) {
    const u = requireActive(); const p = getProject(projectId);
    if (p.deleted) fail('삭제된 프로젝트입니다.');
    if (p.ownerId !== u.id) fail('작성자만 새 버전을 올릴 수 있습니다. 다른 사람의 프로젝트는 [수정본 만들기]를 이용하세요.');
    message = String(message || '').trim(); if (!message) fail('변경 설명을 입력하세요.');
    validateFiles(files);
    if (sameFileSet(headOf(p).files, files)) fail('바뀐 내용이 없습니다.');
    const v = addVersion(p, u.id, files, message);
    Store.save();
    return v;
  }

  /* ---------- 수정본(포크) ---------- */
  /** 수정본 생성 가능 여부: {ok, needsApproval, reason} */
  function forkCheck(p, u = me()) {
    if (!u || u.status !== 'active') return { ok: false, reason: '활동 중인 부원만 수정본을 만들 수 있습니다.' };
    if (p.deleted) return { ok: false, reason: '삭제된 프로젝트입니다.' };
    if (p.ownerId === u.id) return { ok: false, reason: '내 프로젝트는 [편집]으로 새 버전을 올리세요.' };
    if (p.permission === 'view') return { ok: false, reason: '원작자가 "보기만 가능"으로 설정했습니다.' };
    if (p.permission === 'approval') return { ok: true, needsApproval: true };
    return { ok: true, needsApproval: false };
  }
  function doFork(src, owner, title, description) {
    const t = now();
    const p = { id: uid('p'), title: String(title || '').trim() || `${src.title} 수정본`, description: String(description || '').trim(),
      ownerId: owner.id, parentId: src.id, rootId: src.rootId, permission: 'free', generation: owner.generation, year: operatingYear(),
      createdAt: t, updatedAt: t, deleted: false, hidden: false, headVersionId: null };
    D().projects.push(p);
    const head = find('versions', src.headVersionId);
    addVersion(p, owner.id, head.files, `「${src.title}」에서 수정본 생성`, { forkedFromVersionId: head.id });
    notify(src.ownerId, `${owner.name} 님이 「${src.title}」의 수정본 「${p.title}」을 만들었습니다.`, `#/p/${p.id}`);
    const root = rawProject(src.rootId);
    if (root && root.ownerId !== src.ownerId) notify(root.ownerId, `내 원본 「${root.title}」 트리에 새 수정본 「${p.title}」이 생겼습니다.`, `#/p/${p.id}/tree`);
    return p;
  }
  function forkProject(id, { title, description }) {
    const u = requireActive(); const src = getProject(id);
    const c = forkCheck(src, u);
    if (!c.ok) fail(c.reason);
    if (c.needsApproval) fail('원작자 승인이 필요한 프로젝트입니다. 수정본 요청을 보내세요.');
    const p = doFork(src, u, title, description);
    Store.save();
    return p;
  }
  /** 원작자가 졸업생이면 운영진이 대신 처리할 수 있다 */
  function canResolveFor(p, u = me()) {
    if (!u || u.status !== 'active') return false;
    if (p.ownerId === u.id) return true;
    return isStaff(u) && user(p.ownerId).status !== 'active';
  }
  function requestFork(id, { title, message }) {
    const u = requireActive(); const src = getProject(id);
    const c = forkCheck(src, u);
    if (!c.ok) fail(c.reason);
    if (!c.needsApproval) fail('승인 없이 바로 수정본을 만들 수 있는 프로젝트입니다.');
    if (D().forkRequests.some((r) => r.projectId === id && r.requesterId === u.id && r.status === 'pending')) fail('이미 보낸 요청이 대기 중입니다.');
    const r = { id: uid('fr'), projectId: id, requesterId: u.id, title: String(title || '').trim(), message: String(message || '').trim(), status: 'pending', createdAt: now() };
    D().forkRequests.push(r);
    notify(src.ownerId, `${u.name} 님이 「${src.title}」의 수정본 만들기를 요청했습니다.`, `#/p/${id}/merge`);
    if (user(src.ownerId).status !== 'active') notifyStaff(`졸업생 프로젝트 「${src.title}」에 수정본 요청이 왔습니다.`, `#/p/${id}/merge`);
    Store.save();
  }
  function forkRequestsFor(projectId) { requireReader(); if (!canSee(rawProject(projectId))) return []; return D().forkRequests.filter((r) => r.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  function resolveForkRequest(id, approve) {
    requireActive();
    const r = find('forkRequests', id) || fail('요청이 없습니다.');
    if (r.status !== 'pending') fail('이미 처리된 요청입니다.');
    const src = getProject(r.projectId);
    if (!canResolveFor(src)) fail('원작자만 처리할 수 있습니다.');
    if (approve && (src.deleted || src.permission === 'view')) fail('지금은 수정본을 만들 수 없는 상태입니다(삭제 또는 보기만 가능).');
    if (approve) {
      const requester = find('users', r.requesterId);
      if (!requester || requester.status !== 'active') fail('요청한 부원이 활동 중이 아닙니다.');
      const p = doFork(src, requester, r.title, r.message);
      r.status = 'approved'; r.forkId = p.id;
      notify(requester.id, `「${src.title}」 수정본 요청이 승인되어 「${p.title}」이 만들어졌습니다.`, `#/p/${p.id}`);
    } else {
      r.status = 'rejected';
      notify(r.requesterId, `「${src.title}」 수정본 요청이 거절되었습니다.`, `#/p/${src.id}`);
    }
    r.resolvedAt = now();
    Store.save();
  }

  /* ---------- 삭제·숨김 ---------- */
  function deleteProject(id) {
    const u = requireActive(); const p = getProject(id);
    if (p.ownerId !== u.id && !isStaff(u)) fail('작성자 또는 운영진만 삭제할 수 있습니다.');
    if (p.deleted) fail('이미 삭제된 프로젝트입니다.');
    p.deleted = true; p.deletedAt = now(); p.deletedBy = u.id;
    if (p.ownerId !== u.id) audit('project.deleted', p.ownerId, { project: id, title: p.title });
    D().mergeRequests.filter((m) => m.status === 'pending' && (m.fromProjectId === id || m.toProjectId === id)).forEach((m) => { m.status = 'closed'; });
    D().forkRequests.filter((r) => r.status === 'pending' && r.projectId === id).forEach((r) => { r.status = 'closed'; });
    childrenOf(id).forEach((c) => notify(c.ownerId, `「${c.title}」의 원본 「${p.title}」이 삭제되었습니다. 내 수정본은 그대로 남습니다.`, `#/p/${c.id}`));
    Store.save();
  }
  function setHidden(id, hidden, withDescendants = false) {
    requireStaff(); const p = rawProject(id) || fail('프로젝트가 없습니다.');
    const targets = [p, ...(withDescendants ? descendants(id) : [])];
    targets.forEach((x) => { x.hidden = !!hidden; });
    audit(hidden ? 'project.hidden' : 'project.unhidden', p.ownerId, { project: id, count: targets.length, with_descendants: !!withDescendants });
    Store.save();
    return targets.length;
  }

  /* ---------- 반영 요청 ---------- */
  const mrVisible = (m) => canSee(rawProject(m.fromProjectId)) && canSee(rawProject(m.toProjectId));
  function mergeRequestsTo(id) { requireReader(); return D().mergeRequests.filter((m) => m.toProjectId === id && mrVisible(m)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  function mergeRequestsFrom(id) { requireReader(); return D().mergeRequests.filter((m) => m.fromProjectId === id && mrVisible(m)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  function createMergeRequest(fromId, message) {
    const u = requireActive(); const from = getProject(fromId);
    if (from.ownerId !== u.id) fail('수정본 작성자만 반영 요청을 보낼 수 있습니다.');
    if (from.deleted) fail('삭제된 프로젝트입니다.');
    const to = from.parentId ? rawProject(from.parentId) : null;
    if (!to) fail('원본이 없는 프로젝트입니다.');
    if (to.deleted) fail('원본이 삭제되어 반영 요청을 보낼 수 없습니다.');
    if (to.hidden) fail('원본이 숨김 처리되어 있습니다.');
    message = String(message || '').trim(); if (!message) fail('무엇을 바꿨는지 설명을 적어 주세요.');
    if (D().mergeRequests.some((m) => m.fromProjectId === fromId && m.status === 'pending')) fail('이미 대기 중인 반영 요청이 있습니다.');
    if (sameFileSet(find('versions', from.headVersionId).files, find('versions', to.headVersionId).files)) fail('원본과 내용이 같아 반영할 것이 없습니다.');
    const m = { id: uid('mr'), fromProjectId: fromId, toProjectId: to.id, fromVersionId: from.headVersionId, baseVersionId: to.headVersionId,
      authorId: u.id, message, status: 'pending', createdAt: now() };
    D().mergeRequests.push(m);
    notify(to.ownerId, `${u.name} 님이 「${to.title}」에 반영 요청을 보냈습니다: ${message}`, `#/p/${to.id}/merge`);
    if (user(to.ownerId).status !== 'active') notifyStaff(`졸업생 프로젝트 「${to.title}」에 반영 요청이 왔습니다.`, `#/p/${to.id}/merge`);
    Store.save();
    return m;
  }
  function resolveMergeRequest(id, approve, note) {
    requireActive();
    const m = find('mergeRequests', id) || fail('요청이 없습니다.');
    if (m.status !== 'pending') fail('이미 처리된 요청입니다.');
    const to = getProject(m.toProjectId);
    if (!canResolveFor(to)) fail('원작자만 반영 요청을 처리할 수 있습니다.');
    if (to.deleted) fail('삭제된 프로젝트입니다.');
    const from = rawProject(m.fromProjectId);
    if (approve && (!from || from.deleted || from.hidden)) fail('수정본이 삭제되었거나 숨김 처리되어 반영할 수 없습니다.');
    if (approve) {
      // 자동 병합 없이, 요청 시점의 수정본 내용으로 원본의 새 버전을 만든다
      const src = find('versions', m.fromVersionId);
      const v = addVersion(to, m.authorId, src.files, `반영 요청 승인: 「${from.title}」 — ${m.message}`, { mergeRequestId: m.id, approvedBy: me().id });
      m.mergedVersionId = v.id;
      if (!D().contributors.some((c) => c.projectId === to.id && c.userId === m.authorId)) {
        D().contributors.push({ id: uid('c'), projectId: to.id, userId: m.authorId, mergeRequestId: m.id, createdAt: now() });
      }
      notify(m.authorId, `「${to.title}」에 보낸 반영 요청이 승인되었습니다. 기여자 목록에 추가되었습니다.`, `#/p/${to.id}`);
    } else {
      notify(m.authorId, `「${to.title}」에 보낸 반영 요청이 거절되었습니다.${note ? ' 사유: ' + note : ''}`, `#/p/${to.id}/merge`);
    }
    m.status = approve ? 'approved' : 'rejected';
    m.note = String(note || '').trim(); m.resolvedAt = now(); m.resolvedBy = me().id;
    Store.save();
  }

  /* ---------- 줄 단위 댓글 ---------- */
  function commentsOf(versionId, path) {
    return D().comments.filter((c) => c.versionId === versionId && (!path || c.path === path)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  function addComment(versionId, path, line, text) {
    const u = requireActive(); const v = getVersion(versionId);
    const p = rawProject(v.projectId);
    if (p.deleted) fail('삭제된 프로젝트입니다.');
    text = String(text || '').trim(); if (!text) fail('댓글 내용을 입력하세요.');
    const file = v.files.find((f) => f.path === path) || fail('파일이 없습니다.');
    line = Number(line);
    if (!Number.isInteger(line) || line < 1 || line > file.content.split('\n').length) fail('잘못된 줄 번호입니다.');
    const link = `#/p/${p.id}?v=${versionId}&file=${encodeURIComponent(path)}&line=${line}`;
    // 같은 줄에 먼저 댓글을 단 사람들에게도 답글 알림
    const others = new Set(commentsOf(versionId, path).filter((x) => x.line === line).map((x) => x.authorId));
    others.delete(p.ownerId);
    const c = { id: uid('cm'), versionId, path, line, authorId: u.id, text, createdAt: now() };
    D().comments.push(c);
    notify(p.ownerId, `${u.name} 님이 「${p.title}」 ${path}:${line}에 댓글을 남겼습니다.`, link);
    others.forEach((id) => notify(id, `${u.name} 님이 「${p.title}」 ${path}:${line} 댓글에 답했습니다.`, link));
    Store.save();
  }
  function deleteComment(id) {
    const u = requireActive(); const c = find('comments', id) || fail('댓글이 없습니다.');
    if (c.authorId !== u.id && !isStaff(u)) fail('본인 댓글만 지울 수 있습니다.');
    D().comments = D().comments.filter((x) => x.id !== id); Store.save();
  }

  /* ---------- 신고 ---------- */
  function report(projectId, reason) {
    const u = requireActive(); const p = getProject(projectId);
    reason = String(reason || '').trim(); if (!reason) fail('신고 사유를 입력하세요.');
    D().reports.push({ id: uid('rp'), projectId, reporterId: u.id, reason, status: 'open', createdAt: now() });
    notifyStaff(`「${p.title}」에 대한 신고가 접수되었습니다.`, '#/admin?tab=reports');
    Store.save();
  }
  function listReports() { requireStaff(); return [...D().reports].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  function resolveReport(id, action) {
    const u = requireStaff(); const r = find('reports', id) || fail('신고가 없습니다.');
    if (r.status === 'resolved') fail('이미 처리된 신고입니다.');
    if (action === 'escalate') {
      if (isAdmin(u)) fail('관리자는 바로 처리하세요.');
      r.status = 'escalated';
      D().users.filter(isAdmin).forEach((t) => notify(t.id, '운영진이 신고 건의 최종 판단을 요청했습니다.', '#/admin?tab=reports'));
    } else if (action === 'hide' || action === 'dismiss') {
      if (r.status === 'escalated' && !isAdmin(u)) fail('관리자에게 넘긴 신고는 관리자가 처리합니다.');
      if (action === 'hide') setHidden(r.projectId, true, false);
      r.status = 'resolved'; r.action = action; r.resolvedBy = u.id; r.resolvedAt = now();
      audit('report.resolved', null, { report: id, project: r.projectId, action });
    } else fail('잘못된 처리 방식');
    Store.save();
  }
  function hiddenProjects() { requireStaff(); return D().projects.filter((p) => p.hidden); }

  /* ---------- 알림 ---------- */
  function notifications() { const u = me(); return u ? D().notifications.filter((n) => n.userId === u.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : []; }
  function unreadCount() { return notifications().filter((n) => !n.read).length; }
  function markRead(id) { const n = find('notifications', id); if (n && n.userId === me()?.id) { n.read = true; Store.save(); } }
  function markAllRead() { notifications().forEach((n) => { n.read = true; }); Store.save(); }

  /* ---------- 내 기여 내역 ---------- */
  function activity(userId) {
    requireReader();
    const mine = D().projects.filter((p) => p.ownerId === userId && !p.deleted && canSee(p));
    return {
      originals: mine.filter((p) => !p.parentId),
      forks: mine.filter((p) => p.parentId),
      mergedRequests: D().mergeRequests.filter((m) => m.authorId === userId && m.status === 'approved' && mrVisible(m)),
      contributedTo: D().contributors.filter((c) => c.userId === userId).map((c) => rawProject(c.projectId)).filter((p) => p && !p.deleted && canSee(p)),
      versions: D().versions.filter((v) => v.authorId === userId).length,
      comments: D().comments.filter((c) => c.authorId === userId).length,
      forksOfMine: D().projects.filter((p) => p.parentId && !p.deleted && p.ownerId !== userId && mine.some((m) => m.id === p.parentId)).length,
      timeline: timelineOf(userId),
    };
  }
  /** 최근 활동: 실제 기록(프로젝트 생성·버전·반영 요청·댓글)만 모은다. 볼 수 없는 프로젝트는 뺀다. */
  function timelineOf(userId, limit = 30) {
    const visible = (pid) => { const p = rawProject(pid); return p && !p.deleted && canSee(p); };
    const ev = [];
    D().projects.filter((p) => p.ownerId === userId && visible(p.id))
      .forEach((p) => ev.push({ type: p.parentId ? 'fork' : 'create', at: p.createdAt, projectId: p.id, refId: p.parentId }));
    D().versions.filter((v) => v.authorId === userId && visible(v.projectId) && !v.forkedFromVersionId && !v.mergeRequestId)
      .forEach((v) => {
        const first = D().versions.filter((x) => x.projectId === v.projectId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (first && first.id !== v.id) ev.push({ type: 'commit', at: v.createdAt, projectId: v.projectId, text: v.message });
      });
    D().mergeRequests.filter((m) => m.authorId === userId && mrVisible(m)).forEach((m) => {
      ev.push({ type: 'mr', at: m.createdAt, projectId: m.toProjectId, refId: m.fromProjectId, text: m.message });
      if (m.status === 'approved' && m.resolvedAt) ev.push({ type: 'merged', at: m.resolvedAt, projectId: m.toProjectId, refId: m.fromProjectId });
    });
    D().comments.filter((c) => c.authorId === userId).forEach((c) => {
      const v = find('versions', c.versionId);
      if (v && visible(v.projectId)) ev.push({ type: 'comment', at: c.createdAt, projectId: v.projectId, text: `${c.path}:${c.line}` });
    });
    return ev.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }

  /* ---------- 직책 (복수 보유) ---------- */
  const SINGLE_HOLDER = ['president', 'vice'];
  function holdersOf(code) { return D().users.filter((x) => (x.roles || []).includes(code) && x.status === 'active'); }
  /** 직책 임명. 부장·차장은 한 명(새 보유자를 정하면 기존 보유자는 자동으로 물러남), 관리자·서버 관리자는 여러 명 */
  function appointRole(id, role) {
    const cur = requireActive();
    if (role === 'owner') fail('최고 관리자는 [최고 관리자 이양]으로만 바꿀 수 있습니다.');
    if (!['admin', 'president', 'vice', 'server'].includes(role)) fail('임명할 수 없는 직책입니다.');
    if (role === 'admin') { if (!isOwner(cur)) fail('관리자 임명은 최고 관리자만 할 수 있습니다.'); }
    else if (!isAdmin(cur)) fail('관리자 권한이 필요합니다.');
    const t = find('users', id) || fail('회원이 없습니다.');
    if (t.status !== 'active') fail('활동 중인 회원에게만 직책을 줄 수 있습니다.');
    if (t.roles.includes(role)) fail(`이미 ${roleLabel(role)} 직책을 가진 회원입니다.`);
    if (SINGLE_HOLDER.includes(role)) {
      D().users.filter((x) => x.roles.includes(role)).forEach((x) => {
        x.roles = x.roles.filter((r) => r !== role);
        audit('role.revoked', x.id, { role, reason: 'transfer', new_holder: id });
        notify(x.id, `${roleLabel(role)} 직책이 ${t.name} 님에게 넘어갔습니다.`, '#/me');
      });
    }
    t.roles.push(role);
    audit('role.appointed', id, { role });
    notify(id, `${roleLabel(role)} 직책이 부여되었습니다.`, '#/me');
    Store.save();
  }
  function revokeRole(id, role) {
    requireActive(); const cur = me();
    if (role === 'owner') fail('최고 관리자는 [최고 관리자 이양]으로만 바꿀 수 있습니다.');
    if (!['admin', 'president', 'vice', 'server'].includes(role)) fail('해임할 수 없는 직책입니다.');
    if (role === 'admin') { if (!isOwner(cur)) fail('관리자 해임은 최고 관리자만 할 수 있습니다.'); }
    else if (!isAdmin(cur)) fail('관리자 권한이 필요합니다.');
    const t = find('users', id) || fail('회원이 없습니다.');
    if (!t.roles.includes(role)) fail('그 직책을 가진 회원이 아닙니다.');
    if (role === 'admin' && !D().users.some((x) => x.status === 'active' && (x.roles.includes('owner') || (x.roles.includes('admin') && x.id !== id)))) fail('마지막 관리자는 해임할 수 없습니다.');
    t.roles = t.roles.filter((r) => r !== role);
    audit('role.revoked', id, { role, reason: 'revoke' });
    notify(id, `${roleLabel(role)} 직책이 해임되었습니다.`, '#/me');
    Store.save();
  }
  function ownerTransfers() {
    requireReader(); const u = me();
    return D().ownerTransfers.filter((t) => isAdmin(u) || t.fromMember === u.id || t.toMember === u.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  function proposeOwnerTransfer(id) {
    const cur = requireActive();
    if (!isOwner(cur)) fail('최고 관리자만 이양을 제안할 수 있습니다.');
    const t = find('users', id) || fail('회원이 없습니다.');
    if (t.id === cur.id) fail('자기 자신에게는 이양할 수 없습니다.');
    if (t.status !== 'active') fail('활동 중인 회원에게만 이양할 수 있습니다.');
    if (D().ownerTransfers.some((x) => x.fromMember === cur.id && x.status === 'pending')) fail('이미 진행 중인 이양 제안이 있습니다. 먼저 취소하세요.');
    const tr = { id: uid('ot'), fromMember: cur.id, toMember: id, status: 'pending', createdAt: now(), decidedAt: null };
    D().ownerTransfers.push(tr);
    audit('owner.transfer_proposed', id, { transfer: tr.id });
    notify(id, `${cur.name} 님이 최고 관리자 이양을 제안했습니다. 수락하면 최고 관리자가 됩니다.`, '#/admin?tab=roles');
    Store.save();
    return tr.id;
  }
  function acceptOwnerTransfer(id) {
    const cur = requireActive();
    const tr = find('ownerTransfers', id) || fail('이양 제안이 없습니다.');
    if (tr.status !== 'pending') fail('이미 처리된 제안입니다.');
    if (tr.toMember !== cur.id) fail('제안을 받은 본인만 수락할 수 있습니다.');
    const from = find('users', tr.fromMember);
    if (!from || !from.roles.includes('owner')) fail('제안한 사람이 더 이상 최고 관리자가 아닙니다.');
    ['owner', 'admin'].forEach((r) => { if (!cur.roles.includes(r)) cur.roles.push(r); });
    from.roles = from.roles.filter((r) => r !== 'owner');
    if (!from.roles.includes('admin')) from.roles.push('admin');   // 이전 최고 관리자는 관리자로 남는다
    tr.status = 'accepted'; tr.decidedAt = now();
    audit('owner.transferred', cur.id, { transfer: id, from: from.id });
    notify(from.id, `${cur.name} 님이 최고 관리자 이양을 수락했습니다. 이제 관리자입니다.`, '#/admin?tab=roles');
    Store.save();
  }
  function cancelOwnerTransfer(id) {
    const cur = requireActive();
    const tr = find('ownerTransfers', id) || fail('이양 제안이 없습니다.');
    if (tr.status !== 'pending') fail('이미 처리된 제안입니다.');
    if (cur.id !== tr.fromMember && cur.id !== tr.toMember) fail('제안한 사람 또는 받은 사람만 취소할 수 있습니다.');
    tr.status = 'cancelled'; tr.decidedAt = now();
    audit('owner.transfer_cancelled', tr.toMember, { transfer: id });
    notify(cur.id === tr.fromMember ? tr.toMember : tr.fromMember, `${cur.name} 님이 최고 관리자 이양 제안을 취소했습니다.`, '#/admin?tab=roles');
    Store.save();
  }
  function setRolePermission(role, perm, enabled) {
    requireAdmin();
    const row = D().rolePerms.find((p) => p.role === role && p.perm === perm);
    if (!row || !(PERM_ALLOWED[role] || []).includes(perm)) fail('설정할 수 없는 권한입니다.');
    row.enabled = !!enabled;
    audit('role.permission', null, { role, perm, enabled: !!enabled });
    D().users.filter((x) => x.roles.includes(role)).forEach((x) => notify(x.id, `${roleLabel(role)} 직책의 권한이 바뀌었습니다.`, '#/me'));
    Store.save();
  }
  function rolePermissions() { requireReader(); return D().rolePerms; }
  function auditLogs() { requireAdmin(); return [...D().auditLogs].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200); }

  /* ---------- 계정 연결 ---------- */
  function accountsOf(memberId) { requireReader(); const u = me(); return D().accounts.filter((a) => a.memberId === memberId && (a.memberId === u.id || hasPerm(u, 'accounts.link'))); }
  function listAccounts() { requireAccountManager(); return D().accounts; }
  function listInvites() { requireAccountManager(); return D().invites; }
  function inviteAccount(memberId, email) {
    const cur = requireAccountManager();
    const em = String(email || '').trim().toLowerCase();
    const t = find('users', memberId) || fail('회원이 없습니다.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) fail('올바른 이메일 형식이 아닙니다.');
    const domain = D().settings.domain.toLowerCase();
    if (!em.endsWith('@' + domain)) fail(`학교 계정(@${domain})만 등록할 수 있습니다.`);
    if (D().accounts.some((a) => a.email === em && a.status === 'active')) fail('이미 가입된 계정입니다. 승인 대기 회원이면 [기존 회원에 연결]을 쓰세요.');
    const old = D().invites.find((i) => i.email === em);
    if (old && old.memberId !== memberId) fail('이미 다른 회원에게 사전 등록된 이메일입니다.');
    if (!old) D().invites.push({ email: em, memberId: t.id, createdBy: cur.id, createdAt: now() });
    audit('account.invited', t.id, { email: em });
    Store.save();
  }
  function linkAccount(pendingId, targetId) {
    const cur = requireAccountManager();
    if (pendingId === targetId) fail('같은 회원끼리는 연결할 수 없습니다.');
    const pe = find('users', pendingId); const t = find('users', targetId);
    if (!pe || !t) fail('회원이 없습니다.');
    if (pe.status !== 'pending') fail('승인 대기 중인 회원만 다른 회원에 연결할 수 있습니다.');
    if (t.status === 'pending') fail('연결할 대상은 승인된 회원이어야 합니다.');
    const D_ = D();
    if (D_.projects.some((p) => p.ownerId === pe.id) || D_.versions.some((v) => v.authorId === pe.id) || D_.mergeRequests.some((m) => m.authorId === pe.id)
      || D_.forkRequests.some((r) => r.requesterId === pe.id) || D_.comments.some((c) => c.authorId === pe.id) || D_.contributors.some((c) => c.userId === pe.id)
      || D_.reports.some((r) => r.reporterId === pe.id) || (pe.roles || []).length) fail('올린 기록이 있는 회원은 연결(병합)할 수 없습니다.');
    const emails = D_.accounts.filter((a) => a.memberId === pe.id).map((a) => a.email);
    D_.accounts.filter((a) => a.memberId === pe.id).forEach((a) => { a.memberId = t.id; a.linkedBy = cur.id; a.linkedAt = now(); });
    D_.users = D_.users.filter((x) => x.id !== pe.id);
    D_.notifications = D_.notifications.filter((n) => n.userId !== pe.id);
    audit('account.merged', t.id, { from_member: pe.id, from_member_no: pe.memberNo, from_name: pe.name, emails });
    notify(t.id, '새 로그인 계정이 내 회원 정보에 연결되었습니다.', '#/me');
    Store.save();
  }
  function unlinkAccount(authId) {
    requireAccountManager();
    const a = D().accounts.find((x) => x.authId === authId);
    if (!a || a.status !== 'active') fail('연결된 계정이 아닙니다.');
    if (D().accounts.filter((x) => x.memberId === a.memberId && x.status === 'active').length <= 1) fail('회원의 마지막 로그인 계정은 해제할 수 없습니다.');
    a.status = 'unlinked';
    audit('account.unlinked', a.memberId, { email: a.email, auth_id: authId });
    notify(a.memberId, '로그인 계정 하나의 연결이 해제되었습니다.', '#/me');
    Store.save();
  }

  /* ---------- 운영 연도·차시 ---------- */
  const currentYear = () => operatingYear();
  /** 몇 번 불러도 같은 결과. 지우는 것은 아무것도 없다. (서버 ensure_academic_year 와 같은 규칙) */
  function ensureAcademicYear() {
    const db = D(); const y = operatingYear(); let created = false;
    const addYear = (yr, status) => { db.years.push({ year: yr, ...yearBounds(yr), status }); };
    if (!db.years.some((a) => a.year === y)) { addYear(y, 'current'); created = true; }
    db.years.forEach((a) => { if (a.year < y) a.status = 'archived'; });
    db.projects.forEach((p) => { if (p.year != null && p.year < y && !db.years.some((a) => a.year === p.year)) addYear(p.year, 'archived'); });
    db.years.forEach((a) => {
      for (let no = 1; no <= 10; no++) {
        if (!db.sessions.some((x) => x.year === a.year && x.no === no)) db.sessions.push({ id: uid('s'), year: a.year, no, title: `${no}차시`, heldOn: null, description: '' });
      }
    });
    if (created) {
      const prev = Math.max(...db.membership.filter((m) => m.year < y).map((m) => m.year), -Infinity);
      const have = (id) => db.membership.some((m) => m.memberId === id && m.year === y);
      if (prev !== -Infinity) {
        db.membership.filter((m) => m.year === prev && m.status === 'active').forEach((m) => {
          const u = find('users', m.memberId);
          if (u && u.status === 'active' && !have(m.memberId)) db.membership.push({ memberId: m.memberId, year: y, generation: m.generation, grade: m.grade == null ? null : m.grade + 1, roles: [...(u.roles || [])], status: 'active' });
        });
      } else {
        db.users.filter((u) => u.status === 'active').forEach((u) => db.membership.push({ memberId: u.id, year: y, generation: u.generation ?? null, grade: null, roles: [...(u.roles || [])], status: 'active' }));
      }
    }
    db.years.sort((a, b) => b.year - a.year);
    Store.save();
    return y;
  }
  function years() { requireReader(); return [...D().years].sort((a, b) => b.year - a.year); }
  function sessionsOf(year) { requireReader(); return D().sessions.filter((s) => s.year === Number(year)).sort((a, b) => a.no - b.no); }
  function sessionById(id) { requireReader(); return D().sessions.find((s) => s.id === id) || null; }
  function sessionIdsOf(projectId) { return D().projectSessions.filter((x) => x.projectId === projectId).map((x) => x.sessionId); }
  function sessionsOfProject(projectId) { requireReader(); return sessionIdsOf(projectId).map((id) => D().sessions.find((s) => s.id === id)).filter(Boolean).sort((a, b) => b.year - a.year || a.no - b.no); }
  /** 차시에 연결된 코드 프로젝트 (보이는 것만, 삭제된 것 제외) */
  function projectsOfSession(sessionId) {
    requireReader();
    return D().projectSessions.filter((x) => x.sessionId === sessionId).map((x) => rawProject(x.projectId)).filter((p) => p && !p.deleted && canSee(p))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  /** 현재 운영 연도에 올라왔지만 어느 차시에도 연결되지 않은 프로젝트 (관리자용) */
  function unclassifiedProjects() {
    requireAdmin(); const y = operatingYear();
    return D().projects.filter((p) => !p.deleted && p.year === y && !D().projectSessions.some((x) => x.projectId === p.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  function membershipOf(year) { requireReader(); return D().membership.filter((m) => m.year === Number(year)); }
  const isPastYear = (year) => Number(year) !== operatingYear();
  function updateSession(id, { title, heldOn, description }) {
    requireActive();
    const s = D().sessions.find((x) => x.id === id) || fail('차시가 없습니다.');
    const past = isPastYear(s.year);
    if (past) { if (!isAdmin(me())) fail('지난 연도의 차시는 관리자만 고칠 수 있습니다.'); }
    else if (!isStaff(me())) fail('운영진 권한이 필요합니다.');
    title = String(title || '').trim(); if (!title) fail('차시 제목을 입력하세요.');
    if (title.length > 100) fail('차시 제목은 100자까지 쓸 수 있습니다.');
    if (String(description || '').length > 1000) fail('차시 설명은 1000자까지 쓸 수 있습니다.');
    s.title = title; s.heldOn = heldOn || null; s.description = String(description || '').trim();
    if (past) audit('session.updated_past', null, { session: id, year: s.year, no: s.no, title });
    Store.save();
  }
  function checkSessionLink(projectId, sessionId) {
    const u = requireActive(); const p = getProject(projectId);
    const s = D().sessions.find((x) => x.id === sessionId) || fail('차시가 없습니다.');
    if (p.deleted) fail('삭제된 프로젝트입니다.');
    const past = isPastYear(s.year);
    if (past) { if (!isAdmin(u)) fail('지난 연도의 차시는 관리자만 연결할 수 있습니다.'); }
    else if (p.ownerId !== u.id && !isStaff(u)) fail('프로젝트 작성자 또는 운영진만 차시에 연결할 수 있습니다.');
    return { p, past };
  }
  function linkProjectSession(projectId, sessionId) {
    const { p, past } = checkSessionLink(projectId, sessionId);
    if (!D().projectSessions.some((x) => x.projectId === projectId && x.sessionId === sessionId)) D().projectSessions.push({ projectId, sessionId, linkedBy: me().id, linkedAt: now() });
    if (past) audit('session.link_past', p.ownerId, { project: projectId, session: sessionId });
    Store.save();
  }
  function unlinkProjectSession(projectId, sessionId) {
    const { p, past } = checkSessionLink(projectId, sessionId);
    D().projectSessions = D().projectSessions.filter((x) => !(x.projectId === projectId && x.sessionId === sessionId));
    if (past) audit('session.unlink_past', p.ownerId, { project: projectId, session: sessionId });
    Store.save();
  }
  function upsertMembership(memberId, year, generation, grade) {
    requireAdmin();
    const t = find('users', memberId) || fail('회원이 없습니다.');
    year = Number(year);
    if (!D().years.some((a) => a.year === year)) fail(`${year}년 운영 연도가 없습니다.`);
    generation = generation === '' || generation == null ? null : Number(generation);
    grade = grade === '' || grade == null ? null : Number(grade);
    if (generation != null && !(generation >= 1)) fail('기수는 1 이상이어야 합니다.');
    if (grade != null && !(grade >= 1 && grade <= 6)) fail('학년은 1~6 사이로 입력하세요.');
    const row = D().membership.find((m) => m.memberId === memberId && m.year === year);
    if (row) { row.generation = generation; row.grade = grade; }
    else D().membership.push({ memberId, year, generation, grade, roles: year === operatingYear() ? [...t.roles] : [], status: t.status });
    if (year !== operatingYear()) audit('membership.updated_past', memberId, { year, generation, grade });
    Store.save();
  }

  /* ---------- 서버 상태 (데모 모드에는 서버가 없다) ---------- */
  function ping() { return { ok: true, ms: 0, now: now(), lastPing: now(), demo: true }; }
  function serverStatus() { fail('데모 모드에는 서버가 없어 상세 상태가 없습니다.'); }
  function canServerDetail(u = me()) { return isAdmin(u) || (hasRole(u, 'server') && hasPerm(u, 'server.detail')); }

  return {
    me, isStaff, isAdmin, isOwner, hasRole, hasPerm, canServerDetail, roleLabel, login, logout, user, listUsers, approveUser, rejectUser, setUserStatus, setUserGeneration,
    settings, updateSettings, rawProject, canSee, getProject, listProjects, generations, childrenOf, treeOf, lineage, contributors,
    versionsOf, getVersion, headOf, versionNumber, createProject, updateProjectInfo, commitVersion,
    forkCheck, forkProject, requestFork, forkRequestsFor, resolveForkRequest, canResolveFor,
    deleteProject, setHidden, mergeRequestsTo, mergeRequestsFrom, createMergeRequest, resolveMergeRequest,
    commentsOf, addComment, deleteComment, report, listReports, resolveReport, hiddenProjects,
    notifications, unreadCount, markRead, markAllRead, activity,
    holdersOf, appointRole, revokeRole, ownerTransfers, proposeOwnerTransfer, acceptOwnerTransfer, cancelOwnerTransfer, setRolePermission, rolePermissions, auditLogs,
    accountsOf, listAccounts, listInvites, inviteAccount, linkAccount, unlinkAccount,
    currentYear, isPastYear, ensureAcademicYear, years, sessionsOf, sessionById, sessionsOfProject, projectsOfSession, unclassifiedProjects, membershipOf,
    updateSession, linkProjectSession, unlinkProjectSession, upsertMembership, ping, serverStatus,
  };
})();
