/* =====================================================================
   COBRONA :: PROTOCOLO NEON — js/core/input.js  ->  COBRA.Input
   ---------------------------------------------------------------------
   Camada de entrada: teclado, toque (swipe/tap) e gamepad opcional.

   Duas responsabilidades bem separadas:

   1) FILA DE DIREÇÕES (§2 "BUFFER DE INPUT")
      Fila de no máximo 2 direções, consumida a UMA por tick pelo Game.
      O filtro de inversa acontece na ENTRADA da fila e é comparado contra
      a ÚLTIMA direção da fila (ou contra a direção de referência, se a fila
      estiver vazia) — nunca contra a direção atual da cobra. É exatamente
      isso que mata a morte clássica de "virei duas vezes rápido demais":
      indo para a DIREITA, CIMA + ESQUERDA em 20ms vira uma curva legítima,
      porque ESQUERDA é comparada contra CIMA (a última da fila) e não
      contra DIREITA.

   2) ONE-SHOTS
      Ações de borda ('start', 'pause', ...) marcadas no keydown e apagadas
      por endFrame(). Quem lê é o main.js, uma vez por frame.

   Nada é lido de COBRA.CFG/COBRA.Util no escopo de topo: a ordem de carga
   dos scripts não pode quebrar este arquivo.
   ===================================================================== */

