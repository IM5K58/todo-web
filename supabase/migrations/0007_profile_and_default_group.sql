-- ═══════════════════════════════════════════════════════════════════════════
-- 0007_profile_and_default_group.sql  --  마이페이지(프로필 사진) + 기본 그룹 고정
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 【이 파일이 하는 일】
--   ① public.profiles 에 컬럼 2개
--        default_group_id  -- 처음 열 그룹 고정 (홈 드롭다운 / 현황 화면)
--        avatar_url        -- 업로드한 사진의 Storage 경로 또는 구글 프로필 사진 URL
--   ② private.avatar_url_is_allowed(uuid, text)   -- 허용 형태 판정 (단일 진실)
--   ③ 그룹을 나가면 고정을 자동 해제하는 트리거
--   ④ RPC 2개  public.set_default_group(uuid) / public.set_avatar(text)
--   ⑤ Storage 버킷 'avatars' + storage.objects 정책 4개 (본인 폴더 한정)
--   ⑥ 계정 삭제 시 무엇이 연쇄로 지워지는지 조사 결과 (주석 -- 삭제 라우트용 근거)
--
-- 【이 파일이 하지 않는 일 -- 의도적】
--   탈퇴(계정 삭제)를 하는 SQL 함수를 만들지 않습니다. auth.users 를 SQL 에서
--   직접 지우면 GoTrue 가 모르는 사이에 세션/리프레시 토큰/identity 가 정리되고,
--   그 순간 auth 스키마는 Supabase 가 보증하지 않는 상태가 됩니다. 삭제는
--   Route Handler 에서 service_role 로 auth.admin.deleteUser() 를 부르는 것이
--   유일한 지원 경로입니다. 그 라우트가 무엇을 함께 지워야 하는지는 ⑥ 에.
--
-- 【쓰기 경로 원칙 -- 0003 의 auto_nudge_* 와 같습니다】
--   새 컬럼 2개에는 authenticated UPDATE 권한을 주지 않습니다. 유일한 쓰기 문은
--   ④ 의 RPC 두 개입니다. 컬럼 GRANT 를 열면 "내가 속하지도 않은 그룹 고정",
--   "남의 폴더 경로를 내 avatar_url 로 저장" 같은 값이 CHECK 만으로는 못 막는
--   형태로 들어옵니다 (CHECK 은 auth.uid() 를 볼 수 없습니다 -- IMMUTABLE 이 아님).
--
-- 멱등: add column if not exists / do 블록 가드 / create or replace /
--       drop policy if exists / on conflict do update. 여러 번 실행해도 안전합니다.
-- 반드시 `postgres` 역할로 실행하세요 (SECURITY DEFINER 의 근거).
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- ① profiles 컬럼 2개
-- ───────────────────────────────────────────────────────────────────────────
--
-- 【default_group_id -- 왜 FK 만으로는 부족한가】
--   on delete set null 은 "그룹이 삭제될 때" 만 걸립니다. 실제로 훨씬 자주
--   일어나는 일은 "그룹은 그대로인데 내가 나갔다" 이고 (group_members 행 삭제),
--   FK 는 여기에 아무 반응도 하지 않습니다. 고정이 남으면 현황 화면이 내가
--   더 이상 멤버가 아닌 그룹을 기본으로 열려다 0행/빈 화면을 받습니다.
--
--   ▶ 결정: **트리거로 즉시 정리 + 조회 시점 재확인**, 둘 다 합니다.
--     - 트리거(③)가 1차입니다. 멤버십 상실은 예외 없이 group_members 의 DELETE 를
--       지나갑니다 -- 스스로 나가기(0002 group_members_delete_self_or_owner),
--       추방(public.remove_member), 그룹 삭제 캐스케이드, 계정 삭제 캐스케이드.
--       입구가 하나뿐이라 트리거로 전부 덮입니다. 조회 시점에만 거르면 DB 에는
--       계속 죽은 값이 남고, "마이페이지에 고정된 그룹 이름이 안 보인다" 같은
--       버그로 나중에 다시 만납니다.
--     - 그래도 읽는 쪽(lib/tasks.ts 의 preferredGroupId)은 이 값을 **보장이 아니라
--       힌트**로 다뤄야 합니다. 이유는 값이 공짜이기 때문입니다 -- 그 코드는 이미
--       "내 그룹 목록" 을 손에 들고 있어서, 목록에 없으면 첫 번째 그룹으로
--       떨어뜨리는 데 질의가 한 번도 더 들지 않습니다. 다른 탭에서 그룹을 나간
--       직후의 경쟁 상태, 수동 SQL 수정, 백업 복원 -- 공짜인 방어를 굳이 뺄 이유가
--       없습니다.
--
--   FK 자체는 그대로 둡니다(그룹 삭제 경로). ADD COLUMN 과 FK 를 나눈 이유는
--   0004 와 같습니다: `add column if not exists ... references ...` 는 컬럼이 이미
--   있으면 FK 까지 통째로 건너뛰어, 컬럼만 있고 FK 는 없는 상태가 영구히 굳습니다.
alter table public.profiles
  add column if not exists default_group_id uuid;

do $do$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname  = 'profiles_default_group_id_fkey'
  ) then
    alter table public.profiles
      add constraint profiles_default_group_id_fkey
      foreign key (default_group_id) references public.groups (id)
      on delete set null;
  end if;
end
$do$;

-- FK 인덱스. 없으면 그룹 삭제의 SET NULL 캐스케이드가 profiles 순차 스캔입니다.
-- (0001 의 groups_created_by_idx 와 같은 이유. 부분 인덱스인 것은 고정을 안 한
--  사람이 대부분이기 때문입니다.)
create index if not exists profiles_default_group_id_idx
  on public.profiles (default_group_id)
  where default_group_id is not null;


-- 【avatar_url -- 어떤 형태를 허용할 것인가】
--
--   요구사항의 아바타 우선순위는 이렇습니다.
--     1) profiles.avatar_url 이 있으면 그 사진
--     2) 없으면 구글 로그인 사진 (auth 사용자 메타데이터의 picture/avatar_url)
--     3) 없으면 profiles.avatar_emoji
--
--   2)번은 **본인 화면에서만** 성립합니다. auth 사용자 메타데이터는 자기
--   세션에서만 읽히고, 그룹 동료의 구글 사진을 볼 방법은 없습니다. 그래서
--   "친구들에게도 내 구글 사진을 보여주려면" 그 URL 이 profiles 에 있어야 합니다.
--   허용 형태를 Storage 경로 하나로 좁히면 그 기능이 통째로 사라집니다.
--
--   반대로 **임의의 외부 URL** 을 허용하면, 내가 넣은 주소를 그룹원 전원의
--   브라우저가 자동으로 요청합니다. 그건 그들의 IP·User-Agent·접속 시각을
--   내가 고른 서버에 넘기는 추적 픽셀이고, 3~6명짜리 친구 앱에서도 실제 피해가
--   있는 종류입니다.
--
--   ▶ 결정: **두 형태만** 허용하고 그 외는 전부 거부합니다.
--     (a) 이 프로젝트 Storage 경로:  <내_uuid>/<파일명>.(jpg|jpeg|png|webp)
--         -- 첫 세그먼트가 auth.uid() 여야 합니다 (④ set_avatar 가 강제).
--     (b) 구글 프로필 사진 CDN:      https://lh3.googleusercontent.com/...
--         -- 우선순위 2)번이 이름으로 지목한 바로 그 호스트 하나뿐입니다.
--            "구글 계정이면 누구나 lh3 에 이미지를 올릴 수 있으니 신원 증명은
--            아니다" 는 맞습니다. 하지만 여기서 막으려는 건 신원 위조가 아니라
--            **내가 통제하는 서버로 남의 브라우저를 부르는 것** 이고, 그건
--            닫힙니다. 그리고 lh3 는 어차피 로그인한 본인 화면에서 이미 뜹니다.
--
--   http:, data:, javascript:, 다른 호스트, 상대 경로(../) 는 전부 거부입니다.
--
--   ★ 프런트엔드 주의 ★ next/image 를 쓴다면 images.remotePatterns 에
--     lh3.googleusercontent.com 을 넣어야 합니다. 넣기 싫으면 <img> 로 렌더하세요.
--     Storage 경로는 공개 버킷의 /storage/v1/object/public/avatars/<경로> 입니다.
alter table public.profiles
  add column if not exists avatar_url text;

