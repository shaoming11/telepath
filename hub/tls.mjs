import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

export function findLanAddress() {
  const routes = networkInterfaces();
  const preferred = [...(routes.en0 ?? []), ...Object.values(routes).flat()];
  return preferred.find(item => item?.family === 'IPv4' && !item.internal && /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(item.address))?.address ?? 'localhost';
}

function openssl(args) {
  execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 8000 });
}

export function resolveTLS(env, runtime, host) {
  if (env.TELEPATHY_NO_TLS === '1') return null;
  if (env.TELEPATHY_TLS_CERT || env.TELEPATHY_TLS_KEY) {
    if (!env.TELEPATHY_TLS_CERT || !env.TELEPATHY_TLS_KEY) throw new Error('Both TELEPATHY_TLS_CERT and TELEPATHY_TLS_KEY are required.');
    return { key: readFileSync(env.TELEPATHY_TLS_KEY), cert: readFileSync(env.TELEPATHY_TLS_CERT) };
  }
  if (!isIP(host) && !/^[a-z0-9.-]+$/i.test(host)) throw new Error('Invalid TELEPATHY_HOST for the LAN certificate.');
  const dir = join(runtime, 'tls');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const root_key = join(dir, 'root.key');
  const root_pem = join(dir, 'root.pem');
  const root_cer = join(dir, 'telepathy-ca.cer');
  if (!existsSync(root_key) || !existsSync(root_pem)) {
    const cfg = join(dir, 'root.cnf');
    writeFileSync(cfg, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Telepathy Local Demo\n[ca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n');
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365', '-sha256', '-config', cfg, '-keyout', root_key, '-out', root_pem]);
  }
  openssl(['x509', '-in', root_pem, '-outform', 'DER', '-out', root_cer]);
  const key = join(dir, 'hub.key');
  const cert = join(dir, 'hub.pem');
  const request = join(dir, 'hub.csr');
  const cfg = join(dir, 'hub.cnf');
  const san = ['DNS:localhost', 'IP:127.0.0.1'];
  if (host !== 'localhost') san.push((isIP(host) ? 'IP:' : 'DNS:') + host);
  writeFileSync(cfg, 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=' + san.join(',') + '\n');
  openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=Telepathy Hub', '-keyout', key, '-out', request]);
  openssl(['x509', '-req', '-in', request, '-CA', root_pem, '-CAkey', root_key, '-CAcreateserial', '-out', cert, '-days', '90', '-sha256', '-extfile', cfg]);
  rmSync(request, { force: true });
  return { key: readFileSync(key), cert: readFileSync(cert), publicRoot: readFileSync(root_cer) };
}
