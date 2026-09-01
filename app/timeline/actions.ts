'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { POST_BODY_MAX, POST_PHOTO_PATH_RE } from '@/lib/posts'
import { createClient } from '@/lib/supabase/server'

/**
 * 타임라인의 쓰기 경로 — 게시물 만들기 / 지우기.
 *
 * ---------------------------------------------------------------------------
 * 사진 파일은 이 파일을 지나가지 않습니다
 * ---------------------------------------------------------------------------
 * 브라우저가 Supabase Storage 로 **직접** 올리고, 결과 경로 문자열만
 * createPost() 로 넘어옵니다. app/me/actions.ts 가 아바타에 대해 내린 것과
 * 같은 판단입니다: 파일을 Server Action 으로 흘리면 Vercel 함수의 요청 본문
 * 한도를 건드리고, 이미 버킷이 1 MiB / MIME 을 강제하는데 그 앞에 더 약한
 * 관문을 하나 더 세우는 셈입니다.
 *
 * ---------------------------------------------------------------------------
 * ★ 고아 파일 ★ — 실패했을 때 누가 치우는가
 * ---------------------------------------------------------------------------
 * 업로드는 성공했는데 여기서 INSERT 가 실패하면, 그 파일은 어떤 게시물도
 * 가리키지 않는 고아가 됩니다. 0010 ⑧ 의 정리 큐 트리거는 **posts 행이 사라질
 * 때만** 돌기 때문에 이 고아는 큐에 들어가지도 않습니다.
 *
 * 그래서 치우는 쪽은 호출자입니다. app/timeline/composer.tsx 가 이 함수가
 * `ok: false` 를 돌려주는 즉시 방금 올린 파일을 remove() 합니다(0010 ⑥ 의
 * posts_delete_own_folder 정책이 그 문입니다). 여기서 지우지 않는 이유는
 * 서버에는 사용자 토큰으로 Storage 를 부를 클라이언트가 없고, service_role 로
 * 지우면 "실패했는데 남의 파일을 지울 수도 있는" 경로가 하나 더 생기기
 * 때문입니다. 지워야 할 경로를 아는 것은 방금 올린 브라우저입니다.
 *
 * ---------------------------------------------------------------------------
 * 두 함수의 모양이 다른 이유
 * ---------------------------------------------------------------------------
 * createPost 는 값을 돌려줍니다 — 호출자가 Client Component 라서 반환값을
 * 그대로 읽을 수 있고, 여러 단계(업로드 → INSERT) 중 어디서 실패했는지
 * 화면 안에서 말해 줘야 하기 때문입니다.
 * deletePost 는 순수 <form action> 입니다 — 값을 받을 자리가 없어서
 * `?perr=` 를 달고 redirect 합니다(app/groups/manage-actions.ts 와 같은 처방).
 *
 * 'use server' 파일은 async 함수 외의 export 를 허용하지 않습니다. 아래
 * `type` 은 컴파일 시점에 지워지므로 예외입니다.
 */

// ---------------------------------------------------------------------------
// 결과 타입
// ---------------------------------------------------------------------------

export type PostActionResult =
  | { ok: true }
  | { ok: false; message: string }

/** deletePost 가 `?perr=` 로 실어 보내는 코드. 문구는 app/page.tsx 에 있습니다. */
export type PostErrCode = 'auth' | 'badrequest' | 'notfound' | 'notdeployed' | 'fail'

// ---------------------------------------------------------------------------
// 검증
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Postgres `char_length()` 는 코드 포인트를 셉니다. JS 의 `.length` 는 UTF-16
 * 코드 유닛이라 '😀'.length 는 2 지만 DB 에서는 1 입니다. 이 차이를 무시하면
 * 이모지가 섞인 글이 여기서는 통과하고 DB 에서 23514 로 터집니다.
 * (app/me/actions.ts 의 charLength 와 같은 규칙입니다.)
 */
function charLength(value: string): number {
  return Array.from(value).length
}

/**
 * posts 테이블의 최소 모양. 캐스트가 필요한 이유는 lib/posts.ts 의 PostsReader
 * 주석 참고 — 특히 캐스트가 `.from()` 의 결과가 아니라 **클라이언트** 에
 * 걸리는 이유(인자 'posts' 부터 TS2769 로 거부됩니다).
 */
type PostsClient = { from: (table: string) => PostsWriter }

