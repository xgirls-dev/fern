import assert from 'node:assert/strict';
import {fixture} from './ui-fixture.mjs';
const {page,state,errors,dir,close}=await fixture();
const choose=()=>page.getByRole('button',{name:'Choose model',exact:true});
async function refreshed(){await page.waitForResponse(r=>r.url().includes('/api/flux2/status'));await page.waitForTimeout(150);}
async function oneRow(){
 const boxes=await page.locator('.composer-toolbar').evaluate(el=>Array.from(el.querySelectorAll(':scope > .composer-options > button, :scope > .composer-options > .seed-popover-anchor > button, .composer-model-trigger, .composer-submit')).map(b=>{const r=b.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};}));
 assert(boxes.length>=4);const centers=boxes.map(b=>b.y+b.height/2);assert(Math.max(...centers)-Math.min(...centers)<2,'Toolbar buttons must share one row');
 const rect=await page.locator('.prompt-composer').boundingBox();for(const b of boxes)assert(b.x>=rect.x && b.x+b.width<=rect.x+rect.width,'Controls stay inside composer');
}
async function contained(selector,edge){
 const {panel,composer,toolbar}=await page.evaluate(selector=>({
  panel:document.querySelector(selector).getBoundingClientRect().toJSON(),
  composer:document.querySelector('.prompt-composer').getBoundingClientRect().toJSON(),
  toolbar:document.querySelector('.composer-toolbar').getBoundingClientRect().toJSON(),
 }),selector);
 assert(panel.x>=composer.x && panel.x+panel.width<=composer.x+composer.width,'Popover stays within composer edges');
 assert(Math.abs(edge==='left'?panel.x-toolbar.x:panel.x+panel.width-toolbar.x-toolbar.width)<1,'Popover aligns with toolbar inset');
}
try {
 await page.setViewportSize({width:1080,height:720});
 assert.equal(await choose().count(),0);
 assert.equal(await page.locator('.prompt-composer select').count(),0);
 assert.equal(await page.getByRole('button',{name:'Models',exact:true}).count(),0);
 await page.locator('.prompt-composer').getByRole('button',{name:'Image settings',exact:true}).click();
 await oneRow();await page.screenshot({path:`${dir}/composer-one-model.png`});
 state.installedModels=[{id:'9b',label:'Klein 9B'},{id:'4b',label:'Klein 4B'}];await refreshed();await choose().waitFor();
 await oneRow();await choose().click();
 const menu=page.getByRole('menu',{name:'Model',exact:true});await menu.waitFor();
 await contained('.composer-model-menu','right');
 await page.screenshot({path:`${dir}/composer-model-popover.png`});
 await page.keyboard.press('Escape');assert.equal(await menu.count(),0);assert(await choose().evaluate(el=>el===document.activeElement));
 await choose().click();await page.locator('#prompt').click();assert.equal(await menu.count(),0);
 await choose().focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('End');await page.keyboard.press('Enter');assert.equal(await menu.count(),0);assert((await choose().innerText()).includes('4B'));
 await page.getByRole('button',{name:'Seed settings',exact:true}).click();await contained('.seed-popover','left');await page.screenshot({path:`${dir}/composer-seed-popover.png`});await page.getByRole('textbox',{name:'Seed',exact:true}).fill('1234567890123');await choose().click();assert.equal(await page.getByRole('dialog',{name:'Seed settings',exact:true}).count(),0);
 for(const width of [1440,1080]){
  await page.setViewportSize({width,height:720});await contained('.composer-model-menu','right');
 }
 await page.keyboard.press('Escape');await oneRow();
 await page.getByRole('button',{name:'Generate image',exact:true}).click();assert.equal(state.payloads.at(-1).model,'4b');
 state.runtime={status:'loading',message:'Checking a very long installed runtime message that must never make the header taller',logs:[]};await refreshed();
 const banner=await page.locator('.runtime-banner').boundingBox();const header=await page.locator('.titlebar').boundingBox();assert(banner.y>=header.y && banner.y+banner.height<=header.y+header.height,'Alert fits inside titlebar');
 const actions=await page.locator('.titlebar-actions').boundingBox();assert(banner.x+banner.width<=actions.x,'Alert leaves header controls accessible');
 await page.screenshot({path:`${dir}/composer-loading-header.png`});
 await choose().click();state.installedModels=[{id:'9b',label:'Klein 9B'}];await refreshed();assert.equal(await choose().count(),0);assert.equal(await menu.count(),0);
 state.installedModels=[];await refreshed();assert.equal(await choose().count(),0);await oneRow();
 state.modelReady=false;state.runtime={status:'idle',message:'',logs:[]};await refreshed();
 assert.equal(await page.locator('.runtime-install-hint').count(),0);await oneRow();
 await page.screenshot({path:`${dir}/composer-unavailable-model.png`});
 assert.deepEqual(errors,[]);console.log('Composer: 0/1/2 models, keyboard/outside close, one row at 1080px with inspector, seed, payload, unavailable model and header bounds passed');
}finally{await close();}
