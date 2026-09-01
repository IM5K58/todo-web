import type { ReactNode } from 'react'

/**
 * 앱의 표준 페이지 껍데기 — app/settings/page.tsx 가 세운 폭/간격 + 하단 고정
 * <BottomNav> (56px + iOS 홈 인디케이터) 여백.
 *
 * 원래 app/page.tsx · app/status/page.tsx · app/history/page.tsx ·
 * app/me/page.tsx 가 글자 하나 다르지 않은 `function Screen` 을 각자 들고
 * 있었고, 나머지 열한 곳은 같은 <main> 과 같은 스페이서를 손으로 적고
 * 있었습니다. 마크업은 그대로 두고 정의만 하나로 모은 것입니다.
 *
 * ★ 여백이 <main> 의 `pb-28` 이 아니라 스페이서 <div> 인 이유 ★
 * `screen-safe` 는 min-height:100dvh 와 함께
 * `padding-bottom: env(safe-area-inset-bottom)` 을 이미 걸고 있어서, 둘 중
 * 무엇이 캐스케이드에서 이기는지가 우연에 달리게 됩니다. screen-safe 가
 * 이기면 마지막 줄이 56px 바 아래로 들어갑니다. 형제 <div> 에는 그런 모호함이
 * 없습니다. `h-28` 은 바 자신의 주석이 요구하는 7rem 그대로입니다
 * (56px 바 + 홈 인디케이터 inset + 숨 쉴 틈).
 *
 * ---------------------------------------------------------------------------
 * 이 껍데기를 쓰지 *않는* 화면
 * ---------------------------------------------------------------------------
 * /login 과 /install 은 각자 다른 <main> 을 씁니다(폭도 정렬도 다릅니다).
 * app/not-found.tsx 는 같은 screen-safe 위에 세로 가운데 정렬을 씁니다.
 * app/groups/new · app/groups/join 은 같은 <main> 을 쓰지만 스페이서가
 * 없습니다 — 지금 그리는 화면을 바꾸지 않으려고 그대로 두었습니다.
 *
 * /onboarding 은 <BottomNav> 가 숨는 경로인데도 스페이서를 갖고 있습니다.
 * 없애면 스크롤 끝이 7rem 짧아지므로, 그것도 지금 화면 그대로 둡니다.
 * (그래서 스페이서를 끄는 prop 은 아직 필요하지 않습니다.)
 *
 * ---------------------------------------------------------------------------
 * components/ui.tsx 가 아니라 별도 모듈인 이유
 * ---------------------------------------------------------------------------
 * ui.tsx 는 `'use client'` 모듈입니다(Button 이 useFormStatus 를 읽습니다).
 * 거기에 두면 app/page.tsx 같은 Server Component 의 <main> 까지 클라이언트
 * 경계 뒤로 넘어갑니다 — 얻는 것 없이 RSC 페이로드 모양만 바뀝니다. 지시문이
 * 없는 이 모듈은 서버에서는 서버 컴포넌트로, `'use client'` 파일
 * (app/me/page.tsx, app/settings/page.tsx)에서는 클라이언트 컴포넌트로
 * 쓰이며, 어느 쪽도 이 파일이 생기기 전과 달라지지 않습니다.
 */
export function Screen({ children }: { children: ReactNode }) {
  return (
    <main className="screen-safe px-safe mx-auto flex w-full max-w-md flex-col gap-5 py-6">
      {children}
      <div aria-hidden="true" className="h-28 shrink-0" />
    </main>
  )
}
