// The host-side image reader (p5-image-host; DEV-p5-image-scan-10, -14, -15). It reads a built image as data,
// from `docker save`, and never runs a binary from the image: the layer tarballs are parsed here, on the
// host, entry by entry, and the image's final filesystem is rebuilt from them the way the engine stacks
// them (later layers win, whiteouts delete, opaque directories hide what is below). A check that asked the
// image's own `find`, `sh`, `cat` or `apk` could be lied to by a wrapper copied in from an earlier stage
// (-15); and the setuid check could not see file capabilities, which survive COPY as a `security.capability`
// extended attribute (-14). Both are read here from the tar headers themselves, including PAX records.
//
//   node docker/image-fs.ts read <docker save folder> <expected diff_ids, comma-separated> <model.json>
//   node docker/image-fs.ts list <model.json>                 every path, as `tar -t` of an export lists it
//   node docker/image-fs.ts special <model.json>              setuid/setgid files, capabilities, any xattr
//   node docker/image-fs.ts cat <model.json> <path>           a file's bytes (symlinks followed in the image)
//   node docker/image-fs.ts exists <model.json> <path>...     the given paths that exist (as lstat sees them)
//   node docker/image-fs.ts uid <model.json> <USER>           the uid a container gets for that USER
//   node docker/image-fs.ts apk-state <model.json>            /etc/apk, hashed, then world (check-images.sh)
//   node docker/image-fs.ts apk-installed <model.json>        name<TAB>version per installed package
//   node docker/image-fs.ts vercmp <a> <b>                    apk's version order: <, = or >
//   node docker/image-fs.ts node-packages <model.json>        name@version of every package.json
//   node docker/image-fs.ts layers <base.json> <model.json> <expected history file>
//   node docker/image-fs.ts added <base.json> <model.json> <packages the apk line names> <root>...
//   node docker/image-fs.ts header-include <model.json> <path>  the nginx header include: header lines only
//   node docker/image-fs.ts pnpm-store <model.json> <node_modules> <pnpm list --json file>
//                                                             installed packages = the lockfile's production tree
//
// Fails closed: an unreadable or unknown blob, a digest that does not match, a compression it does not
// know, a tar entry type or PAX key it does not know, a malformed header, a path with `..`, an entry under
// a symlink, a hard link to nothing: each is an error and exit 2, never a partial model. The checks print
// one finding per line and exit 1 if there is any; check-images.sh counts them.
import { createHash, type Hash } from 'node:crypto'
import { createReadStream, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { createGunzip, createZstdDecompress } from 'node:zlib'

type Kind = 'file' | 'dir' | 'symlink'

interface Entry {
  kind: Kind
  mode: number
  uid: number
  gid: number
  size: number
  layer: number
  xattrs: string[]
  sha256?: string
  sha1?: string
  elf?: boolean
  target?: string
  hardlinkOf?: string
  content?: string // base64, only for the small files the checks read (KEEP_CONTENT)
}

// One change a layer makes, in tar order: an entry, a whiteout (deletes a lower path) or an opaque marker.
interface Change {
  op: 'entry' | 'hardlink' | 'whiteout' | 'opaque'
  path: string
  entry?: Entry
  link?: string
}

interface Model {
  diffIds: string[]
  config: { Env?: string[]; Entrypoint?: string[] | null; Cmd?: string[] | null; User?: string }
  history: { created_by: string; empty_layer: boolean }[]
  layers: Change[][]
  files: Record<string, Entry>
}

class Fatal extends Error {}
// A declaration, not an arrow function, so TypeScript narrows after `if (...) fatal(...)`.
function fatal(message: string): never {
  throw new Fatal(message)
}

// Contents kept for the files the checks read: apk's database and config, the user database, and every
// package.json (the language-package list the scan coverage is compared with, DEV-p5-image-scan-04 (b)),
// and the nginx header include the build stage writes (checked line by line, DEV-p5-image-host-03).
const KEEP_MAX = 4 * 1024 * 1024
const keepContent = (path: string): boolean =>
  /^(etc\/(apk\/.*|passwd|group|nginx\/ascrum\/security-headers\.conf)|lib\/apk\/db\/.*)$/.test(path) ||
  /(^|\/)package\.json$/.test(path)

// --- Paths ------------------------------------------------------------------------------------------
// A tar name as the engine applies it: relative to the root, no `.` or `..` segment, no empty segment.
// The root itself ("./", "/") is ''.
// C0 controls and DEL (a character test, not a regex: lint refuses control characters in one).
const hasControl = (s: string): boolean => [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
// What this reader prints (findings, errors) shows a control character as \xNN, tab included, so no
// image-derived text can start a new log line (DEV-p5-image-host-05). It is also kept from being read as a
// workflow command (DEV-p5-image-host-13 / sec-09), the same way docker/log-safe.sh does it for the scripts: the runner takes
// `##[` anywhere in a line as its old command form, so every `##[` becomes `##(`; and every colon followed
// by a colon gets a `?` after it, so no `::` is left anywhere (`::` → `:?:`, `:::` → `:?:?:`). The runner's
// `::` form is found after .NET TrimStart(), which drops every Unicode blank, so escaping it only after
// ASCII blanks was not enough (DEV-p5-image-host-14 / sec-10).
const printable = (s: string): string =>
  [...s]
    .map((c) => {
      const n = c.charCodeAt(0)
      return n < 0x20 || n === 0x7f ? `\\x${n.toString(16).padStart(2, '0')}` : c
    })
    .join('')
    .replaceAll('##[', '##(')
    .replace(/:(?=:)/g, ':?')
function normalise(raw: string, what: string): string {
  if (raw.includes('\0')) fatal(`${what}: a NUL byte in the name`)
  // DEV-p5-image-host-05: a control character (CR, ESC, ...) in a path could forge a workflow command
  // or a terminal sequence wherever a path is printed. Neither clean image has one, so it is refused
  // here, before any path reaches the output; the message escapes it instead of printing it.
  if (hasControl(raw)) fatal(`${what}: a control character in the name ${JSON.stringify(raw)}`)
  let name = raw
  while (name.startsWith('./')) name = name.slice(2)
  name = name.replace(/^\/+/, '').replace(/\/+$/, '')
  if (name === '' || name === '.') return ''
  const parts = name.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..'))
    fatal(`${what}: path '${raw}' has an empty, '.' or '..' segment`)
  return name
}
const parentOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
const isUnder = (path: string, dir: string): boolean => dir === '' || path === dir || path.startsWith(dir + '/')

// --- Tar ------------------------------------------------------------------------------------------
const utf8 = new TextDecoder('utf-8', { fatal: true })
const text = (bytes: Uint8Array, what: string): string => {
  try {
    return utf8.decode(bytes)
  } catch {
    return fatal(`${what}: a name that is not valid UTF-8`)
  }
}
const cstring = (block: Buffer, start: number, length: number): Buffer => {
  const field = block.subarray(start, start + length)
  const nul = field.indexOf(0)
  return nul === -1 ? field : field.subarray(0, nul)
}
// Octal ASCII (NUL or space terminated), or base-256 when the top bit of the first byte is set.
function numeric(block: Buffer, start: number, length: number, what: string): number {
  const field = block.subarray(start, start + length)
  if (field[0] !== undefined && (field[0] & 0x80) !== 0) {
    if ((field[0] & 0x40) !== 0) fatal(`${what}: a negative base-256 number`)
    let value = BigInt(field[0] & 0x3f)
    for (const byte of field.subarray(1)) value = (value << 8n) | BigInt(byte)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fatal(`${what}: a base-256 number too large`)
    return Number(value)
  }
  const digits = field
    .toString('latin1')
    .replace(/[\0 ]+$/, '')
    .replace(/^ +/, '')
  if (digits === '') return 0
  if (!/^[0-7]+$/.test(digits)) fatal(`${what}: '${digits}' is not an octal number`)
  return parseInt(digits, 8)
}
// "<length> <key>=<value>\n" records; the length counts the whole record (POSIX pax).
function paxRecords(data: Buffer, what: string): Map<string, Buffer> {
  const records = new Map<string, Buffer>()
  let at = 0
  while (at < data.length) {
    const space = data.indexOf(0x20, at)
    if (space === -1) fatal(`${what}: a PAX record without a length`)
    const lengthText = data.subarray(at, space).toString('latin1')
    if (!/^[1-9][0-9]*$/.test(lengthText)) fatal(`${what}: a PAX record length '${lengthText}'`)
    const end = at + Number(lengthText)
    if (end > data.length || data[end - 1] !== 0x0a) fatal(`${what}: a PAX record that overruns or lacks its newline`)
    const record = data.subarray(space + 1, end - 1)
    const equals = record.indexOf(0x3d)
    if (equals <= 0) fatal(`${what}: a PAX record without a key`)
    records.set(record.subarray(0, equals).toString('latin1'), Buffer.from(record.subarray(equals + 1)))
    at = end
  }
  return records
}
// The PAX keys a layer may carry. Anything else (GNU sparse files, a charset, a comment, a key from a
// newer writer) is not understood here, so it fails rather than being ignored.
const PAX_IGNORED = new Set(['mtime', 'atime', 'ctime', 'uname', 'gname'])

interface Header {
  name: string
  type: string
  mode: number
  uid: number
  gid: number
  size: number
  linkname: string
  xattrs: string[]
}

// A tar stream parser that fails closed: header checksums verified, only the entry types a layer uses,
// GNU long names and PAX extended headers applied to the next entry, the end marker required and nothing
// but zeros after it. `onEntry` is called with each entry's header; its data (regular files only) goes
// to the returned sink, chunk by chunk.
interface Sink {
  data(chunk: Buffer): void
  end(): void
}
class TarParser {
  private buffer: Buffer = Buffer.alloc(0)
  private remaining = 0
  private padding = 0
  private sink: Sink | undefined
  private meta: 'pax' | 'longname' | 'longlink' | undefined
  private metaData: Buffer[] = []
  private pax = new Map<string, Buffer>()
  private longName: string | undefined
  private longLink: string | undefined
  // Extended headers already read for the next entry (DEV-p5-image-host-01 (3)): a second one of the
  // same kind is refused, because the engine keeps only the last where this reader would merge.
  private pending = new Set<string>()
  private zeros = 0
  private ended = false
  private readonly what: string
  private readonly onEntry: (header: Header) => Sink | undefined

  constructor(what: string, onEntry: (header: Header) => Sink | undefined) {
    this.what = what
    this.onEntry = onEntry
  }

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    for (;;) {
      if (this.remaining > 0) {
        if (this.buffer.length === 0) return
        const take = Math.min(this.remaining, this.buffer.length)
        const part = this.buffer.subarray(0, take)
        if (this.meta) this.metaData.push(Buffer.from(part))
        else this.sink?.data(part)
        this.buffer = this.buffer.subarray(take)
        this.remaining -= take
        if (this.remaining > 0) return
        this.finishData()
        continue
      }
      if (this.padding > 0) {
        const take = Math.min(this.padding, this.buffer.length)
        this.buffer = this.buffer.subarray(take)
        this.padding -= take
        if (this.padding > 0) return
        continue
      }
      if (this.buffer.length < 512) return
      const block = this.buffer.subarray(0, 512)
      this.buffer = this.buffer.subarray(512)
      if (this.ended) {
        if (block.some((b) => b !== 0)) fatal(`${this.what}: data after the end-of-archive marker`)
        continue
      }
      if (block.every((b) => b === 0)) {
        this.zeros += 1
        if (this.zeros === 2) this.ended = true
        continue
      }
      if (this.zeros > 0) fatal(`${this.what}: a single zero block in the middle of the archive`)
      this.header(block)
    }
  }

  finish(): void {
    if (this.remaining > 0 || this.padding > 0 || this.meta) fatal(`${this.what}: the archive ends inside an entry`)
    if (!this.ended) fatal(`${this.what}: the archive has no end-of-archive marker (two zero blocks)`)
    if (this.buffer.some((b) => b !== 0)) fatal(`${this.what}: trailing bytes after the end-of-archive marker`)
  }

  private finishData(): void {
    if (this.meta) {
      const data = Buffer.concat(this.metaData)
      if (this.meta === 'pax') {
        for (const [key, value] of paxRecords(data, this.what)) this.pax.set(key, value)
      } else {
        const name = text(cstring(data, 0, data.length), this.what)
        if (this.meta === 'longname') this.longName = name
        else this.longLink = name
      }
      this.meta = undefined
      this.metaData = []
    } else {
      this.sink?.end()
      this.sink = undefined
    }
  }

  private header(block: Buffer): void {
    let sum = 0
    let signed = 0
    for (let i = 0; i < 512; i++) {
      const byte = i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0)
      sum += byte
      signed += byte > 127 ? byte - 256 : byte
    }
    const stored = numeric(block, 148, 8, this.what)
    if (stored !== sum && stored !== signed) fatal(`${this.what}: a header checksum does not match`)
    const magic = block.subarray(257, 265).toString('latin1')
    const ustar = magic === 'ustar\u000000'
    const gnu = magic === 'ustar  \u0000'
    if (!ustar && !gnu && magic !== '\0'.repeat(8)) fatal(`${this.what}: unknown tar magic ${JSON.stringify(magic)}`)
    const typeflag = String.fromCharCode(block[156] ?? 0)
    const size = numeric(block, 124, 12, this.what)
    const padded = (n: number) => (512 - (n % 512)) % 512

    if (typeflag === 'x' || typeflag === 'L' || typeflag === 'K') {
      // Unreachable today (DEV-p5-image-host-19): header() runs only once the previous extended header's
      // data is fully read, and finishData() clears `meta` at that point (at once for a size-0 header), so
      // no test can reach it. Kept as defence in depth, in case a later change ends that data lazily.
      if (this.meta) fatal(`${this.what}: nested extended headers`)
      if (this.pending.has(typeflag)) fatal(`${this.what}: two '${typeflag}' extended headers for one entry`)
      this.pending.add(typeflag)
      if (size > 16 * 1024 * 1024) fatal(`${this.what}: an extended header of ${size} bytes`)
      this.meta = typeflag === 'x' ? 'pax' : typeflag === 'L' ? 'longname' : 'longlink'
      this.remaining = size
      this.padding = padded(size)
      if (size === 0) this.finishData()
      return
    }
    // A global PAX header would change every later entry; layers do not use one, so it is refused.
    if (typeflag === 'g') fatal(`${this.what}: a global PAX header`)

    // DEV-p5-image-host-01 (2): with both a GNU long name and a PAX path (or long link and PAX linkpath)
    // the engine takes the GNU one; rather than pick, the entry is refused. BuildKit never writes both.
    if (
      (this.longName !== undefined || this.longLink !== undefined) &&
      (this.pax.has('path') || this.pax.has('linkpath'))
    )
      fatal(`${this.what}: an entry has both a GNU long name or link and a PAX path or linkpath`)
    this.pending = new Set()
    let name = text(cstring(block, 0, 100), this.what)
    const prefix = ustar ? text(cstring(block, 345, 155), this.what) : ''
    if (prefix !== '') name = `${prefix}/${name}`
    if (this.longName !== undefined) name = this.longName
    let linkname = text(cstring(block, 157, 100), this.what)
    if (this.longLink !== undefined) linkname = this.longLink
    let entrySize = size
    let uid = numeric(block, 108, 8, this.what)
    let gid = numeric(block, 116, 8, this.what)
    const xattrs: string[] = []
    for (const [key, value] of this.pax) {
      if (key === 'path') name = text(value, this.what)
      else if (key === 'linkpath') linkname = text(value, this.what)
      else if (key === 'size' || key === 'uid' || key === 'gid') {
        const v = value.toString('latin1')
        if (!/^[0-9]+$/.test(v)) fatal(`${this.what}: PAX ${key} '${v}' is not a number`)
        if (key === 'size') entrySize = Number(v)
        else if (key === 'uid') uid = Number(v)
        else gid = Number(v)
      } else if (key.startsWith('SCHILY.xattr.')) xattrs.push(key.slice('SCHILY.xattr.'.length))
      else if (key.startsWith('LIBARCHIVE.xattr.')) {
        xattrs.push(Buffer.from(key.slice('LIBARCHIVE.xattr.'.length), 'base64').toString('latin1'))
      } else if (!PAX_IGNORED.has(key)) fatal(`${this.what}: PAX key '${key}' is not understood by this reader`)
    }
    this.pax = new Map()
    this.longName = undefined
    this.longLink = undefined

    const KNOWN: Record<string, string> = { '0': 'file', '\0': 'file', '1': 'hardlink', '2': 'symlink', '5': 'dir' }
    const type = KNOWN[typeflag]
    // DEV-p5-image-host-01 (4): an old-style regular file (`\0`, or `0`) whose name ends in `/` is made a
    // directory by the engine. BuildKit writes directories as type 5, so such an entry is refused.
    if (type === 'file' && name.endsWith('/'))
      fatal(`${this.what}: entry '${name}' is a regular-file type with a directory name`)
    // Character and block devices, FIFOs, contiguous files, GNU sparse, multi-volume and anything else:
    // neither clean image has one, and an unknown type must not be skipped.
    if (type === undefined)
      fatal(`${this.what}: entry '${name}' has tar type '${typeflag}', which a layer here may not use`)
    if (type !== 'file' && entrySize !== 0)
      fatal(`${this.what}: ${type} entry '${name}' carries ${entrySize} bytes of data`)
    const header: Header = {
      name,
      type: type as string,
      mode: numeric(block, 100, 8, this.what) & 0o7777,
      uid,
      gid,
      size: entrySize,
      linkname,
      xattrs,
    }
    this.sink = this.onEntry(header)
    this.remaining = entrySize
    this.padding = padded(entrySize)
    if (entrySize === 0) {
      this.sink?.end()
      this.sink = undefined
    }
  }
}

