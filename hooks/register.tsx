import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CatalogPack, Editing, EventSetting, VoiceConfig, VoiceEvent } from '../types'
import { fetchCatalog, formatSize, installPack, listInstalled, removePack } from './catalog'
import {
  AUDIO_EXT,
  EVENTS,
  META,
  PLAYABLE_EXT,
  baseName,
  clamp,
  cleanPath,
  defaultConfig,
  isVoiceEvent,
  normalize,
  safeName,
  splitPaths,
} from './events'

type $ = EngineInterface

const PANE = 'eva-voice'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// Bump a shape tag when that value's meaning changes: a reload then starts it fresh.
const config = atom({ plugin: 'eva-voice', key: 'config' } as const, defaultConfig(), {
  shape: 'config-3',
})
/** The stage whose row shows the file field, and what its files do, or null. */
const editing = atom({ plugin: 'eva-voice', key: 'editing' } as const, null as Editing | null, {
  shape: 'editing-2',
})
const expanded = atom({ plugin: 'eva-voice', key: 'expanded' } as const, null as VoiceEvent | null, {
  shape: 'expanded-1',
})
const note = atom({ plugin: 'eva-voice', key: 'note' } as const, '', { shape: 'note-1' })
const greeted = atom({ plugin: 'eva-voice', key: 'greeted' } as const, false, {
  shape: 'greeted-1',
})
const catalog = atom({ plugin: 'eva-voice', key: 'catalog' } as const, null as CatalogPack[] | null, {
  shape: 'catalog-1',
})
const busy = atom({ plugin: 'eva-voice', key: 'busy' } as const, '', { shape: 'busy-1' })
/** The file playing now, or '': the band above the prompt shows it. */
const playing = atom({ plugin: 'eva-voice', key: 'playing' } as const, '', { shape: 'playing-1' })

// Module state: starts over on every reload, which is fine for all of it.
let isActive = true
let home = ''
let configText = ''
let player: ((file: string, volume: number) => string[]) | null | undefined
let playerName = ''
let lastAt = 0
const lastByEvent = new Map<VoiceEvent, number>()
const clipCache = new Map<string, string[]>()
const packTitles = new Map<string, string>()

const configDir = () => `${home}/.config/eva-voice`
const configPath = () => `${configDir()}/config.json`
const packsDir = () => `${configDir()}/packs`

// ---------------------------------------------------------------- config file

async function loadConfig($: $): Promise<void> {
  const text = await $.fs.read(configPath()).catch(() => '')
  if (text === configText) return
  configText = text
  let raw: unknown
  try {
    raw = text === '' ? undefined : JSON.parse(text)
  } catch {
    await update($, note, () => `配置文件不是合法 JSON，已用默认配置: ${configPath()}`)
    return
  }
  const next = normalize(raw)
  clipCache.clear()
  await update($, config, () => next)
}

async function saveConfig($: $, change: (cfg: VoiceConfig) => VoiceConfig): Promise<VoiceConfig> {
  const next = change(await read($, config))
  await update($, config, () => next)
  configText = `${JSON.stringify(next, null, 2)}\n`
  await $.fs.write(configPath(), configText)
  clipCache.clear()
  return next
}

// ---------------------------------------------------------------- packs & clips

async function packRoots($: $): Promise<string[]> {
  return [`${$.plugin.root}/packs`, `${configDir()}/packs`]
}

async function listPacks($: $) {
  const packs = await listInstalled($, await packRoots($))
  packTitles.clear()
  for (const one of packs) packTitles.set(one.name, one.title)
  return packs
}

async function packTitle($: $, name: string): Promise<string> {
  if (!packTitles.has(name)) await listPacks($).catch(() => undefined)
  return packTitles.get(name) ?? name
}

// ---------------------------------------------------------------- online packs

