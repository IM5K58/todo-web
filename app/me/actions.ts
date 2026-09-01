'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { createClient } from '@/lib/supabase/server'

/**
 * /me 의 서버 쓰기 경로.
 *
 * ---------------------------------------------------------------------------
 * 페이지는 왜 Client Component 인데 액션은 서버에 있는가
 * ---------------------------------------------------------------------------
 * app/me/page.tsx 는 app/settings/page.tsx 와 같은 이유로 클라이언트입니다 —
 * 파일 선택, 업로드 진행 상태, "이름이 정확히 일치할 때만 탈퇴 버튼 활성화" 는
 * 전부 브라우저에만 존재하는 상태입니다.
 *
 * 그렇다고 프로필 쓰기까지 브라우저에 두면 **Next 서버 캐시가 갱신되지
 * 않습니다**. 홈 헤더와 현황/기록 화면이 display_name 과 avatar_url 을 서버
 * 컴포넌트에서 그리므로, 브라우저에서만 UPDATE 하면 이름을 바꾼 직후 홈으로
 * 넘어갔을 때 옛 이름이 한 번 더 보입니다(app/onboarding/actions.ts 가 같은
 * 이유로 revalidatePath 를 부릅니다). 그래서 DB 쓰기 + 캐시 무효화는 여기에
 * 모읍니다.
 *
 * 반대로 **사진 파일 자체는 여기를 지나가지 않습니다.** 브라우저가 Supabase
 * Storage 로 직접 올리고, 그 결과 경로만 setAvatar() 로 넘깁니다. 파일을 Server
 * Action 으로 흘리면 Vercel 함수의 요청 본문 한도(약 4.5MB)를 아바타 한 장이
 * 건드리게 되고, 이미 버킷이 2MB / MIME 제한을 강제하고 있는데 그 앞에 더 약한
 * 관문을 하나 더 세우는 셈입니다.
 *
 * ---------------------------------------------------------------------------
 * 왜 redirect 가 아니라 값을 돌려주는가
 * ---------------------------------------------------------------------------
 * app/groups/manage-actions.ts 는 `?err=` 를 달고 redirect 합니다. 그건 그
 * 화면이 순수 <form> 이라 값을 받을 방법이 없어서였습니다. 여기서는 클라이언트
 * 컴포넌트가 액션을 직접 부르므로 반환값을 그대로 읽을 수 있고, 그러면 사진
 * 업로드처럼 여러 단계가 있는 흐름에서 "어느 단계가 실패했는지" 를 화면 안에서
 * 말해 줄 수 있습니다. 로그아웃만 예외입니다 — 그건 반드시 이동해야 끝납니다.
 *
 * 'use server' 파일은 async 함수만 export 할 수 있습니다. 아래 `type` 은
 * 컴파일 시점에 지워지므로 예외입니다(app/groups/manage-actions.ts 와 동일).
 */

// ---------------------------------------------------------------------------
// 결과 타입
// ---------------------------------------------------------------------------

/** 액션 결과. 실패 메시지는 이미 한국어라 화면이 그대로 그리면 됩니다. */
export type MeActionResult =
  | { ok: true }
  | { ok: false; message: string }

function fail(message: string): MeActionResult {
  return { ok: false, message }
}

// ---------------------------------------------------------------------------
// 검증 — app/onboarding/actions.ts 와 **같은 규칙**
// ---------------------------------------------------------------------------

/**
 * Postgres `char_length()` 는 문자(코드 포인트)를 셉니다. JS 의 `.length` 는
 * UTF-16 코드 유닛을 세기 때문에 '😀'.length 는 2 지만 DB 에서는 1 입니다.
 * 이 차이를 무시하면 이모지가 섞인 이름이 여기서는 통과하고 DB 에서 23514 로
 * 터지거나, 반대로 멀쩡한 이름이 여기서 거절됩니다.
 *
 * profiles_display_name_len_chk: char_length(btrim(display_name)) between 1 and 40
 */
function charLength(value: string): number {
  return Array.from(value).length
}

const NAME_MIN = 1
const NAME_MAX = 40

// ---------------------------------------------------------------------------
// 공통
// ---------------------------------------------------------------------------

/**
 * 검증된 세션의 사용자 id.
 *
 * getClaims() 는 JWT 서명을 로컬에서 검증합니다. getSession() 은 쿠키를 그대로
 * 돌려줄 뿐이라 인가 검사가 아닙니다.
 */
