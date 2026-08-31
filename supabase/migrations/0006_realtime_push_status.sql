-- ═══════════════════════════════════════════════════════════════════════════
-- 0006_realtime_push_status.sql  --  알림 켬/끔 노출 + 현황 화면 Realtime
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 【이 파일이 하는 일】
--   ① public.group_push_status(uuid)  -- 그룹원이 알림을 켰는지 "불리언만" 노출
--   ② public.tasks 를 supabase_realtime 퍼블리케이션에 추가 (현황 화면 실시간)
--
-- 【① 의 배경】
--   push_subscriptions 는 0002 의 push_subscriptions_all_own 정책 때문에
--   본인 행만 읽힙니다. 그래서 화면에서는 "이 친구가 알림을 켰는지" 를 알 수
--   없고, 콕 찌르기를 눌러 본 뒤에야(=상대는 아무것도 못 받은 뒤에야) 압니다.
--   이 정책을 넓히면 endpoint / p256dh / auth 키까지 그룹원에게 열립니다.
--   그건 남의 기기로 푸시를 보낼 수 있는 자격증명입니다. 절대 안 됩니다.
--   그래서 정책은 그대로 두고, SECURITY DEFINER 함수로 **불리언 한 칸만**
--   따로 뚫습니다. 0001 의 private.shares_group_with() 와 같은 발상입니다
--   ("목록은 돌려주지 않고 불리언만 답한다").
--
-- 【① 이 절대 반환하지 않는 것】
--   endpoint, p256dh, auth, expiration_time, user_agent,
--   created_at / updated_at / last_used_at, 그리고 **구독 개수**.
--   개수는 "이 친구가 기기 몇 대를 쓰는가" 라는 별개의 사생활 정보이고
--   기능상 필요가 없습니다. 그래서 count(*) 가 아니라 exists() 입니다.
--
-- 【① 이 비멤버에게 예외를 던지지 않는 이유】
--   예외를 던지면 "그 group_id 는 실재한다" 가 새고, 조회 실패(네트워크·권한)
--   와 구분할 수도 없습니다. 남의 그룹 id 를 넣어본 사람은 그냥 0행을 봅니다.
--   자기 그룹인데 아무도 안 켠 경우와 응답이 같아 보이지만, 그건 문제가
--   아닙니다. 호출자는 자기가 어느 그룹의 멤버인지 이미 알고 있습니다.
--
-- 【자체 점검이 덮는 것 / 덮지 못하는 것】
--   덮는 것: 반환 시그니처(타입 포함), security definer / owner / search_path,
--            멤버십 가드가 본문에 남아 있는지, anon·authenticated 실행 권한,
--            tasks 의 RLS(1차 방어선)와 replica identity(2차 방어선),
--            퍼블리케이션 등록, 그리고 "인증 안 된 호출자는 0행".
--   못 덮는 것: "그룹 A 의 **인증된** 멤버가 그룹 B 를 조회" -- 진짜 공격 경로.
--            역할 위장이 필요해서 실행형으로 넣지 않았습니다. 파일 끝의
--            「수동 확인 ①」 에 절차와 그 판단 근거가 있습니다.
--
-- 멱등: create or replace + do 블록 가드. 여러 번 실행해도 안전합니다.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- ① public.group_push_status(p_group_id uuid)
--      returns table (user_id uuid, has_push boolean)
-- ───────────────────────────────────────────────────────────────────────────
--
-- 호출 예 (브라우저):
--   const { data } = await supabase.rpc('group_push_status', { p_group_id: gid })
--   -- RETURNS TABLE 이라 data 는 **배열**입니다. data[0] 이 아니라 map 으로 쓰세요.
--   -- [{ user_id: '…', has_push: true }, …]
--
-- 반환 행 = "그 그룹의 멤버 전원" 입니다. 알림을 켠 사람만이 아닙니다.
-- 안 켠 사람은 has_push=false 로 나옵니다. 화면에서 멤버 목록과 조인하세요.
--
-- language sql / stable:
--   부수효과가 없고 한 트랜잭션 안에서 값이 변하지 않습니다. 플래너가
--   멤버십 검사를 한 번만 평가하게 하려는 목적도 있습니다.
create or replace function public.group_push_status(p_group_id uuid)
returns table (user_id uuid, has_push boolean)
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    gm.user_id,
    -- ★ exists() 입니다. count(*) 가 아닙니다. 기기 대수를 세지 마세요. ★
    --   push_subscriptions 의 어떤 컬럼값도 이 함수 밖으로 나가지 않습니다.
    --   나가는 것은 "행이 1건 이상 있는가" 라는 불리언뿐입니다.
    exists (
      select 1
      from public.push_subscriptions ps
      where ps.user_id = gm.user_id
    ) as has_push
  from public.group_members gm
  -- 멤버십 검사. SECURITY DEFINER 라서 RLS 가 걸리지 않으므로 여기서
  -- 직접 확인해야 합니다. private.is_group_member 는 auth.uid() 를 보고,
  -- p_group_id 가 null 이거나 비멤버면 false → 결과는 0행.
  -- (service_role/cron 처럼 auth.uid() 가 null 인 호출도 자동으로 0행입니다.)
  where p_group_id is not null
    and private.is_group_member(p_group_id)
    and gm.group_id = p_group_id;
