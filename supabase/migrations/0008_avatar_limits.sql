-- ═══════════════════════════════════════════════════════════════════════════
-- 0008_avatar_limits.sql  --  아바타 파일 **개수** 상한 + storage.prefixes 정책
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 【이 파일이 하는 일】
--   ① private.avatar_file_limit()        -- 상한 값의 단일 진실 (5)
--   ② private.enforce_avatar_quota()     -- SECURITY DEFINER 트리거 함수
--   ③ storage.objects 에 BEFORE INSERT OR UPDATE OF name 트리거
--   ④ 세는 질의를 받쳐 줄 부분 인덱스 (실패해도 치명적이지 않음)
--   ⑤ storage.prefixes 가 있는 엔진에서만 "본인 폴더" 정책 1개 (조건부·멱등)
--   ⑥ 자체 점검 -- 상한이 **실제로** 거부하는지 넣어 보고 롤백하는 항목 포함
--
-- ───────────────────────────────────────────────────────────────────────────
-- 【왜 필요한가 -- 0007 이 남긴 구멍】
--   0007 의 avatars_insert_own_folder 는 "본인 폴더인가" 만 봅니다. 몇 개까지인가는
--   보지 않습니다. 삭제는 app/me 의 최선노력 정리뿐이고, 그건 Storage API 를 직접
--   부르는 쪽에는 존재하지 않는 것과 같습니다. 로그인 세션 하나로:
--
--     const blob = new Blob([new Uint8Array(2*1024*1024 - 1)], { type: 'image/png' })
--     for (let i = 0; i < 512; i++)
--       await supabase.storage.from('avatars')
--         .upload(`${uid}/${crypto.randomUUID()}.png`, blob, { contentType: 'image/png' })
--
--   = 1GB. 무료 티어 저장소 한도와 정확히 같은 값이고, 소진되면 프로젝트 전체의
--   Storage 쓰기가 멈춥니다. 공개 버킷이라 egress(무료 5GB)도 같은 방식으로 빠집니다.
--   가입 허용목록이 있어 "공격자"는 친구로 한정되지만, 이건 인증된 사용자가 가진
--   유일한 무한 쓰기 프리미티브이고 실수로도(자동 재시도 루프) 일어납니다.
--
-- ───────────────────────────────────────────────────────────────────────────
-- 【왜 RLS 정책이 아니라 트리거인가 -- 42P17 을 실제로 확인한 결과】
--   가장 먼저 검토한 것은 정책 안에서 세는 방법입니다:
--
--     create policy avatars_insert_own_folder on storage.objects for insert
--       with check ( ... and (select count(*) from storage.objects
--                              where bucket_id = 'avatars' and ...) < 5 )
--
--   이건 **재귀합니다**. Postgres 는 정책 식 안에서 그 정책이 지키는 릴레이션을
--   다시 읽을 때 정책을 재적용하고, 순환을 감지하면 SQLSTATE 42P17
--   ("infinite recursion detected in policy for relation ...") 로 포기합니다.
--   0002 의 group_members 가 정확히 같은 문제였고, 그때의 해법은 postgres 소유
--   SECURITY DEFINER 헬퍼(private.*)로 읽기를 정책 바깥으로 빼내는 것이었습니다.
--
--   ▶ 여기서도 우회 수단은 SECURITY DEFINER 입니다. 다만 헬퍼를 정책에 끼우는
--     대신 **트리거**로 갑니다. 이유 두 가지:
--       (1) 정책 식은 INSERT 마다 평가되지만 UPDATE 로 이름을 바꿔 폴더를 옮기는
--           경로까지 한 식으로 덮으려면 정책 4개를 전부 손대야 합니다. 트리거는
--           `before insert or update of name` 한 줄로 두 경로를 함께 잡습니다.
--       (2) 0007 의 정책 4개는 지금 형태 그대로 자체 점검 (9)에 박제돼 있습니다.
--           그 식을 건드리지 않고 상한만 얹는 편이 두 파일 모두 안전합니다.
--     트리거 함수는 정책 식이 아니므로 애초에 재귀 대상이 아니고, 게다가
--     postgres 소유 SECURITY DEFINER 라 storage.objects 를 읽을 때 RLS 를
--     통과하지 않습니다. 42P17 이 생길 자리가 없습니다.
--
-- 【storage 스키마에 트리거를 다는 것이 Supabase 업그레이드에 안전한가】
--   판단: **안전하다. 단, 무조건은 아니고 "재실행이 곧 복구" 라는 조건부로.**
--     - storage-api 의 마이그레이션은 storage.objects 를 alter 하고(컬럼·인덱스·
--       정책·자기네 트리거 추가) 있지, drop table 로 갈아엎지 않습니다. 갈아엎으면
--       사용자 파일 메타데이터가 통째로 날아가므로 앞으로도 그럴 수 없습니다.
--       테이블이 남아 있는 한 남의 스키마에 붙인 트리거는 살아남습니다.
--     - 저쪽이 지우는 것은 `drop trigger if exists <자기네 이름>` 뿐입니다. 우리
--       이름 avatars_quota 는 그 목록에 없습니다(있게 될 리도 없습니다).
--     - 그래도 100% 는 아닙니다. 그래서 이 파일은 전부 멱등이고, **재실행이 곧
--       복구**입니다. 그리고 아래 자체 점검 (2)(3) 이 트리거의 부재/비활성을
--       예외로 잡습니다 -- 스토리지 업그레이드 후 이 마이그레이션을 한 번 다시
--       돌리는 것을 운영 절차로 두세요.
--     - 대안이었던 "정책 안에서 세기" 는 위에서 본 대로 42P17 로 아예 불가능하고,
--       "애플리케이션에서만 세기" 는 Storage API 를 직접 부르면 없는 것과 같습니다
--       (0007 이 크기·MIME 을 버킷 설정으로 건 것과 같은 이유). 서버 강제 수단은
--       실질적으로 트리거뿐입니다.
--
-- ───────────────────────────────────────────────────────────────────────────
-- 【상한 값을 5 로 정한 근거】
--   정상 사용은 사람당 1장입니다. app/me 는 새 파일을 올린 뒤 옛 파일을 지우므로
--   교체 도중 잠깐 2장이 공존합니다. 여기에 "지우기가 실패해 남은 찌꺼기" 몫으로
--   여유를 3장 더 둡니다.
--
--     1 (현재 사진) + 1 (교체 중 일시적) + 3 (정리 실패 찌꺼기 여유) = 5
--
--   ▶ 왜 3(=최소한의 여유)이 아니라 5 인가: 상한에 걸리면 사용자는 **사진을 영영
--     못 바꿉니다**(찌꺼기를 지울 UI 가 없습니다). 3 은 정리 실패가 두 번만 겹쳐도
--     잠기고, 그건 보안 사고가 아니라 그냥 고장입니다. 반대로 상한을 5 로 올려서
--     추가로 감수하는 최악값은 사람당 10MB 뿐입니다.
--   ▶ 최악값 계산: 5 × 2MB = 10MB/인. 6명 = 60MB (무료 1GB 의 6%).
--     허용목록을 20명까지 늘려도 200MB. 공격 루프는 1GB 가 아니라 10MB 에서
--     멈춥니다 -- 100배 축소이고, 이게 이 수정의 전부입니다.
--   ▶ 바꾸려면 private.avatar_file_limit() 한 곳만 고치세요. 트리거와 자체 점검이
--     둘 다 그 함수를 읽습니다(상수를 두 곳에 적어 두면 반드시 어긋납니다).
--
-- ───────────────────────────────────────────────────────────────────────────
-- 【"본인 파일만 센다" -- 정보 누출 방지】
--   세는 질의는 `bucket_id = 'avatars' AND 첫 경로조각 = new.name 의 첫 경로조각`
--   입니다. 즉 **지금 들어오는 그 행이 향하는 폴더** 만 셉니다. RLS 가 그 폴더를
--   본인 것으로 이미 못 박았으므로(0007) 결과적으로 본인 파일만 셉니다.
--   남의 폴더를 세지 않으니 "거부/허용" 이라는 1비트로도 남의 사정이 새지 않습니다.
--   (역으로, 전역 개수를 셌다면 남이 몇 장을 올렸는지가 내 업로드 성패로 샙니다.)
--
-- 멱등: create or replace / drop trigger if exists / create index if not exists /
--       drop policy if exists / to_regclass 가드. 여러 번 실행해도 안전합니다.
-- 0007 이 이미 적용된 DB 를 전제로 합니다(버킷 avatars 와 정책 4개가 있어야 함).
-- 반드시 `postgres` 역할로 실행하세요 (SECURITY DEFINER 와 storage 트리거의 근거).
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- 0. 선행 조건 확인 -- 0007 없이 이 파일만 돌면 조용히 아무것도 안 지킵니다
-- ───────────────────────────────────────────────────────────────────────────
do $do$
begin
  if pg_catalog.to_regclass('storage.objects') is null then
    raise exception
      'storage 스키마가 없습니다. Supabase 프로젝트가 아니거나 Storage 가 꺼져 '
      '있습니다. 대시보드에서 Storage 를 켠 뒤 0007 -> 0008 순서로 실행하세요.';
  end if;

  if not exists (select 1 from storage.buckets b where b.id = 'avatars') then
    raise exception
      '버킷 "avatars" 가 없습니다. 0008 은 0007 위에 얹는 파일입니다. '
      '0007_profile_and_default_group.sql 을 먼저 실행하세요.';
  end if;

  if pg_catalog.to_regnamespace('private') is null then
    raise exception
      'private 스키마가 없습니다(0001 에서 만들어집니다). 마이그레이션을 '
      '0001 부터 순서대로 실행하세요.';
  end if;
