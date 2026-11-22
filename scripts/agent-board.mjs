import { spawnSync, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const REPO = 'fireheartjerry/telepathy';
const BRANCH = 'agent-coordination';
const CONTENTS = 'repos/' + REPO + '/contents/claims.json';
const AREAS = {
  '@phone-ui': ['public/index.html', 'public/phone.mjs', 'public/phone.css', 'public/phone-data.mjs', 'public/calibrate.mjs'],
  '@stage-ui': ['public/stage.html', 'public/stage.mjs', 'public/stage.css', 'public/announcements.mjs'],
};
AREAS['@ui'] = [...AREAS['@phone-ui'], ...AREAS['@stage-ui']];

export function expandScopes(scopes) {
  if (!scopes.length) throw new Error('Specify at least one file, directory, or UI area.');
  const paths = scopes.flatMap(scope => {
    if (scope.startsWith('@')) {
      if (!Object.hasOwn(AREAS, scope)) throw new Error('Unknown area: ' + scope);
      return AREAS[scope];
    }
    const path = scope.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (path === '.') return [path];
    if (!path || path.split('/').some(part => /^(?:\.{1,2})?$/.test(part) || !/^[a-z0-9_.-]+$/i.test(part))) {
      throw new Error('Use a repo-relative file or directory: ' + scope);
    }
    return [path];
  });
  return [...new Set(paths)].sort();
}

export function scopesOverlap(left, right) {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a === '.' || b === '.' || a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

export function addClaim(claims, request) {
  const conflict = claims.find(claim => claim.paths.some(path => request.paths.some(next => scopesOverlap(path, next))));
  if (conflict) {
    throw new Error('Scope already claimed by @' + conflict.owner + ' (' + conflict.agent + ') on '
      + conflict.branch + ': ' + conflict.scopes.join(', ') + '\nCoordinate here: ' + conflict.thread);
  }
  return [...claims, request];
}

export function removeClaim(claims, id, owner) {
  const claim = claims.find(item => item.id === id);
  if (!claim) throw new Error('Claim not found: ' + id);
  if (claim.owner.toLowerCase() !== owner.toLowerCase()) {
    throw new Error('Ask @' + claim.owner + ' to release this claim: ' + claim.thread);
  }
  return claims.filter(item => item.id !== id);
}

export function updateBoard({ read, write }, transform) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { sha, revision, claims } = read();
    const next = { revision: revision + 1, claims: transform(claims) };
    if (write(sha, next)) return next;
  }
  throw new Error('The board kept changing. List current claims and try again.');
}

function gh(args, input) {
  const result = spawnSync('gh', args, { input, encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') throw new Error('Install GitHub CLI and sign in with gh auth login.');
  if (result.error) throw result.error;
  return result;
}

function requireSuccess(result) {
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'GitHub request failed.');
  return result.stdout;
}

function read() {
  const file = JSON.parse(requireSuccess(gh(['api', CONTENTS + '?ref=' + BRANCH])));
  const board = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  if (!file.sha || !Number.isSafeInteger(board.revision) || !Array.isArray(board.claims)) {
    throw new Error('The shared registry is invalid. Ask the repo owner to check claims.json.');
  }
  return { sha: file.sha, revision: board.revision, claims: board.claims };
}

function write(sha, board) {
  const body = JSON.stringify({
    branch: BRANCH,
    message: 'Update active agent claims',
    sha,
    content: Buffer.from(JSON.stringify(board, null, 2) + '\n').toString('base64'),
  });
  const result = gh(['api', CONTENTS, '--method', 'PUT', '--input', '-'], body);
  if (result.status !== 0 && /HTTP 409\b/.test(result.stderr)) return false;
  if (result.status !== 0 && /HTTP 422\b/.test(result.stderr) && read().sha !== sha) return false;
  requireSuccess(result);
  return true;
}

function main([command, ...args]) {
  if (command === 'list' && !args.length) {
    console.log(JSON.stringify(read().claims, null, 2));
    return;
  }

  if (command === 'claim' && args.length >= 3) {
    const [agent, thread, ...scopes] = args;
    if (!/^[a-z0-9][a-z0-9._-]{0,47}$/i.test(agent)) throw new Error('Use a short agent name, such as sam-ui.');
    if (!/^https:\/\/github\.com\/fireheartjerry\/telepathy\/(?:discussions|issues|pull)\/[1-9]\d*$/.test(thread)) {
      throw new Error('Link a discussion, issue, or PR in this repository.');
    }
    const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
    if (!branch || branch === BRANCH) throw new Error('Check out your work branch first.');
    const paths = expandScopes(scopes);
    const owner = requireSuccess(gh(['api', 'user', '--jq', '.login'])).trim();
    const claim = { id: randomUUID(), owner, agent, branch, thread, scopes, paths, claimedAt: new Date().toISOString() };
    updateBoard({ read, write }, claims => addClaim(claims, claim));
    console.log(JSON.stringify(claim, null, 2));
    return;
  }

  if (command === 'release' && args.length === 1) {
    const owner = requireSuccess(gh(['api', 'user', '--jq', '.login'])).trim();
    updateBoard({ read, write }, claims => removeClaim(claims, args[0], owner));
    console.log('Released ' + args[0]);
    return;
  }

  throw new Error('Usage: npm run board -- list | claim AGENT THREAD_URL SCOPE... | release CLAIM_ID');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
