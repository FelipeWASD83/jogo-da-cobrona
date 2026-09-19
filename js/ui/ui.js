/* ==========================================================================
   COBRONA :: PROTOCOLO NEON
   js/ui/ui.js  ->  COBRA.UI

   Responsável por TODO o DOM (§9.11, §6, §10) e por absolutamente nada do
   canvas. Duas obsessões guiam este arquivo:

   1. ZERO getElementById fora do init(). Tudo é cacheado uma vez só.
   2. ZERO escrita no DOM sem mudança de valor. syncHUD roda 60x/s; escrever
      textContent ou style.width com o MESMO valor ainda assim invalida o
      layout do elemento no Firefox. Por isso cada campo do HUD tem um
      "último valor escrito" guardado em variável — a comparação em JS é
      ordens de grandeza mais barata que o toque no DOM.

   Nenhum módulo é lido no escopo de topo (regra de ouro de §8).
   ========================================================================== */
(function () {
  'use strict';

  window.COBRA = window.COBRA || {};

  var UI = {};

  /* ---------------------------------------------------------------------
     Cache de elementos (preenchido em init)
     --------------------------------------------------------------------- */
  var el = {
    hud: null, score: null, best: null, len: null, sector: null,
    comboWrap: null, comboBar: null, comboMult: null,
    powerups: null,
    banner: null, bannerMain: null, bannerSub: null,
    screenMenu: null, screenPause: null, screenOver: null,
    modes: null, menuBest: null, scorelist: null,
    overTitle: null, overRecord: null, overStats: null,
    mute: null
  };

  var modeItems = [];      // <li data-mode> em ordem de tela
  var selIndex = 0;        // índice da seleção do menu
  var inited = false;

  /* ---------------------------------------------------------------------
     Últimos valores escritos no DOM. Sentinela: null/-1 = "nunca escrito",
     garantindo que a primeira sincronização sempre pinte tudo.
     --------------------------------------------------------------------- */
  var lastScore = -1;
  var lastBest = -1;
  var lastLen = -1;
  var lastSector = -1;
  var lastComboPct = -1;   // já arredondado para inteiro
  var lastMultTxt = '';
  var lastComboOn = null;  // bool: wrapper visível?
  var lastPowerMask = -1;  // bitmask do CONJUNTO de power-ups ativos
  var lastScreen = '';

  var bannerTimer = 0;     // id do setTimeout do banner em voo

  /* Chips de power-up reaproveitados entre frames. Criar/destruir <div> a
     60fps geraria lixo e reflow constante; aqui cada id tem seu chip vitalício
     e o container só é remontado quando o CONJUNTO de ativos muda. */
  var chips = {};          // id -> { el, bar, lastW, lastBlink }

  /* ---------------------------------------------------------------------
     Helpers internos
     --------------------------------------------------------------------- */

  function $(id) {
    return document.getElementById(id);
  }

  /** Toca um SFX de UI sem nunca explodir se o Audio ainda não existir. */
  function sfx(nome) {
    var A = COBRA.Audio;
    if (A && A.sfx && typeof A.sfx[nome] === 'function') A.sfx[nome]();
  }

  /** 'x1', 'x2.5', 'x8' — uma casa decimal, mas sem o ".0" pendurado (§6). */
  function fmtMult(m) {
    var s = (Math.round(m * 10) / 10).toFixed(1);
    if (s.slice(-2) === '.0') s = s.slice(0, -2);
    return 'x' + s;
  }

  /** Util.pad2 com plano B, caso o Util não tenha carregado (nunca deveria). */
  function pad2(n) {
    var U = COBRA.Util;
    if (U && U.pad2) return U.pad2(n);
    return n < 10 ? '0' + n : '' + n;
  }

  function clearEl(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function setText(node, txt) {
    if (node) node.textContent = txt;
  }

  function setClass(node, cls, on) {
    if (!node) return;
    if (on) node.classList.add(cls);
    else node.classList.remove(cls);
  }

  /* ---------------------------------------------------------------------
     init
     --------------------------------------------------------------------- */

  UI.init = function () {
    if (inited) return;
    inited = true;

    var CFG = COBRA.CFG;

    el.hud        = $('hud');
    el.score      = $('hud-score');
    el.best       = $('hud-best');
    el.len        = $('hud-len');
    el.sector     = $('hud-sector');
    el.comboWrap  = $('combo-wrap');
    el.comboBar   = $('combo-bar');
    el.comboMult  = $('combo-mult');
    el.powerups   = $('powerups');
    el.banner     = $('banner');
    el.bannerMain = $('banner-main');
    el.bannerSub  = $('banner-sub');
    el.screenMenu = $('screen-menu');
    el.screenPause= $('screen-pause');
    el.screenOver = $('screen-over');
    el.modes      = $('modes');
    el.menuBest   = $('menu-best');
    el.scorelist  = $('scorelist');
    el.overTitle  = $('over-title');
    el.overRecord = $('over-record');
    el.overStats  = $('over-stats');
    el.mute       = $('mute-ind');

    // Lista estática de itens do menu: o <ul> não muda, então consultar
    // querySelectorAll uma vez basta para sempre.
    modeItems = [];
    if (el.modes) {
      var lis = el.modes.querySelectorAll('li[data-mode]');
      for (var i = 0; i < lis.length; i++) {
        modeItems.push(lis[i]);
        // Clique/toque direto só MOVE a seleção; quem decide começar é o
        // main.js (o mesmo toque também vira 'start' no Input).
        (function (idx, node) {
          function escolher() {
            if (idx === selIndex) return;
            applySelection(idx);
            sfx('uiMove');
          }
          // PORQUÊ pointerdown ALÉM de click: o Input dá preventDefault() no
          // touchstart para matar scroll/zoom, e isso suprime o `click`
          // sintético do toque — sem esta linha, tocar em CAÔS/ZEN no celular
          // não fazia nada. `pointerdown` é despachado antes do touchstart,
          // então escapa. Ter os dois é inofensivo: escolher() é idempotente.
          node.addEventListener('pointerdown', escolher);
          node.addEventListener('click', escolher);
        })(i, lis[i]);
      }
    }

    // Restaura o último modo jogado, se houver — detalhe barato que evita
    // rolar o menu de novo a cada partida.
    var salvo = null;
    if (CFG && CFG.STORAGE_MODE && COBRA.Util && COBRA.Util.store) {
      salvo = COBRA.Util.store.get(CFG.STORAGE_MODE, null);
    }
    var start = 0;
    for (var j = 0; j < modeItems.length; j++) {
      if (modeItems[j].getAttribute('data-mode') === salvo) { start = j; break; }
      if (modeItems[j].classList.contains('sel')) start = j;
    }
    applySelection(start);

    UI.renderScores();
  };

  /* ---------------------------------------------------------------------
     Telas (§10 — visibilidade por classe .on)
     --------------------------------------------------------------------- */

  UI.show = function (screen) {
    if (screen === lastScreen) return;
    lastScreen = screen;

    setClass(el.hud,         'on', screen === 'game');
    setClass(el.screenMenu,  'on', screen === 'menu');
    setClass(el.screenPause, 'on', screen === 'pause');
    setClass(el.screenOver,  'on', screen === 'gameover');

    // Um banner de setor sobrevivendo por cima do menu/game over fica
    // ridículo — sair da partida cancela o que estiver em voo.
    if (screen === 'menu' || screen === 'gameover') UI.hideBanner();

    if (screen === 'menu') UI.renderScores();
  };

  /* ---------------------------------------------------------------------
     HUD — chamado 60x/s por main.js
     --------------------------------------------------------------------- */

  UI.syncHUD = function (game) {
    if (!game) return;
    var CFG = COBRA.CFG;
    if (!CFG) return;

    /* ----- números principais ----- */
    var sc = game.score | 0;
    if (sc !== lastScore) { lastScore = sc; setText(el.score, sc); }

    var bs = (game.best === undefined || game.best === null) ? UI.bestScore() : (game.best | 0);
    if (bs !== lastBest) { lastBest = bs; setText(el.best, bs); }

    var ln = (game.snake && game.snake.cells) ? game.snake.cells.length : 0;
    if (ln !== lastLen) { lastLen = ln; setText(el.len, ln); }

    var sec = game.sector | 0;
    if (sec !== lastSector) { lastSector = sec; setText(el.sector, pad2(sec + 1)); }

    /* ----- barra de combo ----- */
    var comboOn = (game.combo | 0) > 0;
    if (comboOn !== lastComboOn) {
      lastComboOn = comboOn;
      // display (e não visibility) porque o wrapper é flex: escondê-lo tira
      // ele e o multiplicador do fluxo de uma vez só.
      if (el.comboWrap) el.comboWrap.style.display = comboOn ? '' : 'none';
    }

    if (comboOn) {
      var pct = (game.comboMs || 0) / CFG.COMBO_MS * 100;
      pct = pct < 0 ? 0 : (pct > 100 ? 100 : pct);
      // Arredondar para inteiro corta ~60% das escritas de style.width sem
      // perda visual: 1% da barra é ~3px e há transition de 80ms suavizando.
      pct = Math.round(pct);
      if (pct !== lastComboPct) {
        lastComboPct = pct;
        if (el.comboBar) el.comboBar.style.width = pct + '%';
      }
      var mtxt = fmtMult(game.mult || CFG.multFor(game.combo | 0));
      if (mtxt !== lastMultTxt) {
        lastMultTxt = mtxt;
        setText(el.comboMult, mtxt);
      }
    } else if (lastComboPct !== 0) {
      // Zera a barra escondida para ela não reaparecer cheia no próximo combo.
      lastComboPct = 0;
      if (el.comboBar) el.comboBar.style.width = '0%';
    }

    /* ----- chips de power-up ----- */
    syncPowerups(game.power, CFG);
  };

  /**
   * Renderiza os chips de power-up ativos.
   * O CONJUNTO ativo vira um bitmask (não uma string) só para poder comparar
   * com o frame anterior sem alocar nada; a remontagem do container acontece
   * apenas quando esse bitmask muda. Nos demais frames só a largura da barra
   * é tocada — e mesmo assim só quando o inteiro do percentual muda.
   */
  function syncPowerups(power, CFG) {
    if (!el.powerups) return;

    var ids = CFG.POWER_IDS;
    var mask = 0;
    var i, id, ms;

    if (power) {
      for (i = 0; i < ids.length; i++) {
        id = ids[i];
        var v = power[id];
        var ativo = (id === 'shield') ? !!v : (typeof v === 'number' && v > 0);
        if (ativo) mask |= (1 << i);
      }
    }

    if (mask !== lastPowerMask) {
      lastPowerMask = mask;
      clearEl(el.powerups);
      for (i = 0; i < ids.length; i++) {
        if (mask & (1 << i)) el.powerups.appendChild(chipFor(ids[i], CFG).el);
      }
    }

    if (mask === 0) return;

    var blinkMs = CFG.POWER_BLINK_MS || 2000;
    for (i = 0; i < ids.length; i++) {
      if (!(mask & (1 << i))) continue;
      id = ids[i];
      var c = chips[id];
      if (!c || !c.bar) continue;           // ESCUDO é booleano: chip sem barra

      var total = CFG.POWER[id].ms || 0;
      if (total <= 0) continue;
      ms = power[id] || 0;

      var w = Math.round(ms / total * 100);
      if (w < 0) w = 0; else if (w > 100) w = 100;
      if (w !== c.lastW) { c.lastW = w; c.bar.style.width = w + '%'; }

      var pisca = ms < blinkMs;
      if (pisca !== c.lastBlink) {
        c.lastBlink = pisca;
        setClass(c.el, 'piscando', pisca);
      }
    }
  }

  /** Cria (uma vez) e devolve o chip de um power-up. */
  function chipFor(id, CFG) {
    var c = chips[id];
    if (c) return c;

    var info = CFG.POWER[id] || {};
    var box = document.createElement('div');
    box.className = 'chip pu-' + id;

    var nome = document.createElement('span');
    nome.className = 'nome';
    nome.textContent = info.nome || id;
    box.appendChild(nome);

    // A cor do power-up entra como borda/realce; o resto do visual é do CSS.
    if (info.cor) box.style.borderColor = info.cor;

    var bar = null;
    if (info.ms > 0) {                       // ESCUDO (ms 0) não tem barra
      bar = document.createElement('i');
      bar.className = 'bar';
      bar.style.width = '100%';
      box.appendChild(bar);
    }

    c = { el: box, bar: bar, lastW: -1, lastBlink: false };
    chips[id] = c;
    return c;
  }

  /* ---------------------------------------------------------------------
     Banner
     --------------------------------------------------------------------- */

  UI.banner = function (texto, sub, ms) {
    if (!el.banner) return;

    if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = 0; }

    setText(el.bannerMain, texto || '');
    setText(el.bannerSub, sub || '');

    // A animação de entrada está presa a `#banner.on`. Se a classe já
    // estivesse lá, um banner novo apareceria estático — remover, forçar
    // reflow lendo offsetWidth e readicionar reinicia o keyframe.
    el.banner.classList.remove('on');
    void el.banner.offsetWidth;
    el.banner.classList.add('on');

    var dur = (ms === undefined || ms === null) ? 1800 : ms;
    if (dur > 0) {
      bannerTimer = setTimeout(function () {
        bannerTimer = 0;
        if (el.banner) el.banner.classList.remove('on');
      }, dur);
    }
  };

  UI.hideBanner = function () {
    if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = 0; }
    if (el.banner) el.banner.classList.remove('on');
  };

  /* ---------------------------------------------------------------------
     Game over (§6)
     --------------------------------------------------------------------- */

  UI.showGameOver = function (stats, isRecord) {
    var CFG = COBRA.CFG;
    var U = COBRA.Util;
    var s = stats || {};

    // Manchete pela causa da morte, com fallback obrigatório.
    var titulo;
    if (CFG && typeof CFG.deathTitle === 'function') titulo = CFG.deathTitle(s.cause);
    else if (CFG && CFG.DEATH_TITLES) titulo = CFG.DEATH_TITLES[s.cause] || 'CONEXÃO PERDIDA';
    else titulo = 'CONEXÃO PERDIDA';
    setText(el.overTitle, titulo);

    // 'hide' é a classe que o CSS reconhece para ocultar o NOVO RECORDE!
    setClass(el.overRecord, 'hide', !isRecord);

    if (el.overStats) {
      // Game.stats não carrega o placar no contrato de §9.8; aceitamos
      // score/pontos se vierem e, senão, usamos o último valor visto no HUD.
      var pontos = (s.score !== undefined && s.score !== null) ? s.score
                 : ((s.pontos !== undefined && s.pontos !== null) ? s.pontos
                 : (lastScore < 0 ? 0 : lastScore));

      var linhas = [
        [(CFG && CFG.TXT ? CFG.TXT.pontos : 'PONTOS'), Math.round(pontos)],
        [(CFG && CFG.TXT ? CFG.TXT.tamanhoMax : 'TAMANHO MÁXIMO'), (s.maxLen | 0)],
        [(CFG && CFG.TXT ? CFG.TXT.comboMax : 'COMBO MÁXIMO'), (s.maxCombo | 0)],
        [(CFG && CFG.TXT ? CFG.TXT.setorAlcancado : 'SETOR ALCANÇADO'), pad2((s.sector | 0) + 1)],
        [(CFG && CFG.TXT ? CFG.TXT.tempo : 'TEMPO'), (U ? U.formatTime(s.timeMs || 0) : '0:00')]
      ];

      clearEl(el.overStats);
      for (var i = 0; i < linhas.length; i++) {
        var dt = document.createElement('dt');
        dt.textContent = linhas[i][0];
        var dd = document.createElement('dd');
        dd.textContent = linhas[i][1];
        el.overStats.appendChild(dt);
        el.overStats.appendChild(dd);
      }
    }

    UI.show('gameover');
  };

  /* ---------------------------------------------------------------------
     Menu
     --------------------------------------------------------------------- */

  function applySelection(idx) {
    if (!modeItems.length) return;
    var n = modeItems.length;
    selIndex = ((idx % n) + n) % n;          // circular nos dois sentidos
    for (var i = 0; i < n; i++) {
      // classList.toggle com força explícita não escreve se já está no estado.
      modeItems[i].classList.toggle('sel', i === selIndex);
    }
  }

  UI.menuMove = function (delta) {
    if (!modeItems.length) return null;
    applySelection(selIndex + (delta | 0));
    sfx('uiMove');
    return UI.selectedMode();
  };

  UI.selectedMode = function () {
    var CFG = COBRA.CFG;
    var padrao = (CFG && CFG.DEFAULT_MODE) ? CFG.DEFAULT_MODE : 'classico';
    if (!modeItems.length) return padrao;
    return modeItems[selIndex].getAttribute('data-mode') || padrao;
  };

  UI.menuSelect = function () {
    sfx('uiConfirm');
    var modo = UI.selectedMode();
    var CFG = COBRA.CFG;
    if (CFG && CFG.STORAGE_MODE && COBRA.Util && COBRA.Util.store) {
      COBRA.Util.store.set(CFG.STORAGE_MODE, modo);
    }
    return modo;
  };

  /* ---------------------------------------------------------------------
     Recordes (§6) — top 5 em Util.store, chave CFG.STORAGE_KEY
     --------------------------------------------------------------------- */

  function loadScores() {
    var CFG = COBRA.CFG, U = COBRA.Util;
    if (!CFG || !U || !U.store) return [];
    var arr = U.store.get(CFG.STORAGE_KEY, null);
    if (!arr || Object.prototype.toString.call(arr) !== '[object Array]') return [];
    // Saneamento: dados vindos do storage podem ter sido editados à mão.
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var e = arr[i];
      if (!e || typeof e.pontos !== 'number' || !isFinite(e.pontos)) continue;
      // `modoId` ('classico') é o que renderScores usa para achar o nome em
      // CFG.MODES; `modo` (nome já formatado) fica para registros antigos que
      // não têm o id. Antes o modoId era descartado aqui e a lista só mostrava
      // o nome certo porque o `modo` gravado já estava em maiúsculas.
      out.push({
        pontos: e.pontos | 0,
        modoId: typeof e.modoId === 'string' ? e.modoId : '',
        modo: e.modo || '',
        data: e.data || ''
      });
    }
    out.sort(function (a, b) { return b.pontos - a.pontos; });
    return out;
  }

  function nomeModo(id) {
    var CFG = COBRA.CFG;
    if (CFG && CFG.MODES && CFG.MODES[id] && CFG.MODES[id].nome) return CFG.MODES[id].nome;
    return String(id || '').toUpperCase();
  }

  /** Maior pontuação registrada (0 se não houver nenhuma). */
  UI.bestScore = function () {
    var list = loadScores();
    return list.length ? list[0].pontos : 0;
  };

  /* NÃO existe UI.saveScore: quem grava a tabela de recordes é o
     saveRecord() do game.js, dono do fim de partida. Ter um segundo escritor
     aqui significava duas formas de registro gravadas na MESMA chave de
     storage (uma com `modoId`, outra sem), e a leitura só funcionava por
     acidente, caindo no fallback. Uma fonte da verdade, e é o game.js. */

  /** Preenche #scorelist e o "RECORDE: N" do menu. */
  UI.renderScores = function () {
    var CFG = COBRA.CFG;
    var list = loadScores();

    if (el.scorelist) {
      clearEl(el.scorelist);
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        var li = document.createElement('li');
        // #scorelist usa white-space: pre, então os espaços duplos abaixo
        // funcionam como separador de coluna na fonte monoespaçada.
        // `modoId` é o id cru ('classico'), que resolve pelo CFG.MODES;
        // `modo` é o nome já formatado gravado por versões anteriores do
        // registro. Preferir o id evita depender do fallback toUpperCase().
        li.textContent = (i + 1) + '. ' + e.pontos + '  ' +
                         nomeModo(e.modoId || e.modo) + '  ' + String(e.data).slice(0, 5);
        el.scorelist.appendChild(li);
      }
    }

    if (el.menuBest) {
      var prefixo = (CFG && CFG.TXT) ? CFG.TXT.prefixoRecorde : 'RECORDE: ';
      el.menuBest.textContent = prefixo + (list.length ? list[0].pontos : 0);
    }
  };

  /* ---------------------------------------------------------------------
     Mudo
     --------------------------------------------------------------------- */

  UI.setMuted = function (b) {
    setClass(el.mute, 'on', !!b);
  };

  COBRA.UI = UI;
})();
