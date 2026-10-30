// Offline UI/config checks; no DOM dependency, network, or shared globals.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const publicURL = new URL('../public/', import.meta.url);
const CONFIG_KEY = 'claimers-config-aero-v1-incentives-only';

function storage(seed = {}) {
  const entries = new Map(Object.entries(seed));
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
  };
}

function fakeDOM(html) {
  const elements = new Map();
  const make = (value = '') => ({
    value, checked: false, textContent: '', style: {}, attributes: {}, listeners: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(event, handler) { (this.listeners[event] ??= []).push(handler); },
    click() {}, scrollIntoView() {},
  });
  for (const match of html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = make(match[2].match(/\bvalue="([^"]*)"/)?.[1] ?? '');
    element.checked = /\bchecked\b/.test(match[2]);
    elements.set(match[3], element);
  }
  elements.get('chain').value = 'base';
  const radios = ['scan', 'csv'].map((value) => make(value));
  radios[0].checked = true;
  return {
    elements, radios,
    getElementById: (id) => elements.get(id) ?? null,
    querySelector(selector) {
      if (selector === 'input[name=claimerSource]:checked') return radios.find((r) => r.checked);
      return radios.find((r) => selector.includes(`[value=${r.value}]`)) ?? null;
    },
    querySelectorAll(selector) {
      return selector === 'input[name=claimerSource]' ? radios : [...elements.values(), ...radios];
    },
  };
}

async function loadUI(localStorage) {
  const html = await readFile(new URL('index.html', publicURL), 'utf8');
  const main = await readFile(new URL('js/main.js', publicURL), 'utf8');
  const storeSource = await readFile(new URL('js/store.js', publicURL), 'utf8');
  const storeContext = vm.createContext({ localStorage });
  vm.runInContext(storeSource.replace(/^export /gm, ''), storeContext);
  const document = fakeDOM(html);
  const context = vm.createContext({
    document, store: storeContext, lower: (s) => s.toLowerCase(), AbortController,
    console, Client: class { async blockNumber() { return 53275371n; } },
    topicPoolCreated: 'offline-topic',
  });
  // Run the actual UI code, substituting only module dependencies. No RPC code loads.
  vm.runInContext(main.replace(/^import .*;\r?$/gm, ''), context);
  return { context, document, html, main };
}

