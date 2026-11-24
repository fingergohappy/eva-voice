export type VoiceEvent =
  | 'session_start'
  | 'prompt_submit'
  | 'turn_start'
  | 'tool_bash'
  | 'tool_edit'
  | 'agent_spawn'
  | 'permission'
  | 'tool_error'
  | 'compact'
  | 'done'
  | 'aborted'
  | 'error'
  | 'session_end'

export type EventSetting = {
  enabled: boolean
  /** Absolute paths the person added; when non-empty they replace the pack's clips. */
  custom: string[]
}

export type VoiceConfig = {
  version: 1
  enabled: boolean
  /** Show the 🔊 band above the prompt. */
  showBand: boolean
  /** A folder name under ~/.config/eva-voice/packs/ (or the plugin's packs/). */
  pack: string
  /** 0 to 1.5, passed to the player. */
  volume: number
  /** Minimum gap between two minor clips, so a burst of tool calls stays quiet. */
  gapMs: number
  /** Where the list of downloadable packs is read from. */
  catalogUrl: string
  events: Record<VoiceEvent, EventSetting>
}

/** One downloadable pack, as index.json lists it. */
export type CatalogPack = {
  name: string
  title: string
  description: string
  game: string
  version: number
  clips: number
  /** Bytes of the zip. */
  size: number
  sha256: string
  url: string
}

/** A pack on disk, read from its pack.json (or just its folder name). */
export type InstalledPack = {
  name: string
  title: string
  version: number
}

declare module 'claude-code' {
  interface PluginState {
    'eva-voice': {
      config: Shaped<VoiceConfig>
      editing: Shaped<VoiceEvent | null>
      note: Shaped<string>
      greeted: Shaped<boolean>
      /** null until fetched. */
      catalog: Shaped<CatalogPack[] | null>
      /** The pack being downloaded, or ''. */
      busy: Shaped<string>
      /** The clip playing now, or ''. */
      playing: Shaped<string>
    }
  }
}
