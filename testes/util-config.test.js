// Testes de js/core/util.js (COBRA.Util) e js/game/config.js (COBRA.CFG).
// Rodar na pasta do projeto com:  node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { criarAmbiente } = require('./ambiente.js');

const soUtilConfig = () =>
  criarAmbiente({ modulos: ['js/core/util.js', 'js/game/config.js'] });

// Objetos que vêm do contexto do vm têm outro Array.prototype; comparar a
// forma em JSON evita falso negativo do deepStrictEqual.
const simples = (v) => JSON.parse(JSON.stringify(v));

/* ---------------------------------------------------------------- Util */

test('Util: clamp, lerp, invLerp, remap e wrap', () => {
  const { COBRA: { Util: U } } = soUtilConfig();
  assert.equal(U.clamp(5, 0, 3), 3);
  assert.equal(U.clamp(-1, 0, 3), 0);
  assert.equal(U.clamp(2, 0, 3), 2);
  assert.equal(U.lerp(10, 20, 0.25), 12.5);
  assert.equal(U.invLerp(10, 20, 15), 0.5);
  assert.equal(U.invLerp(4, 4, 99), 0, 'intervalo vazio não divide por zero');
  assert.equal(U.remap(5, 0, 10, 100, 200), 150);
  assert.equal(U.wrap(-1, 30), 29);
  assert.equal(U.wrap(30, 30), 0);
  assert.equal(U.wrap(31, 30), 1);
});

test('Util: curvas começam em 0 e terminam em 1', () => {
  const { COBRA: { Util: U } } = soUtilConfig();
  for (const nome of ['easeOutCubic', 'easeInCubic', 'easeOutBack', 'easeOutElastic', 'easeInOutSine']) {
    assert.ok(Math.abs(U[nome](0)) < 1e-9, nome + '(0)');
    assert.ok(Math.abs(U[nome](1) - 1) < 1e-9, nome + '(1)');
  }
});

test('Util: randInt é inclusivo nos dois extremos', () => {
  const amb = soUtilConfig();
  const U = amb.COBRA.Util;
  amb.fixarAleatorio(0);
  assert.equal(U.randInt(3, 7), 3);
  amb.fixarAleatorio(0.999999);
  assert.equal(U.randInt(3, 7), 7);
  amb.fixarAleatorio(0.5);
  assert.equal(U.pick(['a', 'b', 'c']), 'b');
  assert.equal(U.pick([]), null);
  assert.equal(U.chance(0.6), true);
  assert.equal(U.chance(0.4), false);
});

