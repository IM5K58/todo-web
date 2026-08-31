/**
 * lib/avatar.ts — 아바타 우선순위를 결정하는 단 하나의 장소.
 *
 * ★ 이 파일은 서버/클라이언트 양쪽에서 쓸 수 있습니다 ★
 * next/headers 도 supabase 클라이언트도 import 하지 않습니다. 순수 함수만
 * 있습니다. 그래야 홈 헤더(Server Component)와 마이페이지의 미리보기
 * (Client Component)가 같은 규칙을 쓰면서도 서로 다른 데이터 경로를 가질 수
 * 있습니다.
 *
 * ---------------------------------------------------------------------------
 * 계약 (에이전트 간 공유 — 화면 전역 동일)
 * ---------------------------------------------------------------------------
 *   1) profiles.avatar_url 이 있으면 그 사진
 *   2) 없으면 구글 로그인 사진 (auth 사용자 메타데이터)
 *   3) 없으면 profiles.avatar_emoji (없으면 '🙂')
 *
 * 이 순서를 화면마다 다시 쓰지 마세요. `resolveAvatar()` 한 번이면 됩니다.
 *
 * ---------------------------------------------------------------------------
 * 구글 사진의 키 이름을 왜 "훑는가"
 * ---------------------------------------------------------------------------
 * Supabase 의 사용자 메타데이터는 스키마가 없습니다 —
 *   node_modules/@supabase/auth-js/dist/module/lib/types.d.ts:384
 *     export interface UserMetadata { [key: string]: any }
 * 즉 타입이 아무것도 보증해 주지 않습니다. 값은 OAuth 제공자가 준 것을 거의
 * 그대로 담아 두고, 구글은 표준 OIDC 클레임 `picture` 를 보내지만 Supabase 가
 * 자기 규약인 `avatar_url` 로도 함께 채워 둡니다. 어느 쪽이 있을지는 계정이
 * 언제 만들어졌는지, 어떤 제공자를 썼는지에 따라 다릅니다.
 *
 * 그래서 키 하나를 찍지 않고 후보를 순서대로 훑습니다. 값이 문자열이 아니거나
 * (제공자가 객체를 넣는 경우가 있습니다) 안전한 URL 이 아니면 건너뜁니다.
 * 실제로 무엇이 들어 있는지 눈으로 보고 싶으면 서버에서:
 *
 *   const { data } = await supabase.auth.getClaims()
 *   console.log(data?.claims.user_metadata)   // JwtPayload.user_metadata
 *
 * `getClaims()` 는 JWT 를 로컬 검증하므로 이 값을 읽는 데 네트워크 왕복이
 * 들지 않습니다(JWKS 캐시 적중 시). `getUser()` 를 새로 부르지 마세요 —
 * 그건 언제나 Auth 서버로 나갑니다(lib/tasks.ts:208~226 참고).
 *
 * ---------------------------------------------------------------------------
 * 렌더링: next/image 가 아니라 <img>
 * ---------------------------------------------------------------------------
 * next.config.ts 의 images.remotePatterns 에는 `*.supabase.co` 만 있습니다.
 * 구글 사진은 lh3.googleusercontent.com 에서 오므로 next/image 로 그리면
 * 런타임에 400 이 납니다. 호스트를 config 에 더 넣는 쪽은 되도록 피하세요 —
 * 40×40 아바타는 최적화로 얻을 것이 거의 없고, 대신 매 요청이 우리 함수를
 * 한 번 더 거칩니다. 평범한 <img> 로 그리고, onError 에서 `emoji` 로
 * 되돌리세요(사진 URL 은 만료될 수 있습니다).
 *
 * ---------------------------------------------------------------------------
 * 구글 사진은 "본인 화면에서만" 보입니다
 * ---------------------------------------------------------------------------
 * 2)번 우선순위의 재료는 내 세션의 JWT 입니다. 그룹 동료의 auth 메타데이터를
 * 읽을 방법은 없습니다. 그래서 현황 화면의 남의 행은 1)과 3)만 가능합니다 —
 * 친구들에게도 구글 사진을 보이려면 그 URL 이 profiles.avatar_url 에 저장돼
 * 있어야 하고, 0007 의 CHECK 이 lh3 호스트를 허용하는 이유가 그것입니다.
 * 남의 행을 그릴 때 `userMetadata` 에 내 값을 넘기지 마세요. 내 사진이 친구
 * 얼굴 자리에 붙습니다.
 */