$fn$;

alter function public.group_push_status(uuid) owner to postgres;
revoke all on function public.group_push_status(uuid) from public, anon;
grant execute on function public.group_push_status(uuid) to authenticated;

comment on function public.group_push_status(uuid) is
  '그룹원의 웹푸시 구독 여부를 불리언으로만 노출. returns table (user_id, has_push). '
  '호출자가 그 그룹 멤버가 아니거나 p_group_id 가 null 이면 예외가 아니라 0행. '
  'endpoint/p256dh/auth/user_agent/시각/구독 개수는 절대 반환하지 않습니다 '
  '(count 가 아니라 exists -- 기기 대수도 사생활 정보입니다). '
  'push_subscriptions_all_own 정책은 그대로 두고 이 함수로만 우회합니다.';


-- ───────────────────────────────────────────────────────────────────────────
-- ② Realtime -- public.tasks 를 supabase_realtime 퍼블리케이션에
-- ───────────────────────────────────────────────────────────────────────────
--
-- ⚠️⚠️ REPLICA IDENTITY 는 DEFAULT 를 유지합니다. FULL 로 바꾸지 마세요. ⚠️⚠️
--
-- 【위협 모델 정정 -- 진짜 방어선은 RLS 입니다】
--   이 주석의 이전 판은 "REPLICA IDENTITY 가 FULL 이면 삭제된 행 전체가 비멤버
--   구독자에게 방송된다" 고 단정했습니다. 한 칸 어긋난 설명이었습니다.
--   realtime-js 가 DELETE 페이로드를 만드는 지점 기준으로 실제 순서는 이렇습니다.
--
--     1차 방어선 = public.tasks 의 ROW LEVEL SECURITY.
--       RLS 가 켜져 있으면 Realtime 은 INSERT/UPDATE 페이로드를 구독자별로
--       거르고, DELETE 는 replica identity 가 FULL 이어도 클라이언트에는
--       **기본키만** 내보냅니다.
--       → 그래서 실제로 유출을 여는 스위치는 replica identity 가 아니라
--         "tasks 의 RLS 를 끄는 것" 입니다. 그 순간 replica identity 와 무관하게
--         tasks 의 모든 변경이 전 구독자에게 새어 나갑니다.
--         아래 자체 점검 (4-b) 가 이것을 검사합니다.
--
--     2차 방어선 = REPLICA IDENTITY DEFAULT.
--       RLS 가 켜져 있는 한 FULL 이어도 지금 당장 새지는 않습니다. 그래도
--       DEFAULT 를 유지합니다. 유출까지 남은 실수가 "RLS 를 끄는 것" 하나뿐인
--       상태로 두지 않기 위해서입니다. Postgres Changes 가 DELETE 에 정책을
--       평가하지 않는다는 사실 자체는 그대로이고, FULL 은 WAL 도 무겁게
--       만듭니다. 바꿀 이유가 하나도 없습니다.
--
--   결론은 이전 판과 같습니다 -- DEFAULT 유지. 0001 이 tasks/nudges 를 DEFAULT 로
--   못박아 둔 이유가 이것입니다(0001_init.sql 의 tasks 테이블 코멘트 참고).
--   아래 ②-a 는 확인만 하고 바꾸지 않습니다. 누가 FULL 로 돌려놨다면 이
--   마이그레이션은 실패해야 합니다 -- 2차 방어선이 없는 상태로 퍼블리케이션에
--   넣는 것은, 남은 실수 한 번에 전부를 거는 행위입니다.
--
-- 【클라이언트 구독 형태 -- DELETE 는 필터 없이 받습니다 (결정 A)】
--
--   `filter: 'group_id=eq.<gid>'` 를 걸면 **DELETE 가 하나도 오지 않습니다.**
--   DELETE 의 identity 튜플에는 PK(id) 뿐이라 페이로드에 group_id 가 없고,
--   realtime 의 필터 평가는 레코드에 필터 컬럼이 없으면 불일치로 처리하기
--   때문입니다(Supabase 문서의 "Delete events are not filterable" 과 같은 얘기).
--   필터를 건 채로는 체크(UPDATE)와 추가(INSERT)만 살고 삭제 반영이 죽습니다.
--
--   그래서 DELETE 리스너는 **필터 없이** 붙입니다. 치르는 대가는 두 가지입니다.
--     - 앱 전체 tasks 삭제의 "발생 사실·시각·빈도 + 무작위 uuid" 가 보입니다.
--       title / user_id / group_id / task_date 는 오지 않습니다(위 1차 방어선).
--     - 아무 인증 사용자나 자기 할 일을 추가/삭제 반복하는 것만으로, /status 를
--       열어둔 다른 사용자의 클라이언트에 갱신을 유발할 수 있습니다(증폭 벡터).
--   증폭은 **클라이언트의 갱신 빈도 상한**으로 막습니다(app/status/realtime.tsx
--   의 MIN_INTERVAL_MS). 서버가 아니라 거기가 맞는 자리입니다 -- 이벤트가 오는
--   것 자체는 막을 수 없고, 실제 방어는 반응 비용에 천장을 씌우는 것이기
--   때문입니다. 그리고 모르는 id 를 로컬 목록에서 지우려는 시도는 no-op 입니다.
--
--   【왜 broadcast 트리거(안 B)로 가지 않았는가 / 언제 옮기는가】
--   대안은 tasks 에 AFTER DELETE 트리거를 달아 realtime.send() 로 그룹별 토픽에
--   broadcast 하는 방식입니다. 위의 유출도 증폭도 함께 없앱니다. 대신
--   realtime.messages 에 대한 RLS 정책과 SECURITY DEFINER 트리거라는 공격면이
--   새로 생깁니다. 지금 규모 -- 친구 3~6명, 구글 OAuth 테스트 사용자
--   허용목록으로 **가입 자체가 통제됨** -- 에서는 그 대가가 과합니다.
--   "아무 인증 사용자" 의 모집단이 허용목록에 직접 올린 사람들뿐이기 때문입니다.
--   ▶ (B) 로 옮겨야 할 때: 가입 허용목록을 푸는 순간(공개 가입), 사용자가 수십
--     명 단위로 늘 때, 또는 갱신 빈도 상한을 올려야 할 만큼 그룹이 커질 때.
--     그때는 필터 없는 DELETE 리스너와 이 주석을 함께 걷어내세요.