export async function runUIConfigTests() {
  const source = await readFile(new URL('js/store.js', publicURL), 'utf8');
  const localStorage = storage({
    'claimers-config-v1': JSON.stringify({ token: 'obsolete TEA', voter: 'obsolete voter' }),
    'claimers-config-aero-v1': JSON.stringify({ token: 'obsolete mixed-fee config' }),
  });
  const context = vm.createContext({ localStorage });
  vm.runInContext(source.replace(/^export /gm, ''), context);
  assert.equal(context.loadFormConfig(), null, 'obsolete saved configs must be ignored');
  context.saveFormConfig({ programScanStart: '53171524', symbol: 'RSGP' });
  assert.equal(JSON.parse(localStorage.getItem(CONFIG_KEY)).programScanStart, '53171524');
  assert.equal(context.loadFormConfig().symbol, 'RSGP');
  localStorage.setItem(CONFIG_KEY, '{invalid');
  assert.equal(context.loadFormConfig(), null, 'malformed saved config is ignored');
  console.log('PASS UI config persistence namespace and round trip');

  const uiStorage = storage({ 'claimers-config-v1': JSON.stringify({ token: 'obsolete TEA' }) });
  const { context: ui, document, html, main } = await loadUI(uiStorage);
  const field = (id) => document.getElementById(id);
  const expected = {
    token: '0x44b63af715d5ef02cc3646a6ce96875e11d69e85', symbol: 'RSGP', decimals: '18',
    votingReward: '0x4ad4efa871b9a9d943cd69fd779c4d0230eb021f',
    pools: '0x8e859b6cf564c4ac2b848693c85c496e81dbf6c8',
    factory: '0x9cb220581b91b0c83223012fe69688b92ad07a76',
    startBlock: '53171524', endBlock: '53275371', stepBlocks: '3600', minClaimed: '1000',
    logsRpc: 'https://base-rpc.publicnode.com', archiveRpc: 'https://mainnet.base.org',
  };
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(String(field(key).value), value, `Base preset ${key}`);
  }
  // HTML input values coerce assigned numbers to strings in a real browser.
  for (const element of document.elements.values()) element.value = String(element.value);
  const config = ui.buildConfig();
  assert.equal(config.chain, 'base', 'normalized config carries selected chain label');
  for (const removed of ['voter', 'claimEventSig']) {
    assert.equal(field(removed), null, `${removed} HTML field removed`);
    assert.equal(removed in config, false, `${removed} config removed`);
    assert.equal(removed in ui.readForm(), false, `${removed} persistence wiring removed`);
  }
  console.log('PASS UI Base RSGP preset and removed legacy fields');

  assert.ok(field('programScanStart'), 'programScanStart field must exist');
  assert.equal(field('programScanStart').value, '53171524', 'preset program scan start');
  assert.equal(ui.buildConfig().programScanStart, 53171524n);
  field('programScanStart').value = '   ';
  assert.equal(ui.buildConfig().programScanStart, ui.buildConfig().startBlock, 'blank defaults to startBlock');
  field('programScanStart').value = '53,000,000';
  assert.equal(ui.buildConfig().programScanStart, 53000000n, 'explicit earlier program scan start');
  field('programScanStart').value = '0';
  assert.equal(ui.buildConfig().programScanStart, 0n, 'explicit zero is preserved');
  for (const invalid of ['-1', '1.5', 'nope', '53275372']) {
    field('programScanStart').value = invalid;
    assert.throws(() => ui.buildConfig(), /Program scan start block/, `reject ${invalid}`);
    assert.equal(field('programScanStart').attributes['aria-invalid'], 'true');
  }
  field('programScanStart').value = '';
  ui.buildConfig();
  assert.equal(field('programScanStart').attributes['aria-invalid'], 'false', 'clearing invalid input resets validation');
  field('programScanStart').value = '53000000';
  for (const handler of field('programScanStart').listeners.change) handler();
  assert.equal(JSON.parse(uiStorage.getItem(CONFIG_KEY)).programScanStart, '53000000', 'change handler persists field');
  const restored = await loadUI(uiStorage);
  assert.equal(restored.document.getElementById('programScanStart').value, '53000000', 'saved field restored');
  assert.equal(restored.context.buildConfig().programScanStart, 53000000n);
  console.log('PASS UI program scan start default, validation, wiring and reload');

  assert.match(html, /for="votingReward">VotingRewardsManager/);
  assert.match(html, /Aero MetaDEX03/);
  assert.match(html, /Aero CLFactory/);
  assert.match(html, /Scan claim events onchain/);
  assert.match(html, /ClaimIncentives/);
  assert.match(html, /ClaimFees[^<]*excluded/);
  assert.match(html, /CSV[^<]*incentive-only[^<]*fixed-total/i);
  assert.doesNotMatch(html + main + source, /on-chain|Bribe \/ VotingReward|v2 or|placeholder="TEA"/i);
  field('votingReward').value = 'invalid';
  assert.throws(() => ui.buildConfig(), /VotingRewardsManager must/);
  field('votingReward').value = expected.votingReward;
  ui.discoverPools = async () => [{ address: expected.pools, token0: expected.token, tickSpacing: -100 }];
  await ui.discover();
  assert.match(field('pools-note').textContent, /tickSpacing -100/);
  assert.doesNotMatch(field('pools-note').textContent, /stable/);
  assert.ok(document.radios.some((r) => r.value === 'csv'), 'reference CSV source remains');
  console.log('PASS UI incentive-only labels and CL discovery tickSpacing');
}
