// Testes de js/game/entities.js: COBRA.Snake, COBRA.Food e COBRA.Hunter.
// Rodar na pasta do projeto com:  node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { criarAmbiente } = require('./ambiente.js');

const ambiente = () => criarAmbiente({
  modulos: ['js/core/util.js', 'js/game/config.js', 'js/game/entities.js'],
});

// Array.from (e não arr.map) para o resultado ser um array DESTE lado: os
// arrays do jogo nascem dentro do vm, com outro Array.prototype.
const pos = (arr) => Array.from(arr, (c) => [c.x, c.y]);

/* --------------------------------------------------------------- Snake */

test('Snake: nasce com 4 segmentos atrás da cabeça e prev igual a cells', () => {
  const { COBRA } = ambiente();
  const s = new COBRA.Snake(15, 10, COBRA.Util.DIRS.RIGHT);
  assert.deepEqual(pos(s.cells), [[15, 10], [14, 10], [13, 10], [12, 10]]);
  assert.deepEqual(pos(s.prev), pos(s.cells));
  assert.notEqual(s.prev[0], s.cells[0], 'prev não compartilha objeto com cells');
  assert.equal(s.head(), s.cells[0]);
  assert.equal(s.len(), 4);
});

test('Snake: aceita a direção como texto ("RIGHT") e prende o corpo na grade', () => {
  const { COBRA } = ambiente();
  const s = new COBRA.Snake(1, 5, 'RIGHT');
  assert.equal(s.dir, COBRA.Util.DIRS.RIGHT);
  assert.deepEqual(pos(s.cells), [[1, 5], [0, 5], [0, 5], [0, 5]],
    'perto da borda os segmentos extras empilham na última célula válida');
});

test('Snake.step: anda uma célula e guarda a posição anterior', () => {
  const { COBRA } = ambiente();
  const s = new COBRA.Snake(15, 10, 'RIGHT');
  const r = s.step(null, { wrap: false, arena: null });
  assert.deepEqual(pos(s.cells), [[16, 10], [15, 10], [14, 10], [13, 10]]);
  assert.deepEqual(pos(s.prev), [[15, 10], [14, 10], [13, 10], [12, 10]]);
  assert.equal(r.portal, false);
  assert.equal(r.wrapped, false);
  assert.equal(s.noInterp, false);
});

test('Snake.step: vira, mas recusa a ré exata', () => {
  const { COBRA } = ambiente();
  const D = COBRA.Util.DIRS;
  const s = new COBRA.Snake(15, 10, 'RIGHT');
  s.step(D.LEFT, {});
  assert.deepEqual(pos(s.cells)[0], [16, 10], 'ré ignorada, segue para a direita');
  s.step(D.UP, {});
  assert.deepEqual(pos(s.cells)[0], [16, 9]);
  assert.equal(s.dir, D.UP);
});

test('Snake.grow: cresce um segmento por tick, nascendo na cauda nos dois arrays', () => {
  const { COBRA } = ambiente();
  const s = new COBRA.Snake(15, 10, 'RIGHT');
  s.grow(2);
  assert.equal(s.pendingGrow, 2);

  s.step(null, {});
  assert.equal(s.cells.length, 5);
  assert.equal(s.prev.length, 5);
  assert.deepEqual(pos(s.cells), [[16, 10], [15, 10], [14, 10], [13, 10], [12, 10]]);
  // O segmento novo fica parado na cauda antiga: prev == cells nele, senão o
  // renderer o desenharia entrando "voando" de outro lugar.
  assert.deepEqual([s.prev[4].x, s.prev[4].y], [12, 10]);

  s.step(null, {});
  assert.equal(s.cells.length, 6);
  s.step(null, {});
  assert.equal(s.cells.length, 6, 'acabou o crescimento pendente');
  assert.equal(s.pendingGrow, 0);
});

test('Snake.step com wrap: atravessa a borda e suprime a interpolação', () => {
  const { COBRA } = ambiente();
  const s = new COBRA.Snake(29, 10, 'RIGHT');
  const r = s.step(null, { wrap: true });
  assert.deepEqual(pos(s.cells)[0], [0, 10]);
  assert.equal(r.wrapped, true);
  assert.equal(s.noInterp, true);
  s.step(null, { wrap: true });
  assert.equal(s.noInterp, false, 'volta a interpolar no tick seguinte');
});

test('Snake.step sem wrap: sai da grade (quem mata é o Game)', () => {
  const { COBRA } = ambiente();
  const s = new COBRA.Snake(29, 10, 'RIGHT');
  s.step(null, { wrap: false });
  assert.deepEqual(pos(s.cells)[0], [30, 10]);
});

