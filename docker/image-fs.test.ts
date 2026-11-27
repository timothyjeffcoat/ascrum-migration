// DEV-p5-image-host-07 (owner's answer to Q-p5-image-host-4 (a)): the host-side image reader's fail-closed
// branches. CI runs this file by name in the `test` job (`node --test docker/image-fs.test.ts`, which fails
// when the file is missing, and the step also fails on any skipped or todo test: DEV-p5-image-host-18). The
// clean images never reach these branches, so without this file nothing would notice one of them turning
// into "skip and carry on". Each case is a `docker save` folder built by docker/image-fs-craft.ts with
// exactly one thing wrong; the reader runs as check-images.sh runs it (`node docker/image-fs.ts read <folder>
// <diff_ids> <model>`), and the test asserts the exit code and a stable part of the message. Clean control
// cases must exit 0, so a refusal is known to come from the crafted detail and not from a broken generator.
// Also here: the output escaping of the reader and of docker/log-safe.sh (-16), and the API's
// node_modules against the lockfile's production tree (`pnpm-store`, -17).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import {
  gnuLong,
  gzipLayer,
  header,
  pax,
  rawLayer,
  saveFolder,
  scratch,
  tar,
  withChecksum,
  type FolderOptions,
  type Layer,
  type TarEntry,
} from './image-fs-craft.ts'

const READER = join(import.meta.dirname, 'image-fs.ts')
const work = scratch()
after(() => rmSync(work, { recursive: true, force: true }))

let models = 0
function run(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [READER, ...args], { encoding: 'utf8' })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}
function read(
  layers: Layer[],
  options?: FolderOptions,
): { code: number | null; stdout: string; stderr: string; model: string } {
  const { dir, expected } = saveFolder(work, layers, options)
  const model = join(work, `model-${++models}.json`)
  return { ...run(['read', dir, expected, model]), model }
}
// One gzip layer holding a valid directory, then the entries under test.
const layerOf = (...entries: TarEntry[]): Layer => gzipLayer(tar([{ name: 'app/', type: '5' }, ...entries]))
const refused = (entries: TarEntry[], message: string | RegExp) => {
  const result = read([layerOf(...entries)])
  assert.equal(result.code, 2, `exit code (stderr: ${result.stderr})`)
  if (typeof message === 'string') assert.ok(result.stderr.includes(message), `stderr: ${result.stderr}`)
  else assert.match(result.stderr, message)
}
const C = (code: number): string => String.fromCharCode(code)

