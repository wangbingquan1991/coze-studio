import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-coze-studio'
export const inject = ['tools']

const execFileAsync = promisify(execFile)
const DEFAULT_REPO = 'https://github.com/wangbingquan1991/coze-studio.git'
const DEFAULT_ROOT = join(homedir(), '.dsh', 'apps', 'coze-studio')
const COMPOSE_FILE = join('docker', 'docker-compose.yml')
const ENV_FILE = join('docker', '.env')
const ENV_EXAMPLE = join('docker', '.env.example')

const output = {
  schema: { type: 'json', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

function isProject(root) {
  return existsSync(join(root, COMPOSE_FILE)) && existsSync(join(root, ENV_EXAMPLE))
}

function findProject(start) {
  let current = resolve(start)
  for (let i = 0; i < 8; i += 1) {
    if (isProject(current)) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

function projectRoot(explicitRoot) {
  if (explicitRoot) return resolve(explicitRoot)
  if (process.env.COZE_STUDIO_ROOT) return resolve(process.env.COZE_STUDIO_ROOT)
  return findProject(process.cwd()) || DEFAULT_ROOT
}

async function run(file, args, cwd, timeout = 300000) {
  try {
    const result = await execFileAsync(file, args, {
      cwd: cwd || process.cwd(),
      env: process.env,
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    })
    return {
      ok: true,
      stdout: String(result.stdout || '').trim(),
      stderr: String(result.stderr || '').trim(),
    }
  } catch (error) {
    const stderr = String(error.stderr || '').trim()
    const stdout = String(error.stdout || '').trim()
    throw new Error(file + ' ' + args.join(' ') + ' failed: ' + (stderr || stdout || error.message))
  }
}

async function probe(file, args) {
  try {
    const result = await run(file, args, homedir(), 15000)
    return { ok: true, version: result.stdout || result.stderr }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

function ensureEnv(root) {
  const envPath = join(root, ENV_FILE)
  if (existsSync(envPath)) return { created: false, path: envPath }

  const examplePath = join(root, ENV_EXAMPLE)
  if (!existsSync(examplePath)) throw new Error('Missing ' + ENV_EXAMPLE + ' in ' + root)
  copyFileSync(examplePath, envPath)

  let text = readFileSync(envPath, 'utf8')
  if (/^WEB_LISTEN_ADDR=/m.test(text)) {
    text = text.replace(/^WEB_LISTEN_ADDR=.*$/m, 'WEB_LISTEN_ADDR=127.0.0.1:8888')
  } else {
    text += '\n# DSH adapter: keep the default UI local-only\nWEB_LISTEN_ADDR=127.0.0.1:8888\n'
  }
  writeFileSync(envPath, text)
  return { created: true, path: envPath }
}

async function ensureProject(root) {
  if (isProject(root)) return { cloned: false, root }
  if (existsSync(root)) throw new Error(root + ' exists but is not a Coze Studio checkout')

  mkdirSync(dirname(root), { recursive: true })
  const repo = process.env.COZE_STUDIO_REPO || DEFAULT_REPO
  const ref = process.env.COZE_STUDIO_REF || 'main'
  await run('git', ['clone', '--depth', '1', '--branch', ref, repo, root], dirname(root), 300000)
  return { cloned: true, root, repo, ref }
}

function composeArgs(root, args) {
  const result = ['compose', '-f', join(root, COMPOSE_FILE)]
  if (existsSync(join(root, ENV_FILE))) result.push('--env-file', join(root, ENV_FILE))
  result.push(...args)
  return result
}

async function compose(root, args, timeout) {
  return run('docker', composeArgs(root, args), root, timeout || 300000)
}

function envValue(root, key) {
  const file = join(root, ENV_FILE)
  if (!existsSync(file)) return null
  const match = readFileSync(file, 'utf8').match(new RegExp('^' + key + '=(.*)$', 'm'))
  return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : null
}

function baseUrl(root) {
  if (process.env.COZE_STUDIO_URL) return process.env.COZE_STUDIO_URL.replace(/\/$/, '')
  const listen = envValue(root, 'WEB_LISTEN_ADDR') || '8888'
  if (/^\d+$/.test(listen)) return 'http://127.0.0.1:' + listen
  if (/^(0\.0\.0\.0|localhost|127\.0\.0\.1):\d+$/.test(listen)) {
    return 'http://' + listen.replace(/^0\.0\.0\.0/, '127.0.0.1')
  }
  return 'http://127.0.0.1:8888'
}

async function webProbe(url) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    })
    return { reachable: response.status < 500, http_status: response.status }
  } catch (error) {
    return { reachable: false, web_error: error.message }
  }
}

function parsePs(text) {
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return text.split(/\r?\n/).filter(Boolean).map(line => {
      try { return JSON.parse(line) } catch { return { raw: line } }
    })
  }
}

async function getStatus(root) {
  const result = {
    project_root: root,
    installed: isProject(root),
    env_ready: existsSync(join(root, ENV_FILE)),
    url: baseUrl(root),
    reachable: false,
    services: [],
  }
  if (!result.installed) return result

  try {
    const ps = await compose(root, ['ps', '--format', 'json'], 30000)
    result.services = parsePs(ps.stdout)
  } catch (error) {
    result.compose_error = error.message
  }

  Object.assign(result, await webProbe(result.url))
  return result
}

function register(ctx, toolName, description, parameters, execute) {
  ctx.tools.register(defineTool({
    name: toolName,
    description,
    parameters,
    output,
    execute,
  }))
}

export function apply(ctx) {
  register(ctx, 'coze_studio_doctor',
    'Check Git, Docker, Docker Compose, Coze Studio files, container state, and local Web UI readiness.',
    {
      project_root: { type: 'string', description: 'Optional Coze Studio checkout path.' },
    },
    async args => {
      const root = projectRoot(args.project_root)
      const checks = await Promise.all([
        probe('git', ['--version']),
        probe('docker', ['--version']),
        probe('docker', ['compose', 'version']),
      ])
      return {
        git: checks[0],
        docker: checks[1],
        docker_compose: checks[2],
        ...(await getStatus(root)),
      }
    })

  register(ctx, 'coze_studio_install',
    'Prepare Coze Studio for DSH. Clone it if missing, create docker/.env without overwriting an existing file, and optionally pre-pull images.',
    {
      project_root: { type: 'string', description: 'Optional installation path.' },
      pull_images: { type: 'boolean', description: 'Pre-pull Docker images. Defaults to false.' },
    },
    async args => {
      const root = projectRoot(args.project_root)
      const project = await ensureProject(root)
      const env = ensureEnv(root)
      let pull = null
      if (args.pull_images === true) pull = await compose(root, ['pull'], 900000)
      return { ok: true, project, env, pull, ...(await getStatus(root)) }
    })

  register(ctx, 'coze_studio_start',
    'Install Coze Studio when necessary and start the complete stack in the background with Docker Compose.',
    {
      project_root: { type: 'string', description: 'Optional Coze Studio checkout path.' },
    },
    async args => {
      const root = projectRoot(args.project_root)
      const project = await ensureProject(root)
      const env = ensureEnv(root)
      const start = await compose(root, ['up', '-d'], 900000)
      return { ok: true, project, env, start, ...(await getStatus(root)) }
    })

  register(ctx, 'coze_studio_stop',
    'Stop Coze Studio containers without removing containers, volumes, or persistent data.',
    {
      project_root: { type: 'string', description: 'Optional Coze Studio checkout path.' },
    },
    async args => {
      const root = projectRoot(args.project_root)
      if (!isProject(root)) throw new Error('Coze Studio is not installed at ' + root)
      const stop = await compose(root, ['stop'], 300000)
      return { ok: true, stop, ...(await getStatus(root)) }
    })

  register(ctx, 'coze_studio_restart',
    'Restart the existing Coze Studio stack while preserving persistent data.',
    {
      project_root: { type: 'string', description: 'Optional Coze Studio checkout path.' },
    },
    async args => {
      const root = projectRoot(args.project_root)
      if (!isProject(root)) throw new Error('Coze Studio is not installed at ' + root)
      ensureEnv(root)
      const restart = await compose(root, ['restart'], 600000)
      return { ok: true, restart, ...(await getStatus(root)) }
    })

  register(ctx, 'coze_studio_logs',
    'Read recent Docker Compose logs for all Coze Studio services or one named service.',
    {
      project_root: { type: 'string', description: 'Optional Coze Studio checkout path.' },
      service: { type: 'string', description: 'Optional service name, for example coze-server or coze-web.' },
      tail: { type: 'number', description: 'Recent log lines from 20 to 500. Defaults to 120.' },
    },
    async args => {
      const root = projectRoot(args.project_root)
      if (!isProject(root)) throw new Error('Coze Studio is not installed at ' + root)
      const tail = Math.min(500, Math.max(20, Math.floor(args.tail || 120)))
      const command = ['logs', '--no-color', '--tail', String(tail)]
      if (args.service) {
        if (!/^[A-Za-z0-9_-]+$/.test(args.service)) throw new Error('Invalid service name')
        command.push(args.service)
      }
      const logs = await compose(root, command, 60000)
      return {
        project_root: root,
        service: args.service || 'all',
        tail,
        logs: logs.stdout || logs.stderr,
      }
    })

  register(ctx, 'coze_studio_status',
    'Return the Coze Studio installation path, Docker Compose service state, Web UI URL, and reachability.',
    {
      project_root: { type: 'string', description: 'Optional Coze Studio checkout path.' },
    },
    async args => getStatus(projectRoot(args.project_root)))

  register(ctx, 'coze_studio_url',
    'Return the Coze Studio main, sign-in, and model-management URLs.',
    {
      project_root: { type: 'string', description: 'Optional Coze Studio checkout path.' },
    },
    async args => {
      const root = projectRoot(args.project_root)
      const base = baseUrl(root)
      return {
        project_root: root,
        base_url: base,
        sign_url: base + '/sign',
        model_management_url: base + '/admin/#model-management',
      }
    })
}
