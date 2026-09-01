-- ═══════════════════════════════════════════════════════════════════════════
-- 0010_posts.sql  --  타임라인(오늘 한 일: 사진 + 글)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 【이 파일이 하는 일】
--   ① public.posts 테이블 (+ CHECK 4개, 인덱스 3개, 트리거 2개)
--   ② 컬럼 단위 GRANT
--   ③ RLS 정책 4개  -- 같은 그룹 멤버가 읽기 / 쓰기·수정·삭제는 본인만
--   ④ Realtime 판단 (일부러 퍼블리케이션에 넣지 않습니다) + replica identity 고정
--   ⑤ Storage 버킷 'posts'  -- **비공개**. 판단 근거는 아래 ⑤ 머리말에.
--   ⑥ storage.objects 정책 4개(본인 폴더 한정) + storage.prefixes 정책(조건부)
--   ⑦ 폴더당 파일 개수 상한 (private.post_file_limit / 트리거) -- 0008 의 변주
--   ⑧ 사진 정리 큐  private.post_photo_orphans + 트리거 + service_role 전용 RPC 2개
--      -- posts 행이 사라질 때 Storage 파일을 **누가 지울지** 를 DB 가 기록합니다
--   ⑨ 실행되는 자체 점검 (0006/0008 스타일 -- 실제로 넣어 보고 롤백하는 항목 포함)
--   ⑩ 수동 확인 + 앱이 반드시 해야 할 정리 작업 목록
--
-- 【이 파일이 하지 않는 일 -- 의도적】
--   * 관리자(0009 의 private.is_app_admin) 를 쓰지 않습니다. 게시물은 본인이
--     쓰는 것이지 관리자 기능이 아닙니다. 그래서 0009 가 아직 없어도 이 파일은
--     그대로 성립하고, 0009 -> 0010 순서에 의존하지 않습니다.
--   * Storage 파일을 SQL 로 지우지 않습니다. 할 수 없습니다(0007 ⑥ 에서 배운 것).
--     대신 ⑧ 의 큐에 "지워야 할 경로" 를 남기고, 그걸 비우는 것은 앱의 몫입니다.
--
-- 멱등: create table if not exists / do 블록 가드 / create or replace /
--       drop policy if exists / drop trigger if exists / on conflict do update.
--       운영 DB 에 이미 적용됐어도 다시 실행할 수 있습니다.
-- 선행: 0001, 0002 (private.* 헬퍼와 profiles/groups/group_members).
-- 반드시 `postgres` 역할로 실행하세요. SECURITY DEFINER 함수와 storage 트리거의
-- 근거가 "소유자가 postgres" 라는 사실입니다.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- 0. 선행 조건 -- 없는 상태로 반쯤 적용되면 조용히 아무것도 안 지킵니다
-- ───────────────────────────────────────────────────────────────────────────
do $do$
begin
  if pg_catalog.to_regnamespace('private') is null then
    raise exception
      'private 스키마가 없습니다(0001 에서 만들어집니다). 마이그레이션을 0001 부터 '
      '순서대로 실행하세요.';
  end if;

  if pg_catalog.to_regclass('public.profiles') is null
     or pg_catalog.to_regclass('public.groups') is null
     or pg_catalog.to_regclass('public.group_members') is null then
    raise exception
      'public.profiles / groups / group_members 가 없습니다. 0001_init.sql 을 먼저 '
      '실행하세요.';
  end if;

  -- 정책이 기댈 헬퍼들입니다. 없으면 정책 생성이 나중에 42883 으로 죽는 대신
  -- 여기서 무엇이 빠졌는지 말해 줍니다.
  if pg_catalog.to_regprocedure('private.current_user_group_ids()') is null
     or pg_catalog.to_regprocedure('private.is_group_member(uuid)') is null then
    raise exception
      'private.current_user_group_ids() / private.is_group_member(uuid) 가 없습니다. '
      '0001_init.sql 의 6번 섹션이 만듭니다. 정책 안에서 group_members 를 직접 읽으면 '
      '무한재귀(42P17)이므로 이 헬퍼들은 선택이 아닙니다.';
  end if;

  -- ①-c 의 updated_at 트리거가 이 함수를 씁니다(0001 의 1번 섹션).
  if pg_catalog.to_regprocedure('public.set_updated_at()') is null then
    raise exception
      'public.set_updated_at() 이 없습니다. 0001_init.sql 이 만듭니다.';
  end if;

  if pg_catalog.to_regclass('storage.buckets') is null then
    raise exception
      'storage 스키마가 없습니다. Supabase 프로젝트가 아니거나 Storage 가 꺼져 '
      '있습니다. 대시보드에서 Storage 를 켠 뒤 다시 실행하세요.';
  end if;
end
$do$;


-- ═══════════════════════════════════════════════════════════════════════════
-- ① public.posts
--
-- 【tasks 와 무엇이 다른가】
--   tasks 는 "오늘 할 일" 이고 하루 단위로 묶입니다(task_date + 정렬 순서).
--   posts 는 "오늘 한 일" 이고 **시간 순 피드** 입니다. 그래서 task_date 같은
--   날짜 버킷 컬럼이 없고 created_at 하나로 정렬합니다.
--   ▶ 날짜가 필요하면(예: "9월 1일에 올린 글") 화면에서 created_at 을 그 사람의
--     timezone 으로 변환해 표시하세요. 저장 컬럼을 따로 두지 않은 이유는,
--     current_user_local_date() 는 **읽는 사람** 의 시간대를 보기 때문입니다
--     (0001 의 그 함수는 auth.uid() 의 프로필을 읽습니다). 게시물이 "언제 올라온
--     것인가" 는 쓴 사람 기준이어야 하는데, DEFAULT 로는 그걸 표현할 수 없습니다.
--     타임라인은 절대 시각을 보여 주면 되므로 컬럼을 만들지 않는 편이 맞습니다.
--
-- 【body 와 photo_path 가 둘 다 비면 안 된다】
--   빈 게시물은 피드에 아무 의미도 없는 카드 한 장을 남깁니다. 그리고 사진 업로드가
--   실패한 뒤 만들어진 빈 행은 "왜 아무것도 안 보이지" 라는 버그로 돌아옵니다.
--   CHECK 으로 막고, body 는 아래 정규화 트리거가 공백만 있는 값을 NULL 로 바꿉니다
--   (그래야 이 CHECK 이 '   ' 를 내용으로 인정하지 않습니다).
--
-- 【photo_path 의 소유자 검사를 CHECK 으로 할 수 있는 이유】
--   0007 의 avatar_url 은 소유자 검사를 CHECK 에 넣을 수 없었습니다 -- 비교 대상이
--   auth.uid() 였고 그건 STABLE 이라 IMMUTABLE 식만 허용하는 CHECK 에 못 들어갑니다.
--   여기서는 비교 대상이 **같은 행의 user_id 컬럼** 입니다. string_to_array 도
--   uuid::text 캐스트도 IMMUTABLE 이므로 CHECK 으로 표현됩니다.
--   그리고 RLS INSERT 정책이 user_id = auth.uid() 를 강제하므로,
--     "photo_path 의 첫 폴더 = user_id"  +  "user_id = auth.uid()"
--   두 문장이 합쳐져 "내 폴더의 사진만 내 게시물에 붙는다" 가 됩니다.
--   ▶ 트리거가 아니라 CHECK 인 것이 중요합니다. 트리거는 disable 한 번에 꺼지지만
--     CHECK 은 기존 행까지 검증하고, service_role 로 넣는 행에도 그대로 걸립니다.
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.posts (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  group_id   uuid        not null references public.groups (id)   on delete cascade,
  body       text,
  photo_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- 본문 길이. NULL 허용(사진만 올리는 게시물). 정규화 트리거가 btrim 후 ''를
  -- NULL 로 바꾸므로, 여기 도달하는 값은 항상 실제 내용이 있는 문자열입니다.
  constraint posts_body_len_chk
    check (body is null or char_length(btrim(body)) between 1 and 2000),

  -- 경로 "모양". 0007 의 avatar 경로 정규식과 같은 형태이고 깊이 1 고정입니다.
  --   '..' 도, '/' 두 번도, 루트 파일도 이 정규식을 통과하지 못합니다.
  --   ★ svg 는 일부러 뺐습니다 ★ ⑤ 의 allowed_mime_types 와 같은 이유입니다.
  --   ⚠ 정규식 안에 반복 횟수를 크게 쓰지 마세요. Postgres 정규식의 반복 횟수
  --     상한은 255 이고, 넘기면 2201B 로 마이그레이션이 죽습니다(0007 의 선례).
  constraint posts_photo_path_shape_chk
    check (
      photo_path is null
      or (
        char_length(photo_path) between 3 and 256
        and photo_path ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(jpg|jpeg|png|webp)$'
      )
    ),

  -- 경로 "소유자". 위 머리말 참고 -- 이건 CHECK 으로 표현됩니다.
  constraint posts_photo_path_owner_chk
    check (
      photo_path is null
      or (pg_catalog.string_to_array(photo_path, '/'))[1] = user_id::text
    ),

  -- 빈 게시물 금지.
  constraint posts_not_empty_chk
    check (coalesce(btrim(body), '') <> '' or photo_path is not null)
);

-- 0001 의 습관: 테이블을 만든 직후 같은 트랜잭션에서 RLS 를 켜고 권한을 회수합니다.
-- (0001 이 alter default privileges 로 신규 테이블 자동 GRANT 를 껐지만, 이 파일
--  하나만 읽어도 접근 권한의 전체 그림이 보이도록 명시합니다.)
alter table public.posts enable row level security;
revoke all on public.posts from anon, authenticated;

-- ★ force row level security 는 절대 켜지 마세요 ★ 0001 의 경고 그대로입니다.
-- FORCE 는 테이블 소유자(postgres)에게도 RLS 를 적용해서, ⑧ 의 SECURITY DEFINER
-- 트리거가 posts 를 읽는 순간 정책이 다시 평가됩니다.

comment on table public.posts is
  '타임라인 게시물. 같은 그룹 멤버가 읽고, 쓰기/수정/삭제는 본인만. '
  'body 와 photo_path 가 둘 다 비면 안 됩니다(posts_not_empty_chk). '
  'photo_path 는 비공개 버킷 "posts" 의 경로이고, 화면에 그리려면 서명 URL 이 '
  '필요합니다(0010 ⑤ 참고). 행이 사라지면 0010 ⑧ 의 트리거가 사진 경로를 '
  'private.post_photo_orphans 에 넣습니다 -- 실제 삭제는 앱이 합니다.';

comment on column public.posts.body is
  '본문. NULL 허용(사진만 올리는 게시물). BEFORE 트리거가 btrim 후 빈 문자열을 '
  'NULL 로 정규화하므로 저장된 값은 항상 내용이 있습니다. 최대 2000자.';
comment on column public.posts.photo_path is
  '비공개 Storage 버킷 "posts" 의 객체 경로 "<user_id>/<무작위>.(jpg|jpeg|png|webp)". '
  '공개 URL 이 아닙니다 -- 이 값만 알아도 사진을 볼 수 없고, 서버가 service_role 로 '
  '발급한 서명 URL 이 있어야 합니다. 첫 폴더가 user_id 와 같아야 한다는 규칙은 '
  'posts_photo_path_owner_chk 가 강제합니다.';
comment on column public.posts.group_id is
  '이 게시물이 보이는 그룹. ★ UPDATE 컬럼 GRANT 에 없습니다 ★ 즉 한 번 올린 게시물은 '
  '다른 그룹으로 옮길 수 없습니다. tasks 처럼 이동 가드 트리거를 두지 않은 이유가 '
  '이것입니다 -- 이동 자체가 불가능하면 가드할 것도 없습니다.';


-- ───────────────────────────────────────────────────────────────────────────
-- ①-b 인덱스
-- ───────────────────────────────────────────────────────────────────────────

-- 계약이 지정한 인덱스. 타임라인의 유일한 접근 경로입니다.
--   where group_id = $1 order by created_at desc limit 20
create index if not exists posts_group_created_idx
  on public.posts (group_id, created_at desc);

-- FK 인덱스. 계정 삭제 캐스케이드(profiles -> posts)와 "내 게시물" 조회.
-- 없으면 탈퇴 한 번이 posts 순차 스캔입니다(0001 의 groups_created_by_idx 와 같은 이유).
create index if not exists posts_user_created_idx
  on public.posts (user_id, created_at desc);

