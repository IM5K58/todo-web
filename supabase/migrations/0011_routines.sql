-- ═══════════════════════════════════════════════════════════════════════════
-- 0011_routines.sql  --  개인별 루틴 (주/월 주기 + 본인 체크인)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 【사용자가 요청한 것 (원문)】
--   "개개인별 루틴 설정 가능하게 하기. 해당 루틴 설정은 관리자 계정으로만 가능.
--    그룹 내 사용자에게 추가할 수 있음. 주별/달 별 체크인지 확인 그리고 매일
--    체크할 수 있게 할것(각 사용자 본인이). 예를 들어, 일주일에 헬스장 이틀
--    가기를 루틴으로 정하면, 사용자에게 일주일 루틴, 이틀마다 체크할 수 있게 하고"
--
--   ▶ 이 예시를 스키마로 옮기면:
--       routines(title='헬스장 가기', period='week', target_count=2)
--       사용자는 **매일** 토글할 수 있고(월요일에 가도, 토요일에 가도 그날 체크),
--       이번 주 안에 2번이 채워지면 그 주는 달성입니다.
--     "이틀마다 체크" 를 "이틀에 한 번씩만 버튼이 열린다" 로 읽지 않았습니다.
--     헬스장에 언제 갈지는 사용자가 정하는 것이지 시스템이 정하는 게 아니고,
--     "월/목에만 체크 가능" 같은 구현은 화요일에 간 사람을 미달성으로 만듭니다.
--     목표는 **횟수** 이고 날짜는 자유입니다.
--
-- 【이 파일이 만드는 것 -- 이 순서 그대로입니다】
--   ① private.routine_period_start / routine_period_end   -- 주/월 경계 (단일 진실)
--   ② public.routines / routine_assignments / routine_checkins  + 인덱스·트리거
--   ③ private.routine_period_progress                      -- "이번 주기 몇 번" (단일 진실)
--   ④ private.is_routine_visible                           -- RLS 헬퍼 (42P17 회피)
--   ⑤ GRANT (읽기만) + RLS 정책 (SELECT 만)
--   ⑥ private.clear_routine_assignments_on_leave           -- 탈퇴 시 배정 정리
--   ⑦ public.upsert_routine / set_routine_assignees        -- 관리자 전용
--   ⑧ public.toggle_routine_checkin / get_my_routines      -- 본인 전용
--   ⑨ Realtime
--   ⑩ 자체 점검 -- 주기 계산이 **실제로** 맞는지 값을 넣어 보고 롤백
--
--   ⚠ ③ 이 ② 뒤에 있는 것은 취향이 아니라 필수입니다. `language sql` 함수는
--     **생성 시점에 본문이 파싱·검증** 됩니다(plpgsql 과 다릅니다). 테이블보다
--     먼저 두면 `relation "public.routine_checkins" does not exist` 로 이 파일이
--     통째로 실패합니다. 실제로 그렇게 짰다가 잡았습니다 -- 순서를 바꾸지 마세요.
--
-- 선행: 0001(private 헬퍼, current_user_local_date), 0009(private.is_app_admin).
-- 멱등: create ... if not exists / create or replace / drop ... if exists / do 가드.
-- 반드시 `postgres` 역할로 실행하세요 (SECURITY DEFINER 의 근거).
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- 0. 선행 조건 -- 없으면 조용히 반쪽만 도는 대신 여기서 멈춥니다
-- ───────────────────────────────────────────────────────────────────────────
do $do$
begin
  if pg_catalog.to_regnamespace('private') is null then
    raise exception
      'private 스키마가 없습니다(0001 에서 만들어집니다). 0001 부터 순서대로 실행하세요.';
  end if;

  if pg_catalog.to_regprocedure('private.is_app_admin()') is null then
    raise exception
      'private.is_app_admin() 이 없습니다. 0011 의 관리자 전용 RPC 두 개가 이 함수에 '
      '통째로 걸려 있습니다 -- 0009_admin_and_pledge.sql 을 먼저 실행하세요. '
      '(지금 이 파일만 적용하면 upsert_routine / set_routine_assignees 가 호출 시점에 '
      '42883 으로 터집니다.)';
  end if;

  if pg_catalog.to_regprocedure('public.current_user_local_date()') is null then
    raise exception
      'public.current_user_local_date() 가 없습니다(0001). 이 함수 없이는 "오늘" 이 '
      '서버 UTC 가 되어 한국 시간 자정~오전 9시 사이의 체크가 전날로 기록됩니다.';
  end if;

  if pg_catalog.to_regprocedure('private.is_group_member(uuid)') is null then
    raise exception 'private.is_group_member(uuid) 가 없습니다(0001).';
  end if;

  if pg_catalog.to_regprocedure('public.set_updated_at()') is null then
    raise exception 'public.set_updated_at() 이 없습니다(0001).';
  end if;
end
$do$;


-- ═══════════════════════════════════════════════════════════════════════════
-- ① 주기 경계 -- 이 파일에서 가장 중요한 결정 세 가지
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 【결정 1. 주의 시작 요일 = 월요일】
--   근거 두 가지가 같은 답을 가리킵니다.
--     (a) 한국에서 "이번 주" 는 월요일에 시작합니다. 달력도, 주간 계획도 그렇습니다.
--         일요일 시작(미국식)을 쓰면 일요일 밤에 헬스장에 다녀온 사람의 체크가
--         **다음 주** 로 잡혀서, 본인이 보기에 이번 주 목표가 갑자기 미달성이 됩니다.
--     (b) Postgres 의 date_trunc('week', ...) 는 ISO 8601 기준이라 **이미 월요일
--         시작** 입니다. 즉 표준 함수를 그대로 쓰면 우리가 원하는 동작이 나옵니다.
--         손으로 요일 계산을 하지 않는 편이 버그가 적습니다.
--   ▶ 아래 자체 점검 (1) 이 이 두 문장을 **매 실행마다 검증** 합니다.
--     "일요일이 속한 주의 시작은 그 6일 전 월요일" 을 하드코딩된 날짜로 확인하므로,
--     Postgres 버전이나 서버 로케일이 이 동작을 바꾸면 마이그레이션이 실패합니다.
--
-- 【결정 2. period='month' = 달력 월 (30일 이동창 아님)】
--   "이번 달에 몇 번 갔지?" 라는 질문에 사람이 기대하는 답은 1일부터 말일까지입니다.
--   30일 이동창은 화면에 "지난 30일" 이라고 적어야 정직한데, 그러면 매일 기준선이
--   움직여서 어제 달성이던 것이 오늘 미달성이 됩니다. 달력 월은 말일 자정에 한 번만
--   리셋되고, 그 순간을 사용자가 예측할 수 있습니다.
--   달의 길이가 28~31 로 들쭉날쭉한 것은 감수합니다 -- 사람의 달력이 원래 그렇습니다.
--
-- 【결정 3. "오늘" 은 사용자 로컬 날짜 (public.current_user_local_date())】
--   서버 UTC 로 판정하면 한국 시간 00:00~09:00 의 체크가 전날로 기록되고, 그러면
--   주 경계도 함께 밀립니다. 월요일 새벽 1시에 체크한 사람은 지난 주에 카운트되어
--   이번 주 진행이 0 인 채로 시작합니다. 0001 이 tasks.task_date 에서 이미 겪은
--   문제이고, 같은 함수로 같이 해결합니다.
--
-- ───────────────────────────────────────────────────────────────────────────
-- ①-a private.routine_period_start(p_period text, p_today date) -> date
--
-- immutable 인 이유:
--   date_trunc(text, timestamp) 는 IMMUTABLE 입니다(세션 타임존에 의존하는
--   date_trunc(text, timestamptz) 는 STABLE -- 0001 의 send_nudge 주석 참고).
--   date -> timestamp 캐스팅도 immutable 이라 이 함수 전체가 immutable 입니다.
--   덕분에 플래너가 상수 폴딩을 할 수 있고, 나중에 필요하면 인덱스 식에도
--   쓸 수 있습니다.
--
-- 알 수 없는 period 는 예외가 아니라 NULL 입니다. 예외를 던지면 CHECK 제약이
-- 이미 막고 있는 값 때문에 조회 전체가 터질 수 있습니다. NULL 이면 비교식이
-- NULL 이 되어 0건이 되고, 그건 "진행 0" 이라는 안전한 값입니다.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function private.routine_period_start(p_period text, p_today date)
returns date
language sql
immutable
set search_path = ''
as $fn$
  select case p_period
    -- ★ date_trunc('week', ...) 는 ISO 8601 = 월요일 시작입니다 ★
    --   이 한 줄이 "주의 시작 요일" 에 대한 이 앱의 유일한 정의입니다.
    when 'week'  then (pg_catalog.date_trunc('week',  p_today::timestamp))::date
    when 'month' then (pg_catalog.date_trunc('month', p_today::timestamp))::date
    else null::date
  end;
$fn$;

alter function private.routine_period_start(text, date) owner to postgres;
revoke all on function private.routine_period_start(text, date) from public, anon, authenticated;

comment on function private.routine_period_start(text, date) is
  '주기의 첫날. week 는 ISO 8601 기준 **월요일** 시작(date_trunc 의 기본 동작), '
  'month 는 달력 월 1일. 알 수 없는 period 는 NULL(예외 아님 -- 조회가 0건이 되는 쪽이 안전합니다). '
  '주의 시작 요일을 바꾸려면 여기 한 줄만 고치세요. routine_period_end 가 이 값에서 파생되고 '
  'toggle_routine_checkin / get_my_routines 가 둘 다 이 함수를 경유합니다.';


-- ───────────────────────────────────────────────────────────────────────────
-- ①-b private.routine_period_end(p_period text, p_period_start date) -> date
--
-- ★ 인자가 p_today 가 아니라 p_period_start 입니다 ★
--   일부러입니다. 끝날을 "오늘" 에서 독립적으로 계산하면 시작과 끝이 서로 다른
--   요일 규칙을 갖게 되는 순간(예: 시작은 월요일인데 끝은 토요일) 아무도 모르게
--   하루가 새거나 사라집니다. 끝을 시작에서 파생시키면 "월요일 시작" 이라는
--   결정이 물리적으로 한 곳에만 존재합니다.
--   경계는 **양끝 포함** 입니다: [start, end] 안의 체크인을 셉니다.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function private.routine_period_end(p_period text, p_period_start date)
returns date
language sql
immutable
set search_path = ''
as $fn$
  select case p_period
    when 'week'  then p_period_start + 6                                  -- 월~일
    when 'month' then (p_period_start + interval '1 month')::date - 1      -- 1일~말일
    else null::date
  end;
$fn$;

alter function private.routine_period_end(text, date) owner to postgres;
revoke all on function private.routine_period_end(text, date) from public, anon, authenticated;

comment on function private.routine_period_end(text, date) is
  '주기의 마지막날(포함). 인자가 "오늘" 이 아니라 "주기 시작일" 인 것이 핵심입니다 -- '
  '시작과 끝이 각자 요일 계산을 하면 언젠가 하루가 어긋납니다. week=시작+6, month=다음달1일-1일.';


