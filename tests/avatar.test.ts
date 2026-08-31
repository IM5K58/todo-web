import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_AVATAR_EMOJI,
  avatarAltText,
  googlePhotoUrl,
  resolveAvatar,
  storagePublicUrl,
} from '@/lib/avatar'
import type { AvatarInput, ResolvedAvatar } from '@/lib/avatar'

/**
 * tests/avatar.test.ts — lib/avatar.ts 의 3단계 우선순위와 URL 검증 계약.
 *
 * ---------------------------------------------------------------------------
 * 이 파일이 막는 고장은 "사람마다 다른 아바타를 본다" 입니다
 * ---------------------------------------------------------------------------
 * 아바타는 홈 헤더, /status 의 멤버 목록, /groups 의 그룹원 목록, /me 의 미리보기
 * 네 군데에 나옵니다. 우선순위 규칙을 화면마다 손으로 다시 쓰면 — 그리고 그건
 * 이 저장소에서 이미 한 번 일어났습니다(`weekdayOf` 가 세 벌 복사돼 있습니다,
 * tests/templates.test.ts 참고) — 어긋나도 아무도 모릅니다. 예외도 로그도
 * 없이 그냥 A 화면에서는 사진이, B 화면에서는 이모지가 보입니다.
 *
 * 그래서 여기서 못 박는 것은 "resolveAvatar 가 잘 돈다" 가 아니라
 * **"우선순위가 정확히 이 순서이고, 각 단계가 비어 있다고 판정하는 기준이
 * 정확히 이것이다"** 입니다. 화면이 이 함수 대신 `profile.avatar_url ?? ...`
 * 를 직접 쓰기 시작하면 이 파일은 그걸 잡아 주지 못하지만, 적어도 규칙 자체가
 * 조용히 바뀌는 것은 잡습니다.
 *
 *   1) profiles.avatar_url          (업로드한 사진 / 저장된 절대 URL)
 *   2) auth user_metadata 의 사진   (구글 로그인 사진)
 *   3) profiles.avatar_emoji        (없으면 DEFAULT_AVATAR_EMOJI)
 *
 * ---------------------------------------------------------------------------
 * "비어 있다" 의 정의가 이 파일의 절반입니다
 * ---------------------------------------------------------------------------
 * null 만 검사하면 안 됩니다. 실제로 들어오는 값은 네 가지 모양입니다:
 *
 *   · null            — 컬럼 DEFAULT, 아직 설정 안 함
 *   · undefined       — 컬럼을 select 하지 않은 조회 경로(profiles 는 컬럼 단위
 *                       grant 라 화면마다 고르는 컬럼이 다릅니다)
 *   · ''              — 폼이 빈 값을 저장한 경우
 *   · '   ' / '\n\t ' — 붙여넣기 사고. `?? '🙂'` 는 이걸 통과시킵니다.
 *
 * 마지막 것이 제일 위험합니다: 공백만 있는 avatar_url 을 "있음" 으로 보면
 * kind='image' 에 src='   ' 가 나가고, 브라우저는 **현재 페이지 URL** 을 다시
 * 요청합니다. 아바타 자리마다 페이지 하나씩 다시 받는 셈입니다.
 *
 * ---------------------------------------------------------------------------
 * 모킹 방침 — 없습니다
 * ---------------------------------------------------------------------------
 * lib/avatar.ts 는 next/headers 도 supabase 도 import 하지 않습니다. 유일한
 * 외부 의존은 `process.env.NEXT_PUBLIC_SUPABASE_URL` 이고 그것도 호출 시점에
 * 읽으므로, 환경변수를 세워 두고 되돌리는 것 말고는 대역이 한 줄도 없습니다.
 * 그래서 여기서 도는 코드는 전부 진짜 구현입니다.
 */

/* ==========================================================================
 * 환경변수 — 호출 시점에 읽히므로 테스트마다 세우고 되돌립니다
 *
 * vitest 는 .env.local 을 process.env 로 옮겨 주지 않습니다(그건 Vite 의
 * import.meta.env 쪽 이야기입니다). 그래서 값이 있다고 가정하지 않고 매번
 * 명시적으로 세웁니다 — 개발자 로컬에 무엇이 있든 결과가 같아야 합니다.
 * ======================================================================== */

/** 실제 프로젝트 URL 모양. 'https://x' 같은 자리표시자는 조립 결과를 못 읽습니다. */
const SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co'

/** storagePublicUrl 이 붙이는 공개 객체 경로 접두사(lib/avatar.ts 의 사본). */
const PUBLIC_PREFIX = '/storage/v1/object/public/'

let originalSupabaseUrl: string | undefined

beforeEach(() => {
  originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL
})

afterEach(() => {
  if (originalSupabaseUrl === undefined) {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
  } else {
    process.env.NEXT_PUBLIC_SUPABASE_URL = originalSupabaseUrl
  }
})