test('Snake.step com portal: teleporta e cada segmento salta sem riscar a tela', () => {
  const { COBRA } = ambiente();
  // Arena falsa: a célula (16,10) leva a (5,5).
  const arena = {
    portalAt: (x, y) => (x === 16 && y === 10 ? { x: 5, y: 5 } : null),
  };
  const s = new COBRA.Snake(15, 10, 'RIGHT');
  const r = s.step(null, { arena });
  assert.equal(r.portal, true);
  assert.equal(s.noInterp, true);
  assert.deepEqual(pos(s.cells)[0], [5, 5]);

  s.step(null, { arena });
  assert.deepEqual(pos(s.cells).slice(0, 2), [[6, 5], [5, 5]]);
  // O segmento 1 deu o salto neste tick: prev colado no destino, e não na
  // célula de origem do outro lado da arena.
  assert.deepEqual([s.prev[1].x, s.prev[1].y], [5, 5]);
});

test('Snake.shrink: corta do fim, com piso em CFG.MIN_LEN (3)', () => {
  const { COBRA } = ambiente();
  const s = new COBRA.Snake(15, 10, 'RIGHT');
  s.grow(3);
  for (let i = 0; i < 3; i++) s.step(null, {});
  assert.equal(s.len(), 7);
  assert.equal(s.shrink(3), 3);
  assert.equal(s.len(), 4);
  assert.equal(s.shrink(3), 1, 'só consegue tirar 1 sem passar do piso');
  assert.equal(s.len(), 3);
  assert.equal(s.prev.length, 3);
  assert.equal(s.shrink(5), 0);
});

test('Snake.shrink respeita um CFG.MIN_LEN menor', () => {
  const { COBRA } = ambiente();
  COBRA.CFG.MIN_LEN = 2;
  const s = new COBRA.Snake(15, 10, 'RIGHT');
  s.shrink(10);
  assert.equal(s.len(), 2);
});

test('Snake.hits: corpo inteiro, com opção de ignorar a cauda', () => {
  const { COBRA } = ambiente();
  const s = new COBRA.Snake(15, 10, 'RIGHT');
  assert.equal(s.hits(15, 10), true, 'a cabeça conta');
  assert.equal(s.hits(12, 10), true);
  assert.equal(s.hits(12, 10, true), false, 'a cauda sai da célula neste tick');
  s.grow(1);
  assert.equal(s.hits(12, 10, true), true, 'crescendo, a cauda fica');
  assert.equal(s.hits(0, 0), false);
  assert.equal(s.indexAt(13, 10), 2);
  assert.equal(s.indexAt(0, 0), -1);
});

test('Snake: onda de engolida anda 22 segmentos/s e some depois da cauda', () => {
  const { COBRA } = ambiente();
  const s = new COBRA.Snake(15, 10, 'RIGHT');
  s.addWave();
  assert.ok(Math.abs(s.waveScale(0) - 1.45) < 1e-9, 'pico na cabeça');
  assert.equal(s.waveScale(3), 1, 'longe do pulso não escala');
  s.updateWaves(100);
  assert.ok(Math.abs(s.waves[0].pos - 2.2) < 1e-9);
  s.updateWaves(1000);
  assert.equal(s.waves.length, 0);
});

test('Snake: rastro da cabeça amostrado por tempo, não por frame', () => {
  const { COBRA } = ambiente();
  const s = new COBRA.Snake(15, 10, 'RIGHT');
  // TRAIL_MS = 16: quatro frames de 4 ms rendem UMA amostra.
  for (let i = 0; i < 4; i++) s.pushTrail(100 + i, 50, 4);
  assert.equal(s.trailCount, 1);
  assert.deepEqual([s.trailAt(0).x, s.trailAt(0).y], [103, 50]);
  for (let i = 0; i < 20; i++) s.pushTrail(200 + i, 50, 16);
  assert.equal(s.trailCount, 8, 'buffer circular de 8');
  assert.equal(s.trailAt(0).x, 219);
  assert.equal(s.trailAt(8), null);
  s.clearTrail();
  assert.equal(s.trailCount, 0);
});

/* ---------------------------------------------------------------- Food */