/* ==========================================================================
 * 상수
 * ======================================================================== */

/**
 * profiles.avatar_emoji 의 컬럼 DEFAULT 와 같은 값 (0001_init.sql).
 * app/page.tsx 의 DEFAULT_AVATAR_EMOJI 와 같은 문자열이어야 합니다.
 */
export const DEFAULT_AVATAR_EMOJI = '🙂'

/**
 * 사용자 메타데이터에서 사진 URL 이 들어 있을 수 있는 키들, 우선순위 순.
 *
 * `avatar_url` 이 먼저인 이유: Supabase 가 자기 규약으로 채우는 쪽이라
 * 제공자를 바꿔도 이름이 유지됩니다. `picture` 는 구글/OIDC 원본 클레임이고,
 * 나머지 둘은 다른 제공자에서 관측되는 변형입니다. 하나라도 쓸 만한 값이
 * 나오면 거기서 멈춥니다.
 */
const PHOTO_KEYS = ['avatar_url', 'picture', 'photoURL', 'profile_image_url'] as const

/**
 * 아바타 파일이 사는 공개 버킷 이름. 0007_profile_and_default_group.sql 이
 * 지정한 값입니다("Storage 경로는 공개 버킷의
 * /storage/v1/object/public/avatars/<경로> 입니다").
 *
 * ★ profiles.avatar_url 에는 버킷 이름이 들어 있지 않습니다 ★ CHECK
 * `profiles_avatar_url_shape_chk` 가 허용하는 모양은 정확히
 * `<본인 uuid>/<파일명>.(jpg|jpeg|png|webp)` — 깊이 1 고정입니다. 그래서 공개
 * URL 을 만들 때 버킷을 여기서 붙여 줘야 합니다.
 */
const AVATAR_BUCKET = 'avatars'

/** Supabase Storage 공개 객체 경로의 접두사. */
const STORAGE_PUBLIC_PREFIX = '/storage/v1/object/public/'

/* ==========================================================================
 * 타입
 * ======================================================================== */

/** 사진이 어디서 왔는지. 화면에서 "구글 사진을 쓰는 중" 같은 안내에 씁니다. */
export type AvatarSource = 'upload' | 'google' | 'emoji'

export type ResolvedAvatar = {
  /** 'image' 면 <img src={imageUrl}>, 'emoji' 면 텍스트로 {emoji} 를 그리세요. */
  kind: 'image' | 'emoji'
  /** kind 가 'image' 일 때만 문자열입니다. 그 외에는 항상 null. */
  imageUrl: string | null
  /**
   * 언제나 채워집니다 — kind 가 'image' 여도요.
   * 사진 로딩이 실패했을 때(onError) 되돌아갈 자리이자,
   * 사진 없이 그리는 좁은 자리(리스트 행)의 폴백입니다.
   */
  emoji: string
  source: AvatarSource
}

export type AvatarInput = {
  /**
   * profiles.avatar_url. 두 가지 모양을 받습니다(스키마 계약 그대로):
   *   - 절대 URL      'https://lh3.googleusercontent.com/...'  → 그대로 씁니다
   *   - Storage 경로  'avatars/<uid>.jpg'                      → 공개 URL 로 조립
   * 빈 문자열 / 공백만 / null 은 "없음"으로 봅니다.
   */
  avatarUrl?: string | null
  /**
   * auth 사용자 메타데이터. 서버에서는 `getClaims()` 의
   * `data.claims.user_metadata`, 클라이언트에서는 `user.user_metadata` 를
   * 그대로 넘기세요. 모양을 모르므로 `unknown` 으로 받고 안에서 방어합니다.
   */
  userMetadata?: unknown
  /** profiles.avatar_emoji. 비어 있으면 DEFAULT_AVATAR_EMOJI. */
  avatarEmoji?: string | null
}