end
$do$;


-- ───────────────────────────────────────────────────────────────────────────
-- ① 상한 값 -- 단일 진실
--
-- 상수를 트리거 본문과 자체 점검 양쪽에 적으면 언젠가 반드시 어긋나고, 그때
-- "점검은 통과하는데 실제로는 다른 값" 이라는 최악의 형태가 됩니다. 함수 하나로.
-- immutable 인 이유: 값이 리터럴이라 인라인되어야 세는 질의의 계획이 나빠지지
-- 않습니다. 실제 호출은 트리거 함수 안에서 한 번뿐이라 성능 문제는 아니고,
-- 자체 점검이 `private.avatar_file_limit()` 를 그대로 읽게 하려는 목적입니다.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function private.avatar_file_limit()
returns integer
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select 5
$fn$;

comment on function private.avatar_file_limit() is
  '아바타 폴더(<uid>/) 하나에 허용하는 파일 개수 상한. 0008 참고: '
  '1(현재) + 1(교체 중) + 3(정리 실패 여유) = 5, 사람당 최악 10MB.';

alter function private.avatar_file_limit() owner to postgres;
revoke all on function private.avatar_file_limit() from public;
-- 트리거 함수 안에서만 부릅니다. authenticated 에게 EXECUTE 를 주지 않습니다
-- (트리거가 부르는 함수의 EXECUTE 권한은 CREATE TRIGGER 시점에만 검사되고,
--  트리거 발화 시점에는 검사되지 않습니다 -- 0002 의 private.* 와 다른 점).