-- ⑧ 의 "이 경로를 아직 쓰는 게시물이 남아 있는가" 질의용 부분 인덱스.
-- 무작위 파일명이라 중복은 사실상 없지만, 그 질의는 사진이 붙은 게시물이
-- 지워질 때마다 돌기 때문에 인덱스가 있어야 합니다.
create index if not exists posts_photo_path_idx
  on public.posts (photo_path)
  where photo_path is not null;


-- ───────────────────────────────────────────────────────────────────────────
-- ①-c 트리거 2개
--
-- 정규화 트리거는 일부러 SECURITY INVOKER 입니다(0001 의 set_updated_at,
-- 0004 의 weekdays 정규화와 같은 판단). NEW 만 고쳐 쓰고 아무 테이블도 읽지
-- 않으므로 권한 상승이 필요 없습니다. search_path 는 습관적으로 고정합니다.
--
-- 트리거 이름 순서에 의미가 있습니다. 같은 타이밍의 트리거는 이름 알파벳 순으로
-- 발화하므로 posts_normalize_body('n') 가 posts_set_updated_at('s') 보다 먼저
-- 돌고, set_updated_at 의 WHEN (old.* is distinct from new.*) 는 정규화된 NEW 를
-- 봅니다. 즉 "앞뒤 공백만 지운 UPDATE" 는 updated_at 을 건드리지 않습니다.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.normalize_post_body()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  new.body := nullif(btrim(coalesce(new.body, '')), '');
  return new;
end;
$fn$;

revoke all on function public.normalize_post_body() from public;

comment on function public.normalize_post_body() is
  'posts BEFORE INSERT/UPDATE: body 를 btrim 하고 빈 문자열을 NULL 로. '
  '이게 없으면 posts_not_empty_chk 가 "   " 를 내용으로 인정합니다. '
  '테이블을 읽지 않으므로 SECURITY INVOKER.';

drop trigger if exists posts_normalize_body on public.posts;
create trigger posts_normalize_body
  before insert or update of body on public.posts
  for each row
  execute function public.normalize_post_body();

drop trigger if exists posts_set_updated_at on public.posts;
create trigger posts_set_updated_at
  before update on public.posts
  for each row
  when (old.* is distinct from new.*)
  execute function public.set_updated_at();


-- ═══════════════════════════════════════════════════════════════════════════
-- ② 권한(GRANT)
--
-- GRANT 와 RLS 는 독립적인 두 개의 문이고 요청은 둘 다 통과해야 합니다.
-- anon 에는 아무것도 주지 않습니다. 로그아웃 상태에서는 게시물 한 줄, 사진 경로
-- 하나도 읽을 수 없습니다.
--
-- 【SELECT 를 컬럼 단위로 좁히지 않는 이유】
--   0002 의 groups.invite_code 는 "읽는 순간 권한이 생기는 값" 이라 감췄습니다.
--   posts 에는 그런 컬럼이 없습니다. photo_path 는 **비공개 버킷의 경로** 라서
--   알아도 아무것도 할 수 없고(서명 URL 이 있어야 합니다), 나머지는 전부 화면에
--   그대로 그려지는 값입니다. 그래서 테이블 단위 SELECT 로 둡니다.
--   ▶ 이건 ⑤ 의 "버킷을 비공개로" 판단에 기대고 있습니다. 언젠가 버킷을 공개로
--     바꾼다면 photo_path 는 그 순간 **영구 공개 URL 의 절반** 이 되므로, 이
--     GRANT 를 컬럼 목록으로 좁힐지 다시 판단해야 합니다.
--
-- 【INSERT/UPDATE 목록에서 뺀 것과 그 이유】
--   created_at / updated_at  -- 백데이팅 방지. updated_at 은 트리거 담당.
--   group_id (UPDATE 만)     -- 게시물을 다른 그룹으로 옮길 수 없습니다.
--   user_id  (UPDATE 만)     -- 남에게 게시물을 떠넘길 수 없습니다.
--   user_id 를 INSERT 목록에 넣는 것은 0002 의 tasks 와 같은 형태입니다. 정책의
--   WITH CHECK 이 auth.uid() 와 같은지 확인하므로 남의 id 를 넣으면 거기서 막힙니다.
-- ═══════════════════════════════════════════════════════════════════════════
grant select                                              on public.posts to authenticated;
grant insert (id, user_id, group_id, body, photo_path)    on public.posts to authenticated;
grant update (body, photo_path)                           on public.posts to authenticated;
grant delete                                              on public.posts to authenticated;

-- service_role 은 RLS 를 우회(BYPASSRLS)하지만 테이블 권한은 여전히 필요합니다.
grant all on public.posts to service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- ③ 정책(POLICY)
--
-- 0002 의 관례를 그대로 따릅니다.
--   * 모든 정책에 `to authenticated` (없으면 anon 요청마다 정책 식이 평가됩니다)
--   * 맨 auth.uid() 대신 `(select auth.uid())` -> statement 당 한 번 InitPlan
--   * INSERT/UPDATE 정책에는 예외 없이 WITH CHECK
--   * 정책 식은 자기가 지키는 테이블(posts)을 절대 직접 SELECT 하지 않습니다.
--     멤버십 조회는 전부 private.* SECURITY DEFINER 헬퍼를 경유합니다(42P17 회피).
-- ═══════════════════════════════════════════════════════════════════════════

-- 헬퍼: private.current_user_group_ids()
-- 0002 의 tasks_select_group_members 와 같은 모양입니다. "그룹을 나가도 내가 쓴
-- 것은 계속 보인다" 를 유지합니다 -- 안 그러면 탈퇴 직후 내 타임라인이 통째로
-- 사라지고, 그건 사고처럼 보입니다.
drop policy if exists posts_select_group_members on public.posts;
create policy posts_select_group_members
  on public.posts
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or group_id in (select private.current_user_group_ids())
  );

-- 헬퍼: private.is_group_member(uuid)
-- 멤버십 항이 "user_id = auth.uid()" 보다 엄격합니다 -- 내가 속하지 않은 그룹의
-- 피드에 내 게시물을 꽂아 넣는 것까지 막습니다(0002 tasks_insert_own 과 동일).
drop policy if exists posts_insert_own on public.posts;
create policy posts_insert_own
  on public.posts
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and private.is_group_member(group_id)
  );

-- 헬퍼: 없음 (auth.uid() 만 사용)
-- USING 은 기존 행, WITH CHECK 는 바뀐 행. 둘 다 필요합니다.
-- 멤버십 항을 넣지 않는 이유는 0002 의 tasks_update_own 과 같습니다 -- 그룹을 나간
-- 뒤에도 자기 글의 오타를 고치고 지울 수 있어야 합니다. 진짜 지켜야 할 규칙
-- ("다른 그룹으로 옮길 수 없다")은 UPDATE 컬럼 GRANT 에 group_id 가 없다는
-- 사실이 강제합니다(② 참고).
drop policy if exists posts_update_own on public.posts;
create policy posts_update_own
  on public.posts
  for update
  to authenticated
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- 헬퍼: 없음 (auth.uid() 만 사용)
drop policy if exists posts_delete_own on public.posts;
create policy posts_delete_own
  on public.posts
  for delete
  to authenticated
  using (user_id = (select auth.uid()));


-- ═══════════════════════════════════════════════════════════════════════════
-- ④ Realtime -- 일부러 넣지 않습니다
--
-- tasks 는 0006 에서 퍼블리케이션에 넣었습니다. 현황 화면이 "지금 누가 뭘 끝냈나"
-- 를 실시간으로 보여 주는 것이 그 화면의 존재 이유였기 때문입니다.
-- 타임라인은 다릅니다. 게시물은 하루 몇 개이고, 인스타그램식 피드에서 사람들이
-- 기대하는 동작은 "새로고침하면 새 글이 있다" 입니다. 실시간으로 밀어 넣으면
-- 읽던 위치가 튀는 쪽이 오히려 손해입니다.
--
-- 그리고 0001 의 경고: Supabase Postgres Changes 는 **DELETE 이벤트에 RLS 를
-- 적용하지 않습니다**. 퍼블리케이션에 넣는 순간, 게시물을 지울 때마다 그 PK 가
-- 그 테이블을 구독한 모든 사람에게 갑니다. replica identity 가 DEFAULT 라 PK 뿐이고
-- 그래서 지금은 무해하지만, FULL 로 바뀌는 날 본문과 사진 경로가 통째로 방송됩니다.
--
-- ▶ 나중에 실시간 피드가 필요해지면 0006 의 ② 블록을 그대로 복사해서 테이블
--   이름만 'posts' 로 바꾸세요. 그때도 replica identity 는 DEFAULT 여야 합니다.
--   아래 한 줄과 자체 점검 (10) 이 그 조건을 미리 못 박아 둡니다.
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.posts replica identity default;


