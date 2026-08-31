-- =============================================================================
-- 0004_templates.sql  --  반복 할 일 템플릿 + 하루 채우기 RPC 2종
--
-- 0001_init.sql, 0002_rls.sql, 0003_auto_nudge.sql 이 적용된 뒤에 실행하세요.
-- 반드시 `postgres` 역할로 실행하세요. 여기서 만드는 SECURITY DEFINER 함수들이
-- RLS 를 우회하는 근거가 "소유자가 postgres" 라는 사실입니다.
--
-- 이 파일이 하는 일:
--   1) public.task_templates 테이블 (+ CHECK, 인덱스, 트리거 3개, RLS 정책 4개)
--   2) public.tasks.template_id 컬럼 + 부분 유니크 인덱스
--      -> 같은 템플릿이 하루에 두 번 들어오는 것을 인덱스 차원에서 막습니다
--   3) RPC: public.apply_today_templates(uuid)  -- 오늘 요일에 해당하는 템플릿 적용
--      RPC: public.copy_tasks_from(date)        -- 과거 날짜의 할 일을 오늘로 복사
--   4) grant/revoke 명시. anon 은 이 파일이 만드는 어떤 것도 만질 수 없습니다.
--
-- ★ 템플릿은 개인 설정입니다 ★
-- 같은 그룹 멤버라도 남의 템플릿은 한 줄도 볼 수 없습니다. tasks 는 "그룹 전원이
-- 서로의 오늘을 본다" 가 이 앱의 존재 이유지만, 템플릿은 그 사람의 서랍입니다.
-- 그래서 SELECT 정책이 tasks 처럼 그룹 기반이 아니라 user_id = auth.uid() 입니다.
--
-- 전체가 멱등(idempotent)입니다. 두 번 붙여넣어도 안전합니다.
--
-- 적용 순서는 의미가 있습니다:
--   테이블 -> RLS 켜기 + 권한 회수 -> 트리거 함수 -> 트리거 -> 인덱스
--   -> tasks 컬럼/FK/인덱스 -> RPC -> 함수별 revoke/grant -> 정책 -> 컬럼 GRANT
--   -> notify pgrst
--   (CREATE FUNCTION 은 PUBLIC 에 EXECUTE 를 자동으로 줍니다. 그래서 revoke 는
--    반드시 create 뒤에 와야 합니다. "grant 안 함" 은 "revoke 함" 이 아닙니다.)
-- =============================================================================