-- ②-a  replica identity 확인 (바꾸지 않습니다 -- 검증만)
do $$
declare
  v_relident "char";
begin
  select c.relreplident
    into v_relident
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'tasks';

  if v_relident is null then
    raise exception 'public.tasks 가 없습니다. 0001_init.sql 을 먼저 적용하세요.';
  end if;

  if v_relident = 'f' then
    raise exception
      'public.tasks 의 REPLICA IDENTITY 가 FULL 입니다. Realtime 을 켜기 전에 '
      '반드시 되돌리세요:  alter table public.tasks replica identity default;  '
      'FULL 이면 DELETE 페이로드에 삭제된 행 전체가 실리고, Postgres Changes 는 '
      'DELETE 에 RLS 를 적용하지 않으므로 비멤버 구독자에게도 방송됩니다.';
  end if;

  if v_relident <> 'd' then
    -- 'i'(index) / 'n'(nothing). 유출은 아니지만 DELETE 페이로드가 비거나
    -- 예상과 달라져 화면 동기화가 깨집니다.
    raise warning
      'public.tasks 의 REPLICA IDENTITY 가 % 입니다(기대값 d=default). '
      'DELETE 이벤트 동기화가 정상 동작하지 않을 수 있습니다.', v_relident;
  end if;
end;
$$;