async function sessionUserId(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<string | null> {
  const { data, error } = await supabase.auth.getClaims()
  const userId = data?.claims.sub
  if (error || typeof userId !== 'string' || !userId) return null
  return userId
}

/**
 * 프로필을 바꾼 뒤 서버 캐시 무효화.
 *
 * 'layout' 스코프인 이유: 홈 헤더/하단 탭이 루트 레이아웃 아래에 있고, 라우터
 * 캐시에 남은 이전 RSC 페이로드를 비워 주지 않으면 저장 직후 옛 값이 한 번 더
 * 보입니다(app/onboarding/actions.ts 의 같은 호출과 동일한 이유).
 */
function revalidateProfile(): void {
  revalidatePath('/', 'layout')
}

// ---------------------------------------------------------------------------
// 이름 변경
// ---------------------------------------------------------------------------

/**
 * 표시 이름 저장. auth.uid() 본인 행만.
 *
 * 대상 사용자를 인자로 받지 않습니다. `.eq('id', userId)` 의 userId 는 검증된
 * JWT 에서만 나오고, profiles_update_self 정책이 서버에서 같은 조건을 한 번 더
 * 강제합니다.
 */
export async function saveDisplayName(rawName: string): Promise<MeActionResult> {
  const displayName = typeof rawName === 'string' ? rawName.trim() : ''

  const length = charLength(displayName)
  if (length < NAME_MIN) return fail('이름을 입력해 주세요.')
  if (length > NAME_MAX) return fail('이름은 40자까지 쓸 수 있어요.')

  const supabase = await createClient()
  const userId = await sessionUserId(supabase)
  if (!userId) return fail('로그인이 풀렸어요. 앱을 새로고침한 뒤 다시 시도해 주세요.')

  // `.select('id')` 로 실제로 몇 행이 바뀌었는지 확인합니다. PostgREST 는 0행
  // UPDATE 도 성공으로 돌려주기 때문에, 이게 없으면 저장했다고 말한 뒤 아무것도
  // 바뀌지 않는 조용한 무동작이 생깁니다.
  // profiles 는 컬럼 단위 SELECT 권한이라 '*' 는 42501 입니다. id 만 고릅니다.
  const { data: updated, error } = await supabase
    .from('profiles')
    .update({ display_name: displayName })
    .eq('id', userId)
    .select('id')
    .maybeSingle()

  if (error) {
    if (error.code === '23514') return fail('이 이름은 저장할 수 없는 형태예요.')
    if (error.code === '42501') {
      return fail('로그인이 풀렸어요. 앱을 새로고침한 뒤 다시 시도해 주세요.')
    }
    console.error('[me] display_name update failed', { code: error.code, message: error.message })
    return fail('저장하지 못했어요. 잠시 후 다시 시도해 주세요.')
  }

  if (!updated) {
    // 프로필 행이 없는 계정. handle_new_user() 가 실패를 삼키고 가입을 통과
    // 시키기 때문에 실제로 가능합니다. 0002 의 profiles_insert_self 안전밸브.
    // timezone 은 넘기지 않습니다 — 컬럼 기본값 'Asia/Seoul' 이 맞습니다.
    const { error: insertError } = await supabase
      .from('profiles')
      .insert({ id: userId, display_name: displayName })

    if (insertError) {
      console.error('[me] profile insert fallback failed', insertError.message)
      return fail('저장하지 못했어요. 잠시 후 다시 시도해 주세요.')
    }
  }

  revalidateProfile()
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 프로필 사진
// ---------------------------------------------------------------------------

/**
 * 이 파일이 하는 단 하나의 RPC 호출을 손으로 타이핑한 것. 이유는 호출부 주석 참고.
 * `returns void` 이므로 error 만 읽습니다.
 */
type SetAvatarRpc = (
  fn: 'set_avatar',
  args: { p_avatar_url: string | null },
) => PromiseLike<{ error: { code?: string | null; message?: string } | null }>

// ---------------------------------------------------------------------------
// 옛 아바타 파일 회수 (Storage)
// ---------------------------------------------------------------------------
//
// ★ 왜 이 일이 브라우저가 아니라 여기 있는가 ★
//
// 예전에는 화면이 "저장 성공 -> 옛 경로를 remove()" 하는 최선노력 정리를 했고,
// 그게 실패하는 순간 **그 파일은 영원히 남았습니다**. 실패한 시점에는 옛 경로가
// 이미 profiles 에서 사라진 뒤라, 다시는 어떤 코드도 그 경로를 알 수 없습니다.
// avatars 는 공개 버킷이라 남은 파일의 URL 은 계속 유효합니다. 새던 길 세 가지:
//
//   1) 업로드는 됐는데 set_avatar 응답 전에 탭이 닫힘 -> 롤백이 안 돌아감
//   2) 옛 파일 remove() 가 실패 -> 로그만 남고 영구 고아
//   3) 탭 두 개 경쟁 -> 각 탭의 "이전 경로" 는 자기 load() 시점의 스냅샷이라,
//      먼저 저장한 탭이 올린 파일을 아무도 지우지 않음
//
// 그래서 "옛 것 하나를 지운다" 가 아니라 **"남겨야 할 것만 남긴다"** 로 바꿉니다.
// 이러면 위 세 경우로 이미 생긴 고아도 다음 사진 변경 때 스스로 회수됩니다.
//
// 다만 "남길 것 외 전부 삭제" 를 그대로 하면 새로운 사고가 하나 생깁니다:
// 다른 탭이 방금 업로드했지만 아직 set_avatar 를 못 부른 파일까지 지워 버리고,
// 그 탭의 RPC 가 뒤늦게 성공하면 **DB 는 없는 파일을 가리키게 됩니다.**
// 그래서 갓 만들어진 파일(SWEEP_GRACE_MS)은 건드리지 않습니다. 그 파일이 끝내
// 고아였다면 유예가 지난 뒤 다음 스윕이 데려갑니다. 회수가 늦어질 뿐, 영구히
// 남지는 않습니다 -- 지금 고치려는 문제가 바로 "영구히" 쪽입니다.
//
// 사용자 세션으로 충분합니다: 0007 ⑤ 의 avatars_select_own_folder /
// avatars_delete_own_folder 가 본인 폴더의 list 와 remove 를 허용합니다.

/** 0007 ⑤ 가 만드는 공개 버킷. 파일은 전부 <uid>/ 아래 깊이 1 입니다. */
const AVATAR_BUCKET = 'avatars'

/** list 한 페이지 크기. 정상 계정은 1~2개지만 페이징은 합니다. */
const SWEEP_PAGE = 100

/** 종료 보장. 남길 파일이 늘지 않는 한 보통 1라운드로 끝납니다. */
const SWEEP_MAX_ROUNDS = 20

/**
 * 이 시간 안에 만들어진 파일은 "다른 탭이 지금 올리는 중" 일 수 있으므로
 * 건드리지 않습니다. 업로드 -> set_avatar 는 정상적으로 몇 초 안에 끝납니다.
 */
const SWEEP_GRACE_MS = 2 * 60 * 1000

/**
 * 저장된 avatar_url 이 **우리 버킷의 객체 경로**인가.
 *
 * 허용되는 값은 두 가지뿐이고(0007), 그중 절대 URL(구글 lh3 사진)은 우리 파일이
 * 아니라 지울 대상도, 남길 대상도 아닙니다.
 */
function isStorageObjectPath(value: string | null | undefined): value is string {
  const path = typeof value === 'string' ? value.trim() : ''
  return path.length > 0 && !/^https?:\/\//i.test(path)
}

/**
 * 새 값을 쓰기 **전에** 읽어 두는 현재 avatar_url.
 *
 * 순서가 핵심입니다. set_avatar 가 성공한 뒤에 읽으면 옛 경로는 이미 사라진
 * 뒤이고, 그게 예전 구현이 파일을 잃어버린 이유였습니다.
 *
 * 실패는 치명적이지 않습니다 — 못 읽었어도 스윕의 유예 규칙이 다음 번에
 * 회수합니다. 그래서 사진 저장 자체를 막지 않고 null 을 돌려줍니다.
 *
 * ★ 캐스트인 이유 ★ app/me/page.tsx 와 같습니다: lib/supabase/types.ts 의
 * ProfilesRow 에 avatar_url 이 아직 없어서, 타입이 붙은 채로 select 하면
 * **DB 에는 있는 컬럼 때문에 빌드가 깨집니다.** select('*') 는 금지입니다
 * (profiles 는 컬럼 단위 SELECT 권한 -> 42501).
 */
type AvatarUrlQuery = {
  select: (columns: string) => {
    eq: (column: string, value: string) => {
      maybeSingle: () => PromiseLike<{
        data: { avatar_url?: string | null } | null
        error: { code?: string | null; message?: string } | null
      }>
    }
  }
}

async function readStoredAvatarUrl(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const query = supabase.from('profiles') as unknown as AvatarUrlQuery

  const { data, error } = await query.select('avatar_url').eq('id', userId).maybeSingle()

  if (error) {
    // 42703 = 0007 미배포. 그 경우 set_avatar 도 없어서 어차피 아래로 가지 않습니다.
    console.error('[me] avatar_url 사전 조회 실패 -- 옛 파일은 유예 후 스윕이 회수합니다', {
      code: error.code,
      message: error.message,
    })
    return null
  }

  const stored = data?.avatar_url
  return typeof stored === 'string' && stored.trim().length > 0 ? stored.trim() : null
}

/** 유예 시간이 지난(= 지워도 안전한) 파일인가. 시각을 못 읽으면 지웁니다. */
function olderThanGrace(createdAt: string | null | undefined, now: number): boolean {
  if (typeof createdAt !== 'string' || createdAt.length === 0) return true
  const at = Date.parse(createdAt)
  if (Number.isNaN(at)) return true
  return now - at > SWEEP_GRACE_MS
}

/**
 * avatars/<uid>/ 에서 keepPath 하나만 남기고 회수합니다.
 *
 * 지우는 대상:
 *   - previousPath: 방금 우리가 밀어낸 경로. 갓 올린 파일이어도 즉시 지웁니다
 *     (우리가 대체한 것이 확실하므로 유예가 필요 없습니다).
 *   - 유예가 지난 나머지 전부: 예전 실패로 남은 고아들.
 * 남기는 대상:
 *   - keepPath (지금 profiles 가 가리키는 파일)
 *   - 유예 안에 든 파일 (다른 탭이 올리는 중일 수 있음)
 *
 * 실패해도 **던지지 않습니다**. 사진 변경은 이미 성공했고, 정리가 안 됐다고
 * 사용자에게 실패라고 말하면 거짓말입니다. 대신 **지우지 못한 경로를 서버 로그에
 * 남깁니다** — 나중에 사람이나 배치가 회수할 수 있는 유일한 단서입니다.
 */
async function sweepAvatarFolder(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  keepPath: string | null,
  previousPath: string | null,
): Promise<void> {
  const storage = supabase.storage.from(AVATAR_BUCKET)
  const keep = isStorageObjectPath(keepPath) ? keepPath.trim() : null
  const previous = isStorageObjectPath(previousPath) ? previousPath.trim() : null
  const now = Date.now()

  // 지우면서 읽으므로 offset 은 "이번에 남기기로 한 파일 수" 만큼만 전진합니다.
  // list 는 이름 오름차순이라, 남긴 파일들은 아직 안 읽은 파일들보다 항상
  // 앞에 옵니다. offset 을 안 올리면 남긴 파일이 페이지 머리를 막아 그 뒤를
  // 영영 못 봅니다.
  let offset = 0

  for (let round = 0; round < SWEEP_MAX_ROUNDS; round += 1) {
    const { data, error } = await storage.list(userId, { limit: SWEEP_PAGE, offset })

    if (error) {
      console.error('[me] 아바타 스윕 list 실패 -- 고아 파일이 남았을 수 있습니다', {
        folder: `${AVATAR_BUCKET}/${userId}`,
        offset,
        message: error.message,
      })
      return
    }

    const batch = data ?? []
    const doomed: string[] = []
    let kept = 0

    for (const entry of batch) {
      // 빈 이름을 remove 에 넘기면 폴더 전체를 가리키는 경로가 되어 의미가
      // 완전히 달라집니다. 정책이 깊이 1 을 강제하므로 나머지는 전부 파일입니다.
      const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
      if (!name) {
        kept += 1
        continue
      }

      const path = `${userId}/${name}`

      if (path === keep) {
        kept += 1
        continue
      }

      if (path === previous || olderThanGrace(entry?.created_at, now)) {
        doomed.push(path)
        continue
      }

      // 갓 올라온 남의 탭 파일일 수 있습니다. 이번엔 두고, 다음 스윕에서.
      kept += 1
    }

    if (doomed.length > 0) {
      const { error: removeError } = await storage.remove(doomed)
      if (removeError) {
        // ★ 경로를 반드시 남깁니다 ★ 이 로그가 없으면 공개 버킷에 남은 파일을
        // 되찾을 방법이 사라집니다.
        console.error('[me] 아바타 스윕 remove 실패 -- 아래 경로가 버킷에 남아 있습니다', {
          paths: doomed,
          message: removeError.message,
        })
        return
      }
    }

    // 이번 페이지가 덜 찼다면 폴더 끝을 본 것입니다.
    if (batch.length < SWEEP_PAGE) return

    offset += kept

    // 한 개도 못 지웠고 페이지도 가득 찼다면, 다음 라운드는 offset 이 전진한
    // 덕분에 새 구간을 봅니다. 전진이 0 이면(= 전부 지웠으면) 같은 자리에서
    // 다음 묶음을 읽습니다. 어느 쪽이든 SWEEP_MAX_ROUNDS 에서 멈춥니다.
  }

  console.error('[me] 아바타 스윕이 상한에서 멈췄습니다 -- 고아 파일이 남아 있을 수 있습니다', {
    folder: `${AVATAR_BUCKET}/${userId}`,
    rounds: SWEEP_MAX_ROUNDS,
  })
}

/**
 * profiles.avatar_url 설정. `public.set_avatar()` RPC 하나만 부릅니다.
 *
 * ★ 여기서 URL 형태를 다시 판정하지 않습니다 ★ 판정의 단일 진실은
 * `private.avatar_url_is_allowed()` (0007 ②) 이고, set_avatar 가 그것을
 * 호출합니다. TypeScript 에 정규식을 한 벌 더 두면 반드시 어긋나고, 어긋나는
 * 순간 둘 중 느슨한 쪽이 아니라 **엄격한 쪽이 화면을 막습니다**.
 *
 * 허용되는 값은 두 가지뿐입니다(0007 의 CHECK / 판정 함수):
 *   (a) "<본인 uuid>/<파일명>.(jpg|jpeg|png|webp)"  -- 버킷 이름 없는 객체 경로
 *   (b) "https://lh3.googleusercontent.com/..."      -- 구글 프로필 사진
 * null 또는 빈 문자열이면 해제이고, 화면은 구글 사진 -> 이모지 순으로 폴백합니다.
 *
 * profiles 의 UPDATE 컬럼 GRANT 에 avatar_url 이 **없습니다**(0007 ①-b). 즉
 * `.from('profiles').update({ avatar_url })` 은 42501 입니다. 이 RPC 가 유일한
 * 쓰기 경로인 것은 사고가 아니라 설계입니다.
 *
 * 옛 파일 정리도 여기서 합니다. 순서가 곧 안전장치입니다:
 *   ① 옛 경로 읽기 -> ② set_avatar -> ③ 성공한 뒤에만 스윕
 * ①을 ②보다 뒤로 옮기면 옛 경로를 영영 잃어버립니다. 자세한 이유는 위의
 * "옛 아바타 파일 회수" 절 주석에 있습니다.
 */
export async function setAvatar(avatarUrl: string | null): Promise<MeActionResult> {
  const supabase = await createClient()
  const userId = await sessionUserId(supabase)
  if (!userId) return fail('로그인이 풀렸어요. 앱을 새로고침한 뒤 다시 시도해 주세요.')

  const value = typeof avatarUrl === 'string' ? avatarUrl.trim() : ''

  // ① 새 값을 쓰기 **전에** 옛 경로를 읽습니다. 쓰고 나면 늦습니다.
  const previousPath = await readStoredAvatarUrl(supabase, userId)

  // ★ 캐스트인 이유 ★ lib/supabase/types.ts 는 이 기능이 소유한 파일이 아니라,
  // `set_avatar` 가 아직 Database['public']['Functions'] 에 없을 수 있습니다.
  // 타입이 붙은 채로 부르면 **DB 에는 존재하는 함수 때문에 빌드가 깨집니다.**
  // 캐스트는 일부러 좁습니다 — 함수 이름 하나, 인자 하나, 그리고 `returns void`
  // 라서 읽을 행이 없으므로 error 만 봅니다. types.ts 에 항목이 생기면 이 두 줄을
  // 지우고 `supabase.rpc('set_avatar', …)` 를 그대로 부르면 됩니다.
  // (app/status/default-group-actions.ts 가 set_default_group 에 쓴 것과 같은 처방)
  const rpc = supabase.rpc.bind(supabase) as unknown as SetAvatarRpc

  const { error } = await rpc('set_avatar', {
    // 빈 문자열도 set_avatar 안에서 nullif(btrim(...), '') 로 NULL 이 되지만,
    // 의도를 값에서 읽을 수 있게 여기서 null 로 만들어 보냅니다.
    p_avatar_url: value.length > 0 ? value : null,
  })

  if (error) {
    switch (error.code) {
      case '42501':
        return fail('로그인이 풀렸어요. 앱을 새로고침한 뒤 다시 시도해 주세요.')
      case '22023':
        // set_avatar 가 형태를 거부했습니다. 정상 경로에서는 도달하지 않습니다
        // (업로드 경로는 우리가 만들고, 구글 사진은 lh3 호스트입니다).
        return fail('이 사진 주소는 쓸 수 없어요. 직접 올린 사진이나 구글 프로필 사진만 사용할 수 있어요.')
      case 'P0002':
        return fail('프로필을 찾지 못했어요. 다시 로그인해 주세요.')
      case 'PGRST202':
        // set_avatar 가 PostgREST 스키마 캐시에 없습니다 = 마이그레이션 미적용.
        return fail('사진 기능이 아직 준비되지 않았어요. 잠시 후 다시 시도해 주세요.')
      default:
        console.error('[me] set_avatar rpc failed', { code: error.code, message: error.message })
        return fail('사진을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.')
    }
  }

  // ③ 저장이 확정된 뒤에만 회수합니다. 순서가 반대면 저장이 실패했을 때 이미
  // 쓰이고 있는 파일을 지운 꼴이 됩니다.
  //
  // 스윕은 사용자에게 보이는 결과를 바꾸지 않습니다. 그래서 여기서 실패해도
  // 사진 변경은 성공이고, 예상 못 한 예외까지 감싸 둡니다 — Storage 쪽 사고
  // 하나가 "사진이 안 바뀌었다" 로 둔갑하면 안 됩니다.
  try {
    await sweepAvatarFolder(supabase, userId, value.length > 0 ? value : null, previousPath)
  } catch (cause) {
    console.error('[me] 아바타 스윕이 예외로 중단됐습니다', {
      folder: `${AVATAR_BUCKET}/${userId}`,
      previous: previousPath,
      cause,
    })
  }

  revalidateProfile()
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 로그아웃
// ---------------------------------------------------------------------------

/**
 * 로그아웃 후 /login 으로.
 *
 * 브라우저에서 `supabase.auth.signOut()` 만 부르면 document.cookie 는 지워지지만
 * 이미 렌더된 서버 컴포넌트의 라우터 캐시가 남아, 뒤로가기 한 번에 로그인된
 * 화면이 되살아납니다. 서버에서 지우고 redirect 하면 그 캐시까지 함께 버려집니다.
 *
 * `redirect()` 는 NEXT_REDIRECT 제어 흐름 예외를 던지므로 절대 try 안에 두지
 * 않습니다. 그래서 signOut 의 실패도 삼키지 않고 그냥 무시합니다 — 어차피
 * 세션이 이미 없다는 뜻이고, 사용자가 가야 할 곳은 똑같이 /login 입니다.
 */
export async function signOutAction(): Promise<never> {
  const supabase = await createClient()

  // scope 기본값(global)은 Auth 서버로 나가 모든 기기의 세션을 폐기합니다.
  // 여기서 원하는 것은 이 브라우저의 로그아웃뿐이라 'local' 입니다. 다른 기기의
  // 로그인을 말없이 끊는 것은 사용자가 요청한 적 없는 동작입니다.
  const { error } = await supabase.auth.signOut({ scope: 'local' })
  if (error) {
    console.error('[me] signOut failed', error.message)
  }

  // 로그인 화면과 그 아래 모든 서버 렌더를 새로 그리게 합니다.
  revalidatePath('/', 'layout')
  redirect('/login')
}
