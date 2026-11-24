// The API's run-time import graph, taken from Node's own module loader (DEV-p5-containers-05):
//
//   node docker/api/import-graph.ts <app root> <entry>     e.g. /build/app /build/app/api/src/main.ts
//
// Loads <entry> (main.ts starts nothing when it is imported, `import.meta.main` is false) with a resolve
// hook that records every file Node actually resolves, and prints those under <app root>, outside
// node_modules, one path per line relative to the root, sorted. Type-only imports are erased by type
// stripping and never resolved, so they are not listed: only what the process loads.
//
// Two users, so the API image cannot drift from the code:
//   - api.Dockerfile copies exactly this list into the image. A new file in web/stub/ that the API
//     imports gets in by itself; a test helper or the MSW adapter, which the API never imports, does not.
//   - docker/check-images.sh runs it again inside the built image: if a module is missing it fails like
//     the container would (ERR_MODULE_NOT_FOUND), and the list must equal the .ts files in the image.
import { registerHooks } from 'node:module'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [rootArg, entryArg] = process.argv.slice(2)
if (!rootArg || !entryArg) {
  console.error('usage: node import-graph.ts <app root> <entry>')
  process.exit(2)
}
const root = resolve(rootArg)
const entry = resolve(entryArg)

const loaded = new Set<string>()
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context)
    if (result.url.startsWith('file:')) loaded.add(fileURLToPath(result.url))
    return result
  },
})

await import(pathToFileURL(entry).href)

const files = [...loaded]
  .filter((file) => file.startsWith(root + sep) && !file.split(sep).includes('node_modules'))
  .map((file) => relative(root, file))
  .sort()
if (!files.includes(relative(root, entry))) throw new Error(`the entry ${entry} was not loaded`)
console.log(files.join('\n'))
