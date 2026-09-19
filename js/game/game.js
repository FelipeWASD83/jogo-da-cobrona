/* ==========================================================================
   COBRONA :: PROTOCOLO NEON
   js/game/game.js  ->  COBRA.Game

   A máquina de estados e TODA a regra do jogo (§2, §3, §4). Este é o único
   arquivo que sabe o que é "morrer", "pontuar" ou "subir de setor": Snake,
   Food, Hunter e Arena são deliberadamente burros.

   Três decisões estruturais que valem mais que o código:

   1. ACUMULADOR DE TICK. A simulação é discreta (tickMs), o render é
      contínuo. update() acumula dt e roda no MÁXIMO 3 ticks por frame — sem
      esse teto, um travamento de 500ms viraria uma avalanche de ticks
      ("espiral da morte") e a cobra teleportaria para dentro de um muro.
      O resto vira tickProgress (0..1), que o renderer usa para interpolar.

   2. ORDEM DENTRO DO TICK. Quase todo bug clássico de cobrinha nasce aqui:
        (1) direção (UMA por tick)  (2) passo  (3) colisões  (4) comida
        (5) caçadores               (6) colisão com caçador DE NOVO
        (7) timers/ímã              (8) progressão de setor
      O passo (6) existe porque sem ele o caçador atravessa a cabeça: ele se
      move DEPOIS de (3), então uma checagem só no começo do tick deixaria
      o drone passar por dentro do jogador sem encostar.

   3. COLISÃO NÃO LETAL É "REBOBINAR". Escudo, ZEN e i-frames restauram o
      corpo inteiro a partir de snake.prev em vez de só empurrar a cabeça.
      Empurrar a cabeça para cima do pescoço duplicaria um segmento e o
      duplicado se propagaria pelo corpo para sempre; rebobinar é exato.
      E rebobinar também garante que a cabeça NUNCA fique fora da grade —
      um head.x = -1 durante i-frames seria fatal para o renderer.

   Nada de COBRA.CFG / COBRA.Util no escopo de topo: só dentro de funções.
   ========================================================================== */
