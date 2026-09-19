// Testes de js/game/game.js (COBRA.Game): a regra do jogo inteira, rodando
// com os módulos de verdade (Util, CFG, Input, FX, Arena, entidades). Só a UI
// é trocada por um gravador de chamadas e o áudio fica de fora.
// Rodar na pasta do projeto com:  node --test
//
// Convenção: a partida começa com a cabeça em (15,10) indo para a direita,
// corpo em (14..12,10). Como a comida nasce em lugar sorteado, todo teste que
// não quer comer por acaso põe a comida num canto com `comidaEm`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ambienteDoJogo, gerador } = require('./ambiente.js');

function jogo(modo = 'classico', semente) {
  const amb = ambienteDoJogo({ semente });
  const { COBRA } = amb;
  const G = COBRA.Game;
  G.init();
  if (modo) G.start(modo);
  const j = { ...amb, G, C: COBRA.CFG, I: COBRA.Input, D: COBRA.Util.DIRS, A: COBRA.Arena };
  if (modo) comidaEm(j, 0, 0);
  return j;
}

function comidaEm(j, x, y, tipo = 'normal') {
  j.G.food = new j.COBRA.Food(x, y, tipo, j.agora());
  j.G.food.settle();
  return j.G.food;
}

/** Roda n ticks inteiros (um update do tamanho exato do tick). */
function tick(j, n = 1) {
  for (let i = 0; i < n; i++) j.G.update(j.G.tickMs);
}

const cabeca = (j) => [j.G.snake.head().x, j.G.snake.head().y];

function cacadorPronto(j, x, y) {
  const h = new j.COBRA.Hunter(x, y);
  h.updateSpawn(5000);
  j.G.hunters.push(h);
  return h;
}

/** Anda para a direita até bater na borda (ou até o limite de ticks). */
function bater(j, limite = 40) {
  for (let i = 0; i < limite && j.G.state === 'playing'; i++) tick(j);
}

/* ------------------------------------------------------ ciclo de vida */

test('init: começa no menu, com a cobra já criada e sem comida', () => {
  const j = jogo(null);
  assert.equal(j.G.state, 'menu');
  assert.equal(j.G.snake.cells.length, 4);
  assert.equal(j.G.food, null);
  assert.equal(j.G.best, 0);
  assert.equal(j.G.tickMs, 130);
});

test('start clássico: arena limpa, sem caçador, comida em célula livre', () => {
  const amb = ambienteDoJogo();
  const G = amb.COBRA.Game;
  G.init();
  G.start('classico');
  assert.equal(G.state, 'playing');
  assert.equal(G.mode, 'classico');
  assert.equal(G.sector, 0);
  assert.equal(G.score, 0);
  assert.equal(G.tickMs, 130);
  assert.equal(G.hunters.length, 0);
  assert.equal(amb.COBRA.Arena.wallCount(), 0);
  assert.ok(G.food);
  assert.equal(G.snake.hits(G.food.x, G.food.y), false);
  const b = amb.chamadasDe('banner')[0];
  assert.deepEqual(b.args.slice(0, 2), ['SETOR 01 :: BOOT', 'CLÁSSICO']);
  assert.ok(amb.chamadasDe('show').some((c) => c.args[0] === 'game'));
});

test('toMenu e restart', () => {
  const j = jogo('caos');
  j.G.toMenu();
  assert.equal(j.G.state, 'menu');
  assert.equal(j.G.food, null);
  assert.equal(j.G.hunters.length, 0);
  j.G.restart();
  assert.equal(j.G.mode, 'caos', 'restart repete o último modo');
  assert.equal(j.G.state, 'playing');
});

/* ------------------------------------------------------------- ritmo */

test('acumulador: anda um passo a cada tickMs e expõe o progresso', () => {
  const j = jogo();
  j.G.update(129);
  assert.deepEqual(cabeca(j), [15, 10]);
  assert.ok(Math.abs(j.G.tickProgress - 129 / 130) < 1e-9);
  j.G.update(1);
  assert.deepEqual(cabeca(j), [16, 10]);
  assert.equal(j.G.tick, 1);
  assert.equal(j.G.stats.timeMs, 130);
});

