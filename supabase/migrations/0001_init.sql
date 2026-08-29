-- =============================================================================
-- 0001_init.sql  --  스키마 원본(SCHEMA OF RECORD)
--
-- 친구 그룹용 데일리 투두 앱. 이 파일이 만드는 것:
--   schemas / tables / constraints / indexes / triggers
--   RLS 정책이 재귀 없이 돌아가게 해 주는 private 헬퍼 함수
--   RLS로는 표현이 불가능한 흐름을 담은 SECURITY DEFINER RPC
--
-- 정책(POLICY) 자체와 GRANT는 0002_rls.sql에 있습니다. 다만 "RLS 켜기"와
-- "anon/authenticated 권한 회수"는 이 파일에서 테이블을 만든 직후에 바로 합니다.
-- (0001과 0002는 서로 다른 트랜잭션으로 적용될 수 있고, 그 사이에 모든 행이
--  publishable anon key로 읽히는 창이 생기기 때문입니다.)
--
-- 반드시 `postgres` 역할로 실행하세요. SECURITY DEFINER 함수들이 RLS를
-- 우회하는 근거가 "소유자가 postgres"라는 사실입니다.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. private 스키마
--
-- private는 Settings -> API -> Exposed schemas 에 절대 넣지 마세요.
-- 노출된 스키마에 있는 SECURITY DEFINER 함수는 Data API로 호출 가능하고,
-- 그 순간 생성자 권한이 그대로 새어 나갑니다.
-- -----------------------------------------------------------------------------
create schema if not exists private;

revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- private에 새로 만들어지는 함수가 PUBLIC EXECUTE를 자동으로 받지 않게 합니다.
alter default privileges in schema private revoke execute on functions from public;

comment on schema private is
  'RLS 술어(predicate) 헬퍼와 내부 함수 전용. Exposed schemas에 추가 금지.';


-- -----------------------------------------------------------------------------
-- 0b. public 스키마의 기본 권한 잠그기
--
-- Supabase는 public에 새로 생기는 테이블을 anon/authenticated에게 자동으로
-- GRANT 합니다. 그대로 두면 "앞으로 추가될 모든 테이블"이 RLS 없이 공개되는
-- 함정이 영구히 재장전됩니다. 여기서 한 번 끕니다.
--
-- 주의: 이후에 추가하는 테이블은 필요한 GRANT를 명시적으로 써 주어야 합니다.
-- -----------------------------------------------------------------------------
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;


-- -----------------------------------------------------------------------------
-- 1. updated_at 트리거 함수
--
-- 일부러 SECURITY INVOKER입니다. NEW만 고쳐 쓰고 아무 테이블도 읽지 않으므로
-- 권한 상승이 필요 없습니다. search_path는 Supabase 린터
-- (function_search_path_mutable) 대응 겸 습관적으로 고정합니다.
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

revoke all on function public.set_updated_at() from public;

comment on function public.set_updated_at() is
  'BEFORE UPDATE 트리거: updated_at 갱신. 테이블을 읽지 않으므로 SECURITY INVOKER.';


-- -----------------------------------------------------------------------------
-- 2. profiles
-- -----------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text        not null default '친구',
  avatar_emoji text        not null default '🙂',
  timezone     text        not null default 'Asia/Seoul',
  created_at   timestamptz not null default now(),

  constraint profiles_display_name_len_chk
    check (char_length(btrim(display_name)) between 1 and 40),
  constraint profiles_avatar_emoji_len_chk
    check (char_length(avatar_emoji) between 1 and 8),
  constraint profiles_timezone_len_chk
    check (char_length(timezone) between 1 and 64)
);

alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;

comment on table public.profiles is
  'auth 사용자 1명당 1행. on_auth_user_created 트리거가 자동 생성합니다.';
comment on column public.profiles.timezone is
  'IANA 이름. task_date 버킷팅에 사용. 길이 CHECK만으로는 부족해서 '
  'profiles_validate_timezone 트리거가 pg_timezone_names로 실존 여부를 검증합니다.';


-- -----------------------------------------------------------------------------
-- 2b. timezone 검증 트리거   [필수 수정 2 (a)]
--
-- 왜 CHECK 제약이 아니라 트리거인가:
--   pg_timezone_names 조회는 IMMUTABLE이 아니라서 CHECK 안에 넣을 수 없습니다.
--   (CHECK은 IMMUTABLE 식만 허용 -- 넣으면 생성 시점에 에러)
--
-- 이걸 막지 않으면 'Asia/Seoul ' (뒤 공백) 이나 'KST' 같은 값이 길이 CHECK를
-- 통과한 뒤, current_user_local_date()에서 SQLSTATE 22023으로 터지면서
-- 그 계정의 모든 할 일 추가가 영구히 실패합니다.
-- -----------------------------------------------------------------------------
create or replace function public.validate_profile_timezone()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  new.timezone := btrim(coalesce(new.timezone, ''));

  if new.timezone = '' then
    new.timezone := 'Asia/Seoul';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_timezone_names z where z.name = new.timezone
  ) then
    raise exception '알 수 없는 시간대입니다: %', new.timezone
      using errcode = '22023',
            hint    = 'IANA 이름을 사용하세요 (예: Asia/Seoul).';
  end if;

  return new;
end;
$fn$;

revoke all on function public.validate_profile_timezone() from public;

drop trigger if exists profiles_validate_timezone on public.profiles;
create trigger profiles_validate_timezone
  before insert or update of timezone on public.profiles
  for each row
  execute function public.validate_profile_timezone();

comment on function public.validate_profile_timezone() is
  'profiles.timezone이 실제 IANA 존인지 검증. pg_timezone_names 조회는 IMMUTABLE이 '
  '아니라 CHECK 제약으로 만들 수 없어 트리거로 구현했습니다.';


