/**
 * lib/db-error.ts — PostgrestError → 한국어 한 문장
 *
 * lib/tasks.ts 에서 갈라져 나온 조각입니다. 설계 규칙 전문은 lib/tasks.ts 머리말.
 *
 * 이 모듈은 순수 함수 하나뿐이라 서버 전용이 아닙니다. next/headers 도,
 * createClient() 도 부르지 않습니다.
 */

import type { PostgrestError } from '@supabase/supabase-js'

/**
 * PostgrestError 를 한국어 한 문장으로. 조용히 삼키지 않습니다.
 * 코드는 0001~0003 이 실제로 던지는 것들입니다.
 */
export function toKoreanDbError(
  error: PostgrestError | null,
  fallback: string
): string {
  if (!error) return fallback

  switch (error.code) {
    case '42501':
      return '권한이 없습니다. 다시 로그인해 주세요.'
    case '23514':
      return '입력한 값이 형식에 맞지 않습니다.'
    case '22023':
      return '입력한 값이 올바르지 않습니다.'
    case 'P0002':
      return '대상을 찾을 수 없습니다.'
    case 'PGRST202':
      return '서버 함수를 찾을 수 없습니다. 잠시 후 다시 시도해 주세요.'
    case '23505':
      return '이미 존재하는 값입니다.'
    default:
      return `${fallback} (${error.code ?? '알 수 없음'})`
  }
}
