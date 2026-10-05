const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function harness(files, extras = {}) {
  const timers = new Map();
  let now = Date.parse('2026-10-05T12:00:00Z');
  let seq = 0;
  const window = new EventTarget();
  const context = vm.createContext({
    window, console: { debug() {}, warn() {}, error() {} }, CustomEvent,
    AbortController, Response, URL, Headers, navigator: {}, CSS: { escape: v => v },
    location: { origin: 'https://www.wiki-masters.com', pathname: '/collection' },
    document: {}, localStorage: { getItem() { return null; }, setItem() {} },
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, delay) { const id = ++seq; timers.set(id, {fn, at:now + delay}); return id; },
    clearTimeout(id) { timers.delete(id); }, ...extras
  });
  for (const file of files) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  return {
    window, context, timers,
    send(type, detail) { window.dispatchEvent(new CustomEvent(type, { detail })); },
    async advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers].filter(([,timer]) => timer.at <= target).sort((a,b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      now = target; await flush();
    }
  };
}
function priceHarness(extras) {
  const h = harness(['features/core.js','features/price-ui.js','features/price-loader.js'], extras);
  const registry = h.window.__wmAverageFeatures;
  const core = registry.core.create();
  const runtime = { core, settings: { isEnabled: () => true } };
  runtime.priceUi = registry.priceUi.create(runtime);
  return { ...h, core, runtime };
}
function packHarness(fetch, navigator) {
  const h = harness(['bridge/packs.js'], { navigator: navigator || {
    locks: { request: (_name, _options, callback) => Promise.resolve().then(() => callback({})) }
  }});
  const packs = h.window.__wmBridgeFeatures.bridgePacks.create({core:{
    originalFetch: fetch, MAX_BULK_PACKS: 100,
    mapPackCards: json => Array.isArray(json?.cards) ? json.cards : []
  }});
  const results = [], progress = [];
  h.window.addEventListener('wm-average-open-all-packs-result', e => results.push(e.detail));
  h.window.addEventListener('wm-average-open-all-packs-progress', e => progress.push(e.detail));
  return { ...h, packs, results, progress };
}
const response = (body, status = 200) => new Response(JSON.stringify(body), {status});
const card = {id:'a', title:'Carte A', rarity:'C'};

test('un prix manquant ne reprend jamais la moyenne d’une autre rareté', () => {
  const {runtime} = priceHarness();
  const choose = runtime.priceUi.chooseAverage;
  assert.equal(choose({ok:true, averages:{UR:200}}, null, 'C'), null);
  assert.equal(choose({ok:true, averages:{UR:200}}, null), 200);
  assert.equal(choose({ok:true, averages:{C:3,UR:200}}, null), null);
  assert.equal(choose({ok:false, averages:{C:3}}, null, 'C'), null);
});

test('null, valeurs vides, booléens et prix négatifs ne deviennent pas des prix', () => {
  const {runtime} = priceHarness();
  for (const value of [null, undefined, '', ' ', false, true, -1, Infinity, NaN, 'invalide']) {
    assert.equal(runtime.priceUi.chooseAverage({ok:true, averages:{C:value}}, null, 'C'), null);
  }
  for (const value of [0, '0', 2.5, '2.5']) {
    assert.equal(runtime.priceUi.chooseAverage({ok:true, averages:{C:value}}, null, 'C'), Number(value));
  }
});

test('cache : TTL de 24 h, Retry-After borné et horodatages futurs rejetés', () => {
  const {core} = priceHarness();
  const now = 100000000;
  const entry = {ok:true, fetchedAt:now, averages:{C:3}};
  assert.equal(core.isCacheEntryValid(entry, now), true);
  assert.equal(core.isCacheEntryValid(entry, now + core.CACHE_TTL), false);
  assert.equal(core.isCacheEntryValid(entry, now - 1), false);
  assert.equal(core.isCacheEntryValid({...entry,ok:false,retryAfterMs:120000}, now + 90000), true);
  assert.equal(core.isCacheEntryValid({...entry,ok:false,retryAfterMs:Infinity}, now + 300000), false);
  assert.equal(core.isCacheEntryValid({fetchedAt:now}, now), false);
});