test('no máximo 3 ticks por update, mesmo com um engasgo enorme', () => {
  const j = jogo();
  j.G.update(10000);
  assert.deepEqual(cabeca(j), [18, 10]);
  assert.equal(j.G.tickProgress, 1);
});

test('update em pausa ou no menu não simula nada', () => {
  const j = jogo();
  j.G.pause();
  assert.equal(j.G.state, 'paused');
  j.G.update(5000);
  assert.deepEqual(cabeca(j), [15, 10]);
  assert.equal(j.G.stats.timeMs, 0);
  j.G.togglePause();
  assert.equal(j.G.state, 'playing');
  tick(j);
  assert.deepEqual(cabeca(j), [16, 10]);
});

/* ---------------------------------------------------------- direção */

test('direção: uma curva por tick, vinda da fila do Input', () => {
  const j = jogo();
  j.I.pushDir(j.D.UP);
  j.I.pushDir(j.D.LEFT);
  tick(j);
  assert.deepEqual(cabeca(j), [15, 9]);
  tick(j);
  assert.deepEqual(cabeca(j), [14, 9]);
});

test('direção: a ré é descartada', () => {
  const j = jogo();
  tick(j);                       // estabelece a referência
  j.I.pushDir(j.D.LEFT);
  tick(j);
  assert.deepEqual(cabeca(j), [17, 10]);
});

test('resume limpa a fila (tecla apertada com a tela de pausa aberta)', () => {
  const j = jogo();
  tick(j);
  j.G.pause();
  j.I.pushDir(j.D.UP);
  j.G.resume();
  tick(j);
  assert.deepEqual(cabeca(j), [17, 10]);
});

/* ------------------------------------------------------ comida e pontos */

test('comer: +10, cresce no tick seguinte e nasce outra comida', () => {
  const j = jogo();
  const f = comidaEm(j, 16, 10);
  tick(j);
  assert.equal(j.G.score, 10);
  assert.equal(j.G.foodsEaten, 1);
  assert.equal(j.G.snake.pendingGrow, 1);
  assert.ok(j.G.food && j.G.food !== f);
  assert.equal(j.G.snake.hits(j.G.food.x, j.G.food.y), false);
  comidaEm(j, 0, 0);
  tick(j);
  assert.equal(j.G.snake.cells.length, 5);
  assert.equal(j.G.stats.maxLen, 5);
});

test('dourada vale 50 e cresce 2; cristal vale 25', () => {
  const j = jogo();
  comidaEm(j, 16, 10, 'gold');
  tick(j);
  assert.equal(j.G.score, 50);
  assert.equal(j.G.snake.pendingGrow, 2);

  const k = jogo();
  comidaEm(k, 16, 10, 'crystal');
  tick(k);
  assert.equal(k.G.score, 25);
});

test('combo: comer dentro de 2,5 s multiplica (x1,5 no segundo) e a janela fecha', () => {
  const j = jogo();
  comidaEm(j, 16, 10);
  tick(j);
  comidaEm(j, 17, 10);
  tick(j);
  assert.equal(j.G.score, 10 + 15);
  assert.equal(j.G.combo, 1);
  assert.equal(j.G.mult, 1.5);
  assert.equal(j.G.stats.maxCombo, 1);

  comidaEm(j, 0, 0);
  j.G.update(2500);              // drena a janela (e anda 3 casas)
  assert.equal(j.G.combo, 0);
  assert.equal(j.G.mult, 1);
});

test('combo chega a x8 e para aí', () => {
  const j = jogo();
  // Linha 0: muro nunca nasce a menos de 1 casa da borda, então a troca de
  // setor no meio da sequência (passa de 500 pontos) não põe nada no caminho.
  j.G.snake.reset(0, 0, 'RIGHT');
  let ultimo = 0;
  for (let x = 1; x <= 18; x++) {
    comidaEm(j, x, 0);
    const antes = j.G.score;
    tick(j);
    ultimo = j.G.score - antes;
  }
  assert.equal(j.G.mult, 8);
  assert.equal(ultimo, 80);
});

