/**
 * lib/posts.ts — 타임라인("오늘 한 일") 조회 계층. ★ 서버 전용 ★
 *
 * createClient() 가 next/headers 의 cookies() 를 쓰고, createAdminClient() 는
 * 'server-only' 를 선언한 모듈입니다. 그래서 이 파일은 **클라이언트 컴포넌트가
 * 절대 import 할 수 없습니다** — 상수 하나를 가져가려 해도 빌드가 깨집니다.
 * app/timeline/composer.tsx 가 업로드 계약(1 MiB · 1280px · q0.8)의 사본을
 * 자기 파일에 들고 있는 이유가 그것입니다(app/me/avatar-storage.ts 와 같은
 * 처방). 두 곳의 숫자는 반드시 같아야 하고, 출처는 양쪽 다 0010 ⑤ 입니다.
 *
 * lib/tasks.ts 의 설계 규칙 5개를 그대로 따릅니다: select('*') 금지 ·
 * "오늘"을 JS 가 만들지 않기 · N+1 금지 · 예외 대신 값 · 왕복 세기.
 *
 * ---------------------------------------------------------------------------
 * ★★ 이 파일에서 가장 중요한 것: 사진은 왜 두 단계로 오는가 ★★
 * ---------------------------------------------------------------------------
 * 0010 ⑤ 가 Storage 버킷 'posts' 를 **비공개** 로 만들었습니다. 그래서
 * posts.photo_path 는 URL 이 아니라 그냥 경로이고, <img> 에 넣을 수 있는
 * 주소는 서버가 service_role 로 발급하는 **서명 URL** 뿐입니다.
 *
 * 0010 ⑤ 의 「앱 구현 규칙」을 글자 그대로 옮기면:
 *
 *   ① 먼저 **사용자 토큰** 으로 posts 를 조회합니다.
 *      → RLS(posts_select_group_members)가 "내 글 또는 내가 속한 그룹의 글"
 *        만 남깁니다. 그룹 단위로 정확합니다.
 *   ② 그렇게 나온 photo_path 배열 **만** admin 클라이언트의
 *      createSignedUrls() 에 넘깁니다.
 *   ③ ★ 클라이언트가 보낸 임의의 경로를 절대 그대로 서명하지 마세요 ★
 *      그러면 service_role 이 "아무 경로나 서명해 주는 오라클" 이 됩니다.
 *
 * 그래서 이 파일에는 "경로를 받아 서명해 주는" 공개 함수가 **없습니다**.
 * signPhotoUrls() 는 모듈 내부 함수이고, 유일한 호출자는 바로 위에서 ①을
 * 끝낸 getTimeline() 입니다. 그 순서가 곧 보안 경계입니다 — 서명되는 사진의
 * 집합과 "내가 볼 수 있는 게시물" 의 집합이 정의상 같아집니다.
 *
 * 그 위에 한 겹 더: 서명 직전에 POST_PHOTO_PATH_RE 로 경로 모양을 다시 봅니다.
 * DB 의 posts_photo_path_shape_chk 가 이미 같은 것을 강제하므로 이 검사는
 * 평소에 아무것도 걸러 내지 않습니다. 그게 목적입니다 — 언젠가 누가 이 함수를
 * 다른 곳에서 부르더라도, 최소한 '..' 이나 남의 형태의 경로는 통과하지 않습니다.
 *
 * ---------------------------------------------------------------------------
 * 왕복 (타임라인 탭을 열었을 때만 냅니다 — app/page.tsx 의 tab 분기 참고)
 * ---------------------------------------------------------------------------
 *   파 1: posts 조회 (1회)
 *   파 2: profiles 조회 + 서명 URL 발급 (2회, Promise.all 로 나란히)
 * 게시물 수에 비례해 늘지 않습니다. 30개든 1개든 3회입니다.
 */

import type { PostgrestError } from '@supabase/supabase-js'

import { resolveAvatar, type ResolvedAvatar } from '@/lib/avatar'
import { toKoreanDbError } from '@/lib/db-error'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import type { ProfilesReader } from '@/lib/tasks-model'
import { fetchMemberProfiles } from '@/lib/tasks-queries'

/* ==========================================================================
 * 상수 — 전부 supabase/migrations/0010_posts.sql 이 출처입니다
 * ======================================================================== */

/** 0010 ⑤ 의 버킷. **비공개**. 1 MiB. jpeg·png·webp. */
export const POSTS_BUCKET = 'posts'