// --- docker save ------------------------------------------------------------------------------------
const DIGEST = /^[0-9a-f]{64}$/
function blobPath(dir: string, ref: string, what: string): string {
  const m = /^blobs\/sha256\/([0-9a-f]{64})$/.exec(ref)
  if (!m) fatal(`${what}: '${ref}' is not a blobs/sha256/<digest> path`)
  const path = join(dir, ref)
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat?.isFile()) fatal(`${what}: ${ref} is missing or not a regular file`)
  return path
}
const sha256File = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

// Streams one layer blob: checks the blob's own digest (its name), picks the decompressor from the magic
// bytes, hashes the uncompressed tar (which must equal the config's diff_id) and parses it.
async function readLayer(path: string, index: number, diffId: string): Promise<Change[]> {
  const what = `layer ${index}`
  const head = Buffer.alloc(512)
  const raw = createReadStream(path, { start: 0, end: 511 })
  let got = 0
  for await (const chunk of raw as AsyncIterable<Buffer>) {
    chunk.copy(head, got)
    got += chunk.length
  }
  let decompress: Transform | undefined
  if (head[0] === 0x1f && head[1] === 0x8b) decompress = createGunzip()
  else if (head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd)
    decompress = createZstdDecompress()
  else if (got < 512 || head.subarray(257, 262).toString('latin1') !== 'ustar') {
    fatal(`${what}: neither gzip, zstd nor a ustar archive`)
  }
  const blobHash = createHash('sha256')
  const tarHash = createHash('sha256')
  const changes: Change[] = []
  const parser = new TarParser(what, (header) => onLayerEntry(header, index, changes, what))
  const source = createReadStream(path)
  const feed = (chunk: Buffer) => {
    tarHash.update(chunk)
    parser.push(chunk)
  }
  if (decompress) {
    source.on('data', (chunk) => blobHash.update(chunk as Buffer))
    source.on('error', (error) => decompress.destroy(error))
    source.pipe(decompress)
    for await (const chunk of decompress as AsyncIterable<Buffer>) feed(chunk)
  } else {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      blobHash.update(chunk)
      feed(chunk)
    }
  }
  parser.finish()
  const blobDigest = blobHash.digest('hex')
  if (`blobs/sha256/${blobDigest}` !== path.slice(path.lastIndexOf('blobs/'))) {
    fatal(`${what}: the blob's SHA-256 is ${blobDigest}, not its name`)
  }
  const uncompressed = `sha256:${tarHash.digest('hex')}`
  if (uncompressed !== diffId) fatal(`${what}: the uncompressed tar is ${uncompressed}, the config says ${diffId}`)
  return changes
}