describe('DEV-p5-image-host-07: the image reader (docker/image-fs.ts read)', () => {
  it('DEV-p5-image-host-07: control: a clean image of two layers (gzip and raw tar) reads, exit 0', () => {
    const lower = gzipLayer(
      tar([
        { name: 'app/', type: '5' },
        { name: 'app/a.txt', data: 'a\n' },
        { name: 'app/link', type: '2', linkname: 'a.txt' },
        { name: 'app/hard', type: '1', linkname: 'app/a.txt' },
        pax({ path: `app/${'p'.repeat(120)}`, mtime: '1700000000.5', 'SCHILY.xattr.user.note': 'x' }),
        { name: 'placeholder', data: 'long PAX name\n' },
        gnuLong(`app/${'g'.repeat(120)}`),
        { name: 'placeholder', data: 'long GNU name\n' },
        { name: 'old/', type: '5' },
        { name: 'old/gone.txt', data: 'x' },
        { name: 'hidden/', type: '5' },
        { name: 'hidden/below.txt', data: 'x' },
      ]),
    )
    const upper = rawLayer(
      tar([
        { name: 'old/', type: '5' },
        { name: 'old/.wh.gone.txt' },
        { name: 'hidden/', type: '5' },
        { name: 'hidden/.wh..wh..opq' },
        { name: 'app/b.txt', data: 'b\n' },
      ]),
    )
    const result = read([lower, upper])
    assert.equal(result.code, 0, result.stderr)
    // app, a.txt, link, hard, the PAX name, the GNU name, b.txt, old, hidden: the whiteout and the opaque
    // directory removed old/gone.txt and hidden/below.txt.
    assert.match(result.stdout, /^read 2 layers, 9 paths in the final filesystem$/m)
    const listed = run(['list', result.model])
    assert.equal(listed.code, 0, listed.stderr)
    assert.ok(listed.stdout.includes(`app/${'p'.repeat(120)}\n`))
    assert.ok(listed.stdout.includes(`app/${'g'.repeat(120)}\n`))
    assert.ok(!listed.stdout.includes('gone.txt') && !listed.stdout.includes('below.txt'))
    const special = run(['special', result.model])
    assert.equal(special.code, 1)
    assert.ok(special.stdout.includes('extended attribute user.note'))
  })

  describe('whiteouts and overlay metadata', () => {
    it('DEV-p5-image-host-07: a whiteout that is not an empty file is refused', () => {
      refused([{ name: 'app/.wh.a.txt', data: 'not empty' }], "whiteout 'app/.wh.a.txt' is not an empty file")
    })
    it('DEV-p5-image-host-07: a whiteout of another type (a directory) is refused', () => {
      refused([{ name: 'app/.wh.dir/', type: '5' }], "whiteout 'app/.wh.dir' is not an empty file")
    })
    it('DEV-p5-image-host-07: an overlay metadata file the reader does not know is refused', () => {
      refused(
        [{ name: 'app/.wh..wh.plnk' }],
        "'app/.wh..wh.plnk' is an overlay metadata file this reader does not know",
      )
    })
  })

  describe('links', () => {
    it('DEV-p5-image-host-07: a hard link to nothing is refused', () => {
      refused(
        [{ name: 'app/hard', type: '1', linkname: 'app/missing' }],
        "hard link 'app/hard' points at 'app/missing', which is not a file",
      )
    })
    it('DEV-p5-image-host-07: a hard link with a mode different from its target is refused', () => {
      refused(
        [
          { name: 'app/a', data: 'x', mode: 0o755 },
          { name: 'app/b', type: '1', linkname: 'app/a', mode: 0o4755 },
        ],
        "hard link 'app/b' has a mode, owner or attributes different from its target 'app/a'",
      )
    })
    it('DEV-p5-image-host-07: a symlink with no target, or a control character in it, is refused', () => {
      refused([{ name: 'app/l', type: '2', linkname: '' }], "symlink 'app/l' has no target")
      refused([{ name: 'app/l', type: '2', linkname: `x${C(0x1b)}y` }], "symlink 'app/l' has a control character")
    })
  })

  describe('PAX and GNU extended headers', () => {
    it('DEV-p5-image-host-07: a PAX key the reader does not understand is refused', () => {
      refused(
        [pax({ comment: 'hello' }), { name: 'app/a', data: 'x' }],
        "PAX key 'comment' is not understood by this reader",
      )
      refused(
        [pax({ 'GNU.sparse.major': '1' }), { name: 'app/a', data: 'x' }],
        "PAX key 'GNU.sparse.major' is not understood by this reader",
      )
    })
    it('DEV-p5-image-host-07: a global PAX header is refused', () => {
      refused([pax({ mtime: '1' }, 'g'), { name: 'app/a', data: 'x' }], 'a global PAX header')
    })
    it('DEV-p5-image-host-07: two extended headers of one kind for one entry are refused (x, L)', () => {
      refused(
        [pax({ mtime: '1' }), pax({ uid: '0' }), { name: 'app/a', data: 'x' }],
        "two 'x' extended headers for one entry",
      )
      refused(
        [gnuLong('app/one'), gnuLong('app/two'), { name: 'app/a', data: 'x' }],
        "two 'L' extended headers for one entry",
      )
    })
    it('DEV-p5-image-host-07: a GNU long name with a PAX path, or a long link with a PAX linkpath, is refused', () => {
      const both = 'an entry has both a GNU long name or link and a PAX path or linkpath'
      refused([gnuLong('app/gnu'), pax({ path: 'app/pax' }), { name: 'app/a', data: 'x' }], both)
      refused(
        [gnuLong('app/a', 'K'), pax({ linkpath: 'app/a' }), { name: 'app/l', type: '2', linkname: 'app/a' }],
        both,
      )
    })
    it('DEV-p5-image-host-07: a malformed PAX record or a PAX number that is not a number is refused', () => {
      refused(
        [
          { name: 'PaxHeaders/x', type: 'x', data: '8 nokey\n' },
          { name: 'app/a', data: 'x' },
        ],
        'a PAX record without a key',
      )
      refused([pax({ uid: '-1' }), { name: 'app/a', data: 'x' }], "PAX uid '-1' is not a number")
    })
  })

  describe('entry types', () => {
    for (const [type, what] of [
      ['6', 'a FIFO'],
      ['3', 'a character device'],
      ['4', 'a block device'],
      ['7', 'a contiguous file'],
      ['S', 'a GNU sparse file'],
    ] as const) {
      it(`DEV-p5-image-host-07: ${what} (tar type '${type}') is refused`, () => {
        refused([{ name: 'app/node', type }], `entry 'app/node' has tar type '${type}', which a layer here may not use`)
      })
    }
    it('DEV-p5-image-host-07: a directory or symlink that carries data is refused', () => {
      refused([{ name: 'app/d/', type: '5', data: 'x' }], "dir entry 'app/d/' carries 1 bytes of data")
    })
  })

  describe('names (#90 rounds 2 and 3)', () => {
    it('DEV-p5-image-host-07: a NUL byte in a PAX path is refused', () => {
      refused([pax({ path: `app/a${C(0)}b` }), { name: 'app/x', data: 'x' }], 'a NUL byte in the name')
    })
    it("DEV-p5-image-host-07: an old-style regular file ('\\0' or '0') with a directory name is refused", () => {
      refused([{ name: 'app/dir/', type: C(0) }], "entry 'app/dir/' is a regular-file type with a directory name")
      refused([{ name: 'app/dir/', type: '0' }], "entry 'app/dir/' is a regular-file type with a directory name")
    })
    it('DEV-p5-image-host-07: a C0 control character or DEL in a path is refused', () => {
      for (const code of [0x01, 0x0a, 0x0d, 0x1b, 0x7f]) {
        refused([{ name: `app/a${C(code)}b`, data: 'x' }], 'a control character in the name')
      }
    })
    it("DEV-p5-image-host-07: a '..' or empty segment, or a name that is not UTF-8, is refused", () => {
      refused([{ name: 'app/../etc/x', data: 'x' }], "has an empty, '.' or '..' segment")
      refused([{ name: 'app//x', data: 'x' }], "has an empty, '.' or '..' segment")
      refused(
        [pax({ path: Buffer.from([0x61, 0xff, 0x62]) }), { name: 'app/x', data: 'x' }],
        'a name that is not valid UTF-8',
      )
    })
    it('DEV-p5-image-host-07: an entry under a file is refused', () => {
      refused(
        [
          { name: 'app/f', data: 'x' },
          { name: 'app/f/under', data: 'y' },
        ],
        "'app/f/under' is under 'app/f', which is a file",
      )
    })
  })

  describe('tar structure', () => {
    it('DEV-p5-image-host-07: a header whose checksum does not match is refused', () => {
      refused(
        [{ name: 'app/a', data: 'x', corrupt: (block) => block.write('B', 4, 1, 'latin1') }],
        'a header checksum does not match',
      )
    })
    it('DEV-p5-image-host-07: a malformed numeric field (size not octal) is refused', () => {
      // The checksum is written for the bad field, so only the field is wrong.
      const corrupt = (block: Buffer) => {
        block.write('0000000009x\0', 124, 12, 'latin1')
        block.fill(0x20, 148, 156)
        let sum = 0
        for (const byte of block) sum += byte
        block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1')
      }
      refused([{ name: 'app/a', data: 'x', corrupt }], "'0000000009x' is not an octal number")
    })
    it('DEV-p5-image-host-07: an unknown tar magic is refused', () => {
      const corrupt = (block: Buffer) => {
        block.write('xstar\u000000', 257, 8, 'latin1')
        block.fill(0x20, 148, 156)
        let sum = 0
        for (const byte of block) sum += byte
        block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1')
      }
      refused([{ name: 'app/a', data: 'x', corrupt }], 'unknown tar magic')
    })
    it('DEV-p5-image-host-07: data after the end-of-archive marker is refused', () => {
      const bytes = tar([{ name: 'app/', type: '5' }], Buffer.concat([Buffer.from('junk'), Buffer.alloc(508)]))
      const result = read([gzipLayer(bytes)])
      assert.equal(result.code, 2)
      assert.ok(result.stderr.includes('data after the end-of-archive marker'), result.stderr)
    })
    it('DEV-p5-image-host-07: an archive without its end marker, or with one zero block in the middle, is refused', () => {
      const whole = tar([
        { name: 'app/', type: '5' },
        { name: 'app/a', data: 'x' },
      ])
      const cut = whole.subarray(0, whole.length - 1024)
      let result = read([gzipLayer(cut)])
      assert.equal(result.code, 2)
      assert.ok(result.stderr.includes('the archive has no end-of-archive marker'), result.stderr)
      const gap = Buffer.concat([whole.subarray(0, 512), Buffer.alloc(512), whole.subarray(512)])
      result = read([gzipLayer(gap)])
      assert.equal(result.code, 2)
      assert.ok(result.stderr.includes('a single zero block in the middle of the archive'), result.stderr)
    })
  })

  describe('blobs and digests', () => {
    const clean = () =>
      tar([
        { name: 'app/', type: '5' },
        { name: 'app/a', data: 'x' },
      ])
    it('DEV-p5-image-host-07: a layer blob whose SHA-256 is not its name is refused', () => {
      const layer = gzipLayer(clean())
      layer.blobName = 'a'.repeat(64)
      const result = read([layer])
      assert.equal(result.code, 2)
      assert.match(result.stderr, /layer 0: the blob's SHA-256 is [0-9a-f]{64}, not its name/)
    })
    it('DEV-p5-image-host-07: an uncompressed tar whose digest is not the diff_id is refused', () => {
      const layer = gzipLayer(clean())
      layer.diffId = `sha256:${'b'.repeat(64)}`
      const result = read([layer])
      assert.equal(result.code, 2)
      assert.match(result.stderr, /layer 0: the uncompressed tar is sha256:[0-9a-f]{64}, the config says sha256:b{64}/)
    })
    it('DEV-p5-image-host-07: a blob that is neither gzip, zstd nor a ustar archive is refused', () => {
      for (const blob of [
        Buffer.from('BZh91AY&SY not a tar'),
        Buffer.concat([Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0]), Buffer.alloc(600)]),
      ]) {
        const result = read([{ blob, diffId: `sha256:${'c'.repeat(64)}` }])
        assert.equal(result.code, 2)
        assert.ok(result.stderr.includes('layer 0: neither gzip, zstd nor a ustar archive'), result.stderr)
      }
    })
    it("DEV-p5-image-host-07: diff_ids that are not the engine's are refused", () => {
      const { dir } = saveFolder(work, [gzipLayer(clean())])
      const result = run(['read', dir, `sha256:${'d'.repeat(64)}`, join(work, 'unused.json')])
      assert.equal(result.code, 2)
      assert.ok(result.stderr.includes("are not the image's sha256:"), result.stderr)
    })
  })
})