test('nível: a cada 5 comidas, tick 5 ms mais rápido', () => {
  const j = jogo();
  for (let i = 1; i <= 5; i++) {
    comidaEm(j, 15 + i, 10);
    tick(j);
  }
  assert.equal(j.G.level, 1);
  assert.equal(j.G.stats.level, 1);
  assert.equal(j.G.tickMs, 125);
});

test('multiplicadores: TEMPO LENTO x2, FÚRIA x3, CAÔS x1,5', () => {
  const casos = [
    [{ slow: 5000 }, 'classico', 20],
    [{ fury: 5000 }, 'classico', 30],
    [{ slow: 5000, fury: 5000 }, 'classico', 60],
    [{}, 'caos', 15],
  ];
  for (const [power, modo, esperado] of casos) {
    const j = jogo(modo);
    j.G.hunters.length = 0;
    Object.assign(j.G.power, power);
    comidaEm(j, 16, 10);
    tick(j);
    assert.equal(j.G.score, esperado, JSON.stringify(power) + ' ' + modo);
  }
});

test('cristal sorteia um dos 5 power-ups (duração reposta, não somada)', () => {
  // Math.random fixo escolhe o índice em POWER_IDS: ghost, magnet, slow, shield, fury.
  const casos = [[0.1, 'ghost'], [0.3, 'magnet'], [0.5, 'slow'], [0.7, 'shield'], [0.9, 'fury']];
  for (const [r, id] of casos) {
    const j = jogo();
    if (id !== 'shield') j.G.power[id] = 1000;   // já ativo: a duração é reposta
    comidaEm(j, 16, 10, 'crystal');
    j.fixarAleatorio(r);
    tick(j);
    j.semear(1);
    if (id === 'shield') assert.equal(j.G.power.shield, true);
    else assert.equal(j.G.power[id], j.C.POWER[id].ms, id);
    assert.ok(j.chamadasDe('banner').some((c) => c.args[0] === j.C.POWER[id].nome), 'banner ' + id);
    if (id === 'slow') assert.ok(Math.abs(j.G.tickMs - 130 * 1.8) < 1e-9);
    if (id === 'fury') assert.ok(Math.abs(j.G.tickMs - 130 * 0.6) < 1e-9);
  }
});

test('TEMPO LENTO e FÚRIA devolvem o ritmo normal quando acabam', () => {
  const j = jogo();
  comidaEm(j, 16, 10, 'crystal');
  j.fixarAleatorio(0.9);           // fúria
  tick(j);
  j.semear(1);
  assert.ok(j.G.tickMs < 130);
  comidaEm(j, 0, 0);
  j.G.power.fury = 40;            // os últimos 40 ms de fúria
  j.G.update(50);
  assert.equal(j.G.power.fury, 0);
  assert.equal(j.G.tickMs, 130);
});

test('comida com prazo expira e é trocada; a pausa não conta no prazo', () => {
  const j = jogo();
  const g = comidaEm(j, 0, 0, 'gold');
  j.avancarRelogio(5000);
  tick(j);
  assert.equal(j.G.food, g, 'ainda dentro dos 6 s');
  j.G.pause();
  j.avancarRelogio(60000);
  j.G.resume();
  tick(j);
  assert.equal(j.G.food, g, 'um minuto pausado não gastou o prazo');
  j.avancarRelogio(1000);
  tick(j);
  assert.notEqual(j.G.food, g, 'agora expirou');
  assert.ok(j.G.food);
});

test('ÍMÃ: a comida anda 1 casa em direção à cabeça a cada 2 ticks', () => {
  const j = jogo();
  j.G.power.magnet = 10000;
  const f = comidaEm(j, 19, 12);
  tick(j);                        // tick 1 (ímpar): parada
  assert.deepEqual([f.x, f.y], [19, 12]);
  tick(j);                        // tick 2: cabeça em (17,10)
  assert.deepEqual([f.x, f.y, f.px, f.py], [18, 12, 19, 12]);
});

test('ÍMÃ não puxa comida a mais de 6 casas', () => {
  const j = jogo();
  j.G.power.magnet = 10000;
  const f = comidaEm(j, 25, 17);
  tick(j, 2);
  assert.deepEqual([f.x, f.y], [25, 17]);
});

/* ----------------------------------------------------------- mortes */

