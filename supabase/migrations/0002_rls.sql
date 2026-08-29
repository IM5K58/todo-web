-- =============================================================================
-- 0002_rls.sql  --  권한(GRANT)과 정책(POLICY)
--
-- 0001은 RLS를 켜고 anon/authenticated의 권한을 전부 회수한 상태로 끝납니다.
-- 이 파일은 거기에 "필요한 만큼만" 되돌려 줍니다. 단독으로 몇 번을 다시 돌려도
-- 안전합니다(create or replace / drop policy if exists).
--
-- -----------------------------------------------------------------------------
-- 재귀 문제 (요약 -- 자세한 설명은 0001의 6번 섹션)
-- -----------------------------------------------------------------------------
-- group_members 정책 안에서 group_members를 SELECT하면 그 정책이 다시 평가되고,
-- Postgres가 SQLSTATE 42P17로 포기합니다. tasks/profiles/nudges 정책이
-- group_members를 조인해도 똑같이 그 순환에 들어갑니다.
--
-- 그래서 이 파일의 모든 정책은 멤버십 조회를 절대 인라인으로 하지 않고,
-- 0001에서 정의한 postgres 소유 SECURITY DEFINER 헬퍼를 통해서만 합니다.
--
--   private.current_user_group_ids()   -- 내가 속한 group_id 집합
--   private.is_group_member(uuid)      -- 불리언 형태
--   private.is_group_owner(uuid)       -- 소유자 여부
--   private.shares_group_with(uuid)    -- 이 사람과 그룹을 공유하는가
--
-- 아래 각 정책 위에 "어떤 헬퍼를 쓰는지"를 적어 두었습니다. 정책 식 안에서
-- public.group_members / public.profiles 등을 직접 SELECT하는 곳은 한 군데도
-- 없습니다. 정책을 수정할 때 이 규칙을 깨지 마세요.
--
-- 절대 하지 말 것:
--     alter table public.group_members force row level security;
-- FORCE는 테이블 소유자에게도 RLS를 다시 적용해서 재귀를 되살립니다.
-- =============================================================================


-- =============================================================================
-- 1. 헬퍼 소유권/권한 재확인 (멱등)
--
-- 헬퍼 자체는 0001에서 만들어집니다. 이 파일이 단독으로 검토·재적용되는 경우가
-- 많으므로, RLS 우회의 근거인 "소유자 = postgres"와 authenticated EXECUTE를
-- 여기서 한 번 더 못 박습니다.
-- =============================================================================
alter function private.current_user_group_ids() owner to postgres;
alter function private.is_group_member(uuid)    owner to postgres;
alter function private.is_group_owner(uuid)     owner to postgres;
alter function private.shares_group_with(uuid)  owner to postgres;

revoke all on function private.current_user_group_ids() from public;
revoke all on function private.is_group_member(uuid)    from public;
revoke all on function private.is_group_owner(uuid)     from public;
revoke all on function private.shares_group_with(uuid)  from public;

grant usage on schema private to authenticated, service_role;

-- 정책 식은 질의하는 역할로 평가되므로 authenticated에게 EXECUTE가 실제로
-- 필요합니다. anon에는 주지 않습니다(anon을 대상으로 하는 정책이 없습니다).
grant execute on function private.current_user_group_ids() to authenticated;
grant execute on function private.is_group_member(uuid)    to authenticated;
grant execute on function private.is_group_owner(uuid)     to authenticated;
grant execute on function private.shares_group_with(uuid)  to authenticated;


-- =============================================================================
-- 2. RLS 켜기 (0001에서 이미 켰지만 멱등하게 재확인)
--
-- ENABLE만, FORCE는 금지. 위 헤더 참고.
-- =============================================================================
alter table public.profiles            enable row level security;
alter table public.groups              enable row level security;
alter table public.group_members       enable row level security;
alter table public.tasks               enable row level security;
alter table public.push_subscriptions  enable row level security;
alter table public.nudges              enable row level security;


