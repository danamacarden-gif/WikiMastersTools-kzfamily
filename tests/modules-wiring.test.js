const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function bootstrapPaths() {
  const match = read('bootstrap.js').match(/const paths = \[([\s\S]*?)\];/);
  assert.ok(match, 'liste « paths » introuvable dans bootstrap.js');
  return [...match[1].matchAll(/'([^']+\.js)'/g)].map((m) => m[1]);
}

function manifestResources() {
  const manifest = JSON.parse(read('manifest.json'));
  return new Set(manifest.web_accessible_resources.flatMap((entry) => entry.resources));
}

test('chaque script chargé par bootstrap.js existe sur le disque', () => {
  for (const file of bootstrapPaths()) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} est chargé mais absent`);
  }
});

test('chaque script chargé par bootstrap.js est déclaré dans le manifest', () => {
  const resources = manifestResources();
  for (const file of bootstrapPaths()) {
    assert.ok(resources.has(file), `${file} manque dans web_accessible_resources`);
  }
});

test('family-logic.js est chargé avant theme-tracker.js', () => {
  const paths = bootstrapPaths();
  const logic = paths.indexOf('features/family-logic.js');
  const tracker = paths.indexOf('features/theme-tracker.js');

  assert.ok(logic >= 0, 'family-logic.js absent de bootstrap.js');
  assert.ok(logic < tracker, 'family-logic.js doit précéder theme-tracker.js');
});

test('content.js exige et instancie familyLogic avant themeTracker', () => {
  const content = read('content.js');
  const required = content.indexOf("'familyLogic'");
  const requiredTracker = content.indexOf("'themeTracker'");
  const created = content.indexOf('runtime.familyLogic = featureRegistry.familyLogic.create()');
  const createdTracker = content.indexOf('runtime.themeTracker = featureRegistry.themeTracker.create');

  assert.ok(required >= 0 && required < requiredTracker, 'familyLogic doit être dans requiredFeatures');
  assert.ok(created >= 0 && created < createdTracker, 'familyLogic doit être créé avant themeTracker');
});

test('content.js crée myBidsLogic avant themeTracker (la modale de mise s\'en sert)', () => {
  const content = read('content.js');
  const logic = content.indexOf('runtime.myBidsLogic = featureRegistry.myBidsLogic.create()');
  const tracker = content.indexOf('runtime.themeTracker = featureRegistry.themeTracker.create');

  assert.ok(logic >= 0 && logic < tracker, 'myBidsLogic doit être créé avant themeTracker');
});

test('chaque module des features est enregistré sous un nom exigé par content.js', () => {
  const content = read('content.js');
  const required = new Set(
    [...content.match(/requiredFeatures = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  );

  for (const file of bootstrapPaths().filter((f) => f.startsWith('features/'))) {
    const source = read(file);
    const names = [...source.matchAll(/registry\.(\w+)\s*=/g)].map((m) => m[1]);
    assert.ok(names.length > 0, `${file} n'enregistre aucun module`);
    for (const name of names) {
      assert.ok(required.has(name), `${file} enregistre « ${name} » absent de requiredFeatures`);
    }
  }
});

test('les prix des cartes de famille sont câblés : price-ui notifie themeTracker, créé après les prix', () => {
  const content = read('content.js');
  const loader = content.indexOf('runtime.priceLoader = featureRegistry.priceLoader.create');
  const ui = content.indexOf('runtime.priceUi = featureRegistry.priceUi.create');
  const tracker = content.indexOf('runtime.themeTracker = featureRegistry.themeTracker.create');

  assert.ok(ui >= 0 && loader >= 0 && tracker > ui && tracker > loader, 'priceUi et priceLoader doivent précéder themeTracker');
  assert.match(read('features/price-ui.js'), /runtime\.themeTracker\?\.renderCardPrice\?\.\(id\)/);
  assert.match(read('features/theme-tracker.js'), /return \{\s*render,\s*isThemePage,\s*renderCardPrice\s*\}/);
});