-- ═══════════════════════════════════════════════════════════════════════════
-- ② 테이블
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- ②-a public.routines
--
-- 【target_count 의 상한을 주기별로 다르게 거는 이유】
--   period='week', target_count=10 은 물리적으로 달성 불가능한 루틴입니다.
--   일주일에 체크할 수 있는 날이 7일뿐이니까요. 이런 값이 저장되면 사용자에게는
--   "영원히 안 차는 진행 막대" 로 보이고, 그건 기능이 아니라 고장입니다.
--   그래서 CHECK 이 period 를 함께 봅니다 (둘 다 같은 행에 있으므로 가능합니다).
--     week  -> 1..7
--     month -> 1..31
--   ▶ upsert_routine 도 같은 규칙을 한국어 메시지로 다시 검사합니다. CHECK 만
--     있으면 관리자에게 23514 라는 날것의 에러가 갑니다.
--   ▶ 자체 점검 (6) 이 week/8 이 실제로 거부되는지 넣어 보고 확인합니다.
--
-- 【active 가 곧 "삭제" 입니다 -- DELETE 경로를 만들지 않은 이유】
--   routine_checkins 의 FK 는 on delete cascade 입니다. 루틴을 지우면 그 루틴의
--   체크 기록이 **전부 함께 사라집니다**. 그건 사용자가 몇 달에 걸쳐 쌓은 기록이고,
--   관리자 실수 한 번으로 되돌릴 수 없게 날아가서는 안 됩니다.
--   그래서 authenticated 에게 DELETE 권한도, DELETE 정책도 주지 않습니다.
--   "그만할래" 는 upsert_routine(p_active => false) 입니다. 화면에서는 사라지고
--   (get_my_routines 가 active 만 반환), 기록은 남습니다.
--   ▶ 진짜로 지워야 할 때는 그룹 자체를 지우거나(groups -> routines 캐스케이드)
--     service_role 로 직접 지우세요. 의도적으로 불편하게 두었습니다.
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.routines (
  id           uuid        primary key default gen_random_uuid(),
  group_id     uuid        not null references public.groups (id) on delete cascade,
  title        text        not null,
  period       text        not null,
  target_count integer     not null,
  active       boolean     not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint routines_title_len_chk
    check (char_length(btrim(title)) between 1 and 60),

  constraint routines_period_chk
    check (period in ('week', 'month')),

  -- 달성 불가능한 목표를 스키마가 막습니다 (위 주석 참고).
  constraint routines_target_count_chk
    check (
      (period = 'week'  and target_count between 1 and 7)
      or
      (period = 'month' and target_count between 1 and 31)
    )
);

alter table public.routines enable row level security;
revoke all on public.routines from anon, authenticated;
alter table public.routines replica identity default;

comment on table public.routines is
  '그룹 단위 루틴 정의. 예: (title=''헬스장 가기'', period=''week'', target_count=2) '
  '= 일주일에 두 번. 읽기는 같은 그룹 멤버, 쓰기는 관리자 전용 RPC(public.upsert_routine) 뿐입니다 -- '
  'authenticated 에게 INSERT/UPDATE/DELETE 권한도 정책도 없습니다. '
  '"삭제" 는 active=false 입니다(하드 삭제는 routine_checkins 를 캐스케이드로 날립니다).';