-- =============================================================================
-- 3. 권한(GRANT)
--
-- GRANT와 RLS는 서로 독립적인 두 개의 문이고 요청은 둘 다 통과해야 합니다.
-- GRANT가 없으면 "permission denied for table", 정책이 막으면 0행 또는
-- "violates row-level security policy"입니다.
--
-- 컬럼 단위 GRANT는 RLS가 표현할 수 없는 일을 합니다. RLS는 행을 거르지 컬럼을
-- 거르지 않으므로 "그룹 이름은 바꿔도 초대 코드는 못 바꾼다" 같은 규칙은
-- 컬럼 권한이어야 합니다.
-- =============================================================================

-- 백지 상태에서 시작(0001에서 이미 회수했지만 재적용을 위해).
revoke all on public.profiles            from anon, authenticated;
revoke all on public.groups              from anon, authenticated;
revoke all on public.group_members       from anon, authenticated;
revoke all on public.tasks               from anon, authenticated;
revoke all on public.push_subscriptions  from anon, authenticated;
revoke all on public.nudges              from anon, authenticated;

-- anon에는 어디에도 아무것도 주지 않습니다. 로그아웃 상태에서는 할 일 제목 한 줄,
-- push endpoint 하나, 넛지 하나도 읽을 수 없습니다.

-- ---------------------------------------------------------------------------
-- profiles: 읽기(정책 필터), 자기 행 INSERT 안전밸브, 자기 행 UPDATE.
-- UPDATE 대상에서 id를 뺐으므로 정책을 통과해도 PK는 못 바꿉니다.
-- ---------------------------------------------------------------------------
grant select                                            on public.profiles to authenticated;
grant insert (id, display_name, avatar_emoji, timezone) on public.profiles to authenticated;
grant update (display_name, avatar_emoji, timezone)     on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- groups
--
-- ★ 중요 ★ SELECT를 테이블 전체가 아니라 컬럼 단위로 줍니다. invite_code는
-- 제외입니다. 예전에는 모든 멤버가 `select invite_code from groups`를 할 수
-- 있었고, 그래서 추방당한 멤버가 외워 둔 코드로 즉시 재가입했습니다.
--
-- 클라이언트 주의사항:
--   .from('groups').select('*')  ->  invite_code 컬럼 권한이 없어 실패합니다.
--   .from('groups').select('id, name, created_by, created_at')  ->  정상.
-- 초대 코드는 소유자만, public.get_invite_code(group_id)로 읽습니다.
--
-- INSERT 없음 -> 생성은 public.create_group().
-- UPDATE는 name 컬럼만 -> 코드 회전은 public.rotate_invite_code().
-- ---------------------------------------------------------------------------
grant select (id, name, created_by, created_at) on public.groups to authenticated;
grant update (name)                             on public.groups to authenticated;
grant delete                                    on public.groups to authenticated;

-- ---------------------------------------------------------------------------
-- group_members: INSERT 없음 -> 가입은 public.join_group_by_invite_code().
-- UPDATE는 role 컬럼만 -> 멤버십 행을 다른 사용자/다른 그룹으로 돌려놓을 수 없습니다.
-- ---------------------------------------------------------------------------
grant select        on public.group_members to authenticated;
grant update (role) on public.group_members to authenticated;
grant delete        on public.group_members to authenticated;

-- ---------------------------------------------------------------------------
-- tasks: 정책이 제한하는 범위 안에서 전체 CRUD.
-- created_at / updated_at은 주지 않습니다(백데이팅 방지, updated_at은 트리거 담당).
-- ---------------------------------------------------------------------------
grant select                                                               on public.tasks to authenticated;
grant insert (id, user_id, group_id, task_date, title, sort_order, done_at) on public.tasks to authenticated;
grant update (group_id, task_date, title, sort_order, done_at)             on public.tasks to authenticated;
grant delete                                                               on public.tasks to authenticated;

-- ---------------------------------------------------------------------------
-- push_subscriptions: 본인 행만. 기기 재소유 upsert는 service_role 전용입니다
-- (0001의 push_subscriptions_endpoint_key 주석 참고).
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- ---------------------------------------------------------------------------
-- nudges: 클라이언트는 읽기 전용. INSERT 권한도 INSERT 정책도 없습니다.
-- 따라서 public.send_nudge()의 원자적 레이트 리밋을 우회할 방법이 없습니다.
-- 문 두 개가 모두 닫혀 있습니다. 의도된 설계입니다.
-- ---------------------------------------------------------------------------
grant select on public.nudges to authenticated;

