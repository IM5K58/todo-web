/**
 * `?ok=` / `?err=` 같은 결과 코드를 화면에 보여 줄 한 줄로 바꿉니다.
 *
 * app/groups/page.tsx · app/status/page.tsx · app/templates/page.tsx 가 글자
 * 하나 다르지 않은 같은 함수를 각자 들고 있었습니다(주석 언어만 달랐습니다).
 * Server Action 이 결과를 useActionState 가 아니라 URL 로 되돌려 주기 때문에
 * — 그 이유는 app/groups/actions.ts 머리말에 있습니다 — 이 변환이 결과를
 * 쓰는 모든 화면에 필요합니다.
 *
 * 두 가지를 반드시 지킵니다:
 *
 *   1. 같은 파라미터가 두 번 오면 값은 배열입니다(`?ok=a&ok=b`). 배열은 코드가
 *      아니므로 아무것도 그리지 않습니다.
 *   2. 모르는 코드도 아무것도 그리지 않습니다. URL 은 사용자가 손으로 고칠 수
 *      있고, 표에 없는 값에 빈 배너를 띄우면 "무슨 일이 일어났는데 내용이
 *      없는" 화면이 됩니다.
 *
 * hasOwnProperty 로 확인하는 이유는 `?ok=toString` 같은 값이 Object.prototype
 * 의 것을 집어 오지 못하게 하기 위함입니다.
 */
export function messageFor<K extends string>(
  table: Record<K, string>,
  raw: string | string[] | undefined
): string | null {
  if (typeof raw !== 'string') return null
  return Object.prototype.hasOwnProperty.call(table, raw) ? table[raw as K] : null
}
