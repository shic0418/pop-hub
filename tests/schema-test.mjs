import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

// 실행: npm install @electric-sql/pglite  후  node tests/schema-test.mjs
const schemaPath = process.argv[2] || new URL('../supabase/schema.sql', import.meta.url);
const db = new PGlite();
let pass = 0, failN = 0;
const ok = (cond, label) => { if (cond) { pass++; } else { failN++; console.log('❌', label); } };

// --- Supabase 흉내: auth 스키마와 역할 ---
await db.exec(`
create role anon nologin; create role authenticated nologin;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}', raw_app_meta_data jsonb default '{"provider":"google"}', email_confirmed_at timestamptz default now());
create table auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid, provider text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
-- Storage 흉내: 실제 Supabase 의 storage.buckets / storage.objects 중 정책에 필요한 부분만 (RLS 는 켜 둔다)
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz default now());
alter table storage.objects enable row level security;
create unique index on storage.objects (bucket_id, name);   -- 실제 Storage 도 같은 경로는 한 번만(upsert:false 면 거절)
grant usage on schema storage to anon, authenticated; grant select, insert, update, delete on storage.objects to authenticated;
`);
try {
  await db.exec(readFileSync(schemaPath, 'utf8'));
  // 두 번 실행해도 되는지(재실행 안전성)
  await db.exec(readFileSync(schemaPath, 'utf8'));
} catch (e) { console.log('스키마 오류:', e.message, e.where || '', e.position || ''); process.exit(1); }

await db.exec(`update settings set domain = 'school.hs.kr';
  update private_settings set teacher_emails = array['t@school.hs.kr'], whitelist = array['a@school.hs.kr'];`);

async function signup(email, name) {
  try {
    const r = await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, { full_name: name }]);
    return r.rows[0].id;
  } catch (e) { return 'ERR:' + e.message; }
}
async function as(uid, sql, params = []) {
  await db.exec(`set role authenticated`);
  await db.query(`select set_config('test.uid', $1, false)`, [uid || '']);
  try { return { rows: (await db.query(sql, params)).rows }; }
  catch (e) { return { err: e.message }; }
  finally { await db.exec(`reset role`); }
}
const files = (extra = {}) => JSON.stringify(Object.entries({ 'README.md': '# t', 'main.py': 'print(1)\nprint(2)\n', ...extra }).map(([path, content]) => ({ path, content })));

// 1. 가입
ok((await signup('x@gmail.com', 'x')).startsWith('ERR:학교 계정'), '외부 도메인 가입 차단');
const T = await signup('t@school.hs.kr', '선생님');
const A = await signup('a@school.hs.kr', '에이');
const B = await signup('b@school.hs.kr', '비');
let r = await as(T, `select status, (select array_agg(role order by role) from user_roles where member_id = $1) roles from profiles where id = $1`, [T]);
ok(JSON.stringify(r.rows[0].roles) === '["admin","owner"]' && r.rows[0].status === 'active', '부장 이메일 → 최고 관리자 + 관리자');
r = await as(A, `select status from profiles where id = $1`, [A]);
ok(r.rows[0].status === 'active', '명단 이메일 → 바로 활동');
r = await as(B, `select status from profiles where id = $1`, [B]);
ok(r.rows[0].status === 'pending', '그 외 → 승인 대기');
r = await as(T, `select count(*)::int n from notifications where user_id = $1`, [T]);
ok(r.rows[0].n === 1, '승인 대기 알림이 운영진에게');

// 2. 대기 중 사용자 제한
r = await as(B, `select create_project('x', '', 'free', 1, $1::jsonb)`, [files()]);
ok(r.err?.includes('승인 대기'), '대기 중 업로드 차단');
r = await as(B, `select count(*)::int n from profiles`);
ok(r.rows[0].n === 1, '대기 중에는 본인 프로필만 보임');
r = await as(null, `select club_name from settings`);
ok(r.rows.length === 1, '비로그인도 설정(동아리 이름) 읽기 가능');
r = await as(null, `select * from private_settings`);
ok(r.rows.length === 0, '비로그인은 명단 못 읽음');

// 3. 승인·역할
r = await as(A, `select appoint_role($1, 'vice')`, [B]);
ok(r.err?.includes('관리자 권한'), '일반 부원은 직책 임명 불가');
r = await as(T, `select approve_user($1, 4)`, [B]);
ok(!r.err, '부장이 승인');
r = await as(T, `select approve_user($1, 4)`, [B]);
ok(r.err?.includes('승인 대기 중인 사용자가 아닙니다'), '중복 승인 차단');
r = await as(T, `select appoint_role($1, 'vice')`, [A]);
ok(!r.err, '직책 임명(차장)');

// 4. 업로드·검증
r = await as(A, `select create_project('x', '', 'free', 3, $1::jsonb)`, [JSON.stringify([{ path: 'main.py', content: 'x' }])]);
ok(r.err?.includes('README'), 'README 필수');
r = await as(A, `select create_project('x', '', 'free', 3, $1::jsonb)`, [files({ '../evil.py': 'x' })]);
ok(r.err?.includes('잘못된 파일 경로'), '.. 경로 차단');
r = await as(A, `select create_project('x', '', 'free', 3, $1::jsonb)`, [files({ 'lib': 'x', 'lib/a.py': 'y' })]);
ok(r.err?.includes('겹칩니다'), '파일/폴더 이름 충돌 차단');
r = await as(A, `select create_project('로켓', '설명', 'free', 3, $1::jsonb) id`, [files({ 'lib/a.py': 'y' })]);
const P = r.rows?.[0]?.id; ok(P, '원본 업로드');

// 5. 직접 쓰기 차단
r = await as(B, `insert into projects (title, owner_id, root_id, permission) values ('x', $1, $1, 'free')`, [B]);
ok(!!r.err, '테이블 직접 insert 차단');
r = await as(B, `update projects set title = 'hacked' where id = $1`, [P]);
ok(!!r.err || (await as(A, `select title from projects where id = $1`, [P])).rows[0].title === '로켓', '테이블 직접 update 차단');

// 6. 수정본 → 새 버전 → 반영 요청 → 승인
r = await as(A, `select fork_project($1)`, [P]);
ok(r.err?.includes('내 프로젝트'), '자기 프로젝트 포크 차단');
r = await as(B, `select fork_project($1, '공기저항') id`, [P]);
const F = r.rows?.[0]?.id; ok(F, '수정본 생성');
r = await as(B, `select root_id, parent_id from projects where id = $1`, [F]);
ok(r.rows[0].root_id === P && r.rows[0].parent_id === P, '부모·최초 원본 연결');
r = await as(A, `select commit_version($1, $2::jsonb, '남의 것')`, [F, files({ 'x.py': '1' })]);
ok(r.err?.includes('작성자만'), '남의 프로젝트 새 버전 차단');
r = await as(B, `select create_merge_request($1, '바꿈')`, [F]);
ok(r.err?.includes('내용이 같아'), '변경 없는 반영 요청 차단');
r = await as(B, `select commit_version($1, $2::jsonb, '바뀐 점')`, [F, files({ 'lib/a.py': 'y', 'drag.py': 'k=1' })]);
ok(!r.err, '수정본 새 버전');
r = await as(B, `select commit_version($1, $2::jsonb, '같음')`, [F, files({ 'lib/a.py': 'y', 'drag.py': 'k=1' })]);
ok(r.err?.includes('바뀐 내용이 없습니다'), '동일 내용 커밋 차단');
r = await as(B, `select create_merge_request($1, '공기저항 추가') id`, [F]);
const M = r.rows?.[0]?.id; ok(M, '반영 요청');
r = await as(B, `select resolve_merge_request($1, true)`, [M]);
ok(r.err?.includes('원작자만'), '요청자가 스스로 승인 불가');
r = await as(A, `select resolve_merge_request($1, true)`, [M]);
ok(!r.err, '원작자 승인');
r = await as(A, `select (select count(*)::int from versions where project_id = $1) n,
  (select files from versions v join projects p on p.head_version_id = v.id where p.id = $1) f,
  (select array_agg(user_id) from contributors where project_id = $1) c`, [P]);
ok(r.rows[0].n === 2 && JSON.stringify(r.rows[0].f).includes('drag.py') && r.rows[0].c?.[0] === B, '원본 새 버전 + 기여자 등록');

// 7. 승인 필요 / 보기만
r = await as(A, `select create_project('급식', '', 'approval', 2, $1::jsonb) id`, [files()]);
const Q = r.rows[0].id;
r = await as(B, `select fork_project($1)`, [Q]);
ok(r.err?.includes('승인이 필요'), '승인 필요 프로젝트 바로 포크 차단');
r = await as(B, `select request_fork($1, 'GUI판', '해보고 싶어요')`, [Q]);
ok(!r.err, '수정본 요청');
r = await as(B, `select request_fork($1, 'GUI판', '또')`, [Q]);
ok(r.err?.includes('대기 중'), '중복 요청 차단');
r = await as(A, `select id from fork_requests where project_id = $1`, [Q]);
const FR = r.rows[0].id;
r = await as(A, `select update_project_info($1, null, null, 'view')`, [Q]);
r = await as(A, `select resolve_fork_request($1, true)`, [FR]);
ok(r.err?.includes('보기만'), '보기만으로 바뀐 뒤 승인 차단');
await as(A, `select update_project_info($1, null, null, 'approval')`, [Q]);
// 원작자가 졸업 → 운영진(부장)이 대신 처리
r = await as(T, `select set_user_status($1, 'graduated')`, [A]);
ok(!r.err, '졸업 처리');
r = await as(A, `select create_project('x', '', 'free', 1, $1::jsonb)`, [files()]);
ok(r.err?.includes('졸업생'), '졸업생 읽기 전용');
r = await as(A, `select count(*)::int n from projects`);
ok(r.rows[0].n >= 3, '졸업생도 열람 가능');
r = await as(T, `select resolve_fork_request($1, true)`, [FR]);
ok(!r.err, '졸업생 프로젝트는 운영진이 대신 승인');
r = await as(B, `select count(*)::int n from projects where parent_id = $1 and owner_id = $2`, [Q, B]);
ok(r.rows[0].n === 1, '승인 후 요청자 소유 수정본 생성');
await as(T, `select set_user_status($1, 'active')`, [A]);

// 8. 댓글
r = await as(B, `select v.id from versions v join projects p on p.head_version_id = v.id where p.id = $1`, [P]);
const PV = r.rows[0].id;
r = await as(B, `select add_comment($1, 'main.py', 99, 'x')`, [PV]);
ok(r.err?.includes('줄 번호'), '없는 줄 댓글 차단');
r = await as(B, `select add_comment($1, 'main.py', 1, '좋아요')`, [PV]);
ok(!r.err, '댓글');
r = await as(T, `select add_comment($1, 'main.py', 1, '저도요')`, [PV]);
r = await as(B, `select count(*)::int n from notifications where text like '%답했습니다%'`);
ok(r.rows[0].n === 1, '같은 줄 댓글 작성자에게 답글 알림');
r = await as(B, `select count(*)::int n from notifications where user_id <> $1`, [B]);
ok(r.rows[0].n === 0, '남의 알림은 안 보임');
r = await as(B, `select count(*)::int n from member_emails`);
ok(r.rows[0].n === 1, '부원은 본인 이메일만');
r = await as(T, `select count(*)::int n from member_emails`);
ok(r.rows[0].n === 3, '운영진은 이메일 전체');

// 9. 신고·숨김
r = await as(B, `select report_project($1, '표절')`, [Q]);
ok(!r.err, '신고');
r = await as(B, `select count(*)::int n from reports`);
ok(r.rows[0].n === 0, '부원은 신고 목록 못 봄');
r = await as(A, `select id from reports`);
const RP = r.rows[0].id;
r = await as(A, `select resolve_report($1, 'escalate')`, [RP]);
r = await as(A, `select resolve_report($1, 'hide')`, [RP]);
ok(r.err?.includes('관리자'), '넘긴 신고는 관리자만');
r = await as(T, `select resolve_report($1, 'hide')`, [RP]);
ok(!r.err, '관리자가 숨김 처리');
r = await as(B, `select count(*)::int n from projects where id = $1`, [Q]);
ok(r.rows[0].n === 0, '숨김 프로젝트는 부원에게 안 보임');
r = await as(B, `select count(*)::int n from tree_skeleton() where id = $1`, [Q]);
ok(r.rows[0].n === 1, '트리 뼈대에는 자리 남음');
r = await as(B, `select count(*)::int n from versions where project_id = $1`, [Q]);
ok(r.rows[0].n === 0, '숨김 프로젝트 코드 안 보임');
r = await as(T, `select count(*)::int n from projects where id = $1`, [Q]);
ok(r.rows[0].n === 1, '운영진은 숨김 프로젝트 보임');
r = await as(T, `select set_hidden($1, false, true)`, [Q]);
ok(r.rows[0].set_hidden === 2, '하위까지 숨김 해제(2개)');

// 10. 삭제
r = await as(A, `select delete_project($1)`, [P]);
ok(!r.err, '원본 삭제');
r = await as(B, `select deleted from projects where id = $1`, [P]);
ok(r.rows[0]?.deleted === true, '삭제된 원본은 자리로 남음');
r = await as(B, `select count(*)::int n from versions where project_id = $1`, [P]);
ok(r.rows[0].n === 0, '삭제된 원본 코드 안 보임');
r = await as(B, `select count(*)::int n from projects where id = $1 and not deleted`, [F]);
ok(r.rows[0].n === 1, '하위 수정본은 남음');
r = await as(B, `select count(*)::int n from notifications where text like '%삭제되었습니다%'`);
ok(r.rows[0].n === 1, '수정본 작성자에게 삭제 알림');
r = await as(A, `select delete_project($1)`, [P]);
ok(r.err?.includes('이미 삭제'), '중복 삭제 차단');