type PostsWriter = {
  insert: (values: {
    user_id: string
    group_id: string
    body: string | null
    photo_path: string | null
  }) => {
    select: (columns: string) => PromiseLike<{
      data: { id: string }[] | null
      error: { code?: string | null; message?: string } | null
    }>
  }
  delete: () => {
    eq: (
      column: string,
      value: string,
    ) => {
      eq: (
        column: string,
        value: string,
      ) => {
        select: (columns: string) => PromiseLike<{
          data: { id: string }[] | null
          error: { code?: string | null; message?: string } | null
        }>
      }
    }
  }
}

/**
 * 검증된 세션의 사용자 id. getSession() 은 쿠키를 되돌려줄 뿐이라 인가 검사가
 * 아닙니다 — getClaims() 가 JWT 서명을 로컬에서 검증합니다.
 */
async function sessionUserId(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<string | null> {
  const { data, error } = await supabase.auth.getClaims()
  const userId = data?.claims.sub
  if (error || typeof userId !== 'string' || !userId) return null
  return userId
}

// ---------------------------------------------------------------------------
// 게시물 만들기
// ---------------------------------------------------------------------------

/**
 * 글 + 사진 한 장으로 게시물 하나.
 *
 * @param groupId   어느 그룹의 타임라인에 올릴지. RLS 의 WITH CHECK 가
 *                  `private.is_group_member(group_id)` 를 한 번 더 봅니다 —
 *                  내가 속하지 않은 그룹의 피드에는 꽂을 수 없습니다.
 * @param rawBody   본문. 빈 문자열이면 "사진만 올리는 게시물" 입니다.
 * @param photoPath 이미 Storage 에 올라간 경로 `<내 uuid>/<파일>.jpg`.
 *                  없으면 null("글만 올리는 게시물").
 *
 * ★ photoPath 의 첫 폴더가 내 uuid 인지 여기서도 봅니다 ★ DB 의
 * posts_photo_path_owner_chk 가 같은 것을 강제하므로 이 검사는 방어선이
 * 아니라 "23514 라는 숫자 대신 한국어 문장을 돌려주기 위한" 것입니다.
 */
export async function createPost(
  groupId: string,
  rawBody: string,
  photoPath: string | null,
): Promise<PostActionResult> {
  const supabase = await createClient()

  const userId = await sessionUserId(supabase)
  if (!userId) {
    return { ok: false, message: '로그인이 풀렸어요. 앱을 새로고침한 뒤 다시 시도해 주세요.' }
  }

  if (typeof groupId !== 'string' || !UUID_RE.test(groupId)) {
    return { ok: false, message: '어느 그룹에 올릴지 알 수 없어요. 화면을 새로고침해 주세요.' }
  }

  const body = typeof rawBody === 'string' ? rawBody.trim() : ''
  if (charLength(body) > POST_BODY_MAX) {
    return { ok: false, message: `내용은 ${POST_BODY_MAX}자까지 쓸 수 있어요.` }
  }

  const path = typeof photoPath === 'string' && photoPath.length > 0 ? photoPath : null
  if (path !== null) {
    if (!POST_PHOTO_PATH_RE.test(path) || !path.startsWith(`${userId}/`)) {
      return { ok: false, message: '사진 경로가 올바르지 않아요. 사진을 다시 골라 주세요.' }
    }
  }

  // posts_not_empty_chk 와 같은 규칙. 빈 카드 한 장은 피드에 아무 의미도 없습니다.
  if (body.length === 0 && path === null) {
    return { ok: false, message: '내용이나 사진 중 하나는 있어야 해요.' }
  }

  const posts = (supabase as unknown as PostsClient).from('posts')

  // ★ .select('id') 로 실제 행을 받습니다 ★ 조용한 성공 금지. INSERT 가 정책에
  // 걸려도 postgrest 는 오류를 주지만, 0행이 돌아오는 경우까지 성공으로 보고하면
  // "올렸는데 안 보인다" 가 됩니다.
  const { data, error } = await posts
    .insert({ user_id: userId, group_id: groupId, body: body || null, photo_path: path })
    .select('id')

  if (error) {
    console.error('[timeline] 게시물 저장 실패', { code: error.code, message: error.message })
    return { ok: false, message: insertMessage(error.code) }
  }

  if (!data || data.length === 0) {
    return {
      ok: false,
      message: '올리지 못했어요. 이 그룹의 멤버가 맞는지 확인한 뒤 다시 시도해 주세요.',
    }
  }

  // 홈이 서버 컴포넌트로 피드를 그리므로, 여기서 비워 주지 않으면 방금 올린 글이
  // 한 번 더 새로고침해야 보입니다. 'layout' 스코프인 이유는 app/me/actions.ts 와
  // 같습니다 — 하단 탭과 헤더가 루트 레이아웃 아래에 있습니다.
  revalidatePath('/', 'layout')

  return { ok: true }
}

/** 저장 실패 코드를 한국어로. lib/db-error.ts 보다 이 화면에 맞는 문장입니다. */
function insertMessage(code: string | null | undefined): string {
  switch (code) {
    case '42501':
      return '올릴 권한이 없어요. 이 그룹의 멤버가 맞는지 확인해 주세요.'
    case '23514':
      return '내용이나 사진이 형식에 맞지 않아요. 다시 확인해 주세요.'
    case '23503':
      return '그룹을 찾을 수 없어요. 화면을 새로고침해 주세요.'
    case 'PGRST205':
    case '42P01':
      return '타임라인 기능이 아직 서버에 적용되지 않았어요. 잠시 후 다시 시도해 주세요.'
    default:
      return '올리지 못했어요. 잠시 후 다시 시도해 주세요.'
  }
}

// ---------------------------------------------------------------------------
// 게시물 지우기 — 본인만
// ---------------------------------------------------------------------------

/**
 * 게시물 하나 삭제. `<form action={deletePost}>` 로 부릅니다.
 *
 * 삭제되면 0010 ⑧ 의 트리거가 사진 경로를 private.post_photo_orphans 에
 * 넣습니다 — 실제 Storage 파일 삭제는 그 큐를 비우는 쪽의 몫이고, 그건
 * service_role 전용 RPC 라 이 화면의 책임이 아닙니다. 여기서 파일까지 지우려
 * 들면 큐와 이중으로 지우게 되고, 실패했을 때 무엇이 남았는지 알 수 없어집니다.
 *
 * `.eq('user_id', ...)` 를 거는 이유: RLS 의 posts_delete_own 이 이미 같은
 * 조건을 강제하지만, 그것만 믿으면 "남의 글 id 를 보냈을 때" 와 "이미 지워진
 * 글" 이 똑같이 0행으로 뭉개집니다. 조건을 명시하면 의도가 코드에 남습니다.
 * ★ 0행이면 실패로 보고합니다 ★ 조용한 성공 금지.
 */
export async function deletePost(formData: FormData): Promise<void> {
  const rawId = formData.get('postId')
  const rawGroup = formData.get('g')

  const groupId = typeof rawGroup === 'string' && UUID_RE.test(rawGroup) ? rawGroup : null

  const supabase = await createClient()
  const userId = await sessionUserId(supabase)

  let code: PostErrCode | null = null

  if (!userId) {
    code = 'auth'
  } else if (typeof rawId !== 'string' || !UUID_RE.test(rawId)) {
    code = 'badrequest'
  } else {
    const posts = (supabase as unknown as PostsClient).from('posts')
    const { data, error } = await posts
      .delete()
      .eq('id', rawId)
      .eq('user_id', userId)
      .select('id')

    if (error) {
      console.error('[timeline] 게시물 삭제 실패', { code: error.code, message: error.message })
      code = error.code === 'PGRST205' || error.code === '42P01' ? 'notdeployed' : 'fail'
    } else if (!data || data.length === 0) {
      // 남의 글이거나, 이미 지워졌거나. 어느 쪽이든 "지워졌다" 고 말하면 거짓말입니다.
      code = 'notfound'
    } else {
      revalidatePath('/', 'layout')
    }
  }

  // ★ redirect 는 try/catch 밖에서 ★ NEXT_REDIRECT 를 던지는 방식이라
  // try 안에 있으면 catch 가 그걸 삼킵니다.
  redirect(timelineHref(groupId, code))
}

/** 삭제 후 돌아갈 곳. 타임라인 탭과 그룹 선택을 유지합니다. */
function timelineHref(groupId: string | null, err: PostErrCode | null): string {
  const params = new URLSearchParams()
  if (groupId) params.set('g', groupId)
  params.set('tab', 'feed')
  if (err) params.set('perr', err)
  else params.set('pdel', '1')
  return `/?${params.toString()}`
}