-- ---------------------------------------------------------------------------
-- service_role은 RLS를 우회(BYPASSRLS)하지만 테이블 권한은 여전히 필요합니다.
-- 이 파일이 접근 권한의 전체 그림이 되도록 명시합니다.
-- ---------------------------------------------------------------------------
grant all on public.profiles           to service_role;
grant all on public.groups             to service_role;
grant all on public.group_members      to service_role;
grant all on public.tasks              to service_role;
grant all on public.push_subscriptions to service_role;
grant all on public.nudges             to service_role;


-- =============================================================================
-- 4. 정책(POLICY)
--
-- 어디에나 적용한 두 가지 관례(Supabase RLS 성능 가이드):
--
--   * 모든 정책에 `to authenticated`. 없으면 anon 요청마다 정책 식이 평가됩니다.
--   * 맨 auth.uid() 대신 `(select auth.uid())`. 서브쿼리 형태여야 옵티마이저가
--     행마다가 아니라 statement당 한 번 InitPlan으로 계산합니다.
--
--   * INSERT/UPDATE 정책에는 예외 없이 WITH CHECK가 있습니다. USING만 있으면
--     "쓰기 후의 행"이 검사되지 않습니다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- profiles
-- -----------------------------------------------------------------------------

-- 헬퍼: private.shares_group_with(uuid)
-- (group_members를 직접 읽지 않으므로 재귀 없음)
-- SELECT: 나 자신, 또는 나와 그룹을 공유하는 사람.
drop policy if exists profiles_select_self_or_groupmate on public.profiles;
create policy profiles_select_self_or_groupmate
  on public.profiles
  for select
  to authenticated
  using (
    id = (select auth.uid())
    or private.shares_group_with(id)
  );

-- 헬퍼: 없음 (auth.uid()만 사용)
-- 가입 트리거가 프로필을 못 만든 계정을 위한 안전밸브입니다. handle_new_user()가
-- 어떤 이유로든 실패해도 계정 생성은 성공하므로(0001), 클라이언트가 자기 프로필을
-- 한 번 만들 수 있어야 합니다. 남의 프로필은 만들 수 없습니다.
drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self
  on public.profiles
  for insert
  to authenticated
  with check (id = (select auth.uid()));

