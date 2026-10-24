// Actual daemon IPC smoke check: starts the bundled Droid daemon in IPC
// mode under an isolated FACTORY_HOME and waits for the same ready message
// the vendor lifecycle waits for ({"type":"factory.daemon.ready"}).
//
// No authenticated or model requests are sent. Success requires the ready
// message AND a clean shutdown; a child that exits cleanly before reporting
// ready is a failure, not a pass.
//
// Usage:
//   node tests/ipc-smoke.mjs <bundle> [timeout-seconds]
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const READY_TYPE = 'factory.daemon.ready';

export async function runSmoke({
  bundle, droidPath, timeoutMs = 120000,
  spawnImpl = spawn, homeFactory = defaultHomeFactory,
}) {
  if (!bundle && !droidPath) {
    return { ok: false, reason: 'usage: node tests/ipc-smoke.mjs <bundle> [timeout-seconds]' };
  }
  const home = homeFactory();
  const child = spawnImpl(droidPath ?? path.join(bundle, 'resources', 'bin', 'droid'),
    ['daemon', '--listen', 'ipc'], home);

  return await new Promise(resolve => {
    let ready = false;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      try { rmSync(home, { recursive: true, force: true }); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, reason: ready ? 'timed out after ready' : 'timed out before ready' });
    }, timeoutMs);

    child.onMessage?.(message => {
      if (typeof message !== 'object' || message === null || message.type !== READY_TYPE) {
        return; // non-ready and malformed messages are observed, not accepted
      }
      ready = true;
      child.kill('SIGTERM');
    });
    child.onError(error => {
      finish({ ok: false, reason: `daemon failed to start: ${error.message}` });
    });
    child.onExit((code, signal) => {
      if (!ready) {
        finish({ ok: false, reason: `exited before ready (code=${code} signal=${signal})` });
        return;
      }
      if (signal === 'SIGTERM' || code === 0) {
        finish({ ok: true, reason: `ready received and daemon shut down cleanly (code=${code})` });
      } else {
        finish({ ok: false, reason: `unexpected exit after ready (code=${code} signal=${signal})` });
      }
    });
  });
}

function defaultHomeFactory() {
  const home = mkdtempSync(path.join(tmpdir(), 'factory-ipc-'));
  mkdirSync(path.join(home, 'desktop-home'), { recursive: true });
  return home;
}

function nodeSpawn(droid, args, home) {
  const child = spawn(droid, args, {
    cwd: path.join(home, 'desktop-home'),
    env: {
      ...process.env,
      HOME: home,
      FACTORY_HOME_OVERRIDE: path.join(home, 'factory-home'),
      XDG_CACHE_HOME: path.join(home, 'cache'),
      XDG_CONFIG_HOME: path.join(home, 'config'),
      XDG_STATE_HOME: path.join(home, 'state'),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  return {
    onMessage: handler => child.on('message', handler),
    onError: handler => child.on('error', handler),
    onExit: handler => child.on('exit', (code, signal) => handler(code, signal)),
    kill: signal => child.kill(signal),
  };
}

async function cli() {
  const bundle = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  const timeoutMs = Number(process.argv[3] ?? 120) * 1000;
  const result = await runSmoke({ bundle, timeoutMs, spawnImpl: nodeSpawn });
  if (result.ok) {
    console.log(`IPC smoke check passed: ${result.reason}`);
  } else {
    console.error(`IPC smoke check failed: ${result.reason}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cli();
}
