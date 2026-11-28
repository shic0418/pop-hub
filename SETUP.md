# 서버 연결 설정 안내 (Supabase + 학교 Google 로그인)

`js/config.js`가 비어 있으면 **데모 모드**로 동작합니다. 이때 데이터는 이 브라우저에만 저장됩니다.
아래 순서대로 설정하면 **실제 서버 모드**가 됩니다. 실제 학교 Google 로그인을 쓰고, 부원 모두가 같은 데이터를 봅니다.

모든 권한 검사는 서버(Postgres)에서 다시 합니다.
- 브라우저는 테이블을 **읽기만** 할 수 있습니다. 볼 수 있는 범위는 행 단위 보안(RLS)이 정합니다.
- 모든 쓰기는 `supabase/schema.sql`의 서버 함수로만 합니다. 함수마다 역할·상태·소유자를 확인합니다.
- 학교 도메인은 **가입 순간 서버 트리거**가 검사합니다. 다른 도메인 계정은 계정 자체가 만들어지지 않습니다.

---

## 1. Supabase 프로젝트 만들기
1. <https://supabase.com>에 가입하고 **New project**를 만듭니다. 무료 요금제로 충분합니다.
   - 지역(Region)은 `Northeast Asia (Seoul)`을 추천합니다.
2. 프로젝트가 준비되면 왼쪽 메뉴에서 **SQL Editor**를 엽니다.
3. `supabase/schema.sql` 내용 전체를 붙여 넣고 **Run**을 누릅니다. 여러 번 실행해도 안전합니다.
4. 이어서 아래 SQL을 학교에 맞게 고쳐 실행합니다.

```sql
-- 동아리 이름과 학교 Google 계정 도메인
update settings set club_name = '우리 동아리', domain = 'ooo.hs.kr' where id = 1;

-- 처음부터 최고 권한으로 가입될 이메일 (최초 1명 = 최고 관리자+관리자, 이미 최고 관리자가 있으면 관리자)
-- 부원 명단(whitelist)에 있는 이메일은 승인 없이 바로 가입됩니다.
update private_settings
   set teacher_emails = array['teacher@ooo.hs.kr'],
       whitelist      = array['president@ooo.hs.kr']
 where id = 1;
```

> 위 `teacher_emails` 로 처음 로그인한 계정은 **최고 관리자 + 관리자**가 됩니다.
> 그 뒤 **관리 → 직책**에서 부장·차장·서버 관리자(·관리자)를 임명합니다. 예전의 "역할 드롭다운"은 없어졌습니다.
> 웹 화면의 **관리 → 설정**에서 명단·용량 제한을 바꿀 수 있고, 가입 보안의 핵심인 **학교 도메인과 가입 방식은 관리자만** 바꿀 수 있습니다.

### 권한 모델 (v2.0)
- 회원(`profiles`)과 로그인 계정(`user_accounts`)이 분리되어 있습니다. 회원 번호는 `POP-0001` 형식이며, 한 회원에 Google 계정을 여러 개 연결할 수 있습니다.
- 직책은 복수 보유 가능하고 권한은 합산됩니다. `owner`(최고 관리자), `admin`(관리자), `president`(부장), `vice`(차장), `server`(서버 관리자).
  - 관리자 = 최고 관리자 또는 관리자 / 운영진 = 관리자·최고 관리자·부장·차장 (서버 관리자는 운영진이 아님)
  - 부장·차장은 한 명씩(새로 임명하면 기존 보유자는 그 직책만 내려놓음), 관리자·서버 관리자는 여러 명.
  - 관리자 임명·해임과 최고 관리자 이양은 최고 관리자만. 이양은 제안 → 상대방 수락의 2단계이며 이전 최고 관리자는 관리자로 남습니다.
  - 관리자(최고 관리자 포함)가 0명이 되는 해임·졸업 처리는 서버가 거부합니다.
- 서버 관리자의 세부 권한(상세 상태·백업 상태·오류 기록)과 부장·차장에게 위임할 수 있는 권한(계정 연결)은 **관리 → 서버 관리자 권한**에서 켜고 끕니다. 서버 관리자는 이메일 등 개인정보와 관리 기능을 어떤 설정으로도 받을 수 없습니다.
- 직책·계정 연결·설정·삭제 등 주요 변경은 `audit_logs`(관리자만 열람, 수정·삭제 불가)에 남습니다.

