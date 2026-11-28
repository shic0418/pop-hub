-- =====================================================================
-- 예약 작업 (pg_cron): 매일 새벽 운영 연도를 확인한다
-- schema.sql 을 적용한 뒤, Supabase SQL Editor 에서 한 번만 실행하세요.
--
-- 사전 준비: Supabase 대시보드 → Database → Extensions 에서 pg_cron 을 켭니다.
-- 이 파일은 schema.sql 과 따로 둡니다 (pg_cron 이 없는 환경·테스트에서 schema.sql 이 실패하지 않도록).
--
-- ensure_academic_year() 는 여러 번 실행해도 같은 결과가 나옵니다(멱등).
-- 앱에 접속할 때·관리자가 수동으로 실행할 때와 어느 쪽이 먼저 실행돼도 상관없습니다.
-- =====================================================================
create extension if not exists pg_cron;

-- 이미 등록돼 있으면 지우고 다시 등록 (다시 실행해도 안전)
select cron.unschedule(jobid) from cron.job where jobname = 'pop-hub-ensure-academic-year';

-- 매일 00:05 한국 시간 = 전날 15:05 UTC
select cron.schedule('pop-hub-ensure-academic-year', '5 15 * * *', $$select public.ensure_academic_year()$$);

-- 확인: select * from cron.job;
-- 해제: select cron.unschedule('pop-hub-ensure-academic-year');