-- =============================================================================
-- 1. public.task_templates
--
-- weekdays 는 0=일요일 .. 6=토요일 입니다. 이 인코딩은 임의로 고른 게 아니라
-- PostgreSQL 의 `extract(dow from ...)` 와 정확히 같은 규약입니다
-- (문서: "dow -- The day of the week as Sunday (0) to Saturday (6)").
-- 덕분에 apply_today_templates 안에서 변환 없이 그대로 비교합니다.
-- ★ isodow(월=1..일=7) 로 바꾸지 마세요 ★ 그 순간 일요일 템플릿이 통째로 사라집니다.
--
-- title 길이 CHECK 은 0001 의 tasks_title_len_chk 와 글자 그대로 같습니다
-- (btrim 후 1~200자). 다르면 "템플릿으로는 저장됐는데 적용하면 23514 로 터지는"
-- 조합이 생깁니다 -- 템플릿의 title 이 그대로 tasks.title 로 들어가기 때문입니다.
-- sort_order 도 같은 이유로 0001 의 tasks_sort_order_range_chk 와 동일 범위입니다.
-- =============================================================================
create table if not exists public.task_templates (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  group_id   uuid        not null references public.groups (id)   on delete cascade,
  title      text        not null,
  sort_order integer     not null default 0,
  weekdays   smallint[]  not null default '{0,1,2,3,4,5,6}'::smallint[],
  active     boolean     not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- 0001 의 tasks_title_len_chk 와 동일한 값이어야 합니다.
  constraint task_templates_title_len_chk
    check (char_length(btrim(title)) between 1 and 200),

  -- 0001 의 tasks_sort_order_range_chk 와 동일한 값이어야 합니다.
  constraint task_templates_sort_order_range_chk
    check (sort_order between -100000 and 100000),

  -- ---------------------------------------------------------------------------
  -- weekdays 검증: CHECK 으로 되는 것과 안 되는 것
  --
  -- CHECK 으로 되는 것 (전부 IMMUTABLE 식):
  --   * 1차원 배열이고 첨자가 1부터   -> array_ndims / array_lower
  --   * 원소가 1개 이상 7개 이하      -> cardinality (빈 배열은 0 이라 여기서 걸림)
  --   * 값이 0~6 범위                 -> `<@` (arraycontained). 덤으로 NULL 원소도
  --     걸립니다. array_contain_compare 는 비교 연산자가 strict 라는 전제로
  --     "NULL 은 아무것과도 매치되지 않는다" 고 보고 즉시 false 를 냅니다.
  --
  -- CHECK 으로 안 되는 것:
  --   * 중복 금지. 중복 판정에는 unnest/distinct 가 필요한데 CHECK 식에는
  --     서브쿼리를 쓸 수 없습니다 (ERROR 0A000 "cannot use subquery in check
  --     constraint"). 중복을 걸러 주는 IMMUTABLE 스칼라 함수도 없습니다.
  --     -> 그래서 아래 3번의 BEFORE 트리거가 담당합니다. 트리거는 값을 거부하는
  --        대신 "정렬 + 중복 제거" 로 정규화합니다. weekdays 는 순서도 중복도
  --        의미가 없는 집합(set)이고, 클라이언트가 체크박스를 어떤 순서로 보내든
  --        같은 행이 되어야 하기 때문입니다.
  --     -> BEFORE 트리거가 CHECK 보다 먼저 돌므로, 정규화된 값이 이 CHECK 을
  --        통과합니다. 순서를 헷갈리지 마세요.
  --
  -- 이 CHECK 은 트리거가 실수로 제거되어도 남는 최후 방어선입니다.
  -- ---------------------------------------------------------------------------
  constraint task_templates_weekdays_chk
    check (
      array_ndims(weekdays) = 1
      and array_lower(weekdays, 1) = 1
      and cardinality(weekdays) between 1 and 7
      and weekdays <@ '{0,1,2,3,4,5,6}'::smallint[]
    )
);

-- 0001 의 습관: 테이블을 만든 직후 같은 트랜잭션에서 RLS 를 켜고 권한을 회수합니다.
-- (0001 이 alter default privileges 로 신규 테이블 자동 GRANT 를 이미 껐지만,
--  이 파일 단독으로 읽어도 접근 권한의 전체 그림이 보이도록 명시합니다.)
alter table public.task_templates enable row level security;
revoke all on public.task_templates from anon, authenticated;

comment on table public.task_templates is
  '반복 할 일 템플릿. ★ 개인 설정입니다 ★ 같은 그룹 멤버도 남의 템플릿은 볼 수 없습니다 '
  '(RLS SELECT 정책이 user_id = auth.uid()). 여기 있는 행 자체는 할 일이 아니고, '
  'public.apply_today_templates() 가 오늘 요일에 맞는 것만 public.tasks 로 복제합니다.';
comment on column public.task_templates.weekdays is
  '0=일요일 .. 6=토요일. extract(dow from ...) 와 같은 규약입니다. '
  'BEFORE 트리거가 정렬 + 중복 제거로 정규화하므로 저장된 값은 항상 오름차순 중복 없음입니다. '
  '★ isodow(월=1..일=7) 로 바꾸지 마세요 ★';
comment on column public.task_templates.active is
  'false = 잠시 끔. 행을 지우지 않는 이유: tasks.template_id 가 ON DELETE SET NULL 이라 '
  '템플릿을 삭제하면 이미 만들어진 오늘 할 일의 연결이 끊어지고, 그 뒤 같은 템플릿을 '
  '다시 만들면 부분 유니크 인덱스가 막지 못해 중복 행이 생깁니다.';
comment on column public.task_templates.group_id is
  '이 템플릿이 할 일을 만들어 넣을 그룹. INSERT 정책이 private.is_group_member 로 '
  '가입 여부를 확인하고, UPDATE 로 그룹을 옮기는 것은 아래 트리거가 막습니다.';

-- FK 인덱스 겸 RPC 접근 경로. apply_today_templates 가
-- (user_id, [group_id], sort_order) 로 훑습니다. profiles 삭제 캐스케이드도 여기를 탑니다.
-- 일부러 `where active` 부분 인덱스로 만들지 않았습니다. 부분 인덱스는 캐스케이드
-- 삭제(모든 행 대상)를 커버하지 못합니다.
create index if not exists task_templates_user_idx
  on public.task_templates (user_id, group_id, sort_order);

-- groups 삭제 캐스케이드용 FK 인덱스 (0001 의 groups_created_by_idx 와 같은 이유).
create index if not exists task_templates_group_id_idx
  on public.task_templates (group_id);


-- =============================================================================
-- 2. weekdays 정규화 트리거
--
-- 일부러 SECURITY INVOKER 입니다 (0001 의 public.set_updated_at 과 같은 판단).
-- NEW 만 고쳐 쓰고 아무 테이블도 읽지 않으므로 권한 상승이 필요 없습니다.
-- search_path 는 고정하고 unnest 는 pg_catalog. 으로 한정합니다.
--
-- 하는 일:
--   * NULL 원소, 0~6 밖의 값  -> 거부 (한국어 메시지 + 22023)
--   * 빈 배열                 -> 거부
--   * 중복 / 뒤죽박죽 순서    -> 조용히 정규화 (정렬 + 중복 제거)
--
-- 거부와 정규화를 나누는 기준: "값이 틀린 것" 은 사용자에게 알려야 하고,
-- "표현이 다른 것" 은 서버가 정하면 됩니다. {1,1,3} 과 {3,1} 과 {1,3} 은 전부
-- "월요일과 수요일" 이라는 같은 뜻이므로 에러를 띄울 이유가 없습니다.
-- =============================================================================
create or replace function public.normalize_task_template_weekdays()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_days smallint[];
begin
  if new.weekdays is null then
    raise exception '요일을 하나 이상 선택해 주세요.'
      using errcode = '22023';
  end if;

  if pg_catalog.array_ndims(new.weekdays) <> 1 then
    raise exception '요일 목록의 형식이 올바르지 않습니다.'
      using errcode = '22023',
            hint    = '0(일요일)~6(토요일) 값이 들어 있는 1차원 배열이어야 합니다.';
  end if;

  if exists (select 1 from pg_catalog.unnest(new.weekdays) d where d is null) then
    raise exception '요일 목록에 빈 값이 들어 있습니다.'
      using errcode = '22023';
  end if;

  if exists (select 1 from pg_catalog.unnest(new.weekdays) d where d < 0 or d > 6) then
    raise exception '요일 값은 0(일요일)부터 6(토요일)까지만 사용할 수 있습니다.'
      using errcode = '22023';
  end if;

  -- 정렬 + 중복 제거. distinct 와 order by 의 식이 같아야 array_agg 가 허용합니다.
  select pg_catalog.array_agg(distinct d order by d)
    into v_days
  from pg_catalog.unnest(new.weekdays) d;

  -- 빈 배열이면 array_agg 가 NULL 을 돌려줍니다.
  if v_days is null then
    raise exception '요일을 하나 이상 선택해 주세요.'
      using errcode = '22023';
  end if;

  new.weekdays := v_days;
  return new;
end;
$fn$;

revoke all on function public.normalize_task_template_weekdays() from public, anon, authenticated;

comment on function public.normalize_task_template_weekdays() is
  'task_templates.weekdays 정규화(정렬 + 중복 제거)와 값 검증. '
  '중복 금지는 CHECK 으로 표현할 수 없어서(서브쿼리 불가, 0A000) 트리거로 구현했습니다. '
  '범위/개수 CHECK 은 테이블에 그대로 남아 있는 최후 방어선입니다. '
  '테이블을 읽지 않으므로 SECURITY INVOKER.';


-- =============================================================================
-- 3. 그룹 이동 가드
--
-- 0001 의 private.tasks_guard_group_move 와 같은 이유, 같은 모양입니다.
-- INSERT 는 RLS 정책의 WITH CHECK 이 private.is_group_member 로 막지만, UPDATE
-- 정책에는 일부러 멤버십 항을 넣지 않았습니다(그룹을 나간 뒤에도 자기 템플릿을
-- 끄거나 지울 수 있어야 하니까요). 그래서 "안 속한 그룹으로 옮기기" 만 여기서 막습니다.
--
-- 0001 의 tasks 용 함수를 재사용하지 않은 이유: 그 함수는 tasks 전용으로 계속
-- 진화할 수 있고, 그때 이 테이블이 조용히 딸려 가면 안 됩니다.
-- =============================================================================
create or replace function private.task_templates_guard_group_move()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  -- 서버(service_role, cron)에는 auth.uid() 가 없습니다. 그때는 통과시킵니다.
  if (select auth.uid()) is null then
    return new;
  end if;

  if not private.is_group_member(new.group_id) then
    raise exception '가입하지 않은 그룹으로 템플릿을 옮길 수 없습니다.'
      using errcode = '42501';
  end if;

  return new;
end;
$fn$;

alter function private.task_templates_guard_group_move() owner to postgres;
revoke all on function private.task_templates_guard_group_move() from public, anon, authenticated;

comment on function private.task_templates_guard_group_move() is
  'task_templates.group_id 이동 가드. 0001 의 private.tasks_guard_group_move 와 같은 역할이며 '
  'UPDATE 정책에서 일부러 뺀 멤버십 검사를 여기서 강제합니다.';


-- -----------------------------------------------------------------------------
-- 트리거 3개.
--
-- ★ 이름 순서에 의미가 있습니다 ★ 같은 테이블/같은 이벤트의 트리거는 이름
-- 알파벳 순으로 실행됩니다.
--   task_templates_guard_group_move      (g)
--   task_templates_normalize_weekdays    (n)
--   task_templates_set_updated_at        (s)
-- normalize 가 set_updated_at 보다 먼저 돌아야, updated_at 트리거의
-- `when (old.* is distinct from new.*)` 가 "정규화된 뒤의 NEW" 를 비교합니다.
-- 그래야 {3,1} -> {1,3} 처럼 뜻이 같은 재저장이 updated_at 을 건드리지 않습니다.
-- -----------------------------------------------------------------------------
drop trigger if exists task_templates_guard_group_move on public.task_templates;
create trigger task_templates_guard_group_move
  before update on public.task_templates
  for each row
  when (new.group_id is distinct from old.group_id)
  execute function private.task_templates_guard_group_move();

drop trigger if exists task_templates_normalize_weekdays on public.task_templates;
create trigger task_templates_normalize_weekdays
  before insert or update of weekdays on public.task_templates
  for each row
  execute function public.normalize_task_template_weekdays();

-- 0001 의 공용 트리거 함수 재사용. 새로 만들지 않습니다.
drop trigger if exists task_templates_set_updated_at on public.task_templates;
create trigger task_templates_set_updated_at
  before update on public.task_templates
  for each row
  when (old.* is distinct from new.*)   -- 무의미한 UPDATE 는 updated_at 을 건드리지 않음
  execute function public.set_updated_at();


-- =============================================================================
-- 4. public.tasks.template_id  +  부분 유니크 인덱스
--
-- ★ 이 인덱스가 이 파일에서 제일 중요한 한 줄입니다 ★
-- 사용자는 "오늘 채우기" 버튼을 연타합니다. 그리고 모바일 네트워크는 같은 POST 를
-- 두 번 보냅니다. 카운트하고 나서 INSERT 하는 방식은 READ COMMITTED 에서 전형적인
-- TOCTOU 라 둘 다 통과합니다. 그래서 "하루에 같은 템플릿은 한 번" 을 애플리케이션
-- 로직이 아니라 인덱스로 못 박고, RPC 는 on conflict do nothing 으로 조용히
-- skipped 에 집계합니다.
--
-- WHERE template_id is not null 인 이유: 손으로 적은 할 일(template_id NULL)은
-- 하루에 몇 개든 자유롭게 만들 수 있어야 합니다. NULL 은 유니크 제약에서 서로
-- 충돌하지 않으므로 사실 부분 인덱스가 없어도 되지만, 인덱스 크기를 "템플릿에서
-- 나온 행" 으로 줄이고 의도를 코드에 남기려고 명시했습니다.
--
-- ADD COLUMN 과 FK 를 나눈 이유: `add column if not exists ... references ...` 는
-- 컬럼이 이미 있으면 FK 까지 통째로 건너뜁니다. 중간까지 적용된 DB 에서 컬럼만
-- 있고 FK 는 없는 상태가 영구히 굳습니다.
-- =============================================================================
alter table public.tasks
  add column if not exists template_id uuid;

do $do$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.tasks'::regclass
      and conname  = 'tasks_template_id_fkey'
  ) then
    alter table public.tasks
      add constraint tasks_template_id_fkey
      foreign key (template_id) references public.task_templates (id)
      on delete set null;
  end if;
