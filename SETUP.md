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

-- 처음부터 "지도교사" 권한으로 가입될 이메일 (보통 지도교사 선생님)
-- 부원 명단(whitelist)에 있는 이메일은 승인 없이 바로 가입됩니다.
update private_settings
   set teacher_emails = array['teacher@ooo.hs.kr'],
       whitelist      = array['president@ooo.hs.kr']
 where id = 1;
```

> 지도교사가 첫 로그인을 하면 **관리 → 부원 관리**에서 동아리장·부장의 역할을 "운영진"으로 바꿔 줄 수 있습니다.
> 그 뒤로는 웹 화면의 **관리 → 설정**에서 명단·용량 제한을 바꿀 수 있습니다.
> 가입 보안의 핵심인 **학교 도메인과 가입 방식은 지도교사만** 바꿀 수 있습니다.

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

## 5. 알아 둘 점
- **코드 저장 위치**: 코드 파일은 DB의 `versions.files`(JSON)에 저장합니다. 기획서의 Supabase Storage 대신입니다.
  - 파일당 용량 제한(기본 2MB, 관리 화면에서 최대 10MB까지)과 프로젝트당 10MB 제한이 있습니다.
  - 버전마다 파일 전체를 저장하므로, 큰 프로젝트를 자주 고치면 무료 DB 용량(500MB)이 빨리 찹니다.
  - 무료 DB 용량 500MB면 동아리 규모에서 충분합니다.
- **무료 요금제 일시 정지**: Supabase 무료 프로젝트는 **7일 동안 아무 요청이 없으면 일시 정지**됩니다.
  - 방학 뒤에는 대시보드에서 **Restore**를 눌러 다시 켜세요. 데이터는 남아 있습니다.
- **새로고침**: 다른 부원이 바꾼 내용은 창으로 돌아올 때와 1분마다 자동으로 다시 불러옵니다. 아래쪽 "새로 불러오기"를 눌러도 됩니다.
- **가입 거절**: 거절하면 그 계정 기록이 지워집니다. 같은 사람이 나중에 다시 신청할 수 있습니다.
- **삭제·숨김 프로젝트의 공개 범위** (설계상 의도)
  - 삭제된 프로젝트는 제목·작성자만 트리에 남고, 코드는 운영진만 볼 수 있습니다.
  - 숨김 프로젝트는 트리에서 자리만 보이고, 제목·코드는 운영진만 볼 수 있습니다.
- **입력 제한**: 제목 100자, 설명 1000자, 댓글 2000자입니다. 같은 프로젝트는 처리되기 전까지 한 번만 신고할 수 있습니다.
- **아직 없는 것**: 사용자별 업로드 횟수 제한은 없습니다. 접속할 때 볼 수 있는 모든 버전을 한 번에 받습니다.
  - 동아리 규모(수십 명·수백 버전)에서는 문제가 없습니다.
  - 데이터가 아주 많아지면 "버전 이력은 열 때 받기"로 바꾸는 것을 권합니다.

## 6. 개발자용 테스트
- `tests/schema-test.mjs`: 서버 SQL의 권한 규칙 78가지를 로컬 Postgres(PGlite)로 검사합니다.
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
