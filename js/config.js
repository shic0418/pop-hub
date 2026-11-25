/* ===== 서버 연결 설정 =====
 * Supabase 프로젝트의 URL과 anon(public) 키를 넣으면 실제 Google 로그인 + 서버 저장으로 동작합니다.
 * 비워 두면 지금처럼 브라우저 안에서만 동작하는 데모 모드입니다.
 * (anon 키는 공개되어도 되는 키입니다. service_role 키는 절대 넣지 마세요.)
 * 설정 방법은 SETUP.md 를 보세요.
 */
window.APP_CONFIG = {
  supabaseUrl: 'https://idtenufpyrhieyrpwjfd.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlkdGVudWZweXJoaWV5cnB3amZkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUzNzExOTIsImV4cCI6MjExMDk0NzE5Mn0.E4I42wj7xTaizgYaE0o0fRdlxJ7IZd4DsXMwGaLSHic',
};
