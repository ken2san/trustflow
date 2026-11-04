import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SESSION_MODULE = pathToFileURL(path.join(REPO_ROOT, 'tests/e2e/earnerSession.js')).href

function startWorker(env) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { getEarnerSession } = await import(process.env.TF_TEST_EARNER_MODULE_URL);
    import { writeFile } from 'node:fs/promises';

    const waitForGate = () => new Promise(resolve => process.stdin.once('data', resolve));
    process.stdout.write('READY\\n');
    await waitForGate();
    process.stdin.destroy();

    const request = {
      async fetch(url) {
        if (url.endsWith('/auth/v1/user')) return { status: () => 200 };
        if (url.includes('/auth/v1/token?grant_type=password')) {
          await writeFile(process.env.TF_TEST_EARNER_SESSION + '.grant-' + process.pid, 'grant');
          await new Promise(resolve => setTimeout(resolve, 100));
          return {
            status: () => 200,
            json: async () => ({
              access_token: 'fake-access-' + process.pid,
              refresh_token: 'fake-refresh-' + process.pid,
              expires_at: Math.floor(Date.now() / 1000) + 3600,
              user: { id: 'fixture-user' },
            }),
          };
        }
        throw new Error('unexpected mocked request');
      },
    };

    const session = await getEarnerSession(request);
    process.stdout.write('DONE:' + session.userId + '\\n');
  `], { env, stdio: ['pipe', 'pipe', 'pipe'] })

  let output = ''
  let error = ''
  let markReady
  const ready = new Promise(resolve => { markReady = resolve })
  const done = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      output += chunk.toString()
      if (output.includes('READY')) markReady()
    })
    child.stderr.on('data', chunk => { error += chunk.toString() })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolve(output)
      else reject(new Error(`worker exited ${code}: ${error}`))
    })
  })

  return { child, ready, done }
}

it('shares one cold-cache sign-in across separate Playwright worker processes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'trustflow-earner-session-'))
  const envFile = path.join(directory, 'e2e.env')
  const cacheFile = path.join(directory, 'earner-session.json')
  await writeFile(envFile, [
    'VITE_SUPABASE_URL=https://fixture.supabase.co',
    'VITE_SUPABASE_ANON_KEY=fixture-anon-key',
    'TF_TEST_EARNER_EMAIL=fixture@example.invalid',
    'TF_TEST_EARNER_PASSWORD=fixture-password',
  ].join('\n'))

  const env = {
    PATH: process.env.PATH,
    TF_E2E_ENV_FILE: envFile,
    TF_TEST_EARNER_SESSION: cacheFile,
    TF_TEST_EARNER_MODULE_URL: SESSION_MODULE,
  }
  const workers = [startWorker(env), startWorker(env)]

  try {
    await Promise.all(workers.map(worker => worker.ready))
    workers.forEach(worker => worker.child.stdin.end('go\n'))

    const outputs = await Promise.all(workers.map(worker => worker.done))
    const files = await readdir(directory)
    const grants = files.filter(name => name.startsWith('earner-session.json.grant-'))

    expect(outputs.every(output => output.includes('DONE:fixture-user'))).toBe(true)
    expect(grants).toHaveLength(1)
  } finally {
    workers.forEach(worker => worker.child.kill())
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