-- ───────────────────────────────────────────────────────────────────────────
-- ② 트리거 함수
--
-- ▶ security definer + owner postgres: storage.objects 를 RLS 없이 읽기 위함.
--   RLS 를 타면 세는 결과가 "정책이 보여 주는 것" 으로 줄어들어, 정책이 조금이라도
--   느슨해지는 날 상한도 같이 느슨해집니다. 상한은 정책과 독립이어야 합니다.
-- ▶ set search_path = '': 0003/0007 의 SECURITY DEFINER 규칙 그대로. 모든 이름을
--   스키마로 못 박습니다(search_path 를 조작해 다른 objects 를 세게 만드는 길 차단).
-- ▶ 세는 식은 아래 ④ 의 인덱스 식과 **글자 그대로 같아야** 합니다. 다르면 인덱스를
--   못 씁니다. 둘 다 (pg_catalog.string_to_array(name, '/'))[1] 입니다.
--   LIKE 접두 매칭(name like uid || '/%')을 안 쓴 이유: 기본 콜레이션(en_US.UTF-8)
--   에서는 LIKE 접두가 btree 인덱스를 타지 못하고, 범위 비교(>= '/' .. < '0')는
--   구두점을 1차 가중치에서 무시하는 libc 정렬 때문에 경계가 미묘해집니다.
--   첫 조각 **등가 비교**가 폴더 의미와도 정확히 일치하고 인덱스도 탑니다.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function private.enforce_avatar_quota()
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
  -- avatars 이외의 버킷은 이 트리거의 관심사가 아닙니다. 다른 버킷이 생겨도
  -- 이 함수 때문에 느려지거나 막히면 안 됩니다.
  if new.bucket_id is distinct from 'avatars' then
    return new;
  end if;

  v_folder := (pg_catalog.string_to_array(new.name, '/'))[1];
  if v_folder is null then
    return new;   -- 경로가 빈 문자열인 병리적 경우. 형태 검사는 0007 의 RLS 몫입니다.
  end if;

  v_limit := private.avatar_file_limit();

  -- 지금 들어오는 행이 향하는 폴더만 셉니다(= 본인 폴더). 남의 폴더는 보지 않습니다.
  --   id   가 같은 행  -> UPDATE 로 자기 자신을 다시 쓰는 경우. 세면 안 됩니다.
  --   name 이 같은 행  -> upsert(INSERT .. ON CONFLICT DO UPDATE)로 같은 경로를
  --                       덮어쓰는 경우. BEFORE INSERT 트리거는 충돌 판정 **전** 에
  --                       돌기 때문에, 이 제외가 없으면 덮어쓰기가 한 칸을
  --                       잡아먹은 것처럼 세어집니다.
  select pg_catalog.count(*)
    into v_count
  from storage.objects o
  where o.bucket_id = 'avatars'
    and (pg_catalog.string_to_array(o.name, '/'))[1] = v_folder
    and o.id   is distinct from new.id
    and o.name is distinct from new.name;

  if v_count >= v_limit then
    raise exception
      '프로필 사진을 % 개까지만 보관할 수 있습니다(현재 %개). '
      '이전 사진을 먼저 지운 뒤 다시 올려 주세요.',
      v_limit, v_count
      using errcode = '54000';   -- program_limit_exceeded
      -- 54000 을 고른 이유: 클라이언트가 "권한 없음(42501)" 이나 "정책 위반" 과
      -- 구분해서 다른 안내 문구를 띄울 수 있어야 합니다. app/me 의
      -- storageUploadMessage() 는 이 코드/문구를 보고 분기하세요.
  end if;

  return new;
