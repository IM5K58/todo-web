import type { PostgrestError } from '@supabase/supabase-js'
import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'

import { MemberProgressRow, ProgressBar } from '@/components/ui'
import { TASK_TITLE_MAX, codePointLength, toKoreanDbError } from '@/lib/tasks'

/**
 * tests/tasks.test.ts — Supabase 없이 의미 있게 검증할 수 있는 것들.
 *
 *   1. 제목 길이 (codePointLength)  — PG char_length 와 JS .length 의 불일치
 *   2. 진행률 경계 (ProgressBar / MemberProgressRow) — 0개 / 일부 / 전부
 *   3. DB 오류 -> 한국어 메시지 (toKoreanDbError) — 조용한 무시 금지
 *
 * 이 파일은 .ts 라서 JSX 를 쓸 수 없습니다. createElement 로 렌더합니다.
 */

/* ==========================================================================
 * 1. 제목 길이 — codePointLength
 *
 * DB 제약: tasks_title_len_chk = char_length(btrim(title)) between 1 and 200
 * Postgres char_length 는 "코드포인트" 개수입니다. JS .length 는 UTF-16
 * 코드유닛 개수라서 BMP 밖 문자(대부분의 이모지)를 2로 셉니다.
 * 이 차이를 무시하면 이모지 100개짜리 제목이 200자를 넘었다며 거부됩니다.
 * ======================================================================== */

describe('codePointLength — PG char_length 와 자릿수를 맞춘다', () => {
  it('빈 문자열은 0', () => {
    expect(codePointLength('')).toBe(0)
  })

  it('공백만 있는 문자열은 trim 후 0 — DB 의 btrim 과 같은 결론', () => {
    expect(codePointLength('   '.trim())).toBe(0)
    expect(codePointLength('\n\t  \n'.trim())).toBe(0)
  })

  it('ASCII 는 .length 와 같다', () => {
    expect(codePointLength('hello')).toBe(5)
    expect(codePointLength('hello')).toBe('hello'.length)
  })

  it('한글은 BMP 안이라 .length 와 같다', () => {
    expect(codePointLength('오늘 할 일')).toBe(6)
    expect(codePointLength('오늘 할 일')).toBe('오늘 할 일'.length)
  })

  it('★ 이모지 1개는 1자다 — .length 는 2라고 거짓말한다 ★', () => {
    expect('😀'.length).toBe(2)
    expect(codePointLength('😀')).toBe(1)
  })

  it('국기 이모지는 코드포인트 2개 (JS .length 는 4) — PG 도 2로 센다', () => {
    expect('🇰🇷'.length).toBe(4)
    expect(codePointLength('🇰🇷')).toBe(2)
  })

  it('ZWJ 가족 이모지는 화면상 1글자지만 코드포인트 7개 — PG 와 동일', () => {
    // Postgres char_length 도 grapheme 이 아니라 코드포인트를 셉니다.
    // 여기서 1을 기대하면 DB 와 어긋납니다.
    expect('👨‍👩‍👧‍👦'.length).toBe(11)
    expect(codePointLength('👨‍👩‍👧‍👦')).toBe(7)
  })

  it('결합 문자(NFD)는 분해된 개수만큼 센다 — PG 와 동일', () => {
    const precomposed = 'é' // é
    const decomposed = 'é' // e + combining acute
    expect(codePointLength(precomposed)).toBe(1)
    expect(codePointLength(decomposed)).toBe(2)
  })

  it('상한 경계: 200자 ASCII 는 통과, 201자는 초과', () => {
    expect(TASK_TITLE_MAX).toBe(200)
    expect(codePointLength('a'.repeat(TASK_TITLE_MAX))).toBe(TASK_TITLE_MAX)
    expect(codePointLength('a'.repeat(TASK_TITLE_MAX))).toBeLessThanOrEqual(TASK_TITLE_MAX)
    expect(codePointLength('a'.repeat(TASK_TITLE_MAX + 1))).toBeGreaterThan(TASK_TITLE_MAX)
  })

  it('★ 이모지 200개는 정확히 200자 — .length 로 셌다면 400 이라 거부됐을 것 ★', () => {
    const title = '😀'.repeat(TASK_TITLE_MAX)
    expect(title.length).toBe(400) // 이 값으로 검사하면 멀쩡한 제목이 반려됩니다
    expect(codePointLength(title)).toBe(TASK_TITLE_MAX)
    expect(codePointLength(title)).toBeLessThanOrEqual(TASK_TITLE_MAX)
  })

  it('이모지 201개는 초과 — 상한이 코드포인트 기준으로도 실제로 작동한다', () => {
    const title = '😀'.repeat(TASK_TITLE_MAX + 1)
    expect(codePointLength(title)).toBe(TASK_TITLE_MAX + 1)
    expect(codePointLength(title)).toBeGreaterThan(TASK_TITLE_MAX)
  })

  it('한글 200자도 정확히 200 (한글은 확대되지 않는다)', () => {
    const title = '할'.repeat(TASK_TITLE_MAX)
    expect(codePointLength(title)).toBe(TASK_TITLE_MAX)
  })

  it('앞뒤 공백은 trim 뒤에 세야 상한 판정이 DB 와 맞는다', () => {
    const raw = `  ${'a'.repeat(TASK_TITLE_MAX)}  `
    expect(codePointLength(raw)).toBeGreaterThan(TASK_TITLE_MAX)
    expect(codePointLength(raw.trim())).toBe(TASK_TITLE_MAX)
  })

  it('잘린 서로게이트 페어에도 던지지 않는다 (붙여넣기 사고 방어)', () => {
    const lone = '\ud83d' // high surrogate 단독
    expect(() => codePointLength(lone)).not.toThrow()
    expect(codePointLength(lone)).toBe(1)
  })
})