-- CHECK 은 "모양" 만 봅니다. 소유자 검사(첫 세그먼트 = auth.uid())는 여기 못
-- 들어갑니다 -- CHECK 식은 IMMUTABLE 이어야 하고 auth.uid() 는 STABLE 입니다.
-- 그래서 이 CHECK 은 최후 방어선이고, 진짜 게이트는 ④ 의 set_avatar 입니다.
do $do$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname  = 'profiles_avatar_url_shape_chk'
  ) then
    alter table public.profiles
      add constraint profiles_avatar_url_shape_chk
      check (
        avatar_url is null
        or (
          char_length(avatar_url) between 3 and 512
          and (
            -- (a) 이 프로젝트 Storage 경로: <uuid>/<파일명>.<확장자>
            --     깊이 1 고정. '..' 도 '/' 두 번도 이 정규식을 통과하지 못합니다.
            --     svg 는 일부러 뺐습니다 (⑤ 의 MIME 목록과 같은 이유).
            avatar_url ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(jpg|jpeg|png|webp)$'
            -- (b) 구글 프로필 사진 CDN. 호스트 하나만. 따옴표/꺾쇠/공백 불가.
            --     길이는 위의 char_length between 3 and 512 가 막습니다.
            --     여기서 반복 횟수를 명시하면 안 됩니다 -- Postgres 정규식의
            --     반복 횟수 상한은 255 라, 460 같은 값을 쓰면 2201B
            --     (invalid repetition count) 로 마이그레이션이 죽습니다.
            or avatar_url ~ '^https://lh3\.googleusercontent\.com/[A-Za-z0-9._~:/?#@!$&*+,;=%()-]+$'
          )
        )
      );
  end if;
end
$do$;

comment on column public.profiles.default_group_id is
  '처음 열 그룹 고정. 쓰기는 public.set_default_group() 만 (UPDATE 컬럼 GRANT 없음). '
  'FK 는 그룹 "삭제" 만 덮습니다. 그룹을 "나갈" 때는 0007 의 '
  'private.clear_default_group_on_leave() 트리거가 NULL 로 되돌립니다. '
  '읽는 쪽은 이 값을 보장이 아니라 힌트로 다루고, 내 그룹 목록에 없으면 첫 그룹으로 폴백하세요.';

comment on column public.profiles.avatar_url is
  '아바타 우선순위 1순위. 허용 형태는 두 가지뿐입니다: '
  '(a) 이 프로젝트 Storage 경로 "<본인 uuid>/<파일명>.(jpg|jpeg|png|webp)" -- 공개 버킷 avatars, '
  '(b) https://lh3.googleusercontent.com/... (구글 프로필 사진). '
  '임의 외부 URL 은 그룹원 전원의 브라우저를 내가 고른 서버로 부르는 추적 픽셀이라 금지입니다. '
  'NULL 이면 구글 사진(본인 화면 한정) -> avatar_emoji 순으로 폴백. '
  '쓰기는 public.set_avatar() 만 (UPDATE 컬럼 GRANT 없음).';


-- ───────────────────────────────────────────────────────────────────────────
-- ①-b 권한(GRANT) -- 0002 -> 0003 의 컬럼 단위 목록에 새 컬럼 2개 추가
-- ───────────────────────────────────────────────────────────────────────────
--
-- 현재 상태: 0002 가 profiles 에 테이블 전체 SELECT 를 줬고, 0003 이 그걸 회수한 뒤
--   grant select (id, display_name, avatar_emoji, timezone, created_at)
-- 로 좁혔습니다(auto_nudge_* 세 컬럼을 감추려고). 그래서 지금 새 컬럼을 그냥
-- 추가하면 **아무에게도 안 보입니다**. 목록을 다시 씁니다.
--
-- 【default_group_id 를 SELECT 에 넣어도 되는가 -- 판단】
--   profiles 의 SELECT 정책은 "나 자신 또는 나와 그룹을 공유하는 사람" 입니다.
--   즉 그룹 동료가 내 default_group_id 를 읽습니다. 그 사람이 속하지 않은
--   그룹의 uuid 일 수도 있습니다.
--   그래도 넣습니다. 새어 나가는 것이 **무작위 uuid 하나뿐** 이기 때문입니다.
--   그 id 로 할 수 있는 일은 없습니다 -- groups / group_members / tasks 의 모든
--   접근 경로가 private.* 헬퍼로 멤버십을 다시 검사합니다. 0003 이 감춘
--   auto_nudge_at 과는 성격이 다릅니다. 그건 "몇 시에 자는지" 라는 행동 정보였고,
--   이건 존재를 알아도 아무 데도 못 쓰는 식별자입니다.
--   ▶ 이것마저 감춰야 할 때(그룹 목록이 커져 uuid 상관관계가 의미를 가질 때)는
--     이 컬럼을 SELECT 목록에서 빼고 get_default_group() RPC 를 추가하세요.
--     화면 코드가 자기 값만 읽으므로 그 전환은 국소적입니다.
--
-- 【UPDATE GRANT 에는 넣지 않습니다 -- 0003 의 auto_nudge_* 와 동일】
--   ★ 여기에 default_group_id / avatar_url 을 추가하지 마세요. ★
--   추가하는 순간 RPC 의 멤버십 검사와 폴더 소유자 검사가 우회됩니다.
--   (INSERT GRANT 도 그대로 둡니다. 0002 의 안전밸브는 프로필을 기본값으로
--    한 번 만드는 용도이고, 새 컬럼은 NULL 로 시작하는 것이 맞습니다.)
revoke select on public.profiles from authenticated;
grant select (id, display_name, avatar_emoji, timezone, created_at,
              default_group_id, avatar_url)
  on public.profiles to authenticated;

-- service_role 은 테이블 단위 ALL 을 이미 갖고 있어 새 컬럼도 자동 포함입니다.
-- (0003 과 같은 이유로 명시적으로 한 번 더.)
grant all on public.profiles to service_role;