test('la réponse met à jour tous les exemplaires et respecte leur rareté affichée', () => {
  const badges = [];
  const cards = ['C','UR','UR'].map(rarity => {
    const badge = {className:'wm-average-badge', classList:{contains:() => false}, parentElement:{}, textContent:'Prix…'};
    badges.push(badge);
    return {querySelector:selector => selector === '.wm-average-badge' ? badge : null,
      querySelectorAll:() => [{textContent:rarity}]};
  });
  const {core, runtime} = priceHarness({document:{querySelectorAll:() => cards}});
  core.cardMetaById.set('a', {id:'a', title:'A', rarity:'UR'});
  core.cacheMemory.set('a', {ok:true, averages:{C:2,UR:200}});
  runtime.priceUi.renderKnownCard('a');
  assert.deepEqual(badges.map(b => b.textContent), ['Moy. 2 W','Moy. 200 W','Moy. 200 W']);
});

function loaderHarness() {
  const h = priceHarness();
  const requests = [], rendered = [];
  h.runtime.priceUi = {renderKnownCard:id => rendered.push(id)};
  const progress = [];
  let finished = 0;
  h.runtime.collectionBulk = {updateBulkProgress:(...args) => progress.push(args), finishBulkLoad:() => finished++};
  h.window.addEventListener('wm-average-request', e => requests.push(e.detail));
  const loader = h.window.__wmAverageFeatures.priceLoader.create(h.runtime);
  return {...h, loader, requests, rendered, progress, finished:() => finished};
}

test('la file déduplique les cartes et limite à trois requêtes simultanées', () => {
  const h = loaderHarness();
  h.loader.loadCacheForCards([card, card, ...['b','c','d'].map(id => ({...card,id}))]);
  assert.equal(h.requests.length, 3);
  h.send('wm-average-response',{...h.requests[0], ok:true, averages:{C:1}});
  assert.equal(h.requests.length, 4);
  assert.equal(h.requests.filter(r => r.id === 'a').length, 1);
});

test('les réponses inconnues et dupliquées ne libèrent aucun emplacement', () => {
  const h = loaderHarness();
  h.loader.loadCacheForCards(['a','b','c','d','e'].map(id => ({...card,id})));
  h.send('wm-average-response',{requestId:'inconnu',id:'b',ok:true});
  assert.equal(h.requests.length, 3);
  const first = h.requests[0];
  h.send('wm-average-response',{...first,ok:true,averages:{C:1}});
  assert.equal(h.requests.length, 4);
  h.send('wm-average-response',{...first,ok:true,averages:{C:999}});
  assert.equal(h.requests.length, 4);
  assert.equal(h.core.cacheMemory.get('a').averages.C, 1);
});

test('une requête sans réponse expire et la file reprend', async () => {
  const h = loaderHarness();
  h.loader.loadCacheForCards(['a','b','c','d'].map(id => ({...card,id})));
  await h.advance(45000);
  assert.equal(h.requests.length, 4);
  assert.equal(h.core.cacheMemory.get('a').ok, false);
  const fourth = h.requests[3];
  h.send('wm-average-response',{...fourth,ok:true,averages:{C:1}});
  assert.equal(h.loader.isPending('d'), false);
  h.send('wm-average-response',{...h.requests[0],ok:true,averages:{C:999}});
  assert.equal(h.core.cacheMemory.get('a').ok, false);
});

test('le chargement massif compte les ids uniques et se termine après succès ou erreur', () => {
  const h = loaderHarness();
  h.loader.loadCacheForCards([card,card,{...card,id:'b'}],{markBulk:true});
  assert.equal(h.progress[0][0],2);
  h.send('wm-average-response',{...h.requests[0],ok:true,averages:{C:1}});
  h.send('wm-average-response',{...h.requests[1],ok:false});
  assert.equal(h.finished(),1);
});

test('une erreur de rendu ne bloque pas le paquet de prix suivant', () => {
  const h = loaderHarness();
  h.loader.loadCacheForCards(['a','b','c','d'].map(id => ({...card,id})));
  h.runtime.priceUi.renderKnownCard = () => { throw new Error('DOM retiré'); };
  h.send('wm-average-response',{...h.requests[0],ok:true,averages:{C:1}});
  assert.equal(h.requests.length,4);
});

