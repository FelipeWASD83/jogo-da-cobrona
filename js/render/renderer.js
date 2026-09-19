/* =============================================================================
 * COBRONA :: PROTOCOLO NEON — js/render/renderer.js  ->  COBRA.Renderer
 * -----------------------------------------------------------------------------
 * Contrato §9.10:
 *
 *   Renderer.init(canvasEl)
 *   Renderer.resize()
 *   Renderer.render(game, dt)
 *
 * -----------------------------------------------------------------------------
 * FILOSOFIA DE CUSTO (alvo: 60fps num notebook modesto)
 *
 * O jogo tem, no pior caso, ~150 segmentos de cobra + ~70 muros + 5 caçadores +
 * 4 portais + 900 partículas, TODOS brilhando. Se cada um deles pagasse um
 * `shadowBlur`, o frame acabaria antes da cobra terminar de ser desenhada:
 * shadowBlur é um blur gaussiano por primitiva, e o Canvas2D o executa na CPU
 * na maioria das engines.
 *
 * Então a regra é absoluta e vale para o arquivo inteiro:
 *
 *   1. TODO brilho é COZIDO uma única vez em sprites offscreen no init().
 *      Dentro de render() só existe `drawImage`.
 *   2. Brilho em runtime = `globalCompositeOperation = 'lighter'` (soma de luz),
 *      que é praticamente de graça comparado a um blur.
 *   3. Zero alocação por frame: as posições interpoladas dos segmentos vivem em
 *      Float64Array reusados, as strings de cor do corpo são pré-montadas
 *      (36 matizes) e os rastros dos caçadores saem de um pool fixo.
 *   4. `save()/restore()` só onde é barato; nos laços quentes as transformações
 *      são desfeitas à mão (rotate(-a) / translate(-x,-y)).
 *
 * A cobra é desenhada da CAUDA para a CABEÇA — a cabeça é o elemento mais
 * importante da tela e precisa ficar por cima de tudo o que é corpo.
 *
 * Nada de COBRA.CFG (ou qualquer outro módulo) no escopo de topo: só dentro de
 * funções, conforme a regra de ouro do §8.
 * ========================================================================== */