// 11. 거절 → 계정 삭제, 설정
const D = await signup('d@school.hs.kr', '디');
r = await as(T, `select reject_user($1)`, [D]);
ok(!r.err && (await db.query(`select count(*)::int n from auth.users where id = $1`, [D])).rows[0].n === 0, '가입 거절 시 계정 삭제');
r = await as(T, `select update_settings(p_signup_mode => 'whitelist', p_whitelist => array[' E@school.hs.kr ', ''])`);
ok(!r.err, '설정 변경');
ok((await signup('z@school.hs.kr', 'z')).includes('명단'), '명단 모드에서 명단 밖 차단');
ok(!(await signup('e@school.hs.kr', 'e')).startsWith('ERR'), '명단 모드에서 명단 안 가입');
r = await as(B, `select mark_all_notifications_read()`);
r = await as(B, `select count(*)::int n from notifications where not read`);
ok(r.rows[0].n === 0, '알림 모두 읽음');
r = await as(null, `select approve_user($1)`, [B]);
ok(!!r.err, '비로그인 RPC 차단');
r = await as(B, `select private.notify($1, 'x', 'y')`, [A]);
ok(!!r.err, 'private 함수 직접 호출 차단');

// 12. 리뷰 반영 항목
await as(T, `select update_settings(p_signup_mode => 'approval')`);
const prof = async (email) => (await db.query(`select count(*)::int n from profiles p join member_emails m on m.user_id = p.id where m.email = $1`, [email])).rows[0].n;
await db.query(`insert into auth.users (email, raw_app_meta_data) values ('f@school.hs.kr', '{"provider":"email"}')`);
ok(await prof('f@school.hs.kr') === 0, '이메일·비밀번호 가입은 프로필 없음(이용 불가)');
// 실제 Supabase 순서: 계정 생성(확인 전) → identity 생성 → 이메일 확인 UPDATE
const G = (await db.query(`insert into auth.users (email, raw_app_meta_data, email_confirmed_at) values ('g@school.hs.kr', '{}', null) returning id`)).rows[0].id;
ok(await prof('g@school.hs.kr') === 0, '확인 전에는 프로필 없음');
await db.query(`insert into auth.identities (user_id, provider) values ($1, 'google')`, [G]);
await db.query(`update auth.users set email_confirmed_at = now() where id = $1`, [G]);
ok(await prof('g@school.hs.kr') === 1, 'Google 확인 후 프로필 생성');
await db.query(`update auth.users set raw_user_meta_data = '{"x":1}' where id = $1`, [G]);
ok(await prof('g@school.hs.kr') === 1, '이후 UPDATE 에도 중복 생성 없음');
ok((await db.query(`insert into auth.users (email, raw_app_meta_data, email_confirmed_at) values ('h@other.kr', '{}', null)`).then(() => 'OK', (e) => e.message)).includes('학교 계정'), '확인 전이라도 다른 도메인은 즉시 차단');
r = await as(A, `select update_settings(p_domain => 'gmail.com')`);
ok(r.err?.includes('관리자만'), '운영진(차장)은 도메인 변경 불가');
r = await as(A, `select update_settings(p_domain => 'school.hs.kr', p_club_name => '새 이름')`);
ok(!r.err, '도메인을 그대로 두고 다른 설정 저장은 가능');
r = await as(T, `select update_settings(p_signup_mode => 'approval')`);
ok(!r.err, '관리자는 가입 방식 변경 가능');
const FV = (await as(B, `select head_version_id id from projects where id = $1`, [F])).rows[0].id;
r = await as(B, `select add_comment($1, 'main.py', 1, $2)`, [FV, 'x'.repeat(2001)]);
ok(r.err?.includes('2000자'), '댓글 길이 제한');
r = await as(B, `select report_project($1, '또 신고')`, [F]);
r = await as(B, `select report_project($1, '또 신고')`, [F]);
ok(r.err?.includes('이미 신고'), '중복 신고 차단');
await db.exec(`update private_settings set teacher_emails = array['Big@School.hs.kr'], whitelist = '{}'`);
const BIG = await signup('big@school.hs.kr', '대문자');
r = await as(BIG, `select array_agg(role order by role) roles from user_roles where member_id = $1`, [BIG]);
ok(JSON.stringify(r.rows[0]?.roles) === '["admin"]', '대소문자 섞인 부장 이메일도 인식 (이미 최고 관리자가 있으면 관리자)');

// 13. 용량 한도 (파일당 기본 2MB·최대 10MB 설정, 프로젝트 전체 10MB)
const big = (kb) => 'x'.repeat(kb * 1024);
r = await as(T, `select max_file_kb from settings`);
ok(r.rows[0].max_file_kb === 2048, '기본 파일당 한도 2MB');
r = await as(T, `select create_project('큰 파일', '', 'free', 1, $1::jsonb)`, [files({ 'data.txt': big(1500) })]);
ok(!r.err, '1.5MB 파일은 올라감');
r = await as(T, `select create_project('너무 큰 파일', '', 'free', 1, $1::jsonb)`, [files({ 'data.txt': big(2100) })]);
ok(r.err?.includes('용량 제한'), '파일당 2MB 초과 차단');
r = await as(T, `select update_settings(p_max_file_kb => 10240)`);
ok(!r.err, '파일당 한도 10MB까지 설정 가능');
r = await as(T, `select update_settings(p_max_file_kb => 10241)`);
ok(r.err?.includes('10240'), '10MB 초과 설정 차단');
r = await as(T, `select create_project('9MB', '', 'free', 1, $1::jsonb)`, [files({ 'a.txt': big(4500), 'b.txt': big(4500) })]);
ok(!r.err, '프로젝트 전체 9MB는 올라감');
r = await as(T, `select create_project('11MB', '', 'free', 1, $1::jsonb)`, [files({ 'a.txt': big(5600), 'b.txt': big(5600) })]);
ok(r.err?.includes('10MB'), '프로젝트 전체 10MB 초과 차단');
r = await db.query(`select pg_get_constraintdef(oid) d from pg_constraint where conname = 'settings_max_file_kb_check'`);
ok(r.rows.length === 1 && r.rows[0].d.includes('10240'), '설정 제약이 10MB 범위로 하나만 걸림');

// =====================================================================
// v2.0: 회원·계정 분리, 복수 직책, 운영 연도·차시, 서버 상태
// =====================================================================
const J = JSON.stringify;
const asAnon = async (sql, params = []) => {
  await db.exec(`set role anon`);
  try { return { rows: (await db.query(sql, params)).rows }; }
  catch (e) { return { err: e.message }; }
  finally { await db.exec(`reset role`); }
};
const newMember = async (email, name) => {
  const id = await signup(email, name);
  const rr = await as(T, `select approve_user($1, 5)`, [id]);
  if (rr.err) console.log('newMember 승인 실패', email, rr.err);
  return id;
};
const rolesOf = async (id) => (await db.query(`select array_agg(role order by role) r from user_roles where member_id = $1`, [id])).rows[0].r || [];
const cnt = async (sql, params = []) => (await db.query(`select count(*)::int n from (${sql}) x`, params)).rows[0].n;
const curYear = (await db.query(`select private.year_of(now()) y`)).rows[0].y;

// 14. 회원 번호·기본 구조
ok(await cnt(`select 1 from profiles where member_no !~ '^POP-[0-9]{4}$'`) === 0, '회원 번호는 POP-0000 형식');
ok((await db.query(`select member_no from profiles where id = $1`, [T])).rows[0].member_no === 'POP-0001', '첫 회원은 POP-0001');
ok(await cnt(`select 1 from profiles p where not exists (select 1 from user_accounts u where u.member_id = p.id)`) === 0, '모든 회원에 로그인 계정 연결이 있음');
r = await as(T, `select private.my_member_id() m`);
ok(r.rows[0].m === T, 'my_member_id: 로그인 계정 → 회원');

// 15. 복수 직책은 합산된다
const P1 = await newMember('p1@school.hs.kr', '피원');
const P2 = await newMember('p2@school.hs.kr', '피투');
r = await as(P1, `select count(*)::int n from private_settings`);
ok(r.rows[0].n === 0, '직책 없는 부원은 운영진 자료를 못 봄');
r = await as(BIG, `select appoint_role($1, 'president')`, [P1]);
ok(!r.err, '관리자가 부장 임명');
r = await as(P1, `select count(*)::int n from private_settings`);
ok(r.rows[0].n === 1, '부장은 운영진 권한을 가짐');
r = await as(P1, `select server_status()`);
ok(r.err?.includes('권한'), '부장은 서버 상태 상세를 못 봄');
r = await as(BIG, `select appoint_role($1, 'server')`, [P1]);
ok(!r.err, '서버 관리자도 함께 임명');
ok(J(await rolesOf(P1)) === '["president","server"]', '직책을 여러 개 함께 가짐');
r = await as(P1, `select server_status() s`);
ok(!r.err && Number(r.rows[0].s.db_size) > 0, '서버 직책: 서버 상태 상세를 봄');
r = await as(P1, `select count(*)::int n from private_settings`);
ok(r.rows[0].n === 1, '서버 직책을 더해도 부장의 운영진 권한은 유지(합산)');
r = await as(P1, `select count(*)::int n from notifications where text like '%직책이 부여%'`);
ok(r.rows[0].n === 2, '임명된 회원에게 알림');
r = await as(BIG, `select appoint_role($1, 'president')`, [P1]);
ok(r.err?.includes('이미'), '이미 가진 직책 중복 임명 차단');

// 부장 양도: 새 보유자를 정하면 기존 보유자는 그 직책만 내려놓는다
r = await as(BIG, `select appoint_role($1, 'president')`, [P2]);
ok(!r.err, '부장 양도(새 부장 임명)');
ok(J(await rolesOf(P1)) === '["server"]' && J(await rolesOf(P2)) === '["president"]', '기존 부장은 부장만 내려놓고 서버 관리자는 유지');
r = await as(P1, `select count(*)::int n from notifications where text like '%넘어갔습니다%'`);
ok(r.rows[0].n === 1, '기존 부장에게 알림');
r = await as(P1, `select count(*)::int n from private_settings`);
ok(r.rows[0].n === 0, '부장 직책을 잃으면 운영진 권한도 사라짐');
r = await as(BIG, `select appoint_role($1, 'vice')`, [P2]);
ok(!r.err && J(await rolesOf(P2)) === '["president","vice"]', '부장과 차장을 같은 사람이 맡을 수 있음');
ok(J(await rolesOf(A)) === '[]', '차장 양도로 기존 차장(A)은 일반 부원');
r = await as(A, `select count(*)::int n from private_settings`);
ok(r.rows[0].n === 0, '기존 차장은 운영진 권한을 잃음');

// 관리자 임명은 최고 관리자만
r = await as(BIG, `select appoint_role($1, 'admin')`, [P1]);
ok(r.err?.includes('최고 관리자만'), '관리자는 관리자를 임명할 수 없음');
r = await as(T, `select appoint_role($1, 'owner')`, [P1]);
ok(!!r.err, '최고 관리자는 임명 기능으로 만들 수 없음');
r = await as(P2, `select appoint_role($1, 'vice')`, [B]);
ok(r.err?.includes('관리자 권한'), '부장·차장은 직책을 임명할 수 없음');
r = await as(T, `select appoint_role($1, 'admin')`, [P1]);
ok(!r.err, '최고 관리자가 관리자 임명');
r = await as(BIG, `select revoke_role($1, 'admin')`, [P1]);
ok(r.err?.includes('최고 관리자만'), '관리자는 관리자를 해임할 수 없음');
r = await as(T, `select revoke_role($1, 'admin')`, [P1]);
ok(!r.err, '최고 관리자가 관리자 해임');
r = await as(T, `select revoke_role($1, 'owner')`, [T]);
ok(!!r.err, '최고 관리자 직책은 해임 기능으로 못 뺌');
r = await as(P2, `select revoke_role($1, 'server')`, [P1]);
ok(!!r.err, '부장은 서버 관리자를 해임할 수 없음');
r = await as(BIG, `select revoke_role($1, 'president')`, [A]);
ok(r.err?.includes('가진 회원이 아닙니다'), '없는 직책 해임 차단');
r = await as(BIG, `select revoke_role($1, 'server')`, [P1]);
ok(!r.err && J(await rolesOf(P1)) === '[]', '서버 관리자 해임');
const H = await signup('h2@school.hs.kr', '대기');
r = await as(T, `select appoint_role($1, 'vice')`, [H]);
ok(r.err?.includes('활동 중인'), '승인 대기 회원에게는 직책 불가');

// 마지막 관리자 보호
await db.exec(`delete from user_roles where role = 'admin' and member_id = '${BIG}'`);   // 시험용: 관리자를 T 한 명만 남김
r = await as(P2, `select set_user_status($1, 'graduated')`, [T]);
ok(r.err?.includes('마지막 관리자'), '마지막 관리자는 졸업 처리 불가');
r = await as(T, `select appoint_role($1, 'admin')`, [BIG]);
ok(!r.err, '관리자 다시 임명');
r = await as(P2, `select set_user_status($1, 'graduated')`, [BIG]);
ok(r.err?.includes('관리자만'), '부장은 관리자 계정의 상태를 바꿀 수 없음');
r = await as(BIG, `select set_user_status($1, 'graduated')`, [T]);
ok(r.err?.includes('최고 관리자만'), '관리자는 최고 관리자를 졸업 처리할 수 없음');
r = await as(T, `select revoke_role($1, 'admin')`, [T]);
ok(!r.err && J(await rolesOf(T)) === '["owner"]', '최고 관리자가 자기 관리자 직책만 내려놓아도 최고 관리자로 남음');
r = await as(T, `select appoint_role($1, 'admin')`, [T]);
ok(!r.err && J(await rolesOf(T)) === '["admin","owner"]', '다시 관리자 겸임');