test('Tout ouvrir conserve les cartes et s’arrête quand le serveur annonce zéro', async () => {
  let calls = 0;
  const h = packHarness(async () => response({cards:[card],packs_remaining:++calls === 1 ? 1 : 0}));
  const run = h.packs.openAllPacks('x');
  await flush(); await h.advance(2000); await run;
  assert.equal(calls,2);
  assert.equal(h.results[0].openedPacks,2);
  assert.equal(h.results[0].cards.length,2);
  assert.equal(h.results[0].ok,true);
});

test('un compteur null ne signifie pas zéro paquet restant', async () => {
  let calls = 0;
  const h = packHarness(async () => response({cards:[card],packs_remaining:++calls === 1 ? null : 0}));
  const run = h.packs.openAllPacks('x');
  await flush(); await h.advance(2000); await run;
  assert.equal(calls,2);
});

test('Arrêter interrompt l’attente sans perdre le paquet déjà ouvert', async () => {
  let calls = 0;
  const h = packHarness(async () => { calls++; return response({cards:[card],packs_remaining:8}); });
  const run = h.packs.openAllPacks('x');
  await flush(); h.send('wm-average-cancel-open-all-packs',{requestId:'x'}); await run;
  assert.equal(calls,1);
  assert.equal(h.results[0].cancelled,true);
  assert.equal(h.results[0].cards.length,1);
});

test('Arrêter pendant le POST attend la réponse et conserve ses cartes', async () => {
  let resolve;
  const h = packHarness(() => new Promise(r => {resolve=r;}));
  const run = h.packs.openAllPacks('x'); await flush();
  h.packs.cancelOpenAllPacks('x');
  resolve(response({cards:[card],packs_remaining:8})); await run;
  assert.equal(h.results[0].openedPacks,1);
  assert.equal(h.results[0].cards.length,1);
  assert.equal(h.results[0].cancelled,true);
});

test('une erreur réseau sur POST ne déclenche jamais de nouvel essai', async () => {
  let calls = 0;
  const h = packHarness(async () => { calls++; throw new Error('network'); });
  await h.packs.openAllPacks('x');
  assert.equal(calls,1);
  assert.equal(h.results[0].ok,false);
  assert.match(h.results[0].error,/peut avoir été consommé/);
});

test('une erreur après un paquet conserve le résultat partiel', async () => {
  let calls = 0;
  const h = packHarness(async () => ++calls === 1 ? response({cards:[card],packs_remaining:2}) : response({error:'Maintenance'},503));
  const run = h.packs.openAllPacks('x'); await flush(); await h.advance(2000); await run;
  assert.equal(calls,2);
  assert.equal(h.results[0].ok,false);
  assert.equal(h.results[0].cards.length,1);
});

test('une limite quotidienne termine immédiatement le lot', async () => {
  let calls = 0;
  const h = packHarness(async () => { calls++; return response({rate_limited:true,rate_limit_daily:true,retry_after:new Date(Date.now()+5000).toISOString()},429); });
  await h.packs.openAllPacks('x');
  assert.equal(calls,1);
  assert.equal(h.results[0].ok,false);
});

test('une limitation temporaire attend la date serveur puis reprend', async () => {
  let calls = 0;
  const h = packHarness(async () => ++calls === 1 ? response({rate_limited:true,retry_after:'2026-10-05T12:00:01Z',packs_remaining:1},429) : response({cards:[card],packs_remaining:0}));
  const run = h.packs.openAllPacks('x'); await flush();
  assert.equal(calls,1); await h.advance(1199); assert.equal(calls,1);
  await h.advance(1); await run;
  assert.equal(calls,2);
  assert.equal(h.results[0].ok,true);
});

test('une attente excessive et des limitations répétées sont bornées', async () => {
  const excessive = packHarness(async () => response({rate_limited:true,retry_after:'2026-10-05T12:10:00Z'},429));
  await excessive.packs.openAllPacks('x');
  assert.equal(excessive.results[0].ok,false);
  let calls = 0;
  const repeated = packHarness(async () => { calls++; return response({rate_limited:true,retry_after:'2026-10-05T12:00:00Z'},429); });
  const run = repeated.packs.openAllPacks('x'); await flush(); await repeated.advance(1500); await run;
  assert.equal(calls,6);
  assert.equal(repeated.results[0].ok,false);
});

