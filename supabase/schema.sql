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

create or replace function public.update_settings(
  p_club_name text default null, p_domain text default null, p_signup_mode text default null,
  p_max_file_kb int default null, p_whitelist text[] default null
) returns void
language plpgsql security definer set search_path = public as $$
declare d text;
begin
  perform private.require_staff();
  if nullif(trim(p_club_name), '') is not null then update settings set club_name = trim(p_club_name) where id = 1; end if;
  if (p_domain is not null and p_domain is distinct from (select domain from settings where id = 1))
     or (p_signup_mode is not null and p_signup_mode is distinct from (select signup_mode from settings where id = 1))
     or (p_max_file_kb is not null and p_max_file_kb is distinct from (select max_file_kb from settings where id = 1)) then
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
  if p_whitelist is not null then
    update private_settings
       set whitelist = coalesce((select array_agg(distinct lower(trim(e))) from unnest(p_whitelist) e where trim(e) <> ''), '{}')
     where id = 1;
  end if;
  perform private.audit('settings.updated', null, jsonb_strip_nulls(jsonb_build_object(
    'club_name', nullif(trim(p_club_name), ''), 'domain', p_domain, 'signup_mode', p_signup_mode, 'max_file_kb', p_max_file_kb,
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
    if p_action = 'hide' then update projects set hidden = true where id = r.project_id; end if;
    update reports set status = 'resolved', action = p_action, resolved_by = u.id, resolved_at = clock_timestamp() where id = p_id;
    perform private.audit('report.resolved', null, jsonb_build_object('report', p_id, 'project', r.project_id, 'action', p_action));
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
      'audit_logs', (select count(*) from audit_logs)),
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

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
-- 연결 확인은 로그인 전에도 쓸 수 있어야 한다 (읽기 전용, 개인정보 없음)
grant execute on function public.ping() to anon;

-- 처음 설치하는 DB 에도 현재 운영 연도와 1~10차시가 생기게 한다
select public.ensure_academic_year();