(function () {
  'use strict';

  window.COBRA = window.COBRA || {};

  /* ------------------------------------------------------------------
     Constantes locais de toque/gamepad (§7)
     ------------------------------------------------------------------ */
  var SWIPE_MIN   = 24;   // px para um arrasto virar swipe
  var TAP_MAX_PX  = 12;   // px máximos de deslocamento para contar como tap
  var TAP_MAX_MS  = 300;  // duração máxima do tap
  var PAD_DEAD    = 0.5;  // zona morta do analógico esquerdo

  /* Fallback usado só se Util ainda não existir (não deve acontecer, mas
     evita um TypeError fatal caso alguém chame Input antes da hora). */
  var LOCAL_DIRS = {
    UP:    { x: 0,  y: -1 },
    DOWN:  { x: 0,  y: 1 },
    LEFT:  { x: -1, y: 0 },
    RIGHT: { x: 1,  y: 0 }
  };

  var _dirs = null;

  /* Resolve COBRA.Util.DIRS UMA vez, em tempo de execução (nunca no topo).
     Usar os MESMOS objetos que o resto do jogo importa para que comparações
     por identidade continuem valendo em qualquer módulo. */
  function dirs() {
    if (!_dirs) {
      _dirs = (window.COBRA.Util && window.COBRA.Util.DIRS) || LOCAL_DIRS;
    }
    return _dirs;
  }

  /* Normaliza qualquer {x,y} para o objeto canônico correspondente.
     Devolver sempre a mesma referência deixa o dedupe da fila trivial. */
  function canon(d) {
    if (!d) return null;
    var D = dirs();
    if (d.x === 0  && d.y === -1) return D.UP;
    if (d.x === 0  && d.y === 1)  return D.DOWN;
    if (d.x === -1 && d.y === 0)  return D.LEFT;
    if (d.x === 1  && d.y === 0)  return D.RIGHT;
    return null;
  }

  function opposite(a, b) {
    return !!a && !!b && a.x === -b.x && a.y === -b.y;
  }

  function debugOn() {
    return !!(window.COBRA.CFG && window.COBRA.CFG.DEBUG);
  }

  /* ------------------------------------------------------------------
     Estado do módulo
     ------------------------------------------------------------------ */
  var queue   = [];     // até 2 direções canônicas
  var refDir  = null;   // direção de referência p/ o filtro de inversa
  var down    = {};     // teclas fisicamente pressionadas (limpo no blur)
  var target  = null;   // elemento que recebe o toque
  var started = false;  // init() já rodou? (idempotência)
  var audioUnlocked = false;

  /* One-shots: objeto FIXO, sempre as mesmas chaves. Reutilizar o objeto e
     só zerar os booleanos evita alocação por frame no endFrame(). */
  var once = {
    start: false, pause: false, restart: false, menu: false, mute: false,
    up: false, down: false, left: false, right: false, confirm: false
  };
  var ONCE_KEYS = Object.keys(once);

  /* Toque */
  var touchId = null, tX = 0, tY = 0, tT = 0, tSwiped = false;

  /* Gamepad: guarda o estado anterior para gerar bordas (one-shots) */
  var padDir = null, padBtn = {};

  /* ------------------------------------------------------------------
     Fila de direções
     ------------------------------------------------------------------ */

  function pushDir(dir) {
    var d = canon(dir);
    if (!d) return false;

    // Referência: a última da fila; se vazia, a última direção conhecida.
    var ref = queue.length ? queue[queue.length - 1] : refDir;
    if (ref) {
      if (d === ref) return false;         // repetida: não ocupa espaço na fila
      if (opposite(d, ref)) return false;  // inversa: descartada na ENTRADA
    }
    if (queue.length >= 2) return false;   // limite duro de 2

    queue.push(d);
    return true;
  }

  function nextDir(currentDir) {
    var cur = canon(currentDir);
    // Mantém a referência viva mesmo quando a fila esvazia: sem isso, um
    // toque logo após o tick compararia contra uma direção obsoleta.
    if (cur) refDir = cur;

    while (queue.length) {
      var d = queue.shift();
      // Rede de segurança: a inversa já foi barrada na entrada, mas o Game
      // pode ter mudado a direção por conta própria (portal, respawn).
      if (cur && (d === cur || opposite(d, cur))) continue;
      refDir = d;
      return d;
    }
    return null;
  }

  function clearQueue() {
    queue.length = 0;
    refDir = null; // partida nova: nada de herdar a direção da run anterior
  }

  /* ------------------------------------------------------------------
     One-shots
     ------------------------------------------------------------------ */

  function fire(action) {
    once[action] = true;
  }

  function pressed(action) {
    return once[action] === true;
  }

  function clearOnce() {
    for (var i = 0; i < ONCE_KEYS.length; i++) once[ONCE_KEYS[i]] = false;
  }

  /* ------------------------------------------------------------------
     Teclado (§7)
     ------------------------------------------------------------------ */

  /* Teclas cujo comportamento padrão do navegador atrapalha:
     setas e espaço rolam a página, WASD/P/M podem virar atalho de extensão. */
  function shouldPrevent(e) {
    switch (e.key) {
      case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight':
      case ' ': case 'Spacebar':
        return true;
    }
    if (e.code === 'Space') return true;
    var k = (e.key || '').toLowerCase();
    return k === 'w' || k === 'a' || k === 's' || k === 'd' ||
           k === 'p' || k === 'm';
  }

  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    // O AudioContext só sai de 'suspended' dentro de um gesto do usuário;
    // este é o primeiro ponto do jogo que roda dentro de um.
    try {
      if (window.COBRA.Audio) {
        if (window.COBRA.Audio.init) window.COBRA.Audio.init();
        if (window.COBRA.Audio.unlock) window.COBRA.Audio.unlock();
      }
    } catch (err) { /* áudio é opcional: nunca derruba o input */ }
  }

  function onKeyDown(e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return; // não sequestrar atalhos

    if (shouldPrevent(e)) e.preventDefault();

    // Auto-repetição do SO não gera one-shot nem entra na fila: um dedo
    // parado no ArrowLeft não pode encher o buffer nem repetir 'pause'.
    if (e.repeat) return;

    var key = e.key;
    var k = (key || '').toLowerCase();
    down[e.code || key] = true;
    unlockAudio();

    var D = dirs();

    if (key === 'ArrowUp' || k === 'w') {
      pushDir(D.UP); fire('up'); return;
    }
    if (key === 'ArrowDown' || k === 's') {
      pushDir(D.DOWN); fire('down'); return;
    }
    if (key === 'ArrowLeft' || k === 'a') {
      pushDir(D.LEFT); fire('left'); return;
    }
    if (key === 'ArrowRight' || k === 'd') {
      pushDir(D.RIGHT); fire('right'); return;
    }

    if (key === ' ' || key === 'Spacebar' || e.code === 'Space') {
      // Espaço é polivalente (§7): começar / pausar / continuar / confirmar.
      fire('start'); fire('pause'); fire('confirm'); return;
    }
    if (key === 'Enter') { fire('restart'); fire('confirm'); return; }
    if (key === 'Escape' || key === 'Esc') { fire('menu'); return; }
    if (k === 'p') { fire('pause'); return; }
    if (k === 'm') { fire('mute'); return; }
  }

  function onKeyUp(e) {
    delete down[e.code || e.key];
  }

  /* Alt-tab / clique fora: solta tudo. Sem isso, a tecla fica "presa" e o
     jogador volta com a cobra andando sozinha ou com um toggle travado. */
  function onBlur() {
    down = {};
    clearOnce();
    touchId = null;
    padDir = null;
    padBtn = {};
  }

  /* ------------------------------------------------------------------
     Toque: swipe (direção) e tap (começar/confirmar) — §7
     ------------------------------------------------------------------ */

  function onTouchStart(e) {
    if (touchId !== null) return;          // ignora dedos extras
    var t = e.changedTouches[0];
    touchId = t.identifier;
    tX = t.clientX; tY = t.clientY;
    tT = (window.performance ? performance.now() : Date.now());
    tSwiped = false;
    unlockAudio();
    e.preventDefault();                    // mata scroll/zoom/duplo-toque
  }

  function findTouch(list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].identifier === touchId) return list[i];
    }
    return null;
  }

  function onTouchMove(e) {
    if (touchId === null) return;
    var t = findTouch(e.changedTouches);
    if (!t) return;
    e.preventDefault();
    if (tSwiped) return;                   // um swipe por toque

    var dx = t.clientX - tX;
    var dy = t.clientY - tY;
    if (Math.abs(dx) < SWIPE_MIN && Math.abs(dy) < SWIPE_MIN) return;

    var D = dirs();
    // Eixo dominante vence: diagonais viram o movimento mais óbvio.
    if (Math.abs(dx) >= Math.abs(dy)) pushDir(dx > 0 ? D.RIGHT : D.LEFT);
    else                              pushDir(dy > 0 ? D.DOWN  : D.UP);
    tSwiped = true;
  }

  function onTouchEnd(e) {
    if (touchId === null) return;
    var t = findTouch(e.changedTouches);
    if (!t) return;
    e.preventDefault();

    if (!tSwiped) {
      var now = (window.performance ? performance.now() : Date.now());
      var dx = t.clientX - tX, dy = t.clientY - tY;
      if (Math.abs(dx) < TAP_MAX_PX && Math.abs(dy) < TAP_MAX_PX &&
          (now - tT) < TAP_MAX_MS) {
        fire('start'); fire('confirm');
      }
    }
    touchId = null;
  }

  function onTouchCancel() {
    touchId = null;
  }

  /* ------------------------------------------------------------------
     Gamepad (opcional, best-effort) — lido em poll(), via endFrame()
     ------------------------------------------------------------------ */

  function padEdge(name, isDown) {
    var was = padBtn[name] === true;
    padBtn[name] = isDown;
    return isDown && !was;   // só a borda de subida vira one-shot
  }

  function poll() {
    if (!navigator || !navigator.getGamepads) return;
    var pads;
    try { pads = navigator.getGamepads(); } catch (err) { return; }
    if (!pads) return;

    var gp = null;
    for (var i = 0; i < pads.length; i++) {
      if (pads[i] && pads[i].connected !== false) { gp = pads[i]; break; }
    }
    if (!gp) { padDir = null; padBtn = {}; return; }

    var D = dirs();
    var b = gp.buttons || [];
    var ax = gp.axes || [];

    function held(idx) {
      var btn = b[idx];
      if (!btn) return false;
      return (typeof btn === 'object') ? (btn.pressed || btn.value > 0.5)
                                       : btn > 0.5;
    }

    /* Direção: d-pad (12..15) ou analógico esquerdo com zona morta. */
    var dir = null;
    if (held(12)) dir = D.UP;
    else if (held(13)) dir = D.DOWN;
    else if (held(14)) dir = D.LEFT;
    else if (held(15)) dir = D.RIGHT;
    else {
      var x = ax[0] || 0, y = ax[1] || 0;
      if (Math.abs(x) > PAD_DEAD || Math.abs(y) > PAD_DEAD) {
        if (Math.abs(x) >= Math.abs(y)) dir = x > 0 ? D.RIGHT : D.LEFT;
        else                            dir = y > 0 ? D.DOWN  : D.UP;
      }
    }
    // Só na MUDANÇA: segurar o analógico não deve inundar a fila a 60Hz.
    if (dir && dir !== padDir) {
      pushDir(dir);
      if (dir === D.UP) fire('up');
      else if (dir === D.DOWN) fire('down');
      else if (dir === D.LEFT) fire('left');
      else fire('right');
    }
    padDir = dir;

    if (padEdge('a', held(0)))     { fire('confirm'); fire('start'); }
    if (padEdge('b', held(1)))     { fire('menu'); }
    if (padEdge('start', held(9))) { fire('start'); fire('pause'); }
  }

  /* ------------------------------------------------------------------
     Ciclo de frame
     ------------------------------------------------------------------ */

  function endFrame() {
    // Ordem importa: limpa os one-shots do frame que acabou e SÓ ENTÃO lê o
    // gamepad, para que o que ele disparar sobreviva o frame inteiro seguinte.
    clearOnce();
    try { poll(); } catch (err) { /* gamepad quebrado não derruba o jogo */ }
  }

  /* ------------------------------------------------------------------
     init
     ------------------------------------------------------------------ */

  function init(targetEl) {
    if (started) return;
    started = true;

    target = targetEl || document.body;

    window.addEventListener('keydown', onKeyDown, { passive: false });
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    // passive:false é obrigatório: sem isso o navegador ignora o
    // preventDefault e a página rola/faz zoom durante o swipe.
    var opts = { passive: false };
    target.addEventListener('touchstart', onTouchStart, opts);
    target.addEventListener('touchmove', onTouchMove, opts);
    target.addEventListener('touchend', onTouchEnd, opts);
    target.addEventListener('touchcancel', onTouchCancel, opts);

    // Menu de contexto no toque longo atrapalha mais do que ajuda.
    target.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    clearQueue();
    clearOnce();

    if (debugOn() && window.console) {
      console.log('[COBRA.Input] pronto', target.id || target.tagName);
    }
  }

  /* ------------------------------------------------------------------
     API pública (§9.4)
     ------------------------------------------------------------------ */
  COBRA.Input = {
    init: init,
    pushDir: pushDir,
    nextDir: nextDir,
    pressed: pressed,
    endFrame: endFrame,
    clearQueue: clearQueue,

    // extras (não substituem nada do contrato)
    poll: poll,
    isDown: function (code) { return down[code] === true; },
    queueLength: function () { return queue.length; }
  };
})();