> **주의:** 이 SQL을 실행하기 **전에** Google 로그인을 시험해 봤다면 그 계정에는 가입 정보가 없습니다.
> 이때는 **Authentication → Users**에서 그 계정을 지운 뒤 다시 로그인하세요.

## 2. Google 로그인 연결
1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트를 하나 만듭니다.
2. **API 및 서비스 → OAuth 동의 화면**을 설정합니다.
   - 학교 Google Workspace 계정으로 만든 프로젝트면 사용자 유형을 **내부(Internal)**로 고를 수 있습니다. 이렇게 하면 학교 계정만 로그인 화면을 쓸 수 있습니다.
   - 내부를 고를 수 없으면 **외부(External)**로 해도 됩니다. 도메인은 서버가 다시 막습니다.
3. **사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID**로 이동합니다.
   - 애플리케이션 유형은 **웹 애플리케이션**입니다.
   - **승인된 리디렉션 URI**에 다음을 넣습니다: `https://<프로젝트ID>.supabase.co/auth/v1/callback`
     - 이 주소는 Supabase의 **Authentication → Sign In / Providers → Google** 화면에도 나옵니다.
4. 발급된 **클라이언트 ID / 클라이언트 보안 비밀**을 Supabase의 **Authentication → Sign In / Providers → Google**에 붙여 넣고 켭니다.
5. 같은 화면에서 **Email 로그인을 끕니다.** (중요)
   - 서버 트리거도 Google로 확인된 계정만 받도록 한 번 더 막습니다.
   - 그래도 쓰지 않는 로그인 방식은 꺼 두는 것이 안전합니다.
6. **Authentication → URL Configuration**을 설정합니다.
   - **Site URL**: 실제 서비스 주소 (예: `https://club-code.pages.dev`)
   - **Redirect URLs**: 서비스 주소와 테스트용 `http://localhost:5173/**`를 추가합니다.

> 학교 Workspace 관리자가 외부 앱 접근을 막아 두었다면 로그인할 때 "관리자가 차단한 앱"이 뜰 수 있습니다.
> 이때는 학교 정보 담당 선생님께 이 OAuth 앱의 허용을 요청하세요.

## 3. 웹앱에 주소·키 넣기
Supabase의 **Project Settings → API**에서 두 값을 복사해 `js/config.js`에 넣습니다.

```js
window.APP_CONFIG = {
  supabaseUrl: 'https://<프로젝트ID>.supabase.co',
  supabaseAnonKey: '<anon public 키>',
};
```

- `anon` 키는 웹페이지에 공개돼도 되는 키입니다. 권한은 위의 RLS·서버 함수가 지킵니다.
- **`service_role` 키는 절대 넣지 마세요.** 모든 보안을 무시하는 관리자 키입니다.

## 4. 실행·배포
- 내 컴퓨터에서 시험할 때는 프로젝트 폴더에서 실행한 뒤 <http://localhost:5173>을 엽니다.
  ```
  python -m http.server 5173
  ```
- 부원들이 쓰게 하려면 폴더를 그대로 정적 호스팅에 올립니다. 빌드 과정은 없습니다.
  - 예: GitHub Pages, Cloudflare Pages, Netlify, Vercel
- 배포한 주소는 2-6단계의 **Site URL / Redirect URLs**에도 넣어야 합니다.

## 현재 배포 상태 (POP-Hub)
- 사이트 주소: https://shic0418.github.io/pop-hub/ (GitHub 저장소 `shic0418/pop-hub`의 `main` 브랜치를 GitHub Pages로 배포)
- 코드를 고친 뒤 `git push` 하면 1~2분 뒤 자동으로 반영됩니다. 화면이 예전 그대로면 Ctrl+Shift+R로 새로고침하세요.
- Supabase **Site URL**: 위 사이트 주소 / **Redirect URLs**: 사이트 주소와 `http://localhost:5173/**`
- Google 로그인 앱: **프로덕션(게시됨)** 상태. 홈페이지·개인정보처리방침(`privacy.html`)·승인된 도메인(`shic0418.github.io`) 등록됨