// `added`: the image against its base. A COPY layer may only write under the COPY roots, so a whiteout or
// an opaque directory in one is a finding (exit 1), even under a root (DEV-p5-image-host-08 (2)).
describe('DEV-p5-image-host-07: the runtime-stage check (docker/image-fs.ts added)', () => {
  const baseLayer = () =>
    gzipLayer(
      tar([
        { name: 'lib/', type: '5' },
        { name: 'lib/apk/', type: '5' },
        { name: 'lib/apk/db/', type: '5' },
        { name: 'lib/apk/db/installed', data: '' },
      ]),
      'ADD rootfs.tar / # base',
    )
  const COPY = 'COPY dist/ /app # buildkit'
  const check = (copyEntries: TarEntry[]) => {
    const base = read([baseLayer()])
    assert.equal(base.code, 0, base.stderr)
    const image = read([baseLayer(), gzipLayer(tar(copyEntries), COPY)])
    assert.equal(image.code, 0, image.stderr)
    return run(['added', base.model, image.model, '', 'app'])
  }

  it('DEV-p5-image-host-07: control: a COPY layer that writes only under its root passes, exit 0', () => {
    const result = check([
      { name: 'app/', type: '5' },
      { name: 'app/main.js', data: 'x' },
    ])
    assert.equal(result.code, 0, result.stdout + result.stderr)
    assert.equal(result.stdout, '')
  })
  it('DEV-p5-image-host-07: an opaque directory in a COPY layer is a finding, exit 1', () => {
    const result = check([
      { name: 'app/', type: '5' },
      { name: 'app/.wh..wh..opq' },
      { name: 'app/main.js', data: 'x' },
    ])
    assert.equal(result.code, 1, result.stderr)
    assert.ok(result.stdout.includes(`layer 1 (${COPY}): opaque /app is outside the COPY roots`), result.stdout)
  })
  it('DEV-p5-image-host-07: a whiteout in a COPY layer is a finding, exit 1', () => {
    const result = check([{ name: 'app/', type: '5' }, { name: 'app/.wh.old.js' }])
    assert.equal(result.code, 1, result.stderr)
    assert.ok(
      result.stdout.includes(`layer 1 (${COPY}): whiteout /app/old.js is outside the COPY roots`),
      result.stdout,
    )
  })
  it('DEV-p5-image-host-07: a COPY layer that writes outside its root is a finding, exit 1', () => {
    const result = check([
      { name: 'app/', type: '5' },
      { name: 'etc/', type: '5' },
      { name: 'etc/evil', data: 'x' },
    ])
    assert.equal(result.code, 1, result.stderr)
    assert.ok(result.stdout.includes(`layer 1 (${COPY}): entry /etc/evil is outside the COPY roots`), result.stdout)
  })
})