/* ==========================================================================
 * 내부 유틸
 * ======================================================================== */

function trimmed(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text.length > 0 ? text : null
}

/**
 * 이 문자열을 <img src> 에 넣어도 되는가.
 *
 * ★ 프로토콜을 확인하는 이유 ★ 이 값들은 결국 남의 브라우저가 자동으로
 * 요청하게 됩니다. `javascript:` / `data:text/html` 같은 값이 섞이면 그대로
 * 그리는 화면이 생기고, `http:` 는 https 페이지에서 어차피 차단됩니다.
 * 그래서 https 절대 URL 하나만 통과시킵니다 — 0007 의
 * `profiles_avatar_url_shape_chk` 가 저장 쪽에서 세우는 기준과 같습니다.
 * 프로토콜 상대 URL('//host/x')은 파싱이 브라우저마다 달라 거부합니다.
 */
function isSafeImageUrl(value: string): boolean {
  if (value.startsWith('//')) return false
  return /^https:\/\//i.test(value)
}

/* ==========================================================================
 * 공개 함수
 * ======================================================================== */

/**
 * 저장된 아바타 한 칸 → 실제로 <img src> 에 넣을 수 있는 URL.
 *
 * ★ 이 함수는 "조립기" 이지 "검문소" 가 아닙니다 ★ 안전 판정은 아래
 * `resolveAvatar` 가 `isSafeImageUrl` 로 합니다. 둘을 한 함수에 섞으면
 * "URL 을 못 만들었다" 와 "만들 수 있지만 그려서는 안 된다" 가 똑같이 null 로
 * 뭉개져서, 나중에 어느 쪽이었는지 알 수 없게 됩니다.
 *
 * 0007 의 CHECK 이 저장을 허용하는 모양은 두 가지뿐입니다:
 *   (a) 'https://lh3.googleusercontent.com/...'   → 그대로 돌려줍니다
 *   (b) '<본인 uuid>/<파일명>.(jpg|jpeg|png|webp)' → 공개 버킷 URL 로 조립
 *       → '<SUPABASE_URL>/storage/v1/object/public/avatars/<uuid>/<파일명>'
 *
 * ★ 저장된 값에는 버킷 이름이 없습니다 ★ `profiles_avatar_url_shape_chk` 의
 * 정규식은 첫 조각이 UUID 여야 한다고 못 박습니다. 그래서 'avatars/' 는 저장
 * 쪽이 아니라 여기서 붙습니다 — 저장할 때 붙이면 CHECK 이 거부합니다.
 *
 * 다만 첫 조각이 이미 버킷 이름이면 다시 붙이지 않습니다. UUID 는 절대
 * 'avatars' 와 같을 수 없으므로 이 판정에는 애매함이 없고, 덕분에 이 함수는
 * 멱등입니다 — 이미 버킷을 포함한 경로를 손으로 넘겨도 'avatars/avatars/...'
 * 라는 404 가 만들어지지 않습니다.
 *
 * NEXT_PUBLIC_SUPABASE_URL 이 없으면 조립할 수 없으므로 null 입니다. 던지지
 * 않습니다 — 아바타 하나 때문에 화면이 죽으면 안 됩니다.
 */