## 4-1. 기존 서버에 v2.0 스키마 적용하기 (마이그레이션)
이미 운영 중인 DB 에 새 `schema.sql` 을 적용할 때의 순서입니다. **되돌리기 어려우므로 반드시 백업부터 하세요.**

1. **백업 스키마로 복사** — SQL Editor 에서 아래를 실행합니다. 날짜는 오늘로 바꿉니다. (실행 전 Table Editor 로 public 테이블 목록을 확인하고, 있는 테이블은 모두 복사합니다.)
   ```sql
   create schema backup_20271201;
   create table backup_20271201.settings        as select * from public.settings;
   create table backup_20271201.private_settings as select * from public.private_settings;
   create table backup_20271201.profiles        as select * from public.profiles;
   create table backup_20271201.member_emails   as select * from public.member_emails;
   create table backup_20271201.projects        as select * from public.projects;
   create table backup_20271201.versions        as select * from public.versions;
   create table backup_20271201.merge_requests  as select * from public.merge_requests;
   create table backup_20271201.fork_requests   as select * from public.fork_requests;
   create table backup_20271201.comments        as select * from public.comments;
   create table backup_20271201.contributors    as select * from public.contributors;
   create table backup_20271201.notifications   as select * from public.notifications;
   create table backup_20271201.reports         as select * from public.reports;
   -- 인증 계정 목록도 함께 (복원할 때 회원·계정 대응 확인용)
   create table backup_20271201.auth_users as select id, email, created_at from auth.users;
   ```
2. **행 수 기록** — 적용 전 `select count(*) from public.profiles;` 등을 모든 테이블에 실행해 숫자를 적어 둡니다.
3. **`supabase/schema.sql` 전체를 실행**합니다. 여러 번 실행해도 안전합니다. 처음 한 번만 다음 이전이 일어납니다.
   - `profiles` 가 로그인 계정에 묶여 있던 외래 키 제거 (회원이 계정과 별개로 남음)
   - 기존 회원마다 같은 ID 로 `user_accounts` 1행 생성 → **기존 참조(프로젝트·버전·댓글 등)가 전부 그대로 유효**
   - 회원 번호 `POP-0001…` 를 가입 순서대로 부여
   - 직책 변환: 예전 `teacher` → **최고 관리자 + 관리자**, 예전 `admin`(운영진) → **차장**
   - 기존 프로젝트의 운영 연도 = 업로드 날짜 기준 자동 계산(2026 운영 연도). 차시는 추정하지 않으며 "차시 미분류"로 남습니다.
   - 현재 운영 연도와 1~10차시 생성, 활동 회원이 현재 연도 명단으로 복사됨
4. **검증** — 아래를 실행해 숫자가 1번에서 적은 것과 같은지, 문제 행이 0인지 확인합니다.
   ```sql
   select count(*) from public.profiles;                       -- 적용 전과 같아야 함
   select count(*) from public.user_accounts;                  -- 회원 수와 같아야 함
   select count(*) from public.profiles p where not exists (select 1 from public.user_accounts u where u.member_id = p.id);  -- 0
   select count(*) from public.projects where owner_id not in (select id from public.profiles);                             -- 0
   select m.name, array_agg(r.role) from public.profiles m left join public.user_roles r on r.member_id = m.id group by m.name; -- 직책 변환 결과
   select count(*) from public.projects where year is null;    -- 0
   select year, status from public.academic_years;
   ```
5. 웹페이지(`js/`)는 **스키마 적용 후에** 배포합니다. (새 화면은 새 테이블을 읽기 때문에 순서가 거꾸로면 오류가 납니다.)
6. 문제가 생기면 백업 스키마(`backup_YYYYMMDD`)의 표로 복구할 수 있습니다. 백업 스키마는 안정화된 뒤 `drop schema backup_… cascade;` 로 지웁니다.