-- -----------------------------------------------------------------------------
-- 3. current_user_local_date()   [필수 수정 2 (b)]
--
-- tasks.task_date의 DEFAULT. UTC current_date를 쓰면 한국 시간 오전 9시에
-- 보드가 넘어가 버립니다.
--
-- 방어적으로 작성: 저장된 timezone 문자열을 절대 신뢰하지 않습니다.
--   1) pg_timezone_names에 없으면 'Asia/Seoul'로 폴백
--   2) 그래도 예외가 나면 EXCEPTION 핸들러가 'Asia/Seoul'로 폴백
-- 어떤 값이 들어가 있어도 이 함수가 앱을 못 쓰게 만들 수는 없습니다.
--
-- public.tasks보다 먼저 정의합니다 (컬럼 DEFAULT는 전방 참조 불가).
-- -----------------------------------------------------------------------------
create or replace function public.current_user_local_date()
returns date
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_tz text;
begin
  select p.timezone into v_tz
  from public.profiles p
  where p.id = (select auth.uid());

  if v_tz is null
     or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_tz)
  then
    v_tz := 'Asia/Seoul';
  end if;

  return (now() at time zone v_tz)::date;
exception
  when others then
    -- 잘못된 시간대 하나가 할 일 추가 전체를 막는 일은 없어야 합니다.
    raise warning 'current_user_local_date fallback (tz=%): % (%)', v_tz, sqlerrm, sqlstate;
    return (now() at time zone 'Asia/Seoul')::date;
end;
$fn$;

revoke all on function public.current_user_local_date() from public;
grant execute on function public.current_user_local_date() to authenticated, service_role;

comment on function public.current_user_local_date() is
  '호출자 프로필 시간대 기준 오늘 날짜(폴백 Asia/Seoul). tasks.task_date의 DEFAULT. '
  '잘못된 시간대 값에도 절대 예외를 던지지 않습니다.';


-- -----------------------------------------------------------------------------
-- 4. groups
-- -----------------------------------------------------------------------------
create table if not exists public.groups (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  invite_code text        not null unique,
  created_by  uuid        references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),

  constraint groups_name_len_chk
    check (char_length(btrim(name)) between 1 and 60),
  constraint groups_invite_code_shape_chk
    check (invite_code ~ '^[A-Z0-9]{6,16}$')
);

alter table public.groups enable row level security;
revoke all on public.groups from anon, authenticated;

comment on column public.groups.invite_code is
  '서버 생성 값. authenticated에는 이 컬럼의 SELECT 권한이 없습니다(0002의 컬럼 단위 GRANT). '
  '소유자는 public.get_invite_code()로만 읽을 수 있고, 회전은 public.rotate_invite_code()입니다.';
comment on column public.groups.created_by is
  'nullable + ON DELETE SET NULL: 만든 사람이 탈퇴해도 그룹은 살아남습니다.';

-- FK 인덱스: "내가 만든 그룹" 조회와 SET NULL 캐스케이드를 싸게 만듭니다.
create index if not exists groups_created_by_idx
  on public.groups (created_by);


-- -----------------------------------------------------------------------------
-- 5. group_members  <- 재귀 문제의 진원지
--
-- 여기에는 멤버십 규칙이 없습니다. 규칙은 0002가 담당하고, 이 테이블을 읽어야
-- 하는 모든 정책은 아래 private 헬퍼를 경유합니다.
-- -----------------------------------------------------------------------------
create table if not exists public.group_members (
  group_id  uuid        not null references public.groups (id)   on delete cascade,
  user_id   uuid        not null references public.profiles (id) on delete cascade,
  role      text        not null default 'member',
  joined_at timestamptz not null default now(),

  primary key (group_id, user_id),
  constraint group_members_role_chk check (role in ('owner', 'member'))
);

alter table public.group_members enable row level security;
revoke all on public.group_members from anon, authenticated;

-- 중요 인덱스. PK가 (group_id, user_id)라서 user_id 단독 조회를 못 탑니다.
-- private.current_user_group_ids()가 거의 모든 정책 안에서 user_id로 필터하므로,
-- 이 인덱스가 없으면 모든 RLS 검사가 group_members 순차 스캔이 됩니다.
create index if not exists group_members_user_id_idx
  on public.group_members (user_id, group_id);

-- 소유자 조회(private.is_group_owner, 소유자 승계 트리거)용 부분 인덱스.
create index if not exists group_members_owner_idx
  on public.group_members (group_id)
  where role = 'owner';


-- =============================================================================
-- 6. RLS 술어 헬퍼 (private 스키마, SECURITY DEFINER, RLS 우회)
--
-- 재귀 문제와 해법:
--   group_members 정책 안에서 group_members를 SELECT하면 그 정책이 다시
--   평가되고... Postgres가 SQLSTATE 42P17 'infinite recursion detected in
--   policy for relation "group_members"' 로 포기합니다.
--
--   해법은 멤버십 조회를 SECURITY DEFINER 함수 안으로 옮기는 것입니다.
--     * SECURITY DEFINER  -> 본문이 소유자(postgres)로 실행됩니다.
--     * owner to postgres -> postgres가 테이블 소유자이고 테이블 소유자는 RLS
--                            면제입니다. 함수 안의 읽기는 정책을 평가하지 않습니다.
--     * STABLE            -> 플래너가 행마다가 아니라 statement당 InitPlan으로
--                            한 번만 실행합니다.
--     * search_path = '' + 완전 수식 이름 -> SECURITY DEFINER의 유일한 권한 상승
--                            표면을 막습니다.
--     * private 스키마    -> 노출 스키마에 있으면 Data API로 직접 호출됩니다.
--
-- 절대 하지 말 것:
--     alter table public.group_members force row level security;
--   FORCE는 테이블 소유자에게도 RLS를 다시 적용해서 재귀를 되살립니다.
--
-- 이 헬퍼들은 모두 내부적으로 auth.uid()에 묶여 있습니다. "누구로서 행동할지"를
-- 인자로 받지 않으므로 다른 사람 대신 읽거나 쓰도록 조준할 수 없습니다.
-- =============================================================================

