-- ═══════════════════════════════════════════════════════════════════════════
-- 0009_admin_and_pledge.sql  --  관리자 목록 + 찌르기 기본 메시지 + 그룹 공약
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 【이 파일이 만드는 것】
--   ① private.app_admins            -- 관리자 이메일 목록 (Data API 비노출)
--   ② private.is_app_admin()        -- JWT email 클레임으로 판정. RLS/RPC 의 근거
--   ③ public.am_i_admin()           -- 화면이 버튼을 보여줄지 결정하는 편의 함수
--   ④ profiles.nudge_message        -- 내가 보낼 찌르기 기본 메시지 (RPC 로만 쓰기)
--      public.set_nudge_message(text)
--   ⑤ public.group_pledges          -- 그룹당 1행. 멤버는 읽기, 관리자만 쓰기
--      public.set_group_pledge(uuid, text)
--   ⑥ 자체 점검 -- 카탈로그 점검 + **가짜 JWT 를 실제로 세팅해서** 판정 실증
--
-- 【이 파일이 하지 않는 것 -- 의도적】
--   * 타임라인(0010) 과 루틴(0011) 은 건드리지 않습니다. 다만 그 두 파일이
--     private.is_app_admin() 을 쓰므로 **0009 를 먼저** 적용해야 합니다.
--   * "관리자를 추가/삭제하는 RPC" 를 만들지 않습니다. 관리자 승격은 앱 기능이
--     아니라 운영 행위입니다. RPC 가 있으면 그 RPC 자체가 권한 상승 표면이 되고,
--     3~6명짜리 앱에서 그 표면을 유지·감사할 이유가 없습니다.
--     추가는 SQL 에디터에서 (또는 service_role 서버 라우트에서):
--       insert into private.app_admins (email, note) values ('...', '...')
--         on conflict (email) do nothing;
--     삭제는 delete from private.app_admins where email = '...';
--     둘 다 **즉시** 반영됩니다 (is_app_admin 이 매 호출마다 테이블을 읽습니다).
--
-- 멱등: create ... if not exists / create or replace / do 블록 가드 /
--       drop policy if exists / on conflict do nothing. 여러 번 실행해도 안전합니다.
-- 반드시 `postgres` 역할로 실행하세요 (SECURITY DEFINER 의 근거).
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- ① private.app_admins  --  관리자 이메일 목록
-- ───────────────────────────────────────────────────────────────────────────
--
-- 【왜 public 이 아니라 private 인가】
--   public 스키마의 테이블은 Data API(PostgREST)로 노출됩니다. RLS 를 켜고
--   정책을 하나도 안 만들면 행은 안 보이지만, **테이블의 존재와 컬럼 이름은
--   OpenAPI 스펙(GET /rest/v1/)에 그대로 나옵니다.** 그리고 정책을 한 줄
--   잘못 쓰는 순간(예: `using (true)`) "누가 이 앱의 관리자인가" 라는 이메일
--   목록이 통째로 새어 나갑니다. 이메일은 그 자체로 개인정보이고, 이 목록은
--   "이 계정을 노리면 전체 권한이 열린다" 는 표적 안내문이기도 합니다.
--
--   private 스키마는 0001 의 방침대로 Settings -> API -> Exposed schemas 에
--   절대 넣지 않습니다. 넣지 않는 한 PostgREST 는 이 테이블을 모릅니다.
--   그래서 목록 자체가 API 표면에서 사라집니다. 판정 결과(boolean) 만
--   ③ am_i_admin() 으로 나갑니다 -- 그것도 **호출자 자신에 대해서만**.
--
-- 【왜 profiles.is_admin 불리언 컬럼이 아닌가】
--   사용자가 "관리자 목록 테이블" 을 골랐고, 그 선택이 맞습니다.
--   profiles 는 auth.users 를 참조하므로 계정을 지웠다 다시 만들면 uuid 가
--   바뀌고 플래그가 사라집니다. 이메일 기준 목록은 그 사이클을 견딥니다.
--   그리고 profiles 에 컬럼을 더하면 컬럼 단위 GRANT 목록을 또 손봐야 하고,
--   SELECT 에 넣으면 그룹 동료에게 관리자 여부가 보입니다.
create table if not exists private.app_admins (
  email    text        primary key,
  note     text,
  added_at timestamptz not null default now(),

  -- 길이: RFC 5321 의 경로 상한이 320 (local 64 + '@' + domain 255).
  constraint app_admins_email_len_chk
    check (char_length(email) between 3 and 320),

  -- 정규화 강제. is_app_admin() 은 JWT 값을 lower(btrim(...)) 해서 비교하므로,
  -- 여기에 'GiTue11@Gmail.com ' 같은 값이 들어가면 **영원히 매치되지 않습니다**.
  -- 조용히 권한이 안 붙는 고장이라 CHECK 으로 못 들어가게 막습니다.
  constraint app_admins_email_normalized_chk
    check (email = lower(btrim(email))),

  -- 모양만 봅니다. 이메일을 정규식으로 "검증" 하려 들지 않습니다 -- 여기서
  -- 막으려는 건 오타로 'gitue11gmail.com' 이나 '  ' 이 들어가는 것뿐입니다.
  -- ⚠ 반복 횟수({1,320} 같은 것)를 쓰지 마세요. Postgres 정규식의 반복 횟수
  --   상한은 255 이고, 넘기면 2201B 로 마이그레이션이 죽습니다 (0005 의 선례).
  constraint app_admins_email_shape_chk
    check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),

  constraint app_admins_note_len_chk
    check (note is null or char_length(btrim(note)) between 1 and 200)
);

-- 0001 의 습관: 만든 직후 같은 트랜잭션에서 RLS 를 켜고 권한을 회수합니다.
-- private 스키마라 Data API 로는 어차피 안 보이지만, 이 테이블만은 "언젠가
-- private 가 실수로 노출되는" 시나리오까지 버텨야 하므로 이중으로 잠급니다.
alter table private.app_admins enable row level security;
revoke all on private.app_admins from public, anon, authenticated;

-- service_role 만 정책을 하나 받습니다. 서버 라우트에서 관리자 목록을
-- 조회/수정할 수 있게 하려는 것입니다.
-- ★ BYPASSRLS 에 기대지 않고 정책을 명시하는 이유 ★
--   service_role 이 BYPASSRLS 를 갖는다는 건 Supabase 의 현재 구성이지
--   이 스키마가 보증하는 사실이 아닙니다. 명시해 두면 그 전제가 바뀌어도
--   서버 라우트가 조용히 0행을 받는 일이 없습니다.
grant all on private.app_admins to service_role;

drop policy if exists app_admins_service_role_all on private.app_admins;
create policy app_admins_service_role_all
  on private.app_admins
  for all
  to service_role
  using (true)
  with check (true);   -- FOR ALL 은 USING 만으로 쓰기 후의 행을 검사하지 않습니다 (규칙 2)

comment on table private.app_admins is
  '앱 관리자 이메일 목록. ★ private 스키마 ★ -- public 에 두면 "누가 관리자인가" 가 '
  'Data API 의 OpenAPI 스펙과 한 줄짜리 정책 실수로 통째로 새어 나갑니다. '
  '판정은 private.is_app_admin() 하나만 하고, 화면에는 public.am_i_admin() 이 '
  '호출자 자신에 대한 boolean 만 돌려줍니다. '
  '추가/삭제는 RPC 없이 SQL 로 직접 (관리자 승격은 앱 기능이 아니라 운영 행위입니다). '
  '추가/삭제는 즉시 반영됩니다 -- 다만 토큰 갱신 전까지는 프런트의 am_i_admin 캐시가 낡을 수 있습니다.';

comment on column private.app_admins.email is
  '반드시 소문자·공백제거 상태여야 합니다(CHECK 강제). is_app_admin() 이 JWT 의 '
  'email 클레임을 lower(btrim(...)) 해서 비교하므로, 대문자가 섞이면 조용히 매치되지 않습니다.';
comment on column private.app_admins.note is
  '누가 왜 관리자인지. 감사 흔적용이고 판정에는 쓰이지 않습니다.';


-- 시드. 사용자가 지정한 계정 하나.
-- on conflict do nothing: 이미 있으면 note/added_at 을 덮어쓰지 않습니다
-- (운영 DB 에서 note 를 손으로 고쳐 놨을 수 있고, added_at 은 감사 값입니다).
insert into private.app_admins (email, note)
values ('gitue11@gmail.com', '앱 제작자. 0009 시드.')
on conflict (email) do nothing;


