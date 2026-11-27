// Builds crafted `docker save` folders for docker/image-fs.test.ts (DEV-p5-image-host-07, owner's answer to
// Q-p5-image-host-4 (a)). Each folder is what `docker save` hands docker/image-fs.ts: index.json,
// manifest.json, a config blob and the layer blobs, every blob named by its SHA-256. The tar headers are
// written byte by byte here (ustar, PAX `x`/`g`, GNU `L`/`K`), so a test can produce exactly one malformed
// detail and nothing else: the rest of the folder stays valid, and the reader's refusal comes from the
// branch under test. Node's standard library only. Not part of either image: both Dockerfiles' build
// contexts are allowlists (docker/*.Dockerfile.dockerignore) that do not let these files in.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

export interface TarEntry {
  /** The header's name field (at most 100 bytes; longer names go through pax() or gnuLong()). */
  name: string
  /** The typeflag: '0' file (default), '1' hard link, '2' symlink, '5' directory, '\0', 'x', 'g', … */
  type?: string
  mode?: number
  uid?: number
  gid?: number
  data?: Buffer | string
  /** The size field when it should differ from the data's length. */
  size?: number
  linkname?: string
  /** Changes the finished header (after its checksum), to make it malformed on purpose. */
  corrupt?: (block: Buffer) => void
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

function octal(block: Buffer, start: number, width: number, value: number): void {
  block.write(value.toString(8).padStart(width - 1, '0') + '\0', start, width, 'latin1')
}

/** One 512-byte ustar header, its checksum computed as the format defines it. */
export function header(entry: TarEntry): Buffer {
  const block = Buffer.alloc(512)
  const data = entry.data === undefined ? Buffer.alloc(0) : Buffer.from(entry.data)
  const name = Buffer.from(entry.name, 'utf8')
  if (name.length > 100) throw new Error(`craft: name '${entry.name}' is longer than 100 bytes`)
  name.copy(block, 0)
  octal(block, 100, 8, entry.mode ?? (entry.type === '5' ? 0o755 : 0o644))
  octal(block, 108, 8, entry.uid ?? 0)
  octal(block, 116, 8, entry.gid ?? 0)
  octal(block, 124, 12, entry.size ?? data.length)
  octal(block, 136, 12, 0)
  block.write(entry.type ?? '0', 156, 1, 'latin1')
  Buffer.from(entry.linkname ?? '', 'utf8').copy(block, 157)
  block.write('ustar\u000000', 257, 8, 'latin1')
  withChecksum(block)
  entry.corrupt?.(block)
  return block
}

/** Writes a header's checksum for its current bytes (after a test changed a field on purpose). */
export function withChecksum(block: Buffer): Buffer {
  block.fill(0x20, 148, 156)
  let sum = 0
  for (const byte of block) sum += byte
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1')
  return block
}

/** A PAX extended header (`x`, or `g` for a global one) holding the given records. */
export function pax(records: Record<string, string | Buffer>, type = 'x'): TarEntry {
  const parts: Buffer[] = []
  for (const [key, value] of Object.entries(records)) {
    const body = Buffer.concat([Buffer.from(` ${key}=`, 'utf8'), Buffer.from(value), Buffer.from('\n')])
    // The length counts the whole record, its own digits included.
    let length = body.length + 1
    while (String(length).length + body.length !== length) length = String(length).length + body.length
    parts.push(Buffer.concat([Buffer.from(String(length), 'latin1'), body]))
  }
  return { name: 'PaxHeaders/entry', type, data: Buffer.concat(parts) }
}

/** A GNU long name (`L`) or long link (`K`) for the next entry. */
export function gnuLong(value: string, type: 'L' | 'K' = 'L'): TarEntry {
  return { name: '././@LongLink', type, data: Buffer.concat([Buffer.from(value, 'utf8'), Buffer.alloc(1)]) }
}

/** A tar stream: every entry and its padded data, the two zero blocks, then `trailer` if given. */
export function tar(entries: TarEntry[], trailer?: Buffer): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    parts.push(header(entry))
    const data = entry.data === undefined ? Buffer.alloc(0) : Buffer.from(entry.data)
    parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  parts.push(Buffer.alloc(1024))
  if (trailer) parts.push(trailer)
  return Buffer.concat(parts)
}

export interface Layer {
  /** The blob as stored (gzip, raw tar or anything else). */
  blob: Buffer
  /** The config's diff_id for it: the SHA-256 of the uncompressed tar. */
  diffId: string
  /** The history entry's created_by (default `RUN /bin/sh -c true # buildkit`). */
  createdBy?: string
  /** Store the blob under this digest instead of its own (a blob whose name is not its SHA-256). */
  blobName?: string
}

export const gzipLayer = (tarBytes: Buffer, createdBy?: string): Layer => ({
  blob: gzipSync(tarBytes),
  diffId: `sha256:${sha256(tarBytes)}`,
  createdBy,
})
export const rawLayer = (tarBytes: Buffer, createdBy?: string): Layer => ({
  blob: tarBytes,
  diffId: `sha256:${sha256(tarBytes)}`,
  createdBy,
})

/** What a test may break in the folder itself (DEV-p5-image-host-21). */
export interface FolderOptions {
  /** Store the config blob under this digest instead of its own. */
  configName?: string
  /** Rewrite the manifest's layer list (drop one, or replace a ref). */
  manifestLayers?: (refs: string[]) => string[]
  /** How many images manifest.json and index.json list (default 1 each). */
  manifestCount?: number
  indexCount?: number
}

/** Writes a `docker save` folder; `expected` is the diff_id list as check-images.sh passes it. */
export function saveFolder(
  parent: string,
  layers: Layer[],
  options: FolderOptions = {},
): { dir: string; expected: string } {
  const dir = mkdtempSync(join(parent, 'save-'))
  mkdirSync(join(dir, 'blobs', 'sha256'), { recursive: true })
  const blob = (bytes: Buffer, name?: string): string => {
    const ref = `blobs/sha256/${name ?? sha256(bytes)}`
    writeFileSync(join(dir, ref), bytes)
    return ref
  }
  const diffIds = layers.map((l) => l.diffId)
  const config = Buffer.from(
    JSON.stringify({
      architecture: 'amd64',
      os: 'linux',
      config: {},
      rootfs: { type: 'layers', diff_ids: diffIds },
      history: layers.map((l) => ({ created_by: l.createdBy ?? 'RUN /bin/sh -c true # buildkit' })),
    }),
  )
  const refs = layers.map((l) => blob(l.blob, l.blobName))
  const image = { Config: blob(config, options.configName), Layers: (options.manifestLayers ?? ((r) => r))(refs) }
  const manifest = Array.from({ length: options.manifestCount ?? 1 }, () => image)
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
  const manifests = Array.from({ length: options.indexCount ?? 1 }, () => ({}))
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests }))
  return { dir, expected: diffIds.join(',') }
}

/** A fresh scratch folder for one test file's save folders and models. */
export const scratch = (): string => mkdtempSync(join(tmpdir(), 'image-fs-test-'))