/* ==========================================================================
 * 픽스처
 * ======================================================================== */

/** 구글이 실제로 주는 모양(=s96-c 크기 힌트까지). */
const GOOGLE_PHOTO = 'https://lh3.googleusercontent.com/a/ACg8ocK0v1QeXaMpLe=s96-c'

/** 업로드한 파일이 avatar_url 에 저장되는 모양: 버킷 이름 + 경로. */
const UPLOAD_PATH = 'avatars/8f14e45f-ea8f-4b7e-9c1f-000000000001.jpg'

/** 위 경로가 조립되면 나와야 하는 공개 URL. 손으로 적어 둡니다(구현으로 만들지 않음). */
const UPLOAD_PUBLIC_URL = `${SUPABASE_URL}${PUBLIC_PREFIX}${UPLOAD_PATH}`

/**
 * 값이 비어 있다고 판정되어야 하는 모든 모양.
 *
 * `undefined` 는 배열에 넣지 않고 별도 테스트로 둡니다 — 프로퍼티를 아예
 * 생략한 경우와 명시적 undefined 를 구분해서 보고 싶기 때문입니다.
 */
const BLANKS: Array<string | null> = ['', ' ', '   ', '\t', '\n', ' \n\t ', null]

/** 사람이 읽을 이름표. 실패 메시지에 '\n' 이 그대로 찍히면 어느 케이스인지 모릅니다. */
function blankLabel(value: string | null): string {
  if (value === null) return 'null'
  if (value === '') return "'' (빈 문자열)"
  return `${JSON.stringify(value)} (공백만)`
}

/* ==========================================================================
 * 1. 상수
 * ======================================================================== */

describe('DEFAULT_AVATAR_EMOJI — 컬럼 DEFAULT 와 같은 글자여야 한다', () => {
  it("0001_init.sql 의 avatar_emoji DEFAULT '🙂' 와 일치한다", () => {
    // 이 값이 갈라지면 "프로필을 아직 안 만든 사람" 이 화면마다 다르게 보입니다.
    // (app/page.tsx / app/onboarding/page.tsx / lib/tasks.ts 가 같은 글자를 씁니다.)
    expect(DEFAULT_AVATAR_EMOJI).toBe('🙂')
  })

  it('비어 있지 않다 — 이게 마지막 폴백이라 빈 문자열이면 화면에 아무것도 안 남는다', () => {
    expect(DEFAULT_AVATAR_EMOJI.trim().length).toBeGreaterThan(0)
  })
})

/* ==========================================================================
 * 2. resolveAvatar — 3단계 우선순위 (이 파일의 본론)
 * ======================================================================== */

describe('resolveAvatar — 우선순위 1: 업로드한 사진이 다른 둘을 이긴다', () => {
  it('★ 셋 다 있으면 avatar_url 이 이긴다 ★', () => {
    const avatar = resolveAvatar({
      avatarUrl: UPLOAD_PATH,
      userMetadata: { avatar_url: GOOGLE_PHOTO },
      avatarEmoji: '🐱',
    })
    expect(avatar.kind).toBe('image')
    expect(avatar.imageUrl).toBe(UPLOAD_PUBLIC_URL)
    expect(avatar.source).toBe('upload')
    expect(avatar.imageUrl).not.toBe(GOOGLE_PHOTO)
  })

  it('avatar_url 에 절대 URL 이 저장돼 있어도 그대로 1순위다', () => {
    // 스키마 계약: avatar_url 은 "Storage 경로 또는 구글 사진 URL" 둘 다 담습니다.
    const stored = 'https://cdn.example.com/me.png'
    const avatar = resolveAvatar({
      avatarUrl: stored,
      userMetadata: { avatar_url: GOOGLE_PHOTO },
      avatarEmoji: '🐱',
    })
    expect(avatar.imageUrl).toBe(stored)
    expect(avatar.source).toBe('upload')
  })

  it('사진을 쓰더라도 emoji 는 함께 채워진다 — onError 로 되돌아갈 자리가 필요하다', () => {
    const avatar = resolveAvatar({ avatarUrl: UPLOAD_PATH, avatarEmoji: '🐱' })
    expect(avatar.kind).toBe('image')
    expect(avatar.emoji).toBe('🐱')
  })
})

