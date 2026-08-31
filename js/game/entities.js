/* ==========================================================================
   COBRONA :: PROTOCOLO NEON
   js/game/entities.js  ->  COBRA.Snake, COBRA.Food, COBRA.Hunter

   Estas três classes são DE PROPÓSITO burras e previsíveis: elas não sabem o
   que é pontuação, morte, spawn ou power-up. Elas só sabem se mover e guardar
   o passado. Toda regra de jogo mora em game.js.

   O que este arquivo garante (e que o resto do jogo assume como lei):

     1. `cells` e `prev` têm SEMPRE o mesmo comprimento e `prev[i]` é a
        posição de `cells[i]` no tick anterior. O renderer desenha em
        lerp(prev[i], cells[i], tickProgress) (§2) — se os arrays saírem de
        sincronia, a cobra pisca, estica ou "voa" pela tela.
     2. Ao crescer, o segmento novo nasce na posição da CAUDA ANTIGA nos DOIS
        arrays. Se ele nascesse só em `cells`, no primeiro frame ele seria
        interpolado a partir de lixo (ou de (0,0)) e entraria voando de fora
        da tela. Esse é o bug clássico de snake interpolado.
     3. Nenhuma alocação nos caminhos quentes: os objetos de célula, de `prev`
        e de onda saem de pools e são reciclados. Um tick de cobra grande não
        pode gerar lixo para o GC no meio de uma partida a 60fps.

   Nada de COBRA.CFG / COBRA.Util no escopo de topo — só dentro de funções.
   ========================================================================== */