/* ==========================================================================
 * 2. 진행률 경계
 *
 * 진행률 자체는 getGroupTodayStatus() 안에서 DB 결과를 집계하며 계산됩니다.
 * 화면에 나가는 마지막 관문이자 순수하게 검증 가능한 지점이 ProgressBar /
 * MemberProgressRow 이므로, 0개 / 일부 / 전부 경계를 여기서 못 박습니다.
 * ======================================================================== */

describe('ProgressBar — 진행률 경계', () => {
  it('할 일 0개면 progressbar 를 노출하지 않는다 (0/0 은 읽어 줄 값이 없다)', () => {
    render(createElement(ProgressBar, { value: 0, max: 0, label: '민수님의 오늘 진행 상황' }))
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('할 일 0개인데 done 이 남아 있어도 NaN% 가 새어 나가지 않는다', () => {
    // 낙관적 업데이트가 되돌려질 때 (done=2, total=0) 같은 조합이 잠깐 생깁니다.
    const { container } = render(createElement(ProgressBar, { value: 2, max: 0 }))
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(container.innerHTML).not.toContain('NaN')
  })

  it('일부 완료: 3개 중 1개', () => {
    render(createElement(ProgressBar, { value: 1, max: 3, label: '내 진행 상황' }))
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '1')
    expect(bar).toHaveAttribute('aria-valuemax', '3')
    expect(bar).toHaveAttribute('aria-valuetext', '3개 중 1개 완료')
  })

  it('하나도 완료하지 않음: 3개 중 0개 (progressbar 는 그대로 있다)', () => {
    render(createElement(ProgressBar, { value: 0, max: 3 }))
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '0')
    expect(bar).toHaveAttribute('aria-valuetext', '3개 중 0개 완료')
  })

  it('전부 완료: 3개 중 3개', () => {
    render(createElement(ProgressBar, { value: 3, max: 3 }))
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '3')
    expect(bar).toHaveAttribute('aria-valuetext', '3개 중 3개 완료')
  })

  it('완료 시에만 채움색이 진해진다 (일부 완료는 accent/60)', () => {
    const partial = render(createElement(ProgressBar, { value: 1, max: 2 }))
    expect(partial.container.innerHTML).toContain('bg-accent/60')
    partial.unmount()

    const full = render(createElement(ProgressBar, { value: 2, max: 2 }))
    expect(full.container.innerHTML).toContain('bg-accent')
    expect(full.container.innerHTML).not.toContain('bg-accent/60')
  })

  it('value 가 max 를 넘겨도 max 로 잘린다 (오래된 카운트 방어)', () => {
    render(createElement(ProgressBar, { value: 9, max: 3 }))
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3')
  })

  it('음수 value 는 0 으로 잘린다', () => {
    render(createElement(ProgressBar, { value: -4, max: 3 }))
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
  })

  it('1개 중 1개 = 100% (가장 흔한 경우)', () => {
    render(createElement(ProgressBar, { value: 1, max: 1 }))
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '1')
    expect(bar).toHaveAttribute('aria-valuetext', '1개 중 1개 완료')
  })
})