function onLayerEntry(header: Header, layer: number, changes: Change[], what: string): Sink | undefined {
  const path = normalise(header.name, what)
  const base = baseName(path)
  if (base.startsWith('.wh.')) {
    if (header.type !== 'file' || header.size !== 0) fatal(`${what}: whiteout '${path}' is not an empty file`)
    if (base === '.wh..wh..opq') changes.push({ op: 'opaque', path: parentOf(path) })
    else if (base.startsWith('.wh..wh.'))
      fatal(`${what}: '${path}' is an overlay metadata file this reader does not know`)
    else {
      const name = base.slice(4)
      if (name === '' || name === '.' || name === '..') fatal(`${what}: whiteout '${path}' names no file`)
      changes.push({ op: 'whiteout', path: parentOf(path) === '' ? name : `${parentOf(path)}/${name}` })
    }
    return undefined
  }
  const entry: Entry = {
    kind: header.type === 'dir' ? 'dir' : header.type === 'symlink' ? 'symlink' : 'file',
    mode: header.mode,
    uid: header.uid,
    gid: header.gid,
    size: header.size,
    layer,
    xattrs: header.xattrs,
  }
  if (header.type === 'hardlink') {
    changes.push({ op: 'hardlink', path, entry, link: normalise(header.linkname, what) })
    return undefined
  }
  if (header.type === 'symlink') {
    if (header.linkname === '') fatal(`${what}: symlink '${path}' has no target`)
    if (hasControl(header.linkname))
      fatal(`${what}: symlink '${path}' has a control character in its target ${JSON.stringify(header.linkname)}`)
    entry.target = header.linkname
  }
  changes.push({ op: 'entry', path, entry })
  if (entry.kind !== 'file') return undefined
  const sha256: Hash = createHash('sha256')
  const sha1: Hash = createHash('sha1')
  const keep = keepContent(path) && header.size <= KEEP_MAX ? ([] as Buffer[]) : undefined
  let first = Buffer.alloc(0)
  return {
    data(chunk) {
      sha256.update(chunk)
      sha1.update(chunk)
      if (first.length < 4) first = Buffer.concat([first, chunk.subarray(0, 4 - first.length)])
      keep?.push(Buffer.from(chunk))
    },
    end() {
      entry.sha256 = sha256.digest('hex')
      entry.sha1 = sha1.digest('base64')
      entry.elf = first.length === 4 && first.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      if (keep) entry.content = Buffer.concat(keep).toString('base64')
    },
  }
}

// Stacks the layers: each layer's whiteouts and opaque markers act on the layers below it, then its
// entries are applied in order. An entry whose parent is a symlink or a file is refused: the engine
// would resolve it inside the root, and this reader does not model that, so it fails instead.
function apply(files: Map<string, Entry>, layer: Change[], index: number): void {
  const what = `layer ${index}`
  const removeTree = (path: string, keepSelf: boolean) => {
    for (const key of [...files.keys()]) {
      if ((key === path && !keepSelf) || (path === '' ? key !== '' : key.startsWith(path + '/'))) {
        if ((files.get(key)?.layer ?? index) < index) files.delete(key)
      }
    }
  }
  for (const change of layer) {
    if (change.op === 'whiteout') removeTree(change.path, false)
    else if (change.op === 'opaque') removeTree(change.path, true)
  }
  for (const change of layer) {
    if (change.op === 'whiteout' || change.op === 'opaque') continue
    const path = change.path
    const parts = path === '' ? [] : path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join('/')
      const existing = files.get(ancestor)
      if (existing === undefined) {
        // The engine creates a missing parent as a root-owned 0755 directory.
        files.set(ancestor, { kind: 'dir', mode: 0o755, uid: 0, gid: 0, size: 0, layer: index, xattrs: [] })
      } else if (existing.kind !== 'dir') {
        fatal(`${what}: '${path}' is under '${ancestor}', which is a ${existing.kind}, not a directory`)
      }
    }
    let entry = change.entry as Entry
    if (change.op === 'hardlink') {
      const target = files.get(change.link as string)
      if (target?.kind !== 'file') fatal(`${what}: hard link '${path}' points at '${change.link}', which is not a file`)
      // One inode. The engine applies the link header's mode, owner and attributes to that inode, so they
      // would change the target too (a 04755 link to a 0755 file makes both setuid). BuildKit writes a
      // link with its target's metadata; anything else is refused (DEV-p5-image-host-01 (1)).
      const t = target as Entry
      const sorted = (x: string[]) => [...x].sort().join('\n')
      if (
        entry.mode !== t.mode ||
        entry.uid !== t.uid ||
        entry.gid !== t.gid ||
        sorted(entry.xattrs) !== sorted(t.xattrs)
      )
        fatal(`${what}: hard link '${path}' has a mode, owner or attributes different from its target '${change.link}'`)
      entry = { ...t, layer: index, hardlinkOf: change.link }
    }
    const existing = files.get(path)
    if (existing?.kind === 'dir' && entry.kind !== 'dir') removeTree(path, true)
    files.set(path, entry)
  }
}

