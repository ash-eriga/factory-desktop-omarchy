import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CALLBACK = path.join(ROOT, 'runtime', 'factory-callback.sh');
const SCHEME = 'x-scheme-handler/factory-desktop';

// A faithful stand-in for xdg-mime that edits an isolated mimeapps.list the
// same way (one Default Applications line per scheme).
const FAKE_XDG_MIME = `#!/bin/sh
MIMEAPPS="\${XDG_CONFIG_HOME:-$HOME/.config}/mimeapps.list"
case "$1" in
  query)
    type="$3"
    [ -f "$MIMEAPPS" ] || exit 0
    line=$(grep -m1 "^$type=" "$MIMEAPPS" || true)
    value="\${line#*=}"
    # Real xdg-mime resolves to a single desktop id, not the raw line.
    echo "\${value%%;*}"
    ;;
  default)
    app="$2"; type="$3"
    mkdir -p "$(dirname "$MIMEAPPS")"
    touch "$MIMEAPPS"
    if grep -q "^$type=" "$MIMEAPPS"; then
      sed -i "s|^$type=.*|$type=$app|" "$MIMEAPPS"
    else
      printf '%s=%s\\n' "$type" "$app" >> "$MIMEAPPS"
    fi
    ;;
  *) exit 1 ;;
esac
`;

function isolated(dir) {
  return {
    ...process.env,
    HOME: dir,
    XDG_CONFIG_HOME: path.join(dir, 'config'),
    XDG_DATA_HOME: path.join(dir, 'data'),
    XDG_STATE_HOME: path.join(dir, 'state'),
    PATH: `${FAKE_BIN}:${process.env.PATH}`,
  };
}

// Fake xdg-mime lives in tests/fake-bin, created once before tests run.
const FAKE_BIN = path.join(ROOT, 'tests', 'fake-bin');

function run(dir, args) {
  return spawnSync(CALLBACK, args, { encoding: 'utf8', env: isolated(dir) });
}

