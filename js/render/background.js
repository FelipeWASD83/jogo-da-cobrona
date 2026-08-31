/* =============================================================================
 * COBRONA :: PROTOCOLO NEON — js/render/background.js  ->  COBRA.BG
 * -----------------------------------------------------------------------------
 * Pano de fundo synthwave. Contrato §9.9:
 *
 *   BG.init(w, h)
 *   BG.update(dt, intensity)   // intensity 0..3
 *   BG.draw(ctx, w, h, sector)
 *
 * FILOSOFIA DE CUSTO
 * ------------------
 * Este módulo desenha a tela INTEIRA todo frame, então ele é o candidato número 1
 * a comer o orçamento de 16,6 ms. A regra aqui é brutal:
 *
 *   - Nada de `createLinearGradient` / `createRadialGradient` dentro de draw().
 *     Gradiente é caro de construir E caro de rasterizar. Tudo que é gradiente
 *     vira pixel UMA vez, num canvas offscreen, e depois é só `drawImage`.
 *   - Nada de `arc()` para estrelas: 230 arcos por frame é muito mais caro que
 *     230 `fillRect` de 1-2px. A olho nu, a 1px, é a mesma coisa.
 *   - Nada de alocação por frame: as estrelas vivem em Float32Array planos,
 *     as fases são escalares, e o alpha é ajustado via `globalAlpha` (número)
 *     em vez de montar strings `rgba(...)` (que geram lixo pro GC).
 *   - `shadowBlur` NUNCA no loop — só na hora de cozinhar os offscreens.
 *
 * CAMADAS (do fundo para a frente)
 *   1. Gradiente vertical void -> deep          (offscreen `cvBase`)
 *   2. Nebulosa: 4 manchas radiais com deriva   (offscreen `cvNeb`)
 *   3. Starfield parallax de 3 camadas          (procedural, 'lighter')
 *   4. Grid da arena + varredura luminosa       (offscreens `cvGrid` / `cvSweep`)
 *   5. Pulso do grid quando intensity é alto    (só modula alpha, não redesenha)
 * ========================================================================== */

