import { defineConfig } from 'drizzle-kit'
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  // 마이그레이션 생성 전용. DB 적용은 Rust 서버가 담당한다.
})