async function read(dir: string, expected: string, out: string): Promise<void> {
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { manifests?: unknown[] }
  if (!Array.isArray(index.manifests) || index.manifests.length !== 1) fatal('index.json: not exactly one image')
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
    Config?: string
    Layers?: string[]
  }[]
  if (!Array.isArray(manifest) || manifest.length !== 1) fatal('manifest.json: not exactly one image')
  const m = manifest[0] as { Config?: string; Layers?: string[] }
  const configPath = blobPath(dir, m.Config ?? '', 'config')
  if (`blobs/sha256/${sha256File(configPath)}` !== m.Config) fatal("config: the blob's SHA-256 is not its name")
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    rootfs?: { type?: string; diff_ids?: string[] }
    history?: { created_by?: string; empty_layer?: boolean }[]
    config?: Model['config']
  }
  const diffIds = config.rootfs?.diff_ids ?? []
  if (config.rootfs?.type !== 'layers' || diffIds.some((d) => !DIGEST.test(d.replace(/^sha256:/, '')))) {
    fatal('config: rootfs is not a list of sha256 layer digests')
  }
  // The engine's own view of the image (docker image inspect .RootFS.Layers), so the saved copy read here
  // is the image the other checks inspect and run.
  if (diffIds.join(',') !== expected) fatal(`config: diff_ids ${diffIds.join(',')} are not the image's ${expected}`)
  const layers = m.Layers ?? []
  if (layers.length !== diffIds.length)
    fatal(`manifest: ${layers.length} layers, the config has ${diffIds.length} diff_ids`)
  const history = (config.history ?? []).map((h) => ({
    created_by: h.created_by ?? '',
    empty_layer: h.empty_layer === true,
  }))
  if (history.filter((h) => !h.empty_layer).length !== layers.length) {
    fatal(
      `config: ${history.filter((h) => !h.empty_layer).length} history entries with a layer, ${layers.length} layers`,
    )
  }
  const files = new Map<string, Entry>()
  files.set('', { kind: 'dir', mode: 0o755, uid: 0, gid: 0, size: 0, layer: -1, xattrs: [] })
  const changes: Change[][] = []
  for (const [i, ref] of layers.entries()) {
    const layer = await readLayer(blobPath(dir, ref, `layer ${i}`), i, diffIds[i] as string)
    apply(files, layer, i)
    // Contents are only needed in the final filesystem; the per-layer record keeps metadata.
    changes.push(layer.map((c) => (c.entry ? { ...c, entry: { ...c.entry, content: undefined } } : c)))
  }
  const model: Model = {
    diffIds,
    config: config.config ?? {},
    history,
    layers: changes,
    files: Object.fromEntries([...files].filter(([path]) => path !== '')),
  }
  writeFileSync(out, JSON.stringify(model))
  console.log(`read ${layers.length} layers, ${files.size - 1} paths in the final filesystem`)
}

// --- Queries over a model -----------------------------------------------------------------------------
const load = (path: string): Model => JSON.parse(readFileSync(path, 'utf8')) as Model
const sortC = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// Resolves a path in the image as the kernel would inside the container: every symlink, relative or
// absolute, followed within the image's root, at most 40 of them. More is fatal, or, with `loopIsMissing`
// (pnpm-store's links, where a loop is the image's own finding, not a reason to stop), the path does not
// resolve.
function resolve(model: Model, path: string, followLast: boolean, loopIsMissing = false): string | undefined {
  let pending = normalise(path, 'resolve').split('/').filter(Boolean)
  const done: string[] = []
  let hops = 0
  while (pending.length > 0) {
    const part = pending.shift() as string
    if (part === '..') {
      done.pop()
      continue
    }
    if (part === '.') continue
    const candidate = [...done, part].join('/')
    const entry = model.files[candidate]
    if (entry === undefined) return undefined
    if (entry.kind === 'symlink' && (pending.length > 0 || followLast)) {
      if (++hops > 40) {
        if (loopIsMissing) return undefined
        fatal(`resolve: too many symlinks at ${candidate}`)
      }
      const target = entry.target as string
      if (target.startsWith('/')) done.length = 0
      pending = [...target.split('/').filter(Boolean), ...pending]
      continue
    }
    done.push(part)
  }
  return done.join('/')
}
function contentOf(model: Model, path: string): Buffer {
  const real = resolve(model, path, true)
  const entry = real === undefined ? undefined : model.files[real]
  if (entry?.kind !== 'file') fatal(`${path}: not a file in the image`)
  if ((entry as Entry).content === undefined) fatal(`${path}: its contents were not kept by the reader`)
  return Buffer.from((entry as Entry).content as string, 'base64')
}

function list(model: Model): string[] {
  return Object.entries(model.files)
    .map(([path, e]) => (e.kind === 'dir' ? `${path}/` : path))
    .sort(sortC)
}

// setuid/setgid on anything that is not a directory (a setgid directory only sets the group of new files),
// a file capability on anything, and any other extended attribute at all: neither clean image has one, so
// an unexpected attribute fails until someone decides it belongs.
function special(model: Model): string[] {
  const findings: string[] = []
  for (const [path, e] of Object.entries(model.files).sort(([a], [b]) => sortC(a, b))) {
    if (e.kind !== 'dir' && (e.mode & 0o6000) !== 0) {
      findings.push(
        `/${path}: ${(e.mode & 0o4000) !== 0 ? 'setuid' : 'setgid'} (mode ${e.mode.toString(8)}, layer ${e.layer})`,
      )
    }
    for (const x of e.xattrs) {
      findings.push(
        x === 'security.capability'
          ? `/${path}: a file capability (security.capability xattr, layer ${e.layer})`
          : `/${path}: extended attribute ${x} (layer ${e.layer})`,
      )
    }
  }
  return findings
}

// What `docker run` does with Config.User: a number is the uid; a name is looked up in the image's own
// /etc/passwd (read here as data). `user:group` takes the user part.
function uidFor(model: Model, user: string): number {
  const name = user.split(':')[0] ?? ''
  if (name === '') return 0
  if (/^[0-9]+$/.test(name)) return Number(name)
  for (const line of contentOf(model, 'etc/passwd').toString('utf8').split('\n')) {
    const fields = line.split(':')
    if (fields[0] === name) {
      if (!/^[0-9]+$/.test(fields[2] ?? '')) fatal(`etc/passwd: user ${name} has uid '${fields[2]}'`)
      return Number(fields[2])
    }
  }
  return fatal(`etc/passwd: no user ${name}`)
}