-- 현재 사용자가 속한 모든 그룹. 다섯 개 정책이 `x in (select ...)` 형태로 씁니다.
create or replace function private.current_user_group_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $fn$
  select gm.group_id
  from public.group_members gm
  where gm.user_id = (select auth.uid());
$fn$;

-- WITH CHECK 식에서 쓰기 좋은 불리언 형태.
create or replace function private.is_group_member(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id  = (select auth.uid())
  );
$fn$;

create or replace function private.is_group_owner(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id  = (select auth.uid())
      and gm.role     = 'owner'
  );
$fn$;

-- "이 사람과 그룹을 하나라도 공유하는가?" profiles SELECT 정책의 근거.
-- 호출자 자신의 관계에 대한 불리언만 답하고, 목록은 절대 돌려주지 않습니다.
create or replace function private.shares_group_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
    from public.group_members me
    join public.group_members them on them.group_id = me.group_id
    where me.user_id   = (select auth.uid())
      and them.user_id = p_user_id
  );
$fn$;

alter function private.current_user_group_ids() owner to postgres;
alter function private.is_group_member(uuid)    owner to postgres;
alter function private.is_group_owner(uuid)     owner to postgres;
alter function private.shares_group_with(uuid)  owner to postgres;

revoke all on function private.current_user_group_ids() from public;
revoke all on function private.is_group_member(uuid)    from public;
revoke all on function private.is_group_owner(uuid)     from public;
revoke all on function private.shares_group_with(uuid)  from public;

-- 정책 식은 질의하는 역할로 평가되므로 authenticated에게 EXECUTE가 실제로
-- 필요합니다(위의 schema private USAGE와 함께). anon에는 주지 않습니다.
grant execute on function private.current_user_group_ids() to authenticated;
grant execute on function private.is_group_member(uuid)    to authenticated;
grant execute on function private.is_group_owner(uuid)     to authenticated;
grant execute on function private.shares_group_with(uuid)  to authenticated;

comment on function private.current_user_group_ids() is
  'RLS 헬퍼. postgres 소유 SECURITY DEFINER이므로 group_members 읽기가 자기 정책을 '
  '다시 타지 않습니다(42P17 회피). 인자가 없어 다른 사용자로 조준 불가.';
comment on function private.shares_group_with(uuid) is
  'RLS 헬퍼. "호출자가 p_user_id와 그룹을 공유하는가"라는 불리언만 답합니다.';


-- -----------------------------------------------------------------------------
-- 6b. 소유자 없는 그룹 자동 복구 (DEFERRED constraint trigger)
--
-- 두 가지 경로로 그룹이 주인 없는 상태가 될 수 있습니다.
--   (a) 유일한 소유자가 계정을 삭제 -> auth.users -> profiles -> group_members
--       캐스케이드로 소유자 행만 조용히 사라짐
--   (b) 소유자 두 명이 동시에 서로를 강등/제거 (READ COMMITTED TOCTOU)
--
-- "마지막 소유자는 못 나간다"로 막지 않고 자동 승계로 처리합니다. 예외를 던지면
-- 계정 삭제 자체가 막히는데, 3~6명짜리 앱에서는 그게 더 나쁩니다.
-- DEFERRABLE INITIALLY DEFERRED + groups 행 FOR UPDATE 잠금이라 동시 실행도
-- 커밋 시점에 직렬화됩니다.
-- -----------------------------------------------------------------------------
create or replace function private.ensure_group_has_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  -- DELETE 트리거에서 NEW는 "assigned되지 않은 레코드"라서 new.group_id를 읽으면
  -- ERROR 55000 'record "new" is not assigned yet'가 납니다. TG_OP로 분기하세요.
  -- coalesce(old.group_id, new.group_id) 같은 축약은 여기서 통하지 않습니다.
  v_gid  uuid;
  v_heir uuid;
begin
  if tg_op = 'DELETE' then
    v_gid := old.group_id;
  else
    v_gid := new.group_id;
  end if;

  -- groups 행을 잠가 동시 제거/강등을 커밋 시점에 직렬화합니다.
  perform 1 from public.groups g where g.id = v_gid for update;
  if not found then
    return null;   -- 그룹 자체가 삭제됨. 지킬 대상이 없습니다.
  end if;

  if exists (
    select 1 from public.group_members m
    where m.group_id = v_gid and m.role = 'owner'
  ) then
    return null;   -- 소유자가 남아 있습니다.
  end if;

  -- 가장 오래된 멤버를 소유자로 승계. (마지막 소유자가 스스로를 강등하면
  --  본인이 다시 소유자가 될 수 있습니다 -- 의도된 동작입니다.)
  select m.user_id into v_heir
  from public.group_members m
  where m.group_id = v_gid
  order by m.joined_at asc, m.user_id asc
  limit 1;

  if v_heir is not null then
    update public.group_members
       set role = 'owner'
     where group_id = v_gid and user_id = v_heir;

    raise warning '그룹 % 에 소유자가 없어 사용자 % 를 소유자로 승계했습니다.', v_gid, v_heir;
  end if;

  -- 멤버가 0명이면 빈 그룹으로 남깁니다(데이터 자동 삭제는 하지 않음).
  return null;
