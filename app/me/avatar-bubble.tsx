'use client'

import { useEffect, useState } from 'react'

/**
 * 아바타 한 칸. 사진이 깨지면 이모지로 조용히 내려앉습니다.
 *
 * app/me/page.tsx 에 있던 것을 그대로 옮긴 것입니다. 마크업도 클래스도 한 글자
 * 다르지 않습니다 — 프로필 머리(size-16)와 사진 카드(size-12) 두 곳에서 씁니다.
 */
export function AvatarBubble({
  imageUrl,
  emoji,
  size,
  alt,
}: {
  imageUrl: string | null
  emoji: string
  /** tailwind 클래스 그대로 (size-16 / size-12). */
  size: string
  alt: string
}) {
  const [broken, setBroken] = useState(false)

  // 사진 주소가 바뀌면 실패 표시를 다시 걷어 줍니다. 안 그러면 한 번 깨진 뒤
  // 새로 올린 사진도 영영 이모지로만 보입니다.
  useEffect(() => {
    setBroken(false)
  }, [imageUrl])

  const showImage = Boolean(imageUrl) && !broken

  return (
    <div
      className={`bg-surface-2 ${size} grid shrink-0 place-items-center overflow-hidden rounded-full text-3xl`}
    >
      {showImage ? (
        // next/image 가 아니라 <img> 입니다. 0007 의 경고 그대로 — next/image
        // 로 그리려면 lh3.googleusercontent.com 과 우리 Supabase 호스트를
        // images.remotePatterns 에 등록해야 하고, 그 목록은 그대로
        // /_next/image 공개 프록시의 허용 목록이 됩니다(next.config.ts 참고).
        // 40px 아바타가 최적화로 얻을 것보다 잃을 것이 큽니다.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl as string}
          alt={alt}
          className="size-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
        />
      ) : (
        <span aria-hidden={alt === '' ? true : undefined}>{emoji}</span>
      )}
    </div>
  )
}