-- 헬퍼: 없음 (auth.uid()만 사용)
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self
  on public.profiles
  for update
  to authenticated
  using      (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- DELETE 정책 없음: 프로필은 auth.users 캐스케이드로만 사라집니다.


-- -----------------------------------------------------------------------------
-- groups
-- -----------------------------------------------------------------------------

-- 헬퍼: private.current_user_group_ids()
-- (group_members 읽기가 definer 함수 안에서만 일어나므로 재귀 없음)
drop policy if exists groups_select_members on public.groups;
create policy groups_select_members
  on public.groups
  for select
  to authenticated
  using (id in (select private.current_user_group_ids()));

-- 헬퍼: private.is_group_owner(uuid)
-- 컬럼 GRANT가 name으로 제한되어 있으므로 실제로 바꿀 수 있는 건 이름뿐입니다.
drop policy if exists groups_update_owner on public.groups;
create policy groups_update_owner
  on public.groups
  for update
  to authenticated
  using      (private.is_group_owner(id))
  with check (private.is_group_owner(id));

-- 헬퍼: private.is_group_owner(uuid)
drop policy if exists groups_delete_owner on public.groups;
create policy groups_delete_owner
  on public.groups
  for delete
  to authenticated
  using (private.is_group_owner(id));

-- INSERT 정책 없음: 생성은 public.create_group()이 유일한 문입니다.


-- -----------------------------------------------------------------------------
-- group_members  <- 재귀 문제의 진원지인 바로 그 테이블
-- -----------------------------------------------------------------------------

-- 헬퍼: private.current_user_group_ids()
-- 이 정책은 group_members를 읽지만 재귀하지 않습니다. 읽기가 postgres로 실행되는
-- current_user_group_ids() 안에서 일어나고, 테이블 소유자는 RLS 면제이기 때문입니다.
-- 바로 그 우회가 해법의 전부입니다. 이 식을 EXISTS 인라인으로 바꾸면 즉시 42P17.
drop policy if exists group_members_select_same_group on public.group_members;
create policy group_members_select_same_group
  on public.group_members
  for select
  to authenticated
  using (group_id in (select private.current_user_group_ids()));

-- INSERT 정책 없음(의도적). 비멤버가 자기 가입 행을 쓸 수 있을 만큼 느슨한 정책은
-- 그가 id를 아는 모든 그룹에 스스로를 밀어 넣게도 해 줍니다. 가입은
-- public.join_group_by_invite_code()이고, 권한 근거는 초대 코드 소지입니다.

-- 헬퍼: private.is_group_owner(uuid)
-- 승격/강등(컬럼 GRANT로 role만 수정 가능). USING은 기존 행, WITH CHECK는 바뀐 행.
-- "마지막 소유자 강등 금지"를 정책의 카운트 검사로 막지 않습니다. READ COMMITTED
-- 에서는 서로 다른 행을 동시에 고치는 두 소유자가 락 충돌 없이 둘 다 통과하는
-- TOCTOU가 되기 때문입니다. 대신 0001의 DEFERRED constraint trigger
-- private.ensure_group_has_owner()가 커밋 시점에 소유자를 자동 승계합니다.
drop policy if exists group_members_update_owner on public.group_members;
create policy group_members_update_owner
  on public.group_members
  for update
  to authenticated
  using      (private.is_group_owner(group_id))
  with check (private.is_group_owner(group_id));

-- 헬퍼: private.is_group_owner(uuid)
-- 스스로 나가기(user_id = 나), 또는 소유자로서 내보내기.
--
-- 주의: 소유자가 이 경로로 멤버를 내보내면 초대 코드가 회전하지 않습니다.
-- 추방은 반드시 public.remove_member() RPC를 쓰세요. 그 함수만 같은 트랜잭션에서
-- 코드를 회전시켜 추방당한 사람의 재가입을 실제로 막습니다.
drop policy if exists group_members_delete_self_or_owner on public.group_members;
create policy group_members_delete_self_or_owner
  on public.group_members
  for delete
  to authenticated
  using (
    user_id = (select auth.uid())
    or private.is_group_owner(group_id)
  );


-- -----------------------------------------------------------------------------
-- tasks
-- SELECT: 같은 그룹 멤버 전원(이게 이 앱의 존재 이유입니다).
-- INSERT/UPDATE/DELETE: 본인 행만.
-- -----------------------------------------------------------------------------

-- 헬퍼: private.current_user_group_ids()
drop policy if exists tasks_select_group_members on public.tasks;
create policy tasks_select_group_members
  on public.tasks
  for select
  to authenticated
  using (
    -- 그룹을 나가도 내가 쓴 기록은 계속 보입니다.
    user_id = (select auth.uid())
    or group_id in (select private.current_user_group_ids())
  );

-- 헬퍼: private.is_group_member(uuid)
-- WITH CHECK의 멤버십 항은 "user_id = auth.uid()"보다 엄격합니다. 내가 속하지
-- 않은 그룹의 보드에 내 할 일을 꽂아 넣는 것까지 막습니다.
drop policy if exists tasks_insert_own on public.tasks;
create policy tasks_insert_own
  on public.tasks
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and private.is_group_member(group_id)
  );

