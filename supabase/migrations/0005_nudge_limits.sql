-- ═══════════════════════════════════════════════════════════════════════════
-- 0005_nudge_limits.sql  --  콕 찌르기 횟수 제한 해제
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 【배경】
--   0001 이 만들고 0003 이 다시 정의한 public.send_nudge 는 대상 1명당
--   "시간당 1회 / 하루 3회" 를 pg_advisory_xact_lock 으로 원자적으로
--   강제했습니다. 사용자 요청으로 이 제한을 해제합니다.
--
-- 【되돌리는 방법】 아래 두 상수만 바꾸고 이 파일을 다시 실행하세요.
--     c_hourly_limit constant int := 1;   -- 원래 값
--     c_daily_limit  constant int := 3;   -- 원래 값
--   0 = 무제한. 둘 중 하나라도 0 보다 크면 advisory lock 과 카운트 검사가
--   함께 되살아납니다. 코드 구조를 그대로 두었으므로 숫자만 고치면 됩니다.
--
-- 【알아둘 위험】
--   푸시 서비스(FCM/APNs 등)는 남용을 감지하면 구독을 스로틀하거나 아예
--   폐기합니다. 그렇게 되면 받는 쪽의 유일한 방어수단이 "알림 끄기" 가
--   되는데, 그 순간 이 앱의 핵심 기능이 죽습니다.
--   도배가 시작되면 위의 두 숫자를 되살리세요.
--
-- 【안 바뀌는 것】
--   - 로그인 확인, 자기 자신 찌르기 거부(self_nudge), 같은 그룹 확인(not_member)
--   - 자동 리마인더(source='auto')는 애초에 이 쿼터와 무관한 별개 채널
--   - 시그니처와 반환 형태 (ok, reason, nudge_id), reason 코드 집합
--     app/api/nudge/route.ts 의 rate_limited_hour / rate_limited_day 처리
--     코드는 그대로 둡니다. 제한을 되살리면 다시 도달하는 경로가 되므로
--     지우면 그때 다시 써야 합니다.
--
-- 멱등: create or replace 라 여러 번 실행해도 안전합니다.
-- ═══════════════════════════════════════════════════════════════════════════

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
  -- ★ 이 두 줄이 이 마이그레이션의 전부입니다 ★
  --   0 = 무제한. 되살리려면 1 / 3 으로.
  c_hourly_limit constant int := 0;
  c_daily_limit  constant int := 0;

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

  -- ===== 쿼터 검사 (상수가 둘 다 0 이면 통째로 건너뜁니다) =====
  --
  -- 잠금을 이 블록 안에 넣은 이유: 잠금의 존재 이유가 "세어보고 넣기" 사이의
  -- TOCTOU 를 막는 것뿐이기 때문입니다. 셀 것이 없으면 지킬 것도 없고,
  -- 잠금은 (from,to) 쌍을 직렬화하므로 무제한 모드에서는 순수한 비용입니다.
  -- 카운트 질의 2회도 함께 사라집니다.
  --
  -- 1인자 bigint 형태의 키 -- run_auto_nudges 의 2인자 (int4,int4) 형태,
  -- 0004 의 'todo:bulk_insert:' 접두사와 키 공간이 구조적으로 분리됩니다.
  if c_hourly_limit > 0 or c_daily_limit > 0 then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_uid::text || '>' || p_to_user_id::text, 0::bigint)
    );

    if c_hourly_limit > 0 then
      select count(*)::int into v_hour
      from public.nudges n
      where n.from_user_id = v_uid
        and n.to_user_id   = p_to_user_id
        and n.source       = 'manual'   -- 자동 알림은 별개 채널. 쿼터를 쓰지도, 막지도 않습니다.
        and n.created_at   > now() - interval '1 hour';

      if v_hour >= c_hourly_limit then
        return query select false, 'rate_limited_hour'::text, null::uuid;
        return;
      end if;
    end if;

    if c_daily_limit > 0 then
      select count(*)::int into v_day
      from public.nudges n
      where n.from_user_id = v_uid
        and n.to_user_id   = p_to_user_id
        and n.source       = 'manual'   -- 위와 동일.
        and n.created_at   > now() - interval '1 day';

      if v_day >= c_daily_limit then
        return query select false, 'rate_limited_day'::text, null::uuid;
        return;
      end if;
    end if;
  end if;
  -- ===== 쿼터 검사 끝 =====

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

  return query select true, null::text, v_new_id;
end;
$fn$;

alter function public.send_nudge(uuid, uuid, uuid, text) owner to postgres;
revoke all on function public.send_nudge(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.send_nudge(uuid, uuid, uuid, text) to authenticated;

comment on function public.send_nudge(uuid, uuid, uuid, text) is
  '수동 넛지 발송(source=''manual''). from_user_id 는 항상 auth.uid(). '
  '[0005] 횟수 제한 해제됨 -- 함수 상단의 c_hourly_limit / c_daily_limit 가 0. '
  '되살리려면 1 / 3 으로 바꾸고 이 파일을 다시 실행하면 advisory lock 과 '
  '카운트 검사가 함께 복원됩니다. 자기 자신 찌르기와 그룹 멤버십 검사는 계속 유효.';

-- ───────────────────────────────────────────────────────────────────────────
-- 확인 쿼리 (선택)
-- ───────────────────────────────────────────────────────────────────────────
-- 상수가 0 으로 들어갔는지:
--   select pg_get_functiondef('public.send_nudge(uuid,uuid,uuid,text)'::regprocedure)
--          like '%c_hourly_limit constant int := 0%' as unlimited;
--
-- 실제로 연속 발송이 되는지 (본인 계정 세션에서):
--   select * from public.send_nudge('<상대 uuid>', '<그룹 uuid>');
--   select * from public.send_nudge('<상대 uuid>', '<그룹 uuid>');
--   -- 두 번 다 ok = true 여야 합니다. 예전에는 두 번째가 rate_limited_hour 였습니다.
