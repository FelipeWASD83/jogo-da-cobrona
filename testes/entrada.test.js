// Testes de js/core/input.js (COBRA.Input): a fila de direções, o mapa de
// teclas e o swipe. Os eventos são falsos — o teste guarda os listeners que o
// init() registra e chama cada um com um objeto no formato do evento real.
// Rodar na pasta do projeto com:  node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { criarAmbiente } = require('./ambiente.js');

function ambiente() {
  const ouvintes = {};
  const registrar = (alvo) => (tipo, fn) => { (ouvintes[alvo + ':' + tipo] ||= []).push(fn); };
  const amb = criarAmbiente({
    modulos: ['js/core/util.js', 'js/game/config.js', 'js/core/input.js'],
    extras: { addEventListener: registrar('window') },
  });
  const palco = { id: 'app', addEventListener: registrar('palco') };
  const disparar = (chave, ev) => { for (const fn of ouvintes[chave] || []) fn(ev); };

  let prevenidos = 0;
  const tecla = (key, extra = {}) => {
    const ev = { key, code: extra.code || '', repeat: false, ctrlKey: false, altKey: false,
                 metaKey: false, preventDefault() { prevenidos++; }, ...extra };
    disparar('window:keydown', ev);
  };
  const toque = (tipo, x, y) => disparar('palco:' + tipo, {
    changedTouches: [{ identifier: 1, clientX: x, clientY: y }], preventDefault() {},
  });
  return { ...amb, I: amb.COBRA.Input, D: amb.COBRA.Util.DIRS, palco, tecla, toque,
           prevenidos: () => prevenidos, ouvintes };
}

/* ------------------------------------------------------- fila de direções */

test('fila: guarda até 2 direções e entrega uma por vez', () => {
  const { I, D } = ambiente();
  I.nextDir(D.RIGHT);                 // referência: indo para a direita
  assert.equal(I.pushDir(D.UP), true);
  assert.equal(I.pushDir(D.LEFT), true, 'ESQUERDA comparada com CIMA (a última da fila), não com DIREITA');
  assert.equal(I.pushDir(D.DOWN), false, 'fila cheia');
  assert.equal(I.queueLength(), 2);
  assert.equal(I.nextDir(D.RIGHT), D.UP);
  assert.equal(I.nextDir(D.UP), D.LEFT);
  assert.equal(I.nextDir(D.LEFT), null);
});

test('fila: descarta a ré e a repetida na entrada', () => {
  const { I, D } = ambiente();
  I.nextDir(D.RIGHT);
  assert.equal(I.pushDir(D.LEFT), false, 'ré da direção atual');
  assert.equal(I.pushDir(D.RIGHT), false, 'igual à atual');
  assert.equal(I.pushDir(D.UP), true);
  assert.equal(I.pushDir(D.UP), false, 'repetida não ocupa espaço');
  assert.equal(I.queueLength(), 1);
});

test('fila: aceita {x,y} solto e devolve sempre o objeto canônico', () => {
  const { I, D } = ambiente();
  I.nextDir(D.RIGHT);
  assert.equal(I.pushDir({ x: 0, y: 1 }), true);
  assert.equal(I.pushDir({ x: 2, y: 0 }), false, 'vetor inválido');
  assert.equal(I.nextDir(D.RIGHT), D.DOWN);
});

test('fila: nextDir pula o que virou inválido depois de enfileirado', () => {
  const { I, D } = ambiente();
  I.nextDir(D.RIGHT);
  I.pushDir(D.UP);
  // A cobra passou a andar para BAIXO por outro motivo: CIMA agora é ré.
  assert.equal(I.nextDir(D.DOWN), null);
});

test('fila: clearQueue esvazia e esquece a referência', () => {
  const { I, D } = ambiente();
  I.nextDir(D.RIGHT);
  I.pushDir(D.UP);
  I.clearQueue();
  assert.equal(I.queueLength(), 0);
  assert.equal(I.pushDir(D.LEFT), true, 'sem referência, nada é "ré"');
});

// Até 19/09/2026 o input.js tinha o limite 2 cravado e ignorava o CFG.
test('CFG.INPUT_QUEUE_MAX muda o tamanho da fila', () => {
  const { I, D, COBRA } = ambiente();
  COBRA.CFG.INPUT_QUEUE_MAX = 3;
  I.nextDir(D.RIGHT);
  I.pushDir(D.UP);
  I.pushDir(D.LEFT);
  assert.equal(I.pushDir(D.DOWN), true);
  assert.equal(I.queueLength(), 3);
});