end;
$fn$;

alter function private.ensure_group_has_owner() owner to postgres;
revoke all on function private.ensure_group_has_owner() from public;

drop trigger if exists group_members_ensure_owner on public.group_members;
create constraint trigger group_members_ensure_owner
  after delete or update on public.group_members
  deferrable initially deferred
  for each row
  execute function private.ensure_group_has_owner();

comment on function private.ensure_group_has_owner() is
  '소유자가 사라진 그룹에 최고참 멤버를 자동 승계. DEFERRED constraint trigger + '
  'groups 행 FOR UPDATE로 동시성 TOCTOU를 막습니다. 절대 예외를 던지지 않으므로 '
  '계정 삭제/탈퇴를 막지 않습니다.';


-- -----------------------------------------------------------------------------
-- 7. tasks
-- -----------------------------------------------------------------------------
create table if not exists public.tasks (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  group_id   uuid        not null references public.groups (id)   on delete cascade,
  task_date  date        not null default public.current_user_local_date(),
  title      text        not null,
  sort_order integer     not null default 0,
  done_at    timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tasks_title_len_chk
    check (char_length(btrim(title)) between 1 and 200),
  constraint tasks_sort_order_range_chk
    check (sort_order between -100000 and 100000)
);

alter table public.tasks enable row level security;
revoke all on public.tasks from anon, authenticated;

comment on column public.tasks.done_at is
  'NULL = 미완료. 불리언 대신 타임스탬프라서 "새벽 3시에 끝냄"도 답할 수 있습니다.';

-- Realtime DELETE 이벤트는 RLS로 걸러지지 않습니다. REPLICA IDENTITY는 반드시
-- DEFAULT(PK만)로 두세요. FULL로 바꾸면 삭제된 행 전체가 모든 구독자에게 갑니다.
alter table public.tasks replica identity default;

comment on table public.tasks is
  'Realtime 주의: Supabase Postgres Changes는 DELETE 이벤트에 RLS를 적용하지 않습니다. '
  'REPLICA IDENTITY를 FULL로 바꾸면 삭제된 행 전체가 비멤버 구독자에게도 방송됩니다. '
  'DEFAULT(PK만) 유지.';

-- group_id 변경 가드. 정책은 소유권만 보고, "내가 속하지 않은 그룹으로 옮기기"는
-- 여기서 막습니다. 이렇게 하면 그룹을 나간 뒤에도 과거 내 할 일을 계속
-- 수정/체크해제할 수 있습니다(SELECT/DELETE 정책과 일관).
create or replace function private.tasks_guard_group_move()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  -- 서버(service_role, cron)에는 auth.uid()가 없습니다. 그때는 통과시킵니다.
  if (select auth.uid()) is null then
    return new;
  end if;

  if not private.is_group_member(new.group_id) then
    raise exception '가입하지 않은 그룹으로 할 일을 옮길 수 없습니다.'
      using errcode = '42501';
  end if;

  return new;
end;
$fn$;

alter function private.tasks_guard_group_move() owner to postgres;
revoke all on function private.tasks_guard_group_move() from public;

drop trigger if exists tasks_guard_group_move on public.tasks;
create trigger tasks_guard_group_move
  before update on public.tasks
  for each row
  when (new.group_id is distinct from old.group_id)
  execute function private.tasks_guard_group_move();

drop trigger if exists tasks_set_updated_at on public.tasks;
create trigger tasks_set_updated_at
  before update on public.tasks
  for each row
  when (old.* is distinct from new.*)   -- 무의미한 UPDATE는 updated_at을 건드리지 않음
  execute function public.set_updated_at();

-- 질의 패턴: "날짜 D의 그룹 전체 보드"
--   where group_id = $1 and task_date = $2 order by user_id, sort_order
create index if not exists tasks_group_date_idx
  on public.tasks (group_id, task_date, user_id, sort_order);

-- 질의 패턴: "날짜 D의 내 목록"
create index if not exists tasks_user_date_idx
  on public.tasks (user_id, task_date, sort_order);

-- 질의 패턴(자동 넛지 cron): "오늘 G에서 아직 안 끝낸 사람?"
create index if not exists tasks_group_date_open_idx
  on public.tasks (group_id, task_date, user_id)
  where done_at is null;


-- -----------------------------------------------------------------------------
-- 8. push_subscriptions
-- -----------------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references public.profiles (id) on delete cascade,
  endpoint        text        not null,
  p256dh          text        not null,
  auth            text        not null,
  expiration_time bigint,
  user_agent      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_used_at    timestamptz,

  -- Web Push endpoint URL은 브라우저 인스턴스 하나를 전역적으로 식별합니다.
  -- 그래서 UNIQUE는 (user_id, endpoint)가 아니라 endpoint 단독입니다. 한 기기를
  -- 두 계정이 쓰면 행을 복제하지 말고 소유자를 바꿔야 합니다. 안 그러면 이전
  -- 계정이 그 기기의 알림을 계속 받습니다.
  constraint push_subscriptions_endpoint_key unique (endpoint),

  constraint push_subscriptions_endpoint_shape_chk
    check (endpoint ~ '^https://' and char_length(endpoint) between 12 and 2048)
);

-- 기존 배포에 뒤늦게 적용될 때를 위한 멱등 보정.
alter table public.push_subscriptions
  add column if not exists expiration_time bigint;
alter table public.push_subscriptions
  add column if not exists updated_at timestamptz not null default now();

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;

comment on column public.push_subscriptions.expiration_time is
  'PushSubscription.expirationTime (epoch ms). 브라우저가 주지 않으면 NULL.';
