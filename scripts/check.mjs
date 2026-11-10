// `pnpm check` — every check CI runs, in one command, without --fix.
//
// A node script rather than a `a && b && c` one-liner: root scripts run under
// cmd.exe on Windows (see CLAUDE.md), and this way every step runs even after an
// earlier one fails, so one invocation reports all failures at once.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const server = path.join(root, 'server')

const steps = [
  ['typecheck', 'pnpm -r typecheck', root],
  ['test', 'pnpm -r test', root],
  ['lint', 'pnpm -r --if-present lint:check', root],
  ['ruff', 'uv run ruff check src scripts tests', server],
  ['pytest', 'uv run pytest', server],
]

const failed = []
for (const [name, cmd, cwd] of steps) {
  console.log(`\n==> ${name}: ${cmd}`)
  const r = spawnSync(cmd, { cwd, stdio: 'inherit', shell: true })
  if (r.status !== 0)
    failed.push(name)
}

console.log(failed.length ? `\ncheck FAILED: ${failed.join(', ')}` : '\ncheck passed')
process.exit(failed.length ? 1 : 0)