(function () {
  'use strict';

  window.COBRA = window.COBRA || {};

  /* ---------------------------------------------------------------------------
   * Constantes locais do módulo.
   * Não são gameplay, então não moram no CFG — são puramente estéticas.
   * ------------------------------------------------------------------------ */

  var NEB_PAD    = 56;      // folga do canvas da nebulosa, para a deriva não mostrar borda
  var SWEEP_H    = 110;     // altura da faixa de varredura
  var SWEEP_MS   = 4000;    // período da varredura em repouso (~4 s, conforme spec)
  var STAR_LAYERS = [
    // n   speed(px/ms)  base  amp   size  cor
    { n: 120, speed: 0.0045, base: 0.16, amp: 0.10, size: 1, color: '#6f7ec0' }, // fundo, lenta e fria
    { n:  70, speed: 0.0115, base: 0.30, amp: 0.16, size: 1, color: '#b9c8ff' }, // meio
    { n:  40, speed: 0.0230, base: 0.48, amp: 0.26, size: 2, color: '#d8f4ff' }  // frente, rápida e brilhante
  ];

  /* Matiz do grid por setor (§ "rode a matiz progressivamente").
   * 264° casa quase exato com a paleta original (#2a1566 -> hsl(257,66%,24%)),
   * então o setor 0 continua sendo o violeta canônico do CFG.PAL. */
  var SECTOR_HUE = [264, 212, 148, 42, 16, 0];  // violeta, azul, verde, âmbar, laranja, vermelho

  /* ---------------------------------------------------------------------------
   * Estado do módulo. Tudo `null`/0 até init() — nada de tocar em COBRA.CFG
   * no escopo de topo (regra de ouro do §8: a ordem de carga não pode nos quebrar).
   * ------------------------------------------------------------------------ */

  var W = 0, H = 0, CELL = 32;
  var ready = false;

  var cvBase  = null;   // gradiente de fundo já rasterizado
  var cvNeb   = null;   // nebulosa (maior que a tela por causa da deriva)
  var cvLines = null;   // MÁSCARA branca das linhas comuns do grid
  var cvGlow  = null;   // MÁSCARA branca das linhas destacadas (a cada 5) + borda
  var cvGrid  = null;   // grid já tingido para o setor atual (o que realmente é desenhado)
  var cvSweep = null;   // faixa da varredura, também tingida por setor
  var cvTint  = null;   // scratch reutilizado na hora de tingir (evita alocar canvas)

  var tintedSector = -1;  // qual setor está cozido em cvGrid/cvSweep

  var layers = [];      // starfield: 3 objetos com Float32Arrays

  // fases/acumuladores (avançados por update, lidos por draw)
  var tSec      = 0;    // tempo em segundos, para o cintilar
  var nebPhase  = 0;    // deriva da nebulosa
  var sweepT    = 0;    // 0..1, posição da varredura
  var pulsePhase= 0;    // seno do pulso do grid
  var pulseAmt  = 0;    // 0..1, quanto o pulso está ligado (suavizado)

  /* ---------------------------------------------------------------------------
   * Helpers
   * ------------------------------------------------------------------------ */

  /** Acesso tardio ao CFG, com fallback para o módulo nunca explodir sozinho. */
  function cfg() {
    return (window.COBRA && COBRA.CFG) || null;
  }

  function pal() {
    var c = cfg();
    return (c && c.PAL) || {
      'void': '#04010c', deep: '#0b0424',
      gridLine: '#2a1566', gridGlow: '#4b1fa8', violet: '#a855ff', magenta: '#ff2d95'
    };
  }

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width  = Math.max(1, w | 0);
    c.height = Math.max(1, h | 0);
    return c;
  }

  function hsl(h, s, l) { return 'hsl(' + h + ',' + s + '%,' + l + '%)'; }

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /* ---------------------------------------------------------------------------
   * 1. GRADIENTE DE FUNDO
   * Uma vez. Um `createLinearGradient` na vida inteira do processo.
   * ------------------------------------------------------------------------ */
  function bakeBase() {
    var P = pal();
    cvBase = makeCanvas(W, H);
    var g = cvBase.getContext('2d');

    var grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0.00, P['void']);
    grad.addColorStop(0.55, P.deep);
    grad.addColorStop(1.00, P['void']);   // volta a escurecer embaixo: dá "profundidade de caixa"
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
  }

  /* ---------------------------------------------------------------------------
   * 2. NEBULOSA
   * 4 manchas radiais gigantes com alpha baixíssimo (0.05..0.10). O canvas é
   * maior que a tela (NEB_PAD de cada lado) porque ela deriva em seno; assim
   * a deriva nunca revela a borda transparente do offscreen.
   * ------------------------------------------------------------------------ */
  function bakeNebula() {
    var nw = W + NEB_PAD * 2, nh = H + NEB_PAD * 2;
    cvNeb = makeCanvas(nw, nh);
    var g = cvNeb.getContext('2d');

    // Posições fixas (não aleatórias): uma composição escolhida a dedo sempre
    // fica melhor que 4 sorteios que podem empilhar tudo num canto.
    var blobs = [
      { x: 0.18, y: 0.22, r: 0.62, c: '168,60,255', a: 0.10 },  // violeta, alto-esquerda
      { x: 0.82, y: 0.30, r: 0.55, c: '255,45,149', a: 0.07 },  // magenta, alto-direita
      { x: 0.55, y: 0.86, r: 0.70, c: '120,40,220', a: 0.06 },  // violeta profundo, baixo
      { x: 0.05, y: 0.78, r: 0.44, c: '255,80,190', a: 0.05 }   // rosa fraco, baixo-esquerda
    ];

    var base = Math.max(nw, nh);
    for (var i = 0; i < blobs.length; i++) {
      var b = blobs[i];
      var cx = b.x * nw, cy = b.y * nh, r = b.r * base * 0.5;
      var rg = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      rg.addColorStop(0.0, 'rgba(' + b.c + ',' + b.a + ')');
      rg.addColorStop(0.45, 'rgba(' + b.c + ',' + (b.a * 0.45).toFixed(4) + ')');
      rg.addColorStop(1.0, 'rgba(' + b.c + ',0)');
      g.fillStyle = rg;
      g.fillRect(0, 0, nw, nh);
    }
  }

  /* ---------------------------------------------------------------------------
   * 3. STARFIELD
   * Geradas UMA vez em arrays planos. Só o `off` de cada camada se move.
   * Float32Array em vez de array de objetos: zero ponteiros, zero pressão de GC,
   * e o acesso sequencial é amigável ao cache.
   * ------------------------------------------------------------------------ */
  function buildStars() {
    layers.length = 0;
    for (var li = 0; li < STAR_LAYERS.length; li++) {
      var d = STAR_LAYERS[li];
      var L = {
        n: d.n,
        sx: new Float32Array(d.n),
        sy: new Float32Array(d.n),
        ph: new Float32Array(d.n),   // fase inicial do cintilar
        tw: new Float32Array(d.n),   // velocidade do cintilar (rad/s)
        size: d.size,
        speed: d.speed,
        base: d.base,
        amp: d.amp,
        color: d.color,
        off: 0
      };
      for (var i = 0; i < d.n; i++) {
        L.sx[i] = Math.random() * W;
        L.sy[i] = (Math.random() * H) | 0;
        L.ph[i] = Math.random() * 6.2832;
        L.tw[i] = 0.6 + Math.random() * 1.8;
      }
      layers.push(L);
    }
  }

  /* ---------------------------------------------------------------------------
   * 4. GRID
   *
   * PERSPECTIVA: as linhas ficam EXATAMENTE nas células de 32px — mexer na
   * geometria arruinaria a leitura do tabuleiro. A "perspectiva sutil" é
   * puramente fotométrica: as horizontais escurecem em direção ao topo (horizonte)
   * e as verticais somem nas bordas laterais. O olho lê isso como profundidade
   * sem que uma única linha saia do lugar.
   *
   * TINGIMENTO POR SETOR — decisão de projeto:
   * Existem 3 caminhos possíveis. Escolhi o (C).
   *   (A) Retângulo de tint em 'color-dodge'/'lighter' por cima: barato, mas
   *       contamina estrelas e nebulosa, e 'color-dodge' em tela cheia é um dos
   *       composites mais lentos do Canvas2D. Descartado.
   *   (B) N versões pré-renderizadas do grid (uma por setor): zero custo em
   *       runtime, mas 6 canvases de 960x640 = ~15 MB de VRAM parada. Exagero
   *       para um alvo "notebook modesto". Descartado.
   *   (C) Duas MÁSCARAS brancas (linhas comuns / destacadas) cozidas uma vez, e
   *       UM canvas de grid tingido reconstruído só quando o setor muda.
   *       Trocar de setor acontece a cada 500 pontos — reconstruir custa
   *       4 drawImage + 4 fillRect, ~1 ms, uma vez a cada vários minutos.
   *       Custo por frame: um único drawImage. É o melhor dos dois mundos.
   *
   * As máscaras são feitas em branco puro justamente para que o tingimento seja
   * um 'source-in' com a cor do setor — o alpha da máscara sobrevive intacto.
   * ------------------------------------------------------------------------ */
  function bakeGridMasks() {
    cvLines = makeCanvas(W, H);
    cvGlow  = makeCanvas(W, H);
    var gl = cvLines.getContext('2d');
    var gg = cvGlow.getContext('2d');

    var cols = Math.round(W / CELL);
    var rows = Math.round(H / CELL);
    var x, y, c, r;

    // --- linhas comuns -----------------------------------------------------
    gl.fillStyle = '#ffffff';

    // verticais (1px, alpha maior no centro da tela)
    for (c = 0; c <= cols; c++) {
      x = c * CELL;
      var dc = Math.abs(c - cols / 2) / (cols / 2);       // 0 no centro, 1 na borda
      gl.globalAlpha = 0.85 - 0.40 * dc * dc;
      gl.fillRect(x - 0.5 | 0, 0, 1, H);
    }
    // horizontais (mais fortes embaixo: o "chão" vem em direção à câmera)
    for (r = 0; r <= rows; r++) {
      y = r * CELL;
      var fr = r / rows;
      gl.globalAlpha = 0.38 + 0.62 * fr * fr;
      gl.fillRect(0, y - 0.5 | 0, W, 1);
    }
    gl.globalAlpha = 1;

    // Fade de horizonte: multiplica o alpha existente por um gradiente vertical.
    // 'destination-in' = mantém o destino apenas onde a fonte tem alpha, ou seja,
    // multiplica os alphas. Dois passes = duas multiplicações, e o grid ganha
    // um vinhetamento coerente sem nenhuma linha ter mudado de posição.
    applyFade(gl, 0.50, 1.0, 0.60);

    // --- linhas destacadas (a cada 5) + moldura da arena -------------------
    gg.fillStyle = '#ffffff';
    for (c = 0; c <= cols; c++) {
      if (c % 5) continue;
      x = c * CELL;
      gg.globalAlpha = 0.90;
      gg.fillRect(x - 1 | 0, 0, 2, H);
    }
    for (r = 0; r <= rows; r++) {
      if (r % 5) continue;
      y = r * CELL;
      gg.globalAlpha = 0.90;
      gg.fillRect(0, y - 1 | 0, W, 2);
    }
    // Moldura: as bordas MATAM (§2), então elas merecem destaque visual.
    gg.globalAlpha = 1;
    gg.fillRect(0, 0, W, 2);
    gg.fillRect(0, H - 2, W, 2);
    gg.fillRect(0, 0, 2, H);
    gg.fillRect(W - 2, 0, 2, H);

    applyFade(gg, 0.55, 1.0, 0.70);
  }

  /** Multiplica o alpha do canvas por (gradiente vertical) e (gradiente horizontal). */
  function applyFade(g, topA, botA, edgeA) {
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'destination-in';

    var gv = g.createLinearGradient(0, 0, 0, H);
    gv.addColorStop(0, 'rgba(255,255,255,' + topA + ')');
    gv.addColorStop(1, 'rgba(255,255,255,' + botA + ')');
    g.fillStyle = gv;
    g.fillRect(0, 0, W, H);

    var gh = g.createLinearGradient(0, 0, W, 0);
    gh.addColorStop(0.00, 'rgba(255,255,255,' + edgeA + ')');
    gh.addColorStop(0.50, 'rgba(255,255,255,1)');
    gh.addColorStop(1.00, 'rgba(255,255,255,' + edgeA + ')');
    g.fillStyle = gh;
    g.fillRect(0, 0, W, H);

    g.globalCompositeOperation = 'source-over';
  }

  /** Pinta uma máscara branca com `color` dentro do scratch e devolve o scratch. */
  function tintMask(mask, color) {
    var g = cvTint.getContext('2d');
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.clearRect(0, 0, W, H);
    g.drawImage(mask, 0, 0);
    g.globalCompositeOperation = 'source-in';   // preserva o alpha, troca a cor
    g.fillStyle = color;
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over';
    return cvTint;
  }

  /** Reconstrói cvGrid e cvSweep na matiz do setor. Chamado só quando o setor muda. */
  function bakeSector(sector) {
    var idx = sector < 0 ? 0 : (sector >= SECTOR_HUE.length ? SECTOR_HUE.length - 1 : sector);
    var hue = SECTOR_HUE[idx];

    // Cores derivadas: casam com CFG.PAL.gridLine / gridGlow quando hue = 264.
    var colLine = hsl(hue, 66, 24);
    var colGlow = hsl(hue, 69, 40);

    var g = cvGrid.getContext('2d');
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.clearRect(0, 0, W, H);
    g.drawImage(tintMask(cvLines, colLine), 0, 0);
    g.drawImage(tintMask(cvGlow, colGlow), 0, 0);

    bakeSweep(hue);
    tintedSector = sector;
  }

  /* Varredura: faixa horizontal luminosa, gradiente vertical transparente ->
   * núcleo -> transparente, com um "fio" quente bem no meio. Desenhada com
   * 'lighter', então o gradiente já embute o alpha final. */
  function bakeSweep(hue) {
    var g = cvSweep.getContext('2d');
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.clearRect(0, 0, W, SWEEP_H);

    var grad = g.createLinearGradient(0, 0, 0, SWEEP_H);
    grad.addColorStop(0.00, 'hsla(' + hue + ',100%,70%,0)');
    grad.addColorStop(0.42, 'hsla(' + hue + ',100%,70%,0.035)');
    grad.addColorStop(0.50, 'hsla(' + hue + ',100%,82%,0.11)');
    grad.addColorStop(0.58, 'hsla(' + hue + ',100%,70%,0.035)');
    grad.addColorStop(1.00, 'hsla(' + hue + ',100%,70%,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, SWEEP_H);

    // fio central de 1px, quase branco: é ele que "lê" como scanline de CRT
    g.fillStyle = 'hsla(' + hue + ',100%,92%,0.16)';
    g.fillRect(0, (SWEEP_H / 2) | 0, W, 1);
  }

  /* ---------------------------------------------------------------------------
   * Construção / redimensionamento
   * ------------------------------------------------------------------------ */
  function build(w, h) {
    var c = cfg();
    W = Math.max(1, (w || (c && c.W) || 960) | 0);
    H = Math.max(1, (h || (c && c.H) || 640) | 0);
    CELL = (c && c.CELL) || 32;

    cvGrid = makeCanvas(W, H);
    cvTint = makeCanvas(W, H);
    cvSweep = makeCanvas(W, SWEEP_H);

    bakeBase();
    bakeNebula();
    bakeGridMasks();
    buildStars();

    tintedSector = -1;   // força o primeiro bakeSector no próximo draw
    ready = true;
  }

  /* ---------------------------------------------------------------------------
   * API PÚBLICA (§9.9)
   * ------------------------------------------------------------------------ */
  var BG = {

    /** Cozinha todos os offscreens. Idempotente para o mesmo par (w,h). */
    init: function (w, h) {
      var c = cfg();
      var nw = (w || (c && c.W) || 960) | 0;
      var nh = (h || (c && c.H) || 640) | 0;
      if (ready && nw === W && nh === H) return;
      build(nw, nh);
    },

    /** Helper extra (não faz parte do contrato): rebuild explícito. */
    resize: function (w, h) { build(w, h); },

    /**
     * Avança offsets e fases. ZERO alocação aqui — só aritmética escalar.
     * @param {number} dt         ms desde o último frame
     * @param {number} intensity  0..3 (derivado do setor)
     */
    update: function (dt, intensity) {
      if (!ready) return;
      if (!(dt > 0)) dt = 0;
      if (dt > 100) dt = 100;                     // aba em 2º plano não deve teleportar nada

      var inten = intensity > 0 ? (intensity > 3 ? 3 : intensity) : 0;

      tSec += dt * 0.001;

      // Parallax: cada camada anda na sua velocidade, e o caos acelera tudo um pouco.
      var boost = 1 + 0.18 * inten;
      for (var i = 0; i < layers.length; i++) {
        var L = layers[i];
        L.off += L.speed * dt * boost;
        if (L.off >= W) L.off -= W * Math.floor(L.off / W);   // wrap sem while
      }

      // Deriva da nebulosa: lentíssima de propósito, é atmosfera, não movimento.
      nebPhase += dt * 0.00016;
      if (nebPhase > 6283.18) nebPhase -= 6283.18;

      // Varredura: ~4 s em repouso, acelera até ~1,8× no caos.
      sweepT += dt / (SWEEP_MS / (1 + 0.4 * inten));
      if (sweepT >= 1) sweepT -= Math.floor(sweepT);

      // Pulso do grid: só liga de verdade a partir de intensity ~2,
      // e o alvo é suavizado para a transição de setor não dar um soco visual.
      var target = clamp01((inten - 2) / 1);
      pulseAmt += (target - pulseAmt) * Math.min(1, dt * 0.004);
      pulsePhase += dt * 0.0062 * (1 + 0.5 * pulseAmt);
      if (pulsePhase > 6283.18) pulsePhase -= 6283.18;
    },

    /**
     * Desenha as 5 camadas. Espera coordenadas LÓGICAS (o Renderer já aplicou
     * o transform de devicePixelRatio).
     */
    draw: function (ctx, w, h, sector) {
      if (!ready || (w | 0) !== W || (h | 0) !== H) BG.init(w, h);
      if (!ready) return;

      var sec = sector | 0;
      if (sec < 0) sec = 0;
      if (sec !== tintedSector) bakeSector(sec);

      ctx.save();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      // --- 1. gradiente de fundo -----------------------------------------
      ctx.drawImage(cvBase, 0, 0);

      // --- 2. nebulosa, com deriva senoidal -------------------------------
      // 'lighter' porque nuvem de gás sobre vazio é luz somada, não tinta.
      ctx.globalCompositeOperation = 'lighter';
      var ndx = Math.sin(nebPhase) * 24;
      var ndy = Math.cos(nebPhase * 0.63) * 15;
      ctx.drawImage(cvNeb, -NEB_PAD + ndx, -NEB_PAD + ndy);

      // --- 3. starfield ---------------------------------------------------
      // Ainda em 'lighter'. globalAlpha por estrela é uma atribuição de número:
      // nada de montar 'rgba(...)' 230 vezes por frame.
      for (var li = 0; li < layers.length; li++) {
        var L = layers[li];
        ctx.fillStyle = L.color;
        var off = L.off, n = L.n, sz = L.size, base = L.base, amp = L.amp;
        for (var i = 0; i < n; i++) {
          var a = base + amp * Math.sin(tSec * L.tw[i] + L.ph[i]);
          if (a <= 0.015) continue;                 // estrela apagada: pula o draw call
          var x = L.sx[i] - off;
          if (x < 0) x += W;
          ctx.globalAlpha = a;
          ctx.fillRect(x | 0, L.sy[i], sz, sz);
        }
      }
      ctx.globalAlpha = 1;

      // --- 4. grid --------------------------------------------------------
      // O pulso NÃO redesenha o grid: ele só modula o alpha deste drawImage.
      ctx.globalCompositeOperation = 'source-over';
      var puls = 0.5 - 0.5 * Math.cos(pulsePhase);          // 0..1
      ctx.globalAlpha = 1 - pulseAmt * 0.34 * (1 - puls);
      ctx.drawImage(cvGrid, 0, 0);

      // Sobrecarga: um segundo passe aditivo no pico do seno faz o grid "respirar"
      // em neon sem custar mais que um drawImage extra (e só quando pulseAmt > 0).
      if (pulseAmt > 0.02) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = pulseAmt * 0.30 * puls;
        ctx.drawImage(cvGrid, 0, 0);
      }

      // --- 4b. varredura --------------------------------------------------
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 1;
      ctx.drawImage(cvSweep, 0, (sweepT * (H + SWEEP_H) - SWEEP_H) | 0);

      ctx.restore();
    }
  };

  COBRA.BG = BG;

})();
