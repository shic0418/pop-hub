-- =====================================================================
-- 동아리 코드 저장소 · Supabase 스키마
-- Supabase 대시보드 → SQL Editor 에 이 파일 전체를 붙여 넣고 실행하세요.
--
-- 원칙
--  * 브라우저는 테이블을 "읽기"만 한다 (RLS select 정책).
--  * 모든 쓰기는 아래 서버 함수(RPC)로만 하며, 함수 안에서 권한을 다시 검사한다.
--  * 학교 도메인 검사는 가입 시점(auth.users 트리거)에서 서버가 한다.
--  * [v2.0] 회원(profiles)과 로그인 계정(user_accounts)은 분리되어 있다. 직책은 user_roles(복수 보유).
--    "지금 로그인한 회원"은 항상 private.my_member_id() 로 구한다.
-- =====================================================================

create schema if not exists private;

-- ---------------------------------------------------------------------
-- 테이블
-- ---------------------------------------------------------------------
create table if not exists public.settings (
  id           int primary key default 1 check (id = 1),
  club_name    text not null default '코딩 동아리',
  domain       text not null default 'example.hs.kr',
  signup_mode  text not null default 'approval' check (signup_mode in ('approval', 'whitelist')),
  max_file_kb  int  not null default 2048 check (max_file_kb between 1 and 10240)
);
insert into public.settings (id) values (1) on conflict do nothing;
-- 이미 만들어진 DB 에서도 새 용량 범위(최대 10MB)가 적용되도록 제약을 다시 건다
alter table public.settings drop constraint if exists settings_max_file_kb_check;
alter table public.settings add constraint settings_max_file_kb_check check (max_file_kb between 1 and 10240);
-- [v2.1] 팀·게시판 파일 업로드 한도(MB). Storage 파일에 적용된다.
alter table public.settings add column if not exists max_upload_mb int not null default 20;
alter table public.settings drop constraint if exists settings_max_upload_mb_check;
alter table public.settings add constraint settings_max_upload_mb_check check (max_upload_mb between 1 and 50);

-- 명단·부장 이메일은 운영진만 볼 수 있도록 따로 둔다
create table if not exists public.private_settings (
  id              int primary key default 1 check (id = 1),
  whitelist       text[] not null default '{}',
  teacher_emails  text[] not null default '{}'
);
insert into public.private_settings (id) values (1) on conflict do nothing;

create table if not exists public.profiles (
  id          uuid primary key,   -- 내부 회원 ID (로그인 계정 ID 와 별개. 계정 연결은 user_accounts)
  name        text not null,
  role        text not null default 'member' check (role in ('member', 'admin', 'teacher')),  -- 호환용(더 이상 쓰지 않음). 직책은 user_roles
  status      text not null default 'pending' check (status in ('pending', 'active', 'graduated')),
  generation  int,
  created_at  timestamptz not null default clock_timestamp()
);

-- 이메일은 본인과 운영진만 볼 수 있도록 분리
create table if not exists public.member_emails (
  user_id  uuid primary key references public.profiles (id) on delete cascade,
  email    text not null unique
);

create table if not exists public.projects (
  id               uuid primary key default gen_random_uuid(),
  title            text not null,
  description      text not null default '',
  owner_id         uuid not null references public.profiles (id),
  parent_id        uuid references public.projects (id),
  root_id          uuid not null,
  permission       text not null check (permission in ('free', 'approval', 'view')),
  generation       int,
  created_at       timestamptz not null default clock_timestamp(),
  updated_at       timestamptz not null default clock_timestamp(),
  deleted          boolean not null default false,
  deleted_at       timestamptz,
  deleted_by       uuid,
  hidden           boolean not null default false,
  head_version_id  uuid
);
create index if not exists projects_parent_idx on public.projects (parent_id);
create index if not exists projects_root_idx on public.projects (root_id);

create table if not exists public.versions (
  id                      uuid primary key default gen_random_uuid(),
  project_id              uuid not null references public.projects (id),
  message                 text not null,
  author_id               uuid not null references public.profiles (id),
  created_at              timestamptz not null default clock_timestamp(),
  files                   jsonb not null,           -- [{path, content}]
  forked_from_version_id  uuid,
  merge_request_id        uuid,
  approved_by             uuid
);
create index if not exists versions_project_idx on public.versions (project_id);

create table if not exists public.merge_requests (
  id                 uuid primary key default gen_random_uuid(),
  from_project_id    uuid not null references public.projects (id),
  to_project_id      uuid not null references public.projects (id),
  from_version_id    uuid not null references public.versions (id),
  base_version_id    uuid references public.versions (id),
  author_id          uuid not null references public.profiles (id),
  message            text not null,
  status             text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'closed')),
  created_at         timestamptz not null default clock_timestamp(),
  merged_version_id  uuid,
  note               text not null default '',
  resolved_at        timestamptz,
  resolved_by        uuid
);

create table if not exists public.fork_requests (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id),
  requester_id  uuid not null references public.profiles (id),
  title         text not null default '',
  message       text not null default '',
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'closed')),
  fork_id       uuid,
  created_at    timestamptz not null default clock_timestamp(),
  resolved_at   timestamptz
);

create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  version_id  uuid not null references public.versions (id),
  path        text not null,
  line        int  not null,
  author_id   uuid not null references public.profiles (id),
  text        text not null,
  created_at  timestamptz not null default clock_timestamp()
);
create index if not exists comments_version_idx on public.comments (version_id);

create table if not exists public.contributors (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects (id),
  user_id           uuid not null references public.profiles (id),
  merge_request_id  uuid,
  created_at        timestamptz not null default clock_timestamp(),
  unique (project_id, user_id)
);

create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  text        text not null,
  link        text,
  read        boolean not null default false,
  created_at  timestamptz not null default clock_timestamp()
);
create index if not exists notifications_user_idx on public.notifications (user_id);
-- 동시에 두 번 요청해도 대기 중인 요청·신고가 중복으로 생기지 않게 한다
create unique index if not exists mr_one_pending on public.merge_requests (from_project_id) where status = 'pending';
create unique index if not exists fr_one_pending on public.fork_requests (project_id, requester_id) where status = 'pending';

create table if not exists public.reports (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id),
  reporter_id  uuid not null references public.profiles (id),
  reason       text not null,
  status       text not null default 'open' check (status in ('open', 'escalated', 'resolved')),
  action       text,
  resolved_by  uuid,
  resolved_at  timestamptz,
  created_at   timestamptz not null default clock_timestamp()
);
create unique index if not exists report_one_open on public.reports (project_id, reporter_id) where status <> 'resolved';

-- ---------------------------------------------------------------------
-- [v2.0] 회원·계정 분리, 직책, 운영 연도, 서버 상태
-- ---------------------------------------------------------------------
-- 회원(profiles)이 로그인 계정(auth.users)에 묶여 있던 외래 키를 푼다 → 계정이 사라져도 회원은 남는다
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.profiles'::regclass and contype = 'f' and confrelid = 'auth.users'::regclass loop
    execute format('alter table public.profiles drop constraint %I', c.conname);
  end loop;
end $$;

-- 회원 번호 POP-0001 (생성 순서). 기존 회원은 가입 순서대로 채운다.
create sequence if not exists public.member_no_seq;
alter table public.profiles add column if not exists member_no text;
do $$
declare r record;
begin
  for r in select id from public.profiles where member_no is null order by created_at, id loop
    update public.profiles set member_no = 'POP-' || lpad(nextval('public.member_no_seq')::text, 4, '0') where id = r.id;
  end loop;
end $$;
alter table public.profiles alter column member_no set default ('POP-' || lpad(nextval('public.member_no_seq')::text, 4, '0'));
create unique index if not exists profiles_member_no_key on public.profiles (member_no);

alter table public.projects add column if not exists year int;
create index if not exists projects_year_idx on public.projects (year);

-- 로그인 계정 ↔ 회원 (한 회원에 여러 계정 가능)
create table if not exists public.user_accounts (
  auth_id    uuid primary key,
  member_id  uuid not null references public.profiles (id),
  email      text,
  linked_at  timestamptz not null default clock_timestamp(),
  linked_by  uuid,
  status     text not null default 'active' check (status in ('active', 'unlinked', 'removed'))
);
create index if not exists user_accounts_member_idx on public.user_accounts (member_id);

-- 새 학년 계정을 미리 기존 회원에게 묶어 두는 사전 등록 (그 이메일로 첫 로그인하면 자동 연결)
create table if not exists public.account_invites (
  email       text primary key,
  member_id   uuid not null references public.profiles (id) on delete cascade,
  created_by  uuid,
  created_at  timestamptz not null default clock_timestamp()
);

-- 직책
create table if not exists public.roles (
  code   text primary key,
  label  text not null,
  sort   int not null default 0
);
insert into public.roles (code, label, sort) values
  ('owner', '최고 관리자', 1), ('admin', '관리자', 2), ('president', '부장', 3), ('vice', '차장', 4), ('server', '서버 관리자', 5)
on conflict (code) do update set label = excluded.label, sort = excluded.sort;

create table if not exists public.user_roles (
  member_id   uuid not null references public.profiles (id) on delete cascade,
  role        text not null references public.roles (code),
  granted_by  uuid,
  granted_at  timestamptz not null default clock_timestamp(),
  primary key (member_id, role)
);
create index if not exists user_roles_role_idx on public.user_roles (role);

-- 위임·세부 권한: 미리 정한 목록 안에서만 켜고 끌 수 있다. 서버 관리자에게는 개인정보·관리 기능을 줄 수 없다.
create table if not exists public.role_permissions (
  role     text not null references public.roles (code),
  perm     text not null,
  enabled  boolean not null default false,
  primary key (role, perm),
  check ((role = 'server' and perm in ('server.detail', 'server.backup', 'server.errors'))
      or (role in ('president', 'vice') and perm = 'accounts.link'))
);
insert into public.role_permissions (role, perm, enabled) values
  ('server', 'server.detail', true), ('server', 'server.backup', true), ('server', 'server.errors', true),
  ('president', 'accounts.link', false), ('vice', 'accounts.link', false)
on conflict (role, perm) do nothing;

-- 최고 관리자 이양 (제안 → 상대방 수락)
create table if not exists public.owner_transfers (
  id           uuid primary key default gen_random_uuid(),
  from_member  uuid not null references public.profiles (id),
  to_member    uuid not null references public.profiles (id),
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'cancelled')),
  created_at   timestamptz not null default clock_timestamp(),
  decided_at   timestamptz
);
create unique index if not exists owner_transfer_one_pending on public.owner_transfers (from_member) where status = 'pending';

-- 감사 기록: 쓰기는 서버 함수만, 수정·삭제는 누구도 못 한다
create table if not exists public.audit_logs (
  id             bigserial primary key,
  at             timestamptz not null default clock_timestamp(),
  actor          uuid,
  action         text not null,
  target_member  uuid,
  detail         jsonb not null default '{}'::jsonb
);
create index if not exists audit_logs_at_idx on public.audit_logs (at desc);

-- 운영 연도·차시
create table if not exists public.academic_years (
  year        int primary key,
  starts_on   date not null,
  ends_on     date not null,
  status      text not null default 'current' check (status in ('current', 'archived')),
  created_at  timestamptz not null default clock_timestamp()
);
create table if not exists public.sessions (
  id           uuid primary key default gen_random_uuid(),
  year         int not null references public.academic_years (year),
  no           int not null check (no between 1 and 10),
  title        text not null default '',
  held_on      date,
  description  text not null default '',
  unique (year, no)
);
create table if not exists public.membership_history (
  member_id   uuid not null references public.profiles (id) on delete cascade,
  year        int not null,
  generation  int,
  grade       int,
  roles       text[] not null default '{}',
  status      text not null default 'active',
  joined_on   date,
  left_on     date,
  primary key (member_id, year)
);
-- [v2.2] 명단 가져오기(CSV)의 직책 칸은 메모로만 보관한다 (직책은 [직책] 탭에서만 부여)
alter table public.membership_history add column if not exists note text not null default '';
create table if not exists public.project_sessions (
  project_id  uuid not null references public.projects (id),
  session_id  uuid not null references public.sessions (id),
  linked_by   uuid,
  linked_at   timestamptz not null default clock_timestamp(),
  primary key (project_id, session_id)
);
create index if not exists project_sessions_session_idx on public.project_sessions (session_id);

-- 서버 상태 기록: 연결 확인(ping)·백업·오류. 개인정보는 넣지 않는다.
create table if not exists public.system_status (
  id      bigserial primary key,
  at      timestamptz not null default clock_timestamp(),
  kind    text not null check (kind in ('ping', 'backup', 'error')),
  ok      boolean not null default true,
  detail  jsonb not null default '{}'::jsonb
);
create index if not exists system_status_kind_idx on public.system_status (kind, at desc);

-- 한 번만 하는 데이터 이전 표시 (private: API 로 접근 불가)
create table if not exists private.migrations (
  name        text primary key,
  applied_at  timestamptz not null default now()
);

-- 운영 연도 규칙: N년 3월 1일 ~ N+1년 2월 말일 (한국 시간)
create or replace function private.year_of(p_ts timestamptz) returns int
language sql stable as $$
  select extract(year from ((p_ts at time zone 'Asia/Seoul')::date - interval '2 months'))::int
$$;

-- 기존 프로젝트의 운영 연도: 업로드 날짜로 계산한다 (차시는 추정하지 않는다)
update public.projects set year = private.year_of(created_at) where year is null;

-- 기존 데이터 이전: 처음 한 번만 (다시 실행해도 되살아나지 않게 표시를 남긴다)
do $$
begin
  if exists (select 1 from private.migrations where name = 'v2_members_roles') then return; end if;
  -- 기존 회원 ID = 로그인 계정 ID 이므로 같은 값으로 연결을 1행씩 만든다 → 기존 참조가 전부 그대로 유효
  insert into public.user_accounts (auth_id, member_id, email)
  select p.id, p.id, coalesce(me.email, au.email)
    from public.profiles p
    left join public.member_emails me on me.user_id = p.id
    left join auth.users au on au.id = p.id
  on conflict (auth_id) do nothing;
  -- 직책 변환: teacher → 최고 관리자 + 관리자, admin → 차장
  insert into public.user_roles (member_id, role) select id, 'owner' from public.profiles where role = 'teacher' on conflict do nothing;
  insert into public.user_roles (member_id, role) select id, 'admin' from public.profiles where role = 'teacher' on conflict do nothing;
  insert into public.user_roles (member_id, role) select id, 'vice' from public.profiles where role = 'admin' on conflict do nothing;
  insert into private.migrations (name) values ('v2_members_roles');
end $$;

-- ---------------------------------------------------------------------
-- 권한 판단 함수 (private 스키마: API로 직접 호출 불가)
-- ---------------------------------------------------------------------
-- "지금 로그인한 회원" = 로그인 계정(auth.uid()) 에 연결된 회원 ID.
-- 회원을 뜻하는 곳에서는 auth.uid() 를 직접 쓰지 말고 이 함수를 쓴다.
create or replace function private.my_member_id() returns uuid
language sql stable security definer set search_path = public as $$
  select member_id from user_accounts where auth_id = auth.uid() and status = 'active'
$$;
create or replace function private.my_status() returns text
language sql stable security definer set search_path = public as $$
  select status from profiles where id = private.my_member_id()
$$;
create or replace function private.is_reader() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(private.my_status() in ('active', 'graduated'), false)
$$;
-- 활동 중인 회원이 그 직책을 가졌는가
create or replace function private.has_role(p_role text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from user_roles ur join profiles p on p.id = ur.member_id
     where ur.member_id = private.my_member_id() and ur.role = p_role and p.status = 'active')
$$;
create or replace function private.is_owner() returns boolean
language sql stable security definer set search_path = public as $$ select private.has_role('owner') $$;
-- 관리자 = 최고 관리자 또는 관리자 (예전의 "부장" 권한)
create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select private.has_role('owner') or private.has_role('admin')
$$;
-- 운영진 = 관리자·최고 관리자·부장·차장. 서버 관리자는 포함하지 않는다.
create or replace function private.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from user_roles ur join profiles p on p.id = ur.member_id
     where ur.member_id = private.my_member_id() and p.status = 'active'
       and ur.role in ('owner', 'admin', 'president', 'vice'))
