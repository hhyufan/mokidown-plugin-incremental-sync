import { readFile } from 'node:fs/promises';
try {
  const config = JSON.parse(await readFile(process.env.MOKIDOWN_CONFIG || 'config.json', 'utf8'));
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || config.port || 8787}${config.basePath || ''}/healthz`, { signal: AbortSignal.timeout(4000) });
  process.exitCode = response.ok ? 0 : 1;
} catch { process.exitCode = 1; }