-- ───────────────────────────────────────────────────────────────────────────
-- ② private.is_app_admin() -> boolean
-- ───────────────────────────────────────────────────────────────────────────
--
-- 【판정 근거를 무엇으로 삼는가 -- 이 파일에서 가장 중요한 결정】
--
--   후보 세 가지를 실제로 따져 봤습니다.
--
--   (A) auth.jwt() ->> 'email'      -- **채택**
--       JWT 최상위 email 클레임입니다. 이 값은 GoTrue 가 토큰을 발급할 때
--       auth.users.email 에서 복사해 넣고, 토큰 전체가 프로젝트 JWT 시크릿으로
--       서명됩니다. 클라이언트가 고칠 수 있는 값이 아닙니다.
--       구글 OAuth 로그인에서 auth.users.email 은 구글이 확인한 주소이고,
--       그 뒤에 주소를 바꾸려면 supabase.auth.updateUser({ email }) -> 새 주소
--       (기본 설정에서는 기존 주소까지) 메일 확인을 통과해야 합니다.
--       즉 이 값의 신뢰도는 "그 메일함을 실제로 통제하는가" 와 같습니다.
--       관리자 판정 기준으로 딱 그만큼이면 충분합니다.
--
--   (B) auth.jwt() -> 'user_metadata' ->> 'email'   -- ★ 절대 쓰면 안 됨 ★
--       구글 로그인 응답이 여기에도 email 과 email_verified 를 넣어 주기 때문에
--       "이게 더 원본에 가깝다" 는 착각을 하기 쉽습니다. 아닙니다.
--       user_metadata 는 **로그인한 사용자가 직접 쓸 수 있습니다**:
--         await supabase.auth.updateUser({ data: { email: 'gitue11@gmail.com',
--                                                  email_verified: true } })
--       한 줄이면 누구나 관리자가 됩니다. 확인 메일도, 어떤 검증도 없습니다.
--       ▶ 아래 자체 점검 (5) 가 이 실수를 **실제로 재현해서** 막습니다.
--         (app_metadata 는 사용자가 못 씁니다만, 거기에는 email 이 없습니다.)
--
--   (C) auth.uid() 로 auth.users 를 다시 읽기        -- 채택하지 않음
--       가장 "최신" 이긴 합니다(이메일을 바꾸면 토큰 만료를 안 기다려도 됩니다).
--       하지만 (a) auth 스키마 읽기 권한은 Supabase 가 버전 간에 보증해 주는
--       계약이 아니고, 권한이 빠지는 순간 이 함수가 **예외를 던지며** 모든
--       RLS 정책 평가가 터집니다. (b) 얻는 것은 최대 1시간의 지연 단축뿐입니다.
--       ▶ 지금은 (A). 만약 "이메일 변경 즉시 반영" 이 필요해지면 여기 한 곳만
--         고치면 됩니다 -- 호출부는 전부 이 함수를 경유합니다.
--
-- 【이메일이 없거나 비어 있으면 false】
--   anon 키(email 클레임 없음), service_role 키(없음), 익명 로그인(없음),
--   토큰 자체가 없는 postgres/cron 컨텍스트(auth.jwt() 가 '{}') -- 전부 false.
--   sub(=auth.uid()) 도 함께 요구합니다. "주체가 없는데 이메일만 있는" 토큰은
--   정상 세션이 아니고, 관리자 행동은 반드시 누군가의 행동이어야 합니다.
--
-- 【왜 인자가 없는가】
--   0001 의 private 헬퍼들과 같은 이유입니다. "누구로서 판정할지" 를 인자로
--   받으면 그 순간 조준이 가능해집니다. 이 함수는 호출자 자신에 대해서만 답합니다.
--
-- STABLE: 한 statement 안에서 값이 변하지 않습니다. 플래너가 RLS 정책 안에서
--   행마다가 아니라 InitPlan 으로 한 번만 실행합니다.
-- SECURITY DEFINER: authenticated 에게는 private.app_admins 읽기 권한이
--   없습니다(①). 본문이 postgres 로 실행되어야 목록을 읽을 수 있습니다.
create or replace function private.is_app_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
    from private.app_admins a
    where a.email = nullif(
            pg_catalog.lower(pg_catalog.btrim(coalesce(auth.jwt() ->> 'email', ''))),
            '')
      and auth.uid() is not null
  );
$fn$;

alter function private.is_app_admin() owner to postgres;
revoke all on function private.is_app_admin() from public, anon;
-- 정책 식은 질의하는 역할로 평가되므로 authenticated 에게 EXECUTE 가 실제로
-- 필요합니다 (0001 의 private 헬퍼들과 같은 이유). anon 에는 주지 않습니다.
grant execute on function private.is_app_admin() to authenticated;

comment on function private.is_app_admin() is
  '호출자가 앱 관리자인가. 판정 근거는 JWT **최상위** email 클레임 하나뿐입니다 '
  '(GoTrue 가 auth.users.email 에서 복사해 서명한 값 -- 클라이언트가 못 고칩니다). '
  '★ auth.jwt() -> ''user_metadata'' ->> ''email'' 로 바꾸지 마세요 ★ -- '
  'user_metadata 는 updateUser({data}) 로 사용자가 직접 쓸 수 있어서 한 줄이면 누구나 관리자가 됩니다. '
  '이메일이 없거나 비었으면(anon/service_role/익명로그인/cron) false. sub 도 함께 요구합니다. '
  '인자 없음 = 다른 사람으로 조준 불가. 이것이 유일한 보안 경계입니다 -- public.am_i_admin() 은 편의일 뿐입니다.';


-- ───────────────────────────────────────────────────────────────────────────
-- ③ public.am_i_admin() -> boolean
-- ───────────────────────────────────────────────────────────────────────────
--
-- 화면이 "공약 수정" / "루틴 만들기" 버튼을 그릴지 결정하려면 이 값이 필요합니다.
--
-- ⚠ 이건 **보안 경계가 아닙니다**. 편의 함수입니다.
--   프런트가 이 값을 true 로 조작해도(응답을 가로채든 상태를 바꾸든) 얻는 것은
--   버튼이 보이는 것뿐이고, 그 버튼이 부르는 RPC 는 전부 자기 안에서
--   private.is_app_admin() 을 다시 확인합니다. 강제는 언제나 서버에서,
--   각 RPC 안에서 일어납니다.
--
-- 새어 나가는 정보: 호출자 자신이 관리자인지 여부(boolean) 하나. 인자가 없어서
-- 남에 대해 물어볼 수 없고, 관리자 목록도 개수도 나가지 않습니다.
create or replace function public.am_i_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select private.is_app_admin();
$fn$;

alter function public.am_i_admin() owner to postgres;
revoke all on function public.am_i_admin() from public, anon;
grant execute on function public.am_i_admin() to authenticated;

comment on function public.am_i_admin() is
  '호출자가 관리자인지 boolean 하나. 화면 분기(버튼 노출)용 **편의 함수**이고 보안 경계가 아닙니다. '
  '진짜 강제는 set_group_pledge / upsert_routine / set_routine_assignees 등 각 RPC 안의 '
  'private.is_app_admin() 입니다. 인자 없음 = 남에 대해 물어볼 수 없습니다.';


-- ───────────────────────────────────────────────────────────────────────────
-- ④ profiles.nudge_message  +  public.set_nudge_message(text)
-- ───────────────────────────────────────────────────────────────────────────
--
-- 【길이 상한을 200 으로 맞추는 이유】
--   0001 -> 0003 -> 0005 로 세 번 재정의된 public.send_nudge 는 본문에서
--     v_msg := nullif(left(btrim(coalesce(p_message, '')), 200), '');
--   로 메시지를 **200자에서 자릅니다**. 그리고 0001 의 nudges 테이블에도
--     check (message is null or char_length(btrim(message)) between 1 and 200)
--   이 있습니다.
--   여기에 300자를 저장할 수 있게 해 두면, 설정 화면에서는 300자가 저장되는데
--   실제로 보내지는 건 200자가 되어 "내가 쓴 게 잘려서 갔다" 는, 원인을 알 수
--   없는 어긋남이 생깁니다. 그래서 같은 값으로 고정합니다.
--   ▶ 아래 자체 점검 (4) 가 send_nudge 의 본문에서 그 숫자를 **뽑아 와서**
--     이 CHECK 의 상한과 같은지 비교합니다. 한쪽만 바꾸면 마이그레이션이 실패합니다.
alter table public.profiles
  add column if not exists nudge_message text;

-- add column 과 constraint 를 나눈 이유는 0007 과 같습니다: 컬럼이 이미 있으면
-- `add column if not exists ... check (...)` 는 CHECK 까지 통째로 건너뛰어,
-- 컬럼만 있고 제약은 없는 상태가 영구히 굳습니다.
do $do$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname  = 'profiles_nudge_message_len_chk'
  ) then
    alter table public.profiles
      add constraint profiles_nudge_message_len_chk
      check (
        nudge_message is null
        or char_length(btrim(nudge_message)) between 1 and 200
      );
  end if;
end
$do$;

