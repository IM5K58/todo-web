/**
 * lib/image-normalize.ts — 업로드 직전에 사진을 canvas 로 다시 그려 내보냅니다.
 *
 * ★ 이 파일이 존재하는 이유는 "용량" 이 아니라 "EXIF" 입니다 ★
 * 휴대폰으로 찍은 사진에는 GPS 좌표·촬영 시각·기기 모델이 EXIF 로 박혀 있고,
 * 아바타 버킷은 **공개(public)** 입니다. 원본을 그대로 올리면 URL 을 아는
 * 누구나 내려받아 그 좌표를 읽습니다. 앨범에서 고른 사진이면 집 좌표일 확률이
 * 낮지 않습니다. canvas 는 픽셀만 옮겨 담기 때문에, 한 번 통과시켜 다시
 * 인코딩하면 EXIF·XMP·ICC 같은 메타데이터가 통째로 사라집니다.
 * 용량이 줄어드는 건 부수 효과입니다(40~64px 로만 그려지는 얼굴에 2MB 를
 * 저장할 이유가 없습니다).
 *
 * ---------------------------------------------------------------------------
 * ⚠️ 이건 클라이언트 "편의" 이지 방어선이 아닙니다 ⚠️
 * ---------------------------------------------------------------------------
 * 이 코드는 사용자의 브라우저에서 돕니다. Storage API 를 직접 부르면 이 함수는
 * 그냥 없는 것입니다. 진짜 방어선은 버킷 설정입니다 —
 * 0007_profile_and_default_group.sql ⑤ 의 `file_size_limit` (2MB) 과
 * `allowed_mime_types` (jpeg·png·webp), 그리고 storage.objects 정책 4개.
 * 크기·MIME 제한을 여기서 느슨하게 바꾼다고 버킷이 따라오지 않고, 반대로
 * 버킷을 열어 두고 여기만 조이면 아무것도 지켜지지 않습니다.
 *
 * 즉 EXIF 제거는 **우리가 만든 업로드 경로에 한해서만** 보장됩니다. 그걸
 * 서버에서도 보장하고 싶어지면 Storage 트리거나 Edge Function 으로 재인코딩을
 * 옮겨야 합니다. 지금 규모(친구 3~6명)에서는 과합니다.
 *
 * ---------------------------------------------------------------------------
 * 결과 MIME 을 image/jpeg 하나로 통일합니다 — 근거
 * ---------------------------------------------------------------------------
 * 입력이 png 든 webp 든 jpeg 든, 나가는 건 항상 JPEG 입니다.
 *
 *   1) `canvas.toBlob` 이 스펙상 지원을 보장하는 타입은 image/png 뿐이고,
 *      **모르는 타입을 주면 조용히 PNG 로 바꿔 내놓습니다**(예외가 아니라
 *      묵음 대체입니다). 그래서 "요청한 타입" 을 믿으면 안 되고, 실제로
 *      돌아온 `blob.type` 을 확인해야 합니다(아래에서 확인합니다).
 *      JPEG 은 `toBlob` 을 구현한 모든 엔진이 함께 구현하는 사실상의 하한선
 *      이라 그 묵음 대체에 걸릴 확률이 가장 낮습니다.
 *   2) WEBP 는 더 작지만 인코더 지원이 JPEG 보다 늦게 붙었습니다. 실패하면
 *      1)의 PNG 묵음 대체로 떨어지는데, 512px PNG 는 같은 그림의 JPEG 보다
 *      5~10배 크고 그건 2MB 버킷 한도 쪽으로 우리를 도로 밀어 넣습니다.
 *      아바타 한 장에서 아낄 수 있는 몇십 KB 와 바꿀 만한 위험이 아닙니다.
 *   3) MIME 이 하나면 확장자도 하나입니다. 호출부가
 *      `ALLOWED_MIME[file.type]` 로 확장자를 고르는 분기와, 0007 의
 *      `profiles_avatar_url_shape_chk` 가 보는 `(jpg|jpeg|png|webp)` 분기가
 *      전부 한 값으로 고정됩니다 — 경로 모양이 어긋날 자리가 사라집니다.
 *
 * JPEG 에는 알파 채널이 없습니다. 투명 PNG 를 그냥 그리면 투명한 자리가
 * 검게 나옵니다. 그래서 캔버스를 흰색으로 먼저 칠하고 그 위에 그립니다.
 * 원형으로 잘려 40px 로 그려지는 얼굴에서 이 차이는 보이지 않습니다.
 *
 * ---------------------------------------------------------------------------
 * EXIF 를 지우기 전에 "회전" 만은 픽셀에 구워 넣습니다
 * ---------------------------------------------------------------------------
 * 세로로 찍은 사진은 대개 가로 픽셀 + `Orientation` EXIF 태그로 저장됩니다.
 * 브라우저가 `<img>` 를 그릴 때는 그 태그를 존중하지만,
 * `createImageBitmap(blob)` 은 **기본값이 무시** 입니다. 그대로 지웠다가는
 * 프로필 사진이 90도 누워서 올라갑니다. 그래서
 * `{ imageOrientation: 'from-image' }` 로 디코드해 회전을 픽셀에 굽고,
 * 그 다음에 메타데이터를 버립니다. (이 옵션을 모르는 낡은 엔진은 옵션 객체를
 * 무시하는데, 그런 엔진은 대개 `createImageBitmap(blob)` 자체가 없어서 아래
 * `<img>` 폴백으로 내려가고 — 그 경로는 브라우저가 회전을 알아서 적용합니다.)
 *
 * ---------------------------------------------------------------------------
 * 실패하면 원본을 올리지 않습니다
 * ---------------------------------------------------------------------------
 * canvas 를 못 쓰거나 파일이 깨졌으면 **실패로 끝냅니다**. 원본 폴백은
 * "대부분의 경우 GPS 가 지워집니다" 라는 뜻이고, 그건 이 파일 전체를
 * 무의미하게 만듭니다. 하필 폴백이 걸리는 사진이 문제의 사진일 수도 있습니다.
 * 대신 사용자가 무엇을 해야 하는지 아는 한국어 문장을 돌려줍니다.
 *
 * 던지지 않고 판별 유니온(`NormalizeResult`)을 돌려줍니다 — 호출부인
 * app/me/page.tsx 는 이미 "실패 메시지를 상태에 담아 화면에 그리는" 모양이고,
 * try/catch 로 그 흐름을 한 번 더 꺾을 이유가 없습니다.
 */