describe('resolveAvatar — 우선순위 2: 사진이 없으면 구글 사진', () => {
  it('avatar_url 이 없으면 user_metadata 의 사진을 쓴다', () => {
    const avatar = resolveAvatar({
      avatarUrl: null,
      userMetadata: { avatar_url: GOOGLE_PHOTO },
      avatarEmoji: '🐱',
    })
    expect(avatar.kind).toBe('image')
    expect(avatar.imageUrl).toBe(GOOGLE_PHOTO)
    expect(avatar.source).toBe('google')
  })

  it('구글 사진을 쓸 때도 emoji 는 함께 채워진다', () => {
    const avatar = resolveAvatar({ userMetadata: { picture: GOOGLE_PHOTO }, avatarEmoji: '🐱' })
    expect(avatar.source).toBe('google')
    expect(avatar.emoji).toBe('🐱')
  })

  it('구글 사진은 조립되지 않고 원본 그대로 나간다 (Storage 경로가 아니다)', () => {
    const avatar = resolveAvatar({ userMetadata: { avatar_url: GOOGLE_PHOTO } })
    expect(avatar.imageUrl).toBe(GOOGLE_PHOTO)
    expect(avatar.imageUrl).not.toContain(SUPABASE_URL)
  })
})

describe('resolveAvatar — 우선순위 3: 둘 다 없으면 이모지', () => {
  it('사진이 하나도 없으면 avatar_emoji 를 쓴다', () => {
    const avatar = resolveAvatar({ avatarUrl: null, userMetadata: null, avatarEmoji: '🐱' })
    expect(avatar.kind).toBe('emoji')
    expect(avatar.imageUrl).toBeNull()
    expect(avatar.emoji).toBe('🐱')
    expect(avatar.source).toBe('emoji')
  })

  it('★ 입력이 통째로 비어 있어도 빈 화면이 되지 않는다 — 최종 폴백은 🙂 ★', () => {
    const avatar = resolveAvatar({})
    expect(avatar).toEqual({
      kind: 'emoji',
      imageUrl: null,
      emoji: DEFAULT_AVATAR_EMOJI,
      source: 'emoji',
    })
  })

  it('모든 값이 명시적 null 이어도 던지지 않고 최종 폴백으로 간다', () => {
    const avatar = resolveAvatar({ avatarUrl: null, userMetadata: null, avatarEmoji: null })
    expect(avatar.emoji).toBe(DEFAULT_AVATAR_EMOJI)
    expect(avatar.kind).toBe('emoji')
  })

  it('kind 가 emoji 면 imageUrl 은 언제나 null (빈 문자열이 아니다)', () => {
    // src='' 는 브라우저가 현재 페이지를 다시 요청하게 만듭니다. null 이어야
    // 화면이 <img> 자체를 그리지 않는 분기로 갑니다.
    const avatar = resolveAvatar({ avatarEmoji: '🐱' })
    expect(avatar.imageUrl).toBeNull()
    expect(avatar.imageUrl).not.toBe('')
  })
})

/* ==========================================================================
 * 3. 각 단계의 "비어 있음" — null / '' / 공백만
 *
 * 여기가 조용히 어긋나는 자리입니다. `?? ` 하나로 처리하면 ''와 '   ' 가
 * 전부 "있음" 이 됩니다.
 * ======================================================================== */

describe('resolveAvatar — 1단계가 비었다고 볼 값들', () => {
  for (const blank of BLANKS) {
    it(`avatarUrl 이 ${blankLabel(blank)} 이면 구글 사진으로 내려간다`, () => {
      const avatar = resolveAvatar({
        avatarUrl: blank,
        userMetadata: { avatar_url: GOOGLE_PHOTO },
        avatarEmoji: '🐱',
      })
      expect(avatar.source).toBe('google')
      expect(avatar.imageUrl).toBe(GOOGLE_PHOTO)
    })
  }

  it('avatarUrl 프로퍼티를 아예 생략해도 같다', () => {
    const avatar = resolveAvatar({ userMetadata: { avatar_url: GOOGLE_PHOTO } })
    expect(avatar.source).toBe('google')
  })

  it('avatarUrl 이 명시적 undefined 여도 같다', () => {
    const avatar = resolveAvatar({
      avatarUrl: undefined,
      userMetadata: { avatar_url: GOOGLE_PHOTO },
    })
    expect(avatar.source).toBe('google')
  })

  it('★ 공백만 있는 avatar_url 이 src 로 새어 나가지 않는다 ★', () => {
    // 새어 나가면 <img src="   "> 가 되고, 브라우저는 현재 페이지 URL 을 다시
    // 요청합니다. 아바타 개수만큼 페이지를 더 받습니다.
    const avatar = resolveAvatar({ avatarUrl: '   ', avatarEmoji: '🐱' })
    expect(avatar.kind).toBe('emoji')
    expect(avatar.imageUrl).toBeNull()
  })

  it('앞뒤 공백이 붙은 진짜 경로는 다듬어서 쓴다 (버리지 않는다)', () => {
    const avatar = resolveAvatar({ avatarUrl: `  ${UPLOAD_PATH}  ` })
    expect(avatar.source).toBe('upload')
    expect(avatar.imageUrl).toBe(UPLOAD_PUBLIC_URL)
  })
})