(function () {
  'use strict';

  window.COBRA = window.COBRA || {};

  /* ---------------------------------------------------------------------------
   * Constantes puramente estéticas do renderer (não são gameplay -> não vão pro
   * CFG, que é a fonte da verdade só das regras do jogo).
   * ------------------------------------------------------------------------ */

  var SPR      = 64;      // lado do sprite: célula de 32 + 16px de margem de brilho de cada lado
  var SPR_HALF = 32;

  var BODY_SIZE   = 26;   // lado do quadrado do corpo dentro do sprite
  var BODY_RADIUS = 8;
  var HEAD_SIZE   = 30;
  var HEAD_RADIUS = 9;

  // Matizes pré-assadas do corpo e alpha do rastro vêm de CFG.SNAKE
  // (HUE_SPRITES, TRAIL_ALPHA), lidos no init(). Os números aqui são só a
  // reserva para o caso de o CFG não ter carregado e têm que bater com ele.
  var HUE_SPRITES = 36;   // 36 matizes (hue = i*10) — 10° de erro é invisível a olho nu
  var HUE_STEPDEG = 10;   // sempre 360 / HUE_SPRITES

  var LINK_W      = 22;   // espessura do retângulo que emenda dois segmentos
  var WAVE_CLAMP  = 1.75; // teto da soma das ondas de engolida (§4)

  var TRAIL_ALPHA = 0.45; // alpha do rastro mais recente da cabeça (CFG.SNAKE.TRAIL_ALPHA)
  var HUNT_TRAIL  = 6;    // posições no rastro de cada caçador
  var HUNT_TRAIL_MS = 34; // intervalo de amostragem do rastro do caçador

  var SCAN_ALPHA  = 0.10; // o CSS já desenha scanlines; aqui é só o reforço no canvas
  var VIG_ALPHA   = 0.45;

  var DPR_CAP     = 2;    // acima de 2x o ganho visual é nulo e o fill-rate dobra

  var TAU = Math.PI * 2;

  // Arrays constantes: setLineDash exige um array, e criar um por frame seria
  // lixo garantido para o GC no meio do loop de render.
  var GHOST_DASH = [5, 4];
  var EMPTY_DASH = [];

  /* ---------------------------------------------------------------------------
   * ESTADO DO MÓDULO — tudo nulo/zero até init(). Nada aqui toca no CFG.
   * ------------------------------------------------------------------------ */

  var canvas = null, ctx = null;
  var dpr = 1;
  var W = 960, H = 640, CELL = 32, HALF = 16;

  var ready = false;

  // --- sprites cozidos ---
  var sprBody     = [];    // 36 canvases, um por matiz
  var bodyColors  = [];    // 36 strings 'hsl(...)' — pré-montadas p/ os elos
  var sprHead     = null;
  var sprHeadFury = null;
  var sprFood     = { normal: null, gold: null, crystal: null };
  var sprWall     = null;
  var sprHunter   = null;
  var sprPortal   = null;
  var sprShield   = null;
  var sprRingSpawn = null; // anel de materialização do caçador
  var glow        = {};    // halos radiais por cor (chave = hex)

  // --- overlay CRT de tela cheia (scanlines + vinheta), em pixels de DISPOSITIVO ---
  var cvCrt = null;

  // --- buffers de interpolação da cobra (reusados) ---
  var posX = null, posY = null, posCap = 0;

  // --- relógio próprio do renderer (avança com o dt REAL de main.js) ---
  var time = 0;      // ms
  var furyAcc = 0;   // acumulador do emissor de partículas da FÚRIA

  // --- rastros dos caçadores: pool fixo indexado pela posição na lista ---
  var huntTrails = [];

  // --- memória do passo da comida (ÍMÃ, §3.3) ---
  // O Food guarda px/py, mas quem os atualiza é o Game, e SÓ no tick em que a
  // comida realmente anda (ÍMÃ = 1 célula a cada MAGNET_EVERY_TICKS ticks).
  // Nos ticks intermediários px/py continuam apontando para a célula ANTERIOR,
  // e como tickProgress volta a 0 a cada tick, interpolar px->x sempre faria a
  // comida voltar 1 célula e refazer o mesmo trecho — gaguejando de ré.
  // Guardamos aqui em qual tick a comida mudou de célula: só nesse tick o
  // par px/py descreve o passo em andamento; nos demais ela é desenhada parada.
  var foodRef = null, foodCX = -1, foodCY = -1, foodMoveTick = -1;

  // --- throttle do listener de resize ---
  var resizeTimer = 0;
  var listening = false;

  /* ---------------------------------------------------------------------------
   * Acesso tardio aos módulos vizinhos
   * ------------------------------------------------------------------------ */

  function cfg()   { return window.COBRA.CFG || null; }
  function util()  { return window.COBRA.Util || null; }
  function fx()    { return window.COBRA.FX || null; }
  function bg()    { return window.COBRA.BG || null; }
  function arena() { return window.COBRA.Arena || null; }

  function pal(nome, fallback) {
    var C = cfg();
    return (C && C.PAL && C.PAL[nome]) ? C.PAL[nome] : fallback;
  }

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width  = Math.max(1, w | 0);
    c.height = Math.max(1, h | 0);
    return c;
  }

  /** '#rrggbb' -> 'rgba(r,g,b,a)'. Usa Util quando existe; a cópia local é só
      rede de segurança para o arquivo nunca depender da ordem de carga. */
  function rgba(hex, a) {
    var U = util();
    if (U && U.rgba) return U.rgba(hex, a);
    var h = hex.charAt(0) === '#' ? hex.slice(1) : hex;
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /** Retângulo de cantos arredondados. Escrito à mão em vez de ctx.roundRect
      porque roundRect só existe em engines recentes e este jogo precisa abrir
      com duplo clique em qualquer navegador. Só roda na cozinha dos sprites. */
  function roundRect(g, x, y, w, h, r) {
    if (r > w * 0.5) r = w * 0.5;
    if (r > h * 0.5) r = h * 0.5;
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y,     x + w, y + h, r);
    g.arcTo(x + w, y + h, x,     y + h, r);
    g.arcTo(x,     y + h, x,     y,     r);
    g.arcTo(x,     y,     x + w, y,     r);
    g.closePath();
  }

  /* ===========================================================================
   * COZINHA DOS SPRITES
   * Tudo aqui roda UMA vez (init) e nunca mais. É o único lugar do arquivo onde
   * shadowBlur é permitido.
   * ======================================================================== */

  /** Segmento do corpo: quadrado arredondado com halo forte + núcleo claro.
      O halo é aplicado em duas passadas porque um único fill com shadowBlur
      alto fica lavado; a segunda passada satura o miolo do brilho. */
  function bakeBody(hue, size, radius, light, coreLight) {
    var c = makeCanvas(SPR, SPR);
    var g = c.getContext('2d');
    var x = (SPR - size) * 0.5;

    g.shadowColor = 'hsl(' + hue + ',100%,' + (light + 8) + '%)';
    g.shadowBlur = 17;
    g.fillStyle = 'hsl(' + hue + ',100%,' + light + '%)';
    roundRect(g, x, x, size, size, radius);
    g.fill();
    g.fill();                                    // 2ª passada: satura o halo

    // Núcleo mais claro: dá a leitura de "tubo de neon aceso" em vez de
    // "quadrado colorido". Deliberadamente NÃO é branco — o corpo é desenhado
    // em 'lighter' e um núcleo branco somaria com o halo do segmento vizinho,
    // estourando a cobra inteira em branco e apagando o gradiente de matiz.
    var s2 = size * 0.46, x2 = (SPR - s2) * 0.5;
    g.shadowBlur = 7;
    g.shadowColor = 'hsl(' + hue + ',100%,85%)';
    g.fillStyle = 'hsl(' + hue + ',100%,' + coreLight + '%)';
    roundRect(g, x2, x2, s2, s2, radius * 0.6);
    g.fill();

    return c;
  }

  /** Cabeça: variante mais brilhante do corpo com dois olhos.
      Desenhada SEM rotação, apontando para +x (RIGHT); o render rotaciona no
      drawImage conforme a direção — assim uma única cabeça serve para as 4. */
  function bakeHead(hue) {
    var c = bakeBody(hue, HEAD_SIZE, HEAD_RADIUS, 58, 78);
    var g = c.getContext('2d');
    var cx = SPR_HALF, cy = SPR_HALF;

    // Os olhos ficam à FRENTE do núcleo claro (x + 8.5): dentro dele eles
    // simplesmente sumiriam, e é o par de olhos que informa a direção do
    // movimento num relance, sem o jogador precisar ler a forma toda.
    g.shadowBlur = 0;
    g.fillStyle = '#04010c';
    g.beginPath(); g.arc(cx + 8.5, cy - 5.5, 3.4, 0, TAU); g.fill();
    g.beginPath(); g.arc(cx + 8.5, cy + 5.5, 3.4, 0, TAU); g.fill();
    // pupila acesa
    g.shadowColor = '#ffffff';
    g.shadowBlur = 5;
    g.fillStyle = '#ffffff';
    g.beginPath(); g.arc(cx + 9.4, cy - 5.5, 1.6, 0, TAU); g.fill();
    g.beginPath(); g.arc(cx + 9.4, cy + 5.5, 1.6, 0, TAU); g.fill();
    return c;
  }

  /** Halo radial reusável. Desenhado com 'lighter' vira brilho de qualquer
      coisa (rastro, aura de comida, explosão de escudo) por um drawImage. */
  function bakeGlow(hex) {
    var c = makeCanvas(SPR, SPR);
    var g = c.getContext('2d');
    var r = SPR_HALF;
    var grad = g.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0.00, rgba(hex, 0.95));
    grad.addColorStop(0.35, rgba(hex, 0.35));
    grad.addColorStop(1.00, rgba(hex, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, SPR, SPR);
    return c;
  }

  function glowOf(hex) {
    var c = glow[hex];
    if (!c) { c = bakeGlow(hex); glow[hex] = c; }
    return c;
  }

  /** Comida normal: esfera de neon. */
  function bakeFoodRound(hex) {
    var c = makeCanvas(SPR, SPR);
    var g = c.getContext('2d');
    g.shadowColor = hex;
    g.shadowBlur = 18;
    g.fillStyle = hex;
    g.beginPath(); g.arc(SPR_HALF, SPR_HALF, 10, 0, TAU); g.fill();
    g.fill();
    g.shadowBlur = 8;
    g.fillStyle = '#ffffff';
    g.beginPath(); g.arc(SPR_HALF, SPR_HALF, 4.4, 0, TAU); g.fill();
    // realce especular deslocado: dá volume sem custar nada em runtime
    g.shadowBlur = 0;
    g.globalAlpha = 0.75;
    g.beginPath(); g.arc(SPR_HALF - 2.6, SPR_HALF - 3, 1.8, 0, TAU); g.fill();
    return c;
  }

  /** Comida dourada: núcleo redondo + quatro pontas (estrela de brilho). */
  function bakeFoodGold(hex) {
    var c = bakeFoodRound(hex);
    var g = c.getContext('2d');
    g.globalAlpha = 1;
    g.shadowColor = hex;
    g.shadowBlur = 12;
    g.fillStyle = hex;
    g.beginPath();
    g.moveTo(SPR_HALF, SPR_HALF - 16);
    g.lineTo(SPR_HALF + 3.2, SPR_HALF);
    g.lineTo(SPR_HALF, SPR_HALF + 16);
    g.lineTo(SPR_HALF - 3.2, SPR_HALF);
    g.closePath(); g.fill();
    g.beginPath();
    g.moveTo(SPR_HALF - 16, SPR_HALF);
    g.lineTo(SPR_HALF, SPR_HALF - 3.2);
    g.lineTo(SPR_HALF + 16, SPR_HALF);
    g.lineTo(SPR_HALF, SPR_HALF + 3.2);
    g.closePath(); g.fill();
    return c;
  }

  /** Cristal: losango violeta com faceta interna (o render o faz girar). */
  function bakeFoodCrystal(hex) {
    var c = makeCanvas(SPR, SPR);
    var g = c.getContext('2d');
    var r = 13.5;
    g.shadowColor = hex;
    g.shadowBlur = 18;
    g.fillStyle = hex;
    g.beginPath();
    g.moveTo(SPR_HALF, SPR_HALF - r);
    g.lineTo(SPR_HALF + r * 0.72, SPR_HALF);
    g.lineTo(SPR_HALF, SPR_HALF + r);
    g.lineTo(SPR_HALF - r * 0.72, SPR_HALF);
    g.closePath(); g.fill();
    g.fill();
    g.shadowBlur = 6;
    g.fillStyle = '#ffffff';
    g.globalAlpha = 0.9;
    g.beginPath();
    g.moveTo(SPR_HALF, SPR_HALF - r * 0.55);
    g.lineTo(SPR_HALF + r * 0.3, SPR_HALF);
    g.lineTo(SPR_HALF, SPR_HALF + r * 0.55);
    g.lineTo(SPR_HALF - r * 0.3, SPR_HALF);
    g.closePath(); g.fill();
    return c;
  }

  /** Muro: bloco escuro OPACO (precisa ocultar o grid) com borda neon.
      É o único sprite desenhado em 'source-over' no loop. */
  function bakeWall() {
    var c = makeCanvas(SPR, SPR);
    var g = c.getContext('2d');
    var s = CELL, x = (SPR - s) * 0.5;
    var borda = pal('gridGlow', '#4b1fa8');

    g.shadowColor = borda;
    g.shadowBlur = 14;
    g.strokeStyle = borda;
    g.lineWidth = 2;
    roundRect(g, x + 1, x + 1, s - 2, s - 2, 4);
    g.fillStyle = '#0a0520';                       // miolo quase preto
    g.fill();
    g.stroke();
    g.shadowBlur = 0;

    // Diagonais internas: leem como "placa de circuito" e quebram a
    // monotonia de um bloco liso quando há dezenas deles na tela.
    g.globalAlpha = 0.22;
    g.strokeStyle = borda;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x + 6, x + s - 6); g.lineTo(x + s - 6, x + 6);
    g.moveTo(x + 12, x + s - 5); g.lineTo(x + s - 5, x + 12);
    g.stroke();
    return c;
  }

  /** Caçador: losango vermelho agressivo com um "olho" central.
      Ângulos retos e ponta para cima = leitura imediata de ameaça. */
  function bakeHunter() {
    var c = makeCanvas(SPR, SPR);
    var g = c.getContext('2d');
    var cor = pal('danger', '#ff2b2b');
    var r = 14;

    g.shadowColor = cor;
    g.shadowBlur = 13;
    g.fillStyle = cor;
    g.beginPath();
    g.moveTo(SPR_HALF, SPR_HALF - r);
    g.lineTo(SPR_HALF + r, SPR_HALF);
    g.lineTo(SPR_HALF, SPR_HALF + r);
    g.lineTo(SPR_HALF - r, SPR_HALF);
    g.closePath();
    g.fill();
    g.fill();

    // Triângulo interno escuro: transforma o losango numa "cabeça de flecha".
    g.shadowBlur = 0;
    g.fillStyle = '#1a0004';
    g.beginPath();
    g.moveTo(SPR_HALF, SPR_HALF - 6);
    g.lineTo(SPR_HALF + 6, SPR_HALF + 4);
    g.lineTo(SPR_HALF - 6, SPR_HALF + 4);
    g.closePath();
    g.fill();

    g.shadowColor = '#ffffff';
    g.shadowBlur = 8;
    g.fillStyle = '#ffe6e6';
    g.beginPath(); g.arc(SPR_HALF, SPR_HALF - 0.5, 2.2, 0, TAU); g.fill();
    return c;
  }

  /** Anel (portal / escudo / materialização). Raio em pixels dentro do sprite;
      `notches` recorta o anel em arcos para ele "girar" visivelmente. */
  function bakeRing(hex, radius, width, notches, alpha) {
    var c = makeCanvas(SPR, SPR);
    var g = c.getContext('2d');
    g.globalAlpha = alpha === undefined ? 1 : alpha;
    g.shadowColor = hex;
    g.shadowBlur = 14;
    g.strokeStyle = hex;
    g.lineWidth = width;
    g.lineCap = 'butt';

    if (notches > 0) {
      var passo = TAU / notches;
      var arco = passo * 0.62;                    // 62% aceso, 38% apagado
      for (var i = 0; i < notches; i++) {
        g.beginPath();
        g.arc(SPR_HALF, SPR_HALF, radius, i * passo, i * passo + arco);
        g.stroke();
      }
    } else {
      g.beginPath();
      g.arc(SPR_HALF, SPR_HALF, radius, 0, TAU);
      g.stroke();
    }
    return c;
  }

  /** Portal: anel externo entalhado + anel interno fino contrarrotante. */
  function bakePortal() {
    var C = cfg();
    var cor = (C && C.PORTAL && C.PORTAL.COR) || pal('violet', '#a855ff');
    var c = bakeRing(cor, 12.5, 3.5, 6, 1);
    var g = c.getContext('2d');
    g.globalAlpha = 0.8;
    g.shadowColor = cor;
    g.shadowBlur = 10;
    g.strokeStyle = '#e9d6ff';
    g.lineWidth = 1.4;
    g.beginPath(); g.arc(SPR_HALF, SPR_HALF, 6.5, 0, TAU); g.stroke();
    return c;
  }

  function bakeSprites() {
    var C = cfg();
    var hueHead = (C && C.SNAKE) ? C.SNAKE.HUE_HEAD : 185;

    sprBody.length = 0;
    bodyColors.length = 0;
    for (var i = 0; i < HUE_SPRITES; i++) {
      var hue = i * HUE_STEPDEG;
      sprBody.push(bakeBody(hue, BODY_SIZE, BODY_RADIUS, 50, 68));
      // A string do elo é montada AQUI: no loop de render ela seria
      // 150 concatenações por frame só para a cobra. Luminosidade abaixo da do
      // sprite: o elo é "tubo", o sprite é "lâmpada".
      bodyColors.push('hsl(' + hue + ',100%,42%)');
    }

    sprHead     = bakeHead(hueHead);
    sprHeadFury = bakeHead(16);                    // laranja-vermelho da FÚRIA

    sprFood.normal  = bakeFoodRound(pal('magenta', '#ff2d95'));
    sprFood.gold    = bakeFoodGold(pal('amber', '#ffb800'));
    sprFood.crystal = bakeFoodCrystal(pal('violet', '#a855ff'));

    sprWall      = bakeWall();
    sprHunter    = bakeHunter();
    sprPortal    = bakePortal();
    sprShield    = bakeRing(pal('cyan', '#00f0ff'), 20, 2.6, 8, 1);
    sprRingSpawn = bakeRing(pal('danger', '#ff2b2b'), 26, 2, 10, 1);

    // Pré-cozinha os halos mais usados para não pagar o gradiente no 1º frame.
    glowOf(pal('cyan', '#00f0ff'));
    glowOf(pal('magenta', '#ff2d95'));
    glowOf(pal('amber', '#ffb800'));
    glowOf(pal('violet', '#a855ff'));
    glowOf(pal('danger', '#ff2b2b'));
  }

  /* ===========================================================================
   * OVERLAYS DE TELA CHEIA
   * Recozidos no resize porque são feitos em pixels de DISPOSITIVO: assim as
   * scanlines ficam com 1px físico (nítidas) em telas HiDPI, em vez de virarem
   * um borrão cinza depois do upscale do devicePixelRatio.
   * ======================================================================== */

  function bakeOverlays(dw, dh) {
    // As DUAS camadas vão para o MESMO canvas, já com os alphas finais
    // embutidos. Um blit de tela cheia em 1920x1280 é a operação mais cara que
    // este arquivo executa por frame; fazer dois (um por camada) custaria o
    // dobro para um resultado pixel a pixel idêntico ao de compô-las agora.
    cvCrt = makeCanvas(dw, dh);
    var g = cvCrt.getContext('2d');

    // --- scanlines ---
    // Passo de 3 pixels lógicos escalados pelo dpr: em 1x são as clássicas
    // linhas de CRT; em 2x continuam com a mesma espessura APARENTE.
    var passo = Math.max(2, Math.round(3 * dpr));
    var esp = Math.max(1, Math.round(dpr));
    g.globalAlpha = SCAN_ALPHA;
    g.fillStyle = '#000000';
    for (var y = 0; y < dh; y += passo) g.fillRect(0, y, dw, esp);

    // --- vinheta ---
    var cx = dw * 0.5, cy = dh * 0.5;
    var grad = g.createRadialGradient(cx, cy, Math.min(dw, dh) * 0.34,
                                      cx, cy, Math.max(dw, dh) * 0.72);
    grad.addColorStop(0.0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.6, 'rgba(0,0,0,0.35)');
    grad.addColorStop(1.0, 'rgba(0,0,0,1)');
    g.globalAlpha = VIG_ALPHA;
    g.fillStyle = grad;
    g.fillRect(0, 0, dw, dh);
    g.globalAlpha = 1;
  }

  /* ===========================================================================
   * BUFFERS DE INTERPOLAÇÃO
   * ======================================================================== */

  function ensurePosCap(n) {
    if (n <= posCap) return;
    var cap = posCap ? posCap : 64;
    while (cap < n) cap *= 2;
    posX = new Float64Array(cap);
    posY = new Float64Array(cap);
    posCap = cap;
  }

  function ensureHuntTrails() {
    var C = cfg();
    var max = (C && C.HUNTER) ? C.HUNTER.MAX : 5;
    while (huntTrails.length < max) {
      huntTrails.push({
        ref: null,
        x: new Float32Array(HUNT_TRAIL),
        y: new Float32Array(HUNT_TRAIL),
        // lx/ly declarados AQUI (e não criados no 1º frame): acrescentar uma
        // propriedade a um objeto já em uso troca a hidden class dele no meio
        // do laço quente e derruba a otimização do JIT.
        n: 0, i: 0, acc: 0, lx: 0, ly: 0
      });
    }
  }

  /* ===========================================================================
   * DESENHO — helpers de sprite
   * ======================================================================== */

  /** drawImage centrado, com escala. `s` é multiplicador do sprite inteiro. */
  function spr(img, cx, cy, s) {
    var w = SPR * s, h = w * 0.5;
    ctx.drawImage(img, cx - h, cy - h, w, w);
  }

  /** Igual ao anterior, mas rotacionado. Desfaz a transformação à mão em vez de
      save/restore: em laços com dezenas de chamadas isso é medível. */
  function sprRot(img, cx, cy, s, ang) {
    var w = SPR * s, h = w * 0.5;
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    ctx.drawImage(img, -h, -h, w, w);
    ctx.rotate(-ang);
    ctx.translate(-cx, -cy);
  }

  /* ===========================================================================
   * CAMADAS DO MUNDO
   * ======================================================================== */

  /** §3.6 — portais: anel girando com pulso. Puramente aditivo. */
  function drawPortals(t) {
    var A = arena();
    if (!A || !A.portals || A.portals.length === 0) return;
    var C = cfg();
    var vel = (C && C.PORTAL) ? C.PORTAL.RING_SPEED : 1.6;
    var vcor = pal('violet', '#a855ff');
    var halo = glowOf(vcor);

    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < A.portals.length; i++) {
      var p = A.portals[i];
      var cx = p.x * CELL + HALF;
      var cy = p.y * CELL + HALF;
      var ph = p.phase || 0;
      var puls = 0.5 + 0.5 * Math.sin(t * 2.2 + ph);

      ctx.globalAlpha = 0.30 + 0.16 * puls;
      spr(halo, cx, cy, 0.95 + 0.1 * puls);

      ctx.globalAlpha = 0.85;
      // As duas pontas do par giram em sentidos opostos (end 0/1): é a dica
      // visual mais barata possível de que elas são ligadas entre si.
      var sentido = (p.end === 1) ? -1 : 1;
      sprRot(sprPortal, cx, cy, 0.9 + 0.08 * puls, t * vel * sentido + ph);
    }
    ctx.globalAlpha = 1;
  }

  /** §3.4 — muros: bloco opaco + brilho aditivo pulsante por .phase. */
  function drawWalls(t) {
    var A = arena();
    if (!A || !A.wallList || A.wallList.length === 0) return;
    var list = A.wallList;
    var i, w, cx, cy;

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    for (i = 0; i < list.length; i++) {
      w = list[i];
      ctx.drawImage(sprWall, w.x * CELL - HALF, w.y * CELL - HALF);
    }

    // 2ª passada aditiva: só o brilho respira, o bloco não é redesenhado.
    ctx.globalCompositeOperation = 'lighter';
    for (i = 0; i < list.length; i++) {
      w = list[i];
      cx = w.x * CELL + HALF;
      cy = w.y * CELL + HALF;
      ctx.globalAlpha = 0.12 + 0.10 * (0.5 + 0.5 * Math.sin(t * 1.6 + (w.phase || 0)));
      ctx.drawImage(sprWall, cx - SPR_HALF, cy - SPR_HALF);
    }
    ctx.globalAlpha = 1;
  }

  /** §3.2 — comida: pulso senoidal, piscada da dourada, rotação do cristal. */
  function drawFood(game, t, tp) {
    var f = game.food;
    if (!f) return;
    var U = util();
    var img = sprFood[f.type] || sprFood.normal;

    // A comida também interpola: o ÍMÃ (§3.3) a faz andar de célula em célula,
    // e sem px->x ela pularia em degraus de 32px. Mas px/py só valem no tick do
    // passo (ver foodMoveTick lá em cima): fora dele a comida está PARADA na
    // célula atual, e insistir no lerp a faria teletransportar para trás.
    var tickNow = (typeof game.tick === 'number') ? (game.tick | 0) : -1;
    if (f !== foodRef || f.x !== foodCX || f.y !== foodCY) {
      foodRef = f; foodCX = f.x; foodCY = f.y;
      foodMoveTick = tickNow;
    }
    // tickNow < 0 = objeto de jogo sem contador de tick: nesse caso não dá para
    // saber quando o passo terminou, então desenha parado (degrau honesto é
    // melhor que andar de ré).
    var andando = (tickNow >= 0 && tickNow === foodMoveTick);
    var fx0 = (andando && f.px !== undefined) ? f.px : f.x;
    var fy0 = (andando && f.py !== undefined) ? f.py : f.y;
    var gx = (U ? U.lerp(fx0, f.x, tp) : f.x) * CELL + HALF;
    var gy = (U ? U.lerp(fy0, f.y, tp) : f.y) * CELL + HALF;

    var puls = 1 + 0.12 * Math.sin(t * 4.2 + (f.pulse || 0));
    var alpha = 1;

    // Piscada dos últimos 2000ms: a frequência SOBE conforme o tempo acaba —
    // é a diferença entre "está piscando" e "está acabando AGORA".
    if (f.remaining) {
      var rem = f.remaining();
      if (rem !== Infinity && f.blink && rem <= f.blink) {
        var u = 1 - clamp01(rem / f.blink);
        var freq = 9 + u * 20;
        alpha = 0.32 + 0.68 * (0.5 + 0.5 * Math.sin(t * freq));
        puls *= 1 + 0.10 * u;
      }
    }

    var cor = f.cor || pal('magenta', '#ff2d95');
    ctx.globalCompositeOperation = 'lighter';

    // halo atrás
    ctx.globalAlpha = alpha * (0.45 + 0.18 * Math.sin(t * 4.2 + (f.pulse || 0)));
    spr(glowOf(cor), gx, gy, 1.25 * puls);

    ctx.globalAlpha = alpha;
    if (f.type === 'crystal') {
      sprRot(img, gx, gy, puls, t * 1.7);
    } else {
      spr(img, gx, gy, puls);
    }
    ctx.globalAlpha = 1;
  }

  /* ---------------------------------------------------------------------------
   * A COBRA — o ponto alto do render.
   * ------------------------------------------------------------------------ */

  function drawSnake(game, t, tp, dt) {
    var s = game.snake;
    if (!s || !s.cells || s.cells.length === 0) return;

    var C = cfg();
    var F = fx();
    var cells = s.cells, prev = s.prev;
    var n = cells.length;
    ensurePosCap(n);

    var power = game.power || null;
    var ghost = !!(power && power.ghost > 0);
    var fury  = !!(power && power.fury > 0);
    var shield = !!(power && power.shield);
    var death = game.deathAnim || 0;

    var hueHead = (C && C.SNAKE) ? C.SNAKE.HUE_HEAD : 185;
    var hueStep = (C && C.SNAKE) ? C.SNAKE.HUE_STEP : 1.6;
    var hueMin  = (C && C.SNAKE && C.SNAKE.HUE_MIN !== undefined) ? C.SNAKE.HUE_MIN : -60;

    var baseAlpha = ghost ? 0.55 : 1;
    var i, p;

    /* --- 1) posições interpoladas -------------------------------------------
       noInterp é ligado pela Snake no tick em que houve wrap ou portal (§2):
       interpolar ali faria a cobra ATRAVESSAR a tela inteira em um frame. */
    var interp = !s.noInterp;
    for (i = 0; i < n; i++) {
      var c = cells[i];
      if (interp && prev && prev[i]) {
        p = prev[i];
        posX[i] = (p.x + (c.x - p.x) * tp) * CELL + HALF;
        posY[i] = (p.y + (c.y - p.y) * tp) * CELL + HALF;
      } else {
        posX[i] = c.x * CELL + HALF;
        posY[i] = c.y * CELL + HALF;
      }
    }

    var hx = posX[0], hy = posY[0];

    /* --- 2) rastro da cabeça (§4) -------------------------------------------
       O buffer circular vive na Snake, mas quem o alimenta é o renderer: só
       aqui existe a posição INTERPOLADA em pixels. */
    /* Passar `dt` faz a amostragem ser por TEMPO, não por frame: o rastro tem o
       mesmo comprimento em 60Hz e em 144Hz, e congela junto com o jogo durante
       pausa e hitstop (sem dt a Snake cai no relógio de parede, que continua
       correndo com o jogo parado e "come" o rastro). */
    if (s.pushTrail) s.pushTrail(hx, hy, dt);

    ctx.globalCompositeOperation = 'lighter';

    if (s.trailAt && s.trailCount > 1 && death <= 0) {
      var trailCor = fury ? pal('danger', '#ff2b2b') : pal('cyan', '#00f0ff');
      var trailGlow = glowOf(trailCor);
      for (i = 1; i < s.trailCount; i++) {
        var tp2 = s.trailAt(i);
        if (!tp2) continue;
        var k = 1 - i / s.trailCount;
        ctx.globalAlpha = baseAlpha * TRAIL_ALPHA * k * k;
        spr(trailGlow, tp2.x, tp2.y, 0.55 * (0.45 + 0.55 * k));
      }
    }

    /* --- 3) corpo: da CAUDA para a CABEÇA ---------------------------------- */
    for (i = n - 1; i >= 1; i--) {
      // Matiz por índice (§1). O piso vem do CFG (HUE_MIN): sem ele uma cobra
      // muito longa daria a volta no círculo de matiz e voltaria a ser ciano,
      // destruindo a leitura de "gradiente da cabeça até o rabo".
      var hue = hueHead - i * hueStep;
      if (hue < hueMin) hue = hueMin;
      // FÚRIA: em vez de somar laranja por cima (que só estoura o corpo em
      // branco), a matiz dos segmentos da frente é PUXADA para o laranja,
      // desbotando de volta ao normal ao longo de 12 segmentos.
      if (fury && i < 12) {
        var kf = 0.9 * (1 - i / 12);
        hue = hue + (18 - hue) * kf;
      }
      // Normalizado para 0..359 e mapeado no sprite mais próximo entre os
      // HUE_SPRITES (36: erro máximo de 5°, imperceptível a olho nu).
      hue = ((hue % 360) + 360) % 360;
      var idx = Math.round(hue / HUE_STEPDEG) % HUE_SPRITES;

      // Onda de engolida (§4): a soma de todas as ondas ativas, com teto.
      var esc = s.waveScale ? s.waveScale(i) : 1;
      if (esc > WAVE_CLAMP) esc = WAVE_CLAMP;

      var a = baseAlpha;

      // Morte: dissolve do rabo para a cabeça conforme deathAnim (0..1).
      if (death > 0) {
        var thr = (n - 1 - i) / n * 0.72;
        var d = clamp01((death - thr) / 0.28);
        a *= 1 - d;
        esc *= 1 - 0.6 * d;
        if (a <= 0.01) continue;
      }

      // Elo com o vizinho em direção à cabeça: sem ele a cobra vira um colar
      // de contas soltas nos frames intermediários da interpolação.
      var x0 = posX[i], y0 = posY[i], x1 = posX[i - 1], y1 = posY[i - 1];
      var dx = x1 - x0, dy = y1 - y0;
      if (dx < 0) dx = -dx;
      if (dy < 0) dy = -dy;
      // Salto grande = wrap/portal entre os dois segmentos: NÃO emendar,
      // senão nasce um risco de neon atravessando a arena.
      if (dx <= CELL * 1.6 && dy <= CELL * 1.6) {
        var lw = LINK_W * (0.85 + 0.15 * esc);
        var lh = lw * 0.5;
        ctx.globalAlpha = a * 0.9;
        ctx.fillStyle = bodyColors[idx];
        ctx.fillRect(Math.min(x0, x1) - lh, Math.min(y0, y1) - lh, dx + lw, dy + lw);
      }

      ctx.globalAlpha = a;
      spr(sprBody[idx], x0, y0, esc);
    }

    /* --- 4) cabeça ---------------------------------------------------------- */
    var headA = baseAlpha;
    if (death > 0) {
      var dh = clamp01((death - 0.72) / 0.28);
      headA *= 1 - dh;
    }

    if (headA > 0.01) {
      var dir = s.dir || { x: 1, y: 0 };
      // Cabeça cozida apontando para +x: o ângulo é literalmente a direção.
      var ang = Math.atan2(dir.y, dir.x);
      var headScale = s.waveScale ? Math.min(WAVE_CLAMP, s.waveScale(0)) : 1;

      ctx.globalAlpha = headA * 0.35;
      spr(glowOf(fury ? pal('danger', '#ff2b2b') : pal('cyan', '#00f0ff')), hx, hy, 1.2);

      ctx.globalAlpha = headA;
      sprRot(fury ? sprHeadFury : sprHead, hx, hy, headScale, ang);

      // ESCUDO (§3.3): anel ciano girando em volta da cabeça.
      if (shield) {
        ctx.globalAlpha = headA * (0.55 + 0.25 * Math.sin(t * 5));
        sprRot(sprShield, hx, hy, 1, t * 2.4);
      }

      // FANTASMA: contorno tracejado — comunica "atravesso as coisas" sem
      // depender de o jogador lembrar do ícone no HUD.
      if (ghost) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 0.8;
        ctx.strokeStyle = pal('cyan', '#00f0ff');
        ctx.lineWidth = 1.5;
        ctx.setLineDash(GHOST_DASH);
        ctx.lineDashOffset = -t * 22;
        ctx.translate(hx, hy);
        ctx.rotate(ang);
        ctx.strokeRect(-15, -15, 30, 30);
        ctx.rotate(-ang);
        ctx.translate(-hx, -hy);
        ctx.setLineDash(EMPTY_DASH);
        ctx.lineDashOffset = 0;
        ctx.globalCompositeOperation = 'lighter';
      }

      // FÚRIA: faíscas saindo da cabeça. Emissão limitada por acumulador para
      // não depender do framerate (e não estourar o pool de partículas).
      if (fury && F && F.trail) {
        furyAcc += dt;
        while (furyAcc >= 42) {
          furyAcc -= 42;
          F.trail(hx + (Math.random() * 18 - 9), hy + (Math.random() * 18 - 9),
                  Math.random() < 0.5 ? pal('danger', '#ff2b2b') : pal('amber', '#ffb800'));
        }
      } else {
        furyAcc = 0;
      }
    }

    ctx.globalAlpha = 1;
  }

  /** §3.5 — caçadores: interpolados por lerpT, piscando durante a
      materialização, com anel se fechando e rastro vermelho curto. */
  function drawHunters(game, t, tp, dt) {
    var hs = game.hunters;
    if (!hs || hs.length === 0) return;
    ensureHuntTrails();

    var C = cfg();
    var blinkHz = (C && C.HUNTER) ? C.HUNTER.BLINK_HZ : 8;
    var cor = pal('danger', '#ff2b2b');
    var halo = glowOf(cor);

    ctx.globalCompositeOperation = 'lighter';

    for (var i = 0; i < hs.length; i++) {
      var h = hs[i];
      if (!h || h.alive === false) continue;

      var k = h.lerpT ? h.lerpT(tp) : tp;
      var cx = (h.px + (h.x - h.px) * k) * CELL + HALF;
      var cy = (h.py + (h.y - h.py) * k) * CELL + HALF;

      var prog = h.spawnProgress ? h.spawnProgress() : 1;
      var alpha = 1;

      if (h.spawning) {
        // Pisca em vermelho enquanto é intangível (§3.5): o jogador precisa
        // saber que ainda NÃO pode morrer ali, mas que vai poder já já.
        alpha = 0.25 + 0.45 * (0.5 + 0.5 * Math.sin(t * blinkHz * TAU)) * (0.4 + 0.6 * prog);
        // Anel de materialização se fechando: de 2.2x até 0.9x.
        ctx.globalAlpha = 0.55 * (1 - prog) + 0.15;
        sprRot(sprRingSpawn, cx, cy, 2.2 - 1.3 * prog, t * 3);
      }

      // Rastro: amostrado por tempo (não por frame) para ter o mesmo
      // comprimento a 30 ou a 144fps.
      var tr = huntTrails[i];
      if (tr) {
        // Invalidação do rastro. Identidade do objeto NÃO basta: o Game recicla
        // os caçadores de um pool (killHunter/recycleHunters/relocateBuried...)
        // e costuma devolver O MESMO objeto ao MESMO índice, noutro canto da
        // arena. Sem os outros dois testes, o rastro da vida passada continua
        // no buffer e vira um risco vermelho atravessando a tela.
        //   (a) o slot trocou de caçador;
        //   (b) está materializando — ele não anda enquanto spawning, então
        //       zerar todo frame é de graça e garante rastro limpo no 1º passo;
        //   (c) descontinuidade espacial: a posição saltou mais de 2 células
        //       desde o frame anterior, o que só acontece em teleporte.
        if (tr.ref !== h || h.spawning ||
            (tr.n > 0 && (Math.abs(cx - tr.lx) > CELL * 2 ||
                          Math.abs(cy - tr.ly) > CELL * 2))) {
          tr.ref = h; tr.n = 0; tr.i = 0; tr.acc = 0;
        }
        // Última posição VISTA (por frame, não por amostra): é contra ela que a
        // descontinuidade é medida no frame seguinte.
        tr.lx = cx; tr.ly = cy;
        tr.acc += dt;
        if (tr.acc >= HUNT_TRAIL_MS) {
          // Subtrai o intervalo em vez de zerar: zerando, o resto do frame era
          // descartado e o espaçamento real das amostras virava múltiplo do dt
          // (~35ms a 144fps, ~67ms a 30fps) — o mesmo drone arrastaria um
          // rastro com o dobro do comprimento na máquina mais lenta.
          tr.acc -= HUNT_TRAIL_MS;
          // Teto do resto: um frame longo (aba em 2º plano) não pode acumular
          // dívida e fazer o rastro amostrar todo frame por vários frames.
          if (tr.acc > HUNT_TRAIL_MS) tr.acc = HUNT_TRAIL_MS;
          tr.x[tr.i] = cx; tr.y[tr.i] = cy;
          tr.i = (tr.i + 1) % HUNT_TRAIL;
          if (tr.n < HUNT_TRAIL) tr.n++;
        }
        for (var j = 1; j < tr.n; j++) {
          var idx = (tr.i - 1 - j + HUNT_TRAIL * 2) % HUNT_TRAIL;
          var u = 1 - j / tr.n;
          ctx.globalAlpha = alpha * 0.30 * u * u;
          spr(halo, tr.x[idx], tr.y[idx], 0.5 * u + 0.15);
        }
      }

      ctx.globalAlpha = alpha * 0.32;
      spr(halo, cx, cy, 1.15);

      ctx.globalAlpha = alpha;
      // Gira devagar e "encara" o alvo pela ponta: um losango parado parece
      // decoração, um losango girando parece um drone caçando.
      sprRot(sprHunter, cx, cy, 0.95 + 0.05 * Math.sin(t * 6 + (h.phase || 0)),
             t * 1.1 + (h.phase || 0));
    }
    ctx.globalAlpha = 1;
  }

  /* ===========================================================================
   * API PÚBLICA (§9.10)
   * ======================================================================== */

  var Renderer = {};

  /** Cozinha todos os sprites e liga o listener de resize. Idempotente. */
  Renderer.init = function (canvasEl) {
    var C = cfg();
    canvas = canvasEl || document.getElementById('game');
    if (!canvas) return;

    ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) ctx = canvas.getContext('2d');

    W = (C && C.W) || 960;
    H = (C && C.H) || 640;
    CELL = (C && C.CELL) || 32;
    HALF = CELL * 0.5;

    var SN = C && C.SNAKE;
    if (SN && SN.HUE_SPRITES >= 1) {
      HUE_SPRITES = SN.HUE_SPRITES | 0;
      HUE_STEPDEG = 360 / HUE_SPRITES;
    }
    if (SN && typeof SN.TRAIL_ALPHA === 'number' && SN.TRAIL_ALPHA >= 0) TRAIL_ALPHA = SN.TRAIL_ALPHA;

    bakeSprites();
    ensureHuntTrails();
    Renderer.canvas = canvas;
    Renderer.ctx = ctx;

    Renderer.resize();

    if (!listening) {
      listening = true;
      // Throttle: um arrasto de janela dispara dezenas de eventos por segundo, e
      // cada resize recoze um canvas de tela cheia. 120ms de folga resolve.
      window.addEventListener('resize', onResize, false);
      window.addEventListener('orientationchange', onResize, false);
    }

    ready = true;
  };

  function onResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resizeTimer = 0;
      Renderer.resize();
    }, 120);
  }

  /**
   * Dimensiona o buffer do canvas por devicePixelRatio e aplica o transform.
   * O tamanho VISUAL é 100% responsabilidade do CSS (#game { width/height:100% }
   * dentro de um #app com aspect-ratio 3/2) — aqui só cuidamos da resolução
   * interna, para o neon não sair serrilhado em telas HiDPI.
   */
  Renderer.resize = function () {
    if (!canvas || !ctx) return;
    var C = cfg();
    if (C) { W = C.W; H = C.H; CELL = C.CELL; HALF = CELL * 0.5; }

    var d = window.devicePixelRatio || 1;
    if (d > DPR_CAP) d = DPR_CAP;                  // ver DPR_CAP: fill-rate
    if (d < 1) d = 1;

    var dw = Math.round(W * d);
    var dh = Math.round(H * d);

    // Só reatribui width/height se mudou: escrever nessas propriedades LIMPA o
    // canvas e reinicia o contexto, o que causaria um piscão a cada chamada.
    if (canvas.width !== dw || canvas.height !== dh || d !== dpr) {
      dpr = d;
      canvas.width = dw;
      canvas.height = dh;
      bakeOverlays(dw, dh);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;

    var B = bg();
    if (B) B.init(W, H);
  };

  /**
   * Desenha o frame inteiro.
   * @param {Object} game  COBRA.Game (ou compatível)
   * @param {number} dt    ms REAIS do frame (não escalados por timeScale)
   */
  Renderer.render = function (game, dt) {
    if (!ready || !ctx) return;
    if (!(dt > 0)) dt = 0;
    if (dt > 100) dt = 100;                        // aba em 2º plano: sem saltos

    time += dt;
    var t = time * 0.001;                          // segundos, para os senos

    var C = cfg();
    var F = fx();
    var B = bg();

    var sector = (game && game.sector) | 0;
    var estado = (game && game.state) || 'menu';
    var tp = game ? game.tickProgress : 0;
    if (!(tp >= 0)) tp = 0;
    if (tp > 1) tp = 1;

    /* --- 1) limpar + shake -------------------------------------------------- */
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    // Preenchimento (e não clearRect) porque o shake desloca o mundo e as
    // bordas da tela precisam de uma cor de fundo, não de transparência.
    ctx.fillStyle = pal('void', '#04010c');
    ctx.fillRect(0, 0, W, H);

    var sh = F ? F.shakeOffset() : null;
    ctx.save();
    if (sh && (sh.x || sh.y)) ctx.translate(sh.x, sh.y);

    /* --- 2) fundo animado ---------------------------------------------------
       Desenhado SEMPRE, inclusive no menu: as telas de DOM ficam por cima de um
       fundo vivo, e é isso que faz o menu parecer parte do jogo.               */
    if (B) {
      var inten = (C && C.intensityFor) ? C.intensityFor(sector) : 0;
      B.update(dt, inten);
      B.draw(ctx, W, H, sector);
    }

    if (game && estado !== 'menu') {
      /* --- 3..7) mundo ---------------------------------------------------- */
      drawPortals(t);
      drawWalls(t);
      drawFood(game, t, tp);
      drawSnake(game, t, tp, dt);
      drawHunters(game, t, tp, dt);
    }

    /* --- 8) partículas e anéis, em coordenadas de mundo -------------------- */
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (F) F.drawWorld(ctx);

    /* --- 9) fora do shake: flash, chroma e textos flutuantes --------------- */
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (F) F.drawOverlay(ctx, W, H);

    /* --- 10) CRT: scanlines + vinheta --------------------------------------
       Desenhados em pixels de DISPOSITIVO (transform identidade) para ficarem
       nítidos; o save/restore devolve o transform de dpr para o próximo frame. */
    if (cvCrt) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;                         // os alphas já estão no sprite
      ctx.drawImage(cvCrt, 0, 0);
      ctx.restore();
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  };

  /* --- helpers extras (não fazem parte do contrato, mas não custam nada) --- */

  /** devicePixelRatio efetivamente aplicado (já com o cap). */
  Renderer.dpr = function () { return dpr; };

  /** Zera relógio e rastros — útil ao reiniciar a partida.
      NOTA: hoje ninguém chama isto (main.js só usa init/resize/render). O
      rastro do caçador não depende mais disso: ele se invalida sozinho por
      spawning e por descontinuidade espacial (ver drawHunters). */
  Renderer.reset = function () {
    time = 0;
    furyAcc = 0;
    foodRef = null; foodCX = -1; foodCY = -1; foodMoveTick = -1;
    for (var i = 0; i < huntTrails.length; i++) {
      huntTrails[i].ref = null;
      huntTrails[i].n = 0;
      huntTrails[i].i = 0;
      huntTrails[i].acc = 0;
      huntTrails[i].lx = 0;
      huntTrails[i].ly = 0;
    }
  };

  Renderer.canvas = null;
  Renderer.ctx = null;

  COBRA.Renderer = Renderer;
})();
