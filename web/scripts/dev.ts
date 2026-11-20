// `pnpm dev`: the Node stub on :3001 plus Vite on :5173 (which proxies the API paths to the stub).
// One process tree, so Ctrl-C stops both. No extra dependency needed for that.
import { spawn } from 'node:child_process'

const children = [
  spawn('node', ['stub/server.ts'], { stdio: 'inherit' }),
  spawn('pnpm', ['exec', 'vite'], { stdio: 'inherit' }),
]
const stopAll = () => children.forEach((child) => child.kill('SIGTERM'))
for (const child of children) child.on('exit', stopAll)
process.on('SIGINT', stopAll)
process.on('SIGTERM', stopAll)