describe('resolveAvatar — 2단계가 비었다고 볼 값들', () => {
  for (const blank of BLANKS) {
    it(`user_metadata 의 사진이 ${blankLabel(blank)} 이면 이모지로 내려간다`, () => {
      const avatar = resolveAvatar({
        userMetadata: { avatar_url: blank },
        avatarEmoji: '🐱',
      })
      expect(avatar.kind).toBe('emoji')
      expect(avatar.source).toBe('emoji')
      expect(avatar.emoji).toBe('🐱')
    })
  }

  it('user_metadata 자체가 없어도(생략/undefined/null) 던지지 않는다', () => {
    expect(resolveAvatar({ avatarEmoji: '🐱' }).source).toBe('emoji')
    expect(resolveAvatar({ userMetadata: undefined, avatarEmoji: '🐱' }).source).toBe('emoji')
    expect(resolveAvatar({ userMetadata: null, avatarEmoji: '🐱' }).source).toBe('emoji')
  })

  it('빈 객체 {} 는 "사진 없음" 이다', () => {
    expect(resolveAvatar({ userMetadata: {}, avatarEmoji: '🐱' }).source).toBe('emoji')
  })

  it('구글 사진 앞뒤 공백은 다듬어서 쓴다', () => {
    const avatar = resolveAvatar({ userMetadata: { picture: `\n  ${GOOGLE_PHOTO}\t` } })
    expect(avatar.imageUrl).toBe(GOOGLE_PHOTO)
    expect(avatar.source).toBe('google')
  })
})

describe('resolveAvatar — 3단계가 비었다고 볼 값들', () => {
  for (const blank of BLANKS) {
    it(`avatarEmoji 가 ${blankLabel(blank)} 이면 DEFAULT_AVATAR_EMOJI 로 채운다`, () => {
      const avatar = resolveAvatar({ avatarEmoji: blank })
      expect(avatar.emoji).toBe(DEFAULT_AVATAR_EMOJI)
      expect(avatar.emoji.trim()).not.toBe('')
    })
  }

  it('avatarEmoji 를 생략하거나 undefined 로 줘도 기본값이 들어간다', () => {
    expect(resolveAvatar({}).emoji).toBe(DEFAULT_AVATAR_EMOJI)
    expect(resolveAvatar({ avatarEmoji: undefined }).emoji).toBe(DEFAULT_AVATAR_EMOJI)
  })

  it('★ 사진을 쓰는 경우에도 emoji 가 절대 비지 않는다 ★', () => {
    // 사진 로딩이 실패하면 화면은 emoji 로 되돌아갑니다. 여기가 비면 그 순간
    // 아바타 자리가 통째로 사라집니다.
    for (const blank of BLANKS) {
      const uploaded = resolveAvatar({ avatarUrl: UPLOAD_PATH, avatarEmoji: blank })
      const google = resolveAvatar({
        userMetadata: { avatar_url: GOOGLE_PHOTO },
        avatarEmoji: blank,
      })
      expect(uploaded.emoji).toBe(DEFAULT_AVATAR_EMOJI)
      expect(google.emoji).toBe(DEFAULT_AVATAR_EMOJI)
    }
  })

  it('이모지가 아닌 글자(한 글자 이름표)도 그대로 존중한다 — 검열하지 않는다', () => {
    // 길이/내용 검증은 DB CHECK(profiles_avatar_emoji_len_chk)과
    // app/onboarding/actions.ts 의 몫입니다. 여기서 다시 판단하면 두 곳이
    // 어긋난 날 화면이 조용히 기본 이모지로 바뀝니다.
    expect(resolveAvatar({ avatarEmoji: '민' }).emoji).toBe('민')
    expect(resolveAvatar({ avatarEmoji: '👨‍👩‍👧‍👦' }).emoji).toBe('👨‍👩‍👧‍👦')
  })
})

/* ==========================================================================
 * 4. googlePhotoUrl — 메타데이터의 키를 훑는다
 *
 * ★ 이 키 목록은 lib/avatar.ts 의 PHOTO_KEYS 사본입니다 ★ 그 상수는 export 되지
 * 않으므로 여기 손으로 적습니다. 목록이 갈라지면 아래 순서 테스트가 깨집니다 —
 * 그게 이 사본이 존재하는 이유입니다.
 * ======================================================================== */

const PHOTO_KEYS = ['avatar_url', 'picture', 'photoURL', 'profile_image_url'] as const

