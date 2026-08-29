-- =============================================================================
-- 0003_auto_nudge.sql  --  자동 리마인더(자기 자신에게 보내는 알림)
--
-- 0001_init.sql, 0002_rls.sql 이 적용된 뒤에 실행하세요.
-- 반드시 `postgres` 역할로 실행하세요. 여기서 만드는 SECURITY DEFINER 함수들이
-- RLS를 우회하는 근거가 "소유자가 postgres"라는 사실입니다.
-- (특히 run_auto_nudges 는 nudges 에 INSERT 합니다. nudges 에는 INSERT 정책도
--  INSERT 권한도 없으므로(0002), 소유자가 postgres 가 아니면 매일 밤 21시에
--  42501 로 조용히 실패합니다.)
--
-- 이 파일이 하는 일:
--   1) profiles 에 auto_nudge_* 컬럼 3개 추가 (+ 5분 단위 CHECK, 부분 인덱스)
--   2) nudges.from_user_id 를 NULL 허용으로 바꾸고 source 와의 불변식을 CHECK 로 고정
--      (NULL = 시스템/자동. UI 는 사람이 아니라 "자동 알림" 으로 렌더링해야 합니다)
--   3) RPC: public.set_auto_nudge / public.get_auto_nudge   (본인 전용)
--      RPC: public.run_auto_nudges                          (스케줄러 전용)
--   4) 시간대 변경 시 "오늘"의 정의가 바뀌는 문제를 처리하는 트리거
--   5) 프라이버시 마감: profiles 컬럼 단위 SELECT, 자동 넛지 행은 본인만 조회
--   6) 맨 아래에 pg_cron + pg_net 설정 (주석 처리 -- 대시보드 작업이 먼저 필요)
--
-- 전체가 멱등(idempotent)입니다. 두 번 붙여넣어도 안전합니다.
--
-- 적용 순서는 의미가 있습니다:
--   컬럼 -> drop not null -> CHECK(NOT VALID) -> 과거 데이터 정리 -> VALIDATE
--   -> 함수 -> 함수별 revoke/grant -> 트리거 -> 정책 교체 -> 컬럼 GRANT 축소
--   -> notify pgrst
--   (CREATE FUNCTION 은 PUBLIC 에 EXECUTE 를 자동으로 줍니다. 그래서 revoke 는
--    반드시 create 뒤에 와야 합니다. "grant 안 함" 은 "revoke 함" 이 아닙니다.)
-- =============================================================================


-- =============================================================================
-- 1. profiles 컬럼 추가
--
-- 기본값 OFF 입니다. 옵트인이 아니면 기능이 아니라 사고입니다.
-- auto_nudge_at 은 반드시 `time` (= time without time zone) 입니다.
-- timetz 로 만들면 고정 UTC 오프셋이 저장되어 서머타임을 조용히 무시하고,
-- 사용자의 21:00 알림이 1년 중 절반은 20:00 또는 22:00 에 갑니다.
-- 해석 기준 시간대는 profiles.timezone 입니다.
-- =============================================================================
alter table public.profiles
  add column if not exists auto_nudge_enabled boolean not null default false;

alter table public.profiles
  add column if not exists auto_nudge_at time not null default '21:00';

alter table public.profiles
  add column if not exists auto_nudge_last_on date;

comment on column public.profiles.auto_nudge_enabled is
  '자동 리마인더 옵트인. 기본 false. 쓰기 경로는 public.set_auto_nudge() 뿐입니다 '
  '(0002 의 authenticated UPDATE 컬럼 목록에 없고, 0003 에서도 추가하지 않습니다).';
comment on column public.profiles.auto_nudge_at is
  '리마인더 발송 시각. profiles.timezone 기준 현지 시각입니다. 5분 단위만 허용 '
  '(스케줄러가 UTC */5 로 돌기 때문. 모든 IANA 오프셋은 15분의 배수라 위상차가 0입니다). '
  '★ timetz 로 바꾸지 마세요 ★ -- 서머타임이 무시됩니다.';
comment on column public.profiles.auto_nudge_last_on is
  '마지막으로 자동 리마인더를 보낸 "그 사용자의 현지 날짜". NULL = 보낸 적 없음. '
  '하루 1회 멱등성의 근거입니다. 스케줄러는 하루에 여러 번 돌고 재시도도 하지만 '
  '이 값 때문에 두 번째부터는 무동작이 됩니다.';

-- 5분 단위 + 초 0. 앱을 거치지 않고 SQL 편집기에서 직접 넣는 값도 막습니다.
-- date_part(text, time) 은 IMMUTABLE 이라 CHECK 안에 들어갈 수 있습니다.
-- (EXTRACT 는 함수가 아니라 문법이라 pg_catalog. 로 한정할 수 없습니다.)
do $do$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname  = 'profiles_auto_nudge_at_5min_chk'
  ) then
    alter table public.profiles
      add constraint profiles_auto_nudge_at_5min_chk
      check (
        (pg_catalog.date_part('minute', auto_nudge_at)::int % 5) = 0
        and pg_catalog.date_part('second', auto_nudge_at) = 0
      );
  end if;
end
$do$;

-- 스케줄러가 매 5분마다 "지금 보낼 사람 있나?" 를 묻습니다. 3~6명 규모에서는
-- 무의미하지만 공짜이고, 0001 의 부분 인덱스 습관과 일관됩니다.
create index if not exists profiles_auto_nudge_enabled_idx
  on public.profiles (auto_nudge_at)
  where auto_nudge_enabled;


-- =============================================================================
-- 2. nudges.from_user_id 를 NULL 허용으로
--
-- NULL = "시스템이 보냄" = 자동 리마인더.
--
-- ★ CHECK 을 곧바로 붙이면 안 됩니다 ★
-- 과거 배포에서 자동 넛지를 from_user_id 를 채워서 넣었을 수 있습니다
-- (lib/supabase/types.ts 의 nudges.Insert 주석이 그 사실을 문서화하고 있었습니다).
-- 그런 행이 한 줄이라도 있으면 ADD CONSTRAINT 가 23514 로 터지면서 이 마이그레이션
-- 전체가 롤백됩니다. 그래서 NOT VALID -> 데이터 정리 -> VALIDATE 순서입니다.
-- =============================================================================
alter table public.nudges alter column from_user_id drop not null;

