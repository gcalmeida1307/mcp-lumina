import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { documentUpload } from '../gateway/document-upload.js';
import { MAX_UPLOAD_BYTES } from '../core/ingestion-limits.js';
import { contentFingerprint } from '../data/ingestion/pipeline.js';

test('multipart endpoint accepts files above 10 MB through 50 MB, rejects larger payloads', async t => {
  const app = express(); app.post('/upload', documentUpload, (req,res) => res.json({ size: req.file?.size }));
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(400).json({ error: error.message }); });
  const server = app.listen(0,'127.0.0.1'); await new Promise<void>(resolve => server.once('listening',resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/upload`;
  for (const size of [11 * 1024 * 1024, MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES + 1]) {
    const body = new FormData(); body.append('file',new Blob([new Uint8Array(size)]),'test.txt');
    const result = await fetch(url,{method:'POST',body});
    assert.equal(result.status,size > MAX_UPLOAD_BYTES ? 400 : 200);
    if(result.ok) assert.equal((await result.json()).size,size); else await result.arrayBuffer();
  }
});

test('content fingerprints ignore filename changes and formatting-only differences', () => {
  assert.equal(contentFingerprint('Adoção\n\nresponsável.'), contentFingerprint(' adoção responsável. '));
});