end
$do$;

create unique index if not exists tasks_user_date_template_uidx
  on public.tasks (user_id, task_date, template_id)
  where template_id is not null;

-- FK 인덱스. 위 유니크 인덱스는 user_id 로 시작해서 "이 템플릿을 참조하는 행" 을
-- 못 찾습니다. 템플릿 삭제 시의 SET NULL 캐스케이드가 tasks 순차 스캔이 되지 않게 합니다.
create index if not exists tasks_template_id_idx
  on public.tasks (template_id)
  where template_id is not null;

comment on column public.tasks.template_id is
  '이 할 일을 만들어 낸 템플릿. 손으로 적은 할 일은 NULL. '
  '★ authenticated 에게 이 컬럼의 INSERT/UPDATE 권한을 주지 마세요 ★ '
  '0002 의 컬럼 단위 GRANT 목록에 없으므로 클라이언트는 이 값을 직접 쓸 수 없고, '
  'public.apply_today_templates() 만이 유일한 쓰기 경로입니다. 권한을 열면 '
  '임의의 template_id 를 꽂아 tasks_user_date_template_uidx 를 선점해서 남의... 가 아니라 '
  '자기 자신의 템플릿 적용을 영구히 막는 자해가 가능해집니다.';

comment on index public.tasks_user_date_template_uidx is
  '"하루에 같은 템플릿은 한 번". apply_today_templates 의 연타/중복 호출 안전성이 '
  '전적으로 이 인덱스에 달려 있습니다. 지우면 버튼을 두 번 누른 사람에게 할 일이 두 배로 생깁니다.';


