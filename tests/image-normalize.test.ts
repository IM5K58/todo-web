import { describe, expect, it } from 'vitest'

import {
  AVATAR_JPEG_QUALITY,
  AVATAR_MAX_EDGE,
  DEFAULT_MAX_OUTPUT_BYTES,
  NORMALIZED_EXTENSION,
  NORMALIZED_MIME,
  NORMALIZE_MESSAGES,
  fitWithin,
  normalizeAvatarImage,
} from '@/lib/image-normalize'

/**
 * tests/image-normalize.test.ts — lib/image-normalize.ts 의 순수 계약.
 *
 * ---------------------------------------------------------------------------
 * 이 파일이 무엇을 막고, 무엇을 막지 않는가
 * ---------------------------------------------------------------------------
 * 막는 것: **치수 계산과 상수 계약**. 아바타 업로드가 조용히 잘못될 수 있는
 * 자리는 세 군데입니다.
 *   (1) 크기 계산이 0 이나 소수를 뱉으면 canvas 가 던지거나 1픽셀 그림이
 *       올라갑니다. 사용자에게는 "사진이 깨졌다" 로만 보입니다.
 *   (2) 비율을 놓치면 얼굴이 늘어납니다. 눌린 얼굴은 버그 리포트가 오지
 *       않고 그냥 사람들이 사진을 안 씁니다.
 *   (3) 결과 MIME/확장자/용량이 0007 의 CHECK · 버킷 설정과 어긋나면 업로드
 *       자체가 서버에서 거부됩니다. 그건 코드가 아니라 **SQL 이 정한 값**이라
 *       여기서 숫자로 못 박아 둡니다.
 *
 * ---------------------------------------------------------------------------
 * canvas 를 모킹하지 않는 이유 (의도적인 공백입니다)
 * ---------------------------------------------------------------------------
 * `normalizeAvatarImage()` 의 본론(디코드 → drawImage → toBlob)은 jsdom 에
 * 없는 브라우저 API 세 개 위에 서 있습니다. jsdom 은 `createImageBitmap` 이
 * 없고, `canvas.getContext('2d')` 는 null 이며, `<img>` 는 src 를 붙여도
 * load/error 를 **아예 발화하지 않습니다**(resources:'usable' 아님). 마지막
 * 것이 특히 나빠서, 폴백 경로를 그대로 부르면 테스트는 실패가 아니라 타임아웃이
 * 됩니다.
 *
 * 그래서 이 셋을 흉내 내려면 가짜 ImageBitmap · 가짜 2D 컨텍스트 · 가짜
 * toBlob(품질에 따라 크기가 변하는 척까지) 을 손으로 만들어야 하고, 그러면
 * **검증하는 것은 우리 코드가 아니라 우리가 쓴 가짜 canvas** 입니다. 진짜
 * 회귀(EXIF 가 남는다, 흰 바탕이 안 깔린다, toBlob 이 PNG 를 돌려준다)는 그
 * 모킹으로는 어차피 안 잡힙니다 — 실제 브라우저에서만 잡힙니다.
 *
 * 대신 브라우저를 건드리기 **전에** 끝나는 분기 하나(빈 파일)는 실제로
 * 부릅니다. 그 분기는 순수하고, "실패해도 원본을 올리지 않는다" 라는 이
 * 모듈의 핵심 약속이 처음 드러나는 자리이기도 합니다.
 */

/* ==========================================================================
 * 1. fitWithin — 축소 계산
 * ======================================================================== */

describe('fitWithin — 긴 변을 상한 이하로, 비율은 유지', () => {
  it('가로가 긴 사진: 긴 변이 정확히 상한이 된다', () => {
    expect(fitWithin(4000, 3000, 512)).toEqual({ width: 512, height: 384 })
  })

  it('세로가 긴 사진: 어느 쪽이 길든 같은 규칙', () => {
    expect(fitWithin(3000, 4000, 512)).toEqual({ width: 384, height: 512 })
  })

  it('정사각은 정사각으로 남는다', () => {
    expect(fitWithin(2048, 2048, 512)).toEqual({ width: 512, height: 512 })
  })

  it('maxEdge 를 생략하면 AVATAR_MAX_EDGE 를 쓴다', () => {
    expect(fitWithin(4000, 2000)).toEqual(fitWithin(4000, 2000, AVATAR_MAX_EDGE))
    expect(Math.max(...Object.values(fitWithin(4000, 2000)!))).toBe(AVATAR_MAX_EDGE)
  })
})

