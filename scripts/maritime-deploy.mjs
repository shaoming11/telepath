import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.maritime.sh';
const SOURCE = fileURLToPath(new URL('../maritime/', import.meta.url));
const FILES = ['Dockerfile', 'policy.mjs', 'server.mjs'];
const AGENT_NAME = 'telepathy-pitch-coach';

async function withPackage(use) {
  const directory = await mkdtemp(join(tmpdir(), 'telepathy-maritime-'));
  const zip = join(directory, 'telepathy.zip');
  try {
    execFileSync('zip', ['-q', zip, ...FILES], { cwd: SOURCE });
    return await use(zip);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function deploy(key, existing_id) {
  return withPackage(async zip => {
    const upload = new FormData();
    upload.append('file', new Blob([await readFile(zip)], { type: 'application/zip' }), 'telepathy.zip');
    const headers = { Authorization: 'Bearer ' + key };
    const archive = await fetch(API + '/api/upload/zip', {
      method: 'POST', headers, body: upload, redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (!archive.ok) throw new Error('Source upload returned HTTP ' + archive.status);
    const { s3Key } = await archive.json();
    if (typeof s3Key !== 'string' || !s3Key) throw new Error('Maritime did not return a source package ID.');
    const path = existing_id ? '/api/deploy' : '/api/agents';
    const payload = existing_id
      ? { agentId: existing_id, source: 'zip', uploadS3Key: s3Key }
      : { name: AGENT_NAME, framework: 'custom', uploadS3Key: s3Key, hasWebUi: false, useMaritimeLlm: true };
    const result = await fetch(API + path, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify(payload),
    });
    if (!result.ok) throw new Error('Maritime deployment returned HTTP ' + result.status + '. Check the key scopes and available credits.');
    const agent = await result.json();
    if (existing_id) {
      if (agent.agentId !== existing_id || typeof agent.id !== 'string' || !/^[\w-]+$/.test(agent.id)) {
        throw new Error('Check Maritime for the status of the existing agent.');
      }
      console.log('Maritime deployment ID ' + agent.id);
      return;
    }
    const id = agent.id ?? agent.agentId ?? agent.agent?.id;
    if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) throw new Error('Check the Maritime dashboard for the new agent ID.');
    console.log('TELEPATHY_MARITIME_AGENT_ID=' + id);
  });
}

const key = process.env.MARITIME_API_KEY?.trim();
try {
  const existing_id = process.env.TELEPATHY_MARITIME_AGENT_ID?.trim();
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === '--package' && args[1].endsWith('.zip')) {
    const destination = resolve(args[1]);
    await withPackage(zip => copyFile(zip, destination, constants.COPYFILE_EXCL));
    console.log(destination);
  } else {
    const update = args.length === 1 && args[0] === '--update';
    if (args.length && !update) throw new Error('Use --package <file.zip> for offline packaging or --update to redeploy the configured agent.');
    if (!key) throw new Error('Set MARITIME_API_KEY in your local environment.');
    if (update && !/^[\w-]+$/.test(existing_id || '')) throw new Error('Set TELEPATHY_MARITIME_AGENT_ID to update an existing agent.');
    if (!update && existing_id) throw new Error('A Maritime agent is already configured. Use --update to redeploy it.');
    await deploy(key, existing_id);
  }
} catch (error) {
  console.error(error.message.replaceAll(key || 'MARITIME_API_KEY', '[redacted]'));
  process.exitCode = 1;
}