async function refreshCatalog($: $): Promise<void> {
  const cfg = await read($, config)
  try {
    const list = await fetchCatalog($, cfg.catalogUrl)
    await update($, catalog, () => list)
  } catch (err) {
    await update($, catalog, () => [])
    await update($, note, () => `读取在线语音包列表失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function download($: $, pack: CatalogPack): Promise<void> {
  if ((await read($, busy)) !== '') return
  await update($, busy, () => pack.name)
  await update($, note, () => `正在下载「${pack.title}」(${formatSize(pack.size)})…`)
  try {
    await installPack($, packsDir(), pack)
    clipCache.clear()
    const installed = await listPacks($)
    const cfg = await read($, config)
    // A first pack, or one replacing a missing current pack, becomes the one in use.
    const hasCurrent = installed.some(one => one.name === cfg.pack && one.name !== pack.name)
    if (!hasCurrent) await saveConfig($, c => ({ ...c, pack: pack.name }))
    await update($, note, () => `「${pack.title}」已安装${hasCurrent ? '' : '，并设为当前语音包'}`)
  } catch (err) {
    await update($, note, () => `下载失败: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await update($, busy, () => '')
  }
}

async function deletePack($: $, name: string, title: string): Promise<void> {
  try {
    await removePack($, packsDir(), name)
    clipCache.clear()
    await update($, note, () => `已删除「${title}」`)
  } catch (err) {
    await update($, note, () => `删除失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function packClips($: $, pack: string, key: VoiceEvent): Promise<string[]> {
  const cacheKey = `${pack}/${key}`
  const cached = clipCache.get(cacheKey)
  if (cached) return cached
  const found: string[] = []
  for (const root of await packRoots($)) {
    const dir = `${root}/${pack}/${key}`
    const entries = await $.fs.list(dir).catch(() => [])
    for (const one of entries) {
      if (one.kind === 'file' && AUDIO_EXT.test(one.name)) found.push(`${dir}/${one.name}`)
    }
    if (found.length > 0) break
  }
  found.sort()
  clipCache.set(cacheKey, found)
  return found
}

async function clipsFor($: $, cfg: VoiceConfig, key: VoiceEvent): Promise<string[]> {
  const custom = cfg.events[key].custom
  return custom.length > 0 ? custom : packClips($, cfg.pack, key)
}

// ---------------------------------------------------------------- playing

async function findPlayer($: $): Promise<typeof player> {
  if (player !== undefined) return player
  const probe = await $.process
    .run(['sh', '-c', 'command -v pw-play || command -v paplay || command -v afplay'])
    .catch(() => undefined)
  const found = baseName(probe?.stdout.trim().split('\n')[0] ?? '')
  playerName = found
  player =
    found === 'pw-play'
      ? (file, volume) => ['pw-play', '--volume', volume.toFixed(2), file]
      : found === 'paplay'
        ? (file, volume) => ['paplay', `--volume=${Math.round(volume * 65536)}`, file]
        : found === 'afplay'
          ? (file, volume) => ['afplay', '-v', volume.toFixed(2), file]
          : null
  return player
}

async function playFile($: $, file: string, volume: number): Promise<boolean> {
  const argv = (await findPlayer($))?.(file, volume)
  if (!argv) {
    await update($, note, () => '找不到播放器：需要 pw-play、paplay 或 afplay 之一')
    return false
  }
  await update($, playing, () => file).catch(() => undefined)
  try {
    const ran = await $.process.run(argv, { timeoutMs: 20_000 }).catch(() => undefined)
    return ran?.exitCode === 0
  } finally {
    // A later clip may have started meanwhile; clear only our own.
    await update($, playing, now => (now === file ? '' : now)).catch(() => undefined)
  }
}

const lastClip = new Map<VoiceEvent, string>()

/** A random clip of the stage's, never the one it played last time when it has others. */
function pickOne(list: readonly string[], key?: VoiceEvent): string | undefined {
  const last = key === undefined ? undefined : lastClip.get(key)
  const pool = list.length > 1 && last !== undefined ? list.filter(one => one !== last) : list
  const file = pool[Math.floor(Math.random() * pool.length)]
  if (key !== undefined && file !== undefined) lastClip.set(key, file)
  return file
}

/** Plays the event's clip if it is on and not throttled. Never throws. */
async function fire($: $, key: VoiceEvent, opts: { shouldWait?: boolean } = {}): Promise<void> {
  try {
    if (!isActive) return
    const cfg = await read($, config)
    if (!cfg.enabled || !cfg.events[key].enabled) return
    const meta = META[key]
    const now = Date.now()
    if (!meta.isImportant && now - lastAt < cfg.gapMs) return
    if (now - (lastByEvent.get(key) ?? 0) < meta.cooldownMs) return
    const file = pickOne(await clipsFor($, cfg, key), key)
    if (file === undefined) return
    lastAt = now
    lastByEvent.set(key, now)
    const playing = playFile($, file, cfg.volume)
    if (opts.shouldWait) await playing
    else void playing
  } catch {
    // A voice line is never worth breaking the session for.
  }
}

// ---------------------------------------------------------------- adding a file

const isFile = async ($: $, path: string) =>
  (await $.fs.stat(path).catch(() => undefined))?.kind === 'file'

/** The files a typed or dropped value names: one path as typed, or several dropped at once. */
async function droppedFiles($: $, raw: string): Promise<string[]> {
  const whole = cleanPath(raw, home)
  if (whole === '') return []
  if (await isFile($, whole)) return [whole]
  return splitPaths(raw, home).filter(one => one !== '')
}

/** Copies one file under custom/<stage>/ (converted when the player can't read it); its path, or why not. */
async function importClip($: $, key: VoiceEvent, src: string, n: number): Promise<{ dest?: string; why?: string }> {
  if (!(await isFile($, src))) return { why: `找不到文件: ${src}` }
  if (!AUDIO_EXT.test(src)) return { why: `不是支持的音频格式 (wav/ogg/flac/mp3/m4a/aac/opus): ${src}` }
  const dir = `${configDir()}/custom/${key}`
  await $.process.run(['mkdir', '-p', dir])
  const stem = safeName(baseName(src).replace(AUDIO_EXT, ''))
  // afplay (macOS) reads every format here; pw-play and paplay need ffmpeg for mp3 & co.
  await findPlayer($)
  const isCopy = PLAYABLE_EXT.test(src) || playerName === 'afplay'
  const ext = isCopy ? (src.match(AUDIO_EXT)?.[0] ?? '.wav').toLowerCase() : '.wav'
  const dest = `${dir}/${stem}-${Date.now()}${n > 0 ? `-${n}` : ''}${ext}`
  const copied = isCopy
    ? await $.process.run(['cp', src, dest]).catch(() => undefined)
    : await $.process
        .run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-ac', '1', '-ar', '44100', dest], {
          timeoutMs: 60_000,
        })
        .catch(() => undefined)
  if (copied?.exitCode !== 0) {
    return { why: copied?.stderr.trim().split('\n').pop() || (isCopy ? 'cp 失败' : '需要 ffmpeg 转码') }
  }
  return { dest }
}

/**
 * Copies the dropped files in as the stage's voices: `replace` puts them in place of the
 * pack's or earlier ones, `add` puts them beside the stage's own. Says what happened in the note.
 */
async function addVoices($: $, key: VoiceEvent, raw: string, mode: Editing['mode']): Promise<boolean> {
  const files = await droppedFiles($, raw)
  if (files.length === 0) return false
  const added: string[] = []
  const failed: string[] = []
  for (const [n, src] of files.entries()) {
    const got = await importClip($, key, src, n)
    if (got.dest !== undefined) added.push(got.dest)
    else failed.push(got.why ?? src)
  }
  if (added.length === 0) {
    await update($, note, () => `没有加进去: ${failed.join('；')}`)
    return false
  }
  const old = (await read($, config)).events[key].custom
  const cfg = await saveConfig($, cfg => ({
    ...cfg,
    events: {
      ...cfg.events,
      [key]: { enabled: true, custom: mode === 'add' ? [...old, ...added] : added },
    },
  }))
  if (mode === 'replace') await removeOwnCopies($, old)
  const total = cfg.events[key].custom.length
  const label = META[key].label
  const done =
    mode === 'add'
      ? `「${label}」加了 ${added.length} 条，现在共 ${total} 条，随机播放`
      : `「${label}」已换成 ${added.length === 1 ? baseName(files[0] ?? '') : `${added.length} 条`}`
  await update($, note, () => (failed.length > 0 ? `${done}；跳过: ${failed.join('；')}` : done))
  void playFile($, added[0] ?? '', cfg.volume)
  return true
}

/** Takes one clip out of the stage's own list (the stage goes back to the pack when none is left). */
async function removeVoice($: $, key: VoiceEvent, path: string): Promise<void> {
  const cfg = await saveConfig($, c => ({
    ...c,
    events: {
      ...c.events,
      [key]: { ...c.events[key], custom: c.events[key].custom.filter(one => one !== path) },
    },
  }))
  await removeOwnCopies($, [path])
  const left = cfg.events[key].custom.length
  await update($, note, () =>
    left > 0 ? `已删除 ${baseName(path)}，还剩 ${left} 条` : `已删除 ${baseName(path)}，「${META[key].label}」回到语音包默认`,
  )
}

/** Deletes the copies this mod made under custom/; files kept elsewhere are left alone. */
async function removeOwnCopies($: $, paths: readonly string[]): Promise<void> {
  const own = paths.filter(path => path.startsWith(`${configDir()}/custom/`))
  if (own.length > 0) await $.process.run(['rm', '-f', ...own]).catch(() => undefined)
}

// ---------------------------------------------------------------- the pane

const openPane = ($: $) =>
  $.ui.open({ id: PANE, title: '语音 · eva-voice', focus: true, closeOnEscape: true })

function describe(clips: readonly string[], isCustom: boolean): string {
  if (clips.length === 0) return '(无语音)'
  const first = baseName(clips[0] ?? '')
  const more = clips.length > 1 ? ` +${clips.length - 1}` : ''
  return `${isCustom ? '自定义 ' : ''}${first}${more}`
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    isActive = e.isInteractive
    home = (await $.env.get('HOME')) ?? ''
    await $.command.register({
      name: 'voices',
      description: '语音配置面板 (eva-voice)；/voices on|off|test <事件>',
      argumentHint: '[on|off|test <event>]',
    })
    await loadConfig($)
    // session.start runs again on every reload of this module; greet once.
    if (!(await read($, greeted))) {
      await update($, greeted, () => true)
      void fire($, 'session_start')
    }
    return started
  })

  on('command.run', { command: 'voices' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().split(/\s+/)
    if (verb === 'on' || verb === 'off') {
      await saveConfig($, cfg => ({ ...cfg, enabled: verb === 'on' }))
      return { text: `eva-voice 已${verb === 'on' ? '开启' : '关闭'}` }
    }
    if (verb === 'test') {
      if (!isVoiceEvent(arg)) {
        return { text: `用法: /voices test <事件>，事件: ${EVENTS.map(one => one.key).join(', ')}` }
      }
      const cfg = await read($, config)
      const file = pickOne(await clipsFor($, cfg, arg), arg)
      if (file === undefined) return { text: `「${META[arg].label}」没有可播放的语音` }
      await playFile($, file, cfg.volume)
      return { text: `播放了 ${baseName(file)}` }
    }
    await loadConfig($)
    if ((await read($, catalog)) === null) void refreshCatalog($)
    const opened = await openPane($)
    return {
      text: opened.isPlaced
        ? '语音配置面板已打开（Esc 关闭）'
        : `面板暂时放不下（终端太窄？）。配置文件: ${configPath()}`,
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command === undefined && e.isMeta !== true) {
      void loadConfig($).then(() => fire($, 'prompt_submit'))
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) void fire($, 'turn_start')
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const isMain = e.agentId === undefined
    if (isMain && e.tool === 'Bash') void fire($, 'tool_bash')
    else if (isMain && EDIT_TOOLS.has(e.tool)) void fire($, 'tool_edit')
    const ran = await next(e)
    if (isMain && ran.deny === undefined && ran.isError === true) void fire($, 'tool_error')
    return ran
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.agentId === undefined && e.tool_use_id !== undefined) {
      void fire($, 'permission')
    }
    return verdict
  })

  on('agent.spawn', async ($, e, next) => {
    void fire($, 'agent_spawn')
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId === undefined) void fire($, 'compact')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      void fire($, e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'aborted' : 'error')
    }
    return done
  })

  on('session.end', async ($, e, next) => {
    // Wait for the clip, or the process may exit and cut it off.
    if (e.reason !== 'clear') await fire($, 'session_end', { shouldWait: true })
    return next(e)
  })

  // The band above the prompt: a speaker that switches the voice on and off, the pack
  // in use, the line playing now, and a button that opens the pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const cfg = await read($, config)
    if (!cfg.showBand) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await read($, playing)
    const title = await packTitle($, cfg.pack)
    return (
      <Box gap={1}>
        <Button
          key="band-toggle"
          plain
          label={cfg.enabled ? '\u{1F50A}' : '\u{1F507}'}
          onPress={() => saveConfig($, c => ({ ...c, enabled: !c.enabled }))}
        />
        <Text dimColor={!cfg.enabled}>{cfg.enabled ? title : `${title}（已静音）`}</Text>
        {now !== '' && <Text color="green">▶ {baseName(now).replace(AUDIO_EXT, '')}</Text>}
        <Button
          key="band-open"
          plain
          dimColor
          label="⚙"
          onPress={async () => {
            await loadConfig($)
            if ((await read($, catalog)) === null) void refreshCatalog($)
            await openPane($)
          }}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Select } = $.ui.resolve(e)
    const cfg = await read($, config)
    const open = await read($, editing)
    const listed = await read($, expanded)
    const message = await read($, note)
    const packs = await listPacks($)
    const online = await read($, catalog)
    const downloading = await read($, busy)
    const rows = await Promise.all(
      EVENTS.map(async meta => {
        const setting = cfg.events[meta.key]
        const clips = await clipsFor($, cfg, meta.key)
        return { meta, setting, clips, isCustom: setting.custom.length > 0 }
      }),
    )

    const change = (fn: (cfg: VoiceConfig) => VoiceConfig) => () => saveConfig($, fn)
    const setStage = (key: VoiceEvent, fn: (one: EventSetting) => EventSetting) =>
      change(c => ({ ...c, events: { ...c.events, [key]: fn(c.events[key]) } }))
    const preview = (key: VoiceEvent) => async () => {
      const now = await read($, config)
      const file = pickOne(await clipsFor($, now, key), key)
      if (file === undefined) await update($, note, () => `「${META[key].label}」没有可播放的语音`)
      else await playOne(file)
    }
    const playOne = async (file: string) => {
      await update($, note, () => `▶ ${baseName(file)}`)
      await playFile($, file, (await read($, config)).volume)
    }
    const startEdit = (stage: VoiceEvent, mode: Editing['mode']) => async () => {
      await update($, editing, () => ({ stage, mode }))
      await update($, note, () => '')
      await $.ui.focus({ requestId: PANE, key: 'file' }).catch(() => undefined)
    }
    const stopEdit = async (stage: VoiceEvent, mode: Editing['mode']) => {
      await update($, editing, () => null)
      await $.ui
        .focus({ requestId: PANE, key: `${mode === 'add' ? 'add' : 'swap'}-${stage}` })
        .catch(() => undefined)
    }
    const toggleList = (stage: VoiceEvent) => () =>
      update($, expanded, now => (now === stage ? null : stage))
    const volume = (delta: number) =>
      change(c => ({ ...c, volume: clamp(Math.round((c.volume + delta) * 10) / 10, 0, 1.5) }))

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box gap={2}>
          <Button
            key="master"
            variant="primary"
            label={cfg.enabled ? '语音: 开' : '语音: 关'}
            onPress={change(c => ({ ...c, enabled: !c.enabled }))}
          />
          <Box gap={1}>
            <Button key="vol-down" label="-" onPress={volume(-0.1)} />
            <Text>音量 {Math.round(cfg.volume * 100)}%</Text>
            <Button key="vol-up" label="+" onPress={volume(0.1)} />
          </Box>
          <Button
            key="band"
            dimColor
            label={cfg.showBand ? '输入框上方: 显示' : '输入框上方: 隐藏'}
            onPress={change(c => ({ ...c, showBand: !c.showBand }))}
          />
        </Box>
        <Select
          key="pack"
          label="语音包 "
          value={cfg.pack}
          options={
            packs.length > 0
              ? packs.map(one => ({ value: one.name, label: one.title }))
              : [{ value: cfg.pack, label: `${cfg.pack}（未安装）` }]
          }
          onSelect={pack => saveConfig($, c => ({ ...c, pack }))}
        />
        {!packs.some(one => one.name === cfg.pack) && (
          <Text color="yellow">当前语音包「{cfg.pack}」还没安装，在下面「在线语音包」里下载一个</Text>
        )}
        <Text dimColor>─ 生命周期 ─ [x] 开关 · ▶ 随机试听 · 换 替换 · 加 追加 · N 条 展开 ─</Text>
        {rows.map(({ meta, setting, clips, isCustom }) => (
          <Box key={`stage-${meta.key}`} flexDirection="column">
            <Box key={`row-${meta.key}`} gap={1}>
              <Button
                key={`on-${meta.key}`}
                label={setting.enabled ? '[x]' : '[ ]'}
                onPress={setStage(meta.key, one => ({ ...one, enabled: !one.enabled }))}
              />
              <Box width={12}>
                <Text dimColor={!setting.enabled}>{meta.label}</Text>
              </Box>
              <Button key={`play-${meta.key}`} label="▶" onPress={preview(meta.key)} />
              <Button key={`swap-${meta.key}`} label="换" onPress={startEdit(meta.key, 'replace')} />
              <Button key={`add-${meta.key}`} label="加" onPress={startEdit(meta.key, 'add')} />
              <Button
                key={`list-${meta.key}`}
                dimColor
                label={`${listed === meta.key ? '▾' : '▸'} ${clips.length} 条`}
                onPress={toggleList(meta.key)}
              />
              <Text dimColor>{describe(clips, isCustom)}</Text>
              {isCustom && (
                <Button
                  key={`reset-${meta.key}`}
                  dimColor
                  label="恢复默认"
                  onPress={async () => {
                    const old = (await read($, config)).events[meta.key].custom
                    await saveConfig($, c => ({
                      ...c,
                      events: { ...c.events, [meta.key]: { ...c.events[meta.key], custom: [] } },
                    }))
                    await removeOwnCopies($, old)
                    await update($, note, () => `「${meta.label}」已恢复语音包默认`)
                  }}
                />
              )}
            </Box>
            {listed === meta.key && (
              <Box key={`clips-${meta.key}`} flexDirection="column" paddingLeft={4}>
                {clips.length === 0 && <Text dimColor>（这个阶段没有语音）</Text>}
                {!isCustom && clips.length > 0 && (
                  <Text dimColor>语音包自带，随机播放；「加」自己的语音后只在自己加的里面随机</Text>
                )}
                {clips.map((file, i) => (
                  <Box key={`clip-${meta.key}-${i}`} gap={1}>
                    <Button key={`hear-${meta.key}-${i}`} label="▶" onPress={() => playOne(file)} />
                    <Text>{baseName(file)}</Text>
                    {isCustom && (
                      <Button
                        key={`rm-${meta.key}-${i}`}
                        dimColor
                        label="✕"
                        onPress={() => removeVoice($, meta.key, file)}
                      />
                    )}
                  </Box>
                ))}
              </Box>
            )}
            {open?.stage === meta.key && (
              <Box key={`edit-${meta.key}`} gap={1} paddingLeft={4}>
                <Input
                  key="file"
                  label={open.mode === 'add' ? '追加语音 ' : '替换语音 '}
                  placeholder={
                    open.mode === 'add'
                      ? '拖入一个或多个音频文件，回车追加'
                      : '拖入一个或多个音频文件，回车替换'
                  }
                  submitLabel={open.mode === 'add' ? '追加' : '替换'}
                  autoFocus
                  onSubmit={async value => {
                    if (value.trim() === '' || (await addVoices($, meta.key, value, open.mode))) {
                      await stopEdit(meta.key, open.mode)
                    }
                  }}
                />
                <Button key="cancel" dimColor label="取消" onPress={() => stopEdit(meta.key, open.mode)} />
              </Box>
            )}
          </Box>
        ))}
        <Box gap={1}>
          <Text dimColor>─ 在线语音包 ─────────────────────────</Text>
          <Button key="catalog-refresh" dimColor label="刷新" onPress={() => refreshCatalog($)} />
        </Box>
        {online === null && <Text dimColor>正在读取列表…</Text>}
        {online !== null && online.length === 0 && <Text dimColor>（列表为空或读取失败）</Text>}
        {(online ?? []).map(pack => {
          const have = packs.find(one => one.name === pack.name)
          const isOutdated = have !== undefined && have.version < pack.version
          const isLoading = downloading === pack.name
          return (
            <Box key={`pack-${pack.name}`} gap={1}>
              <Box width={20}>
                <Text bold={cfg.pack === pack.name}>{pack.title}</Text>
              </Box>
              <Box width={16}>
                <Text dimColor>
                  {pack.clips} 条 · {formatSize(pack.size)}
                </Text>
              </Box>
              {isLoading && <Text color="yellow">下载中…</Text>}
              {!isLoading && have === undefined && (
                <Button key={`get-${pack.name}`} label="下载" onPress={() => download($, pack)} />
              )}
              {!isLoading && isOutdated && (
                <Button key={`get-${pack.name}`} label="更新" onPress={() => download($, pack)} />
              )}
              {!isLoading && have !== undefined && cfg.pack === pack.name && <Text color="green">使用中</Text>}
              {!isLoading && have !== undefined && cfg.pack !== pack.name && (
                <Button
                  key={`use-${pack.name}`}
                  label="使用"
                  onPress={() => saveConfig($, c => ({ ...c, pack: pack.name }))}
                />
              )}
              {!isLoading && have !== undefined && (
                <Button
                  key={`del-${pack.name}`}
                  dimColor
                  label="删除"
                  onPress={() => deletePack($, pack.name, pack.title)}
                />
              )}
            </Box>
          )
        })}
        {message !== '' && <Text color="yellow">{message}</Text>}
        <Text dimColor>配置: {configPath()} · Esc 关闭</Text>
      </Box>
    )
  })
}