## 4-2. 예약 작업과 정기 점검 (서버 휴면·백업)
- **운영 연도 자동 전환(pg_cron)**: `supabase/cron.sql` 을 SQL Editor 에서 한 번 실행합니다(먼저 Database → Extensions 에서 `pg_cron` 켜기). 매일 00:05 한국 시간에 `ensure_academic_year()` 를 실행하며, 여러 번 실행해도 안전합니다. 앱 접속 시·관리 → 연도의 "연도 확인·생성 실행"으로도 같은 함수가 실행됩니다.
- **GitHub Actions `keepalive`** (`.github/workflows/keepalive.yml`): 3일에 한 번 `ping()` 함수를 호출합니다. DB 를 한 번 읽을 뿐 데이터를 바꾸지 않으며, 결과는 상태 기록에 남습니다.
  - 저장소 **Settings → Secrets and variables → Actions → Variables** 에 `SUPABASE_URL`, `SUPABASE_ANON_KEY` 를 넣습니다(anon 키는 공개 키). 비워 두면 `js/config.js` 의 값을 읽습니다.
  - 무료 요금제 휴면 정책을 우회하는 용도로 해석될 여지가 있으니, 장기 운영이 확실하면 **Pro 요금제(월 $25, 정지 없음·일일 백업)** 를 권장합니다.
- **GitHub Actions `backup`** (`.github/workflows/backup.yml`): 매주 `pg_dump`(PostgreSQL 17) → gzip → `gpg` 암호화 → 비공개 아티팩트로 90일 보관 후, 결과를 `system_status` 에 기록합니다.
  - 저장소 **Secrets** 에 `SUPABASE_DB_URL`(Project Settings → Database → Connection string, 비밀번호 포함) 과 `BACKUP_PASSPHRASE`(암호화 비밀 문구)를 넣습니다. **웹페이지·저장소 파일에는 절대 적지 마세요.** 없으면 작업은 안내 메시지와 함께 건너뜁니다.
  - 비밀 문구를 잃으면 백업을 열 수 없으니 따로 안전하게 보관하세요. 복원 예: `gpg -d pop-hub-….sql.gz.gpg | gunzip | psql <DB 주소>` (자동 복원 버튼은 일부러 없습니다).
- 웹의 **서버 상태**(`#/status`, 푸터 링크): 누구나 "연결 확인"을 눌러 응답 여부를 볼 수 있습니다. 서버가 일시 정지된 경우 안내가 표시되며, 서버 관리자가 Supabase 대시보드에서 **Restore project** 를 눌러 다시 켭니다(웹에서는 깨울 수 없음).

## 4-3. 긴급 복구: 관리자 전원이 접근할 수 없을 때
관리자(최고 관리자 포함) 전원이 로그인할 수 없으면, Supabase 프로젝트 소유자가 SQL Editor 에서 다음을 실행합니다. 이 함수는 웹·API 에서 호출할 수 없습니다.
```sql
select private.emergency_grant_owner('POP-0001');   -- 해당 회원 번호의 회원을 활동 상태로 만들고 최고 관리자 + 관리자로 지정 (감사 기록에 남음)
```
회원 번호는 `select member_no, name from public.profiles;` 로 찾을 수 있습니다. 그 회원이 쓸 Google 계정이 연결돼 있어야 하므로, 새 계정이면 먼저 로그인해 가입한 뒤 `user_accounts` 연결을 확인하세요. 평소에는 관리자가 Google 계정을 2개 이상 연결해 두는 것을 권장합니다.

## 5. 알아 둘 점
- **코드 저장 위치**: 코드 파일은 DB의 `versions.files`(JSON)에 저장합니다. 기획서의 Supabase Storage 대신입니다.
  - 파일당 용량 제한(기본 2MB, 관리 화면에서 최대 10MB까지)과 프로젝트당 10MB 제한이 있습니다.
  - 버전마다 파일 전체를 저장하므로, 큰 프로젝트를 자주 고치면 무료 DB 용량(500MB)이 빨리 찹니다.
  - 무료 DB 용량 500MB면 동아리 규모에서 충분합니다.
