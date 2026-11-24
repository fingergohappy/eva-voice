import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

declare const setTimeout: (fn: () => void, ms: number) => unknown

const PANE = {
  plugin: 'eva-voice',
  component: 'Pane',
  requestId: 'eva-voice',
  props: {
    title: '语音 · eva-voice',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

type Ran = { argv: readonly string[] }

/** What the fake sha256sum answers for any file. */
const SHA = 'a'.repeat(64)

/** Stands in for the engine: a fake home, one pack with one clip per event, pw-play. */
function fakeHost(on: On, { installed = ['red-alert-2'] }: { installed?: string[] } = {}) {
  const ran: Ran[] = []
  const written = new Map<string, string>()
  on('env.get', () => ({ value: '/home/tester' }))
  on('command.register', () => ({ value: { command: 'voices' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('fs.read', (_, e) => {
    const text = written.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_, e) => {
    written.set(e.path, e.text)
    return { value: undefined }
  })
  on('ui.focus', () => ({}))
  on('fs.stat', (_, e) => {
    // Files under /music/; a value naming several paths at once is not one file.
    if (!e.path.startsWith('/music/') || / ['"]?\//.test(e.path)) throw new Error('ENOENT')
    return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }
  })
  on('fs.list', (_, e) => {
    if (e.path.endsWith('/packs') && !e.path.startsWith('/home/tester')) {
      return { value: installed.map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
    }
    if (e.path.includes('/packs/red-alert-2/')) {
      return { value: [{ name: 'clip.wav', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }
    }
    throw new Error('ENOENT')
  })
  on('process.run', (_, e) => {
    ran.push({ argv: e.argv })
    const isHash = e.argv[0] === 'sh' && String(e.argv[2]).includes('sha256')
    const stdout = isHash ? `${SHA}  pack.zip\n` : e.argv[0] === 'sh' ? '/usr/bin/pw-play\n' : ''
    return {
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  return { ran, written }
}

const plays = (ran: readonly Ran[]) => ran.filter(one => one.argv[0] === 'pw-play')

test('a prompt plays its clip through pw-play', async ($, on) => {
  const { ran } = fakeHost(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
  // fire() is not awaited by the hook; give it a moment.
  await new Promise<void>(resolve => setTimeout(() => resolve(), 50))

  const files = plays(ran).map(one => one.argv[one.argv.length - 1])
  expect(files.some(file => file?.endsWith('/packs/red-alert-2/session_start/clip.wav'))).toBe(true)
})

test('the pane lists every stage and its switch writes the config', async ($, on) => {
  const { written } = fakeHost(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // The master switch flips each press: off on the first surface, on again on the second.
  let isOn = true
  for (const surface of ['terminal', 'desktop'] as const) {
    written.clear()
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /会话开始/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /会话结束/ })).toBeDefined()

    await ui.press({ key: 'master' })
    const saved = JSON.parse(written.get('/home/tester/.config/eva-voice/config.json') ?? '{}')
    isOn = !isOn
    expect(saved.enabled).toBe(isOn)
    await ui.unmount()
  }
})

test('换 on a stage opens a file field under that row and replaces its voice', async ($, on) => {
  const { ran, written } = fakeHost(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ key: 'file' })).toBeUndefined()
  await ui.press({ key: 'swap-done' })
  expect(await ui.find({ key: 'file' })).toBeDefined()

  await ui.input({ key: 'file', text: "'/music/my win.wav'" })
  const saved = JSON.parse(written.get('/home/tester/.config/eva-voice/config.json') ?? '{}')
  const custom: string[] = saved.events.done.custom
  expect(custom.length).toBe(1)
  expect(custom[0]?.startsWith('/home/tester/.config/eva-voice/custom/done/my_win-')).toBe(true)
  expect(ran.some(one => one.argv[0] === 'cp' && one.argv[1] === '/music/my win.wav')).toBe(true)
  // The field closes once replaced, and the row offers the way back.
  expect(await ui.find({ key: 'file' })).toBeUndefined()
  expect(await ui.find({ key: 'reset-done' })).toBeDefined()
  await ui.unmount()
})

test('an online pack downloads, checks its hash and becomes the pack in use', async ($, on) => {
  // No pack on disk yet: the first one downloaded becomes the one in use.
  const { ran, written } = fakeHost(on, { installed: [] })
  const sha = SHA
  const index = {
    version: 1,
    packs: [
      { name: 'starcraft', title: '星际争霸 · 人族', version: 1, clips: 50, size: 9e6, sha256: sha, url: 'https://example.test/starcraft.zip' },
    ],
  }
  on('http.fetch', () => ({
    value: { status: 200, ok: true, headers: {}, text: JSON.stringify(index) },
  }))
  on('fs.exists', (_, e) => ({ value: e.path.endsWith('/unpacked/starcraft/pack.json') }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'voices', args: '' } as never).catch(() => undefined)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'get-starcraft' })

  const argvs = ran.map(one => one.argv.join(' '))
  expect(argvs.some(cmd => cmd.startsWith('curl ') && cmd.endsWith('https://example.test/starcraft.zip'))).toBe(true)
  expect(argvs.some(cmd => cmd.startsWith('unzip '))).toBe(true)
  expect(
    argvs.some(cmd => cmd === 'mv /home/tester/.config/eva-voice/packs/.download-starcraft/unpacked/starcraft /home/tester/.config/eva-voice/packs/starcraft'),
  ).toBe(true)
  const saved = JSON.parse(written.get('/home/tester/.config/eva-voice/config.json') ?? '{}')
  expect(saved.pack).toBe('starcraft')
  await ui.unmount()
})

test('the band above the prompt names the pack and its speaker mutes the voice', async ($, on) => {
  const { written } = fakeHost(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({
    plugin: 'eva-voice',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: {
      hasSurvey: false,
      isCollapsed: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 100,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  } as never)

  expect(await ui.find({ type: 'Text', text: /red-alert-2/ })).toBeDefined()
  await ui.press({ key: 'band-toggle' })
  const saved = JSON.parse(written.get('/home/tester/.config/eva-voice/config.json') ?? '{}')
  expect(saved.enabled).toBe(false)
  expect(await ui.find({ type: 'Text', text: /已静音/ })).toBeDefined()
  await ui.unmount()
})

test('加 adds several dropped files beside the stage\'s own, and ✕ takes one out', async ($, on) => {
  const { ran, written } = fakeHost(on)
  const saved = () => JSON.parse(written.get('/home/tester/.config/eva-voice/config.json') ?? '{}')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'swap-done' })
  await ui.input({ key: 'file', text: '/music/one.wav' })
  expect(saved().events.done.custom.length).toBe(1)

  // Two files dropped at once: one escaped, one quoted.
  await ui.press({ key: 'add-done' })
  await ui.input({ key: 'file', text: "/music/two\\ b.wav '/music/three.wav'" })
  const custom: string[] = saved().events.done.custom
  expect(custom.length).toBe(3)
  expect(ran.some(one => one.argv[0] === 'cp' && one.argv[1] === '/music/two b.wav')).toBe(true)
  expect(ran.some(one => one.argv[0] === 'cp' && one.argv[1] === '/music/three.wav')).toBe(true)

  await ui.press({ key: 'list-done' })
  expect(await ui.find({ key: 'hear-done-2' })).toBeDefined()
  await ui.press({ key: 'rm-done-0' })
  expect(saved().events.done.custom).toEqual(custom.slice(1))
  expect(ran.some(one => one.argv[0] === 'rm' && one.argv.includes(custom[0] ?? ''))).toBe(true)
  await ui.unmount()
})
