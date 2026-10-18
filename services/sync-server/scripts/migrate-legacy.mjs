import { resolve, join } from 'node:path';
import { openLegacyStorage } from '../src/legacy.mjs';
const directory=process.argv[2];
if(!directory)throw new Error('Usage: npm run migrate:legacy -- <legacy-data-directory>');
const absolute=resolve(directory);const storage=await openLegacyStorage(absolute);
try {
 const state=await storage.get('sync:default');
 console.log(`Imported/retained ${Object.keys(state.files).length} records. Original documents.json is preserved.`);
 console.log(`SQLite filename: ${join(absolute,'sync-v3.sqlite')}`);
 console.log('Configure this SQLite file in config.json. Keep the legacy instanceId (mokidown-sync-local), namespace (default) and access key to retain client state.');
}finally{await storage.close();}