/**
 * 한 번에 보여 주는 게시물 수의 상한.
 *
 * 0010 ①-b 의 인덱스가 계약한 접근 경로가
 * `where group_id = $1 order by created_at desc limit N` 입니다.
 * 30 인 이유: 친구 3~6명이 하루 한두 개를 올리면 **약 일주일치** 입니다.
 * 더 늘리면 서명 URL 도 그만큼 발급해야 하고(발급은 공짜가 아닙니다),
 * 모바일에서 사진 30장은 이미 충분히 긴 스크롤입니다.
 * ★ 이 숫자는 화면에도 반드시 적습니다 ★ 상한을 말하지 않으면 오래된 글이
 * "사라진" 것처럼 보입니다.
 */
export const TIMELINE_LIMIT = 30

/** posts_body_len_chk: char_length(btrim(body)) between 1 and 2000. */
export const POST_BODY_MAX = 2000

/** 0010 ⑤ 의 file_size_limit 과 **같은 값**. 느슨하게 바꾸지 마세요. */
export const POST_PHOTO_MAX_BYTES = 1024 * 1024

/**
 * 0010 ⑤ 가 앱에 지시한 다운스케일 값입니다("장변 1280px, q0.8").
 * 1 MiB 버킷에서 폰 원본(4~8MB)은 그 자리에서 실패하므로 선택이 아닙니다.
 */
export const POST_PHOTO_MAX_EDGE = 1280
export const POST_PHOTO_QUALITY = 0.8

/**
 * 서명 URL 유효 시간(초). 0010 ⑤ 의 예시와 같은 1시간.
 *
 * 짧게 두는 것이 이 기능의 핵심입니다 — 공개 버킷 URL 과 달리 **만료됩니다**.
 * 그룹을 나간 사람이 들고 있던 주소가 영원히 살아 있지 않습니다.
 */
export const SIGNED_URL_TTL_SECONDS = 3600

/**
 * posts_photo_path_shape_chk 의 정규식을 **글자 그대로** 옮긴 것입니다.
 * `<uuid>/<파일명>.(jpg|jpeg|png|webp)`, 깊이 정확히 1.
 * 한쪽만 고치면 "업로드는 되는데 게시물이 안 만들어지는" 상태가 됩니다.
 */
export const POST_PHOTO_PATH_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(jpg|jpeg|png|webp)$/

/** ★ select('*') 금지 ★ 습관대로 컬럼을 나열합니다(lib/tasks.ts 규칙 2). */
const POST_COLUMNS = 'id, user_id, body, photo_path, created_at'

/* ==========================================================================
 * 타입
 * ======================================================================== */

/** posts 한 행 중 이 화면이 읽는 부분. */
type PostRow = {
  id: string
  user_id: string
  body: string | null
  photo_path: string | null
  created_at: string
}

type DbErrorLike = { code?: string | null; message?: string }

/**
 * `supabase.from('posts')` 의 최소 모양.
 *
 * ★ 캐스트가 필요한 이유 ★ lib/supabase/types.ts 는 이 기능이 소유한 파일이
 * 아니고, 이 글을 쓰는 시점의 Database 타입에는 posts 가 없습니다. 타입이
 * 붙은 채로 `.from('posts')` 를 쓰면 DB 에는 실재하는 테이블 때문에 tsc 가
 * 깨집니다. types.ts 에 posts 가 생기면 이 타입과 캐스트를 지우세요.
 * (app/page.tsx 의 getDefaultGroupId, lib/tasks-model.ts 의 ProfilesReader 가
 *  같은 처방입니다.)
 *
 * ★ 캐스트가 `.from()` 의 **결과** 가 아니라 클라이언트에 걸리는 이유 ★
 * `.from()` 의 파라미터 타입이 Database 의 테이블 이름 유니온이라, posts 가
 * 없으면 인자 'posts' 부터 거부됩니다(TS2769: not assignable to 'never').
 * 결과만 캐스트하면 그 오류는 그대로 남습니다.
 */
type PostsClient = { from: (table: string) => PostsReader }

type PostsReader = {
  select: (columns: string) => {
    eq: (
      column: string,
      value: string,
    ) => {
      order: (
        column: string,
        options: { ascending: boolean },
      ) => {
        limit: (count: number) => PromiseLike<{
          data: PostRow[] | null
          error: DbErrorLike | null
        }>
      }
    }
  }
}

