/* ==========================================================================
   COBRONA :: PROTOCOLO NEON
   js/main.js  ->  bootstrap + loop principal (§11)

   Este arquivo não tem regra de jogo nenhuma. Ele faz três coisas:

     1. LIGA os módulos na ordem certa (§11) depois que o DOM existe.
     2. RODA o loop de frame: Audio -> FX -> Game -> Renderer -> UI -> Input.
     3. TRADUZ os one-shots do Input em transições de estado do Game.

   Três decisões que valem mais que o código:

   A. O ESTADO É LIDO UMA VEZ POR FRAME. O ESPAÇO dispara 'start', 'pause' E
      'confirm' no mesmo keydown (input.js:224). Se lêssemos Game.state depois
      de cada ação, o mesmo ESPAÇO que começa a partida a pausaria no mesmo
      frame. Tirar um retrato do estado antes de tratar qualquer tecla mata
      essa classe inteira de bug.

   B. O REINÍCIO NO GAME OVER É TRAVADO ATÉ O CLÍMAX ACABAR. A morte tem
      slow-motion e explosão segmento a segmento (§4); quem morreu segurando
      ENTER pularia o melhor frame do jogo sem querer. Só liberamos quando a
      tela de fim já subiu (ver reinicioLiberado()).

   C. O FRAME INTEIRO É ENVOLVIDO EM try/catch. Um erro dentro do rAF vira,
      por padrão, 60 exceções por segundo numa tela congelada e muda. Aqui o
      primeiro erro para o loop, grita no console (o único console.error do
      projeto) e escreve o motivo na tela — em português, para o jogador.

   Nada de COBRA.CFG (ou outro módulo) no escopo de topo: as referências são
   resolvidas dentro de boot(), quando todos os <script> já executaram.
   ========================================================================== */