end;
$fn$;

comment on function private.enforce_avatar_quota() is
  'storage.objects BEFORE INSERT/UPDATE OF name 트리거. avatars 버킷의 폴더 '
  '하나당 파일 개수를 private.avatar_file_limit() 로 제한합니다(0008).';

alter function private.enforce_avatar_quota() owner to postgres;
revoke all on function private.enforce_avatar_quota() from public;
revoke all on function private.enforce_avatar_quota() from anon, authenticated;
-- 트리거 함수는 아무도 직접 부를 이유가 없습니다. 발화 시점에는 EXECUTE 를
-- 검사하지 않으므로 전부 회수해도 트리거는 정상 동작합니다.


-- ───────────────────────────────────────────────────────────────────────────
-- ③ 트리거
--
-- `before insert or update of name` -- 두 경로를 함께 덮습니다.
--   INSERT          : 새 파일. 본 목적.
--   UPDATE OF name  : 이름 변경(move/rename). 0007 의 UPDATE 정책이 폴더를
--                     못 넘게 막지만, **같은 폴더 안에서의 rename** 은 허용이고
--                     그 자체로는 개수를 늘리지 않습니다. 그래도 걸어 둡니다 --
--                     정책이 언젠가 느슨해져도 개수만은 독립적으로 지켜집니다.
--
-- 이름을 avatars_quota 로 둔 것도 의도입니다. 같은 타이밍의 트리거는 이름
-- 알파벳 순으로 발화하므로, storage 엔진 v1.19+ 의 objects_insert_create_prefix
-- ('o...') 보다 우리 트리거('a...')가 먼저 돕니다. 즉 거부된 업로드는
-- storage.prefixes 를 건드리지도 않습니다.
-- ───────────────────────────────────────────────────────────────────────────
do $do$
begin
  execute $t$drop trigger if exists avatars_quota on storage.objects$t$;
  execute $t$
    create trigger avatars_quota
      before insert or update of name on storage.objects
      for each row execute function private.enforce_avatar_quota()
  $t$;

exception
  when insufficient_privilege then
    raise exception
      'storage.objects 에 트리거를 만들 권한이 없습니다(현재 역할: %). '
      '이 마이그레이션은 postgres 역할로(예: 대시보드 SQL 편집기, 또는 '
      'supabase db push) 실행해야 합니다. 이 트리거가 없으면 아바타 파일 개수에 '
      '서버 상한이 전혀 없습니다 -- 넘어가지 마세요.', current_user;
end
$do$;


-- ───────────────────────────────────────────────────────────────────────────
-- ④ 세는 질의를 받쳐 줄 부분 인덱스 (있으면 좋은 것 -- 실패해도 진행)
--
-- 인덱스 식은 ② 의 세는 식과 글자 그대로 같습니다. avatars 버킷만 담는 부분
-- 인덱스라 다른 버킷의 쓰기에는 아무 비용도 얹지 않습니다.
-- 지금 규모(3~6명 × 5장 = 30행 미만)에서는 없어도 무방하지만, 업로드 경로에
-- 매번 붙는 질의라 커질 때를 대비해 둡니다.
-- ───────────────────────────────────────────────────────────────────────────
do $do$
begin
  execute $i$
    create index if not exists avatars_objects_owner_folder_idx
      on storage.objects (((pg_catalog.string_to_array(name, '/'))[1]))
      where bucket_id = 'avatars'
  $i$;

exception
  when others then
    -- 인덱스는 성능용입니다. 없다고 상한이 안 걸리지는 않습니다.
    raise warning
      '[0008] avatars_objects_owner_folder_idx 를 만들지 못했습니다(%). '
      '개수 제한 자체는 정상 동작합니다 -- 세는 질의가 avatars 행을 훑을 뿐입니다.',
      sqlerrm;
end
$do$;


