import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { config } from '../gateway/config.js';
import { Store } from '../data/storage/database.js';
import { crawlWebsite } from '../data/ingestion/web-crawler.js';
import { retrieve } from '../core/rag/retrieval.js';

test('web pages survive database reopening, retain provenance and can be retrieved without network', async t => {
  const directory = await mkdtemp(join(tmpdir(),'lumina-web-test-'));
  const original = { DATA_DIR: config.DATA_DIR, S3_ENDPOINT: config.S3_ENDPOINT, EMBEDDING_MODEL: config.EMBEDDING_MODEL };
  Object.assign(config,{DATA_DIR:directory,S3_ENDPOINT:'',EMBEDDING_MODEL:''});
  let store = new Store('',directory); await store.init();
  t.after(async () => { await store.close(); Object.assign(config,original); const target = resolve(directory); if (target.startsWith(resolve(tmpdir())+sep) && target.includes('lumina-web-test-')) await rm(target,{recursive:true,force:true}); });
  const { Ingestion } = await import('../data/ingestion/pipeline.js');
  const ingestion = new Ingestion(store);
  let firstId = '';
  await crawlWebsite({url:'https://example.com/',maxPages:2,signal:new AbortController().signal,
    save:async page => {
      const result=await ingestion.enqueue(page.title+'.md',Buffer.from(page.text),'geral','tester',{sourceUrl:page.url,capturedAt:'2026-09-24T12:00:00Z',webLinks:page.links});
      if(!firstId) firstId=result.document.id;
      await ingestion.flushDocuments();
      assert.equal((await store.document(result.document.id))?.status,'ready');
      return {documentId:result.document.id,duplicate:result.duplicate};
    },progress:async()=>{}
  },{wait:async()=>{},fetch:async url=>url.pathname==='/robots.txt'?{status:404,headers:{},body:Buffer.alloc(0)}:{status:200,headers:{'content-type':'text/html'},body:Buffer.from(`<title>${url.pathname==='/'?'Manual':'Procedimento'}</title><main><p>Procedimento de backup institucional: mantenha cópias verificadas em armazenamento independente e registre a restauração periodicamente.</p>${url.pathname==='/'?'<a href="/procedimento">Procedimento completo</a>':''}</main>`)}});
  await ingestion.idle(); await store.close(); store=new Store('',directory);
  const documents=await store.documents('geral'); assert.equal(documents.length,2);
  assert.deepEqual((await store.document(firstId))?.webLinks,['https://example.com/procedimento']);
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('Network must not be used for offline retrieval');});
  const results=await retrieve(store,'backup','geral');
  assert.ok(results.length>0); assert.match(results[0].text,/backup institucional/);
  assert.ok(results.every(source=>source.sourceUrl?.startsWith('https://example.com/')));
  assert.equal(results[0].capturedAt,'2026-09-24T12:00:00Z');
  assert.deepEqual(await retrieve(store,'backup','medicina'),[]);
});