-- =============================================================================
-- 5. public.apply_today_templates(p_group_id uuid default null)
--        returns table (created integer, skipped integer)
--
-- ★ 오늘 요일 판정 ★
-- 반드시 public.current_user_local_date() 기준입니다. 서버는 UTC 로 돌기 때문에
-- pg_catalog.date_part('dow', now()) 를 쓰면 한국 시간 오전 0시~9시 사이에 하루
-- 전 요일이 나옵니다. 월요일 새벽 1시에 "오늘 채우기" 를 누르면 일요일 템플릿이
-- 들어오는, 재현은 되는데 아침에는 안 보이는 그 버그입니다.
--
-- ★ dow 규약 근거 ★
-- PostgreSQL 문서: "dow -- The day of the week as Sunday (0) to Saturday (6)".
-- 검산: date_part('dow', date '2026-08-30') = 0 이고 2026-08-30 은 일요일입니다.
-- 그래서 task_templates.weekdays 의 0=일요일 규약과 변환 없이 그대로 맞습니다.
-- (isodow 는 월=1..일=7 로 다릅니다. 절대 바꾸지 마세요.)
--
-- ★ task_date 를 명시하지 않는 이유 ★
-- tasks.task_date 의 DEFAULT 가 public.current_user_local_date() 입니다. 여기서
-- 값을 계산해 넣으면 그 계산이 DEFAULT 와 어긋나는 순간(예: 누가 나중에 v_today 를
-- now()::date 로 "간단히" 고치면) 부분 유니크 인덱스가 다른 날짜를 보게 되어
-- 중복 방지가 통째로 무력해집니다. DEFAULT 가 이기게 두세요.
-- v_today 를 요일 계산에만 쓰는 것도 같은 이유입니다. 두 값은 now() 가 트랜잭션
-- 시작 시각으로 고정되어 있으므로 같은 문장 안에서 반드시 일치합니다.
--
-- 반환: created = 실제로 만들어진 할 일 수, skipped = 이미 있어서 건너뛴 수.
-- 합(created + skipped)은 "오늘 요일에 해당하는, 아직 가입 상태인 그룹의, 활성 템플릿" 수입니다.
-- =============================================================================
create or replace function public.apply_today_templates(p_group_id uuid default null)
returns table (created integer, skipped integer)
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_uid     uuid := (select auth.uid());
  v_today   date;
  v_dow     smallint;
  v_created int;
  v_total   int;
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;

  -- 사용자 현지 날짜. tasks.task_date 의 DEFAULT 와 같은 함수 = 같은 값입니다.
  v_today := public.current_user_local_date();

  -- date_part(text, timestamp) 는 IMMUTABLE 이고 pg_catalog. 으로 한정할 수 있습니다.
  -- (EXTRACT 는 함수가 아니라 문법이라 search_path='' 에서 한정이 불가능합니다.
  --  0003 의 5분 단위 검증이 같은 이유로 date_part 를 씁니다.)
  v_dow := pg_catalog.date_part('dow', v_today::timestamp)::smallint;

  -- ===== 원자성 경계 시작 =====
  -- 사용자 1명당 하나의 잠금. "내 오늘 목록에 뭉치로 INSERT" 하는 두 RPC
  -- (apply_today_templates, copy_tasks_from)가 같은 키를 씁니다. 연타/중복 호출이
  -- 서로를 밀어내지 않고 줄을 서게 만드는 게 목적입니다.
  --
  -- 1인자 bigint 형태라 0003 의 run_auto_nudges 가 쓰는 2인자 (int4,int4)
  -- (778899, N) 네임스페이스와는 잠금 태그의 objsubid 로 구조적으로 분리됩니다.
  -- 같은 1인자 공간을 쓰는 send_nudge(0003:560)와는 해시 입력 문자열의 접두사가
  -- 달라 사실상 충돌하지 않습니다. 새 잠금을 추가할 사람은 접두사를 다르게 쓰세요.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('todo:bulk_insert:' || v_uid::text, 0::bigint)
  );

  with candidate as (
    select tt.id, tt.group_id, tt.title, tt.sort_order
    from public.task_templates tt
    where tt.user_id = v_uid
      and tt.active
      and v_dow = any (tt.weekdays)
      and (p_group_id is null or tt.group_id = p_group_id)
      -- SECURITY DEFINER 라 RLS 가 걸리지 않습니다. 0002 의 tasks_insert_own 이
      -- WITH CHECK 으로 강제하는 "가입한 그룹에만" 을 여기서 직접 다시 확인합니다.
      -- 그룹을 나갔다면 그 템플릿은 후보에서 조용히 빠집니다(에러가 아니라 무동작).
      and exists (
        select 1 from public.group_members gm
        where gm.group_id = tt.group_id
          and gm.user_id  = v_uid
      )
  ),
  ins as (
    insert into public.tasks (user_id, group_id, title, sort_order, template_id)
    select v_uid, c.group_id, c.title, c.sort_order, c.id
    from candidate c
    -- 부분 유니크 인덱스를 arbiter 로 지목합니다. WHERE 절까지 똑같이 적어야
    -- 부분 인덱스를 추론합니다. 이미 오늘 들어온 템플릿은 여기서 조용히 탈락합니다.
    on conflict (user_id, task_date, template_id) where template_id is not null
    do nothing
    returning 1
  )
  select (select pg_catalog.count(*)::int from ins),
         (select pg_catalog.count(*)::int from candidate)
    into v_created, v_total;
  -- ===== 원자성 경계 끝 (잠금은 커밋/롤백 시 해제) =====

  return query select coalesce(v_created, 0), coalesce(v_total, 0) - coalesce(v_created, 0);