/* ==========================================================================
 * 상수 (화면이 아니라 여기가 출처입니다)
 * ======================================================================== */

/**
 * 긴 변의 상한. 아바타는 실제로 40~64px(CSS)로만 그려집니다. DPR 3 인
 * 휴대폰에서 64px 이면 192 실제 픽셀이므로 512 는 이미 2.6배 여유이고,
 * 나중에 프로필 상단에 크게 한 번 그리게 돼도 버팁니다. 이 값을 더 키우면
 * 얻는 것 없이 파일만 커집니다.
 */
export const AVATAR_MAX_EDGE = 512

/**
 * JPEG 품질. 0.82 는 512px 사진에서 눈에 보이는 열화 없이 대개 40~90KB 로
 * 떨어집니다(2MB 한도의 5% 미만). 더 올리면 용량만 늘고, 더 내리면 그제서야
 * 격자가 보이기 시작합니다.
 */
export const AVATAR_JPEG_QUALITY = 0.82

/** 내보내는 유일한 MIME. 위 "결과 MIME 을 하나로 통일" 절 참고. */
export const NORMALIZED_MIME = 'image/jpeg'

/** `NORMALIZED_MIME` 에 대응하는 유일한 확장자. 0007 의 CHECK 이 허용합니다. */
export const NORMALIZED_EXTENSION = 'jpg'

/**
 * 재인코딩 결과가 이보다 크면 실패입니다. 기본값은 버킷의 `file_size_limit`
 * 과 같은 2MB — 호출부(app/me/page.tsx 의 MAX_UPLOAD_BYTES)와 같은 숫자를
 * 옵션으로 넘겨 주세요. 512px JPEG 이 2MB 를 넘는 일은 사실상 없지만,
 * "넘을 리 없다" 를 근거로 검사를 빼면 넘었을 때 사용자가 보는 건 Storage 의
 * 영어 에러입니다.
 */
export const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024

/* ==========================================================================
 * 타입
 * ======================================================================== */

export type Dimensions = { width: number; height: number }

export type NormalizeOptions = {
  /** 긴 변 상한. 기본 `AVATAR_MAX_EDGE`. */
  maxEdge?: number
  /** JPEG 품질(0~1). 기본 `AVATAR_JPEG_QUALITY`. */
  quality?: number
  /** 결과 허용 최대 바이트. 기본 `DEFAULT_MAX_OUTPUT_BYTES`. */
  maxBytes?: number
  /** 결과 File 의 이름. 경로는 호출부가 따로 만듭니다. 기본 'avatar.jpg'. */
  fileName?: string
}