describe('googlePhotoUrl — 어느 키에 들어 있어도 잡는다', () => {
  for (const key of PHOTO_KEYS) {
    it(`'${key}' 키 하나만 있어도 찾는다`, () => {
      expect(googlePhotoUrl({ [key]: GOOGLE_PHOTO })).toBe(GOOGLE_PHOTO)
    })
  }

  it('키 우선순위: avatar_url > picture > photoURL > profile_image_url', () => {
    // Supabase 가 채우는 avatar_url 이 먼저입니다. 제공자를 바꿔도 이름이
    // 유지되는 쪽이기 때문입니다.
    const all = {
      avatar_url: 'https://example.com/1.png',
      picture: 'https://example.com/2.png',
      photoURL: 'https://example.com/3.png',
      profile_image_url: 'https://example.com/4.png',
    }
    expect(googlePhotoUrl(all)).toBe('https://example.com/1.png')

    const { avatar_url: _a, ...noAvatarUrl } = all
    expect(googlePhotoUrl(noAvatarUrl)).toBe('https://example.com/2.png')

    const { picture: _p, ...noPicture } = noAvatarUrl
    expect(googlePhotoUrl(noPicture)).toBe('https://example.com/3.png')

    const { photoURL: _ph, ...onlyLast } = noPicture
    expect(googlePhotoUrl(onlyLast)).toBe('https://example.com/4.png')
  })

  it('앞 키가 못 쓸 값이면 건너뛰고 다음 키를 본다 (거기서 멈추지 않는다)', () => {
    expect(googlePhotoUrl({ avatar_url: '   ', picture: GOOGLE_PHOTO })).toBe(GOOGLE_PHOTO)
    expect(googlePhotoUrl({ avatar_url: null, picture: GOOGLE_PHOTO })).toBe(GOOGLE_PHOTO)
    expect(googlePhotoUrl({ avatar_url: 42, picture: GOOGLE_PHOTO })).toBe(GOOGLE_PHOTO)
  })

  it('★ 우리가 훑지 않는 키는 잡지 않는다 — 조용히 넓어지면 계약이 아니다 ★', () => {
    // 목록을 늘리려면 lib/avatar.ts 의 PHOTO_KEYS 와 위 사본을 함께 고쳐야
    // 합니다. 이 테스트가 그 강제 장치입니다.
    expect(googlePhotoUrl({ avatarUrl: GOOGLE_PHOTO })).toBeNull()
    expect(googlePhotoUrl({ image: GOOGLE_PHOTO })).toBeNull()
    expect(googlePhotoUrl({ profile_picture: GOOGLE_PHOTO })).toBeNull()
    expect(googlePhotoUrl({ AVATAR_URL: GOOGLE_PHOTO })).toBeNull()
  })
})

describe('googlePhotoUrl — 스키마 없는 값에 던지지 않는다', () => {
  it('메타데이터가 객체가 아니면 null (타입이 아무것도 보증하지 않는다)', () => {
    // @supabase/auth-js 의 UserMetadata 는 { [key: string]: any } 입니다.
    expect(googlePhotoUrl(null)).toBeNull()
    expect(googlePhotoUrl(undefined)).toBeNull()
    expect(googlePhotoUrl('https://example.com/x.png')).toBeNull()
    expect(googlePhotoUrl(123)).toBeNull()
    expect(googlePhotoUrl(true)).toBeNull()
  })

  it('배열이 와도 던지지 않고 null', () => {
    expect(() => googlePhotoUrl([GOOGLE_PHOTO])).not.toThrow()
    expect(googlePhotoUrl([GOOGLE_PHOTO])).toBeNull()
  })

  it('값이 문자열이 아니면(제공자가 객체를 넣는 경우) 그 키는 없는 셈 친다', () => {
    expect(googlePhotoUrl({ avatar_url: { url: GOOGLE_PHOTO } })).toBeNull()
    expect(googlePhotoUrl({ avatar_url: [GOOGLE_PHOTO] })).toBeNull()
    expect(googlePhotoUrl({ avatar_url: 0 })).toBeNull()
    expect(googlePhotoUrl({ avatar_url: false })).toBeNull()
  })

  it('프로토타입이 없는 객체(Object.create(null))도 읽는다', () => {
    const bag = Object.create(null) as Record<string, unknown>
    bag.picture = GOOGLE_PHOTO
    expect(googlePhotoUrl(bag)).toBe(GOOGLE_PHOTO)
  })
})

/* ==========================================================================
 * 5. 사용자 입력이 그대로 <img src> 로 나가지 않는가
 *
 * avatar_url 은 set_avatar() RPC 로 사용자가 값을 정하는 컬럼입니다. 스키마
 * 계약상 그 RPC 가 검증하는 것은 **길이 상한뿐**입니다. 그러니 스킴 검사는
 * 여기가 마지막 관문입니다.
 * ======================================================================== */

/** 위험한 스킴들. 프로토콜 상대 URL 은 브라우저마다 파싱이 달라 같이 봅니다. */
const DANGEROUS = [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  '//evil.example.com/x.png',
]