/** 피드 한 장. 화면은 이 값만 보면 됩니다. */
export type TimelinePost = {
  id: string
  /** 삭제 버튼을 그릴지 정할 때만 씁니다. 화면에 노출하지 않습니다. */
  authorId: string
  /** 내가 쓴 글인가. 삭제는 본인만(0010 ③ posts_delete_own). */
  isMine: boolean
  displayName: string
  /**
   * ★ 남의 행에 userMetadata 를 넘기지 않습니다 ★
   * 아래 timelineAvatar() 주석 참고. 구글 로그인 사진은 **내 JWT** 에서만
   * 읽히므로, 넘기면 내 얼굴이 친구 자리에 붙습니다.
   */
  avatar: ResolvedAvatar
  /** ISO 8601 (timestamptz). 화면이 보는 사람의 시간대로 포맷합니다. */
  createdAt: string
  body: string | null
  /** 서명 URL. 만료되는 주소입니다. 없으면 null. */
  photoUrl: string | null
  /**
   * 사진이 붙은 게시물인데 서명 URL 을 못 만든 경우 true.
   *
   * ★ 조용히 사진만 빼면 안 됩니다 ★ 그러면 글쓴이는 "사진이 안 올라갔다"고
   * 생각하고 같은 글을 다시 올립니다. 화면이 "사진을 불러오지 못했어요" 라고
   * 말해야 새로고침이라는 올바른 다음 행동이 나옵니다.
   */
  photoFailed: boolean
}

export type TimelineData = {
  posts: TimelinePost[]
  /** 한국어 실패 문장. null 이면 성공입니다(빈 목록은 실패가 아닙니다). */
  error: string | null
  /** 화면에 그대로 적어 주세요. 상한을 숨기지 않습니다. */
  limit: number
  /** 상한만큼 꽉 찼는가 = 더 오래된 글이 있을 수 있다. */
  reachedLimit: boolean
}

function emptyTimeline(error: string | null): TimelineData {
  return { posts: [], error, limit: TIMELINE_LIMIT, reachedLimit: false }
}

/* ==========================================================================
 * 서명 URL (모듈 내부 — 공개 함수가 아닌 것이 핵심입니다)
 * ======================================================================== */

/**
 * photo_path 목록 → 서명 URL 맵.
 *
 * ★ 이 함수를 export 하지 마세요 ★ 파일 머리말의 ③ 그대로입니다. 유일한
 * 호출자는 이미 사용자 토큰으로 posts 를 조회한 getTimeline() 이고, 그래서
 * 넘어오는 경로는 정의상 "그 사람이 볼 수 있는 게시물의 사진" 뿐입니다.
 * 여기에 요청 파라미터나 폼 값에서 온 경로가 흘러 들어오는 순간, service_role
 * 이 서명 오라클이 됩니다.
 *
 * 던지지 않습니다. 서명이 통째로 실패해도 글은 보여야 합니다.
 */
async function signPhotoUrls(paths: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()

  // 한 겹 더. DB CHECK 이 이미 강제하므로 평소엔 아무것도 안 거릅니다.
  const safe = paths.filter((path) => POST_PHOTO_PATH_RE.test(path))
  if (safe.length === 0) return map

  try {
    const admin = createAdminClient()
    const { data, error } = await admin.storage
      .from(POSTS_BUCKET)
      .createSignedUrls(safe, SIGNED_URL_TTL_SECONDS)

    if (error) {
      console.error('[timeline] 서명 URL 발급 실패', error.message)
      return map
    }

    for (const entry of data ?? []) {
      // 항목별로 실패할 수 있습니다(파일이 실제로는 없는 경우 등).
      // path 는 우리가 넘긴 문자열 그대로 돌아옵니다.
      if (entry.error || !entry.path || !entry.signedUrl) continue
      map.set(entry.path, entry.signedUrl)
    }
  } catch (cause) {
    // createAdminClient() 는 환경변수가 없으면 던집니다. 그건 배포 설정
    // 문제이고, 그것 때문에 타임라인 전체가 죽으면 안 됩니다.
    console.error('[timeline] 서명 URL 발급 중 예외', cause)
  }

  return map
}

/* ==========================================================================
 * 조회
 * ======================================================================== */

/**
 * 남의 행의 아바타. **userMetadata 를 받는 자리가 없습니다.**
 *
 * lib/tasks-queries.ts 의 memberAvatar() 와 같은 이유이고 같은 모양입니다.
 * 구글 로그인 사진은 내 JWT 의 user_metadata 에서만 읽히므로, 남의 행을
 * 그리면서 그걸 넘기면 (1) 내 사진이 친구 얼굴 자리에 붙고 (2) 본인이 자유롭게
 * 쓰는 값이라 "임의 https URL" 을 그리게 만드는 구멍이 그룹 전체로 넓어집니다.
 * 내 행도 여기서는 똑같이 취급합니다 — 목록 안에서 나만 다른 규칙으로 그려지면
 * 그게 더 이상합니다. 내 구글 사진을 친구들에게도 보이려면 마이페이지에서
 * 저장하면 됩니다(그러면 profiles.avatar_url 로 들어옵니다).
 */