export type NormalizeResult =
  | {
      ok: true
      /** 항상 image/jpeg. 이 File 을 그대로 Storage 에 올리세요. */
      file: File
      /** 실제로 그려 넣은 픽셀 크기. 로그·디버깅용입니다. */
      width: number
      height: number
      /** 원본 바이트 수. "얼마나 줄었는지" 를 보여 주고 싶을 때 씁니다. */
      originalBytes: number
    }
  | { ok: false; message: string }

/* ==========================================================================
 * 순수 함수 (테스트 대상은 여기입니다)
 * ======================================================================== */

/**
 * 비율을 지키면서 긴 변을 `maxEdge` 이하로 줄인 크기.
 *
 * ★ 잘라내지 않습니다 ★ 정사각으로 크롭하면 화면의 미리보기(원본 objectURL)
 * 와 실제로 올라간 그림이 달라집니다. 사용자가 "고른 것" 과 "올린 것" 이
 * 다르면 그건 버그로 읽힙니다. 원형 마스크는 CSS 가 그릴 때 씌웁니다.
 *
 * ★ 확대하지 않습니다 ★ 이미 작은 사진을 512 로 늘리면 화질은 그대로인데
 * 파일만 커집니다. 그때는 원래 크기 그대로 다시 인코딩만 합니다 — 크기가
 * 안 변해도 EXIF 는 사라지므로 목적은 달성됩니다.
 *
 * 입력이 0 이하이거나 유한하지 않으면(깨진 디코드 결과) `null` 입니다.
 * 던지지 않습니다 — 호출부가 한국어 메시지로 바꿔 돌려줘야 하니까요.
 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number = AVATAR_MAX_EDGE,
): Dimensions | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (!Number.isFinite(maxEdge) || maxEdge < 1) return null
  if (width < 1 || height < 1) return null

  const longest = Math.max(width, height)
  if (longest <= maxEdge) {
    // 확대 금지. 소수점 크기(일부 SVG/벡터 디코드)는 내림해 정수로 맞춥니다.
    return { width: Math.max(1, Math.floor(width)), height: Math.max(1, Math.floor(height)) }
  }

  const scale = maxEdge / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/**
 * 사용자에게 보여 줄 실패 문장들. 화면에서 문자열을 다시 쓰지 말고 이걸
 * 쓰세요 — 같은 실패가 화면마다 다른 문장으로 나가면 문의를 받았을 때
 * 어느 경로였는지 알 수 없습니다.
 *
 * 규칙: (1) 무엇이 안 됐는지 (2) 사용자가 할 수 있는 다음 행동.
 * "원본을 대신 올렸다" 같은 문장은 없습니다 — 그런 동작이 없기 때문입니다.
 */
export const NORMALIZE_MESSAGES = {
  empty: '빈 파일이에요. 다른 사진을 골라 주세요.',
  unsupported:
    '이 브라우저에서는 사진을 처리할 수 없어요. 다른 브라우저나 앱에서 다시 시도해 주세요.',
  decode: '사진을 읽지 못했어요. 파일이 손상됐을 수 있어요. 다른 사진으로 다시 시도해 주세요.',
  encode: '사진을 변환하지 못했어요. 다른 사진으로 다시 시도해 주세요.',
  tooLarge: '사진을 충분히 줄이지 못했어요. 더 작은 사진으로 다시 시도해 주세요.',
} as const

/* ==========================================================================
 * 브라우저 의존 부분
 * ======================================================================== */

type Decoded = {
  source: CanvasImageSource
  width: number
  height: number
  release: () => void
}

/**
 * File → 그릴 수 있는 픽셀.
 *
 * 1순위 `createImageBitmap` — 워커 없이도 메인 스레드를 덜 막고,
 * `imageOrientation: 'from-image'` 로 EXIF 회전을 픽셀에 구울 수 있습니다.
 * 2순위 `<img>` + objectURL — `createImageBitmap` 이 없는 엔진용입니다.
 * 이것도 canvas 로 다시 그리므로 EXIF 는 똑같이 사라집니다(원본 폴백이
 * 아닙니다). 이 경로에서는 브라우저가 회전을 알아서 적용합니다.
 *
 * 둘 다 실패하면 null 입니다.
 */