describe('안전성 — 위험한 스킴이 imageUrl 로 나가지 않는다', () => {
  for (const bad of DANGEROUS) {
    it(`구글 메타데이터의 ${JSON.stringify(bad.slice(0, 28))} 는 무시된다`, () => {
      // user_metadata 는 본인이 updateUser({ data }) 로 바꿀 수 있습니다.
      // 그대로 믿으면 자기 화면에 임의 스킴을 렌더하는 통로가 생깁니다.
      const avatar = resolveAvatar({ userMetadata: { avatar_url: bad }, avatarEmoji: '🐱' })
      expect(avatar.kind).toBe('emoji')
      expect(avatar.imageUrl).toBeNull()
    })
  }

  it('avatar_url 에 프로토콜 상대 URL 이 들어와도 이미지로 쓰지 않는다', () => {
    // '//evil.example.com/x.png' 는 현재 스킴을 그대로 따라가므로 https 검사를
    // 통과한 것처럼 보이는 고전적인 우회 자리입니다.
    const avatar = resolveAvatar({ avatarUrl: '//evil.example.com/x.png', avatarEmoji: '🐱' })
    expect(avatar.kind).toBe('emoji')
    expect(avatar.imageUrl).toBeNull()
    expect(storagePublicUrl('//evil.example.com/x.png')).toBeNull()
  })

  it('★ avatar_url 의 javascript: 는 절대 스킴으로 나가지 않는다 ★', () => {
    const avatar = resolveAvatar({ avatarUrl: 'javascript:alert(1)' })
    // 경로처럼 취급되어 인코딩된 채 Storage URL 안으로 들어갑니다(깨진 이미지).
    // 어느 쪽이든 지켜야 하는 것은 하나입니다: 결과가 javascript: 로 시작하지 않는다.
    expect(avatar.imageUrl ?? '').not.toMatch(/^javascript:/i)
    expect(avatar.imageUrl ?? '').not.toContain('javascript:')
  })

  it('imageUrl 은 언제나 https:// 이거나 앱 절대 경로(/...)다', () => {
    const cases: AvatarInput[] = [
      { avatarUrl: UPLOAD_PATH },
      { avatarUrl: 'javascript:alert(1)' },
      { avatarUrl: '/local/pic.png' },
      { userMetadata: { avatar_url: GOOGLE_PHOTO } },
      { userMetadata: { picture: '/local/pic.png' } },
    ]
    for (const input of cases) {
      const url = resolveAvatar(input).imageUrl
      if (url === null) continue
      expect(url.startsWith('https://') || url.startsWith('http://') || url.startsWith('/')).toBe(
        true,
      )
      expect(url.startsWith('//')).toBe(false)
    }
  })

  it('★ 경로 조각은 인코딩된다 — 쿼리/프래그먼트를 밀어 넣을 수 없다 ★', () => {
    const injected = storagePublicUrl('avatars/x.jpg?download=1#frag')
    expect(injected).toBe(`${SUPABASE_URL}${PUBLIC_PREFIX}avatars/x.jpg%3Fdownload%3D1%23frag`)
    expect(injected).not.toContain('?')
    expect(injected).not.toContain('#')
  })

  it('한글·공백이 든 파일명도 인코딩되어 URL 을 깨뜨리지 않는다', () => {
    expect(storagePublicUrl('avatars/내 사진.png')).toBe(
      `${SUPABASE_URL}${PUBLIC_PREFIX}avatars/%EB%82%B4%20%EC%82%AC%EC%A7%84.png`,
    )
  })

  it('구분자 / 는 인코딩되지 않는다 (조각 단위로만 인코딩한다)', () => {
    expect(storagePublicUrl('avatars/2026/08/me.jpg')).toBe(
      `${SUPABASE_URL}${PUBLIC_PREFIX}avatars/2026/08/me.jpg`,
    )
  })
})

/* ==========================================================================
 * 6. storagePublicUrl — 경로 조립의 나머지 계약
 * ======================================================================== */