(function () {
  'use strict';

  window.COBRA = window.COBRA || {};

  /* ======================================================================
     ACESSO TARDIO AOS MÓDULOS
     Tudo resolvido em tempo de execução (§8, regra de ouro). As chamadas a
     UI/Audio são embrulhadas porque esses módulos carregam DEPOIS deste
     arquivo — e um erro de UI jamais pode derrubar a simulação.
     ====================================================================== */

  function cfg()   { return window.COBRA.CFG; }
  function util()  { return window.COBRA.Util; }
  function fxm()   { return window.COBRA.FX; }
  function arena() { return window.COBRA.Arena; }

  function uiCall(name, a, b, c) {
    var U = window.COBRA.UI;
    if (!U || typeof U[name] !== 'function') return;
    try { U[name](a, b, c); } catch (e) { warn('UI.' + name, e); }
  }

  function sfx(name, arg) {
    var A = window.COBRA.Audio;
    if (!A || !A.sfx || typeof A.sfx[name] !== 'function') return;
    try { A.sfx[name](arg); } catch (e) { warn('sfx.' + name, e); }
  }

  function music(name, arg) {
    var A = window.COBRA.Audio;
    if (!A || !A.music || typeof A.music[name] !== 'function') return;
    try { A.music[name](arg); } catch (e) { warn('music.' + name, e); }
  }

  function warn(what, e) {
    var C = cfg();
    if (C && C.DEBUG && window.console) window.console.warn('[Game]', what, e);
  }

  function nowMs() {
    return (window.performance && window.performance.now)
      ? window.performance.now() : Date.now();
  }

  /* ======================================================================
     CONSTANTES LOCAIS
     Só o que NÃO existe no CFG (não posso editar config.js). Documentadas
     com a origem no doc para ninguém achar que é número mágico.
     ====================================================================== */

  var MAX_TICKS_FRAME = 3;      // teto anti-espiral-da-morte
  var FURY_WALL_PTS = 25;       // FÚRIA destruindo muro (§3.3, tabela de FÚRIA)
  var POWER_BANNER_MS = 1400;   // banner do nome do power-up (§4, "nome no centro")

  /* ======================================================================
     ESTADO INTERNO (nada disso é contrato)
     ====================================================================== */

  var modeCfg = null;           // CFG.MODES[mode] em cache
  var foodsEaten = 0;           // base do nível (§2: 1 nível a cada 5 comidas)
  var pauseAt = 0;              // instante da pausa (compensa o TTL da comida)
  var lastRecord = false;       // resultado de saveRecord(), lido pela UI
  var overShown = false;        // showGameOver já foi chamado nesta morte?

  var deathTimer = 0;           // ms de animação de morte já corridos
  var deathBurstAcc = 0;        // acumulador da explosão segmento a segmento
  var deathSeg = 0;             // próximo segmento a explodir

  var hunterPool = [];          // caçadores reciclados (zero alocação em jogo)
  var protBuf = [];             // células protegidas (reusado por Arena.build)
  var freeBuf = [];             // índices de células livres (reusado no spawn)
  var freeN = 0;

  // Objeto de contexto do snake.step(): reusado para não alocar por tick.
  var stepCtx = { wrap: false, arena: null };

  /* ======================================================================
     API PÚBLICA (§9.8) — TODOS os nomes abaixo são contrato
     ====================================================================== */

  var Game = {
    state: 'menu',              // 'menu' | 'playing' | 'paused' | 'gameover'
    mode: 'classico',

    score: 0,
    best: 0,
    level: 0,
    sector: 0,

    combo: 0,
    comboMs: 0,
    mult: 1,

    snake: null,
    food: null,                 // UM objeto (ou null)
    hunters: [],

    power: { ghost: 0, magnet: 0, slow: 0, fury: 0, shield: false },

    tickMs: 130,
    tickAcc: 0,
    tickProgress: 0,
    timeScale: 1,               // main.js multiplica o dt por isto
    invulnMs: 0,

    stats: {
      maxLen: 0, maxCombo: 0, timeMs: 0, sector: 0, cause: null,
      // extras para a UI não precisar cruzar dados com o Game:
      score: 0, mode: 'classico', level: 0, isRecord: false
    },

    deathAnim: 0,

    // extras públicos (não substituem nada do contrato)
    tick: 0,
    foodsEaten: 0
  };

  /* ======================================================================
     HELPERS DE GRADE
     ====================================================================== */

  function gw() { var C = cfg(); return C ? C.GRID_W : 30; }
  function gh() { var C = cfg(); return C ? C.GRID_H : 20; }

  /** Centro em pixels de MUNDO de uma célula — FX fala nessa unidade (§9.5). */
  function wx(cx) { var C = cfg(); return cx * C.CELL + C.HALF; }
  function wy(cy) { var C = cfg(); return cy * C.CELL + C.HALF; }

  /** Célula livre para SPAWN: dentro da grade, sem muro, sem portal, sem
      cobra e sem caçador. É o filtro de §3.2 e também do destino do ÍMÃ. */
  function cellFree(x, y) {
    if (x < 0 || y < 0 || x >= gw() || y >= gh()) return false;
    var A = arena();
    if (A && A.isBlocked(x, y)) return false;
    if (Game.snake && Game.snake.hits(x, y, false)) return false;
    var hs = Game.hunters;
    for (var i = 0; i < hs.length; i++) {
      if (hs[i].alive && hs[i].x === x && hs[i].y === y) return false;
    }
    return true;
  }

  /** Preenche freeBuf com os índices (y*W+x) das células livres, opcionalmente
      só as que estão a `minDist` (Manhattan) ou mais da cabeça. O buffer é
      reusado: spawn não aloca array novo. -> quantidade encontrada. */
  function collectFree(minDist) {
    var U = util();
    var W = gw(), H = gh();
    var h = Game.snake ? Game.snake.head() : null;
    freeN = 0;
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        if (!cellFree(x, y)) continue;
        if (minDist > 0 && h && U.manhattan(x, y, h.x, h.y) < minDist) continue;
        freeBuf[freeN++] = y * W + x;
      }
    }
    return freeN;
  }

  /** Células que a Arena JAMAIS pode transformar em muro: o corpo inteiro
      mais as 3 células à frente da cabeça (§3.4 — a reconstrução não pode
      matar o jogador nem plantar um muro no caminho já comprometido). */
  function protectedCells() {
    var U = util();
    var W = gw(), H = gh();
    var S = Game.snake;
    var n = 0, i, o;

    for (i = 0; i < S.cells.length; i++) {
      o = protBuf[n]; if (!o) { o = { x: 0, y: 0 }; protBuf[n] = o; }
      o.x = S.cells[i].x; o.y = S.cells[i].y;
      n++;
    }
    var h = S.head(), d = S.dir;
    for (i = 1; i <= 3; i++) {
      o = protBuf[n]; if (!o) { o = { x: 0, y: 0 }; protBuf[n] = o; }
      // wrap: com FANTASMA a cabeça pode sair pelo outro lado, e a célula
      // protegida tem que ser a mesma que ela vai realmente ocupar.
      o.x = U.wrap(h.x + d.x * i, W);
      o.y = U.wrap(h.y + d.y * i, H);
      n++;
    }
    protBuf.length = n;
    return protBuf;
  }

  /** Overrides de arena por modo: o ZEN não tem muro nem portal (§3.7). */
  function arenaOpts() {
    if (modeCfg && modeCfg.muros === false) return { muros: false, portais: false };
    return null;
  }

  /* ======================================================================
     RITMO (§2)
     ====================================================================== */

  /** tickMs efetivo = base do nível x (slow ? 1.8 : 1) x (fury ? 0.6 : 1).
      Chamado sempre que nível ou power-up mudam — nunca por frame. */
  function recomputeTick() {
    var C = cfg();
    var base = C.tickFor(Game.level, modeCfg ? modeCfg.tickBase : C.TICK_BASE);
    if (Game.power.slow > 0) base *= C.SLOW_TICK_MULT;
    if (Game.power.fury > 0) base *= C.FURY_TICK_MULT;

    var old = Game.tickMs;
    Game.tickMs = base;

    // Preserva a FRAÇÃO do tick em andamento em vez do valor absoluto: sem
    // isso, ativar a FÚRIA no meio de um tick dispararia um tick instantâneo
    // (tickAcc > novo tickMs) e a cobra daria um pulo.
    if (old > 0 && Game.tickAcc > 0) Game.tickAcc = (Game.tickAcc / old) * base;
    if (Game.tickAcc > base) Game.tickAcc = base;
  }

  /* ======================================================================
     CICLO DE VIDA (§9.8)
     ====================================================================== */

  Game.init = function () {
    var C = cfg(), U = util();
    if (!C || !U) return;

    var F = fxm();
    if (F && F.init) F.init();

    var A = arena();
    if (A) A.reset();

    modeCfg = C.MODES[C.DEFAULT_MODE];
    Game.mode = C.DEFAULT_MODE;
    Game.best = loadBest();

    // A cobra existe desde o menu: o renderer nunca precisa tratar snake null.
    Game.snake = new window.COBRA.Snake(gw() >> 1, gh() >> 1, C.START_DIR);
    Game.food = null;
    Game.hunters.length = 0;

    Game.state = 'menu';
    Game.timeScale = 1;
    Game.tickAcc = 0;
    Game.tickProgress = 0;
    Game.deathAnim = 0;
    recomputeTick();
  };

  /** @param {string} mode 'classico' | 'caos' | 'zen' */
  Game.start = function (mode) {
    var C = cfg(), U = util(), A = arena(), F = fxm();
    if (!C || !U) return;

    var id = (mode && C.MODES[mode]) ? mode : C.DEFAULT_MODE;
    modeCfg = C.MODES[id];
    Game.mode = id;
    U.store.set(C.STORAGE_MODE, id);

    // --- placar e progressão ---
    Game.score = 0;
    Game.level = 0;
    Game.sector = modeCfg.startSector | 0;
    Game.combo = 0;
    Game.comboMs = 0;
    Game.mult = 1;
    foodsEaten = 0;
    Game.foodsEaten = 0;

    // --- power-ups: objeto MUTADO, nunca trocado (a UI guarda a referência) ---
    Game.power.ghost = 0;
    Game.power.magnet = 0;
    Game.power.slow = 0;
    Game.power.fury = 0;
    Game.power.shield = false;
    Game.invulnMs = 0;

    // --- tempo ---
    Game.tick = 0;
    Game.tickAcc = 0;
    Game.tickProgress = 0;
    Game.timeScale = 1;
    Game.deathAnim = 0;
    deathTimer = 0; deathBurstAcc = 0; deathSeg = 0;
    overShown = false; lastRecord = false;

    // --- stats ---
    Game.stats.maxLen = C.START_LEN;
    Game.stats.maxCombo = 0;
    Game.stats.timeMs = 0;
    Game.stats.sector = Game.sector;
    Game.stats.cause = null;
    Game.stats.score = 0;
    Game.stats.mode = id;
    Game.stats.level = 0;
    Game.stats.isRecord = false;

    // --- entidades ---
    if (!Game.snake) Game.snake = new window.COBRA.Snake(gw() >> 1, gh() >> 1, C.START_DIR);
    else Game.snake.reset(gw() >> 1, gh() >> 1, C.START_DIR);

    recycleHunters();
    Game.food = null;

    if (F) F.reset();
    if (A) A.build(Game.sector, protectedCells(), arenaOpts());

    ensureHunters(desiredHunters());
    spawnFood();

    var I = window.COBRA.Input;
    if (I && I.clearQueue) I.clearQueue();

    recomputeTick();
    Game.state = 'playing';

    music('setLevel', 0);
    music('setIntensity', C.intensityFor(Game.sector));
    music('start');

    uiCall('show', 'game');
    var info = C.sectorInfo(Game.sector);
    uiCall('banner', info.nome, modeCfg.nome, C.SECTOR_BANNER_MS);
  };

  Game.restart = function () {
    Game.start(Game.mode);
  };

  Game.pause = function () {
    if (Game.state !== 'playing') return;
    Game.state = 'paused';
    pauseAt = nowMs();
    // A música não para: só recolhe até a camada de baixo. Recomeçar o
    // scheduler a cada pausa faria a batida "resetar" e soar como bug.
    music('setIntensity', 0);
    uiCall('show', 'pause');
  };

  Game.resume = function () {
    var C = cfg();
    if (Game.state !== 'paused') return;

    // A comida usa o relógio de parede (o renderer também consulta o TTL sem
    // argumento). Empurrar `born` pelo tempo pausado impede que uma dourada
    // expire enquanto o jogo estava congelado.
    if (Game.food && pauseAt) Game.food.born += nowMs() - pauseAt;
    pauseAt = 0;

    // O `onKeyDown` do Input empilha direção em qualquer estado, e a pausa
    // pode chegar sem aviso (perda de foco). Sem limpar aqui, a curva que
    // ficou pendente antes da pausa — ou as setas apertadas com a tela
    // PAUSADO aberta — disparariam no primeiro tick do resume, matando o
    // jogador por um comando que ele não vê acontecer. Limpar no resume (e
    // não no pause) cobre os dois casos. `refDir` volta a ser estabelecida
    // pelo `nextDir(S.dir)` do próximo tick, a partir da direção atual.
    var I = window.COBRA.Input;
    if (I && I.clearQueue) I.clearQueue();

    Game.state = 'playing';
    music('setIntensity', C.intensityFor(Game.sector));
    uiCall('show', 'game');
  };

  Game.togglePause = function () {
    if (Game.state === 'playing') Game.pause();
    else if (Game.state === 'paused') Game.resume();
  };

  Game.toMenu = function () {
    var F = fxm();
    Game.state = 'menu';
    Game.timeScale = 1;
    Game.tickAcc = 0;
    Game.tickProgress = 0;
    Game.food = null;
    recycleHunters();
    if (F) F.reset();
    music('stop');
    uiCall('show', 'menu');
    uiCall('renderScores');
  };

  /* ======================================================================
     UPDATE (§11 chama com dt JÁ multiplicado por timeScale)
     ====================================================================== */

  Game.update = function (dt) {
    var C = cfg(), U = util();
    if (!C || !U) return;
    if (!(dt > 0)) dt = 0;

    // A animação de morte PRECISA continuar depois que o state vira
    // 'gameover' — é ela que devolve o timeScale para 1.
    if (Game.state === 'gameover') { updateDeath(dt); return; }

    // 'menu' e 'paused': nenhuma simulação. Nem tempo, nem tick, nem timers.
    if (Game.state !== 'playing') return;

    Game.stats.timeMs += dt;

    updateTimers(dt);

    // Materialização do caçador no tempo DE JOGO: assim ela congela junto
    // com hitstop/slow-mo em vez de correr no relógio de parede.
    var hs = Game.hunters;
    for (var i = 0; i < hs.length; i++) hs[i].updateSpawn(dt);

    Game.snake.updateWaves(dt);

    // --- acumulador de tick, com teto anti-espiral (§2) ---
    Game.tickAcc += dt;
    var guard = 0;
    while (Game.tickAcc >= Game.tickMs) {
      if (guard >= MAX_TICKS_FRAME) {
        // Descarta o atraso acumulado: melhor perder ticks do que entregar
        // um frame com a cobra 5 células adiante do que o jogador viu.
        Game.tickAcc = Game.tickMs;
        break;
      }
      Game.tickAcc -= Game.tickMs;
      guard++;
      doTick();
      if (Game.state !== 'playing') { Game.tickAcc = 0; break; }
    }

    Game.tickProgress = U.clamp(Game.tickAcc / Game.tickMs, 0, 1);
  };

  /* ----------------------------------------------------------------------
     Timers contínuos (combo, i-frames, power-ups)
     Decrementados por dt e não por tick: a barra de combo do HUD drena em
     2500ms REAIS (§3.1) e não em "quantos ticks couberem em 2500ms", que
     mudaria de velocidade junto com o nível.
     ---------------------------------------------------------------------- */

  function updateTimers(dt) {
    var C = cfg();
    var P = Game.power;
    var recompute = false;

    if (Game.comboMs > 0) {
      Game.comboMs -= dt;
      if (Game.comboMs <= 0) {
        Game.comboMs = 0;
        Game.combo = 0;      // HUD honesto: janela fechada, multiplicador cai
        Game.mult = 1;
      }
    }

    if (Game.invulnMs > 0) {
      Game.invulnMs -= dt;
      if (Game.invulnMs < 0) Game.invulnMs = 0;
    }

    if (P.ghost > 0)  { P.ghost -= dt;  if (P.ghost < 0)  P.ghost = 0; }
    if (P.magnet > 0) { P.magnet -= dt; if (P.magnet < 0) P.magnet = 0; }

    if (P.slow > 0) {
      P.slow -= dt;
      if (P.slow <= 0) { P.slow = 0; recompute = true; }
    }
    if (P.fury > 0) {
      P.fury -= dt;
      if (P.fury <= 0) { P.fury = 0; recompute = true; }
    }

    // slow/fury mexem no tickMs: quando acabam, o ritmo volta na hora.
    if (recompute) recomputeTick();
    if (C.DEBUG && Game.tickMs <= 0) warn('tickMs inválido', Game.tickMs);
  }

  /* ======================================================================
     O TICK — a ordem aqui é a alma do jogo (§2, §3)
     ====================================================================== */

  function doTick() {
    var A = arena();
    var S = Game.snake;

    Game.tick++;

    // (1) direção: NO MÁXIMO uma por tick. Consumir duas faria a cobra dar
    //     meia-volta dentro do próprio pescoço num único passo.
    var nd = null;
    var I = window.COBRA.Input;
    if (I && I.nextDir) nd = I.nextDir(S.dir);

    // (2) passo
    var ghost = Game.power.ghost > 0;
    stepCtx.wrap = ghost;
    stepCtx.arena = A;
    var res = S.step(nd, stepCtx);
    if (res.portal) onPortal(S.head());

    var h = S.head();

    // (3) colisões (borda, muro, corpo)
    var r = checkCollisions(h, ghost);
    if (r === 1) return;                       // morreu: o tick acaba aqui

    // (3b) caçador que já estava parado na célula de destino: a cobra andou
    //      até ele, então a colisão é DESTE momento e não do passo (6).
    if (r === 0 && hunterCollision(h) === 1) return;

    // (4) comida — pulada se a cobra "quicou" (a cabeça voltou para trás)
    if (r === 0) {
      checkFood(h);
      if (Game.state !== 'playing') return;    // 'perfeito': mapa lotado
    }

    // (5) caçadores
    moveHunters(h);

    // (6) colisão com caçador DE NOVO: eles se moveram depois de (3); sem
    //     esta segunda checagem o drone atravessa a cabeça sem encostar.
    if (hunterCollision(h) === 1) return;

    // (7) timers de tick: TTL da comida e ÍMÃ
    tickFood(h);
    if (Game.state !== 'playing') return;

    // (8) progressão de setor
    checkSector();

    var len = S.cells.length;
    if (len > Game.stats.maxLen) Game.stats.maxLen = len;
  }

  /* ----------------------------------------------------------------------
     (3) COLISÕES
     -> 0 = seguiu vivo e livre | 1 = fim de jogo | 2 = quicou (não letal)
     ---------------------------------------------------------------------- */

  function checkCollisions(h, ghost) {
    var A = arena();
    var W = gw(), H = gh();

    // --- borda externa: com FANTASMA o step já fez wrap, então chegar aqui
    //     fora da grade significa que não havia proteção nenhuma.
    if (h.x < 0 || h.y < 0 || h.x >= W || h.y >= H) {
      return hurt('parede', true);
    }

    // --- muro interno ---
    if (A && A.isWall(h.x, h.y)) {
      if (Game.power.fury > 0) {
        breakWall(h.x, h.y);                   // FÚRIA passa por cima e segue
      } else {
        return hurt('parede', true);
      }
    }

    // --- próprio corpo (FANTASMA atravessa) ---
    // Depois do step o array JÁ é o estado novo: a cauda saiu da célula
    // sozinha, então não existe "ignorar a cauda" aqui — comparar contra
    // cells[0] é que seria errado (a cabeça está sempre em cima de si mesma).
    if (!ghost && bodyHit()) {
      return hurt('corpo', true);
    }

    return 0;
  }

  function bodyHit() {
    var cells = Game.snake.cells;
    var hx = cells[0].x, hy = cells[0].y;
    for (var i = 1; i < cells.length; i++) {
      if (cells[i].x === hx && cells[i].y === hy) return true;
    }
    return false;
  }

  /** Restaura o corpo inteiro a partir de prev (ver cabeçalho, decisão 3). */
  function rewind() {
    var S = Game.snake;
    var cells = S.cells, prev = S.prev;
    for (var i = 0; i < cells.length; i++) {
      var p = prev[i];
      if (!p) continue;
      cells[i].x = p.x;
      cells[i].y = p.y;
    }
    // O renderer não pode interpolar o recuo: seria a cobra andando de ré.
    S.noInterp = true;
    S.clearTrail();
  }

  /**
   * Uma colisão letal chegou. Aqui se decide se ela mata mesmo.
   * @return {number} 1 = fim de jogo, 2 = sobreviveu (quicou)
   */
  function hurt(cause, doRewind) {
    // i-frames: quica de graça. Rebobinar (em vez de simplesmente ignorar)
    // é o que impede a cabeça de sair da grade durante os 800ms de escudo.
    if (Game.invulnMs > 0) {
      if (doRewind) rewind();
      return 2;
    }

    if (Game.power.shield) { breakShield(doRewind); return 2; }

    if (modeCfg && modeCfg.morre === false) { zenPenalty(doRewind); return 2; }

    die(cause);
    return 1;
  }

  /** ESCUDO (§3.3 / §4): consome, empurra a cabeça de volta, 800ms de i-frames. */
  function breakShield(doRewind) {
    var C = cfg(), F = fxm();
    var J = C.JUICE.shieldBreak;
    var h = Game.snake.head();

    if (doRewind) rewind();
    Game.power.shield = false;
    Game.invulnMs = C.SHIELD_IFRAMES_MS;

    if (F) {
      F.hitstop(J.hitstop);
      F.shake(J.shake);
      F.flash(J.flash, J.cor);
      F.chroma(J.chroma);
      F.burst(wx(h.x), wy(h.y), { count: J.particles, color: J.cor, speed: 260, size: 4, life: 640 });
      F.ring(wx(h.x), wy(h.y), { color: J.cor, r0: 8, r1: 120, life: 520, width: 4 });
      F.floatText(wx(h.x), wy(h.y) - 18, 'ESCUDO QUEBRADO', { color: J.cor, size: 20 });
    }
    sfx('shield');
  }

  /** ZEN (§3.7): nunca morre, paga 3 segmentos e ganha 1000ms de i-frames. */
  function zenPenalty(doRewind) {
    var C = cfg(), F = fxm();
    var h = Game.snake.head();

    if (doRewind) rewind();
    var perdidos = Game.snake.shrink(C.ZEN_PENALTY);
    Game.invulnMs = C.ZEN_IFRAMES_MS;

    if (F) {
      F.shake(10);
      F.flash(0.12, C.PAL.violet);
      F.burst(wx(h.x), wy(h.y), { count: 26, color: C.PAL.violet, speed: 180, size: 3.5, life: 520 });
      if (perdidos > 0) {
        F.floatText(wx(h.x), wy(h.y) - 18, '-' + perdidos, { color: C.PAL.violet, size: 20 });
      }
    }
    sfx('kill');
  }

  /** FÚRIA derrubando um muro (§3.3): +25 pontos e o passo continua válido. */
  function breakWall(x, y) {
    var C = cfg(), F = fxm(), A = arena();
    if (!A || !A.breakWall || !A.breakWall(x, y)) return;

    Game.score += FURY_WALL_PTS;
    if (F) {
      F.shake(6);
      F.burst(wx(x), wy(y), { count: 24, color: C.PAL.danger, speed: 220, size: 4, life: 480, gravity: 240 });
      F.floatText(wx(x), wy(y) - 14, '+' + FURY_WALL_PTS, { color: C.PAL.danger, size: 16 });
    }
    sfx('kill');
  }

  function onPortal(h) {
    var C = cfg(), F = fxm();
    var J = C.JUICE.portal;
    if (F) {
      F.shake(J.shake);
      F.burst(wx(h.x), wy(h.y), { count: J.particles, color: J.cor, speed: 200, size: 3.5, life: 460 });
      F.ring(wx(h.x), wy(h.y), { color: J.cor, r0: 4, r1: 70, life: 380, width: 3 });
    }
    sfx('portal');
  }

  /* ----------------------------------------------------------------------
     (4) COMIDA — combo, pontuação e power-up (§3.1, §3.2, §3.3)
     ---------------------------------------------------------------------- */

  function checkFood(h) {
    var f = Game.food;
    if (!f || f.x !== h.x || f.y !== h.y) return;
    eatFood(f, h);
  }

  function eatFood(f, h) {
    var C = cfg();

    // --- combo (§3.1): encadeou dentro da janela? soma. senão, zera. ---
    if (Game.comboMs > 0) Game.combo++;
    else Game.combo = 0;
    Game.comboMs = C.COMBO_MS;
    Game.mult = C.multFor(Game.combo);
    if (Game.combo > Game.stats.maxCombo) Game.stats.maxCombo = Game.combo;

    // --- pontos: base x combo x slow x fúria x modo, arredondado ---
    var pts = f.pts * Game.mult;
    if (Game.power.slow > 0) pts *= C.SLOW_PTS_MULT;
    if (Game.power.fury > 0) pts *= C.FURY_PTS_MULT;
    if (modeCfg) pts *= modeCfg.ptsMult;
    pts = Math.round(pts);
    Game.score += pts;

    Game.snake.grow(f.grow);
    Game.snake.addWave();          // onda de engolida (§4)

    foodsEaten++;
    Game.foodsEaten = foodsEaten;

    juiceEat(f, h, pts);
    if (f.type === 'crystal') grantPower(h);

    Game.food = null;
    checkLevel();
    spawnFood();                   // spawn IMEDIATO: sempre 1 comida no mapa
  }

  function juiceEat(f, h, pts) {
    var C = cfg(), F = fxm();
    var J = (f.type === 'gold') ? C.JUICE.gold
          : (f.type === 'crystal') ? C.JUICE.crystal : C.JUICE.eat;
    var px = wx(h.x), py = wy(h.y);

    if (F) {
      F.hitstop(J.hitstop);
      F.shake(J.shake);
      F.flash(J.flash, J.cor);
      F.burst(px, py, { count: J.particles, color: J.cor, speed: f.type === 'normal' ? 190 : 260,
                        size: f.type === 'normal' ? 3.5 : 4.5, life: f.type === 'normal' ? 520 : 720 });
      F.ring(px, py, { color: J.cor, r0: 6, r1: f.type === 'normal' ? 64 : 110,
                       life: f.type === 'normal' ? 420 : 560, width: 3 });
      if (f.type === 'crystal') {
        F.ring(px, py, { color: C.PAL.white, r0: 10, r1: 150, life: 700, width: 2 });
      }
      var txt = '+' + pts + (Game.mult > 1 ? ' x' + Game.mult : '');
      F.floatText(px, py - 16, txt,
                  { color: J.cor, size: f.type === 'gold' ? 26 : 18, life: 950 });
    }

    if (f.type === 'gold') sfx('gold');
    else if (f.type === 'crystal') sfx('powerup');
    else sfx('eat', Game.combo);
  }

  /** Cristal: sorteia um dos 5 power-ups (§3.3). Duração é REPOSTA, nunca
      somada — senão pegar 3 fúrias seguidas daria 21s de fúria. */
  function grantPower(h) {
    var C = cfg(), U = util(), F = fxm();
    var id = U.pick(C.POWER_IDS);
    if (!id) return;
    var def = C.POWER[id];

    if (id === 'shield') Game.power.shield = true;
    else Game.power[id] = def.ms;

    if (id === 'slow' || id === 'fury') recomputeTick();

    if (F) {
      F.ring(wx(h.x), wy(h.y), { color: def.cor, r0: 12, r1: 180, life: 700, width: 3 });
    }
    uiCall('banner', def.nome, def.desc, POWER_BANNER_MS);
  }

  /** Nível: 1 a cada 5 comidas (§2). Acelera o tick e o BPM da música. */
  function checkLevel() {
    var C = cfg(), F = fxm();
    var lvl = Math.floor(foodsEaten / C.FOODS_PER_LEVEL);
    if (lvl <= Game.level) return;

    Game.level = lvl;
    Game.stats.level = lvl;
    recomputeTick();
    music('setLevel', lvl);

    var J = C.JUICE.levelUp;
    var h = Game.snake.head();
    if (F) {
      F.hitstop(J.hitstop);
      F.shake(J.shake);
      F.flash(J.flash, J.cor);
      F.ring(wx(h.x), wy(h.y), { color: J.cor, r0: 10, r1: 160, life: 620, width: 3 });
    }
    sfx('levelUp');
  }

  /* ----------------------------------------------------------------------
     SPAWN DE COMIDA (§3.2)
     ---------------------------------------------------------------------- */

  function spawnFood() {
    var C = cfg(), U = util();
    var n = collectFree(0);

    // Sem célula livre = a cobra literalmente ocupou a rede inteira.
    if (n === 0) { die('perfeito'); return; }

    var idx = freeBuf[U.randInt(0, n - 1)];
    var W = gw();
    var type = C.rollFoodType();

    Game.food = new window.COBRA.Food(idx % W, (idx / W) | 0, type, nowMs());
    Game.food.settle();            // aparece do nada: sem interpolação de entrada
  }

  /* ----------------------------------------------------------------------
     (7) TTL DA COMIDA E ÍMÃ (§3.2, §3.3)
     ---------------------------------------------------------------------- */

  function tickFood(h) {
    var C = cfg(), U = util(), F = fxm();
    var f = Game.food;
    if (!f) { spawnFood(); return; }

    // --- expiração (dourada 6s, cristal 9s) ---
    if (f.expired(nowMs())) {
      if (F) {
        F.burst(wx(f.x), wy(f.y), { count: 12, color: f.cor, speed: 120, size: 3, life: 400 });
      }
      Game.food = null;
      spawnFood();
      return;
    }

    // --- ÍMÃ: 1 célula a cada 2 ticks, se a cabeça estiver a <= 6 ---
    if (Game.power.magnet <= 0) return;
    if (Game.tick % C.MAGNET_EVERY_TICKS !== 0) return;
    if (U.manhattan(f.x, f.y, h.x, h.y) > C.MAGNET_RANGE) return;

    var dx = h.x - f.x, dy = h.y - f.y;
    var ax = dx < 0 ? -dx : dx;
    var ay = dy < 0 ? -dy : dy;
    var sx = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
    var sy = dy > 0 ? 1 : (dy < 0 ? -1 : 0);

    // Eixo de maior diferença primeiro; se estiver bloqueado, tenta o outro.
    var nx = f.x, ny = f.y;
    if (ax >= ay && sx) nx += sx;
    else if (sy) ny += sy;

    if (!cellFree(nx, ny)) {
      nx = f.x; ny = f.y;
      if (ax >= ay && sy) ny += sy;
      else if (sx) nx += sx;
    }
    if ((nx !== f.x || ny !== f.y) && cellFree(nx, ny)) {
      f.moveTo(nx, ny);            // guarda px/py para o renderer interpolar
    }
  }

  /* ----------------------------------------------------------------------
     (5)/(6) CAÇADORES (§3.5)
     ---------------------------------------------------------------------- */

  function moveHunters(h) {
    var C = cfg(), A = arena();
    var every = Game.power.slow > 0 ? C.HUNTER.MOVE_EVERY_TICKS_SLOW
                                    : C.HUNTER.MOVE_EVERY_TICKS;
    var hs = Game.hunters;
    for (var i = 0; i < hs.length; i++) {
      if (hs[i].alive) hs[i].update(Game.tick, h.x, h.y, A, every);
    }
  }

  /** -> 1 se o jogo acabou aqui, 0 caso contrário. */
  function hunterCollision(h) {
    var hs = Game.hunters;
    for (var i = hs.length - 1; i >= 0; i--) {
      var hu = hs[i];
      if (!hu.isTangible()) continue;
      if (hu.x !== h.x || hu.y !== h.y) continue;

      if (Game.power.fury > 0) { killHunter(i); continue; }
      if (hurt('cacador', false) === 1) return 1;   // caçador não faz "quicar"
    }
    return 0;
  }

  /** FÚRIA destrói o drone em contato: +100 pts (§3.5). */
  function killHunter(i) {
    var C = cfg(), F = fxm();
    var J = C.JUICE.hunterKill;
    var hu = Game.hunters[i];

    Game.score += C.HUNTER.KILL_PTS;
    if (F) {
      F.hitstop(J.hitstop);
      F.shake(J.shake);
      F.flash(J.flash, J.cor);
      F.burst(wx(hu.x), wy(hu.y), { count: J.particles, color: J.cor, speed: 300, size: 4, life: 700 });
      F.floatText(wx(hu.x), wy(hu.y) - 16, '+' + C.HUNTER.KILL_PTS, { color: J.cor, size: 22 });
    }
    sfx('kill');

    hu.alive = false;
    Game.hunters.splice(i, 1);
    hunterPool.push(hu);
  }

  /** Quantos caçadores o setor+modo pedem agora. O modo trata `hunters` como
      PISO (o CAÔS nasce com 2 mesmo no setor 3) e nunca como teto, senão os
      setores altos deixariam de escalar. */
  function desiredHunters() {
    var C = cfg();
    if (!modeCfg || modeCfg.cacadores === false) return 0;
    var info = C.sectorInfo(Game.sector);
    var n = info.cacadores | 0;
    if (modeCfg.hunters !== null && modeCfg.hunters !== undefined && modeCfg.hunters > n) {
      n = modeCfg.hunters | 0;
    }
    if (n > C.HUNTER.MAX) n = C.HUNTER.MAX;
    return n;
  }

  function ensureHunters(n) {
    while (Game.hunters.length > n) {
      var hu = Game.hunters.pop();
      hu.alive = false;
      hunterPool.push(hu);
    }
    while (Game.hunters.length < n) {
      if (!spawnHunter()) break;      // sem lugar decente: tenta depois
    }
  }

  /** Nasce sempre a >= 10 células da cabeça (§3.5). Se a arena estiver
      apertada demais, relaxa a distância — nunca deixa de nascer em silêncio,
      porque o setor prometeu um caçador e o jogador precisa vê-lo chegar. */
  function spawnHunter() {
    var C = cfg(), U = util(), F = fxm();
    var n = collectFree(C.HUNTER.SPAWN_MIN_DIST);
    if (n === 0) n = collectFree(Math.floor(C.HUNTER.SPAWN_MIN_DIST / 2));
    if (n === 0) n = collectFree(0);
    if (n === 0) return false;

    var W = gw();
    var idx = freeBuf[U.randInt(0, n - 1)];
    var x = idx % W, y = (idx / W) | 0;

    var hu = hunterPool.pop();
    if (hu) hu.reset(x, y);
    else hu = new window.COBRA.Hunter(x, y);
    Game.hunters.push(hu);

    if (F) {
      F.ring(wx(x), wy(y), { color: C.PAL.danger, r0: 4, r1: 90, life: C.HUNTER.SPAWN_MS, width: 2 });
    }
    // O alerta toca SEMPRE (§3.5): um caçador que nasce em silêncio é uma
    // morte que o jogador não teve como prever.
    sfx('hunterAlert');
    return true;
  }

  function recycleHunters() {
    var hs = Game.hunters;
    while (hs.length) {
      var hu = hs.pop();
      hu.alive = false;
      hunterPool.push(hu);
    }
  }

  /* ----------------------------------------------------------------------
     (8) PROGRESSÃO DE SETOR (§3.4)
     ---------------------------------------------------------------------- */

  function checkSector() {
    var C = cfg();
    if (!modeCfg || modeCfg.progressao === false) return;

    var ns = C.sectorFor(Game.score);
    if (ns < modeCfg.startSector) ns = modeCfg.startSector;   // CAÔS começa no 3
    if (ns <= Game.sector) return;

    sectorUp(ns);
  }

  function sectorUp(ns) {
    var C = cfg(), F = fxm(), A = arena();
    var J = C.JUICE.sector;
    var info = C.sectorInfo(ns);
    var h = Game.snake.head();

    Game.sector = ns;
    Game.stats.sector = ns;

    if (F) {
      F.hitstop(J.hitstop);
      F.shake(J.shake);
      F.flash(J.flash, J.cor);
      F.burst(wx(h.x), wy(h.y), { count: J.particles, color: J.cor, speed: 340, size: 4, life: 900 });
      F.ring(wx(h.x), wy(h.y), { color: J.cor, r0: 10, r1: 260, life: 800, width: 4 });
    }
    sfx('sector');
    music('setIntensity', C.intensityFor(ns));
    uiCall('banner', info.nome, sectorSub(info), C.SECTOR_BANNER_MS);

    // A cobra JAMAIS é morta pela reconstrução (§3.4).
    if (A) A.build(ns, protectedCells(), arenaOpts());

    // A arena nova pode ter enterrado a comida embaixo de um muro/portal.
    if (Game.food && !cellFree(Game.food.x, Game.food.y)) {
      Game.food = null;
      spawnFood();
    }
    // ...e pode ter nascido um muro em cima de um caçador.
    relocateBuriedHunters();
    ensureHunters(desiredHunters());
  }

  /** Subtítulo do banner: o que MUDOU neste setor, em português.
      Descreve a arena que o jogador vai de fato receber: o modo pode
      desligar muros e portais (arenaOpts) e caçadores (desiredHunters) —
      no ZEN o banner anunciava "MUROS INTERNOS · PORTAIS · 1 CAÇADOR" numa
      arena vazia. Chamado depois de Game.sector já ter virado o setor novo. */
  function sectorSub(info) {
    var semArena = !!(modeCfg && modeCfg.muros === false);
    var partes = [];
    if (!info.muros || semArena) partes.push('ARENA LIMPA');
    else partes.push('MUROS INTERNOS');
    if (info.portais && !semArena) partes.push('PORTAIS');
    var n = desiredHunters();
    if (n > 0) {
      partes.push(n > 1 ? n + ' CAÇADORES' : '1 CAÇADOR');
    }
    return partes.join(' · ');
  }

  function relocateBuriedHunters() {
    var A = arena();
    if (!A) return;
    var hs = Game.hunters;
    for (var i = hs.length - 1; i >= 0; i--) {
      if (!A.isWall(hs[i].x, hs[i].y) && !A.isPortal(hs[i].x, hs[i].y)) continue;
      var hu = hs[i];
      hs.splice(i, 1);
      hu.alive = false;
      hunterPool.push(hu);
      spawnHunter();
    }
  }

  /* ======================================================================
     MORTE (§4)
     ====================================================================== */

  function die(cause) {
    var C = cfg(), F = fxm();
    var J = C.JUICE.death;

    Game.state = 'gameover';
    Game.deathAnim = 0;
    deathTimer = 0;
    deathBurstAcc = 0;
    deathSeg = 0;
    overShown = false;

    var len = Game.snake ? Game.snake.cells.length : 0;
    if (len > Game.stats.maxLen) Game.stats.maxLen = len;

    Game.stats.cause = cause;
    Game.stats.sector = Game.sector;
    Game.stats.score = Game.score;
    Game.stats.level = Game.level;
    Game.stats.mode = Game.mode;

    lastRecord = saveRecord();
    Game.stats.isRecord = lastRecord;

    // Slow-motion começa AGORA: main.js já multiplica o dt pelo timeScale.
    Game.timeScale = C.DEATH.SLOWMO_FROM;

    if (F) {
      F.hitstop(J.hitstop);
      F.shake(J.shake);
      F.flash(J.flash, J.cor);
      F.chroma(J.chroma);
    }
    sfx('death');
    music('stop');
  }

  /** Continua rodando DEPOIS que o state virou 'gameover' — é ela que
      devolve timeScale para 1 e desenrola a explosão do corpo. */
  function updateDeath(dt) {
    var C = cfg(), U = util();
    var D = C.DEATH;

    deathTimer += dt;

    // 0.25 -> 1 em 900ms, linear: qualquer curva aqui é lida como "travou"
    // ou "acelerou sozinho". O dt já vem multiplicado pelo timeScale, então
    // esses 900ms são de tempo de JOGO — na tela dão ~1,4s de slow-mo.
    var t = U.clamp(deathTimer / D.SLOWMO_MS, 0, 1);
    Game.timeScale = U.lerp(D.SLOWMO_FROM, 1, t);
    Game.deathAnim = U.clamp(deathTimer / D.ANIM_MS, 0, 1);

    // Explosão escalonada: 18ms por segmento, no relógio JÁ desacelerado.
    // O acumulador (em vez de agendar tudo de uma vez) é o que faz a onda de
    // explosão respeitar o slow-mo e a cabeça explodir primeiro.
    var S = Game.snake;
    if (S && deathSeg < S.cells.length) {
      deathBurstAcc += dt;
      while (deathSeg < S.cells.length && deathBurstAcc >= D.SEG_DELAY_MS) {
        deathBurstAcc -= D.SEG_DELAY_MS;
        burstSegment(S.cells[deathSeg], deathSeg);
        deathSeg++;
      }
    }

    // A tela de fim só entra quando o slow-mo termina: cobri-la antes seria
    // esconder o melhor frame do jogo.
    if (!overShown && deathTimer >= D.SLOWMO_MS) {
      overShown = true;
      uiCall('showGameOver', Game.stats, lastRecord);
      uiCall('show', 'gameover');
    }
  }

  function burstSegment(c, i) {
    var C = cfg(), U = util(), F = fxm();
    if (!F) return;
    // Mesma matiz do corpo (§1): a explosão preserva o gradiente da cobra.
    var hue = C.SNAKE.HUE_HEAD - i * C.SNAKE.HUE_STEP;
    if (hue < C.SNAKE.HUE_MIN) hue = C.SNAKE.HUE_MIN;
    F.burst(wx(c.x), wy(c.y), {
      count: i === 0 ? 22 : 12,
      color: U.hsla(Math.round(hue), C.SNAKE.SAT, C.SNAKE.LIGHT, 1),
      speed: 220, size: 4, life: 780, gravity: 120
    });
  }

  /* ======================================================================
     RECORDES (§6) — top 5 em CFG.STORAGE_KEY, via Util.store (§9.1)
     ====================================================================== */

  function isArray(v) {
    return Object.prototype.toString.call(v) === '[object Array]';
  }

  function loadBest() {
    var C = cfg(), U = util();
    var best = U.store.get(C.STORAGE_BEST, 0) | 0;
    var list = U.store.get(C.STORAGE_KEY, null);
    if (isArray(list)) {
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        var p = (r && r.pontos) | 0;
        if (p > best) best = p;
      }
    }
    return best;
  }

  function saveRecord() {
    var C = cfg(), U = util();
    var isRec = Game.score > Game.best;
    if (isRec) Game.best = Game.score;

    if (Game.score > 0) {
      var list = U.store.get(C.STORAGE_KEY, null);
      if (!isArray(list)) list = [];
      var d = new Date();
      list.push({
        pontos: Game.score,
        modo: modeCfg ? modeCfg.nome : Game.mode,
        modoId: Game.mode,
        // Guardo a data JÁ formatada (e o timestamp cru junto): a UI só
        // precisa imprimir, sem herdar a responsabilidade de formatar.
        data: U.pad2(d.getDate()) + '/' + U.pad2(d.getMonth() + 1) + '/' + d.getFullYear(),
        ts: d.getTime()
      });
      list.sort(function (a, b) { return (b.pontos | 0) - (a.pontos | 0); });
      if (list.length > C.SCORES_MAX) list.length = C.SCORES_MAX;
      U.store.set(C.STORAGE_KEY, list);
    }
    U.store.set(C.STORAGE_BEST, Game.best);
    return isRec;
  }

  window.COBRA.Game = Game;
})();
