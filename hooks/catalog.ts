import type { EngineInterface } from 'claude-code'

import type { CatalogPack, InstalledPack } from '../types'

type $ = EngineInterface

export const DEFAULT_CATALOG_URL =
  'https://raw.githubusercontent.com/fingergohappy/eva-voice-packs/main/index.json'

/** A pack name is also a folder name: keep it to something that can't escape the folder. */
export const isPackName = (name: string): boolean => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function toCatalogPack(raw: unknown): CatalogPack | undefined {
  if (!isRecord(raw)) return undefined
  const { name, title, description, game, version, clips, size, sha256, url } = raw
  if (typeof name !== 'string' || !isPackName(name)) return undefined
  if (typeof url !== 'string' || !url.startsWith('https://')) return undefined
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return undefined
  return {
    name,
    title: typeof title === 'string' && title !== '' ? title : name,
    description: typeof description === 'string' ? description : '',
    game: typeof game === 'string' ? game : '',
    version: typeof version === 'number' ? version : 0,
    clips: typeof clips === 'number' ? clips : 0,
    size: typeof size === 'number' ? size : 0,
    sha256,
    url,
  }
}

export async function fetchCatalog($: $, url: string): Promise<CatalogPack[]> {
  const res = await $.http.fetch(url, { headers: { 'Cache-Control': 'no-cache' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const raw: unknown = JSON.parse(res.text)
  const list = isRecord(raw) && Array.isArray(raw.packs) ? raw.packs : []
  return list.map(toCatalogPack).filter((one): one is CatalogPack => one !== undefined)
}

export async function listInstalled($: $, roots: readonly string[]): Promise<InstalledPack[]> {
  const found = new Map<string, InstalledPack>()
  for (const root of roots) {
    const entries = await $.fs.list(root).catch(() => [])
    for (const one of entries) {
      if (one.kind !== 'dir' || one.name.startsWith('.') || found.has(one.name)) continue
      const meta = await $.fs
        .read(`${root}/${one.name}/pack.json`)
        .then(text => JSON.parse(text) as unknown)
        .catch(() => undefined)
      found.set(one.name, {
        name: one.name,
        title: isRecord(meta) && typeof meta.title === 'string' ? meta.title : one.name,
        version: isRecord(meta) && typeof meta.version === 'number' ? meta.version : 0,
      })
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

async function run($: $, argv: readonly string[], timeoutMs = 30_000): Promise<string> {
  const ran = await $.process.run(argv, { timeoutMs })
  if (ran.exitCode !== 0) {
    const why = ran.stderr.trim().split('\n').pop() || `exit ${ran.exitCode}`
    throw new Error(`${argv[0]}: ${why}`)
  }
  return ran.stdout
}

/**
 * Downloads the pack's zip, checks its hash, and swaps it in under `packsDir/<name>`.
 * Throws with a short reason; leaves the old copy in place when anything fails.
 */
export async function installPack($: $, packsDir: string, pack: CatalogPack): Promise<void> {
  if (!isPackName(pack.name)) throw new Error(`bad pack name: ${pack.name}`)
  const work = `${packsDir}/.download-${pack.name}`
  const zip = `${work}/pack.zip`
  const unpacked = `${work}/unpacked`
  await run($, ['rm', '-rf', work])
  await run($, ['mkdir', '-p', unpacked])
  try {
    await run($, ['curl', '-fsSL', '--retry', '2', '-o', zip, pack.url], 300_000)
    const sum = await run($, [
      'sh',
      '-c',
      'sha256sum "$1" 2>/dev/null || shasum -a 256 "$1"',
      'sh',
      zip,
    ])
    if (sum.trim().split(/\s+/)[0] !== pack.sha256) throw new Error('下载的文件校验不通过')
    await run($, ['unzip', '-q', '-o', zip, '-d', unpacked], 120_000)
    if (!(await $.fs.exists(`${unpacked}/${pack.name}/pack.json`))) {
      throw new Error('压缩包里没有这个语音包')
    }
    await run($, ['rm', '-rf', `${packsDir}/${pack.name}`])
    await run($, ['mv', `${unpacked}/${pack.name}`, `${packsDir}/${pack.name}`])
  } finally {
    await run($, ['rm', '-rf', work]).catch(() => undefined)
  }
}

export async function removePack($: $, packsDir: string, name: string): Promise<void> {
  if (!isPackName(name)) throw new Error(`bad pack name: ${name}`)
  await run($, ['rm', '-rf', `${packsDir}/${name}`])
}

export const formatSize = (bytes: number): string =>
  bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1e3))}KB`