// DEV-p5-image-host-21: refusals of the folder and the tar stream that the first cases did not pin.
describe('DEV-p5-image-host-21: the docker save folder and the tar stream, more refusals', () => {
  const clean = () =>
    tar([
      { name: 'app/', type: '5' },
      { name: 'app/a', data: 'x' },
    ])
  const refusedFolder = (layers: Layer[], options: FolderOptions, message: string) => {
    const result = read(layers, options)
    assert.equal(result.code, 2, `exit code (stderr: ${result.stderr})`)
    assert.ok(result.stderr.includes(message), `stderr: ${result.stderr}`)
  }
  it('DEV-p5-image-host-21: a config blob whose SHA-256 is not its name is refused', () => {
    refusedFolder([gzipLayer(clean())], { configName: 'e'.repeat(64) }, "config: the blob's SHA-256 is not its name")
  })
  it('DEV-p5-image-host-21: a layer ref that is not blobs/sha256/<64 hex> is refused, and a missing blob too', () => {
    for (const ref of [
      'blobs/sha256/../../index.json',
      `blobs/sha512/${'a'.repeat(64)}`,
      `blobs/sha256/${'A'.repeat(64)}`,
    ]) {
      refusedFolder(
        [gzipLayer(clean())],
        { manifestLayers: () => [ref] },
        `'${ref}' is not a blobs/sha256/<digest> path`,
      )
    }
    refusedFolder(
      [gzipLayer(clean())],
      { manifestLayers: () => [`blobs/sha256/${'f'.repeat(64)}`] },
      'is missing or not a regular file',
    )
  })
  it('DEV-p5-image-host-21: a manifest whose layer count is not the config diff_ids count is refused', () => {
    refusedFolder(
      [gzipLayer(clean()), gzipLayer(tar([{ name: 'app/b', data: 'y' }]))],
      { manifestLayers: (refs) => refs.slice(0, 1) },
      'manifest: 1 layers, the config has 2 diff_ids',
    )
  })
  it('DEV-p5-image-host-21: index.json or manifest.json listing other than exactly one image is refused', () => {
    refusedFolder([gzipLayer(clean())], { indexCount: 2 }, 'index.json: not exactly one image')
    refusedFolder([gzipLayer(clean())], { indexCount: 0 }, 'index.json: not exactly one image')
    refusedFolder([gzipLayer(clean())], { manifestCount: 2 }, 'manifest.json: not exactly one image')
  })
  it('DEV-p5-image-host-21: an extended header over 16 MiB is refused', () => {
    refused([{ ...pax({ mtime: '1' }), size: 16 * 1024 * 1024 + 1, data: '' }], 'an extended header of 16777217 bytes')
  })
  it('DEV-p5-image-host-21: an archive that ends inside an entry is refused', () => {
    const cut = Buffer.concat([header({ name: 'app/a', size: 1000 }), Buffer.alloc(100, 0x61)])
    const result = read([gzipLayer(cut)])
    assert.equal(result.code, 2)
    assert.ok(result.stderr.includes('the archive ends inside an entry'), result.stderr)
  })
  it('DEV-p5-image-host-21: base-256 numbers: a valid one is read, a negative or too large one is refused', () => {
    const uid = (bytes: number[]) => (block: Buffer) => {
      Buffer.from(bytes).copy(block, 108)
      withChecksum(block)
    }
    const ok = read([layerOf({ name: 'app/a', data: 'x', corrupt: uid([0x80, 0, 0, 0, 0, 0, 0x03, 0xe8]) })])
    assert.equal(ok.code, 0, ok.stderr)
    const model = JSON.parse(readFileSync(ok.model, 'utf8')) as { files: Record<string, { uid: number }> }
    assert.equal(model.files['app/a']?.uid, 1000)
    refused([{ name: 'app/a', data: 'x', corrupt: uid([0xc0, 0, 0, 0, 0, 0, 0, 1]) }], 'a negative base-256 number')
    refused(
      [{ name: 'app/a', data: 'x', corrupt: uid([0xbf, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]) }],
      'a base-256 number too large',
    )
  })
  it('DEV-p5-image-host-21: malformed PAX record lengths are refused', () => {
    const record = (data: string): TarEntry[] => [
      { name: 'PaxHeaders/x', type: 'x', data },
      { name: 'app/a', data: 'x' },
    ]
    refused(record('nolength'), 'a PAX record without a length')
    refused(record('0x a=b\n'), "a PAX record length '0x'")
    refused(record('07 a=b\n'), "a PAX record length '07'")
    refused(record('99 a=b\n'), 'a PAX record that overruns or lacks its newline')
    refused(record('7 a=bcX'), 'a PAX record that overruns or lacks its newline')
  })
})

