'use client'
import type { ComponentPropsWithRef } from 'react'
import { TooltipButton } from './TooltipButton'

/** 같은 선 굵기·24 단위 좌표계를 쓰는 16px 보조 동작 아이콘. */
const paths = {
  close: 'M6 6l12 12M6 18 18 6',
  focus: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5',
  unfocus: 'M3 8h5V3M21 8h-5V3M8 21v-5H3M16 21v-5h5',
  edit: 'm15 4 5 5M4 20l5-1L21 7l-5-5L4 14Z',
  book: 'M12 5v16M12 5C8 2 4 3 2 4v15c4-2 7-1 10 2 3-3 6-4 10-2V4c-2-1-6-2-10 1Z',
  folderPlus: 'M3 7V4h6l2 3h10v13H3ZM12 10v7M8.5 13.5h7',
  transfer: 'M7 3v16m-4-4 4 4 4-4M17 21V5m-4 4 4-4 4 4',
  import: 'M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5',
  export: 'M12 15V3m-4 4 4-4 4 4M4 16v5h16v-5',
  panelLeft: 'M3 3h18v18H3ZM9 3v18m6-14-3 5 3 5',
  panelRight: 'M3 3h18v18H3ZM15 3v18M9 7l3 5-3 5',
  panelBottom: 'M3 3h18v18H3ZM3 15h18m-13-5 4-4 4 4',
  expandBottom: 'M3 3h18v18H3ZM3 15h18m-13-9 4 4 4-4',
  collapseAll: 'm7 10 5-5 5 5m-10 9 5-5 5 5',
  expandAll: 'm7 5 5 5 5-5m-10 9 5 5 5-5',
  chevronRight: 'm9 5 7 7-7 7',
  chevronDown: 'm5 9 7 7 7-7',
  terminal: 'M3 4h18v16H3Zm4 4 4 4-4 4m7 0h4',
  variables: 'M8 3H6v7l-3 2 3 2v7h2M16 3h2v7l3 2-3 2v7h-2M10 9l4 6m0-6-4 6',
  cookie: 'M21 12a9 9 0 1 1-9-9c-1 4 2 6 5 5-1 3 1 4 4 4ZM8 8h.01M7 14h.01M12 17h.01M15 12h.01',
  keyboard: 'M2 5h20v14H2ZM6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M9 15h6',
  tabs: 'M3 3h14v3M7 7h14v14H7Zm4 5h6m-6 4h6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  star: 'm12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z',
  filter: 'M3 4h18l-7 8v7l-4 2v-9Z',
  select: 'M9 5h12M9 12h12M9 19h12M2 5l2 2 3-4M2 12l2 2 3-4M2 19l2 2 3-4',
  history: 'M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l4 2',
  ai: 'm12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z',
  tools: 'M14 3a6 6 0 0 0-7 8l-5 5 4 4 5-5a6 6 0 0 0 8-7l-4 4-4-4Z',
  undo: 'M3 10h11a6 6 0 0 1 0 12M3 10l6-6m-6 6 6 6',
  preview: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm7 0a3 3 0 1 0 6 0 3 3 0 0 0-6 0',
  pin: 'M9 3h6l-1 7 4 4H6l4-4ZM12 14v8',
  validate: 'm12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6Zm-5 10 3 3 6-6',
  copy: 'M8 8h13v13H8ZM16 8V3H3v13h5',
  download: 'M12 2v14m-5-5 5 5 5-5M3 19v3h18v-3',
  code: 'm8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  clear: 'm15 3 6 6-10 12H5l-4-4Zm-7 9 8 7M11 21h11',
  refresh: 'M20 8a9 9 0 0 0-16-2L2 9m0-6v6h6M4 16a9 9 0 0 0 16 2l2-3m0 6v-6h-6',
  plus: 'M12 3v18M3 12h18',
  check: 'm4 12 5 5L20 6',
  alert: 'm12 2 10 19H2Zm0 6v6m0 3h.01',
  table: 'M3 3h18v18H3ZM3 9h18M9 9v12M3 15h18',
  text: 'M4 5h16M4 10h16M4 15h16M4 20h10',
  format: 'M3 5h18M7 10h14M7 15h14M3 20h18M3 10v5',
  back: 'M20 12H4m6-6-6 6 6 6',
  forward: 'M4 12h16m-6-6 6 6-6 6',
  projects: 'M3 3h7v7H3Zm11 0h7v7h-7ZM3 14h7v7H3Zm11 0h7v7h-7Z',
  compare: 'M4 3h6v18H4ZM14 3h6v18h-6ZM10 8h4m-4 8h4',
  expand: 'M3 9V3h6M21 15v6h-6M3 3l7 7m11 11-7-7',
  link: 'm9 15 6-6M8 17l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 10a4 4 0 0 0 6 0l5-5a4 4 0 0 0-6-6l-1 1',
  moon: 'M21 14A9 9 0 1 1 10 3a7 7 0 0 0 11 11Z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2',
  settings: 'm9 2-.5 3-2 1-3-.5-2 3 2 2v3l-2 2 2 3 3-.5 2 1 .5 3h4l.5-3 2-1 3 .5 2-3-2-2v-3l2-2-2-3-3 .5-2-1L13 2Zm2 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
} as const
export type ToolIconName = keyof typeof paths
export function ToolIcon({ name, filled = false }: { name: ToolIconName; filled?: boolean }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-icon={name}><path d={paths[name]} /></svg>
}
export function ToolButton({ icon, filled, disabled, onClick, children: _children, ...props }: ComponentPropsWithRef<'button'> & { icon: ToolIconName; filled?: boolean; 'aria-label': string }) {
  return <TooltipButton type="button" {...props} aria-disabled={disabled || undefined} aria-description={props.title}
    onClick={event => { if (disabled) { event.preventDefault(); event.stopPropagation(); return }; onClick?.(event) }} data-icon-button="true" className={`ah-tool-button ${props.className ?? ''}`}><ToolIcon name={icon} filled={filled} /></TooltipButton>
}