describe('storagePublicUrl — 무엇을 그대로 두고 무엇을 조립하는가', () => {
  it('빈 값은 전부 null', () => {
    for (const blank of [...BLANKS, undefined]) {
      expect(storagePublicUrl(blank)).toBeNull()
    }
  })

  it('이미 절대 URL 이면 그대로 돌려준다 (다시 조립하지 않는다)', () => {
    expect(storagePublicUrl(GOOGLE_PHOTO)).toBe(GOOGLE_PHOTO)
    expect(storagePublicUrl('http://example.com/a.png')).toBe('http://example.com/a.png')
    expect(storagePublicUrl('HTTPS://example.com/a.png')).toBe('HTTPS://example.com/a.png')
  })

  it('버킷 이름을 포함한 경로를 공개 URL 로 조립한다', () => {
    expect(storagePublicUrl(UPLOAD_PATH)).toBe(UPLOAD_PUBLIC_URL)
  })

  it('★ 앞에 / 가 붙으면 Storage 경로가 아니라 "앱 절대 경로" 로 본다 ★', () => {
    // 이게 실제 동작입니다. `/avatars/x.jpg` 는 조립되지 않고 그대로 나가고,
    // 브라우저는 그걸 **우리 도메인**에서 찾습니다(= 404, 깨진 아바타).
    //
    // 업로드 화면이 Storage 경로를 저장할 때 앞의 / 를 붙이면 안 됩니다.
    // 'avatars/x.jpg' 가 맞고 '/avatars/x.jpg' 는 틀립니다. 함수가 고쳐 주지
    // 않으므로(그럴 수 없습니다 — 로컬 자산 경로와 구분이 안 됩니다) 저장하는
    // 쪽이 지켜야 하는 계약입니다.
    expect(storagePublicUrl(`/${UPLOAD_PATH}`)).toBe(`/${UPLOAD_PATH}`)
    expect(storagePublicUrl(`/${UPLOAD_PATH}`)).not.toContain(SUPABASE_URL)
  })

  it('슬래시 없는 경로만 조립된다 — 그리고 슬래시가 겹치지 않는다', () => {
    const url = storagePublicUrl(UPLOAD_PATH)
    expect(url).toBe(UPLOAD_PUBLIC_URL)
    expect(url).not.toContain('public//')
    expect(url).not.toContain('.co//')
  })

  it('base 의 꼬리 슬래시를 정리한다', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = `${SUPABASE_URL}///`
    expect(storagePublicUrl(UPLOAD_PATH)).toBe(UPLOAD_PUBLIC_URL)
  })

  it('공개 URL 의 경로 부분만 들고 있으면 base 를 앞에 붙인다 (이중 인코딩하지 않는다)', () => {
    const pathOnly = `${PUBLIC_PREFIX}avatars/me.jpg`
    expect(storagePublicUrl(pathOnly)).toBe(`${SUPABASE_URL}${pathOnly}`)
  })

  it('★ 이미 인코딩된 값을 또 인코딩한다 — 저장할 때는 날 것의 경로를 넣으세요 ★', () => {
    // 계약을 못 박아 둡니다. 업로드 화면이 encodeURIComponent 한 경로를 저장하면
    // %20 이 %2520 이 되어 404 가 납니다. 조용히 고쳐 주지 않습니다.
    expect(storagePublicUrl('avatars/a%20b.jpg')).toBe(
      `${SUPABASE_URL}${PUBLIC_PREFIX}avatars/a%2520b.jpg`,
    )
  })

  it('그 밖의 앱 절대 경로(/...)는 그대로 둔다 — 로컬 자산도 아바타가 될 수 있다', () => {
    expect(storagePublicUrl('/icons/default.png')).toBe('/icons/default.png')
  })
})

describe('storagePublicUrl — NEXT_PUBLIC_SUPABASE_URL 이 없을 때', () => {
  it('던지지 않는다 — 아바타 하나 때문에 화면이 죽으면 안 된다', () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    expect(() => storagePublicUrl(UPLOAD_PATH)).not.toThrow()
  })

  it('조립할 수 없으면 null 을 주고, resolveAvatar 는 폴백으로 내려간다', () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    expect(storagePublicUrl(UPLOAD_PATH)).toBeNull()

    const avatar = resolveAvatar({
      avatarUrl: UPLOAD_PATH,
      userMetadata: { avatar_url: GOOGLE_PHOTO },
      avatarEmoji: '🐱',
    })
    expect(avatar.source).toBe('google')
    expect(avatar.imageUrl).toBe(GOOGLE_PHOTO)
  })

  it('구글 사진도 없으면 이모지까지 내려간다 (빈 화면 금지)', () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    const avatar = resolveAvatar({ avatarUrl: UPLOAD_PATH, avatarEmoji: '🐱' })
    expect(avatar.kind).toBe('emoji')
    expect(avatar.emoji).toBe('🐱')
  })

  it('빈 문자열 env 도 "없음" 으로 본다', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = '   '
    expect(storagePublicUrl(UPLOAD_PATH)).toBeNull()
  })

  it('env 가 없어도 절대 URL 은 여전히 통과한다 (조립이 필요 없다)', () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    expect(storagePublicUrl(GOOGLE_PHOTO)).toBe(GOOGLE_PHOTO)
    expect(resolveAvatar({ avatarUrl: GOOGLE_PHOTO }).source).toBe('upload')
  })
})

/* ==========================================================================
 * 7. avatarAltText — 이름을 두 번 읽어 주지 않는다
 * ======================================================================== */