-- ②-b  퍼블리케이션에 추가 (멱등)
--   alter publication ... add table 은 이미 들어있으면 에러(42710)입니다.
--   pg_publication_tables 를 먼저 확인합니다.
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime'
  ) then
    -- Supabase 프로젝트에는 항상 있습니다. 순수 postgres 로컬 등에서 없을 때
    -- 마이그레이션 전체를 실패시키지는 않되, 조용히 넘어가지도 않습니다.
    raise warning
      'supabase_realtime 퍼블리케이션이 없어 tasks 를 추가하지 못했습니다. '
      'Realtime 이 동작하지 않습니다. 대시보드에서 Realtime 을 활성화한 뒤 '
      '이 마이그레이션을 다시 실행하세요.';
    return;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname    = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'tasks'
  ) then
    execute 'alter publication supabase_realtime add table public.tasks';
    raise notice 'public.tasks 를 supabase_realtime 에 추가했습니다.';
  else
    raise notice 'public.tasks 는 이미 supabase_realtime 에 있습니다. 건너뜁니다.';
  end if;
end;
$$;

-- ②-c  nudges 는 추가하지 **않습니다** -- 판단 근거
--
--   추가하면 "누가 나를 찔렀다" 를 소켓으로도 받을 수 있습니다. 그런데:
--
--   1) 역할이 이미 채워져 있습니다. 넛지의 전달 경로는 웹푸시입니다
--      (실기기 검증 완료, pg_cron 자동 리마인더도 같은 경로). 앱이 열려 있는
--      동안만 동작하는 두 번째 경로를 붙이면 같은 넛지가 푸시로 한 번,
--      소켓으로 한 번 -- 중복 표시를 막는 코드가 새로 필요해집니다.
--   2) 새 정보가 없습니다. 넛지는 tasks 를 바꾸지 않습니다. 현황 화면이
--      실시간으로 반영해야 할 상태는 체크/추가/삭제뿐이고 그건 tasks 입니다.
--   3) 유출 위험은 tasks 보다 큽니다. nudges 행에는 message(최대 200자)가
--      들어갑니다. DELETE 에 RLS 가 안 걸린다는 같은 함정 위에서, 언젠가
--      누가 replica identity 를 FULL 로 바꾸면 사적인 메시지가 방송됩니다.
--      구독 대상을 넓히지 않는 것이 그 사고의 반경을 줄입니다.
--   4) 구독 하나는 공짜가 아닙니다. Realtime 은 구독자마다 행별로 RLS 를
--      평가합니다. 넛지는 드물게 오는 이벤트라 이 비용이 유독 안 남습니다.
--
--   나중에 정말 필요해지면(예: 인앱 토스트) ②-b 와 같은 do 블록에 tablename
--   만 'nudges' 로 바꿔 넣으면 됩니다. 그때도 nudges 의 replica identity 는
--   DEFAULT 여야 합니다 -- 0001 이 그렇게 만들어 두었습니다.


-- ═══════════════════════════════════════════════════════════════════════════
-- 자체 점검 (이 마이그레이션이 방금 만든 상태를 검증합니다. 실패하면 롤백)
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_n         int;
  v_group     uuid;
  v_result    text;
  v_relident  "char";
