'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  Button,
  Card,
  ErrorText,
  Hint,
  Input,
  Label,
  LinkButton,
  PageHeader,
  SuccessText,
} from '@/components/ui'
import { DEFAULT_AVATAR_EMOJI, googlePhotoUrl, resolveAvatar } from '@/lib/avatar'
import { AVATAR_MAX_EDGE, normalizeAvatarImage } from '@/lib/image-normalize'
import { createClient } from '@/lib/supabase/client'

import { saveDisplayName, setAvatar, signOutAction } from './actions'

/**
 * /me — 마이페이지.
 *
 * 위에서 아래로: 프로필(사진·이름·가입일) → 사진 변경 → 이름 변경 →
 * 알림 설정 → 계정(로그아웃 · 탈퇴).
 *
 * ---------------------------------------------------------------------------
 * 왜 Client Component 인가 (app/settings/page.tsx 와 같은 이유)
 * ---------------------------------------------------------------------------
 * 이 화면의 의미 있는 상태는 전부 브라우저에만 있습니다:
 *   · 고른 파일과 그 미리보기(objectURL)
 *   · 업로드 진행/실패 (Storage 로 직접 올리므로 서버는 이 왕복을 모릅니다)
 *   · "표시 이름을 정확히 입력했을 때만 탈퇴 버튼 활성화"
 * 서버 컴포넌트로 두고 이걸 흉내 내려면 `pattern` 속성에 사용자 이름을 정규식
 * 으로 이스케이프해 넣어야 하는데, 한글이 섞인 이름에서 그건 브라우저마다
 * 다르게 깨집니다. 되돌릴 수 없는 삭제의 관문을 그런 것 위에 올릴 수는 없습니다.
 *
 * 그렇다고 쓰기까지 브라우저에 두지는 않습니다. DB 쓰기와 Next 캐시 무효화는
 * app/me/actions.ts 의 Server Action 이 합니다(그 파일 머리말 참고).
 * 되돌릴 수 없는 탈퇴만 Route Handler 입니다 — service_role 이 필요해서입니다.
 *
 * ---------------------------------------------------------------------------
 * 아바타 우선순위는 여기서 정하지 않습니다
 * ---------------------------------------------------------------------------
 * lib/avatar.ts 의 `resolveAvatar()` 하나만 부릅니다. 화면마다 순서를 다시 쓰면
 * 홈과 마이페이지가 서로 다른 얼굴을 그리게 됩니다.
 */

// ---------------------------------------------------------------------------
// Storage 계약 (0007 ⑤)
// ---------------------------------------------------------------------------

/** 0007 ⑤ 가 만드는 공개 버킷. public / 2MB / jpeg·png·webp. */
const AVATAR_BUCKET = 'avatars'

/**
 * 버킷이 강제하는 값들의 사본.
 *
 * ⚠️ 이건 방어선이 아닙니다. 진짜 방어선은 버킷의 file_size_limit /
 * allowed_mime_types 이고(0007 ⑤), Storage API 를 직접 부르면 아래 검사는
 * 그냥 없는 것입니다. 여기 있는 이유는 단 하나 — 2MB 를 올려놓고 30초 뒤에
 * 실패를 보는 대신, 고르는 즉시 한국어로 알려 주기 위해서입니다.
 * ★ 이 숫자를 버킷보다 느슨하게 바꾸지 마세요 ★ 그러면 이 검사는 통과하고
 * 서버가 거절하는, 사용자가 이해할 수 없는 상태만 남습니다.
 *
 * 이 값은 두 자리에서 쓰입니다. (1) 고른 파일(원본)의 상한 — 브라우저가
 * 디코드해야 하는 크기라 보수적으로 둡니다. (2) 재인코딩 결과의 상한 —
 * normalizeAvatarImage 에 maxBytes 로 넘겨 실제로 올라가는 바이트를 봅니다.
 * 실제로 올라가는 건 (2) 뿐이고 512px JPEG 은 대개 100KB 미만이므로 (1)은
 * 나중에 완화할 여지가 있습니다. 지금 그러지 않는 이유는 완화하는 순간
 * 저사양 기기에서 20MB 짜리 사진을 디코드하다 탭이 죽기 때문입니다.
 */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 // 2097152 — 버킷과 같은 값

/** allowed_mime_types 와 같은 목록. svg 와 gif 는 일부러 없습니다(0007 ⑤). */
const ALLOWED_MIME: Record<string, 'jpg' | 'png' | 'webp'> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/** <input accept> 에 넣을 값. 목록이 갈라지지 않게 위에서 만듭니다. */
const ACCEPT_ATTR = Object.keys(ALLOWED_MIME).join(',')

/**
 * ★ 저장 형태와 표시 형태의 이음매는 여기서 만지지 않습니다 ★
 *
 * DB 에 저장되는 avatar_url 에는 **버킷 이름이 없습니다** —
 * `profiles_avatar_url_shape_chk` 의 정규식이 첫 조각을 UUID 로 못 박기 때문에
 * 'avatars/' 를 붙여서 저장하면 CHECK 이 거부합니다. 'avatars/' 를 붙이는 것은
 * lib/avatar.ts 의 `storagePublicUrl()` 이고, 그게 유일한 자리입니다.
 *
 * 그래서 이 화면은 `profiles.avatar_url` 값을 **가공하지 않고 그대로**
 * `resolveAvatar()` 에 넘깁니다. 여기서 접두사를 한 번 더 붙이면 규칙이 두
 * 군데로 갈라지고, 갈라진 규칙은 화면마다 다른 얼굴로 나타납니다.
 *
 * 위의 AVATAR_BUCKET 상수는 **업로드/삭제** 에만 씁니다(Storage API 는 버킷
 * 이름을 인자로 받습니다). 표시 경로 조립에는 쓰지 않습니다.
 */

