'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Screen } from '@/components/screen'
import { Button, Card, ErrorText, Hint, LinkButton, PageHeader } from '@/components/ui'
import { DEFAULT_AVATAR_EMOJI, googlePhotoUrl, resolveAvatar } from '@/lib/avatar'
import { normalizeAvatarImage } from '@/lib/image-normalize'
import { createClient } from '@/lib/supabase/client'

import { AccountCard } from './account-card'
import { saveDisplayName, setAvatar } from './actions'
import {
  ALLOWED_MIME,
  AVATAR_BUCKET,
  MAX_UPLOAD_BYTES,
  randomFileName,
  storageUploadMessage,
} from './avatar-storage'
import { PhotoCard } from './photo-card'
import { NameCard, ProfileSummaryCard } from './profile-cards'

/**
 * /me — 마이페이지.
 *
 * 위에서 아래로: 프로필(사진·이름·가입일) → 사진 변경 → 이름 변경 →
 * 알림 설정 → 계정(로그아웃 · 탈퇴).
 *
 * ---------------------------------------------------------------------------
 * 이 파일이 들고 있는 것 / 옆 파일이 들고 있는 것
 * ---------------------------------------------------------------------------
 * 상태와 절차(프로필 읽기 · 이름 저장 · 사진 업로드 · 탈퇴 요청)는 **전부 이
 * 파일**에 있습니다. 옆 파일들은 그것을 그리기만 하고, 필요한 값은 props 로
 * 받습니다 — 화면 조각이 자기만의 상태를 갖기 시작하면 "지금 무엇이 진행
 * 중인가" 가 여러 군데로 갈라집니다.
 *   · ./profile-cards.tsx  프로필 머리 · 이름 카드
 *   · ./photo-card.tsx     사진 카드
 *   · ./account-card.tsx   로그아웃 · 탈퇴(확인 문자열 관문 포함)
 *   · ./avatar-bubble.tsx  아바타 한 칸 (두 카드가 함께 씁니다)
 *   · ./avatar-storage.ts  버킷 계약 사본과 업로드용 작은 함수들
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
  // 의 몫입니다 — ./avatar-storage.ts 의 「저장 형태와 표시 형태의 이음매」 참고.
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
      <ProfileSummaryCard
        avatarImageUrl={avatar.imageUrl}
        avatarEmoji={avatar.emoji}
        displayName={displayName}
        joinedAt={joinedAt}
        avatarSourceLabel={avatarSourceLabel}
      />

      {/* ---------------------------------------------------------------- */}
      {/* 프로필 사진                                                        */}
      {/* ---------------------------------------------------------------- */}
      <PhotoCard
        photoError={photoError}
        photoDone={photoDone}
        previewUrl={previewUrl}
        avatarImageUrl={avatar.imageUrl}
        avatarEmoji={avatar.emoji}
        file={file}
        photoBusy={photoBusy}
        fileInputRef={fileInputRef}
        onPickFile={onPickFile}
        onUpload={() => void onUploadPhoto()}
        googleUrl={googleUrl}
        onUseGoogle={() => void onUseGooglePhoto()}
        storedAvatarUrl={storedAvatarUrl}
        onClear={() => void onClearPhoto()}
      />

      {/* ---------------------------------------------------------------- */}
      {/* 이름                                                              */}
      {/* ---------------------------------------------------------------- */}
      <NameCard
        draft={nameDraft}
        onDraftChange={(value) => {
          setNameDraft(value)
          setNameDone(false)
          setNameError(null)
        }}
        onSubmit={onSaveName}
        error={nameError}
        done={nameDone}
        saving={nameSaving}
        nameMax={NAME_MAX}
        // 바뀐 게 없으면 누를 이유가 없습니다. 단, 프로필 행 자체가 없는
        // 계정(handle_new_user 가 실패를 삼킨 경우)은 값이 같아 보여도
        // 저장이 필요합니다 — 액션의 INSERT 안전밸브가 그때 돕니다.
        saveDisabled={profile !== null && nameDraft.trim() === displayName}
      />

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
      <AccountCard
        displayName={displayName}
        deleteOpen={deleteOpen}
        onOpenDelete={() => {
          setDeleteOpen(true)
          setDeleteError(null)
          setDeleteDraft('')
        }}
        deleteDraft={deleteDraft}
        onDeleteDraftChange={setDeleteDraft}
        deleteArmed={deleteArmed}
        deleting={deleting}
        deleteError={deleteError}
        onCancelDelete={() => {
          setDeleteOpen(false)
          setDeleteDraft('')
          setDeleteError(null)
        }}
        onConfirmDelete={() => void onDeleteAccount()}
      />
    </Screen>
  )
}