-- ───────────────────────────────────────────────────────────────────────────
-- ⑤ storage.prefixes -- 있으면 정책, 없으면 건너뜀
--
-- 【무엇이 문제인가】
--   Storage 엔진 v1.19+ 에는 storage.prefixes 테이블이 생겼습니다. 객체 경로의
--   상위 디렉터리를 별도 행으로 물질화한 것이고, **자체 RLS 를 탑니다**.
--     upload() -> objects INSERT 트리거가 prefixes INSERT 를 유발
--     list()   -> prefixes SELECT
--   0007 은 storage.objects 만 다뤘습니다. 그 엔진 버전에서는 prefixes 에
--   authenticated 를 위한 정책이 하나도 없어 **업로드와 목록이 조용히 실패**할 수
--   있습니다. 보안 구멍이 아니라 기능 정지입니다.
--
-- 【왜 storage.foldername() 을 쓰면 안 되는가 -- 중요】
--   objects 정책은 (storage.foldername(name))[1] 로 씁니다. 파일명을 떼고 남은
--   디렉터리 배열이기 때문입니다. 그런데 prefixes 의 name 은 **디렉터리 자체**
--   ('<uid>') 이지 파일 경로가 아닙니다.
--     storage.foldername('<uid>/x.png') -> {'<uid>'}   -- [1] = uid   (objects)
--     storage.foldername('<uid>')       -> {}          -- [1] = NULL  (prefixes!)
--   즉 objects 와 똑같은 식을 그대로 복사해 오면 prefix 행이 전부 거부되고
--   업로드가 통째로 깨집니다. prefixes 에서는 **첫 경로 조각** 을 봐야 합니다:
--     (pg_catalog.string_to_array(name, '/'))[1] = auth.uid()::text
--   이 식은 '<uid>' 에도, 혹시 생길 더 깊은 '<uid>/a' 에도 모두 맞고, 어느 쪽이든
--   사용자를 자기 폴더 안에 가둡니다.
--
-- 【깊이를 1로 못 박지 않은 이유】
--   objects 정책이 이미 깊이를 정확히 1(<uid>/<파일명>)로 강제하므로, 현재
--   엔진에서 만들어지는 prefix 는 레벨 1('<uid>') 뿐입니다. 그래도 여기서
--   array_length = 1 을 요구하지는 않습니다 -- 엔진이 나중에 prefix 를 다르게
--   물질화하면 그 순간 업로드가 깨집니다. 경계는 "첫 조각 = 내 uid" 하나로 충분하고,
--   그것만으로 남의 폴더는 완전히 닫힙니다.
--
-- for all 로 한 번에 거는 이유: prefixes 의 INSERT/SELECT/UPDATE/DELETE 를 전부
-- 엔진이 알아서 부릅니다(객체를 지우면 빈 prefix 도 정리). 명령별로 쪼갤 실익이
-- 없고, using/with check 가 같은 식이라 쪼개면 어긋날 여지만 생깁니다.
-- ───────────────────────────────────────────────────────────────────────────
do $do$
begin
  if pg_catalog.to_regclass('storage.prefixes') is null then
    raise notice
      '[0008] storage.prefixes 가 없는 엔진입니다(v1.19 미만). 정책을 건너뜁니다. '
      '엔진이 올라간 뒤 이 마이그레이션을 다시 실행하세요 -- 그때 정책이 생깁니다.';
    return;
  end if;

  execute $p$drop policy if exists avatars_prefix_own_folder on storage.prefixes$p$;
  execute $p$
    create policy avatars_prefix_own_folder
      on storage.prefixes
      for all
      to authenticated
      using (
        bucket_id = 'avatars'
        and (pg_catalog.string_to_array(name, '/'))[1] = (select auth.uid())::text
      )
      with check (
        bucket_id = 'avatars'
        and (pg_catalog.string_to_array(name, '/'))[1] = (select auth.uid())::text
      )
  $p$;

exception
  when insufficient_privilege then
    raise exception
      'storage.prefixes 에 정책을 만들 권한이 없습니다(현재 역할: %). postgres '
      '역할로 실행하거나, 대시보드 SQL 편집기에서 avatars_prefix_own_folder 를 '
      '다음 조건으로 만드세요(using / with check 동일): bucket_id = ''avatars'' '
      'and (string_to_array(name, ''/''))[1] = auth.uid()::text. '
      '이 정책이 없으면 v1.19+ 엔진에서 업로드와 목록이 실패합니다.', current_user;
end
$do$;


-- ═══════════════════════════════════════════════════════════════════════════
-- ⑥ 자체 점검 -- 실행되는 형태 (0007 과 같은 방식)
--
-- 마지막 항목 (6) 은 카탈로그를 보는 대신 **실제로 넣어 봅니다**. 트리거가
-- 붙어 있다는 사실과 트리거가 실제로 거부한다는 사실은 다른 명제이고, 상한처럼
-- "평소엔 아무 일도 안 하는" 방어는 후자를 확인하지 않으면 조용히 죽습니다.
-- 넣은 행은 예외를 일부러 던져 서브트랜잭션째로 전부 되돌립니다.
-- ═══════════════════════════════════════════════════════════════════════════
do $check$
declare
  v_limit   integer;
  v_txt     text;
  v_i       integer;
  v_folder  text;
  v_blocked boolean;
  v_skip    text := null;
