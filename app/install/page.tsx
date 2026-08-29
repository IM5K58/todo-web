'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import { isIos, isIosNonSafari, isStandalone } from '@/lib/push/subscribe'

type Mode = 'loading' | 'standalone' | 'ios-safari' | 'ios-other' | 'other'

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="border-line flex gap-3 border-t py-3.5">
      <span className="bg-accent text-accent-fg grid h-7 w-7 shrink-0 place-items-center rounded-full text-sm font-bold">
        {n}
      </span>
      <span className="pt-0.5">{children}</span>
    </li>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-surface-2 border-line mt-7 rounded-xl border p-4 text-sm">
      {children}
    </div>
  )
}

function HomeLink() {
  return (
    <Link
      href="/"
      className="text-accent mt-6 inline-block font-semibold underline-offset-4 hover:underline"
    >
      ← 홈으로 돌아가기
    </Link>
  )
}

export default function InstallPage() {
  // Resolved after mount: matchMedia and navigator.standalone do not exist on
  // the server, and guessing either way would cause a hydration mismatch.
  const [mode, setMode] = useState<Mode>('loading')

  useEffect(() => {
    const resolve = () => {
      if (isStandalone()) return setMode('standalone')
      if (isIos()) return setMode(isIosNonSafari() ? 'ios-other' : 'ios-safari')
      return setMode('other')
    }
    resolve()

    // iOS can flip to standalone without a reload when the page is reopened
    // from the Home Screen icon.
    const mql = window.matchMedia('(display-mode: standalone)')
    mql.addEventListener('change', resolve)
    return () => mql.removeEventListener('change', resolve)
  }, [])

  const shell = 'mx-auto w-full max-w-md px-safe pt-safe pb-16 [word-break:keep-all]'

  if (mode === 'loading') {
    return <main className={shell} aria-busy="true" aria-live="polite" />
  }

  if (mode === 'standalone') {
    return (
      <main className={shell}>
        <h1 className="mt-6 text-2xl font-bold">이미 앱으로 실행 중이에요</h1>
        <p className="text-muted mt-2 leading-relaxed">
          홈 화면 아이콘으로 잘 들어오셨어요. 이제 앱 안에서 알림을 켤 수 있습니다.
        </p>
        <Note>
          알림 버튼을 눌렀을 때 <strong>허용</strong>을 선택해야 친구가 콕 찔러줄 때
          알림이 옵니다.
        </Note>
        <HomeLink />
      </main>
    )
  }

  if (mode === 'ios-other') {
    return (
      <main className={shell}>
        <h1 className="mt-6 text-2xl font-bold">사파리로 열어주세요</h1>
        <p className="text-muted mt-2 leading-relaxed">
          아이폰에서는 <strong className="text-fg">사파리(Safari)</strong>에서만 홈
          화면에 추가할 수 있어요. 크롬·파이어폭스·엣지 등 다른 브라우저에는 이 메뉴가
          아예 나오지 않습니다.
        </p>
        <ol className="mt-6 list-none p-0">
          <Step n={1}>주소창의 링크를 길게 눌러 복사합니다.</Step>
          <Step n={2}>사파리를 열고 주소창에 붙여넣어 다시 접속합니다.</Step>
          <Step n={3}>아래 &lsquo;홈 화면에 추가&rsquo; 안내대로 따라 합니다.</Step>
        </ol>
        <Note>
          홈 화면에 추가한 아이콘으로 실행해야만 알림을 받을 수 있어요. 사파리 탭에서
          그냥 보는 상태로는 아이폰이 알림 자체를 허용하지 않습니다.
        </Note>
        <HomeLink />
      </main>
    )
  }

  if (mode === 'other') {
    return (
      <main className={shell}>
        <h1 className="mt-6 text-2xl font-bold">앱으로 설치하기</h1>
        <p className="text-muted mt-2 leading-relaxed">
          브라우저 주소창의 <strong className="text-fg">설치</strong> 아이콘, 또는 메뉴의{' '}
          <strong className="text-fg">앱 설치 / 홈 화면에 추가</strong>를 눌러주세요.
        </p>
        <Note>
          안드로이드와 데스크톱에서는 설치하지 않아도 알림이 동작합니다. 설치하면 별도
          아이콘이 생기고 전체 화면으로 쓸 수 있어요.
        </Note>
        <HomeLink />
      </main>
    )
  }

  // mode === 'ios-safari'
  return (
    <main className={shell}>
      <h1 className="mt-6 text-2xl font-bold">홈 화면에 추가하기</h1>
      <p className="text-muted mt-2 leading-relaxed">
        아이폰은{' '}
        <strong className="text-fg">홈 화면에 추가한 뒤 그 아이콘으로 실행해야</strong>{' '}
        알림이 옵니다. 사파리 탭에서 그냥 보는 상태로는 알림을 켤 수 없어요.
      </p>

      <ol className="mt-6 list-none p-0">
        <Step n={1}>
          화면 아래 가운데의 <strong>공유 버튼</strong>(□에 화살표 ↑)을 누릅니다.
        </Step>
        <Step n={2}>
          목록을 아래로 내려 <strong>홈 화면에 추가</strong>를 누릅니다.
        </Step>
        <Step n={3}>
          오른쪽 위 <strong>추가</strong>를 누릅니다.
        </Step>
        <Step n={4}>
          사파리를 닫고, <strong>홈 화면에 생긴 아이콘</strong>으로 앱을 다시 실행합니다.
        </Step>
        <Step n={5}>
          앱 안에서 <strong>알림 켜기</strong>를 누르고 <strong>허용</strong>을
          선택합니다.
        </Step>
      </ol>

      <Note>
        <p className="mb-2">
          <strong className="text-fg">iOS 16.4 이상</strong>이 필요합니다. 설정 › 일반 ›
          정보에서 버전을 확인하세요. 그보다 낮은 버전에서는 아이폰 자체가 웹 알림을
          지원하지 않습니다.
        </p>
        <p className="mb-2">
          반드시 <strong className="text-fg">사파리</strong>에서 추가해야 합니다. 다른
          브라우저에는 &lsquo;홈 화면에 추가&rsquo; 메뉴가 없습니다.
        </p>
        <p className="text-danger m-0">
          알림을 한 번 <strong>거부</strong>하면 앱에서 다시 물어볼 수 없어요. 그때는
          설정 › 알림 › 할거적기에서 직접 켜거나, 홈 화면 아이콘을 지우고 처음부터 다시
          추가해야 합니다.
        </p>
      </Note>

      <HomeLink />
    </main>
  )
}
