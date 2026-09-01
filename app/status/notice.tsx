import type { ReactNode } from 'react'

import { ErrorText, SuccessText } from '@/components/ui'

/**
 * 결과 배너 한 줄. /status 에는 이 모양이 세 번 나옵니다 — 콕 찌르기 성공
 * (`?ok=`), 콕 찌르기 실패(`?err=`), 그리고 [0007] 기본 그룹 고정(`?dg=`).
 *
 * 세 자리의 마크업이 원래 글자 하나 다르지 않았고, 여기서도 그대로입니다:
 * 성공은 border-line + bg-surface + <SuccessText>, 실패는 border-danger 만
 * 두르고 <ErrorText>. 실패 쪽에 bg 가 없는 것은 오타가 아니라 원래 그렇습니다.
 *
 * ★ 파라미터가 세 개로 나뉘어 있는 것은 그대로입니다 ★ 모양을 공유한다고 해서
 * 배너가 하나가 되지는 않습니다. `?ok=` 와 `?dg=` 는 동시에 뜰 수 있고, 서로를
 * 덮어쓰지 않는 것이 애초에 파라미터를 나눈 이유입니다(./messages.ts 참고).
 */
export function Notice({ tone, children }: { tone: 'ok' | 'error'; children: ReactNode }) {
  if (tone === 'error') {
    return (
      <div className="border-danger rounded-2xl border p-4">
        <ErrorText>{children}</ErrorText>
      </div>
    )
  }

  return (
    <div className="border-line bg-surface rounded-2xl border p-4">
      <SuccessText>{children}</SuccessText>
    </div>
  )
}