// DEV-p5-image-host-16: what the reader prints and what docker/log-safe.sh prints must never hold a `::`
// (the runner's command form, found after .NET TrimStart() drops every Unicode blank) or a `##[` (its old
// form, found anywhere in a line). This keeps -14's fix.
describe('DEV-p5-image-host-16: output escaping', () => {
  const NBSP = ' '
  it('DEV-p5-image-host-16: a refusal quoting a crafted PAX key prints no `::` and no `##[`', () => {
    const key = `${NBSP}::warning::x##[y`
    const result = read([layerOf(pax({ [key]: '1' }), { name: 'app/a', data: 'x' })])
    assert.equal(result.code, 2)
    assert.ok(result.stderr.includes('is not understood by this reader'), result.stderr)
    assert.ok(result.stderr.includes(':?:warning:?:x##(y'), result.stderr)
    assert.ok(!result.stderr.includes('::'), result.stderr)
    assert.ok(!result.stderr.includes('##['), result.stderr)
  })
  it('DEV-p5-image-host-16: a refusal quoting crafted path names prints no `::` and no `##[`', () => {
    const name = `app/${NBSP}::warning:::x##[e`
    const result = read([layerOf({ name, data: 'x' }, { name: `${name}/under`, data: 'y' })])
    assert.equal(result.code, 2)
    assert.ok(result.stderr.includes('which is a file, not a directory'), result.stderr)
    assert.ok(result.stderr.includes(`${NBSP}:?:warning:?:?:x##(e`), result.stderr)
    assert.ok(!result.stderr.includes('::'), result.stderr)
    assert.ok(!result.stderr.includes('##['), result.stderr)
  })

  const LOG_SAFE = join(import.meta.dirname, 'log-safe.sh')
  const bash = (script: string, input: Buffer, ...args: string[]): Buffer => {
    const result = spawnSync('bash', ['-c', `source "$0"; ${script}`, LOG_SAFE, ...args], { input })
    assert.equal(result.status, 0, result.stderr.toString())
    return result.stdout
  }
  const cases: [string, string][] = [
    [`${NBSP}::warning::nbsp\n`, `${NBSP}:?:warning:?:nbsp\n`],
    [' ::warning::emsp\n', ' :?:warning:?:emsp\n'],
    ['　::add-mask::ideo\n', '　:?:add-mask:?:ideo\n'],
    [' ::error::lsep\n', ' :?:error:?:lsep\n'],
    ['  ::warning::ascii\n', '  :?:warning:?:ascii\n'],
    ['a:::b::::c:::::d\n', 'a:?:?:b:?:?:?:c:?:?:?:?:d\n'],
    ['mid ::error:: line\n', 'mid :?:error:?: line\n'],
    ['##[warning]x ##[add-mask]y\n', '##(warning]x ##(add-mask]y\n'],
    [`a${C(0x1b)}b${C(0x0d)}c${C(0x7f)}\td\n`, 'a?b?c?\td\n'],
  ]
  it('DEV-p5-image-host-16: log_safe_lines escapes every `::` and `##[` on raw bytes', () => {
    for (const [input, want] of cases) {
      const got = bash('log_safe_lines', Buffer.from(input, 'utf8'))
      assert.deepEqual(got, Buffer.from(want, 'utf8'), JSON.stringify(input))
    }
    const all = bash('log_safe_lines', Buffer.from(cases.map(([i]) => i).join(''), 'utf8')).toString('latin1')
    assert.ok(!all.includes('::') && !all.includes('##['))
  })
  it('DEV-p5-image-host-16: log_safe keeps the text on one line and escapes it the same way', () => {
    const got = bash('log_safe "$1"', Buffer.alloc(0), `l1\n${NBSP}::error::x\n##[warning]:::`)
    assert.deepEqual(got, Buffer.from(`l1?${NBSP}:?:error:?:x?##(warning]:?:?:`, 'utf8'))
  })
})

