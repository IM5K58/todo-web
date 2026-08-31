'use client'

import { useRouter } from 'next/navigation'
import { useId, useOptimistic, useTransition } from 'react'

/**
 * 홈 상단의 그룹 선택 드롭다운.
 *
 * ---------------------------------------------------------------------------
 * 왜 <form method="get"> 인가 (그리고 왜 그것만으로는 부족한가)
 * ---------------------------------------------------------------------------
 * 선택 결과는 URL 쿼리(`?g=<uuid>`)입니다. 그래서 이 컨트롤의 뼈대는 평범한
 * GET 폼입니다 — JS 가 아직 안 왔거나(첫 페인트와 hydration 사이), 영영 안
 * 오거나(스크립트 차단), 실패해도 <select> 를 고르고 "이동"을 누르면 그대로
 * 동작합니다. 링크 목록이 아니라 <select> 인 이유는 그룹이 늘어도 헤더 한 줄
 * 높이가 그대로이고, 모바일에서 네이티브 피커가 뜨기 때문입니다.
 *
 * 그 위에 onChange 를 얹습니다. 폼 제출은 문서 전체를 다시 받지만
 * `router.push()` 는 RSC 페이로드만 받아 오므로 훨씬 빠릅니다. useTransition
 * 으로 감싸는 것은 그 사이에 화면이 얼어붙은 것처럼 보이지 않게 하기
 * 위해서입니다(전환 중에는 컨트롤이 흐려집니다).
 *
 * "이동" 버튼을 <noscript> 안에 두는 이유: JS 가 있으면 onChange 가 이미
 * 이동시켜서 버튼이 아무 일도 하지 않는 두 번째 탭 대상이 됩니다. <noscript>
 * 는 서버가 그대로 내보내고 브라우저가 JS 활성 시 무시하므로, "JS 없을 때만
 * 보이는 버튼"을 상태 없이 정확히 표현합니다.
 *
 * ---------------------------------------------------------------------------
 * 선택지가 하나면 드롭다운을 만들지 않습니다
 * ---------------------------------------------------------------------------
 * 고를 것이 없는 셀렉트는 소음이면서, 탭할 수 있어 보이는데 아무 일도 일어나지
 * 않아 고장으로 읽힙니다. 그룹이 1개면 이름만 글자로 보여 줍니다. 0개일 때는
 * 애초에 홈이 "아직 그룹이 없어요" 빈 상태를 그리므로 여기까지 오지 않지만,
 * 방어적으로 아무것도 렌더링하지 않습니다.
 */

export type SwitchableGroup = {
  id: string
  name: string
}

export default function GroupSwitcher({
  groups,
  activeGroupId,
  className = '',
}: {
  /** 내가 속한 그룹 전부. lib/tasks.ts 의 MyGroup 에서 id/name 만 뽑아 넘기세요. */
  groups: SwitchableGroup[]
  /** 지금 보고 있는 그룹. 목록에 없으면 첫 번째가 선택된 것으로 보입니다. */
  activeGroupId: string
  className?: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const selectId = useId()

  /**
   * 전환이 끝나기 전에도 방금 고른 그룹이 보이게 합니다.
   *
   * ★ 이게 없으면 눈에 보이는 버그가 생깁니다 ★ router.push() 는 서버에서
   * RSC 를 받아 오는 동안(왕복 261~1431ms) 아직 예전 props 로 렌더링합니다.
   * 그동안 셀렉트는 방금 고른 B 가 아니라 A 로 되돌아가 있고, 잠시 뒤 혼자
   * B 로 바뀝니다 — 사용자가 보기에는 선택이 씹혔다가 뒤늦게 먹은 것입니다.
   *
   * useState 로 흉내 내지 않은 이유: useOptimistic 은 전환이 끝나면 스스로
   * 기준값(props)으로 돌아갑니다. 그래서 서버가 ?g= 를 무시하는 경우(내가
   * 속하지 않은 그룹 id 였다면 로더가 첫 그룹으로 되돌립니다)에도 컨트롤이
   * 거짓말을 붙들고 있지 않고 실제로 보이는 그룹으로 알아서 맞춰집니다.
   */
  const [shownGroupId, setShownGroupId] = useOptimistic(activeGroupId)

  if (groups.length === 0) return null

  if (groups.length === 1) {
    return (
      <p className={`text-muted truncate text-sm ${className}`}>{groups[0].name}</p>
    )
  }

  return (
    <form method="get" action="/" className={`flex items-center gap-2 ${className}`}>
      <label htmlFor={selectId} className="sr-only">
        그룹 선택
      </label>

      <select
        id={selectId}
        name="g"
        // defaultValue 가 아니라 value + onChange 입니다. 뒤로가기로 ?g= 가 다른
        // URL 에 돌아왔을 때 셀렉트가 이전 선택을 붙들고 있으면, 화면이 보여
        // 주는 그룹과 컨트롤이 말하는 그룹이 서로 다른 말을 하게 됩니다.
        value={shownGroupId}
        aria-busy={pending || undefined}
        onChange={(event) => {
          const next = event.target.value
          if (!next || next === shownGroupId) return
          // 다른 쿼리(fill / c / s / fillerr)는 일부러 버립니다. 그것들은
          // "방금 무슨 일이 있었다"는 일회성 알림이라, 그룹을 바꾼 뒤에도
          // 따라다니면 이미 지난 일을 다시 말하게 됩니다.
          startTransition(() => {
            setShownGroupId(next)
            router.push(`/?g=${encodeURIComponent(next)}`)
          })
        }}
        /*
          app/settings/page.tsx 의 selectClass 와 같은 모양(h-12 / rounded-xl /
          bg-surface-2)입니다. 두 화면의 셀렉트가 다르게 생길 이유가 없습니다.

          ★ text-sm 을 붙이지 마세요 ★ app/globals.css 는 base 레이어에서
          input/select/textarea 에 font-size:16px 을 강제합니다(91~96줄) —
          iOS 가 16px 미만 컨트롤에 포커스하면 화면을 확대해 버리기 때문입니다.
          Tailwind 유틸리티는 base 를 이기므로 text-sm 은 그 방어를 정확히
          무력화합니다.
        */
        className={`border-line bg-surface-2 text-fg h-12 min-w-0 flex-1 rounded-xl border px-3 transition ${
          pending ? 'opacity-60' : ''
        }`}
      >
        {groups.map((group) => (
          <option key={group.id} value={group.id}>
            {group.name}
          </option>
        ))}
      </select>

      <noscript>
        <button
          type="submit"
          className="border-line bg-surface text-fg inline-flex h-12 shrink-0 items-center justify-center rounded-xl border px-4 text-base font-medium"
        >
          이동
        </button>
      </noscript>
    </form>
  )
}