-- ───────────────────────────────────────────────────────────────────────────
-- ② private.avatar_url_is_allowed(p_user_id uuid, p_url text) -> boolean
-- ───────────────────────────────────────────────────────────────────────────
--
-- 위 CHECK 이 "모양" 을 보고, 이 함수가 "모양 + 소유자" 를 봅니다. set_avatar 가
-- 이걸 쓰고, 파일 끝의 자체 점검도 **이 함수를 실제로 호출해서** 거부 목록을
-- 확인합니다. 판정 규칙이 두 군데로 갈라지지 않게 하는 것이 목적입니다.
--
-- immutable: 인자만 보고 테이블을 읽지 않습니다. 그래서 필요하면 CHECK 에도
-- 넣을 수 있지만 넣지 않았습니다 -- CHECK 이 함수 정의에 의존하면 나중에 함수를
-- 바꿔도 기존 행이 재검증되지 않아, 제약이 지키는 불변식이 조용히 흔들립니다.
create or replace function private.avatar_url_is_allowed(p_user_id uuid, p_url text)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select case
    when p_user_id is null or p_url is null then false
    when pg_catalog.char_length(p_url) < 3 or pg_catalog.char_length(p_url) > 512 then false
    -- (a) 내 폴더의 Storage 경로. 폴더 이름이 **호출자 uuid** 여야 합니다.
    --     남의 uuid 폴더를 가리키는 경로는 여기서 떨어집니다.
    when p_url ~ ('^' || p_user_id::text
                  || '/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(jpg|jpeg|png|webp)$') then true
    -- (b) 구글 프로필 사진 CDN
    --     길이는 위의 char_length 가드가 막습니다. 반복 횟수 상한(255) 때문에
    --     {1,460} 같은 형태를 쓸 수 없습니다.
    when p_url ~ '^https://lh3\.googleusercontent\.com/[A-Za-z0-9._~:/?#@!$&*+,;=%()-]+$' then true
    else false
  end;
$fn$;

alter function private.avatar_url_is_allowed(uuid, text) owner to postgres;
revoke all on function private.avatar_url_is_allowed(uuid, text) from public, anon, authenticated;
-- authenticated 에 주지 않습니다. public.set_avatar() 안에서만 불립니다.

comment on function private.avatar_url_is_allowed(uuid, text) is
  'avatar_url 허용 판정의 단일 진실. (a) "<p_user_id>/<파일명>.(jpg|jpeg|png|webp)" 또는 '
  '(b) https://lh3.googleusercontent.com/... 만 true. 그 외(다른 호스트, http, data:, '
  '../, 남의 uuid 폴더, svg, 512자 초과)는 전부 false.';


-- ───────────────────────────────────────────────────────────────────────────
-- ③ 그룹을 나가면 고정 자동 해제
-- ───────────────────────────────────────────────────────────────────────────
--
-- ①의 판단 근거 참고. group_members 의 DELETE 는 멤버십 상실의 유일한 입구입니다.
-- 계정 삭제 캐스케이드에서도 이 트리거가 돕니다. 그때는 profiles 행이 먼저
-- 지워지므로 UPDATE 가 0행이지만, 그건 오류가 아니라 정상입니다 (아래 참고).
--
-- 조건을 `default_group_id = old.group_id` 로 좁힌 이유: 다른 그룹을 고정해 둔
-- 사람의 값을 건드리지 않기 위해서입니다. 0행 UPDATE 가 정상인 유일한 자리이고,
-- 그래서 여기서는 rowcount 를 검사하지 않습니다 (RPC 쪽은 반대로 검사합니다).
create or replace function private.clear_default_group_on_leave()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  update public.profiles p
     set default_group_id = null
   where p.id = old.user_id
     and p.default_group_id = old.group_id;

  return null;   -- AFTER 트리거. 반환값은 무시됩니다.
end;
$fn$;

alter function private.clear_default_group_on_leave() owner to postgres;
revoke all on function private.clear_default_group_on_leave() from public, anon, authenticated;

drop trigger if exists group_members_clear_default_group on public.group_members;
create trigger group_members_clear_default_group
  after delete on public.group_members
  for each row
  execute function private.clear_default_group_on_leave();

comment on function private.clear_default_group_on_leave() is
  '그룹을 나가거나 추방당하면 profiles.default_group_id 를 NULL 로. FK 의 '
  'on delete set null 은 "그룹 삭제" 만 덮고 "멤버 탈퇴" 는 덮지 못하기 때문입니다. '
  '해당 행이 없으면 0행 UPDATE 로 조용히 끝나는 것이 정상입니다(다른 그룹을 고정 중이거나, '
  '계정 삭제 캐스케이드로 profiles 행이 이미 사라진 경우).';