// The same listing check-images.sh used to make with the image's own sh, find and sha256sum: every path
// under /etc/apk except world, with its type and content hash, then world's entries, sorted.
function apkState(model: Model): string[] {
  const root = resolve(model, 'etc/apk', true)
  if (root === undefined || model.files[root]?.kind !== 'dir') fatal('/etc/apk is not a directory in the image')
  const lines: [string, string][] = [['.', 'dir .']]
  for (const [path, e] of Object.entries(model.files)) {
    if (!path.startsWith(`${root}/`) || path === `${root}/world`) continue
    const rel = `./${path.slice((root as string).length + 1)}`
    const line =
      e.kind === 'symlink' ? `link ${rel} -> ${e.target}` : e.kind === 'file' ? `file ${e.sha256} ${rel}` : `dir ${rel}`
    lines.push([rel, line])
  }
  const sorted = lines.sort(([a], [b]) => sortC(a, b)).map(([, line]) => line)
  const world = contentOf(model, 'etc/apk/world').toString('utf8').split(/\s+/).filter(Boolean).sort(sortC)
  return [...sorted, 'world:', ...world]
}

interface Package {
  name: string
  version: string
  dirs: Set<string>
  files: Map<string, string | undefined> // path -> Z: checksum
}
// apk's installed database (/lib/apk/db/installed): blank-line separated records of `X:value` lines. P is
// the name, V the version, F a directory (relative to the root), R a file in the last F, Z the checksum of
// the last R (Q1 + base64 SHA-1, or Q2 + base64 SHA-256).
function apkInstalled(model: Model): Package[] {
  const packages: Package[] = []
  let current: Package | undefined
  let dir: string | undefined
  let file: string | undefined
  for (const line of contentOf(model, 'lib/apk/db/installed').toString('utf8').split('\n')) {
    if (line === '') {
      current = undefined
      dir = undefined
      file = undefined
      continue
    }
    const m = /^([A-Za-z]):(.*)$/.exec(line)
    if (hasControl(line)) fatal(`lib/apk/db/installed: a control character in ${JSON.stringify(line)}`)
    if (!m) fatal(`lib/apk/db/installed: a line that is not 'X:value': ${line}`)
    const key = m[1] ?? ''
    const value = m[2] ?? ''
    // A record starts at its first line (apk writes C:, the package checksum, before P:).
    if (!current) {
      current = { name: '', version: '', dirs: new Set(), files: new Map() }
      packages.push(current)
    }
    const pkg = current
    if (key === 'P') {
      if (pkg.name !== '') fatal(`lib/apk/db/installed: a second P: in one record (${pkg.name}, ${value})`)
      pkg.name = value
    } else if (key === 'V') pkg.version = value
    else if (key === 'F') {
      dir = normalise(value, 'apk F:')
      pkg.dirs.add(dir)
      file = undefined
    } else if (key === 'R') {
      if (dir === undefined) fatal(`lib/apk/db/installed: R:${value} before any F: in ${pkg.name}`)
      file = dir === '' ? value : `${dir}/${value}`
      pkg.files.set(normalise(file, 'apk R:'), undefined)
    } else if (key === 'Z' && file !== undefined) pkg.files.set(file, value)
  }
  for (const p of packages) {
    if (p.name === '' || p.version === '') fatal(`lib/apk/db/installed: a record without P: or V: (${p.name})`)
  }
  return packages
}

// Every file of the given packages must be in the image with the checksum apk recorded (a symlink's
// checksum is of its target). A packaged file replaced by something else (a wrapper over /sbin/apk, a
// patched library) fails. Only the packages this Dockerfile's apk line changed: the bases themselves edit
// a few packaged files (/etc/passwd, group and shadow for their users; nginx.conf and default.conf in the
// unprivileged nginx image), and those are compared with the base instead, by `added`.
function apkVerify(model: Model, names: Set<string>): string[] {
  const findings: string[] = []
  for (const pkg of apkInstalled(model)) {
    if (!names.has(pkg.name)) continue
    for (const [path, z] of pkg.files) {
      const e = model.files[path]
      if (e === undefined) {
        findings.push(`/${path} (${pkg.name}): listed by apk but not in the image`)
        continue
      }
      if (z === undefined) {
        findings.push(`/${path} (${pkg.name}): apk lists no checksum for it`)
        continue
      }
      const m = /^Q([12])(.+)$/.exec(z)
      if (!m) {
        findings.push(`/${path} (${pkg.name}): checksum '${z}' is not Q1 or Q2`)
        continue
      }
      let have: string | undefined
      if (e.kind === 'file') have = m[1] === '1' ? e.sha1 : Buffer.from(e.sha256 ?? '', 'hex').toString('base64')
      else if (e.kind === 'symlink') {
        have = createHash(m[1] === '1' ? 'sha1' : 'sha256')
          .update(e.target ?? '')
          .digest('base64')
      }
      if (have !== m[2]) findings.push(`/${path} (${pkg.name}): content does not match apk's checksum`)
    }
  }
  return findings
}

// apk's version order (apk-tools version.c): dot-separated numbers compared as integers, an optional
// letter, `_suffix[N]` (alpha < beta < pre < rc < none < cvs < svn < git < hg < p), then `-rN`; where one
// version runs out first, the longer one is greater, except that a pre-release suffix makes it smaller.
// apk compares a later number with a leading zero (1.02) as a decimal fraction; no version here has one,
// so such a version is refused rather than compared. So is anything else outside the grammar (a `~hash`).
const SUFFIXES = ['alpha', 'beta', 'pre', 'rc', '', 'cvs', 'svn', 'git', 'hg', 'p']
interface Version {
  nums: string[]
  letter: string
  suffixes: [number, bigint][]
  rev: bigint
}
function parseVersion(v: string): Version {
  const m = /^([0-9]+(?:\.[0-9]+)*)([a-z]?)((?:_(?:alpha|beta|pre|rc|cvs|svn|git|hg|p)[0-9]*)*)(?:-r([0-9]+))?$/.exec(v)
  if (!m) return fatal(`'${v}' is not an apk version this check understands`)
  if ((m[1] as string).split('.').some((n, i) => i > 0 && n.length > 1 && n.startsWith('0'))) {
    fatal(`'${v}' has a number with a leading zero, which apk compares as a fraction; not supported here`)
  }
  // DEV-p5-image-host-06: a suffix with no number (`_rc`) is refused. apk-tools 3.0.9 does not treat it as
  // `_rc0`: `1.30.7_rc` < `1.30.7_rc0`, yet `1.0_rc_p` > `1.0_rc0_p`, so no simple rule matches it. No
  // installed version in either image or base, and no floor, has one; it fails closed instead.
  const suffixes = [...(m[3] ?? '').matchAll(/_([a-z]+)([0-9]*)/g)].map((s): [number, bigint] => {
    if (s[2] === '')
      fatal(`'${v}' has a suffix with no number (_${s[1]}), which apk orders inconsistently; not supported here`)
    return [SUFFIXES.indexOf(s[1] as string), BigInt(s[2] as string)]
  })
  return {
    nums: (m[1] as string).split('.'),
    letter: m[2] ?? '',
    suffixes,
    // No revision sorts below -r0 (apk-tools 3.0.9: `apk version -t 1.4 1.4-r0` prints <).
    rev: m[4] === undefined ? -1n : BigInt(m[4]),
  }
}
function vercmp(a: string, b: string): '<' | '=' | '>' {
  const x = parseVersion(a)
  const y = parseVersion(b)
  const sign = (n: number): '<' | '=' | '>' => (n < 0 ? '<' : n > 0 ? '>' : '=')
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const p = x.nums[i]
    const q = y.nums[i]
    if (p === undefined) return '<'
    if (q === undefined) return '>'
    if (BigInt(p) !== BigInt(q)) return BigInt(p) < BigInt(q) ? '<' : '>'
  }
  if (x.letter !== y.letter) return sign(sortC(x.letter, y.letter))
  for (let i = 0; i < Math.max(x.suffixes.length, y.suffixes.length); i++) {
    const p = x.suffixes[i] ?? [4, 0n]
    const q = y.suffixes[i] ?? [4, 0n]
    if (p[0] !== q[0]) return sign(p[0] - q[0])
    if (p[1] !== q[1]) return p[1] < q[1] ? '<' : '>'
  }
  return x.rev === y.rev ? '=' : x.rev < y.rev ? '<' : '>'
}