begin
  -- (1) 비멤버 호출은 0행인가?
  --     이 마이그레이션은 auth.uid() 가 null 인 컨텍스트(postgres)에서 돕니다.
  --     = 어떤 그룹의 멤버도 아닌 호출자. 실재하는 그룹 id 를 넣어도 0행이어야
  --     합니다.
  --     ※ 이 점검이 덮는 것은 "인증되지 않은 호출자" 하나뿐입니다. 진짜 공격
  --        경로인 "그룹 A 의 인증된 멤버가 그룹 B 를 조회" 는 여기서 실행되지
  --        않습니다. 그건 파일 끝의 「수동 확인 ①」 이고, 왜 실행형 점검으로
  --        넣지 않았는지도 거기에 적혀 있습니다.
  select g.id into v_group from public.groups g limit 1;

  if v_group is null then
    -- 예전 주석은 "그룹이 없으면 null 경로도 함께 확인된다" 고 적었지만,
    -- 실제로는 두 테스트가 같은 테스트로 붕괴해서 진짜 케이스가 조용히
    -- 사라집니다. 사라졌다는 사실을 최소한 눈에 보이게 남깁니다.
    raise warning
      '[0006] groups 가 비어 있어 "실재하는 그룹 id 를 비멤버가 조회" 경로는 '
      '검증되지 않았습니다(아래 null 인자 점검만 돌았습니다). 그룹이 생긴 뒤 '
      '이 마이그레이션을 다시 실행하면 그 경로까지 검증됩니다.';
  else
    select count(*) into v_n from public.group_push_status(v_group);
    if v_n <> 0 then
      raise exception
        '[점검 실패] 비멤버(auth.uid() = null)가 실재하는 그룹 % 를 조회해 %행을 '
        '받았습니다. 멤버십 가드가 뚫렸습니다.', v_group, v_n;
    end if;
  end if;

  select count(*) into v_n from public.group_push_status(null::uuid);
  if v_n <> 0 then
    raise exception '[점검 실패] p_group_id = null 호출이 %행을 반환했습니다.', v_n;
  end if;

  -- (2-a) 반환 시그니처를 컬럼 "이름" 이 아니라 **타입까지 통째로** 고정합니다.
  --       이전 판은 이름만 비교해서(user_id,has_push), has_push 를 boolean 에서
  --       integer(= 기기 대수 count)로 바꿔도 그대로 통과했습니다. 이 파일이
  --       ① 본문에 별표까지 쳐 가며 지키는 규칙("count 가 아니라 exists")을
  --       정작 점검이 못 지키고 있었습니다.
  select pg_catalog.pg_get_function_result('public.group_push_status(uuid)'::regprocedure)
    into v_result;

  if v_result is distinct from 'TABLE(user_id uuid, has_push boolean)' then
    raise exception
      '[점검 실패] 반환 시그니처가 "%" 입니다. '
      '"TABLE(user_id uuid, has_push boolean)" 이어야 합니다. '
      '(has_push 는 boolean 입니다 -- integer/count 로 바꾸면 "이 친구가 기기 몇 '
      '대를 쓰는가" 가 새어 나갑니다. 컬럼이 늘었다면 push_subscriptions 의 값이 '
      '함수 밖으로 나가고 있는지 확인하세요.)', v_result;
  end if;

  -- (2-b) SECURITY DEFINER / owner=postgres / search_path='' -- **세 조건 자체**를
  --       검사합니다. 이게 없으면 누가 create or replace 하면서 search_path 를
  --       빠뜨리거나 security invoker 로 바꿔도 나머지 점검이 전부 통과합니다.
  --         · prosecdef=false     → definer 우회가 사라져 push_subscriptions_all_own
  --                                 정책에 막히고, 함수는 조용히 반쪽만 답합니다.
  --         · owner≠postgres      → definer 권한의 주체가 통째로 바뀝니다.
  --         · search_path 미설정  → 검색경로 하이재킹(public.push_subscriptions 나
  --                                 private.is_group_member 를 가짜 스키마로
  --                                 가로채기)이 열립니다. definer 함수에서 이건
  --                                 권한 상승으로 직결됩니다.
  if not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_roles r on r.oid = p.proowner
    where p.oid = 'public.group_push_status(uuid)'::regprocedure
      and p.prosecdef
      and r.rolname = 'postgres'
      -- proconfig 는 'name=value' 문자열 배열입니다. set search_path = '' 는 보통
      -- 'search_path=' 로 저장되지만 인용 방식에 따라 'search_path=""' 로 보일 수
      -- 있어 둘 다 통과시킵니다. 값이 비어 있지 않으면(예: search_path=public)
      -- 실패해야 맞습니다 -- 그건 검색경로가 다시 열린 것입니다.
      and exists (
        select 1
        from unnest(coalesce(p.proconfig, '{}'::text[])) as cfg
        where cfg like 'search_path=%'
          and btrim(split_part(cfg, '=', 2), '''"') = ''
      )
  ) then
    raise exception
      '[점검 실패] group_push_status 가 (security definer / owner=postgres / '
      'set search_path = '''') 세 조건을 모두 만족하지 않습니다. 현재 값: %',
      (select format('prosecdef=%s, owner=%s, proconfig=%s',
                     p.prosecdef,
                     (select r2.rolname from pg_catalog.pg_roles r2 where r2.oid = p.proowner),
                     coalesce(p.proconfig::text, '(없음)'))
         from pg_catalog.pg_proc p
        where p.oid = 'public.group_push_status(uuid)'::regprocedure);
  end if;

  -- (2-c) 멤버십 가드가 함수 본문에 남아 있는가?
  --       (2-a)/(2-b) 는 시그니처와 실행 컨텍스트만 봅니다. 누가 create or replace
  --       하면서 `private.is_group_member(p_group_id)` 조건만 지워도 시그니처는
  --       그대로라 둘 다 통과합니다. SECURITY DEFINER 는 RLS 를 우회하므로 그
  --       순간 group_members 전체가 아무 인증 사용자에게 열립니다.
  --       본문 문자열 검사라 정교하지 않습니다. 가드를 "통째로 지우는" 가장 큰
  --       실수만 잡습니다. 행동 자체의 검증은 파일 끝 「수동 확인 ①」 입니다.
  --       ※ 먼저 `--` 주석을 걷어내고 봅니다. 이 함수 본문의 주석에도
  --          "private.is_group_member" 라는 말이 나오기 때문에, 그냥 이름만
  --          찾으면 가드를 지워도 주석이 대신 통과시켜 줍니다(실제로 그랬습니다).
  --          그래서 주석을 제거한 뒤 호출 형태까지 확인합니다.
  if regexp_replace(
       (select p.prosrc
          from pg_catalog.pg_proc p
         where p.oid = 'public.group_push_status(uuid)'::regprocedure),
       '--[^' || chr(10) || ']*', '', 'g')
     not like '%is_group_member(p_group_id)%' then
    raise exception
      '[점검 실패] group_push_status 본문(주석 제외)에 '
      'private.is_group_member(p_group_id) 호출이 없습니다. SECURITY DEFINER 는 '
      'RLS 를 우회하므로 이 가드가 없으면 아무 인증 사용자나 남의 그룹 멤버 '
      '목록을 그대로 받아갑니다.';
  end if;

  -- (3) anon 은 실행 못 하고 authenticated 는 할 수 있는가?
  if has_function_privilege('anon', 'public.group_push_status(uuid)', 'execute') then
    raise exception '[점검 실패] anon 이 group_push_status 를 실행할 수 있습니다.';
  end if;
  if not has_function_privilege('authenticated', 'public.group_push_status(uuid)', 'execute') then
    raise exception '[점검 실패] authenticated 가 group_push_status 를 실행할 수 없습니다.';
  end if;

  -- (4-a) tasks 의 replica identity 가 여전히 'd'(default) 인가? (2차 방어선)
  select c.relreplident into v_relident
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'tasks';

  if v_relident <> 'd' then
    raise exception
      '[점검 실패] public.tasks 의 REPLICA IDENTITY 가 % 입니다(기대값 d). '
      '되돌리세요:  alter table public.tasks replica identity default;  '
      'RLS 가 켜져 있으면 FULL 이어도 당장 새지는 않지만(② 주석의 위협 모델 참고), '
      '유출까지 남은 실수가 "RLS 를 끄는 것" 하나뿐인 상태가 됩니다.',
      v_relident;
  end if;

  -- (4-b) tasks 의 RLS 가 켜져 있는가? (1차 방어선 -- 이쪽이 진짜입니다)
  --       이게 꺼지면 replica identity 와 무관하게 샙니다. Realtime 은 RLS 가
  --       켜진 테이블에서만 INSERT/UPDATE 를 구독자별로 거르고 DELETE 페이로드를
  --       기본키로 축소합니다. 0001 이 tasks 에 RLS 를 켜 두었지만, 퍼블리케이션에
  --       올린 뒤로는 "누가 디버깅하다 잠깐 껐다" 가 곧바로 유출이므로 여기서
  --       매 실행마다 확인합니다.
  if not exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'tasks'
      and c.relrowsecurity
  ) then
    raise exception
      '[점검 실패] public.tasks 의 RLS 가 꺼져 있습니다. tasks 는 supabase_realtime '
      '퍼블리케이션에 올라가 있고, Realtime 은 RLS 가 켜진 테이블에서만 INSERT/UPDATE '
      '를 구독자별로 거르고 DELETE 페이로드를 기본키로 축소합니다. RLS 가 꺼진 채로는 '
      'tasks 의 모든 변경(title 포함)이 전 구독자에게 방송됩니다. 즉시 켜세요:  '
      'alter table public.tasks enable row level security;';
  end if;

  -- (5) 퍼블리케이션에 tasks 가 들어갔는가?
  --     (supabase_realtime 자체가 없는 환경에서는 위에서 warning 을 냈으므로
  --      여기서 다시 실패시키지 않습니다.)
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_catalog.pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename  = 'tasks'
     ) then
    raise exception '[점검 실패] public.tasks 가 supabase_realtime 에 없습니다.';
  end if;

  raise notice '[0006] 자체 점검 통과.';
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 수동 확인 ① -- 비멤버 "인증 사용자" 시뮬레이션  (실행되지 않습니다. 의도적)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 자체 점검 (1) 이 덮지 못하는 진짜 공격 경로가 이것입니다:
--   "그룹 A 의 **인증된** 멤버가 그룹 B 의 id 를 넣어 호출한다."
-- 위 점검은 auth.uid() 가 null 인 postgres 컨텍스트에서만 돌기 때문에, 이
-- 경로는 한 번도 실행되지 않습니다. 아래가 그것을 실제로 실행하는 절차입니다.
--
-- 【왜 실행되는 점검이 아니라 주석인가 -- 판단 근거】
--
--   1) 이 앱에서는 거의 항상 "건너뜀" 으로 끝납니다. 시뮬레이션에는 "그 그룹의
--      멤버가 아닌 profiles 행" 이 필요합니다. 친구 3~6명이 한 그룹을 쓰는 이
--      서비스에서 그런 사용자는 보통 존재하지 않습니다. 그러면 블록은 조용히
--      warning 하나 남기고 지나갑니다. **구조적으로 거의 돌지 않는 점검**이
--      마이그레이션에 상주하면, 실제로 검증된 것보다 더 검증됐다는 착각만
--      남습니다. 자체 점검이 실제 공격 경로를 검증하지 못한다는 이 파일의
--      원래 문제를, 형태만 바꿔 반복하는 셈입니다.
--
--   2) `set local role` + 위조한 `request.jwt.claims` 는 임의 사용자로 위장하는
--      절차입니다. 이 파일은 운영 DB 의 SQL 에디터에 붙여 넣어 실행하고, 멱등
--      보장 때문에 앞으로도 여러 번 다시 실행됩니다. 위장이 걸린 상태에서 뒤
--      문장이 실패하면 복구(`reset role`)를 지나칩니다 -- 트랜잭션이 롤백되므로
--      데이터는 안전하지만, 실행 방식(에디터의 문장 배치 처리 방식)에 안전성이
--      의존하게 됩니다. 보안 마이그레이션이 기대야 할 종류의 가정이 아닙니다.
--
--   3) 이득이 검증 한 번뿐입니다. 이 블록은 읽기 전용이고 아무것도 만들지
--      않습니다. 즉 "적용" 이 아니라 "확인" 이고, 확인은 사람이 결과를 보면서
--      의도적으로 돌리는 편이 맞습니다. 매번 자동으로 흘려보낼 이유가 없습니다.
--
--   4) 실패 메시지에 실제 사용자 uuid 가 마이그레이션 로그로 나갑니다. 작지만
--      굳이 상시로 감수할 이유가 없는 노출입니다.
--
--   그래서 아래는 **손으로 한 번** 돌리는 절차로 둡니다. 돌려야 할 때:
--     · 이 마이그레이션을 처음 적용한 직후 한 번
--     · group_push_status 의 본문/시그니처를 건드린 뒤
--     · private.is_group_member 나 group_members 정책을 바꾼 뒤
--   실행 위치는 스테이징이 1순위입니다. 운영에서 돌린다면 트랜잭션으로 감싸고
--   (아래 begin/rollback) 결과만 확인한 뒤 되돌리세요. 읽기 전용이라
--   rollback 으로 흔적 없이 끝납니다.
--
-- ---------------------------------------------------------------------------
-- begin;
--
-- do $manual$
-- declare
--   v_group    uuid;
--   v_outsider uuid;
--   v_n        int;
-- begin
--   select g.id into v_group from public.groups g limit 1;
--
--   -- 그 그룹의 멤버가 "아닌" 사용자. 없으면 시뮬레이션 자체가 불가능합니다.
--   if v_group is not null then
--     select p.id into v_outsider
--     from public.profiles p
--     where not exists (
--       select 1 from public.group_members gm
--       where gm.group_id = v_group and gm.user_id = p.id
--     )
--     limit 1;
--   end if;
--
--   if v_group is null or v_outsider is null then
--     raise exception
--       '[수동 확인 ①] 시뮬레이션 불가: 그룹이 없거나, 그 그룹 밖의 사용자가 '
--       '없습니다. 그룹 두 개(또는 그룹 밖 계정 하나)를 만든 뒤 다시 돌리세요. '
--       '-- 여기서 "건너뜀" 으로 끝내면 검증한 것이 아무것도 없습니다.';
--   end if;
--
--   -- PostgREST 가 하는 것과 같은 방식으로 호출자를 위장합니다.
--   -- private.is_group_member 는 auth.uid() 를 보고, auth.uid() 는
--   -- request.jwt.claims 의 sub 를 읽습니다. is_local=true 라 트랜잭션 한정입니다.
--   set local role authenticated;
--   perform pg_catalog.set_config(
--     'request.jwt.claims',
--     pg_catalog.json_build_object('sub', v_outsider::text, 'role', 'authenticated')::text,
--     true);
--
--   select count(*) into v_n from public.group_push_status(v_group);
--
--   reset role;   -- set local role postgres 가 아닙니다. 원래 역할로 되돌립니다.
--   perform pg_catalog.set_config('request.jwt.claims', '', true);
--
--   if v_n <> 0 then
--     raise exception
--       '[점검 실패] 그룹 % 의 비멤버(인증된 사용자 %)가 %행을 받았습니다. '
--       '멤버십 가드가 뚫렸습니다.', v_group, v_outsider, v_n;
--   end if;
--
--   raise notice '[수동 확인 ①] 비멤버 인증 사용자 시뮬레이션 통과 (0행).';
-- end;
-- $manual$;
--
-- rollback;   -- 읽기 전용입니다. 확인만 하고 되돌립니다.
-- ---------------------------------------------------------------------------