// 16. 서버 관리자: 개인정보·관리 기능 불가, 세부 권한은 관리자가 조절
const SV = await newMember('sv@school.hs.kr', '서버');
r = await as(SV, `select server_status()`);
ok(r.err?.includes('권한'), '직책 없는 부원은 서버 상태 상세를 못 봄');
await as(BIG, `select appoint_role($1, 'server')`, [SV]);
await db.exec(`insert into system_status (kind, ok, detail) values ('backup', true, '{"size":1}'), ('error', false, '{"msg":"x"}')`);
r = await as(SV, `select server_status() s`);
ok(!r.err && Number(r.rows[0].s.counts.profiles) > 0 && r.rows[0].s.backup?.ok === true && r.rows[0].s.errors.length === 1, '서버 관리자: 상세 상태·백업·오류 기록');
ok(!J(r.rows[0].s).includes('@'), '서버 상태에는 이메일이 들어 있지 않음');
r = await as(SV, `select count(*)::int n from member_emails`);
ok(r.rows[0].n === 1, '서버 관리자는 다른 회원 이메일을 못 읽음');
r = await as(SV, `select count(*)::int n from user_accounts`);
ok(r.rows[0].n === 1, '서버 관리자는 계정 연결 목록(이메일)을 못 읽음');
r = await as(SV, `select count(*)::int n from audit_logs`);
ok(r.rows[0].n === 0, '서버 관리자는 감사 기록을 못 읽음');
r = await as(SV, `select count(*)::int n from private_settings`);
ok(r.rows[0].n === 0, '서버 관리자는 명단 설정을 못 읽음');
r = await as(SV, `select appoint_role($1, 'vice')`, [B]);
ok(!!r.err, '서버 관리자는 직책을 임명할 수 없음');
r = await as(SV, `select update_settings(p_club_name => '해킹')`);
ok(r.err?.includes('운영진'), '서버 관리자는 설정을 바꿀 수 없음');
r = await as(SV, `select invite_account($1, 'sv-x@school.hs.kr')`, [B]);
ok(r.err?.includes('계정 연결 권한'), '서버 관리자는 계정 연결을 할 수 없음');
r = await as(SV, `select set_role_permission('server', 'server.detail', true)`);
ok(!!r.err, '서버 관리자는 권한 설정을 바꿀 수 없음');
r = await as(T, `select set_role_permission('server', 'server.backup', false)`);
ok(!r.err, '관리자가 서버 관리자의 백업 확인 권한을 끔');
r = await as(SV, `select server_status() s`);
ok(!r.err && r.rows[0].s.backup === null && r.rows[0].s.errors !== null, '끈 세부 권한은 숨겨지고 나머지는 유지');
await as(T, `select set_role_permission('server', 'server.detail', false)`);
r = await as(SV, `select server_status()`);
ok(r.err?.includes('권한'), '상세 권한을 끄면 서버 관리자도 못 봄');
r = await as(T, `select server_status() s`);
ok(!r.err && r.rows[0].s.backup?.ok === true, '관리자는 항상 서버 상태를 봄');
r = await as(T, `select set_role_permission('server', 'accounts.link', true)`);
ok(r.err?.includes('설정할 수 없는'), '서버 관리자에게 계정 연결 권한은 줄 수 없음');
r = await as(T, `select set_role_permission('vice', 'server.detail', true)`);
ok(!!r.err, '목록에 없는 권한은 설정 불가');
r = await as(B, `select set_role_permission('server', 'server.detail', true)`);
ok(!!r.err, '일반 부원은 권한 설정 불가');
await as(T, `select set_role_permission('server', 'server.detail', true)`);
await as(T, `select set_role_permission('server', 'server.backup', true)`);
r = await as(SV, `select count(*)::int n from notifications where text like '%권한이 바뀌었습니다%'`);
ok(r.rows[0].n >= 1, '권한 변경은 해당 직책 보유자에게 알림');
r = await as(B, `select server_status()`);
ok(r.err?.includes('권한'), '일반 부원은 서버 상태 상세를 못 봄');

// 부장·차장에게 위임 (계정 연결)
r = await as(P2, `select invite_account($1, 'deleg@school.hs.kr')`, [B]);
ok(r.err?.includes('계정 연결 권한'), '위임 전: 부장은 계정 연결 불가');
await as(T, `select set_role_permission('president', 'accounts.link', true)`);
r = await as(P2, `select invite_account($1, 'deleg@school.hs.kr')`, [B]);
ok(!r.err, '위임 후: 부장이 계정 연결(사전 등록) 가능');
r = await as(P2, `select count(*)::int n from user_accounts`);
ok(r.rows[0].n > 1, '위임받은 부장은 계정 연결 목록을 봄');
r = await as(P2, `select invite_account($1, 'steal@school.hs.kr')`, [T]);
ok(r.err?.includes('관리자만'), '위임받은 부장도 최고 관리자 회원에는 계정을 사전 등록할 수 없음');
r = await as(P2, `select update_settings(p_max_file_kb => 1000)`);
ok(r.err?.includes('관리자만'), '부장은 파일 용량 제한을 바꿀 수 없음');
await as(T, `select set_role_permission('president', 'accounts.link', false)`);
r = await as(P2, `select invite_account($1, 'deleg2@school.hs.kr')`, [B]);
ok(r.err?.includes('계정 연결 권한'), '위임을 끄면 다시 불가');
await db.exec(`delete from account_invites`);

// 17. 계정 연결: 사전 등록 → 새 계정이 기존 회원에 붙는다
const MM = await newMember('m@school.hs.kr', '엠');
r = await as(MM, `select create_project('엠 프로젝트', '', 'free', 5, $1::jsonb) id`, [files()]);
const MP = r.rows[0].id;
r = await as(T, `select invite_account($1, 'x@gmail.com')`, [MM]);
ok(r.err?.includes('학교 계정'), '다른 도메인은 사전 등록 불가');
r = await as(T, `select invite_account($1, 'm-new@school.hs.kr')`, [MM]);
ok(!r.err, '사전 등록');
r = await as(T, `select invite_account($1, 'm@school.hs.kr')`, [B]);
ok(r.err?.includes('이미 가입'), '이미 쓰이는 계정은 사전 등록 불가');
r = await as(T, `select invite_account($1, 'm-new@school.hs.kr')`, [B]);
ok(r.err?.includes('다른 회원'), '다른 회원에게 등록된 이메일은 중복 등록 불가');
r = await as(B, `select invite_account($1, 'b-new@school.hs.kr')`, [B]);
ok(r.err?.includes('계정 연결 권한'), '일반 부원은 사전 등록 불가');
const profilesBefore = await cnt(`select 1 from profiles`);
const MM2 = await signup('m-new@school.hs.kr', '엠 새계정');
ok(!String(MM2).startsWith('ERR'), '사전 등록된 새 계정으로 가입(첫 로그인)');
ok(await cnt(`select 1 from profiles`) === profilesBefore, '새 회원이 만들어지지 않음');
ok(await cnt(`select 1 from profiles where name = '엠 새계정'`) === 0, '이름이 달라도 사전 등록 이메일로 기존 회원에 연결');
ok(await cnt(`select 1 from user_accounts where member_id = '${MM}' and status = 'active'`) === 2, '한 회원에 계정 두 개');
ok(await cnt(`select 1 from account_invites where email = 'm-new@school.hs.kr'`) === 0, '사전 등록은 사용되고 사라짐');
r = await as(MM2, `select private.my_member_id() m`);
ok(r.rows[0].m === MM, '새 계정으로 로그인해도 같은 회원');
r = await as(MM2, `select create_project('새 계정으로 올림', '', 'free', 5, $1::jsonb) id`, [files()]);
ok(!r.err && (await db.query(`select owner_id from projects where id = $1`, [r.rows[0].id])).rows[0].owner_id === MM, '새 계정으로 올린 프로젝트도 같은 회원 소유');
r = await as(MM2, `select count(*)::int n from projects where owner_id = $1`, [MM]);
ok(r.rows[0].n === 2, '기존 프로젝트가 그대로 이어짐');
ok(await cnt(`select 1 from audit_logs where action = 'account.linked'`) >= 1, '계정 연결이 감사 기록에 남음');
r = await as(MM2, `select count(*)::int n from notifications where text like '%연결되었습니다%'`);
ok(r.rows[0].n === 1, '연결 알림');

// 승인 대기 회원 병합
const PM = await signup('late@school.hs.kr', '늦은');
const PMID = '00000000-0000-0000-0000-0000000000aa';
await db.exec(`insert into projects (id, title, owner_id, root_id, permission) values ('${PMID}', 'x', '${PM}', '${PMID}', 'free')`);
r = await as(T, `select link_account($1, $2)`, [PM, MM]);
ok(r.err?.includes('올린 기록'), '기록이 있는 대기 회원은 병합 불가');
await db.exec(`delete from projects where id = '${PMID}'`);
r = await as(MM, `select link_account($1, $2)`, [PM, MM]);
ok(!!r.err, '일반 부원은 병합 불가');
r = await as(T, `select link_account($1, $2)`, [B, MM]);
ok(r.err?.includes('승인 대기'), '승인된 회원은 병합 대상(대기 회원)이 될 수 없음');
r = await as(T, `select link_account($1, $2)`, [PM, PM]);
ok(!!r.err, '같은 회원끼리 병합 불가');
r = await as(T, `select link_account($1, $2)`, [PM, MM]);
ok(!r.err, '대기 회원의 계정을 기존 회원에 연결');
ok(await cnt(`select 1 from profiles where id = '${PM}'`) === 0, '빈 대기 회원은 정리됨');
r = await as(PM, `select private.my_member_id() m`);
ok(r.rows[0].m === MM, '병합된 계정은 기존 회원으로 로그인');
ok(await cnt(`select 1 from audit_logs where action = 'account.merged'`) === 1, '병합이 감사 기록에 남음');

// 연결 해제: 마지막 계정은 불가
r = await as(MM, `select unlink_account($1)`, [PM]);
ok(!!r.err, '일반 부원은 연결 해제 불가');
r = await as(T, `select unlink_account($1)`, [PM]);
ok(!r.err, '연결 해제');
r = await as(PM, `select private.my_member_id() m`);
ok(r.rows[0].m === null, '해제된 계정은 회원으로 인식되지 않음');
r = await as(T, `select unlink_account($1)`, [MM2]);
ok(!r.err, '두 번째 계정 연결 해제');
r = await as(T, `select unlink_account($1)`, [MM]);
ok(r.err?.includes('마지막'), '마지막 계정은 해제 불가');
ok(await cnt(`select 1 from audit_logs where action = 'account.unlinked'`) === 2, '연결 해제가 감사 기록에 남음');

// 로그인 계정이 지워져도 회원은 남는다
const GONE = await newMember('gone@school.hs.kr', '사라짐');
await as(GONE, `select create_project('남는 프로젝트', '', 'free', 5, $1::jsonb)`, [files()]);
await db.query(`delete from auth.users where id = $1`, [GONE]);
ok(await cnt(`select 1 from profiles where id = '${GONE}'`) === 1, '로그인 계정을 지워도 회원은 남음');
ok(await cnt(`select 1 from projects where owner_id = '${GONE}'`) === 1, '프로젝트 소유도 그대로');
ok(await cnt(`select 1 from user_accounts where member_id = '${GONE}' and status = 'removed'`) === 1, '계정 연결은 "삭제됨"으로 표시');
r = await as(GONE, `select private.my_member_id() m`);
ok(r.rows[0].m === null, '삭제된 계정은 로그인 불가');

