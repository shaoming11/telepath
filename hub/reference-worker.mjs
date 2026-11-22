import { parentPort, workerData } from 'node:worker_threads';
import { parseReferences } from './references.mjs';

try { parentPort.postMessage({ documents: await parseReferences(workerData) }); }
catch (error) { parentPort.postMessage({ error: error.message || 'Could not read these documents.' }); }
