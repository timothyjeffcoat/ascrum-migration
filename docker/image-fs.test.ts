// DEV-p5-image-host-07 (owner's answer to Q-p5-image-host-4 (a)): the host-side image reader's fail-closed
// branches, run in CI by `node --test docker/` in the `test` job. The clean images never reach these
// branches, so without this file nothing would notice one of them turning into "skip and carry on".
// Each case is a `docker save` folder built by docker/image-fs-craft.ts with exactly one thing wrong; the
// reader runs as check-images.sh runs it (`node docker/image-fs.ts read <folder> <diff_ids> <model>`), and
// the test asserts the exit code and a stable part of the message. Clean control cases must exit 0, so a
// refusal is known to come from the crafted detail and not from a broken generator.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import {
  gnuLong,
  gzipLayer,
  pax,
  rawLayer,
  saveFolder,
  scratch,
  tar,
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
function read(layers: Layer[]): { code: number | null; stdout: string; stderr: string; model: string } {
  const { dir, expected } = saveFolder(work, layers)
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