-- ───────────────────────────────────────────────────────────────────────────
-- ④-a public.set_default_group(p_group_id uuid) returns void
-- ───────────────────────────────────────────────────────────────────────────
--
-- 계약:
--   * auth.uid() 본인 행만 씁니다. "누구로서 쓸지" 를 인자로 받지 않습니다.
--   * p_group_id 가 NULL 이면 고정 해제.
--   * p_group_id 가 내가 속한 그룹이 아니면 **조용히 무시** (예외 금지).
--       왜 예외가 아닌가: 예외를 던지면 "그 group_id 는 실재한다 / 나는 그 그룹의
--       멤버가 아니다" 가 응답 코드로 새고, 0006 의 group_push_status 와도
--       어긋납니다. 그리고 이건 사용자가 고칠 수 있는 오류가 아닙니다 --
--       화면에는 내 그룹만 뜨므로, 여기 도달했다면 방금 그룹을 나갔거나
--       누가 API 를 직접 부른 것입니다. 둘 다 조용히 무동작이 맞습니다.
--   ★ 그래서 호출자는 성공 여부를 반환값으로 판단할 수 없습니다. RPC 뒤에
--     profiles 를 다시 읽어 실제 값으로 화면을 그리세요. (void 는 계약입니다.)
--
-- 0행 UPDATE 는 실패로 보고합니다(프로젝트 규칙). 단 "비멤버라 안 썼다" 와
-- "썼는데 0행" 을 구분합니다 -- 전자는 위 계약대로 무동작, 후자는 프로필 행이
-- 없다는 뜻이라 진짜 오류입니다.
create or replace function public.set_default_group(p_group_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_n   int;
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;

  -- SECURITY DEFINER 라 RLS 가 걸리지 않습니다. 멤버십은 여기서 직접 확인합니다.
  -- private.is_group_member 는 auth.uid() 를 보므로 남의 이름으로 조준 불가.
  if p_group_id is not null and not private.is_group_member(p_group_id) then
    return;   -- 조용히 무시 (위 계약)
  end if;

  update public.profiles p
     set default_group_id = p_group_id
   where p.id = v_uid;

  get diagnostics v_n = row_count;

  if v_n = 0 then
    -- 프로필 행이 없습니다. 0001 의 handle_new_user 가 실패했고 0002 의
    -- 안전밸브(profiles_insert_self)도 아직 안 돈 상태입니다. 조용한 성공 금지.
    raise exception '프로필을 찾을 수 없습니다. 다시 로그인해 주세요.'
      using errcode = 'P0002';
  end if;
end;
$fn$;

alter function public.set_default_group(uuid) owner to postgres;
revoke all on function public.set_default_group(uuid) from public, anon;
grant execute on function public.set_default_group(uuid) to authenticated;

comment on function public.set_default_group(uuid) is
  '기본 그룹 고정. auth.uid() 본인 행만. NULL 이면 고정 해제. '
  '내가 속하지 않은 그룹이면 예외 없이 조용히 무시합니다(그룹 실재 여부를 흘리지 않기 위해). '
  '따라서 호출 후 profiles 를 다시 읽어 실제 값으로 화면을 그리세요. '
  '프로필 행 자체가 없으면 P0002 -- 0행 UPDATE 를 성공으로 보고하지 않습니다.';


-- ───────────────────────────────────────────────────────────────────────────
-- ④-b public.set_avatar(p_avatar_url text) returns void
-- ───────────────────────────────────────────────────────────────────────────
--
-- 계약:
--   * auth.uid() 본인 행만.
--   * NULL 또는 공백 문자열이면 해제 -> 화면은 구글 사진 -> 이모지 순으로 폴백.
--   * 허용 형태가 아니면 **22023 으로 거부**합니다 (set_default_group 과 다릅니다).
--       왜 여기는 조용히 무시가 아닌가: 이건 사용자가 고칠 수 있는 입력 오류이고,
--       아무것도 새지 않습니다(응답이 알려주는 것은 "내가 방금 보낸 문자열이
--       규칙에 안 맞는다" 뿐입니다). 조용히 무시하면 업로드는 끝났는데 사진이
--       안 바뀌는, 원인을 알 수 없는 상태가 됩니다.
create or replace function public.set_avatar(p_avatar_url text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_url text;
  v_n   int;
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;

  v_url := nullif(btrim(coalesce(p_avatar_url, '')), '');

  -- 길이 상한을 판정 함수보다 먼저 봅니다. 거부 메시지에 512자짜리 문자열을
  -- 되돌려 주지 않기 위해서이기도 합니다(로그 오염 방지).
  if v_url is not null and pg_catalog.char_length(v_url) > 512 then
    raise exception '프로필 사진 주소가 너무 깁니다(최대 512자).'
      using errcode = '22023';
  end if;

  if v_url is not null and not private.avatar_url_is_allowed(v_uid, v_url) then
    raise exception '허용되지 않는 프로필 사진 주소입니다.'
      using errcode = '22023',
            hint    = '업로드한 사진(본인 폴더의 avatars 경로) 또는 구글 프로필 사진만 사용할 수 있습니다.';
  end if;

  update public.profiles p
     set avatar_url = v_url
   where p.id = v_uid;

  get diagnostics v_n = row_count;

  if v_n = 0 then
    raise exception '프로필을 찾을 수 없습니다. 다시 로그인해 주세요.'
      using errcode = 'P0002';
  end if;
end;
$fn$;

alter function public.set_avatar(text) owner to postgres;
revoke all on function public.set_avatar(text) from public, anon;
grant execute on function public.set_avatar(text) to authenticated;

comment on function public.set_avatar(text) is
  '프로필 사진 설정. auth.uid() 본인 행만. NULL/공백이면 해제(이모지로 폴백). '
  '허용 형태는 본인 폴더의 Storage 경로 또는 https://lh3.googleusercontent.com/... 뿐이고 '
  '그 외에는 22023 으로 거부합니다(임의 URL 은 그룹원 브라우저를 부르는 추적 픽셀이 됩니다). '
  '길이 상한 512자. 0행 UPDATE 는 P0002.';


-- ───────────────────────────────────────────────────────────────────────────
-- ⑤ Storage 버킷 'avatars'
-- ───────────────────────────────────────────────────────────────────────────
--
-- 【공개 버킷인가, 비공개 + 서명 URL 인가 -- 판단】
--
--   결정적인 사실 하나: <img src> 는 Authorization 헤더를 못 보냅니다. 그래서
--   비공개 버킷을 고르면 선택지는 (a) 멤버 수만큼 서명 URL 을 매 렌더마다 발급,
--   (b) 이미지를 대신 받아 주는 프록시 라우트 -- 둘 중 하나뿐입니다. 홈/현황/
--   내기록/마이페이지가 전부 아바타를 그리므로, 그 비용이 화면 전체에 붙습니다.
--   서명 URL 은 만료도 있어서 SSR 캐시와도 싸웁니다.
--
--   그리고 이 앱은 이미 avatar_url 에 **공개 CDN 주소(lh3.googleusercontent.com)** 를
--   허용합니다. 구글 사진은 공개 URL 로 두고 업로드 사진만 서명하는 것은,
--   비용은 전부 치르면서 실제로 닫히는 구멍은 없는 보안 연극입니다.
--
--   ▶ 결정: **공개 버킷 + 추측 불가능한 경로**.
--     - 경로는 <uid>/<무작위 uuid>.<확장자> 입니다. uid 는 비밀이 아니지만
--       (그룹 동료가 profiles.id 로 읽습니다) 파일명이 무작위라 전체 경로는
--       추측할 수 없습니다. 그리고 목록 조회(LIST)는 본인 폴더만 열려 있어
--       열거로 알아낼 수도 없습니다 -- 아래 SELECT 정책.
--     - 감수하는 것: 경로를 아는 사람(= 그룹 동료, 또는 그가 링크를 퍼뜨린 상대)은
--       탈퇴·추방 이후에도 그 URL 로 사진을 볼 수 있습니다. Slack/Discord 의
--       아바타 CDN 과 같은 성질이고, 3~6명 친구 앱에서 이 위험은 서명 URL 배관을
--       모든 화면에 까는 값보다 쌉니다.
--     ▶ 재검토 시점: 가입 허용목록을 풀어 공개 서비스가 될 때, 또는 아바타가
--       얼굴 사진 이상(신분증·사적인 사진)을 담게 될 때. 그때는 비공개 버킷 +
--       서버에서 createSignedUrls() 배치 발급으로 옮기고 이 주석을 걷어내세요.
--
-- 【크기·MIME 을 버킷 설정으로 거는 이유】
--   클라이언트 검증은 Storage API 를 직접 부르면 그냥 없는 것입니다. 버킷의
--   file_size_limit / allowed_mime_types 는 서버가 강제합니다.
--   ★ image/svg+xml 은 일부러 뺐습니다 ★ SVG 는 <script> 를 품을 수 있고,
--   공개 버킷은 그걸 Storage 오리진에서 그대로 서빙합니다. 저장형 XSS 입니다.
--   (gif 도 뺐습니다. 아바타에 필요 없고 표면만 넓힙니다.)
do $do$
begin
  if pg_catalog.to_regclass('storage.buckets') is null then
    raise exception
      'storage 스키마가 없습니다. Supabase 프로젝트가 아니거나 Storage 가 꺼져 있습니다. '
      '대시보드에서 Storage 를 활성화한 뒤 이 마이그레이션을 다시 실행하세요.';
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('avatars', 'avatars', true, 2097152,
          array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update
    set public             = excluded.public,
        file_size_limit    = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  -- on conflict do update 인 이유: 누가 대시보드에서 크기 제한을 풀거나 svg 를
  -- 추가해 두었다면, 이 마이그레이션을 다시 돌리는 것으로 되돌아와야 합니다.
  -- do nothing 이면 드리프트가 영구히 남습니다.

exception
  when insufficient_privilege then
    raise exception
      'storage.buckets 에 쓸 권한이 없습니다(현재 역할: %). 이 마이그레이션은 '
      'postgres 역할로(예: 대시보드 SQL 편집기) 실행해야 합니다.', current_user;
end
$do$;


-- storage.objects 정책 4개 -- 전부 "본인 폴더" 한정
--
-- ⚠️ 이 정책들은 storage.objects 를 직접 SELECT 하지 않습니다. storage.foldername()
--    은 현재 행의 name 문자열만 쪼개는 스칼라 함수라 정책 재평가(42P17)가 없습니다.
--    여기에 `exists (select 1 from storage.objects ...)` 를 넣지 마세요.
--
-- 경로 규칙: 첫 세그먼트 = auth.uid(), 깊이는 정확히 1 (<uid>/<파일명>).
--   storage.foldername('a1b2.../x.png') -> {'a1b2...'}  (파일명은 빠집니다)
--   storage.foldername('x.png')         -> {}           -> [1] 은 NULL -> false
--   즉 루트 업로드도, 남의 폴더도, 더 깊은 중첩도 전부 막힙니다.
--
-- 【읽기(SELECT)를 같은 그룹 멤버까지 열지 않는 이유】
--   공개 버킷이라 화면 렌더는 정책과 무관하게 됩니다(public 엔드포인트).
--   그래서 SELECT 정책이 실제로 결정하는 것은 "**목록을 훑을 수 있는가**" 뿐입니다.
--   그룹 멤버에게 열면 남의 폴더 파일 목록(이전 아바타 전부, 업로드 시각)이
--   열거 가능해집니다 -- 얻는 것은 없고 추측 불가능성만 잃습니다. 본인 폴더만.
do $do$
begin
  execute $p$drop policy if exists avatars_select_own_folder on storage.objects$p$;
  execute $p$
    create policy avatars_select_own_folder
      on storage.objects
      for select
      to authenticated
      using (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = (select auth.uid())::text
        and array_length(storage.foldername(name), 1) = 1
      )
  $p$;

  execute $p$drop policy if exists avatars_insert_own_folder on storage.objects$p$;
  execute $p$
    create policy avatars_insert_own_folder
      on storage.objects
      for insert
      to authenticated
      with check (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = (select auth.uid())::text
        and array_length(storage.foldername(name), 1) = 1
      )
  $p$;

  -- upsert(같은 경로 덮어쓰기)용. USING 과 WITH CHECK 를 모두 씁니다 --
  -- USING 만 있으면 "내 파일을 남의 폴더 경로로 rename" 이 통과합니다.
  execute $p$drop policy if exists avatars_update_own_folder on storage.objects$p$;
  execute $p$
    create policy avatars_update_own_folder
      on storage.objects
      for update
      to authenticated
      using (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = (select auth.uid())::text
        and array_length(storage.foldername(name), 1) = 1
      )
      with check (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = (select auth.uid())::text
        and array_length(storage.foldername(name), 1) = 1
      )
  $p$;

  -- 사진을 바꾸면 이전 파일을 지울 수 있어야 합니다(공개 버킷이므로 남겨 두면
  -- 이전 사진의 URL 이 영원히 유효합니다).
  execute $p$drop policy if exists avatars_delete_own_folder on storage.objects$p$;
  execute $p$
    create policy avatars_delete_own_folder
      on storage.objects
      for delete
      to authenticated
      using (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = (select auth.uid())::text
        and array_length(storage.foldername(name), 1) = 1
      )
  $p$;

exception
  when insufficient_privilege then
    raise exception
      'storage.objects 에 정책을 만들 권한이 없습니다(현재 역할: %). 대시보드 SQL '
      '편집기(postgres 역할)에서 실행하거나, Storage -> Policies 화면에서 같은 '
      '조건으로 만드세요: bucket_id = ''avatars'' and '
      '(storage.foldername(name))[1] = auth.uid()::text and '
      'array_length(storage.foldername(name), 1) = 1', current_user;
end
$do$;


-- ───────────────────────────────────────────────────────────────────────────
-- ⑥ 계정 삭제(탈퇴) 시 연쇄 삭제되는 것 -- 조사 결과
-- ───────────────────────────────────────────────────────────────────────────
--
-- ★ 삭제는 이 파일이 하지 않습니다 ★ Route Handler 에서 service_role 로
--   supabase.auth.admin.deleteUser(uid) -- 이것이 유일한 지원 경로입니다.
--   아래는 그 라우트를 만드는 에이전트와 검토자를 위한 근거입니다.
--
-- delete from auth.users where id = <uid>  한 문장이 끌고 가는 것:
--
--   auth.users
--     └─ public.profiles                (0001:79  on delete cascade)   ← 여기서 시작
--          ├─ public.group_members      (0001:238 user_id cascade)
--          │     · 그룹 자체는 남습니다. 소유자였다면 0001 의 DEFERRED constraint
--          │       trigger private.ensure_group_has_owner() 가 최고참 멤버에게
--          │       소유권을 승계합니다(예외를 던지지 않으므로 삭제를 막지 않습니다).
--          │     · 0007 의 group_members_clear_default_group 트리거도 함께 돕니다.
--          │       이때 profiles 행은 이미 지워졌으므로 0행 UPDATE 이고 정상입니다.
--          │     · 마지막 멤버였다면 **빈 그룹이 남습니다**(0001 의 의도된 선택).
--          ├─ public.tasks              (0001:461 user_id cascade)
--          │     · 친구들의 /status, /history 에서 그 사람 기록이 사라집니다.
--          │       "탈퇴하면 남의 화면의 과거 기록도 없어진다" 는 제품 결정이고,
--          │       삭제 전에 사용자에게 그렇게 안내해야 합니다.
--          ├─ public.task_templates     (0004:48  user_id cascade)
--          ├─ public.push_subscriptions (0001:552 user_id cascade)
--          ├─ public.nudges (from_user_id) (0001:608 cascade)  -- 내가 보낸 넛지
--          ├─ public.nudges (to_user_id)   (0001:609 cascade)  -- 내가 받은 넛지
--          │     ★ from_user_id 를 on delete set null 로 바꾸지 마세요 ★
--          │       수동 넛지가 (source='manual', from_user_id is null) 이 되어
--          │       0003 의 nudges_source_sender_chk 를 위반하고, 그 순간 계정 삭제
--          │       자체가 23514 로 실패합니다(0003:129 주석).
--          └─ public.groups.created_by  (0001:207 on delete SET NULL)
--                · 내가 만든 그룹은 살아남고 created_by 만 NULL 이 됩니다.
--     └─ auth 스키마 내부 (identities / sessions / refresh_tokens / mfa_factors /
--        one_time_tokens ...) -- GoTrue 가 관리하는 FK 들이 정리합니다.
--        이것이 SQL 로 직접 지우면 안 되는 이유이기도 합니다.
--
--   public.tasks.template_id 는 task_templates 에 대한 on delete SET NULL(0004:307)
--   이지만, 이 사람의 tasks 는 어차피 같은 캐스케이드로 사라지므로 무관합니다.
--   남의 tasks 가 내 템플릿을 가리키는 일은 구조상 없습니다(둘 다 user_id 소유).
--
-- ★★ 연쇄되지 **않는** 것 -- 라우트가 직접 지워야 합니다 ★★
--   storage.objects 의 avatars/<uid>/ 아래 파일들.
--   Storage 객체는 auth.users FK 로 지워지지 않습니다(owner 컬럼은 SET NULL 되거나
--   그대로 남습니다). 공개 버킷이므로 남겨 두면 **탈퇴 후에도 사진 URL 이 계속
--   유효합니다**. 순서까지 중요합니다:
--
--     1) service_role 로  storage.from('avatars').list(uid)
--     2) service_role 로  storage.from('avatars').remove([...경로])
--     3) 그 다음에        auth.admin.deleteUser(uid)
--
--   반대로 하면 uid 를 알던 세션이 사라진 뒤 고아 파일만 남습니다. 1~2 가
--   실패하면 3 을 하지 말고 실패로 응답하세요(다시 시도할 수 있게).
--   profiles.avatar_url 이 lh3 URL 이면 지울 것이 없습니다 -- list 결과가 0건일 뿐
--   오류가 아닙니다.


-- ═══════════════════════════════════════════════════════════════════════════
-- 자체 점검 (이 마이그레이션이 방금 만든 상태를 검증합니다. 실패하면 롤백)
--
-- 덮는 것: 컬럼 2개의 존재/타입/nullable/FK 동작, CHECK 제약이 **실제로**
--          악성 값을 거부하는지(제약식을 꺼내 그대로 평가), 컬럼 단위 GRANT
--          (SELECT 는 열리고 UPDATE 는 닫혔는지), RPC 2개의 반환 시그니처 +
--          prosecdef/owner/search_path + 실행 권한 + 인증 없는 호출의 42501,
--          판정 함수의 거부/허용 목록, 트리거 존재, 버킷 존재/public/크기/MIME,
--          storage 정책 4개가 본인 폴더 제한을 실제로 거는지.
-- 못 덮는 것: "그룹 A 의 인증된 멤버가 그룹 B 를 고정" 과 "다른 사용자로
--          로그인해 남의 폴더에 업로드" -- 역할 위장이 필요합니다. 0006 과 같은
--          이유로 실행형에 넣지 않았습니다. 파일 끝 「수동 확인」 참고.
-- ═══════════════════════════════════════════════════════════════════════════
do $check$
declare
  v_txt      text;
  v_bool     boolean;
  v_n        int;
  v_uid_a    uuid := '11111111-1111-4111-8111-111111111111'::uuid;
  v_uid_b    uuid := '22222222-2222-4222-8222-222222222222'::uuid;
  v_chk      text;
  v_pol      record;
  v_missing  text[];
begin
  -- ─────────────────────────────────────────────────────────────────────
  -- (1) 컬럼 2개가 실제로 생겼는가 (타입·nullable 까지)
  -- ─────────────────────────────────────────────────────────────────────
  if not exists (
    select 1 from pg_catalog.pg_attribute a
    where a.attrelid = 'public.profiles'::regclass
      and a.attname  = 'default_group_id'
      and a.attnum > 0 and not a.attisdropped
      and a.atttypid = 'uuid'::regtype
      and not a.attnotnull
  ) then
    raise exception
      '[점검 실패] public.profiles.default_group_id 가 없거나 uuid/nullable 이 아닙니다.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_attribute a
    where a.attrelid = 'public.profiles'::regclass
      and a.attname  = 'avatar_url'
      and a.attnum > 0 and not a.attisdropped
      and a.atttypid = 'text'::regtype
      and not a.attnotnull
  ) then
    raise exception
      '[점검 실패] public.profiles.avatar_url 이 없거나 text/nullable 이 아닙니다.';
  end if;

  -- FK 가 groups 를 가리키고 삭제 동작이 SET NULL('n') 인가.
  -- ('c'=cascade 로 바뀌어 있으면 그룹 하나 삭제가 프로필을 지웁니다.)
  if not exists (
    select 1 from pg_catalog.pg_constraint c
    where c.conrelid   = 'public.profiles'::regclass
      and c.conname    = 'profiles_default_group_id_fkey'
      and c.contype    = 'f'
      and c.confrelid  = 'public.groups'::regclass
      and c.confdeltype = 'n'
  ) then
    raise exception
      '[점검 실패] profiles_default_group_id_fkey 가 없거나 ON DELETE SET NULL 이 아닙니다. '
      '현재: %',
      coalesce((select pg_catalog.pg_get_constraintdef(c.oid)
                  from pg_catalog.pg_constraint c
                 where c.conrelid = 'public.profiles'::regclass
                   and c.conname  = 'profiles_default_group_id_fkey'), '(없음)');
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (2) avatar_url CHECK 이 **실제로** 거부하는가
  --     제약 이름만 확인하면 누가 식을 `avatar_url is not null` 로 바꿔 놔도
  --     통과합니다. 그래서 저장된 제약식을 그대로 꺼내 값에 적용합니다.
  -- ─────────────────────────────────────────────────────────────────────
  select pg_catalog.pg_get_constraintdef(c.oid)
    into v_chk
  from pg_catalog.pg_constraint c
  where c.conrelid = 'public.profiles'::regclass
    and c.conname  = 'profiles_avatar_url_shape_chk';

  if v_chk is null then
    raise exception '[점검 실패] profiles_avatar_url_shape_chk 제약이 없습니다.';
  end if;

  -- 'CHECK ((...))' 에서 앞의 'CHECK ' 6자를 떼어 낸 식을 평가합니다.
  v_chk := substr(v_chk, 7);

  -- 거부되어야 하는 값들
  foreach v_txt in array array[
    'https://evil.example.com/a.png',                    -- 다른 호스트
    'http://lh3.googleusercontent.com/a/x',              -- http (평문)
    'https://lh3.googleusercontent.com.evil.test/a',     -- 호스트 접미사 위장
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',        -- data: URL
    'javascript:alert(1)',                               -- 스킴 공격
    '11111111-1111-4111-8111-111111111111/../x.png',     -- 경로 탈출
    '11111111-1111-4111-8111-111111111111/x.svg',        -- svg (저장형 XSS)
    '11111111-1111-4111-8111-111111111111/sub/x.png',    -- 깊이 2
    'x.png'                                              -- 루트
  ] loop
    execute pg_catalog.format('select (%s) from (select %L::text as avatar_url) s',
                              v_chk, v_txt)
      into v_bool;
    if coalesce(v_bool, false) then
      raise exception
        '[점검 실패] profiles_avatar_url_shape_chk 가 "%" 를 통과시켰습니다. '
        '임의 URL 이 저장되면 그룹원 전원의 브라우저가 그 주소를 자동으로 요청합니다.',
        v_txt;
    end if;
  end loop;

  -- 허용되어야 하는 값들 (막아 버리면 기능이 죽습니다)
  foreach v_txt in array array[
    '11111111-1111-4111-8111-111111111111/a1b2c3.png',
    '11111111-1111-4111-8111-111111111111/photo.webp',
    'https://lh3.googleusercontent.com/a/ACg8ocKexample=s96-c',
    null
  ] loop
    execute pg_catalog.format('select (%s) from (select %L::text as avatar_url) s',
                              v_chk, v_txt)
      into v_bool;
    if not coalesce(v_bool, false) then
      raise exception
        '[점검 실패] profiles_avatar_url_shape_chk 가 정상 값 "%" 를 거부합니다.',
        coalesce(v_txt, '(null)');
    end if;
  end loop;

  -- ─────────────────────────────────────────────────────────────────────
  -- (3) 판정 함수: 모양 + **소유자** 까지 보는가
  --     (2)의 CHECK 은 uuid 가 누구 것인지 모릅니다. 그 칸을 이 함수가 채웁니다.
  -- ─────────────────────────────────────────────────────────────────────
  if not private.avatar_url_is_allowed(v_uid_a, v_uid_a::text || '/x.png') then
    raise exception '[점검 실패] avatar_url_is_allowed 가 본인 폴더 경로를 거부합니다.';
  end if;

  if private.avatar_url_is_allowed(v_uid_a, v_uid_b::text || '/x.png') then
    raise exception
      '[점검 실패] avatar_url_is_allowed 가 **남의 폴더** 경로(%)를 통과시켰습니다. '
      '이게 뚫리면 남의 사진을 내 아바타로 걸 수 있고, 그 사람이 사진을 지워도 '
      '경로가 내 프로필에 남습니다.', v_uid_b::text || '/x.png';
  end if;

  if private.avatar_url_is_allowed(v_uid_a, 'https://evil.example.com/a.png') then
    raise exception '[점검 실패] avatar_url_is_allowed 가 외부 호스트를 통과시켰습니다.';
  end if;

  if private.avatar_url_is_allowed(v_uid_a, v_uid_a::text || '/' || repeat('a', 600) || '.png') then
    raise exception '[점검 실패] avatar_url_is_allowed 가 512자 상한을 지키지 않습니다.';
  end if;

  if not private.avatar_url_is_allowed(
       v_uid_a, 'https://lh3.googleusercontent.com/a/ACg8ocKexample=s96-c') then
    raise exception '[점검 실패] avatar_url_is_allowed 가 구글 프로필 사진 URL 을 거부합니다.';
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (4) 컬럼 단위 GRANT -- SELECT 는 열리고 UPDATE 는 닫혀 있는가
  --     UPDATE 가 열리면 RPC 의 멤버십/소유자 검사가 통째로 우회됩니다.
  -- ─────────────────────────────────────────────────────────────────────
  if not has_column_privilege('authenticated', 'public.profiles', 'default_group_id', 'SELECT') then
    raise exception
      '[점검 실패] authenticated 가 profiles.default_group_id 를 읽지 못합니다. '
      '0003 이 profiles SELECT 를 컬럼 목록으로 좁혀 두었기 때문에, 새 컬럼은 '
      '목록에 명시해야 보입니다.';
  end if;
  if not has_column_privilege('authenticated', 'public.profiles', 'avatar_url', 'SELECT') then
    raise exception '[점검 실패] authenticated 가 profiles.avatar_url 을 읽지 못합니다.';
  end if;

  if has_column_privilege('authenticated', 'public.profiles', 'default_group_id', 'UPDATE') then
    raise exception
      '[점검 실패] authenticated 가 profiles.default_group_id 를 직접 UPDATE 할 수 있습니다. '
      'set_default_group() 의 멤버십 검사가 우회됩니다. GRANT 목록에서 빼세요.';
  end if;
  if has_column_privilege('authenticated', 'public.profiles', 'avatar_url', 'UPDATE') then
    raise exception
      '[점검 실패] authenticated 가 profiles.avatar_url 을 직접 UPDATE 할 수 있습니다. '
      'set_avatar() 의 형태·소유자 검사가 우회되어 임의 URL 이 저장됩니다.';
  end if;

  -- 0003 이 감춘 컬럼이 다시 열리지 않았는지도 함께 봅니다(목록을 다시 쓰면서
  -- auto_nudge_* 를 실수로 끼워 넣기 가장 쉬운 지점이 바로 여기입니다).
  -- 컬럼이 없는 DB(0003 미적용)에서는 has_column_privilege 가 예외를 던지므로
  -- 존재 여부를 먼저 봅니다.
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

  -- ─────────────────────────────────────────────────────────────────────
  -- (5) RPC 2개: 반환 시그니처 / prosecdef / owner / search_path / 실행 권한
  --     (0006 의 (2-a)(2-b)(3) 과 같은 형식)
  -- ─────────────────────────────────────────────────────────────────────
  foreach v_txt in array array['public.set_default_group(uuid)', 'public.set_avatar(text)'] loop
    if pg_catalog.pg_get_function_result(v_txt::regprocedure) is distinct from 'void' then
      raise exception '[점검 실패] % 의 반환 타입이 "%" 입니다(void 여야 합니다).',
        v_txt, pg_catalog.pg_get_function_result(v_txt::regprocedure);
    end if;

    if not exists (
      select 1
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
      where p.oid = v_txt::regprocedure
        and p.prosecdef
        and r.rolname = 'postgres'
        -- proconfig 는 'name=value' 문자열 배열입니다. 인용 방식에 따라
        -- 'search_path=' / 'search_path=""' 둘 다 나올 수 있어 모두 통과시킵니다.
        -- 값이 비어 있지 않으면(예: search_path=public) 실패해야 맞습니다.
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

  -- 본문 가드가 남아 있는가 (0006 의 (2-c) 와 같은 발상 -- 주석은 걷어내고 봅니다)
  if regexp_replace(
       (select p.prosrc from pg_catalog.pg_proc p
         where p.oid = 'public.set_default_group(uuid)'::regprocedure),
       '--[^' || chr(10) || ']*', '', 'g')
     not like '%is_group_member(p_group_id)%' then
    raise exception
      '[점검 실패] set_default_group 본문(주석 제외)에 '
      'private.is_group_member(p_group_id) 호출이 없습니다. SECURITY DEFINER 는 RLS 를 '
      '우회하므로, 이 가드가 없으면 아무 그룹 uuid 나 자기 기본 그룹으로 고정할 수 있습니다.';
  end if;

  if regexp_replace(
       (select p.prosrc from pg_catalog.pg_proc p
         where p.oid = 'public.set_avatar(text)'::regprocedure),
       '--[^' || chr(10) || ']*', '', 'g')
     not like '%avatar_url_is_allowed(v_uid, v_url)%' then
    raise exception
      '[점검 실패] set_avatar 본문(주석 제외)에 '
      'private.avatar_url_is_allowed(v_uid, v_url) 호출이 없습니다. 이 가드가 없으면 '
      '임의 URL 과 남의 폴더 경로가 그대로 저장됩니다(CHECK 은 소유자를 모릅니다).';
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (6) 인증 없는 호출은 42501 인가 (실제로 불러 봅니다)
  --     이 마이그레이션은 auth.uid() 가 null 인 컨텍스트(postgres)에서 돕니다.
  --     0행 UPDATE 를 조용한 성공으로 처리하지 않는지도 여기서 걸립니다.
  -- ─────────────────────────────────────────────────────────────────────
  begin
    perform public.set_default_group(null::uuid);
    raise exception
      '[점검 실패] auth.uid() 가 null 인데 set_default_group 이 성공했습니다. '
      '로그인 가드가 없습니다.';
  exception
    when insufficient_privilege then
      null;   -- 42501. 기대한 동작입니다.
  end;

  begin
    perform public.set_avatar(null::text);
    raise exception
      '[점검 실패] auth.uid() 가 null 인데 set_avatar 가 성공했습니다. '
      '로그인 가드가 없습니다.';
  exception
    when insufficient_privilege then
      null;   -- 42501
  end;

  -- ─────────────────────────────────────────────────────────────────────
  -- (7) 고정 자동 해제 트리거가 붙어 있는가
  -- ─────────────────────────────────────────────────────────────────────
  if not exists (
    select 1
    from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.group_members'::regclass
      and t.tgname  = 'group_members_clear_default_group'
      and not t.tgisinternal
  ) then
    raise exception
      '[점검 실패] group_members_clear_default_group 트리거가 없습니다. '
      '그룹을 나간 뒤에도 고정이 남아 현황 화면이 남의 그룹을 열려고 합니다 '
      '(FK 의 on delete set null 은 "그룹 삭제" 만 덮습니다).';
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (8) 버킷: 존재 / public 여부가 의도대로 / 크기 / MIME
  -- ─────────────────────────────────────────────────────────────────────
  if not exists (select 1 from storage.buckets b where b.id = 'avatars') then
    raise exception '[점검 실패] storage 버킷 "avatars" 가 없습니다.';
  end if;

  select b.public into v_bool from storage.buckets b where b.id = 'avatars';
  if v_bool is not true then
    raise exception
      '[점검 실패] avatars 버킷이 공개(public=true)가 아닙니다. 현재: %. '
      '이 프로젝트는 공개 버킷 + 추측 불가능한 경로를 의도했습니다(⑤ 판단 근거 참고). '
      '비공개로 바꾸려면 모든 화면의 <img> 를 서명 URL 로 바꾸는 작업이 함께 필요합니다 '
      '-- 지금 상태로 비공개만 켜면 아바타가 전부 깨집니다.',
      coalesce(v_bool::text, '(null)');
  end if;

  select b.file_size_limit into v_n from storage.buckets b where b.id = 'avatars';
  if v_n is null or v_n > 2097152 then
    raise exception
      '[점검 실패] avatars 버킷의 file_size_limit 이 % 입니다(2097152 이하 필수). '
      '클라이언트 검증은 Storage API 를 직접 부르면 없는 것과 같습니다.',
      coalesce(v_n::text, '(무제한)');
  end if;

  select b.allowed_mime_types into v_missing from storage.buckets b where b.id = 'avatars';
  if v_missing is null then
    raise exception
      '[점검 실패] avatars 버킷에 allowed_mime_types 제한이 없습니다. '
      'image/svg+xml 업로드가 가능해지고, 공개 버킷은 그걸 Storage 오리진에서 그대로 '
      '서빙합니다(저장형 XSS).';
  end if;
  if 'image/svg+xml' = any(v_missing) then
    raise exception
      '[점검 실패] avatars 버킷이 image/svg+xml 을 허용합니다. SVG 는 <script> 를 '
      '품을 수 있고 공개 버킷이 그대로 서빙합니다. 목록에서 빼세요.';
  end if;
  if not ('image/jpeg' = any(v_missing) and 'image/png' = any(v_missing)) then
    raise exception
      '[점검 실패] avatars 버킷의 allowed_mime_types 에 image/jpeg 또는 image/png 가 '
      '없습니다. 현재: %', v_missing::text;
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (9) storage.objects 정책이 **실제로** 본인 폴더 제한을 거는가
  --     이름만 세면 조건이 `true` 인 정책도 통과합니다. 식을 문자열로 확인합니다.
  -- ─────────────────────────────────────────────────────────────────────
  v_missing := '{}'::text[];
  foreach v_txt in array array['avatars_select_own_folder', 'avatars_insert_own_folder',
                               'avatars_update_own_folder', 'avatars_delete_own_folder'] loop
    if not exists (
      select 1 from pg_catalog.pg_policy p
      where p.polrelid = 'storage.objects'::regclass and p.polname = v_txt
    ) then
      v_missing := v_missing || v_txt;
    end if;
  end loop;
  if array_length(v_missing, 1) > 0 then
    raise exception '[점검 실패] storage.objects 정책이 없습니다: %', v_missing::text;
  end if;

  for v_pol in
    select p.polname,
           p.polcmd,
           coalesce(pg_catalog.pg_get_expr(p.polqual,      p.polrelid), '') as q,
           coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '') as w
    from pg_catalog.pg_policy p
    where p.polrelid = 'storage.objects'::regclass
      and p.polname like 'avatars\_%'
  loop
    -- INSERT 는 with_check, 나머지는 using 이 실질 조건입니다. UPDATE 는 둘 다.
    v_txt := v_pol.q || ' ' || v_pol.w;

    if v_txt not like '%foldername%'
       or v_txt not like '%auth.uid()%'
       or v_txt not like '%avatars%' then
      raise exception
        '[점검 실패] storage 정책 % 가 본인 폴더 제한을 걸지 않습니다. '
        'using=[%] with_check=[%]  -- bucket_id = ''avatars'' 와 '
        '(storage.foldername(name))[1] = auth.uid()::text 가 모두 있어야 합니다.',
        v_pol.polname, v_pol.q, v_pol.w;
    end if;

    -- 쓰기 계열(INSERT/UPDATE/ALL)에는 WITH CHECK 가 반드시 있어야 합니다.
    -- USING 만 있으면 "내 파일을 남의 폴더 이름으로 바꾸기" 가 통과합니다.
    if v_pol.polcmd in ('a', 'w', '*') and v_pol.w = '' then
      raise exception
        '[점검 실패] storage 정책 % 에 WITH CHECK 가 없습니다(polcmd=%). '
        '쓰기 정책은 "쓰기 후의 행" 도 검사해야 합니다.',
        v_pol.polname, v_pol.polcmd;
    end if;
  end loop;

  -- 다른 정책이 avatars 버킷의 쓰기를 통째로 열어 두지 않았는지 살펴봅니다.
  -- 정책은 OR 로 합쳐지므로, 조건 없는 쓰기 정책 하나가 위 네 개를 무의미하게
  -- 만듭니다. 다른 버킷을 위한 정상적인 정책일 수 있어 예외가 아니라 경고입니다.
  for v_pol in
    select p.polname,
           coalesce(pg_catalog.pg_get_expr(p.polqual,      p.polrelid), '') as q,
           coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '') as w
    from pg_catalog.pg_policy p
    where p.polrelid = 'storage.objects'::regclass
      and p.polname not like 'avatars\_%'
      and p.polcmd in ('a', 'w', '*')
  loop
    if (v_pol.q || ' ' || v_pol.w) not like '%bucket_id%' then
      raise warning
        '[0007] storage.objects 에 버킷을 한정하지 않는 쓰기 정책 "%" 가 있습니다. '
        '정책은 OR 로 합쳐지므로 이 정책이 avatars 의 본인 폴더 제한을 무력화할 수 '
        '있습니다. 확인하세요. using=[%] with_check=[%]',
        v_pol.polname, v_pol.q, v_pol.w;
    end if;
  end loop;

  raise notice '[0007] 자체 점검 통과.';