describe('MemberProgressRow — 0개인 그룹원을 가짜 0% 로 그리지 않는다', () => {
  it('오늘 할 일이 0개면 진행바 대신 정직한 안내 문구', () => {
    render(createElement(MemberProgressRow, { name: '민수', done: 0, total: 0 }))
    expect(screen.getByText('아직 오늘 할 일을 적지 않았어요.')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.queryByText('0/0')).toBeNull()
  })

  it('일부 완료면 n/m 카운터와 진행바가 함께 나온다', () => {
    render(createElement(MemberProgressRow, { name: '민수', done: 2, total: 5 }))
    expect(screen.getByText('2/5')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2')
  })

  it('전부 완료면 m/m', () => {
    render(createElement(MemberProgressRow, { name: '민수', done: 5, total: 5 }))
    expect(screen.getByText('5/5')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '5개 중 5개 완료')
  })

  it('본인 행에는 (나) 가 붙는다 — 콕 찌르기 버튼을 숨길 근거', () => {
    render(createElement(MemberProgressRow, { name: '민수', done: 1, total: 2, isSelf: true }))
    expect(screen.getByText('(나)')).toBeInTheDocument()
  })
})

/* ==========================================================================
 * 3. DB 오류 -> 한국어
 *
 * 조용한 무시 금지. 어떤 코드가 와도 한국어 문장이 나와야 하고, 모르는
 * 코드는 삼키지 말고 fallback 뒤에 코드를 붙여 노출해야 합니다.
 * ======================================================================== */

/** PostgrestError 는 클래스라서 리터럴로는 만들 수 없습니다. */
function pgError(code: string, message = 'boom'): PostgrestError {
  return Object.assign(new Error(message), {
    details: '',
    hint: '',
    code,
  }) as PostgrestError
}

describe('toKoreanDbError', () => {
  const fallback = '할 일을 불러오지 못했습니다.'

  it('오류가 없으면 fallback 을 그대로 돌려준다', () => {
    expect(toKoreanDbError(null, fallback)).toBe(fallback)
  })

  it('42501(권한 없음) -> 재로그인 안내', () => {
    expect(toKoreanDbError(pgError('42501'), fallback)).toBe(
      '권한이 없습니다. 다시 로그인해 주세요.'
    )
  })

  it('23514(CHECK 위반, 예: 제목 길이) -> 형식 안내', () => {
    expect(toKoreanDbError(pgError('23514'), fallback)).toBe(
      '입력한 값이 형식에 맞지 않습니다.'
    )
  })

  it('PGRST202(RPC 미배포) -> 잠시 후 재시도 안내', () => {
    expect(toKoreanDbError(pgError('PGRST202'), fallback)).toBe(
      '서버 함수를 찾을 수 없습니다. 잠시 후 다시 시도해 주세요.'
    )
  })

  it('알 수 없는 코드는 삼키지 않고 fallback 뒤에 코드를 붙인다', () => {
    expect(toKoreanDbError(pgError('40001'), fallback)).toBe(`${fallback} (40001)`)
  })

  it('코드가 아예 없어도 한국어 문장이 나온다', () => {
    const bare = Object.assign(new Error('network down'), {
      details: '',
      hint: '',
    }) as unknown as PostgrestError
    expect(toKoreanDbError(bare, fallback)).toBe(`${fallback} (알 수 없음)`)
  })

  it('매핑된 모든 코드가 영어를 새어 보내지 않는다', () => {
    for (const code of ['42501', '23514', '22023', 'P0002', 'PGRST202', '23505']) {
      const message = toKoreanDbError(pgError(code), fallback)
      expect(message).not.toContain('permission denied')
      expect(message).toMatch(/[가-힣]/)
    }
  })
})