test('bater na borda: fim de jogo "parede" e slow-motion', () => {
  const j = jogo();
  bater(j);
  assert.equal(j.G.state, 'gameover');
  assert.equal(j.G.stats.cause, 'parede');
  assert.equal(j.G.timeScale, 0.25);
  assert.equal(j.C.deathTitle(j.G.stats.cause), 'VOCÊ VIROU CONCRETO');
});

test('animação de morte: tela de fim uma vez só, depois de 900 ms de jogo', () => {
  const j = jogo();
  bater(j);
  j.G.update(450);
  assert.equal(j.chamadasDe('showGameOver').length, 0);
  assert.ok(j.G.timeScale > 0.25 && j.G.timeScale < 1);
  j.G.update(450);
  assert.equal(j.chamadasDe('showGameOver').length, 1);
  assert.equal(j.G.timeScale, 1);
  assert.ok(Math.abs(j.G.deathAnim - 900 / 1400) < 1e-9);
  j.G.update(2000);
  assert.equal(j.chamadasDe('showGameOver').length, 1);
  assert.equal(j.G.deathAnim, 1);
});

test('morder o próprio corpo: fim de jogo "corpo"', () => {
  const j = jogo();
  j.G.snake.grow(4);
  tick(j, 4);                     // 8 segmentos, cabeça em (19,10)
  for (const d of [j.D.UP, j.D.LEFT, j.D.DOWN]) {
    j.I.pushDir(d);
    tick(j);
  }
  assert.equal(j.G.state, 'gameover');
  assert.equal(j.G.stats.cause, 'corpo');
});

test('seguir o próprio rabo não mata (a cauda sai da casa no mesmo tick)', () => {
  const j = jogo();
  // Quadrado 2x2 com 4 segmentos: a cabeça entra onde a cauda estava.
  for (const d of [j.D.UP, j.D.LEFT, j.D.DOWN, j.D.RIGHT, j.D.UP]) {
    j.I.pushDir(d);
    tick(j);
  }
  assert.equal(j.G.state, 'playing');
});

test('caçador na casa de destino: fim de jogo "cacador"', () => {
  const j = jogo();
  cacadorPronto(j, 17, 10);
  tick(j, 2);
  assert.equal(j.G.state, 'gameover');
  assert.equal(j.G.stats.cause, 'cacador');
});

test('caçador que anda para cima da cabeça também mata (2ª checagem do tick)', () => {
  const j = jogo();
  j.G.snake.reset(15, 10, 'DOWN');
  j.I.clearQueue();
  cacadorPronto(j, 16, 12);
  tick(j);                        // tick 1: cabeça (15,11); caçador só anda em tick par
  assert.equal(j.G.state, 'playing');
  tick(j);                        // tick 2: cabeça (15,12) e o caçador pula nela
  assert.equal(j.G.state, 'gameover');
  assert.equal(j.G.stats.cause, 'cacador');
});

test('caçador materializando é intangível: a cobra passa por ele', () => {
  const j = jogo();
  j.G.hunters.push(new j.COBRA.Hunter(17, 10));
  tick(j, 3);
  assert.equal(j.G.state, 'playing');
});

test('FÚRIA destrói o caçador: +100', () => {
  const j = jogo();
  j.G.power.fury = 5000;
  cacadorPronto(j, 17, 10);
  tick(j, 2);
  assert.equal(j.G.state, 'playing');
  assert.equal(j.G.score, 100);
  assert.equal(j.G.hunters.length, 0);
});

test('FÚRIA atravessa muro (+25); sem ela o muro mata', () => {
  for (const furia of [true, false]) {
    const j = jogo();
    j.A.build(1, []);
    const w = Array.from(j.A.wallList).find((m) => !j.A.isWall(m.x - 1, m.y));
    j.G.snake.reset(w.x - 1, w.y, 'RIGHT');
    j.I.clearQueue();
    if (furia) j.G.power.fury = 5000;
    tick(j);
    if (furia) {
      assert.equal(j.G.state, 'playing');
      assert.equal(j.A.isWall(w.x, w.y), false);
      assert.equal(j.G.score, 25);
    } else {
      assert.equal(j.G.state, 'gameover');
      assert.equal(j.G.stats.cause, 'parede');
    }
  }
});

