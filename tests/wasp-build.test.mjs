import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const BUILD_SCRIPT = await readFile(new URL('../scripts/build-wasp-ui', import.meta.url));

async function buildFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'telepathy-build-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function put(path, contents = '', mode) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, contents, { mode });
  }
  await Promise.all([
    put('scripts/build-wasp-ui', BUILD_SCRIPT),
    put('scripts/generate-wasp-surfaces.py'),
    put('public/index.html'),
    put('public/stage.html'),
    put('wasp-ui/src/main.ts', 'source'),
    ...['.wasproot', '.waspignore', '.npmrc', 'main.wasp.ts', 'schema.prisma', 'package.json', 'package-lock.json',
      'vite.config.ts', 'tsconfig.json', 'tsconfig.src.json', 'tsconfig.wasp.json']
      .map(name => put('wasp-ui/' + name)),
    put('hub/project-references.mjs', "export const WASP_SOURCE_SNAPSHOT='reference-source.json';export const createWaspSourceSnapshot=()=>'{}';"),
    put('bin/npm', `#!/bin/sh
case "$6" in
  install)
    mkdir -p .wasp/spec
    printf '%s' installed > package-lock.json
    ;;
  build)
    printf '%s' resolved > package-lock.json
    if [ "${'$'}{TELEPATHY_BUILD_TEST_SOURCE_EDIT:-}" = yes ]; then
      printf '%s' edited > src/main.ts
    fi
    ;;
  *) exit 1 ;;
esac
`, 0o755),
    put('bin/vite', `#!/bin/sh
dist=.wasp/out/web-app/build
mkdir -p "$dist/wasp-assets"
printf '%s' '<meta name="viewport" content="width=device-width">' > "$dist/200.html"
printf '%s' 'export {}' > "$dist/wasp-assets/app-12345678.js"
`, 0o755),
  ]);
  return {
    run(args = [], extra = {}) {
      return execFileSync('bash', ['scripts/build-wasp-ui', ...args], { cwd: root, encoding: 'utf8',
        env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH, ...extra } });
    },
    read(path) { return readFile(join(root, path), 'utf8'); },
  };
}

test('the Wasp build fingerprints the lockfile that its installer actually resolved', async t => {
  const fixture = await buildFixture(t);
  fixture.run();
  assert.match(await fixture.read('.runtime/wasp-client/source.sha256'), /^[\da-f]{64}\n$/);
  assert.equal(await fixture.read('wasp-ui/package-lock.json'), 'resolved');
  assert.equal(fixture.run(['--ensure'], { TELEPATHY_BUILD_TEST_SOURCE_EDIT: 'yes' }), '');
  assert.equal(await fixture.read('wasp-ui/src/main.ts'), 'source');
});

test('the Wasp build still refuses a real source edit during dependency resolution', async t => {
  const fixture = await buildFixture(t);
  assert.throws(() => fixture.run([], { TELEPATHY_BUILD_TEST_SOURCE_EDIT: 'yes' }),
    error => /build inputs changed during compilation/.test(error.stderr));
  await assert.rejects(fixture.read('.runtime/wasp-client/index.html'), { code: 'ENOENT' });
});