// 18. 운영 연도·차시
const yq = async (ts) => (await db.query(`select private.year_of($1::timestamptz) y`, [ts])).rows[0].y;
ok(await yq('2027-02-28 23:59:00+09') === 2026, '2027-02-28 23:59 KST → 2026 운영 연도');
ok(await yq('2027-03-01 00:00:00+09') === 2027, '2027-03-01 00:00 KST → 2027 운영 연도');
ok(await yq('2027-02-28 14:59:59+00') === 2026 && await yq('2027-02-28 15:00:00+00') === 2027, 'UTC 로 줄 때도 한국 시간 기준');
ok(await yq('2028-02-29 12:00:00+09') === 2027, '윤년 2월 29일은 전년도 운영 연도');
ok(await yq('2026-12-31 23:00:00+09') === 2026 && await yq('2027-01-15 00:00:00+09') === 2026, '연말·연초는 같은 운영 연도');
for (let i = 0; i < 3; i++) { r = await as(B, `select public.ensure_academic_year() y`); }
ok(!r.err && r.rows[0].y === curYear, 'ensure_academic_year 는 일반 부원도 호출 가능, 현재 연도 반환');
ok(await cnt(`select 1 from academic_years where year = ${curYear}`) === 1, '여러 번 불러도 연도 1행');
ok(await cnt(`select 1 from sessions where year = ${curYear}`) === 10, '여러 번 불러도 차시 10개');
ok(await cnt(`select 1 from academic_years where status = 'current'`) === 1, '현재 연도는 하나');
ok(await cnt(`select 1 from membership_history where year = ${curYear} and member_id = '${A}'`) === 1, '활동 회원은 현재 연도 명단에 있음');
r = await as(null, `select count(*)::int n from sessions`);
ok(r.rows[0].n === 0, '로그인하지 않으면 차시도 못 봄');
r = await as(B, `select count(*)::int n from sessions`);
ok(r.rows[0].n >= 10, '부원은 차시를 봄');
// 지난 연도: 프로젝트가 있던 해는 목록·차시가 생기고 보관됨
r = await as(B, `select create_project('옛날 작품', '', 'free', 5, $1::jsonb) id`, [files()]);
const OLD = r.rows[0].id;
await db.exec(`update projects set year = 2025 where id = '${OLD}'`);
await as(B, `select public.ensure_academic_year()`);
ok(await cnt(`select 1 from academic_years where year = 2025 and status = 'archived'`) === 1, '프로젝트가 있는 지난 연도는 보관 상태로 생김');
ok(await cnt(`select 1 from sessions where year = 2025`) === 10, '지난 연도에도 1~10차시');
ok(await cnt(`select 1 from academic_years where status = 'current'`) === 1, '현재 연도는 여전히 하나');
ok(await cnt(`select 1 from projects where id = '${OLD}'`) === 1, '연도 정리는 기존 데이터를 지우지 않음');
ok((await db.query(`select year from projects where id = '${P}'`)).rows[0].year === curYear, '새 프로젝트의 운영 연도는 업로드 시점으로 정해짐');
const S25 = (await db.query(`select id from sessions where year = 2025 and no = 1`)).rows[0].id;
const SCUR = (await db.query(`select id from sessions where year = ${curYear} and no = 1`)).rows[0].id;
// 차시 수정
r = await as(B, `select update_session($1, '1차시 오리엔테이션', '2026-03-10', '첫 모임')`, [SCUR]);
ok(r.err?.includes('운영진'), '일반 부원은 차시 수정 불가');
r = await as(P2, `select update_session($1, '1차시 오리엔테이션', '2026-03-10', '첫 모임')`, [SCUR]);
ok(!r.err && (await db.query(`select title, held_on::text d from sessions where id = $1`, [SCUR])).rows[0].title === '1차시 오리엔테이션', '운영진(부장)은 현재 연도 차시 수정');
r = await as(P2, `select update_session($1, '  ', null, '')`, [SCUR]);
ok(r.err?.includes('제목'), '차시 제목은 비울 수 없음');
r = await as(P2, `select update_session($1, '고침', null, '')`, [S25]);
ok(r.err?.includes('관리자만'), '지난 연도 차시는 운영진도 수정 불가');
r = await as(BIG, `select update_session($1, '2025 1차시', '2025-03-10', '옛 기록')`, [S25]);
ok(!r.err, '관리자는 지난 연도 차시 수정');
ok(await cnt(`select 1 from audit_logs where action = 'session.updated_past'`) === 1, '지난 연도 수정은 감사 기록에 남음');
// 프로젝트 ↔ 차시 연결
r = await as(B, `select link_project_session($1, $2)`, [MP, SCUR]);
ok(r.err?.includes('작성자 또는 운영진'), '남의 프로젝트는 차시에 연결 불가');
r = await as(MM, `select link_project_session($1, $2)`, [MP, SCUR]);
ok(!r.err, '작성자가 현재 연도 차시에 연결');
r = await as(P2, `select link_project_session($1, $2)`, [MP, SCUR]);
ok(!r.err && await cnt(`select 1 from project_sessions where project_id = '${MP}'`) === 1, '운영진도 연결 가능, 중복 연결은 한 번만');
r = await as(MM, `select link_project_session($1, $2)`, [MP, S25]);
ok(r.err?.includes('관리자만'), '작성자도 지난 연도 차시에는 연결 불가');
r = await as(BIG, `select link_project_session($1, $2)`, [MP, S25]);
ok(!r.err && await cnt(`select 1 from audit_logs where action = 'session.link_past'`) === 1, '관리자는 지난 연도 차시에 연결(감사 기록)');
r = await as(B, `select count(*)::int n from project_sessions`);
ok(r.rows[0].n === 2, '부원은 연결 현황을 봄');
r = await as(MM, `select unlink_project_session($1, $2)`, [MP, S25]);
ok(!!r.err, '작성자도 지난 연도 연결은 해제 불가');
r = await as(MM, `select unlink_project_session($1, $2)`, [MP, SCUR]);
ok(!r.err && await cnt(`select 1 from project_sessions where project_id = '${MP}'`) === 1, '연결 해제');
r = await as(BIG, `select unlink_project_session($1, $2)`, [MP, S25]);
ok(!r.err && await cnt(`select 1 from audit_logs where action = 'session.unlink_past'`) === 1, '관리자는 지난 연도 연결 해제(감사 기록)');
r = await as(B, `select link_project_session($1, $2)`, [Q, SCUR]);
ok(!!r.err, '숨김 프로젝트는 일반 부원이 연결할 수 없음');
// 연도별 회원 기록
r = await as(B, `select upsert_membership($1, ${curYear}, 5, 2)`, [B]);
ok(r.err?.includes('관리자 권한'), '일반 부원은 명단 수정 불가');
r = await as(T, `select upsert_membership($1, ${curYear}, 5, 2)`, [B]);
ok(!r.err && (await db.query(`select grade from membership_history where member_id = $1 and year = ${curYear}`, [B])).rows[0].grade === 2, '관리자가 연도별 학년 기록');
r = await as(T, `select upsert_membership($1, 2025, 5, 1)`, [B]);
ok(!r.err && await cnt(`select 1 from audit_logs where action = 'membership.updated_past'`) === 1, '지난 연도 명단 수정은 감사 기록에 남음');
ok(await cnt(`select 1 from membership_history where member_id = '${B}'`) === 2, '연도별 기록은 연도마다 따로 저장됨');
r = await as(T, `select upsert_membership($1, 2020, 5, 1)`, [B]);
ok(r.err?.includes('운영 연도가 없습니다'), '없는 연도는 거절');
r = await as(T, `select upsert_membership($1, ${curYear}, 5, 9)`, [B]);
ok(r.err?.includes('학년'), '학년 범위 검사');

// 19. 서버 상태: 누구나 연결 확인, 기록은 10분에 한 번
r = await asAnon(`select public.ping() p`);
ok(!r.err && r.rows[0].p.ok === true && !!r.rows[0].p.now, '로그인 없이 연결 확인(ping)');
await asAnon(`select public.ping()`);
await as(B, `select public.ping()`);
ok(await cnt(`select 1 from system_status where kind = 'ping'`) === 1, 'ping 기록은 10분에 한 번만 남음');
await db.exec(`update system_status set at = now() - interval '11 minutes' where kind = 'ping'`);
await asAnon(`select public.ping()`);
ok(await cnt(`select 1 from system_status where kind = 'ping'`) === 2, '10분이 지나면 다시 기록');
r = await asAnon(`select count(*)::int n from system_status`);
ok(!!r.err || r.rows[0].n === 0, '상태 기록 테이블은 직접 읽을 수 없음');
r = await as(T, `select count(*)::int n from system_status`);
ok(!!r.err || r.rows[0].n === 0, '관리자도 상태 기록은 server_status 로만 봄');
r = await asAnon(`select public.server_status()`);
ok(!!r.err, '로그인 없이는 서버 상태 상세 불가');
r = await asAnon(`select public.ensure_academic_year()`);
ok(!!r.err, '로그인 없이는 연도 전환 불가');
r = await asAnon(`insert into system_status (kind) values ('ping')`);
ok(!!r.err, '상태 기록 직접 쓰기 불가');

// 20. 최고 관리자 이양 (2단계)
r = await as(BIG, `select propose_owner_transfer($1)`, [P1]);
ok(r.err?.includes('최고 관리자만'), '관리자는 이양을 제안할 수 없음');
r = await as(T, `select propose_owner_transfer($1)`, [T]);
ok(r.err?.includes('자기 자신'), '자기 자신에게 이양 불가');
r = await as(T, `select propose_owner_transfer($1)`, [H]);
ok(r.err?.includes('활동 중인'), '대기 회원에게 이양 불가');
r = await as(T, `select propose_owner_transfer($1) id`, [P1]);
const OT1 = r.rows?.[0]?.id; ok(OT1, '이양 제안');
r = await as(T, `select propose_owner_transfer($1)`, [B]);
ok(r.err?.includes('진행 중'), '진행 중인 제안이 있으면 새 제안 불가');
ok(J(await rolesOf(T)) === '["admin","owner"]' && J(await rolesOf(P1)) === '[]', '제안만으로는 직책이 바뀌지 않음');
r = await as(P1, `select count(*)::int n from notifications where text like '%이양을 제안%'`);
ok(r.rows[0].n === 1, '받는 사람에게 알림');
r = await as(T, `select accept_owner_transfer($1)`, [OT1]);
ok(r.err?.includes('본인만'), '제안한 사람이 스스로 수락할 수 없음');
r = await as(BIG, `select accept_owner_transfer($1)`, [OT1]);
ok(r.err?.includes('본인만'), '제3자는 수락할 수 없음');
r = await as(B, `select count(*)::int n from owner_transfers`);
ok(r.rows[0].n === 0, '관련 없는 부원은 이양 제안을 못 봄');
r = await as(P1, `select count(*)::int n from owner_transfers`);
ok(r.rows[0].n === 1, '받는 사람은 제안을 봄');
r = await as(B, `select cancel_owner_transfer($1)`, [OT1]);
ok(r.err?.includes('제안한 사람 또는 받은 사람'), '제3자는 취소할 수 없음');
r = await as(P1, `select cancel_owner_transfer($1)`, [OT1]);
ok(!r.err, '받는 사람이 거절(취소)');
ok(J(await rolesOf(T)) === '["admin","owner"]', '취소해도 직책 변화 없음');
r = await as(P1, `select accept_owner_transfer($1)`, [OT1]);
ok(r.err?.includes('이미 처리'), '취소된 제안은 수락 불가');
r = await as(T, `select propose_owner_transfer($1) id`, [P1]);
const OT2 = r.rows[0].id;
r = await as(T, `select cancel_owner_transfer($1)`, [OT2]);
ok(!r.err, '제안한 사람이 수락 전에 취소');
r = await as(T, `select propose_owner_transfer($1) id`, [P1]);
const OT3 = r.rows[0].id;
r = await as(P1, `select accept_owner_transfer($1)`, [OT3]);
ok(!r.err, '받는 사람이 본인 계정으로 수락');
ok(J(await rolesOf(P1)) === '["admin","owner"]', '새 최고 관리자는 관리자도 가짐');
ok(J(await rolesOf(T)) === '["admin"]', '이전 최고 관리자는 관리자 직책을 유지');
r = await as(T, `select propose_owner_transfer($1)`, [B]);
ok(r.err?.includes('최고 관리자만'), '이양 후 이전 최고 관리자는 더 이상 이양 불가');
r = await as(T, `select appoint_role($1, 'admin')`, [B]);
ok(r.err?.includes('최고 관리자만'), '이양 후 이전 최고 관리자는 관리자 임명 불가');
r = await as(P1, `select appoint_role($1, 'admin')`, [B]);
ok(!r.err, '새 최고 관리자는 관리자 임명 가능');
ok(await cnt(`select 1 from owner_transfers where status = 'accepted'`) === 1 && await cnt(`select 1 from owner_transfers where status = 'cancelled'`) === 2, '이양 제안 상태 기록');
ok(await cnt(`select 1 from audit_logs where action = 'owner.transferred'`) === 1, '이양이 감사 기록에 남음');

// 21. 감사 기록
r = await as(MM, `select count(*)::int n from audit_logs`);
ok(r.rows[0].n === 0, '일반 부원은 감사 기록을 못 봄');
r = await as(P2, `select count(*)::int n from audit_logs`);
ok(r.rows[0].n === 0, '부장·차장도 감사 기록을 못 봄');
r = await as(T, `select count(*)::int n from audit_logs`);
ok(r.rows[0].n > 10, '관리자는 감사 기록을 봄');
ok(await cnt(`select 1 from audit_logs where action in ('role.appointed', 'role.revoked', 'settings.updated', 'member.status', 'member.approved', 'role.permission', 'project.hidden')`) >= 7, '주요 변경이 감사 기록에 남음');
r = await as(T, `delete from audit_logs`);
ok(!!r.err, '관리자도 감사 기록을 지울 수 없음');
r = await as(T, `update audit_logs set action = 'x'`);
ok(!!r.err, '관리자도 감사 기록을 고칠 수 없음');
r = await db.query(`delete from audit_logs`).then(() => 'OK', (e) => e.message);
ok(r.includes('지울 수 없습니다'), '서버(DB) 안에서도 감사 기록은 수정·삭제 불가');
r = await db.query(`truncate audit_logs`).then(() => 'OK', (e) => e.message);
ok(r.includes('지울 수 없습니다'), '감사 기록 비우기도 불가');

// 22. 최후 복구: SQL 편집기에서만
r = await as(T, `select private.emergency_grant_owner('POP-0001')`);
ok(!!r.err, '로그인한 관리자도 emergency_grant_owner 를 호출할 수 없음');
r = await asAnon(`select private.emergency_grant_owner('POP-0001')`);
ok(!!r.err, '비로그인도 호출 불가');
const noB = (await db.query(`select member_no from profiles where id = $1`, [B])).rows[0].member_no;
r = await db.query(`select private.emergency_grant_owner('POP-9999')`).then(() => 'OK', (e) => e.message);
ok(r.includes('찾을 수 없'), '없는 회원 번호는 거절');
await db.query(`select private.emergency_grant_owner($1)`, [noB]);
ok(J(await rolesOf(B)) === '["admin","owner"]', '긴급 복구: 회원 번호로 최고 관리자 + 관리자 부여');
ok(await cnt(`select 1 from audit_logs where action = 'role.emergency_owner'`) === 1, '긴급 복구가 감사 기록에 남음');

// =====================================================================
// v2.1: 2단계 — 파일 저장소(Storage), 팀 프로젝트, 게시판·공지
// =====================================================================
const putObj = (name, size = 1000, mime = 'application/pdf') =>
  db.query(`insert into storage.objects (bucket_id, name, metadata) values ('pop-files', $1, $2)`, [name, { size, mimetype: mime }]);
const objCount = async (uid, name) => (await as(uid, `select count(*)::int n from storage.objects where name = $1`, [name])).rows?.[0]?.n ?? -1;
const uuidv = () => crypto.randomUUID();
const TL = await newMember('tl@school.hs.kr', '팀장');
const TM = await newMember('tm@school.hs.kr', '팀원');
const TX = await newMember('tx@school.hs.kr', '외부부원');
const ST = await newMember('st@school.hs.kr', '운영');
const SV2 = await newMember('sv2@school.hs.kr', '서버지기');
await as(T, `select appoint_role($1, 'president')`, [ST]);
await as(T, `select appoint_role($1, 'server')`, [SV2]);

// 24. 저장소 설정
r = await db.query(`select public, file_size_limit from storage.buckets where id = 'pop-files'`);
ok(r.rows.length === 1 && r.rows[0].public === false, 'pop-files 버킷은 비공개로 만들어짐');
ok(await cnt(`select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname in ('pop_files_insert', 'pop_files_select')`) === 2, 'Storage 정책(추가·열람) 2개');
ok(await cnt(`select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and cmd in ('UPDATE', 'DELETE', 'ALL')`) === 0, 'Storage 수정·삭제 정책은 없음(덮어쓰기·삭제 불가)');
ok((await db.query(`select max_upload_mb from settings`)).rows[0].max_upload_mb === 20, '업로드 한도 기본 20MB');
r = await as(ST, `select update_settings(p_max_upload_mb => 5)`);
ok(r.err?.includes('관리자만'), '운영진(비관리자)은 업로드 한도를 못 바꿈');
r = await as(T, `select update_settings(p_max_upload_mb => 51)`);
ok(r.err?.includes('1~50MB'), '업로드 한도는 1~50MB');
r = await as(T, `select update_settings(p_club_name => '동아리')`);
ok(!r.err, 'update_settings 새 인자 추가 후에도 이름 지정 호출이 모호하지 않음');