comment on column public.routines.period is
  '''week'' = ISO 8601 주(월요일 시작), ''month'' = 달력 월. 경계 계산은 '
  'private.routine_period_start/end 한 곳에만 있습니다.';
comment on column public.routines.target_count is
  '한 주기에 채워야 하는 체크 횟수. week 는 1..7, month 는 1..31 (달성 불가능한 목표 차단). '
  '"이틀마다 체크" 가 아니라 "주기 안에 아무 날이나 target_count 번" 입니다.';
comment on column public.routines.active is
  'false = 더 이상 하지 않는 루틴. get_my_routines 에서 빠지고 toggle_routine_checkin 도 거부하지만, '
  '★ 과거 routine_checkins 행은 지우지 않습니다 ★ -- 기록이기 때문입니다.';

-- 질의 패턴: "이 그룹의 루틴 목록" (관리자 화면).
create index if not exists routines_group_created_idx
  on public.routines (group_id, created_at);

drop trigger if exists routines_set_updated_at on public.routines;
create trigger routines_set_updated_at
  before update on public.routines
  for each row
  when (old.* is distinct from new.*)   -- 무의미한 UPDATE 는 updated_at 을 건드리지 않음
  execute function public.set_updated_at();


-- ───────────────────────────────────────────────────────────────────────────
-- ②-b public.routine_assignments  --  "누구에게 이 루틴이 붙었는가"
--
-- 복합 PK (routine_id, user_id) 라서 같은 사람을 두 번 배정할 수 없습니다.
-- 배정 자체는 기록이 아니라 **현재 상태** 입니다. 배정을 해제하면 이 행은
-- 사라지지만 routine_checkins 는 그대로 남습니다 (②-c 주석 참고).
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.routine_assignments (
  routine_id  uuid        not null references public.routines (id) on delete cascade,
  user_id     uuid        not null references public.profiles (id) on delete cascade,
  assigned_at timestamptz not null default now(),

  primary key (routine_id, user_id)
);

alter table public.routine_assignments enable row level security;
revoke all on public.routine_assignments from anon, authenticated;
alter table public.routine_assignments replica identity default;

comment on table public.routine_assignments is
  '루틴 배정(현재 상태). 관리자 전용 RPC(public.set_routine_assignees)로 전체 교체합니다. '
  '해제하면 이 행만 사라지고 routine_checkins 는 남습니다 -- 기록은 지우지 않습니다.';

-- ★ 중요 인덱스 ★ PK 가 (routine_id, user_id) 라서 user_id 단독 조회를 못 탑니다.
--   get_my_routines 가 매 호출마다 user_id 로 필터하므로, 이게 없으면 홈 화면이
--   배정 테이블 순차 스캔이 됩니다. 0001 의 group_members_user_id_idx 와 같은 이유.
create index if not exists routine_assignments_user_idx
  on public.routine_assignments (user_id, routine_id);


-- ───────────────────────────────────────────────────────────────────────────
-- ②-c public.routine_checkins  --  "그 사람이 그날 했다"
--
-- 【unique(routine_id, user_id, checked_on) 이 토글 멱등성의 근거】
--   같은 날 두 번 누르면 체크/해제가 되어야지 행이 두 개 생기면 안 됩니다.
--   toggle_routine_checkin 이 자문 잠금으로 직렬화하지만, 그건 "우리 RPC 를 통한
--   동시 호출" 만 덮습니다. 스키마가 막는 편이 최종 방어선입니다.
--   ▶ 자체 점검 (6) 이 같은 날 두 번째 INSERT 가 23505 로 거부되는지 확인합니다.
--
-- 【checked_on 의 DEFAULT 가 current_date 가 아닌 이유】  (규칙 4)
--   서버는 UTC 입니다. current_date 를 쓰면 한국 시간 00:00~09:00 의 체크가
--   전날로 기록되고, 그 결과 주 경계까지 함께 밀립니다.
--   0001 의 tasks.task_date 와 같은 DEFAULT 를 씁니다.
--   ▶ 자체 점검 (5) 가 이 DEFAULT 가 실제로 그 함수인지 카탈로그에서 확인합니다.
--
-- 【배정 해제/비활성화 뒤의 과거 체크는 어떻게 되는가 -- 결정】
--   * 지우지 않습니다. 기록입니다. 배정 해제는 routine_assignments 만 건드리고,
--     루틴 비활성화는 routines.active 만 건드립니다.
--   * 다만 **조회에서는 뺍니다**: get_my_routines 는 "지금 나에게 배정된, 활성
--     루틴" 만 돌려줍니다. 이유는 그 목록이 "오늘 내가 체크할 것" 이기 때문입니다.
--     끝난 루틴을 섞어 보여 주면 체크할 수 없는 항목이 목록에 남아 혼란스럽고,
--     toggle 이 거부하는 것과도 어긋납니다.
--   * 기록 자체는 사라지지 않으므로, 나중에 "지난 기록 보기" 화면이 필요해지면
--     routine_checkins 를 직접 조회하면 됩니다(SELECT 정책이 같은 그룹 멤버에게
--     이미 열려 있습니다). 그때 이 파일을 고칠 필요는 없습니다.
--
-- 【왜 같은 그룹 멤버가 서로의 체크를 볼 수 있는가】
--   이 앱의 존재 이유입니다. tasks 도 nudges 도 그룹 공개이고(0002), 루틴만
--   비공개로 두면 "친구가 이번 주에 헬스장 두 번 갔나" 를 아무도 볼 수 없어서
--   루틴 기능이 혼자 쓰는 체크리스트로 전락합니다.
--   나가는 정보는 (누가, 어떤 루틴을, 며칠에 체크했는가) 이고 전부 같은 그룹
--   안에서만 보입니다. 그룹을 나가면 안 보입니다.
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.routine_checkins (
  id         uuid        primary key default gen_random_uuid(),
  routine_id uuid        not null references public.routines (id) on delete cascade,
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  checked_on date        not null default public.current_user_local_date(),
  created_at timestamptz not null default now(),

  -- 하루 한 번. 토글이 두 행을 만들 수 없게 하는 최종 방어선.
  constraint routine_checkins_once_a_day_key unique (routine_id, user_id, checked_on)
);

alter table public.routine_checkins enable row level security;
revoke all on public.routine_checkins from anon, authenticated;

-- Realtime DELETE 이벤트는 RLS 로 걸러지지 않습니다(0001 의 경고).
-- REPLICA IDENTITY 는 반드시 DEFAULT(PK만) 로 두세요. FULL 로 바꾸면 체크 해제 시
-- (누가/어떤 루틴/며칠) 이 통째로 모든 구독자에게 갑니다.
alter table public.routine_checkins replica identity default;

comment on table public.routine_checkins is
  '루틴 체크인. 하루 한 번(unique(routine_id, user_id, checked_on)) -- 이게 토글 멱등성의 최종 근거입니다. '
  '쓰기는 public.toggle_routine_checkin() 뿐이고 authenticated 에게는 INSERT/UPDATE/DELETE 권한도 정책도 없습니다. '
  '읽기는 같은 그룹 멤버 전원(이 앱의 존재 이유). '
  'Realtime 주의: DELETE 이벤트에는 RLS 가 적용되지 않으니 REPLICA IDENTITY 는 DEFAULT 유지.';
comment on column public.routine_checkins.checked_on is
  '체크한 날짜. DEFAULT 가 public.current_user_local_date() 인 것이 핵심입니다 -- '
  'current_date(서버 UTC)로 바꾸면 한국 시간 자정~오전 9시의 체크가 전날로 기록되고 주 경계까지 밀립니다(규칙 4).';

-- unique 제약이 만든 인덱스 (routine_id, user_id, checked_on) 는
-- routine_period_progress 의 "이 루틴 + 이 사람 + 날짜 범위" 를 그대로 탑니다.
-- 아래 인덱스는 그걸로 못 타는 질의용입니다: "이 루틴의 이번 주 체크 전원"
-- (그룹 화면에서 친구들 진행을 한 번에 그릴 때).
create index if not exists routine_checkins_routine_date_idx
  on public.routine_checkins (routine_id, checked_on);

-- FK 인덱스 + "내 최근 체크" 조회.
create index if not exists routine_checkins_user_date_idx
  on public.routine_checkins (user_id, checked_on desc);


-- ═══════════════════════════════════════════════════════════════════════════
-- ③ private.routine_period_progress(routine, user, period, today) -> int
--    "그 사람이 이번 주기에 몇 번 체크했는가"
--
-- ★ 이 함수가 "현재 주기" 계산의 단일 진실입니다 ★
--   toggle_routine_checkin 과 get_my_routines 가 **둘 다** 이걸 부릅니다.
--   세는 식을 두 군데에 적으면 언젠가 어긋나고, 그때 증상은 "토글 직후에 보이는
--   숫자와 새로고침 뒤 숫자가 다르다" 라는 최악의 형태입니다.
--   자체 점검 (6) 도 이 함수를 그대로 호출해서 검증합니다.
--
-- ⚠ 이 함수는 public.routine_checkins 를 참조하므로 **반드시 ② 뒤에** 있어야
--   합니다. `language sql` 은 생성 시점에 본문이 검증됩니다(파일 머리 주석 참고).
--
-- 【왜 SECURITY DEFINER 가 아닌가 -- 의도적입니다】
--   이 함수는 p_user_id 를 인자로 받습니다. 즉 "남으로서" 조준이 가능한 모양입니다.
--   0001 의 private 헬퍼들이 인자를 받지 않는 이유가 정확히 그것이었습니다.
--   그래서 여기서는 반대로 갑니다: SECURITY **INVOKER** 로 두고 EXECUTE 를
--   authenticated 에서 회수합니다.
--     * 실제 호출자는 postgres 소유 DEFINER 함수 두 개뿐이고, 그 안에서는 현재
--       역할이 postgres 라 테이블 소유자 자격으로 RLS 없이 읽습니다(정상 동작).
--     * 만에 하나 누가 EXECUTE 를 열어 주더라도, INVOKER 라서 호출자의 RLS 가
--       그대로 걸립니다 -- routine_checkins 의 SELECT 정책이 "같은 그룹" 으로
--       좁히므로 남의 진행을 훔쳐보는 데 쓸 수 없습니다.
--   DEFINER 였다면 EXECUTE 가 새는 순간 전 사용자의 체크 이력이 열립니다.
--   ▶ 자체 점검 (4) 가 authenticated/anon 에 EXECUTE 가 없는지 매번 확인합니다.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function private.routine_period_progress(
  p_routine_id uuid,
  p_user_id    uuid,
  p_period     text,
  p_today      date
)
returns integer
language sql
stable
set search_path = ''
as $fn$
  select pg_catalog.count(*)::int
  from public.routine_checkins c
  where c.routine_id = p_routine_id
    and c.user_id    = p_user_id
    -- 양끝 포함. period 가 이상하면 start/end 가 NULL 이라 조건이 NULL -> 0건.
    and c.checked_on >= private.routine_period_start(p_period, p_today)
    and c.checked_on <= private.routine_period_end(
                          p_period,
                          private.routine_period_start(p_period, p_today));
$fn$;

alter function private.routine_period_progress(uuid, uuid, text, date) owner to postgres;
revoke all on function private.routine_period_progress(uuid, uuid, text, date)
  from public, anon, authenticated;

comment on function private.routine_period_progress(uuid, uuid, text, date) is
  '현재 주기의 체크 횟수. toggle_routine_checkin 과 get_my_routines 의 공통 계산식입니다 '
  '(두 곳에 따로 적으면 토글 직후 숫자와 새로고침 뒤 숫자가 갈라집니다). '
  '경계는 [start, end] 양끝 포함. p_user_id 를 받는 조준 가능한 모양이라 '
  '일부러 SECURITY INVOKER 이고 authenticated/anon 에는 EXECUTE 를 주지 않습니다.';


-- ═══════════════════════════════════════════════════════════════════════════
-- ④ private.is_routine_visible(p_routine_id uuid) -> boolean   (RLS 헬퍼)
--
-- routine_assignments / routine_checkins 의 SELECT 정책이 "이 루틴이 내 그룹의
-- 것인가" 를 물어야 합니다. 그 판정에는 routines 와 group_members 를 함께 읽어야
-- 하는데, 정책 식 안에서 그 조인을 인라인으로 쓰면 규칙 1 위반입니다
-- (group_members 는 자기 정책 안에서 다시 읽히면 42P17 로 터집니다).
--
-- 0001 의 private.is_group_member(uuid) 와 완전히 같은 모양입니다: 인자는 받지만
-- 답하는 것은 **호출자 자신의 관계에 대한 불리언 하나** 이고, 목록은 나가지
-- 않습니다. "그 루틴이 실재하는가" 조차 false 와 구분되지 않습니다.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function private.is_routine_visible(p_routine_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
    from public.routines r
    join public.group_members gm on gm.group_id = r.group_id
    where r.id       = p_routine_id
      and gm.user_id = (select auth.uid())
  );
$fn$;

alter function private.is_routine_visible(uuid) owner to postgres;
revoke all on function private.is_routine_visible(uuid) from public, anon;
-- 정책 식은 질의하는 역할로 평가되므로 authenticated 에게 EXECUTE 가 필요합니다.
grant execute on function private.is_routine_visible(uuid) to authenticated;

comment on function private.is_routine_visible(uuid) is
  'RLS 헬퍼. "이 루틴이 내가 속한 그룹의 것인가" 불리언 하나만 답합니다. '
  'postgres 소유 SECURITY DEFINER 라 group_members 읽기가 자기 정책을 다시 타지 않습니다(42P17 회피). '
  '루틴의 실재 여부도 false 와 구분되지 않습니다.';


-- ═══════════════════════════════════════════════════════════════════════════
-- ⑤ GRANT + RLS 정책 -- 읽기만 엽니다
--
-- ★ INSERT/UPDATE/DELETE 는 GRANT 자체를 하지 않습니다 ★
--   정책만 안 만드는 것과 다릅니다. 권한이 없으면 나중에 누가 정책을 하나 잘못
--   추가해도(예: for all using (true)) 여전히 42501 로 막힙니다. 0009 의
--   group_pledges 와 같은 두 겹 방어이고, 이 세 테이블의 쓰기 규칙("루틴은
--   관리자만 / 체크는 본인만")이 통째로 RPC 하나씩에 걸려 있으므로 필요합니다.
--   ▶ 자체 점검 (5) 가 쓰기 권한이 생기지 않았는지 매 실행마다 확인합니다.
--     (컬럼 단위로 몰래 열리는 경우까지 보려고 has_any_column_privilege 를 씁니다.)
--
-- 새 테이블이므로 컬럼 단위로 좁힐 이유가 없습니다(0004 의 task_templates,
-- 0009 의 group_pledges 와 같은 판단). 모든 컬럼이 그룹 멤버에게 보여도 되는
-- 값입니다 -- 루틴 제목, 목표 횟수, 배정 여부, 체크한 날짜뿐입니다.
-- ═══════════════════════════════════════════════════════════════════════════
grant select on public.routines            to authenticated;
grant select on public.routine_assignments to authenticated;
grant select on public.routine_checkins    to authenticated;

-- service_role 은 RLS 를 우회하지만 테이블 권한은 여전히 필요합니다.
grant all on public.routines            to service_role;
grant all on public.routine_assignments to service_role;
grant all on public.routine_checkins    to service_role;

-- ---------------------------------------------------------------------------
-- routines -- 헬퍼: private.current_user_group_ids()  (0001)
-- 정책 안에서 routines 를 직접 SELECT 하지 않습니다(규칙 1). 여기서 읽는 것은
-- group_members 뿐이고 그것도 SECURITY DEFINER 헬퍼를 경유합니다.
-- 비멤버에게는 예외가 아니라 0행입니다(규칙 8).
-- ---------------------------------------------------------------------------
drop policy if exists routines_select_group_members on public.routines;
create policy routines_select_group_members
  on public.routines
  for select
  to authenticated
  using (group_id in (select private.current_user_group_ids()));

-- ---------------------------------------------------------------------------
-- routine_assignments -- 헬퍼: private.is_routine_visible(uuid)  (④)
--
-- `user_id = auth.uid()` 항을 or 로 둔 이유: 그룹을 나간 뒤에도 "내 배정이었다"
-- 는 사실은 내가 볼 수 있어야 합니다. 0002 의 tasks_select_group_members 가
-- 같은 이유로 같은 모양입니다. (탈퇴 시 배정 행 자체는 ⑥ 트리거가 지우므로
-- 실제로는 거의 해당되지 않지만, 트리거가 꺼진 상태에서도 일관되게 동작합니다.)
-- ---------------------------------------------------------------------------
drop policy if exists routine_assignments_select_group_members on public.routine_assignments;
create policy routine_assignments_select_group_members
  on public.routine_assignments
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or private.is_routine_visible(routine_id)
  );

-- ---------------------------------------------------------------------------
-- routine_checkins -- 헬퍼: private.is_routine_visible(uuid)  (④)
-- 같은 그룹 멤버 전원이 읽습니다(②-c 의 근거). 내 기록은 그룹을 나가도 보입니다.
-- ---------------------------------------------------------------------------
drop policy if exists routine_checkins_select_group_members on public.routine_checkins;
create policy routine_checkins_select_group_members
  on public.routine_checkins
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or private.is_routine_visible(routine_id)
  );

-- INSERT/UPDATE/DELETE 정책은 세 테이블 모두 **일부러 만들지 않습니다**.
-- 만들면 "관리자인가" 와 "본인인가" 판정이 정책과 RPC 두 곳으로 갈라집니다.
-- 쓰기 문은 네 개뿐입니다: upsert_routine / set_routine_assignees /
-- toggle_routine_checkin / (탈퇴 정리 트리거).


-- ═══════════════════════════════════════════════════════════════════════════
-- ⑥ 그룹을 나가면 그 그룹 루틴의 배정을 해제
--
-- 0007 의 clear_default_group_on_leave 와 같은 자리입니다. group_members 의
-- DELETE 는 멤버십 상실의 유일한 입구입니다(탈퇴·추방·계정삭제 캐스케이드).
--
-- ★ routine_checkins 는 건드리지 않습니다 ★ 배정은 현재 상태고 체크인은 기록입니다.
--   나갔다 다시 들어와도 예전 체크는 그대로 있고, 관리자가 다시 배정하면
--   그 주기의 진행이 이어집니다. 그게 사람이 기대하는 동작입니다.
--
-- 0행 DELETE 는 정상입니다(그 그룹에 루틴이 없거나 배정된 적이 없는 경우).
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function private.clear_routine_assignments_on_leave()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  delete from public.routine_assignments ra
   using public.routines r
   where ra.routine_id = r.id
     and ra.user_id    = old.user_id
     and r.group_id    = old.group_id;

  return null;   -- AFTER 트리거. 반환값은 무시됩니다.
end;
$fn$;

alter function private.clear_routine_assignments_on_leave() owner to postgres;
revoke all on function private.clear_routine_assignments_on_leave()
  from public, anon, authenticated;

drop trigger if exists group_members_clear_routine_assignments on public.group_members;
create trigger group_members_clear_routine_assignments
  after delete on public.group_members
  for each row
  execute function private.clear_routine_assignments_on_leave();

comment on function private.clear_routine_assignments_on_leave() is
  '그룹을 나가거나 추방당하면 그 그룹 루틴의 배정을 해제합니다. '
  '★ routine_checkins 는 지우지 않습니다 -- 기록이기 때문입니다. ★ '
  '0행 DELETE 는 정상입니다(배정된 루틴이 없던 경우).';


-- ═══════════════════════════════════════════════════════════════════════════
-- ⑦ 관리자 전용 RPC
--
-- 【거절을 조용히 할 것인가 예외로 할 것인가 -- 순서가 계약입니다】  (규칙 8)
--   두 함수 모두 이 순서를 지킵니다:
--     1) 로그인 안 했으면 42501            (이건 사용자가 고칠 수 있는 상태입니다)
--     2) 관리자가 아니면      -> 조용히 무동작   ← 여기서 끝나면 아무것도 안 새어 나감
--     3) 그 그룹 멤버가 아니면 -> 조용히 무동작
--     4) 여기부터는 "관리자이고 그 그룹의 멤버" 가 확정된 상태입니다.
--        입력 오류(빈 제목, 잘못된 period, 말이 안 되는 목표 횟수)는 **예외** 로
--        알립니다 -- 관리자 본인이 고칠 수 있는 오류이고, 응답이 알려 주는 것은
--        "내가 방금 보낸 값이 이상하다" 뿐입니다.
--   ▶ 순서를 바꾸면 안 됩니다. 검증을 권한 검사보다 먼저 하면, 비관리자가
--     에러 종류의 차이(22023 vs 무응답)로 "그 group_id 는 실재한다" 를 알아냅니다.
--     0009 의 set_group_pledge 가 같은 이유로 같은 순서입니다.
--
-- 【정상 경로】
--   ★ public.am_i_admin() 이 false 인 사용자에게는 버튼 자체를 보여주지 마세요. ★
--   조용한 무동작은 화면을 우회한 직접 호출용 최후 방어선이지 일반 사용자가 겪는
--   경로가 아닙니다. 그리고 관리자 화면도 반환값만으로 성공을 판단하지 말고,
--   호출 뒤 routines / routine_assignments 를 다시 읽어 실제 값으로 그리세요.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- ⑦-a public.upsert_routine(...) returns uuid
--
-- p_id 가 null 이면 생성, 아니면 수정. 반환은 만들어졌거나 고쳐진 루틴의 id 이고,
-- **조용히 무시된 경우에는 NULL** 입니다. 화면은 NULL 을 "아무 일도 일어나지
-- 않았다" 로 읽으면 됩니다(예외가 아니므로 사유는 알려 주지 않습니다).
--
-- 【수정 시 group_id 를 바꾸지 않는 이유】
--   루틴을 다른 그룹으로 옮기면 이미 배정된 사람들이 그 그룹의 멤버가 아니게
--   됩니다. 그러면 그들은 자기 목록에서 루틴이 사라지는데 체크 기록은 남아 있는,
--   설명하기 어려운 상태가 됩니다. where 절에 group_id 를 함께 넣어서, 다른
--   그룹의 루틴 id 를 넘기면 0행 -> NULL 이 되게 했습니다(그룹 이동이 아니라 무동작).
--
-- p_active 가 NULL 이면: 생성 시 true, 수정 시 기존 값 유지.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.upsert_routine(
  p_id           uuid,
  p_group_id     uuid,
  p_title        text,
  p_period       text,
  p_target_count integer,
  p_active       boolean
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_uid    uuid := (select auth.uid());
  v_title  text;
  v_period text;
  v_max    integer;
  v_id     uuid;
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;

  -- ── 조용한 거절 구간 (규칙 8). 권한을 **먼저** 봅니다.
  if not private.is_app_admin() then
    return null;
  end if;

  if p_group_id is null then
    return null;
  end if;

  -- SECURITY DEFINER 라 RLS 가 걸리지 않습니다. 멤버십은 여기서 직접 확인합니다.
  -- private.is_group_member 는 auth.uid() 를 보므로 남의 이름으로 조준 불가.
  -- (관리자라도 자기가 속하지 않은 그룹에 루틴을 심을 이유가 없고, 이 가드가
  --  없으면 존재하지 않는 group_id 에 대해 FK 위반 23503 이 "그 그룹은 없다" 를
  --  에러로 흘립니다 -- 0009 set_group_pledge 와 같은 판단.)
  if not private.is_group_member(p_group_id) then
    return null;
  end if;
  -- ── 여기부터는 "관리자이고 그 그룹의 멤버" 확정. 입력 오류는 예외로 알립니다.

  v_title := nullif(pg_catalog.btrim(coalesce(p_title, '')), '');
  if v_title is null then
    raise exception '루틴 이름을 입력해 주세요.' using errcode = '22023';
  end if;
  v_title := pg_catalog.left(v_title, 60);   -- routines_title_len_chk 와 맞춤

  v_period := pg_catalog.lower(pg_catalog.btrim(coalesce(p_period, '')));
  if v_period not in ('week', 'month') then
    raise exception '주기는 week(주) 또는 month(월) 여야 합니다.'
      using errcode = '22023';
  end if;

  -- CHECK 제약과 같은 규칙을 한국어로 다시 검사합니다. CHECK 만 있으면 관리자에게
  -- 23514 라는 날것의 에러가 갑니다. (규칙 자체는 스키마가 최종 강제합니다.)
  v_max := case v_period when 'week' then 7 else 31 end;
  if p_target_count is null or p_target_count < 1 or p_target_count > v_max then
    raise exception
      '목표 횟수는 1 이상 % 이하여야 합니다(% 주기에는 그보다 많은 날이 없습니다).',
      v_max, case v_period when 'week' then '주' else '월' end
      using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.routines (group_id, title, period, target_count, active)
    values (p_group_id, v_title, v_period, p_target_count, coalesce(p_active, true))
    returning id into v_id;
  else
    update public.routines r
       set title        = v_title,
           period       = v_period,
           target_count = p_target_count,
           active       = coalesce(p_active, r.active)
     where r.id       = p_id
       and r.group_id = p_group_id     -- 그룹 이동 금지 (위 주석)
    returning r.id into v_id;
    -- 0행이면 v_id 는 NULL 입니다: 없는 id 이거나 다른 그룹의 루틴.
    -- 조용한 무동작이 맞습니다 -- 어느 쪽인지 알려 주면 루틴 id 를 훑어
    -- 실재 여부를 알아낼 수 있습니다.
  end if;

  return v_id;
end;
$fn$;

alter function public.upsert_routine(uuid, uuid, text, text, integer, boolean) owner to postgres;
revoke all on function public.upsert_routine(uuid, uuid, text, text, integer, boolean)
  from public, anon;
grant execute on function public.upsert_routine(uuid, uuid, text, text, integer, boolean)
  to authenticated;

comment on function public.upsert_routine(uuid, uuid, text, text, integer, boolean) is
  '루틴 생성(p_id=null)/수정. 관리자(private.is_app_admin())이면서 그 그룹의 멤버일 때만 씁니다. '
  '아니면 예외 없이 조용히 NULL 반환(규칙 8 -- 예외를 던지면 특권 계정의 존재와 그룹/루틴 실재 여부가 샙니다). '
  '입력 오류(빈 제목, period 가 week/month 아님, 목표 횟수 범위 밖)는 관리자 인증 통과 뒤에만 도달하며 22023 입니다. '
  '수정 시 group_id 는 바뀌지 않습니다(다른 그룹 id 를 주면 0행 -> NULL). '
  'p_active 는 생성 시 NULL이면 true, 수정 시 NULL이면 기존 값 유지. '
  '★ 반환값만으로 성공을 판단하지 말고 호출 뒤 routines 를 다시 읽으세요.';


-- ───────────────────────────────────────────────────────────────────────────
-- ⑦-b public.set_routine_assignees(p_routine_id uuid, p_user_ids uuid[]) returns void
--
-- 전체 교체 방식입니다: 목록에 없는 배정은 제거하고, 목록에 있는데 없던 사람은
-- 추가합니다. 화면이 체크박스 목록을 통째로 보내는 형태를 전제합니다.
--
-- 【그룹 멤버가 아닌 uuid 는 조용히 무시】
--   추가는 group_members 와 조인해서 넣습니다. 그래서
--     * 그 그룹 멤버가 아닌 uuid  -> 조인에서 빠짐 (에러 아님)
--     * 존재하지 않는 uuid        -> 조인에서 빠짐 (FK 위반 23503 이 안 남)
--     * 같은 uuid 중복            -> group_members PK 덕에 한 번만
--   실패를 예외로 알리면 "그 uuid 는 실재하는 사용자다 / 그 그룹의 멤버다" 가
--   에러 종류로 새어 나갑니다(규칙 8). 화면은 호출 뒤 routine_assignments 를
--   다시 읽어 실제로 배정된 사람으로 그리세요.
--
-- 【routines 행을 FOR UPDATE 로 잠그는 이유】
--   전체 교체는 DELETE + INSERT 두 문입니다. 관리자가 두 탭에서 동시에 저장하면
--   READ COMMITTED 에서 서로의 DELETE 와 INSERT 가 교차해 둘 다 아닌 상태가
--   남을 수 있습니다. 루틴 행 하나를 잠가 커밋까지 직렬화합니다
--   (0001 의 ensure_group_has_owner 가 groups 행을 잠그는 것과 같은 이유).
--
-- p_user_ids 가 NULL 이거나 빈 배열이면 = 전원 배정 해제. 정상 입력입니다.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.set_routine_assignees(
  p_routine_id uuid,
  p_user_ids   uuid[]
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_group uuid;
  v_ids   uuid[];
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;

  -- ── 조용한 거절 구간 (규칙 8). 권한을 **먼저**.
  if not private.is_app_admin() then
    return;
  end if;

  if p_routine_id is null then
    return;
  end if;

  -- 루틴 행을 잠가 동시 교체를 직렬화합니다(위 주석). 없는 루틴이면 0행 -> 무동작.
  select r.group_id into v_group
  from public.routines r
  where r.id = p_routine_id
  for update;

  if not found then
    return;
  end if;

  if not private.is_group_member(v_group) then
    return;
  end if;
  -- ── 여기부터 "관리자이고 그 루틴 그룹의 멤버" 확정.

  -- NULL 원소를 걷어냅니다. 이게 없으면 아래 `<> all (배열)` 이 NULL 을 만나
  -- NULL 을 반환하고, 그 결과 **아무것도 지워지지 않는** 조용한 고장이 됩니다.
  select coalesce(pg_catalog.array_agg(distinct u), '{}'::uuid[])
    into v_ids
  from pg_catalog.unnest(coalesce(p_user_ids, '{}'::uuid[])) as u
  where u is not null;

  -- 3~6명짜리 그룹입니다. 비정상적으로 큰 배열은 여기서 끊습니다
  -- (관리자 인증을 통과한 뒤에만 도달하므로 예외로 알려도 새는 정보가 없습니다).
  -- ⚠ coalesce 는 pg_catalog 함수가 아니라 SQL 구문입니다. 수식하면 문법 오류.
  if coalesce(pg_catalog.array_length(v_ids, 1), 0) > 100 then
    raise exception '한 번에 배정할 수 있는 인원을 넘었습니다(최대 100명).'
      using errcode = '22023';
  end if;

  -- 목록에 없는 배정 제거.
  delete from public.routine_assignments ra
   where ra.routine_id = p_routine_id
     and ra.user_id <> all (v_ids);

  -- 목록에 있고 **그 그룹의 실제 멤버** 인 사람만 추가. (조인이 필터 역할을 합니다.)
  insert into public.routine_assignments (routine_id, user_id)
  select p_routine_id, gm.user_id
  from public.group_members gm
  where gm.group_id = v_group
    and gm.user_id = any (v_ids)
  on conflict (routine_id, user_id) do nothing;
end;
$fn$;

alter function public.set_routine_assignees(uuid, uuid[]) owner to postgres;
revoke all on function public.set_routine_assignees(uuid, uuid[]) from public, anon;
grant execute on function public.set_routine_assignees(uuid, uuid[]) to authenticated;

comment on function public.set_routine_assignees(uuid, uuid[]) is
  '루틴 배정 **전체 교체**. 관리자이면서 그 루틴 그룹의 멤버일 때만. 아니면 조용히 무동작(규칙 8). '
  '그 그룹 멤버가 아니거나 존재하지 않는 uuid 는 조용히 빠집니다(FK 위반으로 실재 여부가 새지 않게 group_members 와 조인해서 넣습니다). '
  'NULL/빈 배열 = 전원 해제(정상 입력). 배정 해제는 routine_checkins 를 지우지 않습니다 -- 기록입니다. '
  '반환이 void 이므로 호출 뒤 routine_assignments 를 다시 읽어 실제 값으로 화면을 그리세요.';


-- ═══════════════════════════════════════════════════════════════════════════
-- ⑧ 본인 전용 RPC
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- ⑧-a public.toggle_routine_checkin(p_routine_id uuid)
--        returns table (checked boolean, done integer, target integer)
--
-- 호출 예 (브라우저):
--   const { data } = await supabase.rpc('toggle_routine_checkin', { p_routine_id: id })
--   -- RETURNS TABLE 이라 data 는 **배열**입니다(규칙 5). data[0] 을 쓰세요.
--   -- [{ checked: true, done: 2, target: 2 }]   done >= target 이면 이번 주기 달성.
--   -- ★ 배열이 비어 있으면(길이 0) 거절된 것입니다 -- 화면을 낙관적으로 갱신했다면
--   --   되돌리세요. 사유는 알려 주지 않습니다(규칙 8).
--
-- 【토글 멱등성】
--   같은 날 두 번 누르면 체크 -> 해제입니다. 두 행이 생기지 않습니다. 세 겹입니다:
--     1) 이 함수가 (routine, user) 쌍에 트랜잭션 자문 잠금을 잡아 동시 호출을
--        직렬화합니다. 세기 전에 잡아야 의미가 있습니다(0001 send_nudge 와 동일).
--     2) DELETE 를 먼저 시도하고 rowcount 를 봅니다. 지워졌으면 해제, 없었으면 삽입.
--        "먼저 SELECT 하고 분기" 보다 문이 하나 적고 원자적입니다.
--     3) unique(routine_id, user_id, checked_on) 이 최종 방어선입니다.
--
-- 【거절은 전부 0행 (규칙 8)】
--   없는 루틴 / 비활성 루틴 / 나에게 배정되지 않은 루틴 / 내가 나간 그룹의 루틴
--   -> 전부 조용히 0행입니다. 예외를 던지면 루틴 id 를 훑어 실재 여부와 활성
--   여부를 알아낼 수 있습니다.
--   ★ 정상 경로는 화면이 애초에 그 루틴을 안 보여주는 것입니다 ★ --
--     get_my_routines 가 "지금 나에게 배정된 활성 루틴" 만 돌려줍니다.
--     0행은 그 화면을 우회했거나, 목록을 띄운 뒤 관리자가 배정을 해제한 경우입니다.
--
-- 반환값의 done/target 은 **이번 주기** 기준입니다. period='week' 면 이번 주
-- (월~일), 'month' 면 이번 달(1일~말일)의 체크 수이고, 기준 날짜는 사용자 로컬
-- 날짜입니다. 계산은 private.routine_period_progress 한 곳에만 있습니다.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.toggle_routine_checkin(p_routine_id uuid)
returns table (checked boolean, done integer, target integer)
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_uid     uuid := (select auth.uid());
  v_routine public.routines;
  v_today   date;
  v_checked boolean;
  v_done    integer;
  v_n       integer;
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;

  if p_routine_id is null then
    return;   -- 0행
  end if;

  -- 비활성 루틴은 여기서 걸립니다(and r.active). 화면에도 안 뜨는 것이 정상입니다.
  select r.* into v_routine
  from public.routines r
  where r.id = p_routine_id
    and r.active;

  if not found then
    return;   -- 없거나 비활성. 조용히 0행.
  end if;

  -- 나에게 배정된 루틴인가. SECURITY DEFINER 라 RLS 가 걸리지 않으므로 직접 확인.
  if not exists (
    select 1
    from public.routine_assignments ra
    where ra.routine_id = p_routine_id
      and ra.user_id    = v_uid
  ) then
    return;   -- 조용히 0행
  end if;

  -- 아직 그 그룹의 멤버인가. ⑥ 트리거가 탈퇴 시 배정을 지우므로 보통은 위에서
  -- 이미 걸리지만, 트리거가 비활성이거나 미래에 배정 정리 규칙이 바뀌어도
  -- "나간 그룹의 루틴을 체크" 가 생기지 않게 두 겹으로 둡니다.
  if not private.is_group_member(v_routine.group_id) then
    return;   -- 조용히 0행
  end if;

  -- ===== 원자성 경계 시작 =====
  -- (routine, user) 쌍마다 하나의 잠금. 커밋/롤백 시 자동 해제됩니다.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_routine_id::text || '>' || v_uid::text, 0::bigint)
  );

  -- ★ 사용자 로컬 날짜 ★ 서버 UTC(current_date)를 쓰면 한국 시간 자정~오전 9시의
  --   체크가 전날로 기록되고 주 경계까지 밀립니다(규칙 4).
  v_today := public.current_user_local_date();

  delete from public.routine_checkins c
   where c.routine_id = p_routine_id
     and c.user_id    = v_uid
     and c.checked_on = v_today;

  get diagnostics v_n = row_count;

  if v_n > 0 then
    v_checked := false;                    -- 있던 체크를 해제했습니다.
  else
    insert into public.routine_checkins (routine_id, user_id, checked_on)
    values (p_routine_id, v_uid, v_today);
    v_checked := true;
  end if;

  -- 진행 계산은 단일 진실 함수로. (잠금 안에서 세므로 방금 쓴 값이 반영됩니다.)
  v_done := private.routine_period_progress(
              p_routine_id, v_uid, v_routine.period, v_today);
  -- ===== 원자성 경계 끝 =====

  return query select v_checked, v_done, v_routine.target_count;
end;
$fn$;

alter function public.toggle_routine_checkin(uuid) owner to postgres;
revoke all on function public.toggle_routine_checkin(uuid) from public, anon;
grant execute on function public.toggle_routine_checkin(uuid) to authenticated;

comment on function public.toggle_routine_checkin(uuid) is
  '오늘 날짜(사용자 로컬)로 체크 토글. 본인만 -- 대상을 인자로 받지 않고 항상 auth.uid() 입니다. '
  'returns table (checked boolean, done integer, target integer) -- PostgREST 에서는 배열이므로 data[0] (규칙 5). '
  'done/target 은 **이번 주기**(week=월~일, month=1일~말일) 기준이고 계산은 private.routine_period_progress 한 곳입니다. '
  '없는/비활성/미배정/나간 그룹의 루틴은 예외가 아니라 **0행**입니다(규칙 8) -- 배열이 비면 화면을 되돌리세요. '
  '같은 날 두 번 눌러도 두 행이 생기지 않습니다(자문 잠금 + unique(routine_id,user_id,checked_on)).';


-- ───────────────────────────────────────────────────────────────────────────
-- ⑧-b public.get_my_routines()
--        returns table (
--          routine_id    uuid,     -- toggle_routine_checkin 에 그대로 넘기는 값
--          group_id      uuid,     -- 화면이 현재 그룹으로 필터할 때 씁니다
--          title         text,     -- 루틴 제목
--          period        text,     -- 'week' | 'month'
--          target_count  integer,  -- 목표 횟수
--          done_count    integer,  -- 이번 주기에 체크한 횟수 (달성 = done_count >= target_count)
--          checked_today boolean,  -- 오늘 체크했는가 (버튼의 on/off 상태)
--          period_start  date,     -- 이번 주기 첫날 (진행 막대 라벨용)
--          period_end    date      -- 이번 주기 마지막날 (포함)
--        )
--
-- 호출 예 (브라우저):
--   const { data } = await supabase.rpc('get_my_routines')   // 배열 (규칙 5)
--   // data.filter(r => r.group_id === currentGroupId)
--   //     .map(r => `${r.title} ${r.done_count}/${r.target_count}`)
--
-- 【반환 컬럼을 이렇게 정한 근거】
--   * achieved(달성 여부)를 넣지 않았습니다. done_count >= target_count 로 화면에서
--     계산하면 되고, 서버가 파생값을 함께 보내면 둘이 어긋날 때가 반드시 옵니다.
--   * today 를 넣지 않았습니다. checked_today 가 "오늘" 에 대한 판정을 이미 담고
--     있고, 사용자 로컬 날짜는 period_start/end 로도 유추됩니다.
--   * group_id 는 넣었습니다. 이 앱은 그룹 전환이 있고(0007), 인자 없는 RPC 라
--     여러 그룹의 루틴이 한 번에 옵니다. 화면이 필터하려면 필요합니다.
--   * period_start/period_end 는 넣었습니다. "9/1~9/7 중 2번" 같은 라벨을 그리려면
--     클라이언트가 주 경계를 다시 계산해야 하는데, 그러면 월요일 시작 규칙이
--     TypeScript 에 한 벌 더 생깁니다. 서버가 정한 경계를 그대로 내려보냅니다.
--
-- 【무엇을 돌려주고 무엇을 빼는가】
--   포함: 지금 나에게 배정된 + active 인 + 내가 아직 멤버인 그룹의 루틴.
--   제외: 비활성 루틴(관리자가 껐음), 배정 해제된 루틴, 내가 나간 그룹의 루틴.
--     ▶ 이 목록의 의미가 "오늘 내가 체크할 것" 이기 때문입니다. 체크할 수 없는
--       항목을 섞으면 toggle 이 0행을 돌려주는 것과 화면이 어긋납니다.
--     ▶ ★ 제외된 루틴의 과거 routine_checkins 는 지우지 않습니다 ★ -- 기록입니다.
--       "지난 기록 보기" 가 필요해지면 routine_checkins 를 직접 조회하세요
--       (SELECT 정책이 같은 그룹 멤버에게 이미 열려 있습니다).
--
-- 정렬은 created_at, id 입니다. 목록 순서가 새로고침마다 흔들리지 않게 하려는
-- 것이고, id 를 붙인 것은 created_at 동률(같은 트랜잭션 생성)에서도 결정적이게
-- 하기 위해서입니다.
--
-- language sql / stable: 부수효과가 없고 한 트랜잭션 안에서 값이 변하지 않습니다.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.get_my_routines()
returns table (
  routine_id    uuid,
  group_id      uuid,
  title         text,
  period        text,
  target_count  integer,
  done_count    integer,
  checked_today boolean,
  period_start  date,
  period_end    date
)
language sql
stable
security definer
set search_path = ''
as $fn$
  with me as (
    select
      (select auth.uid())                as uid,
      public.current_user_local_date()   as today
  )
  select
    r.id,
    r.group_id,
    r.title,
    r.period,
    r.target_count,
    -- 이번 주기 진행. toggle 이 쓰는 것과 **같은 함수** 입니다(단일 진실).
    private.routine_period_progress(r.id, me.uid, r.period, me.today),
    exists (
      select 1
      from public.routine_checkins c
      where c.routine_id = r.id
        and c.user_id    = me.uid
        and c.checked_on = me.today
    ),
    private.routine_period_start(r.period, me.today),
    private.routine_period_end(
      r.period,
      private.routine_period_start(r.period, me.today))
  from me
  join public.routine_assignments ra on ra.user_id = me.uid
  join public.routines            r  on r.id       = ra.routine_id
  where me.uid is not null            -- 로그인 안 했으면 0행 (예외 아님)
    and r.active
    -- 내가 아직 멤버인 그룹의 루틴만. 멤버십 읽기는 SECURITY DEFINER 헬퍼 안에서.
    and r.group_id in (select private.current_user_group_ids())
  order by r.created_at, r.id;
$fn$;

alter function public.get_my_routines() owner to postgres;
revoke all on function public.get_my_routines() from public, anon;
grant execute on function public.get_my_routines() to authenticated;

comment on function public.get_my_routines() is
  '내게 배정된 활성 루틴 + 이번 주기 진행. 인자 없음 = 남의 목록을 물어볼 수 없습니다. '
  'returns table (routine_id uuid, group_id uuid, title text, period text, target_count integer, '
  'done_count integer, checked_today boolean, period_start date, period_end date) -- '
  'PostgREST 에서는 배열입니다(규칙 5). 달성 여부는 done_count >= target_count 로 화면에서 계산하세요. '
  '주기 경계(week=월요일 시작, month=달력 월)와 "오늘" 은 서버가 사용자 타임존으로 계산해 내려보냅니다 -- '
  '클라이언트가 다시 계산하지 마세요(요일 규칙이 두 벌이 되면 어긋납니다). '
  '비활성/미배정/나간 그룹의 루틴은 빠지지만 그 체크 기록은 지워지지 않습니다.';


-- ═══════════════════════════════════════════════════════════════════════════
-- ⑨ Realtime -- routine_checkins 만
--
-- 친구가 방금 체크한 것이 내 화면에 바로 뜨는 것이 이 기능의 재미입니다
-- (0006 이 tasks 에 대해 내린 것과 같은 판단).
-- routines / routine_assignments 는 넣지 않습니다 -- 관리자가 가끔 고치는 값이라
-- 실시간일 이유가 없고, publication 에 넣는 순간 아래 DELETE 문제를 떠안습니다.
--
-- ⚠ Realtime 은 SELECT 에 대해서는 RLS 를 존중하지만 **DELETE 이벤트는 아닙니다**.
--   위에서 replica identity 를 DEFAULT(PK만)로 둔 이유이고, 그래서 체크 해제가
--   방송해도 나가는 것은 uuid 하나뿐입니다. FULL 로 바꾸지 마세요.
-- ═══════════════════════════════════════════════════════════════════════════
do $do$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public' and tablename = 'routine_checkins'
    ) then
      alter publication supabase_realtime add table public.routine_checkins;
    end if;
  end if;
end
$do$;


-- ═══════════════════════════════════════════════════════════════════════════
-- ⑩ 자체 점검 -- 실행되는 형태 (0006 / 0008 / 0009 와 같은 방식)
--
-- 이 파일에서 조용히 고장 날 수 있는 것은 **주기 계산** 입니다. 카탈로그는
-- "함수가 있다" 까지만 말하고, 주 경계가 하루 밀린 상태는 카탈로그에 아무
-- 흔적도 남기지 않습니다. 사용자에게는 "분명히 두 번 갔는데 진행이 1" 로만
-- 보이고, 그 시점에는 이미 몇 주치 데이터가 쌓여 있습니다.
--
-- 그래서 (6) 은 실제 그룹/사용자에 루틴과 체크인을 **넣어 보고** 경계 바로 안쪽/
-- 바깥쪽이 정확히 세어지는지 확인한 뒤, sentinel 예외로 전부 되돌립니다.
-- 성공 경로든 실패 경로든 커밋되는 행은 하나도 없습니다.
--
-- ⚠ sentinel SQLSTATE 를 'ZR000' 같은 값으로 "정리" 하지 마세요. 끝 세 자리가
--   000 인 코드는 개별 코드가 아니라 **클래스** 이고, 그러면 롤백 핸들러가
--   실패 신호까지 삼켜서 계산이 완전히 틀려도 점검이 통과합니다(0008 의 기록).
--   두 코드 모두 000 으로 끝나지 않고, 실패 핸들러를 **먼저** 씁니다.
-- ═══════════════════════════════════════════════════════════════════════════
do $check$
declare
  v_d       date;
  v_ws      date;
  v_we      date;
  v_ms      date;
  v_me      date;
  v_anchor  date;
  v_group   uuid;
  v_user    uuid;
  v_rw      uuid;
  v_rm      uuid;
  v_done    integer;
  v_txt     text;
  v_res     text;
  v_tbl     text;
  v_hit     boolean;
  v_skip    text := null;
begin
  -- ─────────────────────────────────────────────────────────────────────
  -- (1) 주 경계 = 월요일 시작인가. 달 경계 = 달력 월인가.
  --     5년치(윤년 2024/2028, ISO 주가 연도를 넘는 12월/1월 포함)를 하루씩
  --     돌면서 불변식을 확인합니다. 순수 함수라 롤백이 필요 없습니다.
  -- ─────────────────────────────────────────────────────────────────────
  for v_d in
    -- ::timestamp 로 명시 캐스팅합니다. date 를 그냥 넘기면 timestamp /
    -- timestamptz 두 오버로드 중 어느 쪽으로 풀릴지가 암묵 캐스팅에 달리고,
    -- timestamptz 쪽으로 풀리면 세션 타임존이 이 점검 결과에 끼어듭니다.
    select g::date
    from pg_catalog.generate_series(
           date '2024-01-01'::timestamp,
           date '2028-12-31'::timestamp,
           interval '1 day') as g
  loop
    v_ws := private.routine_period_start('week', v_d);
    v_we := private.routine_period_end('week', v_ws);

    -- ★ 월요일 시작의 정의 그 자체 ★
    if v_ws is distinct from (v_d - (pg_catalog.date_part('isodow', v_d::timestamp)::int - 1)) then
      raise exception
        '[점검 실패] %(isodow=%) 이 속한 주의 시작이 % 입니다. 월요일 시작이면 % 여야 합니다. '
        'private.routine_period_start 의 date_trunc(''week'') 가 ISO(월요일) 가 아닌 '
        '동작을 하고 있습니다.',
        v_d, pg_catalog.date_part('isodow', v_d::timestamp)::int, v_ws,
        v_d - (pg_catalog.date_part('isodow', v_d::timestamp)::int - 1);
    end if;

    if pg_catalog.date_part('isodow', v_ws::timestamp)::int <> 1 then
      raise exception '[점검 실패] 주 시작 % 의 요일이 월요일이 아닙니다(isodow=%).',
        v_ws, pg_catalog.date_part('isodow', v_ws::timestamp)::int;
    end if;

    if v_we is distinct from v_ws + 6 then
      raise exception '[점검 실패] 주 경계가 7일이 아닙니다: % ~ %.', v_ws, v_we;
    end if;

    if v_d < v_ws or v_d > v_we then
      raise exception '[점검 실패] % 가 자기 주 경계 [%, %] 밖에 있습니다.', v_d, v_ws, v_we;
    end if;

    v_ms := private.routine_period_start('month', v_d);
    v_me := private.routine_period_end('month', v_ms);

    if pg_catalog.date_part('day', v_ms::timestamp)::int <> 1 then
      raise exception '[점검 실패] 월 시작이 1일이 아닙니다: %.', v_ms;
    end if;

    if v_d < v_ms or v_d > v_me then
      raise exception '[점검 실패] % 가 자기 달 경계 [%, %] 밖에 있습니다 '
        '(달력 월이 아니라 이동창으로 바뀌었는지 확인하세요).', v_d, v_ms, v_me;
    end if;

    if (v_me + 1) is distinct from (v_ms + interval '1 month')::date then
      raise exception '[점검 실패] 달 마지막날이 말일이 아닙니다: % ~ %.', v_ms, v_me;
    end if;
  end loop;

  -- 사람이 눈으로 확인할 수 있는 앵커 하나. 2026-01-04 는 일요일이고,
  -- 월요일 시작이면 그 주는 **전년도** 2025-12-29 에 시작합니다.
  -- (일요일 시작 달력이면 2026-01-04 자신이 나옵니다 -- 정확히 그 버그입니다.)
  if pg_catalog.date_part('isodow', date '2026-01-04'::timestamp)::int <> 7 then
    raise exception
      '[점검 실패] 달력 가정이 깨졌습니다: 2026-01-04 의 isodow 가 % 입니다(7=일요일 기대).',
      pg_catalog.date_part('isodow', date '2026-01-04'::timestamp)::int;
  end if;
  if private.routine_period_start('week', date '2026-01-04') <> date '2025-12-29' then
    raise exception
      '[점검 실패] 일요일 2026-01-04 이 속한 주의 시작이 % 입니다. 월요일 시작이면 '
      '2025-12-29 여야 합니다. (2026-01-04 이 나왔다면 일요일 시작 달력입니다 -- '
      '일요일 밤에 한 체크가 다음 주로 넘어가는 바로 그 버그입니다.)',
      private.routine_period_start('week', date '2026-01-04');
  end if;

  -- 알 수 없는 period 는 NULL (예외 아님)
  if private.routine_period_start('quarter', date '2026-01-04') is not null then
    raise exception '[점검 실패] 알 수 없는 period 가 NULL 이 아닙니다.';
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (2) RPC 네 개: security definer / owner=postgres / search_path='' /
  --     반환 시그니처가 **타입까지** 고정 / anon 실행 불가 / authenticated 가능
  --
  --     반환 시그니처를 타입까지 보는 이유는 0006 의 기록 그대로입니다.
  --     컬럼 이름만 비교하면 done_count 를 integer 에서 numeric 으로 바꿔도
  --     통과하고, TypeScript 는 그대로 씁니다.
  -- ─────────────────────────────────────────────────────────────────────
  foreach v_txt in array array[
    'public.upsert_routine(uuid, uuid, text, text, integer, boolean)',
    'public.set_routine_assignees(uuid, uuid[])',
    'public.toggle_routine_checkin(uuid)',
    'public.get_my_routines()'
  ] loop
    if pg_catalog.to_regprocedure(v_txt) is null then
      raise exception '[점검 실패] % 가 없습니다.', v_txt;
    end if;

    if not exists (
      select 1
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
      where p.oid = v_txt::regprocedure
        and p.prosecdef
        and r.rolname = 'postgres'
        and exists (
          select 1
          from pg_catalog.unnest(coalesce(p.proconfig, '{}'::text[])) as cfg
          where cfg like 'search_path=%'
            and pg_catalog.btrim(pg_catalog.split_part(cfg, '=', 2), '''"') = ''
        )
    ) then
      raise exception
        '[점검 실패] % 가 (security definer / owner=postgres / set search_path = '''') '
        '세 조건을 모두 만족하지 않습니다. 현재 값: %',
        v_txt,
        (select format('prosecdef=%s, owner=%s, proconfig=%s',
                       p.prosecdef,
                       (select r2.rolname from pg_catalog.pg_roles r2 where r2.oid = p.proowner),
                       coalesce(p.proconfig::text, '(없음)'))
           from pg_catalog.pg_proc p where p.oid = v_txt::regprocedure);
    end if;

    if has_function_privilege('anon', v_txt, 'execute') then
      raise exception '[점검 실패] anon 이 % 를 실행할 수 있습니다.', v_txt;
    end if;
    if not has_function_privilege('authenticated', v_txt, 'execute') then
      raise exception '[점검 실패] authenticated 가 % 를 실행할 수 없습니다.', v_txt;
    end if;
  end loop;

  select pg_catalog.pg_get_function_result(
           'public.toggle_routine_checkin(uuid)'::regprocedure) into v_res;
  if v_res is distinct from 'TABLE(checked boolean, done integer, target integer)' then
    raise exception
      '[점검 실패] toggle_routine_checkin 의 반환 시그니처가 "%" 입니다. '
      '"TABLE(checked boolean, done integer, target integer)" 여야 합니다 '
      '-- TypeScript 가 이 이름과 타입을 그대로 씁니다.', v_res;
  end if;

  select pg_catalog.pg_get_function_result(
           'public.get_my_routines()'::regprocedure) into v_res;
  if v_res is distinct from
     'TABLE(routine_id uuid, group_id uuid, title text, period text, target_count integer, '
     || 'done_count integer, checked_today boolean, period_start date, period_end date)' then
    raise exception
      '[점검 실패] get_my_routines 의 반환 시그니처가 "%" 입니다. 계약과 다릅니다 '
      '-- TypeScript 가 이 이름과 타입을 그대로 씁니다.', v_res;
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (3) 관리자 가드가 **본문에** 남아 있는가 (주석 제외)
  --     시그니처와 실행 컨텍스트만 보면, 누가 create or replace 하면서
  --     is_app_admin 검사만 지워도 (2) 가 전부 통과합니다. SECURITY DEFINER 는
  --     RLS 를 우회하므로 그 순간 아무 인증 사용자나 남의 그룹에 루틴을 심습니다.
  --     ※ 주석을 먼저 걷어냅니다 -- 본문 주석에도 is_app_admin 이라는 말이
  --        나오기 때문에 이름만 찾으면 가드를 지워도 주석이 통과시켜 줍니다
  --        (0006 이 실제로 그렇게 당했습니다).
  -- ─────────────────────────────────────────────────────────────────────
  foreach v_txt in array array[
    'public.upsert_routine(uuid, uuid, text, text, integer, boolean)',
    'public.set_routine_assignees(uuid, uuid[])'
  ] loop
    if regexp_replace(
         (select p.prosrc from pg_catalog.pg_proc p where p.oid = v_txt::regprocedure),
         '--[^' || chr(10) || ']*', '', 'g')
       not like '%private.is_app_admin()%' then
      raise exception
        '[점검 실패] % 본문(주석 제외)에 private.is_app_admin() 호출이 없습니다. '
        'SECURITY DEFINER 는 RLS 를 우회하므로 이 가드가 없으면 아무 인증 사용자나 '
        '루틴을 만들고 남에게 배정할 수 있습니다.', v_txt;
    end if;
  end loop;

  -- 본인 전용 함수는 auth.uid() 밖에 신원 근거가 없어야 합니다.
  if regexp_replace(
       (select p.prosrc from pg_catalog.pg_proc p
         where p.oid = 'public.toggle_routine_checkin(uuid)'::regprocedure),
       '--[^' || chr(10) || ']*', '', 'g')
     not like '%auth.uid()%' then
    raise exception
      '[점검 실패] toggle_routine_checkin 본문(주석 제외)에 auth.uid() 가 없습니다. '
      '체크인의 주인이 호출자 자신이라는 근거가 사라졌습니다.';
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (4) 헬퍼 권한: 조준 가능한 progress 는 닫혀 있고, 정책이 쓰는 헬퍼는 열려야 함
  -- ─────────────────────────────────────────────────────────────────────
  foreach v_txt in array array['anon', 'authenticated'] loop
    if has_function_privilege(
         v_txt, 'private.routine_period_progress(uuid, uuid, text, date)', 'execute') then
      raise exception
        '[점검 실패] % 이 private.routine_period_progress 를 실행할 수 있습니다. '
        '이 함수는 p_user_id 를 인자로 받는 조준 가능한 모양이라 반드시 닫혀 있어야 '
        '합니다(호출자는 postgres 소유 DEFINER 함수 두 개뿐입니다).', v_txt;
    end if;
  end loop;

  if not has_function_privilege('authenticated', 'private.is_routine_visible(uuid)', 'execute') then
    raise exception
      '[점검 실패] authenticated 가 private.is_routine_visible 를 실행할 수 없습니다. '
      '정책 식은 질의하는 역할로 평가되므로, EXECUTE 가 없으면 routine_assignments / '
      'routine_checkins 조회가 42501 로 통째로 실패합니다(보안이 아니라 기능 정지).';
  end if;
  if has_function_privilege('anon', 'private.is_routine_visible(uuid)', 'execute') then
    raise exception '[점검 실패] anon 이 private.is_routine_visible 를 실행할 수 있습니다.';
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (5) 테이블: RLS 켜짐 / FORCE 꺼짐 / 읽기만 열림 / checked_on DEFAULT / 정책 식
  -- ─────────────────────────────────────────────────────────────────────
  foreach v_tbl in array array[
    'public.routines', 'public.routine_assignments', 'public.routine_checkins'
  ] loop
    if not exists (
      select 1 from pg_catalog.pg_class c
      where c.oid = v_tbl::regclass and c.relrowsecurity
    ) then
      raise exception '[점검 실패] % 에 RLS 가 꺼져 있습니다.', v_tbl;
    end if;

    -- FORCE 는 테이블 소유자에게도 RLS 를 적용해서 private.* DEFINER 헬퍼의
    -- 우회 근거를 무너뜨립니다(0001 의 경고). 켜지 마세요.
    if exists (
      select 1 from pg_catalog.pg_class c
      where c.oid = v_tbl::regclass and c.relforcerowsecurity
    ) then
      raise exception
        '[점검 실패] % 에 FORCE ROW LEVEL SECURITY 가 켜져 있습니다. '
        'postgres 소유 SECURITY DEFINER 헬퍼가 RLS 를 우회하지 못하게 되어 '
        '42P17 재귀가 되살아납니다.', v_tbl;
    end if;

    if not has_table_privilege('authenticated', v_tbl, 'SELECT') then
      raise exception '[점검 실패] authenticated 가 % 를 읽을 수 없습니다.', v_tbl;
    end if;
    if has_table_privilege('anon', v_tbl, 'SELECT') then
      raise exception '[점검 실패] anon 이 % 를 읽을 수 있습니다.', v_tbl;
    end if;

    -- 쓰기 권한은 **없어야** 합니다. 컬럼 단위로 몰래 열리는 경우까지 보려고
    -- has_any_column_privilege 를 씁니다(has_table_privilege 는 컬럼 GRANT 를
    -- 못 봅니다 -- 이게 0002 의 컬럼 단위 GRANT 를 쓰는 프로젝트에서 중요합니다).
    if has_any_column_privilege('authenticated', v_tbl, 'INSERT')
       or has_any_column_privilege('authenticated', v_tbl, 'UPDATE')
       or has_table_privilege('authenticated', v_tbl, 'DELETE') then
      raise exception
        '[점검 실패] authenticated 가 % 에 쓰기 권한을 갖고 있습니다. '
        '이 세 테이블의 쓰기 문은 RPC 뿐입니다(upsert_routine / set_routine_assignees / '
        'toggle_routine_checkin). 권한이 열리면 관리자 판정과 하루-한-번 규칙을 '
        '통째로 우회할 수 있습니다.', v_tbl;
    end if;
  end loop;

  -- checked_on 의 DEFAULT 가 서버 UTC 로 바뀌지 않았는가 (규칙 4)
  select pg_catalog.pg_get_expr(d.adbin, d.adrelid) into v_txt
  from pg_catalog.pg_attrdef d
  join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
  where d.adrelid = 'public.routine_checkins'::regclass
    and a.attname = 'checked_on';

  if coalesce(v_txt, '') not like '%current_user_local_date%' then
    raise exception
      '[점검 실패] routine_checkins.checked_on 의 DEFAULT 가 "%" 입니다. '
      'public.current_user_local_date() 여야 합니다 -- current_date(서버 UTC)로 바뀌면 '
      '한국 시간 자정~오전 9시의 체크가 전날로 기록되고 주 경계까지 밀립니다(규칙 4).',
      coalesce(v_txt, '(없음)');
  end if;

  -- 정책 식이 보호 대상 테이블을 직접 읽지 않는가 (42P17 감시, 규칙 1)
  for v_txt, v_res in
    select p.polname::text,
           coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '')
    from pg_catalog.pg_policy p
    where p.polrelid in ('public.routines'::regclass,
                         'public.routine_assignments'::regclass,
                         'public.routine_checkins'::regclass)
  loop
    if v_res like '%group_members%' or v_res like '%FROM routine%' then
      raise exception
        '[점검 실패] 정책 % 의 식이 테이블을 직접 읽습니다: [%]. '
        '멤버십/가시성 조회는 반드시 private.* SECURITY DEFINER 헬퍼를 경유해야 '
        '합니다(규칙 1 -- 인라인하면 42P17).', v_txt, v_res;
    end if;
    if v_res not like '%private.%' and v_res not like '%auth.uid()%' then
      raise exception '[점검 실패] 정책 % 의 식에 아무 가드가 없습니다: [%].', v_txt, v_res;
    end if;
  end loop;

  -- ─────────────────────────────────────────────────────────────────────
  -- (6) ★ 주기 계산이 **실제로** 맞는가 -- 넣어 보고 전부 롤백 ★
  --
  --     (1) 은 순수 함수의 불변식만 봅니다. 실제로 세는 질의가 경계를 제대로
  --     쓰는지는 다른 명제입니다. 예를 들어 `checked_on < period_end` 처럼
  --     끝을 배타적으로 쓰면 (1) 은 전부 통과하고 **일요일 체크만 조용히
  --     사라집니다**. 사용자에게는 "일요일에 간 건 왜 안 세지?" 로만 보이고
  --     카탈로그에는 아무 흔적도 없습니다.
  --
  --     그래서 여기서는 경계 바로 안쪽(첫날/마지막날)과 바로 바깥쪽(전날/다음날)에
  --     체크인을 하나씩 심고, 정확히 2가 나오는지 봅니다. 그리고 앵커를 옆
  --     주기로 옮기면 바깥쪽 것만 1로 세어지는지도 확인합니다.
  --
  --     사용자의 예시 그대로입니다: period='week', target_count=2 인 루틴에
  --     그 주 안에 2번 체크 -> 달성.
  --
  --     ⚠ auth.uid() 가 null 인 postgres 컨텍스트라서 RPC(toggle/get_my_routines)의
  --       "본인만" 경로는 여기서 실행되지 않습니다. 그건 파일 끝의 「수동 확인」
  --       몫입니다. 여기서 검증하는 것은 두 RPC 가 공유하는 계산 엔진
  --       private.routine_period_progress 입니다 -- 틀리면 둘 다 틀립니다.
  -- ─────────────────────────────────────────────────────────────────────
  select gm.group_id, gm.user_id into v_group, v_user
  from public.group_members gm
  order by gm.group_id, gm.user_id
  limit 1;

  if v_group is null then
    raise warning
      '[0011] group_members 가 비어 있어 주기 계산 실증(6)을 건너뜁니다. '
      '순수 함수 불변식(1)만 확인된 상태입니다 -- 그룹이 생긴 뒤 이 마이그레이션을 '
      '다시 실행하면 실증까지 돕니다.';
  else
    begin
      -- 앵커는 아무 날이나 됩니다. 아래 계산이 전부 이 값에서 파생됩니다.
      v_anchor := date '2026-06-17';

      -- ── 주 루틴: 사용자의 예시 그대로 (일주일에 두 번)
      insert into public.routines (group_id, title, period, target_count, active)
      values (v_group, '__0011 자체점검(주)__', 'week', 2, true)
      returning id into v_rw;

      insert into public.routine_assignments (routine_id, user_id)
      values (v_rw, v_user);

      v_ws := private.routine_period_start('week', v_anchor);
      v_we := private.routine_period_end('week', v_ws);

      insert into public.routine_checkins (routine_id, user_id, checked_on) values
        (v_rw, v_user, v_ws),        -- 그 주 월요일        -> 세야 함
        (v_rw, v_user, v_we),        -- 그 주 일요일(마지막) -> 세야 함  ★ 여기가 핵심 ★
        (v_rw, v_user, v_ws - 1),    -- 지난 주 일요일       -> 세면 안 됨
        (v_rw, v_user, v_we + 1);    -- 다음 주 월요일       -> 세면 안 됨

      v_done := private.routine_period_progress(v_rw, v_user, 'week', v_anchor);
      if v_done <> 2 then
        raise exception using errcode = 'ZR901', message = format(
          '[점검 실패] 주 경계 [%s, %s] 안에 정확히 2건을 넣었는데 %s 로 세었습니다. '
          '(3이면 경계 바깥 하루를 끌어온 것이고, 1이면 마지막날(일요일)을 빠뜨린 것 '
          '-- checked_on <= period_end 가 아니라 < 로 바뀌었는지 확인하세요.)',
          v_ws, v_we, v_done);
      end if;

      -- 사용자의 예시: target_count=2 이므로 이번 주는 달성이어야 합니다.
      if not (v_done >= 2) then
        raise exception using errcode = 'ZR901', message =
          '[점검 실패] 일주일에 두 번 목표를 두 번 채웠는데 달성이 아닙니다.';
      end if;

      -- 옆 주기로 앵커를 옮기면 바깥쪽 것만 세어져야 합니다(경계가 실제로 이동하는가).
      v_done := private.routine_period_progress(v_rw, v_user, 'week', v_we + 1);
      if v_done <> 1 then
        raise exception using errcode = 'ZR901', message = format(
          '[점검 실패] 다음 주(%s 기준)의 진행이 %s 입니다. 1 이어야 합니다 '
          '-- 주기 경계가 앵커를 따라 움직이지 않습니다.', v_we + 1, v_done);
      end if;
      v_done := private.routine_period_progress(v_rw, v_user, 'week', v_ws - 1);
      if v_done <> 1 then
        raise exception using errcode = 'ZR901', message = format(
          '[점검 실패] 지난 주(%s 기준)의 진행이 %s 입니다. 1 이어야 합니다.',
          v_ws - 1, v_done);
      end if;

      -- ── 월 루틴: 달력 월인가 (1일과 말일이 같은 주기, 전달 말일/다음달 1일은 아님)
      insert into public.routines (group_id, title, period, target_count, active)
      values (v_group, '__0011 자체점검(월)__', 'month', 2, true)
      returning id into v_rm;

      insert into public.routine_assignments (routine_id, user_id)
      values (v_rm, v_user);

      v_ms := private.routine_period_start('month', v_anchor);
      v_me := private.routine_period_end('month', v_ms);

      insert into public.routine_checkins (routine_id, user_id, checked_on) values
        (v_rm, v_user, v_ms),        -- 1일    -> 세야 함
        (v_rm, v_user, v_me),        -- 말일   -> 세야 함
        (v_rm, v_user, v_ms - 1),    -- 전달 말일   -> 세면 안 됨
        (v_rm, v_user, v_me + 1);    -- 다음달 1일  -> 세면 안 됨

      v_done := private.routine_period_progress(v_rm, v_user, 'month', v_anchor);
      if v_done <> 2 then
        raise exception using errcode = 'ZR901', message = format(
          '[점검 실패] 달 경계 [%s, %s] 안에 정확히 2건을 넣었는데 %s 로 세었습니다 '
          '(달력 월이 아니라 30일 이동창으로 바뀌었는지 확인하세요).', v_ms, v_me, v_done);
      end if;

      -- 두 루틴의 체크인이 서로 섞이지 않는가 (routine_id 필터가 살아 있는가).
      -- 월 루틴의 체크인 4건은 모두 이번 주 [v_ws, v_we] 밖이므로 0 이어야 합니다.
      -- routine_id 필터가 빠지면 주 루틴의 2건이 여기로 새어 들어옵니다.
      v_done := private.routine_period_progress(v_rm, v_user, 'week', v_anchor);
      if v_done <> 0 then
        raise exception using errcode = 'ZR901', message = format(
          '[점검 실패] 월 루틴의 이번 주 진행이 %s 입니다. 0 이어야 합니다 '
          '-- 다른 루틴의 체크인까지 함께 세고 있습니다(routine_id 필터 없음).', v_done);
      end if;

      -- ── 하루 두 번 = 두 행 금지 (토글 멱등성의 DB 근거)
      v_hit := false;
      begin
        insert into public.routine_checkins (routine_id, user_id, checked_on)
        values (v_rw, v_user, v_ws);
      exception when unique_violation then
        v_hit := true;
      end;
      if not v_hit then
        raise exception using errcode = 'ZR901', message =
          '[점검 실패] 같은 (루틴, 사용자, 날짜) 로 두 번째 체크인이 들어갔습니다. '
          'unique(routine_id, user_id, checked_on) 이 사라졌습니다 -- 토글이 두 번 '
          '눌리면 해제가 아니라 행이 두 개 생기고 진행이 2배로 셉니다.';
      end if;

      -- ── 달성 불가능한 목표를 스키마가 막는가 (일주일에 8번)
      v_hit := false;
      begin
        insert into public.routines (group_id, title, period, target_count)
        values (v_group, '__0011 자체점검(불가)__', 'week', 8);
      exception when check_violation then
        v_hit := true;
      end;
      if not v_hit then
        raise exception using errcode = 'ZR901', message =
          '[점검 실패] period=''week'', target_count=8 이 저장되었습니다. '
          '일주일에 체크할 수 있는 날은 7일뿐이라 영원히 안 차는 진행 막대가 됩니다 '
          '-- routines_target_count_chk 를 확인하세요.';
      end if;

      -- 여기까지 왔으면 통과. 넣은 행을 되돌리기 위해 일부러 던집니다.
      raise exception using errcode = 'ZR801', message = 'rollback sentinel';

    exception
      -- 실패 신호를 **먼저** 씁니다. 핸들러는 위에서부터 처음 맞는 것이 이깁니다.
      when sqlstate 'ZR901' then
        raise;                     -- 계산이 틀림. 메시지를 그대로 올립니다.
      when sqlstate 'ZR801' then
        null;                      -- 정상 경로. 위에서 넣은 행은 전부 되돌아갔습니다.
      when others then
        -- 실증 자체를 못 한 경우. 통과로 위장하지 않고 크게 경고합니다.
        v_skip := sqlstate || ' ' || sqlerrm;
    end;
  end if;

  if v_skip is not null then
    raise warning
      '[0011] 주기 계산 실증(6)을 수행하지 못했습니다: %. '
      '순수 함수 불변식(1)과 카탈로그 점검까지만 확인된 상태입니다 -- 아래 '
      '「수동 확인」 을 실제 로그인 세션에서 한 번 돌려 보세요.', v_skip;
  end if;

  raise notice
    '[0011] 자체 점검 통과. 주 = ISO 월요일 시작, 월 = 달력 월, 경계는 양끝 포함, '
    '기준 날짜는 public.current_user_local_date().';
end;
$check$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 수동 확인 -- 역할 위장이 필요해 실행형으로 넣지 않은 것
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ── ① 사용자의 예시가 실제로 동작하는가 (관리자 세션)
--      // 헬스장, 일주일에 두 번
--      const { data: id } = await supabase.rpc('upsert_routine', {
--        p_id: null, p_group_id: gid, p_title: '헬스장 가기',
--        p_period: 'week', p_target_count: 2, p_active: true })
--      // id 가 null 이면 관리자가 아니거나 그 그룹 멤버가 아닌 것입니다(조용한 거절).
--      await supabase.rpc('set_routine_assignees', {
--        p_routine_id: id, p_user_ids: [uidA, uidB] })
--
-- ── ② 비관리자 세션에서 같은 호출 (기대: 조용한 무동작)
--      const { data, error } = await supabase.rpc('upsert_routine', { ... })
--      // error 는 null, data 는 null 이어야 정상입니다.
--      // error 가 나면 규칙 8 이 깨진 것입니다 -- 특권 계정의 존재가 샙니다.
--      await supabase.rpc('am_i_admin')   // false 여야 하고, 화면은 버튼을 숨겨야 합니다.
--
-- ── ③ 본인 체크 토글 (배정된 사용자 세션)
--      const { data } = await supabase.rpc('toggle_routine_checkin', { p_routine_id: id })
--      // [{ checked: true,  done: 1, target: 2 }]
--      // 한 번 더 누르면 [{ checked: false, done: 0, target: 2 }]  ← 두 행이 생기지 않음
--      // 배열이 비어 있으면 거절된 것입니다(미배정/비활성/나간 그룹).
--
-- ── ④ 배정되지 않은 사용자가 같은 루틴을 토글 (기대: 빈 배열, 예외 없음)
--      const { data, error } = await supabase.rpc('toggle_routine_checkin', { p_routine_id: id })
--      // error 는 null, data 는 [] 여야 정상입니다.
--
-- ── ⑤ 자정 근처 동작 (규칙 4 -- 실제로 겪은 종류의 버그)
--      한국 시간 00:30 에 체크하고 get_my_routines 를 보세요.
--      checked_today 가 true 여야 하고 period_start 가 어제 주로 밀리면 안 됩니다.
--      (프로필 timezone 이 Asia/Seoul 인지 먼저 확인: select timezone from profiles)
--
-- ── ⑥ 남의 그룹 루틴이 안 보이는가 (그룹 A 멤버 세션)
--      await supabase.from('routines').select('*')            // 내 그룹 것만
--      await supabase.from('routine_checkins').select('*')    // 내 그룹 것만
--      await supabase.from('routines').insert({ ... })        // 42501 (GRANT 자체가 없음)
--
-- ── 손으로 보는 확인 (postgres 세션)
--   select private.routine_period_start('week',  current_date),
--          private.routine_period_end  ('week',  private.routine_period_start('week',  current_date)),
--          private.routine_period_start('month', current_date),
--          private.routine_period_end  ('month', private.routine_period_start('month', current_date));
--
--   select pg_get_function_arguments('public.get_my_routines()'::regprocedure),
--          pg_get_function_result   ('public.get_my_routines()'::regprocedure);
--
--   select polrelid::regclass, polname, pg_get_expr(polqual, polrelid)
--     from pg_policy
--    where polrelid in ('public.routines'::regclass,
--                       'public.routine_assignments'::regclass,
--                       'public.routine_checkins'::regclass);
--   -- 어떤 식에도 group_members / routines 같은 테이블 이름이 나오면 안 됩니다.
--      private.* 헬퍼 호출과 auth.uid() 만 보여야 합니다.
-- ═══════════════════════════════════════════════════════════════════════════


notify pgrst, 'reload schema';