comment on constraint push_subscriptions_endpoint_key on public.push_subscriptions is
  '재소유(re-owning) upsert 대상: on conflict (endpoint) do update set user_id = excluded.user_id. '
  '주의: UPDATE 정책의 USING은 기존 행(이전 소유자)에 대해 평가되므로 이 upsert는 '
  '반드시 service_role(RLS 우회)로 실행해야 합니다. 클라이언트에서 직접 하면 실패합니다.';

create index if not exists push_subscriptions_user_id_idx
  on public.push_subscriptions (user_id);

-- 정리 작업: N일 이상 안 쓰인 endpoint 제거용.
create index if not exists push_subscriptions_last_used_idx
  on public.push_subscriptions (last_used_at nulls first);

drop trigger if exists push_subscriptions_set_updated_at on public.push_subscriptions;
create trigger push_subscriptions_set_updated_at
  before update on public.push_subscriptions
  for each row
  when (old.* is distinct from new.*)
  execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- 9. nudges
-- -----------------------------------------------------------------------------
create table if not exists public.nudges (
  id           uuid        primary key default gen_random_uuid(),
  from_user_id uuid        not null references public.profiles (id) on delete cascade,
  to_user_id   uuid        not null references public.profiles (id) on delete cascade,
  group_id     uuid        not null references public.groups (id)   on delete cascade,
  task_id      uuid        references public.tasks (id) on delete set null,
  message      text,
  source       text        not null default 'manual',
  created_at   timestamptz not null default now(),

  constraint nudges_source_chk        check (source in ('manual', 'auto')),
  constraint nudges_no_self_nudge_chk check (from_user_id <> to_user_id),
  constraint nudges_message_len_chk
    check (message is null or char_length(btrim(message)) between 1 and 200)
);

alter table public.nudges enable row level security;
revoke all on public.nudges from anon, authenticated;

alter table public.nudges replica identity default;

comment on table public.nudges is
  '삽입 전용. 클라이언트에는 INSERT 권한도, INSERT 정책도 없습니다. 수동 넛지는 '
  'public.send_nudge() RPC로만, 자동 넛지는 service_role로만 만들어집니다. '
  'Realtime 주의: DELETE 이벤트는 RLS로 걸러지지 않으니 REPLICA IDENTITY는 DEFAULT 유지.';
