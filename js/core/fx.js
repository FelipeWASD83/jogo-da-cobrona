/* ==========================================================================
 * COBRONA :: PROTOCOLO NEON — js/core/fx.js  ->  COBRA.FX
 *
 * Camada de "juice": partículas, anéis de choque, textos flutuantes, flash de
 * tela, aberração cromática, screen shake por trauma e hitstop.
 *
 * FILOSOFIA DE PERFORMANCE (alvo: 60fps num notebook modesto):
 *  - TUDO é pool pré-alocado. Nenhum objeto é criado dentro do loop de update
 *    ou de draw. Nem literais {x,y}, nem strings de cor, nem gradientes.
 *  - Os arrays são "densos": as entidades vivas ocupam sempre [0, nVivos).
 *    Matar uma entidade = trocar com a última viva e decrementar o contador.
 *    Assim o update itera só sobre o que está vivo, não sobre o pool inteiro.
 *  - Brilho aditivo via globalCompositeOperation='lighter'. NUNCA shadowBlur
 *    dentro do loop (custa um blur por primitiva; mata o frame rate).
 * ========================================================================== */
(function () {
  'use strict';
  window.COBRA = window.COBRA || {};

  /* ---------------------------------------------------------------------- *
   * Acesso preguiçoso ao CFG.
   * A regra de ouro do projeto proíbe ler COBRA.CFG no escopo de topo — a
   * ordem de carga não pode nos quebrar. Então resolvemos na primeira chamada
   * e cacheamos. O FALLBACK existe só para o caso patológico de alguém chamar
   * FX antes do config.js; nunca é cacheado no lugar do CFG real.
   * ---------------------------------------------------------------------- */
  var CFG = null;
  var FALLBACK = {
    MAX_PARTICLES: 900,
    DEBUG: false,
    PAL: {
      void: '#04010c', deep: '#0b0424', gridLine: '#2a1566', gridGlow: '#4b1fa8',
      cyan: '#00f0ff', magenta: '#ff2d95', lime: '#7dff4d', amber: '#ffb800',
      violet: '#a855ff', danger: '#ff2b2b', white: '#eaf6ff', dim: '#7a6fa8'
    }
  };
  function cfg() {
    if (!CFG && window.COBRA.CFG) CFG = window.COBRA.CFG;
    return CFG || FALLBACK;
  }
  function pal(nome) {
    var p = cfg().PAL || FALLBACK.PAL;
    return p[nome] || FALLBACK.PAL[nome] || '#ffffff';
  }

  /* ---------------------------------------------------------------------- *
   * Matemática local.
   * Duplicamos clamp/ease/rand em vez de chamar COBRA.Util dentro dos loops
   * quentes: uma chamada aqui vira uma função monomórfica local que o JIT
   * inlina, sem duas indireções de propriedade por partícula por frame.
   * ---------------------------------------------------------------------- */
  var PI2 = Math.PI * 2;
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function easeOutCubic(t) { var u = 1 - t; return 1 - u * u * u; }
  function rnd(a, b) { return a + Math.random() * (b - a); }

  /* Lê um campo de opts com valor padrão (opts pode ser undefined). */
  function opt(o, k, d) { return (o && o[k] !== undefined && o[k] !== null) ? o[k] : d; }

  /* ---------------------------------------------------------------------- *
   * ESTADO
   * ---------------------------------------------------------------------- */
  var parts = [];      // pool de partículas (tamanho = CFG.MAX_PARTICLES)
  var nParts = 0;      // vivas em parts[0 .. nParts-1]
  var rings = [];      // pool de anéis
  var nRings = 0;
  var texts = [];      // pool de textos flutuantes
  var nTexts = 0;
  var delays = [];     // pool de bursts agendados (usado pela morte segmentada)
  var nDelays = 0;

  var RING_POOL = 48;
  var TEXT_POOL = 32;
  var DELAY_POOL = 96;

  var seq = 0;         // carimbo de nascimento: serve pra achar a MAIS VELHA

  var trauma = 0;      // 0..1 — screen shake
  var shakeX = 0, shakeY = 0;
  var shakeObj = { x: 0, y: 0 };   // objeto reusado: shakeOffset() não aloca

  var hitstopMs = 0;
  var chromaMs = 0, chromaDur = 1;

  var flashA = 0;      // alpha inicial do flash
  var flashT = 0;      // tempo decorrido
  var flashDur = 180;  // ~180ms, decaindo com easeOutCubic
  var flashColor = '#ffffff';

  var inited = false;

  /* Gradientes de vinheta cacheados por dimensão — criar gradiente por frame
     aloca e recompila a rampa de cor; aqui só recriamos se o canvas mudar. */
  var gW = -1, gH = -1, gradRed = null, gradCyan = null, gradFlash = null;

  /* ---------------------------------------------------------------------- *
   * CONSTRUÇÃO DOS POOLS
   * ---------------------------------------------------------------------- */
  function novaParticula() {
    return {
      x: 0, y: 0, vx: 0, vy: 0,
      life: 0, maxLife: 1,
      size: 3, color: '#fff',
      gravity: 0, drag: 0,
      additive: true, alive: false,
      spin: 0, rot: 0,
      seq: 0
    };
  }
  function novoAnel() {
    return { x: 0, y: 0, r0: 0, r1: 0, life: 0, maxLife: 1, color: '#fff', width: 3, alive: false };
  }
  function novoTexto() {
    return {
      x: 0, y: 0, texto: '', cor: '#fff', tamanho: 18, vy: -46,
      life: 0, maxLife: 1, font: '', alive: false,
      // halfW: metade da largura medida do texto, em px. -1 = ainda não medida.
      // Medir exige um ctx (só existe no draw), então isso é preenchido no
      // primeiro frame em que o texto é desenhado e reusado depois — assim o
      // clamp de borda não paga um measureText por texto por frame.
      halfW: -1
    };
  }
  function novoDelay() {
    return {
      t: 0, x: 0, y: 0, alive: false,
      count: 8, color: '#fff', speed: 120, size: 3, life: 500,
      spread: PI2, angle: 0, gravity: 0, drag: 0, additive: true, spin: 0
    };
  }

  function ensurePools() {
    if (inited) return;
    inited = true;
    var max = cfg().MAX_PARTICLES || FALLBACK.MAX_PARTICLES;
    parts.length = 0;
    for (var i = 0; i < max; i++) parts.push(novaParticula());
    rings.length = 0;
    for (var j = 0; j < RING_POOL; j++) rings.push(novoAnel());
    texts.length = 0;
    for (var k = 0; k < TEXT_POOL; k++) texts.push(novoTexto());
    delays.length = 0;
    for (var d = 0; d < DELAY_POOL; d++) delays.push(novoDelay());
  }

  /* ---------------------------------------------------------------------- *
   * ALOCADORES
   * Regra do doc (§4): "Ao estourar, as mais velhas são recicladas."
   * Enquanto há espaço, pegamos parts[nParts++] — O(1).
   * Quando o pool satura, varremos as vivas UMA vez procurando o menor .seq
   * (a mais velha) e a sobrescrevemos no lugar. Essa varredura só acontece
   * quando já estamos em 900 partículas, ou seja, no caos total.
   * ---------------------------------------------------------------------- */
  function allocPart() {
    var p;
    if (nParts < parts.length) {
      p = parts[nParts++];
    } else {
      var idx = 0, menor = Infinity;
      for (var i = 0; i < nParts; i++) {
        if (parts[i].seq < menor) { menor = parts[i].seq; idx = i; }
      }
      p = parts[idx];
    }
    p.alive = true;
    p.seq = ++seq;
    return p;
  }
  function killPart(i) {
    var p = parts[i];
    p.alive = false;
    nParts--;
    if (i !== nParts) { parts[i] = parts[nParts]; parts[nParts] = p; }
  }

  function allocRing() {
    var r;
    if (nRings < rings.length) r = rings[nRings++];
    else r = rings[0];              // pool minúsculo: reciclar o índice 0 basta
    r.alive = true;
    return r;
  }
  function killRing(i) {
    var r = rings[i]; r.alive = false; nRings--;
    if (i !== nRings) { rings[i] = rings[nRings]; rings[nRings] = r; }
  }

  function allocText() {
    var t;
    if (nTexts < texts.length) t = texts[nTexts++];
    else t = texts[0];
    t.alive = true;
    return t;
  }
  function killText(i) {
    var t = texts[i]; t.alive = false; nTexts--;
    if (i !== nTexts) { texts[i] = texts[nTexts]; texts[nTexts] = t; }
  }

  function allocDelay() {
    var d;
    if (nDelays < delays.length) d = delays[nDelays++];
    else d = delays[0];
    d.alive = true;
    return d;
  }
  function killDelay(i) {
    var d = delays[i]; d.alive = false; nDelays--;
    if (i !== nDelays) { delays[i] = delays[nDelays]; delays[nDelays] = d; }
  }

  /* ---------------------------------------------------------------------- *
   * EMISSÃO DE PARTÍCULAS (núcleo compartilhado por burst e burstDelay)
   * Todos os parâmetros são escalares — assim o burst agendado não precisa
   * guardar (nem clonar) um objeto de opções.
   * ---------------------------------------------------------------------- */
  function emit(x, y, count, color, speed, size, life, spread, angle, gravity, drag, additive, spin) {
    ensurePools();
    for (var i = 0; i < count; i++) {
      var p = allocPart();
      // Ângulo dentro do cone [angle - spread/2, angle + spread/2].
      var a = angle + (Math.random() - 0.5) * spread;
      // Velocidade com variação de ±35% pra a explosão não virar um anel perfeito.
      var v = speed * rnd(0.65, 1.35);
      p.x = x; p.y = y;
      p.vx = Math.cos(a) * v;
      p.vy = Math.sin(a) * v;
      p.maxLife = life * rnd(0.75, 1.25);
      p.life = p.maxLife;
      p.size = size * rnd(0.7, 1.3);
      p.color = color;
      p.gravity = gravity;
      p.drag = drag;
      p.additive = additive;
      p.spin = spin ? rnd(-spin, spin) : 0;
      p.rot = spin ? rnd(0, PI2) : 0;
    }
  }

  /* ---------------------------------------------------------------------- *
   * API PÚBLICA
   * ---------------------------------------------------------------------- */
  var FX = {};

  FX.init = function () {
    ensurePools();
    FX.reset();
  };

  FX.reset = function () {
    ensurePools();
    for (var i = 0; i < nParts; i++) parts[i].alive = false;
    for (var j = 0; j < nRings; j++) rings[j].alive = false;
    for (var k = 0; k < nTexts; k++) texts[k].alive = false;
    for (var d = 0; d < nDelays; d++) delays[d].alive = false;
    nParts = nRings = nTexts = nDelays = 0;
    trauma = 0; shakeX = 0; shakeY = 0;
    shakeObj.x = 0; shakeObj.y = 0;
    hitstopMs = 0;
    chromaMs = 0; chromaDur = 1;
    flashA = 0; flashT = 0;
    seq = 0;
  };

  /**
   * opts: {count,color,speed,size,life,spread,angle,gravity,additive,drag,spin}
   * Coordenadas em pixels de MUNDO (célula * 32 + 16).
   */
  FX.burst = function (x, y, opts) {
    emit(
      x, y,
      opt(opts, 'count', 12) | 0,
      opt(opts, 'color', pal('white')),
      opt(opts, 'speed', 150),
      opt(opts, 'size', 4),
      opt(opts, 'life', 520),
      opt(opts, 'spread', PI2),
      opt(opts, 'angle', Math.random() * PI2),
      opt(opts, 'gravity', 0),
      opt(opts, 'drag', 1.6),
      opt(opts, 'additive', true),
      opt(opts, 'spin', 0)
    );
  };

  /**
   * Burst agendado. Existe pra morte do §4 ("corpo explode segmento a
   * segmento, delay 18ms por segmento") — o Game agenda tudo de uma vez em
   * vez de manter o próprio timer. Todas as opções são resolvidas AGORA e
   * guardadas como escalares no registro do pool: zero alocação depois.
   */
  FX.burstDelay = function (x, y, opts, delayMs) {
    ensurePools();
    var d = allocDelay();
    d.t = delayMs || 0;
    d.x = x; d.y = y;
    d.count = opt(opts, 'count', 12) | 0;
    d.color = opt(opts, 'color', pal('white'));
    d.speed = opt(opts, 'speed', 150);
    d.size = opt(opts, 'size', 4);
    d.life = opt(opts, 'life', 520);
    d.spread = opt(opts, 'spread', PI2);
    d.angle = opt(opts, 'angle', Math.random() * PI2);
    d.gravity = opt(opts, 'gravity', 0);
    d.drag = opt(opts, 'drag', 1.6);
    d.additive = opt(opts, 'additive', true);
    d.spin = opt(opts, 'spin', 0);
  };

  /** opts: {color,r0,r1,life,width} — anel expandindo com easeOutCubic. */
  FX.ring = function (x, y, opts) {
    ensurePools();
    var r = allocRing();
    r.x = x; r.y = y;
    r.r0 = opt(opts, 'r0', 6);
    r.r1 = opt(opts, 'r1', 90);
    r.maxLife = opt(opts, 'life', 480);
    r.life = r.maxLife;
    r.color = opt(opts, 'color', pal('cyan'));
    r.width = opt(opts, 'width', 3);
  };

  /**
   * opts: {color,size,life,vy,bold}
   * Recebe pixels de MUNDO, mas é desenhado em drawOverlay (espaço de tela).
   * Como o canvas lógico é 1:1 com o mundo (960x640), a conversão é a
   * identidade — a diferença prática é que o texto NÃO acompanha o shake,
   * o que mantém a leitura do "+10 x2" nítida no meio do tremor.
   */
  FX.floatText = function (x, y, texto, opts) {
    ensurePools();
    var t = allocText();
    t.x = x; t.y = y;
    t.texto = String(texto);
    t.cor = opt(opts, 'color', pal('white'));
    t.tamanho = opt(opts, 'size', 18);
    t.vy = opt(opts, 'vy', -46);
    t.maxLife = opt(opts, 'life', 900);
    t.life = t.maxLife;
    // A string de fonte é montada UMA vez no spawn; no draw só atribuímos.
    t.font = (opt(opts, 'bold', true) ? 'bold ' : '') + t.tamanho +
      'px ui-monospace, "JetBrains Mono", "Fira Code", Consolas, monospace';
    // Slot reciclado do pool: a largura do texto ANTERIOR não vale mais.
    t.halfW = -1;
  };

  /** n em unidades de trauma (§4): trauma = min(1, trauma + n/25). */
  FX.shake = function (n) {
    trauma = clamp(trauma + (n || 0) / 25, 0, 1);
  };

  FX.flash = function (alpha, color) {
    var a = alpha || 0;
    // Flashes não se somam: o mais forte manda. Somar estoura em branco.
    if (a >= flashA * (1 - flashT / flashDur)) {
      flashA = clamp(a, 0, 1);
      flashT = 0;
      flashColor = color || pal('white');
    }
  };

  /** Aberração cromática por `ms` (pega o MAIOR entre o restante e o novo). */
  FX.chroma = function (ms) {
    // Não soma: se o novo efeito é mais longo que o restante, reinicia com a
    // duração cheia; se é menor, o que já está rodando manda.
    if (ms > chromaMs) { chromaMs = ms; chromaDur = ms; }
  };

  /** Hitstop acumula pelo MAIOR, nunca somando (senão o jogo trava de vez). */
  FX.hitstop = function (ms) {
    if (ms > hitstopMs) hitstopMs = ms;
  };

  FX.blocked = function () { return hitstopMs > 0; };

  /**
   * Offset do shake. O valor é sorteado UMA vez por update e cacheado num
   * objeto reusado: (a) zero alocação por frame, (b) mundo e overlay podem
   * consultar o mesmo offset sem "descolar" um do outro.
   */
  FX.shakeOffset = function () {
    shakeObj.x = shakeX;
    shakeObj.y = shakeY;
    return shakeObj;
  };

  FX.count = function () { return nParts; };

  /** Faísca única de rastro — barata, sem velocidade radial. Ver resumo. */
  FX.trail = function (x, y, color) {
    ensurePools();
    var p = allocPart();
    p.x = x; p.y = y;
    p.vx = rnd(-14, 14); p.vy = rnd(-14, 14);
    p.maxLife = 230; p.life = 230;
    p.size = rnd(2, 3.6);
    p.color = color || pal('cyan');
    p.gravity = 0; p.drag = 2.2;
    p.additive = true; p.spin = 0; p.rot = 0;
  };

  /* ---------------------------------------------------------------------- *
   * UPDATE — dt em ms REAIS (main.js chama sempre, mesmo em hitstop).
   * ---------------------------------------------------------------------- */
  FX.update = function (dt) {
    ensurePools();
    if (!(dt > 0)) dt = 0;
    var s = dt / 1000;

    /* --- hitstop: consome tempo real -------------------------------------- */
    var congelado = hitstopMs > 0;
    if (congelado) {
      hitstopMs -= dt;
      if (hitstopMs < 0) hitstopMs = 0;
    }

    /* --- trauma / shake ---------------------------------------------------
       Decaimento linear (§4). O deslocamento é quadrático no trauma: pancadas
       fortes tremem MUITO e somem rápido, tremores fracos quase não aparecem.
       Isso é o que dá a sensação de "impacto" em vez de "câmera bêbada".      */
    if (trauma > 0) {
      trauma -= s * 1.6;
      if (trauma < 0) trauma = 0;
    }
    if (trauma > 0) {
      var amp = trauma * trauma * 14;
      shakeX = (Math.random() * 2 - 1) * amp;
      shakeY = (Math.random() * 2 - 1) * amp;
    } else {
      shakeX = 0; shakeY = 0;
    }

    /* --- flash / chroma: rodam mesmo em hitstop (são feedback, não mundo) -- */
    if (flashA > 0) {
      flashT += dt;
      if (flashT >= flashDur) { flashA = 0; flashT = 0; }
    }
    if (chromaMs > 0) {
      chromaMs -= dt;
      if (chromaMs < 0) chromaMs = 0;
    }

    /* --- textos flutuantes: também continuam no hitstop -------------------- */
    var tdamp;
    for (var ti = 0; ti < nTexts; ti++) {
      var t = texts[ti];
      t.life -= dt;
      if (t.life <= 0) { killText(ti); ti--; continue; }
      t.y += t.vy * s;
      // Frenagem em TEMPO REAL, não por frame. O antigo `t.vy *= 0.985` era um
      // fator fixo por quadro: a 60Hz sobravam ~40% da velocidade por segundo,
      // mas a 144Hz sobravam ~14% e o texto travava em cima da comida em vez de
      // flutuar (§4). Mesmo arrasto linear já usado nas partículas, calibrado
      // para reproduzir o comportamento de 60fps (0.985^60 ≈ 0.40/s).
      tdamp = 1 - 0.91 * s;
      if (tdamp < 0) tdamp = 0;
      t.vy *= tdamp;              // desacelera a subida: efeito de "flutuar"
    }

    /* --- bursts agendados -------------------------------------------------- */
    for (var di = 0; di < nDelays; di++) {
      var d = delays[di];
      d.t -= dt;
      if (d.t <= 0) {
        emit(d.x, d.y, d.count, d.color, d.speed, d.size, d.life,
          d.spread, d.angle, d.gravity, d.drag, d.additive, d.spin);
        killDelay(di); di--;
      }
    }

    /* --- SIMULAÇÃO DO MUNDO ----------------------------------------------
       Durante o hitstop, partículas e anéis ficam CONGELADOS no ar. É esse
       congelamento total que faz a pancada "pesar"; se só o gameplay parasse
       e os estilhaços continuassem voando, o efeito se perderia.             */
    if (congelado) return;

    for (var i = 0; i < nParts; i++) {
      var p = parts[i];
      p.life -= dt;
      if (p.life <= 0) { killPart(i); i--; continue; }
      p.vy += p.gravity * s;
      // Arrasto linear (1 - drag*dt) em vez de pow(drag, dt): evita uma
      // chamada a Math.pow por partícula por frame, com o mesmo visual.
      var damp = 1 - p.drag * s;
      if (damp < 0) damp = 0;
      p.vx *= damp; p.vy *= damp;
      p.x += p.vx * s;
      p.y += p.vy * s;
      if (p.spin !== 0) p.rot += p.spin * s;
    }

    for (var ri = 0; ri < nRings; ri++) {
      var r = rings[ri];
      r.life -= dt;
      if (r.life <= 0) { killRing(ri); ri--; }
    }
  };

  /* ---------------------------------------------------------------------- *
   * DRAW — MUNDO (partículas + anéis)
   * Duas passadas: primeiro as normais (source-over), depois as aditivas com
   * 'lighter'. Duas passadas custam menos que alternar o composite dezenas de
   * vezes dentro de uma passada só — trocar globalCompositeOperation quebra o
   * batch do canvas.
   * ---------------------------------------------------------------------- */
  FX.drawWorld = function (ctx) {
    if (nParts === 0 && nRings === 0) return;
    var i, p, k, alpha, sz, comp = ctx.globalCompositeOperation;
    var lastColor = null;

    ctx.save();

    /* passada 1: partículas opacas (fumaça, detritos) */
    for (i = 0; i < nParts; i++) {
      p = parts[i];
      if (p.additive) continue;
      k = p.life / p.maxLife;
      alpha = k * k;                       // fade quadrático: some rápido no fim
      if (alpha < 0.02) continue;
      sz = p.size * (0.35 + 0.65 * k);
      ctx.globalAlpha = alpha;
      if (p.color !== lastColor) { ctx.fillStyle = p.color; lastColor = p.color; }
      desenhaParticula(ctx, p, sz);
    }

    /* passada 2: brilho aditivo — o "neon" do jogo inteiro mora aqui */
    ctx.globalCompositeOperation = 'lighter';
    lastColor = null;
    for (i = 0; i < nParts; i++) {
      p = parts[i];
      if (!p.additive) continue;
      k = p.life / p.maxLife;
      alpha = k * k;
      if (alpha < 0.02) continue;
      sz = p.size * (0.35 + 0.65 * k);
      ctx.globalAlpha = alpha;
      if (p.color !== lastColor) { ctx.fillStyle = p.color; lastColor = p.color; }
      desenhaParticula(ctx, p, sz);
    }

    /* anéis de choque */
    lastColor = null;
    for (i = 0; i < nRings; i++) {
      var r = rings[i];
      var u = 1 - r.life / r.maxLife;       // 0..1 progresso
      // easeOutCubic: o anel dispara pra fora e freia — leitura de "impacto".
      var rad = r.r0 + (r.r1 - r.r0) * easeOutCubic(u);
      var a = (1 - u) * (1 - u);
      if (a < 0.02 || rad <= 0) continue;
      ctx.globalAlpha = a;
      ctx.lineWidth = r.width * (1 - u * 0.65);
      if (r.color !== lastColor) { ctx.strokeStyle = r.color; lastColor = r.color; }
      ctx.beginPath();
      ctx.arc(r.x, r.y, rad, 0, PI2);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = comp;
    ctx.restore();
  };

  /* Partícula: quadrado centrado. Só paga save/rotate/restore quando gira. */
  function desenhaParticula(ctx, p, sz) {
    var h = sz * 0.5;
    if (p.spin === 0) {
      ctx.fillRect(p.x - h, p.y - h, sz, sz);
    } else {
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillRect(-h, -h, sz, sz);
      ctx.rotate(-p.rot);
      ctx.translate(-p.x, -p.y);
    }
  }

  /* ---------------------------------------------------------------------- *
   * GRADIENTES DA VINHETA (cacheados por dimensão)
   * ---------------------------------------------------------------------- */
  function ensureGrads(ctx, w, h) {
    if (w === gW && h === gH && gradRed) return;
    gW = w; gH = h;
    var cx = w * 0.5, cy = h * 0.5;
    var r0 = Math.min(w, h) * 0.30;
    var r1 = Math.max(w, h) * 0.72;
    gradRed = ctx.createRadialGradient(cx, cy, r0, cx, cy, r1);
    gradRed.addColorStop(0, 'rgba(255,0,64,0)');
    gradRed.addColorStop(1, 'rgba(255,0,64,0.85)');
    gradCyan = ctx.createRadialGradient(cx, cy, r0, cx, cy, r1);
    gradCyan.addColorStop(0, 'rgba(0,255,255,0)');
    gradCyan.addColorStop(1, 'rgba(0,255,255,0.85)');
  }

  /* ---------------------------------------------------------------------- *
   * DRAW — OVERLAY (espaço de tela): chroma, flash, textos flutuantes.
   * ---------------------------------------------------------------------- */
  FX.drawOverlay = function (ctx, w, h) {
    var comp = ctx.globalCompositeOperation;

    /* --- ABERRAÇÃO CROMÁTICA BARATA ---------------------------------------
       O jeito "correto" seria separar os canais RGB do frame e redesenhar o
       canvas inteiro deslocado 2x — isso são dois blits de tela cheia por
       frame (ou pior, getImageData), o que sozinho come o orçamento de 16ms.
       Truque: o olho lê aberração cromática principalmente nas BORDAS da
       imagem. Então desenhamos apenas duas vinhetas radiais — vermelha
       deslocada pra um lado, ciano pro outro — em 'lighter'. São dois
       fillRect com gradiente cacheado, custo praticamente zero, e a ilusão
       de "sinal de vídeo corrompido" é idêntica em movimento.                */
    if (chromaMs > 0) {
      ensureGrads(ctx, w, h);
      var cu = clamp(chromaMs / chromaDur, 0, 1);
      var forca = cu * cu;                       // some suave no fim
      // Jitter em alta frequência: o deslocamento treme, não desliza.
      var dx = (5 + Math.random() * 5) * forca;
      var dy = (Math.random() * 2 - 1) * 2 * forca;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.55 * forca;
      ctx.translate(-dx, -dy);
      ctx.fillStyle = gradRed;
      ctx.fillRect(0, 0, w, h);
      ctx.translate(dx * 2, dy * 2);
      ctx.fillStyle = gradCyan;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }

    /* --- FLASH ------------------------------------------------------------ */
    if (flashA > 0) {
      var fa = flashA * (1 - easeOutCubic(clamp(flashT / flashDur, 0, 1)));
      if (fa > 0.004) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = fa;
        ctx.fillStyle = flashColor;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }
    }

    /* --- TEXTOS FLUTUANTES ------------------------------------------------ */
    if (nTexts > 0) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      var tdx, tdy;
      for (var i = 0; i < nTexts; i++) {
        var t = texts[i];
        var u = 1 - t.life / t.maxLife;
        // Opaco na maior parte da vida, fade só nos últimos ~40%: o jogador
        // precisa conseguir LER "+50" antes de ele começar a sumir.
        var a = u < 0.6 ? 1 : (1 - u) / 0.4;
        // Pop de entrada: cresce de 0.6x até 1x nos primeiros 12%.
        var esc = u < 0.12 ? (0.6 + 0.4 * easeOutCubic(u / 0.12)) : 1;
        if (a <= 0.01) continue;
        ctx.font = t.font;
        // CLAMP DE BORDA — o texto nasce em pixels de MUNDO (ex.: 'ESCUDO
        // QUEBRADO' na coluna 0 nasce em x=16, e centrado ele começaria em
        // x=-74: o jogador leria 'O QUEBRADO'). Como textAlign é 'center' e
        // textBaseline é 'middle', prendemos o ponto de desenho dentro do
        // retângulo w x h com meia-largura/meia-altura de folga, para o evento
        // continuar legível quando acontece encostado na parede.
        // A medição custa um measureText por texto na vida inteira dele
        // (cacheado em t.halfW), não um por frame.
        if (t.halfW < 0) t.halfW = ctx.measureText(t.texto).width * 0.5;
        tdx = clamp(t.x, t.halfW + 8, w - t.halfW - 8);
        tdy = clamp(t.y, t.tamanho * 0.7, h - t.tamanho * 0.7);
        ctx.globalAlpha = a;
        ctx.fillStyle = t.cor;
        // O pop usa save/restore em vez de setTransform: o Renderer pode ter
        // um transform de devicePixelRatio ativo, e zerá-lo aqui quebraria
        // todo o resto do desenho em telas HiDPI.
        if (esc !== 1) {
          ctx.save();
          ctx.translate(tdx, tdy);
          ctx.scale(esc, esc);
          ctx.fillText(t.texto, 0, 0);
          // Segunda passada aditiva = halo neon sem custo de shadowBlur.
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = a * 0.5;
          ctx.fillText(t.texto, 0, 0);
          ctx.restore();
        } else {
          ctx.fillText(t.texto, tdx, tdy);
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = a * 0.5;
          ctx.fillText(t.texto, tdx, tdy);
          ctx.globalCompositeOperation = 'source-over';
        }
      }
      ctx.restore();
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = comp;
  };

  window.COBRA.FX = FX;
})();