$$;
-- 세부 권한: 관리자는 항상, 그 밖에는 직책별로 관리자가 켜 둔 것만
create or replace function private.has_perm(p_perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select private.is_admin() or exists (
    select 1 from user_roles ur join profiles p on p.id = ur.member_id
      join role_permissions rp on rp.role = ur.role
     where ur.member_id = private.my_member_id() and p.status = 'active' and rp.perm = p_perm and rp.enabled)
$$;
create or replace function private.can_see(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select private.is_reader() and exists (
    select 1 from projects where id = p_project and (not hidden or private.is_staff()))
$$;
-- 코드 내용(버전)까지 볼 수 있는지: 삭제된 프로젝트의 코드는 운영진만
create or replace function private.can_read_code(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select private.is_reader() and exists (
    select 1 from projects where id = p_project and ((not hidden and not deleted) or private.is_staff()))
$$;

create or replace function private.require_reader() returns public.profiles
language plpgsql stable security definer set search_path = public as $$
declare u profiles;
begin
  select * into u from profiles where id = private.my_member_id();
  if u.id is null then raise exception '로그인이 필요합니다.'; end if;
  if u.status = 'pending' then raise exception '가입 승인 대기 중입니다.'; end if;
  if u.status not in ('active', 'graduated') then raise exception '접근할 수 없는 계정입니다.'; end if;
  return u;
end $$;
create or replace function private.require_active() returns public.profiles
language plpgsql stable security definer set search_path = public as $$
declare u profiles;
begin
  u := private.require_reader();
  if u.status = 'graduated' then raise exception '졸업생 계정은 읽기 전용입니다.'; end if;
  return u;
end $$;
create or replace function private.require_staff() returns public.profiles
language plpgsql stable security definer set search_path = public as $$
declare u profiles;
begin
  u := private.require_active();
  if not private.is_staff() then raise exception '운영진 권한이 필요합니다.'; end if;
  return u;
end $$;
create or replace function private.require_admin() returns public.profiles
language plpgsql stable security definer set search_path = public as $$
declare u profiles;
begin
  u := private.require_active();
  if not private.is_admin() then raise exception '관리자 권한이 필요합니다.'; end if;
  return u;
end $$;
-- 계정 연결·해제·병합: 관리자, 또는 관리자가 위임한 부장·차장
create or replace function private.require_account_manager() returns public.profiles
language plpgsql stable security definer set search_path = public as $$
declare u profiles;
begin
  u := private.require_active();
  if not private.has_perm('accounts.link') then raise exception '계정 연결 권한이 필요합니다.'; end if;
  return u;
end $$;
-- 관리자·최고 관리자·서버 관리자 회원의 계정을 건드리는 일은 관리자만 (위임받은 부장·차장이 관리자 권한을 가로채지 못하게)
create or replace function private.guard_privileged_target(p_member uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if exists (select 1 from user_roles where member_id = p_member and role in ('owner', 'admin', 'server')) and not private.is_admin() then
    raise exception '관리자·서버 관리자 회원의 계정은 관리자만 연결·해제할 수 있습니다.';
  end if;
end $$;
-- 보이는 프로젝트를 가져오거나 오류
create or replace function private.get_project(p_id uuid) returns public.projects
language plpgsql stable security definer set search_path = public as $$
declare p projects;
begin
  perform private.require_reader();
  select * into p from projects where id = p_id;
  if p.id is null then raise exception '프로젝트를 찾을 수 없습니다.'; end if;
  if p.hidden and not private.is_staff() then raise exception '운영진이 숨김 처리한 프로젝트입니다.'; end if;
  return p;
end $$;

-- 감사 기록 한 줄 (행위자 = 지금 로그인한 회원. 가입 트리거처럼 로그인 없이 불릴 때는 비어 있다)
create or replace function private.audit(p_action text, p_target uuid, p_detail jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into audit_logs (actor, action, target_member, detail) values (private.my_member_id(), p_action, p_target, coalesce(p_detail, '{}'::jsonb));
end $$;
-- 감사 기록은 고칠 수도 지울 수도 없다 (서버 함수도, 관리자도)
create or replace function private.audit_immutable() returns trigger
language plpgsql as $$
begin
  raise exception '감사 기록은 수정하거나 지울 수 없습니다.';
end $$;
drop trigger if exists audit_logs_no_change on public.audit_logs;
create trigger audit_logs_no_change before update or delete on public.audit_logs
  for each row execute function private.audit_immutable();
drop trigger if exists audit_logs_no_truncate on public.audit_logs;
create trigger audit_logs_no_truncate before truncate on public.audit_logs
  for each statement execute function private.audit_immutable();

-- ---------------------------------------------------------------------
-- 내부 도우미
-- ---------------------------------------------------------------------
create or replace function private.check_len(p_value text, p_max int, p_label text) returns void
language plpgsql immutable as $$
begin
  if char_length(coalesce(p_value, '')) > p_max then raise exception '%은(는) %자까지 쓸 수 있습니다.', p_label, p_max; end if;
end $$;
create or replace function private.notify(p_user uuid, p_text text, p_link text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_user is null or p_user = private.my_member_id() then return; end if;
  insert into notifications (user_id, text, link) values (p_user, p_text, p_link);
end $$;
create or replace function private.notify_staff(p_text text, p_link text) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select distinct p.id from profiles p join user_roles ur on ur.member_id = p.id
            where p.status = 'active' and ur.role in ('owner', 'admin', 'president', 'vice') loop
    perform private.notify(r.id, p_text, p_link);
  end loop;
end $$;

-- 파일 목록 정리: path/content 외의 값은 버린다
create or replace function private.clean_files(p_files jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(jsonb_build_object('path', f ->> 'path', 'content', f ->> 'content')), '[]'::jsonb)
  from jsonb_array_elements(p_files) f
$$;
-- 내용 비교용 {path: content} 객체
create or replace function private.files_map(p_files jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(f ->> 'path', f ->> 'content'), '{}'::jsonb) from jsonb_array_elements(p_files) f
$$;

create or replace function private.validate_files(p_files jsonb) returns void
language plpgsql stable security definer set search_path = public as $$
declare
  lim int; f jsonb; p text; d text; total bigint := 0; paths text[] := '{}'; has_readme boolean := false;
begin
  select max_file_kb * 1024 into lim from settings where id = 1;
  if p_files is null or jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) = 0 then
    raise exception '파일이 하나도 없습니다.';
  end if;
  if jsonb_array_length(p_files) > 500 then raise exception '파일이 너무 많습니다(최대 500개).'; end if;
  for f in select * from jsonb_array_elements(p_files) loop
    p := f ->> 'path';
    if jsonb_typeof(f) <> 'object' or p is null or jsonb_typeof(f -> 'content') is distinct from 'string' then
      raise exception '잘못된 파일 데이터입니다.';
    end if;
    if p = '' or p ~ '(^/|/$|//|\\)' or p ~ '(^|/)\.\.?(/|$)' or length(p) > 300 then
      raise exception '잘못된 파일 경로: %', p;
    end if;
    if p = any (paths) then raise exception '같은 경로의 파일이 두 개 있습니다: %', p; end if;
    paths := paths || p;
    if octet_length(f ->> 'content') > lim then
      raise exception '% 파일이 용량 제한(%KB)을 넘습니다.', p, lim / 1024;
    end if;
    total := total + octet_length(f ->> 'content');
    if lower(p) = 'readme.md' then has_readme := true; end if;
  end loop;
  if total > 10 * 1024 * 1024 then raise exception '프로젝트 전체 크기가 10MB를 넘습니다.'; end if;
  if not has_readme then raise exception 'README.md 파일이 필요합니다. (프로젝트 설명·실행 방법)'; end if;
  foreach p in array paths loop
    d := p;
    while position('/' in d) > 0 loop
      d := regexp_replace(d, '/[^/]*$', '');
      if d = any (paths) then raise exception '파일과 폴더 이름이 겹칩니다: %', d; end if;
    end loop;
  end loop;
end $$;

create or replace function private.add_version(
  p_project uuid, p_author uuid, p_files jsonb, p_message text,
  p_forked_from uuid default null, p_mr uuid default null, p_approved_by uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into versions (project_id, message, author_id, files, forked_from_version_id, merge_request_id, approved_by)
  values (p_project, p_message, p_author, private.clean_files(p_files), p_forked_from, p_mr, p_approved_by)
  returning id into v_id;
  update projects set head_version_id = v_id, updated_at = clock_timestamp() where id = p_project;
  return v_id;
end $$;

-- 'ok' | 'approval' | 불가 사유
create or replace function private.fork_check(p projects, u profiles) returns text
language plpgsql stable as $$
begin
  if u.id is null or u.status <> 'active' then return '활동 중인 부원만 수정본을 만들 수 있습니다.'; end if;
  if p.deleted then return '삭제된 프로젝트입니다.'; end if;
  if p.owner_id = u.id then return '내 프로젝트는 [편집]으로 새 버전을 올리세요.'; end if;
  if p.permission = 'view' then return '원작자가 "보기만 가능"으로 설정했습니다.'; end if;
  if p.permission = 'approval' then return 'approval'; end if;
  return 'ok';
end $$;

-- 원작자가 졸업생이면 운영진이 대신 처리할 수 있다
create or replace function private.can_resolve_for(p projects, u profiles) returns boolean
language sql stable security definer set search_path = public as $$
  select u.status = 'active' and (
    p.owner_id = u.id
    or (private.is_staff() and coalesce((select status from profiles where id = p.owner_id), '') <> 'active'))
$$;

create or replace function private.do_fork(src projects, owner profiles, p_title text, p_description text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := gen_random_uuid();
  head versions;
  root projects;
  v_title text := coalesce(nullif(trim(p_title), ''), src.title || ' 수정본');
begin
  select * into head from versions where id = src.head_version_id;
  insert into projects (id, title, description, owner_id, parent_id, root_id, permission, generation, year)
  values (v_id, v_title, coalesce(trim(p_description), ''), owner.id, src.id, src.root_id, 'free', owner.generation, private.year_of(now()));
  perform private.add_version(v_id, owner.id, head.files, format('「%s」에서 수정본 생성', src.title), head.id);
  perform private.notify(src.owner_id, format('%s 님이 「%s」의 수정본 「%s」을 만들었습니다.', owner.name, src.title, v_title), '#/p/' || v_id);
  select * into root from projects where id = src.root_id;
  if root.owner_id is distinct from src.owner_id then
    perform private.notify(root.owner_id, format('내 원본 「%s」 트리에 새 수정본 「%s」이 생겼습니다.', root.title, v_title), '#/p/' || v_id || '/tree');
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- 가입 처리: auth.users 에 사용자가 생길 때 서버가 도메인을 검사한다
-- ---------------------------------------------------------------------
-- 가입 처리는 두 단계로 나눈다.
--  1) 계정이 처음 만들어질 때(INSERT): 학교 도메인만 검사한다. 다른 도메인은 여기서 바로 막는다.
--  2) Google 로그인 확인이 끝났을 때(INSERT 또는 UPDATE): 프로필을 만든다.
--     Supabase 는 Google 계정을 먼저 만든 뒤 "이메일 확인·로그인 방식"을 따로 채우기 때문에,
--     처음 INSERT 시점에는 그 값이 비어 있을 수 있다.
-- 현재 운영 연도 명단에 회원 한 명을 넣는다 (이미 있으면 그대로)
create or replace function private.touch_membership(p_member uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into membership_history (member_id, year, generation, roles, status, joined_on)
  select p.id, y.year, p.generation, coalesce(array(select ur.role from user_roles ur where ur.member_id = p.id order by ur.role), '{}'), 'active',
         (now() at time zone 'Asia/Seoul')::date
    from profiles p, academic_years y
   where p.id = p_member and y.status = 'current'
  on conflict (member_id, year) do nothing;
end $$;

create or replace function private.create_profile_if_ready(p_user auth.users) returns void
language plpgsql security definer set search_path = public as $$
declare
  s settings; ps private_settings; inv account_invites;
  em text := lower(coalesce(p_user.email, ''));
  nm text; st text; is_teacher boolean := false; v_member uuid;
begin
  -- 이미 연결된 계정이면 할 일 없음 (연결 해제·삭제된 계정은 아래에서 다시 가입 처리)
  if exists (select 1 from user_accounts where auth_id = p_user.id and status = 'active') then return; end if;
  -- Google 로그인으로 확인된 이메일만 프로필을 받는다 (이메일·비밀번호 가입 등은 프로필 없음 = 이용 불가)
  if p_user.email_confirmed_at is null then return; end if;
  if coalesce(p_user.raw_app_meta_data ->> 'provider', '') <> 'google'
     and not exists (select 1 from auth.identities i where i.user_id = p_user.id and i.provider = 'google') then
    return;
  end if;
  select * into s from settings where id = 1;
  select * into ps from private_settings where id = 1;
  if s.domain is null or ps.id is null then raise exception '서버 설정이 없습니다. schema.sql 을 다시 실행하세요.'; end if;
  if right(em, length(s.domain) + 1) is distinct from '@' || lower(s.domain) then
    raise exception '학교 계정(@%)으로만 가입할 수 있습니다.', s.domain;
  end if;

  -- 관리자가 미리 등록해 둔 이메일이면 새 회원을 만들지 않고 기존 회원에 연결한다 (이름이 같다는 이유로는 절대 합치지 않는다)
  select * into inv from account_invites where email = em;
  if inv.email is not null then
    insert into user_accounts (auth_id, member_id, email, linked_by, status)
    values (p_user.id, inv.member_id, em, inv.created_by, 'active')
    on conflict (auth_id) do update set member_id = excluded.member_id, email = excluded.email, linked_by = excluded.linked_by,
      linked_at = clock_timestamp(), status = 'active';
    delete from account_invites where email = em;
    insert into audit_logs (actor, action, target_member, detail)
    values (null, 'account.linked', inv.member_id, jsonb_build_object('email', em, 'via', 'invite', 'auth_id', p_user.id));
    perform private.notify(inv.member_id, '새 로그인 계정이 내 회원 정보에 연결되었습니다.', '#/me');
    return;
  end if;

  nm := left(coalesce(nullif(p_user.raw_user_meta_data ->> 'full_name', ''), nullif(p_user.raw_user_meta_data ->> 'name', ''), split_part(em, '@', 1)), 50);
  if em in (select lower(trim(x)) from unnest(ps.teacher_emails) x) then st := 'active'; is_teacher := true;
  elsif em in (select lower(trim(x)) from unnest(ps.whitelist) x) then st := 'active';
  elsif s.signup_mode = 'whitelist' then raise exception '부원 명단에 없는 계정입니다.';
  else st := 'pending';
  end if;
  -- 예전 계정 ID 와 같은 회원 ID 가 이미 있으면 겹치지 않게 새 ID 를 쓴다
  v_member := case when exists (select 1 from profiles where id = p_user.id) then gen_random_uuid() else p_user.id end;
  insert into profiles (id, name, status) values (v_member, nm, st);
  insert into user_accounts (auth_id, member_id, email, status) values (p_user.id, v_member, em, 'active')
    on conflict (auth_id) do update set member_id = excluded.member_id, email = excluded.email, linked_at = clock_timestamp(), status = 'active';
  insert into member_emails (user_id, email) values (v_member, em) on conflict do nothing;
  if is_teacher then
    -- 처음 등록된 부장 이메일은 최고 관리자, 이미 최고 관리자가 있으면 관리자
    if not exists (select 1 from user_roles where role = 'owner') then
      insert into user_roles (member_id, role) values (v_member, 'owner') on conflict do nothing;
    end if;
    insert into user_roles (member_id, role) values (v_member, 'admin') on conflict do nothing;
  end if;
  if st = 'active' then perform private.touch_membership(v_member); end if;
  if st = 'pending' then
    perform private.notify_staff(format('%s(%s) 님이 가입 승인을 기다립니다.', nm, em), '#/admin?tab=pending');
  end if;
end $$;

create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare s settings;
begin
  select * into s from settings where id = 1;
  if s.domain is null then raise exception '서버 설정이 없습니다. schema.sql 을 다시 실행하세요.'; end if;
  if right(lower(coalesce(new.email, '')), length(s.domain) + 1) is distinct from '@' || lower(s.domain) then
    raise exception '학교 계정(@%)으로만 가입할 수 있습니다.', s.domain;
  end if;
  perform private.create_profile_if_ready(new);
  return new;
end $$;

create or replace function private.handle_user_updated() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform private.create_profile_if_ready(new);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();
drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated after update on auth.users
  for each row execute function private.handle_user_updated();

-- ---------------------------------------------------------------------
-- RPC: 사용자·설정 관리
-- ---------------------------------------------------------------------
-- 이 회원이 활동 중인 마지막 관리자(최고 관리자 포함)인가
create or replace function private.is_last_admin(p_member uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from user_roles ur join profiles p on p.id = ur.member_id
                  where ur.member_id = p_member and p.status = 'active' and ur.role in ('owner', 'admin'))
     and not exists (select 1 from user_roles ur join profiles p on p.id = ur.member_id
                      where ur.member_id <> p_member and p.status = 'active' and ur.role in ('owner', 'admin'))
$$;

create or replace function public.approve_user(p_id uuid, p_generation int default null) returns void
language plpgsql security definer set search_path = public as $$
declare t profiles;
begin
  perform private.require_staff();
  select * into t from profiles where id = p_id;
  if t.id is null then raise exception '사용자가 없습니다.'; end if;
  if t.status <> 'pending' then raise exception '승인 대기 중인 사용자가 아닙니다.'; end if;
  update profiles set status = 'active', generation = coalesce(p_generation, generation) where id = p_id;
  perform private.touch_membership(p_id);
  perform private.audit('member.approved', p_id, jsonb_build_object('generation', p_generation));
  perform private.notify(p_id, '가입이 승인되었습니다. 환영합니다!', '#/');
end $$;

create or replace function public.reject_user(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t profiles;
begin
  perform private.require_staff();
  select * into t from profiles where id = p_id;
  if t.id is null then raise exception '사용자가 없습니다.'; end if;
  if t.status <> 'pending' then raise exception '승인 대기 중인 사용자만 거절할 수 있습니다.'; end if;
  perform private.audit('member.rejected', null, jsonb_build_object('member', p_id, 'member_no', t.member_no, 'name', t.name));
  delete from auth.users where id in (select auth_id from user_accounts where member_id = p_id);   -- 로그인 계정 삭제 (다시 신청 가능)
  delete from user_accounts where member_id = p_id;
  delete from profiles where id = p_id;   -- 대기 회원은 기록이 없으므로 함께 정리된다
end $$;

create or replace function public.set_user_status(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare cur profiles; t profiles;
begin
  cur := private.require_staff();
  select * into t from profiles where id = p_id;
  if t.id is null then raise exception '사용자가 없습니다.'; end if;
  if p_status not in ('active', 'graduated') then raise exception '잘못된 상태입니다.'; end if;
  if t.status = 'pending' then raise exception '승인 대기 중인 사용자는 먼저 승인하세요.'; end if;
  if t.id = cur.id then raise exception '자기 자신의 상태는 바꿀 수 없습니다.'; end if;
  -- 관리자가 0명이 되면 안 된다
  if p_status = 'graduated' and private.is_last_admin(p_id) then raise exception '마지막 관리자는 졸업 처리할 수 없습니다.'; end if;
  if exists (select 1 from user_roles where member_id = p_id and role in ('owner', 'admin')) and not private.is_owner() then
    raise exception '관리자·최고 관리자의 상태는 최고 관리자만 바꿀 수 있습니다.';
  end if;
  update profiles set status = p_status where id = p_id;
  if p_status = 'active' then perform private.touch_membership(p_id); end if;
  perform private.audit('member.status', p_id, jsonb_build_object('from', t.status, 'to', p_status));
end $$;

-- 예전 "역할 변경" 함수는 없앴다. 직책은 appoint_role / revoke_role 로만 바꾼다.
drop function if exists public.set_user_role(uuid, text);

create or replace function public.set_user_generation(p_id uuid, p_generation int) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform private.require_staff();
  if p_generation is not null and p_generation < 1 then raise exception '기수는 1 이상이어야 합니다.'; end if;
  update profiles set generation = p_generation where id = p_id;
  if not found then raise exception '사용자가 없습니다.'; end if;
end $$;

-- 인자가 늘어 예전 함수와 겹치지 않도록 먼저 지운다
drop function if exists public.update_settings(text, text, text, int, text[]);
create or replace function public.update_settings(
  p_club_name text default null, p_domain text default null, p_signup_mode text default null,
  p_max_file_kb int default null, p_whitelist text[] default null, p_max_upload_mb int default null
) returns void
language plpgsql security definer set search_path = public as $$
declare d text;
begin
  perform private.require_staff();
  if nullif(trim(p_club_name), '') is not null then update settings set club_name = trim(p_club_name) where id = 1; end if;
  if (p_domain is not null and p_domain is distinct from (select domain from settings where id = 1))
     or (p_signup_mode is not null and p_signup_mode is distinct from (select signup_mode from settings where id = 1))
     or (p_max_file_kb is not null and p_max_file_kb is distinct from (select max_file_kb from settings where id = 1))
     or (p_max_upload_mb is not null and p_max_upload_mb is distinct from (select max_upload_mb from settings where id = 1)) then
    if not private.is_admin() then raise exception '학교 도메인·가입 방식·파일 용량은 관리자만 바꿀 수 있습니다.'; end if;
  end if;
  perform private.check_len(p_club_name, 40, '동아리 이름');
  if p_domain is not null then
    d := lower(regexp_replace(trim(p_domain), '^@', ''));
    if d !~ '^[a-z0-9.-]+\.[a-z]{2,}$' then raise exception '도메인 형식이 올바르지 않습니다.'; end if;
    update settings set domain = d where id = 1;
  end if;
  if p_signup_mode is not null then
    if p_signup_mode not in ('approval', 'whitelist') then raise exception '잘못된 가입 방식'; end if;
    update settings set signup_mode = p_signup_mode where id = 1;
  end if;
  if p_max_file_kb is not null then
    if p_max_file_kb not between 1 and 10240 then raise exception '파일 용량 제한은 1~10240KB(10MB) 사이로 정하세요.'; end if;
    update settings set max_file_kb = p_max_file_kb where id = 1;
  end if;
  if p_max_upload_mb is not null then
    if p_max_upload_mb not between 1 and 50 then raise exception '업로드 용량 제한은 1~50MB 사이로 정하세요.'; end if;
    update settings set max_upload_mb = p_max_upload_mb where id = 1;
  end if;
  if p_whitelist is not null then
    update private_settings
       set whitelist = coalesce((select array_agg(distinct lower(trim(e))) from unnest(p_whitelist) e where trim(e) <> ''), '{}')
     where id = 1;
  end if;
  perform private.audit('settings.updated', null, jsonb_strip_nulls(jsonb_build_object(
    'club_name', nullif(trim(p_club_name), ''), 'domain', p_domain, 'signup_mode', p_signup_mode, 'max_file_kb', p_max_file_kb, 'max_upload_mb', p_max_upload_mb,
    'whitelist_count', case when p_whitelist is null then null else cardinality(p_whitelist) end)));
end $$;

-- ---------------------------------------------------------------------
-- RPC: 프로젝트·버전
-- ---------------------------------------------------------------------
create or replace function public.create_project(
  p_title text, p_description text, p_permission text, p_generation int, p_files jsonb, p_message text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare u profiles; v_id uuid := gen_random_uuid();
begin
  u := private.require_active();
  if nullif(trim(p_title), '') is null then raise exception '제목을 입력하세요.'; end if;
  perform private.check_len(trim(p_title), 100, '제목'); perform private.check_len(p_description, 1000, '설명'); perform private.check_len(p_message, 500, '변경 설명');
  if p_permission is null or p_permission not in ('free', 'approval', 'view') then raise exception '수정 허용 범위를 선택하세요.'; end if;
  if p_generation is not null and p_generation < 1 then raise exception '기수는 1 이상이어야 합니다.'; end if;
  perform private.validate_files(p_files);
  insert into projects (id, title, description, owner_id, root_id, permission, generation, year)
  values (v_id, trim(p_title), coalesce(trim(p_description), ''), u.id, v_id, p_permission, coalesce(p_generation, u.generation), private.year_of(now()));
  perform private.add_version(v_id, u.id, p_files, coalesce(nullif(trim(p_message), ''), '처음 업로드'));
  return v_id;
end $$;

-- null 인 값은 바꾸지 않는다. p_generation = '' 이면 기수 미지정으로.
create or replace function public.update_project_info(
  p_id uuid, p_title text default null, p_description text default null, p_permission text default null, p_generation text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; p projects;
begin
  u := private.require_active();
  p := private.get_project(p_id);
  if p.deleted then raise exception '삭제된 프로젝트입니다.'; end if;
  if p_generation is not null then
    if p.owner_id <> u.id and not private.is_staff() then raise exception '작성자 또는 운영진만 기수를 바꿀 수 있습니다.'; end if;
    if trim(p_generation) = '' then update projects set generation = null where id = p_id;
    elsif trim(p_generation) ~ '^[1-9][0-9]{0,3}$' then update projects set generation = trim(p_generation)::int where id = p_id;
    else raise exception '기수는 1 이상의 숫자로 입력하세요.';
    end if;
  end if;
  if p_title is null and p_description is null and p_permission is null then return; end if;
  if p.owner_id <> u.id then raise exception '작성자만 수정할 수 있습니다.'; end if;
  if p_title is not null then
    if trim(p_title) = '' then raise exception '제목을 입력하세요.'; end if;
    perform private.check_len(trim(p_title), 100, '제목');
    update projects set title = trim(p_title) where id = p_id;
  end if;
  perform private.check_len(p_description, 1000, '설명');
  if p_description is not null then update projects set description = trim(p_description) where id = p_id; end if;
  if p_permission is not null then
    if p_permission not in ('free', 'approval', 'view') then raise exception '잘못된 허용 범위'; end if;
    update projects set permission = p_permission where id = p_id;
  end if;
end $$;

create or replace function public.commit_version(p_project uuid, p_files jsonb, p_message text) returns uuid
language plpgsql security definer set search_path = public as $$
declare u profiles; p projects; head versions;
begin
  u := private.require_active();
  p := private.get_project(p_project);
  if p.deleted then raise exception '삭제된 프로젝트입니다.'; end if;
  if p.owner_id <> u.id then raise exception '작성자만 새 버전을 올릴 수 있습니다. 다른 사람의 프로젝트는 [수정본 만들기]를 이용하세요.'; end if;
  if nullif(trim(p_message), '') is null then raise exception '변경 설명을 입력하세요.'; end if;
  perform private.check_len(trim(p_message), 500, '변경 설명');
  perform private.validate_files(p_files);
  select * into head from versions where id = p.head_version_id;
  if private.files_map(head.files) = private.files_map(p_files) then raise exception '바뀐 내용이 없습니다.'; end if;
  return private.add_version(p.id, u.id, p_files, trim(p_message));
end $$;

create or replace function public.delete_project(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; p projects; c record;
begin
  u := private.require_active();
  p := private.get_project(p_id);
  if p.owner_id <> u.id and not private.is_staff() then raise exception '작성자 또는 운영진만 삭제할 수 있습니다.'; end if;
  if p.deleted then raise exception '이미 삭제된 프로젝트입니다.'; end if;
  if p.owner_id <> u.id then
    perform private.audit('project.deleted', p.owner_id, jsonb_build_object('project', p_id, 'title', p.title));
  end if;
  update projects set deleted = true, deleted_at = clock_timestamp(), deleted_by = u.id where id = p_id;
  update merge_requests set status = 'closed' where status = 'pending' and (from_project_id = p_id or to_project_id = p_id);
  update fork_requests set status = 'closed' where status = 'pending' and project_id = p_id;
  for c in select id, owner_id, title from projects where parent_id = p_id and not deleted loop
    perform private.notify(c.owner_id, format('「%s」의 원본 「%s」이 삭제되었습니다. 내 수정본은 그대로 남습니다.', c.title, p.title), '#/p/' || c.id);
  end loop;
end $$;

create or replace function public.set_hidden(p_id uuid, p_hidden boolean, p_with_descendants boolean default false) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform private.require_staff();
  if not exists (select 1 from projects where id = p_id) then raise exception '프로젝트가 없습니다.'; end if;
  with recursive t as (
    select id from projects where id = p_id
    union all
    select c.id from projects c join t on c.parent_id = t.id where p_with_descendants
  )
  update projects set hidden = p_hidden where id in (select id from t);
  get diagnostics n = row_count;
  perform private.audit(case when p_hidden then 'project.hidden' else 'project.unhidden' end,
    (select owner_id from projects where id = p_id), jsonb_build_object('project', p_id, 'count', n, 'with_descendants', p_with_descendants));
  return n;
end $$;

-- ---------------------------------------------------------------------
-- RPC: 수정본(포크)
-- ---------------------------------------------------------------------
create or replace function public.fork_project(p_id uuid, p_title text default null, p_description text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare u profiles; src projects; chk text;
begin
  u := private.require_active();
  src := private.get_project(p_id);
  chk := private.fork_check(src, u);
  if chk = 'approval' then raise exception '원작자 승인이 필요한 프로젝트입니다. 수정본 요청을 보내세요.'; end if;
  if chk <> 'ok' then raise exception '%', chk; end if;
  return private.do_fork(src, u, p_title, p_description);
end $$;

create or replace function public.request_fork(p_id uuid, p_title text default null, p_message text default null) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; src projects; chk text;
begin
  u := private.require_active();
  src := private.get_project(p_id);
  chk := private.fork_check(src, u);
  if chk = 'ok' then raise exception '승인 없이 바로 수정본을 만들 수 있는 프로젝트입니다.'; end if;
  if chk <> 'approval' then raise exception '%', chk; end if;
  if exists (select 1 from fork_requests where project_id = p_id and requester_id = u.id and status = 'pending') then
    raise exception '이미 보낸 요청이 대기 중입니다.';
  end if;
  perform private.check_len(p_title, 100, '제목'); perform private.check_len(p_message, 1000, '요청 메시지');
  insert into fork_requests (project_id, requester_id, title, message)
  values (p_id, u.id, coalesce(trim(p_title), ''), coalesce(trim(p_message), ''));
  perform private.notify(src.owner_id, format('%s 님이 「%s」의 수정본 만들기를 요청했습니다.', u.name, src.title), '#/p/' || p_id || '/merge');
  if (select status from profiles where id = src.owner_id) <> 'active' then
    perform private.notify_staff(format('졸업생 프로젝트 「%s」에 수정본 요청이 왔습니다.', src.title), '#/p/' || p_id || '/merge');
  end if;
end $$;

create or replace function public.resolve_fork_request(p_id uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; r fork_requests; src projects; requester profiles; v_fork uuid;
begin
  u := private.require_active();
  select * into r from fork_requests where id = p_id for update;
  if r.id is null then raise exception '요청이 없습니다.'; end if;
  if r.status <> 'pending' then raise exception '이미 처리된 요청입니다.'; end if;
  src := private.get_project(r.project_id);
  if not private.can_resolve_for(src, u) then raise exception '원작자만 처리할 수 있습니다.'; end if;
  if p_approve then
    if src.deleted or src.permission = 'view' then raise exception '지금은 수정본을 만들 수 없는 상태입니다(삭제 또는 보기만 가능).'; end if;
    select * into requester from profiles where id = r.requester_id;
    if requester.id is null or requester.status <> 'active' then raise exception '요청한 부원이 활동 중이 아닙니다.'; end if;
    v_fork := private.do_fork(src, requester, r.title, r.message);
    update fork_requests set status = 'approved', fork_id = v_fork, resolved_at = clock_timestamp() where id = p_id;
    perform private.notify(requester.id, format('「%s」 수정본 요청이 승인되어 수정본이 만들어졌습니다.', src.title), '#/p/' || v_fork);
  else
    update fork_requests set status = 'rejected', resolved_at = clock_timestamp() where id = p_id;
    perform private.notify(r.requester_id, format('「%s」 수정본 요청이 거절되었습니다.', src.title), '#/p/' || src.id);
  end if;
end $$;

-- ---------------------------------------------------------------------
-- RPC: 반영 요청
-- ---------------------------------------------------------------------
create or replace function public.create_merge_request(p_from uuid, p_message text) returns uuid
language plpgsql security definer set search_path = public as $$
declare u profiles; f projects; t projects; fv versions; tv versions; v_id uuid;
begin
  u := private.require_active();
  f := private.get_project(p_from);
  if f.owner_id <> u.id then raise exception '수정본 작성자만 반영 요청을 보낼 수 있습니다.'; end if;
  if f.deleted then raise exception '삭제된 프로젝트입니다.'; end if;
  select * into t from projects where id = f.parent_id;
  if t.id is null then raise exception '원본이 없는 프로젝트입니다.'; end if;
  if t.deleted then raise exception '원본이 삭제되어 반영 요청을 보낼 수 없습니다.'; end if;
  if t.hidden then raise exception '원본이 숨김 처리되어 있습니다.'; end if;
  if nullif(trim(p_message), '') is null then raise exception '무엇을 바꿨는지 설명을 적어 주세요.'; end if;
  perform private.check_len(trim(p_message), 1000, '요청 설명');
  if exists (select 1 from merge_requests where from_project_id = p_from and status = 'pending') then
    raise exception '이미 대기 중인 반영 요청이 있습니다.';
  end if;
  select * into fv from versions where id = f.head_version_id;
  select * into tv from versions where id = t.head_version_id;
  if private.files_map(fv.files) = private.files_map(tv.files) then raise exception '원본과 내용이 같아 반영할 것이 없습니다.'; end if;
  insert into merge_requests (from_project_id, to_project_id, from_version_id, base_version_id, author_id, message)
  values (f.id, t.id, fv.id, tv.id, u.id, trim(p_message)) returning id into v_id;
  perform private.notify(t.owner_id, format('%s 님이 「%s」에 반영 요청을 보냈습니다: %s', u.name, t.title, trim(p_message)), '#/p/' || t.id || '/merge');
  if (select status from profiles where id = t.owner_id) <> 'active' then
    perform private.notify_staff(format('졸업생 프로젝트 「%s」에 반영 요청이 왔습니다.', t.title), '#/p/' || t.id || '/merge');
  end if;
  return v_id;
end $$;

create or replace function public.resolve_merge_request(p_id uuid, p_approve boolean, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; m merge_requests; t projects; f projects; src versions; v_id uuid;
begin
  u := private.require_active();
  select * into m from merge_requests where id = p_id for update;
  if m.id is null then raise exception '요청이 없습니다.'; end if;
  if m.status <> 'pending' then raise exception '이미 처리된 요청입니다.'; end if;
  perform private.check_len(p_note, 500, '사유');
  t := private.get_project(m.to_project_id);
  if not private.can_resolve_for(t, u) then raise exception '원작자만 반영 요청을 처리할 수 있습니다.'; end if;
  if t.deleted then raise exception '삭제된 프로젝트입니다.'; end if;
  select * into f from projects where id = m.from_project_id;
  if p_approve then
    if f.id is null or f.deleted or f.hidden then raise exception '수정본이 삭제되었거나 숨김 처리되어 반영할 수 없습니다.'; end if;
    -- 자동 병합 없이, 요청 시점의 수정본 내용으로 원본의 새 버전을 만든다
    select * into src from versions where id = m.from_version_id;
    v_id := private.add_version(t.id, m.author_id, src.files, format('반영 요청 승인: 「%s」 — %s', f.title, m.message), null, m.id, u.id);
    insert into contributors (project_id, user_id, merge_request_id) values (t.id, m.author_id, m.id)
      on conflict (project_id, user_id) do nothing;
    update merge_requests set status = 'approved', merged_version_id = v_id, note = coalesce(trim(p_note), ''),
      resolved_at = clock_timestamp(), resolved_by = u.id where id = p_id;
    perform private.notify(m.author_id, format('「%s」에 보낸 반영 요청이 승인되었습니다. 기여자 목록에 추가되었습니다.', t.title), '#/p/' || t.id);
  else
    update merge_requests set status = 'rejected', note = coalesce(trim(p_note), ''),
      resolved_at = clock_timestamp(), resolved_by = u.id where id = p_id;
    perform private.notify(m.author_id, format('「%s」에 보낸 반영 요청이 거절되었습니다.%s', t.title,
      case when coalesce(trim(p_note), '') <> '' then ' 사유: ' || trim(p_note) else '' end), '#/p/' || t.id || '/merge');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- RPC: 줄 단위 댓글
-- ---------------------------------------------------------------------
create or replace function public.add_comment(p_version uuid, p_path text, p_line int, p_text text) returns uuid
language plpgsql security definer set search_path = public as $$
declare u profiles; v versions; p projects; content text; link text; v_id uuid; r record;
begin
  u := private.require_active();
  select * into v from versions where id = p_version;
  if v.id is null then raise exception '버전을 찾을 수 없습니다.'; end if;
  p := private.get_project(v.project_id);
  if p.deleted then raise exception '삭제된 프로젝트입니다.'; end if;
  if nullif(trim(p_text), '') is null then raise exception '댓글 내용을 입력하세요.'; end if;
  perform private.check_len(trim(p_text), 2000, '댓글');
  select f ->> 'content' into content from jsonb_array_elements(v.files) f where f ->> 'path' = p_path;
  if content is null then raise exception '파일이 없습니다.'; end if;
  if p_line is null or p_line < 1 or p_line > array_length(string_to_array(content, E'\n'), 1) then
    raise exception '잘못된 줄 번호입니다.';
  end if;
  link := format('#/p/%s?v=%s&file=%s&line=%s', p.id, v.id, p_path, p_line);
  -- 같은 줄에 먼저 댓글을 단 사람들에게 답글 알림 (작성자 제외)
  for r in select distinct author_id from comments
            where version_id = p_version and path = p_path and line = p_line and author_id <> p.owner_id loop
    perform private.notify(r.author_id, format('%s 님이 「%s」 %s:%s 댓글에 답했습니다.', u.name, p.title, p_path, p_line), link);
  end loop;
  insert into comments (version_id, path, line, author_id, text) values (p_version, p_path, p_line, u.id, trim(p_text)) returning id into v_id;
  perform private.notify(p.owner_id, format('%s 님이 「%s」 %s:%s에 댓글을 남겼습니다.', u.name, p.title, p_path, p_line), link);
  return v_id;
end $$;

create or replace function public.delete_comment(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; c comments;
begin
  u := private.require_active();
  select * into c from comments where id = p_id;
  if c.id is null then raise exception '댓글이 없습니다.'; end if;
  if c.author_id <> u.id and not private.is_staff() then raise exception '본인 댓글만 지울 수 있습니다.'; end if;
  delete from comments where id = p_id;
end $$;

-- ---------------------------------------------------------------------
-- RPC: 신고
-- ---------------------------------------------------------------------
create or replace function public.report_project(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; p projects;
begin
  u := private.require_active();
  p := private.get_project(p_id);
  if nullif(trim(p_reason), '') is null then raise exception '신고 사유를 입력하세요.'; end if;
  perform private.check_len(trim(p_reason), 1000, '신고 사유');
  if exists (select 1 from reports where project_id = p_id and reporter_id = u.id and status <> 'resolved') then
    raise exception '이미 신고한 프로젝트입니다. 운영진이 확인 중입니다.';
  end if;
  insert into reports (project_id, reporter_id, reason) values (p_id, u.id, trim(p_reason));
  perform private.notify_staff(format('「%s」에 대한 신고가 접수되었습니다.', p.title), '#/admin?tab=reports');
end $$;

create or replace function public.resolve_report(p_id uuid, p_action text) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; r reports; t record;
begin
  u := private.require_staff();
  select * into r from reports where id = p_id for update;
  if r.id is null then raise exception '신고가 없습니다.'; end if;
  if r.status = 'resolved' then raise exception '이미 처리된 신고입니다.'; end if;
  if p_action = 'escalate' then
    if private.is_admin() then raise exception '관리자는 바로 처리하세요.'; end if;
    update reports set status = 'escalated' where id = p_id;
    for t in select distinct p.id from profiles p join user_roles ur on ur.member_id = p.id
              where ur.role in ('owner', 'admin') and p.status = 'active' loop
      perform private.notify(t.id, '운영진이 신고 건의 최종 판단을 요청했습니다.', '#/admin?tab=reports');
    end loop;
  elsif p_action in ('hide', 'dismiss') then
    if r.status = 'escalated' and not private.is_admin() then raise exception '관리자에게 넘긴 신고는 관리자가 처리합니다.'; end if;
    if p_action = 'hide' then
      if r.project_id is not null then update projects set hidden = true where id = r.project_id;
      else update posts set hidden = true where id = r.post_id; end if;
    end if;
    update reports set status = 'resolved', action = p_action, resolved_by = u.id, resolved_at = clock_timestamp() where id = p_id;
    perform private.audit('report.resolved', null, jsonb_build_object('report', p_id, 'project', r.project_id, 'post', r.post_id, 'action', p_action));
  else
    raise exception '잘못된 처리 방식';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- RPC: 알림
-- ---------------------------------------------------------------------
create or replace function public.mark_notification_read(p_id uuid) returns void
language sql security definer set search_path = public as $$
  update notifications set read = true where id = p_id and user_id = private.my_member_id()
$$;
create or replace function public.mark_all_notifications_read() returns void
language sql security definer set search_path = public as $$
  update notifications set read = true where user_id = private.my_member_id() and not read
$$;

-- 트리 뼈대: 숨김 프로젝트도 "자리"만은 알려 줘서 하위 수정본이 트리에서 끊기지 않게 한다
create or replace function public.tree_skeleton()
returns table (id uuid, parent_id uuid, root_id uuid, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not private.is_reader() then return; end if;
  return query select p.id, p.parent_id, p.root_id, p.created_at from projects p;
end $$;

-- ---------------------------------------------------------------------
-- RPC: 직책 (복수 보유, 합산) [v2.0]
-- ---------------------------------------------------------------------
create or replace function private.role_label(p_role text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select label from roles where code = p_role), p_role)
$$;

-- 직책 임명. 부장·차장은 한 명만(새 보유자를 정하면 기존 보유자는 자동으로 물러난다), 관리자·서버 관리자는 여러 명.
create or replace function public.appoint_role(p_member_id uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
declare cur profiles; t profiles; prev record; v_label text;
begin
  cur := private.require_active();
  if p_role = 'owner' then raise exception '최고 관리자는 [최고 관리자 이양]으로만 바꿀 수 있습니다.'; end if;
  if p_role is null or p_role not in ('admin', 'president', 'vice', 'server') then raise exception '임명할 수 없는 직책입니다.'; end if;
  if p_role = 'admin' then
    if not private.is_owner() then raise exception '관리자 임명은 최고 관리자만 할 수 있습니다.'; end if;
  elsif not private.is_admin() then
    raise exception '관리자 권한이 필요합니다.';
  end if;
  select * into t from profiles where id = p_member_id;
  if t.id is null then raise exception '회원이 없습니다.'; end if;
  if t.status <> 'active' then raise exception '활동 중인 회원에게만 직책을 줄 수 있습니다.'; end if;
  v_label := private.role_label(p_role);
  if exists (select 1 from user_roles where member_id = p_member_id and role = p_role) then
    raise exception '이미 % 직책을 가진 회원입니다.', v_label;
  end if;
  if p_role in ('president', 'vice') then
    for prev in select member_id from user_roles where role = p_role loop
      delete from user_roles where member_id = prev.member_id and role = p_role;
      perform private.audit('role.revoked', prev.member_id, jsonb_build_object('role', p_role, 'reason', 'transfer', 'new_holder', p_member_id));
      perform private.notify(prev.member_id, format('%s 직책이 %s 님에게 넘어갔습니다.', v_label, t.name), '#/me');
    end loop;
  end if;
  insert into user_roles (member_id, role, granted_by) values (p_member_id, p_role, cur.id);
  perform private.audit('role.appointed', p_member_id, jsonb_build_object('role', p_role));
  perform private.notify(p_member_id, format('%s 직책이 부여되었습니다.', v_label), '#/me');
end $$;

create or replace function public.revoke_role(p_member_id uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
declare cur profiles; t profiles; v_label text;
begin
  cur := private.require_active();
  if p_role = 'owner' then raise exception '최고 관리자는 [최고 관리자 이양]으로만 바꿀 수 있습니다.'; end if;
  if p_role is null or p_role not in ('admin', 'president', 'vice', 'server') then raise exception '해임할 수 없는 직책입니다.'; end if;
  if p_role = 'admin' then
    if not private.is_owner() then raise exception '관리자 해임은 최고 관리자만 할 수 있습니다.'; end if;
  elsif not private.is_admin() then
    raise exception '관리자 권한이 필요합니다.';
  end if;
  select * into t from profiles where id = p_member_id;
  if t.id is null then raise exception '회원이 없습니다.'; end if;
  if not exists (select 1 from user_roles where member_id = p_member_id and role = p_role) then
    raise exception '그 직책을 가진 회원이 아닙니다.';
  end if;
  -- 관리자(최고 관리자 포함)가 0명이 되면 안 된다
  if p_role = 'admin' and not exists (
       select 1 from user_roles ur join profiles p on p.id = ur.member_id
        where p.status = 'active' and ur.role in ('owner', 'admin') and not (ur.member_id = p_member_id and ur.role = p_role)) then
    raise exception '마지막 관리자는 해임할 수 없습니다.';
  end if;
  v_label := private.role_label(p_role);
  delete from user_roles where member_id = p_member_id and role = p_role;
  perform private.audit('role.revoked', p_member_id, jsonb_build_object('role', p_role, 'reason', 'revoke'));
  perform private.notify(p_member_id, format('%s 직책이 해임되었습니다.', v_label), '#/me');
end $$;

-- 최고 관리자 이양: 제안 → 받는 사람이 본인 계정으로 수락해야 완료 (수락 전에는 취소 가능)
create or replace function public.propose_owner_transfer(p_member_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare cur profiles; t profiles; v_id uuid;
begin
  cur := private.require_active();
  if not private.is_owner() then raise exception '최고 관리자만 이양을 제안할 수 있습니다.'; end if;
  select * into t from profiles where id = p_member_id;
  if t.id is null then raise exception '회원이 없습니다.'; end if;
  if t.id = cur.id then raise exception '자기 자신에게는 이양할 수 없습니다.'; end if;
  if t.status <> 'active' then raise exception '활동 중인 회원에게만 이양할 수 있습니다.'; end if;
  if exists (select 1 from owner_transfers where from_member = cur.id and status = 'pending') then
    raise exception '이미 진행 중인 이양 제안이 있습니다. 먼저 취소하세요.';
  end if;
  insert into owner_transfers (from_member, to_member) values (cur.id, p_member_id) returning id into v_id;
  perform private.audit('owner.transfer_proposed', p_member_id, jsonb_build_object('transfer', v_id));
  perform private.notify(p_member_id, format('%s 님이 최고 관리자 이양을 제안했습니다. 수락하면 최고 관리자가 됩니다.', cur.name), '#/admin?tab=roles');
  return v_id;
end $$;

create or replace function public.accept_owner_transfer(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare cur profiles; tr owner_transfers; from_p profiles;
begin
  cur := private.require_active();
  select * into tr from owner_transfers where id = p_id for update;
  if tr.id is null then raise exception '이양 제안이 없습니다.'; end if;
  if tr.status <> 'pending' then raise exception '이미 처리된 제안입니다.'; end if;
  if tr.to_member <> cur.id then raise exception '제안을 받은 본인만 수락할 수 있습니다.'; end if;
  select * into from_p from profiles where id = tr.from_member;
  if not exists (select 1 from user_roles where member_id = tr.from_member and role = 'owner') then
    raise exception '제안한 사람이 더 이상 최고 관리자가 아닙니다.';
  end if;
  -- 새 최고 관리자(+관리자), 이전 최고 관리자는 최고 관리자만 내려놓고 관리자는 유지
  insert into user_roles (member_id, role, granted_by) values (cur.id, 'owner', tr.from_member) on conflict do nothing;
  insert into user_roles (member_id, role, granted_by) values (cur.id, 'admin', tr.from_member) on conflict do nothing;
  insert into user_roles (member_id, role, granted_by) values (tr.from_member, 'admin', tr.from_member) on conflict do nothing;
  delete from user_roles where member_id = tr.from_member and role = 'owner';
  update owner_transfers set status = 'accepted', decided_at = clock_timestamp() where id = p_id;
  perform private.audit('owner.transferred', cur.id, jsonb_build_object('transfer', p_id, 'from', tr.from_member));
  perform private.notify(tr.from_member, format('%s 님이 최고 관리자 이양을 수락했습니다. 이제 관리자입니다.', cur.name), '#/admin?tab=roles');
end $$;

create or replace function public.cancel_owner_transfer(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare cur profiles; tr owner_transfers; other uuid;
begin
  cur := private.require_active();
  select * into tr from owner_transfers where id = p_id for update;
  if tr.id is null then raise exception '이양 제안이 없습니다.'; end if;
  if tr.status <> 'pending' then raise exception '이미 처리된 제안입니다.'; end if;
  if cur.id not in (tr.from_member, tr.to_member) then raise exception '제안한 사람 또는 받은 사람만 취소할 수 있습니다.'; end if;
  update owner_transfers set status = 'cancelled', decided_at = clock_timestamp() where id = p_id;
  other := case when cur.id = tr.from_member then tr.to_member else tr.from_member end;
  perform private.audit('owner.transfer_cancelled', tr.to_member, jsonb_build_object('transfer', p_id));
  perform private.notify(other, format('%s 님이 최고 관리자 이양 제안을 취소했습니다.', cur.name), '#/admin?tab=roles');
end $$;

-- 위임·세부 권한 켜기/끄기 (미리 정한 목록 안에서만)
create or replace function public.set_role_permission(p_role text, p_perm text, p_enabled boolean) returns void
language plpgsql security definer set search_path = public as $$
declare h record;
begin
  perform private.require_admin();
  if p_enabled is null then raise exception '켜기/끄기 값이 필요합니다.'; end if;
  update role_permissions set enabled = p_enabled where role = p_role and perm = p_perm;
  if not found then raise exception '설정할 수 없는 권한입니다.'; end if;
  perform private.audit('role.permission', null, jsonb_build_object('role', p_role, 'perm', p_perm, 'enabled', p_enabled));
  for h in select member_id from user_roles where role = p_role loop
    perform private.notify(h.member_id, format('%s 직책의 권한이 바뀌었습니다.', private.role_label(p_role)), '#/me');
  end loop;
end $$;

-- 관리자 전원이 접근 불가할 때: Supabase SQL 편집기에서만 실행 (웹·API 에서는 호출할 수 없다)
create or replace function private.emergency_grant_owner(p_member_no text) returns void
language plpgsql security definer set search_path = public as $$
declare t profiles;
begin
  select * into t from profiles where member_no = p_member_no;
  if t.id is null then raise exception '회원 번호 %를 찾을 수 없습니다.', p_member_no; end if;
  update profiles set status = 'active' where id = t.id and status <> 'active';
  insert into user_roles (member_id, role) values (t.id, 'owner') on conflict do nothing;
  insert into user_roles (member_id, role) values (t.id, 'admin') on conflict do nothing;
  insert into audit_logs (actor, action, target_member, detail)
  values (null, 'role.emergency_owner', t.id, jsonb_build_object('member_no', p_member_no, 'emergency', true));
end $$;

-- ---------------------------------------------------------------------
-- RPC: 계정 연결 [v2.0]
-- ---------------------------------------------------------------------
-- 새 학년 계정을 미리 등록: 그 이메일로 첫 로그인하면 새 회원을 만들지 않고 이 회원에 연결된다
create or replace function public.invite_account(p_member_id uuid, p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare cur profiles; em text := lower(trim(coalesce(p_email, ''))); s settings; t profiles; old account_invites;
begin
  cur := private.require_account_manager();
  select * into s from settings where id = 1;
  select * into t from profiles where id = p_member_id;
  if t.id is null then raise exception '회원이 없습니다.'; end if;
  perform private.guard_privileged_target(p_member_id);
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception '올바른 이메일 형식이 아닙니다.'; end if;
  if right(em, length(s.domain) + 1) is distinct from '@' || lower(s.domain) then
    raise exception '학교 계정(@%)만 등록할 수 있습니다.', s.domain;
  end if;
  if exists (select 1 from user_accounts where lower(email) = em and status = 'active') then
    raise exception '이미 가입된 계정입니다. 승인 대기 회원이면 [기존 회원에 연결]을 쓰세요.';
  end if;
  select * into old from account_invites where email = em;
  if old.email is not null and old.member_id <> p_member_id then raise exception '이미 다른 회원에게 사전 등록된 이메일입니다.'; end if;
  insert into account_invites (email, member_id, created_by) values (em, p_member_id, cur.id)
    on conflict (email) do update set created_by = excluded.created_by, created_at = clock_timestamp();
  perform private.audit('account.invited', p_member_id, jsonb_build_object('email', em));
end $$;

-- 승인 대기 중인(기록이 없는) 회원의 로그인 계정을 기존 회원에 옮기고, 빈 대기 회원은 정리한다
create or replace function public.link_account(p_pending_member_id uuid, p_target_member_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare cur profiles; pe profiles; t profiles; accts jsonb;
begin
  cur := private.require_account_manager();
  if p_pending_member_id = p_target_member_id then raise exception '같은 회원끼리는 연결할 수 없습니다.'; end if;
  select * into pe from profiles where id = p_pending_member_id;
  select * into t from profiles where id = p_target_member_id;
  if pe.id is null or t.id is null then raise exception '회원이 없습니다.'; end if;
  perform private.guard_privileged_target(t.id);
  if pe.status <> 'pending' then raise exception '승인 대기 중인 회원만 다른 회원에 연결할 수 있습니다.'; end if;
  if t.status = 'pending' then raise exception '연결할 대상은 승인된 회원이어야 합니다.'; end if;
  if exists (select 1 from projects where owner_id = pe.id) or exists (select 1 from versions where author_id = pe.id)
     or exists (select 1 from merge_requests where author_id = pe.id) or exists (select 1 from fork_requests where requester_id = pe.id)
     or exists (select 1 from comments where author_id = pe.id) or exists (select 1 from contributors where user_id = pe.id)
     or exists (select 1 from reports where reporter_id = pe.id) or exists (select 1 from user_roles where member_id = pe.id) then
    raise exception '올린 기록이 있는 회원은 연결(병합)할 수 없습니다.';
  end if;
  select coalesce(jsonb_agg(email), '[]'::jsonb) into accts from user_accounts where member_id = pe.id;
  update user_accounts set member_id = t.id, linked_by = cur.id, linked_at = clock_timestamp() where member_id = pe.id;
  delete from profiles where id = pe.id;
  perform private.audit('account.merged', t.id, jsonb_build_object('from_member', pe.id, 'from_member_no', pe.member_no, 'from_name', pe.name, 'emails', accts));
  perform private.notify(t.id, '새 로그인 계정이 내 회원 정보에 연결되었습니다.', '#/me');
end $$;

create or replace function public.unlink_account(p_auth_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare cur profiles; a user_accounts;
begin
  cur := private.require_account_manager();
  select * into a from user_accounts where auth_id = p_auth_id for update;
  if a.auth_id is null or a.status <> 'active' then raise exception '연결된 계정이 아닙니다.'; end if;
  perform private.guard_privileged_target(a.member_id);
  if (select count(*) from user_accounts where member_id = a.member_id and status = 'active') <= 1 then
    raise exception '회원의 마지막 로그인 계정은 해제할 수 없습니다.';
  end if;
  update user_accounts set status = 'unlinked' where auth_id = p_auth_id;
  perform private.audit('account.unlinked', a.member_id, jsonb_build_object('email', a.email, 'auth_id', p_auth_id));
  perform private.notify(a.member_id, '로그인 계정 하나의 연결이 해제되었습니다.', '#/me');
end $$;

-- ---------------------------------------------------------------------
-- RPC: 운영 연도·차시 [v2.0]
-- ---------------------------------------------------------------------
-- 몇 번 불러도 같은 결과(멱등). 지우는 것은 아무것도 없다.
create or replace function public.ensure_academic_year() returns int
language plpgsql security definer set search_path = public as $$
declare v_year int := private.year_of(now()); n int; v_prev int;
begin
  insert into academic_years (year, starts_on, ends_on, status)
  values (v_year, make_date(v_year, 3, 1), make_date(v_year + 1, 3, 1) - 1, 'current')
  on conflict (year) do nothing;
  get diagnostics n = row_count;
  update academic_years set status = 'archived' where year < v_year and status <> 'archived';
  -- 프로젝트가 있는 지난 연도도 목록에 나오게 한다
  insert into academic_years (year, starts_on, ends_on, status)
  select distinct pr.year, make_date(pr.year, 3, 1), make_date(pr.year + 1, 3, 1) - 1, 'archived'
    from projects pr where pr.year is not null and pr.year < v_year
  on conflict (year) do nothing;
  insert into sessions (year, no, title)
  select ay.year, g, g || '차시' from academic_years ay, generate_series(1, 10) g
  on conflict (year, no) do nothing;
  if n > 0 then
    -- 새 연도 명단 후보: 전년도 활동 회원을 복사 (학년 +1, 기수 그대로, 직책은 지금 직책의 기록). 없으면 지금 활동 회원.
    select max(year) into v_prev from membership_history where year < v_year;
    if v_prev is not null then
      insert into membership_history (member_id, year, generation, grade, roles, status, joined_on)
      select h.member_id, v_year, h.generation, case when h.grade is null then null else h.grade + 1 end,
             coalesce(array(select ur.role from user_roles ur where ur.member_id = h.member_id order by ur.role), '{}'),
             'active', make_date(v_year, 3, 1)
        from membership_history h join profiles p on p.id = h.member_id
       where h.year = v_prev and h.status = 'active' and p.status = 'active'
      on conflict (member_id, year) do nothing;
    else
      insert into membership_history (member_id, year, generation, roles, status, joined_on)
      select p.id, v_year, p.generation, coalesce(array(select ur.role from user_roles ur where ur.member_id = p.id order by ur.role), '{}'),
             'active', make_date(v_year, 3, 1)
        from profiles p where p.status = 'active'
      on conflict (member_id, year) do nothing;
    end if;
  end if;
  return v_year;
end $$;

create or replace function public.update_session(p_id uuid, p_title text, p_held_on date, p_description text) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; s sessions; v_past boolean;
begin
  u := private.require_active();
  select * into s from sessions where id = p_id;
  if s.id is null then raise exception '차시가 없습니다.'; end if;
  v_past := s.year <> private.year_of(now());
  if v_past then
    if not private.is_admin() then raise exception '지난 연도의 차시는 관리자만 고칠 수 있습니다.'; end if;
  elsif not private.is_staff() then
    raise exception '운영진 권한이 필요합니다.';
  end if;
  if nullif(trim(p_title), '') is null then raise exception '차시 제목을 입력하세요.'; end if;
  perform private.check_len(trim(p_title), 100, '차시 제목'); perform private.check_len(p_description, 1000, '차시 설명');
  update sessions set title = trim(p_title), held_on = p_held_on, description = coalesce(trim(p_description), '') where id = p_id;
  if v_past then
    perform private.audit('session.updated_past', null, jsonb_build_object('session', p_id, 'year', s.year, 'no', s.no, 'title', trim(p_title)));
  end if;
end $$;

create or replace function private.check_session_link(p_project uuid, p_session uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare u profiles; p projects; s sessions; v_past boolean;
begin
  u := private.require_active();
  p := private.get_project(p_project);
  select * into s from sessions where id = p_session;
  if s.id is null then raise exception '차시가 없습니다.'; end if;
  if p.deleted then raise exception '삭제된 프로젝트입니다.'; end if;
  v_past := s.year <> private.year_of(now());
  if v_past then
    if not private.is_admin() then raise exception '지난 연도의 차시는 관리자만 연결할 수 있습니다.'; end if;
  elsif p.owner_id <> u.id and not private.is_staff() then
    raise exception '프로젝트 작성자 또는 운영진만 차시에 연결할 수 있습니다.';
  end if;
  return v_past;
end $$;

create or replace function public.link_project_session(p_project_id uuid, p_session_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_past boolean; cur uuid := private.my_member_id();
begin
  v_past := private.check_session_link(p_project_id, p_session_id);
  insert into project_sessions (project_id, session_id, linked_by) values (p_project_id, p_session_id, cur) on conflict do nothing;
  if v_past then
    perform private.audit('session.link_past', (select owner_id from projects where id = p_project_id), jsonb_build_object('project', p_project_id, 'session', p_session_id));
  end if;
end $$;

create or replace function public.unlink_project_session(p_project_id uuid, p_session_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_past boolean;
begin
  v_past := private.check_session_link(p_project_id, p_session_id);
  delete from project_sessions where project_id = p_project_id and session_id = p_session_id;
  if v_past then
    perform private.audit('session.unlink_past', (select owner_id from projects where id = p_project_id), jsonb_build_object('project', p_project_id, 'session', p_session_id));
  end if;
end $$;

-- 연도별 회원 기록 (기수·그 해 학년). 과거 연도 수정은 감사 기록에 남는다.
create or replace function public.upsert_membership(p_member_id uuid, p_year int, p_generation int, p_grade int) returns void
language plpgsql security definer set search_path = public as $$
declare t profiles; v_cur int := private.year_of(now());
begin
  perform private.require_admin();
  select * into t from profiles where id = p_member_id;
  if t.id is null then raise exception '회원이 없습니다.'; end if;
  if not exists (select 1 from academic_years where year = p_year) then raise exception '%년 운영 연도가 없습니다.', p_year; end if;
  if p_generation is not null and p_generation < 1 then raise exception '기수는 1 이상이어야 합니다.'; end if;
  if p_grade is not null and p_grade not between 1 and 6 then raise exception '학년은 1~6 사이로 입력하세요.'; end if;
  insert into membership_history (member_id, year, generation, grade, roles, status, joined_on)
  values (p_member_id, p_year, p_generation, p_grade,
          case when p_year = v_cur then coalesce(array(select ur.role from user_roles ur where ur.member_id = p_member_id order by ur.role), '{}') else '{}' end,
          t.status, (select starts_on from academic_years where year = p_year))
  on conflict (member_id, year) do update set generation = excluded.generation, grade = excluded.grade;
  if p_year <> v_cur then
    perform private.audit('membership.updated_past', p_member_id, jsonb_build_object('year', p_year, 'generation', p_generation, 'grade', p_grade));
  end if;
end $$;

-- ---------------------------------------------------------------------
-- RPC: 서버 상태 [v2.0]
-- ---------------------------------------------------------------------
-- 누구나(로그인 전에도) 호출 가능한 연결 확인. 실제로 DB 를 한 번 읽고, 기록은 10분에 한 번만 남긴다. 데이터는 바꾸지 않는다(상태 기록 제외).
create or replace function public.ping() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_last timestamptz;
begin
  perform 1 from settings where id = 1;
  select max(at) into v_last from system_status where kind = 'ping';
  if v_last is null or v_last < now() - interval '10 minutes' then
    insert into system_status (kind, ok, detail) values ('ping', true, '{}'::jsonb) returning at into v_last;
    delete from system_status where kind = 'ping' and at < now() - interval '90 days';
  end if;
  return jsonb_build_object('ok', true, 'now', now(), 'last_ping', v_last);
end $$;

-- 서버 상태 상세: 관리자, 또는 서버 직책 + 관리자가 켜 둔 권한. 개인정보(이메일 등)는 담지 않는다.
create or replace function public.server_status() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_detail boolean; v_backup boolean; v_errors boolean;
begin
  perform private.require_active();
  v_detail := private.is_admin() or (private.has_role('server') and private.has_perm('server.detail'));
  if not v_detail then raise exception '서버 상태를 볼 권한이 없습니다.'; end if;
  v_backup := private.is_admin() or private.has_perm('server.backup');
  v_errors := private.is_admin() or private.has_perm('server.errors');
  return jsonb_build_object(
    'db_size', pg_database_size(current_database()),
    'year', private.year_of(now()),
    'counts', jsonb_build_object('profiles', (select count(*) from profiles), 'projects', (select count(*) from projects),
      'versions', (select count(*) from versions), 'comments', (select count(*) from comments),
      'notifications', (select count(*) from notifications), 'sessions', (select count(*) from sessions),
      'audit_logs', (select count(*) from audit_logs),
      'team_projects', (select count(*) from team_projects), 'posts', (select count(*) from posts where deleted_at is null),
      'team_file_versions', (select count(*) from team_file_versions)),
    'pings', coalesce((select jsonb_agg(jsonb_build_object('at', at, 'ok', ok) order by at desc)
                         from (select at, ok from system_status where kind = 'ping' order by at desc limit 10) x), '[]'::jsonb),
    'backup', case when v_backup then (select jsonb_build_object('at', at, 'ok', ok, 'detail', detail)
                         from system_status where kind = 'backup' order by at desc limit 1) else null end,
    'errors', case when v_errors then coalesce((select jsonb_agg(jsonb_build_object('at', at, 'detail', detail) order by at desc)
                         from (select at, detail from system_status where kind = 'error' order by at desc limit 20) y), '[]'::jsonb) else null end,
    'can_backup', v_backup, 'can_errors', v_errors);
end $$;

-- 로그인 계정이 지워지면(Authentication → Users 에서 삭제 등) 연결만 "삭제됨"으로 표시한다. 회원·기록은 그대로 남는다.
create or replace function private.handle_user_deleted() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update user_accounts set status = 'removed' where auth_id = old.id and status = 'active';
  return old;
end $$;
drop trigger if exists on_auth_user_deleted on auth.users;
create trigger on_auth_user_deleted after delete on auth.users
  for each row execute function private.handle_user_deleted();

-- ---------------------------------------------------------------------
-- [v2.1] 2단계: 파일 저장소(Storage) · 팀 프로젝트 · 게시판
-- ---------------------------------------------------------------------
create table if not exists public.team_projects (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  description   text not null default '',
  goal          text not null default '',
  leader        uuid not null references public.profiles (id),
  year          int not null,
  cover_path    text,
  status        text not null default 'planning' check (status in ('planning', 'active', 'pending_submit', 'done', 'published', 'archived')),
  published_at  timestamptz,
  created_at    timestamptz not null default clock_timestamp(),
  updated_at    timestamptz not null default clock_timestamp(),
  deleted_at    timestamptz
);
create index if not exists team_projects_year_idx on public.team_projects (year);
-- [v2.2] 관리자만 하는 소프트 삭제: 누가·왜 지웠는지 남기고, 파일은 지우지 않는다
alter table public.team_projects add column if not exists deleted_by uuid;
alter table public.team_projects add column if not exists delete_reason text not null default '';

create table if not exists public.team_members (
  team_id     uuid not null references public.team_projects (id),
  member_id   uuid not null references public.profiles (id),
  role_label  text not null default '',
  status      text not null default 'invited' check (status in ('invited', 'active', 'left')),
  invited_by  uuid,
  invited_at  timestamptz not null default clock_timestamp(),
  joined_at   timestamptz,
  primary key (team_id, member_id)
);
create index if not exists team_members_member_idx on public.team_members (member_id);

create table if not exists public.team_files (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.team_projects (id),
  name        text not null,
  created_by  uuid references public.profiles (id),
  created_at  timestamptz not null default clock_timestamp()
);
create index if not exists team_files_team_idx on public.team_files (team_id);

create table if not exists public.team_file_versions (
  id           uuid primary key default gen_random_uuid(),
  file_id      uuid not null references public.team_files (id),
  version_no   int not null,
  orig_name    text not null default '',
  path         text not null unique,
  size         bigint not null default 0,
  mime         text,
  note         text not null default '',
  uploaded_by  uuid references public.profiles (id),
  uploaded_at  timestamptz not null default clock_timestamp(),
  unique (file_id, version_no)
);

create table if not exists public.team_notes (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.team_projects (id),
  author      uuid not null references public.profiles (id),
  kind        text not null default 'note' check (kind in ('note', 'progress', 'discussion')),
  body        text not null,
  pinned      boolean not null default false,
  created_at  timestamptz not null default clock_timestamp()
);
create index if not exists team_notes_team_idx on public.team_notes (team_id);

create table if not exists public.team_credits (
  team_id       uuid not null references public.team_projects (id),
  member_id     uuid not null references public.profiles (id),
  display_name  text not null,
  contribution  text not null default '',
  status        text not null default 'pending' check (status in ('pending', 'confirmed', 'declined')),
  confirmed_at  timestamptz,
  updated_by    uuid,
  primary key (team_id, member_id)
);
-- 제작자 표시 변경 이력: 서버 함수만 쓰고, 고치거나 지울 수 없다
create table if not exists public.team_credit_history (
  id       bigserial primary key,
  team_id  uuid not null references public.team_projects (id),
  actor    uuid,
  change   jsonb not null default '{}'::jsonb,
  at       timestamptz not null default clock_timestamp()
);
create index if not exists team_credit_history_team_idx on public.team_credit_history (team_id);
drop trigger if exists team_credit_history_no_change on public.team_credit_history;
create trigger team_credit_history_no_change before update or delete on public.team_credit_history
  for each row execute function private.audit_immutable();

create table if not exists public.team_project_sessions (
  team_id     uuid not null references public.team_projects (id),
  session_id  uuid not null references public.sessions (id),
  linked_by   uuid,
  linked_at   timestamptz not null default clock_timestamp(),
  primary key (team_id, session_id)
);
create index if not exists team_project_sessions_session_idx on public.team_project_sessions (session_id);

create table if not exists public.team_final_files (
  team_id          uuid not null references public.team_projects (id),
  file_version_id  uuid not null references public.team_file_versions (id),
  primary key (team_id, file_version_id)
);

create table if not exists public.posts (
  id          uuid primary key default gen_random_uuid(),
  author      uuid not null references public.profiles (id),
  board       text not null check (board in ('club', 'free', 'notice')),
  title       text not null,
  body        text not null default '',
  tags        text[] not null default '{}',
  visibility  text not null default 'members' check (visibility in ('members', 'staff')),
  cover_path  text,
  team_id     uuid references public.team_projects (id),
  project_id  uuid references public.projects (id),
  year        int not null,
  pinned      boolean not null default false,
  hidden      boolean not null default false,
  created_at  timestamptz not null default clock_timestamp(),
  updated_at  timestamptz not null default clock_timestamp(),
  deleted_at  timestamptz
);
create index if not exists posts_board_idx on public.posts (board, created_at desc);
create index if not exists posts_team_idx on public.posts (team_id);

create table if not exists public.post_sessions (
  post_id     uuid not null references public.posts (id),
  session_id  uuid not null references public.sessions (id),
  primary key (post_id, session_id)
);
create index if not exists post_sessions_session_idx on public.post_sessions (session_id);

create table if not exists public.post_files (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.posts (id),
  path        text not null unique,
  name        text not null,
  size        bigint not null default 0,
  mime        text,
  created_at  timestamptz not null default clock_timestamp()
);
create index if not exists post_files_post_idx on public.post_files (post_id);

create table if not exists public.post_comments (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.posts (id),
  author      uuid not null references public.profiles (id),
  body        text not null,
  created_at  timestamptz not null default clock_timestamp(),
  deleted_at  timestamptz
);
create index if not exists post_comments_post_idx on public.post_comments (post_id);

create table if not exists public.post_reactions (
  post_id    uuid not null references public.posts (id),
  member_id  uuid not null references public.profiles (id),
  kind       text not null default 'like' check (kind in ('like')),
  primary key (post_id, member_id, kind)
);

-- 신고: 코드 프로젝트 또는 게시물 중 정확히 하나가 대상
alter table public.reports add column if not exists post_id uuid references public.posts (id);
alter table public.reports alter column project_id drop not null;
alter table public.reports drop constraint if exists reports_one_target;
alter table public.reports add constraint reports_one_target check ((project_id is not null)::int + (post_id is not null)::int = 1);
create unique index if not exists report_post_one_open on public.reports (post_id, reporter_id) where status <> 'resolved' and post_id is not null;

-- ---------------------------------------------------------------------
-- 파일 저장소 도우미 (private)
-- ---------------------------------------------------------------------
create or replace function private.uuid_or_null(p text) returns uuid
language plpgsql immutable as $$
begin return p::uuid; exception when others then return null; end $$;

-- 실행 파일 등 막는 확장자 (서버 검사. 화면에서도 같은 목록으로 미리 막는다)
create or replace function private.is_blocked_name(p_name text) returns boolean
language sql immutable as $$
  select lower(regexp_replace(trim(coalesce(p_name, '')), '[. ]+$', '')) ~ '\.(exe|bat|cmd|com|msi|scr|ps1|vbs|dll|sh|jar|apk|app|dmg)$'
$$;

-- Storage 에 올라간 객체의 크기·종류 (storage 스키마가 없는 DB 에서는 빈 결과)
create or replace function private.storage_object(p_path text) returns table (o_size bigint, o_mime text)
language plpgsql stable security definer set search_path = public as $$
begin
  if to_regclass('storage.objects') is null then return; end if;
  return query execute 'select coalesce((metadata ->> ''size'')::bigint, 0), metadata ->> ''mimetype'' from storage.objects where bucket_id = ''pop-files'' and name = $1' using p_path;
end $$;

-- 등록할 파일 검증: 경로 규칙, 막는 확장자, 실제로 올라와 있는지, 크기 제한. 크기·종류를 돌려준다.
create or replace function private.verify_upload(p_path text, p_prefix text, p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_lim bigint; v_size bigint; v_mime text;
begin
  if p_path is null or left(p_path, length(p_prefix)) <> p_prefix or p_path ~ '(\.\.|//|\\)' or length(p_path) > 400 or substr(p_path, length(p_prefix) + 1) = '' then
    raise exception '올바르지 않은 파일 경로입니다.';
  end if;
  if nullif(trim(p_name), '') is null then raise exception '파일 이름이 없습니다.'; end if;
  perform private.check_len(trim(p_name), 200, '파일 이름');
  if private.is_blocked_name(p_name) or private.is_blocked_name(p_path) then
    raise exception '실행 파일 등 올릴 수 없는 형식입니다. (exe, bat, cmd, com, msi, scr, ps1, vbs, dll, sh, jar, apk, app, dmg)';
  end if;
  select o_size, o_mime into v_size, v_mime from private.storage_object(p_path);
  if not found then raise exception '업로드된 파일을 찾을 수 없습니다. 파일을 먼저 올린 뒤 다시 시도하세요.'; end if;
  select max_upload_mb::bigint * 1048576 into v_lim from settings where id = 1;
  if v_size <= 0 then raise exception '빈 파일은 올릴 수 없습니다.'; end if;
  if v_size > v_lim then raise exception '파일이 용량 제한(%MB)을 넘습니다.', v_lim / 1048576; end if;
  return jsonb_build_object('size', v_size, 'mime', v_mime);
end $$;

-- ---------------------------------------------------------------------
-- 팀·게시물 권한 판단 (정책에서 쓰이므로 execute 를 열어 둔다)
-- ---------------------------------------------------------------------
create or replace function private.is_team_member(p_team uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from team_members where team_id = p_team and member_id = private.my_member_id() and status = 'active')
$$;
create or replace function private.is_team_leader(p_team uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from team_projects where id = p_team and leader = private.my_member_id())
$$;
-- 비공개 작업 공간(파일·메모)을 볼 수 있는가: 팀원 또는 운영진. 서버 관리자는 해당 없음.
-- [v2.2] 삭제된 팀인가 / 이 사람에게 보이는 팀인가
create or replace function private.team_is_deleted(p_team uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from team_projects where id = p_team and deleted_at is not null)
$$;
create or replace function private.team_visible(p_team uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from team_projects where id = p_team and (deleted_at is null or private.is_admin()))
$$;
-- [v2.2] Storage 객체가 어디에서도 쓰이지 않는가 (팀 파일 버전·게시물 첨부·대표 이미지 어디에도 없음)
create or replace function private.is_orphan_path(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_name is not null
     and not exists (select 1 from team_file_versions where path = p_name)
     and not exists (select 1 from post_files where path = p_name)
     and not exists (select 1 from posts where cover_path = p_name)
     and not exists (select 1 from team_projects where cover_path = p_name)
$$;
-- [v2.2] 삭제된 팀은 관리자 외에는 (팀원·운영진도) 작업 공간을 볼 수 없다
create or replace function private.can_view_team(p_team uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select private.is_reader() and (private.is_team_member(p_team) or private.is_staff())
     and (private.is_admin() or not private.team_is_deleted(p_team))
$$;
create or replace function private.team_published(p_team uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from team_projects where id = p_team and published_at is not null and deleted_at is null)
$$;
create or replace function private.team_of_file(p_file uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select team_id from team_files where id = p_file
$$;
-- 게시된 팀 프로젝트의 최종본으로 지정된 버전인가 (전체 부원이 볼 수 있는 파일)
create or replace function private.version_is_public_final(p_version uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select private.is_reader() and exists (
    select 1 from team_final_files tf join team_projects t on t.id = tf.team_id
     where tf.file_version_id = p_version and t.published_at is not null and t.deleted_at is null)
$$;
create or replace function private.file_has_public_final(p_file uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from team_file_versions v where v.file_id = p_file and private.version_is_public_final(v.id))
$$;
-- 게시물을 볼 수 있는가: 운영진은 전부, 그 외에는 지워지지 않았고 (본인 글이거나 [숨김 아님 + 부원 공개])
-- [v2.2] 삭제된 팀의 게시물은 관리자만 본다
create or replace function private.can_read_post(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select private.is_reader() and exists (
    select 1 from posts p where p.id = p_id
      and (p.team_id is null or private.is_admin() or not private.team_is_deleted(p.team_id))
      and (
        private.is_staff()
        or (p.deleted_at is null and (p.author = private.my_member_id() or (not p.hidden and p.visibility = 'members')))))
$$;

-- Storage 경로별 열람·업로드 권한 (storage.objects 정책에서 쓴다)
create or replace function private.can_read_path(p_name text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare k text := split_part(p_name, '/', 1); v_id uuid;
begin
  if not private.is_reader() then return false; end if;
  -- [v2.2] 어디에도 연결되지 않은 고아 파일은 정리를 위해 관리자만 볼 수 있다
  if private.is_admin() and private.is_orphan_path(p_name) then return true; end if;
  if k = 'team' then
    v_id := private.uuid_or_null(split_part(p_name, '/', 2));
    if v_id is null then return false; end if;
    return private.can_view_team(v_id)
        or exists (select 1 from team_file_versions v join team_files f on f.id = v.file_id
                    where v.path = p_name and f.team_id = v_id and private.version_is_public_final(v.id));
  elsif k = 'cover' then
    if split_part(p_name, '/', 2) <> 'team' then return false; end if;
    v_id := private.uuid_or_null(split_part(p_name, '/', 3));
    if v_id is null then return false; end if;
    -- 팀원·운영진은 모두, 그 밖에는 게시된 팀의 대표 이미지(또는 그 게시물의 대표 이미지)로 등록된 파일만
    return private.can_view_team(v_id)
        or exists (select 1 from team_projects where id = v_id and cover_path = p_name and published_at is not null and deleted_at is null)
        or exists (select 1 from posts where cover_path = p_name and private.can_read_post(id));
  elsif k = 'post' then
    v_id := private.uuid_or_null(split_part(p_name, '/', 2));
    if v_id is null or not private.can_read_post(v_id) then return false; end if;
    -- 작성자는 등록 전 파일도 보고, 다른 사람은 게시물에 첨부·대표 이미지로 등록된 파일만 본다
    return exists (select 1 from posts where id = v_id and author = private.my_member_id())
        or exists (select 1 from post_files where path = p_name)
        or exists (select 1 from posts where id = v_id and cover_path = p_name);
  end if;
  return false;
end $$;

create or replace function private.can_upload_path(p_name text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare k text := split_part(p_name, '/', 1); v_id uuid; t team_projects;
begin
  if private.my_status() is distinct from 'active' then return false; end if;
  if not (p_name ~ '^(team|post)/[0-9a-f-]{36}/[^/]+$' or p_name ~ '^cover/team/[0-9a-f-]{36}/[^/]+$') then return false; end if;
  if p_name ~ '(\.\.|\\)' or length(p_name) > 400 or private.is_blocked_name(p_name) then return false; end if;
  if k in ('team', 'cover') then
    v_id := private.uuid_or_null(split_part(p_name, '/', case when k = 'team' then 2 else 3 end));
    select * into t from team_projects where id = v_id and deleted_at is null;
    if t.id is null then return false; end if;
    if t.year < private.year_of(now()) and not private.is_admin() then return false; end if;
    if k = 'team' and t.status in ('published', 'archived') then return false; end if;
    return private.is_team_member(v_id) or private.is_staff();
  elsif k = 'post' then
    v_id := private.uuid_or_null(split_part(p_name, '/', 2));
    return exists (select 1 from posts where id = v_id and author = private.my_member_id() and deleted_at is null);
  end if;
  return false;
end $$;

-- 비공개 버킷과 Storage 정책. storage 스키마가 없는 DB(테스트 등)에서는 건너뛴다.
-- 수정 정책은 일부러 만들지 않는다: 올린 파일은 덮어쓸 수 없다. 삭제는 아래 pop_files_delete (관리자 · 고아 파일 · 24시간 경과)뿐이다.
do $$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise notice 'storage 스키마가 없어 파일 저장소(pop-files) 설정을 건너뜁니다.';
    return;
  end if;
  execute 'insert into storage.buckets (id, name, public, file_size_limit) values (''pop-files'', ''pop-files'', false, 52428800)
           on conflict (id) do update set public = false';
  execute 'drop policy if exists pop_files_insert on storage.objects';
  execute 'create policy pop_files_insert on storage.objects for insert to authenticated
           with check (bucket_id = ''pop-files'' and private.can_upload_path(name))';
  execute 'drop policy if exists pop_files_select on storage.objects';
  execute 'create policy pop_files_select on storage.objects for select to authenticated
           using (bucket_id = ''pop-files'' and private.can_read_path(name))';
  -- [v2.2] 삭제는 관리자가, 어디에도 연결되지 않은 24시간 지난 고아 파일에 한해서만 (그 밖의 파일은 여전히 지울 수 없다)
  execute 'drop policy if exists pop_files_delete on storage.objects';
  execute 'create policy pop_files_delete on storage.objects for delete to authenticated
           using (bucket_id = ''pop-files'' and private.is_admin() and private.is_orphan_path(name)
                  and created_at < now() - interval ''24 hours'')';
exception when insufficient_privilege then
  raise notice 'Storage 정책을 만들 권한이 없습니다. SETUP.md 의 Storage 안내를 따라 대시보드에서 직접 만드세요.';
end $$;

-- ---------------------------------------------------------------------
-- RPC: 팀 프로젝트 [v2.1]
-- ---------------------------------------------------------------------
-- 팀을 쓰기용으로 가져온다: 삭제된 팀 불가, 지난 연도는 관리자만(감사 기록에 남음)
create or replace function private.team_for_write(p_team uuid, p_action text default null) returns public.team_projects
language plpgsql security definer set search_path = public as $$
declare t team_projects;
begin
  select * into t from team_projects where id = p_team;
  if t.id is null or t.deleted_at is not null then raise exception '팀 프로젝트를 찾을 수 없습니다.'; end if;
  if t.year < private.year_of(now()) then
    if not private.is_admin() then raise exception '지난 연도의 팀 프로젝트는 읽기 전용입니다. (관리자만 고칠 수 있습니다)'; end if;
    perform private.audit('team.past_edit', t.leader, jsonb_build_object('team', t.id, 'name', t.name, 'year', t.year, 'action', p_action));
  end if;
  return t;
end $$;

-- 팀원 전체(본인 제외)에게 알림
create or replace function private.notify_team(p_team uuid, p_text text) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select member_id from team_members where team_id = p_team and status = 'active' loop
    perform private.notify(r.member_id, p_text, '#/team/' || p_team);
  end loop;
end $$;

-- 제출·게시 조건: 최종 파일이 하나 이상 있고 제작자 명단이 모두 확인되어야 한다
create or replace function private.team_ready(p_team uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from team_final_files where team_id = p_team) then
    raise exception '최종본으로 정한 파일이 하나 이상 있어야 합니다. [파일] 탭에서 최종본을 정하세요.';
  end if;
  if not exists (select 1 from team_credits where team_id = p_team) then
    raise exception '제작자 명단을 먼저 작성하세요.';
  end if;
  if exists (select 1 from team_credits where team_id = p_team and status <> 'confirmed') then
    raise exception '제작자 명단을 모든 팀원이 확인해야 합니다.';
  end if;
end $$;

create or replace function public.create_team(p_name text, p_description text default '', p_goal text default '') returns uuid
language plpgsql security definer set search_path = public as $$
declare u profiles; v_id uuid := gen_random_uuid();
begin
  u := private.require_active();
  if nullif(trim(p_name), '') is null then raise exception '팀 이름을 입력하세요.'; end if;
  perform private.check_len(trim(p_name), 60, '팀 이름'); perform private.check_len(p_description, 2000, '설명'); perform private.check_len(p_goal, 1000, '목표');
  insert into team_projects (id, name, description, goal, leader, year)
  values (v_id, trim(p_name), coalesce(trim(p_description), ''), coalesce(trim(p_goal), ''), u.id, private.year_of(now()));
  insert into team_members (team_id, member_id, role_label, status, invited_by, joined_at)
  values (v_id, u.id, '팀장', 'active', u.id, clock_timestamp());
  return v_id;
end $$;

-- 팀 정보 수정 (팀장 또는 운영진). p_cover_path: null = 그대로, '' = 지우기
create or replace function public.update_team(p_id uuid, p_name text default null, p_description text default null, p_goal text default null, p_cover_path text default null) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; t team_projects; v jsonb;
begin
  u := private.require_active();
  t := private.team_for_write(p_id, 'update');
  if not (private.is_team_leader(p_id) or private.is_staff()) then raise exception '팀장 또는 운영진만 팀 정보를 고칠 수 있습니다.'; end if;
  if p_name is not null then
    if trim(p_name) = '' then raise exception '팀 이름을 입력하세요.'; end if;
    perform private.check_len(trim(p_name), 60, '팀 이름');
    update team_projects set name = trim(p_name) where id = p_id;
  end if;
  perform private.check_len(p_description, 2000, '설명'); perform private.check_len(p_goal, 1000, '목표');
  if p_description is not null then update team_projects set description = trim(p_description) where id = p_id; end if;
  if p_goal is not null then update team_projects set goal = trim(p_goal) where id = p_id; end if;
  if p_cover_path is not null then
    if p_cover_path = '' then
      update team_projects set cover_path = null where id = p_id;
    else
      v := private.verify_upload(p_cover_path, 'cover/team/' || p_id || '/', p_cover_path);
      if lower(p_cover_path) !~ '\.(png|jpe?g|gif|webp)$' then raise exception '대표 이미지는 png, jpg, gif, webp 만 쓸 수 있습니다.'; end if;
      update team_projects set cover_path = p_cover_path where id = p_id;
    end if;
  end if;
  update team_projects set updated_at = clock_timestamp() where id = p_id;
end $$;

create or replace function public.invite_team_member(p_team uuid, p_member uuid, p_role_label text default '') returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; t team_projects; m profiles; cur team_members;
begin
  u := private.require_active();
  t := private.team_for_write(p_team, 'invite');
  if not private.is_team_leader(p_team) then raise exception '팀장만 팀원을 초대할 수 있습니다.'; end if;
  if t.status in ('published', 'archived') then raise exception '게시 완료·보관된 팀에는 팀원을 초대할 수 없습니다.'; end if;
  perform private.check_len(p_role_label, 30, '역할');
  select * into m from profiles where id = p_member;
  if m.id is null or m.status <> 'active' then raise exception '활동 중인 회원만 초대할 수 있습니다.'; end if;
  select * into cur from team_members where team_id = p_team and member_id = p_member;
  if cur.team_id is not null and cur.status = 'active' then raise exception '이미 팀원입니다.'; end if;
  if cur.team_id is not null and cur.status = 'invited' then raise exception '이미 초대했습니다. 상대방의 응답을 기다리세요.'; end if;
  if cur.team_id is null then
    insert into team_members (team_id, member_id, role_label, status, invited_by) values (p_team, p_member, coalesce(trim(p_role_label), ''), 'invited', u.id);
  else
    update team_members set status = 'invited', role_label = coalesce(trim(p_role_label), ''), invited_by = u.id, invited_at = clock_timestamp(), joined_at = null
     where team_id = p_team and member_id = p_member;
  end if;
  perform private.notify(p_member, format('%s 님이 팀 프로젝트 「%s」에 초대했습니다.', u.name, t.name), '#/team/' || p_team);
end $$;

create or replace function public.respond_team_invite(p_team uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; t team_projects; cur team_members;
begin
  u := private.require_active();
  select * into t from team_projects where id = p_team and deleted_at is null;
  if t.id is null then raise exception '팀 프로젝트를 찾을 수 없습니다.'; end if;
  select * into cur from team_members where team_id = p_team and member_id = u.id for update;
  if cur.team_id is null or cur.status <> 'invited' then raise exception '받은 초대가 없습니다.'; end if;
  if p_accept is null then raise exception '수락 또는 거절을 선택하세요.'; end if;
  if p_accept then
    update team_members set status = 'active', joined_at = clock_timestamp() where team_id = p_team and member_id = u.id;
    perform private.notify(t.leader, format('%s 님이 팀 「%s」 초대를 수락했습니다.', u.name, t.name), '#/team/' || p_team);
  else
    update team_members set status = 'left' where team_id = p_team and member_id = u.id;
    perform private.notify(t.leader, format('%s 님이 팀 「%s」 초대를 거절했습니다.', u.name, t.name), '#/team/' || p_team);
  end if;
end $$;

create or replace function private.drop_member_credit(p_team uuid, p_member uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c team_credits;
begin
  select * into c from team_credits where team_id = p_team and member_id = p_member;
  if c.team_id is null then return; end if;
  delete from team_credits where team_id = p_team and member_id = p_member;
  insert into team_credit_history (team_id, actor, change)
  values (p_team, private.my_member_id(), jsonb_build_object('kind', 'removed', 'member', p_member, 'display_name', c.display_name, 'reason', 'left'));
end $$;

create or replace function public.remove_team_member(p_team uuid, p_member uuid) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; t team_projects; cur team_members;
begin
  u := private.require_active();
  t := private.team_for_write(p_team, 'remove_member');
  if not private.is_team_leader(p_team) then raise exception '팀장만 팀원을 내보낼 수 있습니다.'; end if;
  if t.status in ('published', 'archived') then raise exception '게시 완료·보관된 팀의 팀원은 바꿀 수 없습니다.'; end if;
  if p_member = t.leader then raise exception '팀장은 내보낼 수 없습니다. 먼저 팀장을 넘기세요.'; end if;
  select * into cur from team_members where team_id = p_team and member_id = p_member;
  if cur.team_id is null or cur.status = 'left' then raise exception '팀원이 아닙니다.'; end if;
  update team_members set status = 'left' where team_id = p_team and member_id = p_member;
  perform private.drop_member_credit(p_team, p_member);
  perform private.notify(p_member, format('팀 「%s」에서 제외되었습니다.', t.name), '#/team/' || p_team);
end $$;

create or replace function public.leave_team(p_team uuid) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; t team_projects;
begin
  u := private.require_active();
  t := private.team_for_write(p_team, 'leave');
  if t.leader = u.id then raise exception '팀장은 팀을 떠날 수 없습니다. 먼저 팀장을 다른 팀원에게 넘기세요.'; end if;
  if not private.is_team_member(p_team) then raise exception '팀원이 아닙니다.'; end if;
  update team_members set status = 'left' where team_id = p_team and member_id = u.id;
  if t.published_at is null then perform private.drop_member_credit(p_team, u.id); end if;
  perform private.notify(t.leader, format('%s 님이 팀 「%s」를 떠났습니다.', u.name, t.name), '#/team/' || p_team);
end $$;

create or replace function public.transfer_team_leader(p_team uuid, p_member uuid) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; t team_projects; m profiles;
begin
  u := private.require_active();
  t := private.team_for_write(p_team, 'leader');
  if not (private.is_team_leader(p_team) or private.is_staff()) then raise exception '팀장 또는 운영진만 팀장을 바꿀 수 있습니다.'; end if;
  if p_member = t.leader then raise exception '이미 팀장입니다.'; end if;
  select * into m from profiles where id = p_member;
  if m.id is null or m.status <> 'active' or not exists (select 1 from team_members where team_id = p_team and member_id = p_member and status = 'active') then
    raise exception '활동 중인 팀원에게만 팀장을 넘길 수 있습니다.';
  end if;
  update team_projects set leader = p_member, updated_at = clock_timestamp() where id = p_team;
  update team_members set role_label = '팀장' where team_id = p_team and member_id = p_member;
  update team_members set role_label = '' where team_id = p_team and member_id = t.leader and role_label = '팀장';
  if t.leader <> u.id then
    perform private.audit('team.leader_changed', p_member, jsonb_build_object('team', p_team, 'name', t.name, 'from', t.leader));
  end if;
  perform private.notify(p_member, format('팀 「%s」의 팀장이 되었습니다.', t.name), '#/team/' || p_team);
  perform private.notify(t.leader, format('팀 「%s」의 팀장이 %s 님으로 바뀌었습니다.', t.name, m.name), '#/team/' || p_team);
end $$;

-- 상태 변경. 게시(published)는 publish_team 으로만 한다.
create or replace function public.set_team_status(p_team uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; t team_projects; v_leader boolean; v_staff boolean;
begin
  u := private.require_active();
  t := private.team_for_write(p_team, 'status');
  v_leader := private.is_team_leader(p_team); v_staff := private.is_staff();
  if p_status is null or p_status not in ('planning', 'active', 'pending_submit', 'done', 'archived') then raise exception '바꿀 수 없는 상태입니다.'; end if;
  if p_status = t.status then raise exception '이미 그 상태입니다.'; end if;
  if p_status = 'archived' then
    if not (v_leader or v_staff) then raise exception '팀장 또는 운영진만 보관할 수 있습니다.'; end if;
  elsif t.status = 'archived' or t.status = 'published' then
    raise exception '게시 완료·보관된 팀의 상태는 바꿀 수 없습니다.';
  elsif t.status = 'planning' and p_status = 'active' then
    if not v_leader then raise exception '팀장만 진행을 시작할 수 있습니다.'; end if;
  elsif t.status = 'active' and p_status = 'pending_submit' then
    if not v_leader then raise exception '팀장만 최종 제출할 수 있습니다.'; end if;
    perform private.team_ready(p_team);
  elsif t.status = 'pending_submit' and p_status = 'active' then
    if not (v_leader or v_staff) then raise exception '팀장 또는 운영진만 제출을 되돌릴 수 있습니다.'; end if;
  elsif t.status = 'pending_submit' and p_status = 'done' then
    if not v_staff then raise exception '운영진만 완료 처리할 수 있습니다.'; end if;
  elsif t.status = 'done' and p_status = 'active' then
    if not v_staff then raise exception '운영진만 완료를 되돌릴 수 있습니다.'; end if;
  else
    raise exception '바꿀 수 없는 상태 변경입니다.';
  end if;
  update team_projects set status = p_status, updated_at = clock_timestamp() where id = p_team;
  if v_staff and not v_leader then
    perform private.audit('team.status', t.leader, jsonb_build_object('team', p_team, 'name', t.name, 'from', t.status, 'to', p_status));
  end if;
  if p_status = 'pending_submit' then
    perform private.notify_staff(format('팀 「%s」이(가) 최종 제출되었습니다. 확인해 주세요.', t.name), '#/team/' || p_team);
  elsif p_status = 'done' then
    perform private.notify_team(p_team, format('팀 「%s」이(가) 완료 처리되었습니다. 곧 게시판에 게시됩니다.', t.name));
  elsif p_status = 'active' and t.status in ('pending_submit', 'done') then
    perform private.notify(t.leader, format('팀 「%s」의 제출이 되돌려졌습니다.', t.name), '#/team/' || p_team);
  end if;
end $$;

-- 파일 등록: 파일은 이미 Storage 에 올라가 있어야 한다. 같은 파일(이름)이면 새 버전으로 쌓이고, 덮어쓰지 않는다.
create or replace function public.register_team_file(p_team uuid, p_path text, p_name text, p_note text default '', p_file_id uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare u profiles; t team_projects; v jsonb; v_file uuid; v_no int; v_ver uuid; v_name text := trim(coalesce(p_name, ''));
begin
  u := private.require_active();
  t := private.team_for_write(p_team, 'file');
  if not private.is_team_member(p_team) then raise exception '팀원만 파일을 올릴 수 있습니다.'; end if;
  if t.status in ('published', 'archived') then raise exception '게시 완료·보관된 팀에는 파일을 올릴 수 없습니다.'; end if;
  perform private.check_len(p_note, 500, '버전 메모');
  v := private.verify_upload(p_path, 'team/' || p_team || '/', v_name);
  if exists (select 1 from team_file_versions where path = p_path) then raise exception '이미 등록된 파일입니다.'; end if;
  if p_file_id is not null then
    select id into v_file from team_files where id = p_file_id and team_id = p_team for update;
    if v_file is null then raise exception '새 버전을 올릴 파일을 찾을 수 없습니다.'; end if;
  else
    select id into v_file from team_files where team_id = p_team and lower(name) = lower(v_name) order by created_at limit 1 for update;
    if v_file is null then
      insert into team_files (team_id, name, created_by) values (p_team, v_name, u.id) returning id into v_file;
    end if;
  end if;
  select coalesce(max(version_no), 0) + 1 into v_no from team_file_versions where file_id = v_file;
  insert into team_file_versions (file_id, version_no, orig_name, path, size, mime, note, uploaded_by)
  values (v_file, v_no, v_name, p_path, (v ->> 'size')::bigint, v ->> 'mime', coalesce(trim(p_note), ''), u.id) returning id into v_ver;
  update team_projects set updated_at = clock_timestamp() where id = p_team;
  perform private.notify_team(p_team, format('%s 님이 「%s」의 파일 「%s」 v%s을(를) 올렸습니다.', u.name, t.name, (select name from team_files where id = v_file), v_no));
  return v_ver;
end $$;

-- 최종본 지정/해제 (팀장). 같은 파일의 다른 버전이 최종본이면 바꿔 끼운다.
create or replace function public.set_team_final(p_team uuid, p_version uuid, p_final boolean) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; t team_projects; v_file uuid;
begin
  u := private.require_active();
  t := private.team_for_write(p_team, 'final');
  if not private.is_team_leader(p_team) then raise exception '팀장만 최종본을 정할 수 있습니다.'; end if;
  if t.status in ('pending_submit', 'done', 'published', 'archived') then raise exception '제출 대기 이후에는 최종본을 바꿀 수 없습니다. 먼저 제출을 되돌리세요.'; end if;
  select v.file_id into v_file from team_file_versions v join team_files f on f.id = v.file_id where v.id = p_version and f.team_id = p_team;
  if v_file is null then raise exception '이 팀의 파일 버전이 아닙니다.'; end if;
  if p_final then
    delete from team_final_files where team_id = p_team and file_version_id in (select id from team_file_versions where file_id = v_file);
    insert into team_final_files (team_id, file_version_id) values (p_team, p_version);
  else
    delete from team_final_files where team_id = p_team and file_version_id = p_version;
  end if;
end $$;

create or replace function public.add_team_note(p_team uuid, p_kind text, p_body text) returns uuid
language plpgsql security definer set search_path = public as $$
declare u profiles; t team_projects; v_id uuid;
begin
  u := private.require_active();
  t := private.team_for_write(p_team, 'note');
  if not private.is_team_member(p_team) then raise exception '팀원만 쓸 수 있습니다.'; end if;
  if t.status in ('published', 'archived') then raise exception '게시 완료·보관된 팀에는 쓸 수 없습니다.'; end if;
  if p_kind is null or p_kind not in ('note', 'progress', 'discussion') then raise exception '글 종류가 올바르지 않습니다.'; end if;
  if nullif(trim(p_body), '') is null then raise exception '내용을 입력하세요.'; end if;
  perform private.check_len(trim(p_body), 4000, '내용');
  insert into team_notes (team_id, author, kind, body) values (p_team, u.id, p_kind, trim(p_body)) returning id into v_id;
  update team_projects set updated_at = clock_timestamp() where id = p_team;
  return v_id;
end $$;

create or replace function public.delete_team_note(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; n team_notes;
begin
  u := private.require_active();
  select * into n from team_notes where id = p_id;
  if n.id is null then raise exception '글이 없습니다.'; end if;
  perform private.team_for_write(n.team_id, 'note_delete');
  if n.author <> u.id and not private.is_team_leader(n.team_id) then raise exception '본인 글 또는 팀장만 지울 수 있습니다.'; end if;
  delete from team_notes where id = p_id;
end $$;

create or replace function public.pin_team_note(p_id uuid, p_pinned boolean) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; n team_notes;
begin
  u := private.require_active();
  select * into n from team_notes where id = p_id;
  if n.id is null then raise exception '글이 없습니다.'; end if;
  perform private.team_for_write(n.team_id, 'note_pin');
  if not private.is_team_leader(n.team_id) then raise exception '팀장만 고정할 수 있습니다.'; end if;
  update team_notes set pinned = coalesce(p_pinned, false) where id = p_id;
end $$;

-- 제작자 명단 (팀장이 작성 → 각자 확인/거절). 게시 후에는 관리자만 고칠 수 있고 이력·감사 기록이 남는다.
-- p_credits: [{"member_id": "...", "display_name": "...", "contribution": "..."}]
create or replace function public.set_team_credits(p_team uuid, p_credits jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  u profiles; t team_projects; e jsonb; v_post boolean; v_m uuid; v_name text; v_con text;
  old team_credits; seen uuid[] := '{}'; r record; v_status text; n_changes int := 0;
begin
  u := private.require_active();
  t := private.team_for_write(p_team, 'credits');
  v_post := t.published_at is not null;
  if v_post then
    if not private.is_admin() then raise exception '게시된 뒤에는 관리자만 제작자 표시를 고칠 수 있습니다.'; end if;
  else
    if not private.is_team_leader(p_team) then raise exception '팀장만 제작자 명단을 작성할 수 있습니다.'; end if;
    if t.status not in ('planning', 'active') then raise exception '제출 대기·완료 상태에서는 제작자 명단을 고칠 수 없습니다. 먼저 제출을 되돌리세요.'; end if;
  end if;
  if p_credits is null or jsonb_typeof(p_credits) <> 'array' then raise exception '제작자 명단 형식이 올바르지 않습니다.'; end if;
  if jsonb_array_length(p_credits) > 30 then raise exception '제작자는 30명까지 올릴 수 있습니다.'; end if;
  v_status := case when v_post then 'confirmed' else 'pending' end;
  for e in select * from jsonb_array_elements(p_credits) loop
    v_m := private.uuid_or_null(e ->> 'member_id');
    v_name := nullif(trim(coalesce(e ->> 'display_name', '')), '');
    v_con := trim(coalesce(e ->> 'contribution', ''));
    if v_m is null then raise exception '제작자 회원이 올바르지 않습니다.'; end if;
    if v_m = any (seen) then raise exception '같은 회원이 두 번 들어 있습니다.'; end if;
    if not exists (select 1 from team_members where team_id = p_team and member_id = v_m and (status = 'active' or (v_post and status = 'left'))) then
      raise exception '팀원이 아닌 회원은 제작자로 올릴 수 없습니다.';
    end if;
    if v_name is null then raise exception '이름 표기를 입력하세요.'; end if;
    perform private.check_len(v_name, 50, '이름 표기'); perform private.check_len(v_con, 200, '역할·기여');
    seen := seen || v_m;
  end loop;
  if cardinality(seen) = 0 then raise exception '제작자를 한 명 이상 올리세요.'; end if;
  for r in select * from team_credits where team_id = p_team and not (member_id = any (seen)) loop
    delete from team_credits where team_id = p_team and member_id = r.member_id;
    insert into team_credit_history (team_id, actor, change)
    values (p_team, u.id, jsonb_build_object('kind', 'removed', 'member', r.member_id, 'display_name', r.display_name));
    n_changes := n_changes + 1;
  end loop;
  for e in select * from jsonb_array_elements(p_credits) loop
    v_m := (e ->> 'member_id')::uuid;
    v_name := trim(e ->> 'display_name'); v_con := trim(coalesce(e ->> 'contribution', ''));
    select * into old from team_credits where team_id = p_team and member_id = v_m;
    if old.team_id is null then
      insert into team_credits (team_id, member_id, display_name, contribution, status, confirmed_at, updated_by)
      values (p_team, v_m, v_name, v_con, v_status, case when v_post then clock_timestamp() end, u.id);
      insert into team_credit_history (team_id, actor, change)
      values (p_team, u.id, jsonb_build_object('kind', 'added', 'member', v_m, 'display_name', v_name, 'contribution', v_con));
      n_changes := n_changes + 1;
      if not v_post then perform private.notify(v_m, format('팀 「%s」의 제작자 표시 확인을 요청받았습니다.', t.name), '#/team/' || p_team || '?tab=credits'); end if;
    elsif old.display_name <> v_name or old.contribution <> v_con then
      update team_credits set display_name = v_name, contribution = v_con, status = v_status,
             confirmed_at = case when v_post then clock_timestamp() end, updated_by = u.id
       where team_id = p_team and member_id = v_m;
      insert into team_credit_history (team_id, actor, change)
      values (p_team, u.id, jsonb_build_object('kind', 'changed', 'member', v_m, 'display_name', v_name, 'contribution', v_con,
                'from_display_name', old.display_name, 'from_contribution', old.contribution));
      n_changes := n_changes + 1;
      if not v_post then perform private.notify(v_m, format('팀 「%s」의 제작자 표시가 바뀌어 다시 확인이 필요합니다.', t.name), '#/team/' || p_team || '?tab=credits'); end if;
    end if;
  end loop;
  if v_post and n_changes > 0 then
    perform private.audit('team.credits_edited', t.leader, jsonb_build_object('team', p_team, 'name', t.name, 'count', n_changes));
  end if;
end $$;

-- 본인 항목만 확인/거절한다 (대상 회원을 인자로 받지 않는다)
create or replace function public.respond_team_credit(p_team uuid, p_confirm boolean) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; t team_projects; c team_credits;
begin
  u := private.require_active();
  t := private.team_for_write(p_team, 'credit_respond');
  select * into c from team_credits where team_id = p_team and member_id = u.id for update;
  if c.team_id is null then raise exception '내 이름으로 올라온 제작자 표시가 없습니다.'; end if;
  if c.status <> 'pending' then raise exception '확인 대기 중인 항목이 아닙니다.'; end if;
  if p_confirm is null then raise exception '확인 또는 거절을 선택하세요.'; end if;
  update team_credits set status = case when p_confirm then 'confirmed' else 'declined' end,
         confirmed_at = case when p_confirm then clock_timestamp() end, updated_by = u.id
   where team_id = p_team and member_id = u.id;
  insert into team_credit_history (team_id, actor, change)
  values (p_team, u.id, jsonb_build_object('kind', case when p_confirm then 'confirmed' else 'declined' end, 'member', u.id, 'display_name', c.display_name));
  perform private.notify(t.leader, format('%s 님이 제작자 표시를 %s했습니다. (팀 「%s」)', u.name, case when p_confirm then '확인' else '거절' end, t.name), '#/team/' || p_team || '?tab=credits');
  if p_confirm and not exists (select 1 from team_credits where team_id = p_team and status <> 'confirmed') then
    perform private.notify(t.leader, format('팀 「%s」의 제작자 명단을 모두 확인했습니다. 이제 제출할 수 있습니다.', t.name), '#/team/' || p_team || '?tab=credits');
  end if;
end $$;

create or replace function private.check_team_session(p_team uuid, p_session uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare t team_projects; s sessions; v_past boolean;
begin
  perform private.require_active();
  t := private.team_for_write(p_team, 'session');
  select * into s from sessions where id = p_session;
  if s.id is null then raise exception '차시가 없습니다.'; end if;
  if not (private.is_team_leader(p_team) or private.is_staff()) then raise exception '팀장 또는 운영진만 차시에 연결할 수 있습니다.'; end if;
  v_past := s.year <> private.year_of(now());
  if v_past and not private.is_admin() then raise exception '지난 연도의 차시는 관리자만 연결할 수 있습니다.'; end if;
  return v_past;
end $$;

create or replace function public.link_team_session(p_team uuid, p_session uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_past boolean;
begin
  v_past := private.check_team_session(p_team, p_session);
  insert into team_project_sessions (team_id, session_id, linked_by) values (p_team, p_session, private.my_member_id()) on conflict do nothing;
  if v_past then perform private.audit('team.session_link_past', (select leader from team_projects where id = p_team), jsonb_build_object('team', p_team, 'session', p_session)); end if;
end $$;

create or replace function public.unlink_team_session(p_team uuid, p_session uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_past boolean;
begin
  v_past := private.check_team_session(p_team, p_session);
  delete from team_project_sessions where team_id = p_team and session_id = p_session;
  if v_past then perform private.audit('team.session_unlink_past', (select leader from team_projects where id = p_team), jsonb_build_object('team', p_team, 'session', p_session)); end if;
end $$;

-- 게시: 운영진이 완료된 팀 프로젝트를 동아리 게시판에 올린다 (제작자 명단·차시·대표 이미지가 자동 연결)
create or replace function public.publish_team(p_team uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare u profiles; t team_projects; v_post uuid := gen_random_uuid(); v_body text;
begin
  u := private.require_staff();
  t := private.team_for_write(p_team, 'publish');
  if t.status <> 'done' then raise exception '완료 처리된 팀 프로젝트만 게시할 수 있습니다.'; end if;
  perform private.team_ready(p_team);
  v_body := coalesce(nullif(t.description, ''), '') || case when t.goal <> '' then E'\n\n## 목표\n' || t.goal else '' end;
  insert into posts (id, author, board, title, body, tags, visibility, cover_path, team_id, year)
  values (v_post, t.leader, 'club', t.name, v_body, array['팀프로젝트'], 'members', t.cover_path, p_team, t.year);
  insert into post_sessions (post_id, session_id) select v_post, session_id from team_project_sessions where team_id = p_team;
  update team_projects set status = 'published', published_at = clock_timestamp(), updated_at = clock_timestamp() where id = p_team;
  perform private.audit('team.published', t.leader, jsonb_build_object('team', p_team, 'name', t.name, 'post', v_post));
  perform private.notify_team(p_team, format('팀 「%s」이(가) 동아리 게시판에 게시되었습니다.', t.name));
  perform private.notify(t.leader, format('팀 「%s」이(가) 동아리 게시판에 게시되었습니다.', t.name), '#/post/' || v_post);
  return v_post;
end $$;

-- ---------------------------------------------------------------------
-- RPC: 게시판·공지 [v2.1]
-- ---------------------------------------------------------------------
create or replace function private.clean_tags(p text[]) returns text[]
language sql immutable as $$
  select coalesce(array(select x from (select distinct left(trim(both '#' from trim(t)), 20) x from unnest(coalesce(p, '{}')) t) s where x <> '' order by x limit 8), '{}')
$$;

-- 게시물의 차시 연결을 p_sessions 로 맞춘다 (지난 연도 차시는 관리자만)
create or replace function private.set_post_sessions(p_post uuid, p_sessions uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare s sessions; x uuid;
begin
  if cardinality(coalesce(p_sessions, '{}')) > 10 then raise exception '차시는 10개까지 연결할 수 있습니다.'; end if;
  foreach x in array coalesce(p_sessions, '{}') loop
    select * into s from sessions where id = x;
    if s.id is null then raise exception '차시가 없습니다.'; end if;
    if s.year <> private.year_of(now()) and not private.is_admin()
       and not exists (select 1 from post_sessions where post_id = p_post and session_id = x) then
      raise exception '지난 연도의 차시는 관리자만 연결할 수 있습니다.';
    end if;
  end loop;
  delete from post_sessions where post_id = p_post and not (session_id = any (coalesce(p_sessions, '{}')));
  insert into post_sessions (post_id, session_id) select p_post, y from (select distinct unnest(coalesce(p_sessions, '{}')) y) z
  on conflict do nothing;
end $$;

create or replace function public.create_post(
  p_board text, p_title text, p_body text, p_tags text[] default '{}', p_visibility text default 'members',
  p_team_id uuid default null, p_project_id uuid default null, p_session_ids uuid[] default '{}', p_pinned boolean default false
) returns uuid
language plpgsql security definer set search_path = public as $$
declare u profiles; v_id uuid := gen_random_uuid(); r record;
begin
  u := private.require_active();
  if p_board is null or p_board not in ('club', 'free', 'notice') then raise exception '게시판을 선택하세요.'; end if;
  if p_board in ('club', 'notice') and not private.is_staff() then
    raise exception '동아리·공지 게시물은 운영진만 쓸 수 있습니다. 개인 창작물은 자유 게시판에 올려 주세요.';
  end if;
  if nullif(trim(p_title), '') is null then raise exception '제목을 입력하세요.'; end if;
  perform private.check_len(trim(p_title), 100, '제목'); perform private.check_len(p_body, 20000, '내용');
  if p_visibility is null or p_visibility not in ('members', 'staff') then raise exception '공개 범위가 올바르지 않습니다.'; end if;
  if coalesce(p_pinned, false) and p_board <> 'notice' then raise exception '고정은 공지에만 쓸 수 있습니다.'; end if;
  if p_team_id is not null then
    if p_board <> 'club' then raise exception '팀 프로젝트는 동아리 게시물에만 연결할 수 있습니다.'; end if;
    if not private.team_published(p_team_id) then raise exception '게시 완료된 팀 프로젝트만 연결할 수 있습니다.'; end if;
  end if;
  if p_project_id is not null then perform private.get_project(p_project_id); end if;
  insert into posts (id, author, board, title, body, tags, visibility, team_id, project_id, year, pinned)
  values (v_id, u.id, p_board, trim(p_title), coalesce(p_body, ''), private.clean_tags(p_tags), p_visibility, p_team_id, p_project_id,
          private.year_of(now()), coalesce(p_pinned, false));
  perform private.set_post_sessions(v_id, p_session_ids);
  if p_board = 'notice' then
    for r in select id from profiles where status = 'active' and (p_visibility = 'members' or id in (select member_id from user_roles where role in ('owner', 'admin', 'president', 'vice'))) loop
      perform private.notify(r.id, format('새 공지: %s', trim(p_title)), '#/post/' || v_id);
    end loop;
  end if;
  return v_id;
end $$;

create or replace function public.update_post(
  p_id uuid, p_title text, p_body text, p_tags text[] default '{}', p_visibility text default 'members',
  p_project_id uuid default null, p_session_ids uuid[] default '{}'
) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; p posts;
begin
  u := private.require_active();
  select * into p from posts where id = p_id;
  if p.id is null or p.deleted_at is not null then raise exception '게시물을 찾을 수 없습니다.'; end if;
  if p.author <> u.id then raise exception '작성자만 고칠 수 있습니다.'; end if;
  if p.board in ('club', 'notice') and not private.is_staff() then raise exception '동아리·공지 게시물은 운영진만 고칠 수 있습니다.'; end if;
  if nullif(trim(p_title), '') is null then raise exception '제목을 입력하세요.'; end if;
  perform private.check_len(trim(p_title), 100, '제목'); perform private.check_len(p_body, 20000, '내용');
  if p_visibility is null or p_visibility not in ('members', 'staff') then raise exception '공개 범위가 올바르지 않습니다.'; end if;
  if p_project_id is not null then perform private.get_project(p_project_id); end if;
  update posts set title = trim(p_title), body = coalesce(p_body, ''), tags = private.clean_tags(p_tags), visibility = p_visibility,
         project_id = p_project_id, updated_at = clock_timestamp() where id = p_id;
  perform private.set_post_sessions(p_id, p_session_ids);
end $$;

-- 소프트 삭제: 본인 또는 운영진 (운영진이 남의 글을 지우면 감사 기록)
create or replace function public.delete_post(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; p posts;
begin
  u := private.require_active();
  select * into p from posts where id = p_id;
  if p.id is null or p.deleted_at is not null then raise exception '게시물을 찾을 수 없습니다.'; end if;
  if p.board in ('club', 'notice') then
    if not private.is_staff() then raise exception '동아리·공지 게시물은 운영진만 지울 수 있습니다.'; end if;
  elsif p.author <> u.id and not private.is_staff() then raise exception '작성자 또는 운영진만 지울 수 있습니다.'; end if;
  update posts set deleted_at = clock_timestamp() where id = p_id;
  if p.author <> u.id then
    perform private.audit('post.deleted', p.author, jsonb_build_object('post', p_id, 'title', p.title));
  end if;
end $$;

create or replace function public.set_post_hidden(p_id uuid, p_hidden boolean) returns void
language plpgsql security definer set search_path = public as $$
declare p posts;
begin
  perform private.require_staff();
  select * into p from posts where id = p_id;
  if p.id is null or p.deleted_at is not null then raise exception '게시물을 찾을 수 없습니다.'; end if;
  update posts set hidden = coalesce(p_hidden, false) where id = p_id;
  perform private.audit(case when coalesce(p_hidden, false) then 'post.hidden' else 'post.unhidden' end, p.author, jsonb_build_object('post', p_id, 'title', p.title));
end $$;

create or replace function public.set_post_pinned(p_id uuid, p_pinned boolean) returns void
language plpgsql security definer set search_path = public as $$
declare p posts;
begin
  perform private.require_staff();
  select * into p from posts where id = p_id;
  if p.id is null or p.deleted_at is not null then raise exception '게시물을 찾을 수 없습니다.'; end if;
  if p.board <> 'notice' then raise exception '공지만 고정할 수 있습니다.'; end if;
  update posts set pinned = coalesce(p_pinned, false) where id = p_id;
end $$;

-- 첨부·대표 이미지 등록 (작성자). 파일은 post/<게시물 ID>/ 아래에 이미 올라가 있어야 한다.
create or replace function public.register_post_file(p_post uuid, p_path text, p_name text, p_cover boolean default false) returns uuid
language plpgsql security definer set search_path = public as $$
declare u profiles; p posts; v jsonb; v_id uuid;
begin
  u := private.require_active();
  select * into p from posts where id = p_post;
  if p.id is null or p.deleted_at is not null then raise exception '게시물을 찾을 수 없습니다.'; end if;
  if p.author <> u.id then raise exception '작성자만 파일을 붙일 수 있습니다.'; end if;
  if p.board in ('club', 'notice') and not private.is_staff() then raise exception '동아리·공지 게시물은 운영진만 고칠 수 있습니다.'; end if;
  v := private.verify_upload(p_path, 'post/' || p_post || '/', p_name);
  if exists (select 1 from post_files where path = p_path) then raise exception '이미 등록된 파일입니다.'; end if;
  if coalesce(p_cover, false) then
    if lower(p_path) !~ '\.(png|jpe?g|gif|webp)$' then raise exception '대표 이미지는 png, jpg, gif, webp 만 쓸 수 있습니다.'; end if;
    update posts set cover_path = p_path, updated_at = clock_timestamp() where id = p_post;
    return null;
  end if;
  if (select count(*) from post_files where post_id = p_post) >= 10 then raise exception '첨부는 10개까지 붙일 수 있습니다.'; end if;
  insert into post_files (post_id, path, name, size, mime) values (p_post, p_path, trim(p_name), (v ->> 'size')::bigint, v ->> 'mime') returning id into v_id;
  return v_id;
end $$;

create or replace function public.remove_post_file(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; f post_files;
begin
  u := private.require_active();
  select * into f from post_files where id = p_id;
  if f.id is null then raise exception '첨부가 없습니다.'; end if;
  if not exists (select 1 from posts where id = f.post_id and author = u.id) then raise exception '작성자만 지울 수 있습니다.'; end if;
  if exists (select 1 from posts where id = f.post_id and board in ('club', 'notice')) and not private.is_staff() then raise exception '동아리·공지 게시물은 운영진만 고칠 수 있습니다.'; end if;
  delete from post_files where id = p_id;   -- 저장소의 실제 파일은 남는다 (관리자가 대시보드에서 정리)
end $$;

create or replace function public.add_post_comment(p_post uuid, p_body text) returns uuid
language plpgsql security definer set search_path = public as $$
declare u profiles; p posts; v_id uuid;
begin
  u := private.require_active();
  if not private.can_read_post(p_post) then raise exception '게시물을 찾을 수 없습니다.'; end if;
  select * into p from posts where id = p_post;
  if p.deleted_at is not null then raise exception '삭제된 게시물입니다.'; end if;
  if nullif(trim(p_body), '') is null then raise exception '댓글 내용을 입력하세요.'; end if;
  perform private.check_len(trim(p_body), 2000, '댓글');
  insert into post_comments (post_id, author, body) values (p_post, u.id, trim(p_body)) returning id into v_id;
  perform private.notify(p.author, format('%s 님이 「%s」에 댓글을 남겼습니다.', u.name, p.title), '#/post/' || p_post);
  return v_id;
end $$;

create or replace function public.delete_post_comment(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; c post_comments;
begin
  u := private.require_active();
  select * into c from post_comments where id = p_id;
  if c.id is null or c.deleted_at is not null then raise exception '댓글이 없습니다.'; end if;
  if c.author <> u.id and not private.is_staff() then raise exception '본인 댓글만 지울 수 있습니다.'; end if;
  update post_comments set deleted_at = clock_timestamp() where id = p_id;
  if c.author <> u.id then perform private.audit('post.comment_deleted', c.author, jsonb_build_object('post', c.post_id)); end if;
end $$;

-- 좋아요 토글. 지금 눌린 상태를 돌려준다.
create or replace function public.toggle_post_reaction(p_post uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare u profiles;
begin
  u := private.require_active();
  if not private.can_read_post(p_post) or exists (select 1 from posts where id = p_post and deleted_at is not null) then raise exception '게시물을 찾을 수 없습니다.'; end if;
  if exists (select 1 from post_reactions where post_id = p_post and member_id = u.id and kind = 'like') then
    delete from post_reactions where post_id = p_post and member_id = u.id and kind = 'like';
    return false;
  end if;
  insert into post_reactions (post_id, member_id, kind) values (p_post, u.id, 'like');
  return true;
end $$;

create or replace function public.report_post(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; p posts;
begin
  u := private.require_active();
  if not private.can_read_post(p_id) then raise exception '게시물을 찾을 수 없습니다.'; end if;
  select * into p from posts where id = p_id;
  if p.deleted_at is not null then raise exception '삭제된 게시물입니다.'; end if;
  if nullif(trim(p_reason), '') is null then raise exception '신고 사유를 입력하세요.'; end if;
  perform private.check_len(trim(p_reason), 1000, '신고 사유');
  if exists (select 1 from reports where post_id = p_id and reporter_id = u.id and status <> 'resolved') then
    raise exception '이미 신고한 게시물입니다. 운영진이 확인 중입니다.';
  end if;
  insert into reports (post_id, reporter_id, reason) values (p_id, u.id, trim(p_reason));
  perform private.notify_staff(format('게시물 「%s」에 대한 신고가 접수되었습니다.', p.title), '#/admin?tab=reports');
end $$;

-- ---------------------------------------------------------------------
-- [v2.2] 3단계: 팀 삭제·복구, 명예의 전당, 명단 가져오기, 저장 공간 관리
-- ---------------------------------------------------------------------
-- 직책이 바뀌면 "현재 운영 연도" 명단의 직책 기록도 함께 맞춘다 → 연도가 지나면 그 해 마지막 직책으로 굳는다 (명예의 전당이 읽는다)
create or replace function private.sync_roles_snapshot() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_member uuid;
begin
  if tg_op = 'DELETE' then v_member := old.member_id; else v_member := new.member_id; end if;
  update membership_history
     set roles = coalesce(array(select ur.role from user_roles ur where ur.member_id = v_member order by ur.role), '{}')
   where member_id = v_member and year = private.year_of(now());
  return null;
end $$;
drop trigger if exists user_roles_sync_snapshot on public.user_roles;
create trigger user_roles_sync_snapshot after insert or delete on public.user_roles
  for each row execute function private.sync_roles_snapshot();

-- 우수 작업물 (명예의 전당)
create table if not exists public.featured_items (
  kind         text not null check (kind in ('team', 'post', 'project')),
  item_id      uuid not null,
  year         int not null,
  note         text not null default '',
  featured_by  uuid references public.profiles (id),
  featured_at  timestamptz not null default clock_timestamp(),
  primary key (kind, item_id)
);
create index if not exists featured_items_year_idx on public.featured_items (year);

create or replace function private.can_see_item(p_kind text, p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case p_kind
    when 'team' then private.team_visible(p_id)
    when 'post' then private.can_read_post(p_id)
    when 'project' then private.can_see(p_id)
    else false end
$$;

-- 관리자 전용 팀 삭제(소프트 삭제). 파일·기록은 지우지 않고, 관리자 외에는 어디에서도 보이지 않게 한다.
create or replace function public.delete_team(p_team_id uuid, p_reason text default '') returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; t team_projects; v_now timestamptz := clock_timestamp(); v_posts int; r record;
begin
  u := private.require_admin();
  select * into t from team_projects where id = p_team_id for update;
  if t.id is null then raise exception '팀 프로젝트를 찾을 수 없습니다.'; end if;
  if t.deleted_at is not null then raise exception '이미 삭제된 팀입니다.'; end if;
  perform private.check_len(p_reason, 500, '삭제 사유');
  update team_projects set deleted_at = v_now, deleted_by = u.id, delete_reason = coalesce(trim(p_reason), ''), updated_at = v_now where id = p_team_id;
  -- 게시된 팀이면 연결된 동아리 게시물도 함께 소프트 삭제 (복구 때 같은 시각의 것만 되살린다)
  update posts set deleted_at = v_now where team_id = p_team_id and deleted_at is null;
  get diagnostics v_posts = row_count;
  perform private.audit('team.deleted', t.leader, jsonb_build_object('team', p_team_id, 'name', t.name, 'year', t.year, 'reason', coalesce(trim(p_reason), ''), 'posts', v_posts));
  for r in select member_id from team_members where team_id = p_team_id and status in ('active', 'invited') loop
    perform private.notify(r.member_id, format('팀 프로젝트 「%s」이(가) 관리자에 의해 삭제되었습니다.', t.name), '#/teams');
  end loop;
end $$;

create or replace function public.restore_team(p_team_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t team_projects; r record; v_posts int;
begin
  perform private.require_admin();
  select * into t from team_projects where id = p_team_id for update;
  if t.id is null then raise exception '팀 프로젝트를 찾을 수 없습니다.'; end if;
  if t.deleted_at is null then raise exception '삭제된 팀이 아닙니다.'; end if;
  update posts set deleted_at = null where team_id = p_team_id and deleted_at = t.deleted_at;
  get diagnostics v_posts = row_count;
  update team_projects set deleted_at = null, deleted_by = null, delete_reason = '', updated_at = clock_timestamp() where id = p_team_id;
  perform private.audit('team.restored', t.leader, jsonb_build_object('team', p_team_id, 'name', t.name, 'year', t.year, 'posts', v_posts));
  for r in select member_id from team_members where team_id = p_team_id and status in ('active', 'invited') loop
    perform private.notify(r.member_id, format('팀 프로젝트 「%s」이(가) 복구되었습니다.', t.name), '#/team/' || p_team_id);
  end loop;
end $$;

-- 우수 작업물 지정/해제: 현재 연도는 운영진, 지난 연도는 관리자만(감사 기록)
create or replace function public.feature_item(p_kind text, p_item_id uuid, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; v_year int; v_title text; t team_projects; po posts; pr projects; v_cur int := private.year_of(now());
begin
  u := private.require_staff();   -- 먼저 운영진인지 확인한다 (일반 부원이 항목 존재 여부를 오류 문구로 알아내지 못하게)
  if p_kind is null or p_kind not in ('team', 'post', 'project') then raise exception '우수 작업물로 올릴 수 없는 종류입니다.'; end if;
  perform private.check_len(p_note, 200, '메모');
  if p_kind = 'team' then
    select * into t from team_projects where id = p_item_id and deleted_at is null;
    if t.id is null then raise exception '팀 프로젝트를 찾을 수 없습니다.'; end if;
    if t.published_at is null then raise exception '게시 완료된 팀 프로젝트만 우수 작업물로 올릴 수 있습니다.'; end if;
    v_year := t.year; v_title := t.name;
  elsif p_kind = 'post' then
    select * into po from posts where id = p_item_id and deleted_at is null and not hidden and visibility = 'members';
    if po.id is null then raise exception '게시물을 찾을 수 없습니다.'; end if;
    if po.board = 'notice' then raise exception '공지는 우수 작업물로 올릴 수 없습니다.'; end if;
    v_year := po.year; v_title := po.title;
  else
    select * into pr from projects where id = p_item_id and not deleted and not hidden;
    if pr.id is null then raise exception '프로젝트를 찾을 수 없습니다.'; end if;
    v_year := coalesce(pr.year, private.year_of(pr.created_at)); v_title := pr.title;
  end if;
  if v_year <> v_cur then
    perform private.require_admin();
  else
    perform private.require_staff();
  end if;
  insert into featured_items (kind, item_id, year, note, featured_by) values (p_kind, p_item_id, v_year, coalesce(trim(p_note), ''), u.id)
  on conflict (kind, item_id) do update set note = excluded.note, featured_by = excluded.featured_by, featured_at = clock_timestamp();
  if v_year <> v_cur then
    perform private.audit('hall.featured_past', null, jsonb_build_object('kind', p_kind, 'item', p_item_id, 'year', v_year, 'title', v_title));
  end if;
end $$;

create or replace function public.unfeature_item(p_kind text, p_item_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare f featured_items; v_cur int := private.year_of(now());
begin
  perform private.require_staff();
  select * into f from featured_items where kind = p_kind and item_id = p_item_id;
  if f.item_id is null then raise exception '우수 작업물로 지정되어 있지 않습니다.'; end if;
  if f.year <> v_cur then perform private.require_admin(); else perform private.require_staff(); end if;
  delete from featured_items where kind = p_kind and item_id = p_item_id;
  if f.year <> v_cur then
    perform private.audit('hall.unfeatured_past', null, jsonb_build_object('kind', p_kind, 'item', p_item_id, 'year', f.year));
  end if;
end $$;

-- 차시 일괄 편집: 한 연도의 차시를 한 번에 고친다 (현재 연도는 운영진, 지난 연도는 관리자 + 감사 기록)
-- p_items: [{"id": "...", "title": "...", "held_on": "2027-04-01" | "", "description": "..."}]
create or replace function public.update_sessions_bulk(p_year int, p_items jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare
  e jsonb; s sessions; v_past boolean := p_year <> private.year_of(now()); v_title text; v_date date; v_desc text; v_n int := 0; v_seen uuid[] := '{}'; v_id uuid;
begin
  perform private.require_active();
  if v_past then perform private.require_admin(); else perform private.require_staff(); end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception '수정할 차시가 없습니다.'; end if;
  if jsonb_array_length(p_items) > 10 then raise exception '차시는 한 번에 10개까지 고칠 수 있습니다.'; end if;
  -- 먼저 전부 검사한 뒤 한꺼번에 반영한다 (하나라도 틀리면 아무것도 바꾸지 않는다)
  for e in select * from jsonb_array_elements(p_items) loop
    v_id := private.uuid_or_null(e ->> 'id');
    select * into s from sessions where id = v_id;
    if s.id is null or s.year <> p_year then raise exception '% 연도의 차시가 아닙니다.', p_year; end if;
    if v_id = any (v_seen) then raise exception '같은 차시가 두 번 들어 있습니다.'; end if;
    v_seen := v_seen || v_id;
    v_title := trim(coalesce(e ->> 'title', ''));
    if v_title = '' then raise exception '%차시의 제목을 입력하세요.', s.no; end if;
    perform private.check_len(v_title, 100, '차시 제목'); perform private.check_len(e ->> 'description', 1000, '차시 설명');
    begin
      v_date := nullif(trim(coalesce(e ->> 'held_on', '')), '')::date;
    exception when others then raise exception '%차시의 날짜 형식이 올바르지 않습니다.', s.no;
    end;
  end loop;
  for e in select * from jsonb_array_elements(p_items) loop
    v_id := (e ->> 'id')::uuid;
    select * into s from sessions where id = v_id;
    v_title := trim(e ->> 'title'); v_desc := trim(coalesce(e ->> 'description', ''));
    v_date := nullif(trim(coalesce(e ->> 'held_on', '')), '')::date;
    if s.title is distinct from v_title or s.held_on is distinct from v_date or s.description is distinct from v_desc then
      update sessions set title = v_title, held_on = v_date, description = v_desc where id = v_id;
      v_n := v_n + 1;
      if v_past then
        perform private.audit('session.updated_past', null, jsonb_build_object('session', v_id, 'year', s.year, 'no', s.no, 'title', v_title));
      end if;
    end if;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- [v2.2] 명단 가져오기(CSV). 클라이언트가 CSV 를 파싱해 행 목록으로 보내면 서버가 분류하고, 올바른 행만 반영한다.
--   p_rows: [{"name","generation","grade","email","member_no","note"}]  (note = CSV 의 직책 칸. 메모로만 보관하고 직책은 주지 않는다)
--   분류: existing(기존 회원) / new(신규) / dup(파일 내 중복) / conflict(회원번호와 이메일이 서로 다른 회원) / error
--   회원은 회원번호, 없으면 이메일(로그인 계정·회원 이메일·사전 등록)로만 찾는다. 이름으로는 절대 합치지 않는다.
-- ---------------------------------------------------------------------
create or replace function private.roster_classify(p_year int, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s settings; e jsonb; i int := 0; v_out jsonb := '[]'::jsonb;
  v_name text; v_email text; v_no text; v_gen_t text; v_grade_t text; v_gen int; v_grade int; v_note text;
  v_a uuid; v_b uuid[]; v_member uuid; v_st text; v_reason text; v_invite boolean; v_activate boolean; v_mname text;
  seen_emails text[] := '{}'; seen_members uuid[] := '{}'; seen_nos text[] := '{}';
begin
  select * into s from settings where id = 1;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception '가져올 명단이 없습니다.'; end if;
  if jsonb_array_length(p_rows) > 500 then raise exception '한 번에 500행까지 가져올 수 있습니다.'; end if;
  if not exists (select 1 from academic_years where year = p_year) then raise exception '%년 운영 연도가 없습니다.', p_year; end if;
  for e in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    v_name := trim(coalesce(e ->> 'name', '')); v_email := lower(trim(coalesce(e ->> 'email', ''))); v_no := upper(trim(coalesce(e ->> 'member_no', '')));
    v_gen_t := trim(coalesce(e ->> 'generation', '')); v_grade_t := trim(coalesce(e ->> 'grade', '')); v_note := left(trim(coalesce(e ->> 'note', '')), 100);
    v_st := null; v_reason := null; v_member := null; v_invite := false; v_activate := false; v_gen := null; v_grade := null; v_a := null; v_b := '{}'; v_mname := null;
    if v_name = '' then v_st := 'error'; v_reason := '이름이 비어 있습니다.';
    elsif char_length(v_name) > 50 then v_st := 'error'; v_reason := '이름이 50자를 넘습니다.';
    elsif v_no = '' and v_email = '' then v_st := 'error'; v_reason := '이메일 또는 회원번호가 필요합니다.';
    elsif v_gen_t <> '' and v_gen_t !~ '^[0-9]{1,3}$' then v_st := 'error'; v_reason := '기수가 올바르지 않습니다. (1 이상의 숫자)';
    elsif v_grade_t <> '' and v_grade_t !~ '^[0-9]$' then v_st := 'error'; v_reason := '학년이 올바르지 않습니다. (1~6)';
    elsif v_no <> '' and v_no !~ '^POP-[0-9]{1,8}$' then v_st := 'error'; v_reason := '회원번호 형식이 올바르지 않습니다. (예: POP-0001)';
    elsif v_email <> '' and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then v_st := 'error'; v_reason := '이메일 형식이 올바르지 않습니다.';
    elsif v_email <> '' and right(v_email, length(s.domain) + 1) is distinct from '@' || lower(s.domain) then v_st := 'error'; v_reason := format('학교 계정(@%s)이 아닙니다.', s.domain);
    end if;
    if v_st is null and v_gen_t <> '' then
      v_gen := v_gen_t::int;
      if v_gen < 1 then v_st := 'error'; v_reason := '기수는 1 이상이어야 합니다.'; end if;
    end if;
    if v_st is null and v_grade_t <> '' then
      v_grade := v_grade_t::int;
      if v_grade not between 1 and 6 then v_st := 'error'; v_reason := '학년은 1~6 사이여야 합니다.'; end if;
    end if;
    if v_st is null and ((v_email <> '' and v_email = any (seen_emails)) or (v_no <> '' and v_no = any (seen_nos))) then
      v_st := 'dup'; v_reason := '파일 안에 같은 이메일 또는 회원번호가 앞에 이미 있습니다.';
    end if;
    if v_st is null and v_no <> '' then
      select id into v_a from profiles where member_no = v_no;
      if v_a is null then v_st := 'error'; v_reason := '그런 회원번호가 없습니다.'; end if;
    end if;
    if v_st is null and v_email <> '' then
      select coalesce(array_agg(m order by m), '{}') into v_b from (
        select member_id m from user_accounts where lower(email) = v_email
        union select user_id from member_emails where lower(email) = v_email
        union select member_id from account_invites where lower(email) = v_email) x;
      if cardinality(v_b) > 1 then v_st := 'conflict'; v_reason := '이 이메일이 여러 회원에 연결되어 있습니다.';
      elsif v_a is not null and cardinality(v_b) = 1 and v_b[1] <> v_a then v_st := 'conflict'; v_reason := '회원번호와 이메일이 서로 다른 회원을 가리킵니다.';
      end if;
    end if;
    if v_st is null then
      v_member := coalesce(v_a, case when cardinality(v_b) = 1 then v_b[1] end);
      if v_member is null then
        v_st := 'new';
      elsif v_member = any (seen_members) then
        v_st := 'dup'; v_reason := '파일 안에서 같은 회원이 앞에 이미 있습니다.';
      else
        v_st := 'existing';
      end if;
    end if;
    if v_st = 'existing' then
      select name, (status = 'pending') into v_mname, v_activate from profiles where id = v_member;
      if v_email <> '' and cardinality(v_b) = 0 then v_invite := true; end if;
    end if;
    if v_st in ('new', 'existing') then
      if v_email <> '' then seen_emails := seen_emails || v_email; end if;
      if v_no <> '' then seen_nos := seen_nos || v_no; end if;
      if v_member is not null then seen_members := seen_members || v_member; end if;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'idx', i, 'name', v_name, 'generation', v_gen, 'grade', v_grade, 'email', v_email, 'member_no', v_no, 'note', v_note,
      'status', v_st, 'reason', v_reason, 'member_id', v_member, 'member_name', v_mname, 'invite', v_invite, 'activate', coalesce(v_activate, false)));
  end loop;
  return v_out;
end $$;

create or replace function public.preview_roster(p_year int, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_rows jsonb;
begin
  perform private.require_admin();
  v_rows := private.roster_classify(p_year, p_rows);
  return jsonb_build_object('year', p_year, 'rows', v_rows, 'counts', (
    select coalesce(jsonb_object_agg(st, n), '{}'::jsonb) from (select r ->> 'status' st, count(*) n from jsonb_array_elements(v_rows) r group by 1) x));
end $$;

create or replace function public.import_roster(p_year int, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u profiles; v_rows jsonb; r jsonb; v_id uuid; v_status text; v_cur int := private.year_of(now()); v_start date;
  n_created int := 0; n_updated int := 0; n_skipped int := 0; n_invites int := 0; n_activated int := 0; v_gen int; v_grade int; v_email text;
  v_activated uuid[] := '{}'; v_invited uuid[] := '{}';
begin
  u := private.require_admin();
  v_rows := private.roster_classify(p_year, p_rows);
  select starts_on into v_start from academic_years where year = p_year;
  for r in select * from jsonb_array_elements(v_rows) loop
    if r ->> 'status' not in ('new', 'existing') then n_skipped := n_skipped + 1; continue; end if;
    v_gen := (r ->> 'generation')::int; v_grade := (r ->> 'grade')::int; v_email := nullif(r ->> 'email', '');
    if r ->> 'status' = 'new' then
      -- 인증 계정은 아직 없다. 사전 등록(account_invites)이 있으므로 그 이메일로 첫 로그인하면 이 회원에 자동 연결된다.
      insert into profiles (id, name, status, generation) values (gen_random_uuid(), r ->> 'name', 'active', v_gen) returning id into v_id;
      insert into account_invites (email, member_id, created_by) values (v_email, v_id, u.id);
      n_created := n_created + 1; n_invites := n_invites + 1; v_invited := v_invited || v_id;
    else
      v_id := (r ->> 'member_id')::uuid;
      if (r ->> 'invite')::boolean and v_email is not null then
        insert into account_invites (email, member_id, created_by) values (v_email, v_id, u.id) on conflict (email) do nothing;
        n_invites := n_invites + 1; v_invited := v_invited || v_id;
      end if;
      if (r ->> 'activate')::boolean then
        update profiles set status = 'active' where id = v_id and status = 'pending';
        v_activated := v_activated || v_id; n_activated := n_activated + 1;
        perform private.notify(v_id, '가입이 승인되었습니다. 환영합니다!', '#/');
      end if;
      if v_gen is not null then update profiles set generation = v_gen where id = v_id and generation is null; end if;
      n_updated := n_updated + 1;
    end if;
    select status into v_status from profiles where id = v_id;
    insert into membership_history (member_id, year, generation, grade, roles, status, joined_on, note)
    values (v_id, p_year, v_gen, v_grade,
            case when p_year = v_cur then coalesce(array(select ur.role from user_roles ur where ur.member_id = v_id order by ur.role), '{}') else '{}' end,
            v_status, v_start, coalesce(r ->> 'note', ''))
    on conflict (member_id, year) do update
      set generation = coalesce(excluded.generation, membership_history.generation),
          grade = coalesce(excluded.grade, membership_history.grade),
          note = coalesce(nullif(excluded.note, ''), membership_history.note);
  end loop;
  perform private.audit('roster.imported', null, jsonb_build_object('year', p_year, 'created', n_created, 'updated', n_updated, 'skipped', n_skipped,
    'invites', n_invites, 'activated', n_activated, 'activated_members', to_jsonb(v_activated), 'invited_members', to_jsonb(v_invited), 'rows', jsonb_array_length(v_rows)));
  return jsonb_build_object('year', p_year, 'created', n_created, 'updated', n_updated, 'skipped', n_skipped, 'invites', n_invites, 'activated', n_activated, 'rows', v_rows);
end $$;

-- ---------------------------------------------------------------------
-- [v2.2] 저장 공간 관리 (Supabase 무료 요금제 Storage 1GB). 관리자는 전부, 서버 관리자(server.detail)는 합계만.
-- ---------------------------------------------------------------------
create or replace function public.storage_usage() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_admin boolean; v_detail boolean; v_total bigint := 0; v_count bigint := 0; v_by jsonb := null; v_big jsonb := null; v_orph jsonb := null;
  v_on bigint := null; v_ob bigint := null;
begin
  perform private.require_active();
  v_admin := private.is_admin();
  v_detail := v_admin or (private.has_role('server') and private.has_perm('server.detail'));
  if not v_detail then raise exception '저장 공간 상태를 볼 권한이 없습니다.'; end if;
  if to_regclass('storage.objects') is null then
    return jsonb_build_object('available', false, 'limit_bytes', 1073741824, 'total_bytes', 0, 'total_count', 0,
      'by_prefix', case when v_admin then '[]'::jsonb end, 'largest', case when v_admin then '[]'::jsonb end, 'orphans', case when v_admin then '[]'::jsonb end,
      'orphan_count', case when v_admin then 0 end, 'orphan_bytes', case when v_admin then 0 end);
  end if;
  execute $q$ select coalesce(sum(coalesce((metadata ->> 'size')::bigint, 0)), 0)::bigint, count(*)::bigint from storage.objects where bucket_id = 'pop-files' $q$ into v_total, v_count;
  if v_admin then
    execute $q$ select coalesce(jsonb_agg(jsonb_build_object('prefix', p, 'bytes', b, 'count', c) order by b desc), '[]'::jsonb)
                  from (select split_part(name, '/', 1) p, sum(coalesce((metadata ->> 'size')::bigint, 0))::bigint b, count(*) c
                          from storage.objects where bucket_id = 'pop-files' group by 1) x $q$ into v_by;
    execute $q$ select coalesce(jsonb_agg(jsonb_build_object('path', name, 'size', size, 'created_at', created_at, 'linked', linked) order by size desc, name), '[]'::jsonb)
                  from (select o.name, coalesce((o.metadata ->> 'size')::bigint, 0) size, o.created_at,
                          coalesce(
                            (select '팀 파일 · ' || t.name || ' / ' || f.name from team_file_versions v join team_files f on f.id = v.file_id join team_projects t on t.id = f.team_id where v.path = o.name limit 1),
                            (select '게시물 첨부 · ' || p.title from post_files pf join posts p on p.id = pf.post_id where pf.path = o.name limit 1),
                            (select '게시물 대표 이미지 · ' || p.title from posts p where p.cover_path = o.name limit 1),
                            (select '팀 대표 이미지 · ' || t.name from team_projects t where t.cover_path = o.name limit 1)) linked
                          from storage.objects o where o.bucket_id = 'pop-files'
                         order by 2 desc, o.name limit 20) y $q$ into v_big;
    execute $q$ select coalesce(jsonb_agg(jsonb_build_object('path', name, 'size', size, 'created_at', created_at, 'deletable', created_at < now() - interval '24 hours') order by created_at, name), '[]'::jsonb)
                  from (select o.name, coalesce((o.metadata ->> 'size')::bigint, 0) size, o.created_at from storage.objects o
                         where o.bucket_id = 'pop-files' and private.is_orphan_path(o.name) order by o.created_at, o.name limit 200) z $q$ into v_orph;
    execute $q$ select count(*)::bigint, coalesce(sum(coalesce((metadata ->> 'size')::bigint, 0)), 0)::bigint from storage.objects
                 where bucket_id = 'pop-files' and private.is_orphan_path(name) $q$ into v_on, v_ob;
  end if;
  return jsonb_build_object('available', true, 'limit_bytes', 1073741824, 'total_bytes', v_total, 'total_count', v_count,
    'by_prefix', v_by, 'largest', v_big, 'orphans', v_orph, 'orphan_count', v_on, 'orphan_bytes', v_ob);
end $$;

-- 고아 파일 정리 기록: 파일은 클라이언트가 Storage 에서 지우고(삭제 정책이 서버 쪽에서 다시 검사), 여기서는 실제로 사라졌는지 세어 감사 기록만 남긴다.
create or replace function public.log_orphan_cleanup(p_paths text[]) returns int
language plpgsql security definer set search_path = public as $$
declare v_left bigint := 0; v_n int;
begin
  perform private.require_admin();
  v_n := coalesce(cardinality(p_paths), 0);
  if v_n = 0 then raise exception '정리한 파일 목록이 비어 있습니다.'; end if;
  if v_n > 200 then raise exception '한 번에 200개까지 기록할 수 있습니다.'; end if;
  if to_regclass('storage.objects') is not null then
    execute $q$ select count(*)::bigint from storage.objects where bucket_id = 'pop-files' and name = any ($1) $q$ into v_left using p_paths;
  end if;
  perform private.audit('storage.orphans_cleaned', null, jsonb_build_object('requested', v_n, 'removed', v_n - v_left, 'sample', to_jsonb((select array_agg(x) from (select unnest(p_paths) x limit 10) y))));
  return (v_n - v_left)::int;
end $$;

-- ---------------------------------------------------------------------
-- RLS: 2단계 표 (읽기만, 쓰기는 위 함수로만)
-- ---------------------------------------------------------------------
alter table public.team_projects         enable row level security;
alter table public.team_members          enable row level security;
alter table public.team_files            enable row level security;
alter table public.team_file_versions    enable row level security;
alter table public.team_notes            enable row level security;
alter table public.team_credits          enable row level security;
alter table public.team_credit_history   enable row level security;
alter table public.team_project_sessions enable row level security;
alter table public.team_final_files      enable row level security;
alter table public.posts                 enable row level security;
alter table public.post_sessions         enable row level security;
alter table public.post_files            enable row level security;
alter table public.post_comments         enable row level security;
alter table public.post_reactions        enable row level security;
alter table public.featured_items        enable row level security;

-- 팀 이름·설명·상태·팀원 명단은 전체 부원이 볼 수 있고, 파일·메모는 팀원과 운영진만 (게시된 최종본은 전체 부원)
drop policy if exists read_team_projects on public.team_projects;
create policy read_team_projects on public.team_projects for select using (private.is_reader() and (deleted_at is null or private.is_admin()));
drop policy if exists read_team_members on public.team_members;
create policy read_team_members on public.team_members for select
  using (private.is_reader() and private.team_visible(team_id)
         and (status = 'active' or member_id = private.my_member_id() or private.is_team_leader(team_id) or private.is_staff()));
drop policy if exists read_team_files on public.team_files;
create policy read_team_files on public.team_files for select using (private.can_view_team(team_id) or (private.is_reader() and private.file_has_public_final(id)));
drop policy if exists read_team_file_versions on public.team_file_versions;
create policy read_team_file_versions on public.team_file_versions for select
  using (private.can_view_team(private.team_of_file(file_id)) or private.version_is_public_final(id));
drop policy if exists read_team_notes on public.team_notes;
create policy read_team_notes on public.team_notes for select using (private.can_view_team(team_id));
drop policy if exists read_team_credits on public.team_credits;
create policy read_team_credits on public.team_credits for select using (private.can_view_team(team_id) or (private.is_reader() and private.team_published(team_id)));
drop policy if exists read_team_credit_history on public.team_credit_history;
create policy read_team_credit_history on public.team_credit_history for select using (private.can_view_team(team_id));
drop policy if exists read_team_project_sessions on public.team_project_sessions;
create policy read_team_project_sessions on public.team_project_sessions for select using (private.is_reader() and private.team_visible(team_id));
drop policy if exists read_team_final_files on public.team_final_files;
create policy read_team_final_files on public.team_final_files for select using (private.can_view_team(team_id) or (private.is_reader() and private.team_published(team_id)));
drop policy if exists read_posts on public.posts;
create policy read_posts on public.posts for select using (private.can_read_post(id));
drop policy if exists read_post_sessions on public.post_sessions;
create policy read_post_sessions on public.post_sessions for select using (private.can_read_post(post_id));
drop policy if exists read_post_files on public.post_files;
create policy read_post_files on public.post_files for select using (private.can_read_post(post_id));
drop policy if exists read_post_comments on public.post_comments;
create policy read_post_comments on public.post_comments for select using (private.can_read_post(post_id) and (deleted_at is null or private.is_staff()));
drop policy if exists read_post_reactions on public.post_reactions;
create policy read_post_reactions on public.post_reactions for select using (private.can_read_post(post_id));

-- [v2.2] 우수 작업물: 볼 수 있는 대상만 보인다 (삭제된 팀·숨김 프로젝트 등은 가려진다)
drop policy if exists read_featured_items on public.featured_items;
create policy read_featured_items on public.featured_items for select using (private.is_reader() and private.can_see_item(kind, item_id));

-- ---------------------------------------------------------------------
-- RLS: 읽기 정책만 둔다 (쓰기는 위 함수로만)
-- ---------------------------------------------------------------------
alter table public.settings          enable row level security;
alter table public.private_settings  enable row level security;
alter table public.profiles          enable row level security;
alter table public.member_emails     enable row level security;
alter table public.projects          enable row level security;
alter table public.versions          enable row level security;
alter table public.merge_requests    enable row level security;
alter table public.fork_requests     enable row level security;
alter table public.comments          enable row level security;
alter table public.contributors      enable row level security;
alter table public.notifications     enable row level security;
alter table public.reports           enable row level security;
alter table public.user_accounts     enable row level security;
alter table public.account_invites   enable row level security;
alter table public.roles             enable row level security;
alter table public.user_roles        enable row level security;
alter table public.role_permissions  enable row level security;
alter table public.owner_transfers   enable row level security;
alter table public.audit_logs        enable row level security;
alter table public.academic_years    enable row level security;
alter table public.sessions          enable row level security;
alter table public.membership_history enable row level security;
alter table public.project_sessions  enable row level security;
alter table public.system_status     enable row level security;

drop policy if exists read_settings on public.settings;
create policy read_settings on public.settings for select using (true);
drop policy if exists read_private_settings on public.private_settings;
create policy read_private_settings on public.private_settings for select using (private.is_staff());
drop policy if exists read_profiles on public.profiles;
create policy read_profiles on public.profiles for select using (id = private.my_member_id() or private.is_reader());
-- 이메일은 본인과 운영진만 (서버 관리자는 볼 수 없다)
drop policy if exists read_emails on public.member_emails;
create policy read_emails on public.member_emails for select using (user_id = private.my_member_id() or private.is_staff());
drop policy if exists read_projects on public.projects;
create policy read_projects on public.projects for select using (private.can_see(id));
drop policy if exists read_versions on public.versions;
create policy read_versions on public.versions for select using (private.can_read_code(project_id));
drop policy if exists read_mrs on public.merge_requests;
create policy read_mrs on public.merge_requests for select using (private.can_see(from_project_id) and private.can_see(to_project_id));
drop policy if exists read_frs on public.fork_requests;
create policy read_frs on public.fork_requests for select using (private.can_see(project_id));
drop policy if exists read_comments on public.comments;
create policy read_comments on public.comments for select
  using (exists (select 1 from versions v where v.id = version_id and private.can_read_code(v.project_id)));
drop policy if exists read_contributors on public.contributors;
create policy read_contributors on public.contributors for select using (private.can_see(project_id));
drop policy if exists read_notifications on public.notifications;
create policy read_notifications on public.notifications for select using (user_id = private.my_member_id());
drop policy if exists read_reports on public.reports;
create policy read_reports on public.reports for select using (private.is_staff());

-- [v2.0] 계정 연결(이메일 포함)은 본인 것과 관리자(또는 계정 연결을 위임받은 사람)만
drop policy if exists read_user_accounts on public.user_accounts;
create policy read_user_accounts on public.user_accounts for select
  using (auth_id = auth.uid() or member_id = private.my_member_id() or private.has_perm('accounts.link'));
drop policy if exists read_account_invites on public.account_invites;
create policy read_account_invites on public.account_invites for select using (private.has_perm('accounts.link'));
drop policy if exists read_roles on public.roles;
create policy read_roles on public.roles for select using (private.is_reader());
drop policy if exists read_user_roles on public.user_roles;
create policy read_user_roles on public.user_roles for select using (private.is_reader());
drop policy if exists read_role_permissions on public.role_permissions;
create policy read_role_permissions on public.role_permissions for select using (private.is_reader());
drop policy if exists read_owner_transfers on public.owner_transfers;
create policy read_owner_transfers on public.owner_transfers for select
  using (from_member = private.my_member_id() or to_member = private.my_member_id() or private.is_admin());
drop policy if exists read_audit_logs on public.audit_logs;
create policy read_audit_logs on public.audit_logs for select using (private.is_admin());
drop policy if exists read_academic_years on public.academic_years;
create policy read_academic_years on public.academic_years for select using (private.is_reader());
drop policy if exists read_sessions on public.sessions;
create policy read_sessions on public.sessions for select using (private.is_reader());
drop policy if exists read_membership_history on public.membership_history;
create policy read_membership_history on public.membership_history for select using (private.is_reader());
drop policy if exists read_project_sessions on public.project_sessions;
create policy read_project_sessions on public.project_sessions for select using (private.can_see(project_id));
-- system_status 는 정책이 없다 → 직접 읽기 불가. ping() / server_status() 로만 본다.
drop policy if exists read_system_status on public.system_status;

-- ---------------------------------------------------------------------
-- 권한(GRANT): 테이블은 읽기만, private 함수는 정책 판단용만 허용
-- ---------------------------------------------------------------------
-- 예전 부장 전용 도우미는 없앴다 (is_admin / require_admin 으로 대체)
drop function if exists private.is_teacher();
drop function if exists private.require_teacher();

grant usage on schema public to anon, authenticated;
grant select on all tables in schema public to anon, authenticated;
revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;
revoke select on public.system_status from anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

revoke all on schema private from public;
grant usage on schema private to anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.my_member_id(), private.my_status(), private.is_reader(), private.is_staff(), private.is_admin(),
  private.is_owner(), private.has_role(text), private.has_perm(text), private.can_see(uuid), private.can_read_code(uuid) to anon, authenticated;
-- [v2.1] 2단계 정책(Storage 포함)이 쓰는 판단 함수
grant execute on function private.is_team_member(uuid), private.is_team_leader(uuid), private.can_view_team(uuid), private.team_published(uuid),
  private.team_of_file(uuid), private.version_is_public_final(uuid), private.file_has_public_final(uuid), private.can_read_post(uuid),
  private.can_read_path(text), private.can_upload_path(text) to anon, authenticated;
-- [v2.2] 정책이 쓰는 판단 함수
grant execute on function private.team_is_deleted(uuid), private.team_visible(uuid), private.is_orphan_path(text), private.can_see_item(text, uuid) to anon, authenticated;

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
-- 연결 확인은 로그인 전에도 쓸 수 있어야 한다 (읽기 전용, 개인정보 없음)
grant execute on function public.ping() to anon;

-- 처음 설치하는 DB 에도 현재 운영 연도와 1~10차시가 생기게 한다
select public.ensure_academic_year();
