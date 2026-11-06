import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

// 화면만 정적 파일로 굽는다(`npm run build` → out/). 백엔드는 Rust(server/)이고,
// 데스크톱 앱·도커가 Node 없이 이 out/ 을 그대로 내보낸다.
//
// 개발 중(next dev, `npm run dev`)엔 /api/* 를 Rust 서버로 넘긴다 — 화면은 Next 가 핫리로드로 그리고,
// 데이터는 실제 백엔드가 답한다. scripts/dev-rust.mjs 가 POSTQ_DEV_API 를 넣어 준다.
export default function config(phase: string): NextConfig {
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    const devApi = (process.env.POSTQ_DEV_API ?? "http://127.0.0.1:3001").replace(/\/+$/, "");
    return {
      async rewrites() {
        return [{ source: "/api/:path*", destination: `${devApi}/api/:path*` }];
      },
    };
  }
  return { output: "export" };
}
