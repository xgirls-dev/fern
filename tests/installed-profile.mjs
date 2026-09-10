import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'vite';
import {join,resolve} from 'node:path';
const profile=process.env.FERN_TEST_PROFILE;
assert(profile,'Set FERN_TEST_PROFILE to an existing profile for read-only integration verification');
const python=join(profile,'runtime','python-home','python.exe');
const backend=spawn(python,['-u','-c',`import sys; sys.path.insert(0,'scripts'); import api_server as a
class ReadOnly(a.Handler):
 allow_cors=True
 def do_POST(self): self.send_json(403, {'error':'Read-only verification'})
s=a.ThreadingHTTPServer(('127.0.0.1',0),ReadOnly)
print(s.server_address[1],flush=True)
s.serve_forever()`],{cwd:process.cwd(),windowsHide:true,env:{...process.env,FERN_ROOT:join(profile,'studio-data'),PYTHONHOME:join(profile,'runtime','python-home'),PYTHONPATH:join(profile,'runtime','site-packages')}});
backend.stderr.on('data',()=>{});
const port=await new Promise((resolve,reject)=>{backend.once('error',reject);backend.stdout.once('data',chunk=>resolve(Number(chunk.toString().trim())));});
const api=`http://127.0.0.1:${port}`;
let browser,server;
try {
 const start=Date.now();
 const initial=await (await fetch(api+'/api/flux2/status')).json();
 assert(Date.now()-start<3000,'Gallery status must not wait for hardware imports');
 assert(initial.images.length>0);assert.equal(initial.model.checking,true);
 server=await createServer({configFile:false,root:resolve('apps/desktop/src/renderer'),server:{host:'127.0.0.1',port:0}});await server.listen();
 const {chromium}=await import(process.env.FERN_PLAYWRIGHT_MODULE);
 browser=await chromium.launch({headless:true,executablePath:process.env.FERN_CHROME_PATH});
 const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(api=>{window.studio=new Proxy({platform:'win32',getApiBaseUrl:async()=>api,onApiBaseUrl:()=>()=>{},onBackendError:()=>()=>{},onThemeChanged:()=>()=>{}},{get:(t,k)=>t[k]??(async()=>null)});},api);
 await page.goto(server.resolvedUrls.local[0]);
 await page.getByRole('button',{name:'Library',exact:true}).click();
 await page.locator('.thumb-wrap').first().waitFor();
 assert(await page.locator('.thumb-wrap').count()>0);
 const deadline=Date.now()+120000;let status;
 do {status=await(await fetch(api+'/api/flux2/status?images=0')).json();if(!status.model.checking)break;await new Promise(r=>setTimeout(r,500));}while(Date.now()<deadline);
 assert.equal(status.model.runtimeReady,true);assert.equal(status.runtime.status,'idle');
 await page.reload();await page.getByRole('button',{name:'Library',exact:true}).click();await page.locator('.thumb-wrap').first().waitFor();
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,images:initial.images.length,modelInstalled:status.model.runtimeReady,modelLoaded:false,libraryVisible:true,reloadPassed:true}));
} finally {await browser?.close();await server?.close();backend.kill();}
