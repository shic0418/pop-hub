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
let r = await as(T, `select role, status from profiles where id = $1`, [T]);
ok(r.rows[0].role === 'teacher' && r.rows[0].status === 'active', '부장 이메일 → teacher');
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
r = await as(A, `select set_user_role($1, 'teacher')`, [B]);
ok(r.err?.includes('부장 권한'), '부원은 역할 변경 불가');
r = await as(T, `select approve_user($1, 4)`, [B]);
ok(!r.err, '부장이 승인');
r = await as(T, `select approve_user($1, 4)`, [B]);
ok(r.err?.includes('승인 대기 중인 사용자가 아닙니다'), '중복 승인 차단');
r = await as(T, `select set_user_role($1, 'admin')`, [A]);
ok(!r.err, '역할 변경');

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
ok(r.err?.includes('부장'), '넘긴 신고는 부장만');
r = await as(T, `select resolve_report($1, 'hide')`, [RP]);
ok(!r.err, '부장이 숨김 처리');
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
ok(r.err?.includes('부장만'), '운영진(학생)은 도메인 변경 불가');
r = await as(A, `select update_settings(p_domain => 'school.hs.kr', p_club_name => '새 이름')`);
ok(!r.err, '도메인을 그대로 두고 다른 설정 저장은 가능');
r = await as(T, `select update_settings(p_signup_mode => 'approval')`);
ok(!r.err, '부장은 가입 방식 변경 가능');
const FV = (await as(B, `select head_version_id id from projects where id = $1`, [F])).rows[0].id;
r = await as(B, `select add_comment($1, 'main.py', 1, $2)`, [FV, 'x'.repeat(2001)]);
ok(r.err?.includes('2000자'), '댓글 길이 제한');
r = await as(B, `select report_project($1, '또 신고')`, [F]);
r = await as(B, `select report_project($1, '또 신고')`, [F]);
ok(r.err?.includes('이미 신고'), '중복 신고 차단');
await db.exec(`update private_settings set teacher_emails = array['Big@School.hs.kr'], whitelist = '{}'`);
const BIG = await signup('big@school.hs.kr', '대문자');
r = await as(BIG, `select role from profiles where id = $1`, [BIG]);
ok(r.rows[0]?.role === 'teacher', '대소문자 섞인 부장 이메일도 인식');

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

console.log(`\n통과 ${pass} / 실패 ${failN}`);
process.exit(failN ? 1 : 0);