end;
$fn$;

alter function public.apply_today_templates(uuid) owner to postgres;
revoke all on function public.apply_today_templates(uuid) from public, anon;
grant execute on function public.apply_today_templates(uuid) to authenticated;

comment on function public.apply_today_templates(uuid) is
  '오늘 요일에 해당하는 내 활성 템플릿을 오늘 할 일로 만듭니다. 대상은 언제나 auth.uid() -- '
  '★ p_user_id 같은 인자를 절대 추가하지 마세요 ★ 남의 목록에 할 일을 꽂아 넣는 도구가 됩니다. '
  'p_group_id 가 NULL 이면 내가 가입한 모든 그룹의 템플릿이 대상입니다. '
  '요일 판정은 public.current_user_local_date() 기준(서버 UTC 아님), dow 규약은 일요일=0. '
  'task_date 는 명시하지 않고 컬럼 DEFAULT 가 이깁니다. '
  '멱등: 두 번째 호출부터는 tasks_user_date_template_uidx 가 걸러 created=0, skipped=N 이 됩니다. '
  '반환은 RETURNS TABLE 이라 PostgREST 에서 배열로 옵니다 -- 클라이언트는 data[0] 을 보세요.';


-- =============================================================================
-- 6. public.copy_tasks_from(p_date date)
--        returns table (created integer, skipped integer)
--
-- "어제 거 그대로" 버튼. p_date 의 내 할 일 제목들을 오늘로 복사합니다.
--
-- 거부 규칙: p_date 가 NULL 이거나 오늘 이후(오늘 포함)면 아무것도 하지 않고
-- created=0, skipped=0 을 돌려줍니다. 예외를 던지지 않는 이유는 이게 "사용자가
-- 고칠 수 있는 잘못" 이 아니라 클라이언트 버그이고, 화면에 빨간 토스트를 띄울 만한
-- 사건이 아니기 때문입니다. (오늘을 허용하면 자기 자신을 복사하는 무한 증식이
-- 되고, 미래는 애초에 존재할 수 없는 요청입니다.)
--
-- 비교 단위는 "btrim 한 제목" 입니다. 대소문자는 접지 않습니다 -- 한국어에는
-- 의미가 없고, 영어 제목에서 'gym' 과 'Gym' 을 다른 할 일로 보고 싶은 사람도 있습니다.
--
-- template_id 는 반드시 NULL 로 넣습니다. 복사는 "템플릿 적용" 이 아니라 그냥 새
-- 할 일이고, 원본의 template_id 를 그대로 옮기면 오늘 이미 적용된 템플릿과
-- tasks_user_date_template_uidx 에서 충돌해 조용히 사라집니다.
-- =============================================================================
create or replace function public.copy_tasks_from(p_date date)
returns table (created integer, skipped integer)
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_uid     uuid := (select auth.uid());
  v_today   date;
  v_created int;
  v_total   int;
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;

  v_today := public.current_user_local_date();

  -- 미래이거나 오늘이면 거부. reason 없이 0/0 입니다.
  if p_date is null or p_date >= v_today then
    return query select 0, 0;
    return;
  end if;

  -- ===== 원자성 경계 시작 =====
  -- apply_today_templates 와 같은 키. 여기는 유니크 인덱스가 없어서
  -- (제목 중복은 정상적인 데이터니까요) 이 잠금이 연타 방어의 전부입니다.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('todo:bulk_insert:' || v_uid::text, 0::bigint)
  );

  with src as (
    -- 원본 날짜에 같은 제목이 두 번 있으면 한 번만 복사합니다(집계 단위도 "제목").
    -- distinct on 의 식과 order by 첫 식이 같아야 합니다.
    select distinct on (btrim(t.title))
           btrim(t.title) as title,
           t.group_id,
           t.sort_order
    from public.tasks t
    where t.user_id   = v_uid
      and t.task_date = p_date
      -- apply_today_templates 와 같은 이유의 멤버십 재확인(DEFINER 는 RLS 우회).
      -- 그 사이 나간 그룹의 옛 할 일은 복사되지 않습니다.
      and exists (
        select 1 from public.group_members gm
        where gm.group_id = t.group_id
          and gm.user_id  = v_uid
      )
    order by btrim(t.title), t.sort_order, t.id
  ),
  fresh as (
    select s.title, s.group_id, s.sort_order
    from src s
    where not exists (
      select 1
      from public.tasks x
      where x.user_id   = v_uid
        and x.task_date = v_today      -- DEFAULT 와 같은 함수에서 나온 같은 날짜
        and btrim(x.title) = s.title
    )
  ),
  ins as (
    -- task_date 는 명시하지 않습니다. 컬럼 DEFAULT(current_user_local_date)가 이깁니다.
    -- sort_order 는 원본 순서를 그대로 가져옵니다. 오늘이 비어 있을 때(가장 흔한
    -- 경우) 어제와 같은 순서로 보이는 게 자연스럽습니다.
    insert into public.tasks (user_id, group_id, title, sort_order, template_id)
    select v_uid, f.group_id, f.title, f.sort_order, null::uuid
    from fresh f
    returning 1
  )
  select (select pg_catalog.count(*)::int from ins),
         (select pg_catalog.count(*)::int from src)
    into v_created, v_total;
  -- ===== 원자성 경계 끝 =====

  return query select coalesce(v_created, 0), coalesce(v_total, 0) - coalesce(v_created, 0);
