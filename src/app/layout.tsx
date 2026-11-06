import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ThemeWatcher } from "@/components/ThemeWatcher";
import { LanguageWatcher } from "@/components/LanguageWatcher";

// 폰트를 리포에 담아 로컬 로드한다(next/font/local) — 빌드 타임에 Google 로 나가지 않아
// 폐쇄망/에어갭 CI 에서도 재현 가능하게 빌드된다. woff2(latin subset)는 src/app/fonts.
const plexSans = localFont({
  variable: "--font-plex-sans",
  display: "swap",
  src: [
    { path: "./fonts/plex-sans-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/plex-sans-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/plex-sans-600.woff2", weight: "600", style: "normal" },
    { path: "./fonts/plex-sans-700.woff2", weight: "700", style: "normal" },
  ],
});

const plexMono = localFont({
  variable: "--font-plex-mono",
  display: "swap",
  src: [
    { path: "./fonts/plex-mono-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/plex-mono-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/plex-mono-600.woff2", weight: "600", style: "normal" },
  ],
});


export const metadata: Metadata = {
  title: "postq",
  description: "Create, send, and organize API requests",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ko"
      // 테마 초기화 스크립트가 하이드레이션 전에 data-theme 속성을 붙인다(FOUC 방지) —
      // 서버 HTML에는 없는 속성이라 이 엘리먼트에 한해 하이드레이션 불일치 경고를 억제한다.
      suppressHydrationWarning
      className={`${plexSans.variable} ${plexMono.variable} h-full antialiased`}
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            // 하이드레이션 전 테마 확정(FOUC 방지): 저장값 없거나 'system'이면 OS 설정을 따른다.
            __html: "try{var t=localStorage.getItem('theme');var d=(t==='dark')||((t!=='light')&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light');}catch(e){}",
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        <ThemeWatcher />
        <LanguageWatcher />
        <ErrorBoundary>{children}</ErrorBoundary>
      </body>
    </html>
  );
}