describe('fitWithin — 확대는 하지 않는다', () => {
  /**
   * 작은 사진을 512 로 늘리면 화질은 그대로인데 파일만 커집니다. 크기가 안
   * 변해도 canvas 를 한 번 통과하므로 EXIF 제거라는 목적은 달성됩니다.
   */
  it('상한보다 작으면 그대로 돌려준다', () => {
    expect(fitWithin(120, 80, 512)).toEqual({ width: 120, height: 80 })
  })

  it('긴 변이 상한과 같으면 그대로다 (경계값)', () => {
    expect(fitWithin(512, 300, 512)).toEqual({ width: 512, height: 300 })
  })

  it('1픽셀만 넘으면 그때부터 줄인다 (경계값)', () => {
    const size = fitWithin(513, 513, 512)
    expect(size).toEqual({ width: 512, height: 512 })
  })
})

describe('fitWithin — 결과는 언제나 그릴 수 있는 정수 크기다', () => {
  /**
   * canvas.width 에 소수나 0 을 넣으면 그림이 사라지거나 예외가 납니다.
   * 극단적으로 가느다란 사진(파노라마, 스캔 실패본)이 실제로 그런 값을
   * 만듭니다: 4000×1 을 0.128 배 하면 세로가 0.128 입니다.
   */
  it('아주 가느다란 사진도 최소 1픽셀은 남긴다', () => {
    expect(fitWithin(4000, 1, 512)).toEqual({ width: 512, height: 1 })
    expect(fitWithin(1, 4000, 512)).toEqual({ width: 1, height: 512 })
  })

  it('소수 크기(벡터 디코드)는 내림해서 정수로 맞춘다', () => {
    expect(fitWithin(120.9, 80.4, 512)).toEqual({ width: 120, height: 80 })
  })

  it('1픽셀짜리 원본도 1픽셀로 살아남는다', () => {
    expect(fitWithin(1, 1, 512)).toEqual({ width: 1, height: 1 })
  })

  it('maxEdge 가 1 이어도 0 을 만들지 않는다', () => {
    const size = fitWithin(100, 50, 1)
    expect(size).not.toBeNull()
    expect(size!.width).toBeGreaterThanOrEqual(1)
    expect(size!.height).toBeGreaterThanOrEqual(1)
  })
})

describe('fitWithin — 못 그리는 입력은 null (던지지 않는다)', () => {
  /**
   * 호출부는 이 null 을 한국어 메시지로 바꿔 돌려줍니다. 예외를 던지면
   * 사진 한 장 때문에 마이페이지 전체가 죽습니다.
   */
  const bad: Array<[string, number, number]> = [
    ['0 × n', 0, 100],
    ['n × 0', 100, 0],
    ['음수', -10, 100],
    ['NaN', Number.NaN, 100],
    ['Infinity', Number.POSITIVE_INFINITY, 100],
    ['1픽셀 미만', 0.4, 100],
  ]

  it.each(bad)('%s 는 null 이다', (_label, width, height) => {
    expect(fitWithin(width, height, 512)).toBeNull()
  })

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'maxEdge 가 %p 면 null 이다',
    (maxEdge) => {
      expect(fitWithin(4000, 3000, maxEdge)).toBeNull()
    },
  )
})

describe('fitWithin — 어떤 크기를 넣어도 지켜지는 성질', () => {
  /**
   * 표본은 고정 시드 LCG 로 만듭니다. 매 실행 같은 값이라 실패가 재현됩니다
   * (무작위 표본은 CI 에서 한 번 깨지고 로컬에서 안 깨지는 테스트가 됩니다).
   */
  function* sample(count: number): Generator<[number, number]> {
    let seed = 20260901
    const next = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return (seed % max) + 1
    }
    for (let i = 0; i < count; i += 1) yield [next(6000), next(6000)]
  }

  it('긴 변은 상한을 넘지 않고, 결과는 정수 ≥ 1 이며, 비율이 보존된다', () => {
    for (const [width, height] of sample(300)) {
      const size = fitWithin(width, height, AVATAR_MAX_EDGE)
      expect(size).not.toBeNull()
      const { width: w, height: h } = size!

      expect(Number.isInteger(w)).toBe(true)
      expect(Number.isInteger(h)).toBe(true)
      expect(w).toBeGreaterThanOrEqual(1)
      expect(h).toBeGreaterThanOrEqual(1)
      expect(Math.max(w, h)).toBeLessThanOrEqual(AVATAR_MAX_EDGE)

      // 반올림 때문에 비율이 딱 떨어지지는 않습니다. 허용 오차는 "짧은 변에서
      // 1픽셀" 이고, 512 이하에서 그건 눈에 보이지 않습니다.
      const before = width / height
      const after = w / h
      const tolerance = before * (1 / Math.min(w, h) + 0.001)
      expect(Math.abs(after - before)).toBeLessThanOrEqual(tolerance)
    }
  })

  it('같은 입력은 언제나 같은 출력이다 (숨은 상태 없음)', () => {
    for (const [width, height] of sample(50)) {
      expect(fitWithin(width, height)).toEqual(fitWithin(width, height))
    }
  })
})