test('le verrou empêche les lots concurrents entre onglets', async () => {
  let locked = false, calls = 0;
  const navigator = {locks:{async request(_name,_options,callback) {
    if (locked) return callback(null);
    locked=true;
    try { return await callback({}); } finally { locked=false; }
  }}};
  const first = packHarness(async () => {calls++; return response({cards:[card],packs_remaining:8});},navigator);
  const second = packHarness(async () => {calls++; return response({cards:[card],packs_remaining:8});},navigator);
  const run = first.packs.openAllPacks('a'); await flush();
  await second.packs.openAllPacks('b');
  assert.equal(calls,1);
  assert.match(second.results[0].error,/autre onglet/);
  first.packs.cancelOpenAllPacks('a'); await run;
});

test('un événement dupliqué ne lance pas un nouveau lot', async () => {
  let calls=0;
  const h = packHarness(async () => {calls++; return response({cards:[card],packs_remaining:8});});
  const run=h.packs.openAllPacks('a'); await flush();
  await h.packs.openAllPacks('a');
  assert.equal(h.results.length,0);
  assert.equal(calls,1);
  h.packs.cancelOpenAllPacks('a'); await run;
  assert.equal(h.results.length,1);
});

test('un serveur sans paquets est une fin normale', async () => {
  const h = packHarness(async () => response({packs_remaining:0,error:'Aucun paquet'},400));
  await h.packs.openAllPacks('x');
  assert.equal(h.results[0].ok,true);
  assert.equal(h.results[0].openedPacks,0);
});

test('un POST bloqué expire sans être relancé', async () => {
  let calls=0;
  const h = packHarness((_url,{signal}) => new Promise((_resolve,reject) => {
    calls++; signal.addEventListener('abort',() => reject(new Error('aborted')));
  }));
  const run = h.packs.openAllPacks('x'); await flush(); await h.advance(30000); await run;
  assert.equal(calls,1);
  assert.equal(h.results[0].ok,false);
});

function salesHarness(fetch) {
  const h = harness(['bridge/prices.js']);
  h.window.__wmBridgeFeatures.bridgePrices.create({core:{originalFetch:fetch}});
  const results=[];
  h.window.addEventListener('wm-average-response', e => results.push(e.detail));
  h.send('wm-average-request',{id:'a',requestId:'sales'});
  return {...h,results};
}

test('le résumé de ventes filtre les prix invalides sans fabriquer des zéros', async () => {
  const h = salesHarness(async () => response({summary:{C:{average:null},UR:{average:'120.5'},L:{average:0},SR:{average:-2},unknown:{average:10}}}));
  await flush();
  assert.equal(h.results[0].ok,true);
  assert.equal(JSON.stringify(h.results[0].averages),JSON.stringify({UR:120.5,L:0}));
  assert.equal(h.timers.size,0);
});

test('un résumé absent échoue après trois essais au lieu de cacher une réponse vide 24 h', async () => {
  let calls=0;
  const h = salesHarness(async () => {calls++; return response({});});
  await flush(); await h.advance(1000);
  assert.equal(calls,3);
  assert.equal(h.results[0].ok,false);
  assert.equal(h.timers.size,0);
});

test('HTTP 429 respecte Retry-After sans relancer immédiatement', async () => {
  let calls=0;
  const h = salesHarness(async () => {calls++; return new Response('{}',{status:429,headers:{'Retry-After':'120'}});});
  await flush();
  assert.equal(calls,1);
  assert.equal(h.results[0].rateLimited,true);
  assert.equal(h.results[0].retryAfterMs,120000);
});

test('une limitation des prix suspend aussi les prochaines cartes de la file', async () => {
  const h = loaderHarness();
  h.loader.loadCacheForCards(['a','b','c','d'].map(id => ({...card,id})));
  h.send('wm-average-response',{...h.requests[0],ok:false,rateLimited:true,retryAfterMs:120000});
  assert.equal(h.requests.length,3);
  await h.advance(119999); assert.equal(h.requests.length,3);
  await h.advance(1); assert.equal(h.requests.length,4);
});