export function storagePublicUrl(pathOrUrl: string | null | undefined): string | null {
  const value = trimmed(pathOrUrl)
  if (!value) return null

  // (a) 이미 절대 URL 이면 다시 조립하지 않습니다. 스킴 검사는 호출자 몫이고,
  //     화면으로 나가는 경로에서는 resolveAvatar 가 https 만 통과시킵니다.
  if (/^https?:\/\//i.test(value)) return value
  // 프로토콜 상대 URL('//host/x')은 파싱이 브라우저마다 달라 거부합니다.
  if (value.startsWith('//')) return null

  // 이미 공개 URL 의 경로 부분만 들고 있는 경우(저장 형태는 아니지만, 호출자가
  // 손으로 만들어 넘길 수 있습니다). 이건 우리 도메인이 아니라 Supabase 쪽
  // 경로이므로 상대 URL 로 두면 안 되고, 반드시 origin 을 붙여야 합니다.
  if (value.startsWith(STORAGE_PUBLIC_PREFIX)) {
    const origin = supabaseOrigin()
    return origin ? `${origin}${value}` : null
  }
  // 그 밖의 앱 절대 경로는 우리 도메인의 자산입니다. 그대로 둡니다.
  if (value.startsWith('/')) return value

  // (b) 버킷 상대 경로.
  const origin = supabaseOrigin()
  if (!origin) return null

  // 조각 단위로 인코딩합니다. '/' 는 구분자로 남고, '..' 은 '%2E%2E' 가 되어
  // 경로를 거슬러 올라갈 수 없습니다.
  const segments = value.split('/').map((segment) => encodeURIComponent(segment))
  const withBucket = segments[0] === AVATAR_BUCKET ? segments : [AVATAR_BUCKET, ...segments]

  return `${origin}${STORAGE_PUBLIC_PREFIX}${withBucket.join('/')}`
}

function supabaseOrigin(): string | null {
  const base = trimmed(process.env.NEXT_PUBLIC_SUPABASE_URL)
  return base ? base.replace(/\/+$/, '') : null
}

/**
 * auth 사용자 메타데이터에서 구글(또는 다른 OAuth 제공자) 사진 URL 하나.
 *
 * 키 이름을 추측하지 않고 PHOTO_KEYS 를 순서대로 훑습니다. 값이 문자열이
 * 아니거나 안전한 URL 이 아니면 그 키는 없는 셈 칩니다. 아무것도 못 찾으면
 * null — 그러면 호출자는 이모지로 내려갑니다.
 */
export function googlePhotoUrl(userMetadata: unknown): string | null {
  if (typeof userMetadata !== 'object' || userMetadata === null) return null

  const bag = userMetadata as Record<string, unknown>

  for (const key of PHOTO_KEYS) {
    const value = trimmed(bag[key])
    if (value && isSafeImageUrl(value)) return value
  }

  return null
}

/**
 * 아바타 우선순위를 한 번에 적용합니다. 화면은 이 결과만 보면 됩니다.
 *
 * 예)
 *   const avatar = resolveAvatar({
 *     avatarUrl: profile?.avatar_url,
 *     userMetadata: claims?.user_metadata,
 *     avatarEmoji: profile?.avatar_emoji,
 *   })
 *   avatar.kind === 'image'
 *     ? <img src={avatar.imageUrl!} alt="" />
 *     : <span aria-hidden="true">{avatar.emoji}</span>
 *
 * 세 입력이 모두 비어 있어도 절대 실패하지 않습니다 — 최악의 경우
 * `{ kind: 'emoji', emoji: '🙂', source: 'emoji' }` 입니다.
 */
export function resolveAvatar(input: AvatarInput): ResolvedAvatar {
  const emoji = trimmed(input.avatarEmoji) ?? DEFAULT_AVATAR_EMOJI

  // 1) 업로드한 사진 (또는 avatar_url 에 직접 저장된 구글 사진 URL).
  const uploaded = storagePublicUrl(input.avatarUrl)
  if (uploaded && isSafeImageUrl(uploaded)) {
    return { kind: 'image', imageUrl: uploaded, emoji, source: 'upload' }
  }

  // 2) 구글 로그인 사진.
  const google = googlePhotoUrl(input.userMetadata)
  if (google) {
    return { kind: 'image', imageUrl: google, emoji, source: 'google' }
  }

  // 3) 이모지.
  return { kind: 'emoji', imageUrl: null, emoji, source: 'emoji' }
}

/**
 * `<img alt>` 에 넣을 값.
 *
 * 아바타 옆에는 거의 항상 이름이 글자로 함께 있습니다. 그럴 때 alt 는 빈
 * 문자열이어야 합니다 — "민수 프로필 사진"을 읽어 주면 스크린리더 사용자는
 * 이름을 두 번 듣습니다. 이름이 글자로 없는 자리(아바타만 있는 버튼)에서만
 * `nameVisible: false` 로 부르세요.
 */
export function avatarAltText(displayName: string, nameVisible = true): string {
  return nameVisible ? '' : `${displayName}님의 프로필 사진`
}