// name@version of every package.json in the image that has both (what a language-package scanner counts).
function nodePackages(model: Model): string[] {
  const out = new Set<string>()
  for (const [path, e] of Object.entries(model.files)) {
    if (e.kind !== 'file' || !/(^|\/)package\.json$/.test(path)) continue
    if (e.content === undefined) fatal(`/${path}: too large to read`)
    let json: { name?: unknown; version?: unknown }
    try {
      json = JSON.parse(Buffer.from(e.content as string, 'base64').toString('utf8')) as typeof json
    } catch {
      return fatal(`/${path}: not valid JSON`)
    }
    if (typeof json.name === 'string' && json.name !== '' && typeof json.version === 'string' && json.version !== '') {
      if (hasControl(json.name) || hasControl(json.version))
        fatal(`/${path}: a control character in its name or version ${JSON.stringify([json.name, json.version])}`)
      out.add(`${json.name}@${json.version}\t/${path}`)
    }
  }
  return [...out].sort(sortC)
}

// The image sits on its pinned base, and what the runtime stage did is what the Dockerfile says
// (DEV-p5-image-scan-10, -09, -11): the base's layers (by diff_id) and history entries are a prefix of the
// image's, and the image's own history entries that make a filesystem change (RUN, COPY, ADD, WORKDIR)
// are exactly the expected lines, in order, built from the runtime stage's text by check-images.sh. No other
// entry may carry a layer. The history is what BuildKit actually ran, so a SHELL hook, a heredoc or a
// reader mismatch that the text checks missed would show here as a different line.
function layers(base: Model, model: Model, expectedFile: string): string[] {
  const findings: string[] = []
  const prefix = model.diffIds.slice(0, base.diffIds.length)
  if (prefix.join(',') !== base.diffIds.join(','))
    findings.push("the image does not start with its base image's layers")
  const baseHistory = JSON.stringify(base.history)
  if (JSON.stringify(model.history.slice(0, base.history.length)) !== baseHistory) {
    findings.push("the image's history does not start with its base image's history")
  }
  const ours = model.history.slice(base.history.length)
  const changing = /^(RUN|COPY|ADD|WORKDIR) /
  for (const h of ours) {
    if (!h.empty_layer && !changing.test(h.created_by))
      findings.push(`a layer from a history entry that should not make one: ${h.created_by}`)
  }
  const actual = ours.filter((h) => changing.test(h.created_by)).map((h) => h.created_by)
  const expected = readFileSync(expectedFile, 'utf8').split('\n').filter(Boolean)
  if (actual.join('\n') !== expected.join('\n')) {
    findings.push(
      `its own history is not the runtime stage's RUN/COPY/WORKDIR lines: image [${actual.join(' | ')}], Dockerfile [${expected.join(' | ')}]`,
    )
  }
  return findings
}

// DEV-p5-image-scan-10: what the runtime stage may add to its base. Path by path, the final filesystem
// against the base's (kind, mode, owner, content or link target, xattrs; times are not compared):
//   - under one of the image's COPY roots (its own files: /app, the site root, nginx's two folders):
//     allowed, but no ELF binary or shared library, and a symlink must stay inside its root;
//   - one of apk's own state files (the installed database, scripts, triggers, world): allowed here, and
//     checked by the apk checks;
//   - a file or symlink that a package changed by this Dockerfile's apk line owns, with apk's checksum
//     (apk-verify checks the checksum itself): allowed;
//   - a directory one of those packages owns, or an ancestor of a COPY root: allowed;
//   - anything else, added or changed, fails: a wrapper in a PATH directory, a replaced library, a new
//     tool, wherever an earlier stage made it.
// Removals are allowed (rm -rf and apk del remove; removing cannot add a capability) and counted. Also
// per layer: a COPY or WORKDIR layer may touch only its roots and their ancestors.
const APK_STATE = new Set([
  'lib/apk/db/installed',
  'lib/apk/db/scripts.tar',
  'lib/apk/db/scripts.tar.gz',
  'lib/apk/db/triggers',
  'lib/apk/db/lock',
  'etc/apk/world',
  'var/log/apk.log', // apk's own log of what it did: text, not on any PATH
])
function added(base: Model, model: Model, allowed: string[], roots: string[]): string[] {
  const findings: string[] = []
  // The package set first: against the base, no package may be added (a floor names a package the base
  // already has, DEV-p5-image-scan-02), and only the packages the apk line names may change version or go.
  const before = new Map(apkInstalled(base).map((p) => [p.name, p.version]))
  const after = new Map(apkInstalled(model).map((p) => [p.name, p.version]))
  const changed = new Set<string>()
  for (const [name, version] of after) {
    const was = before.get(name)
    if (was === undefined) findings.push(`package ${name} ${version} is not in the base image`)
    else if (was !== version) {
      if (allowed.includes(name)) changed.add(name)
      else findings.push(`package ${name} changed from ${was} to ${version}, and the apk line does not name it`)
    }
  }
  for (const [name, version] of before) {
    if (!after.has(name) && !allowed.includes(name)) {
      findings.push(`package ${name} ${version} was removed, and the apk line does not name it`)
    }
  }
  findings.push(...apkVerify(model, changed))
  const owned = new Map<string, string>()
  const ownedDirs = new Set<string>()
  for (const pkg of apkInstalled(model)) {
    if (!changed.has(pkg.name)) continue
    for (const path of pkg.files.keys()) owned.set(path, pkg.name)
    for (const dir of pkg.dirs) ownedDirs.add(dir)
  }
  const ancestorOfRoot = (path: string) => roots.some((r) => r.startsWith(path + '/'))
  const same = (a: Entry, b: Entry) =>
    a.kind === b.kind &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.sha256 === b.sha256 &&
    a.target === b.target &&
    [...a.xattrs].sort().join() === [...b.xattrs].sort().join()
  let copied = 0
  let packaged = 0
  for (const [path, e] of Object.entries(model.files).sort(([a], [b]) => sortC(a, b))) {
    const b = base.files[path]
    const root = roots.find((r) => isUnder(path, r))
    if (root !== undefined) {
      // Every entry under a root, changed or not. DEV-p5-image-host-04: owned by root and not writable by
      // others (a symlink's own mode means nothing), so the unprivileged runtime user cannot change it.
      if (e.uid !== 0 || e.gid !== 0) findings.push(`/${path}: owned by ${e.uid}:${e.gid} under /${root}, not 0:0`)
      if (e.kind !== 'symlink' && (e.mode & 0o002) !== 0)
        findings.push(`/${path}: writable by others (mode ${e.mode.toString(8)}) under /${root}`)
      // DEV-p5-image-host-02: a symlink is resolved in the image as the kernel would (every link on the
      // way followed, at most 40, then exit 2), and the result must exist and stay under the root.
      if (e.kind === 'symlink') {
        const real = resolve(model, path, true)
        if (real === undefined) findings.push(`/${path}: a symlink to ${e.target} that does not resolve in the image`)
        else if (!isUnder(real, root))
          findings.push(`/${path}: a symlink to ${e.target}, which resolves to /${real}, outside /${root}`)
      }
      if (b !== undefined && same(b, e)) continue
      copied++
      if (e.kind === 'file' && e.elf) findings.push(`/${path}: an ELF binary or library under /${root}`)
      continue
    }
    if (b !== undefined && same(b, e)) continue
    if (APK_STATE.has(path)) continue
    if (e.kind !== 'dir' && owned.has(path)) {
      packaged++
      continue
    }
    if (e.kind === 'dir' && (ownedDirs.has(path) || ancestorOfRoot(path))) continue
    findings.push(
      `/${path}: ${b === undefined ? 'added' : 'changed'} (${e.kind}, mode ${e.mode.toString(8)}, layer ${e.layer}), outside the COPY roots and not a file of a package the apk line changes`,
    )
  }
  const removed = Object.keys(base.files).filter((p) => model.files[p] === undefined).length
  // Per layer: what each of the image's own COPY or WORKDIR layers wrote. A layer records every parent
  // directory of what it wrote; one the base already has with the same mode and owner is only that record.
  const ours = model.history.slice(base.history.length).filter((h) => !h.empty_layer)
  for (const [i, h] of ours.entries()) {
    const index = base.diffIds.length + i
    if (!/^(COPY|WORKDIR) /.test(h.created_by)) continue
    for (const c of model.layers[index] ?? []) {
      const b = base.files[c.path]
      const parentRecord = c.op === 'entry' && c.entry?.kind === 'dir' && b?.kind === 'dir' && same(b, c.entry)
      const ok =
        parentRecord ||
        ((c.op === 'entry' || c.op === 'hardlink') &&
          (roots.some((r) => isUnder(c.path, r)) || (c.entry?.kind === 'dir' && ancestorOfRoot(c.path))))
      if (!ok) findings.push(`layer ${index} (${h.created_by}): ${c.op} /${c.path} is outside the COPY roots`)
    }
  }
  console.error(
    `image-fs added: changed against the base: ${copied} paths under the COPY roots, ${packaged} packaged files; ${removed} paths removed`,
  )
  return findings
}