// 25. 팀 만들기·초대·수락·탈퇴
r = await as(TL, `select create_team('로봇팀', '로봇을 만든다', '대회 출전') id`);
const TEAM = r.rows?.[0]?.id; ok(TEAM, '팀 만들기');
r = await as(TL, `select leader = $2 as lead, status, year from team_projects where id = $1`, [TEAM, TL]);
ok(r.rows[0].lead && r.rows[0].status === 'planning' && r.rows[0].year === curYear, '만든 사람이 팀장, 기획 중, 현재 연도');
ok(await cnt(`select 1 from team_members where team_id = '${TEAM}' and member_id = '${TL}' and status = 'active'`) === 1, '팀장은 팀원(active)으로 등록');
r = await as(TX, `select create_team('   ')`);
ok(r.err?.includes('팀 이름'), '팀 이름 필수');
r = await as(TX, `select name, (select count(*)::int from team_members where team_id = $1) m from team_projects where id = $1`, [TEAM]);
ok(r.rows.length === 1 && r.rows[0].m === 1, '일반 부원도 팀 이름·팀원 명단은 볼 수 있음');
r = await as(TX, `select invite_team_member($1, $2)`, [TEAM, TX]);
ok(r.err?.includes('팀장만'), '팀장이 아니면 초대 불가');
r = await as(TL, `select invite_team_member($1, $2, '디자인')`, [TEAM, TM]);
ok(!r.err, '팀장이 초대');
r = await as(TL, `select invite_team_member($1, $2)`, [TEAM, TM]);
ok(r.err?.includes('이미 초대'), '중복 초대 차단');
r = await as(TL, `select invite_team_member($1, $2)`, [TEAM, H]);
ok(r.err?.includes('활동 중인'), '승인 대기 회원은 초대 불가');
ok(await cnt(`select 1 from notifications where user_id = '${TM}' and text like '%초대했습니다%'`) === 1, '초대 알림');
r = await as(TX, `select count(*)::int n from team_members where team_id = $1 and member_id = $2`, [TEAM, TM]);
ok(r.rows[0].n === 0, '초대 중인 사람은 다른 부원에게 안 보임');
r = await as(TM, `select count(*)::int n from team_members where team_id = $1 and member_id = $2`, [TEAM, TM]);
ok(r.rows[0].n === 1, '초대받은 본인은 봄');
r = await as(TM, `select team_id from team_files where team_id = $1`, [TEAM]);
ok(r.rows.length === 0, '초대만 받은 사람은 작업 공간 파일 목록을 못 봄(팀원 아님)');
r = await as(TX, `select respond_team_invite($1, true)`, [TEAM]);
ok(r.err?.includes('받은 초대가 없'), '초대받지 않은 사람은 수락 불가');
r = await as(TM, `select respond_team_invite($1, true)`, [TEAM]);
ok(!r.err, '초대 수락');
ok(await cnt(`select 1 from team_members where team_id = '${TEAM}' and member_id = '${TM}' and status = 'active' and joined_at is not null`) === 1, '수락하면 active');
r = await as(TL, `select leave_team($1)`, [TEAM]);
ok(r.err?.includes('팀장은 팀을 떠날 수 없'), '팀장은 넘기기 전에는 탈퇴 불가');
r = await as(TM, `select leave_team($1)`, [TEAM]);
ok(!r.err, '팀원 탈퇴');
ok(await cnt(`select 1 from team_members where team_id = '${TEAM}' and member_id = '${TM}' and status = 'left'`) === 1, '탈퇴하면 left');
await as(TL, `select invite_team_member($1, $2, '디자인')`, [TEAM, TM]);
r = await as(TM, `select respond_team_invite($1, true)`, [TEAM]);
ok(!r.err, '다시 초대받아 수락');
await as(TL, `select invite_team_member($1, $2)`, [TEAM, TX]);
r = await as(TX, `select respond_team_invite($1, false)`, [TEAM]);
ok(!r.err && await cnt(`select 1 from team_members where team_id = '${TEAM}' and member_id = '${TX}' and status = 'left'`) === 1, '초대 거절');
r = await as(TX, `insert into team_members (team_id, member_id, status) values ('${TEAM}', '${TX}', 'active')`);
ok(!!r.err, '팀원 표 직접 insert 차단');

// 26. 파일: Storage 정책과 버전
const f1 = `team/${TEAM}/${uuidv()}-설계서.pdf`;
r = await as(TX, `insert into storage.objects (bucket_id, name, metadata) values ('pop-files', $1, '{"size":10}')`, [f1]);
ok(!!r.err, '팀원이 아닌 사람은 팀 폴더에 올릴 수 없음(Storage 정책)');
r = await as(TM, `insert into storage.objects (bucket_id, name, metadata) values ('pop-files', $1, '{"size":1000,"mimetype":"application/pdf"}')`, [f1]);
ok(!r.err, '팀원은 팀 폴더에 올릴 수 있음');
ok(await objCount(TL, f1) === 1 && await objCount(TM, f1) === 1, '팀원은 팀 파일 열람');
ok(await objCount(TX, f1) === 0, '팀원이 아닌 부원은 팀 파일을 못 봄(Storage 정책)');
ok(await objCount(ST, f1) === 1, '운영진은 팀 파일 열람');
ok(await objCount(SV2, f1) === 0, '서버 관리자는 팀 파일을 못 봄');
ok(await objCount(null, f1) === 0, '비로그인은 팀 파일을 못 봄');
r = await as(TM, `update storage.objects set name = name || 'x' where name = $1 returning name`, [f1]);
ok(!r.err && r.rows.length === 0, '올린 파일은 수정(덮어쓰기·이름 변경)할 수 없음');
r = await as(TM, `delete from storage.objects where name = $1 returning name`, [f1]);
ok(!r.err && r.rows.length === 0 && await objCount(TM, f1) === 1, '올린 파일은 지울 수 없음');
r = await as(TM, `insert into storage.objects (bucket_id, name, metadata) values ('pop-files', $1, '{"size":10}')`, [f1]);
ok(!!r.err, '같은 경로로 다시 올리기(덮어쓰기) 불가');
const otherTeam = uuidv();
r = await as(TM, `insert into storage.objects (bucket_id, name, metadata) values ('pop-files', $1, '{"size":10}')`, [`team/${otherTeam}/${uuidv()}-a.pdf`]);
ok(!!r.err, '없는 팀 폴더에는 올릴 수 없음');
r = await as(TM, `insert into storage.objects (bucket_id, name, metadata) values ('pop-files', $1, '{"size":10}')`, [`etc/${uuidv()}.pdf`]);
ok(!!r.err, '정해진 폴더 밖 경로는 올릴 수 없음');

r = await as(TM, `select register_team_file($1, $2, '설계서.pdf', '첫 버전') id`, [TEAM, `team/${TEAM}/${uuidv()}-없는파일.pdf`]);
ok(r.err?.includes('찾을 수 없'), '실제로 올라와 있지 않으면 등록 실패');
r = await as(TX, `select register_team_file($1, $2, '설계서.pdf')`, [TEAM, f1]);
ok(r.err?.includes('팀원만'), '팀원이 아니면 등록 불가');
r = await as(TM, `select register_team_file($1, $2, '설계서.pdf', '첫 버전') id`, [TEAM, f1]);
const FV1 = r.rows?.[0]?.id; ok(FV1, '파일 등록(v1)');
r = await as(TM, `select register_team_file($1, $2, '설계서.pdf')`, [TEAM, f1]);
ok(r.err?.includes('이미 등록'), '같은 경로 중복 등록 불가');
const f2 = `team/${TEAM}/${uuidv()}-설계서.pdf`;
await putObj(f2, 2000);
r = await as(TL, `select register_team_file($1, $2, '설계서.pdf', '표지 수정') id`, [TEAM, f2]);
const FV2 = r.rows?.[0]?.id; ok(FV2, '같은 이름으로 다시 올리면 등록');
r = await as(TL, `select version_no, file_id from team_file_versions where id = $1`, [FV2]);
const FILE1 = r.rows[0].file_id;
ok(r.rows[0].version_no === 2, '같은 파일은 새 버전(v2)으로 쌓임');
ok(await cnt(`select 1 from team_files where team_id = '${TEAM}'`) === 1, '파일은 하나, 버전만 늘어남');
ok((await db.query(`select path from team_file_versions where id = $1`, [FV1])).rows[0].path === f1, '이전 버전의 파일은 그대로 남음');
const f3 = `team/${TEAM}/${uuidv()}-회의록.docx`;
await putObj(f3, 500, 'application/vnd.openxmlformats');
r = await as(TM, `select register_team_file($1, $2, '회의록.docx', '', null) id`, [TEAM, f3]);
const FV3 = r.rows?.[0]?.id; ok(FV3 && await cnt(`select 1 from team_files where team_id = '${TEAM}'`) === 2, '다른 이름은 새 파일');
const f4 = `team/${TEAM}/${uuidv()}-회의록-수정.docx`;
await putObj(f4, 600);
r = await as(TM, `select register_team_file($1, $2, '회의록-수정.docx', '수정', $3) id`, [TEAM, f4, (await db.query(`select file_id from team_file_versions where id = $1`, [FV3])).rows[0].file_id]);
ok(!r.err && (await db.query(`select version_no from team_file_versions where id = $1`, [r.rows[0].id])).rows[0].version_no === 2, '파일을 직접 골라 새 버전으로 올릴 수 있음');
r = await as(TM, `update team_file_versions set path = 'x' where id = $1`, [FV1]);
ok(!!r.err, '버전 표 직접 수정 차단');
r = await as(TM, `insert into team_file_versions (file_id, version_no, path) values ('${FILE1}', 9, 'x')`);
ok(!!r.err, '버전 표 직접 추가 차단');
// 차단 확장자·용량
for (const [bad, label] of [['virus.exe', 'exe'], ['run.BAT', 'bat'], ['x.ps1', 'ps1'], ['tool.jar', 'jar'], ['setup.msi', 'msi'], ['a.sh', 'sh'], ['a.dmg', 'dmg']]) {
  const bp = `team/${TEAM}/${uuidv()}-${bad}`;
  await putObj(bp, 100);
  r = await as(TM, `select register_team_file($1, $2, $3)`, [TEAM, bp, bad]);
  ok(r.err?.includes('올릴 수 없는 형식'), `차단 확장자 거절: ${label}`);
}
{
  const bp = `team/${TEAM}/${uuidv()}-ok.pdf`;
  await putObj(bp, 100);
  r = await as(TM, `select register_team_file($1, $2, 'ok.pdf.exe ')`, [TEAM, bp]);
  ok(r.err?.includes('올릴 수 없는 형식'), '이름 끝에 공백·점을 붙여도 확장자 차단');
  r = await as(TM, `select register_team_file($1, $2, 'notes.exe.txt') id`, [TEAM, bp]);
  ok(!r.err, '마지막 확장자만 본다(txt 는 허용)');
}
{
  await as(T, `select update_settings(p_max_upload_mb => 1)`);
  const big = `team/${TEAM}/${uuidv()}-큰파일.pdf`;
  await putObj(big, 2 * 1048576);
  r = await as(TM, `select register_team_file($1, $2, '큰파일.pdf')`, [TEAM, big]);
  ok(r.err?.includes('용량 제한(1MB)'), '업로드 용량 제한 초과 거절');
  await as(T, `select update_settings(p_max_upload_mb => 20)`);
  r = await as(TM, `select register_team_file($1, $2, '큰파일.pdf') id`, [TEAM, big]);
  ok(!r.err, '한도를 늘리면 같은 파일이 등록됨');
  const zero = `team/${TEAM}/${uuidv()}-빈.pdf`;
  await putObj(zero, 0);
  r = await as(TM, `select register_team_file($1, $2, '빈.pdf')`, [TEAM, zero]);
  ok(r.err?.includes('빈 파일'), '빈 파일 거절');
  r = await as(TM, `select register_team_file($1, $2, 'x.pdf')`, [TEAM, `team/${otherTeam}/${uuidv()}-x.pdf`]);
  ok(r.err?.includes('올바르지 않은 파일 경로'), '다른 팀 경로로는 등록 불가');
}
ok(await cnt(`select 1 from notifications where user_id = '${TL}' and text like '%파일 「설계서.pdf」 v1%'`) === 1, '새 파일 버전 알림(팀원에게)');

// 메모·토론·진행 상황
r = await as(TM, `select add_team_note($1, 'progress', '회로 설계 70% 완료') id`, [TEAM]);
const NOTE = r.rows?.[0]?.id; ok(NOTE, '진행 상황 쓰기');
r = await as(TX, `select add_team_note($1, 'note', 'x')`, [TEAM]);
ok(r.err?.includes('팀원만'), '팀원이 아니면 메모 불가');
r = await as(TM, `select add_team_note($1, 'secret', 'x')`, [TEAM]);
ok(!!r.err, '잘못된 글 종류 거절');
r = await as(TX, `select count(*)::int n from team_notes where team_id = $1`, [TEAM]);
ok(r.rows[0].n === 0, '팀원이 아닌 부원은 메모를 못 읽음');
r = await as(TM, `select count(*)::int n from team_notes where team_id = $1`, [TEAM]);
ok(r.rows[0].n === 1, '팀원은 메모를 읽음');
r = await as(SV2, `select count(*)::int n from team_notes`);
ok(r.rows[0].n === 0, '서버 관리자는 메모를 못 읽음');
r = await as(TX, `select count(*)::int n from team_files where team_id = $1`, [TEAM]);
ok(r.rows[0].n === 0, '팀원이 아닌 부원은 파일 목록(DB 행)도 못 봄');
r = await as(TX, `select count(*)::int n from team_file_versions`);
ok(r.rows[0].n === 0, '팀원이 아닌 부원은 파일 버전(경로)도 못 봄');
r = await as(ST, `select (select count(*)::int from team_files) f, (select count(*)::int from team_notes) n`);
ok(r.rows[0].f >= 2 && r.rows[0].n === 1, '운영진은 작업 공간(파일·메모)을 봄');
r = await as(TM, `select pin_team_note($1, true)`, [NOTE]);
ok(r.err?.includes('팀장만'), '메모 고정은 팀장만');
r = await as(TL, `select pin_team_note($1, true)`, [NOTE]);
ok(!r.err, '팀장이 메모 고정');
r = await as(TX, `select delete_team_note($1)`, [NOTE]);
ok(!!r.err, '남의 팀 메모는 지울 수 없음');

