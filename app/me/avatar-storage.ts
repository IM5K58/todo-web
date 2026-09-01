// ---------------------------------------------------------------------------
// Storage 계약 (0007 ⑤)
// ---------------------------------------------------------------------------
//
// app/me/page.tsx 에 있던 상수와 작은 함수를 그대로 옮긴 것입니다. 값도 문구도
// 한 글자 바뀌지 않았습니다. 여기 모아 둔 이유는 화면(JSX)과 업로드 절차가
// 같은 표를 보게 하기 위해서입니다 — accept 속성과 확장자 표가 갈라지면
// "브라우저는 고르게 해 주는데 버킷이 거절하는" 상태가 생깁니다.

/** 0007 ⑤ 가 만드는 공개 버킷. public / 2MB / jpeg·png·webp. */
export const AVATAR_BUCKET = 'avatars'

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
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 // 2097152 — 버킷과 같은 값

/** allowed_mime_types 와 같은 목록. svg 와 gif 는 일부러 없습니다(0007 ⑤). */
export const ALLOWED_MIME: Record<string, 'jpg' | 'png' | 'webp'> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/** <input accept> 에 넣을 값. 목록이 갈라지지 않게 위에서 만듭니다. */
export const ACCEPT_ATTR = Object.keys(ALLOWED_MIME).join(',')

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

/** 랜덤 파일명. 경로를 추측할 수 없게 만드는 것이 공개 버킷의 방어선입니다. */
export function randomFileName(extension: string): string {
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : // 보안 컨텍스트가 아니면 randomUUID 가 없습니다. 그때도 파일명은
        // 0007 의 정규식 `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` 을 지켜야 합니다.
        `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
  return `${id}.${extension}`
}

/** Storage 가 돌려주는 영어 메시지를 사용자가 읽을 한국어로. */
export function storageUploadMessage(raw: string): string {
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
