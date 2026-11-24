import type { EventSetting, VoiceConfig, VoiceEvent } from '../types'
import { DEFAULT_CATALOG_URL } from './catalog'

export type EventMeta = {
  key: VoiceEvent
  label: string
  /** Plays even right after another clip. */
  isImportant: boolean
  isOnByDefault: boolean
  /** Minimum gap between two plays of this same event. */
  cooldownMs: number
}

export const EVENTS: readonly EventMeta[] = [
  { key: 'session_start', label: '会话开始', isImportant: true, isOnByDefault: true, cooldownMs: 0 },
  { key: 'prompt_submit', label: '下达指令', isImportant: false, isOnByDefault: true, cooldownMs: 0 },
  { key: 'turn_start', label: '开始执行', isImportant: false, isOnByDefault: false, cooldownMs: 0 },
  { key: 'tool_bash', label: '执行命令', isImportant: false, isOnByDefault: true, cooldownMs: 8000 },
  { key: 'tool_edit', label: '修改文件', isImportant: false, isOnByDefault: true, cooldownMs: 8000 },
  { key: 'agent_spawn', label: '派出子代理', isImportant: false, isOnByDefault: true, cooldownMs: 3000 },
  { key: 'permission', label: '等待授权', isImportant: true, isOnByDefault: true, cooldownMs: 0 },
  { key: 'tool_error', label: '工具失败', isImportant: false, isOnByDefault: true, cooldownMs: 5000 },
  { key: 'compact', label: '压缩上下文', isImportant: false, isOnByDefault: true, cooldownMs: 0 },
  { key: 'done', label: '完成', isImportant: true, isOnByDefault: true, cooldownMs: 0 },
  { key: 'aborted', label: '被中断', isImportant: true, isOnByDefault: true, cooldownMs: 0 },
  { key: 'error', label: '出错', isImportant: true, isOnByDefault: true, cooldownMs: 0 },
  { key: 'session_end', label: '会话结束', isImportant: true, isOnByDefault: true, cooldownMs: 0 },
]

export const META = Object.fromEntries(EVENTS.map(one => [one.key, one])) as Record<
  VoiceEvent,
  EventMeta
>

export const isVoiceEvent = (value: string): value is VoiceEvent => value in META

export const AUDIO_EXT = /\.(wav|ogg|oga|flac|mp3|m4a|aac|opus)$/i
/** What pw-play / paplay read directly (libsndfile); anything else goes through ffmpeg. */
export const PLAYABLE_EXT = /\.(wav|ogg|oga|flac)$/i

export const defaultConfig = (): VoiceConfig => ({
  version: 1,
  enabled: true,
  showBand: true,
  pack: 'red-alert-2',
  volume: 0.8,
  gapMs: 1500,
  catalogUrl: DEFAULT_CATALOG_URL,
  events: Object.fromEntries(
    EVENTS.map(one => [one.key, { enabled: one.isOnByDefault, custom: [] }]),
  ) as unknown as Record<VoiceEvent, EventSetting>,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Whatever the file holds, a whole config: unknown keys dropped, missing ones defaulted. */
export const normalize = (raw: unknown): VoiceConfig => {
  const base = defaultConfig()
  if (!isRecord(raw)) return base
  const events = isRecord(raw.events) ? raw.events : {}

  return {
    version: 1,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled,
    showBand: typeof raw.showBand === 'boolean' ? raw.showBand : base.showBand,
    pack: typeof raw.pack === 'string' && raw.pack !== '' ? raw.pack : base.pack,
    volume: typeof raw.volume === 'number' ? clamp(raw.volume, 0, 1.5) : base.volume,
    gapMs: typeof raw.gapMs === 'number' ? Math.max(0, raw.gapMs) : base.gapMs,
    catalogUrl:
      typeof raw.catalogUrl === 'string' && raw.catalogUrl.startsWith('https://')
        ? raw.catalogUrl
        : base.catalogUrl,
    events: Object.fromEntries(
      EVENTS.map(({ key }) => {
        const one = events[key]
        const fallback = base.events[key]
        if (!isRecord(one)) return [key, fallback]
        return [
          key,
          {
            enabled: typeof one.enabled === 'boolean' ? one.enabled : fallback.enabled,
            custom: Array.isArray(one.custom)
              ? one.custom.filter((path): path is string => typeof path === 'string')
              : [],
          },
        ]
      }),
    ) as unknown as Record<VoiceEvent, EventSetting>,
  }
}

export const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value))

/**
 * A path as a terminal pastes or drops it: quoted, backslash-escaped, a file:// URL,
 * or starting with ~.
 */
export const cleanPath = (raw: string, home: string): string => {
  let path = raw.trim()
  if (
    path.length >= 2 &&
    ((path.startsWith("'") && path.endsWith("'")) || (path.startsWith('"') && path.endsWith('"')))
  ) {
    path = path.slice(1, -1)
  } else {
    path = path.replace(/\\(.)/g, '$1')
  }
  if (path.startsWith('file://')) path = decodeURIComponent(path.slice('file://'.length))
  if (path === '~' || path.startsWith('~/')) path = home + path.slice(1)
  return path
}

export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** A file name safe to keep: letters, digits, dot, dash, underscore. */
export const safeName = (name: string): string =>
  name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'clip'