(function () {
  'use strict';

  window.COBRA = window.COBRA || {};

  var TAU = Math.PI * 2;

  /* ======================================================================
     ACESSO TARDIO AOS MÓDULOS
     Chamadas dentro de funções, nunca no topo: a ordem de carga (§8) nunca
     nos quebra, mesmo que algum dia este arquivo suba antes do config.
     Os fallbacks existem só para o arquivo ser testável isolado.
     ====================================================================== */

  function cfg() {
    return window.COBRA.CFG || null;
  }

  function util() {
    return window.COBRA.Util || null;
  }

  function gridW() {
    var C = cfg();
    return C ? C.GRID_W : 30;
  }

  function gridH() {
    var C = cfg();
    return C ? C.GRID_H : 20;
  }

  /** Relógio próprio: performance.now() quando existe (monotônico e mais
      preciso), Date.now() como rede de segurança. */
  function now() {
    return (window.performance && window.performance.now)
      ? window.performance.now()
      : Date.now();
  }

  /** Envolve v em [0,n) — módulo que também funciona para negativos. */
  function wrapN(v, n) {
    return ((v % n) + n) % n;
  }

  /** Resolve uma direção que pode vir como vetor {x,y} ou como chave
      ('RIGHT') de Util.DIRS. Aceitar as duas formas evita que um agente
      vizinho quebre só por passar a string do CFG.START_DIR. */
  function toDir(d) {
    var U = util();
    if (!d) return null;
    if (typeof d === 'string') {
      return (U && U.DIRS[d]) ? U.DIRS[d] : null;
    }
    if (typeof d.x === 'number' && typeof d.y === 'number') return d;
    return null;
  }

  /* ======================================================================
     COBRA (§9.7)
     ====================================================================== */

  /**
   * @param {number} x  coluna da cabeça
   * @param {number} y  linha da cabeça
   * @param {Object|string} dir vetor {x,y} ou chave de Util.DIRS
   */
  function Snake(x, y, dir) {
    // --- contrato §9.7 ---
    this.cells = [];        // [{x,y}] — índice 0 = CABEÇA
    this.prev = [];         // [{x,y}] — mesmas posições no tick ANTERIOR
    this.dir = null;        // {x,y}
    this.pendingGrow = 0;   // segmentos a nascer (1 por tick)
    this.waves = [];        // [{pos}] — ondas de engolida (§4)
    this.noInterp = false;  // true no tick em que houve wrap/portal

    // --- extras públicos ---
    this.ticks = 0;         // ticks vividos (base do cooldown de portal)
    this.headTrail = [];    // buffer CIRCULAR de 8 posições EM PIXELS (§4)
    this.trailIndex = 0;    // próxima posição a ser escrita
    this.trailCount = 0;    // quantas posições do buffer já são válidas
    this._trailAcc = 0;     // ms acumulados desde a última amostra do rastro
    this._trailLast = 0;    // instante da última amostra (só no modo sem dt)

    // --- pools internos (nada disso é alocado por tick) ---
    this._cellPool = [];
    this._wavePool = [];
    this._portalCd = null;  // { "x,y": tick até o qual o portal está frio }
    this._result = { portal: false, wrapped: false };  // objeto de retorno reusado

    this._initTrail();
    this.reset(x, y, dir);
  }

  /* --------------------------------------------------------------------
     Infra de pools
     -------------------------------------------------------------------- */

  /** Tira um {x,y} do pool (ou cria) já posicionado. */
  Snake.prototype._cell = function (x, y) {
    var c = this._cellPool.pop();
    if (c) { c.x = x; c.y = y; return c; }
    return { x: x, y: y };
  };

  /** Devolve ao pool todos os objetos de um array e o esvazia. */
  Snake.prototype._recycle = function (arr) {
    for (var i = 0; i < arr.length; i++) this._cellPool.push(arr[i]);
    arr.length = 0;
  };

  /** Aloca o rastro uma única vez: ele é circular, nunca cresce nem encolhe. */
  Snake.prototype._initTrail = function () {
    var C = cfg();
    var n = (C && C.SNAKE && C.SNAKE.TRAIL_LEN) ? C.SNAKE.TRAIL_LEN : 8;
    this.headTrail.length = 0;
    for (var i = 0; i < n; i++) this.headTrail.push({ x: 0, y: 0 });
    this.trailIndex = 0;
    this.trailCount = 0;
  };

  /* --------------------------------------------------------------------
     Ciclo de vida
     -------------------------------------------------------------------- */

  /** Recoloca a cobra do zero reusando todos os objetos já alocados.
      Chamado pelo construtor e por Game.start()/restart(). */
  Snake.prototype.reset = function (x, y, dir) {
    var C = cfg();
    var U = util();
    var W = gridW(), H = gridH();

    var d = toDir(dir);
    if (!d) d = toDir(C ? C.START_DIR : 'RIGHT');
    if (!d) d = (U ? U.DIRS.RIGHT : { x: 1, y: 0 });
    this.dir = d;

    var len = (C && C.START_LEN) ? C.START_LEN : 4;
    if (len < 1) len = 1;

    this._recycle(this.cells);
    this._recycle(this.prev);
    this._recycleWaves();

    var hx = (x === undefined || x === null) ? (W >> 1) : (x | 0);
    var hy = (y === undefined || y === null) ? (H >> 1) : (y | 0);

    // O corpo nasce ATRÁS da cabeça (sentido oposto ao movimento) e preso
    // dentro da grade: se a cabeça começa perto da borda, os segmentos
    // extras empilham na última célula válida em vez de sair do mapa.
    for (var i = 0; i < len; i++) {
      var cx = hx - d.x * i;
      var cy = hy - d.y * i;
      if (cx < 0) cx = 0; else if (cx > W - 1) cx = W - 1;
      if (cy < 0) cy = 0; else if (cy > H - 1) cy = H - 1;
      this.cells.push(this._cell(cx, cy));
      // prev nasce IGUAL a cells: no primeiro frame a interpolação é imóvel,
      // e não um salto a partir de posição nenhuma.
      this.prev.push(this._cell(cx, cy));
    }

    this.pendingGrow = 0;
    this.noInterp = false;
    this.ticks = 0;
    this._portalCd = null;
    this.clearTrail();
    return this;
  };

  Snake.prototype.head = function () {
    return this.cells[0];
  };

  /** Último segmento. Mutar o objeto retornado é proibido — é o objeto vivo. */
  Snake.prototype.tail = function () {
    return this.cells[this.cells.length - 1];
  };

  Snake.prototype.len = function () {
    return this.cells.length;
  };

  /* --------------------------------------------------------------------
     PASSO (§9.7)
     -------------------------------------------------------------------- */

  /**
   * Avança um tick.
   * @param {Object|string} dir nova direção (ou null/undefined = mantém)
   * @param {Object} ctx { wrap:boolean, arena:COBRA.Arena }
   * @return {{portal:boolean, wrapped:boolean}} objeto REUSADO — leia os
   *         campos no mesmo tick, não guarde a referência.
   */
  Snake.prototype.step = function (dir, ctx) {
    var C = cfg();
    var U = util();
    var W = gridW(), H = gridH();

    var res = this._result;
    res.portal = false;
    res.wrapped = false;

    // Resetado no INÍCIO: se um tick fizer wrap e o seguinte não, o renderer
    // precisa voltar a interpolar imediatamente.
    this.noInterp = false;
    this.ticks++;

    // Direção nova só entra se não for a ré exata — a fila de input já
    // filtra isso (§2), mas a cobra se defende sozinha: aceitar a ré aqui
    // seria suicídio instantâneo dentro do próprio pescoço.
    var d = toDir(dir);
    if (d && !(U && U.isOpposite(d, this.dir))) this.dir = d;
    d = this.dir;

    var cells = this.cells;
    var prev = this.prev;
    var n = cells.length;
    var i;

    // 1) cells -> prev, REUSANDO os objetos de prev (sem array novo).
    for (i = 0; i < n; i++) {
      var p = prev[i];
      if (!p) { p = this._cell(0, 0); prev[i] = p; }
      p.x = cells[i].x;
      p.y = cells[i].y;
    }
    // prev nunca pode ser mais longo que cells (acontece depois de shrink).
    while (prev.length > n) this._cellPool.push(prev.pop());

    // 2) nova cabeça
    var h = cells[0];
    var nx = h.x + d.x;
    var ny = h.y + d.y;

    // 3) wrap das bordas (FANTASMA / modos sem parede)
    if (ctx && ctx.wrap) {
      var wx = wrapN(nx, W);
      var wy = wrapN(ny, H);
      if (wx !== nx || wy !== ny) {
        // Sem isso a cabeça seria interpolada de um lado ao outro da tela
        // num único tick — o "voo" que §2 manda suprimir.
        this.noInterp = true;
        res.wrapped = true;
      }
      nx = wx;
      ny = wy;
    }

    // 4) portal: portalAt() já devolve a PONTA OPOSTA (o destino).
    var arena = ctx && ctx.arena;
    if (arena && arena.portalAt) {
      var dest = arena.portalAt(nx, ny);
      if (dest && this._portalReady(nx, ny)) {
        this._portalCool(nx, ny, dest.x, dest.y);
        nx = dest.x;
        ny = dest.y;
        this.noInterp = true;
        res.portal = true;
      }
    }

    // 5) crescimento: o segmento novo nasce na CAUDA ATUAL, nos DOIS arrays.
    //    Feito ANTES do deslocamento, o shift o empurra sozinho para a
    //    posição correta e a cauda antiga simplesmente não é removida.
    if (this.pendingGrow > 0) {
      this.pendingGrow--;
      var t = cells[n - 1];
      cells.push(this._cell(t.x, t.y));
      prev.push(this._cell(t.x, t.y));   // <- a linha que evita o segmento voador
      n++;
    }

    // 6) desloca o corpo copiando VALORES de trás para frente. Nenhum objeto
    //    é criado ou destruído: quando não há crescimento, a última célula
    //    recebe o valor da penúltima e a cauda "some" naturalmente.
    //
    //    O salto de portal/wrap PROPAGA pelo array: a cabeça pula no tick T
    //    (e `noInterp` cobre esse tick inteiro), mas no tick T+1 o segmento 1
    //    herda o destino do outro lado da arena enquanto `prev[1]` ainda é a
    //    célula de origem — e o renderer, que interpola prev[i]->cells[i] sem
    //    guarda de distância, faria esse segmento RISCAR a tela inteira. E de
    //    novo com o índice 2 no tick T+2, 3 no T+3... por `len-1` ticks.
    //    Por isso a interpolação é suprimida POR SEGMENTO, no tick exato em
    //    que aquele índice dá o salto: se o destino está a mais de 1 célula
    //    (Manhattan), colamos `prev[i]` no destino e o segmento aparece
    //    direto do outro lado — o mesmo tratamento que a cabeça já recebe.
    //    `noInterp` continua correto e intocado: ele cobre o tick do salto.
    for (i = n - 1; i > 0; i--) {
      // cells[i-1] ainda tem o valor ANTIGO (varremos de trás para frente) e
      // cells[i] ainda é idêntico a prev[i] (copiado no passo 1).
      var sx = cells[i - 1].x, sy = cells[i - 1].y;
      var dxs = sx - cells[i].x; if (dxs < 0) dxs = -dxs;
      var dys = sy - cells[i].y; if (dys < 0) dys = -dys;
      if (dxs + dys > 1) { prev[i].x = sx; prev[i].y = sy; }
      cells[i].x = sx;
      cells[i].y = sy;
    }
    cells[0].x = nx;
    cells[0].y = ny;

    // Teleporte/wrap invalidam o rastro em pixels: ele ligaria as duas
    // pontas da tela com um risco de neon atravessado.
    if (this.noInterp) this.clearTrail();

    if (C && C.DEBUG && prev.length !== cells.length) {
      // eslint-disable-next-line no-console
      console.warn('[Snake] prev/cells fora de sincronia', prev.length, cells.length);
    }
    return res;
  };

  /* --------------------------------------------------------------------
     Cooldown de portal (§3.6)
     Chaveado por célula, com o contador de ticks da própria cobra. Marcamos
     as DUAS pontas: sem isso, entrar em A e sair em B faria a saída contar
     como entrada no tick seguinte e a cobra ficaria pingando entre elas.
     -------------------------------------------------------------------- */

  Snake.prototype._portalReady = function (x, y) {
    if (!this._portalCd) return true;
    var U = util();
    var k = U ? U.key(x, y) : (x + ',' + y);
    var until = this._portalCd[k];
    return !(until !== undefined && this.ticks < until);
  };

  Snake.prototype._portalCool = function (ax, ay, bx, by) {
    var C = cfg();
    var U = util();
    var t = (C && C.PORTAL) ? C.PORTAL.COOLDOWN_TICKS : 2;
    if (!this._portalCd) this._portalCd = {};
    var until = this.ticks + t;
    this._portalCd[U ? U.key(ax, ay) : (ax + ',' + ay)] = until;
    this._portalCd[U ? U.key(bx, by) : (bx + ',' + by)] = until;
  };

  /* --------------------------------------------------------------------
     Tamanho
     -------------------------------------------------------------------- */

  /** Enfileira n segmentos; eles nascem 1 por tick (crescimento visível). */
  Snake.prototype.grow = function (n) {
    var k = (n === undefined) ? 1 : (n | 0);
    if (k > 0) this.pendingGrow += k;
    return this.pendingGrow;
  };

  /** Corta n segmentos do FIM (penalidade do ZEN, §3.7).
      O piso vem do CFG.MIN_LEN: abaixo dele a cobra vira um ponto e o jogo
      perde a leitura visual. */
  Snake.prototype.shrink = function (n) {
    var C = cfg();
    // Fonte única de verdade. Antes havia um 3 fixo aqui que só cedia se o
    // CFG fosse MAIOR — então baixar CFG.MIN_LEN não tinha efeito nenhum.
    var min = (C && C.MIN_LEN > 0) ? (C.MIN_LEN | 0) : 3;

    var k = (n === undefined) ? 1 : (n | 0);
    if (k <= 0) return 0;

    var removed = 0;
    while (this.cells.length > min && k-- > 0) {
      this._cellPool.push(this.cells.pop());
      if (this.prev.length > this.cells.length) this._cellPool.push(this.prev.pop());
      removed++;
    }
    // Ondas que já estariam além da nova cauda não têm mais o que percorrer.
    this._clampWaves();
    return removed;
  };

  /**
   * Alguma célula do corpo ocupa (x,y)?
   * @param {boolean} ignoreTail ignora o ÚLTIMO segmento — use true ao testar
   *   o destino da cabeça: a cauda sai daquela célula neste mesmo tick, e sem
   *   isso o jogador morre injustamente ao seguir o próprio rabo.
   *
   * A CABEÇA (índice 0) é sempre contada. Isso é seguro para o teste do
   * destino — a cabeça nunca pisa na própria célula, já que todo passo anda 1
   * célula — e é necessário para o spawn de comida, que precisa saber que a
   * célula da cabeça está ocupada.
   */
  Snake.prototype.hits = function (x, y, ignoreTail) {
    var cells = this.cells;
    var n = cells.length;
    if (ignoreTail && this.pendingGrow === 0) n--;   // cresceu? a cauda FICA
    for (var i = 0; i < n; i++) {
      if (cells[i].x === x && cells[i].y === y) return true;
    }
    return false;
  };

  /** Índice do segmento em (x,y), ou -1. Helper para o efeito de mordida. */
  Snake.prototype.indexAt = function (x, y) {
    for (var i = 0; i < this.cells.length; i++) {
      if (this.cells[i].x === x && this.cells[i].y === y) return i;
    }
    return -1;
  };

  /* --------------------------------------------------------------------
     ONDAS DE ENGOLIDA (§4)
     Um pulso que viaja da cabeça até a cauda a 22 segmentos/s. O renderer
     escala o segmento i por 1 + 0.45*max(0, 1 - |pos - i|/2).
     -------------------------------------------------------------------- */

  /** Nova onda na cabeça. (game.js também pode fazer waves.push({pos:0})
      direto — updateWaves aceita objetos de qualquer origem.) */
  Snake.prototype.addWave = function () {
    var w = this._wavePool.pop();
    if (w) w.pos = 0; else w = { pos: 0 };
    this.waves.push(w);
    return w;
  };

  /** Avança as ondas e recolhe as que passaram da cauda.
      Compacta o array no lugar (write index) para não alocar nem chamar
      splice dentro do laço. */
  Snake.prototype.updateWaves = function (dt) {
    var C = cfg();
    var speed = (C && C.WAVE) ? C.WAVE.SPEED : 22;
    var w = this.waves;
    var n = w.length;
    if (n === 0) return;

    var limit = this.cells.length;
    var adv = speed * (dt || 0) / 1000;
    var k = 0;

    for (var i = 0; i < n; i++) {
      var o = w[i];
      o.pos += adv;
      if (o.pos <= limit) w[k++] = o;
      else this._wavePool.push(o);
    }
    w.length = k;
  };

  Snake.prototype._clampWaves = function () {
    var w = this.waves;
    var limit = this.cells.length;
    var k = 0;
    for (var i = 0; i < w.length; i++) {
      if (w[i].pos <= limit) w[k++] = w[i];
      else this._wavePool.push(w[i]);
    }
    w.length = k;
  };

  Snake.prototype._recycleWaves = function () {
    for (var i = 0; i < this.waves.length; i++) this._wavePool.push(this.waves[i]);
    this.waves.length = 0;
  };

  /** Fator de escala acumulado das ondas no segmento i (§4). O renderer
      chama isto por segmento; é O(nº de ondas), quase sempre 0 ou 1. */
  Snake.prototype.waveScale = function (i) {
    var C = cfg();
    var amp = (C && C.WAVE) ? C.WAVE.AMP : 0.45;
    var width = (C && C.WAVE) ? C.WAVE.WIDTH : 2;
    var s = 1;
    for (var k = 0; k < this.waves.length; k++) {
      var d = this.waves[k].pos - i;
      if (d < 0) d = -d;
      if (d < width) s += amp * (1 - d / width);
    }
    return s;
  };

  /* --------------------------------------------------------------------
     RASTRO DA CABEÇA (§4)
     Buffer circular de 8 posições EM PIXELS DE MUNDO. Não é atualizado pelo
     step(): o rastro precisa da posição INTERPOLADA, que só o renderer
     conhece. O renderer chama pushTrail(px, py, dt) uma vez por frame com o
     centro da cabeça já interpolado; a leitura é por trailAt(0..7), do mais
     recente ao mais antigo.

     A amostragem é por TEMPO, não por frame. Com 8 slots gravados a cada
     frame, o rastro durava ~55ms num monitor de 144Hz (some atrás do sprite
     da cabeça) e ~266ms a 30fps: o mesmo jogo, na mesma partida, mostrava um
     rastro de comprimento diferente só por causa do monitor. Amostrando a
     cada TRAIL_MS o comprimento na tela passa a ser o mesmo em qualquer taxa
     de quadros — é a mesma solução que o renderer já usa no rastro do
     caçador (HUNT_TRAIL_MS).
     -------------------------------------------------------------------- */

  /** Intervalo de amostragem do rastro, em ms. */
  function trailMs() {
    var C = cfg();
    var ms = (C && C.SNAKE && C.SNAKE.TRAIL_MS) ? C.SNAKE.TRAIL_MS : 16;
    return ms > 0 ? ms : 16;
  }

  /**
   * @param {number} px  centro X da cabeça JÁ interpolado, em pixels de mundo
   * @param {number} py  centro Y
   * @param {number} [dt] ms de jogo do frame. Preferir sempre passá-lo: assim
   *        o rastro congela junto com pausa/hitstop. Se o chamador não passar
   *        (compatibilidade), caímos no relógio de parede — o importante é
   *        que a amostragem NÃO volte a ser por frame.
   */
  Snake.prototype.pushTrail = function (px, py, dt) {
    var t = this.headTrail;
    if (t.length === 0) return;

    var ms = trailMs();
    var step;
    if (dt === undefined || dt === null) {
      var tn = now();
      step = this._trailLast ? (tn - this._trailLast) : ms;
      this._trailLast = tn;
    } else {
      step = dt;
    }
    if (step < 0) step = 0;

    this._trailAcc += step;
    if (this._trailAcc < ms) return;
    // Subtrair (em vez de zerar) mantém a taxa média exata quando o frame não
    // é múltiplo de TRAIL_MS; o clamp evita que um engasgo de 500ms deixe um
    // crédito enorme e faça o rastro disparar em rajada nos frames seguintes.
    this._trailAcc -= ms;
    if (this._trailAcc > ms) this._trailAcc = 0;

    var slot = t[this.trailIndex];
    slot.x = px;
    slot.y = py;
    this.trailIndex = (this.trailIndex + 1) % t.length;
    if (this.trailCount < t.length) this.trailCount++;
  };

  /** i = 0 é a posição mais recente. Retorna null se ainda não existe. */
  Snake.prototype.trailAt = function (i) {
    var t = this.headTrail;
    if (i < 0 || i >= this.trailCount) return null;
    var n = t.length;
    return t[(this.trailIndex - 1 - i + n * 2) % n];
  };

  Snake.prototype.clearTrail = function () {
    this.trailIndex = 0;
    this.trailCount = 0;
    // Zerar o acumulador junto: depois de um portal o rastro recomeça do
    // nada, e um crédito de tempo pendente gravaria duas amostras coladas.
    this._trailAcc = 0;
    this._trailLast = 0;
  };

  /* ======================================================================
     COMIDA (§3.2 / §9.7)
     ====================================================================== */

  /**
   * @param {number} x
   * @param {number} y
   * @param {string} type 'normal' | 'gold' | 'crystal'
   * @param {number} [bornAt] instante de nascimento (default: agora)
   */
  function Food(x, y, type, bornAt) {
    var C = cfg();
    var t = type || 'normal';
    var def = (C && C.FOOD && C.FOOD[t]) ? C.FOOD[t] : null;

    // --- contrato §9.7 ---
    this.x = x | 0;
    this.y = y | 0;
    this.type = t;
    this.born = (bornAt === undefined || bornAt === null) ? now() : bornAt;
    this.ttl = def ? def.ttl : 0;            // 0 = eterna
    // Fase aleatória do pulso: se todas as comidas pulsassem em fase, o
    // brilho viraria um metrônomo; a fase quebra a repetição entre partidas.
    this.pulse = Math.random() * TAU;

    // --- conveniências (evitam game.js/renderer relerem o CFG por frame) ---
    this.px = this.x;                        // posição anterior (ÍMÃ, §3.3):
    this.py = this.y;                        // o renderer interpola px->x
    this.pts = def ? def.pts : 10;
    this.grow = def ? def.grow : 1;
    this.cor = def ? def.cor : '#ff2d95';
    this.blink = def ? def.blink : 0;
  }

  /** ttl 0 nunca expira. */
  Food.prototype.expired = function (t) {
    if (!this.ttl) return false;
    return ((t === undefined ? now() : t) - this.born) >= this.ttl;
  };

  /** ms restantes; Infinity se eterna. Base do piscar dos últimos 2000ms. */
  Food.prototype.remaining = function (t) {
    if (!this.ttl) return Infinity;
    var r = this.ttl - ((t === undefined ? now() : t) - this.born);
    return r > 0 ? r : 0;
  };

  /** Está na janela final de piscar? (§3.2) */
  Food.prototype.blinking = function (t) {
    if (!this.ttl || !this.blink) return false;
    return this.remaining(t) <= this.blink;
  };

  /** 0..1 de vida consumida (para o anel de TTL do renderer). */
  Food.prototype.progress = function (t) {
    if (!this.ttl) return 0;
    var p = ((t === undefined ? now() : t) - this.born) / this.ttl;
    return p < 0 ? 0 : (p > 1 ? 1 : p);
  };

  /** Movimento do ÍMÃ: guarda a posição antiga para o renderer interpolar.
      CONTRATO (§2): px/py é a posição do TICK ANTERIOR, e não "a posição
      antes do último moveTo". Como o ÍMÃ só anda a cada MAGNET_EVERY_TICKS,
      quem chama (game.js: tickFood) PRECISA chamar settle() nos ticks em que
      a comida NÃO se mexe — inclusive quando o destino está bloqueado. Sem
      isso px/py ficam velhos, o renderer refaz o mesmo deslizamento no tick
      seguinte e a comida parece pular uma célula para trás e voltar. */
  Food.prototype.moveTo = function (x, y) {
    this.px = this.x;
    this.py = this.y;
    this.x = x | 0;
    this.y = y | 0;
  };

  /** Cola px/py em x/y — usar no spawn (a comida aparece do nada) E em todo
      tick em que ela não anda, para reciclar px/py como manda o §2. */
  Food.prototype.settle = function () {
    this.px = this.x;
    this.py = this.y;
  };

  /* ======================================================================
     CAÇADOR (§3.5 / §9.7)
     ====================================================================== */

  /** Ordem fixa de varredura dos vizinhos. Fixa (e não aleatória) porque o
      empate deve ser resolvido pela direção anterior — comportamento
      previsível é o que torna o caçador justo. */
  var HDX = [0, 1, 0, -1];
  var HDY = [-1, 0, 1, 0];

  function Hunter(x, y) {
    // --- contrato §9.7 ---
    this.x = x | 0;
    this.y = y | 0;
    this.px = this.x;         // posição do passo anterior (interpolação, §2)
    this.py = this.y;
    this.alive = true;
    this.spawning = true;     // materializando: intangível e piscando
    this.spawnT = 0;          // ms JÁ decorridos da materialização
    this.dir = { x: 0, y: 0 };

    // --- extras para o renderer ---
    this.moveEvery = 0;       // ticks por passo (0 = lê do CFG a cada update)
    this.sinceMove = 0;       // ticks completos desde o último passo
    this.moveProgress = 0;    // 0..1 do passo atual (atualizado em lerpT)
    this.phase = Math.random() * TAU;   // fase do anel/olho do drone

    this._born = now();       // relógio de emergência (ver updateSpawn)
    this._dtDriven = false;   // true assim que alguém chama updateSpawn(dt)
    this._lastTick = -1;      // idempotência: 2 updates no mesmo tick não contam 2
  }

  /** Reposiciona reusando a instância (o Game mantém um pool de caçadores). */
  Hunter.prototype.reset = function (x, y) {
    this.x = x | 0;
    this.y = y | 0;
    this.px = this.x;
    this.py = this.y;
    this.alive = true;
    this.spawning = true;
    this.spawnT = 0;
    this.dir.x = 0;
    this.dir.y = 0;
    this.sinceMove = 0;
    this.moveProgress = 0;
    this._born = now();
    this._dtDriven = false;
    this._lastTick = -1;
    return this;
  };

  function spawnMs() {
    var C = cfg();
    return (C && C.HUNTER) ? C.HUNTER.SPAWN_MS : 1200;
  }

  /**
   * Avança a materialização. DEVE ser chamado pelo Game a cada frame com o
   * dt do jogo — assim a animação congela junto com hitstop/pausa/slow-mo,
   * em vez de correr no relógio de parede.
   */
  Hunter.prototype.updateSpawn = function (dt) {
    this._dtDriven = true;
    if (!this.spawning) return;
    this.spawnT += (dt || 0);
    if (this.spawnT >= spawnMs()) {
      this.spawnT = spawnMs();
      this.spawning = false;
    }
  };

  /** 0..1 da materialização (1 = totalmente sólido). */
  Hunter.prototype.spawnProgress = function () {
    var ms = spawnMs();
    if (ms <= 0) return 1;
    var p = this.spawnT / ms;
    return p < 0 ? 0 : (p > 1 ? 1 : p);
  };

  /** Intangível durante a materialização (§3.5): não mata nem morre. */
  Hunter.prototype.isTangible = function () {
    return this.alive && !this.spawning;
  };

  /** Uma célula é pisável pelo caçador? Descarta o que está fora da grade
      (as bordas externas), os muros e os portais — §3.5 diz que ele nunca
      entra em portal (senão ele reapareceria do outro lado do mapa e a
      perseguição deixaria de ser legível para o jogador). */
  function hunterFree(arena, x, y) {
    if (x < 0 || y < 0 || x >= gridW() || y >= gridH()) return false;
    if (!arena) return true;
    if (arena.isWall && arena.isWall(x, y)) return false;
    if (arena.isPortal && arena.isPortal(x, y)) return false;
    return true;
  }

  /**
   * Passo do caçador (§3.5).
   * @param {number} tick contador global de ticks do Game
   * @param {number} headX
   * @param {number} headY
   * @param {Object} arena COBRA.Arena
   * @param {number} [everyTicks] override (3 quando TEMPO LENTO está ativo);
   *        também pode ser fixado em h.moveEvery.
   * @return {boolean} true se andou neste tick
   */
  Hunter.prototype.update = function (tick, headX, headY, arena, everyTicks) {
    if (!this.alive) return false;

    var C = cfg();
    var U = util();

    // Rede de segurança: se ninguém estiver chamando updateSpawn(dt), a
    // materialização ainda termina pelo relógio de parede. Nunca deixamos um
    // caçador intangível para sempre — isso seria um inimigo fantasma eterno.
    if (this.spawning && !this._dtDriven) {
      this.spawnT = now() - this._born;
      if (this.spawnT >= spawnMs()) {
        this.spawnT = spawnMs();
        this.spawning = false;
      }
    }
    if (this.spawning) return false;

    var step = everyTicks | 0;
    if (!step) step = this.moveEvery | 0;
    if (!step) step = (C && C.HUNTER) ? C.HUNTER.MOVE_EVERY_TICKS : 2;
    if (step < 1) step = 1;
    this.moveEvery = step;

    // Idempotência: o Game pode chamar update mais de uma vez no mesmo tick
    // (ex.: recuperando ticks atrasados); contar sinceMove duas vezes
    // adiantaria a interpolação e o drone tremeria.
    var t = tick | 0;
    if (t === this._lastTick) return false;
    this._lastTick = t;

    if (t % step !== 0) {
      if (this.sinceMove < step - 1) this.sinceMove++;
      return false;
    }

    // px/py ANTES de mover: é o par que o renderer interpola (§2).
    this.px = this.x;
    this.py = this.y;

    var bestI = -1;
    var bestD = Infinity;
    var keepI = -1;              // candidato que mantém a direção anterior
    var i, nx, ny, d;

    for (i = 0; i < 4; i++) {
      nx = this.x + HDX[i];
      ny = this.y + HDY[i];
      if (!hunterFree(arena, nx, ny)) continue;

      d = U ? U.manhattan(nx, ny, headX, headY)
            : (Math.abs(nx - headX) + Math.abs(ny - headY));

      if (d < bestD) {
        bestD = d;
        bestI = i;
        keepI = -1;
      }
      // Empate resolvido pela direção anterior (§3.5): sem isso o drone
      // ficaria vibrando entre dois vizinhos equidistantes.
      if (d === bestD && this.dir.x === HDX[i] && this.dir.y === HDY[i]) {
        keepI = i;
      }
    }

    if (keepI >= 0) bestI = keepI;
    if (bestI < 0) {
      // Encurralado: fica parado, mas o passo "conta" para o ritmo.
      this.sinceMove = 0;
      this.moveProgress = 0;
      return false;
    }

    this.dir.x = HDX[bestI];
    this.dir.y = HDY[bestI];
    this.x += this.dir.x;
    this.y += this.dir.y;
    this.sinceMove = 0;
    this.moveProgress = 0;
    return true;
  };

  /**
   * Fator de interpolação do caçador, 0..1.
   * O renderer chama h.lerpT(game.tickProgress) e desenha em
   * lerp(px, x, t) — o passo do drone dura `moveEvery` ticks, então ele
   * desliza suave por 2 ticks inteiros em vez de teleportar a cada 2 ticks.
   */
  Hunter.prototype.lerpT = function (tickProgress) {
    var step = this.moveEvery > 0 ? this.moveEvery : 2;
    var p = (this.sinceMove + (tickProgress || 0)) / step;
    if (p < 0) p = 0; else if (p > 1) p = 1;
    this.moveProgress = p;
    return p;
  };

  /** Distância de Manhattan até (x,y). Usado pelo alerta sonoro/spawn. */
  Hunter.prototype.distTo = function (x, y) {
    var U = util();
    return U ? U.manhattan(this.x, this.y, x, y)
             : (Math.abs(this.x - x) + Math.abs(this.y - y));
  };

  /* ====================================================================== */

  COBRA.Snake = Snake;
  COBRA.Food = Food;
  COBRA.Hunter = Hunter;
})();