test('FANTASMA: atravessa a borda e sai do outro lado', () => {
  const j = jogo();
  j.G.power.ghost = 8000;
  tick(j, 15);
  assert.equal(j.G.state, 'playing');
  assert.deepEqual(cabeca(j), [0, 10]);
});

test('FANTASMA: atravessa o próprio corpo', () => {
  const j = jogo();
  j.G.power.ghost = 8000;
  j.G.snake.grow(4);
  tick(j, 4);
  for (const d of [j.D.UP, j.D.LEFT, j.D.DOWN]) {
    j.I.pushDir(d);
    tick(j);
  }
  assert.equal(j.G.state, 'playing');
});

test('ESCUDO: absorve uma batida, rebobina a cobra e dá 800 ms de invencibilidade', () => {
  const j = jogo();
  j.G.power.shield = true;
  bater(j, 15);
  assert.equal(j.G.state, 'playing');
  assert.equal(j.G.power.shield, false);
  assert.equal(j.G.invulnMs, 800);
  assert.deepEqual(cabeca(j), [29, 10], 'a cabeça voltou para dentro da grade');
  assert.equal(new Set(Array.from(j.G.snake.cells, (c) => c.x + ',' + c.y)).size, 4,
    'rebobinar não duplica segmento');
  j.I.pushDir(j.D.UP);
  tick(j);
  assert.deepEqual(cabeca(j), [29, 9]);
  assert.equal(j.G.state, 'playing');
});

test('ESCUDO também salva do caçador', () => {
  const j = jogo();
  j.G.power.shield = true;
  cacadorPronto(j, 17, 10);
  tick(j, 2);
  assert.equal(j.G.state, 'playing');
  assert.equal(j.G.power.shield, false);
});

test('ZEN: bater não mata, custa segmentos (piso 3) e dá 1 s de invencibilidade', () => {
  const j = jogo('zen');
  bater(j, 15);
  assert.equal(j.G.state, 'playing');
  assert.equal(j.G.snake.cells.length, 3, 'tinha 4: só dá para tirar 1');
  assert.equal(j.G.invulnMs, 1000);
  assert.deepEqual(cabeca(j), [29, 10]);
});

test('perfeito: sem célula livre para a comida, a rede foi comida inteira', () => {
  const j = jogo();
  const { G, C } = j;
  // Cobra em zigue-zague ocupando 599 das 600 casas, crescendo, com a comida
  // na última casa livre bem na frente da cabeça.
  const caminho = [];
  for (let y = 0; y < C.GRID_H; y++) {
    for (let k = 0; k < C.GRID_W; k++) caminho.push({ x: y % 2 ? C.GRID_W - 1 - k : k, y });
  }
  const corpo = caminho.slice(0, caminho.length - 1).reverse();
  const S = G.snake;
  S.cells.length = 0;
  S.prev.length = 0;
  for (const c of corpo) { S.cells.push({ ...c }); S.prev.push({ ...c }); }
  S.dir = j.D.LEFT;
  S.pendingGrow = 1;
  j.I.clearQueue();
  const ultima = caminho[caminho.length - 1];
  comidaEm(j, ultima.x, ultima.y);
  tick(j);
  assert.equal(G.state, 'gameover');
  assert.equal(G.stats.cause, 'perfeito');
  assert.equal(G.stats.maxLen, 600);
});

/* --------------------------------------------------------- recordes */

test('recordes: top 5 ordenado, recorde marcado e lido de volta no init', () => {
  const j = jogo();
  const { G, C, COBRA } = j;
  const marcou = [];
  for (const pontos of [30, 10, 70, 50, 0, 20, 60, 40]) {
    G.start('classico');
    comidaEm(j, 0, 0);
    G.score = pontos;
    bater(j);
    marcou.push(G.stats.isRecord);
  }
  assert.deepEqual(marcou, [true, false, true, false, false, false, false, false]);
  assert.equal(G.best, 70);

  const lista = COBRA.Util.store.get(C.STORAGE_KEY, null);
  assert.deepEqual(Array.from(lista, (r) => r.pontos), [70, 60, 50, 40, 30]);
  assert.equal(lista[0].modo, 'CLÁSSICO');
  assert.equal(lista[0].modoId, 'classico');
  assert.match(lista[0].data, /^\d\d\/\d\d\/\d{4}$/);
  assert.equal(COBRA.Util.store.get(C.STORAGE_BEST, 0), 70);

  G.init();
  assert.equal(G.best, 70, 'o recorde sobrevive a um novo init');
});