async function decodeImage(file: File): Promise<Decoded | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      if (bitmap.width > 0 && bitmap.height > 0) {
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          release: () => bitmap.close(),
        }
      }
      bitmap.close()
    } catch {
      // 아래 <img> 경로로 내려갑니다.
    }
  }

  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return null

  const objectUrl = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement | null>((resolve) => {
      const element = new Image()
      // 같은 origin 의 blob: URL 이라 canvas 가 오염되지 않지만, 명시해 둡니다.
      element.crossOrigin = 'anonymous'
      element.decoding = 'async'
      element.onload = () => resolve(element)
      element.onerror = () => resolve(null)
      element.src = objectUrl
    })

    const width = image?.naturalWidth ?? 0
    const height = image?.naturalHeight ?? 0
    if (!image || width < 1 || height < 1) {
      URL.revokeObjectURL(objectUrl)
      return null
    }

    return {
      source: image,
      width,
      height,
      release: () => URL.revokeObjectURL(objectUrl),
    }
  } catch {
    URL.revokeObjectURL(objectUrl)
    return null
  }
}

/** `canvas.toBlob` 을 Promise 로. 콜백이 null 을 줄 수 있습니다(인코더 실패). */
function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), NORMALIZED_MIME, quality)
    } catch {
      resolve(null)
    }
  })
}

/**
 * 업로드 직전에 부르세요. 성공하면 EXIF 없는 image/jpeg File 이 나옵니다.
 *
 *   const normalized = await normalizeAvatarImage(file, { maxBytes: MAX_UPLOAD_BYTES })
 *   if (!normalized.ok) { setPhotoError(normalized.message); return }
 *   // normalized.file.type === 'image/jpeg' 가 보장됩니다
 *
 * 실패는 전부 `{ ok: false, message }` 입니다. **원본을 대신 올리지 않습니다** —
 * 이 파일 머리말의 "실패하면 원본을 올리지 않습니다" 절을 보세요.
 */
export async function normalizeAvatarImage(
  file: File,
  options: NormalizeOptions = {},
): Promise<NormalizeResult> {
  const maxEdge = options.maxEdge ?? AVATAR_MAX_EDGE
  const quality = options.quality ?? AVATAR_JPEG_QUALITY
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const fileName = options.fileName ?? `avatar.${NORMALIZED_EXTENSION}`

  if (!file || file.size === 0) {
    return { ok: false, message: NORMALIZE_MESSAGES.empty }
  }
  // 서버에서 실수로 부른 경우. 던지지 않고 같은 모양으로 실패합니다.
  if (typeof document === 'undefined') {
    return { ok: false, message: NORMALIZE_MESSAGES.unsupported }
  }

  const decoded = await decodeImage(file)
  if (!decoded) {
    return { ok: false, message: NORMALIZE_MESSAGES.decode }
  }

  try {
    const target = fitWithin(decoded.width, decoded.height, maxEdge)
    if (!target) {
      return { ok: false, message: NORMALIZE_MESSAGES.decode }
    }

    const canvas = document.createElement('canvas')
    canvas.width = target.width
    canvas.height = target.height

    // alpha: false — JPEG 에는 어차피 알파가 없고, 불투명 캔버스가 합성도
    // 한 단계 덜 거칩니다.
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) {
      return { ok: false, message: NORMALIZE_MESSAGES.unsupported }
    }

    // 투명 PNG 가 검게 나오지 않도록 흰 바탕을 먼저 깔습니다.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, target.width, target.height)
    // 축소는 대개 크게 일어납니다(4000px → 512px). 보간 품질을 올려 두지
    // 않으면 계단이 눈에 띕니다.
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'

    try {
      ctx.drawImage(decoded.source, 0, 0, target.width, target.height)
    } catch {
      // 디코드는 됐는데 그리기에서 죽는 경우(오염된 캔버스 등).
      return { ok: false, message: NORMALIZE_MESSAGES.decode }
    }

    const blob = await toBlob(canvas, quality)
    // ★ 요청한 타입이 아니라 돌아온 타입을 봅니다 ★ `toBlob` 은 모르는 타입에
    // 조용히 PNG 를 돌려줍니다. 그걸 image/jpeg 라고 이름 붙여 올리면
    // Storage 에 내용과 다른 Content-Type 이 박힙니다.
    if (!blob || blob.size === 0 || blob.type !== NORMALIZED_MIME) {
      return { ok: false, message: NORMALIZE_MESSAGES.encode }
    }
    if (blob.size > maxBytes) {
      return { ok: false, message: NORMALIZE_MESSAGES.tooLarge }
    }

    return {
      ok: true,
      file: new File([blob], fileName, {
        type: NORMALIZED_MIME,
        lastModified: Date.now(),
      }),
      width: target.width,
      height: target.height,
      originalBytes: file.size,
    }
  } finally {
    decoded.release()
  }
}