begin
  -- ─────────────────────────────────────────────────────────────────────
  -- (1) 상한 함수: 존재 / 값이 말이 되는가
  -- ─────────────────────────────────────────────────────────────────────
  v_limit := private.avatar_file_limit();
  if v_limit is null or v_limit < 1 then
    raise exception
      '[점검 실패] private.avatar_file_limit() 이 % 입니다. 1 이상이어야 합니다 '
      '(0 이면 아무도 사진을 올릴 수 없습니다).', coalesce(v_limit::text, '(null)');
  end if;
  if v_limit > 20 then
    raise exception
      '[점검 실패] private.avatar_file_limit() = % 입니다. 사람당 최악 %MB 이고, '
      '이 정도면 상한이라 부를 값이 아닙니다. 0008 의 근거 계산을 다시 읽으세요.',
      v_limit, v_limit * 2;
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (2) 트리거 함수: security definer / owner=postgres / search_path 비움
  --     (0007 의 (5) 와 같은 형식 -- 셋 중 하나만 어긋나도 우회가 생깁니다)
  -- ─────────────────────────────────────────────────────────────────────
  v_txt := 'private.enforce_avatar_quota()';
  if not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_roles r on r.oid = p.proowner
    where p.oid = v_txt::regprocedure
      and p.prosecdef
      and r.rolname = 'postgres'
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

  -- ─────────────────────────────────────────────────────────────────────
  -- (3) 트리거가 storage.objects 에 붙어 있고, **켜져 있고**, 타이밍이 맞는가
  --     tgenabled: 'O'=평소대로, 'D'=비활성, 'R'/'A'=replica 전용.
  --     'D' 는 `alter table ... disable trigger` 한 번이면 나오는 상태이고,
  --     이름만 세는 점검은 그걸 통과시킵니다.
  -- ─────────────────────────────────────────────────────────────────────
  if not exists (
    select 1
    from pg_catalog.pg_trigger t
    where t.tgrelid = 'storage.objects'::regclass
      and t.tgname  = 'avatars_quota'
      and not t.tgisinternal
  ) then
    raise exception
      '[점검 실패] storage.objects 에 avatars_quota 트리거가 없습니다. '
      '아바타 파일 개수에 서버 상한이 없는 상태입니다(0007 의 정책은 "본인 폴더인가" '
      '만 봅니다). Storage 엔진을 업그레이드한 직후라면 0008 을 다시 실행하세요.';
  end if;

  select t.tgenabled into v_txt
  from pg_catalog.pg_trigger t
  where t.tgrelid = 'storage.objects'::regclass and t.tgname = 'avatars_quota';
  if v_txt is distinct from 'O' then
    raise exception
      '[점검 실패] avatars_quota 트리거가 비활성 상태입니다(tgenabled=%). '
      '`alter table storage.objects enable trigger avatars_quota` 로 되살리세요.',
      v_txt;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger t
    where t.tgrelid = 'storage.objects'::regclass
      and t.tgname  = 'avatars_quota'
      and (t.tgtype & 2) <> 0    -- BEFORE
      and (t.tgtype & 4) <> 0    -- INSERT
      and (t.tgtype & 1) <> 0    -- FOR EACH ROW
  ) then
    raise exception
      '[점검 실패] avatars_quota 가 BEFORE INSERT FOR EACH ROW 가 아닙니다. '
      'AFTER 로 바뀌면 행은 이미 들어간 뒤라 개수를 막지 못합니다.';
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (4) 0007 의 정책 4개가 아직 살아 있는가
  --     상한은 "본인 폴더" 제한 위에 얹은 것입니다. 아래가 사라지면 상한은
  --     "남의 폴더에도 5개씩" 이라는 무의미한 방어가 됩니다.
  -- ─────────────────────────────────────────────────────────────────────
  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_policy p
    where p.polrelid = 'storage.objects'::regclass
      and p.polname in ('avatars_select_own_folder', 'avatars_insert_own_folder',
                        'avatars_update_own_folder', 'avatars_delete_own_folder')
  ) <> 4 then
    raise exception
      '[점검 실패] 0007 의 storage.objects 정책 4개가 온전하지 않습니다. '
      '0008 의 개수 상한은 "본인 폴더" 제한 위에 얹는 것입니다 -- '
      '0007 을 다시 실행해 정책을 복구한 뒤 이 파일을 실행하세요.';
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (5) storage.prefixes 가 존재한다면 정책도 존재하는가 + 그 정책이 실제로
  --     본인 폴더로 좁히는가 (이름만 세면 조건이 `true` 인 정책도 통과합니다)
  -- ─────────────────────────────────────────────────────────────────────
  if pg_catalog.to_regclass('storage.prefixes') is null then
    raise notice
      '[0008] storage.prefixes 가 없는 엔진입니다. (5) 를 건너뜁니다.';
  else
    if not exists (
      select 1 from pg_catalog.pg_policy p
      where p.polrelid = 'storage.prefixes'::regclass
        and p.polname  = 'avatars_prefix_own_folder'
    ) then
      raise exception
        '[점검 실패] storage.prefixes 가 있는데 avatars_prefix_own_folder 정책이 '
        '없습니다. 이 엔진에서 upload() 는 prefixes INSERT 를, list() 는 prefixes '
        'SELECT 를 요구합니다 -- 정책이 없으면 아바타 업로드와 목록이 조용히 '
        '실패합니다(보안이 아니라 기능 정지).';
    end if;

    select coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '')
           || ' ' ||
           coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '')
      into v_txt
    from pg_catalog.pg_policy p
    where p.polrelid = 'storage.prefixes'::regclass
      and p.polname  = 'avatars_prefix_own_folder';

    if v_txt not like '%auth.uid()%'
       or v_txt not like '%avatars%'
       or v_txt not like '%string_to_array%' then
      raise exception
        '[점검 실패] avatars_prefix_own_folder 가 본인 폴더로 좁히지 않습니다. [%] '
        '-- bucket_id = ''avatars'' 와 (string_to_array(name, ''/''))[1] = '
        'auth.uid()::text 가 using/with check 양쪽에 있어야 합니다. '
        '※ objects 쪽의 storage.foldername() 을 그대로 복사해 오면 안 됩니다 -- '
        'prefixes 의 name 은 디렉터리 자체라 foldername() 이 빈 배열을 돌려주고, '
        '그러면 모든 업로드가 거부됩니다(0008 ⑤ 참고).', v_txt;
    end if;

    -- with check 가 비어 있으면 prefix 를 남의 폴더 이름으로 만들 수 있습니다.
    if coalesce(
         (select pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)
            from pg_catalog.pg_policy p
           where p.polrelid = 'storage.prefixes'::regclass
             and p.polname  = 'avatars_prefix_own_folder'), '') = '' then
      raise exception
        '[점검 실패] avatars_prefix_own_folder 에 WITH CHECK 가 없습니다. '
        'FOR ALL 정책은 using 만으로는 쓰기 후의 행을 검사하지 않습니다.';
    end if;
  end if;

  -- ─────────────────────────────────────────────────────────────────────
  -- (6) 상한이 **실제로** 거부하는가 -- 넣어 보고 전부 롤백
  --
  --     카탈로그 점검 (2)(3) 은 "트리거가 있다" 까지만 말합니다. 여기서는
  --     아무도 쓰지 않는 무작위 uuid 폴더에 limit 개를 넣고, limit+1 번째가
  --     54000 으로 거부되는지 봅니다. 끝에 sentinel 예외(ZQ801)를 던져
  --     이 블록에서 넣은 행을 서브트랜잭션째로 되돌립니다 -- 성공 경로든
  --     실패 경로든 커밋되는 행은 하나도 없습니다.
  --
  --     ⚠ sentinel 코드를 'ZQ000' 같은 값으로 "정리" 하지 마세요. 끝 세 자리가
  --       000 인 SQLSTATE 는 개별 코드가 아니라 **클래스(카테고리)** 이고,
  --       `when sqlstate 'ZQ000'` 은 ZQ 클래스 전체를 잡습니다. 그러면 아래
  --       실패 신호(ZQ901)까지 롤백 핸들러가 삼켜서, 상한이 완전히 죽어 있어도
  --       이 점검이 "통과" 를 찍습니다. 실제로 그렇게 짰다가 잡았습니다.
  --       그래서 두 코드 모두 000 으로 끝나지 않고, 실패 핸들러를 먼저 씁니다.
  --
  --     ★ 이 점검이 진짜로 값을 하는 지점: ② 의 세는 질의는 storage.objects 에
  --       걸린 RLS 를 통과하지 않아야 합니다(postgres 가 BYPASSRLS 라서 그렇습니다).
  --       만약 그 전제가 깨진 환경이라면 -- 정책은 `to authenticated` 인데 definer
  --       컨텍스트의 역할은 postgres 라 아무 정책도 안 맞고 -- count 가 늘 0 이 되어
  --       상한이 **조용히 사라집니다**. 카탈로그 점검으로는 절대 안 보이는 고장이고,
  --       limit+1 번째가 통과하는 것으로 여기서만 드러납니다.
  --
  --     ⚠ 이 점검은 postgres 컨텍스트(auth.uid() = null)에서 돕니다. 즉
  --       "인증된 사용자가 남의 폴더에 올린다" 는 검증하지 않습니다 -- 그건
  --       0007 의 「수동 확인 ②」 몫이고 여기서도 아래 주석에 남겨 둡니다.
  -- ─────────────────────────────────────────────────────────────────────
  v_folder := pg_catalog.gen_random_uuid()::text;

  begin
    -- limit 개까지는 들어가야 정상입니다.
    for v_i in 1..v_limit loop
      insert into storage.objects (bucket_id, name)
      values ('avatars', v_folder || '/' || pg_catalog.gen_random_uuid()::text || '.png');
    end loop;

    -- limit+1 번째는 거부되어야 정상입니다.
    v_blocked := false;
    begin
      insert into storage.objects (bucket_id, name)
      values ('avatars', v_folder || '/' || pg_catalog.gen_random_uuid()::text || '.png');
    exception
      when sqlstate '54000' then
        v_blocked := true;
    end;

    if not v_blocked then
      raise exception using
        errcode = 'ZQ901',
        message = format(
          '[점검 실패] 한 폴더에 %s개를 넣은 뒤 %s번째도 성공했습니다. '
          'avatars_quota 트리거가 실제로는 아무것도 막지 않습니다. '
          '(트리거는 붙어 있는데 세는 질의가 0 을 돌려주는 상태 -- 예를 들어 '
          'private.enforce_avatar_quota() 가 storage.objects 를 RLS 없이 읽지 '
          '못하는 환경이면 이렇게 됩니다.)',
          v_limit, v_limit + 1);
    end if;

    -- 여기까지 왔으면 통과. 넣은 행을 되돌리기 위해 일부러 던집니다.
    raise exception using errcode = 'ZQ801', message = 'rollback sentinel';

  exception
    -- 실패 신호를 **먼저** 씁니다. 핸들러는 위에서부터 처음 맞는 것이 이깁니다.
    when sqlstate 'ZQ901' then
      raise;                     -- 상한이 안 걸림. 메시지를 그대로 올립니다.
    when sqlstate 'ZQ801' then
      null;                      -- 정상 경로. 위에서 넣은 행은 전부 되돌아갔습니다.
    when others then
      -- 실증 자체를 못 한 경우(예: 이 역할이 storage.objects 에 직접 INSERT 할 수
      -- 없음). 통과로 위장하지 않고 크게 경고합니다.
      v_skip := sqlstate || ' ' || sqlerrm;
  end;

  if v_skip is not null then
    raise warning
      '[0008] 상한 실증(6)을 수행하지 못했습니다: %. '
      '트리거가 붙어 있다는 것까지만 확인된 상태입니다 -- 아래 「수동 확인 ①」 을 '
      '실제 로그인 세션에서 한 번 돌려 상한이 걸리는지 눈으로 보세요.', v_skip;
  end if;

  raise notice '[0008] 자체 점검 통과. 폴더당 상한 = %개.', v_limit;