test('la collection abandonne après trois erreurs réseau et rend le contrôle à l’interface', async () => {
  let calls=0;
  const h = harness(['bridge/core.js','bridge/collection.js']);
  h.window.fetch=async () => { calls++; throw new Error('offline'); };
  const core=h.window.__wmBridgeFeatures.bridgeCore.create();
  const collection=h.window.__wmBridgeFeatures.bridgeCollection.create({core});
  const results=[];
  h.window.addEventListener('wm-average-tag-cards',e => results.push(e.detail));
  const run=collection.fetchTagCards('x','tag');
  await flush(); await h.advance(1000); await run;
  assert.equal(calls,3);
  assert.equal(results[0].ok,false);
});

test('le chargement collection expire aussi si fetch ne répond pas', async () => {
  const h=harness(['bridge/core.js']);
  h.window.fetch=(_url,{signal}) => new Promise((_resolve,reject) => signal.addEventListener('abort',() => reject(new Error('timeout'))));
  const core=h.window.__wmBridgeFeatures.bridgeCore.create();
  const run=core.fetchJsonRetry('/api/my-collection',{}, {maxAttempts:1,timeoutMs:15000});
  const rejected=assert.rejects(run,/timeout/);
  await flush(); await h.advance(15000); await rejected;
});

// DOM minimal pour tester les interactions du module, sans navigateur ni dépendance.
function documentFixture() {
  class Element extends EventTarget {
    constructor(tag) { super(); this.tagName=tag.toUpperCase(); this.children=[]; this.dataset={}; this.className=''; this.hidden=false; this.disabled=false; this._text=''; }
    get childElementCount() {return this.children.length;}
    get textContent() {return this._text+this.children.map(c => c.textContent).join('');}
    set textContent(v) {this._text=String(v); this.children=[];}
    get classList() {return {
      contains:name => this.className.split(' ').includes(name),
      add:(...names) => {this.className=[...new Set([...this.className.split(' '),...names])].join(' ');},
      toggle:(name,enabled) => {const names=new Set(this.className.split(' ')); enabled ? names.add(name) : names.delete(name); this.className=[...names].join(' ');}
    };}
    get isConnected() {return this.tagName==='BODY' || Boolean(this.parentElement?.isConnected);}
    append(...nodes) {for(const node of nodes) {node.remove(); node.parentElement=this; this.children.push(node);}}
    appendChild(node) {this.append(node); return node;}
    replaceChildren(...nodes) {for(const child of this.children) child.parentElement=null; this.children=[]; this._text=''; this.append(...nodes);}
    remove() {if(this.parentElement) {this.parentElement.children=this.parentElement.children.filter(child => child!==this); this.parentElement=null;}}
    insertAdjacentElement(position,node) {
      if(position==='afterend') {node.remove(); const parent=this.parentElement; node.parentElement=parent; parent.children.splice(parent.children.indexOf(this)+1,0,node);}
    }
    setAttribute(name,value) {this[name]=value;}
    click() {if(!this.disabled) this.dispatchEvent(new Event('click'));}
    querySelectorAll(selector) {
      const match=node => selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1))
        : selector.startsWith('[data-role=') ? node.dataset.role===selector.match(/"(.*?)"/)[1]
        : node.tagName===selector.toUpperCase();
      return this.children.flatMap(child => [...(match(child)?[child]:[]),...child.querySelectorAll(selector)]);
    }
    querySelector(selector) {return this.querySelectorAll(selector)[0] || null;}
  }
  const document=new EventTarget();
  document.body=new Element('body');
  document.createElement=tag => new Element(tag);
  document.createTextNode=text => {const node=new Element('#text'); node.textContent=text; return node;};
  document.createDocumentFragment=() => new Element('#fragment');
  document.querySelectorAll=selector => document.body.querySelectorAll(selector);
  document.getElementById=id => {
    const visit=node => node.id===id ? node : node.children.map(visit).find(Boolean);
    return visit(document.body) || null;
  };
  const header=new Element('header'), h1=new Element('h1'), subtitle=new Element('p');
  h1.textContent='Ouvrir un paquet'; subtitle.textContent='Découvrez 5 cartes';
  header.append(h1,subtitle); document.body.append(header);
  return document;
}
function storageFixture() {
  const data=new Map();
  return {getItem:key => data.get(key) ?? null, setItem:(key,value) => data.set(key,String(value)), removeItem:key => data.delete(key)};
}
function packsUiHarness({ savedRecap = null } = {}) {
  const document=documentFixture(), localStorage=storageFixture(), sessionStorage=storageFixture();
  if (savedRecap) sessionStorage.setItem('wm_pack_batch_recap_v1', JSON.stringify(savedRecap));
  const h=harness(['features/core.js','features/price-ui.js','features/packs.js'], {
    document, localStorage, sessionStorage, location:{pathname:'/pulls',reload() {}}
  });
  const registry=h.window.__wmAverageFeatures;
  const core=registry.core.create(); core.isLastPullCardVisible=() => false;
  const recorded=[], requests=[], cancellations=[];
  const runtime={core,settings:{isEnabled:() => true},pullStats:{recordPullStats:cards => recorded.push(cards)},priceLoader:{loadCacheForCards() {}},modalUi:{showInfoModal() {}}};
  runtime.priceUi=registry.priceUi.create(runtime);
  runtime.packs=registry.packs.create(runtime);
  runtime.packs.ensurePullsToolbar();
  h.window.addEventListener('wm-average-open-all-packs',e => requests.push(e.detail));
  h.window.addEventListener('wm-average-cancel-open-all-packs',e => cancellations.push(e.detail));
  return {...h, document, localStorage, sessionStorage, runtime, recorded, requests, cancellations,
    button:text => document.querySelectorAll('button').find(button => button.textContent===text)};
}