-- ═══════════════════════════════════════════════════════════════════════════
-- ⑤ Storage 버킷 'posts'
--
-- 【공개 버킷인가, 비공개 + 서명 URL 인가 -- 판단】
--
--   0007 은 avatars 를 **공개 + 추측 불가능한 경로** 로 정했습니다. 그 판단의
--   근거는 세 가지였습니다.
--     (a) <img src> 는 Authorization 헤더를 못 보내므로 비공개면 서명 URL 이 필요한데,
--         아바타는 홈/현황/내기록/마이페이지 **모든 화면** 에 붙는다.
--     (b) 이미 lh3.googleusercontent.com 이라는 공개 CDN 주소를 허용하고 있어서,
--         업로드 사진만 서명하는 것은 비용만 치르고 닫히는 구멍은 없는 연극이다.
--     (c) 아바타는 사람당 1장이고, 새어 나가는 최악이 "얼굴 사진 한 장" 이다.
--
--   게시물 사진은 세 근거가 **전부 성립하지 않습니다**.
--     (a) 타임라인은 화면 하나입니다. 그 화면은 이미 posts 를 한 번 질의하므로,
--         그 결과의 photo_path 목록을 그대로 createSignedUrls(paths) 에 넘기면
--         **페이지당 왕복 한 번** 이 늘 뿐입니다. 사진 개수만큼이 아닙니다.
--         아바타처럼 여러 화면·여러 질의에 흩어져 붙는 비용이 아닙니다.
--     (b) 게시물 사진에는 대응하는 "이미 공개인 외부 CDN 주소" 가 없습니다.
--         비교 대상 자체가 없으므로 연극이 아니라 실제 경계가 됩니다.
--     (c) 최악이 다릅니다. 아바타는 그 사람이 스스로 고른 공개 신원 사진 한 장이고,
--         타임라인은 밥, 방, 운동, 가족 -- 매일 쌓이는 사생활입니다. 그리고 아바타의
--         유출 최악값은 1장으로 고정인데 게시물은 **하루마다 늘어납니다**.
--
--   결정적인 차이 하나 더: 공개 버킷의 URL 은 **취소가 불가능** 합니다. 그룹을
--   나가거나 추방당한 사람이 그동안 본 사진의 URL 은 영원히 유효합니다. 아바타에서
--   그건 "Slack 아바타 CDN 과 같은 성질" 이라고 감수할 만했지만, 여기서는 감수하는
--   대상이 그 사람의 일상 사진 전부입니다. 0007 이 재검토 시점으로 지목한
--   "아바타가 얼굴 사진 이상을 담게 될 때" 가 바로 이 기능입니다.
--
--   ▶ 결정: **비공개 버킷(public = false) + 서버가 발급하는 서명 URL**.
--
--   ▶ 그럼 서명 URL 은 누가 발급하는가 -- 여기서 한 번 더 갈립니다.
--     선택지 1) 사용자 토큰으로 createSignedUrls() 를 부른다.
--         그러려면 storage.objects 의 SELECT 정책을 "같은 그룹 멤버" 까지 열어야
--         합니다. 그런데 경로는 <uid>/<무작위> 이고 **그룹 정보가 없습니다**.
--         정책이 쓸 수 있는 최선은 private.shares_group_with(폴더 uuid) 인데,
--         그건 "아무 그룹이나 하나라도 공유하는가" 입니다. 0007/0008 이후 이 앱은
--         한 사람이 여러 그룹에 속하는 것이 정상이므로, A 와 G1 을 공유하는 사람이
--         A 의 폴더를 list() 해서 **G2 전용 게시물의 사진까지** 서명할 수 있게
--         됩니다. posts 의 RLS 는 그룹별로 정확한데 Storage 쪽만 뭉개지는 것입니다.
--     선택지 2) 서버가 service_role 로 발급한다.  ◀ 채택
--         발급 대상 경로를 **사용자 토큰으로 조회한 posts 행에서만** 가져오면,
--         "볼 수 있는 게시물" 과 "서명되는 사진" 이 정확히 같은 집합이 됩니다.
--         RLS 가 이미 그룹 단위로 정확하므로 새로 만드는 판정 규칙이 없습니다.
--         그래서 storage.objects 정책은 avatars 와 똑같이 **본인 폴더 한정** 이고,
--         남의 폴더는 열거조차 되지 않습니다.
--
--     ★ 앱 구현 규칙 (어기면 위 경계가 그대로 무너집니다) ★
--       1. 먼저 **사용자 토큰** 으로  select id, photo_path from public.posts ...
--          -> RLS 가 걸러 준 결과만 손에 들어옵니다.
--       2. 그 결과의 photo_path 배열만 service_role 클라이언트(lib/supabase/admin.ts)의
--          storage.from('posts').createSignedUrls(paths, 3600) 에 넘깁니다.
--       3. 클라이언트가 보낸 임의의 경로를 절대 그대로 서명하지 마세요. 그러면
--          service_role 이 "아무 경로나 서명해 주는 오라클" 이 됩니다.
--
-- 【크기·MIME 을 버킷 설정으로 거는 이유】
--   0007 과 같습니다. 클라이언트 검증은 Storage API 를 직접 부르면 없는 것입니다.
--   ★ image/svg+xml 은 뺐습니다 ★ 비공개 버킷이라 저장형 XSS 표면은 공개 버킷보다
--   좁지만, 서명 URL 도 결국 Storage 오리진에서 그 파일을 서빙합니다. 그리고
--   "사진 타임라인" 에 SVG 가 필요한 경우가 없습니다. 표면만 넓힙니다.
--   gif 도 뺐습니다(같은 이유 + 용량).
--
-- 【file_size_limit = 1 MiB 인 이유】
--   1280px 장변 JPEG(q≈0.8)은 보통 200~400KB 입니다. 1 MiB 는 거기에 2~3배
--   여유입니다. 반대로 폰 카메라 원본(4~8MB)은 **그 자리에서 실패** 합니다 --
--   그게 의도입니다. 피드용 사진은 어차피 앱이 업로드 전에 줄여야 하고, 서버가
--   거부해 주지 않으면 아무도 줄이지 않습니다.
--   ▶ 앱은 canvas 로 장변 1280px, JPEG/WebP q0.8 로 줄여서 올리세요.
--     실패 메시지는 "사진이 너무 큽니다" 가 아니라 "사진을 줄여서 다시" 여야 합니다.
-- ═══════════════════════════════════════════════════════════════════════════
do $do$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('posts', 'posts', false, 1048576,
          array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update
    set public             = excluded.public,
        file_size_limit    = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  -- on conflict do update 인 이유는 0007 과 같습니다. 누가 대시보드에서 버킷을
  -- 공개로 돌리거나 크기 제한을 풀어 두었다면, 이 마이그레이션을 다시 돌리는
  -- 것으로 되돌아와야 합니다. do nothing 이면 드리프트가 영구히 남습니다.
  -- ★ 특히 public 을 여기서 다시 false 로 못 박는 것이 이 파일의 핵심 중 하나입니다.

exception
  when insufficient_privilege then
    raise exception
      'storage.buckets 에 쓸 권한이 없습니다(현재 역할: %). 이 마이그레이션은 '
      'postgres 역할로(예: 대시보드 SQL 편집기, supabase db push) 실행해야 합니다.',
      current_user;
end
$do$;


-- ═══════════════════════════════════════════════════════════════════════════
-- ⑥ storage.objects 정책 4개 -- 전부 "본인 폴더" 한정 (⑤ 의 선택지 2 참고)
--
-- ⚠️ 이 정책들은 storage.objects 를 직접 SELECT 하지 않습니다. storage.foldername()
--    은 현재 행의 name 문자열만 쪼개는 스칼라 함수라 정책 재평가(42P17)가 없습니다.
--    여기에 `exists (select 1 from storage.objects ...)` 를 넣지 마세요.
--
-- 경로 규칙: 첫 세그먼트 = auth.uid(), 깊이는 정확히 1 (<uid>/<파일명>).
--   storage.foldername('a1b2.../x.jpg') -> {'a1b2...'}  (파일명은 빠집니다)
--   storage.foldername('x.jpg')         -> {}           -> [1] 은 NULL -> false
--   즉 루트 업로드도, 남의 폴더도, 더 깊은 중첩도 전부 막힙니다.
--   이 규칙은 posts_photo_path_shape_chk 의 정규식(깊이 1)과 글자 그대로 같은
--   불변식입니다. 한쪽만 고치면 "업로드는 되는데 게시물이 안 만들어지는" 상태가
--   되니 반드시 같이 고치세요.
--
-- 【SELECT 정책이 실제로 결정하는 것】
--   비공개 버킷이므로 SELECT 정책은 두 가지를 결정합니다.
--     (1) list() 로 목록을 훑을 수 있는가          -> 본인 폴더만
--     (2) **사용자 토큰으로** 서명 URL 을 만들 수 있는가 -> 본인 사진만
--   그룹 동료의 사진은 서버가 service_role 로 서명합니다(⑤). 그래서 여기를
--   그룹까지 여는 것은 얻는 것 없이 열거만 허용하는 손해입니다.
--
-- 【DELETE 정책이 반드시 필요한 이유 -- 아바타보다 중요합니다】
--   업로드는 성공했는데 posts INSERT 가 실패하면, 그 파일은 어떤 게시물도 가리키지
--   않는 고아가 됩니다. ⑧ 의 트리거는 posts 행이 사라질 때만 도므로 이 파일은
--   큐에도 안 들어갑니다. 앱이 그 자리에서 지울 수 있어야 하고, 그 문이 이 정책입니다.
--   (⑩ 의 「앱이 책임져야 하는 정리 작업」 1번)
-- ═══════════════════════════════════════════════════════════════════════════
do $do$
begin
  execute $p$drop policy if exists posts_select_own_folder on storage.objects$p$;
  execute $p$
    create policy posts_select_own_folder
      on storage.objects
      for select
      to authenticated
      using (
        bucket_id = 'posts'
        and (storage.foldername(name))[1] = (select auth.uid())::text
        and array_length(storage.foldername(name), 1) = 1
      )
  $p$;

  execute $p$drop policy if exists posts_insert_own_folder on storage.objects$p$;
  execute $p$
    create policy posts_insert_own_folder
      on storage.objects
      for insert
      to authenticated
      with check (
        bucket_id = 'posts'
        and (storage.foldername(name))[1] = (select auth.uid())::text
        and array_length(storage.foldername(name), 1) = 1
      )
  $p$;

  -- upsert(같은 경로 덮어쓰기)용. USING 과 WITH CHECK 를 **모두** 씁니다 --
  -- USING 만 있으면 "내 파일을 남의 폴더 경로로 rename" 이 통과합니다.
  execute $p$drop policy if exists posts_update_own_folder on storage.objects$p$;
  execute $p$
    create policy posts_update_own_folder
      on storage.objects
      for update
      to authenticated
      using (
        bucket_id = 'posts'
        and (storage.foldername(name))[1] = (select auth.uid())::text
        and array_length(storage.foldername(name), 1) = 1
      )
      with check (
        bucket_id = 'posts'
        and (storage.foldername(name))[1] = (select auth.uid())::text
        and array_length(storage.foldername(name), 1) = 1
      )
  $p$;

  execute $p$drop policy if exists posts_delete_own_folder on storage.objects$p$;
  execute $p$
    create policy posts_delete_own_folder
      on storage.objects
      for delete
      to authenticated
      using (
        bucket_id = 'posts'
        and (storage.foldername(name))[1] = (select auth.uid())::text
        and array_length(storage.foldername(name), 1) = 1
      )
  $p$;

exception
  when insufficient_privilege then
    raise exception
      'storage.objects 에 정책을 만들 권한이 없습니다(현재 역할: %). 대시보드 SQL '
      '편집기(postgres 역할)에서 실행하거나, Storage -> Policies 화면에서 같은 '
      '조건으로 만드세요: bucket_id = ''posts'' and '
      '(storage.foldername(name))[1] = auth.uid()::text and '
      'array_length(storage.foldername(name), 1) = 1', current_user;
end
$do$;


-- ───────────────────────────────────────────────────────────────────────────
-- ⑥-b storage.prefixes -- 있으면 정책, 없으면 건너뜀 (0008 ⑤ 와 같은 처리)
--
-- Storage 엔진 v1.19+ 에는 storage.prefixes 가 있고 **자체 RLS 를 탑니다**.
--   upload() -> objects INSERT 트리거가 prefixes INSERT 를 유발
--   list()   -> prefixes SELECT
-- 정책이 없으면 업로드와 목록이 조용히 실패합니다(보안 구멍이 아니라 기능 정지).
--
-- ★ objects 의 storage.foldername() 을 그대로 복사해 오면 안 됩니다 ★
--   prefixes 의 name 은 **디렉터리 자체**('<uid>')라서 foldername() 이 빈 배열을
--   돌려주고, 그러면 모든 업로드가 거부됩니다. 첫 경로 조각을 봐야 합니다:
--     (pg_catalog.string_to_array(name, '/'))[1] = auth.uid()::text
-- ───────────────────────────────────────────────────────────────────────────
do $do$
begin
  if pg_catalog.to_regclass('storage.prefixes') is null then
    raise notice
      '[0010] storage.prefixes 가 없는 엔진입니다(v1.19 미만). 정책을 건너뜁니다. '
      '엔진이 올라간 뒤 이 마이그레이션을 다시 실행하세요 -- 그때 정책이 생깁니다.';
    return;
  end if;

  execute $p$drop policy if exists posts_prefix_own_folder on storage.prefixes$p$;
  execute $p$
    create policy posts_prefix_own_folder
      on storage.prefixes
      for all
      to authenticated
      using (
        bucket_id = 'posts'
        and (pg_catalog.string_to_array(name, '/'))[1] = (select auth.uid())::text
      )
      with check (
        bucket_id = 'posts'
        and (pg_catalog.string_to_array(name, '/'))[1] = (select auth.uid())::text
      )
  $p$;

exception
  when insufficient_privilege then
    raise exception
      'storage.prefixes 에 정책을 만들 권한이 없습니다(현재 역할: %). postgres '
      '역할로 실행하거나, 대시보드에서 posts_prefix_own_folder 를 다음 조건으로 '
      '만드세요(using / with check 동일): bucket_id = ''posts'' and '
      '(string_to_array(name, ''/''))[1] = auth.uid()::text. '
      '이 정책이 없으면 v1.19+ 엔진에서 업로드와 목록이 실패합니다.', current_user;
end
$do$;


-- ═══════════════════════════════════════════════════════════════════════════
-- ⑦ 폴더당 파일 개수 상한 -- 0008 의 구조, 다른 숫자
--
-- 0008 이 왜 RLS 정책이 아니라 트리거인지는 그 파일에 자세히 있습니다(요약:
-- 정책 식 안에서 storage.objects 를 세면 42P17 무한재귀. postgres 소유
-- SECURITY DEFINER 트리거는 정책 식이 아니므로 재귀 대상이 아니고, RLS 도
-- 통과하지 않습니다). 여기서도 같은 구조를 씁니다.
--
-- ───────────────────────────────────────────────────────────────────────────
-- 【상한을 200 으로 정한 근거 -- 아바타의 5 를 그대로 쓰면 안 되는 이유】
--
--   아바타는 정상 사용이 **1장** 이라서 5 가 "정상 사용의 5배" 였습니다.
--   게시물은 정상 사용이 **하루 한 장** 입니다. 같은 발상으로 작은 값을 쓰면
--   보안이 아니라 고장이 됩니다 -- 두 달 뒤에 "사진을 더는 못 올립니다" 가 뜹니다.
--
--   그래서 두 개의 서로 다른 목표를 두 개의 서로 다른 손잡이로 나눕니다.
--     (가) 무한 쓰기 프리미티브 차단  -> **개수 상한**. 어떤 유한한 값이든 이 일은
--          합니다. 0008 이 지적한 그 루프(재시도 폭주, 악의적 반복)를 끊는 것.
--     (나) 무료 티어(1GB)를 정상 사용으로 태우지 않기 -> **크기 상한**.
--          1 MiB 강제가 실제로는 이쪽을 담당합니다. 폰 원본을 그대로 못 올리므로
--          한 장이 300KB 안팎이 되고, 그게 총량의 3~10배 차이를 만듭니다.
--
--   ▶ 200장 / 폴더.
--     정상 사용:  하루 한 장이면 **6~7개월**. 사진 없는 글도 정상이므로 실제로는
--                 더 깁니다. 상한에 걸리기 전에 앱이 남은 칸을 보여 주고, 게시물을
--                 지우면 칸이 돌아옵니다(⑧ 의 큐가 파일도 같이 지웁니다).
--                 ★ 아바타(0008)와 결정적으로 다른 점입니다 ★ 거기엔 찌꺼기를 지울
--                 UI 가 없어서 상한이 곧 영구 잠금이었지만, 여기서는 "게시물 삭제"
--                 라는 정상적인 출구가 이미 제품에 있습니다.
--     공격 최악:  200 × 1 MiB = **200MB/인**. 상한이 없을 때의 1GB 대비 5배 축소.
--     6명 최악:   1.2GB. ★ 솔직히 적자면, 이 숫자는 무료 티어를 넘습니다 ★
--                 개수 상한만으로 티어가 지켜지지는 않습니다. 실사용 기준으로는
--                 200장 × 300KB ≈ 60MB/인, 6명이면 360MB 이고 여기에 아바타
--                 최악 60MB(0008)를 더해도 여유가 있습니다. 즉 이 상한이 보장하는
--                 것은 "한 사람이 혼자서 티어를 즉시 태울 수는 없다" 까지이고,
--                 그 이상은 크기 상한 + 아래 ⑩ 의 사용량 모니터링 질의의 몫입니다.
--                 (진짜로 티어가 위험해지면 손댈 곳은 이 함수 하나입니다.)
--   ▶ 바꾸려면 private.post_file_limit() 한 곳만 고치세요. 트리거와 자체 점검이
--     둘 다 이 함수를 읽습니다. 상수를 두 곳에 적으면 반드시 어긋납니다.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function private.post_file_limit()
returns integer
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select 200
$fn$;

comment on function private.post_file_limit() is
  '게시물 사진 폴더(<uid>/) 하나에 허용하는 파일 개수 상한. 0010 ⑦ 참고: '
  '하루 한 장이면 6~7개월치이고, 공격 최악은 200 x 1MiB = 200MB/인입니다. '
  '아바타(0008 의 5)와 달리 "게시물 삭제" 라는 정상적인 출구가 있어 상한이 '
  '영구 잠금이 되지 않습니다.';

alter function private.post_file_limit() owner to postgres;
revoke all on function private.post_file_limit() from public;
-- 트리거 함수 안에서만 부릅니다. authenticated 에 EXECUTE 를 주지 않습니다
-- (트리거가 부르는 함수의 EXECUTE 는 CREATE TRIGGER 시점에만 검사됩니다 -- 0008 참고).


-- 세는 식은 아래 인덱스 식과 **글자 그대로 같아야** 합니다. 다르면 인덱스를
-- 못 씁니다. 둘 다 (pg_catalog.string_to_array(name, '/'))[1] 입니다.
-- (LIKE 접두 매칭을 안 쓰는 이유는 0008 의 주석 참고 -- 기본 콜레이션에서
--  btree 를 못 타고 범위 경계가 미묘해집니다.)
create or replace function private.enforce_post_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_folder text;
  v_limit  integer;
  v_count  integer;
begin
  -- posts 이외의 버킷은 이 트리거의 관심사가 아닙니다. avatars 업로드가 이
  -- 함수 때문에 느려지거나 막히면 안 됩니다.
  if new.bucket_id is distinct from 'posts' then
    return new;
  end if;

  v_folder := (pg_catalog.string_to_array(new.name, '/'))[1];
  if v_folder is null then
    return new;   -- 경로가 빈 문자열인 병리적 경우. 형태 검사는 ⑥ 의 RLS 몫입니다.
  end if;

  v_limit := private.post_file_limit();

  -- 지금 들어오는 행이 향하는 폴더만 셉니다(= 본인 폴더). 남의 폴더는 보지 않으므로
  -- "거부/허용" 이라는 1비트로도 남의 사정이 새지 않습니다(0008 과 같은 판단).
  --   id   가 같은 행  -> UPDATE 로 자기 자신을 다시 쓰는 경우. 세면 안 됩니다.
  --   name 이 같은 행  -> upsert 로 같은 경로를 덮어쓰는 경우. BEFORE INSERT 는
  --                       충돌 판정 **전** 에 돌기 때문에 이 제외가 없으면
  --                       덮어쓰기가 한 칸을 잡아먹은 것처럼 세어집니다.
  select pg_catalog.count(*)
    into v_count
  from storage.objects o
  where o.bucket_id = 'posts'
    and (pg_catalog.string_to_array(o.name, '/'))[1] = v_folder
    and o.id   is distinct from new.id
    and o.name is distinct from new.name;

  if v_count >= v_limit then
    raise exception
      '사진을 % 장까지만 보관할 수 있습니다(현재 %장). '
      '예전 게시물을 지우면 자리가 돌아옵니다.',
      v_limit, v_count
      using errcode = '54000';   -- program_limit_exceeded
      -- 54000 인 이유는 0008 과 같습니다. 클라이언트가 "권한 없음(42501)" 이나
      -- "용량 초과(413)" 와 구분해서 다른 안내를 띄울 수 있어야 합니다.
  end if;

  return new;
end;
$fn$;

comment on function private.enforce_post_quota() is
  'storage.objects BEFORE INSERT/UPDATE OF name 트리거. posts 버킷의 폴더 하나당 '
  '파일 개수를 private.post_file_limit() 로 제한합니다(0010 ⑦).';

alter function private.enforce_post_quota() owner to postgres;
revoke all on function private.enforce_post_quota() from public;
revoke all on function private.enforce_post_quota() from anon, authenticated;


-- 트리거 이름에 대하여: 0008 은 avatars_quota 를 'a' 로 시작하게 해서 storage
-- 엔진의 objects_insert_create_prefix('o') 보다 먼저 발화하도록 했습니다.
-- posts_quota 는 'p' 라서 그 뒤입니다. **문제 없습니다** -- 이 트리거가 예외를
-- 던지면 그 문장 전체가 롤백되므로, 먼저 만들어진 prefix 행도 함께 되돌아갑니다.
-- 0008 의 순서 이야기는 보안 조건이 아니라 "쓸데없는 쓰기를 아낀다" 는 최적화였습니다.
do $do$
begin
  execute $t$drop trigger if exists posts_quota on storage.objects$t$;
  execute $t$
    create trigger posts_quota
      before insert or update of name on storage.objects
      for each row execute function private.enforce_post_quota()
  $t$;

exception
  when insufficient_privilege then
    raise exception
      'storage.objects 에 트리거를 만들 권한이 없습니다(현재 역할: %). 이 '
      '마이그레이션은 postgres 역할로 실행해야 합니다. 이 트리거가 없으면 게시물 '
      '사진 개수에 서버 상한이 전혀 없습니다 -- 넘어가지 마세요.', current_user;
end
$do$;


-- 세는 질의를 받쳐 줄 부분 인덱스 (있으면 좋은 것 -- 실패해도 진행).
-- 0008 의 avatars 인덱스와 형태는 같고 버킷만 다릅니다. 아바타보다 훨씬 중요합니다 --
-- 여기는 폴더당 최대 200행이고 업로드마다 그걸 셉니다.
do $do$
begin
  execute $i$
    create index if not exists posts_objects_owner_folder_idx
      on storage.objects (((pg_catalog.string_to_array(name, '/'))[1]))
      where bucket_id = 'posts'
  $i$;

exception
  when others then
    raise warning
      '[0010] posts_objects_owner_folder_idx 를 만들지 못했습니다(%). '
      '개수 제한 자체는 정상 동작합니다 -- 세는 질의가 posts 행을 훑을 뿐입니다.',
      sqlerrm;
end
$do$;


-- ═══════════════════════════════════════════════════════════════════════════
-- ⑧ 게시물이 지워질 때 사진은 어떻게 되는가
--
-- 【사실: DB 는 Storage 파일을 지울 수 없습니다】
--   0007 ⑥ 에서 배운 그대로입니다. auth.users 캐스케이드도, posts 의 FK 캐스케이드도
--   storage.objects 를 건드리지 않습니다. SQL 로 storage.objects 에서 행을 지우면
--   메타데이터만 사라지고 **S3 의 실제 바이트는 남습니다**(storage-api 가 지웁니다).
--   그러니 여기서 delete from storage.objects 를 하면 안 됩니다 -- 용량은 그대로인데
--   장부만 사라져서, 나중에 무엇을 지워야 하는지조차 알 수 없게 됩니다.
--
-- 【그럼 앱이 지우면 되지 않는가 -- 안 됩니다. 앱이 알 수 없는 경로가 있습니다】
--   사용자가 게시물 하나를 지우는 경우라면 앱이 그 photo_path 를 압니다. 하지만
--   posts 행이 사라지는 경로는 그것만이 아닙니다.
--     * 그룹 삭제      -> groups 캐스케이드로 **여러 사람의** 게시물이 한꺼번에
--     * 계정 삭제      -> profiles 캐스케이드로 그 사람 게시물 전부
--     * 사진 교체      -> UPDATE 로 photo_path 만 바뀌고 옛 파일은 고아
--   앞의 둘은 트랜잭션이 끝난 **뒤에는** 무엇이 있었는지 재구성할 방법이 없습니다.
--   0007 의 아바타는 "폴더 하나를 통째로 list 하고 remove" 로 해결됐지만, 게시물은
--   한 폴더 안에 여러 그룹의 사진이 섞여 있어서 그 수법이 통하지 않습니다.
--
--   ▶ 결정: **DB 가 지울 목록을 남기고, 앱이 그 목록을 비웁니다.**
--     AFTER DELETE / AFTER UPDATE OF photo_path 트리거가 경로를 큐에 넣습니다.
--     큐는 private 스키마라 Data API 로 노출되지 않고, 비우는 문은 service_role
--     전용 RPC 두 개(list -> 실제 삭제 -> clear)뿐입니다.
--     ★ 2단계인 이유 ★ 한 방에 "꺼내면서 지우는(delete .. returning)" 큐로 만들면,
--       Storage 삭제가 실패했을 때 경로가 영영 사라져 파일이 미아가 됩니다.
--       목록을 먼저 받고, 실제로 지운 것만 clear 하면 재시도가 안전해집니다.
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists private.post_photo_orphans (
  photo_path text        primary key,
  deleted_at timestamptz not null default now()
);

-- private 스키마는 노출 스키마가 아니지만(0001), 습관대로 명시적으로 잠급니다.
revoke all on private.post_photo_orphans from public, anon, authenticated;
grant all on private.post_photo_orphans to service_role;
-- ※ service_role 도 PostgREST 를 통해서는 이 테이블을 볼 수 없습니다(private 은
--   노출 스키마가 아님). 실제 접근 경로는 아래 RPC 두 개입니다. 이 GRANT 는
--   psql/SQL 편집기로 직접 들여다볼 때를 위한 것입니다.

-- RLS 를 켜지 않는 이유: 이 테이블에는 authenticated 를 위한 정책이 하나도 없어야
-- 하고, 애초에 GRANT 가 없어서 authenticated 는 문 앞에서 막힙니다. RLS 를 켜면
-- "정책만 잘 쓰면 열어도 되는 테이블" 처럼 보여서 오히려 위험합니다.

comment on table private.post_photo_orphans is
  '지워야 할 게시물 사진의 Storage 경로 큐. posts 행이 사라지거나 photo_path 가 '
  '바뀔 때 트리거가 넣습니다. 비우는 것은 앱의 몫입니다(service_role 로 '
  'public.list_orphan_photos -> storage.remove -> public.clear_orphan_photos). '
  'DB 는 Storage 파일을 지울 수 없고, 그룹/계정 캐스케이드로 사라진 경로는 '
  '나중에 재구성할 방법이 없어서 이 큐가 필요합니다(0010 ⑧).';


create or replace function private.enqueue_post_photo_orphan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_old text;
begin
  -- DELETE 트리거에서 NEW 는 assign 되지 않은 레코드라 읽으면 55000 입니다.
  -- TG_OP 로 분기하세요(0001 의 ensure_group_has_owner 와 같은 함정).
  if tg_op = 'DELETE' then
    v_old := old.photo_path;
  else
    if new.photo_path is not distinct from old.photo_path then
      return null;   -- 사진이 그대로면 할 일 없음
    end if;
    v_old := old.photo_path;
  end if;

  if v_old is null then
    return null;
  end if;

  -- 같은 경로를 아직 가리키는 게시물이 남아 있으면 지우면 안 됩니다.
  -- 무작위 파일명이라 실제로 겹칠 일은 없지만, 이 한 줄이 없으면 "살아 있는
  -- 게시물의 사진이 사라지는" 사고가 이론이 아니라 가능성이 됩니다.
  -- (SECURITY DEFINER + owner postgres 라 posts 의 RLS 를 통과하지 않고 전부 봅니다.
  --  RLS 를 탔다면 "내가 못 보는 남의 게시물이 그 경로를 쓰는 중" 을 놓칩니다.)
  if exists (
    select 1 from public.posts p where p.photo_path = v_old
  ) then
    return null;
  end if;

  insert into private.post_photo_orphans (photo_path)
  values (v_old)
  on conflict (photo_path) do nothing;

  return null;   -- AFTER 트리거. 반환값은 무시됩니다.
end;
$fn$;

alter function private.enqueue_post_photo_orphan() owner to postgres;
revoke all on function private.enqueue_post_photo_orphan() from public, anon, authenticated;

comment on function private.enqueue_post_photo_orphan() is
  'posts AFTER DELETE / AFTER UPDATE OF photo_path 트리거. 더 이상 아무 게시물도 '
  '가리키지 않게 된 사진 경로를 private.post_photo_orphans 에 넣습니다. '
  '그룹/계정 캐스케이드에서도 발화하므로, 앱이 재구성할 수 없는 경로까지 전부 잡힙니다.';

drop trigger if exists posts_enqueue_photo_orphan on public.posts;
create trigger posts_enqueue_photo_orphan
  after delete or update of photo_path on public.posts
  for each row
  execute function private.enqueue_post_photo_orphan();


-- ───────────────────────────────────────────────────────────────────────────
-- ⑧-b 큐를 비우는 문 -- service_role 전용 RPC 2개
--
-- ★ authenticated 에 절대 주지 마세요 ★ 이 목록은 "누가 방금 무엇을 지웠는가" 를
--   경로(= 사용자 uuid + 파일명)로 그대로 드러냅니다. 남의 삭제 활동이 샙니다.
--   그래서 public 스키마에 있지만(PostgREST 로 부르려면 필요합니다) EXECUTE 는
--   service_role 에게만 있습니다. anon/authenticated 가 부르면 42501 입니다.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.list_orphan_photos(p_limit integer default 200)
returns table (photo_path text)
language sql
stable
security definer
set search_path = ''
as $fn$
  select o.photo_path
  from private.post_photo_orphans o
  -- 큐에 들어간 뒤 같은 경로를 쓰는 게시물이 다시 생겼다면 건너뜁니다(경쟁 상태
  -- 보험). 트리거의 같은 검사와 짝입니다 -- 둘 중 하나만 있으면 창이 남습니다.
  where not exists (
    select 1 from public.posts p where p.photo_path = o.photo_path
  )
  order by o.deleted_at asc, o.photo_path asc
  limit greatest(1, least(coalesce(p_limit, 200), 1000));
$fn$;

alter function public.list_orphan_photos(integer) owner to postgres;
revoke all on function public.list_orphan_photos(integer) from public, anon, authenticated;
grant execute on function public.list_orphan_photos(integer) to service_role;

comment on function public.list_orphan_photos(integer) is
  '★ service_role 전용 ★ 지워야 할 게시물 사진 경로 목록. 실제 Storage 삭제 뒤 '
  'public.clear_orphan_photos() 로 큐에서 빼세요. RETURNS TABLE 이라 PostgREST '
  '에서는 [{photo_path}] 배열로 옵니다. 목록을 받기만 해서는 큐가 줄지 않습니다 '
  '-- 삭제 실패 시 재시도가 가능해야 하므로 일부러 2단계입니다.';


create or replace function public.clear_orphan_photos(p_paths text[])
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_n integer;
begin
  if p_paths is null or pg_catalog.cardinality(p_paths) = 0 then
    return 0;
  end if;

  delete from private.post_photo_orphans o
  where o.photo_path = any (p_paths);

  get diagnostics v_n = row_count;
  return v_n;
end;
$fn$;

alter function public.clear_orphan_photos(text[]) owner to postgres;
revoke all on function public.clear_orphan_photos(text[]) from public, anon, authenticated;
grant execute on function public.clear_orphan_photos(text[]) to service_role;

comment on function public.clear_orphan_photos(text[]) is
  '★ service_role 전용 ★ Storage 에서 실제로 지운 경로를 큐에서 뺍니다. '
  '지운 행 수를 반환합니다. 없는 경로를 넘겨도 오류가 아니라 0 입니다(멱등).';


-- ═══════════════════════════════════════════════════════════════════════════
-- ⑨ 자체 점검 -- 실행되는 형태 (0006 / 0008 스타일)
--
-- 덮는 것: 테이블/컬럼/RLS/FORCE, CHECK 이 **실제로** 악성 값을 거부하는지
--          (제약식을 꺼내 그대로 평가), 컬럼 단위 GRANT, 정책 4개가 실제로
--          본인/그룹 제한을 거는지 + 쓰기 정책의 WITH CHECK, 버킷의
--          존재/**비공개**/크기/MIME, storage 정책 4개와 prefixes 정책,
--          개수 상한 트리거의 존재·활성·타이밍 + **정말로 거부하는지**(넣어 보고 롤백),
--          사진 정리 큐 트리거가 **정말로 경로를 남기는지**(넣고 지워 보고 롤백),
--          RPC 2개의 시그니처/secdef/owner/search_path/실행 권한.
-- 못 덮는 것: "인증된 다른 사용자가 남의 폴더에 업로드" 와 "비멤버가 남의 그룹
--          게시물을 읽기" -- 역할 위장이 필요합니다. 0007/0008 과 같은 이유로
--          실행형에 넣지 않고 ⑩ 의 「수동 확인」 에 두었습니다.
-- ═══════════════════════════════════════════════════════════════════════════
do $check$
declare
  v_txt      text;
  v_bool     boolean;
  v_n        int;
  v_limit    int;
  v_i        int;
  v_chk      text;
  v_pol      record;
  v_missing  text[];
  v_mimes    text[];
  v_folder   text;
  v_blocked  boolean;
  v_uid      uuid;
  v_gid      uuid;
  v_pid      uuid;
  v_path     text;
  v_skip     text := null;
  v_uid_a    uuid := '11111111-1111-4111-8111-111111111111'::uuid;
  v_uid_b    uuid := '22222222-2222-4222-8222-222222222222'::uuid;
begin
  -- ─────────────────────────────────────────────────────────────────────
  -- (1) 테이블과 컬럼
  -- ─────────────────────────────────────────────────────────────────────
  if pg_catalog.to_regclass('public.posts') is null then
    raise exception '[점검 실패] public.posts 가 없습니다.';
  end if;

  foreach v_txt in array array['id', 'user_id', 'group_id', 'body', 'photo_path',
                               'created_at', 'updated_at'] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute a
      where a.attrelid = 'public.posts'::regclass
        and a.attname  = v_txt
        and a.attnum > 0 and not a.attisdropped
    ) then
      raise exception '[점검 실패] public.posts.% 컬럼이 없습니다.', v_txt;
    end if;
  end loop;

  -- body / photo_path 는 nullable 이어야 합니다. not null 이면 "사진만" 또는
  -- "글만" 올리는 정상 사용이 통째로 막힙니다.
  if exists (
    select 1 from pg_catalog.pg_attribute a
    where a.attrelid = 'public.posts'::regclass
      and a.attname in ('body', 'photo_path')
      and a.attnotnull
  ) then
    raise exception
      '[점검 실패] posts.body 또는 posts.photo_path 가 NOT NULL 입니다. '
      '둘 중 하나만 있는 게시물이 정상입니다(빈 게시물만 posts_not_empty_chk 로 막습니다).';
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (2) RLS 가 켜져 있고 FORCE 는 꺼져 있는가
  --     FORCE 는 소유자(postgres)에게도 RLS 를 적용해 ⑧ 의 DEFINER 트리거가
  --     posts 를 읽는 순간 정책을 다시 타게 만듭니다(0001 의 경고).
  -- ─────────────────────────────────────────────────────────────────────
  select c.relrowsecurity, c.relforcerowsecurity into v_bool, v_blocked
  from pg_catalog.pg_class c where c.oid = 'public.posts'::regclass;

  if v_bool is not true then
    raise exception
      '[점검 실패] public.posts 의 RLS 가 꺼져 있습니다. 이 테이블은 authenticated 에게 '
      'SELECT GRANT 가 있으므로, RLS 없이는 **모든 그룹의 모든 게시물** 이 읽힙니다.';
  end if;
  if v_blocked is true then
    raise exception
      '[점검 실패] public.posts 에 FORCE ROW LEVEL SECURITY 가 켜져 있습니다. '
      '되돌리세요:  alter table public.posts no force row level security;';
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (3) CHECK 이 **실제로** 거부하는가
  --     제약 이름만 세면 누가 식을 `true` 로 바꿔 놔도 통과합니다. 저장된
  --     제약식을 그대로 꺼내 값에 적용합니다(0007 의 (2) 와 같은 수법).
  -- ─────────────────────────────────────────────────────────────────────

  -- (3-a) 빈 게시물 금지
  select pg_catalog.pg_get_constraintdef(c.oid) into v_chk
  from pg_catalog.pg_constraint c
  where c.conrelid = 'public.posts'::regclass and c.conname = 'posts_not_empty_chk';
  if v_chk is null then
    raise exception '[점검 실패] posts_not_empty_chk 제약이 없습니다.';
  end if;
  v_chk := substr(v_chk, 7);   -- 'CHECK ' 6자 제거

  execute pg_catalog.format(
    'select (%s) from (select %L::text as body, %L::text as photo_path) s',
    v_chk, null, null) into v_bool;
  if coalesce(v_bool, false) then
    raise exception
      '[점검 실패] posts_not_empty_chk 가 (body=null, photo_path=null) 을 통과시켰습니다. '
      '피드에 아무것도 없는 카드가 남습니다.';
  end if;

  execute pg_catalog.format(
    'select (%s) from (select %L::text as body, %L::text as photo_path) s',
    v_chk, '   ', null) into v_bool;
  if coalesce(v_bool, false) then
    raise exception
      '[점검 실패] posts_not_empty_chk 가 공백만 있는 body 를 내용으로 인정했습니다.';
  end if;

  -- 정상 값 둘은 통과해야 합니다(막아 버리면 기능이 죽습니다).
  execute pg_catalog.format(
    'select (%s) from (select %L::text as body, %L::text as photo_path) s',
    v_chk, '오늘 헬스장 다녀옴', null) into v_bool;
  if not coalesce(v_bool, false) then
    raise exception '[점검 실패] posts_not_empty_chk 가 "글만 있는 게시물" 을 거부합니다.';
  end if;

  execute pg_catalog.format(
    'select (%s) from (select %L::text as body, %L::text as photo_path) s',
    v_chk, null, v_uid_a::text || '/a.jpg') into v_bool;
  if not coalesce(v_bool, false) then
    raise exception '[점검 실패] posts_not_empty_chk 가 "사진만 있는 게시물" 을 거부합니다.';
  end if;

  -- (3-b) photo_path 모양
  select pg_catalog.pg_get_constraintdef(c.oid) into v_chk
  from pg_catalog.pg_constraint c
  where c.conrelid = 'public.posts'::regclass
    and c.conname  = 'posts_photo_path_shape_chk';
  if v_chk is null then
    raise exception '[점검 실패] posts_photo_path_shape_chk 제약이 없습니다.';
  end if;
  v_chk := substr(v_chk, 7);

  foreach v_txt in array array[
    'https://evil.example.com/a.jpg',                     -- 외부 URL
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',         -- data: URL
    'javascript:alert(1)',                                -- 스킴 공격
    '11111111-1111-4111-8111-111111111111/../x.jpg',      -- 경로 탈출
    '11111111-1111-4111-8111-111111111111/x.svg',         -- svg (스크립트 품음)
    '11111111-1111-4111-8111-111111111111/sub/x.jpg',     -- 깊이 2
    'x.jpg',                                              -- 루트
    'not-a-uuid/x.jpg'                                    -- 폴더가 uuid 가 아님
  ] loop
    execute pg_catalog.format('select (%s) from (select %L::text as photo_path) s',
                              v_chk, v_txt) into v_bool;
    if coalesce(v_bool, false) then
      raise exception
        '[점검 실패] posts_photo_path_shape_chk 가 "%" 를 통과시켰습니다.', v_txt;
    end if;
  end loop;

  foreach v_txt in array array[
    '11111111-1111-4111-8111-111111111111/a1b2c3.jpg',
    '11111111-1111-4111-8111-111111111111/photo.webp',
    null
  ] loop
    execute pg_catalog.format('select (%s) from (select %L::text as photo_path) s',
                              v_chk, v_txt) into v_bool;
    if not coalesce(v_bool, false) then
      raise exception
        '[점검 실패] posts_photo_path_shape_chk 가 정상 경로 "%" 를 거부합니다.',
        coalesce(v_txt, '(null)');
    end if;
  end loop;

  -- (3-c) photo_path 소유자 -- 모양만으로는 남의 폴더를 못 막습니다
  select pg_catalog.pg_get_constraintdef(c.oid) into v_chk
  from pg_catalog.pg_constraint c
  where c.conrelid = 'public.posts'::regclass
    and c.conname  = 'posts_photo_path_owner_chk';
  if v_chk is null then
    raise exception '[점검 실패] posts_photo_path_owner_chk 제약이 없습니다.';
  end if;
  v_chk := substr(v_chk, 7);

  execute pg_catalog.format(
    'select (%s) from (select %L::text as photo_path, %L::uuid as user_id) s',
    v_chk, v_uid_b::text || '/x.jpg', v_uid_a) into v_bool;
  if coalesce(v_bool, false) then
    raise exception
      '[점검 실패] posts_photo_path_owner_chk 가 **남의 폴더** 경로를 통과시켰습니다. '
      '이게 뚫리면 남의 사진을 내 게시물에 붙일 수 있고, 서버가 그걸 서명해 줍니다.';
  end if;

  execute pg_catalog.format(
    'select (%s) from (select %L::text as photo_path, %L::uuid as user_id) s',
    v_chk, v_uid_a::text || '/x.jpg', v_uid_a) into v_bool;
  if not coalesce(v_bool, false) then
    raise exception
      '[점검 실패] posts_photo_path_owner_chk 가 본인 폴더 경로를 거부합니다.';
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (4) 컬럼 단위 GRANT
  --     UPDATE 로 group_id 나 user_id 를 고칠 수 있으면 "다른 그룹으로 게시물
  --     밀어 넣기" 와 "남에게 게시물 떠넘기기" 가 정책을 통과해 버립니다.
  -- ─────────────────────────────────────────────────────────────────────
  if not has_column_privilege('authenticated', 'public.posts', 'photo_path', 'SELECT') then
    raise exception '[점검 실패] authenticated 가 posts.photo_path 를 읽지 못합니다.';
  end if;
  if not has_column_privilege('authenticated', 'public.posts', 'body', 'SELECT') then
    raise exception '[점검 실패] authenticated 가 posts.body 를 읽지 못합니다.';
  end if;

  if has_column_privilege('authenticated', 'public.posts', 'group_id', 'UPDATE') then
    raise exception
      '[점검 실패] authenticated 가 posts.group_id 를 UPDATE 할 수 있습니다. '
      'posts_update_own 정책은 user_id 만 보므로, 이 GRANT 가 열려 있으면 자기 '
      '게시물을 **속하지 않은 그룹으로** 옮길 수 있습니다(tasks 와 달리 여기에는 '
      '이동 가드 트리거가 없습니다 -- GRANT 를 닫는 것이 그 자리입니다).';
  end if;
  if has_column_privilege('authenticated', 'public.posts', 'user_id', 'UPDATE') then
    raise exception
      '[점검 실패] authenticated 가 posts.user_id 를 UPDATE 할 수 있습니다. '
      '남에게 게시물을 떠넘길 수 있습니다.';
  end if;
  if has_column_privilege('authenticated', 'public.posts', 'created_at', 'UPDATE')
     or has_column_privilege('authenticated', 'public.posts', 'created_at', 'INSERT') then
    raise exception
      '[점검 실패] authenticated 가 posts.created_at 을 쓸 수 있습니다(백데이팅). '
      '타임라인의 정렬 기준입니다 -- 남의 글 위로 끼워 넣을 수 있게 됩니다.';
  end if;

  -- anon 은 아무것도 없어야 합니다.
  if exists (
    select 1 from information_schema.role_table_grants g
    where g.grantee = 'anon' and g.table_schema = 'public' and g.table_name = 'posts'
  ) then
    raise exception
      '[점검 실패] anon 에게 public.posts 권한이 있습니다. 로그아웃 상태에서 게시물이 읽힙니다.';
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (5) 정책 4개 -- 존재 + 재귀 감시 + 쓰기 정책의 WITH CHECK
  -- ─────────────────────────────────────────────────────────────────────
  v_missing := '{}'::text[];
  foreach v_txt in array array['posts_select_group_members', 'posts_insert_own',
                               'posts_update_own', 'posts_delete_own'] loop
    if not exists (
      select 1 from pg_catalog.pg_policy p
      where p.polrelid = 'public.posts'::regclass and p.polname = v_txt
    ) then
      v_missing := v_missing || v_txt;
    end if;
  end loop;
  if array_length(v_missing, 1) > 0 then
    raise exception '[점검 실패] public.posts 정책이 없습니다: %', v_missing::text;
  end if;

  for v_pol in
    select p.polname,
           p.polcmd,
           coalesce(pg_catalog.pg_get_expr(p.polqual,      p.polrelid), '') as q,
           coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '') as w
    from pg_catalog.pg_policy p
    where p.polrelid = 'public.posts'::regclass
  loop
    v_txt := v_pol.q || ' ' || v_pol.w;

    -- 재귀 감시: 정책 식이 자기가 지키는 테이블이나 group_members 를 직접
    -- 참조하면 42P17 입니다. private.* 헬퍼와 auth.uid() 만 보여야 합니다.
    --
    -- \y(단어 경계)를 쓰는 이유: pg_get_expr 는 search_path 에 따라 테이블을
    -- 'posts' 로도 'public.posts' 로도 렌더하므로 like '%public.posts%' 로는
    -- `FROM posts` 를 놓칩니다. 반대로 like '%posts%' 는 posts_quota 같은
    -- 식별자에 오탐합니다. 단어 경계가 둘 다 해결합니다('.' 은 경계이고
    -- '_' 는 단어 문자라서 posts_xxx 에는 걸리지 않습니다).
    -- 같은 이유로 private.is_group_member(...) 는 'group_members' 에
    -- 걸리지 않습니다(뒤에 오는 글자가 '(' 라서 's' 가 아닙니다).
    if v_txt ~ '\ygroup_members\y' or v_txt ~ '\yposts\y' then
      raise exception
        '[점검 실패] 정책 % 의 식이 테이블을 직접 참조합니다: using=[%] with_check=[%] '
        '-- 멤버십 조회는 private.current_user_group_ids() / private.is_group_member() '
        '만 써야 합니다(0001 의 42P17 무한재귀).',
        v_pol.polname, v_pol.q, v_pol.w;
    end if;

    -- 모든 정책이 auth.uid() 를 통해 호출자에 묶여 있어야 합니다.
    if v_txt not like '%auth.uid()%' then
      raise exception
        '[점검 실패] 정책 % 가 auth.uid() 를 보지 않습니다: using=[%] with_check=[%]',
        v_pol.polname, v_pol.q, v_pol.w;
    end if;

    -- 쓰기 계열(INSERT='a' / UPDATE='w' / ALL='*')에는 WITH CHECK 가 필수입니다.
    if v_pol.polcmd in ('a', 'w', '*') and v_pol.w = '' then
      raise exception
        '[점검 실패] 정책 % 에 WITH CHECK 가 없습니다(polcmd=%). USING 만 있으면 '
        '"쓰기 후의 행" 이 검사되지 않아 user_id 를 고쳐 남에게 떠넘길 수 있습니다.',
        v_pol.polname, v_pol.polcmd;
    end if;
  end loop;

  -- INSERT 정책은 멤버십까지 봐야 합니다("내가 속하지 않은 그룹에 글쓰기" 차단).
  select coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '') into v_txt
  from pg_catalog.pg_policy p
  where p.polrelid = 'public.posts'::regclass and p.polname = 'posts_insert_own';
  if v_txt not like '%is_group_member%' then
    raise exception
      '[점검 실패] posts_insert_own 의 WITH CHECK 에 private.is_group_member(group_id) '
      '가 없습니다. user_id 만 보면 아무 그룹 uuid 에나 게시물을 꽂아 넣을 수 있습니다. '
      '현재: [%]', v_txt;
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (6) 버킷: 존재 / **비공개** / 크기 / MIME
  --     public=true 로 뒤집히면 photo_path 하나가 그대로 영구 공개 URL 이 되고,
  --     ⑤ 의 판단(취소 불가능한 사생활 유출)이 통째로 무너집니다.
  -- ─────────────────────────────────────────────────────────────────────
  if not exists (select 1 from storage.buckets b where b.id = 'posts') then
    raise exception '[점검 실패] storage 버킷 "posts" 가 없습니다.';
  end if;

  select b.public into v_bool from storage.buckets b where b.id = 'posts';
  if v_bool is not false then
    raise exception
      '[점검 실패] posts 버킷이 비공개(public=false)가 아닙니다. 현재: %. '
      '공개로 두면 photo_path 를 아는 사람 누구나 사진을 볼 수 있고, 그 URL 은 '
      '탈퇴/추방 이후에도 **취소할 수 없습니다**. 아바타(0007)와 달리 게시물은 매일 '
      '쌓이는 사생활입니다. 되돌리세요: '
      'update storage.buckets set public = false where id = ''posts'';',
      coalesce(v_bool::text, '(null)');
  end if;

  select b.file_size_limit into v_n from storage.buckets b where b.id = 'posts';
  if v_n is null or v_n > 1048576 then
    raise exception
      '[점검 실패] posts 버킷의 file_size_limit 이 % 입니다(1048576 이하 필수). '
      '클라이언트 검증은 Storage API 를 직접 부르면 없는 것과 같고, 이 한도가 '
      '무료 티어를 지키는 실질적인 손잡이입니다(0010 ⑦).',
      coalesce(v_n::text, '(무제한)');
  end if;

  select b.allowed_mime_types into v_mimes from storage.buckets b where b.id = 'posts';
  if v_mimes is null then
    raise exception
      '[점검 실패] posts 버킷에 allowed_mime_types 제한이 없습니다. '
      'image/svg+xml 과 임의 파일 업로드가 열립니다.';
  end if;
  if 'image/svg+xml' = any(v_mimes) then
    raise exception
      '[점검 실패] posts 버킷이 image/svg+xml 을 허용합니다. SVG 는 <script> 를 '
      '품을 수 있고, 서명 URL 도 결국 Storage 오리진에서 그 파일을 서빙합니다. '
      '목록에서 빼세요.';
  end if;
  if not ('image/jpeg' = any(v_mimes) and 'image/png' = any(v_mimes)) then
    raise exception
      '[점검 실패] posts 버킷의 allowed_mime_types 에 image/jpeg 또는 image/png 가 '
      '없습니다. 현재: %', v_mimes::text;
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (7) storage.objects 정책 4개가 **실제로** 본인 폴더 제한을 거는가
  --     이름만 세면 조건이 `true` 인 정책도 통과합니다(0007 의 (9) 와 같은 형식).
  -- ─────────────────────────────────────────────────────────────────────
  v_missing := '{}'::text[];
  foreach v_txt in array array['posts_select_own_folder', 'posts_insert_own_folder',
                               'posts_update_own_folder', 'posts_delete_own_folder'] loop
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
      and p.polname like 'posts\_%'
  loop
    v_txt := v_pol.q || ' ' || v_pol.w;

    if v_txt not like '%foldername%'
       or v_txt not like '%auth.uid()%'
       or v_txt not like '%posts%' then
      raise exception
        '[점검 실패] storage 정책 % 가 본인 폴더 제한을 걸지 않습니다. '
        'using=[%] with_check=[%]  -- bucket_id = ''posts'' 와 '
        '(storage.foldername(name))[1] = auth.uid()::text 가 모두 있어야 합니다.',
        v_pol.polname, v_pol.q, v_pol.w;
    end if;

    if v_pol.polcmd in ('a', 'w', '*') and v_pol.w = '' then
      raise exception
        '[점검 실패] storage 정책 % 에 WITH CHECK 가 없습니다(polcmd=%). '
        'USING 만 있으면 "내 파일을 남의 폴더 이름으로 rename" 이 통과합니다.',
        v_pol.polname, v_pol.polcmd;
    end if;
  end loop;

  -- 버킷을 한정하지 않는 쓰기 정책이 있으면 위 네 개가 OR 로 무력화됩니다.
  -- 다른 버킷을 위한 정상 정책일 수 있어 예외가 아니라 경고입니다(0007 과 동일).
  for v_pol in
    select p.polname,
           coalesce(pg_catalog.pg_get_expr(p.polqual,      p.polrelid), '') as q,
           coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '') as w
    from pg_catalog.pg_policy p
    where p.polrelid = 'storage.objects'::regclass
      and p.polcmd in ('a', 'w', '*')
  loop
    if (v_pol.q || ' ' || v_pol.w) not like '%bucket_id%' then
      raise warning
        '[0010] storage.objects 에 버킷을 한정하지 않는 쓰기 정책 "%" 가 있습니다. '
        '정책은 OR 로 합쳐지므로 posts 의 본인 폴더 제한을 무력화할 수 있습니다. '
        'using=[%] with_check=[%]', v_pol.polname, v_pol.q, v_pol.w;
    end if;
  end loop;

  -- storage.prefixes 가 있는 엔진이면 정책도 있어야 합니다(없으면 업로드 정지).
  if pg_catalog.to_regclass('storage.prefixes') is null then
    raise notice '[0010] storage.prefixes 가 없는 엔진입니다. 관련 점검을 건너뜁니다.';
  else
    select coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
           coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '')
      into v_txt
    from pg_catalog.pg_policy p
    where p.polrelid = 'storage.prefixes'::regclass
      and p.polname  = 'posts_prefix_own_folder';

    if v_txt is null then
      raise exception
        '[점검 실패] storage.prefixes 가 있는데 posts_prefix_own_folder 정책이 '
        '없습니다. 이 엔진에서 upload() 는 prefixes INSERT 를 요구합니다 -- 정책이 '
        '없으면 사진 업로드가 조용히 실패합니다(보안이 아니라 기능 정지).';
    end if;
    if v_txt not like '%auth.uid()%' or v_txt not like '%posts%'
       or v_txt not like '%string_to_array%' then
      raise exception
        '[점검 실패] posts_prefix_own_folder 가 본인 폴더로 좁히지 않습니다: [%] '
        '※ objects 쪽의 storage.foldername() 을 복사해 오면 안 됩니다 -- prefixes 의 '
        'name 은 디렉터리 자체라 foldername() 이 빈 배열을 돌려주고, 그러면 모든 '
        '업로드가 거부됩니다(0008 ⑤ 의 선례).', v_txt;
    end if;
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (8) 개수 상한: 함수 값 / 트리거 존재·활성·타이밍 / **실제로 거부하는가**
  -- ─────────────────────────────────────────────────────────────────────
  v_limit := private.post_file_limit();
  if v_limit is null or v_limit < 1 then
    raise exception
      '[점검 실패] private.post_file_limit() 이 % 입니다. 1 이상이어야 합니다.',
      coalesce(v_limit::text, '(null)');
  end if;
  if v_limit > 1000 then
    raise exception
      '[점검 실패] private.post_file_limit() = % 입니다. 사람당 최악 %MB 이고, '
      '무료 티어(1GB)를 한 사람이 혼자 태울 수 있습니다. 0010 ⑦ 의 계산을 다시 읽으세요.',
      v_limit, v_limit;   -- file_size_limit 이 1MiB 라 개수 = MB
  end if;

  if not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'storage.objects'::regclass
      and t.tgname  = 'posts_quota'
      and not t.tgisinternal
  ) then
    raise exception
      '[점검 실패] storage.objects 에 posts_quota 트리거가 없습니다. 게시물 사진 '
      '개수에 서버 상한이 없는 상태입니다. Storage 엔진을 업그레이드한 직후라면 '
      '0010 을 다시 실행하세요.';
  end if;

  select t.tgenabled into v_txt
  from pg_catalog.pg_trigger t
  where t.tgrelid = 'storage.objects'::regclass and t.tgname = 'posts_quota';
  if v_txt is distinct from 'O' then
    raise exception
      '[점검 실패] posts_quota 트리거가 비활성 상태입니다(tgenabled=%). '
      '`alter table storage.objects enable trigger posts_quota` 로 되살리세요.', v_txt;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'storage.objects'::regclass
      and t.tgname  = 'posts_quota'
      and (t.tgtype & 2) <> 0    -- BEFORE
      and (t.tgtype & 4) <> 0    -- INSERT
      and (t.tgtype & 1) <> 0    -- FOR EACH ROW
  ) then
    raise exception
      '[점검 실패] posts_quota 가 BEFORE INSERT FOR EACH ROW 가 아닙니다. '
      'AFTER 로 바뀌면 행은 이미 들어간 뒤라 개수를 막지 못합니다.';
  end if;

  -- 실증: 아무도 안 쓰는 무작위 폴더에 limit 개를 넣고 limit+1 번째가 54000 으로
  -- 거부되는지 봅니다. 끝에 sentinel 예외로 서브트랜잭션째 되돌립니다.
  -- ⚠ sentinel 코드를 'ZP000' 처럼 000 으로 끝내지 마세요. 끝 세 자리가 000 인
  --   SQLSTATE 는 개별 코드가 아니라 **클래스** 라서 실패 신호까지 같이 삼킵니다
  --   (0008 이 실제로 겪은 함정). 그래서 실패 핸들러를 먼저 씁니다.
  v_folder := pg_catalog.gen_random_uuid()::text;
  begin
    for v_i in 1..v_limit loop
      insert into storage.objects (bucket_id, name)
      values ('posts', v_folder || '/' || pg_catalog.gen_random_uuid()::text || '.jpg');
    end loop;

    v_blocked := false;
    begin
      insert into storage.objects (bucket_id, name)
      values ('posts', v_folder || '/' || pg_catalog.gen_random_uuid()::text || '.jpg');
    exception
      when sqlstate '54000' then
        v_blocked := true;
    end;

    if not v_blocked then
      raise exception using
        errcode = 'ZP911',
        message = format(
          '[점검 실패] 한 폴더에 %s개를 넣은 뒤 %s번째도 성공했습니다. posts_quota '
          '트리거가 실제로는 아무것도 막지 않습니다. (트리거는 붙어 있는데 세는 '
          '질의가 0 을 돌려주는 상태 -- private.enforce_post_quota() 가 '
          'storage.objects 를 RLS 없이 읽지 못하는 환경이면 이렇게 됩니다.)',
          v_limit, v_limit + 1);
    end if;

    raise exception using errcode = 'ZP811', message = 'rollback sentinel';

  exception
    when sqlstate 'ZP911' then
      raise;                     -- 상한이 안 걸림. 메시지를 그대로 올립니다.
    when sqlstate 'ZP811' then
      null;                      -- 정상 경로. 넣은 행은 전부 되돌아갔습니다.
    when others then
      v_skip := 'quota: ' || sqlstate || ' ' || sqlerrm;
  end;

  if v_skip is not null then
    raise warning
      '[0010] 개수 상한 실증을 수행하지 못했습니다: %. 트리거가 붙어 있다는 것까지만 '
      '확인된 상태입니다 -- ⑩ 의 「수동 확인 ③」 을 실제 로그인 세션에서 돌려 보세요.',
      v_skip;
    v_skip := null;
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (9) 사진 정리 큐: 트리거가 **실제로** 경로를 남기는가
  --     이게 이 파일에서 가장 조용히 죽기 쉬운 부분입니다. 트리거가 없어도
  --     게시물 삭제는 잘 되고, 아무 오류도 안 납니다 -- 사진만 영원히 남습니다.
  --     그래서 실제로 게시물을 만들고 지워 봅니다(끝에 sentinel 로 롤백).
  --     FK 때문에 실제 (사용자, 그룹) 쌍이 필요합니다. 없으면(빈 DB) 건너뜁니다.
  -- ─────────────────────────────────────────────────────────────────────
  if not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.posts'::regclass
      and t.tgname  = 'posts_enqueue_photo_orphan'
      and not t.tgisinternal
  ) then
    raise exception
      '[점검 실패] public.posts 에 posts_enqueue_photo_orphan 트리거가 없습니다. '
      '게시물을 지워도 Storage 사진이 남고, 그룹/계정 캐스케이드로 사라진 경로는 '
      '나중에 재구성할 수 없습니다(0010 ⑧).';
  end if;

  select gm.user_id, gm.group_id into v_uid, v_gid
  from public.group_members gm
  limit 1;

  if v_uid is null then
    raise notice
      '[0010] group_members 가 비어 있어 사진 정리 큐 실증을 건너뜁니다 '
      '(트리거가 붙어 있다는 것까지는 확인했습니다). 실제 그룹이 생긴 뒤 이 '
      '마이그레이션을 한 번 더 실행하면 여기까지 검증됩니다.';
  else
    v_path := v_uid::text || '/' || pg_catalog.gen_random_uuid()::text || '.jpg';
    begin
      insert into public.posts (user_id, group_id, body, photo_path)
      values (v_uid, v_gid, '[0010 자체 점검]', v_path)
      returning id into v_pid;

      delete from public.posts where id = v_pid;

      if not exists (
        select 1 from private.post_photo_orphans o where o.photo_path = v_path
      ) then
        raise exception using
          errcode = 'ZP912',
          message =
            '[점검 실패] 게시물을 지웠는데 사진 경로가 private.post_photo_orphans 에 '
            '들어가지 않았습니다. 트리거는 붙어 있지만 실제로는 아무것도 기록하지 '
            '않는 상태입니다 -- 모든 게시물 사진이 Storage 에 영구히 남습니다.';
      end if;

      -- 목록 RPC 가 그 경로를 실제로 돌려주는지도 여기서 함께 봅니다.
      if not exists (
        select 1 from public.list_orphan_photos(1000) f where f.photo_path = v_path
      ) then
        raise exception using
          errcode = 'ZP913',
          message =
            '[점검 실패] public.list_orphan_photos() 가 방금 큐에 들어간 경로를 '
            '돌려주지 않습니다. 앱이 이 목록으로 정리하므로, 이게 비면 큐만 쌓입니다.';
      end if;

      raise exception using errcode = 'ZP812', message = 'rollback sentinel';

    exception
      when sqlstate 'ZP912' then raise;
      when sqlstate 'ZP913' then raise;
      when sqlstate 'ZP812' then null;   -- 정상 경로. 게시물도 큐 행도 되돌아갔습니다.
      when others then
        v_skip := 'orphan: ' || sqlstate || ' ' || sqlerrm;
    end;

    if v_skip is not null then
      raise warning
        '[0010] 사진 정리 큐 실증을 수행하지 못했습니다: %. 트리거 존재까지만 '
        '확인된 상태입니다.', v_skip;
      v_skip := null;
    end if;
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (10) 정리 RPC 2개: 시그니처 / secdef / owner / search_path / 실행 권한
  --      ★ authenticated 가 부를 수 있으면 남의 삭제 활동이 샙니다 ★
  -- ─────────────────────────────────────────────────────────────────────
  foreach v_txt in array array['public.list_orphan_photos(integer)',
                               'public.clear_orphan_photos(text[])'] loop
    if not exists (
      select 1
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
      where p.oid = v_txt::regprocedure
        and p.prosecdef
        and r.rolname = 'postgres'
        and exists (
          select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) as cfg
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
    if has_function_privilege('authenticated', v_txt, 'execute') then
      raise exception
        '[점검 실패] authenticated 가 % 를 실행할 수 있습니다. 이 목록은 "누가 방금 '
        '무엇을 지웠는가" 를 경로(사용자 uuid + 파일명)로 드러냅니다. '
        'service_role 에게만 주세요.', v_txt;
    end if;
    if not has_function_privilege('service_role', v_txt, 'execute') then
      raise exception
        '[점검 실패] service_role 이 % 를 실행할 수 없습니다. 정리 라우트가 큐를 '
        '비울 수 없어 사진이 무한히 쌓입니다.', v_txt;
    end if;
  end loop;

  if pg_catalog.pg_get_function_result('public.list_orphan_photos(integer)'::regprocedure)
     is distinct from 'TABLE(photo_path text)' then
    raise exception
      '[점검 실패] list_orphan_photos 의 반환 타입이 "%" 입니다. '
      'TABLE(photo_path text) 여야 합니다 -- TypeScript 가 그대로 씁니다.',
      pg_catalog.pg_get_function_result('public.list_orphan_photos(integer)'::regprocedure);
  end if;
  if pg_catalog.pg_get_function_result('public.clear_orphan_photos(text[])'::regprocedure)
     is distinct from 'integer' then
    raise exception
      '[점검 실패] clear_orphan_photos 의 반환 타입이 "%" 입니다(integer 여야 합니다).',
      pg_catalog.pg_get_function_result('public.clear_orphan_photos(text[])'::regprocedure);
  end if;

  -- 큐 테이블에 authenticated 권한이 붙어 있지 않은지.
  if has_table_privilege('authenticated', 'private.post_photo_orphans', 'SELECT') then
    raise exception
      '[점검 실패] authenticated 가 private.post_photo_orphans 를 읽을 수 있습니다. '
      '남이 방금 지운 사진 경로가 그대로 보입니다.';
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (11) Realtime: posts 는 퍼블리케이션에 넣지 않았고 replica identity 는 d
  --      (④ 참고. 나중에 넣더라도 FULL 이면 DELETE 때 본문/경로가 방송됩니다.)
  -- ─────────────────────────────────────────────────────────────────────
  select c.relreplident into v_txt
  from pg_catalog.pg_class c where c.oid = 'public.posts'::regclass;
  if v_txt is distinct from 'd' then
    raise exception
      '[점검 실패] public.posts 의 replica identity 가 "%" 입니다(d 여야 합니다). '
      '되돌리세요:  alter table public.posts replica identity default;  '
      'FULL 이면 posts 를 퍼블리케이션에 넣는 순간 삭제된 게시물의 본문과 사진 '
      '경로가 구독자 전원에게 방송됩니다(Realtime 은 DELETE 에 RLS 를 적용하지 않습니다).',
      v_txt;
  end if;

  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
     and exists (
       select 1 from pg_catalog.pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'posts'
     ) then
    raise warning
      '[0010] public.posts 가 supabase_realtime 에 들어 있습니다. 0010 ④ 는 일부러 '
      '넣지 않기로 했습니다 -- 의도한 것이라면 replica identity 가 계속 DEFAULT 인지 '
      '확인하고 이 경고를 무시하세요.';
  end if;

  raise notice
    '[0010] 자체 점검 통과. 버킷 posts = 비공개 / 1MiB / 폴더당 %개.', v_limit;
end;
$check$;


-- ═══════════════════════════════════════════════════════════════════════════
-- ⑩ 수동 확인 + ★ 앱이 책임져야 하는 정리 작업 ★
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ── ★ 앱이 반드시 해야 하는 일 (DB 가 못 하는 것) ★ ───────────────────────
--
--   1) 게시물 작성 실패 시 방금 올린 사진 지우기
--      순서는 반드시 "업로드 -> posts INSERT" 입니다(경로를 알아야 INSERT 하므로).
--      INSERT 가 실패하면 그 파일은 어떤 게시물도 가리키지 않는 고아가 되고,
--      ⑧ 의 트리거는 **posts 행이 사라질 때만** 돌기 때문에 큐에도 안 들어갑니다.
--        const up = await supabase.storage.from('posts').upload(path, blob, {...})
--        const ins = await supabase.from('posts').insert({...}).select().single()
--        if (ins.error) await supabase.storage.from('posts').remove([path])   // ★
--      이게 가능한 이유가 ⑥ 의 posts_delete_own_folder 정책입니다.
--
--   2) 사진 정리 큐 비우기 (service_role)
--      게시물 삭제 / 사진 교체 / 그룹 삭제 / 계정 삭제 -- 어느 경로든 ⑧ 의 트리거가
--      경로를 큐에 넣습니다. 실제 삭제는 앱이 합니다. 라우트든 cron 이든 좋습니다.
--        const admin = createAdminClient()                       // lib/supabase/admin.ts
--        const { data } = await admin.rpc('list_orphan_photos', { p_limit: 200 })
--        const paths = (data ?? []).map(r => r.photo_path)        // RETURNS TABLE -> 배열
--        if (paths.length) {
--          const { data: removed, error } = await admin.storage.from('posts').remove(paths)
--          if (!error) {
--            await admin.rpc('clear_orphan_photos',
--                            { p_paths: removed.map(o => o.name) })   // 실제로 지운 것만
--          }
--        }
--      ★ 순서를 뒤집지 마세요 ★ clear 를 먼저 하면 삭제가 실패했을 때 경로가
--        영영 사라져 파일이 미아가 됩니다. 이게 큐를 2단계로 만든 이유입니다.
--      ★ remove() 는 없는 파일에 오류를 내지 않습니다(멱등). 재시도해도 안전합니다.
--
--   3) 사진 서명 URL 발급 -- 반드시 RLS 로 거른 경로만 (⑤ 의 선택지 2)
--        // 1단계: 사용자 토큰. RLS 가 "볼 수 있는 게시물" 만 돌려줍니다.
--        const { data: posts } = await supabase
--          .from('posts').select('id, user_id, body, photo_path, created_at')
--          .eq('group_id', groupId).order('created_at', { ascending: false }).limit(20)
--        // 2단계: service_role. 1단계에서 나온 경로만 넘깁니다.
--        const paths = posts.filter(p => p.photo_path).map(p => p.photo_path)
--        const { data: signed } = await createAdminClient()
--          .storage.from('posts').createSignedUrls(paths, 3600)
--      ★ 클라이언트가 보낸 임의의 경로를 절대 그대로 서명하지 마세요 ★
--        그러면 service_role 이 "아무 경로나 서명해 주는 오라클" 이 됩니다.
--      서명 URL 은 만료됩니다(위 예시는 1시간). 서버 컴포넌트에서 매 요청 발급하고,
--      무한 스크롤은 다음 배치를 가져올 때 그 배치의 URL 도 함께 받으세요.
--
--   4) 업로드 전에 사진 줄이기
--      버킷 한도가 1 MiB 입니다. 폰 원본(4~8MB)은 그냥 실패합니다 -- 의도입니다.
--      canvas 로 장변 1280px, JPEG/WebP q0.8 로 줄여서 올리세요.
--      경로는 `${uid}/${crypto.randomUUID()}.jpg` 입니다(깊이 1, 무작위 파일명).
--
--   5) 남은 칸 보여 주기
--      폴더당 200장이 상한입니다(private.post_file_limit).
--        const { data } = await supabase.storage.from('posts').list(uid, { limit: 1000 })
--      가 200 에 가까워지면 "예전 게시물을 지우면 자리가 돌아옵니다" 를 안내하세요.
--      상한에 걸린 업로드는 SQLSTATE 54000 과 위 한국어 메시지로 돌아옵니다.
--
--   6) 계정 삭제 라우트 (app/api/account/delete/route.ts)
--      0007 은 avatars/<uid>/ 를 라우트가 직접 list + remove 해야 했습니다.
--      게시물은 두 가지 방법이 다 됩니다. 둘 다 하는 것을 권합니다.
--        (a) auth.admin.deleteUser() 뒤에 2) 의 큐 비우기를 한 번 돌린다
--            -- 캐스케이드로 사라진 게시물의 사진이 전부 큐에 들어가 있습니다.
--        (b) 그 전에 storage.from('posts').list(uid) + remove() 로 폴더를 비운다
--            -- 1) 의 고아 파일(게시물이 없는 업로드 찌꺼기)까지 잡힙니다.
--            (b) 를 하고 (a) 를 돌리면 큐에 남은 경로는 이미 없는 파일이라
--            remove() 가 조용히 성공하고 clear 로 정리됩니다.
--
-- ── 수동 확인 ① 남의 폴더에 업로드 / 남의 폴더 열거 (기대: 전부 실패)
--      로그인한 브라우저 콘솔에서:
--        const b = new Blob([new Uint8Array(16)], { type: 'image/jpeg' })
--        await supabase.storage.from('posts').upload(`${남의uuid}/x.jpg`, b)  // 실패해야 정상
--        await supabase.storage.from('posts').upload('x.jpg', b)              // 루트. 실패
--        await supabase.storage.from('posts').list('<남의uuid>')              // 0건이어야 정상
--        await supabase.storage.from('posts')
--          .upload(`${myUid}/${crypto.randomUUID()}.jpg`, b)                  // 성공해야 정상
--
-- ── 수동 확인 ② 비공개 버킷이 정말 비공개인가 (기대: 로그아웃 상태에서 400/404)
--      브라우저 시크릿 창에서 공개 엔드포인트를 직접 열어 보세요:
--        https://<project>.supabase.co/storage/v1/object/public/posts/<uid>/<파일>.jpg
--      사진이 보이면 버킷이 공개로 뒤집힌 것입니다. 자체 점검 (6) 이 잡지만,
--      대시보드에서 바꾸고 마이그레이션을 다시 안 돌린 상태일 수 있습니다.
--      서명 URL 은 반대로 보여야 정상입니다(발급 후 1시간).
--
-- ── 수동 확인 ③ 개수 상한이 진짜 사용자에게도 걸리는가
--      자체 점검 (8) 은 postgres 컨텍스트에서 돕니다. 실제 세션에서:
--        for (let i = 0; i < 205; i++) { ... upload ... }
--      200번째까지 ok, 201번째부터 '사진을 200 장까지만 ...' 이어야 정상.
--      ※ 확인 뒤에는 list + remove 로 반드시 지우세요.
--
-- ── 수동 확인 ④ 다른 그룹의 게시물이 안 보이는지
--      같은 그룹이 아닌 계정으로:  select * from public.posts;
--      상대 그룹 행이 한 줄도 나오면 안 됩니다.
--
-- ── 손으로 보는 확인 (postgres 세션)
--   select id, public, file_size_limit, allowed_mime_types
--     from storage.buckets where id = 'posts';
--   -- posts | f | 1048576 | {image/jpeg,image/png,image/webp}
--
--   select private.post_file_limit();
--
--   select t.tgname, t.tgenabled from pg_trigger t
--    where t.tgrelid = 'storage.objects'::regclass and not t.tgisinternal order by 1;
--   -- avatars_quota(0008) 와 posts_quota(0010) 가 모두 'O' 여야 합니다.
--
--   select count(*) from private.post_photo_orphans;
--   -- 정리 라우트가 도는 중이면 대개 0 근처입니다. 계속 늘면 라우트가 죽은 것입니다.
--
--   -- 폴더별 실제 사용량 (가끔 보세요 -- 무료 티어 1GB)
--   select (string_to_array(name, '/'))[1] as folder,
--          count(*) as files,
--          pg_size_pretty(sum((metadata->>'size')::bigint)) as bytes
--     from storage.objects where bucket_id = 'posts'
--    group by 1 order by 2 desc;
-- ═══════════════════════════════════════════════════════════════════════════


notify pgrst, 'reload schema';
