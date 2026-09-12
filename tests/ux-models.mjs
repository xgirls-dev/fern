import assert from 'node:assert/strict';
import {fixture} from './ui-fixture.mjs';
const {page,state,errors,dir,close}=await fixture();
let models=[{id:'9b',label:'Klein 9B',bytes:9624762465,downloaded:0,installed:true,state:'installed'},{id:'4b',label:'Klein 4B',bytes:4580585470,downloaded:0,installed:false,state:'not-installed'}];
try {
 await page.route('**/api/models',route=>route.fulfill({json:{models}}));
 await page.route('**/api/models/*',route=>{const op=route.request().url().split('/').at(-1);models[1].state=op==='install'?'downloading':op==='pause'?'paused':'not-installed';return route.fulfill({json:{models}});});
 await page.getByRole('combobox',{name:'Model',exact:true}).selectOption('4b');
 await page.getByRole('button',{name:'Generate image',exact:true}).click();
 assert.equal(state.payloads.at(-1).model,'4b');
 await page.getByRole('button',{name:'Models',exact:true}).click();
 const card=page.locator('.model-library-card').filter({has:page.getByRole('heading',{name:/Klein 4B/})});
 await card.getByRole('button',{name:'Install',exact:true}).click();
 await card.getByRole('button',{name:'Pause',exact:true}).click();
 await card.getByRole('button',{name:'Resume download',exact:true}).waitFor();
 await page.screenshot({path:`${dir}/models-library.png`});
 await page.getByRole('button',{name:'Library',exact:true}).click();
 await page.locator('.history-grid').waitFor();
 assert.deepEqual(errors,[]);console.log('Model selection, install, pause, resume and gallery navigation passed');
}finally{await close();}