end;
$fn$;

alter function public.copy_tasks_from(date) owner to postgres;
revoke all on function public.copy_tasks_from(date) from public, anon;
grant execute on function public.copy_tasks_from(date) to authenticated;

comment on function public.copy_tasks_from(date) is
  'p_date 의 내 할 일 제목을 오늘로 복사합니다. 대상은 언제나 auth.uid() -- '
  '★ p_user_id 같은 인자를 절대 추가하지 마세요 ★ '
  '오늘 이미 같은 제목(btrim 비교)이 있으면 건너뜁니다. p_date 가 NULL/오늘/미래면 '
  '예외 없이 created=0, skipped=0. task_date 는 컬럼 DEFAULT 가 결정하고, '
  '복사본의 template_id 는 항상 NULL 입니다. '
  '멱등: 두 번째 호출은 제목이 전부 존재하므로 created=0, skipped=N. 연타는 '
  'pg_advisory_xact_lock 으로 직렬화합니다. '
  '반환은 RETURNS TABLE 이라 PostgREST 에서 배열로 옵니다 -- 클라이언트는 data[0] 을 보세요.';


-- =============================================================================
-- 7. 권한(GRANT)
--
-- GRANT 와 RLS 는 독립적인 두 개의 문이고 요청은 둘 다 통과해야 합니다.
-- anon 에는 아무것도 주지 않습니다. 로그아웃 상태에서는 템플릿 제목 한 줄도
-- 읽을 수 없습니다.
--
-- created_at / updated_at 은 주지 않습니다(백데이팅 방지, updated_at 은 트리거 담당).
-- user_id 를 INSERT 목록에 넣는 이유: 정책의 WITH CHECK 이 auth.uid() 와 같은지
-- 확인하므로 남의 id 를 넣으면 그 자리에서 막힙니다. 0002 의 tasks 와 같은 형태입니다.
--
-- ★ tasks 의 컬럼 GRANT 는 건드리지 않습니다 ★ template_id 가 0002 의 INSERT/UPDATE
-- 컬럼 목록에 없다는 사실이 "클라이언트는 template_id 를 직접 못 쓴다" 의 근거입니다.
-- =============================================================================
grant select                                                       on public.task_templates to authenticated;
grant insert (id, user_id, group_id, title, sort_order, weekdays, active)
                                                                   on public.task_templates to authenticated;