// The nginx header include (DEV-p5-image-host-03, owner's answer: header lines only; -12 / sec-08). The build
// stage writes it and nginx includes it inside `server {}`, so anything but header lines is server config
// from the build stage. The bytes come first: every byte must be printable ASCII (0x20-0x7e), a tab or a
// newline, before any line is matched. A NUL made GNU grep treat the file as binary and match nothing
// (WB6), while nginx skipped the NUL inside a comment and applied a `location` on the line before; CR,
// other C0 bytes, DEL, a BOM and anything at or above 0x80 are refused the same way. Then every line is
// blank, a comment, or one directive exactly as docker/web/security-headers.ts writes it:
// `add_header <name> "<value>" always;` (no `"`, `$` or backslash in the value) or `proxy_hide_header
// <name>;`. No `{`, `}`, `include`, variable or escape, nothing after the `;`, and at least one header.
function headerInclude(model: Model, path: string): { findings: string[]; adds: number; hides: number } {
  const bytes = contentOf(model, path)
  const findings: string[] = []
  let line = 1
  for (const b of bytes) {
    if (b === 0x0a) line++
    else if (b !== 0x09 && (b < 0x20 || b > 0x7e)) {
      findings.push(
        `/${path}: line ${line} has byte 0x${b.toString(16).padStart(2, '0')}, which is not printable ASCII`,
      )
    }
  }
  if (findings.length > 0) return { findings, adds: 0, hides: 0 }
  let adds = 0
  let hides = 0
  for (const [i, text] of bytes.toString('latin1').split('\n').entries()) {
    if (/^[ \t]*(#.*)?$/.test(text)) continue
    if (/^add_header [A-Za-z0-9-]+ "[^"$\\]+" always;$/.test(text)) adds++
    else if (/^proxy_hide_header [A-Za-z0-9-]+;$/.test(text)) hides++
    else findings.push(`/${path}: line ${i + 1} is not one add_header or proxy_hide_header directive`)
  }
  if (findings.length === 0 && adds === 0) findings.push(`/${path}: no add_header line, so no security header is sent`)
  return { findings, adds, hides }
}

// The API's installed packages against the lockfile's production tree (DEV-p5-image-host-10, -17). The
// expected tree is `pnpm list --lockfile-only --prod --depth Infinity --json` (check-images.sh runs it on
// the host): every package's `path` names its virtual-store directory and its own name in it
// (`…/.pnpm/<dir>/node_modules/<name>`). The image's side is the model's entries under `nm`, with their
// kinds as the layers recorded them (no symlink followed). pnpm's layout, and nothing else, may be there:
//   - top level: `.pnpm/` (a directory), `.modules.yaml` and `.pnpm-workspace-state-v1.json` (files), and
//     one symlink per production dependency, into that package's store directory; a scope `@s` is a
//     directory holding only such symlinks. Any other dot entry, file, directory or symlink is a finding;
//   - `.pnpm/`: `lock.yaml` (a file), `node_modules/` (pnpm's hoisted links: symlinks only, scopes as
//     directories of symlinks), and the store directories, exactly the lockfile's set. A non-directory
//     store name (a symlink `.pnpm/x@1`) is a finding;
//   - `.pnpm/<dir>/` holds only `node_modules/`, which holds the package's own directory (its scope as a
//     directory when scoped) and symlinks to its dependencies; no other real directory or file, and no
//     `node_modules` folder anywhere inside the package itself.
// Every symlink in these places must land, once resolved in the image (relative or absolute, every hop),
// on `.pnpm/<d>/node_modules/<name>`, the own directory of a store directory `d` that the lockfile maps to
// `<name>`, the link's own name (DEV-p5-image-host-24: links to a directory outside the store, to a
// subdirectory of a package, or under another name had passed). The tree also says which store directory
// each edge uses, so a top-level link must be a production dependency into the directory the tree names,
// and a link beside a store package must be one of that package's dependencies in the tree, into the
// directory the tree names. Hoisted links in `.pnpm/node_modules/` may go to any store directory of their
// name. A scope is a real directory everywhere, never a symlink. An npm alias (`"x": "npm:y@1"`) would be a
// link whose name is not its package's; there is none today, and one would fail here until this learns it.
// So no package can sit anywhere Node's lookup would find it unless the lockfile names it (sec-01: real
// directories in `.pnpm/node_modules/` and in a store directory's `node_modules/` had passed).
const PNPM_TOP_DOT = new Map([
  ['.pnpm', 'dir'],
  ['.modules.yaml', 'file'],
  ['.pnpm-workspace-state-v1.json', 'file'],
])
function pnpmStore(model: Model, nm: string, tree: unknown): { findings: string[]; summary: string } {
  // The expected side: store directory → its package's name, and the production dependencies.
  const store = new Map<string, string>()
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) for (const n of node) walk(n)
    else if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'path' && typeof value === 'string') {
          const m = /\/node_modules\/\.pnpm\/([^/]+)\/node_modules\/(.+)$/.exec(value)
          if (!m) continue
          const [dir, name] = [m[1] as string, m[2] as string]
          if (store.has(dir) && store.get(dir) !== name) fatal(`pnpm list: store directory ${dir} holds two packages`)
          store.set(dir, name)
        } else walk(value)
      }
    }
  }
  walk(tree)
  const root = (Array.isArray(tree) ? tree[0] : undefined) as
    { dependencies?: Record<string, unknown>; optionalDependencies?: Record<string, unknown> } | undefined
  const direct = new Set([...Object.keys(root?.dependencies ?? {}), ...Object.keys(root?.optionalDependencies ?? {})])
  if (store.size === 0 || direct.size === 0) fatal('pnpm list: no production packages, so nothing can be compared')
  // The tree's edges: from a store directory ('' for the project itself), each dependency name and the
  // store directories the tree resolves it to.
  const edges = new Map<string, Map<string, Set<string>>>()
  const addEdges = (node: unknown, from: string): void => {
    if (node === null || typeof node !== 'object') return
    for (const key of ['dependencies', 'optionalDependencies']) {
      const deps = (node as Record<string, unknown>)[key]
      if (deps === null || typeof deps !== 'object') continue
      for (const [name, child] of Object.entries(deps as Record<string, unknown>)) {
        const path = child !== null && typeof child === 'object' ? (child as { path?: unknown }).path : undefined
        const m = typeof path === 'string' ? /\/node_modules\/\.pnpm\/([^/]+)\/node_modules\/(.+)$/.exec(path) : null
        if (!m) continue
        const byName = edges.get(from) ?? new Map<string, Set<string>>()
        edges.set(from, byName)
        const dirs = byName.get(name) ?? new Set<string>()
        byName.set(name, dirs)
        dirs.add(m[1] as string)
        addEdges(child, m[1] as string)
      }
    }
  }
  addEdges(root, '')

  const findings: string[] = []
  const kind = (path: string): string | undefined => model.files[path]?.kind
  const children = (dir: string): string[] =>
    Object.keys(model.files)
      .filter((p) => parentOf(p) === dir)
      .map(baseName)
      .sort(sortC)
  const at = (...parts: string[]) => [nm, ...parts].join('/')
  if (kind(nm) !== 'dir') return { findings: [`/${nm}: not a directory in the image`], summary: '' }
  // A link must resolve to `.pnpm/<d>/node_modules/<name>`, a real directory, for a store directory `d`
  // the lockfile maps to `name` (the link's own name), and one of `dirs` when the tree names them.
  const linkLands = (path: string, name: string, dirs?: Set<string>): boolean => {
    const real = resolve(model, path, true, true)
    return (
      real !== undefined &&
      kind(real) === 'dir' &&
      [...store].some(
        ([d, n]) => n === name && (dirs === undefined || dirs.has(d)) && real === at('.pnpm', d, 'node_modules', name),
      )
    )
  }
  // A folder of pnpm's links: a scope is a real directory; every other entry, and every entry in a scope,
  // is a symlink that `check` accepts, except the package's own directory (`own`, a store's).
  const linkFolder = (
    dir: string,
    where: string,
    check: (path: string, name: string) => string | undefined,
    own?: string,
  ) => {
    for (const c of children(dir)) {
      const p = `${dir}/${c}`
      const names = c.startsWith('@')
        ? kind(p) === 'dir'
          ? children(p).map((s) => `${c}/${s}`)
          : (findings.push(`/${p}: a scope that is a ${kind(p)}, not a directory`), [])
        : [c]
      for (const name of names) {
        const q = `${dir}/${name}`
        if (q === own) continue
        if (kind(q) !== 'symlink') findings.push(`/${q}: a ${kind(q)} ${where}, not a symlink`)
        else {
          const why = check(q, name)
          if (why !== undefined) findings.push(`/${q}: ${why}`)
        }
      }
    }
  }

  // Top level.
  const top = new Set<string>()
  for (const c of children(nm)) {
    const p = at(c)
    if (c.startsWith('.')) {
      const want = PNPM_TOP_DOT.get(c)
      if (want === undefined) findings.push(`/${p}: a ${kind(p)} pnpm does not write at the top of node_modules`)
      else if (kind(p) !== want) findings.push(`/${p}: a ${kind(p)}, not a ${want}`)
      continue
    }
    const names = c.startsWith('@')
      ? kind(p) === 'dir'
        ? children(p).map((s) => `${c}/${s}`)
        : (findings.push(`/${p}: a scope that is a ${kind(p)}, not a directory`), [])
      : [c]
    for (const name of names) {
      top.add(name)
      const q = at(name)
      if (!direct.has(name)) findings.push(`/${q}: a top-level package the lockfile's production tree does not name`)
      else if (kind(q) !== 'symlink') findings.push(`/${q}: a ${kind(q)}, not pnpm's symlink into the store`)
      else if (!linkLands(q, name, edges.get('')?.get(name)))
        findings.push(`/${q}: a symlink that does not resolve to ${name}'s store directory`)
    }
  }
  for (const name of [...direct].sort(sortC)) {
    if (!top.has(name)) findings.push(`/${at(name)}: production dependency ${name} is missing`)
  }

  // The virtual store.
  const pnpmDir = at('.pnpm')
  const seen = new Set<string>()
  for (const c of kind(pnpmDir) === 'dir' ? children(pnpmDir) : []) {
    const p = `${pnpmDir}/${c}`
    if (c === 'lock.yaml') {
      if (kind(p) !== 'file') findings.push(`/${p}: a ${kind(p)}, not a file`)
    } else if (c === 'node_modules') {
      if (kind(p) !== 'dir') findings.push(`/${p}: a ${kind(p)}, not a directory`)
      else
        linkFolder(p, "in pnpm's hoisted links", (q, name) =>
          linkLands(q, name)
            ? undefined
            : `a symlink in pnpm's hoisted links that does not resolve to ${name}'s store directory`,
        )
    } else if (!store.has(c)) {
      findings.push(`/${p}: a ${kind(p)} in the store the lockfile's production tree does not name`)
    } else if (kind(p) !== 'dir') {
      findings.push(`/${p}: a ${kind(p)}, not a store directory`)
    } else {
      seen.add(c)
      const own = store.get(c) as string
      for (const x of children(p)) if (x !== 'node_modules') findings.push(`/${p}/${x}: not pnpm's node_modules folder`)
      const inner = `${p}/node_modules`
      const ownPath = `${inner}/${own}`
      if (kind(ownPath) !== 'dir') findings.push(`/${ownPath}: ${own}'s own directory is missing or not a directory`)
      linkFolder(
        inner,
        `beside ${own}`,
        (q, name) => {
          const dirs = edges.get(c)?.get(name)
          if (dirs === undefined) return `a symlink beside ${own} that the lockfile does not list as its dependency`
          return linkLands(q, name, dirs) ? undefined : `a symlink that does not resolve to ${name}'s store directory`
        },
        ownPath,
      )
      for (const path of Object.keys(model.files)) {
        if (
          path.startsWith(`${ownPath}/`) &&
          path
            .slice(ownPath.length + 1)
            .split('/')
            .includes('node_modules')
        ) {
          findings.push(`/${path}: a node_modules folder inside ${own}`)
        }
      }
    }
  }
  for (const dir of [...store.keys()].sort(sortC)) {
    if (!seen.has(dir) && kind(`${pnpmDir}/${dir}`) === undefined)
      findings.push(`/${pnpmDir}/${dir}: missing from the image`)
  }
  return {
    findings,
    summary: `/${nm}: exactly the lockfile's production tree in pnpm's layout: ${store.size} store directories (${[...store.keys()].sort(sortC).join(' ')}), top level ${[...direct].sort(sortC).join(' ')}`,
  }
}