(function () {
  'use strict';

  window.COBRA = window.COBRA || {};

  /* ======================================================================
     ESTADO DO BOOTSTRAP
     ====================================================================== */

  var canvas = null;

  // Referências resolvidas em boot(). Cachear evita uma busca de propriedade
  // em window.COBRA por módulo por frame — barato, mas é o loop mais quente
  // do jogo e não custa nada fazer certo.
  var mAudio = null, mFX = null, mGame = null, mInput = null;
  var mRenderer = null, mUI = null, mBG = null, mUtil = null;

  var iniciado = false;      // boot() já rodou? (idempotência)
  var parado = false;        // loop abortado por erro fatal
  var rafId = 0;
  var last = 0;

  var DT_MAX = 50;           // clamp do dt (§11); sobrescrito por CFG.DT_MAX

  var gameoverMs = 0;        // tempo REAL desde que o estado virou 'gameover'
  var audioLiberado = false; // Audio.unlock() já foi chamado num gesto?

  var GAMEOVER_MIN_MS = 900;   // §4: o slow-motion da morte dura ~900ms
  var GAMEOVER_MAX_MS = 3000;  // rede de segurança: nunca prender o jogador

  var FONTE = 'ui-monospace, "JetBrains Mono", "Fira Code", Consolas, monospace';

  function agora() {
    return (window.performance && window.performance.now)
      ? window.performance.now() : Date.now();
  }

  function debugOn() {
    return !!(window.COBRA.CFG && window.COBRA.CFG.DEBUG);
  }

  /* ======================================================================
     ENTRADA DO JOGADOR -> MÁQUINA DE ESTADOS
     ====================================================================== */

  /**
   * Primeiro gesto do usuário: acorda o AudioContext.
   * Navegador nenhum tira um contexto de 'suspended' fora de um gesto, e o
   * contexto nasce suspenso mesmo quando criado antes. O input.js também faz
   * isso por conta própria; chamar duas vezes é inofensivo (é idempotente) e
   * garante o destravamento mesmo por um clique que não vire ação de jogo.
   */
  function liberarAudio() {
    if (audioLiberado) return;
    audioLiberado = true;
    desligarGestos();
    try {
      var A = window.COBRA.Audio;
      if (!A) return;
      if (A.init) A.init();
      if (A.unlock) A.unlock();
    } catch (e) { /* áudio é opcional: jamais derruba o bootstrap */ }
  }

  /** Música do menu. start() é idempotente (audio.js:776), então chamar a cada
      input não reinicia a batida — só religa depois de um toMenu(), que a para. */
  function musicaMenu() {
    var A = mAudio || window.COBRA.Audio;
    if (A && A.music && A.music.start) A.music.start();
  }

  function alternarMudo() {
    var mudo = false;
    if (mAudio) {
      if (mAudio.toggleMute) mudo = !!mAudio.toggleMute();
      if (mAudio.isMuted) mudo = !!mAudio.isMuted();
    }
    if (mUI && mUI.setMuted) mUI.setMuted(mudo);
    guardarMudo(mudo);
  }

  /** CFG.STORAGE_MUTE existe no config e nenhum outro módulo o usa; a
      persistência do mudo mora aqui para a preferência sobreviver ao F5. */
  function guardarMudo(v) {
    var C = window.COBRA.CFG;
    if (mUtil && mUtil.store && C && C.STORAGE_MUTE) mUtil.store.set(C.STORAGE_MUTE, v);
  }

  function restaurarMudo() {
    var C = window.COBRA.CFG;
    var mudo = false;
    if (mUtil && mUtil.store && C && C.STORAGE_MUTE) {
      mudo = !!mUtil.store.get(C.STORAGE_MUTE, false);
    }
    if (mAudio && mAudio.setMuted) mAudio.setMuted(mudo);
    if (mUI && mUI.setMuted) mUI.setMuted(mudo);
  }

  /**
   * O reinício só é aceito depois que a animação de morte entregou o clímax.
   * Casamos com o critério do próprio game.js (game.js:1128): a tela de fim
   * sobe quando deathTimer >= DEATH.SLOWMO_MS, o que equivale a deathAnim ter
   * passado de SLOWMO_MS/ANIM_MS. O teto de 3s é rede de segurança: se por
   * qualquer motivo a animação empacar, o jogador não fica preso na tela.
   */
  function reinicioLiberado() {
    if (gameoverMs >= GAMEOVER_MAX_MS) return true;

    var D = window.COBRA.CFG ? window.COBRA.CFG.DEATH : null;
    var minMs = (D && D.SLOWMO_MS > 0) ? D.SLOWMO_MS : GAMEOVER_MIN_MS;
    if (gameoverMs < minMs) return false;
    if (!D || !(D.ANIM_MS > 0)) return true;

    return (mGame.deathAnim || 0) >= (D.SLOWMO_MS / D.ANIM_MS);
  }

  function processarInput() {
    var I = mInput, G = mGame;
    if (!I || !G || !I.pressed) return;

    // M funciona em qualquer tela — inclusive no meio da animação de morte.
    if (I.pressed('mute')) alternarMudo();

    // Retrato do estado ANTES de qualquer ação (ver decisão A no cabeçalho).
    var st = G.state;

    if (st === 'menu') inputMenu(I, G);
    else if (st === 'playing') inputJogando(I, G);
    else if (st === 'paused') inputPausado(I, G);
    else if (st === 'gameover') inputGameOver(I, G);
  }

  function inputMenu(I, G) {
    var mexeu = false;

    if (I.pressed('up'))   { menuMove(-1); mexeu = true; }
    if (I.pressed('down')) { menuMove(1);  mexeu = true; }

    var comecar = I.pressed('start') || I.pressed('confirm');

    // Qualquer input no menu já vale como "o jogador chegou": destrava o áudio
    // e liga a música, para o menu não ser uma tela morta antes da partida.
    if (mexeu || comecar) { liberarAudio(); musicaMenu(); }

    if (comecar) G.start(modoEscolhido());
  }

  function menuMove(d) {
    if (mUI && mUI.menuMove) mUI.menuMove(d);
  }

  /** menuSelect() é o do contrato (§9.11) e ainda toca o blip de confirmação
      e persiste o modo; selectedMode() é o plano B. */
  function modoEscolhido() {
    var C = window.COBRA.CFG;
    var padrao = (C && C.DEFAULT_MODE) ? C.DEFAULT_MODE : 'classico';
    if (!mUI) return padrao;
    if (mUI.menuSelect) return mUI.menuSelect() || padrao;
    if (mUI.selectedMode) return mUI.selectedMode() || padrao;
    return padrao;
  }

  function inputJogando(I, G) {
    // ESC tem prioridade: sair é uma decisão consciente, pausar é reflexo.
    if (I.pressed('menu')) { G.toMenu(); return; }
    if (I.pressed('pause') || I.pressed('start')) G.togglePause();
  }

  function inputPausado(I, G) {
    if (I.pressed('menu')) { G.toMenu(); return; }
    if (I.pressed('start') || I.pressed('pause')) G.togglePause();
  }

  function inputGameOver(I, G) {
    if (I.pressed('menu')) { G.toMenu(); return; }
    if (!reinicioLiberado()) return;
    if (I.pressed('restart') || I.pressed('start') || I.pressed('confirm')) G.restart();
  }

  /* ======================================================================
     LOOP PRINCIPAL (§11)
     ====================================================================== */

  function frame(now) {
    rafId = 0;
    if (parado) return;

    try {
      // dt clampado: com a aba em segundo plano o rAF acumula segundos, e sem
      // o teto a cobra atravessaria meia arena no frame do retorno.
      var dt = now - last;
      if (!(dt > 0)) dt = 0;
      if (dt > DT_MAX) dt = DT_MAX;
      last = now;

      processarInput();

      // Relógio REAL da tela de fim (o de jogo está em slow-motion).
      if (mGame.state === 'gameover') gameoverMs += dt;
      else gameoverMs = 0;

      mAudio.update();
      mFX.update(dt);                       // sempre: FX consome o hitstop

      if (!mFX.blocked()) {
        // timeScale é 0.25 -> 1 durante a morte (§4). O Game espera o dt já
        // multiplicado; a guarda evita propagar NaN se algo o zerar.
        var ts = mGame.timeScale;
        if (!(ts > 0)) ts = 1;
        mGame.update(dt * ts);
      }

      // Renderer e UI recebem o dt REAL: brilho, rastros e barra de combo não
      // devem entrar em slow-motion junto com a simulação.
      mRenderer.render(mGame, dt);
      mUI.syncHUD(mGame);

      mInput.endFrame();
    } catch (err) {
      abortar(err);
      return;
    }

    rafId = requestAnimationFrame(frame);
  }

  /* ======================================================================
     FALHA FATAL
     ====================================================================== */

  function abortar(err) {
    if (parado) return;
    parado = true;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }

    // ÚNICO console.error do projeto: uma tela congelada e muda é o pior
    // desfecho possível, tanto para o jogador quanto para quem for depurar.
    if (window.console && window.console.error) {
      window.console.error('[COBRONA] erro fatal no frame — loop interrompido:', err);
    }

    var msg = (err && (err.message || String(err))) || 'erro desconhecido';
    try { pintarFalhaCanvas(msg); } catch (e) { /* já estamos no pior caso */ }
    try { pintarFalhaDOM(msg); } catch (e) { /* idem */ }
  }

  function cortar(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  /** Mensagem no canvas, em pixels de DISPOSITIVO (transform identidade): o
      transform de devicePixelRatio do Renderer pode estar em qualquer estado
      quando o erro acontece, e aqui não podemos depender de nada dele. */
  function pintarFalhaCanvas(msg) {
    if (!canvas || !canvas.getContext) return;
    var g = canvas.getContext('2d');
    if (!g) return;

    var w = canvas.width, h = canvas.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#04010c';
    g.fillRect(0, 0, w, h);

    var base = Math.max(12, Math.round(w / 46));
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    g.fillStyle = '#ff2b2b';
    g.font = 'bold ' + base + 'px ' + FONTE;
    g.fillText('FALHA NO PROTOCOLO', w * 0.5, h * 0.5 - base * 1.7);

    g.fillStyle = '#eaf6ff';
    g.font = Math.round(base * 0.6) + 'px ' + FONTE;
    g.fillText('Recarregue a página (F5) para tentar de novo.', w * 0.5, h * 0.5);

    g.fillStyle = '#7a6fa8';
    g.font = Math.round(base * 0.48) + 'px ' + FONTE;
    g.fillText(cortar(msg, 72), w * 0.5, h * 0.5 + base * 1.5);
  }

  /** As telas de UI (.screen.on) ficam POR CIMA do canvas, então a mensagem
      pintada nele pode estar escondida atrás do menu. Este overlay em DOM,
      com estilo inline (não depende do CSS do jogo), aparece sempre. */
  function pintarFalhaDOM(msg) {
    if (document.getElementById('erro-fatal')) return;
    var host = document.getElementById('app') || document.body;
    if (!host) return;

    var box = document.createElement('div');
    box.id = 'erro-fatal';
    box.setAttribute('role', 'alert');
    box.style.cssText =
      'position:absolute;inset:0;z-index:99;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;gap:1em;padding:2em;' +
      'text-align:center;background:rgba(4,1,12,0.94);color:#eaf6ff;' +
      'font-family:' + FONTE + ';';

    var t = document.createElement('strong');
    t.textContent = 'FALHA NO PROTOCOLO';
    t.style.cssText = 'font-size:1.7em;letter-spacing:0.2em;color:#ff2b2b;';

    var p1 = document.createElement('p');
    p1.textContent = 'O jogo foi interrompido. Recarregue a página (F5) para tentar de novo.';
    p1.style.cssText = 'margin:0;max-width:34em;line-height:1.5;';

    var p2 = document.createElement('p');
    p2.textContent = cortar(msg, 220);
    p2.style.cssText = 'margin:0;max-width:34em;line-height:1.4;color:#7a6fa8;' +
                       'font-size:0.85em;word-break:break-word;';

    box.appendChild(t);
    box.appendChild(p1);
    box.appendChild(p2);
    host.appendChild(box);
  }

  /* ======================================================================
     EVENTOS GLOBAIS
     ====================================================================== */

  function onResize() {
    // O Renderer já tem o próprio listener com throttle; esta chamada extra é
    // barata (só reescreve o transform quando o devicePixelRatio muda) e
    // garante o ajuste imediato mesmo se aquele listener não tiver subido.
    if (mRenderer && mRenderer.resize) mRenderer.resize();
  }

  /** Perder o foco com a partida rolando é morte garantida na volta. */
  function pausarPorFoco() {
    if (mGame && mGame.state === 'playing' && mGame.pause) mGame.pause();
  }

  function onVisibilidade() {
    if (document.hidden) pausarPorFoco();
  }

  function onGesto() { liberarAudio(); }

  function desligarGestos() {
    window.removeEventListener('keydown', onGesto, true);
    window.removeEventListener('pointerdown', onGesto, true);
    window.removeEventListener('touchstart', onGesto, true);
    window.removeEventListener('mousedown', onGesto, true);
  }

  function ligarEventosGlobais() {
    window.addEventListener('resize', onResize, false);
    window.addEventListener('blur', pausarPorFoco, false);
    document.addEventListener('visibilitychange', onVisibilidade, false);

    // Captura (true) + passive: só observamos o gesto para acordar o áudio,
    // sem interferir em quem realmente trata o evento (input.js).
    var opts = { passive: true, capture: true };
    window.addEventListener('keydown', onGesto, opts);
    window.addEventListener('pointerdown', onGesto, opts);
    window.addEventListener('touchstart', onGesto, opts);
    window.addEventListener('mousedown', onGesto, opts);
  }

  /* ======================================================================
     BOOTSTRAP
     ====================================================================== */

  /** O toque precisa chegar ao Input mesmo com uma tela de menu aberta: as
      telas (.screen.on) têm pointer-events:auto e cobrem o canvas inteiro
      (style.css:151), então um listener preso ao <canvas> nunca veria o tap
      que começa a partida. O palco (#app) é ancestral das duas coisas. */
  function alvoDeInput() {
    return document.getElementById('app') || canvas || document.body;
  }

  function boot() {
    if (iniciado) return;
    iniciado = true;

    canvas = document.getElementById('game');

    try {
      var C = window.COBRA.CFG;
      if (!C) throw new Error('COBRA.CFG não carregou: confira a ordem dos <script> do index.html (§8).');
      if (!canvas) throw new Error('Canvas #game não encontrado no DOM (§10).');

      mUtil = window.COBRA.Util;
      mAudio = window.COBRA.Audio;
      mInput = window.COBRA.Input;
      mFX = window.COBRA.FX;
      mGame = window.COBRA.Game;
      mBG = window.COBRA.BG;
      mRenderer = window.COBRA.Renderer;
      mUI = window.COBRA.UI;

      var faltando = [];
      if (!mUtil) faltando.push('Util');
      if (!mAudio) faltando.push('Audio');
      if (!mInput) faltando.push('Input');
      if (!mFX) faltando.push('FX');
      if (!mGame) faltando.push('Game');
      if (!mBG) faltando.push('BG');
      if (!mRenderer) faltando.push('Renderer');
      if (!mUI) faltando.push('UI');

      // Arena e as entidades não têm referência cacheada aqui (main.js não fala
      // com elas), mas §8 as exige e a ausência delas é pior que a dos outros:
      // game.js e renderer.js guardam TODO uso de Arena com `if (A)`, então um
      // arena.js que não subiu (zip extraído pela metade, arquivo renomeado — e
      // em file:// o <script src> que falha é silencioso) não quebra nada: o
      // jogo abre, anuncia 'SETOR 02 :: FIREWALL · MUROS INTERNOS' e simplesmente
      // nunca desenha um muro ou portal, para sempre, sem uma linha de aviso.
      // Conferir aqui transforma esse silêncio no mesmo 'FALHA NO PROTOCOLO' em
      // português dos demais módulos — e, no caso de entities.js, troca o
      // TypeError cru do navegador (em inglês, vindo de Game.init) por ele.
      if (!window.COBRA.Arena) faltando.push('Arena');
      if (!window.COBRA.Snake) faltando.push('Snake');
      if (!window.COBRA.Food) faltando.push('Food');
      if (!window.COBRA.Hunter) faltando.push('Hunter');

      if (faltando.length) {
        throw new Error('Módulos não carregados: COBRA.' + faltando.join(', COBRA.'));
      }

      DT_MAX = (C.DT_MAX > 0) ? C.DT_MAX : 50;

      // Ordem de §11. Audio primeiro (o contexto nasce suspenso, sem problema);
      // Renderer antes do BG porque resize() já dimensiona o canvas lógico.
      mAudio.init();
      mFX.init();
      mUI.init();
      mRenderer.init(canvas);
      mRenderer.resize();
      mBG.init(C.W, C.H);
      mInput.init(alvoDeInput());
      mGame.init();

      restaurarMudo();

      // game.js deixa o estado em 'menu' mas NÃO chama UI.show() no init
      // (game.js:274): sem esta linha o jogo abriria numa tela sem menu,
      // porque toda tela só aparece com a classe .on (style.css:134).
      if (mGame.state === 'menu' && mUI.show) {
        mUI.show('menu');
        if (mUI.renderScores) mUI.renderScores();
      }

      ligarEventosGlobais();

      last = agora();
      rafId = requestAnimationFrame(frame);

      if (debugOn() && window.console) {
        window.console.log('[COBRONA] pronto —', C.VERSION || '?', '| dtMax', DT_MAX);
      }
    } catch (err) {
      abortar(err);
    }
  }

  // Os <script> estão no fim do <body>, então na prática o DOM já está pronto;
  // o listener existe para o caso de alguém mover a tag para o <head>.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, false);
  } else {
    boot();
  }

  /* Superfície mínima para depuração no console (não é contrato de §9). */
  window.COBRA.Main = {
    boot: boot,
    rodando: function () { return !parado && iniciado; },
    parar: function () {
      parado = true;
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    }
  };
})();