test('Food: normal é eterna; dourada expira em 6 s e pisca nos últimos 2 s', () => {
  const { COBRA } = ambiente();
  const n = new COBRA.Food(3, 4, 'normal', 0);
  assert.equal(n.expired(1e9), false);
  assert.equal(n.remaining(1e9), Infinity);
  assert.equal(n.pts, 10);

  const g = new COBRA.Food(3, 4, 'gold', 1000);
  assert.equal(g.pts, 50);
  assert.equal(g.grow, 2);
  assert.equal(g.expired(6999), false);
  assert.equal(g.expired(7000), true);
  assert.equal(g.remaining(2000), 5000);
  assert.equal(g.blinking(4999), false);
  assert.equal(g.blinking(5000), true);
  assert.equal(g.progress(4000), 0.5);

  const c = new COBRA.Food(0, 0, 'crystal', 0);
  assert.equal(c.ttl, 9000);
  assert.equal(c.pts, 25);
});

test('Food: moveTo guarda a posição anterior e settle a cola', () => {
  const { COBRA } = ambiente();
  const f = new COBRA.Food(5, 5, 'normal', 0);
  f.moveTo(6, 5);
  assert.deepEqual([f.px, f.py, f.x, f.y], [5, 5, 6, 5]);
  f.settle();
  assert.deepEqual([f.px, f.py], [6, 5]);
});

/* -------------------------------------------------------------- Hunter */

test('Hunter: intangível durante 1200 ms de materialização', () => {
  const { COBRA } = ambiente();
  const h = new COBRA.Hunter(5, 5);
  assert.equal(h.isTangible(), false);
  h.updateSpawn(600);
  assert.equal(h.spawnProgress(), 0.5);
  assert.equal(h.update(2, 0, 0, null), false, 'materializando não anda');
  h.updateSpawn(600);
  assert.equal(h.isTangible(), true);
});

function cacadorPronto(COBRA, x, y) {
  const h = new COBRA.Hunter(x, y);
  h.updateSpawn(5000);
  return h;
}

test('Hunter: anda a cada 2 ticks na direção que mais encurta a distância', () => {
  const { COBRA } = ambiente();
  const h = cacadorPronto(COBRA, 5, 5);
  assert.equal(h.update(1, 10, 5, null), false, 'tick ímpar não anda');
  assert.equal(h.update(2, 10, 5, null), true);
  assert.deepEqual([h.x, h.y, h.px, h.py], [6, 5, 5, 5]);
  assert.equal(h.update(2, 10, 5, null), false, 'mesmo tick duas vezes não conta dobrado');
  h.update(4, 6, 0, null);
  assert.deepEqual([h.x, h.y], [6, 4]);
});

test('Hunter: com TEMPO LENTO anda a cada 3 ticks', () => {
  const { COBRA } = ambiente();
  const h = cacadorPronto(COBRA, 5, 5);
  assert.equal(h.update(2, 10, 5, null, 3), false);
  assert.equal(h.update(3, 10, 5, null, 3), true);
});

test('Hunter: empate mantém a direção anterior', () => {
  const { COBRA } = ambiente();
  const h = cacadorPronto(COBRA, 5, 5);
  h.update(2, 10, 5, null);          // anda para a direita, dir = (1,0)
  // Alvo na diagonal: direita e baixo empatam; tem que continuar à direita.
  h.update(4, 10, 10, null);
  assert.deepEqual([h.x, h.y], [7, 5]);
});

test('Hunter: não pisa em muro nem em portal nem sai da grade', () => {
  const { COBRA } = ambiente();
  const h = cacadorPronto(COBRA, 5, 5);
  const arena = {
    isWall: (x, y) => x === 6 && y === 5,
    isPortal: (x, y) => x === 5 && y === 6,
  };
  h.update(2, 10, 10, arena);        // direita é muro, baixo é portal
  assert.ok(!(h.x === 6 && h.y === 5) && !(h.x === 5 && h.y === 6));
  assert.equal(h.x + h.y, 9, 'foi para cima ou esquerda (as únicas livres)');

  const canto = cacadorPronto(COBRA, 0, 0);
  canto.update(2, -5, -5, null);
  assert.ok(canto.x >= 0 && canto.y >= 0);
});

test('Hunter: cercado fica parado', () => {
  const { COBRA } = ambiente();
  const h = cacadorPronto(COBRA, 5, 5);
  const tudoMuro = { isWall: () => true };
  assert.equal(h.update(2, 10, 5, tudoMuro), false);
  assert.deepEqual([h.x, h.y], [5, 5]);
});

test('Hunter.lerpT: desliza durante o passo inteiro de 2 ticks', () => {
  const { COBRA } = ambiente();
  const h = cacadorPronto(COBRA, 5, 5);
  h.update(2, 10, 5, null);
  assert.equal(h.lerpT(0), 0);
  assert.equal(h.lerpT(0.5), 0.25);
  h.update(3, 10, 5, null);
  assert.equal(h.lerpT(0.5), 0.75);
  assert.equal(h.distTo(10, 5), 4);
});