// --- CLI ------------------------------------------------------------------------------------------
const [command, ...args] = process.argv.slice(2)
const report = (findings: string[]) => {
  for (const f of findings) console.log(printable(f))
  process.exitCode = findings.length > 0 ? 1 : 0
}
try {
  switch (command) {
    case 'read':
      if (args.length !== 3) fatal('usage: read <docker save folder> <diff_ids> <model.json>')
      await read(args[0] as string, args[1] as string, args[2] as string)
      break
    case 'list':
      process.stdout.write(list(load(args[0] as string)).join('\n') + '\n')
      break
    case 'special':
      report(special(load(args[0] as string)))
      break
    case 'cat':
      process.stdout.write(contentOf(load(args[0] as string), args[1] as string))
      break
    case 'exists': {
      const model = load(args[0] as string)
      for (const p of args.slice(1)) {
        const parent = resolve(model, parentOf(normalise(p, p)), true)
        if (parent !== undefined && model.files[[parent, baseName(p)].filter(Boolean).join('/')]) console.log(p)
      }
      break
    }
    case 'uid':
      console.log(uidFor(load(args[0] as string), args[1] ?? ''))
      break
    case 'apk-state':
      console.log(apkState(load(args[0] as string)).join('\n'))
      break
    case 'apk-installed':
      for (const p of apkInstalled(load(args[0] as string))) console.log(`${p.name}\t${p.version}`)
      break
    case 'vercmp':
      console.log(vercmp(args[0] as string, args[1] as string))
      break
    case 'node-packages':
      for (const p of nodePackages(load(args[0] as string))) console.log(p)
      break
    case 'layers':
      report(layers(load(args[0] as string), load(args[1] as string), args[2] as string))
      break
    case 'added':
      report(
        added(
          load(args[0] as string),
          load(args[1] as string),
          (args[2] ?? '').split(/[\s,]+/).filter(Boolean),
          args.slice(3).map((r) => normalise(r, 'root')),
        ),
      )
      break
    case 'pnpm-store': {
      const { findings, summary } = pnpmStore(
        load(args[0] as string),
        normalise(args[1] ?? '', 'node_modules'),
        JSON.parse(readFileSync(args[2] as string, 'utf8')) as unknown,
      )
      report(findings)
      if (findings.length === 0) console.log(printable(summary))
      break
    }
    case 'header-include': {
      const { findings, adds, hides } = headerInclude(load(args[0] as string), normalise(args[1] ?? '', 'path'))
      report(findings)
      if (findings.length === 0) {
        console.log(`/${args[1] ?? ''}: ${adds} add_header and ${hides} proxy_hide_header lines, nothing else`)
      }
      break
    }
    default:
      fatal(`unknown command '${command ?? ''}'`)
  }
} catch (error) {
  console.error(`image-fs: ${printable(error instanceof Fatal ? error.message : String(error))}`)
  process.exitCode = 2
}