// ---------------------------------------------------------------------------
// 프로필 읽기
// ---------------------------------------------------------------------------

/** handle_new_user() 가 넣는 컬럼 DEFAULT. app/page.tsx 와 같은 값. */
const DEFAULT_DISPLAY_NAME = '친구'
const FALLBACK_TIMEZONE = 'Asia/Seoul'

const NAME_MAX = 40

type ProfileRow = {
  display_name: string | null
  avatar_emoji: string | null
  timezone: string | null
  created_at: string | null
  avatar_url?: string | null
}

/**
 * ★ 캐스트인 이유 ★ lib/supabase/types.ts 는 이 기능이 소유한 파일이 아니라
 * ProfilesRow 에 avatar_url 이 아직 없을 수 있습니다. 타입이 붙은 채로
 * `.select(… , avatar_url)` 을 쓰면 DB 에는 있는 컬럼 때문에 빌드가 깨집니다.
 * types.ts 에 컬럼이 생기면 캐스트를 지우고 그대로 부르면 됩니다.
 * (app/status/page.tsx 가 default_group_id 에 쓴 것과 같은 처방)
 */
type ProfileQuery = {
  select: (columns: string) => {
    eq: (column: string, value: string) => {
      maybeSingle: () => PromiseLike<{
        data: ProfileRow | null
        error: { code?: string | null; message?: string } | null
      }>
    }
  }
}

/** ★ select('*') 금지 ★ profiles 는 컬럼 단위 SELECT 권한입니다(0003/0007). */
const PROFILE_COLUMNS = 'display_name, avatar_emoji, timezone, created_at, avatar_url'
/** 0007 미배포(42703) 폴백. 사진 기능만 빠지고 나머지는 그대로 동작합니다. */
const PROFILE_COLUMNS_LEGACY = 'display_name, avatar_emoji, timezone, created_at'

/**
 * 'ko-KR' 로 가입일 한 줄. created_at 은 timestamptz 이므로 진짜 시각이고,
 * 사용자의 프로필 시간대로 읽어 줍니다(그 사람에게 "가입한 날"은 그 시간대의
 * 날짜입니다). 시간대 문자열은 DB 트리거가 검증하지만, 그래도 Intl 이 던질 수
 * 있으므로 감쌉니다 — 가입일 한 줄 때문에 화면이 죽으면 안 됩니다.
 */
