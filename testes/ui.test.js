// Testes de js/ui/ui.js (COBRA.UI) que não dependem de layout: a lista de
// recordes do menu, a tela de fim e o HUD. O DOM é falso e mínimo — só o que
// o ui.js toca (getElementById, createElement, classList, appendChild...).
// Rodar na pasta do projeto com:  node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { criarAmbiente } = require('./ambiente.js');

function elemento(nome) {
  const classes = new Set();
  return {
    nome,
    children: [],
    textContent: '',
    style: {},
    offsetWidth: 0,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, f) => (f ? classes.add(c) : classes.delete(c)),
    },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children.splice(this.children.indexOf(c), 1); return c; },
    get firstChild() { return this.children[0] || null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    getAttribute() { return null; },
  };
}

function ambiente() {
  const els = {};
  const document = {
    getElementById: (id) => (els[id] ||= elemento(id)),
    createElement: (tag) => elemento(tag),
  };
  const amb = criarAmbiente({
    modulos: ['js/core/util.js', 'js/game/config.js'],
    extras: { document, setTimeout: () => 1, clearTimeout: () => {} },
  });
  // ui.js não está na lista do ambiente (ele precisa do DOM falso acima).
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js/ui/ui.js'), 'utf8'),
    amb.global, { filename: 'js/ui/ui.js' });
  return { ...amb, UI: amb.COBRA.UI, els };
}

const linhas = (el) => el.children.map((li) => li.textContent);

test('recordes: o nome do modo vem do modoId, não do texto gravado', () => {
  const amb = ambiente();
  const { COBRA, UI, els } = amb;
  COBRA.Util.store.set(COBRA.CFG.STORAGE_KEY, [
    { pontos: 900, modo: 'TEXTO QUALQUER', modoId: 'caos', data: '19/09/2026' },
    { pontos: 500, modo: 'OUTRO', modoId: 'zen', data: '18/09/2026' },
  ]);
  UI.init();
  assert.deepEqual(linhas(els.scorelist), ['1. 900  CAÔS  19/09', '2. 500  ZEN  18/09']);
  assert.equal(els['menu-best'].textContent, 'RECORDE: 900');
});

test('recordes antigos, sem modoId, ainda mostram o nome gravado', () => {
  const amb = ambiente();
  const { COBRA, UI, els } = amb;
  COBRA.Util.store.set(COBRA.CFG.STORAGE_KEY, [
    { pontos: 40, modo: 'CLÁSSICO', data: '01/08/2026' },
    { pontos: 'lixo', modo: 'X' },          // registro editado à mão: ignorado
  ]);
  UI.init();
  assert.deepEqual(linhas(els.scorelist), ['1. 40  CLÁSSICO  01/08']);
});

test('tela de fim: manchete pela causa, estatísticas e NOVO RECORDE', () => {
  const amb = ambiente();
  const { UI, els } = amb;
  UI.init();
  UI.showGameOver({ cause: 'corpo', score: 120, maxLen: 9, maxCombo: 4, sector: 1, timeMs: 67000 }, true);
  assert.equal(els['over-title'].textContent, 'VOCÊ SE MORDEU, GÊNIO');
  assert.equal(els['over-record'].classList.contains('hide'), false);
  const dl = els['over-stats'].children.map((c) => String(c.textContent));
  assert.deepEqual(dl, ['PONTOS', '120', 'TAMANHO MÁXIMO', '9', 'COMBO MÁXIMO', '4',
                        'SETOR ALCANÇADO', '02', 'TEMPO', '1:07']);
  UI.showGameOver({ cause: '???' }, false);
  assert.equal(els['over-title'].textContent, 'CONEXÃO PERDIDA');
  assert.equal(els['over-record'].classList.contains('hide'), true);
});

// Decisão de design registrada no CLAUDE.md: o RECORDE do HUD mostra
// Game.best, que só muda quando a partida acaba (saveRecord).
test('HUD: pontos, recorde, setor, tamanho e multiplicador do combo', () => {
  const amb = ambiente();
  const { UI, els } = amb;
  UI.init();
  const jogo = {
    score: 350, best: 200, sector: 2, combo: 3, comboMs: 1250, mult: 2.5,
    snake: { cells: new Array(7) }, power: { ghost: 0, magnet: 0, slow: 0, fury: 0, shield: false },
  };
  UI.syncHUD(jogo);
  assert.equal(String(els['hud-score'].textContent), '350');
  assert.equal(String(els['hud-best'].textContent), '200', 'recorde do HUD não segue a pontuação ao vivo');
  assert.equal(els['hud-sector'].textContent, '03');
  assert.equal(String(els['hud-len'].textContent), '7');
  assert.equal(els['combo-mult'].textContent, 'x2.5');
  assert.equal(els['combo-bar'].style.width, '50%');
});
