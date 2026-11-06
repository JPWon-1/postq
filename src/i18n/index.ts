'use client'
import { useCallback, useSyncExternalStore } from 'react'
import { ko } from './ko'
import { en } from './en'
import { staticKo } from './staticKo'
import { staticEn } from './staticEn'

export type LanguagePreference = 'system' | 'ko' | 'en'
export type Language = 'ko' | 'en'
export type TranslationKey = keyof typeof ko

const STORAGE_KEY = 'postq:language'
const EVENT = 'postq:language-change'
let clientHydrated = false

function readPreference(): LanguagePreference {
  if (typeof window === 'undefined') return 'system'
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'ko' || value === 'en' ? value : 'system'
  } catch { return 'system' }
}

export function getLanguagePreference(): LanguagePreference { return readPreference() }
export function getLanguage(): Language {
  if (typeof window === 'undefined') return 'ko'
  const preference = readPreference()
  if (preference !== 'system') return preference
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('ko') ? 'ko' : 'en'
}

export function setLanguagePreference(preference: LanguagePreference) {
  try { localStorage.setItem(STORAGE_KEY, preference) } catch { /* private browsing */ }
  document.documentElement.lang = getLanguage()
  window.dispatchEvent(new Event(EVENT))
}

export function markLanguageReady() {
  clientHydrated = true
  window.dispatchEvent(new Event(EVENT))
}

function subscribe(listener: () => void) {
  window.addEventListener(EVENT, listener)
  window.addEventListener('storage', listener)
  window.addEventListener('languagechange', listener)
  return () => {
    window.removeEventListener(EVENT, listener)
    window.removeEventListener('storage', listener)
    window.removeEventListener('languagechange', listener)
  }
}

export function useLanguage(): Language {
  const snapshot = useSyncExternalStore(subscribe, () => `${getLanguage()}:${clientHydrated}`, () => 'ko:false')
  return snapshot.startsWith('en:') ? 'en' : 'ko'
}

export function useLanguagePreference(): LanguagePreference {
  return useSyncExternalStore(subscribe, getLanguagePreference, () => 'system')
}

export function t(key: TranslationKey, variables?: Record<string, string | number>): string {
  const phrase = ((clientHydrated && getLanguage() === 'en') ? en : ko)[key]
  return variables ? phrase.replace(/\{(\w+)\}/g, (_, name: string) => String(variables[name] ?? `{${name}}`)) : phrase
}

export function stepCount(count: number): string {
  return t(count === 1 ? 'stepCountOne' : 'stepCountOther', { count })
}

const staticLookup = new Map<string, string>(Object.keys(staticKo).map(key => [
  staticKo[key as keyof typeof staticKo], staticEn[key as keyof typeof staticEn],
]))

/** Localize legacy option labels stored as Korean strings in static descriptors. */
export function localizeKorean(value: string): string {
  return clientHydrated && getLanguage() === 'en' ? staticLookup.get(value) ?? value : value
}

export function useT() {
  const language = useLanguage()
  return useCallback((key: TranslationKey, variables?: Record<string, string | number>) => {
    const phrase = (language === 'ko' ? ko : en)[key]
    return variables ? phrase.replace(/\{(\w+)\}/g, (_, name: string) => String(variables[name] ?? `{${name}}`)) : phrase
  }, [language])
}