comment on column public.profiles.nudge_message is
  '내가 콕 찌를 때 기본으로 실릴 메시지. NULL 이면 메시지 없이 찌릅니다. '
  '상한 200자 -- public.send_nudge() 가 left(btrim(...), 200) 으로 자르는 길이와 **반드시** 같아야 합니다. '
  '쓰기는 public.set_nudge_message() 만 (UPDATE 컬럼 GRANT 없음). '
  '읽기는 같은 그룹 멤버에게도 열려 있습니다 -- 어차피 그들에게 보낼 문장이기 때문입니다.';


-- ④-b 권한(GRANT) -- 0002 -> 0003 -> 0007 로 이어진 컬럼 단위 목록에 추가
--
-- 현재 상태: 0007 이 profiles 의 SELECT 를
--   (id, display_name, avatar_emoji, timezone, created_at, default_group_id, avatar_url)
-- 로 좁혀 놨습니다. 그래서 새 컬럼을 그냥 추가하면 **본인조차 못 읽습니다**.
-- 컬럼 GRANT 는 역할 단위라 "내 것만 읽기" 같은 건 없습니다 -- 목록에 없으면 끝입니다.
--
-- 【nudge_message 를 SELECT 에 넣어도 되는가 -- 판단】
--   profiles 의 SELECT 정책은 "나 자신 또는 나와 그룹을 공유하는 사람" 입니다.
--   즉 그룹 동료가 내 기본 찌르기 메시지를 미리 읽습니다.
--   그래도 넣습니다. 이 문장은 **바로 그 사람들에게 보내려고 쓴 문장** 이라
--   미리 보인다고 새로 새는 정보가 없습니다. 0003 이 감춘 auto_nudge_at
--   ("몇 시에 자는지") 과는 성격이 다릅니다.
--   그리고 설정 화면이 현재 값을 보여주려면 읽기 경로가 필요한데, 대안은
--   get_nudge_message() RPC 를 하나 더 만드는 것뿐입니다. 얻는 것에 비해
--   유지할 표면이 늘어납니다.
--   ▶ 감춰야 할 때가 오면(예: 메시지에 사적인 내용을 쓰게 되면) 이 컬럼을
--     SELECT 목록에서 빼고 get_nudge_message() 를 추가하세요. 화면 코드가
--     자기 값만 읽으므로 그 전환은 국소적입니다.
--
-- 【UPDATE GRANT 에는 넣지 않습니다 -- 0003/0007 의 선례와 동일】
--   ★ 여기에 nudge_message 를 추가하지 마세요. ★ 추가하는 순간 RPC 의
--   200자 절단이 우회되어, CHECK 이 거부하는 201자 입력이 UPDATE 실패
--   (23514) 로 사용자에게 터져 나오고, 무엇보다 "RPC 로만 쓴다" 는 계약이
--   깨집니다. 아래 자체 점검 (3) 이 이걸 실제로 막습니다.
revoke select on public.profiles from authenticated;
grant select (id, display_name, avatar_emoji, timezone, created_at,
              default_group_id, avatar_url, nudge_message)
  on public.profiles to authenticated;

-- service_role 은 테이블 단위 ALL 이라 새 컬럼도 자동 포함입니다.
-- (0003/0007 과 같은 이유로 명시적으로 한 번 더.)
grant all on public.profiles to service_role;


-- ④-c public.set_nudge_message(p_message text) returns void
--
-- 계약:
--   * auth.uid() 본인 행만. "누구로서 쓸지" 를 인자로 받지 않습니다.
--   * NULL 또는 공백만 있는 문자열이면 **해제**(NULL 저장).
--   * 200자를 넘으면 거부하지 않고 **자릅니다**. send_nudge 와 정확히 같은 식을
--     씁니다 -- 같은 입력이 두 경로에서 다르게 처리되면 안 되기 때문입니다.
--     (set_avatar 는 거부였습니다. 거기서는 "형태가 틀렸다" 는 사용자가 고쳐야
--      할 오류였고, 여기서는 "길다" 는 서버가 이미 처리 방법을 정해 둔 값입니다.)
--   * 프로필 행이 없으면 P0002. 0행 UPDATE 를 조용한 성공으로 보고하지 않습니다.
--
-- ★ 잘린 결과를 화면이 알아야 하므로, 호출 뒤 profiles 를 다시 읽어 실제 값으로
--   입력란을 그리세요. (void 는 계약입니다 -- 0007 의 두 RPC 와 같습니다.)
create or replace function public.set_nudge_message(p_message text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_msg text;
  v_n   int;
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;

  -- ★ send_nudge 본문과 **같은 식** ★ (0001/0003/0005 의
  --   v_msg := nullif(left(btrim(coalesce(p_message, '')), 200), ''); 와 동일)
  --   숫자를 바꾸려면 send_nudge 와 profiles_nudge_message_len_chk 도 같이
  --   바꿔야 합니다. 자체 점검 (4) 가 세 값이 어긋나면 실패합니다.
  v_msg := nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p_message, '')), 200), '');

  update public.profiles p
     set nudge_message = v_msg
   where p.id = v_uid;

  get diagnostics v_n = row_count;

  if v_n = 0 then
    -- 0001 의 handle_new_user 가 실패했고 0002 의 안전밸브도 아직 안 돈 상태.
    raise exception '프로필을 찾을 수 없습니다. 다시 로그인해 주세요.'
      using errcode = 'P0002';
  end if;
end;
$fn$;

alter function public.set_nudge_message(text) owner to postgres;
revoke all on function public.set_nudge_message(text) from public, anon;
grant execute on function public.set_nudge_message(text) to authenticated;

comment on function public.set_nudge_message(text) is
  '콕 찌르기 기본 메시지 설정. auth.uid() 본인 행만. NULL/공백이면 해제. '
  '200자를 넘으면 거부가 아니라 자릅니다 -- public.send_nudge() 와 정확히 같은 식이라 '
  '두 경로가 같은 입력을 다르게 처리하지 않습니다. 잘릴 수 있으므로 호출 뒤 profiles 를 다시 읽으세요. '
  '프로필 행이 없으면 P0002 (0행 UPDATE 를 성공으로 보고하지 않습니다).';