end;
$check$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 수동 확인 -- 역할 위장이 필요해 실행형으로 넣지 않은 것
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ── ① 상한이 진짜 사용자에게도 걸리는가 (기대: limit+1 번째에서 실패)
--    로그인한 브라우저 콘솔에서:
--      const b = new Blob([new Uint8Array(16)], { type: 'image/png' })
--      for (let i = 0; i < 8; i++) {
--        const r = await supabase.storage.from('avatars')
--          .upload(`${myUid}/${crypto.randomUUID()}.png`, b, { contentType: 'image/png' })
--        console.log(i, r.error?.message ?? 'ok')
--      }
--      // 0..4 는 ok, 5 번째부터 '프로필 사진을 5 개까지만 ...' 이어야 정상.
--      // 확인 뒤에는 올린 파일들을 지우세요:
--      //   const { data } = await supabase.storage.from('avatars').list(myUid)
--      //   await supabase.storage.from('avatars')
--      //     .remove(data.map(f => `${myUid}/${f.name}`))
--
-- ── ② v1.19+ 엔진에서 목록이 되는가 (prefixes SELECT 정책 확인)
--      await supabase.storage.from('avatars').list(myUid)     // 내 파일이 보여야 정상
--      await supabase.storage.from('avatars').list('<남의uuid>')  // 0건이어야 정상
--
-- ── 손으로 보는 확인 (postgres 세션)
--   select private.avatar_file_limit();
--
--   select t.tgname, t.tgenabled, pg_get_triggerdef(t.oid)
--     from pg_trigger t
--    where t.tgrelid = 'storage.objects'::regclass and not t.tgisinternal
--    order by t.tgname;
--   -- avatars_quota 가 목록에 있고 tgenabled = 'O' 여야 합니다. 알파벳 순서상
--   -- objects_insert_create_prefix 보다 앞에 발화합니다.
--
--   select polname, polcmd,
--          pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid)
--     from pg_policy where polrelid = 'storage.prefixes'::regclass;
--   -- 테이블이 있으면 avatars_prefix_own_folder 가 있어야 합니다.
--
--   -- 폴더별 실제 사용량 (정리가 잘 되고 있는지 가끔 보세요)
--   select (string_to_array(name, '/'))[1] as folder,
--          count(*) as files,
--          pg_size_pretty(sum((metadata->>'size')::bigint)) as bytes
--     from storage.objects where bucket_id = 'avatars'
--    group by 1 order by 2 desc;
-- ═══════════════════════════════════════════════════════════════════════════


notify pgrst, 'reload schema';
