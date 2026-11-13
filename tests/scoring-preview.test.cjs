// Real Chrome regression; deterministic hands, real scoring and timers. No game publication.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/Users/hellmeet/.hermes/cache/scratch/alatkilat-qa/node_modules/playwright');

async function scoreScenario(t, { cards, jokers = [], ante = 1, blindIndex = 0, expected, levels = {} }) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'));
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/' ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(req.url === '/' ? html : 'not found');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(({ cards, jokers, ante, blindIndex, levels }) => {
      AudioEngine.enabled = false;
      initHandLevels();
      for (const [name, upgrade] of Object.entries(levels)) State.handLevels[name] = upgrade;
      State.ante = ante;
      State.blindIndex = blindIndex;
      State.currentScore = 0;
      State.handsLeft = 4;
      State.isEvaluating = false;
      const deck = createDeck();
      State.hand = cards.map(([rank, suit]) => deck.find(c => c.rank === rank && c.suit === suit));
      State.deck = deck.filter(c => !State.hand.includes(c));
      State.jokers = jokers.map(id => JOKER_CATALOG.find(j => j.id === id));
      State.selectedCardIds = [];
      renderJokers();
      renderCards();
      updateHUD();
      updateSelectedHandPreview();
    }, { cards, jokers, ante, blindIndex, levels });
    // Select using actual card handlers, not a replacement scoring implementation.
    for (const id of await page.evaluate(() => State.hand.map(c => c.id))) {
      await page.locator(`.playing-card[data-id="${id}"]`).click();
    }
    const preview = await page.locator('#calcTotal').textContent();
    const previewChips = await page.locator('#calcChips').textContent();
    const previewMult = await page.locator('#calcMult').textContent();
    await page.locator('#playBtn').click();
    await page.waitForFunction(() => State.currentScore > 0, { timeout: 15000 });
    const actual = await page.evaluate(() => State.currentScore);
    const actualChips = await page.locator('#calcChips').textContent();
    const actualMult = await page.locator('#calcMult').textContent();
    const expectedLabel = await page.evaluate(n => n.toLocaleString() + ' PTS', expected);
    t.diagnostic(JSON.stringify({ preview, previewChips, previewMult, actual, actualChips, actualMult, expected, errors }));
    assert.equal(actual, expected, 'Existing animated score must retain its arithmetic');
    assert.equal(preview, expectedLabel, 'Selection preview must match the score awarded by Play');
    assert.equal(previewChips, actualChips, 'Preview chips must match awarded chips');
    assert.equal(previewMult, actualMult, 'Preview mult must match awarded mult');
    await page.waitForFunction(() => !State.isEvaluating);
    assert.equal(await page.locator('#calcTotal').textContent(), '0 PTS', 'Preview resets after played cards are removed');
    assert.deepEqual(errors, [], 'No uncaught browser errors');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'No mobile horizontal overflow');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

test('Boss Clubs penalty and per-card/end jokers agree with preview', t => scoreScenario(t, {
  cards: [[13, 'C']], jokers: ['scary_face', 'baron', 'polychrome'], blindIndex: 2, expected: 560
}));

// Characterization cases protect existing rules, including inventory order and flooring.
const cases = [
  ['Pair additive jokers', { cards: [[8, 'S'], [8, 'H']], jokers: ['neon_joker', 'chip_stack', 'high_roller', 'bullseye'], expected: 2184 }],
  ['Poly Chrome before additive mult', { cards: [[8, 'S'], [8, 'H']], jokers: ['polychrome', 'neon_joker'], expected: 182 }],
  ['Poly Chrome after additive mult', { cards: [[8, 'S'], [8, 'H']], jokers: ['neon_joker', 'polychrome'], expected: 234 }],
  ['Flush Prism and Poly Chrome', { cards: [[2, 'H'], [4, 'H'], [6, 'H'], [8, 'H'], [10, 'H']], jokers: ['prism_flush', 'polychrome'], expected: 780 }],
  ['Planet-upgraded Pair', { cards: [[8, 'S'], [8, 'H']], jokers: ['bullseye'], levels: { 'One Pair': { bonusChips: 15, bonusMult: 1 } }, expected: 451 }],
  ['Boss Clubs chip penalty only', { cards: [[13, 'C']], blindIndex: 2, expected: 5 }],
  ['Clubs outside boss', { cards: [[13, 'C']], expected: 15 }],
  ['Different boss does not penalize Clubs', { cards: [[13, 'C']], ante: 2, blindIndex: 2, expected: 15 }],
  ['King face and Baron effects', { cards: [[13, 'D']], jokers: ['scary_face', 'baron'], expected: 495 }],
  ['Ace not treated as a face card', { cards: [[14, 'S']], jokers: ['scary_face', 'baron', 'prism_flush', 'bullseye'], expected: 16 }],
  ['Non-scoring jokers leave points unchanged', { cards: [[9, 'D']], jokers: ['overclock', 'recycler', 'gold_ingot'], expected: 14 }],
];
for (const [suit, joker] of [['S', 'spade_wrath'], ['H', 'heart_lust'], ['D', 'dia_greed'], ['C', 'club_glutton']]) {
  cases.push([`${suit} suit joker`, { cards: [[9, suit]], jokers: [joker], expected: 56 }]);
}
for (const [name, scenario] of cases) test(name, t => scoreScenario(t, scenario));