-- ───────────────────────────────────────────────────────────────────────────
-- ⑤ public.group_pledges  +  public.set_group_pledge(uuid, text)
-- ───────────────────────────────────────────────────────────────────────────
--
-- 홈에 뜨는 "그룹 공약". 그룹당 정확히 한 줄(문단)이고, 관리자만 씁니다.
--
-- 【왜 group_id 에 UNIQUE 인가】
--   "그룹당 하나" 를 애플리케이션 코드가 아니라 스키마가 지키게 합니다.
--   그리고 이 UNIQUE 가 set_group_pledge 의 `on conflict (group_id) do update`
--   를 원자적으로 만들어 줍니다 -- "있으면 update, 없으면 insert" 를 손으로
--   짜면 READ COMMITTED 에서 두 번 눌렀을 때 23505 가 납니다.
--
-- 【왜 id 를 따로 두는가 (group_id 를 PK 로 쓰지 않고)】
--   0001~0008 의 모든 public 테이블이 uuid id 를 PK 로 갖고 있고, PostgREST
--   기반 클라이언트 코드가 그 규약에 기대고 있습니다. 여기서만 깨지 않습니다.
create table if not exists public.group_pledges (
  id         uuid        primary key default gen_random_uuid(),
  group_id   uuid        not null unique references public.groups (id) on delete cascade,
  body       text        not null,

  -- 누가 마지막으로 고쳤는가. 관리자가 바뀌거나 탈퇴해도 공약 자체는 남아야
  -- 하므로 on delete set null 이고, 따라서 nullable 입니다.
  updated_by uuid        references public.profiles (id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- 1..2000. 공약은 홈 화면에 통째로 렌더되는 문단입니다. 200(할 일 제목)은
  -- 너무 짧고, 무제한은 홈 화면을 통째로 밀어냅니다.
  -- btrim 길이 >= 1 이므로 공백만 있는 공약은 저장되지 않습니다.
  -- (set_group_pledge 는 그런 입력을 "삭제" 로 해석합니다.)
  constraint group_pledges_body_len_chk
    check (char_length(btrim(body)) between 1 and 2000)
);

-- 0001 의 습관: 만든 직후 같은 트랜잭션에서 RLS 를 켜고 권한을 회수합니다.
alter table public.group_pledges enable row level security;
revoke all on public.group_pledges from anon, authenticated;

-- Realtime DELETE 이벤트는 RLS 로 걸러지지 않습니다(0001 의 경고). REPLICA
-- IDENTITY 는 DEFAULT(PK만)로 둡니다. FULL 로 바꾸면 삭제된 공약 본문 전체가
-- 모든 구독자에게 갑니다.
alter table public.group_pledges replica identity default;

-- ⚠ supabase_realtime publication 에 **넣지 않습니다**. 공약은 관리자가 가끔
--   고치는 값이라 실시간으로 밀어 줄 이유가 없고, publication 에 넣는 순간
--   위의 DELETE 이벤트 문제를 떠안게 됩니다. 홈 화면 진입 시 한 번 읽으세요.

comment on table public.group_pledges is
  '그룹당 1행(group_id UNIQUE)인 그룹 공약. 같은 그룹 멤버는 읽기, 쓰기는 관리자만입니다. '
  'authenticated 에게 INSERT/UPDATE/DELETE 권한도 정책도 주지 않습니다 -- '
  '유일한 쓰기 문은 public.set_group_pledge() 입니다.';
comment on column public.group_pledges.body is
  '공약 본문. 1~2000자. 빈 문자열로 저장할 수 없습니다 -- set_group_pledge 는 빈 입력을 삭제로 해석합니다.';
comment on column public.group_pledges.updated_by is
  '마지막으로 고친 사람. 감사 흔적이고 권한 판정에는 쓰이지 않습니다(판정은 항상 private.is_app_admin()). '
  '그 계정이 지워져도 공약은 남아야 하므로 on delete set null 입니다.';

-- FK 인덱스: profiles 삭제 시 SET NULL 캐스케이드가 group_pledges 순차 스캔을
-- 하지 않도록 (0001 의 groups_created_by_idx 와 같은 이유).
-- 부분 인덱스인 것은 updated_by 가 NULL 인 행이 정상적으로 존재하기 때문입니다.
create index if not exists group_pledges_updated_by_idx
  on public.group_pledges (updated_by)
  where updated_by is not null;
-- group_id 조회는 UNIQUE 제약이 만든 인덱스를 그대로 탑니다. 따로 만들지 않습니다.

drop trigger if exists group_pledges_set_updated_at on public.group_pledges;
create trigger group_pledges_set_updated_at
  before update on public.group_pledges
  for each row
  when (old.* is distinct from new.*)   -- 무의미한 UPDATE 는 updated_at 을 건드리지 않음
  execute function public.set_updated_at();


-- ⑤-b GRANT -- 읽기만 엽니다
--
-- 새 테이블이므로 컬럼 단위로 좁힐 이유가 없습니다(0004 의 task_templates 와
-- 같은 판단). 모든 컬럼이 멤버에게 보여도 되는 값입니다.
--
-- ★ INSERT/UPDATE/DELETE 는 **GRANT 자체를 하지 않습니다** ★
--   정책만 안 만드는 것과는 다릅니다. 권한이 없으면 나중에 누가 정책을 하나
--   잘못 추가해도 (예: `for all using (true)`) 여전히 42501 로 막힙니다.
--   방어를 두 겹으로 두는 이유는 이 테이블의 쓰기가 "관리자만" 이라는 규칙
--   하나에 통째로 걸려 있기 때문입니다.
grant select on public.group_pledges to authenticated;
grant all    on public.group_pledges to service_role;


-- ⑤-c RLS 정책 -- SELECT 하나뿐
--
-- 헬퍼: private.is_group_member(uuid)  (0001)
-- ★ 정책 안에서 group_pledges 를 직접 SELECT 하지 않습니다 ★ (규칙 1: 42P17)
--   여기서 읽는 것은 group_members 뿐이고, 그것도 SECURITY DEFINER 헬퍼를
--   경유합니다.
--
-- 비멤버에게는 예외가 아니라 **0행** 입니다(규칙 8). RLS 는 원래 그렇게
-- 동작합니다 -- "그 그룹에 공약이 있는지" 조차 알 수 없습니다.
drop policy if exists group_pledges_select_member on public.group_pledges;
create policy group_pledges_select_member
  on public.group_pledges
  for select
  to authenticated
  using (private.is_group_member(group_id));

-- INSERT/UPDATE/DELETE 정책은 **일부러 만들지 않습니다**.
-- 만들면 "관리자인가" 를 정책 식에 넣게 되는데, 그러면 판정이 정책과 RPC
-- 두 곳으로 갈라집니다. 쓰기 경로를 set_group_pledge 하나로 좁혀 두면
-- 관리자 판정도 한 곳, 입력 정규화(빈 문자열 -> 삭제)도 한 곳입니다.


-- ⑤-d public.set_group_pledge(p_group_id uuid, p_body text) returns void
--
-- 계약:
--   * 로그인하지 않았으면 42501. (그 외 모든 거절은 조용합니다.)
--   * private.is_app_admin() 이 false 면 **조용히 무시**. 예외 없음, 반환 없음.
--   * 내가 그 그룹의 멤버가 아니면 역시 **조용히 무시**.
--   * p_body 가 NULL 이거나 공백뿐이면 그 그룹의 공약을 **삭제**.
--   * 그 외에는 upsert. updated_by = auth.uid().
--   * 2000자를 넘으면 22023 으로 거부(관리자 인증을 통과한 뒤에만 도달합니다).
--
-- 【왜 비관리자에게 예외를 던지지 않는가 -- 규칙 8】
--   예외를 던지면 응답 코드가 "너는 관리자가 아니다" 를 확정해 줍니다. 그건
--   "관리자라는 게 존재한다 / 이 앱에는 특권 계정이 있다" 를 알려 주는 것이고,
--   더 나쁜 건 p_group_id 를 바꿔 가며 부를 때 **어떤 그룹이 실재하는지** 가
--   에러 종류(권한 오류 vs FK 오류)로 새어 나가는 것입니다.
--   0006 의 group_push_status 와 0007 의 set_default_group 이 같은 이유로
--   조용한 무동작을 택했습니다.
--
-- 【그런데 화면이 "저장됐다" 고 거짓말하면 안 됩니다 -- 정상 경로】
--   ★ 정상 경로는 public.am_i_admin() 이 false 인 사용자에게 **버튼 자체를
--     보여주지 않는 것** 입니다. ★
--   조용한 무시는 "화면을 우회해 API 를 직접 부른 경우" 를 위한 최후 방어선이지,
--   일반 사용자가 겪는 경로가 아닙니다.
--   그리고 관리자 화면조차 이 RPC 의 반환값(void)으로 성공을 판단해서는 안
--   됩니다. 호출 뒤 group_pledges 를 다시 읽어 **실제 저장된 값** 으로 화면을
--   그리세요. 그러면 어떤 이유로 무시되었든 화면이 거짓말을 할 수 없습니다.
--
-- 【멤버십까지 확인하는 이유】
--   관리자라도 자기가 속하지 않은 그룹에 공약을 심을 수 있어야 할 이유가
--   없습니다. 그리고 멤버십을 안 보면 존재하지 않는 group_id 에 대해 INSERT 가
--   FK 위반(23503)으로 터지면서 "그 그룹은 없다" 가 에러로 새어 나갑니다.
--   멤버십 가드가 그 경로를 통째로 막습니다.
create or replace function public.set_group_pledge(p_group_id uuid, p_body text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_uid  uuid := (select auth.uid());
  v_body text;
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;

  -- ── 조용한 거절 구간 (규칙 8). 순서가 중요합니다: 권한 검사를 **먼저** 해야
  --    비관리자가 길이 오류(22023) 같은 응답 차이로 무언가를 알아내지 못합니다.
  if not private.is_app_admin() then
    return;
  end if;

  if p_group_id is null then
    return;
  end if;

  -- SECURITY DEFINER 라 RLS 가 걸리지 않습니다. 멤버십은 여기서 직접 확인합니다.
  -- private.is_group_member 는 auth.uid() 를 보므로 남의 이름으로 조준 불가.
  if not private.is_group_member(p_group_id) then
    return;
  end if;
  -- ── 여기부터는 "관리자이고 그 그룹의 멤버" 가 확정된 상태입니다.

  v_body := nullif(pg_catalog.btrim(coalesce(p_body, '')), '');

  if v_body is null then
    -- 빈 입력 = 삭제. 없는 것을 지워도 0행이고, 그건 성공입니다
    -- (공약이 없는 상태를 원했고 결과가 그렇습니다).
    delete from public.group_pledges gp
     where gp.group_id = p_group_id;
    return;
  end if;

  -- 길이 초과는 여기서 거부합니다. 관리자 본인이 고칠 수 있는 입력 오류이고,
  -- 응답이 알려 주는 것은 "내가 방금 보낸 문자열이 길다" 뿐입니다.
  -- (에러 메시지에 본문을 되돌려 주지 않습니다 -- 로그 오염 방지, 0007 과 동일.)
  if pg_catalog.char_length(v_body) > 2000 then
    raise exception '공약이 너무 깁니다(최대 2000자).'
      using errcode = '22023';
  end if;

  -- group_id UNIQUE 가 이 upsert 를 원자적으로 만들어 줍니다. 두 번 눌러도
  -- 23505 가 나지 않습니다.
  insert into public.group_pledges (group_id, body, updated_by)
  values (p_group_id, v_body, v_uid)
  on conflict (group_id) do update
    set body       = excluded.body,
        updated_by = excluded.updated_by;
  -- updated_at 은 group_pledges_set_updated_at 트리거가 갱신합니다.
end;
$fn$;

alter function public.set_group_pledge(uuid, text) owner to postgres;
revoke all on function public.set_group_pledge(uuid, text) from public, anon;
grant execute on function public.set_group_pledge(uuid, text) to authenticated;

comment on function public.set_group_pledge(uuid, text) is
  '그룹 공약 저장/삭제. 관리자(private.is_app_admin())이면서 그 그룹의 멤버일 때만 씁니다. '
  '아니면 예외 없이 **조용히 무시** -- 예외를 던지면 특권 계정의 존재와 그룹 실재 여부가 새어 나갑니다(규칙 8). '
  '★ 정상 경로는 public.am_i_admin() 이 false 인 사용자에게 버튼을 아예 안 보여주는 것입니다 ★ -- '
  '조용한 무시는 화면을 우회한 직접 호출용 최후 방어선입니다. '
  'p_body 가 NULL/공백이면 그 그룹의 공약을 삭제. 2000자 초과는 22023. '
  '반환이 void 이므로 호출 뒤 group_pledges 를 다시 읽어 실제 값으로 화면을 그리세요(그래야 "저장됐다" 고 거짓말하지 않습니다).';


-- ═══════════════════════════════════════════════════════════════════════════
-- ⑥ 자체 점검 -- 실행되는 형태 (0006 / 0008 과 같은 방식)
--
-- 카탈로그만 보는 점검은 "함수가 있다" 까지만 말합니다. 관리자 판정처럼
-- **평소엔 아무 일도 안 하는 방어** 는 그걸로 부족합니다. 그래서 (5)(6)(7) 은
-- request.jwt.claims 를 **실제로 세팅해서** 판정을 돌려 봅니다.
--   * set_config(..., is_local => true) 이므로 이 트랜잭션이 끝나면 자동으로
--     사라지고, 아래에서도 성공/실패 양쪽 경로에서 명시적으로 되돌립니다.
--   * 가짜 uid 는 gen_random_uuid() 라 어떤 profiles/group_members 행과도
--     매치되지 않습니다. 운영 데이터를 한 행도 건드리지 않습니다.
-- ═══════════════════════════════════════════════════════════════════════════
do $check$
declare
  v_txt        text;
  v_fn         text;
  v_admin      text := 'gitue11@gmail.com';
  v_fake_uid   uuid := gen_random_uuid();
  v_fake_group uuid := gen_random_uuid();
  v_n          bigint;
  v_send_limit int;
  v_chk_limit  int;
  v_jwt_ok     boolean;
begin
  -- ─────────────────────────────────────────────────────────────────────
  -- (1) 관리자 시드가 실제로 들어갔는가
  --     on conflict do nothing 이라 "이미 있으면 통과" 도 정상입니다.
  --     여기서 잡고 싶은 건 시드가 **없는** 상태입니다 -- 그러면 아무도
  --     공약을 못 쓰고, 그 고장은 화면에서 "버튼이 안 보인다" 로만 나타나서
  --     원인을 찾는 데 한참 걸립니다.
  -- ─────────────────────────────────────────────────────────────────────
  select pg_catalog.count(*) into v_n
  from private.app_admins a
  where a.email = v_admin;

  if v_n <> 1 then
    -- ⚠ RAISE 의 자리표시자는 % 하나뿐입니다. format() 의 %L / %I 를 쓰면
    --   "인자 하나 + 리터럴 L" 로 해석되어 메시지가 망가집니다.
    raise exception
      '[점검 실패] private.app_admins 에 % 가 없습니다(%행). '
      '시드 INSERT 가 실행되지 않았거나 이메일이 정규화되지 않은 상태입니다. 복구: '
      'insert into private.app_admins (email, note) values (''%'', ''수동 복구'') '
      'on conflict (email) do nothing;',
      v_admin, v_n, v_admin;
  end if;

  -- 정규화 CHECK 이 살아 있는지도 함께 봅니다. 이게 없으면 대문자 섞인 값이
  -- 들어가 조용히 매치되지 않습니다.
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'private.app_admins'::regclass
      and conname  = 'app_admins_email_normalized_chk'
  ) then
    raise exception
      '[점검 실패] app_admins_email_normalized_chk 가 없습니다. '
      '대문자/공백이 섞인 이메일이 들어가면 is_app_admin() 이 영원히 false 를 냅니다.';
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (2) 관리자 **목록** 이 새지 않는가
  --     private 스키마에 둔 이유가 이것입니다. 권한이 열려 있으면 그 이유가
  --     통째로 사라집니다.
  -- ─────────────────────────────────────────────────────────────────────
  if has_schema_privilege('anon', 'private', 'USAGE') then
    raise exception
      '[점검 실패] anon 이 private 스키마에 USAGE 를 갖고 있습니다. '
      '0001 은 authenticated 와 service_role 에만 줍니다.';
  end if;

  foreach v_txt in array array['anon', 'authenticated'] loop
    if has_table_privilege(v_txt, 'private.app_admins', 'SELECT') then
      raise exception
        '[점검 실패] % 가 private.app_admins 를 SELECT 할 수 있습니다. '
        '관리자 이메일 목록이 새어 나갑니다. private 스키마에 둔 의미가 없어집니다.',
        v_txt;
    end if;
    if has_table_privilege(v_txt, 'private.app_admins', 'INSERT')
       or has_table_privilege(v_txt, 'private.app_admins', 'UPDATE') then
      raise exception
        '[점검 실패] % 가 private.app_admins 에 쓸 수 있습니다. 스스로 관리자가 될 수 있습니다.',
        v_txt;
    end if;
  end loop;

  -- ─────────────────────────────────────────────────────────────────────
  -- (3) nudge_message: SELECT 는 열리고 UPDATE 는 **닫혀** 있는가
  --     UPDATE 가 열리면 set_nudge_message 의 200자 절단이 우회됩니다.
  -- ─────────────────────────────────────────────────────────────────────
  if not has_column_privilege('authenticated', 'public.profiles', 'nudge_message', 'SELECT') then
    raise exception
      '[점검 실패] authenticated 가 profiles.nudge_message 를 읽지 못합니다. '
      '0003/0007 이 profiles SELECT 를 컬럼 목록으로 좁혀 두었기 때문에, 새 컬럼은 '
      '목록에 명시해야 보입니다. 설정 화면이 현재 값을 못 그립니다.';
  end if;

  if has_column_privilege('authenticated', 'public.profiles', 'nudge_message', 'UPDATE') then
    raise exception
      '[점검 실패] authenticated 가 profiles.nudge_message 를 직접 UPDATE 할 수 있습니다. '
      'set_nudge_message() 의 200자 절단이 우회되고, CHECK 이 거부하는 입력이 23514 로 '
      '사용자에게 터져 나옵니다. GRANT 목록에서 빼세요.';
  end if;

  -- 0003/0007 이 감춘 컬럼이 목록을 다시 쓰면서 딸려 들어오지 않았는지도
  -- 함께 봅니다. GRANT 목록을 재작성하는 이 자리가 실수하기 가장 쉬운 지점입니다.
  if exists (
       select 1 from pg_catalog.pg_attribute a
       where a.attrelid = 'public.profiles'::regclass
         and a.attname  = 'auto_nudge_at'
         and a.attnum > 0 and not a.attisdropped
     )
     and has_column_privilege('authenticated', 'public.profiles', 'auto_nudge_at', 'SELECT') then
    raise exception
      '[점검 실패] profiles.auto_nudge_at 이 authenticated 에게 다시 열렸습니다. '
      '0003 이 감춘 컬럼입니다(그룹 동료에게 기상/취침 시각이 새어 나갑니다).';
  end if;

  foreach v_txt in array array['default_group_id', 'avatar_url'] loop
    if has_column_privilege('authenticated', 'public.profiles', v_txt, 'UPDATE') then
      raise exception
        '[점검 실패] profiles.% 가 authenticated 에게 UPDATE 로 열렸습니다. '
        '0007 의 RPC 검사가 우회됩니다 -- 0009 의 GRANT 재작성 중에 끼어든 것 같습니다.',
        v_txt;
    end if;
  end loop;

  -- ─────────────────────────────────────────────────────────────────────
  -- (4) 200 이라는 숫자가 세 군데에서 같은가
  --     (a) send_nudge 가 실제로 자르는 길이  (b) profiles CHECK 상한
  --     (c) set_nudge_message 가 자르는 길이
  --     문서로 "맞추세요" 라고 적어 두는 건 언젠가 어긋납니다. 카탈로그에서
  --     직접 뽑아 와서 비교합니다.
  -- ─────────────────────────────────────────────────────────────────────
  -- to_regprocedure 로 먼저 봅니다. ::regprocedure 캐스팅은 함수가 없으면
  -- 예외를 던져서, 0001 이 아직 안 들어간 DB 에서 이 점검이 죽습니다.
  if pg_catalog.to_regprocedure('public.send_nudge(uuid,uuid,uuid,text)') is null then
    v_send_limit := null;
  else
    select (pg_catalog.substring(
              pg_catalog.regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g'),
              'left\(btrim\(coalesce\(p_message[^)]*\)\), *([0-9]+)\)'))::int
      into v_send_limit
    from pg_catalog.pg_proc p
    where p.oid = 'public.send_nudge(uuid,uuid,uuid,text)'::regprocedure;
  end if;

  select (pg_catalog.substring(
            pg_catalog.pg_get_constraintdef(c.oid), '<= ([0-9]+)'))::int
    into v_chk_limit
  from pg_catalog.pg_constraint c
  where c.conrelid = 'public.profiles'::regclass
    and c.conname  = 'profiles_nudge_message_len_chk';

  if v_chk_limit is null then
    raise exception
      '[점검 실패] profiles_nudge_message_len_chk 가 없거나 상한을 읽을 수 없습니다. '
      '컬럼만 있고 CHECK 이 없는 상태이면 201자짜리 값이 저장되어 send_nudge 가 조용히 자릅니다.';
  end if;

  if v_send_limit is null then
    -- send_nudge 의 모양이 바뀐 경우. 여기서 마이그레이션을 죽일 일은 아니지만
    -- 통과로 위장하지도 않습니다.
    raise warning
      '[0009] send_nudge 본문에서 절단 길이를 읽지 못했습니다(함수 모양이 바뀐 듯). '
      'profiles CHECK 상한(%)이 send_nudge 의 절단 길이와 같은지 손으로 확인하세요: '
      'select prosrc from pg_proc where oid = ''public.send_nudge(uuid,uuid,uuid,text)''::regprocedure;',
      v_chk_limit;
  elsif v_send_limit <> v_chk_limit then
    -- ⚠ 이 상태는 **0009 를 다시 실행해도 고쳐지지 않습니다**. 위 CHECK 추가는
    --   이름으로 존재 여부만 보는 do 블록 가드라서(0004/0007 과 같은 형태),
    --   이름이 같고 내용이 다른 제약이 이미 있으면 통째로 건너뜁니다.
    --   그래서 손으로 떨어뜨린 뒤 다시 실행해야 한다고 명시합니다.
    raise exception
      '[점검 실패] send_nudge 는 %자에서 자르는데 profiles_nudge_message_len_chk 는 %자입니다. '
      '설정 화면에서는 저장되는데 실제로 보내지는 문장이 잘리는(또는 그 반대) 어긋남이 생깁니다. '
      '★ 0009 를 다시 실행해도 고쳐지지 않습니다(제약 추가가 이름 기준 가드입니다) ★ -- '
      '먼저 alter table public.profiles drop constraint profiles_nudge_message_len_chk; '
      '를 실행한 뒤 0009 를 다시 실행하거나, send_nudge 의 절단 길이를 %자로 맞추세요.',
      v_send_limit, v_chk_limit, v_chk_limit;
  end if;

  if pg_catalog.regexp_replace(
       (select p.prosrc from pg_catalog.pg_proc p
         where p.oid = 'public.set_nudge_message(text)'::regprocedure),
       '--[^' || chr(10) || ']*', '', 'g')
     not like '%' || v_chk_limit::text || '%' then
    raise exception
      '[점검 실패] set_nudge_message 본문(주석 제외)에 절단 길이 %가 없습니다. '
      'send_nudge 와 같은 식을 써야 합니다.', v_chk_limit;
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (5)~(7) 가짜 JWT 를 실제로 세팅해서 판정을 돌려 봅니다.
  --     auth.jwt() 가 없는 환경(순수 Postgres)에서는 건너뜁니다.
  -- ─────────────────────────────────────────────────────────────────────
  v_jwt_ok := (pg_catalog.to_regprocedure('auth.jwt()') is not null)
              and (pg_catalog.to_regprocedure('auth.uid()') is not null);

  -- (5-0) 토큰이 아예 없는 지금(postgres 컨텍스트)은 반드시 false 여야 합니다.
  --       이게 true 로 나오면 cron / service_role / 마이그레이션 자체가
  --       관리자 권한을 갖는다는 뜻입니다.
  if private.is_app_admin() then
    raise exception
      '[점검 실패] JWT 가 전혀 없는 컨텍스트(auth.jwt() 가 비어 있음)에서 '
      'private.is_app_admin() 이 true 입니다. 이메일이 없으면 false 여야 합니다.';
  end if;
  if public.am_i_admin() then
    raise exception
      '[점검 실패] JWT 가 없는데 public.am_i_admin() 이 true 입니다.';
  end if;

  if not v_jwt_ok then
    raise warning
      '[0009] auth.jwt()/auth.uid() 가 없는 환경입니다. 판정 실증 (5)(6)(7) 을 건너뜁니다. '
      '실제 Supabase 프로젝트에서는 반드시 돌아야 하는 점검입니다.';
  else
    begin
      -- ─────────────────────────────────────────────────────────────
      -- (5) email 클레임 판정: 맞는 이메일 true / 틀린 이메일 false /
      --     ★ user_metadata 로 위조한 이메일은 false ★
      -- ─────────────────────────────────────────────────────────────

      -- (5-a) 관리자 이메일 + sub 있음 -> true 여야 합니다.
      perform pg_catalog.set_config('request.jwt.claims',
        pg_catalog.json_build_object('sub', v_fake_uid::text, 'role', 'authenticated',
                                     'email', v_admin)::text, true);
      if not private.is_app_admin() then
        raise exception
          '[점검 실패] JWT email=% 인데 is_app_admin() 이 false 입니다. '
          '시드가 있는데도 판정이 안 되면 (a) 이메일 정규화가 어긋났거나 '
          '(b) 함수가 최상위 email 이 아닌 다른 클레임을 보고 있습니다.', v_admin;
      end if;
      if not public.am_i_admin() then
        raise exception '[점검 실패] is_app_admin() 은 true 인데 am_i_admin() 이 false 입니다.';
      end if;

      -- (5-b) 대소문자가 섞여 있어도 같은 사람입니다.
      perform pg_catalog.set_config('request.jwt.claims',
        pg_catalog.json_build_object('sub', v_fake_uid::text, 'role', 'authenticated',
                                     'email', '  GiTue11@GMAIL.com  ')::text, true);
      if not private.is_app_admin() then
        raise exception
          '[점검 실패] 대소문자/공백이 섞인 관리자 이메일을 인식하지 못합니다. '
          'is_app_admin() 이 lower(btrim(...)) 을 하지 않고 있습니다.';
      end if;

      -- (5-c) 다른 이메일 -> false.
      perform pg_catalog.set_config('request.jwt.claims',
        pg_catalog.json_build_object('sub', v_fake_uid::text, 'role', 'authenticated',
                                     'email', 'someone.else@example.com')::text, true);
      if private.is_app_admin() then
        raise exception '[점검 실패] 목록에 없는 이메일이 관리자로 판정됩니다.';
      end if;

      -- (5-d) ★ 핵심 ★ user_metadata 로 위조한 이메일 -> false 여야 합니다.
      --   supabase.auth.updateUser({ data: { email: '...' } }) 한 줄이면 누구나
      --   만들 수 있는 상태입니다. 여기서 true 가 나오면 앱 전체가 열립니다.
      perform pg_catalog.set_config('request.jwt.claims',
        pg_catalog.json_build_object(
          'sub', v_fake_uid::text, 'role', 'authenticated',
          'email', 'attacker@example.com',
          'user_metadata', pg_catalog.json_build_object(
            'email', v_admin, 'email_verified', true))::text, true);
      if private.is_app_admin() then
        raise exception
          '[점검 실패] ★★ user_metadata.email 로 관리자 판정이 뚫립니다 ★★ '
          'user_metadata 는 updateUser({data}) 로 사용자가 직접 쓰는 값입니다. '
          'private.is_app_admin() 이 최상위 email 클레임(auth.jwt() ->> ''email'') 만 '
          '보도록 되돌리세요.';
      end if;

      -- (5-e) email 이 비었거나 없으면 false.
      perform pg_catalog.set_config('request.jwt.claims',
        pg_catalog.json_build_object('sub', v_fake_uid::text, 'role', 'authenticated',
                                     'email', '   ')::text, true);
      if private.is_app_admin() then
        raise exception '[점검 실패] 공백뿐인 email 클레임이 관리자로 판정됩니다.';
      end if;

      perform pg_catalog.set_config('request.jwt.claims',
        pg_catalog.json_build_object('sub', v_fake_uid::text, 'role', 'authenticated')::text, true);
      if private.is_app_admin() then
        raise exception '[점검 실패] email 클레임이 아예 없는데 관리자로 판정됩니다.';
      end if;

      -- (5-f) sub 없이 email 만 있는 토큰 -> false (정상 세션이 아닙니다).
      perform pg_catalog.set_config('request.jwt.claims',
        pg_catalog.json_build_object('role', 'authenticated', 'email', v_admin)::text, true);
      if private.is_app_admin() then
        raise exception
          '[점검 실패] sub(auth.uid()) 가 없는 토큰이 관리자로 판정됩니다. '
          '관리자 행동은 반드시 주체가 있어야 합니다.';
      end if;

      -- ─────────────────────────────────────────────────────────────
      -- (6) set_group_pledge 가 **비관리자에게 조용한 무동작** 인가
      --     예외도 안 나고 행도 안 생겨야 정상입니다(규칙 8).
      -- ─────────────────────────────────────────────────────────────
      perform pg_catalog.set_config('request.jwt.claims',
        pg_catalog.json_build_object('sub', v_fake_uid::text, 'role', 'authenticated',
                                     'email', 'someone.else@example.com')::text, true);

      perform public.set_group_pledge(v_fake_group, '내가 공약을 심는다');

      select pg_catalog.count(*) into v_n
      from public.group_pledges gp where gp.group_id = v_fake_group;
      if v_n <> 0 then
        raise exception
          '[점검 실패] 비관리자가 부른 set_group_pledge 가 %행을 만들었습니다. '
          '관리자 검사가 통째로 빠져 있습니다.', v_n;
      end if;

      -- ─────────────────────────────────────────────────────────────
      -- (7) 관리자라도 **자기가 속하지 않은 그룹** 에는 못 쓰는가
      --     가짜 uid 는 어떤 group_members 행에도 없으므로 비멤버입니다.
      --     여기서 FK 위반(23503)이 나면 "그 그룹은 없다" 가 새는 것이고,
      --     행이 생기면 멤버십 가드가 없는 것입니다. 둘 다 실패입니다.
      -- ─────────────────────────────────────────────────────────────
      perform pg_catalog.set_config('request.jwt.claims',
        pg_catalog.json_build_object('sub', v_fake_uid::text, 'role', 'authenticated',
                                     'email', v_admin)::text, true);

      begin
        perform public.set_group_pledge(v_fake_group, '관리자지만 비멤버');
      exception
        when others then
          raise exception
            '[점검 실패] 관리자가 비멤버 그룹에 set_group_pledge 를 부르자 예외(% %)가 났습니다. '
            '조용한 무동작이어야 합니다 -- 예외 종류로 그룹 실재 여부가 새어 나갑니다.',
            sqlstate, sqlerrm;
      end;

      select pg_catalog.count(*) into v_n
      from public.group_pledges gp where gp.group_id = v_fake_group;
      if v_n <> 0 then
        raise exception
          '[점검 실패] 관리자가 자기가 속하지 않은 그룹에 공약을 심었습니다(%행). '
          'set_group_pledge 의 private.is_group_member 가드가 없습니다.', v_n;
      end if;

      -- (7-b) set_nudge_message 가 0행 UPDATE 를 조용한 성공으로 처리하지 않는가.
      --       가짜 uid 에는 profiles 행이 없으므로 P0002 가 나야 정상입니다.
      begin
        perform public.set_nudge_message('점검용');
        raise exception
          '[점검 실패] profiles 행이 없는 uid 로 set_nudge_message 가 성공했습니다. '
          '0행 UPDATE 를 성공으로 보고하고 있습니다.';
      exception
        when no_data_found then
          null;   -- P0002. 기대한 동작입니다.
      end;

      -- 가짜 JWT 정리. is_local=true 라 트랜잭션 끝에 어차피 사라지지만,
      -- 이 트랜잭션 안에서 뒤에 오는 문장이 영향을 받지 않도록 명시적으로 되돌립니다.
      perform pg_catalog.set_config('request.jwt.claims', '', true);

    exception
      when others then
        -- 어떤 경로로 실패하든 가짜 JWT 를 남기지 않습니다.
        perform pg_catalog.set_config('request.jwt.claims', '', true);
        raise;
    end;
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (8) 함수 4개: prosecdef / owner=postgres / search_path='' / 실행 권한
  --     셋 중 하나만 어긋나도 우회가 생깁니다 (0006 (2)(3), 0007 (5), 0008 (2)).
  -- ─────────────────────────────────────────────────────────────────────
  foreach v_fn in array array[
    'private.is_app_admin()',
    'public.am_i_admin()',
    'public.set_nudge_message(text)',
    'public.set_group_pledge(uuid,text)'
  ] loop
    if not exists (
      select 1
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
      where p.oid = v_fn::regprocedure
        and p.prosecdef
        and r.rolname = 'postgres'
        -- proconfig 는 'name=value' 문자열 배열입니다. 인용 방식에 따라
        -- 'search_path=' / 'search_path=""' 둘 다 나올 수 있어 모두 통과시킵니다.
        and exists (
          select 1
          from unnest(coalesce(p.proconfig, '{}'::text[])) as cfg
          where cfg like 'search_path=%'
            and btrim(split_part(cfg, '=', 2), '''"') = ''
        )
    ) then
      raise exception
        '[점검 실패] % 가 (security definer / owner=postgres / set search_path = '''') '
        '세 조건을 모두 만족하지 않습니다. 현재 값: %',
        v_fn,
        (select format('prosecdef=%s, owner=%s, proconfig=%s',
                       p.prosecdef,
                       (select r2.rolname from pg_catalog.pg_roles r2 where r2.oid = p.proowner),
                       coalesce(p.proconfig::text, '(없음)'))
           from pg_catalog.pg_proc p where p.oid = v_fn::regprocedure);
    end if;

    if has_function_privilege('anon', v_fn, 'execute') then
      raise exception
        '[점검 실패] anon 이 % 를 실행할 수 있습니다. 로그인하지 않은 방문자가 '
        '관리자 판정과 쓰기 경로를 두드릴 수 있습니다.', v_fn;
    end if;
    if not has_function_privilege('authenticated', v_fn, 'execute') then
      raise exception
        '[점검 실패] authenticated 가 % 를 실행할 수 없습니다. '
        '(private.is_app_admin 은 0010/0011 의 RLS 정책 식이 직접 부르므로 '
        'authenticated EXECUTE 가 실제로 필요합니다.)', v_fn;
    end if;
  end loop;

  -- 반환 타입 (TypeScript 가 그대로 씁니다)
  foreach v_fn in array array['private.is_app_admin()', 'public.am_i_admin()'] loop
    if pg_catalog.pg_get_function_result(v_fn::regprocedure) is distinct from 'boolean' then
      raise exception '[점검 실패] % 의 반환 타입이 "%" 입니다(boolean 이어야 합니다).',
        v_fn, pg_catalog.pg_get_function_result(v_fn::regprocedure);
    end if;
  end loop;
  foreach v_fn in array array['public.set_nudge_message(text)', 'public.set_group_pledge(uuid,text)'] loop
    if pg_catalog.pg_get_function_result(v_fn::regprocedure) is distinct from 'void' then
      raise exception '[점검 실패] % 의 반환 타입이 "%" 입니다(void 여야 합니다).',
        v_fn, pg_catalog.pg_get_function_result(v_fn::regprocedure);
    end if;
  end loop;

  -- is_app_admin / am_i_admin 은 RLS 정책 안에서 statement 당 한 번만 돌아야
  -- 합니다. VOLATILE 이면 행마다 다시 실행되어 정책이 붙은 모든 질의가 느려집니다.
  foreach v_fn in array array['private.is_app_admin()', 'public.am_i_admin()'] loop
    if (select p.provolatile from pg_catalog.pg_proc p where p.oid = v_fn::regprocedure) <> 's' then
      raise exception
        '[점검 실패] % 가 STABLE 이 아닙니다. RLS 정책 안에서 행마다 실행됩니다.', v_fn;
    end if;
    if (select p.pronargs from pg_catalog.pg_proc p where p.oid = v_fn::regprocedure) <> 0 then
      raise exception
        '[점검 실패] % 가 인자를 받습니다. 관리자 판정은 인자를 받으면 안 됩니다 '
        '-- 남을 조준할 수 있게 됩니다(0001 의 private 헬퍼 원칙).', v_fn;
    end if;
  end loop;

  -- 본문 가드가 남아 있는가 (주석은 걷어내고 봅니다 -- 0006 (2-c), 0007 (5))
  if pg_catalog.regexp_replace(
       (select p.prosrc from pg_catalog.pg_proc p
         where p.oid = 'private.is_app_admin()'::regprocedure),
       '--[^' || chr(10) || ']*', '', 'g') like '%user_metadata%' then
    raise exception
      '[점검 실패] private.is_app_admin() 본문에 user_metadata 가 등장합니다. '
      'user_metadata 는 사용자가 직접 쓰는 값입니다 -- 최상위 email 클레임만 보세요.';
  end if;

  if pg_catalog.regexp_replace(
       (select p.prosrc from pg_catalog.pg_proc p
         where p.oid = 'public.set_group_pledge(uuid,text)'::regprocedure),
       '--[^' || chr(10) || ']*', '', 'g')
     not like '%is_app_admin()%' then
    raise exception
      '[점검 실패] set_group_pledge 본문(주석 제외)에 private.is_app_admin() 호출이 없습니다. '
      'SECURITY DEFINER 는 RLS 를 우회하므로, 이 가드가 없으면 아무나 공약을 씁니다.';
  end if;

  if pg_catalog.regexp_replace(
       (select p.prosrc from pg_catalog.pg_proc p
         where p.oid = 'public.set_group_pledge(uuid,text)'::regprocedure),
       '--[^' || chr(10) || ']*', '', 'g')
     not like '%is_group_member(p_group_id)%' then
    raise exception
      '[점검 실패] set_group_pledge 본문(주석 제외)에 '
      'private.is_group_member(p_group_id) 호출이 없습니다. 관리자가 아무 그룹 uuid 에나 '
      '공약을 심을 수 있고, 존재하지 않는 그룹에 대해서는 FK 오류로 실재 여부가 샙니다.';
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (9) group_pledges: 읽기만 열려 있는가 + 정책이 멤버로 좁히는가
  -- ─────────────────────────────────────────────────────────────────────
  if not has_table_privilege('authenticated', 'public.group_pledges', 'SELECT') then
    raise exception '[점검 실패] authenticated 가 group_pledges 를 읽지 못합니다.';
  end if;
  foreach v_txt in array array['INSERT', 'UPDATE', 'DELETE'] loop
    if has_table_privilege('authenticated', 'public.group_pledges', v_txt) then
      raise exception
        '[점검 실패] authenticated 가 group_pledges 에 % 권한을 갖고 있습니다. '
        '쓰기는 set_group_pledge() 뿐이어야 합니다 -- 권한이 열려 있으면 나중에 정책 하나 '
        '잘못 추가하는 것만으로 아무나 공약을 고칠 수 있습니다.', v_txt;
    end if;
  end loop;
  if has_table_privilege('anon', 'public.group_pledges', 'SELECT') then
    raise exception '[점검 실패] anon 이 group_pledges 를 읽을 수 있습니다.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_class c
    where c.oid = 'public.group_pledges'::regclass and c.relrowsecurity
  ) then
    raise exception '[점검 실패] public.group_pledges 에 RLS 가 꺼져 있습니다.';
  end if;

  select coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '')
    into v_txt
  from pg_catalog.pg_policy p
  where p.polrelid = 'public.group_pledges'::regclass
    and p.polname  = 'group_pledges_select_member';

  if v_txt is null or v_txt not like '%is_group_member%' then
    raise exception
      '[점검 실패] group_pledges_select_member 가 private.is_group_member 로 좁히지 않습니다. [%] '
      '정책 안에서 group_members 를 직접 SELECT 하면 안 되고(42P17 재귀), '
      '멤버가 아닌 사람에게 공약이 보이면 안 됩니다.', coalesce(v_txt, '(정책 없음)');
  end if;

  -- 쓰기 정책이 몰래 생기지 않았는지. (권한이 없어 지금은 무해하지만, GRANT 한 줄과
  -- 겹치는 순간 뚫립니다. 두 겹 방어의 나머지 한 겹을 여기서 지킵니다.)
  if exists (
    select 1 from pg_catalog.pg_policy p
    where p.polrelid = 'public.group_pledges'::regclass
      and p.polcmd <> 'r'   -- 'r' = SELECT
  ) then
    raise exception
      '[점검 실패] group_pledges 에 SELECT 이외의 정책이 있습니다. '
      '쓰기 경로는 set_group_pledge() 하나여야 하고, 정책으로 열면 관리자 판정이 '
      '정책과 RPC 두 곳으로 갈라집니다.';
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (10) 로그인 가드 -- 실제로 불러 봅니다 (지금은 auth.uid() 가 null)
  -- ─────────────────────────────────────────────────────────────────────
  begin
    perform public.set_nudge_message('x');
    raise exception
      '[점검 실패] auth.uid() 가 null 인데 set_nudge_message 가 성공했습니다. 로그인 가드가 없습니다.';
  exception
    when insufficient_privilege then
      null;   -- 42501. 기대한 동작입니다.
  end;

  begin
    perform public.set_group_pledge(v_fake_group, 'x');
    raise exception
      '[점검 실패] auth.uid() 가 null 인데 set_group_pledge 가 성공했습니다. 로그인 가드가 없습니다.';
  exception
    when insufficient_privilege then
      null;   -- 42501
  end;

  raise notice
    '[0009] 자체 점검 통과. 관리자 %명, 찌르기 메시지 상한 %자.',
    (select pg_catalog.count(*) from private.app_admins), v_chk_limit;
end;
$check$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 수동 확인 -- 실제 로그인 세션이 필요해 실행형으로 넣지 않은 것
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ── ① 관리자 본인 (gitue11@gmail.com 으로 로그인한 브라우저 콘솔)
--      const { data } = await supabase.rpc('am_i_admin')     // true 여야 정상
--      await supabase.rpc('set_group_pledge',
--        { p_group_id: myGroupId, p_body: '우리는 매일 세 줄을 적는다' })
--      await supabase.from('group_pledges').select('*').eq('group_id', myGroupId)
--      // 위 select 결과로 화면을 그리세요. RPC 의 void 를 성공으로 믿지 마세요.
--
-- ── ② 관리자가 아닌 그룹원
--      await supabase.rpc('am_i_admin')                       // false 여야 정상
--      await supabase.rpc('set_group_pledge',
--        { p_group_id: myGroupId, p_body: '내 맘대로' })       // error 없이 통과
--      await supabase.from('group_pledges').select('*').eq('group_id', myGroupId)
--      // 공약이 **바뀌지 않았어야** 정상입니다. 오류가 아니라 무동작입니다.
--      // ★ 그래서 화면은 am_i_admin() 이 false 면 입력란과 저장 버튼을 아예
--      //   렌더하지 마세요. 안 그러면 "저장했는데 안 바뀐다" 가 됩니다.
--
-- ── ③ 다른 그룹 사람이 남의 공약을 볼 수 있는가 (기대: 0행)
--      await supabase.from('group_pledges').select('*').eq('group_id', '<남의 그룹 uuid>')
--
-- ── ④ 찌르기 기본 메시지
--      await supabase.rpc('set_nudge_message', { p_message: '오늘도 파이팅' })
--      await supabase.from('profiles').select('nudge_message').eq('id', myUid).single()
--      await supabase.rpc('set_nudge_message', { p_message: null })   // 해제
--      // 201자 이상을 보내면 오류 없이 200자로 잘립니다. 위 select 로 확인하세요.
--
-- ── ⑤ 관리자 추가/삭제 (SQL 에디터, postgres 또는 service_role)
--      insert into private.app_admins (email, note)
--        values ('someone@example.com', '2026-09 공동 관리자')
--        on conflict (email) do nothing;
--      delete from private.app_admins where email = 'someone@example.com';
--      select * from private.app_admins order by added_at;
--      -- 즉시 반영됩니다. 다만 프런트가 am_i_admin() 결과를 캐시해 뒀다면
--      -- 새로고침 전까지 버튼 노출이 낡아 있을 수 있습니다(권한 자체는 이미 바뀜).
--
-- ── ⑥ ★ 배포 설정 확인 ★
--      Supabase Dashboard -> Settings -> API -> Exposed schemas 에
--      `private` 가 **없어야** 합니다. 들어가는 순간 private.app_admins 와
--      private.is_app_admin() 이 Data API 로 노출됩니다.
--
-- ── 손으로 보는 확인 (postgres 세션)
--      select * from private.app_admins order by added_at;
--      select prosecdef, provolatile, proconfig,
--             pg_get_function_result(oid) as ret
--        from pg_proc
--       where oid in ('private.is_app_admin()'::regprocedure,
--                     'public.am_i_admin()'::regprocedure,
--                     'public.set_nudge_message(text)'::regprocedure,
--                     'public.set_group_pledge(uuid,text)'::regprocedure);
--
--      select column_name, privilege_type
--        from information_schema.column_privileges
--       where grantee = 'authenticated' and table_name = 'profiles'
--         and privilege_type = 'UPDATE' order by column_name;
--      -- nudge_message / default_group_id / avatar_url 이 **없어야** 정상입니다.
-- ═══════════════════════════════════════════════════════════════════════════


notify pgrst, 'reload schema';