test('double clic sur Tout ouvrir : une seule confirmation, puis une seule requête', async () => {
  const h=packsUiHarness();
  h.button('Tout ouvrir').click(); h.button('Tout ouvrir').click();
  assert.equal(h.document.querySelectorAll('.wm-confirm-modal').length,1);
  assert.equal(h.requests.length,0);
  h.document.querySelectorAll('.wm-confirm-modal')[0].querySelectorAll('button').find(button => button.textContent==='Tout ouvrir').click();
  await flush();
  assert.equal(h.requests.length,1);
});

test('la progression du lot garde le total pendant les attentes et ne double ni stats ni exemplaires', async () => {
  const h=packsUiHarness();
  h.runtime.core.storageSet({[h.runtime.core.ALL_COLLECTION_KEY]:{fetchedAt:123,cards:[{...card,count:4}]}});
  h.button('Tout ouvrir').click();
  h.document.querySelectorAll('.wm-confirm-modal')[0].querySelectorAll('button').find(button => button.textContent==='Tout ouvrir').click(); await flush();
  const requestId=h.requests[0].requestId;
  const detail={requestId,openedPacks:1,cards:[card],packsRemaining:4};
  h.send('wm-average-open-all-packs-progress',detail);
  h.send('wm-average-open-all-packs-progress',detail);
  assert.equal(h.recorded.length,1);
  const stored=JSON.parse(h.localStorage.getItem(h.runtime.core.ALL_COLLECTION_KEY));
  assert.equal(stored.cards[0].count,5);
  assert.equal(stored.fetchedAt,123);
  const counter=h.document.querySelectorAll('.wm-open-all-progress')[0];
  assert.equal(counter.textContent,'1/5 ouverts');
  assert.equal(counter.hidden,false);
  h.send('wm-average-open-all-packs-progress',{requestId,openedPacks:3,packsRemaining:2,waiting:true,waitMs:1500});
  assert.equal(counter.textContent,'3/5 ouverts');
  h.send('wm-average-open-all-packs-progress',{requestId,openedPacks:3,packsRemaining:null,waiting:true,waitMs:1500});
  assert.equal(counter.textContent,'3/5 ouverts');
  assert.equal(h.button('Ouverture…').disabled,true);
  assert.equal(h.cancellations.length,0);
  h.send('wm-average-open-all-packs-result',{...detail,ok:true});
  assert.equal(counter.hidden,true);
  assert.equal(h.button('Tout ouvrir').disabled,false);
  assert.ok(h.document.getElementById('wm-open-all-overlay'));
});