// 27. 최종본·제작자·제출
r = await as(TM, `select set_team_final($1, $2, true)`, [TEAM, FV2]);
ok(r.err?.includes('팀장만'), '최종본 지정은 팀장만');
r = await as(TL, `select set_team_final($1, $2, true)`, [TEAM, uuidv()]);
ok(r.err?.includes('이 팀의 파일 버전이 아닙니다'), '없는 버전은 최종본으로 못 정함');
r = await as(TL, `select set_team_status($1, 'pending_submit')`, [TEAM]);
ok(r.err?.includes('바꿀 수 없는'), '기획 중에서 곧바로 제출 불가');
r = await as(TM, `select set_team_status($1, 'active')`, [TEAM]);
ok(r.err?.includes('팀장만'), '팀원은 진행 시작 불가');
r = await as(TL, `select set_team_status($1, 'active')`, [TEAM]);
ok(!r.err, '팀장이 진행 시작');
r = await as(TL, `select set_team_status($1, 'pending_submit')`, [TEAM]);
ok(r.err?.includes('최종본'), '제출에는 최종본이 필요');
await as(TL, `select set_team_final($1, $2, true)`, [TEAM, FV1]);
await as(TL, `select set_team_final($1, $2, true)`, [TEAM, FV2]);
ok(await cnt(`select 1 from team_final_files where team_id = '${TEAM}'`) === 1 && await cnt(`select 1 from team_final_files where file_version_id = '${FV2}'`) === 1, '같은 파일의 다른 버전을 최종본으로 정하면 바꿔 끼움');
r = await as(TL, `select set_team_status($1, 'pending_submit')`, [TEAM]);
ok(r.err?.includes('제작자 명단'), '제출에는 제작자 명단이 필요');
const credits = (arr) => J(arr.map(([m, n, c]) => ({ member_id: m, display_name: n, contribution: c })));
r = await as(TM, `select set_team_credits($1, $2::jsonb)`, [TEAM, credits([[TM, '팀원', '디자인']])]);
ok(r.err?.includes('팀장만'), '제작자 명단은 팀장만 작성');
r = await as(TL, `select set_team_credits($1, $2::jsonb)`, [TEAM, credits([[TX, '외부', '']])]);
ok(r.err?.includes('팀원이 아닌'), '팀원이 아닌 회원은 제작자로 올릴 수 없음');
r = await as(TL, `select set_team_credits($1, $2::jsonb)`, [TEAM, credits([[TL, '', '']])]);
ok(r.err?.includes('이름 표기'), '이름 표기 필수');
r = await as(TL, `select set_team_credits($1, $2::jsonb)`, [TEAM, credits([[TL, '팀장', '총괄'], [TM, '팀원 님', '디자인']])]);
ok(!r.err, '팀장이 제작자 명단 작성');
ok(await cnt(`select 1 from team_credits where team_id = '${TEAM}' and status = 'pending'`) === 2, '처음에는 모두 확인 대기');
ok(await cnt(`select 1 from notifications where user_id = '${TM}' and text like '%제작자 표시 확인을 요청%'`) === 1, '제작자 확인 요청 알림');
r = await as(TL, `select set_team_status($1, 'pending_submit')`, [TEAM]);
ok(r.err?.includes('모든 팀원이 확인'), '전원 확인 전에는 제출 불가');
r = await as(TX, `select respond_team_credit($1, true)`, [TEAM]);
ok(r.err?.includes('내 이름으로'), '명단에 없는 사람은 확인할 수 없음');
r = await as(TL, `select respond_team_credit($1, true)`, [TEAM]);
ok(!r.err, '본인 항목 확인');
ok((await db.query(`select status from team_credits where team_id = $1 and member_id = $2`, [TEAM, TM])).rows[0].status === 'pending', '팀장이 확인해도 남의 항목은 그대로(본인만 확인)');
r = await as(TL, `select respond_team_credit($1, true)`, [TEAM]);
ok(r.err?.includes('확인 대기 중인 항목이 아닙'), '이미 확인한 항목은 다시 처리 불가');
r = await as(TM, `select respond_team_credit($1, false)`, [TEAM]);
ok(!r.err && (await db.query(`select status from team_credits where team_id = $1 and member_id = $2`, [TEAM, TM])).rows[0].status === 'declined', '본인이 거절');
r = await as(TL, `select set_team_status($1, 'pending_submit')`, [TEAM]);
ok(r.err?.includes('모든 팀원이 확인'), '거절이 있으면 제출 불가');
await as(TL, `select set_team_credits($1, $2::jsonb)`, [TEAM, credits([[TL, '팀장', '총괄'], [TM, '팀원', '디자인·제작']])]);
ok((await db.query(`select status from team_credits where team_id = $1 and member_id = $2`, [TEAM, TL])).rows[0].status === 'confirmed', '바뀌지 않은 항목은 확인 상태 유지');
ok((await db.query(`select status from team_credits where team_id = $1 and member_id = $2`, [TEAM, TM])).rows[0].status === 'pending', '고친 항목은 다시 확인 대기');
await as(TM, `select respond_team_credit($1, true)`, [TEAM]);
ok(await cnt(`select 1 from notifications where user_id = '${TL}' and text like '%모두 확인했습니다%'`) === 1, '전원 확인하면 팀장에게 알림');
r = await as(TM, `select set_team_status($1, 'pending_submit')`, [TEAM]);
ok(r.err?.includes('팀장만'), '제출은 팀장만');
r = await as(TL, `select set_team_status($1, 'pending_submit')`, [TEAM]);
ok(!r.err, '최종본·전원 확인 후 제출');
ok(await cnt(`select 1 from notifications where user_id = '${ST}' and text like '%최종 제출%'`) === 1, '제출하면 운영진에게 알림');
r = await as(TL, `select set_team_credits($1, $2::jsonb)`, [TEAM, credits([[TL, '팀장', 'x']])]);
ok(r.err?.includes('제출 대기'), '제출 대기 중에는 제작자 명단을 못 고침');
r = await as(TL, `select set_team_final($1, $2, false)`, [TEAM, FV2]);
ok(r.err?.includes('제출 대기 이후'), '제출 대기 중에는 최종본을 못 바꿈');
r = await as(TL, `select set_team_status($1, 'done')`, [TEAM]);
ok(r.err?.includes('운영진만'), '완료 처리는 운영진만');
r = await as(TL, `select publish_team($1)`, [TEAM]);
ok(r.err?.includes('운영진'), '팀장은 게시할 수 없음');
r = await as(ST, `select publish_team($1)`, [TEAM]);
ok(r.err?.includes('완료 처리된'), '완료 전에는 게시 불가');
r = await as(ST, `select set_team_status($1, 'done')`, [TEAM]);
ok(!r.err, '운영진이 완료 처리');
ok(await cnt(`select 1 from audit_logs where action = 'team.status'`) >= 1, '운영진의 상태 변경이 감사 기록에 남음');

// 두 번째 팀: 최종본 없이 제출 시도, 팀장 넘기기
r = await as(TL, `select create_team('임시팀') id`);
const TEAM2 = r.rows[0].id;
await as(TL, `select set_team_credits($1, $2::jsonb)`, [TEAM2, credits([[TL, '팀장', '']])]);
await as(TL, `select respond_team_credit($1, true)`, [TEAM2]);
await as(TL, `select set_team_status($1, 'active')`, [TEAM2]);
r = await as(TL, `select set_team_status($1, 'pending_submit')`, [TEAM2]);
ok(r.err?.includes('최종본'), '제작자는 확인됐어도 최종본이 없으면 제출 불가');


// 28. 게시 → 동아리 게시물 자동 생성, 공개 범위
const draftOnly = `team/${TEAM}/${uuidv()}-초안.pdf`;
await putObj(draftOnly, 100);
r = await as(TM, `select register_team_file($1, $2, '초안.pdf') id`, [TEAM, draftOnly]);
const FVD = r.rows?.[0]?.id; ok(FVD, '완료 상태에서도 팀원은 파일을 더 올릴 수 있음(게시 전까지)');
const finalPath = f2;
ok(await objCount(TX, finalPath) === 0 && await objCount(TX, draftOnly) === 0, '게시 전에는 최종본도 일반 부원이 못 봄');
await as(TL, `select link_team_session($1, $2)`, [TEAM, SCUR]);
ok(await cnt(`select 1 from team_project_sessions where team_id = '${TEAM}' and session_id = '${SCUR}'`) === 1, '팀을 현재 연도 차시에 연결(여러 개 가능)');
r = await as(TL, `select link_team_session($1, $2)`, [TEAM, S25]);
ok(r.err?.includes('관리자만'), '지난 연도 차시 연결은 관리자만');
r = await as(TX, `select link_team_session($1, $2)`, [TEAM, SCUR]);
ok(r.err?.includes('팀장 또는 운영진'), '팀장·운영진이 아니면 차시 연결 불가');
r = await as(T, `select link_team_session($1, $2)`, [TEAM, S25]);
ok(!r.err && await cnt(`select 1 from audit_logs where action = 'team.session_link_past'`) === 1, '관리자의 지난 연도 차시 연결은 감사 기록');
r = await as(ST, `select publish_team($1) id`, [TEAM]);
const POSTT = r.rows?.[0]?.id; ok(POSTT, '운영진이 게시');
r = await as(TX, `select board, author, team_id, title from posts where id = $1`, [POSTT]);
ok(r.rows[0]?.board === 'club' && r.rows[0].author === TL && r.rows[0].team_id === TEAM && r.rows[0].title === '로봇팀', '게시하면 팀과 연결된 동아리 게시물이 만들어짐(작성자=팀장)');
ok(await cnt(`select 1 from post_sessions where post_id = '${POSTT}'`) === 2, '팀의 차시 연결이 게시물로 복사됨');
ok((await db.query(`select status, published_at is not null p from team_projects where id = $1`, [TEAM])).rows[0].p === true, '게시 완료 상태');
r = await as(TX, `select count(*)::int n from team_credits where team_id = $1 and status = 'confirmed'`, [TEAM]);
ok(r.rows[0].n === 2, '게시 후에는 전체 부원이 확정된 제작자 명단을 봄');
ok(await objCount(TX, finalPath) === 1, '게시된 최종본은 전체 부원이 열람 가능(Storage)');
ok(await objCount(TX, f1) === 0 && await objCount(TX, draftOnly) === 0, '최종본이 아닌 파일은 여전히 팀원만(Storage)');
ok(await objCount(SV2, finalPath) === 1, '게시된 최종본은 서버 관리자(부원)도 열람');
ok(await objCount(null, finalPath) === 0, '비로그인은 게시된 최종본도 못 봄');
r = await as(TX, `select count(*)::int n from team_file_versions`);
ok(r.rows[0].n === 1, '일반 부원은 게시된 최종 버전 행만 봄');
r = await as(TX, `select count(*)::int n from team_files`);
ok(r.rows[0].n === 1, '일반 부원은 최종본이 있는 파일 행만 봄');
r = await as(TX, `select count(*)::int n from team_notes`);
ok(r.rows[0].n === 0, '게시 후에도 메모는 팀원·운영진만');
r = await as(TX, `select count(*)::int n from team_final_files where team_id = $1`, [TEAM]);
ok(r.rows[0].n === 1, '최종본 지정 목록은 게시 후 공개');
ok(await cnt(`select 1 from notifications where user_id = '${TM}' and text like '%게시판에 게시되었습니다%'`) >= 1, '게시 알림');
r = await as(TM, `select register_team_file($1, $2, '쓰기.pdf')`, [TEAM, draftOnly]);
ok(r.err?.includes('게시 완료'), '게시 후에는 파일을 더 올릴 수 없음');
r = await as(ST, `select publish_team($1)`, [TEAM]);
ok(r.err?.includes('완료 처리된'), '두 번 게시할 수 없음');
// 게시 후 제작자 수정: 관리자만, 이력+감사 기록
r = await as(TL, `select set_team_credits($1, $2::jsonb)`, [TEAM, credits([[TL, '팀장', '총괄'], [TM, '팀원', '제작']])]);
ok(r.err?.includes('관리자만'), '게시 후 팀장은 제작자 표시를 고칠 수 없음');
r = await as(ST, `select set_team_credits($1, $2::jsonb)`, [TEAM, credits([[TL, '팀장', '총괄'], [TM, '팀원', '제작']])]);
ok(r.err?.includes('관리자만'), '게시 후 운영진(비관리자)도 제작자 표시를 고칠 수 없음');
const histBefore = await cnt(`select 1 from team_credit_history where team_id = '${TEAM}'`);
r = await as(T, `select set_team_credits($1, $2::jsonb)`, [TEAM, credits([[TL, '팀장', '총괄·기획'], [TM, '팀원', '디자인·제작']])]);
ok(!r.err, '관리자가 게시 후 제작자 표시 수정');
ok(await cnt(`select 1 from team_credit_history where team_id = '${TEAM}'`) === histBefore + 1, '변경 이력이 team_credit_history 에 남음');
ok(await cnt(`select 1 from audit_logs where action = 'team.credits_edited'`) === 1, '게시 후 수정이 감사 기록에 남음');
ok((await db.query(`select count(*)::int n from team_credits where team_id = $1 and status = 'confirmed'`, [TEAM])).rows[0].n === 2, '관리자 수정 항목은 확정 상태 유지');
r = await db.query(`delete from team_credit_history`).then(() => 'OK', (e) => e.message);
ok(r.includes('지울 수 없습니다'), '제작자 변경 이력은 지울 수 없음');
r = await as(T, `update team_credit_history set change = '{}'`);
ok(!!r.err, '제작자 변경 이력은 API 로 고칠 수 없음');
r = await as(TL, `select count(*)::int n from team_credit_history where team_id = $1`, [TEAM]);
ok(r.rows[0].n >= 4, '팀원은 변경 이력을 볼 수 있음');
r = await as(TX, `select count(*)::int n from team_credit_history`);
ok(r.rows[0].n === 0, '일반 부원은 변경 이력을 못 봄');