- **무료 요금제 일시 정지**: Supabase 무료 프로젝트는 **7일 동안 아무 요청이 없으면 일시 정지**됩니다.
  - 방학 뒤에는 대시보드에서 **Restore**를 눌러 다시 켜세요. 데이터는 남아 있습니다. 정기 점검(`keepalive`)은 위 4-2 를 보세요.
- **새로고침**: 다른 부원이 바꾼 내용은 창으로 돌아올 때와 1분마다 자동으로 다시 불러옵니다. 아래쪽 "새로 불러오기"를 눌러도 됩니다.
- **가입 거절**: 거절하면 그 로그인 계정과 빈 대기 회원이 지워집니다. 같은 사람이 나중에 다시 신청할 수 있습니다.
- **계정이 바뀐 기존 회원(새 학년)**: **관리 → 계정 연결**에서 새 이메일을 미리 등록하면, 그 계정으로 첫 로그인할 때 새 회원을 만들지 않고 기존 회원(과 모든 기록)에 자동 연결됩니다. 먼저 로그인해 승인 대기가 된 경우에는 같은 화면에서 "기존 회원에 연결"을 누릅니다. 이름이 같다는 이유로 자동 병합하지는 않습니다.
- **삭제·숨김 프로젝트의 공개 범위** (설계상 의도)
  - 삭제된 프로젝트는 제목·작성자만 트리에 남고, 코드는 운영진만 볼 수 있습니다.
  - 숨김 프로젝트는 트리에서 자리만 보이고, 제목·코드는 운영진만 볼 수 있습니다.
- **입력 제한**: 제목 100자, 설명 1000자, 댓글 2000자입니다. 같은 프로젝트는 처리되기 전까지 한 번만 신고할 수 있습니다.
- **아직 없는 것**: 사용자별 업로드 횟수 제한은 없습니다. 접속할 때 볼 수 있는 모든 버전을 한 번에 받습니다.
  - 동아리 규모(수십 명·수백 버전)에서는 문제가 없습니다.
  - 데이터가 아주 많아지면 "버전 이력은 열 때 받기"로 바꾸는 것을 권합니다.

## 6. 개발자용 테스트
- `tests/schema-test.mjs`: 서버 SQL의 권한 규칙 278가지를 로컬 Postgres(PGlite)로 검사합니다. 직책·계정 연결·운영 연도·서버 상태, 옛 구조 DB 의 마이그레이션(두 번 적용해도 안전)까지 포함합니다.
  ```
  npm install @electric-sql/pglite
  node tests/schema-test.mjs
  ```
- `tests/remote-mock.html`: Supabase 없이 서버 모드 화면을 시험하는 페이지입니다.
  - 브라우저 안 Postgres에 같은 `schema.sql`을 올립니다.
  - `http://localhost:5173/tests/remote-mock.html`을 열고, 개발자 도구 콘솔에서 `mockLogin('a@school.hs.kr')` 등으로 로그인합니다.

## 7. Google 앱 "게시" (부원 전체가 로그인하려면 필수)
- 처음에는 Google 로그인 앱이 **테스트 중** 상태입니다. 이때는 Google Cloud의 **Google 인증 플랫폼 → 대상 → 테스트 사용자**에 등록한 사람만 로그인할 수 있습니다(최대 100명).
- 부원 전체가 쓰려면 **앱 게시**를 해야 합니다. 그 전에 **브랜딩** 페이지에 아래를 채워야 합니다.
  - 앱 홈페이지 URL: 배포한 사이트 주소
  - 개인정보처리방침 URL: 사이트 안의 개인정보처리방침 페이지
  - 승인된 도메인: 배포한 사이트의 도메인
- 이름·이메일만 요청하므로 Google의 별도 앱 심사는 필요 없습니다.

## 8. 참고: 가입 처리 순서
- Supabase는 Google 계정을 먼저 만든 뒤, "이메일 확인·로그인 방식"을 따로 채웁니다.
- 그래서 서버는 두 단계로 처리합니다.
  - 계정이 처음 만들어질 때: 학교 도메인만 검사합니다.
  - Google 확인이 끝난 뒤: 프로필을 만듭니다.
- 로그인 오류가 나면 Supabase 대시보드의 **Logs → Postgres** 에서 서버가 남긴 거절 사유를 볼 수 있습니다.