test('Util: shuffle mantém os mesmos elementos', () => {
  const { COBRA: { Util: U } } = soUtilConfig();
  const arr = [1, 2, 3, 4, 5, 6, 7, 8];
  U.shuffle(arr);
  assert.deepEqual([...arr].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('Util: formatTime, pad2, key, hsla e rgba', () => {
  const { COBRA: { Util: U } } = soUtilConfig();
  assert.equal(U.formatTime(67000), '1:07');
  assert.equal(U.formatTime(0), '0:00');
  assert.equal(U.formatTime(-500), '0:00');
  assert.equal(U.formatTime(5000 * 1000), '83:20', 'sem horas: minutos passam de 60');
  assert.equal(U.pad2(3), '03');
  assert.equal(U.pad2(12), '12');
  assert.equal(U.key(4, 7), '4,7');
  assert.equal(U.hsla(185, 100, 55, 1), 'hsla(185,100%,55%,1)');
  assert.equal(U.rgba('#ff2d95', 0.5), 'rgba(255,45,149,0.5)');
  assert.equal(U.rgba('#fff', 1), 'rgba(255,255,255,1)');
  assert.equal(U.manhattan(0, 0, 3, -4), 7);
});

test('Util: direções são congeladas e isOpposite/dirEqual comparam valor', () => {
  const { COBRA: { Util: U } } = soUtilConfig();
  const D = U.DIRS;
  assert.ok(Object.isFrozen(D) && Object.isFrozen(D.UP));
  assert.equal(U.isOpposite(D.UP, D.DOWN), true);
  assert.equal(U.isOpposite(D.LEFT, D.RIGHT), true);
  assert.equal(U.isOpposite(D.UP, D.LEFT), false);
  assert.equal(U.isOpposite(D.UP, null), false);
  assert.equal(U.dirEqual(D.UP, { x: 0, y: -1 }), true);
  assert.equal(U.dirEqual(D.UP, D.DOWN), false);
});

test('Util.store: sem localStorage guarda na memória da sessão', () => {
  const { COBRA: { Util: U } } = soUtilConfig();
  assert.equal(U.store.available(), false);
  assert.equal(U.store.get('x', 'padrão'), 'padrão');
  assert.equal(U.store.set('x', { a: 1 }), false, 'não persistiu de verdade');
  assert.deepEqual(simples(U.store.get('x', null)), { a: 1 });
  U.store.remove('x');
  assert.equal(U.store.get('x', 7), 7);
});

test('Util.store: localStorage que lança exceção não derruba nada', () => {
  const bloqueado = {
    setItem() { throw new Error('SecurityError'); },
    getItem() { throw new Error('SecurityError'); },
    removeItem() { throw new Error('SecurityError'); },
  };
  const { COBRA: { Util: U } } = criarAmbiente({
    modulos: ['js/core/util.js'], localStorage: bloqueado,
  });
  assert.equal(U.store.available(), false);
  U.store.set('k', 5);
  assert.equal(U.store.get('k', 0), 5);
});

test('Util.store: grava no localStorage de verdade e ignora JSON corrompido', () => {
  const dados = {};
  const ls = {
    setItem(k, v) { dados[k] = String(v); },
    getItem(k) { return Object.prototype.hasOwnProperty.call(dados, k) ? dados[k] : null; },
    removeItem(k) { delete dados[k]; },
  };
  const { COBRA: { Util: U } } = criarAmbiente({ modulos: ['js/core/util.js'], localStorage: ls });
  assert.equal(U.store.available(), true);
  assert.equal(U.store.set('r', [1, 2]), true);
  assert.equal(dados.r, '[1,2]');
  dados.quebrado = '{nao é json';
  assert.equal(U.store.get('quebrado', 'fallback'), 'fallback');
  assert.equal(U.store.get('nulo', 'fallback'), 'fallback');
});

/* ----------------------------------------------------------------- CFG */

test('CFG: grade e canvas batem entre si', () => {
  const { COBRA: { CFG } } = soUtilConfig();
  assert.equal(CFG.GRID_W * CFG.CELL, CFG.W);
  assert.equal(CFG.GRID_H * CFG.CELL, CFG.H);
  assert.equal(CFG.HALF, CFG.CELL / 2);
});

test('CFG.tickFor: 130 ms no nível 0, -5 por nível, piso de 58', () => {
  const { COBRA: { CFG } } = soUtilConfig();
  assert.equal(CFG.tickFor(0), 130);
  assert.equal(CFG.tickFor(1), 125);
  assert.equal(CFG.tickFor(14), 60);
  assert.equal(CFG.tickFor(15), 58);
  assert.equal(CFG.tickFor(100), 58);
  assert.equal(CFG.tickFor(0, 105), 105, 'CAÔS usa base 105');
  assert.equal(CFG.tickFor(20, 105), 58);
});

test('CFG.multFor: 1 + combo*0,5, teto x8', () => {
  const { COBRA: { CFG } } = soUtilConfig();
  assert.equal(CFG.multFor(0), 1);
  assert.equal(CFG.multFor(1), 1.5);
  assert.equal(CFG.multFor(3), 2.5);
  assert.equal(CFG.multFor(14), 8);
  assert.equal(CFG.multFor(50), 8);
});

test('CFG: chances das comidas somam 1 e o sorteio respeita as faixas', () => {
  const amb = soUtilConfig();
  const CFG = amb.COBRA.CFG;
  const soma = Object.values(CFG.FOOD).reduce((s, f) => s + f.chance, 0);
  assert.ok(Math.abs(soma - 1) < 1e-9);
  // Roleta na ordem gold (12%) -> crystal (5%) -> normal (83%).
  const casos = [[0, 'gold'], [0.1199, 'gold'], [0.12, 'crystal'], [0.1699, 'crystal'],
                 [0.17, 'normal'], [0.9999, 'normal']];
  for (const [r, esperado] of casos) {
    amb.fixarAleatorio(r);
    assert.equal(CFG.rollFoodType(), esperado, 'random ' + r);
  }
});

test('CFG: tabelas de comida e power-up como o README descreve', () => {
  const { COBRA: { CFG } } = soUtilConfig();
  assert.deepEqual(simples([CFG.FOOD.normal.pts, CFG.FOOD.gold.pts, CFG.FOOD.crystal.pts]), [10, 50, 25]);
  assert.deepEqual(simples([CFG.FOOD.normal.grow, CFG.FOOD.gold.grow, CFG.FOOD.crystal.grow]), [1, 2, 1]);
  assert.deepEqual(simples([CFG.FOOD.normal.ttl, CFG.FOOD.gold.ttl, CFG.FOOD.crystal.ttl]), [0, 6000, 9000]);
  assert.deepEqual(simples(CFG.POWER_IDS), ['ghost', 'magnet', 'slow', 'shield', 'fury']);
  for (const id of CFG.POWER_IDS) assert.ok(CFG.POWER[id], id);
  assert.equal(CFG.POWER.shield.ms, 0, 'escudo dura até levar um golpe');
});

test('CFG.sectorFor: um setor a cada 500 pontos, sem teto', () => {
  const { COBRA: { CFG } } = soUtilConfig();
  assert.equal(CFG.sectorFor(0), 0);
  assert.equal(CFG.sectorFor(499), 0);
  assert.equal(CFG.sectorFor(500), 1);
  assert.equal(CFG.sectorFor(2500), 5);
  assert.equal(CFG.sectorFor(10000), 20);
  assert.equal(CFG.sectorFor(-10), 0);
  assert.equal(CFG.sectorFor(undefined), 0);
});

test('CFG.sectorInfo: 6 setores fixos, depois gerados com teto', () => {
  const { COBRA: { CFG } } = soUtilConfig();
  assert.equal(CFG.sectorInfo(0).nome, 'SETOR 01 :: BOOT');
  assert.equal(CFG.sectorInfo(2).cacadores, 1);
  assert.equal(CFG.sectorInfo(3).portais, true);
  assert.equal(CFG.sectorInfo(5).nome, 'SETOR 06 :: CAOS');
  assert.equal(CFG.sectorInfo(-3), CFG.sectorInfo(0));

  const s6 = CFG.sectorInfo(6);
  assert.equal(s6.nome, 'SETOR 07 :: CAOS');
  assert.equal(s6.gerado, true);
  assert.equal(s6.cacadores, 4);
  assert.ok(Math.abs(s6.densidade - 0.08) < 1e-9);
  assert.equal(CFG.sectorInfo(6), s6, 'cacheado: não aloca objeto novo por chamada');

  assert.equal(CFG.sectorInfo(8).cacadores, 5);
  assert.equal(CFG.sectorInfo(30).cacadores, CFG.SECTOR_HUNTER_CAP);
  assert.equal(CFG.sectorInfo(30).densidade, CFG.SECTOR_DENSITY_CAP);
  assert.equal(CFG.sectorInfo(98).nome, 'SETOR 99 :: CAOS');
});

test('CFG: intensidade musical e manchetes de fim de jogo', () => {
  const { COBRA: { CFG } } = soUtilConfig();
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(CFG.intensityFor), [0, 1, 2, 3, 3, 3]);
  assert.equal(CFG.deathTitle('parede'), 'VOCÊ VIROU CONCRETO');
  assert.equal(CFG.deathTitle('corpo'), 'VOCÊ SE MORDEU, GÊNIO');
  assert.equal(CFG.deathTitle('cacador'), 'O CAÇADOR TE PEGOU');
  assert.equal(CFG.deathTitle('perfeito'), 'VOCÊ COMEU A REDE INTEIRA');
  assert.equal(CFG.deathTitle('???'), 'CONEXÃO PERDIDA');
});

test('CFG: os três modos', () => {
  const { COBRA: { CFG } } = soUtilConfig();
  assert.deepEqual(simples(CFG.MODE_IDS), ['classico', 'caos', 'zen']);
  const { classico, caos, zen } = CFG.MODES;
  assert.equal(classico.tickBase, 130);
  assert.equal(caos.tickBase, 105);
  assert.equal(caos.startSector, 3, 'índice 3 = "SETOR 04 :: DOBRA" na tela');
  assert.equal(caos.hunters, 2);
  assert.equal(caos.ptsMult, 1.5);
  assert.equal(zen.morre, false);
  assert.equal(zen.muros, false);
  assert.equal(zen.cacadores, false);
});
