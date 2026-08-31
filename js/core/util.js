/* ==========================================================================
   COBRONA :: PROTOCOLO NEON
   js/core/util.js  ->  COBRA.Util
   Funções puras e sem estado (exceto o fallback de storage). Este arquivo é a
   base de todos os outros; ele NÃO lê COBRA.CFG nem qualquer outro módulo,
   nem no topo nem dentro das funções — assim a ordem de carga nunca o quebra.
   ========================================================================== */
(function () {
  'use strict';

  window.COBRA = window.COBRA || {};

  // Aliases locais: acesso a Math.* dentro de loops quentes (partículas, render)
  // é medível; guardar a referência evita uma busca de propriedade por chamada.
  var M = Math;
  var PI = M.PI;
  var pow = M.pow;
  var sin = M.sin;
  var abs = M.abs;
  var floor = M.floor;
  var random = M.random;

  var Util = {};

  /* ---------------------------------------------------------------------
     Matemática básica
     --------------------------------------------------------------------- */

  /** Prende v no intervalo [a, b]. */
  Util.clamp = function (v, a, b) {
    return v < a ? a : (v > b ? b : v);
  };

  /** Interpolação linear. É o coração do movimento contínuo (§2). */
  Util.lerp = function (a, b, t) {
    return a + (b - a) * t;
  };

  /** Inverso de lerp: onde v cai entre a e b, em 0..1 (sem clamp). */
  Util.invLerp = function (a, b, v) {
    return b === a ? 0 : (v - a) / (b - a);
  };

  /** Reprojeta v de [a,b] para [c,d]. Helper extra, útil em HUD/áudio. */
  Util.remap = function (v, a, b, c, d) {
    return c + (d - c) * Util.invLerp(a, b, v);
  };

  /** Envolve v no anel [0, n) — usado pelo wrap do FANTASMA nas bordas. */
  Util.wrap = function (v, n) {
    return ((v % n) + n) % n;
  };

  /* ---------------------------------------------------------------------
     Curvas de animação
     Constantes canônicas (as mesmas de easings.net) — não ajustar "no olho",
     elas definem o feel de todos os pops/banners do jogo.
     --------------------------------------------------------------------- */

  Util.easeOutCubic = function (t) {
    var u = 1 - t;
    return 1 - u * u * u;
  };

  Util.easeInCubic = function (t) {
    return t * t * t;
  };

  /** Overshoot suave: passa de 1 e volta. c1 = 1.70158 (canônico). */
  Util.easeOutBack = function (t) {
    var c1 = 1.70158;
    var c3 = c1 + 1;
    var u = t - 1;
    return 1 + c3 * u * u * u + c1 * u * u;
  };

  /** Mola amortecida. c4 = 2π/3 (canônico). Extremos tratados à parte
      porque pow(2, -10*0) = 1 daria 1 em vez de 0. */
  Util.easeOutElastic = function (t) {
    var c4 = (2 * PI) / 3;
    if (t === 0) return 0;
    if (t === 1) return 1;
    return pow(2, -10 * t) * sin((t * 10 - 0.75) * c4) + 1;
  };

  Util.easeInOutSine = function (t) {
    return -(M.cos(PI * t) - 1) / 2;
  };

  /* ---------------------------------------------------------------------
     Aleatoriedade
     --------------------------------------------------------------------- */

  /** Float em [a, b). */
  Util.rand = function (a, b) {
    return a + random() * (b - a);
  };

  /** Inteiro em [a, b] — INCLUSIVO nos dois extremos (grade é inclusiva). */
  Util.randInt = function (a, b) {
    return floor(a + random() * (b - a + 1));
  };

  /** Elemento aleatório do array (null se vazio/ausente). */
  Util.pick = function (arr) {
    if (!arr || arr.length === 0) return null;
    return arr[floor(random() * arr.length)];
  };

  /** true com probabilidade p (0..1). */
  Util.chance = function (p) {
    return random() < p;
  };

  /** Fisher-Yates in-place. Usado na geração de muros/portais. */
  Util.shuffle = function (arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = floor(random() * (i + 1));
      var t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  };

  /* ---------------------------------------------------------------------
     Cor e formatação
     --------------------------------------------------------------------- */

  /** Monta a string CSS hsla. O corpo da cobra usa matiz variável por
      segmento (§1), então isso é chamado bastante — string concat simples
      é mais rápida aqui do que template/array.join. */
  Util.hsla = function (h, s, l, a) {
    return 'hsla(' + h + ',' + s + '%,' + l + '%,' + a + ')';
  };

  /** Converte '#rrggbb' em 'rgba(r,g,b,a)'. Helper extra para dar alpha às
      cores da paleta sem precisar duplicar constantes. */
  Util.rgba = function (hex, a) {
    var h = hex.charAt(0) === '#' ? hex.slice(1) : hex;
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  };

  /** Chave de célula para Set/Map. Formato "x,y" — é contrato (§9.6). */
  Util.key = function (x, y) {
    return x + ',' + y;
  };

  /** Distância de Manhattan — métrica do caçador (§3.5). */
  Util.manhattan = function (ax, ay, bx, by) {
    return abs(ax - bx) + abs(ay - by);
  };

  /** Zero à esquerda em números de 1 dígito ("SETOR 01"). */
  Util.pad2 = function (n) {
    return n < 10 ? '0' + n : '' + n;
  };

  /** ms -> "M:SS" (ex.: 67000 -> "1:07"). Sem horas: partida longa vira "83:20". */
  Util.formatTime = function (ms) {
    var total = floor((ms || 0) / 1000);
    if (total < 0) total = 0;
    var m = floor(total / 60);
    var s = total % 60;
    return m + ':' + (s < 10 ? '0' + s : s);
  };

  /* ---------------------------------------------------------------------
     Direções
     Congeladas: os vetores circulam por Input/Snake/Game por referência;
     uma mutação acidental (dir.x++) corromperia o jogo inteiro.
     --------------------------------------------------------------------- */

  Util.DIRS = Object.freeze({
    UP:    Object.freeze({ x: 0,  y: -1 }),
    DOWN:  Object.freeze({ x: 0,  y: 1 }),
    LEFT:  Object.freeze({ x: -1, y: 0 }),
    RIGHT: Object.freeze({ x: 1,  y: 0 })
  });

  /** Mesma direção? (compara componentes, não identidade) */
  Util.dirEqual = function (a, b) {
    return !!a && !!b && a.x === b.x && a.y === b.y;
  };

  /** Direções exatamente opostas? Base do filtro da fila de input (§2). */
  Util.isOpposite = function (a, b) {
    return !!a && !!b && a.x === -b.x && a.y === -b.y;
  };

  /* ---------------------------------------------------------------------
     Storage resiliente
     Em file:// o Chrome LANÇA SecurityError só de tocar em window.localStorage
     (nem no getItem — no acesso à propriedade). Por isso TUDO aqui está em
     try/catch, inclusive a detecção, e existe um espelho em memória que
     mantém o jogo funcional na sessão mesmo sem persistência real.
     --------------------------------------------------------------------- */

  var mem = {};          // fallback em memória (sempre escrito, sempre lido por último)
  var ls = null;         // referência ao localStorage, se acessível
  var lsProbed = false;  // detecção preguiçosa: só na 1ª operação

  function backend() {
    if (lsProbed) return ls;
    lsProbed = true;
    try {
      var probe = window.localStorage;
      // Teste de escrita real: Safari privado expõe o objeto mas rejeita setItem.
      var k = '__cobrona_probe__';
      probe.setItem(k, '1');
      probe.removeItem(k);
      ls = probe;
    } catch (e) {
      ls = null;
    }
    return ls;
  }

  Util.store = {
    /** Lê e desserializa JSON. Qualquer falha (bloqueio, JSON corrompido)
        cai silenciosamente na memória e, por fim, no fallback informado. */
    get: function (key, fallback) {
      var raw = null;
      var b = backend();
      if (b) {
        try {
          raw = b.getItem(key);
        } catch (e) {
          raw = null;
        }
      }
      if (raw === null || raw === undefined) {
        raw = Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : null;
      }
      if (raw === null || raw === undefined) return fallback;
      try {
        var v = JSON.parse(raw);
        return (v === null || v === undefined) ? fallback : v;
      } catch (e) {
        return fallback;
      }
    },

    /** Serializa e grava. Nunca lança: no pior caso persiste só na sessão. */
    set: function (key, value) {
      var raw;
      try {
        raw = JSON.stringify(value);
      } catch (e) {
        return false;
      }
      mem[key] = raw; // espelho em memória primeiro: garante leitura coerente já
      var b = backend();
      if (b) {
        try {
          b.setItem(key, raw);
          return true;
        } catch (e) {
          // cota estourada ou acesso negado — segue só com a memória
        }
      }
      return false;
    },

    /** Remove a chave dos dois lados. Helper extra. */
    remove: function (key) {
      delete mem[key];
      var b = backend();
      if (b) {
        try { b.removeItem(key); } catch (e) { /* ignorado de propósito */ }
      }
    },

    /** true se a persistência real está disponível (para a UI avisar, se quiser). */
    available: function () {
      return !!backend();
    }
  };

  COBRA.Util = Util;
})();