comment on column public.nudges.source is
  '''manual'' = 사람이 보낸 넛지(send_nudge RPC), ''auto'' = cron 자동 넛지(service_role).';

-- 레이트 리밋(수신자 기준).
create index if not exists nudges_to_user_created_idx
  on public.nudges (to_user_id, created_at desc);

-- 레이트 리밋(발신자 기준). send_nudge의 (from,to,시간) 카운트가 이 인덱스를 탑니다.
create index if not exists nudges_from_user_created_idx
  on public.nudges (from_user_id, to_user_id, created_at desc);

-- 그룹 활동 피드. RLS SELECT 정책이 필터하는 접근 경로이기도 합니다.
create index if not exists nudges_group_created_idx
  on public.nudges (group_id, created_at desc);

-- FK 인덱스: 할 일 삭제 시 SET NULL이 nudges를 순차 스캔하지 않도록.
create index if not exists nudges_task_id_idx
  on public.nudges (task_id)
  where task_id is not null;


-- =============================================================================
-- 10. 가입 -> 프로필 생성   [필수 수정 1]
--
-- auth.users의 AFTER INSERT 트리거 + SECURITY DEFINER 함수(Supabase 공식 패턴).
-- 삽입 세션은 내부 auth 역할이라 public.profiles에 권한이 없으므로 DEFINER가
-- 반드시 필요합니다.
--
-- 여기서 실패하면 가입 자체가 "Database error saving new user" 500으로 죽습니다.
-- 그래서 두 겹으로 막습니다.
--   (a) 모든 메타데이터 값을 컬럼 한도에 맞게 left()로 자르고 기본값으로 coalesce
--       (avatar_emoji CHECK은 1..8자 -- 9자짜리를 보내면 예전엔 가입이 터졌습니다)
--       timezone은 pg_timezone_names로 실존 검증까지 하고 아니면 Asia/Seoul
--   (b) 본문 전체를 EXCEPTION 핸들러로 감싸서, 무슨 일이 있어도 NEW를 반환
--       프로필이 없으면 0002의 profiles_insert_self 정책이 안전밸브가 됩니다.
-- =============================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_name  text;
  v_emoji text;
  v_tz    text;
begin
  v_name := left(btrim(coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    '친구'
  )), 40);
  if btrim(coalesce(v_name, '')) = '' then
    v_name := '친구';
  end if;

  -- CHECK: char_length(avatar_emoji) between 1 and 8
  v_emoji := left(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'avatar_emoji'), ''), '🙂'), 8);
  if coalesce(v_emoji, '') = '' then
    v_emoji := '🙂';
  end if;

  -- CHECK: char_length(timezone) between 1 and 64  +  실존하는 IANA 존이어야 함
  v_tz := left(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'timezone'), ''), 'Asia/Seoul'), 64);
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_tz) then
    v_tz := 'Asia/Seoul';
  end if;

  insert into public.profiles (id, display_name, avatar_emoji, timezone)
  values (new.id, v_name, v_emoji, v_tz)
  on conflict (id) do nothing;

  return new;
exception
  when others then
    -- 프로필 문제로 계정 생성이 막히는 일은 절대 없어야 합니다.
    raise warning 'handle_new_user 실패 (user %): % (%)', new.id, sqlerrm, sqlstate;
    return new;
end;
$fn$;

alter function public.handle_new_user() owner to postgres;

-- 트리거 함수는 PostgREST로 호출할 수 없지만(trigger 타입 인자를 만들 수 없음)
-- 방어적으로 회수합니다.
revoke all on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

comment on function public.handle_new_user() is
  'auth.users AFTER INSERT -> public.profiles 시드. 모든 메타데이터를 컬럼 한도로 '
  '자르고 검증하며, EXCEPTION 핸들러가 있어 어떤 실패도 가입을 막지 못합니다. '
  'NEW.id만 쓰므로 다른 사용자로 조준 불가.';


-- =============================================================================
-- 11. 초대 코드 생성
--
-- 12자 x 30심볼 = 약 59비트. 8자(약 39비트)는 인증만 하면 누구나 호출할 수 있는
-- join RPC에 비해 너무 얇았습니다(Supabase 익명 로그인은 공짜로 만들 수 있음).
--
-- 모듈로 편향 제거: 0..255를 30으로 나머지 연산하면 앞쪽 16개 심볼이 9/256,
-- 나머지가 8/256로 나옵니다. 240(=8*30) 이상인 바이트를 버리는 rejection
-- sampling으로 균등하게 만듭니다.
-- =============================================================================
create or replace function private.generate_invite_code()
returns text
language plpgsql
volatile
set search_path = ''
as $fn$
declare
  -- I, L, O, U, 0, 1 제외 -> 사진으로 보고 받아 적어도 헷갈리지 않습니다.
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTVWXYZ23456789';  -- 30자
  v_len      constant int  := 30;
  v_cutoff   constant int  := 240;   -- 8 * 30
  v_target   constant int  := 12;
  -- gen_random_uuid()는 pg_strong_random(CSPRNG). v4 UUID의 바이트 6(version)과
  -- 8(variant)은 고정 비트를 포함하므로 건너뜁니다.
  v_src      constant int[] := array[0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13, 14, 15];
  v_bytes    bytea;
  v_b        int;
  v_code     text := '';
  i          int;
begin
  while char_length(v_code) < v_target loop
    v_bytes := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
    foreach i in array v_src loop
      v_b := get_byte(v_bytes, i);
      if v_b < v_cutoff then
        v_code := v_code || substr(v_alphabet, (v_b % v_len) + 1, 1);
        exit when char_length(v_code) >= v_target;
      end if;
    end loop;
  end loop;

  return v_code;   -- 12자, 30^12 ~= 5.3e17
end;
$fn$;

alter function private.generate_invite_code() owner to postgres;
revoke all on function private.generate_invite_code() from public;
-- authenticated에 주지 않습니다. 아래 SECURITY DEFINER RPC들만 호출합니다.


-- =============================================================================
-- 12. public.create_group(p_name text) returns public.groups
--
-- 그룹 생성과 소유자 등록은 하나의 원자적 행위입니다. 클라이언트 문장 두 개로
-- 나누면 두 번째가 실패했을 때 주인 없는 그룹이 남고, group_members에 임의의
-- 멤버십 행을 쓸 수 있는 INSERT 정책이 필요해집니다.
--
-- 그래서 authenticated에는 groups/group_members INSERT 권한이 없습니다(0002).
-- 이 함수가 유일한 문입니다.
-- =============================================================================
create or replace function public.create_group(p_name text)
returns public.groups
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_uid     uuid := (select auth.uid());
  v_group   public.groups;
  v_code    text;
  v_attempt int := 0;
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;

  if btrim(coalesce(p_name, '')) = '' then
    raise exception '그룹 이름을 입력해 주세요.' using errcode = '22023';
  end if;

  -- 초대 코드 충돌(사실상 불가능) 재시도.
  loop
    v_attempt := v_attempt + 1;
    v_code := private.generate_invite_code();
    begin
      insert into public.groups (name, invite_code, created_by)
      values (left(btrim(p_name), 60), v_code, v_uid)
      returning * into v_group;
      exit;
    exception when unique_violation then
      if v_attempt >= 10 then
        raise;
      end if;
    end;
  end loop;

  insert into public.group_members (group_id, user_id, role)
  values (v_group.id, v_uid, 'owner');

  return v_group;
end;
$fn$;

alter function public.create_group(text) owner to postgres;
revoke all on function public.create_group(text) from public;
grant execute on function public.create_group(text) to authenticated;

comment on function public.create_group(text) is
  '그룹과 소유자 멤버십을 원자적으로 생성. 호출자가 넘기는 신원은 무시하고 '
  'auth.uid()만 사용하므로 남의 이름으로 그룹을 만들 수 없습니다.';


-- =============================================================================
-- 13. public.join_group_by_invite_code(p_invite_code text) returns public.groups
--
-- RLS로는 구조적으로 표현할 수 없는 흐름입니다. 가입하려는 사람은 아직 멤버가
-- 아니라 어떤 멤버십 기반 정책도 그를 승인할 수 없고, 그를 통과시킬 만큼 느슨한
-- INSERT 정책은 다른 모든 그룹에도 자기를 밀어 넣게 해 줍니다.
--
-- 여기서의 권한 근거는 "초대 코드 소지"이고, 그 코드가 들어 있는 컬럼은 호출자가
-- 읽을 수 없습니다. 그래서 DEFINER 함수 안에서 검사해야 합니다.
-- =============================================================================
create or replace function public.join_group_by_invite_code(p_invite_code text)
returns public.groups
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_code  text := upper(btrim(coalesce(p_invite_code, '')));
  v_group public.groups;
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;

  if v_code !~ '^[A-Z0-9]{6,16}$' then
    raise exception '초대 코드가 올바르지 않습니다.' using errcode = '22023';
  end if;

  select g.* into v_group
  from public.groups g
  where g.invite_code = v_code;

  if not found then
    raise exception '초대 코드가 올바르지 않습니다.' using errcode = 'P0002';
  end if;

  -- 항상 'member'. 가입자가 스스로 'owner' 행을 만들 수 없고, 재가입은 에러가
  -- 아니라 무동작입니다(모바일 클라이언트는 재시도합니다).
  insert into public.group_members (group_id, user_id, role)
  values (v_group.id, v_uid, 'member')
  on conflict (group_id, user_id) do nothing;

  return v_group;
end;
$fn$;

alter function public.join_group_by_invite_code(text) owner to postgres;
revoke all on function public.join_group_by_invite_code(text) from public;
grant execute on function public.join_group_by_invite_code(text) to authenticated;

comment on function public.join_group_by_invite_code(text) is
  '초대 코드로 가입. 가입자가 아직 멤버가 아니므로 SECURITY DEFINER. '
  '항상 (해당 그룹, auth.uid(), ''member'') 한 행만 씁니다.';


-- =============================================================================
-- 14. public.get_invite_code(p_group_id uuid) returns text   [필수 수정 3]
--
-- groups.invite_code에는 authenticated의 컬럼 SELECT 권한이 없습니다(0002).
-- 예전에는 모든 멤버가 코드를 읽을 수 있었고, 그래서 추방당한 멤버가 외워 둔
-- 코드로 즉시 재가입할 수 있었습니다. 이제 소유자만 이 함수로 읽습니다.
-- =============================================================================
create or replace function public.get_invite_code(p_group_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid  uuid := (select auth.uid());
  v_code text;
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;

  -- RLS를 우회해서 실행되므로 소유자 검사를 함수 안에서 다시 합니다.
  if not exists (
    select 1 from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id  = v_uid
      and gm.role     = 'owner'
  ) then
    raise exception '그룹 소유자만 초대 코드를 볼 수 있습니다.' using errcode = '42501';
  end if;

  select g.invite_code into v_code
  from public.groups g
  where g.id = p_group_id;

  return v_code;
end;
$fn$;

alter function public.get_invite_code(uuid) owner to postgres;
revoke all on function public.get_invite_code(uuid) from public;
grant execute on function public.get_invite_code(uuid) to authenticated;

comment on function public.get_invite_code(uuid) is
  '소유자 전용 초대 코드 조회. groups.invite_code는 컬럼 단위로 SELECT가 막혀 있어 '
  '이 함수가 유일한 읽기 경로입니다.';


-- =============================================================================
-- 15. 초대 코드 회전
--
-- 권한 검사가 없는 내부 루틴을 먼저 정의합니다. public.rotate_invite_code()와
-- public.remove_member()가 같은 트랜잭션에서 재사용합니다. private에 있으므로
-- Data API로는 노출되지 않습니다.
-- =============================================================================
create or replace function private.rotate_invite_code_unchecked(p_group_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_code    text;
  v_attempt int := 0;
begin
  loop
    v_attempt := v_attempt + 1;
    v_code := private.generate_invite_code();
    begin
      update public.groups set invite_code = v_code where id = p_group_id;
      exit;
    exception when unique_violation then
      if v_attempt >= 10 then
        raise;
      end if;
    end;
  end loop;

  return v_code;
end;
$fn$;

alter function private.rotate_invite_code_unchecked(uuid) owner to postgres;
revoke all on function private.rotate_invite_code_unchecked(uuid) from public;


create or replace function public.rotate_invite_code(p_group_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_uid  uuid := (select auth.uid());
  v_code text;
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id  = v_uid
      and gm.role     = 'owner'
  ) then
    raise exception '그룹 소유자만 초대 코드를 새로 만들 수 있습니다.' using errcode = '42501';
  end if;

  v_code := private.rotate_invite_code_unchecked(p_group_id);

  return v_code;
end;
$fn$;

alter function public.rotate_invite_code(uuid) owner to postgres;
revoke all on function public.rotate_invite_code(uuid) from public;
grant execute on function public.rotate_invite_code(uuid) to authenticated;

comment on function public.rotate_invite_code(uuid) is
  '소유자 전용 초대 코드 회전. RLS 우회 상태로 실행되므로 소유자 검사를 내부에서 다시 합니다.';


-- =============================================================================
-- 16. public.remove_member(p_group_id uuid, p_user_id uuid) returns void
--     [필수 수정 3]
--
-- 추방은 초대 코드 회전과 한 트랜잭션이어야 의미가 있습니다. 그렇지 않으면
-- 추방당한 사람이 외워 둔 코드로 1초 뒤에 다시 들어옵니다.
-- =============================================================================
create or replace function public.remove_member(p_group_id uuid, p_user_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;

  if p_user_id = v_uid then
    raise exception '스스로를 내보낼 수는 없습니다. 그룹 나가기를 사용하세요.'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id  = v_uid
      and gm.role     = 'owner'
  ) then
    raise exception '그룹 소유자만 멤버를 내보낼 수 있습니다.' using errcode = '42501';
  end if;

  -- 이미 멤버가 아니면 조용히 종료(멱등). 코드도 회전하지 않습니다.
  if not exists (
    select 1 from public.group_members gm
    where gm.group_id = p_group_id and gm.user_id = p_user_id
  ) then
    return;
  end if;

  delete from public.group_members
  where group_id = p_group_id and user_id = p_user_id;

  -- 같은 트랜잭션에서 회전. 이게 없으면 추방이 강제력을 갖지 못합니다.
  perform private.rotate_invite_code_unchecked(p_group_id);
end;
$fn$;

alter function public.remove_member(uuid, uuid) owner to postgres;
revoke all on function public.remove_member(uuid, uuid) from public;
grant execute on function public.remove_member(uuid, uuid) to authenticated;

comment on function public.remove_member(uuid, uuid) is
  '소유자 전용 멤버 추방. 같은 트랜잭션에서 초대 코드를 반드시 회전시켜 '
  '추방당한 사람이 외워 둔 코드로 재가입하지 못하게 합니다.';


-- =============================================================================
-- 17. public.send_nudge(...)   [필수 수정 4]
--     returns table (ok boolean, reason text, nudge_id uuid)
--
-- 레이트 리밋: 대상 1명당 시간당 1회, 하루 3회.
--
-- 원자성을 어떻게 얻는가:
--   COUNT를 세고 나서 INSERT하는 것은 READ COMMITTED에서 전형적인 TOCTOU입니다.
--   동시에 들어온 20개 요청이 전부 "0건"을 보고 전부 통과합니다.
--   그래서 세기 전에 (from, to) 쌍에 대한 트랜잭션 자문 잠금을 잡습니다.
--   같은 쌍의 동시 호출은 커밋까지 직렬화되고, 잠금은 트랜잭션 종료 시 자동
--   해제되므로 별도 정리가 필요 없습니다.
--
--   왜 유니크 인덱스로 못 하는가:
--     create unique index ... on public.nudges (from_user_id, to_user_id,
--       date_trunc('hour', created_at));
--   이건 만들어지지 않습니다. created_at이 timestamptz이고 date_trunc(text,
--   timestamptz)는 STABLE입니다(결과가 세션 TimeZone 설정에 의존). 인덱스 식은
--   IMMUTABLE이어야 하므로 Postgres가 ERROR 42P17
--   'functions in index expression must be marked IMMUTABLE'로 거부합니다.
--   date_trunc(text, timestamp) (타임존 없는 쪽)만 IMMUTABLE이고, created_at을
--   거기에 캐스팅하면 다시 세션 타임존에 의존하게 되어 같은 문제입니다.
--   그리고 "정시 기준 1시간"이 아니라 "직전 60분"이라는 요구사항 자체가
--   유니크 인덱스로는 표현이 안 됩니다.
--
-- 예외를 던지지 않고 (ok, reason)을 돌려주는 이유: 라우트가 reason을 한국어
-- 메시지로 매핑할 수 있도록.
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

  -- 호출자와 대상이 같은 그룹에 있어야 합니다. DEFINER라 RLS가 걸리지 않으므로
  -- 여기서 직접 확인합니다.
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
  -- (from, to) 쌍마다 하나의 잠금. 세기 전에 잡아야 의미가 있습니다.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_uid::text || '>' || p_to_user_id::text, 0::bigint)
  );

  select count(*)::int into v_hour
  from public.nudges n
  where n.from_user_id = v_uid
    and n.to_user_id   = p_to_user_id
    and n.created_at   > now() - interval '1 hour';

  if v_hour >= 1 then
    return query select false, 'rate_limited_hour'::text, null::uuid;
    return;
  end if;

  select count(*)::int into v_day
  from public.nudges n
  where n.from_user_id = v_uid
    and n.to_user_id   = p_to_user_id
    and n.created_at   > now() - interval '1 day';

  if v_day >= 3 then
    return query select false, 'rate_limited_day'::text, null::uuid;
    return;
  end if;

  -- task_id는 반드시 그 그룹의, 그 대상의 할 일이어야 합니다. 아니면 조용히
  -- 버립니다(넛지 자체는 보냅니다). 남의 task id를 끼워 넣어 존재를 확인하는
  -- 짓을 막습니다.
  v_task := null;
  if p_task_id is not null then
    select t.id into v_task
    from public.tasks t
    where t.id       = p_task_id
      and t.group_id = p_group_id
      and t.user_id  = p_to_user_id;
  end if;

  v_msg := nullif(left(btrim(coalesce(p_message, '')), 200), '');

  insert into public.nudges (from_user_id, to_user_id, group_id, task_id, message, source)
  values (v_uid, p_to_user_id, p_group_id, v_task, v_msg, 'manual')
  returning id into v_new_id;
  -- ===== 원자성 경계 끝 (잠금은 커밋/롤백 시 해제) =====

  return query select true, null::text, v_new_id;
end;
$fn$;

alter function public.send_nudge(uuid, uuid, uuid, text) owner to postgres;
revoke all on function public.send_nudge(uuid, uuid, uuid, text) from public;
grant execute on function public.send_nudge(uuid, uuid, uuid, text) to authenticated;

comment on function public.send_nudge(uuid, uuid, uuid, text) is
  '수동 넛지 발송(source=''manual''). from_user_id는 항상 auth.uid(). '
  '대상 1명당 시간당 1회 / 하루 3회를 pg_advisory_xact_lock으로 원자적으로 강제합니다. '
  '거절 시 예외 대신 ok=false와 reason(not_member|rate_limited_hour|rate_limited_day|self_nudge)을 반환. '
  '유니크 인덱스로 대체 불가: date_trunc(text, timestamptz)는 STABLE이라 인덱스 식이 될 수 없습니다(42P17).';


-- =============================================================================
-- 18. Realtime (선택)
--
-- Realtime은 SELECT에 대해 RLS를 존중합니다. 단, DELETE 이벤트는 예외이므로
-- 위 테이블 주석의 REPLICA IDENTITY 경고를 반드시 지키세요.
-- 기본 publication이 없는 프로젝트에서도 마이그레이션이 적용되도록 가드했습니다.
-- =============================================================================
do $do$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public' and tablename = 'tasks'
    ) then
      alter publication supabase_realtime add table public.tasks;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public' and tablename = 'nudges'
    ) then
      alter publication supabase_realtime add table public.nudges;
    end if;
  end if;
end
$do$;


notify pgrst, 'reload schema';