test('la désactivation automatique arrête le lot et garde son récap sans doubler les cartes', async () => {
  const h=packsUiHarness();
  h.runtime.core.writeLocalValue(h.runtime.core.AUTO_OPEN_MIN_MINUTES_KEY,1);
  h.runtime.core.writeLocalValue(h.runtime.core.AUTO_OPEN_MAX_MINUTES_KEY,1);
  const toggle=h.document.querySelectorAll('input')[1];
  toggle.checked=true; toggle.dispatchEvent(new Event('change'));
  await h.advance(60000);
  assert.equal(h.requests.length,1);
  const detail={requestId:h.requests[0].requestId,openedPacks:1,cards:[card],packsRemaining:8};
  h.send('wm-average-open-all-packs-progress',detail);
  toggle.checked=false; toggle.dispatchEvent(new Event('change'));
  assert.equal(h.cancellations.length,1);
  h.send('wm-average-open-all-packs-result',{...detail,ok:true,cancelled:true});
  const session=JSON.parse(h.localStorage.getItem(h.runtime.core.AUTO_OPEN_SESSION_KEY));
  assert.equal(session.cards.length,1);
  assert.equal(session.openedPacks,1);
  assert.equal(session.runs,1);
  assert.match(h.document.getElementById('wm-open-all-overlay').textContent,/Récap ouverture automatique/);
  await h.advance(60000);
  assert.equal(h.requests.length,1);
});

test('le récap natif évite de recréer le DOM quand les prix n’ont pas changé', () => {
  const document=documentFixture();
  const fresh=harness(['features/core.js','features/price-ui.js','features/packs.js'], {document,localStorage:storageFixture(),sessionStorage:storageFixture(),location:{pathname:'/pulls'}});
  const registry=fresh.window.__wmAverageFeatures, core=registry.core.create();
  core.isLastPullCardVisible=() => true;
  const runtime={core,settings:{isEnabled:() => true},pullStats:{recordPullStats() {}},priceLoader:{loadCacheForCards() {}}};
  runtime.priceUi=registry.priceUi.create(runtime); runtime.packs=registry.packs.create(runtime);
  fresh.send('wm-average-pack-opened',{cards:[card]});
  const panel=document.getElementById('wm-pack-recap'), children=panel.children;
  runtime.packs.renderPackRecap();
  assert.equal(panel.children,children);
});

test('la navigation entre annonces recharge le bon prix et ignore une ancienne réponse', () => {
  const a='00000000-0000-0000-0000-000000000001', b='00000000-0000-0000-0000-000000000002';
  const h=priceHarness({document:{querySelectorAll:() => [],getElementById:() => null},location:{pathname:'/marketplace/'+a}});
  const loaded=[], requested=[];
  h.runtime.priceLoader={loadCacheForCards:cards => loaded.push(cards[0].id)};
  h.window.addEventListener('wm-average-load-marketplace-detail',e => requested.push(e.detail.auctionId));
  h.send('wm-average-marketplace-detail',{auctionId:a,card:{...card,id:'card-a'}});
  h.context.location.pathname='/marketplace/'+b;
  h.runtime.priceUi.renderMarketplaceCurrent();
  assert.deepEqual(requested,[b]);
  h.send('wm-average-marketplace-detail',{auctionId:a,card:{...card,id:'card-a'}});
  assert.deepEqual(loaded,['card-a']);
  h.send('wm-average-marketplace-detail',{auctionId:b,card:{...card,id:'card-b'}});
  assert.deepEqual(loaded,['card-a','card-b']);
});

test('les ouvertures natives utilisent aussi le verrou des lots', async () => {
  let calls=0;
  const h=harness(['bridge/core.js','bridge/packs.js','bridge/intercept.js'], {
    navigator:{locks:{request:(_name,_opts,callback) => Promise.resolve().then(() => callback(null))}}
  });
  h.window.fetch=async () => {calls++; return response({cards:[]});};
  const registry=h.window.__wmBridgeFeatures, core=registry.bridgeCore.create();
  const runtime={core}; runtime.packs=registry.bridgePacks.create(runtime);
  registry.bridgeIntercept.create(runtime);
  await assert.rejects(h.window.fetch('/api/packs/open',{method:'POST'}),/autre onglet/);
  assert.equal(calls,0);
  await h.window.fetch('/api/my-collection');
  assert.equal(calls,1);
});


test('la barre des paquets masque le compteur au repos et n’offre ni arrêt ni ancien récap', () => {
  const h=packsUiHarness({savedRecap:{cards:[card],openedPacks:1}});
  assert.equal(h.button('Arrêter'),undefined);
  assert.equal(h.button('Revoir le dernier récap'),undefined);
  assert.equal(h.document.querySelectorAll('.wm-open-all-progress')[0].hidden,true);
});