function timelineAvatar(profile: { avatar_emoji?: string | null; avatar_url?: string | null } | undefined): ResolvedAvatar {
  return resolveAvatar({
    avatarUrl: profile?.avatar_url ?? null,
    // ★ userMetadata 를 넘기지 마세요 ★ 자리 자체를 비워 둡니다.
    avatarEmoji: profile?.avatar_emoji ?? null,
  })
}

/**
 * 한 그룹의 최신 게시물 `TIMELINE_LIMIT` 개.
 *
 * 예외를 던지지 않습니다. 실패는 `error` 에 한국어 한 문장으로 옵니다
 * (lib/tasks.ts 규칙 4). 빈 목록과 실패는 서로 다른 상태이고, 화면은 그
 * 둘을 다르게 그려야 합니다.
 *
 * @param groupId  보여 줄 그룹. RLS 가 한 번 더 검사하므로 "내 그룹인가" 를
 *                 여기서 확인하지 않습니다 — 남의 그룹 id 를 넣으면 결과가
 *                 빈 목록입니다(0010 ③ posts_select_group_members).
 * @param viewerId 검증된 JWT 의 sub. 삭제 버튼을 그릴지 정하는 데만 씁니다.
 */
export async function getTimeline(groupId: string, viewerId: string): Promise<TimelineData> {
  const supabase = await createClient()

  // ── ① 사용자 토큰으로 조회 ────────────────────────────────────────────
  const posts = (supabase as unknown as PostsClient).from('posts')

  const { data, error } = await posts
    .select(POST_COLUMNS)
    .eq('group_id', groupId)
    .order('created_at', { ascending: false })
    .limit(TIMELINE_LIMIT)

  if (error) {
    // 0010 이 아직 이 환경에 적용되지 않았습니다(PostgREST 스키마 캐시에 없음).
    // 이건 "실패" 가 아니라 "아직 없는 기능" 이라 문장이 달라야 합니다.
    if (error.code === 'PGRST205' || error.code === '42P01') {
      return emptyTimeline('타임라인 기능이 아직 서버에 적용되지 않았어요. 잠시 후 다시 열어봐 주세요.')
    }
    console.error('[timeline] 게시물 조회 실패', { code: error.code, message: error.message })
    return emptyTimeline(
      toKoreanDbError(error as PostgrestError, '타임라인을 불러오지 못했어요.'),
    )
  }

  const rows = data ?? []
  if (rows.length === 0) {
    return { posts: [], error: null, limit: TIMELINE_LIMIT, reachedLimit: false }
  }

  // ── ② 작성자 프로필 + 서명 URL. 서로 독립이라 한 파에 나란히 보냅니다 ──
  const authorIds = [...new Set(rows.map((row) => row.user_id))]
  const photoPaths = [
    ...new Set(rows.map((row) => row.photo_path).filter((path): path is string => Boolean(path))),
  ]

  const [profileResult, signedMap] = await Promise.all([
    // 0007 미배포(42703) 폴백까지 이미 들어 있는 공용 배관입니다.
    fetchMemberProfiles(supabase as unknown as ProfilesReader, authorIds),
    // ★ rows 에서 나온 경로만 넘어갑니다 ★ 파일 머리말 ②③ 참고.
    signPhotoUrls(photoPaths),
  ])

  if (profileResult.error) {
    // 이름과 얼굴이 없어도 글은 보여 줍니다. 프로필 하나 때문에 타임라인 전체를
    // 오류 화면으로 바꾸지 않습니다(0007 미배포 폴백과 같은 판단).
    console.error('[timeline] 작성자 프로필 조회 실패', {
      code: profileResult.error.code,
      message: profileResult.error.message,
    })
  }

  const byId = new Map(profileResult.data.map((profile) => [profile.id, profile]))

  const timeline: TimelinePost[] = rows.map((row) => {
    const profile = byId.get(row.user_id)
    const photoUrl = row.photo_path ? (signedMap.get(row.photo_path) ?? null) : null

    return {
      id: row.id,
      authorId: row.user_id,
      isMine: row.user_id === viewerId,
      displayName: (profile?.display_name ?? '').trim() || '친구',
      avatar: timelineAvatar(profile),
      createdAt: row.created_at,
      body: row.body,
      photoUrl,
      photoFailed: Boolean(row.photo_path) && photoUrl === null,
    }
  })

  return {
    posts: timeline,
    error: null,
    limit: TIMELINE_LIMIT,
    reachedLimit: rows.length >= TIMELINE_LIMIT,
  }
}