-- ───────────────────────────────────────────────────────────────────────────
-- 손으로 해보는 확인 (선택 -- 실제 로그인 세션에서)
-- ───────────────────────────────────────────────────────────────────────────
-- 내 그룹: 멤버 전원이 나오고 컬럼은 두 개뿐이어야 합니다.
--   select * from public.group_push_status('<내 그룹 uuid>');
--
-- 남의 그룹: 0행. 에러가 아니라 0행입니다.
--   select * from public.group_push_status('<남의 그룹 uuid>');
--
-- 서명(인자/반환 형태) 확인:
--   select pg_get_function_arguments('public.group_push_status(uuid)'::regprocedure),
--          pg_get_function_result   ('public.group_push_status(uuid)'::regprocedure);
--   -- p_group_id uuid  /  TABLE(user_id uuid, has_push boolean)
--   -- 반환 쪽은 자체 점검 (2-a) 가 이 문자열과 통째로 비교합니다. has_push 가
--   -- boolean 이 아니면 마이그레이션이 실패합니다.
--
-- 실행 컨텍스트(자체 점검 (2-b) 와 같은 것) 확인:
--   select p.prosecdef, r.rolname as owner, p.proconfig
--   from pg_proc p join pg_roles r on r.oid = p.proowner
--   where p.oid = 'public.group_push_status(uuid)'::regprocedure;
--   -- t / postgres / {search_path=}
--
-- 퍼블리케이션 상태:
--   select schemaname, tablename from pg_publication_tables
--   where pubname = 'supabase_realtime' order by 1, 2;
--
-- RLS(1차 방어선) + replica identity(2차 방어선) 한 번에:
--   select relname, relrowsecurity, relreplident from pg_class
--   where relnamespace = 'public'::regnamespace and relname in ('tasks','nudges');
--   -- relrowsecurity 는 t 여야 합니다. f 면 즉시 켜세요 -- 이쪽이 진짜 방어선이고,
--   --   꺼지면 replica identity 와 무관하게 tasks 전체가 방송됩니다.
--   -- relreplident 는 d 여야 합니다. f(FULL) 면 되돌리세요.
