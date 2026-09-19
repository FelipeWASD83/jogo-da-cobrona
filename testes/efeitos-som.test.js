// Testes da parte sem tela de js/core/fx.js (COBRA.FX) e de js/core/audio.js
// (COBRA.Audio). O desenho do FX e a síntese de som precisam de canvas e de
// AudioContext, que não existem no Node; aqui fica só o que é regra.
// Rodar na pasta do projeto com:  node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { criarAmbiente } = require('./ambiente.js');

const fx = () => criarAmbiente({ modulos: ['js/core/util.js', 'js/game/config.js', 'js/core/fx.js'] }).COBRA.FX;
const audio = () => criarAmbiente({ modulos: ['js/core/util.js', 'js/game/config.js', 'js/core/audio.js'] }).COBRA.Audio;

/* ------------------------------------------------------------------ FX */

test('FX: hitstop fica com o MAIOR pedido e é consumido pelo tempo real', () => {
  const FX = fx();
  FX.init();
  assert.equal(FX.blocked(), false);
  FX.hitstop(100);
  FX.hitstop(40);                  // menor: não soma nem encurta
  FX.update(60);
  assert.equal(FX.blocked(), true, 'sobram 40 ms');
  FX.update(40);
  assert.equal(FX.blocked(), false);
});

test('FX: nunca passa de 900 partículas (as mais velhas são recicladas)', () => {
  const FX = fx();
  FX.init();
  for (let i = 0; i < 30; i++) FX.burst(100, 100, { count: 50 });
  assert.equal(FX.count(), 900);
  FX.update(5000);                 // todas morrem de velhas
  assert.equal(FX.count(), 0);
});

test('FX: tremor, flash e pools usam os números do CFG, iguais aos de sempre', () => {
  const amb = criarAmbiente({ modulos: ['js/core/util.js', 'js/game/config.js', 'js/core/fx.js'] });
  const C = amb.COBRA.CFG;
  assert.equal(C.SHAKE.DECAY, 1.6);
  assert.equal(C.SHAKE.MAX_PX, 14);
  assert.equal(C.SHAKE.DIVISOR, 25);
  assert.equal(C.FLASH_FADE_MS, 180);
  assert.equal(C.MAX_RINGS, 48);
  assert.equal(C.MAX_TEXTS, 32);

  // Prova de que o FX lê o CFG: com MAX_PX 1 o tremor nunca passa de 1 px.
  C.SHAKE.MAX_PX = 1;
  const FX = amb.COBRA.FX;
  FX.init();
  FX.shake(25);
  for (let i = 0; i < 20; i++) {
    FX.update(16);
    const o = FX.shakeOffset();
    assert.ok(Math.abs(o.x) <= 1 && Math.abs(o.y) <= 1);
  }
});

test('FX: o tremor some sozinho e reset zera tudo', () => {
  const FX = fx();
  FX.init();
  FX.shake(24);
  FX.update(16);
  const o = FX.shakeOffset();
  assert.ok(o.x !== 0 || o.y !== 0);
  FX.update(1000);                 // trauma decai 1,6 por segundo
  assert.deepEqual([FX.shakeOffset().x, FX.shakeOffset().y], [0, 0]);

  FX.burst(0, 0, { count: 10 });
  FX.hitstop(500);
  FX.reset();
  assert.equal(FX.count(), 0);
  assert.equal(FX.blocked(), false);
});

/* --------------------------------------------------------------- Áudio */

test('Áudio sem AudioContext: tudo vira no-op, nada lança exceção', () => {
  const A = audio();
  A.init();
  A.unlock();
  A.update();
  assert.equal(A.isSupported(), false);
  assert.equal(A.state(), 'none');
  for (const nome of ['eat', 'gold', 'powerup', 'levelUp', 'sector', 'shield', 'kill',
                      'death', 'portal', 'hunterAlert', 'uiMove', 'uiConfirm']) {
    assert.doesNotThrow(() => A.sfx[nome](3), nome);
  }
  A.music.start();
  assert.equal(A.music.isPlaying(), false, 'sem contexto a música não liga');
});

test('Áudio: mudo alterna mesmo sem contexto', () => {
  const A = audio();
  assert.equal(A.isMuted(), false);
  assert.equal(A.toggleMute(), true);
  assert.equal(A.isMuted(), true);
  A.setMuted(false);
  assert.equal(A.isMuted(), false);
});

test('Áudio: BPM = min(164, 112 + nível*2), stop volta ao começo', () => {
  const A = audio();
  assert.equal(A.music.getBpm(), 112);
  A.music.setLevel(10);
  assert.equal(A.music.getBpm(), 132);
  A.music.setLevel(40);
  assert.equal(A.music.getBpm(), 164);
  A.music.setIntensity(9);
  assert.equal(A.music.getIntensity(), 3);
  A.music.stop();
  assert.equal(A.music.getBpm(), 112);
  assert.equal(A.music.getIntensity(), 0);
  A.music.setLevel(0);
  assert.equal(A.music.getBpm(), 112);
});