// 29. 팀장 넘기기·내보내기·보관
r = await as(TM, `select transfer_team_leader($1, $2)`, [TEAM2, TM]);
ok(!!r.err, '팀장이 아니면 팀장을 넘길 수 없음');
await as(TL, `select invite_team_member($1, $2)`, [TEAM2, TM]);
await as(TM, `select respond_team_invite($1, true)`, [TEAM2]);
r = await as(TL, `select transfer_team_leader($1, $2)`, [TEAM2, TX]);
ok(r.err?.includes('활동 중인 팀원'), '팀원이 아닌 사람에게는 넘길 수 없음');
r = await as(TL, `select transfer_team_leader($1, $2)`, [TEAM2, TM]);
ok(!r.err && (await db.query(`select leader from team_projects where id = $1`, [TEAM2])).rows[0].leader === TM, '팀장 넘기기');
ok(await cnt(`select 1 from notifications where user_id = '${TM}' and text like '%팀장이 되었습니다%'`) === 1, '팀장 변경 알림');
r = await as(TL, `select remove_team_member($1, $2)`, [TEAM2, TM]);
ok(r.err?.includes('팀장만'), '넘긴 뒤에는 이전 팀장이 팀원을 내보낼 수 없음');
r = await as(TM, `select remove_team_member($1, $2)`, [TEAM2, TM]);
ok(r.err?.includes('팀장은 내보낼 수 없'), '팀장 자신은 내보낼 수 없음');
r = await as(ST, `select transfer_team_leader($1, $2)`, [TEAM2, TL]);
ok(!r.err && await cnt(`select 1 from audit_logs where action = 'team.leader_changed'`) === 1, '운영진이 팀장을 바꾸면 감사 기록');
r = await as(TL, `select remove_team_member($1, $2)`, [TEAM2, TM]);
ok(!r.err, '팀장이 팀원 내보내기');
ok(await cnt(`select 1 from team_credits where team_id = '${TEAM2}' and member_id = '${TM}'`) === 0, '내보낸 팀원의 제작자 항목도 정리됨');
r = await as(TM, `select count(*)::int n from team_notes where team_id = $1`, [TEAM2]);
ok(r.rows[0].n === 0, '내보낸 팀원은 작업 공간을 못 봄');
r = await as(TX, `select set_team_status($1, 'archived')`, [TEAM2]);
ok(r.err?.includes('팀장 또는 운영진'), '팀원 아닌 사람은 보관 불가');
r = await as(TL, `select set_team_status($1, 'archived')`, [TEAM2]);
ok(!r.err, '팀장이 보관');
r = await as(TL, `select set_team_status($1, 'active')`, [TEAM2]);
ok(r.err?.includes('바꿀 수 없'), '보관된 팀의 상태는 되돌릴 수 없음');
r = await as(TL, `select add_team_note($1, 'note', 'x')`, [TEAM2]);
ok(r.err?.includes('보관'), '보관된 팀에는 쓸 수 없음');

// 30. 지난 연도 팀은 관리자만
const OLDTEAM = uuidv();
await db.query(`insert into team_projects (id, name, leader, year, status) values ($1, '작년팀', $2, $3, 'active')`, [OLDTEAM, TL, curYear - 1]);
await db.query(`insert into team_members (team_id, member_id, status, joined_at) values ($1, $2, 'active', now()), ($1, $3, 'active', now())`, [OLDTEAM, TL, TM]);
r = await as(TL, `select add_team_note($1, 'note', 'x')`, [OLDTEAM]);
ok(r.err?.includes('지난 연도'), '지난 연도 팀: 팀장도 메모 불가');
r = await as(TL, `select set_team_status($1, 'archived')`, [OLDTEAM]);
ok(r.err?.includes('지난 연도'), '지난 연도 팀: 팀장도 상태 변경 불가');
r = await as(ST, `select update_team($1, '새이름')`, [OLDTEAM]);
ok(r.err?.includes('지난 연도'), '지난 연도 팀: 운영진(비관리자)도 수정 불가');
r = await as(TM, `select leave_team($1)`, [OLDTEAM]);
ok(r.err?.includes('지난 연도'), '지난 연도 팀: 탈퇴도 불가');
{
  const op = `team/${OLDTEAM}/${uuidv()}-a.pdf`;
  r = await as(TL, `insert into storage.objects (bucket_id, name, metadata) values ('pop-files', $1, '{"size":10}')`, [op]);
  ok(!!r.err, '지난 연도 팀 폴더에는 팀원도 올릴 수 없음(Storage 정책)');
}
r = await as(T, `select update_team($1, '작년팀(수정)')`, [OLDTEAM]);
ok(!r.err, '관리자는 지난 연도 팀을 고칠 수 있음');
ok(await cnt(`select 1 from audit_logs where action = 'team.past_edit'`) >= 1, '관리자의 지난 연도 팀 수정은 감사 기록');
r = await as(TX, `select count(*)::int n from team_projects where id = $1`, [OLDTEAM]);
ok(r.rows[0].n === 1, '지난 연도 팀도 부원은 열람 가능');

// 31. 게시판·공지
r = await as(TX, `select create_post('free', '내가 만든 게임', '# 소개\n재미있어요', array['게임', '  ', '#게임'], 'members') id`);
const PF = r.rows?.[0]?.id; ok(PF, '자유 게시물은 일반 부원도 작성');
r = await as(TX, `select tags, year, board from posts where id = $1`, [PF]);
ok(J(r.rows[0].tags) === '["게임"]' && r.rows[0].year === curYear, '태그 정리·중복 제거, 연도 기록');
r = await as(TX, `select create_post('club', '공식', 'x')`);
ok(r.err?.includes('운영진만'), '일반 부원은 동아리 게시물을 쓸 수 없음');
r = await as(TX, `select create_post('notice', '공지', 'x')`);
ok(r.err?.includes('운영진만'), '일반 부원은 공지를 쓸 수 없음');
r = await as(TX, `select create_post('free', 'x', 'x', '{}', 'members', null, null, '{}', true)`);
ok(r.err?.includes('고정은 공지'), '자유 게시물은 고정할 수 없음');
r = await as(TX, `select create_post('free', 'x', 'x', '{}', 'secret')`);
ok(r.err?.includes('공개 범위'), '공개 범위 검사');
r = await as(TX, `select create_post('free', '   ', 'x')`);
ok(r.err?.includes('제목'), '제목 필수');
r = await as(TX, `select create_post('free', 'x', 'x', '{}', 'members', $1)`, [TEAM]);
ok(r.err?.includes('동아리 게시물에만'), '자유 게시물에는 팀을 연결할 수 없음');
r = await as(SV2, `select create_post('club', 'x', 'x')`);
ok(r.err?.includes('운영진만'), '서버 관리자는 동아리 게시물·공지를 쓸 수 없음');
r = await as(ST, `select create_post('notice', '3월 첫 모임 안내', '장소는 ...', array['안내'], 'members', null, null, array['${SCUR}']::uuid[], true) id`);
const PN = r.rows?.[0]?.id; ok(PN, '운영진이 공지 작성(고정)');
ok(await cnt(`select 1 from notifications where user_id = '${TX}' and text = '새 공지: 3월 첫 모임 안내'`) === 1 && await cnt(`select 1 from notifications where user_id = '${TM}' and text like '새 공지%'`) === 1, '공지를 올리면 활동 중인 부원 모두에게 알림');
ok(await cnt(`select 1 from notifications where user_id = '${ST}' and text like '새 공지%'`) === 0, '작성자 본인에게는 알림 없음');
r = await as(TX, `select set_post_pinned($1, false)`, [PN]);
ok(r.err?.includes('운영진'), '공지 고정은 운영진만');
r = await as(ST, `select set_post_pinned($1, false)`, [PF]);
ok(r.err?.includes('공지만'), '공지가 아닌 글은 고정 불가');
r = await as(ST, `select set_post_pinned($1, false)`, [PN]);
ok(!r.err, '운영진이 고정 해제');
await as(ST, `select set_post_pinned($1, true)`, [PN]);
r = await as(ST, `select create_post('club', '운영진 전용 회의록', '내부', '{}', 'staff') id`);
const PS = r.rows[0].id;
r = await as(TX, `select count(*)::int n from posts where id = $1`, [PS]);
ok(r.rows[0].n === 0, '운영진 전용 게시물은 일반 부원에게 안 보임');
r = await as(ST, `select count(*)::int n from posts where id = $1`, [PS]);
ok(r.rows[0].n === 1, '운영진은 운영진 전용 게시물을 봄');
r = await as(SV2, `select count(*)::int n from posts where id = $1`, [PS]);
ok(r.rows[0].n === 0, '서버 관리자는 운영진 전용 게시물을 못 봄');
r = await as(TX, `select add_post_comment($1, '엿보기')`, [PS]);
ok(!!r.err, '안 보이는 게시물에는 댓글 불가');
r = await as(TX, `select toggle_post_reaction($1)`, [PS]);
ok(!!r.err, '안 보이는 게시물에는 반응 불가');
r = await as(TX, `select update_post($1, '남의 글', 'x')`, [PN]);
ok(r.err?.includes('작성자만'), '남의 글은 고칠 수 없음');
r = await as(TX, `select update_post($1, '내가 만든 게임 v2', '수정', array['게임','퍼즐'], 'members', null, '{}'::uuid[])`, [PF]);
ok(!r.err, '본인 글 수정');
r = await as(TX, `select title, updated_at > created_at u from posts where id = $1`, [PF]);
ok(r.rows[0].title === '내가 만든 게임 v2' && r.rows[0].u, '수정 반영');
// 댓글·반응
r = await as(TM, `select add_post_comment($1, '재밌네요!') id`, [PF]);
const PC = r.rows?.[0]?.id; ok(PC, '부원이 댓글');
ok(await cnt(`select 1 from notifications where user_id = '${TX}' and text like '%댓글을 남겼습니다%'`) === 1, '작성자에게 댓글 알림');
r = await as(SV2, `select add_post_comment($1, '서버지기 댓글')`, [PF]);
ok(!r.err, '서버 관리자도 일반 부원처럼 댓글은 가능');
r = await as(TM, `select add_post_comment($1, '   ')`, [PF]);
ok(r.err?.includes('댓글 내용'), '빈 댓글 거절');
r = await as(TL, `select delete_post_comment($1)`, [PC]);
ok(r.err?.includes('본인 댓글'), '남의 댓글은 지울 수 없음');
r = await as(TM, `select toggle_post_reaction($1) liked`, [PF]);
ok(r.rows?.[0]?.liked === true, '좋아요');
r = await as(TL, `select toggle_post_reaction($1) liked`, [PF]);
r = await as(TM, `select toggle_post_reaction($1) liked`, [PF]);
ok(r.rows?.[0]?.liked === false && await cnt(`select 1 from post_reactions where post_id = '${PF}'`) === 1, '다시 누르면 취소(토글), 사람당 한 번');
r = await as(TM, `insert into post_reactions (post_id, member_id) values ('${PF}', '${TM}')`);
ok(!!r.err, '반응 표 직접 insert 차단');
r = await as(TM, `delete from post_comments where id = $1`, [PC]);
ok(!!r.err, '댓글 직접 삭제 차단');
r = await as(TM, `select delete_post_comment($1)`, [PC]);
ok(!r.err, '본인 댓글 삭제(소프트)');
r = await as(TL, `select count(*)::int n from post_comments where id = $1`, [PC]);
ok(r.rows[0].n === 0, '삭제된 댓글은 부원에게 안 보임');
r = await as(ST, `select count(*)::int n from post_comments where id = $1`, [PC]);
ok(r.rows[0].n === 1, '운영진은 삭제된 댓글 행도 봄(기록)');
r = await as(TL, `select add_post_comment($1, '운영진이 지울 댓글') id`, [PF]);
r = await as(ST, `select delete_post_comment($1)`, [r.rows[0].id]);
ok(!r.err && await cnt(`select 1 from audit_logs where action = 'post.comment_deleted'`) === 1, '운영진이 남의 댓글 삭제(감사 기록)');
// 숨김·삭제
r = await as(TM, `select set_post_hidden($1, true)`, [PF]);
ok(r.err?.includes('운영진'), '숨김은 운영진만');
r = await as(ST, `select set_post_hidden($1, true)`, [PF]);
ok(!r.err, '운영진이 게시물 숨김');
r = await as(TM, `select count(*)::int n from posts where id = $1`, [PF]);
ok(r.rows[0].n === 0, '숨긴 게시물은 다른 부원에게 안 보임');
r = await as(TX, `select count(*)::int n from posts where id = $1`, [PF]);
ok(r.rows[0].n === 1, '작성자는 숨겨진 자기 글을 봄');
r = await as(TM, `select add_post_comment($1, '숨긴 글 댓글')`, [PF]);
ok(!!r.err, '숨긴 게시물에는 댓글 불가');
await as(ST, `select set_post_hidden($1, false)`, [PF]);
ok(await cnt(`select 1 from audit_logs where action in ('post.hidden', 'post.unhidden')`) === 2, '숨김·해제가 감사 기록에 남음');
r = await as(TM, `select delete_post($1)`, [PF]);
ok(r.err?.includes('작성자 또는 운영진'), '남의 글은 지울 수 없음');
r = await as(TX, `select create_post('free', '곧 지울 글', 'x') id`);
const PD = r.rows[0].id;
r = await as(TX, `select delete_post($1)`, [PD]);
ok(!r.err, '본인 글 삭제(소프트)');
ok(await cnt(`select 1 from posts where id = '${PD}' and deleted_at is not null`) === 1, '행은 남고 deleted_at 만 채워짐');
r = await as(TM, `select count(*)::int n from posts where id = $1`, [PD]);
ok(r.rows[0].n === 0, '삭제된 게시물은 부원에게 안 보임');
r = await as(TX, `select count(*)::int n from posts where id = $1`, [PD]);
ok(r.rows[0].n === 0, '삭제된 게시물은 작성자에게도 안 보임');
r = await as(ST, `select count(*)::int n from posts where id = $1`, [PD]);
ok(r.rows[0].n === 1, '운영진은 삭제된 게시물도 봄');
r = await as(TX, `select delete_post($1)`, [PD]);
ok(r.err?.includes('찾을 수 없'), '이미 삭제된 글');
r = await as(TX, `select create_post('free', '운영진이 지울 글', 'x') id`);
const PD2 = r.rows[0].id;
r = await as(ST, `select delete_post($1)`, [PD2]);
ok(!r.err && await cnt(`select 1 from audit_logs where action = 'post.deleted'`) === 1, '운영진이 남의 글 삭제는 감사 기록');
r = await as(TM, `delete from posts where id = '${PF}'`);
ok(!!r.err, '게시물 직접 삭제 차단');
r = await as(TM, `update posts set title = 'x' where id = '${PF}'`);
ok(!!r.err, '게시물 직접 수정 차단');
// 게시물 첨부(Storage)
const pf1 = `post/${PF}/${uuidv()}-스크린샷.png`;
r = await as(TM, `insert into storage.objects (bucket_id, name, metadata) values ('pop-files', $1, '{"size":100}')`, [pf1]);
ok(!!r.err, '작성자가 아니면 게시물 폴더에 올릴 수 없음');
r = await as(TX, `insert into storage.objects (bucket_id, name, metadata) values ('pop-files', $1, '{"size":100,"mimetype":"image/png"}')`, [pf1]);
ok(!r.err, '작성자는 게시물 폴더에 올림');
ok(await objCount(TM, pf1) === 0, '등록 전 첨부는 다른 부원이 못 봄');
ok(await objCount(TX, pf1) === 1, '등록 전 첨부도 작성자는 봄');
r = await as(TM, `select register_post_file($1, $2, '스크린샷.png') id`, [PF, pf1]);
ok(r.err?.includes('작성자만'), '작성자가 아니면 첨부 등록 불가');
r = await as(TX, `select register_post_file($1, $2, '스크린샷.png') id`, [PF, pf1]);
ok(!r.err, '첨부 등록');
ok(await objCount(TM, pf1) === 1, '보이는 게시물의 등록된 첨부는 부원이 열람');
r = await as(TM, `select count(*)::int n from post_files where post_id = $1`, [PF]);
ok(r.rows[0].n === 1, '부원은 첨부 목록을 봄');
{
  const ev = `post/${PF}/${uuidv()}-악성.exe`;
  await putObj(ev, 10);
  r = await as(TX, `select register_post_file($1, $2, '악성.exe')`, [PF, ev]);
  ok(r.err?.includes('올릴 수 없는 형식'), '게시물 첨부도 실행 파일 차단');
  const cv = `post/${PF}/${uuidv()}-cover.png`;
  await putObj(cv, 50, 'image/png');
  r = await as(TX, `select register_post_file($1, $2, 'cover.png', true)`, [PF, cv]);
  ok(!r.err && (await db.query(`select cover_path from posts where id = $1`, [PF])).rows[0].cover_path === cv, '대표 이미지 등록');
}
await as(ST, `select set_post_hidden($1, true)`, [PF]);
ok(await objCount(TM, pf1) === 0, '숨긴 게시물의 첨부는 다른 부원이 못 봄');
ok(await objCount(TX, pf1) === 1, '작성자는 자기 게시물 첨부를 봄');
ok(await objCount(ST, pf1) === 1, '운영진은 숨긴 게시물 첨부도 봄');
await as(ST, `select set_post_hidden($1, false)`, [PF]);
// 신고 (코드 프로젝트 신고와 같은 표)
r = await as(TM, `select report_post($1, '부적절한 내용')`, [PF]);
ok(!r.err, '게시물 신고');
r = await as(TM, `select report_post($1, '또')`, [PF]);
ok(r.err?.includes('이미 신고'), '중복 신고 차단');
r = await as(TM, `select count(*)::int n from reports`);
ok(r.rows[0].n === 0, '신고 목록은 운영진만');
r = await db.query(`insert into reports (reporter_id, reason) values ($1, 'x')`, [TM]).then(() => 'OK', (e) => e.message);
ok(r.includes('reports_one_target'), '신고는 대상이 정확히 하나여야 함(둘 다 비면 거절)');
r = await db.query(`insert into reports (project_id, post_id, reporter_id, reason) values ($1, $2, $3, 'x')`, [P, PF, TM]).then(() => 'OK', (e) => e.message);
ok(r.includes('reports_one_target'), '신고 대상이 둘이면 거절');
r = await as(ST, `select id from reports where post_id = $1`, [PF]);
const RPP = r.rows[0].id;
r = await as(ST, `select resolve_report($1, 'hide')`, [RPP]);
ok(!r.err && (await db.query(`select hidden from posts where id = $1`, [PF])).rows[0].hidden === true, '게시물 신고를 숨김으로 처리하면 게시물이 숨겨짐');
await as(ST, `select set_post_hidden($1, false)`, [PF]);
ok(await cnt(`select 1 from reports where project_id is not null`) >= 1, '기존 코드 프로젝트 신고는 그대로');