end;
$check$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 수동 확인 -- 역할 위장이 필요해 실행형으로 넣지 않은 두 가지
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 위 자체 점검은 전부 postgres(auth.uid() = null) 컨텍스트에서 돕니다. 그래서
-- "인증된 사용자가 남의 것을 건드리는" 진짜 공격 경로는 한 번도 실행되지
-- 않습니다. 0006 의 「수동 확인 ①」 과 같은 이유로 여기 주석에 둡니다
-- (구조적으로 거의 "건너뜀" 으로 끝나는 점검이 상주하면, 검증되지 않은 것을
--  검증됐다고 착각하게 만듭니다. set local role + 위조 JWT 를 운영 DB 에서
--  상시로 돌리고 싶지도 않습니다).
--
-- ── ① 남의 그룹을 고정할 수 있는가 (기대: 조용히 무시 -> 값이 안 바뀜)
-- begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims',
--                     json_build_object('sub', '<그룹 B 의 멤버가 아닌 사용자 uuid>',
--                                       'role', 'authenticated')::text, true);
--   select public.set_default_group('<그 사람이 속하지 않은 그룹 uuid>');
--   reset role;
--   select id, default_group_id from public.profiles
--    where id = '<위와 같은 사용자 uuid>';
--   -- default_group_id 가 그대로(또는 null)여야 합니다. 바뀌었으면 가드가 뚫린 것입니다.
-- rollback;
--
-- ── ② 남의 폴더에 업로드할 수 있는가 (기대: 403 new row violates row-level security)
--    이건 SQL 이 아니라 실제 클라이언트로 확인하는 편이 정확합니다.
--    로그인한 브라우저 콘솔에서:
--      await supabase.storage.from('avatars')
--        .upload('<다른_사용자_uuid>/x.png', file)     // 실패해야 정상
--      await supabase.storage.from('avatars')
--        .upload('x.png', file)                        // 루트. 실패해야 정상
--      await supabase.storage.from('avatars')
--        .upload(`${myUid}/${crypto.randomUUID()}.png`, file)   // 성공해야 정상
--      await supabase.storage.from('avatars').list('<다른_사용자_uuid>')
--        // 0건이어야 정상(목록 열거 차단)
--
-- ── 손으로 해보는 확인 (실제 로그인 세션에서)
--   select id, display_name, avatar_emoji, avatar_url, default_group_id
--     from public.profiles where id = auth.uid();
--   -- select * 는 실패합니다. auto_nudge_* 에 컬럼 권한이 없기 때문입니다(0003).
--
--   select pg_get_function_arguments('public.set_avatar(text)'::regprocedure),
--          pg_get_function_result   ('public.set_avatar(text)'::regprocedure);
--   -- p_avatar_url text  /  void
--
--   select id, public, file_size_limit, allowed_mime_types from storage.buckets
--    where id = 'avatars';
--   -- avatars | t | 2097152 | {image/jpeg,image/png,image/webp}
--
--   select polname, polcmd,
--          pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid)
--     from pg_policy where polrelid = 'storage.objects'::regclass
--      and polname like 'avatars%';


notify pgrst, 'reload schema';