function formatJoinedAt(iso: string | null, timezone: string | null): string | null {
  if (!iso) return null
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null

  const zone = (timezone ?? '').trim() || FALLBACK_TIMEZONE

  const format = (tz: string) =>
    new Intl.DateTimeFormat('ko-KR', {
      timeZone: tz,
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(at)

  try {
    return format(zone)
  } catch {
    try {
      return format(FALLBACK_TIMEZONE)
    } catch {
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// 탈퇴 확인 문자열 비교
// ---------------------------------------------------------------------------

/**
 * app/api/account/delete/route.ts 의 `normalizeForCompare()` 와 **같은 규칙**.
 *
 * NFC 정규화가 반드시 필요합니다. 한글은 같은 글자를 완성형 코드포인트 하나로도,
 * 자모 셋으로도 표현할 수 있습니다. macOS 계열 입력기가 만드는 NFD 문자열을
 * 정규화 없이 비교하면 **눈으로는 똑같은 글자인데** 영원히 불일치가 나고,
 * 그 사용자는 탈퇴 버튼을 절대 누를 수 없습니다.
 *
 * 규칙이 서버와 어긋나면 두 종류의 막다른 골목이 생깁니다: 여기서만 통과하면
 * 400 을 받고, 서버에서만 통과하면 버튼이 영영 안 켜집니다. 한 글자도 다르게
 * 두지 마세요.
 */
function normalizeForCompare(value: string): string {
  return value.normalize('NFC').trim()
}

// ---------------------------------------------------------------------------
// 작은 조각들
// ---------------------------------------------------------------------------

/** 랜덤 파일명. 경로를 추측할 수 없게 만드는 것이 공개 버킷의 방어선입니다. */
function randomFileName(extension: string): string {
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : // 보안 컨텍스트가 아니면 randomUUID 가 없습니다. 그때도 파일명은
        // 0007 의 정규식 `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` 을 지켜야 합니다.
        `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
  return `${id}.${extension}`
}

/** Storage 가 돌려주는 영어 메시지를 사용자가 읽을 한국어로. */
function storageUploadMessage(raw: string): string {
  const text = raw.toLowerCase()
  if (text.includes('exceeded') || text.includes('too large') || text.includes('payload')) {
    return '사진 용량이 너무 커요. 2MB 이하로 줄여서 다시 시도해 주세요.'
  }
  if (text.includes('mime') || text.includes('content type')) {
    return 'JPG · PNG · WEBP 사진만 올릴 수 있어요.'
  }
  // 0008 의 트리거가 폴더당 5개를 넘기면 54000 으로 거부합니다.
  // 정상 흐름에서는 도달하지 않습니다 -- 옛 파일 정리가 반복 실패했다는 신호입니다.
  if (text.includes('54000') || text.includes('보관할 수 있습니다')) {
    return '저장된 사진이 너무 많아요. 잠시 후 다시 시도해 주세요. (계속 안 되면 알려주세요)'
  }
  if (text.includes('bucket not found')) {
    return '사진 저장소가 아직 준비되지 않았어요. 잠시 후 다시 시도해 주세요.'
  }
  if (text.includes('row-level security') || text.includes('unauthorized') || text.includes('jwt')) {
    return '로그인이 풀렸어요. 앱을 새로고침한 뒤 다시 시도해 주세요.'
  }
  return '사진을 올리지 못했어요. 잠시 후 다시 시도해 주세요.'
}

/** 아바타 한 칸. 사진이 깨지면 이모지로 조용히 내려앉습니다. */
function AvatarBubble({
  imageUrl,
  emoji,
  size,
  alt,
}: {
  imageUrl: string | null
  emoji: string
  /** tailwind 클래스 그대로 (size-16 / size-12). */
  size: string
  alt: string
}) {
  const [broken, setBroken] = useState(false)

  // 사진 주소가 바뀌면 실패 표시를 다시 걷어 줍니다. 안 그러면 한 번 깨진 뒤
  // 새로 올린 사진도 영영 이모지로만 보입니다.
  useEffect(() => {
    setBroken(false)
  }, [imageUrl])

  const showImage = Boolean(imageUrl) && !broken

  return (
    <div
      className={`bg-surface-2 ${size} grid shrink-0 place-items-center overflow-hidden rounded-full text-3xl`}
    >
      {showImage ? (
        // next/image 가 아니라 <img> 입니다. 0007 의 경고 그대로 — next/image
        // 로 그리려면 lh3.googleusercontent.com 과 우리 Supabase 호스트를
        // images.remotePatterns 에 등록해야 하고, 그 목록은 그대로
        // /_next/image 공개 프록시의 허용 목록이 됩니다(next.config.ts 참고).
        // 40px 아바타가 최적화로 얻을 것보다 잃을 것이 큽니다.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl as string}
          alt={alt}
          className="size-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
        />
      ) : (
        <span aria-hidden={alt === '' ? true : undefined}>{emoji}</span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 화면
// ---------------------------------------------------------------------------

type LoadState = 'loading' | 'ready' | 'error'

export default function MePage() {
  const router = useRouter()

  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [loadMessage, setLoadMessage] = useState<string | null>(null)

  const [userId, setUserId] = useState<string | null>(null)
  const [userMetadata, setUserMetadata] = useState<unknown>(null)
  const [profile, setProfile] = useState<ProfileRow | null>(null)

  // 이름
  const [nameDraft, setNameDraft] = useState('')
  const [nameSaving, setNameSaving] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [nameDone, setNameDone] = useState(false)

  // 사진
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [photoBusy, setPhotoBusy] = useState<null | 'upload' | 'google' | 'clear'>(null)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [photoDone, setPhotoDone] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // 탈퇴
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteDraft, setDeleteDraft] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // -------------------------------------------------------------------------
  // 로드
  // -------------------------------------------------------------------------

  const load = useCallback(async () => {
    setLoadState('loading')
    setLoadMessage(null)

    const supabase = createClient()

    // getClaims() 는 JWT 서명을 로컬에서 검증합니다(JWKS 캐시 적중 시 왕복 없음).
    // getUser() 를 쓰면 매번 Auth 서버로 나갑니다 — 구글 사진 URL 하나 읽으려고
    // 낼 비용이 아닙니다(lib/avatar.ts 머리말이 같은 말을 합니다).
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims()
    const uid = claimsData?.claims.sub

    if (claimsError || typeof uid !== 'string' || !uid) {
      // proxy.ts 가 이미 막아 주지만, 세션이 화면을 보는 도중 만료될 수 있습니다.
      window.location.replace('/login?next=%2Fme')
      return
    }

    setUserId(uid)
    setUserMetadata(claimsData?.claims.user_metadata ?? null)

    const profiles = supabase.from('profiles') as unknown as ProfileQuery

    let { data, error } = await profiles.select(PROFILE_COLUMNS).eq('id', uid).maybeSingle()

    // 42703 = 0007 미배포. 사진 기능만 없는 셈 치고 나머지를 그립니다.
    if (error?.code === '42703') {
      ;({ data, error } = await profiles
        .select(PROFILE_COLUMNS_LEGACY)
        .eq('id', uid)
        .maybeSingle())
    }

    if (error) {
      console.error('[me] 프로필 조회 실패', { code: error.code, message: error.message })
      setLoadState('error')
      setLoadMessage('프로필을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.')
      return
    }

    // 프로필 행이 없는 계정도 실제로 존재합니다 — handle_new_user() 가 실패를
    // 삼키고 가입을 통과시키기 때문입니다. 그래도 화면은 기본값으로 동작하고,
    // 이름을 저장하면 액션이 안전밸브로 INSERT 합니다.
    setProfile(data)
    setNameDraft((data?.display_name ?? '').trim() || DEFAULT_DISPLAY_NAME)
    setLoadState('ready')
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 미리보기 objectURL 은 반드시 회수합니다. 안 하면 사진을 고를 때마다 blob 이
  // 쌓이고, 모바일에서는 그게 곧 메모리 압박입니다.
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  // -------------------------------------------------------------------------
  // 파생 값
  // -------------------------------------------------------------------------

  const displayName = (profile?.display_name ?? '').trim() || DEFAULT_DISPLAY_NAME
  const storedAvatarUrl = profile?.avatar_url ?? null
  const googleUrl = googlePhotoUrl(userMetadata)

  // 저장된 값을 그대로 넘깁니다. 버킷 접두사도 안전 판정도 전부 lib/avatar.ts
  // 의 몫입니다 — 위 「저장 형태와 표시 형태의 이음매」 주석 참고.
  const avatar = resolveAvatar({
    avatarUrl: storedAvatarUrl,
    userMetadata,
    avatarEmoji: profile?.avatar_emoji ?? DEFAULT_AVATAR_EMOJI,
  })

  const joinedAt = formatJoinedAt(profile?.created_at ?? null, profile?.timezone ?? null)

  /**
   * `resolveAvatar` 의 source 만으로는 부족합니다. 저장된 avatar_url 이 구글
   * 사진 URL 인 경우에도 source 는 'upload'(= 1순위가 이겼다) 이기 때문입니다.
   * 사용자에게 중요한 구분은 "그게 친구들에게도 보이는가" 이고, 그건 값이
   * profiles 에 있느냐로 갈립니다 — 구글 사진을 auth 메타데이터에서만 읽는
   * 경우는 **본인 화면에서만** 보입니다(0007 의 avatar_url 주석).
   */
  const avatarSourceLabel =
    avatar.source === 'emoji'
      ? '이모지를 쓰고 있어요.'
      : avatar.source === 'google'
        ? '구글 로그인 사진이 보이고 있어요. 이 사진은 나에게만 보여요 — 친구들에게는 이모지로 보입니다.'
        : storedAvatarUrl && /^https?:\/\//i.test(storedAvatarUrl)
          ? '구글 사진을 프로필 사진으로 저장해 두었어요. 친구들에게도 이 사진이 보여요.'
          : '직접 올린 사진을 쓰고 있어요. 친구들에게도 이 사진이 보여요.'

  const deleteArmed =
    normalizeForCompare(deleteDraft) === normalizeForCompare(displayName) &&
    deleteDraft.trim().length > 0

  // -------------------------------------------------------------------------
  // 이름 저장
  // -------------------------------------------------------------------------

  async function onSaveName(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (nameSaving) return

    setNameSaving(true)
    setNameError(null)
    setNameDone(false)

    const result = await saveDisplayName(nameDraft)

    setNameSaving(false)

    if (!result.ok) {
      setNameError(result.message)
      return
    }

    setNameDone(true)
    // 서버 쪽 캐시는 액션이 revalidatePath 로 비웠습니다. 이건 이 화면이 들고
    // 있는 RSC 페이로드를 다시 받아 오는 쪽입니다.
    router.refresh()
    await load()
  }

  // -------------------------------------------------------------------------
  // 사진
  // -------------------------------------------------------------------------

  /**
   * 이전에 올렸던 파일 정리. 실패해도 진행합니다.
   *
   * 공개 버킷이라 남겨 두면 이전 사진의 URL 이 계속 유효합니다. 그렇다고 이걸
   * 실패로 보고하면 사진은 이미 바뀌었는데 사용자에게는 실패라고 말하는 셈이라,
   * 로그만 남기고 넘어갑니다.
   */
  async function removeStoredFile(dbPath: string | null) {
    const path = (dbPath ?? '').trim()
    // 절대 URL(구글 사진)은 우리 파일이 아닙니다. 지울 것이 없습니다.
    if (!path || /^https?:\/\//i.test(path)) return

    const supabase = createClient()
    const { error } = await supabase.storage.from(AVATAR_BUCKET).remove([path])
    if (error) {
      console.error('[me] 이전 아바타 파일 삭제 실패', error.message)
    }
  }

  function onPickFile(event: React.ChangeEvent<HTMLInputElement>) {
    setPhotoError(null)
    setPhotoDone(null)

    const picked = event.target.files?.[0] ?? null
    if (!picked) {
      setFile(null)
      return
    }

    // 앞에서 거르되, 이게 방어선이라고 믿지는 않습니다 — 버킷 설정이 진짜
    // 방어선입니다. 여기서 하는 일은 "빨리, 한국어로" 알려 주는 것뿐입니다.
    if (!(picked.type in ALLOWED_MIME)) {
      setFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
      setPhotoError('JPG · PNG · WEBP 사진만 올릴 수 있어요.')
      return
    }

    if (picked.size > MAX_UPLOAD_BYTES) {
      setFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
      setPhotoError('사진 용량이 너무 커요. 2MB 이하로 줄여서 다시 시도해 주세요.')
      return
    }

    setFile(picked)
  }

  async function onUploadPhoto() {
    if (!file || !userId || photoBusy) return

    setPhotoBusy('upload')
    setPhotoError(null)
    setPhotoDone(null)

    // ★ 사용자가 고른 파일을 그대로 올리지 않습니다 ★
    // 아바타 버킷은 공개입니다. 휴대폰 사진의 EXIF 에는 GPS 좌표가 들어 있고,
    // 원본을 올리면 URL 을 아는 누구나 그걸 읽습니다. canvas 로 한 번 다시
    // 그려 내보내면 메타데이터가 통째로 사라집니다 — lib/image-normalize.ts.
    // 실패하면 원본으로 되돌아가지 **않고** 그대로 실패합니다. 그래야
    // "대부분의 경우 지워집니다" 가 아니라 "우리 경로로 올라간 건 지워졌습니다"
    // 가 됩니다.
    const normalized = await normalizeAvatarImage(file, { maxBytes: MAX_UPLOAD_BYTES })
    if (!normalized.ok) {
      setPhotoBusy(null)
      setPhotoError(normalized.message)
      return
    }

    // 여기서부터 `file`(사용자가 고른 것) 이 아니라 `upload`(재인코딩한 것) 만
    // 씁니다. 둘을 섞으면 EXIF 를 지운 의미가 사라집니다.
    const upload = normalized.file

    // normalizeAvatarImage 는 항상 image/jpeg 를 돌려주므로 이 조회는 사실상
    // 'jpg' 로 고정입니다. 그래도 상수를 직접 쓰지 않고 ALLOWED_MIME 을 거치는
    // 이유는, 버킷의 allowed_mime_types 와 확장자 표가 갈라지는 날 여기서
    // 먼저 걸리게 하기 위해서입니다.
    const extension = ALLOWED_MIME[upload.type]
    if (!extension) {
      setPhotoBusy(null)
      setPhotoError('JPG · PNG · WEBP 사진만 올릴 수 있어요.')
      return
    }

    // 경로는 0007 이 요구하는 모양 그대로: <내 uuid>/<무작위>.<확장자>.
    // 깊이가 1 이 아니거나 첫 세그먼트가 내 uuid 가 아니면 storage 정책이
    // 거절하고, set_avatar 도 거절합니다.
    const objectPath = `${userId}/${randomFileName(extension)}`
    const previous = storedAvatarUrl

    const supabase = createClient()
    const { error: uploadError } = await supabase.storage
      .from(AVATAR_BUCKET)
      .upload(objectPath, upload, {
        contentType: upload.type,
        // upsert 는 하지 않습니다. 파일명이 매번 새로 만들어지므로 덮어쓸 대상이
        // 없고, upsert 를 켜면 UPDATE 정책까지 필요해집니다.
        upsert: false,
      })

    if (uploadError) {
      console.error('[me] 아바타 업로드 실패', uploadError.message)
      setPhotoBusy(null)
      setPhotoError(storageUploadMessage(uploadError.message))
      return
    }

    // 파일은 올라갔지만 아직 아무도 그 사진을 보지 않습니다. profiles 를
    // 가리키게 하는 것은 set_avatar 뿐입니다.
    const result = await setAvatar(objectPath)

    if (!result.ok) {
      // 방금 올린 파일을 되돌립니다. 안 그러면 아무도 가리키지 않는 공개 파일이
      // 버킷에 영원히 남습니다.
      await removeStoredFile(objectPath)
      setPhotoBusy(null)
      setPhotoError(result.message)
      return
    }

    // [정리는 서버가 합니다] 예전에는 여기서 옛 파일을 직접 지웠지만,
    // `previous` 는 이 화면이 렌더될 때의 값이라 다른 탭이 그 사이에 사진을
    // 바꿨으면 **지금 쓰이는 파일**을 지웁니다. app/me/actions.ts 의
    // sweepAvatarFolder 가 쓰기 직전에 읽은 값으로 정리하고, 실패로 남은
    // 찌꺼기도 다음 변경 때 회수합니다.

    setFile(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
    setPhotoBusy(null)
    setPhotoDone('프로필 사진을 바꿨어요.')
    router.refresh()
    await load()
  }

  async function onUseGooglePhoto() {
    if (!googleUrl || photoBusy) return

    setPhotoBusy('google')
    setPhotoError(null)
    setPhotoDone(null)

    const previous = storedAvatarUrl
    const result = await setAvatar(googleUrl)

    if (!result.ok) {
      setPhotoBusy(null)
      setPhotoError(result.message)
      return
    }

    // [정리는 서버가 합니다] 예전에는 여기서 옛 파일을 직접 지웠지만,
    // `previous` 는 이 화면이 렌더될 때의 값이라 다른 탭이 그 사이에 사진을
    // 바꿨으면 **지금 쓰이는 파일**을 지웁니다. app/me/actions.ts 의
    // sweepAvatarFolder 가 쓰기 직전에 읽은 값으로 정리하고, 실패로 남은
    // 찌꺼기도 다음 변경 때 회수합니다.

    setPhotoBusy(null)
    setPhotoDone('구글 사진으로 바꿨어요.')
    router.refresh()
    await load()
  }

  async function onClearPhoto() {
    if (photoBusy) return

    setPhotoBusy('clear')
    setPhotoError(null)
    setPhotoDone(null)

    const previous = storedAvatarUrl
    const result = await setAvatar(null)

    if (!result.ok) {
      setPhotoBusy(null)
      setPhotoError(result.message)
      return
    }

    // [정리는 서버가 합니다] 예전에는 여기서 옛 파일을 직접 지웠지만,
    // `previous` 는 이 화면이 렌더될 때의 값이라 다른 탭이 그 사이에 사진을
    // 바꿨으면 **지금 쓰이는 파일**을 지웁니다. app/me/actions.ts 의
    // sweepAvatarFolder 가 쓰기 직전에 읽은 값으로 정리하고, 실패로 남은
    // 찌꺼기도 다음 변경 때 회수합니다.

    setPhotoBusy(null)
    setPhotoDone('사진을 지웠어요.')
    router.refresh()
    await load()
  }

  // -------------------------------------------------------------------------
  // 탈퇴
  // -------------------------------------------------------------------------

  async function onDeleteAccount() {
    if (!deleteArmed || deleting) return

    setDeleting(true)
    setDeleteError(null)

    let response: Response
    try {
      response = await fetch('/api/account/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: deleteDraft }),
      })
    } catch (cause) {
      console.error('[me] 탈퇴 요청 실패', cause)
      setDeleting(false)
      setDeleteError('연결에 실패했어요. 네트워크를 확인한 뒤 다시 시도해 주세요.')
      return
    }

    if (!response.ok) {
      let message = '탈퇴하지 못했어요. 잠시 후 다시 시도해 주세요.'
      try {
        const payload = (await response.json()) as { error?: unknown }
        if (typeof payload?.error === 'string' && payload.error.trim()) {
          message = payload.error
        }
      } catch {
        // 본문이 JSON 이 아니면 위의 기본 문구를 씁니다.
      }
      setDeleting(false)
      setDeleteError(message)
      return
    }

    // 계정은 사라졌습니다. 브라우저에 남은 세션 흔적도 정리하고, 소프트 내비게이션
    // 대신 통째로 다시 불러 라우터 캐시에 남은 화면이 되살아나지 않게 합니다.
    try {
      await createClient().auth.signOut({ scope: 'local' })
    } catch {
      // 서버가 이미 쿠키를 지웠습니다. 실패해도 할 일은 똑같습니다.
    }
    window.location.replace('/login')
  }

  // -------------------------------------------------------------------------
  // 렌더
  // -------------------------------------------------------------------------

  if (loadState === 'loading') {
    // app/me/loading.tsx 와 같은 골격. 여기서도 필요한 이유: loading.tsx 는
    // 라우트 전환만 덮고, 이 화면의 데이터는 마운트 뒤 브라우저에서 옵니다.
    return (
      <Screen>
        <div aria-busy="true" aria-live="polite" className="motion-safe:animate-pulse flex flex-col gap-5">
          <span className="sr-only">불러오는 중…</span>
          <div className="flex flex-col gap-3">
            <div className="bg-surface-2 h-7 w-32 rounded-lg" />
            <div className="bg-surface-2 h-4 w-52 rounded-md" />
          </div>
          <div className="border-line bg-surface rounded-2xl border p-5">
            <div className="flex items-center gap-4">
              <div className="bg-surface-2 size-16 shrink-0 rounded-full" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="bg-surface-2 h-5 w-28 rounded-md" />
                <div className="bg-surface-2 h-3.5 w-40 rounded-sm" />
              </div>
            </div>
          </div>
          <div className="bg-surface-2 h-52 rounded-2xl" />
          <div className="bg-surface-2 h-56 rounded-2xl" />
        </div>
      </Screen>
    )
  }

  if (loadState === 'error') {
    return (
      <Screen>
        <PageHeader title="마이페이지" />
        <Card>
          <ErrorText>{loadMessage}</ErrorText>
          <Button type="button" variant="secondary" onClick={() => void load()}>
            다시 시도
          </Button>
        </Card>
      </Screen>
    )
  }

  return (
    <Screen>
      <PageHeader
        title="마이페이지"
        description="사진과 이름은 같은 그룹 친구들에게 보여요."
      />

      {/* ---------------------------------------------------------------- */}
      {/* 프로필                                                            */}
      {/* ---------------------------------------------------------------- */}
      <Card>
        <div className="flex items-center gap-4">
          <AvatarBubble
            imageUrl={avatar.imageUrl}
            emoji={avatar.emoji}
            size="size-16"
            // 이름이 바로 옆에 글자로 있으므로 alt 는 빈 문자열입니다.
            // (lib/avatar.ts 의 avatarAltText 가 설명하는 그 규칙)
            alt=""
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className="text-fg truncate text-lg font-semibold">{displayName}</p>
            {joinedAt ? (
              <p className="text-muted text-xs">{joinedAt} 가입</p>
            ) : (
              <p className="text-muted text-xs">가입일을 불러오지 못했어요.</p>
            )}
          </div>
        </div>
        <Hint>{avatarSourceLabel}</Hint>
      </Card>

      {/* ---------------------------------------------------------------- */}
      {/* 프로필 사진                                                        */}
      {/* ---------------------------------------------------------------- */}
      <Card title="프로필 사진">
        <ErrorText>{photoError}</ErrorText>
        <SuccessText>{photoDone}</SuccessText>

        <div className="flex items-center gap-3">
          <AvatarBubble
            imageUrl={previewUrl ?? avatar.imageUrl}
            emoji={avatar.emoji}
            size="size-12"
            alt={previewUrl ? '고른 사진 미리보기' : ''}
          />
          <p className="text-muted min-w-0 flex-1 text-xs [word-break:keep-all]">
            {previewUrl
              ? '고른 사진이에요. 아래 버튼을 눌러야 저장돼요.'
              : `JPG · PNG · WEBP, 2MB 이하 · 올릴 때 ${AVATAR_MAX_EDGE}px 로 줄이고 위치 정보를 지워요`}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="avatar-file">사진 고르기</Label>
          <input
            id="avatar-file"
            ref={fileInputRef}
            type="file"
            accept={ACCEPT_ATTR}
            onChange={onPickFile}
            disabled={photoBusy !== null}
            className="border-line bg-surface-2 text-fg file:bg-surface file:text-fg file:border-line h-12 w-full rounded-xl border px-3 text-sm file:mr-3 file:h-8 file:rounded-lg file:border file:px-3 file:text-sm disabled:opacity-40"
          />
        </div>

        <Button
          type="button"
          variant="primary"
          disabled={!file || photoBusy !== null}
          pending={photoBusy === 'upload'}
          pendingLabel="올리는 중…"
          onClick={() => void onUploadPhoto()}
        >
          이 사진으로 바꾸기
        </Button>

        {/* 구글 사진은 로그인 계정에 사진이 실제로 있을 때만 제안합니다.
            없는데 버튼만 보이면 눌러 본 뒤에야 없다는 걸 알게 됩니다. */}
        {googleUrl && (
          <Button
            type="button"
            variant="secondary"
            disabled={photoBusy !== null}
            pending={photoBusy === 'google'}
            pendingLabel="바꾸는 중…"
            onClick={() => void onUseGooglePhoto()}
          >
            구글 사진 쓰기
          </Button>
        )}

        {/* 지울 사진이 있을 때만 보여 줍니다. avatar_url 이 이미 비어 있으면
            누를 이유가 없고, 이미 이모지를 쓰는 중입니다. */}
        {storedAvatarUrl && (
          <Button
            type="button"
            variant="secondary"
            disabled={photoBusy !== null}
            pending={photoBusy === 'clear'}
            pendingLabel="되돌리는 중…"
            onClick={() => void onClearPhoto()}
          >
            이모지로 되돌리기
          </Button>
        )}

        <Hint>
          {googleUrl
            ? `사진을 지우면 나에게는 구글 사진이, 친구들에게는 이모지(${avatar.emoji})가 보여요. `
            : `사진을 지우면 이모지(${avatar.emoji})로 보여요. `}
          이모지는{' '}
          <Link href="/onboarding" className="text-accent underline underline-offset-4">
            프로필 수정
          </Link>
          에서 바꿀 수 있어요.
        </Hint>
      </Card>

      {/* ---------------------------------------------------------------- */}
      {/* 이름                                                              */}
      {/* ---------------------------------------------------------------- */}
      <Card title="이름">
        <form onSubmit={onSaveName} className="flex flex-col gap-3">
          <Input
            id="display-name"
            name="display_name"
            type="text"
            label="이름"
            value={nameDraft}
            onChange={(event) => {
              setNameDraft(event.target.value)
              setNameDone(false)
              setNameError(null)
            }}
            error={nameError}
            required
            // 브라우저가 세는 40 은 UTF-16 코드 유닛이라 이모지가 섞이면 DB 기준
            // 40자보다 짧게 잘립니다. 서버보다 엄격한 쪽이라 안전합니다.
            maxLength={NAME_MAX}
            autoComplete="nickname"
            enterKeyHint="done"
            placeholder="예: 지수"
            hint="1~40자. 친구들에게 이 이름으로 보여요."
            disabled={nameSaving}
          />

          {nameDone && <SuccessText>이름을 바꿨어요.</SuccessText>}

          <Button
            type="submit"
            variant="primary"
            pending={nameSaving}
            pendingLabel="저장 중…"
            // 바뀐 게 없으면 누를 이유가 없습니다. 단, 프로필 행 자체가 없는
            // 계정(handle_new_user 가 실패를 삼킨 경우)은 값이 같아 보여도
            // 저장이 필요합니다 — 액션의 INSERT 안전밸브가 그때 돕니다.
            disabled={profile !== null && nameDraft.trim() === displayName}
          >
            이름 저장
          </Button>
        </form>
      </Card>

      {/* ---------------------------------------------------------------- */}
      {/* 알림                                                              */}
      {/* ---------------------------------------------------------------- */}
      <Card title="알림">
        <Hint>
          콕 찌르기 알림과 저녁 자동 리마인더를 켜고 끌 수 있어요.
        </Hint>
        <LinkButton href="/settings" variant="secondary">
          알림 설정 열기
        </LinkButton>
      </Card>

      {/* ---------------------------------------------------------------- */}
      {/* 계정                                                              */}
      {/* ---------------------------------------------------------------- */}
      <Card title="계정">
        {/*
          로그아웃은 Server Action 입니다. 브라우저에서 signOut() 만 부르면
          document.cookie 는 지워져도 이미 받아 둔 서버 컴포넌트 페이로드가
          라우터 캐시에 남아, 뒤로가기 한 번에 로그인된 화면이 되살아납니다.
        */}
        <form action={signOutAction}>
          <Button type="submit" variant="secondary" pendingLabel="로그아웃 중…">
            로그아웃
          </Button>
        </form>

        <div className="border-line mt-2 border-t pt-4">
          {!deleteOpen ? (
            <div className="flex flex-col gap-2">
              <Hint>
                탈퇴하면 계정과 내 기록이 모두 사라져요. 되돌릴 수 없어요.
              </Hint>
              <Button
                type="button"
                variant="danger"
                onClick={() => {
                  setDeleteOpen(true)
                  setDeleteError(null)
                  setDeleteDraft('')
                }}
              >
                탈퇴하기
              </Button>
            </div>
          ) : (
            <DeleteConfirm
              displayName={displayName}
              draft={deleteDraft}
              onDraftChange={setDeleteDraft}
              armed={deleteArmed}
              busy={deleting}
              error={deleteError}
              onCancel={() => {
                setDeleteOpen(false)
                setDeleteDraft('')
                setDeleteError(null)
              }}
              onConfirm={() => void onDeleteAccount()}
            />
          )}
        </div>
      </Card>
    </Screen>
  )
}

// ---------------------------------------------------------------------------
// 공통 껍데기
// ---------------------------------------------------------------------------

/**
 * app/settings/page.tsx 가 세운 페이지 폭/간격 + 하단 고정 탭바 여유 공간.
 *
 * 여유 공간은 <main> 의 `pb-28` 이 아니라 스페이서 <div> 입니다. `screen-safe`
 * 가 이미 padding-bottom: env(safe-area-inset-bottom) 을 걸고 있어서 둘 중
 * 어느 쪽이 캐스케이드에서 이기는지가 우연에 달리게 되고, screen-safe 가 이기면
 * 마지막 줄이 56px 바 아래로 들어갑니다. 형제 <div> 에는 그런 모호함이 없습니다.
 */
function Screen({ children }: { children: React.ReactNode }) {
  return (
    <main className="screen-safe px-safe mx-auto flex w-full max-w-md flex-col gap-5 py-6">
      {children}
      <div aria-hidden="true" className="h-28 shrink-0" />
    </main>
  )
}

// ---------------------------------------------------------------------------
// 탈퇴 확인
// ---------------------------------------------------------------------------

/**
 * 되돌릴 수 없는 삭제의 관문.
 *
 * window.confirm() 을 쓰지 않는 이유는 components/ui.tsx 의 ConfirmButton 과
 * 같습니다 — 일부 standalone PWA 컨텍스트에서 막히고, 페이지 전체를 멈춥니다.
 * 그리고 confirm 창에는 "무엇이 지워지는가" 를 이만큼 적을 수 없습니다.
 *
 * 활성화 조건은 **표시 이름을 정확히 옮겨 적기** 입니다. 체크박스나 두 번 누르기
 * 보다 강한 이유는, 다른 사람의 화면을 잠깐 잡은 사람이나 실수로 스크롤하다
 * 누른 사람이 통과할 수 없기 때문입니다. 물론 이건 UI 이고, 진짜 관문은
 * app/api/account/delete/route.ts 가 같은 문자열을 서버에서 다시 맞춰 보는
 * 쪽입니다.
 *
 * 【아래 목록의 출처】 추측이 아니라 supabase/migrations 의 ON DELETE 절입니다.
 *   tasks / task_templates / group_members / push_subscriptions / nudges
 *     → profiles(id) ON DELETE CASCADE            (0001, 0004)
 *   groups.created_by → profiles(id) ON DELETE SET NULL  (0001:207)
 *     = 내가 만든 그룹은 남고, '만든 사람' 칸만 비워집니다.
 *   마지막 소유자였다면 private.ensure_group_has_owner() (0001 §6b) 가 가장
 *     오래된 남은 멤버에게 소유권을 넘깁니다. 남은 멤버가 없으면 빈 그룹이
 *     남습니다.
 */
function DeleteConfirm({
  displayName,
  draft,
  onDraftChange,
  armed,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  displayName: string
  draft: string
  onDraftChange: (value: string) => void
  armed: boolean
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="border-danger flex flex-col gap-3 rounded-xl border p-4">
      <h3 className="text-danger text-sm font-semibold" role="alert">
        정말 탈퇴할까요? 되돌릴 수 없어요.
      </h3>

      <div className="flex flex-col gap-2">
        <p className="text-fg text-sm font-medium">지워지는 것</p>
        <ul className="text-muted flex list-disc flex-col gap-1 pl-5 text-sm leading-relaxed [word-break:keep-all]">
          <li>지금까지 적은 할 일과 기록 전부 (친구들의 현황·기록 화면에서도 사라져요)</li>
          <li>반복 할 일 템플릿</li>
          <li>모든 그룹에서의 참여 (그룹 자체는 남아요)</li>
          <li>알림 구독 — 이 계정으로는 더 이상 알림이 오지 않아요</li>
          <li>주고받은 콕 찌르기 기록</li>
          <li>프로필 — 이름, 올린 사진, 이모지</li>
        </ul>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-fg text-sm font-medium">남는 것</p>
        <ul className="text-muted flex list-disc flex-col gap-1 pl-5 text-sm leading-relaxed [word-break:keep-all]">
          <li>내가 만든 그룹은 그대로 남아요. &lsquo;만든 사람&rsquo; 표시만 비워져요.</li>
          <li>친구들이 적은 할 일과 기록은 그대로예요.</li>
          <li>
            내가 유일한 방장인 그룹은 가장 오래 있던 다른 멤버가 자동으로 방장이 돼요.
            남은 멤버가 아무도 없으면 그 그룹은 빈 채로 남아요.
          </li>
        </ul>
      </div>

      <Hint>
        다시 쓰고 싶어지면 같은 구글 계정으로 새로 가입할 수 있지만, 지워진 기록은
        돌아오지 않아요.
      </Hint>

      <Input
        id="delete-confirm"
        type="text"
        label="확인"
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        // autoComplete='off' + 자동 대문자/교정 끄기: 이름을 정확히 옮겨 적어야
        // 하는 칸에서 모바일 키보드가 첫 글자를 바꿔 놓으면 사용자는 왜 버튼이
        // 안 켜지는지 알 수 없습니다.
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="done"
        disabled={busy}
        placeholder={displayName}
        hint={
          <>
            탈퇴하려면 내 이름 <strong className="text-fg">{displayName}</strong> 을(를)
            그대로 입력해 주세요.
          </>
        }
      />

      <ErrorText>{error}</ErrorText>

      <div className="flex gap-2">
        <Button
          type="button"
          variant="danger"
          disabled={!armed}
          pending={busy}
          pendingLabel="탈퇴 중…"
          onClick={onConfirm}
          className="flex-1"
        >
          영구 삭제
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={onCancel}
          className="flex-1"
        >
          취소
        </Button>
      </div>
    </div>
  )
}