do $do$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.nudges'::regclass
      and conname  = 'nudges_source_sender_chk'
  ) then
    alter table public.nudges
      add constraint nudges_source_sender_chk
      check (
        (source = 'auto'   and from_user_id is null) or
        (source = 'manual' and from_user_id is not null)
      ) not valid;
  end if;
end
$do$;

-- 과거 배포에서 from_user_id 를 채워 넣은 auto 행 정리.
update public.nudges
   set from_user_id = null
 where source = 'auto'
   and from_user_id is not null;

alter table public.nudges validate constraint nudges_source_sender_chk;

comment on column public.nudges.from_user_id is
  'NULL = 시스템(자동 알림). UI 는 사람이 아니라 "자동 알림" 으로 렌더링해야 합니다. '
  '★ ON DELETE SET NULL 로 바꾸지 마세요 ★ -- 수동 넛지가 '
  'source=''manual'' + from_user_id IS NULL 이 되어 nudges_source_sender_chk 를 '
  '위반하고, 그 순간 계정 삭제 자체가 23514 로 실패합니다. CASCADE 유지.';

comment on constraint nudges_source_sender_chk on public.nudges is
  '자동 넛지는 반드시 발신자 NULL, 수동 넛지는 반드시 발신자 있음. '
  '이 불변식이 send_nudge 의 쿼터 계산(from_user_id = uid 비교)과 UI 렌더링 분기의 근거입니다.';

-- 참고: nudges_no_self_nudge_chk (from_user_id <> to_user_id) 는 그대로 둡니다.
--   NULL <> to_user_id -> NULL -> CHECK 통과. 자동 리마인더는 설계상 자기 자신에게
--   가는 행이므로 이게 정확히 우리가 원하는 동작입니다.
-- 참고: nudges_from_user_created_idx 에 `where from_user_id is not null` 을 붙여
--   auto 행을 빼는 최적화가 가능하지만, 3~6명 규모에서 인덱스를 갈아엎을 이유가
--   없어 일부러 하지 않았습니다.


-- =============================================================================
-- 3. private.safe_local_now(text)  --  절대 예외를 던지지 않는 현지 시각
--
-- 0001 의 current_user_local_date() 가 쓰는 이중 방어(존재 검증 + EXCEPTION 폴백)를
-- 그대로 함수로 뽑았습니다.
--
-- ★ 왜 이게 필요한가 ★
-- (now() at time zone p.timezone) 을 집합 술어에 그냥 쓰면, 잘못된 시간대가 든 행이
-- 딱 하나만 있어도 22023 으로 SELECT 전체가 죽습니다. 즉 "아무도" 알림을 못 받고,
-- 에러는 어디에도 안 보입니다.
-- 0001 의 검증 트리거가 있으니 괜찮다? 아닙니다. 트리거는 `insert or update of
-- timezone` 에서만 돕니다. 이미 저장된 행은 다시 검증되지 않는데, tzdata 는 마이너
-- 업그레이드에서 바뀝니다 (US/Pacific-New 는 삭제됐고 Europe/Kiev 는 이름이 바뀌었습니다).
--
-- 반환값 NULL = "이 사람은 이번 배치에서 건너뛰세요" 입니다.
-- =============================================================================
create or replace function private.safe_local_now(p_tz text)
returns timestamp
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_tz text := p_tz;
begin
  if v_tz is null
     or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_tz)
  then
    v_tz := 'Asia/Seoul';
  end if;

  return (pg_catalog.now() at time zone v_tz);
exception
  when others then
    -- 한 사람의 잘못된 시간대가 배치 전체를 죽이지 않게 합니다.
    raise warning 'safe_local_now 폴백 실패 (tz=%): % (%)', p_tz, sqlerrm, sqlstate;
    return null;
end;
$fn$;

alter function private.safe_local_now(text) owner to postgres;
revoke all on function private.safe_local_now(text) from public, anon, authenticated;

comment on function private.safe_local_now(text) is
  '주어진 IANA 시간대의 현재 현지 시각(timestamp without time zone). '
  '알 수 없는 시간대는 Asia/Seoul 폴백, 그래도 실패하면 NULL. 절대 예외를 던지지 않습니다. '
  '자동 리마인더 관련 모든 시간대 계산은 반드시 이 함수를 거칩니다.';


-- =============================================================================
-- 4. private.auto_nudge_due_exists()  --  "지금 보낼 사람이 한 명이라도 있나?"
--
-- pg_cron 틱이 HTTP 를 쏘기 전에 물어보는 값입니다. 하루 288번 도는 틱 중
-- 284번쯤은 여기서 false 를 받고 아무것도 안 합니다.
-- =============================================================================
create or replace function private.auto_nudge_due_exists()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
    from public.profiles p
    cross join lateral (select private.safe_local_now(p.timezone) as lt) l
    where p.auto_nudge_enabled
      and l.lt is not null
      and l.lt::time >= p.auto_nudge_at
      and (p.auto_nudge_last_on is null or p.auto_nudge_last_on < l.lt::date)
      and exists (
        select 1 from public.tasks t
        where t.user_id   = p.id
          and t.task_date = l.lt::date
          and t.done_at is null
      )
  );
$fn$;

alter function private.auto_nudge_due_exists() owner to postgres;
revoke all on function private.auto_nudge_due_exists() from public, anon, authenticated;
grant execute on function private.auto_nudge_due_exists() to service_role;

comment on function private.auto_nudge_due_exists() is
  '스케줄러 틱용 값싼 술어. run_auto_nudges 와 동일한 조건이지만 아무것도 쓰지 않습니다. '
  '이게 false 면 pg_cron 틱은 HTTP 요청조차 만들지 않습니다.';