/* ------------------------------------------------------ modos e setores */

test('CAÔS: começa no índice 3 (SETOR 04 :: DOBRA), tick 105, 2 caçadores longe', () => {
  const amb = ambienteDoJogo({ semente: 5 });
  const G = amb.COBRA.Game;
  G.init();
  G.start('caos');
  assert.equal(G.sector, 3);
  assert.equal(G.tickMs, 105);
  assert.equal(G.hunters.length, 2);
  for (const h of G.hunters) {
    assert.ok(Math.abs(h.x - 15) + Math.abs(h.y - 10) >= 10, 'nasce a 10+ casas da cabeça');
    assert.equal(h.isTangible(), false, 'nasce materializando');
  }
  assert.ok(amb.COBRA.Arena.wallCount() > 0);
  assert.ok(amb.COBRA.Arena.portals.length >= 2);
  assert.deepEqual(amb.chamadasDe('banner')[0].args.slice(0, 2), ['SETOR 04 :: DOBRA', 'CAÔS']);
});

test('CAÔS só sai do setor 3 com 2000 pontos', () => {
  const j = jogo('caos', 5);
  j.G.hunters.length = 0;
  j.G.score = 1990;
  comidaEm(j, 16, 10);
  tick(j);
  assert.equal(j.G.score, 2005);
  assert.equal(j.G.sector, 4);
});

test('setor sobe a cada 500 pontos e reconstrói a arena sem matar a cobra', () => {
  const j = jogo('classico', 9);
  const { G, A } = j;
  G.score = 495;
  comidaEm(j, 16, 10);
  tick(j);
  assert.equal(G.sector, 1);
  assert.equal(G.stats.sector, 1);
  assert.ok(A.wallCount() > 0);
  for (const c of G.snake.cells) assert.equal(A.isWall(c.x, c.y), false);
  assert.equal(A.isBlocked(G.food.x, G.food.y), false);
  const b = j.chamadasDe('banner').at(-1);
  assert.deepEqual(b.args.slice(0, 2), ['SETOR 02 :: FIREWALL', 'MUROS INTERNOS']);

  G.score = 995;
  comidaEm(j, cabeca(j)[0] + 1, 10);
  tick(j);
  assert.equal(G.sector, 2);
  assert.equal(G.hunters.length, 1, 'setor 03 :: CAÇADA traz o primeiro caçador');
});

test('ZEN: sobe de setor sem ganhar muro, portal nem caçador', () => {
  const j = jogo('zen');
  j.G.score = 1495;
  comidaEm(j, 16, 10);
  tick(j);
  assert.equal(j.G.sector, 3);
  assert.equal(j.A.wallCount(), 0);
  assert.equal(j.A.portals.length, 0);
  assert.equal(j.G.hunters.length, 0);
});

// Até 19/09/2026 o sectorSub() montava o banner só com CFG.sectorInfo e, no
// ZEN, anunciava "MUROS INTERNOS · PORTAIS · 1 CAÇADOR" numa arena vazia.
test('ZEN: o banner de setor não promete muro, portal nem caçador', () => {
  const j = jogo('zen');
  j.G.score = 1495;
  comidaEm(j, 16, 10);
  tick(j);
  const sub = j.chamadasDe('banner').at(-1).args[1];
  assert.equal(sub, 'ARENA LIMPA');
});

test('banner de setor conta os caçadores que o setor realmente traz', () => {
  const casos = [
    ['classico', 1495, 3, 'MUROS INTERNOS · PORTAIS · 1 CAÇADOR'],
    ['classico', 2495, 5, 'MUROS INTERNOS · PORTAIS · 3 CAÇADORES'],
    ['caos', 1995, 4, 'MUROS INTERNOS · PORTAIS · 2 CAÇADORES'],
  ];
  for (const [modo, pontos, setor, esperado] of casos) {
    const j = jogo(modo, 3);
    j.G.hunters.length = 0;
    j.G.score = pontos;
    comidaEm(j, 16, 10);
    tick(j);
    assert.equal(j.G.sector, setor, modo + ' ' + pontos);
    assert.equal(j.chamadasDe('banner').at(-1).args[1], esperado);
    assert.equal(j.G.hunters.length, Number(esperado.match(/(\d) CAÇADOR/)[1]));
  }
});