// 32. 차시·프로필에서 보이는 연결, 서버 관리자 권한 한계
r = await as(TX, `select count(*)::int n from team_project_sessions where session_id = $1`, [SCUR]);
ok(r.rows[0].n === 1, '차시 페이지에서 팀 프로젝트 연결을 볼 수 있음');
r = await as(TX, `select count(*)::int n from post_sessions where session_id = $1`, [SCUR]);
ok(r.rows[0].n === 2, '차시 페이지에서 게시물 연결을 볼 수 있음(공지 + 게시된 팀)');
r = await as(SV2, `select (select count(*)::int from team_files) f, (select count(*)::int from team_notes) n, (select count(*)::int from team_credit_history) h`);
ok(r.rows[0].n === 0 && r.rows[0].h === 0, '서버 관리자는 팀 메모·변경 이력을 못 봄');
ok(await objCount(SV2, f1) === 0 && await objCount(SV2, draftOnly) === 0, '서버 관리자는 비공개 팀 파일을 못 봄');
r = await as(SV2, `select set_team_status($1, 'archived')`, [TEAM2]);
ok(!!r.err, '서버 관리자는 팀 상태를 바꿀 수 없음');
r = await as(SV2, `select publish_team($1)`, [TEAM]);
ok(!!r.err, '서버 관리자는 게시할 수 없음');
r = await as(SV2, `select server_status() s`);
ok(!r.err && r.rows[0].s.counts.team_projects >= 3 && r.rows[0].s.counts.posts >= 3, '서버 상태 개수에 팀·게시물이 포함(개인정보 없음)');
r = await as(null, `select count(*)::int n from posts`);
ok(r.rows[0].n === 0, '비로그인은 게시물을 못 읽음');
r = await as(null, `select count(*)::int n from team_projects`);
ok(r.rows[0].n === 0, '비로그인은 팀을 못 읽음');
r = await as(null, `select create_post('free', 'x', 'x')`);
ok(!!r.err, '비로그인은 게시물을 쓸 수 없음');
r = await as(H, `select count(*)::int n from team_projects`);
ok(r.rows[0].n === 0, '승인 대기 회원은 팀을 못 읽음');
r = await as(H, `select create_team('x')`);
ok(!!r.err, '승인 대기 회원은 팀을 만들 수 없음');
// 졸업생: 읽기만
{
  const GR = await newMember('grad@school.hs.kr', '졸업');
  await as(T, `select set_user_status($1, 'graduated')`, [GR]);
  r = await as(GR, `select count(*)::int n from posts where id = $1`, [PF]);
  ok(r.rows[0].n === 1, '졸업생도 게시물 열람');
  r = await as(GR, `select create_post('free', 'x', 'x')`);
  ok(r.err?.includes('졸업생'), '졸업생은 게시물을 쓸 수 없음(읽기 전용)');
  r = await as(GR, `select create_team('x')`);
  ok(r.err?.includes('졸업생'), '졸업생은 팀을 만들 수 없음');
}
// 재실행 안전성: 데이터가 있는 DB 에 schema.sql 을 다시 적용해도 그대로
{
  const cntBefore = [await cnt(`select 1 from team_projects`), await cnt(`select 1 from posts`), await cnt(`select 1 from team_file_versions`), await cnt(`select 1 from reports`)];
  let e3 = null;
  try { await db.exec(readFileSync(schemaPath, 'utf8')); } catch (e) { e3 = e.message; }
  ok(!e3, '데이터가 있는 DB 에 schema.sql 재적용 (' + (e3 || '성공') + ')');
  const cntAfter = [await cnt(`select 1 from team_projects`), await cnt(`select 1 from posts`), await cnt(`select 1 from team_file_versions`), await cnt(`select 1 from reports`)];
  ok(J(cntBefore) === J(cntAfter), '재적용해도 팀·게시물·버전·신고가 그대로');
  ok((await db.query(`select max_upload_mb from settings`)).rows[0].max_upload_mb === 20, '재적용해도 설정 유지');
  ok(await cnt(`select 1 from storage.buckets where id = 'pop-files'`) === 1 && await cnt(`select 1 from pg_policies where schemaname = 'storage' and policyname like 'pop_files_%'`) === 2, '재적용해도 버킷 1개·정책 2개');
}

// 23. 기존 데이터 이전 (옛 구조 DB 에 새 schema.sql 적용)
{
  const db2 = new PGlite();
  await db2.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}', raw_app_meta_data jsonb default '{"provider":"google"}', email_confirmed_at timestamptz default now());
  create table auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid, provider text);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
  -- 옛 구조: 회원 = 로그인 계정, 직책은 role 한 칸
  create table public.profiles (id uuid primary key references auth.users (id) on delete cascade, name text not null,
    role text not null default 'member' check (role in ('member', 'admin', 'teacher')),
    status text not null default 'pending' check (status in ('pending', 'active', 'graduated')), generation int,
    created_at timestamptz not null default clock_timestamp());
  create table public.member_emails (user_id uuid primary key references public.profiles (id) on delete cascade, email text not null unique);`);
  const oldIds = {};
  for (const [key, role, day] of [['member', 'member', '2024-03-01'], ['teacher', 'teacher', '2024-01-01'], ['admin', 'admin', '2024-02-01']]) {
    const id = (await db2.query(`insert into auth.users (email) values ($1) returning id`, [`${key}@old.hs.kr`])).rows[0].id;
    await db2.query(`insert into public.profiles (id, name, role, status, created_at) values ($1, $2, $3, 'active', $4)`, [id, key, role, day]);
    await db2.query(`insert into public.member_emails (user_id, email) values ($1, $2)`, [id, `${key}@old.hs.kr`]);
    oldIds[key] = id;
  }
  const sql = readFileSync(schemaPath, 'utf8');
  let mErr = null;
  try { await db2.exec(sql); } catch (e) { mErr = e.message; }
  ok(!mErr, '옛 구조 DB 에 새 schema.sql 적용 (' + (mErr || '성공') + ')');
  const q2 = async (s, p = []) => (await db2.query(s, p)).rows;
  ok((await q2(`select count(*)::int n from pg_constraint where conrelid = 'public.profiles'::regclass and contype = 'f'`))[0].n === 0, '이전: 회원→로그인 계정 외래 키 제거');
  ok((await q2(`select count(*)::int n from public.user_accounts where member_id = auth_id and status = 'active' and email like '%@old.hs.kr'`))[0].n === 3, '이전: 기존 회원마다 같은 ID 로 계정 연결 생성');
  const rl = async (k) => (await q2(`select coalesce(array_agg(role order by role), '{}') r from public.user_roles where member_id = $1`, [oldIds[k]]))[0].r;
  ok(J(await rl('teacher')) === '["admin","owner"]', '이전: teacher → 최고 관리자 + 관리자');
  ok(J(await rl('admin')) === '["vice"]', '이전: admin → 차장');
  ok(J(await rl('member')) === '[]', '이전: member → 직책 없음');
  const nos = (await q2(`select name, member_no from public.profiles order by member_no`)).map((x) => x.name + ':' + x.member_no).join(',');
  ok(nos === 'teacher:POP-0001,admin:POP-0002,member:POP-0003', '이전: 회원 번호는 가입 순서대로 (' + nos + ')');
  ok((await q2(`select count(*)::int n from public.academic_years where status = 'current'`))[0].n === 1, '이전: 현재 운영 연도 생성');
  ok((await q2(`select count(*)::int n from public.membership_history`))[0].n === 3, '이전: 활동 회원이 현재 연도 명단으로 복사됨');
  await db2.query(`delete from auth.users where id = $1`, [oldIds.member]);
  ok((await q2(`select count(*)::int n from public.profiles where id = $1`, [oldIds.member]))[0].n === 1, '이전 후: 로그인 계정을 지워도 회원이 남음');
  // 다시 적용해도 이미 바꾼 직책이 되살아나지 않는다
  await db2.query(`delete from public.user_roles where role = 'owner'`);
  await db2.query(`delete from public.user_accounts where member_id = $1`, [oldIds.admin]);
  let mErr2 = null;
  try { await db2.exec(sql); } catch (e) { mErr2 = e.message; }
  ok(!mErr2, '이전 후 schema.sql 재실행 (' + (mErr2 || '성공') + ')');
  ok(J(await rl('teacher')) === '["admin"]', '재실행해도 내려놓은 최고 관리자 직책이 되살아나지 않음');
  ok((await q2(`select count(*)::int n from public.user_accounts where member_id = $1`, [oldIds.admin]))[0].n === 0, '재실행해도 해제한 계정 연결이 되살아나지 않음');
  ok((await q2(`select count(*)::int n from public.academic_years`))[0].n === 1, '재실행해도 연도는 한 행');
}


console.log(`\n통과 ${pass} / 실패 ${failN}`);
process.exit(failN ? 1 : 0);