grant update (group_id, title, sort_order, weekdays, active)       on public.task_templates to authenticated;
grant delete                                                       on public.task_templates to authenticated;

-- service_role 은 RLS 를 우회(BYPASSRLS)하지만 테이블 권한은 여전히 필요합니다.
grant all on public.task_templates to service_role;


-- =============================================================================
-- 8. 정책(POLICY)
--
-- 0002 의 관례를 그대로 따릅니다.
--   * 모든 정책에 `to authenticated` (없으면 anon 요청마다 정책 식이 평가됩니다)
--   * 맨 auth.uid() 대신 `(select auth.uid())` -> statement 당 한 번 InitPlan
--   * INSERT/UPDATE 정책에는 예외 없이 WITH CHECK
--   * 정책 식은 자기가 지키는 테이블(task_templates)을 절대 직접 SELECT 하지 않습니다.
--     여기서는 아예 다른 테이블을 읽을 일 자체가 private.is_group_member 하나뿐입니다.
-- =============================================================================

-- 헬퍼: 없음 (auth.uid() 만 사용)
-- ★ 그룹 기반이 아닙니다 ★ 템플릿은 개인 설정이라 같은 그룹 멤버도 볼 수 없습니다.
drop policy if exists task_templates_select_own on public.task_templates;
create policy task_templates_select_own
  on public.task_templates
  for select
  to authenticated
  using (user_id = (select auth.uid()));

-- 헬퍼: private.is_group_member(uuid)
-- 0002 의 tasks_insert_own 과 같은 모양입니다. 멤버십 항이 "user_id = auth.uid()"
-- 보다 엄격합니다 -- 내가 속하지 않은 그룹을 겨냥한 템플릿을 만들 수 없습니다.
drop policy if exists task_templates_insert_own on public.task_templates;
create policy task_templates_insert_own
  on public.task_templates
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and private.is_group_member(group_id)
  );

-- 헬퍼: 없음 (auth.uid() 만 사용)
-- USING 은 기존 행, WITH CHECK 는 바뀐 행. 둘 다 필요합니다. USING 만 있으면
-- user_id 를 고쳐서 남에게 템플릿을 떠넘길 수 있습니다.
--
-- 멤버십 항을 넣지 않는 이유는 0002 의 tasks_update_own 과 같습니다. 그룹을 나간
-- 뒤에도 자기 템플릿을 끄고(active=false) 지울 수 있어야 합니다. 진짜 지켜야 할
-- 규칙("안 속한 그룹으로 옮길 수 없다")은 위 3번의 트리거가 강제합니다.
drop policy if exists task_templates_update_own on public.task_templates;
create policy task_templates_update_own
  on public.task_templates
  for update
  to authenticated
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- 헬퍼: 없음 (auth.uid() 만 사용)
drop policy if exists task_templates_delete_own on public.task_templates;
create policy task_templates_delete_own
  on public.task_templates
  for delete
  to authenticated
  using (user_id = (select auth.uid()));