-- =============================================================================
-- 5. public.set_auto_nudge(boolean, time)  --  본인 설정 저장
--
-- ★ 불변식 ★ 이 함수는 사용자를 지정하는 파라미터를 받지 않습니다. 대상은 항상
-- auth.uid() 입니다. "관리자 편의" 같은 이유로 p_user_id uuid default null 을
-- 추가하는 순간, 이 RPC 는 남에게 알림을 예약하는 도구가 됩니다. 절대 추가 금지.
-- =============================================================================
create or replace function public.set_auto_nudge(
  p_enabled boolean,
  p_at      time
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_tz    text;
  v_lt    timestamp;
  v_last  date;
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;

  if p_enabled is null then
    raise exception '알림 사용 여부가 비어 있습니다.' using errcode = '22023';
  end if;

  -- 5분 단위 검증. EXTRACT 는 문법이라 search_path='' 에서 한정할 수 없으므로
  -- 같은 일을 하는 IMMUTABLE 함수 date_part 를 씁니다.
  -- 초 검사가 따로 필요합니다: time 은 마이크로초를 담을 수 있어서
  -- '21:00:30.5' 는 분(minute)이 0 이라 5의 배수 검사만으로는 통과해 버립니다.
  if p_at is null
     or pg_catalog.date_part('second', p_at) <> 0
     or (pg_catalog.date_part('minute', p_at)::int % 5) <> 0
  then
    raise exception '알림 시각은 5분 단위여야 합니다 (예: 21:00, 21:05).'
      using errcode = '22023';
  end if;

  select p.timezone into v_tz from public.profiles p where p.id = v_uid;
  v_lt := private.safe_local_now(v_tz);
  if v_lt is null then
    v_lt := (pg_catalog.now() at time zone 'Asia/Seoul');
  end if;

  -- ★ 이 한 줄이 세 가지 버그를 동시에 막습니다 ★
  --   (1) 밤 22시에 처음 켜면(기본값 21:00) 토글을 누르는 순간 알림이 날아옵니다.
  --   (2) 오늘 09:05 에 이미 받은 사람이 10:00 에 09:00 -> 09:30 으로 바꾸면
  --       55분 만에 두 번째 알림이 갑니다. (last_on 을 그냥 NULL 로 비우는
  --       "당연해 보이는" 수정이 정확히 이 버그를 만듭니다.)
  --   (3) 오늘 09:05 에 받은 사람이 15:00 에 21:00 으로 바꾸면 오늘 저녁을 통째로
  --       잃습니다.
  -- 규칙: "그 시각이 오늘 이미 지났으면 오늘은 처리된 것으로 찍고, 아직 안 왔으면 비운다."
  v_last := case when p_at <= v_lt::time then v_lt::date else null end;

  update public.profiles
     set auto_nudge_enabled = p_enabled,
         auto_nudge_at      = p_at,
         auto_nudge_last_on = v_last
   where id = v_uid;

  -- 0001 의 handle_new_user() 는 모든 예외를 삼키므로 프로필 행이 없는 계정이
  -- 정상적으로 존재할 수 있습니다(0002 의 profiles_insert_self 가 안전밸브).
  -- 여기서 조용히 0행 UPDATE 로 성공을 반환하면, 토글이 켜졌다가 새로고침 때
  -- 혼자 꺼지는 유령 버그가 됩니다.
  if not found then
    raise exception '프로필을 찾을 수 없습니다. 앱을 새로고침한 뒤 다시 시도해 주세요.'
      using errcode = 'P0002';
  end if;
end;
$fn$;

alter function public.set_auto_nudge(boolean, time) owner to postgres;
revoke all on function public.set_auto_nudge(boolean, time) from public, anon;
grant execute on function public.set_auto_nudge(boolean, time) to authenticated;

comment on function public.set_auto_nudge(boolean, time) is
  '자동 리마인더 설정 저장. 대상은 언제나 auth.uid() -- 사용자 지정 파라미터가 없습니다. '
  '★ p_user_id 같은 인자를 절대 추가하지 마세요 ★ 그 순간 남에게 알림을 예약할 수 있게 됩니다. '
  'p_at 은 5분 단위(초=0)여야 하며, 위반 시 22023. 프로필 행이 없으면 P0002. '
  '클라이언트 주의: 이 RPC 성공은 "알림이 도착한다" 를 보장하지 않습니다. iOS 는 홈 화면에 '
  '설치된 PWA 안에서만 웹 푸시가 동작하므로, 토글은 실제 PushSubscription 존재 여부로 '
  '게이팅해야 합니다.';


-- =============================================================================
-- 6. public.get_auto_nudge()  --  본인 설정 읽기
--
-- 반환 컬럼 이름이 `at` 이 아니라 `at_local` 입니다. AT 은 비예약 키워드라
-- `at time` 이 문법적으로는 통과하지만, AT TIME ZONE 문법과 토큰 하나 차이라
-- 읽는 사람마다 버그로 오해합니다. 피하는 데 드는 비용이 0 입니다.
-- =============================================================================
create or replace function public.get_auto_nudge()
returns table (enabled boolean, at_local time, last_on date)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;

  -- LEFT JOIN 이라 프로필 행이 아직 없어도 항상 정확히 1행을 돌려줍니다.
  -- (클라이언트가 빈 배열 처리 분기를 따로 만들지 않아도 되게.)
  return query
  select coalesce(p.auto_nudge_enabled, false),
         coalesce(p.auto_nudge_at, '21:00'::time),
         p.auto_nudge_last_on
  from (select v_uid as uid) c
  left join public.profiles p on p.id = c.uid;
end;
$fn$;

alter function public.get_auto_nudge() owner to postgres;
revoke all on function public.get_auto_nudge() from public, anon;
grant execute on function public.get_auto_nudge() to authenticated;

comment on function public.get_auto_nudge() is
  '본인의 자동 리마인더 설정을 항상 1행으로 반환. 대상은 auth.uid() 고정 -- 인자가 없습니다. '
  'auto_nudge_* 컬럼은 0003 에서 authenticated 의 SELECT 대상에서 빠졌으므로 '
  '이 RPC 가 유일한 읽기 경로입니다.';


-- =============================================================================
-- 7. public.run_auto_nudges()  --  스케줄러 전용 배치
--
-- ★★ 이 함수는 절대 authenticated / anon 에게 EXECUTE 를 주면 안 됩니다 ★★
-- 반환값이 (사용자 id, 남은 할 일 수) 목록입니다. 노출되는 순간 브라우저에서
-- publishable anon key 만으로 전체 사용자 명단과 활동 메타데이터가 새고,
-- 덤으로 모두의 알림을 원하는 때에 강제 발송할 수 있게 됩니다.
--
-- 그런데도 private 이 아니라 public 에 있는 이유: PostgREST 는 노출된 스키마만
-- 호출할 수 있고, web-push 팬아웃을 하는 Node 라우트가 이 함수를 PostgREST 로
-- 불러야 하기 때문입니다. 그래서 "권한 회수 + 런타임 가드" 이중으로 막습니다.
--
-- 전달 보장은 at-most-once 입니다. nudges 행 INSERT 와 last_on UPDATE 는 이
-- 함수 안에서 커밋되지만, 실제 web-push 발송은 그 뒤 Node 에서 일어납니다.
-- 그 사이에 라우트가 죽으면 그날 그 사람의 알림은 사라지고, last_on 가드가
-- 재시도를 정확히 거부합니다. 리마인더에는 이게 맞는 선택입니다
-- (재시도해서 두 번 울리는 것보다 한 번 조용한 게 낫습니다).
-- "스케줄러가 여러 번 돈다" 는 at-least-once 약속이 아니라, 배치가 여러 번 돌아도
-- 안전하다는 뜻입니다.
-- =============================================================================
create or replace function public.run_auto_nudges()
returns table (out_to_user_id uuid, out_group_id uuid, out_pending_count int)
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_uid   uuid;
  v_tz    text;
  v_lt    timestamp;
  v_today date;
  v_now_t time;
  v_gid   uuid;
  v_cnt   int;
begin
  -- 런타임 가드. GRANT 가 실수로 되돌아가도(예: 깨끗한 DB 에 CREATE 로 다시 만들면
  -- PUBLIC 에 EXECUTE 가 재부여됩니다) 여기서 닫힙니다.
  -- service_role / cron 세션에는 auth.uid() 가 없습니다 -- 0001 의
  -- private.tasks_guard_group_move (501~503행) 가 이미 같은 사실에 의존합니다.
  if (select auth.uid()) is not null then
    raise exception '이 함수는 서버 스케줄러 전용입니다.' using errcode = '42501';
  end if;

  -- 스케줄러 두 런이 겹쳐도 이중 발송이 없도록 배치 전체를 직렬화합니다.
  -- ★ 반드시 (int4, int4) 2인자 형태 ★ -- send_nudge 는 1인자 bigint 형태를 씁니다
  -- (0001:1163). 두 키 공간은 잠금 태그의 objsubid (1 vs 2) 로 구조적으로 분리되어
  -- 있어서, 확률이 아니라 정의상 충돌하지 않습니다. 이 프로젝트의 2인자 네임스페이스는
  -- (778899, N) 으로 예약합니다. 다음에 잠금을 추가할 사람은 N 을 다르게 쓰세요.
  perform pg_catalog.pg_advisory_xact_lock(778899, 1);

  for v_uid, v_tz in
    select p.id, p.timezone
    from public.profiles p
    where p.auto_nudge_enabled
    order by p.id
  loop
    -- 잘못된 시간대 한 줄이 배치 전체를 죽이지 않게. 0001 의 이중 방어와 동일합니다.
    v_lt := private.safe_local_now(v_tz);
    if v_lt is null then
      raise warning 'run_auto_nudges: 시간대 계산 실패로 건너뜀 (user %, tz=%)', v_uid, v_tz;
      continue;
    end if;

    v_today := v_lt::date;
    v_now_t := v_lt::time;

    -- 발송 시각 도달 + 그 사람의 현지 날짜 기준 하루 1회. 여기가 멱등성의 근거입니다.
    perform 1
    from public.profiles p
    where p.id = v_uid
      and v_now_t >= p.auto_nudge_at
      and (p.auto_nudge_last_on is null or p.auto_nudge_last_on < v_today);
    if not found then
      continue;
    end if;

    -- nudges.group_id 는 NOT NULL 입니다. 미완료 할 일에서 그룹을 끌어옵니다
    -- (tasks.group_id 도 NOT NULL 이라 항상 실재하는 그룹입니다).
    -- 여러 그룹에 걸쳐 있으면 결정적으로 하나만 고릅니다 -- 사람당 하루 한 행이어야
    -- last_on 하나로 멱등성이 성립합니다.
    -- 주의: out_pending_count 는 "고른 그룹 안의" 미완료 개수입니다.
    -- 인덱스 주의: 0001 의 tasks_group_date_open_idx 는 group_id 로 시작하는데
    -- 여기서는 user_id + task_date 로 거릅니다. 그래서 이 질의는 그 인덱스를
    -- 타지 않고 tasks_user_date_idx 로 떨어져 done_at 을 재검사합니다.
    -- 0001:541 의 "자동 넛지 cron" 주석이 이 질의를 커버한다고 오해하지 마세요.
    -- 3~6명 규모에서는 아무 문제 없습니다.
    v_gid := null;
    v_cnt := 0;
    select t.group_id, count(*)::int
      into v_gid, v_cnt
    from public.tasks t
    where t.user_id   = v_uid
      and t.task_date = v_today
      and t.done_at is null
    group by t.group_id
    order by count(*) desc, t.group_id
    limit 1;

    -- 미완료 할 일이 없거나 그룹이 없으면 조용히 건너뜁니다. last_on 도 건드리지
    -- 않습니다 -- 오후에 할 일을 추가하면 오늘 저녁 알림을 정상적으로 받습니다.
    if v_gid is null then
      continue;
    end if;

    insert into public.nudges (from_user_id, to_user_id, group_id, task_id, message, source)
    values (null, v_uid, v_gid, null, null, 'auto');

    -- 같은 현지 날짜에 다시 돌면 위 `perform 1` 에서 걸러져 무동작이 됩니다.
    update public.profiles
       set auto_nudge_last_on = v_today
     where id = v_uid;

    out_to_user_id    := v_uid;
    out_group_id      := v_gid;
    out_pending_count := v_cnt;
    return next;
  end loop;
end;
$fn$;

alter function public.run_auto_nudges() owner to postgres;
revoke all on function public.run_auto_nudges() from public, anon, authenticated;
grant execute on function public.run_auto_nudges() to service_role;

comment on function public.run_auto_nudges() is
  '자동 리마인더 배치. 스케줄러(service_role) 전용이며 authenticated/anon 에는 EXECUTE 가 '
  '없습니다 -- 반환값이 사용자 명단 + 활동 메타데이터라 노출되면 곧바로 정보 유출입니다. '
  'auth.uid() 가 있으면 42501 로 즉시 거부하는 런타임 가드가 추가로 있습니다. '
  '사용자의 현지 날짜 기준 하루 1회 멱등. pg_advisory_xact_lock(778899,1) 로 동시 실행 직렬화. '
  '수동 넛지 쿼터(시간당 1 / 하루 3)를 쓰지도, 그 쿼터에 막히지도 않습니다 -- 별개 채널입니다. '
  '전달 보장은 at-most-once. '
  '알려진 경합: advisory lock 은 스케줄러 런끼리만 직렬화하고 사용자의 profiles UPDATE 와는 '
  '겹칠 수 있습니다. 시간대를 바꾸는 바로 그 순간 배치가 돌면 그날 알림이 한 번 더 갈 수 있습니다. '
  '행 잠금을 걸 만한 가치가 없어 그대로 둡니다.';


-- =============================================================================
-- 8. send_nudge 재정의  --  자동/수동 채널 분리를 문서가 아니라 코드로 고정
--
-- 원래도 동작은 맞았습니다. from_user_id = v_uid 비교에서 NULL = uuid 는 NULL 이라
-- auto 행이 카운트에 안 잡히기 때문입니다. 하지만 그건 3값 논리에 기댄 우연이고,
-- 누군가 `is not distinct from` 으로 "고치는" 순간 두 채널이 조용히 합쳐집니다.
-- source = 'manual' 을 명시해서 의도를 코드에 박습니다.
--
-- 나머지 본문은 0001 과 동일합니다.
-- =============================================================================
create or replace function public.send_nudge(
  p_to_user_id uuid,
  p_group_id   uuid,
  p_task_id    uuid default null,
  p_message    text default null
)
returns table (ok boolean, reason text, nudge_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_uid     uuid := (select auth.uid());
  v_msg     text;
  v_task    uuid;
  v_hour    int;
  v_day     int;
  v_new_id  uuid;
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;

  if p_to_user_id is null or p_group_id is null then
    return query select false, 'not_member'::text, null::uuid;
    return;
  end if;

  if p_to_user_id = v_uid then
    return query select false, 'self_nudge'::text, null::uuid;
    return;
  end if;

  if not exists (
    select 1 from public.group_members me
    where me.group_id = p_group_id and me.user_id = v_uid
  ) or not exists (
    select 1 from public.group_members them
    where them.group_id = p_group_id and them.user_id = p_to_user_id
  ) then
    return query select false, 'not_member'::text, null::uuid;
    return;
  end if;

  -- ===== 원자성 경계 시작 =====
  -- (from, to) 쌍마다 하나의 잠금. 1인자 bigint 형태 -- run_auto_nudges 의
  -- 2인자 (int4,int4) 형태와 키 공간이 구조적으로 분리됩니다.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_uid::text || '>' || p_to_user_id::text, 0::bigint)
  );

  select count(*)::int into v_hour
  from public.nudges n
  where n.from_user_id = v_uid
    and n.to_user_id   = p_to_user_id
    and n.source       = 'manual'   -- [0003] 자동 알림은 별개 채널. 쿼터를 쓰지도, 막지도 않습니다.
    and n.created_at   > now() - interval '1 hour';

  if v_hour >= 1 then
    return query select false, 'rate_limited_hour'::text, null::uuid;
    return;
  end if;

  select count(*)::int into v_day
  from public.nudges n
  where n.from_user_id = v_uid
    and n.to_user_id   = p_to_user_id
    and n.source       = 'manual'   -- [0003] 위와 동일.
    and n.created_at   > now() - interval '1 day';

  if v_day >= 3 then
    return query select false, 'rate_limited_day'::text, null::uuid;
    return;
  end if;

  v_task := null;
  if p_task_id is not null then
    select t.id into v_task
    from public.tasks t
    where t.id       = p_task_id
      and t.group_id = p_group_id
      and t.user_id  = p_to_user_id;
  end if;

  v_msg := nullif(left(btrim(coalesce(p_message, '')), 200), '');

  -- v_uid 는 위 가드 때문에 NULL 일 수 없으므로 nudges_source_sender_chk 를 만족합니다.
  insert into public.nudges (from_user_id, to_user_id, group_id, task_id, message, source)
  values (v_uid, p_to_user_id, p_group_id, v_task, v_msg, 'manual')
  returning id into v_new_id;
  -- ===== 원자성 경계 끝 =====

  return query select true, null::text, v_new_id;
