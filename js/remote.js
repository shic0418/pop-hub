'use strict';
/* ===== Supabase 연결 계층 =====
 * config.js 에 URL·키가 있으면 켜진다.
 * - 읽기: 로그인한 사람이 볼 수 있는 데이터(RLS 통과분)를 한 번에 받아 Store.db 형태로 캐시한다.
 *   화면 코드는 데모 모드와 똑같이 이 캐시를 읽는다.
 * - 쓰기: Api 의 변경 함수를 서버 함수(RPC) 호출로 바꿔 끼운다. 권한 검사는 서버가 다시 한다.
 */
const Remote = (() => {
  const cfg = window.APP_CONFIG || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  let client = null;
  let loginError = '';
  let orphanSession = false;
  let failed = false;        // 마지막 불러오기가 실패했는가 (화면에 비차단 안내를 띄우는 용도)
  let ensuredFor = null;     // 운영 연도 준비를 이미 호출한 로그인 계정
  const versionCache = new Map(); // 버전은 바뀌지 않으므로 한 번 받은 것은 다시 받지 않는다

  /* ---------- 공통 ---------- */
  function cleanError(msg) {
    msg = String(msg || '');
    if (/JWT|token/i.test(msg)) return '로그인이 만료되었습니다. 다시 로그인하세요.';
    if (/Failed to fetch|NetworkError/i.test(msg)) return '서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요.';
    return msg;
  }
  async function rpc(name, params) {
    const { data, error } = await client.rpc(name, params);
    if (error) throw new ApiError(cleanError(error.message));
    return data;
  }
  /** 표마다 행을 하나로 정하는 정렬 열(기본키). 기본키가 여러 열이면 전부 정렬에 넣어야 페이지 사이에 행이 겹치거나 빠지지 않는다. */
  const ORDER = {
    member_emails: ['user_id'], user_accounts: ['auth_id'], account_invites: ['email'], private_settings: ['id'],
    user_roles: ['member_id', 'role'], role_permissions: ['role', 'perm'], academic_years: ['year'],
    membership_history: ['member_id', 'year'], project_sessions: ['project_id', 'session_id'],
    team_members: ['team_id', 'member_id'], team_credits: ['team_id', 'member_id'], team_project_sessions: ['team_id', 'session_id'],
    team_final_files: ['team_id', 'file_version_id'], post_sessions: ['post_id', 'session_id'], post_reactions: ['post_id', 'member_id', 'kind'],
    featured_items: ['kind', 'item_id'],
  };
  /** PostgREST는 한 번에 최대 1000행이라 나눠서 받는다. 정렬은 표의 기본키 전체(ORDER)로 항상 정해 둔다. */
  async function fetchAll(table, columns = '*', apply = (q) => q, orderBy) {
    const out = []; const size = 1000;
    const cols = [].concat(orderBy || ORDER[table] || ['id']);
    for (let from = 0; ; from += size) {
      // 정렬이 없거나 유일하지 않으면 페이지 사이에 행이 겹치거나 빠질 수 있다
      let q = apply(client.from(table).select(columns));
      for (const c of cols) q = q.order(c);
      const { data, error } = await q.range(from, from + size - 1);
      if (error) throw new ApiError(cleanError(error.message));
      out.push(...data);
      if (data.length < size) return out;
    }
  }

  /* ---------- 행 → 캐시 형태 변환 ---------- */
  // 시각은 항상 같은 형식의 ISO 문자열로 맞춘다 (화면에서 문자열로 정렬하기 때문)
  const ts = (v) => (v == null ? null : new Date(v).toISOString());
  // role 은 예전 호환용 칸이라 쓰지 않는다. 직책은 roles(user_roles) 로 읽는다.
  const mapUser = (r, email, roles) => ({ id: r.id, name: r.name, role: 'member', roles: roles || [], memberNo: r.member_no || '', status: r.status, generation: r.generation, createdAt: ts(r.created_at), email: email || '' });
  const mapProject = (r) => ({
    id: r.id, title: r.title, description: r.description, ownerId: r.owner_id, parentId: r.parent_id, rootId: r.root_id,
    permission: r.permission, generation: r.generation, year: r.year, createdAt: ts(r.created_at), updatedAt: ts(r.updated_at),
    deleted: r.deleted, deletedAt: ts(r.deleted_at), deletedBy: r.deleted_by, hidden: r.hidden, headVersionId: r.head_version_id,
  });
  const mapVersion = (r) => ({
    id: r.id, projectId: r.project_id, message: r.message, authorId: r.author_id, createdAt: ts(r.created_at), files: r.files,
    forkedFromVersionId: r.forked_from_version_id, mergeRequestId: r.merge_request_id, approvedBy: r.approved_by,
  });
  const mapMR = (r) => ({
    id: r.id, fromProjectId: r.from_project_id, toProjectId: r.to_project_id, fromVersionId: r.from_version_id, baseVersionId: r.base_version_id,
    authorId: r.author_id, message: r.message, status: r.status, createdAt: ts(r.created_at), mergedVersionId: r.merged_version_id,
    note: r.note, resolvedAt: ts(r.resolved_at), resolvedBy: r.resolved_by,
  });
  const mapFR = (r) => ({ id: r.id, projectId: r.project_id, requesterId: r.requester_id, title: r.title, message: r.message, status: r.status, forkId: r.fork_id, createdAt: ts(r.created_at), resolvedAt: ts(r.resolved_at) });
  const mapComment = (r) => ({ id: r.id, versionId: r.version_id, path: r.path, line: r.line, authorId: r.author_id, text: r.text, createdAt: ts(r.created_at) });
  const mapContrib = (r) => ({ id: r.id, projectId: r.project_id, userId: r.user_id, mergeRequestId: r.merge_request_id, createdAt: ts(r.created_at) });
  const mapNoti = (r) => ({ id: r.id, userId: r.user_id, text: r.text, link: r.link, read: r.read, createdAt: ts(r.created_at) });
  const mapAccount = (r) => ({ authId: r.auth_id, memberId: r.member_id, email: r.email || '', status: r.status, linkedAt: ts(r.linked_at), linkedBy: r.linked_by });
  const mapTransfer = (r) => ({ id: r.id, fromMember: r.from_member, toMember: r.to_member, status: r.status, createdAt: ts(r.created_at), decidedAt: ts(r.decided_at) });
  const mapAudit = (r) => ({ id: r.id, at: ts(r.at), actor: r.actor, action: r.action, target: r.target_member, detail: r.detail || {} });
  // date 칸은 'YYYY-MM-DD' 문자열로 맞춘다
  const day = (v) => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
  const mapYear = (r) => ({ year: r.year, startsOn: day(r.starts_on), endsOn: day(r.ends_on), status: r.status });
  const mapSession = (r) => ({ id: r.id, year: r.year, no: r.no, title: r.title, heldOn: day(r.held_on), description: r.description });
  const mapMembership = (r) => ({ memberId: r.member_id, year: r.year, generation: r.generation, grade: r.grade, roles: r.roles || [], status: r.status, note: r.note || '' });
  const mapReport = (r) => ({ id: r.id, projectId: r.project_id, postId: r.post_id, reporterId: r.reporter_id, reason: r.reason, status: r.status, action: r.action, resolvedBy: r.resolved_by, resolvedAt: ts(r.resolved_at), createdAt: ts(r.created_at) });
  // [2단계] 팀 프로젝트·게시판
  const mapTeam = (r) => ({ id: r.id, name: r.name, description: r.description, goal: r.goal, leader: r.leader, year: r.year, coverPath: r.cover_path, status: r.status, publishedAt: ts(r.published_at), createdAt: ts(r.created_at), updatedAt: ts(r.updated_at), deletedAt: ts(r.deleted_at), deletedBy: r.deleted_by || null, deleteReason: r.delete_reason || '' });
  const mapTeamMember = (r) => ({ teamId: r.team_id, memberId: r.member_id, roleLabel: r.role_label, status: r.status, invitedBy: r.invited_by, invitedAt: ts(r.invited_at), joinedAt: ts(r.joined_at) });
  const mapTeamFile = (r) => ({ id: r.id, teamId: r.team_id, name: r.name, createdBy: r.created_by, createdAt: ts(r.created_at) });
  const mapTeamVersion = (r) => ({ id: r.id, fileId: r.file_id, versionNo: r.version_no, origName: r.orig_name, path: r.path, size: Number(r.size), mime: r.mime, note: r.note, uploadedBy: r.uploaded_by, uploadedAt: ts(r.uploaded_at) });
  const mapTeamNote = (r) => ({ id: r.id, teamId: r.team_id, author: r.author, kind: r.kind, body: r.body, pinned: r.pinned, createdAt: ts(r.created_at) });
  const mapTeamCredit = (r) => ({ teamId: r.team_id, memberId: r.member_id, displayName: r.display_name, contribution: r.contribution, status: r.status, confirmedAt: ts(r.confirmed_at) });
  const mapCreditHistory = (r) => ({ id: r.id, teamId: r.team_id, actor: r.actor, change: r.change || {}, at: ts(r.at) });
  const mapPost = (r) => ({ id: r.id, author: r.author, board: r.board, title: r.title, body: r.body, tags: r.tags || [], visibility: r.visibility, coverPath: r.cover_path, teamId: r.team_id, projectId: r.project_id, year: r.year, pinned: r.pinned, hidden: r.hidden, createdAt: ts(r.created_at), updatedAt: ts(r.updated_at), deletedAt: ts(r.deleted_at) });
  const mapPostFile = (r) => ({ id: r.id, postId: r.post_id, path: r.path, name: r.name, size: Number(r.size), mime: r.mime, createdAt: ts(r.created_at) });
  const mapPostComment = (r) => ({ id: r.id, postId: r.post_id, author: r.author, body: r.body, createdAt: ts(r.created_at), deletedAt: ts(r.deleted_at) });

  /* ---------- 서버에서 전체 다시 읽기 ---------- */
  // 동시에 여러 번 불려도 가장 나중에 시작한 결과만 반영한다 (늦게 끝난 옛 결과가 덮어쓰지 않게)
  let refreshSeq = 0;
  async function refresh() {
    try { await refreshOnce(); failed = false; } catch (e) { failed = true; throw e; }
  }
  async function refreshOnce() {
    const mySeq = ++refreshSeq;
    const { data: { session } } = await client.auth.getSession();
    const uid = session?.user?.id || null;   // 로그인 계정 ID (회원 ID 와 다를 수 있다)
    if (uid && ensuredFor !== uid) {
      // 접속할 때 현재 운영 연도·차시가 있는지 확인한다 (이미 있으면 아무 일도 하지 않는다). 실패해도 앱은 계속 쓴다.
      ensuredFor = uid;
      try { await rpc('ensure_academic_year', {}); } catch (e) { console.warn('운영 연도 준비 실패', e); }
    }
    const { data: s, error: se } = await client.from('settings').select('*').eq('id', 1).single();
    if (se) throw new ApiError(cleanError(se.message));
    const db = {
      schema: SCHEMA, session: { userId: null, authId: uid },
      settings: { clubName: s.club_name, domain: s.domain, signupMode: s.signup_mode, maxFileKB: s.max_file_kb, maxUploadMB: s.max_upload_mb ?? 20, whitelist: [] },
      users: [], projects: [], versions: [], mergeRequests: [], forkRequests: [], comments: [], contributors: [], notifications: [], reports: [],
      accounts: [], invites: [], rolePerms: [], ownerTransfers: [], auditLogs: [], years: [], sessions: [], membership: [], projectSessions: [],
    };
    ensureV3Tables(db);
    if (uid) {
      const [profiles, emails, priv, projects, skeleton, versionIds, mrs, frs, comments, contribs, notis, reports,
        accounts, invites, userRoles, perms, transfers, audits, years, sessions, membership, projectSessions] = await Promise.all([
        fetchAll('profiles'), fetchAll('member_emails'), fetchAll('private_settings'), fetchAll('projects'),
        rpc('tree_skeleton', {}), fetchAll('versions', 'id'),
        fetchAll('merge_requests'), fetchAll('fork_requests'), fetchAll('comments'), fetchAll('contributors'),
        fetchAll('notifications'), fetchAll('reports'),
        fetchAll('user_accounts'), fetchAll('account_invites'),
        fetchAll('user_roles'), fetchAll('role_permissions'),
        fetchAll('owner_transfers'),
        // 감사 기록은 관리자에게만 보인다(서버가 걸러 준다). 최근 200건만 받는다.
        client.from('audit_logs').select('*').order('id', { ascending: false }).range(0, 199).then(({ data, error }) => { if (error) throw new ApiError(cleanError(error.message)); return data; }),
        fetchAll('academic_years'), fetchAll('sessions'), fetchAll('membership_history'),
        fetchAll('project_sessions'),
      ]);
      // [2단계] 팀 프로젝트·게시판 표 (볼 수 있는 행만 서버가 걸러 준다)
      const [teams, tMembers, tFiles, tVers, tNotes, tCredits, tHist, tSess, tFinal, posts, pSess, pFiles, pComments, pReacts, featured] = await Promise.all([
        fetchAll('team_projects'), fetchAll('team_members'), fetchAll('team_files'), fetchAll('team_file_versions'), fetchAll('team_notes'),
        fetchAll('team_credits'), fetchAll('team_credit_history'), fetchAll('team_project_sessions'),
        fetchAll('team_final_files'), fetchAll('posts'), fetchAll('post_sessions'),
        fetchAll('post_files'), fetchAll('post_comments'), fetchAll('post_reactions'), fetchAll('featured_items'),
      ]);
      db.teams = teams.map(mapTeam); db.teamMembers = tMembers.map(mapTeamMember); db.teamFiles = tFiles.map(mapTeamFile);
      db.teamVersions = tVers.map(mapTeamVersion); db.teamNotes = tNotes.map(mapTeamNote); db.teamCredits = tCredits.map(mapTeamCredit);
      db.teamCreditHistory = tHist.map(mapCreditHistory); db.teamSessions = tSess.map((r) => ({ teamId: r.team_id, sessionId: r.session_id }));
      db.teamFinal = tFinal.map((r) => ({ teamId: r.team_id, versionId: r.file_version_id }));
      db.posts = posts.map(mapPost); db.postSessions = pSess.map((r) => ({ postId: r.post_id, sessionId: r.session_id }));
      db.postFiles = pFiles.map(mapPostFile); db.postComments = pComments.map(mapPostComment);
      db.postReactions = pReacts.map((r) => ({ postId: r.post_id, memberId: r.member_id }));
      db.featured = featured.map((r) => ({ kind: r.kind, itemId: r.item_id, year: r.year, note: r.note, featuredBy: r.featured_by, featuredAt: ts(r.featured_at) }));
      const emailOf = new Map(emails.map((e) => [e.user_id, e.email]));
      const rolesOf = new Map();
      for (const r of userRoles) { if (!rolesOf.has(r.member_id)) rolesOf.set(r.member_id, []); rolesOf.get(r.member_id).push(r.role); }
      db.accounts = accounts.map(mapAccount);
      // 지금 로그인한 회원 = 이 로그인 계정에 연결된 회원
      db.session.userId = db.accounts.find((a) => a.authId === uid && a.status === 'active')?.memberId || null;
      db.users = profiles.map((r) => mapUser(r, emailOf.get(r.id), rolesOf.get(r.id)));
      if (priv[0]) db.settings.whitelist = priv[0].whitelist || [];
      db.invites = invites.map((r) => ({ email: r.email, memberId: r.member_id, createdBy: r.created_by, createdAt: ts(r.created_at) }));
      db.rolePerms = perms.map((r) => ({ role: r.role, perm: r.perm, enabled: r.enabled }));
      db.ownerTransfers = transfers.map(mapTransfer);
      db.auditLogs = audits.map(mapAudit);
      db.years = years.map(mapYear);
      db.sessions = sessions.map(mapSession);
      db.membership = membership.map(mapMembership);
      db.projectSessions = projectSessions.map((r) => ({ projectId: r.project_id, sessionId: r.session_id, linkedBy: r.linked_by }));
      db.projects = projects.map(mapProject);
      // 숨김 프로젝트는 자리만 남겨 하위 수정본이 트리에서 끊기지 않게 한다
      const known = new Set(db.projects.map((p) => p.id));
      for (const k of skeleton || []) {
        if (!known.has(k.id)) db.projects.push({ id: k.id, parentId: k.parent_id, rootId: k.root_id, createdAt: ts(k.created_at), updatedAt: ts(k.created_at), title: '', description: '', ownerId: null, permission: 'view', generation: null, year: null, deleted: false, hidden: true, headVersionId: null });
      }
      // 버전: 새로 보이게 된 것만 받아 온다
      const visible = new Set(versionIds.map((v) => v.id));
      const missing = [...visible].filter((id) => !versionCache.has(id));
      for (let i = 0; i < missing.length; i += 100) {
        const chunk = missing.slice(i, i + 100);
        const rows = await fetchAll('versions', '*', (q) => q.in('id', chunk));
        rows.forEach((r) => versionCache.set(r.id, mapVersion(r)));
      }
      // 목록을 받은 뒤에 새 버전이 올라와 head 버전이 빠졌으면 마저 받는다
      const heads = db.projects.filter((p) => p.headVersionId && !versionCache.has(p.headVersionId) && !p.hidden && !p.deleted).map((p) => p.headVersionId);
      if (heads.length) {
        const rows = await fetchAll('versions', '*', (q) => q.in('id', heads));
        rows.forEach((r) => { versionCache.set(r.id, mapVersion(r)); visible.add(r.id); });
      }
      for (const id of [...versionCache.keys()]) if (!visible.has(id)) versionCache.delete(id);
      db.versions = [...versionCache.values()];
      db.mergeRequests = mrs.map(mapMR);
      db.forkRequests = frs.map(mapFR);
      db.comments = comments.map(mapComment);
      db.contributors = contribs.map(mapContrib);
      db.notifications = notis.map(mapNoti);
      db.reports = reports.map(mapReport);
    }
    if (mySeq !== refreshSeq) return; // 더 최근에 시작한 refresh 가 있으면 이 결과는 버린다
    // 로그인은 됐지만 회원 정보가 없는 세션 (스키마 적용 전에 만든 계정, 연결이 해제된 계정 등)
    orphanSession = !!uid && !db.users.some((u) => u.id === db.session.userId);
    Store.replace(db);
  }

  /* ---------- 쓰기: Api 함수를 RPC로 교체 ---------- */
  const num = (v) => (v === '' || v == null ? null : Number(v));
  // 명단 행은 서버가 분류하므로 값 그대로(문자열) 보낸다
  const rosterRows = (rows) => rows.map((r) => ({ name: r.name ?? '', generation: r.generation ?? '', grade: r.grade ?? '', email: r.email ?? '', member_no: r.member_no ?? '', note: r.note ?? '' }));
  const plainFiles = (files) => files.map((f) => ({ path: f.path, content: f.content }));
  const writes = {
    approveUser: (id, gen) => rpc('approve_user', { p_id: id, p_generation: num(gen) }),
    rejectUser: (id) => rpc('reject_user', { p_id: id }),
    setUserStatus: (id, status) => rpc('set_user_status', { p_id: id, p_status: status }),
    setUserGeneration: (id, gen) => rpc('set_user_generation', { p_id: id, p_generation: num(gen) }),
    updateSettings: (p) => rpc('update_settings', {
      p_club_name: p.clubName ?? null, p_domain: p.domain ?? null, p_signup_mode: p.signupMode ?? null,
      p_max_file_kb: num(p.maxFileKB), p_whitelist: p.whitelist ?? null, p_max_upload_mb: num(p.maxUploadMB),
    }),
    createProject: (o) => rpc('create_project', {
      p_title: o.title, p_description: o.description || '', p_permission: o.permission,
      p_generation: num(o.generation), p_files: plainFiles(o.files), p_message: o.message || null,
    }),
    updateProjectInfo: (id, o) => rpc('update_project_info', {
      p_id: id, p_title: o.title ?? null, p_description: o.description ?? null, p_permission: o.permission ?? null,
      p_generation: o.generation === undefined ? null : String(o.generation ?? ''),
    }),
    commitVersion: (id, files, message) => rpc('commit_version', { p_project: id, p_files: plainFiles(files), p_message: message }),
    forkProject: (id, o) => rpc('fork_project', { p_id: id, p_title: o.title ?? null, p_description: o.description ?? null }),
    requestFork: (id, o) => rpc('request_fork', { p_id: id, p_title: o.title ?? null, p_message: o.message ?? null }),
    resolveForkRequest: (id, approve) => rpc('resolve_fork_request', { p_id: id, p_approve: !!approve }),
    deleteProject: (id) => rpc('delete_project', { p_id: id }),
    setHidden: (id, hidden, withDesc = false) => rpc('set_hidden', { p_id: id, p_hidden: !!hidden, p_with_descendants: !!withDesc }),
    createMergeRequest: (id, message) => rpc('create_merge_request', { p_from: id, p_message: message }),
    resolveMergeRequest: (id, approve, note) => rpc('resolve_merge_request', { p_id: id, p_approve: !!approve, p_note: note || '' }),
    addComment: (versionId, path, line, text) => rpc('add_comment', { p_version: versionId, p_path: path, p_line: Number(line), p_text: text }),
    deleteComment: (id) => rpc('delete_comment', { p_id: id }),
    report: (id, reason) => rpc('report_project', { p_id: id, p_reason: reason }),
    resolveReport: (id, action) => rpc('resolve_report', { p_id: id, p_action: action }),
    markRead: (id) => rpc('mark_notification_read', { p_id: id }),
    markAllRead: () => rpc('mark_all_notifications_read', {}),
    appointRole: (id, role) => rpc('appoint_role', { p_member_id: id, p_role: role }),
    revokeRole: (id, role) => rpc('revoke_role', { p_member_id: id, p_role: role }),
    proposeOwnerTransfer: (id) => rpc('propose_owner_transfer', { p_member_id: id }),
    acceptOwnerTransfer: (id) => rpc('accept_owner_transfer', { p_id: id }),
    cancelOwnerTransfer: (id) => rpc('cancel_owner_transfer', { p_id: id }),
    setRolePermission: (role, perm, enabled) => rpc('set_role_permission', { p_role: role, p_perm: perm, p_enabled: !!enabled }),
    inviteAccount: (memberId, email) => rpc('invite_account', { p_member_id: memberId, p_email: email }),
    linkAccount: (pendingId, targetId) => rpc('link_account', { p_pending_member_id: pendingId, p_target_member_id: targetId }),
    unlinkAccount: (authId) => rpc('unlink_account', { p_auth_id: authId }),
    updateSession: (id, o) => rpc('update_session', { p_id: id, p_title: o.title, p_held_on: o.heldOn || null, p_description: o.description || '' }),
    linkProjectSession: (projectId, sessionId) => rpc('link_project_session', { p_project_id: projectId, p_session_id: sessionId }),
    unlinkProjectSession: (projectId, sessionId) => rpc('unlink_project_session', { p_project_id: projectId, p_session_id: sessionId }),
    upsertMembership: (memberId, year, gen, grade) => rpc('upsert_membership', { p_member_id: memberId, p_year: Number(year), p_generation: num(gen), p_grade: num(grade) }),
    ensureAcademicYear: () => rpc('ensure_academic_year', {}),
    // 2단계: 팀 프로젝트
    createTeam: (o) => rpc('create_team', { p_name: o.name, p_description: o.description || '', p_goal: o.goal || '' }),
    updateTeam: (id, o) => rpc('update_team', { p_id: id, p_name: o.name ?? null, p_description: o.description ?? null, p_goal: o.goal ?? null, p_cover_path: o.coverPath ?? null }),
    inviteTeamMember: (id, member, label) => rpc('invite_team_member', { p_team: id, p_member: member, p_role_label: label || '' }),
    respondTeamInvite: (id, accept) => rpc('respond_team_invite', { p_team: id, p_accept: !!accept }),
    removeTeamMember: (id, member) => rpc('remove_team_member', { p_team: id, p_member: member }),
    leaveTeam: (id) => rpc('leave_team', { p_team: id }),
    transferTeamLeader: (id, member) => rpc('transfer_team_leader', { p_team: id, p_member: member }),
    setTeamStatus: (id, status) => rpc('set_team_status', { p_team: id, p_status: status }),
    registerTeamFile: (id, o) => rpc('register_team_file', { p_team: id, p_path: o.path, p_name: o.name, p_note: o.note || '', p_file_id: o.fileId || null }),
    setTeamFinal: (id, versionId, final) => rpc('set_team_final', { p_team: id, p_version: versionId, p_final: !!final }),
    addTeamNote: (id, kind, body) => rpc('add_team_note', { p_team: id, p_kind: kind, p_body: body }),
    deleteTeamNote: (id) => rpc('delete_team_note', { p_id: id }),
    pinTeamNote: (id, pinned) => rpc('pin_team_note', { p_id: id, p_pinned: !!pinned }),
    setTeamCredits: (id, list) => rpc('set_team_credits', { p_team: id, p_credits: list.map((c) => ({ member_id: c.memberId, display_name: c.displayName, contribution: c.contribution || '' })) }),
    respondTeamCredit: (id, confirm) => rpc('respond_team_credit', { p_team: id, p_confirm: !!confirm }),
    linkTeamSession: (id, sid) => rpc('link_team_session', { p_team: id, p_session: sid }),
    unlinkTeamSession: (id, sid) => rpc('unlink_team_session', { p_team: id, p_session: sid }),
    publishTeam: (id) => rpc('publish_team', { p_team: id }),
    // 3단계: 팀 삭제·복구(관리자), 명예의 전당, 명단 가져오기, 차시 일괄 편집
    deleteTeam: (id, reason) => rpc('delete_team', { p_team_id: id, p_reason: reason || '' }),
    restoreTeam: (id) => rpc('restore_team', { p_team_id: id }),
    featureItem: (kind, id, note) => rpc('feature_item', { p_kind: kind, p_item_id: id, p_note: note || '' }),
    unfeatureItem: (kind, id) => rpc('unfeature_item', { p_kind: kind, p_item_id: id }),
    importRoster: (year, rows) => rpc('import_roster', { p_year: Number(year), p_rows: rosterRows(rows) }),
    updateSessionsBulk: (year, items) => rpc('update_sessions_bulk', { p_year: Number(year), p_items: items.map((x) => ({ id: x.id, title: x.title, held_on: x.heldOn || '', description: x.description || '' })) }),
    // 2단계: 게시판
    createPost: (o) => rpc('create_post', { p_board: o.board, p_title: o.title, p_body: o.body || '', p_tags: o.tags || [], p_visibility: o.visibility || 'members',
      p_team_id: o.teamId || null, p_project_id: o.projectId || null, p_session_ids: o.sessionIds || [], p_pinned: !!o.pinned }),
    updatePost: (id, o) => rpc('update_post', { p_id: id, p_title: o.title, p_body: o.body || '', p_tags: o.tags || [], p_visibility: o.visibility || 'members',
      p_project_id: o.projectId || null, p_session_ids: o.sessionIds || [] }),
    deletePost: (id) => rpc('delete_post', { p_id: id }),
    setPostHidden: (id, hidden) => rpc('set_post_hidden', { p_id: id, p_hidden: !!hidden }),
    setPostPinned: (id, pinned) => rpc('set_post_pinned', { p_id: id, p_pinned: !!pinned }),
    registerPostFile: (postId, o) => rpc('register_post_file', { p_post: postId, p_path: o.path, p_name: o.name, p_cover: !!o.cover }),
    removePostFile: (id) => rpc('remove_post_file', { p_id: id }),
    addPostComment: (postId, body) => rpc('add_post_comment', { p_post: postId, p_body: body }),
    deletePostComment: (id) => rpc('delete_post_comment', { p_id: id }),
    togglePostReaction: (postId) => rpc('toggle_post_reaction', { p_post: postId }),
    reportPost: (postId, reason) => rpc('report_post', { p_id: postId, p_reason: reason }),
  };
  // 서버가 새 행의 ID 만 돌려주는 함수는, 다시 읽은 뒤 화면 코드가 쓰는 객체(데모 모드와 같은 모양)로 바꿔 돌려준다
  const returnsObject = {
    createProject: (id) => Api.rawProject(id) || { id }, forkProject: (id) => Api.rawProject(id) || { id },
    createTeam: (id) => Api.getTeam(id), createPost: (id) => Api.rawPost(id) || { id }, publishTeam: (id) => Api.rawPost(id) || { id },
  };

  function installApi() {
    for (const [name, fn] of Object.entries(writes)) {
      Api[name] = async (...args) => {
        const result = await fn(...args);
        // 저장은 이미 끝났으므로, 다시 읽기가 실패해도 오류로 보고하지 않는다 (재시도로 중복 생성되는 것 방지)
        try { await refresh(); } catch (e) { console.warn('저장 후 새로고침 실패', e); }
        return returnsObject[name] ? returnsObject[name](result) : result;
      };
    }
    Api.login = () => { throw new ApiError('Google 로그인 버튼을 이용하세요.'); };
    Api.logout = async () => { await client.auth.signOut(); versionCache.clear(); ensuredFor = null; await refresh(); };
    Api.ping = ping;
    Api.serverStatus = serverStatus;
    Api.previewRoster = async (year, rows) => rpc('preview_roster', { p_year: Number(year), p_rows: rosterRows(rows) });   // 미리보기는 아무것도 쓰지 않는다
    Api.storageUsage = storageUsage;
    Api.cleanupOrphans = cleanupOrphans;
    // 파일은 Supabase Storage(비공개 버킷 pop-files)에 올린다. 덮어쓰기는 하지 않고(upsert:false), 열람은 60초짜리 서명 주소로만 한다.
    FileStore.limitBytes = () => (Store.db?.settings?.maxUploadMB || 20) * 1048576;
    FileStore.put = async (path, file) => {
      const { error } = await client.storage.from('pop-files').upload(path, file, { upsert: false, contentType: file.type || undefined, cacheControl: '3600' });
      if (error) throw new ApiError(storageError(error.message));
      return { size: file.size, mime: file.type || '' };
    };
    FileStore.url = async (path, downloadName) => {
      const { data, error } = await client.storage.from('pop-files').createSignedUrl(path, 60, downloadName ? { download: downloadName } : undefined);
      if (error || !data?.signedUrl) throw new ApiError(storageError(error?.message || '파일 주소를 만들지 못했습니다.'));
      return data.signedUrl;
    };
  }
  function storageError(msg) {
    msg = String(msg || '');
    if (/row-level security|not authorized|Unauthorized/i.test(msg)) return '이 위치에 파일을 올리거나 열 권한이 없습니다.';
    if (/already exists|Duplicate/i.test(msg)) return '같은 경로의 파일이 이미 있습니다. 다시 시도해 주세요.';
    if (/exceed|too large|maximum/i.test(msg)) return '파일이 너무 큽니다. 업로드 용량 제한을 확인하세요.';
    if (/not found|Object not found/i.test(msg)) return '파일을 찾을 수 없습니다.';
    return cleanError(msg);
  }

  /* ---------- 저장 공간 ---------- */
  const mapUsage = (d) => ({
    available: d.available !== false, limitBytes: Number(d.limit_bytes), totalBytes: Number(d.total_bytes), totalCount: Number(d.total_count),
    byPrefix: d.by_prefix ? d.by_prefix.map((x) => ({ prefix: x.prefix, bytes: Number(x.bytes), count: Number(x.count) })) : null,
    largest: d.largest ? d.largest.map((x) => ({ path: x.path, size: Number(x.size), createdAt: ts(x.created_at), linked: x.linked || null })) : null,
    orphans: d.orphans ? d.orphans.map((x) => ({ path: x.path, size: Number(x.size), createdAt: ts(x.created_at), deletable: !!x.deletable })) : null,
    orphanCount: d.orphan_count == null ? null : Number(d.orphan_count), orphanBytes: d.orphan_bytes == null ? null : Number(d.orphan_bytes),
  });
  async function storageUsage() { return mapUsage(await rpc('storage_usage', {})); }
  /** 고아 파일 정리: Storage 에서 지우고(삭제 권한은 서버 정책이 다시 검사한다) 실제로 사라진 개수를 감사 기록으로 남긴다 */
  async function cleanupOrphans(paths) {
    if (!paths.length) throw new ApiError('정리할 파일이 없습니다.');
    const { error } = await client.storage.from('pop-files').remove(paths);
    if (error) throw new ApiError(storageError(error.message));
    const removed = await rpc('log_orphan_cleanup', { p_paths: paths });
    return removed;
  }

  /* ---------- 서버 상태 ---------- */
  const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, no) => setTimeout(() => no(new Error('응답 시간이 초과되었습니다.')), ms))]);
  /** 연결 확인: 서버 함수 ping 을 한 번 부른다. 데이터를 바꾸지 않으며(상태 기록 제외), 실패해도 예외를 던지지 않는다. */
  async function ping() {
    const t0 = performance.now();
    try {
      if (!client) throw new Error('Supabase 라이브러리를 불러오지 못했습니다.');
      const { data, error } = await withTimeout(client.rpc('ping', {}), 12000);
      if (error) throw new Error(cleanError(error.message));
      return { ok: data?.ok === true, ms: Math.round(performance.now() - t0), now: data?.now || null, lastPing: data?.last_ping || null };
    } catch (e) {
      return { ok: false, ms: Math.round(performance.now() - t0), error: cleanError(e.message) };
    }
  }
  /** 서버 상태 상세 (관리자, 또는 권한이 켜진 서버 관리자). 서버가 권한을 다시 검사한다. */
  async function serverStatus() {
    const d = await rpc('server_status', {});
    return { dbSize: Number(d.db_size), year: d.year, counts: d.counts || {}, pings: d.pings || [], backup: d.backup || null, errors: d.errors || null, canBackup: !!d.can_backup, canErrors: !!d.can_errors };
  }

  /* ---------- 시작 ---------- */
  function takeUrlError() {
    // OAuth 실패(학교 도메인 아님·명단에 없음 등)는 주소에 error_description 으로 돌아온다
    const params = new URLSearchParams(location.search);
    const hashParams = new URLSearchParams(location.hash.replace(/^#\/?/, ''));
    const desc = params.get('error_description') || hashParams.get('error_description');
    if (!desc) return;
    loginError = /saving new user|Database error/i.test(desc)
      ? '가입할 수 없는 계정입니다. 학교 Google 계정인지 확인하세요. (부원 명단 방식이면 운영진에게 등록을 요청하세요)'
      : `로그인 실패: ${desc}`;
    history.replaceState(null, '', location.pathname + '#/');
  }
  async function init() {
    if (!window.supabase?.createClient) throw new Error('Supabase 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인하세요.');
    takeUrlError();
    client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
    });
    Store.remote = true;
    await client.auth.getSession(); // ?code= 교환을 끝낸다
    if (new URLSearchParams(location.search).has('code')) history.replaceState(null, '', location.pathname + (location.hash || '#/'));
    installApi();
    await refresh();
    // 다른 탭에서 로그인·로그아웃했을 때만 다시 그린다 (탭 포커스 때 오는 SIGNED_IN 은 사용자 id 가 같으면 무시)
    client.auth.onAuthStateChange((event, session) => {
      const uid = session?.user?.id || null;
      if (uid === (Store.db?.session?.authId || null)) return;
      refresh().then(() => window.render?.()).catch(console.error);
    });
  }
  async function signIn() {
    const { error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: location.origin + location.pathname,
        // 학교 계정이 이미 로그인돼 있으면 그 세션을 그대로 쓰도록 강제 재선택(prompt)은 하지 않는다.
        // (학교 SSO(SAML) 도메인은 재인증을 강제하면 학교 로그인 서버에서 오류가 날 수 있음)
        queryParams: { hd: Store.db.settings.domain, prompt: 'select_account' },
      },
    });
    if (error) throw new ApiError(cleanError(error.message));
  }

  return {
    enabled, init, refresh, signIn,
    get loginError() { return loginError; },
    get orphanSession() { return orphanSession; },
    get failed() { return failed; },
    markFailed() { failed = true; },
    ping, serverStatus,
    clearLoginError() { loginError = ''; },
  };
})();