-- =============================================================================
-- 9. Realtime
--
-- task_templates 는 일부러 publication 에 넣지 않습니다. 개인 설정이라 다른
-- 기기와 실시간으로 맞출 이유가 없고, 0001 의 경고대로 DELETE 이벤트에는 RLS 가
-- 적용되지 않습니다. tasks 는 이미 publication 에 있으므로 apply/copy 로 생긴
-- 할 일은 그룹 화면에 자동으로 나타납니다.
-- =============================================================================


-- =============================================================================
-- 10. 자체 점검 (선택 -- SQL 편집기에서 돌려 보세요)
--
-- (a) dow 규약 확인  ★ 제일 중요 ★
--   select pg_catalog.date_part('dow', date '2026-08-30');  -- 일요일
--   -> 0 이어야 합니다. 여기가 1 이나 7 이면 weekdays 인코딩 전체가 틀린 것입니다.
--
-- (b) weekdays 정규화/검증
--   insert into public.task_templates (user_id, group_id, title, weekdays)
--   values (auth.uid(), '<그룹id>', '스트레칭', '{3,1,1}');   -- -> 저장값 {1,3}
--   ... weekdays = '{7}'   -> 22023 (0~6 범위)
--   ... weekdays = '{}'    -> 22023 (하나 이상)
--   ... weekdays = '{null}'-> 22023 (빈 값)
--
-- (c) 남의 템플릿이 안 보이는지
--   -> 같은 그룹의 다른 계정으로 select * from public.task_templates;
--      상대방 행이 한 줄도 나오면 안 됩니다.
--
-- (d) 클라이언트가 template_id 를 직접 못 쓰는지
--   select has_column_privilege('authenticated', 'public.tasks', 'template_id', 'INSERT');
--   select has_column_privilege('authenticated', 'public.tasks', 'template_id', 'UPDATE');
--   -> 둘 다 false 여야 합니다.
--   select has_column_privilege('authenticated', 'public.tasks', 'template_id', 'SELECT');
--   -> true 여야 합니다 (UI 가 "템플릿에서 온 할 일" 배지를 그릴 수 있게).
--
-- (e) anon 이 아무것도 못 하는지
--   select privilege_type from information_schema.role_table_grants
--   where grantee = 'anon' and table_schema = 'public' and table_name = 'task_templates';
--   -> 0행이어야 합니다.
--   select has_function_privilege('anon', 'public.apply_today_templates(uuid)', 'EXECUTE');
--   select has_function_privilege('anon', 'public.copy_tasks_from(date)', 'EXECUTE');
--   -> 둘 다 false 여야 합니다.
--   select has_function_privilege('authenticated', 'public.apply_today_templates(uuid)', 'EXECUTE');
--   select has_function_privilege('authenticated', 'public.copy_tasks_from(date)', 'EXECUTE');
--   -> 둘 다 true 여야 합니다.
--
-- (f) 함수 소유자가 postgres 인지 (RLS 우회의 근거)
--   select p.proname, r.rolname
--   from pg_proc p join pg_roles r on r.oid = p.proowner
--   where p.proname in ('apply_today_templates','copy_tasks_from',
--                       'task_templates_guard_group_move',
--                       'normalize_task_template_weekdays');
--   -> rolname 이 전부 postgres 여야 합니다.
--
-- (g) 정책 식이 자기 테이블을 직접 참조하지 않는지 (재귀 감시)
--   select polname, pg_get_expr(polqual, polrelid) as using_expr,
--          pg_get_expr(polwithcheck, polrelid) as check_expr
--   from pg_policy where polrelid = 'public.task_templates'::regclass;
--   -> 식에 task_templates 라는 테이블 이름이 나오면 안 됩니다.
--      auth.uid() 와 private.is_group_member 만 보여야 합니다.
--   -> 네 정책 모두 나와야 하고, insert/update 행의 check_expr 이 NULL 이면 안 됩니다.
--
-- (h) 부분 유니크 인덱스가 실제로 붙었는지
--   select indexdef from pg_indexes
--   where schemaname = 'public' and indexname = 'tasks_user_date_template_uidx';
--   -> UNIQUE ... (user_id, task_date, template_id) WHERE (template_id IS NOT NULL)
--
-- (i) 멱등성 수동 확인 (로그인 세션으로)
--   select * from public.apply_today_templates();   -- created=N, skipped=0
--   select * from public.apply_today_templates();   -- created=0, skipped=N
--   select * from public.copy_tasks_from(current_date - 1);   -- created=M, skipped=0
--   select * from public.copy_tasks_from(current_date - 1);   -- created=0, skipped=M
--   select * from public.copy_tasks_from(current_date);       -- 0 / 0 (오늘은 거부)
--
-- (j) 자정 근처 회귀 테스트 (한국 시간 00:30 에 해 보세요)
--   -> 새로 만들어진 tasks 의 task_date 가 UTC 기준 어제가 아니라 오늘이어야 하고,
--      적용된 템플릿의 요일도 어제가 아니라 오늘 요일이어야 합니다.
-- =============================================================================


-- PostgREST 스키마 캐시 갱신. 이게 없으면 apply_today_templates / copy_tasks_from 이
-- 다음 무관한 배포 전까지 404 로 나옵니다. task_templates 테이블도 마찬가지입니다.
notify pgrst, 'reload schema';