// DEV-p5-image-host-17: the API's node_modules against the lockfile's production tree, in pnpm's layout.
describe('DEV-p5-image-host-17: installed packages (docker/image-fs.ts pnpm-store)', () => {
  const NM = 'app/api/node_modules'
  const P = (dir: string, name: string) => `/build/api/node_modules/.pnpm/${dir}/node_modules/${name}`
  const TREE = [
    {
      name: 'ascrum-api',
      dependencies: {
        a: { from: 'a', path: P('a@1.0.0', 'a'), dependencies: { b: { from: 'b', path: P('b@2.0.0', 'b') } } },
        '@s/c': { from: '@s/c', path: P('@s+c@1.0.0', '@s/c') },
      },
    },
  ]
  const d = (name: string): TarEntry => ({ name: `${NM}/${name}/`, type: '5' })
  const f = (name: string): TarEntry => ({ name: `${NM}/${name}`, data: 'x' })
  const l = (name: string, target: string): TarEntry => ({ name: `${NM}/${name}`, type: '2', linkname: target })
  const CLEAN: TarEntry[] = [
    { name: 'app/', type: '5' },
    { name: 'app/api/', type: '5' },
    { name: `${NM}/`, type: '5' },
    f('.modules.yaml'),
    f('.pnpm-workspace-state-v1.json'),
    l('a', '.pnpm/a@1.0.0/node_modules/a'),
    d('@s'),
    l('@s/c', '../.pnpm/@s+c@1.0.0/node_modules/@s/c'),
    d('.pnpm'),
    f('.pnpm/lock.yaml'),
    d('.pnpm/node_modules'),
    l('.pnpm/node_modules/b', '../b@2.0.0/node_modules/b'),
    d('.pnpm/a@1.0.0'),
    d('.pnpm/a@1.0.0/node_modules'),
    d('.pnpm/a@1.0.0/node_modules/a'),
    f('.pnpm/a@1.0.0/node_modules/a/index.js'),
    l('.pnpm/a@1.0.0/node_modules/b', '../../b@2.0.0/node_modules/b'),
    d('.pnpm/b@2.0.0'),
    d('.pnpm/b@2.0.0/node_modules'),
    d('.pnpm/b@2.0.0/node_modules/b'),
    f('.pnpm/b@2.0.0/node_modules/b/index.js'),
    d('.pnpm/@s+c@1.0.0'),
    d('.pnpm/@s+c@1.0.0/node_modules'),
    d('.pnpm/@s+c@1.0.0/node_modules/@s'),
    d('.pnpm/@s+c@1.0.0/node_modules/@s/c'),
    f('.pnpm/@s+c@1.0.0/node_modules/@s/c/index.js'),
  ]
  const treeFile = (tree: unknown) => {
    const path = join(mkdtempSync(join(work, 'tree-')), 'prod-tree.json')
    writeFileSync(path, JSON.stringify(tree))
    return path
  }
  const store = (extra: TarEntry[] = [], drop: (name: string) => boolean = () => false, tree: unknown = TREE) => {
    const image = read([gzipLayer(tar([...CLEAN.filter((e) => !drop(e.name.replace(/\/$/, ''))), ...extra]))])
    assert.equal(image.code, 0, image.stderr)
    return run(['pnpm-store', image.model, NM, treeFile(tree)])
  }
  const finding = (result: ReturnType<typeof run>, message: string) => {
    assert.equal(result.code, 1, result.stdout + result.stderr)
    assert.ok(result.stdout.includes(message), result.stdout)
  }
  const under = (prefix: string) => (name: string) => name === `${NM}/${prefix}` || name.startsWith(`${NM}/${prefix}/`)

  it("DEV-p5-image-host-17: control: pnpm's layout of exactly the production tree passes, exit 0", () => {
    const result = store()
    assert.equal(result.code, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /exactly the lockfile's production tree in pnpm's layout: 3 store directories/)
  })
  it('DEV-p5-image-host-17 (I5): a real package directory in .pnpm/node_modules/ is a finding', () => {
    finding(
      store([d('.pnpm/node_modules/evil'), f('.pnpm/node_modules/evil/index.js')]),
      `/${NM}/.pnpm/node_modules/evil: a dir in pnpm's hoisted links, not a symlink`,
    )
  })
  it('DEV-p5-image-host-17 (I6): a real package directory beside a store package is a finding (scoped too)', () => {
    finding(
      store([d('.pnpm/a@1.0.0/node_modules/evil'), f('.pnpm/a@1.0.0/node_modules/evil/index.js')]),
      `/${NM}/.pnpm/a@1.0.0/node_modules/evil: a dir beside a, not a symlink`,
    )
    finding(
      store([d('.pnpm/@s+c@1.0.0/node_modules/@s/evil')]),
      `/${NM}/.pnpm/@s+c@1.0.0/node_modules/@s/evil: a dir beside @s/c, not a symlink`,
    )
  })
  it('DEV-p5-image-host-17 (I7): a non-directory .pnpm/<name> is a finding', () => {
    finding(
      store([l('.pnpm/evil@1.0.0', 'a@1.0.0')]),
      `/${NM}/.pnpm/evil@1.0.0: a symlink in the store the lockfile's production tree does not name`,
    )
    finding(
      store([l('.pnpm/b@2.0.0', 'a@1.0.0')], under('.pnpm/b@2.0.0')),
      `/${NM}/.pnpm/b@2.0.0: a symlink, not a store directory`,
    )
  })
  it('DEV-p5-image-host-17 (I8): a top-level scope that is not a directory is a finding', () => {
    finding(store([f('@evil')]), `/${NM}/@evil: a scope that is a file, not a directory`)
  })
  it('DEV-p5-image-host-17 (I9): a dot-named top-level entry pnpm does not write is a finding', () => {
    finding(
      store([d('.evil'), f('.evil/index.js')]),
      `/${NM}/.evil: a dir pnpm does not write at the top of node_modules`,
    )
    finding(store([f('.bin')]), `/${NM}/.bin: a file pnpm does not write at the top of node_modules`)
  })
  it('DEV-p5-image-host-17: top-level packages are exactly the production dependencies, as symlinks into their store', () => {
    finding(store([f('top.js')]), `/${NM}/top.js: a top-level package the lockfile's production tree does not name`)
    finding(store([d('@s/evil')]), `/${NM}/@s/evil: a top-level package the lockfile's production tree does not name`)
    finding(store([d('a')], under('a')), `/${NM}/a: a dir, not pnpm's symlink into the store`)
    finding(
      store([l('a', '.pnpm/b@2.0.0/node_modules/b')], under('a')),
      `/${NM}/a: a symlink that does not resolve to a's store directory`,
    )
    finding(store([], under('a')), `/${NM}/a: production dependency a is missing`)
  })
  it("DEV-p5-image-host-17: store directories are exactly the lockfile's, each with only its own package", () => {
    finding(store([], under('.pnpm/b@2.0.0')), `/${NM}/.pnpm/b@2.0.0: missing from the image`)
    finding(
      store([], under('.pnpm/b@2.0.0/node_modules/b')),
      `/${NM}/.pnpm/b@2.0.0/node_modules/b: b's own directory is missing or not a directory`,
    )
    finding(store([f('.pnpm/b@2.0.0/extra.js')]), `/${NM}/.pnpm/b@2.0.0/extra.js: not pnpm's node_modules folder`)
    finding(
      store([d('.pnpm/b@2.0.0/node_modules/b/node_modules'), d('.pnpm/b@2.0.0/node_modules/b/node_modules/evil')]),
      `/${NM}/.pnpm/b@2.0.0/node_modules/b/node_modules: a node_modules folder inside b`,
    )
    finding(store([d('.pnpm/lock.yaml')], under('.pnpm/lock.yaml')), `/${NM}/.pnpm/lock.yaml: a dir, not a file`)
  })
  it('DEV-p5-image-host-17: a production tree with no packages cannot be compared, exit 2', () => {
    const result = store([], () => false, [{ name: 'ascrum-api' }])
    assert.equal(result.code, 2)
    assert.ok(result.stderr.includes('no production packages, so nothing can be compared'), result.stderr)
  })
})