-- 헬퍼: 없음 (auth.uid()만 사용)
-- USING은 기존 행, WITH CHECK는 바뀐 행. 둘 다 필요합니다. USING만 있으면
-- user_id를 고쳐서 남에게 할 일을 떠넘길 수 있습니다.
--
-- 여기에 멤버십 항을 넣지 않는 이유: 그룹을 나간 뒤에도 SELECT와 DELETE는
-- 되는데 체크 해제만 안 되는 비일관이 생깁니다. 진짜 지켜야 할 규칙
-- ("안 속한 그룹으로 할 일을 옮길 수 없다")은 0001의
-- private.tasks_guard_group_move() 트리거가 강제합니다.
drop policy if exists tasks_update_own on public.tasks;
create policy tasks_update_own
  on public.tasks
  for update
  to authenticated
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- 헬퍼: 없음 (auth.uid()만 사용)
drop policy if exists tasks_delete_own on public.tasks;
create policy tasks_delete_own
  on public.tasks
  for delete
  to authenticated
  using (user_id = (select auth.uid()));


-- -----------------------------------------------------------------------------
-- push_subscriptions
-- 헬퍼: 없음 (auth.uid()만 사용)
--
-- 본인 행만, 네 개 동사 전부. FOR ALL 정책이지만 USING과 WITH CHECK를 모두
-- 명시했으므로 INSERT/UPDATE 후의 행도 검사됩니다.
--
-- 기기 재소유(on conflict (endpoint) do update set user_id = ...)는 이 정책을
-- 통과하지 못합니다. UPDATE의 USING이 "이전 소유자"의 행에 대해 평가되기
-- 때문입니다. 의도된 것입니다 -- 재소유는 서버가 service_role로 해야 하고,
-- 그래야 endpoint를 아는 사람이 남의 구독 행을 가로챌 수 없습니다.
-- -----------------------------------------------------------------------------
drop policy if exists push_subscriptions_all_own on public.push_subscriptions;
create policy push_subscriptions_all_own
  on public.push_subscriptions
  for all
  to authenticated
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));


-- -----------------------------------------------------------------------------
-- nudges
-- 헬퍼: private.current_user_group_ids()
--
-- SELECT 정책 하나뿐입니다. INSERT/UPDATE/DELETE 정책이 없고 GRANT도 없으므로,
-- 넛지는 public.send_nudge()(원자적 레이트 리밋) 또는 service_role로만
-- 만들어집니다. 클라이언트가 직접 행을 써서 제한을 건너뛸 수 없습니다.
-- -----------------------------------------------------------------------------
drop policy if exists nudges_select_group_members on public.nudges;
create policy nudges_select_group_members
  on public.nudges
  for select
  to authenticated
  using (group_id in (select private.current_user_group_ids()));


-- =============================================================================
-- 5. 자체 점검 (선택 -- SQL 편집기에서 돌려 보세요)
--
-- (a) RLS가 켜져 있고 FORCE가 꺼져 있는지
--   select relname, relrowsecurity, relforcerowsecurity
--   from pg_class where relnamespace = 'public'::regnamespace
--     and relname in ('profiles','groups','group_members','tasks',
--                     'push_subscriptions','nudges');
--   -> relrowsecurity = true, relforcerowsecurity = false 여야 합니다.
--
-- (b) 정책 식이 RLS 대상 테이블을 직접 참조하지 않는지 (재귀 감시)
--   select polrelid::regclass, polname, pg_get_expr(polqual, polrelid) as using_expr,
--          pg_get_expr(polwithcheck, polrelid) as check_expr
--   from pg_policy
--   where polrelid in ('public.profiles'::regclass, 'public.groups'::regclass,
--                      'public.group_members'::regclass, 'public.tasks'::regclass,
--                      'public.push_subscriptions'::regclass, 'public.nudges'::regclass);
--   -> 어떤 식에도 group_members / profiles 같은 테이블 이름이 나오면 안 됩니다.
--      private.* 헬퍼 호출과 auth.uid()만 보여야 합니다.
--
-- (c) invite_code 컬럼이 실제로 막혔는지
--   select has_column_privilege('authenticated', 'public.groups', 'invite_code', 'SELECT');
--   -> false 여야 합니다.
--   select has_column_privilege('authenticated', 'public.groups', 'name', 'SELECT');
--   -> true 여야 합니다.
--
-- (d) anon이 아무것도 못 하는지
--   select table_name, privilege_type from information_schema.role_table_grants
--   where grantee = 'anon' and table_schema = 'public';
--   -> 0행이어야 합니다.
-- =============================================================================


notify pgrst, 'reload schema';