/* ==========================================================================
 * 2. 상수 — 0007_profile_and_default_group.sql 과의 계약
 * ======================================================================== */

describe('결과 파일 계약 — SQL 이 정한 값과 어긋나면 업로드가 서버에서 거부된다', () => {
  /**
   * 0007 의 `profiles_avatar_url_shape_chk` 원문(줄 142)에서 그대로 옮긴
   * 정규식입니다. 저장 가능한 모양은 정확히 `<uuid>/<파일명>.(jpg|jpeg|png|webp)`
   * 하나뿐이라, 정규화가 만들어 내는 확장자가 여기 없으면 사진은 올라가도
   * **경로를 저장하는 단계에서** 22023 으로 떨어집니다.
   */
  const AVATAR_PATH_RE =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(jpg|jpeg|png|webp)$/

  const UUID = '11111111-2222-4333-8444-555555555555'

  it('기본 파일명이 0007 의 CHECK 를 통과한다', () => {
    expect(`${UUID}/avatar.${NORMALIZED_EXTENSION}`).toMatch(AVATAR_PATH_RE)
  })

  it('MIME 과 확장자가 서로 맞는다', () => {
    expect(NORMALIZED_MIME).toBe('image/jpeg')
    expect(NORMALIZED_EXTENSION).toBe('jpg')
  })

  it('허용 용량이 avatars 버킷의 file_size_limit(2097152) 이하다', () => {
    // 0007:464 `values ('avatars', 'avatars', true, 2097152, …)`
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBeLessThanOrEqual(2097152)
  })

  it('버킷의 allowed_mime_types 에 들어 있는 타입만 내보낸다', () => {
    // 0007:1104 `{image/jpeg,image/png,image/webp}`
    expect(['image/jpeg', 'image/png', 'image/webp']).toContain(NORMALIZED_MIME)
  })

  it('JPEG 품질은 0 과 1 사이다', () => {
    expect(AVATAR_JPEG_QUALITY).toBeGreaterThan(0)
    expect(AVATAR_JPEG_QUALITY).toBeLessThanOrEqual(1)
  })

  it('상한은 아바타가 실제로 그려지는 크기(≤64 CSS px)보다 넉넉하다', () => {
    expect(AVATAR_MAX_EDGE).toBeGreaterThanOrEqual(64 * 3) // DPR 3
    expect(Number.isInteger(AVATAR_MAX_EDGE)).toBe(true)
  })
})

/* ==========================================================================
 * 3. 실패 메시지 — 화면이 다시 쓰지 않도록
 * ======================================================================== */

describe('NORMALIZE_MESSAGES', () => {
  const messages = Object.values(NORMALIZE_MESSAGES)

  it('전부 비어 있지 않은 한국어 문장이다', () => {
    for (const message of messages) {
      expect(message.trim().length).toBeGreaterThan(0)
      expect(message).toMatch(/[가-힣]/)
    }
  })

  it('서로 다른 문장이다 — 같으면 어느 경로에서 실패했는지 알 수 없다', () => {
    expect(new Set(messages).size).toBe(messages.length)
  })

  it('"원본을 대신 올렸다" 는 약속을 하지 않는다', () => {
    for (const message of messages) {
      expect(message).not.toMatch(/원본/)
    }
  })
})

/* ==========================================================================
 * 4. normalizeAvatarImage — 브라우저를 건드리기 전에 끝나는 분기만
 * ======================================================================== */

describe('normalizeAvatarImage — 빈 파일', () => {
  /**
   * 이 분기는 디코더도 canvas 도 부르지 않으므로 jsdom 에서 그대로 돌아갑니다.
   * (그 뒤 경로를 왜 여기서 다루지 않는지는 이 파일 머리말 참고.)
   */
  it('크기 0 인 파일은 실패하고, 원본을 돌려주지 않는다', async () => {
    const result = await normalizeAvatarImage(new File([], 'empty.png', { type: 'image/png' }))

    expect(result.ok).toBe(false)
    expect(result).toEqual({ ok: false, message: NORMALIZE_MESSAGES.empty })
    expect(result).not.toHaveProperty('file')
  })
})