test('config diz a verdade: fila de 2 e swipe de 24 px são os valores de hoje', () => {
  const { COBRA } = ambiente();
  assert.equal(COBRA.CFG.INPUT_QUEUE_MAX, 2);
  assert.equal(COBRA.CFG.SWIPE_THRESHOLD, 24);
});

/* ------------------------------------------------------------- teclado */

test('teclado: setas e WASD enfileiram direção e disparam o one-shot', () => {
  const amb = ambiente();
  const { I, D } = amb;
  I.init(amb.palco);
  I.nextDir(D.RIGHT);
  amb.tecla('ArrowUp');
  assert.equal(I.pressed('up'), true);
  amb.tecla('a');
  assert.equal(I.pressed('left'), true);
  assert.equal(I.nextDir(D.RIGHT), D.UP);
  assert.equal(I.nextDir(D.UP), D.LEFT);
  assert.equal(amb.prevenidos(), 2, 'seta e WASD não rolam a página');
});

test('teclado: Espaço, Enter, Esc, P e M', () => {
  const amb = ambiente();
  const { I } = amb;
  I.init(amb.palco);
  amb.tecla(' ', { code: 'Space' });
  assert.deepEqual(['start', 'pause', 'confirm'].map(I.pressed), [true, true, true]);
  I.endFrame();
  assert.equal(I.pressed('start'), false, 'one-shot dura um frame');

  amb.tecla('Enter');
  assert.deepEqual(['restart', 'confirm'].map(I.pressed), [true, true]);
  I.endFrame();
  amb.tecla('Escape');
  assert.equal(I.pressed('menu'), true);
  amb.tecla('p');
  assert.equal(I.pressed('pause'), true);
  amb.tecla('M');
  assert.equal(I.pressed('mute'), true);
});

test('teclado: auto-repetição e atalho com Ctrl são ignorados', () => {
  const amb = ambiente();
  const { I, D } = amb;
  I.init(amb.palco);
  I.nextDir(D.RIGHT);
  amb.tecla('ArrowUp', { repeat: true });
  amb.tecla('ArrowDown', { ctrlKey: true });
  amb.tecla('p', { repeat: true });
  assert.equal(I.queueLength(), 0);
  assert.equal(I.pressed('pause'), false);
});

test('perder o foco solta os one-shots', () => {
  const amb = ambiente();
  const { I } = amb;
  I.init(amb.palco);
  amb.tecla('Enter');
  for (const fn of amb.ouvintes['window:blur']) fn({});
  assert.equal(I.pressed('restart'), false);
});

/* --------------------------------------------------------------- toque */

test('toque: swipe de 24 px ou mais vira direção, pelo eixo dominante', () => {
  const amb = ambiente();
  const { I, D } = amb;
  I.init(amb.palco);
  I.nextDir(D.RIGHT);
  amb.toque('touchstart', 100, 100);
  amb.toque('touchmove', 110, 120);   // 10 x 20: abaixo do limiar
  assert.equal(I.queueLength(), 0);
  amb.toque('touchmove', 110, 130);   // 10 x 30: para baixo
  amb.toque('touchmove', 200, 130);   // um swipe por toque
  amb.toque('touchend', 200, 130);
  assert.equal(I.nextDir(D.RIGHT), D.DOWN);
  assert.equal(I.queueLength(), 0);
});

test('toque: tap curto e parado vira começar/confirmar', () => {
  const amb = ambiente();
  const { I } = amb;
  I.init(amb.palco);
  amb.toque('touchstart', 50, 50);
  amb.avancarRelogio(100);
  amb.toque('touchend', 53, 52);
  assert.equal(I.pressed('start'), true);
  assert.equal(I.pressed('confirm'), true);
});

test('toque: segurar mais de 300 ms não é tap', () => {
  const amb = ambiente();
  const { I } = amb;
  I.init(amb.palco);
  amb.toque('touchstart', 50, 50);
  amb.avancarRelogio(400);
  amb.toque('touchend', 50, 50);
  assert.equal(I.pressed('start'), false);
});

// Até 19/09/2026 o input.js usava a constante local SWIPE_MIN = 24.
test('CFG.SWIPE_THRESHOLD muda o limiar do swipe', () => {
  const amb = ambiente();
  const { I, D, COBRA } = amb;
  COBRA.CFG.SWIPE_THRESHOLD = 60;
  I.init(amb.palco);
  I.nextDir(D.RIGHT);
  amb.toque('touchstart', 100, 100);
  amb.toque('touchmove', 100, 140);   // 40 px: abaixo do limiar de 60
  assert.equal(I.queueLength(), 0);
  amb.toque('touchmove', 100, 165);   // 65 px: agora sim
  assert.equal(I.queueLength(), 1);
});