describe('avatarAltText', () => {
  it('이름이 글자로 함께 보이면 alt 는 빈 문자열이다 (기본값)', () => {
    // 여기서 "민수님의 프로필 사진" 을 넣으면 스크린리더가 이름을 두 번 읽습니다.
    expect(avatarAltText('민수')).toBe('')
    expect(avatarAltText('민수', true)).toBe('')
  })

  it('아바타만 있는 자리에서는 이름을 읽어 준다', () => {
    expect(avatarAltText('민수', false)).toBe('민수님의 프로필 사진')
  })

  it('이름이 무엇이든 한국어 문장이 나온다 (영어가 새지 않는다)', () => {
    expect(avatarAltText('Alex', false)).toBe('Alex님의 프로필 사진')
    expect(avatarAltText('Alex', false)).toMatch(/[가-힣]/)
  })
})

/* ==========================================================================
 * 8. 불변식 — 화면이 무엇을 넘기든 항상 성립해야 하는 것들
 *
 * 위 테스트들이 "어떤 입력이면 어떤 결과" 를 못 박는다면, 여기는 "어떤 입력이든
 * 결과가 이 모양을 벗어나지 않는다" 를 봅니다. 새 소스(카카오 사진 등)를
 * 추가하다 imageUrl 을 빈 문자열로 두거나 emoji 를 비우는 사고를 잡습니다.
 * ======================================================================== */

describe('resolveAvatar — 어떤 입력에도 깨지지 않는 모양', () => {
  const WILD: AvatarInput[] = [
    {},
    { avatarUrl: null, userMetadata: null, avatarEmoji: null },
    { avatarUrl: '   ', userMetadata: '   ', avatarEmoji: '   ' },
    { avatarUrl: UPLOAD_PATH },
    { avatarUrl: GOOGLE_PHOTO },
    { avatarUrl: 'javascript:alert(1)' },
    { avatarUrl: '//evil.example.com/x.png' },
    { userMetadata: { avatar_url: GOOGLE_PHOTO } },
    { userMetadata: { picture: 'javascript:alert(1)' } },
    { userMetadata: { avatar_url: { nested: true } } },
    { userMetadata: [1, 2, 3] },
    { userMetadata: 0 },
    { avatarEmoji: '🐱' },
    { avatarEmoji: '👨‍👩‍👧‍👦' },
    { avatarUrl: UPLOAD_PATH, userMetadata: { picture: GOOGLE_PHOTO }, avatarEmoji: '🐱' },
  ]

  function assertShape(avatar: ResolvedAvatar): void {
    expect(['image', 'emoji']).toContain(avatar.kind)
    expect(['upload', 'google', 'emoji']).toContain(avatar.source)

    // 이모지는 언제나, 어떤 분기에서도 비지 않습니다.
    expect(typeof avatar.emoji).toBe('string')
    expect(avatar.emoji.trim().length).toBeGreaterThan(0)

    // kind 와 imageUrl 과 source 는 서로 모순되지 않습니다.
    if (avatar.kind === 'image') {
      expect(typeof avatar.imageUrl).toBe('string')
      expect((avatar.imageUrl as string).trim().length).toBeGreaterThan(0)
      expect(avatar.source).not.toBe('emoji')
    } else {
      expect(avatar.imageUrl).toBeNull()
      expect(avatar.source).toBe('emoji')
    }
  }

  for (const [index, input] of WILD.entries()) {
    it(`#${index} ${JSON.stringify(input)} — 던지지 않고 모양을 지킨다`, () => {
      let avatar: ResolvedAvatar | undefined
      expect(() => {
        avatar = resolveAvatar(input)
      }).not.toThrow()
      assertShape(avatar as ResolvedAvatar)
    })
  }

  it('같은 입력은 언제 불러도 같은 결과다 — 화면마다 달라질 여지가 없다', () => {
    // 홈 헤더(Server Component)와 마이페이지(Client Component)가 같은 값을
    // 넘기면 같은 아바타를 봐야 합니다. 시계도 난수도 끼어들지 않습니다.
    const input: AvatarInput = {
      avatarUrl: UPLOAD_PATH,
      userMetadata: { picture: GOOGLE_PHOTO },
      avatarEmoji: '🐱',
    }
    expect(resolveAvatar(input)).toEqual(resolveAvatar(input))
    expect(resolveAvatar(input)).toEqual(resolveAvatar({ ...input }))
  })

  it('입력 객체를 건드리지 않는다', () => {
    const metadata = { picture: `  ${GOOGLE_PHOTO}  ` }
    const input: AvatarInput = { avatarUrl: '  ', userMetadata: metadata, avatarEmoji: '  ' }
    const snapshot = JSON.stringify(input)
    resolveAvatar(input)
    expect(JSON.stringify(input)).toBe(snapshot)
    expect(metadata.picture).toBe(`  ${GOOGLE_PHOTO}  `)
  })
})