end;
$fn$;

alter function public.send_nudge(uuid, uuid, uuid, text) owner to postgres;
revoke all on function public.send_nudge(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.send_nudge(uuid, uuid, uuid, text) to authenticated;

comment on function public.send_nudge(uuid, uuid, uuid, text) is
  '수동 넛지 발송(source=''manual''). from_user_id 는 항상 auth.uid(). '
  '대상 1명당 시간당 1회 / 하루 3회를 pg_advisory_xact_lock 으로 원자적으로 강제합니다. '
  '[0003] 쿼터 계산에 source = ''manual'' 을 명시했습니다 -- 자동 리마인더는 별개 채널이라 '
  '수동 쿼터를 소모하지도, 수동 넛지를 막지도 않습니다. '
  '거절 시 예외 대신 ok=false 와 reason(not_member|rate_limited_hour|rate_limited_day|self_nudge) 반환.';


-- =============================================================================
-- 9. 시간대 변경 트리거
--
-- 시간대가 바뀌면 "오늘" 의 정의가 바뀝니다. 그런데 이 경로는 set_auto_nudge 를
-- 거치지 않습니다 -- 0002 의 컬럼 GRANT 가 timezone 을 평범한 UPDATE 로 허용하기
-- 때문입니다. 그래서 트리거가 필요합니다.
--
-- 안 하면: 서울(21:00 발송 완료, last_on=8/30)에서 LA 로 이동해 시간대를 바꾸면,
--   UTC 8/31 04:05 = LA 8/30 21:05 이라 현지 날짜가 아직 8/30 입니다.
--   가드가 `8/30 < 8/30` 으로 막아서 약 40시간 동안 아무 알림도 안 갑니다.
-- 그냥 NULL 로 비우면: 같은 저녁에 두 번 갑니다.
-- 그래서 set_auto_nudge 와 정확히 같은 규칙을 씁니다.
-- =============================================================================
create or replace function private.profiles_auto_nudge_tz_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_lt timestamp;
begin
  if new.timezone is not distinct from old.timezone then
    return new;
  end if;

  v_lt := private.safe_local_now(new.timezone);
  if v_lt is null then
    return new;   -- 계산 불가면 손대지 않습니다. 시간대 변경 자체는 통과시킵니다.
  end if;

  if new.auto_nudge_at <= v_lt::time then
    new.auto_nudge_last_on := v_lt::date;
  else
    new.auto_nudge_last_on := null;
  end if;

  return new;
exception when others then
  raise warning 'profiles_auto_nudge_tz_change 실패 (user %): % (%)', new.id, sqlerrm, sqlstate;
  return new;   -- 시간대 변경 자체를 막지 않습니다.
end;
$fn$;

alter function private.profiles_auto_nudge_tz_change() owner to postgres;
revoke all on function private.profiles_auto_nudge_tz_change() from public, anon, authenticated;

-- ★ 트리거 이름 주의 ★
-- 같은 테이블/같은 이벤트의 트리거는 이름 알파벳 순으로 실행됩니다. 이 트리거는
-- new.timezone 을 읽으므로 반드시 0001 의 profiles_validate_timezone (btrim 정규화 +
-- Asia/Seoul 폴백 + 실존 검증) 뒤에 와야 합니다. 'profiles_z...' 가 'profiles_v...'
-- 뒤로 정렬되므로 이름을 바꾸지 마세요.
drop trigger if exists profiles_z_auto_nudge_tz_change on public.profiles;
create trigger profiles_z_auto_nudge_tz_change
  before update of timezone on public.profiles
  for each row
  execute function private.profiles_auto_nudge_tz_change();

comment on function private.profiles_auto_nudge_tz_change() is
  '시간대 변경 시 auto_nudge_last_on 을 재계산합니다 (set_auto_nudge 와 동일한 규칙). '
  '★ 이름 앞의 z 는 실행 순서용입니다 ★ profiles_validate_timezone 보다 뒤에 돌아야 '
  '검증/정규화된 timezone 을 읽습니다. '
  '참고: 컬럼 단위 UPDATE GRANT 는 문장의 SET 목록을 제한할 뿐 BEFORE 트리거가 NEW 에 '
  '무엇을 대입하는지는 제한하지 않습니다. 그래서 authenticated 에게 권한이 없는 '
  'auto_nudge_last_on 을 여기서 정당하게 쓸 수 있습니다.';


-- =============================================================================
-- 10. 정책 교체 -- 자동 알림 행은 본인에게만 보입니다
--
-- 0002 의 nudges SELECT 정책은 group_id 만 봅니다. 자동 리마인더 행은 그대로 두면
-- 그룹 전원에게 보이고, 그 순간
--   * 행의 존재 자체     -> 그 사람이 자동 알림을 켰다는 사실
--   * nudges.created_at -> 그 사람의 auto_nudge_at (거의 그대로)
-- 이 새어 나갑니다. 아래 11번에서 컬럼 단위로 막는 바로 그 두 가지입니다.
-- 게다가 nudges 는 supabase_realtime publication 에 들어 있어(0001:1246) 조회를
-- 기다릴 것도 없이 실시간으로 방송됩니다.
--
-- 수동 넛지 피드는 그대로입니다.
-- =============================================================================
drop policy if exists nudges_select_group_members on public.nudges;
create policy nudges_select_group_members
  on public.nudges
  for select
  to authenticated
  using (
    group_id in (select private.current_user_group_ids())
    and (source <> 'auto' or to_user_id = (select auth.uid()))
  );


-- =============================================================================
-- 11. profiles SELECT 를 컬럼 단위로 축소
--
-- 0002 는 profiles 에 테이블 전체 SELECT 를 줍니다(groups 와 달리 컬럼 목록이
-- 없습니다). 그래서 방금 추가한 auto_nudge_* 세 컬럼이 자동으로 그 권한에
-- 딸려 들어가고, profiles_select_self_or_groupmate 정책 덕분에 그룹 동료 전원이
-- "쟤가 리마인더를 쓰는지, 몇 시로 맞췄는지, 마지막으로 언제 받았는지" 를 읽습니다.
--
-- ★ 클라이언트 주의 ★ groups.invite_code 때와 똑같은 함정입니다.
--   .from('profiles').select('*')  ->  이제 실패합니다.
--   .from('profiles').select('id, display_name, avatar_emoji, timezone, created_at')  ->  정상.
-- auto_nudge_* 는 public.get_auto_nudge() 로만 읽습니다.
--
-- UPDATE GRANT 는 손대지 않습니다. 0002 의
--   grant update (display_name, avatar_emoji, timezone)
-- 이 이미 새 컬럼을 제외하고 있어서, set_auto_nudge() 가 구조적으로 유일한
-- 쓰기 경로입니다. ★ 여기에 auto_nudge_* 를 추가하지 마세요. ★
-- =============================================================================
revoke select on public.profiles from authenticated;
grant select (id, display_name, avatar_emoji, timezone, created_at)
  on public.profiles to authenticated;

-- service_role 은 테이블 단위 ALL 을 이미 갖고 있어(0002) 새 컬럼도 자동 포함입니다.
-- 명시적으로 한 번 더 적어 둡니다.
grant all on public.profiles to service_role;
grant all on public.nudges   to service_role;


-- =============================================================================
-- 12. pg_cron + pg_net 설정  ★ 전부 주석 처리되어 있습니다 ★
--
-- ───────────────────────────────────────────────────────────────────────────
-- 이 파일을 그냥 붙여넣어도 스케줄러는 켜지지 않습니다. 확장(extension)을 먼저
-- 대시보드에서 켜야 하고, Vault 에 비밀값 두 개를 넣어야 합니다. 확장이 없는
-- 상태에서 `revoke ... on schema net` 같은 문장이 실행되면 에러가 나면서 위쪽
-- 작업까지 전부 롤백되기 때문에, 일부러 주석으로 두었습니다.
--
-- 왜 Vercel Cron 이 아닌가: Hobby 플랜은 크론이 하루 1회 + 오차 ±59분이고,
-- `*/5 * * * *` 같은 식은 아예 배포가 실패합니다. "21시에 알려줘" 를 지킬 수 없습니다.
-- 왜 GitHub Actions 가 아닌가: 5분 단위는 되지만 부하가 높으면 예약된 실행이
-- 그냥 폐기(dropped)됩니다. 벤더와 시크릿 저장소가 하나 더 늘기도 합니다.
--
-- 동작 흐름:
--   pg_cron (UTC, 5분마다)
--     -> private.dispatch_auto_nudges()
--          -> 보낼 사람 없으면 여기서 끝 (하루 288틱 중 ~284틱)
--          -> 있으면 pg_net 으로 Vercel 라우트에 빈 POST ("일어나")
--     -> POST /api/cron/auto-nudge  (Bearer 인증)
--          -> service_role 로 public.run_auto_nudges() 호출 (여기서 원자적으로 확정)
--          -> web-push 팬아웃
--
-- pg_cron 은 UTC 고정입니다(Supabase 에서는 postgresql.conf 를 못 고칩니다).
-- 그래서 시간대 계산은 전부 위쪽 SQL 안에서 profiles.timezone 으로 합니다.
-- 모든 IANA 오프셋이 15분의 배수이므로 UTC 의 5분 경계는 어느 현지 시간대에서도
-- 5분 경계입니다. 위상차가 0 입니다.
--
-- ───────────────────────────────────────────────────────────────────────────
-- [1단계] Supabase 대시보드 -> Database -> Extensions 에서 켜기
--         * pg_cron   (스키마: 그대로 두면 cron)
--         * pg_net    (스키마: extensions -- 함수는 net 스키마에 생깁니다)
--
-- [2단계] 비밀값 만들기. 터미널에서:
--             openssl rand -base64 48
--         이 값을 Vercel 환경변수 CRON_SECRET (Production) 에도
--         똑같이 넣으세요. ★ SUPABASE_SERVICE_ROLE_KEY 를 재사용하지 마세요. ★
--         별개로 회전할 수 있어야 합니다.
--
-- [3단계] 아래 SQL 을 위에서부터 순서대로 SQL 편집기에 붙여넣으세요.
--         <붙여넣을_비밀값> 과 <내앱주소> 를 실제 값으로 바꾸세요.
-- ───────────────────────────────────────────────────────────────────────────
--
-- -- (a) pg_net 을 브라우저 손에서 떼어놓기.
-- --     anon/authenticated 가 net.http_post 를 부를 수 있으면 그건 데이터베이스의
-- --     egress 신원을 그대로 쓰는 완전한 SSRF 입니다. SECURITY DEFINER 코드만
-- --     만질 수 있어야 합니다.
-- revoke all on schema net                  from anon, authenticated;
-- revoke all on all functions in schema net from anon, authenticated;
--
-- -- (b) Vault 에 비밀값 저장. cron.schedule 의 command 문자열에 비밀값을 인라인하면
-- --     cron.job 테이블에 평문으로 남습니다. 그래서 런타임에 읽습니다.
-- select vault.create_secret(
--   '<붙여넣을_비밀값>',
--   'cron_secret',
--   '/api/cron/auto-nudge 용 Bearer 토큰');
-- select vault.create_secret(
--   'https://<내앱주소>/api/cron/auto-nudge',
--   'reminder_cron_url',
--   '자동 리마인더 웨이크업 엔드포인트');
--
-- -- (c) 틱 함수. 보낼 사람이 없으면 HTTP 를 아예 만들지 않습니다.
-- create or replace function private.dispatch_auto_nudges()
-- returns void
-- language plpgsql
-- security definer
-- set search_path = ''
-- as $fn$
-- declare
--   v_secret text;
--   v_url    text;
-- begin
--   if not private.auto_nudge_due_exists() then
--     return;   -- 하루 288틱 중 ~284틱이 여기서 끝납니다.
--   end if;
--
--   select s.decrypted_secret into v_secret
--   from vault.decrypted_secrets s where s.name = 'cron_secret';
--   select s.decrypted_secret into v_url
--   from vault.decrypted_secrets s where s.name = 'reminder_cron_url';
--
--   if v_secret is null or v_url is null then
--     raise warning '[auto_nudge] vault 비밀값이 없습니다. 12번 [2단계]를 확인하세요.';
--     return;
--   end if;
--
--   perform net.http_post(
--     url     => v_url,
--     body    => '{}'::jsonb,
--     headers => jsonb_build_object(
--                  'Content-Type',  'application/json',
--                  'Authorization', 'Bearer ' || v_secret),
--     -- ★ 이 값을 지우지 마세요 ★ 기본값이 1~2초입니다. 밤에 오래 놀고 있던
--     -- Vercel 함수는 콜드 스타트에 그보다 오래 걸리고, 그러면 요청이 취소되면서
--     -- 조용히 매일 밤 알림이 사라집니다. 라우트가 실제로 실행되기 전에는
--     -- 아무것도 확정하지 않으므로, 진짜 타임아웃이 나도 다음 틱이 재시도합니다.
--     timeout_milliseconds => 30000
--   );
-- end;
-- $fn$;
--
-- alter function private.dispatch_auto_nudges() owner to postgres;
-- revoke all on function private.dispatch_auto_nudges() from public, anon, authenticated;
--
-- -- (d) 5분마다 (UTC). 이미 같은 이름의 job 이 있으면 먼저 지우세요:
-- --     select cron.unschedule('auto-nudges');
-- select cron.schedule(
--   'auto-nudges',
--   '*/5 * * * *',
--   $cron$select private.dispatch_auto_nudges()$cron$);
--
-- -- (e) cron.job_run_details 는 자동으로 정리되지 않습니다. 5분마다 도는 job 은
-- --     연 10만 행이 넘고, 무료 플랜 500MB 를 조용히 갉아먹습니다.
-- select cron.schedule(
--   'cron-log-prune',
--   '17 4 * * *',
--   $cron$delete from cron.job_run_details where end_time < now() - interval '7 days'$cron$);
--
-- ───────────────────────────────────────────────────────────────────────────
-- [4단계] 앱 쪽에서 반드시 해야 하는 것
--   * proxy.ts 의 matcher 부정 룩어헤드에 `api/cron/` 을 추가하세요.
--     지금은 세션 없는 /api/* 요청을 401 로 돌려보내므로, 쿠키가 없는 이 POST 는
--     라우트에 닿지도 못합니다.
--   * /api/cron/auto-nudge 는 Authorization 헤더를 crypto.timingSafeEqual 로
--     (길이 먼저 확인한 뒤) 비교하고, 실패하면 401 이 아니라 404 를 반환하세요.
--   * runtime = 'nodejs', dynamic = 'force-dynamic'.
--   * 요청 본문은 절대 신뢰하지 마세요. 보낼 대상은 run_auto_nudges() 결과에서만
--     나옵니다. 그래서 비밀값이 새어도 "특정 사람" 을 지목해 알림을 보낼 수 없습니다.
--
-- [5단계] 알아 둘 실패 모드
--   * 무료 플랜 프로젝트 일시정지: 일주일간 API 호출이 없으면 프로젝트가 멈추고
--     리마인더도 조용히 멈춥니다. pg_cron 틱은 "활동" 으로 세지 않습니다.
--   * 비밀값 회전은 무증상 장애입니다. Vault 와 Vercel 중 한쪽만 바꾸면 5분마다
--     404 가 날 뿐 아무 신호도 없습니다. 한 번에 같이 바꾸세요.
--   * "21:00" 은 실제로는 "21:00~21:05, 보통은" 입니다. 구조적인 지연입니다.
--   * iOS 는 홈 화면에 설치한 PWA 안에서만 웹 푸시가 옵니다. Safari 에서 토글만
--     켠 사용자는 설정 행만 생기고 알림은 평생 한 번도 안 옵니다.
--   * 오늘 적어 둔 할 일이 0개면 알림이 안 갑니다(요구사항대로). "아무것도 안
--     적었다" 가 사실 제일 알림이 필요한 경우일 수 있다는 건 알아 두세요.
-- =============================================================================


-- =============================================================================
-- 13. 자체 점검 (선택 -- SQL 편집기에서 돌려 보세요)
--
-- (a) 스케줄러 함수가 클라이언트에서 안 보이는지  ★ 제일 중요 ★
--   select has_function_privilege('authenticated', 'public.run_auto_nudges()', 'EXECUTE');
--   -> false 여야 합니다.
--   select has_function_privilege('anon', 'public.run_auto_nudges()', 'EXECUTE');
--   -> false 여야 합니다.
--   select has_function_privilege('service_role', 'public.run_auto_nudges()', 'EXECUTE');
--   -> true 여야 합니다.
--
-- (b) 본인용 RPC 는 로그인 사용자에게 열려 있는지
--   select has_function_privilege('authenticated', 'public.set_auto_nudge(boolean,time)', 'EXECUTE');
--   select has_function_privilege('authenticated', 'public.get_auto_nudge()', 'EXECUTE');
--   -> 둘 다 true 여야 합니다.
--   select has_function_privilege('anon', 'public.set_auto_nudge(boolean,time)', 'EXECUTE');
--   -> false 여야 합니다.
--
-- (c) auto_nudge_* 컬럼이 그룹 동료에게 막혔는지
--   select has_column_privilege('authenticated', 'public.profiles', 'auto_nudge_at', 'SELECT');
--   select has_column_privilege('authenticated', 'public.profiles', 'auto_nudge_enabled', 'SELECT');
--   select has_column_privilege('authenticated', 'public.profiles', 'auto_nudge_last_on', 'SELECT');
--   -> 셋 다 false 여야 합니다.
--   select has_column_privilege('authenticated', 'public.profiles', 'display_name', 'SELECT');
--   -> true 여야 합니다.
--
-- (d) auto_nudge_* 를 클라이언트가 직접 쓸 수 없는지
--   select has_column_privilege('authenticated', 'public.profiles', 'auto_nudge_enabled', 'UPDATE');
--   -> false 여야 합니다. (유일한 쓰기 경로는 set_auto_nudge)
--
-- (e) 함수 소유자가 postgres 인지 (RLS 우회의 근거)
--   select p.proname, r.rolname
--   from pg_proc p join pg_roles r on r.oid = p.proowner
--   where p.proname in ('run_auto_nudges','set_auto_nudge','get_auto_nudge',
--                       'send_nudge','safe_local_now','auto_nudge_due_exists',
--                       'profiles_auto_nudge_tz_change');
--   -> rolname 이 전부 postgres 여야 합니다.
--
-- (f) nudges CHECK 이 실제로 유효한지 (NOT VALID 로 남아 있지 않은지)
--   select conname, convalidated from pg_constraint
--   where conrelid = 'public.nudges'::regclass and conname = 'nudges_source_sender_chk';
--   -> convalidated = true 여야 합니다.
--
-- (g) 트리거 실행 순서 (알파벳 순 -- validate 가 먼저여야 합니다)
--   select tgname from pg_trigger
--   where tgrelid = 'public.profiles'::regclass and not tgisinternal
--   order by tgname;
--   -> profiles_validate_timezone 이 profiles_z_auto_nudge_tz_change 보다 앞.
--
-- (h) 멱등성 수동 확인
--   select * from public.run_auto_nudges();   -- service_role 로 실행
--   select * from public.run_auto_nudges();   -- 곧바로 다시
--   -> 두 번째는 0행이어야 합니다.
--   (SQL 편집기는 postgres 로 도는 경우가 많아 auth.uid() 가 NULL 이라 통과합니다.
--    authenticated 로 흉내 내면 42501 이 나야 정상입니다.)
--
-- (i) 알림 본문에 넣으면 안 되는 것 -- 코드 리뷰 체크리스트
--   자동 리마인더는 수신자 본인의 사적인 할 일 목록에서 생성됩니다. 푸시 알림은
--   잠금 화면, 차량/TV 미러링, 페어링된 시계에 그대로 뜹니다.
--   금지: tasks.title (자르든 말든), 그룹 이름, 다른 멤버 이름,
--         task/group UUID 가 들어간 url, requireInteraction.
--   허용: 개수 하나. 예)
--     title: "오늘 할 일이 남았어요"
--     body:  `아직 ${out_pending_count}개 남았어요.`
--     url:   "/"
--     tag:   "auto-nudge"   -- 상수. app/sw.ts 가 renotify:true 라 tag 가 필수이고,
--                           -- 상수여야 반복 알림이 잠금화면에서 하나로 합쳐집니다.
--   라우트는 run_auto_nudges() 결과 외에 tasks 를 다시 조회하면 안 됩니다.
--   "본문을 좀 더 친절하게" 하려는 그 재조회가 제목이 새어 나가는 유일한 경로입니다.
-- =============================================================================


-- PostgREST 스키마 캐시 갱신. 이게 없으면 set_auto_nudge / get_auto_nudge 가
-- 다음 무관한 배포 전까지 404 로 나옵니다.
notify pgrst, 'reload schema';