/* ------------------------------------------------ partida longa, sorteada */

// Piloto simples: entre as direções que não matam no próximo passo, vai na
// que mais aproxima da comida. De tempos em tempos ganha pontos de presente
// para forçar troca de setor com a cobra em qualquer lugar da arena. A cada
// tick confere o que não pode quebrar nunca.
test('partidas longas sorteadas mantêm as invariantes a cada tick', () => {
  let setorMax = 0, mortes = 0, ticks = 0;
  for (let semente = 1; semente <= 6; semente++) {
    for (const modo of ['classico', 'caos', 'zen']) {
      const j = jogo(modo, semente);
      const { G, A, D, COBRA } = j;
      const W = j.C.GRID_W, H = j.C.GRID_H;
      const rnd = gerador(semente * 31 + modo.length);

      for (let t = 1; t <= 1500; t++) {
        if (G.state !== 'playing') { mortes++; G.start(modo); }
        if (t % 120 === 0) G.score += 400;

        const S = G.snake, h = S.head();
        const opcoes = [D.UP, D.DOWN, D.LEFT, D.RIGHT]
          .filter((d) => !COBRA.Util.isOpposite(d, S.dir))
          .map((d) => {
            let nx = h.x + d.x, ny = h.y + d.y;
            if (G.power.ghost > 0) { nx = (nx + W) % W; ny = (ny + H) % H; }
            const fora = nx < 0 || ny < 0 || nx >= W || ny >= H;
            const morre = fora || (A.isWall(nx, ny) && !(G.power.fury > 0)) ||
              (!(G.power.ghost > 0) && S.hits(nx, ny, true)) ||
              G.hunters.some((u) => u.isTangible() && u.x === nx && u.y === ny);
            const dist = G.food ? Math.abs(G.food.x - nx) + Math.abs(G.food.y - ny) : 0;
            return { d, peso: (morre ? 1000 : 0) + dist + rnd() };
          })
          .sort((a, b) => a.peso - b.peso);
        j.I.clearQueue();
        j.I.nextDir(S.dir);
        j.I.pushDir(opcoes[0].d);

        G.update(G.tickMs);
        ticks++;

        const ctx = `semente ${semente}, ${modo}, tick ${t}`;
        assert.equal(S.cells.length, S.prev.length, 'cells/prev ' + ctx);
        assert.ok(G.tickMs > 0 && Number.isFinite(G.tickMs), 'tickMs ' + ctx);
        assert.ok(G.tickProgress >= 0 && G.tickProgress <= 1, 'tickProgress ' + ctx);
        assert.ok(Number.isInteger(G.score), 'pontos inteiros ' + ctx);
        if (G.state !== 'playing') continue;
        setorMax = Math.max(setorMax, G.sector);
        for (const c of S.cells) {
          assert.ok(c.x >= 0 && c.y >= 0 && c.x < W && c.y < H, 'cobra fora da grade ' + ctx);
          assert.equal(A.isWall(c.x, c.y), false, 'cobra dentro de muro ' + ctx);
        }
        assert.ok(G.food, 'sempre uma comida ' + ctx);
        assert.equal(A.isBlocked(G.food.x, G.food.y), false, 'comida em muro/portal ' + ctx);
        assert.equal(S.hits(G.food.x, G.food.y), false, 'comida embaixo da cobra ' + ctx);
        for (const u of G.hunters) {
          assert.equal(A.isBlocked(u.x, u.y), false, 'caçador em muro/portal ' + ctx);
        }
        if (modo === 'zen') {
          assert.equal(A.wallCount() + G.hunters.length, 0, 'ZEN limpo ' + ctx);
        }
      }
    }
  }
  assert.ok(setorMax >= 8, 'a varredura passou por setores altos (' + setorMax + ')');
  assert.ok(ticks > 20000);
  void mortes;
});