test('register, preserve, and rollback keep other associations intact', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'factory-cb-'));
  try {
    await mkdir(FAKE_BIN, { recursive: true });
    await writeFile(path.join(FAKE_BIN, 'xdg-mime'), FAKE_XDG_MIME, { mode: 0o755 });
    const mimeapps = path.join(dir, 'config', 'mimeapps.list');
    await mkdir(path.dirname(mimeapps), { recursive: true });
    await writeFile(mimeapps, '[Default Applications]\nx-scheme-handler/https=firefox.desktop\ntext/plain=org.gnome.Nano.desktop\n');

    // Register: previous handler for the scheme is empty.
    let result = run(dir, ['register']);
    assert.equal(result.status, 0, result.stderr);
    let content = await readFile(mimeapps, 'utf8');
    assert.ok(content.includes(`${SCHEME}=factory-droid-desktop-callback.desktop`));
    // Existing associations preserved.
    assert.ok(content.includes('x-scheme-handler/https=firefox.desktop'));
    assert.ok(content.includes('text/plain=org.gnome.Nano.desktop'));

    // Idempotent re-register.
    result = run(dir, ['register']);
    assert.equal(result.status, 0, result.stderr);

    // Rollback with no previous handler: our line is dropped, others stay.
    result = run(dir, ['rollback']);
    assert.equal(result.status, 0, result.stderr);
    content = await readFile(mimeapps, 'utf8');
    assert.ok(!content.includes(SCHEME));
    assert.ok(content.includes('x-scheme-handler/https=firefox.desktop'));
    assert.ok(content.includes('text/plain=org.gnome.Nano.desktop'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rollback restores the previous handler', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'factory-cb-'));
  try {
    const mimeapps = path.join(dir, 'config', 'mimeapps.list');
    await mkdir(path.dirname(mimeapps), { recursive: true });
    await writeFile(mimeapps, `[Default Applications]\n${SCHEME}=old-handler.desktop\n`);

    let result = run(dir, ['register']);
    assert.equal(result.status, 0, result.stderr);
    result = run(dir, ['rollback']);
    assert.equal(result.status, 0, result.stderr);
    const content = await readFile(mimeapps, 'utf8');
    assert.ok(content.includes(`${SCHEME}=old-handler.desktop`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rollback refuses to clobber a concurrent change', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'factory-cb-'));
  try {
    let result = run(dir, ['register']);
    assert.equal(result.status, 0, result.stderr);

    // Someone else claims the scheme between register and rollback.
    const mimeapps = path.join(dir, 'config', 'mimeapps.list');
    await writeFile(mimeapps, `[Default Applications]\n${SCHEME}=someone-else.desktop\n`);
    result = run(dir, ['rollback']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing/);
    const content = await readFile(mimeapps, 'utf8');
    assert.ok(content.includes(`${SCHEME}=someone-else.desktop`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('status works without registration', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'factory-cb-'));
  try {
    const result = run(dir, ['status']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /none|This port/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Use real XDG discovery/dispatch, not the helper's fake xdg-mime. The
// executable is a recorder; no browser, GUI, credentials or account is used.
async function desktopFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'factory-xdg-'));
  for (const name of ['data/applications', 'config', 'system', 'bin', '.factory'])
    await mkdir(path.join(dir, name), { recursive: true });
  await writeFile(path.join(dir, '.factory', 'sentinel'), 'standalone CLI untouched');
  await writeFile(path.join(dir, 'bin', 'factory-droid-desktop'),
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/received"\n', { mode: 0o755 });
  const env = {
    ...process.env, HOME: dir,
    XDG_CONFIG_HOME: path.join(dir, 'config'),
    XDG_CONFIG_DIRS: path.join(dir, 'system'),
    XDG_DATA_HOME: path.join(dir, 'data'),
    XDG_DATA_DIRS: path.join(dir, 'system'),
    XDG_CURRENT_DESKTOP: 'X-Generic', DE: 'generic', DISPLAY: ':0',
    PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin`,
  };
  for (const name of ['DBUS_SESSION_BUS_ADDRESS', 'BROWSER', 'KDE_FULL_SESSION',
    'GNOME_DESKTOP_SESSION_ID', 'DESKTOP_SESSION'])
    delete env[name];
  const apps = path.join(dir, 'data', 'applications');
  const entry = path.join(apps, 'factory-droid-desktop.desktop');
  const source = await readFile(path.join(ROOT, 'packaging', 'factory-droid-desktop.desktop'), 'utf8');
  const run = (command, args) => {
    const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return result.stdout.trim();
  };
  const refresh = () => run('/usr/bin/update-desktop-database', [apps]);
  const handler = () => run('/usr/bin/xdg-mime', ['query', 'default', SCHEME]);
  return { dir, apps, entry, source, run, refresh, handler };
}

test('a clean install discovers and dispatches browser callbacks without a registration command', async () => {
  const h = await desktopFixture();
  try {
    // Negative control: the old packaged entry cannot be discovered.
    await writeFile(h.entry, h.source.replace(/^MimeType=.*\n/m, ''));
    h.refresh();
    assert.equal(h.handler(), '');
    await writeFile(h.entry, h.source);
    h.run('/usr/bin/desktop-file-validate', [h.entry]);
    h.refresh();
    assert.equal(h.handler(), 'factory-droid-desktop.desktop');
    const uri = 'factory-desktop://auth/callback?code=synthetic-test-only&state=synthetic';
    h.run('/usr/bin/xdg-open', [uri]);
    assert.equal(await readFile(path.join(h.dir, 'received'), 'utf8'), `${uri}\n`);
    assert.equal(await readFile(path.join(h.dir, '.factory', 'sentinel'), 'utf8'),
      'standalone CLI untouched');
    await assert.rejects(readFile(path.join(h.dir, 'config', 'mimeapps.list')), { code: 'ENOENT' });
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test('installing protocol support preserves an existing user default', async () => {
  const h = await desktopFixture();
  try {
    await writeFile(path.join(h.apps, 'existing.desktop'),
      '[Desktop Entry]\nType=Application\nName=Existing app\nExec=true %u\n'
        + `MimeType=${SCHEME};\n`);
    const mimeapps = path.join(h.dir, 'config', 'mimeapps.list');
    const previous = `[Default Applications]\n${SCHEME}=existing.desktop\n`;
    await writeFile(mimeapps, previous);
    await writeFile(h.entry, h.source);
    h.refresh();
    assert.equal(h.handler(), 'existing.desktop');
    assert.equal(await readFile(mimeapps, 'utf8'), previous);
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test('uninstalling the desktop entry removes its clean-install protocol association', async () => {
  const h = await desktopFixture();
  try {
    await writeFile(h.entry, h.source);
    h.refresh();
    assert.equal(h.handler(), 'factory-droid-desktop.desktop');
    await rm(h.entry);
    h.refresh();
    assert.equal(h.handler(), '');
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});
