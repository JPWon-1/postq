'use client'
import { useEffect } from 'react'
import { markLanguageReady, useLanguage } from '@/i18n'

export function LanguageWatcher() {
  const language = useLanguage()
  useEffect(() => { markLanguageReady() }, [])
  useEffect(() => { document.documentElement.lang = language }, [language])
  useEffect(() => {
    const original = window.fetch
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.startsWith('/api/') && !url.startsWith(`${location.origin}/api/`)) return original(input, init)
      const headers = new Headers(input instanceof Request ? input.headers : undefined)
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
      headers.set('Accept-Language', document.documentElement.lang)
      return original(input, { ...init, headers })
    }
    return () => { window.fetch = original }
  }, [])
  return null
}
