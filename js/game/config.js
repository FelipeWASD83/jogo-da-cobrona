/* ==========================================================================
   COBRONA :: PROTOCOLO NEON
   js/game/config.js  ->  COBRA.CFG

   FONTE ÚNICA DA VERDADE. Toda constante numérica, cor, texto e tabela de
   balanceamento do jogo mora aqui. Nenhum outro módulo deve escrever número
   mágico: se falta algo, acrescente NESTE arquivo.

   Este arquivo só depende de COBRA.Util DENTRO de funções (sectorInfo usa
   Util.pad2), nunca no escopo de topo — a ordem de carga fica robusta.
   ========================================================================== */
(function () {
  'use strict';

  window.COBRA = window.COBRA || {};

  var CFG = {};

  /* ======================================================================
     0. GERAL
     ====================================================================== */

  CFG.DEBUG = false;                       // único portão permitido para console.log
  CFG.VERSION = '1.0.0';
  // NÃO USADOS pelo código: o título e o subtítulo que aparecem no menu estão
  // escritos no index.html. Ficam aqui só como referência.
  CFG.TITLE = 'COBRONA';
  CFG.SUBTITLE = ':: PROTOCOLO NEON ::';

  /* ======================================================================
     1. GRADE E CANVAS (§2)
     ====================================================================== */

  CFG.GRID_W = 30;
  CFG.GRID_H = 20;
  CFG.CELL = 32;
  CFG.W = 960;                             // GRID_W * CELL
  CFG.H = 640;                             // GRID_H * CELL
  CFG.HALF = 16;                           // meia célula: centro de uma célula em px

  /* ======================================================================
     2. RITMO (§2)
     ====================================================================== */

  CFG.TICK_BASE = 130;                     // ms por tick no nível 0
  CFG.TICK_MIN = 58;                       // piso absoluto — abaixo disso vira injogável
  CFG.TICK_STEP = 5;                       // ms retirados por nível
  CFG.FOODS_PER_LEVEL = 5;                 // comidas para subir 1 nível
  CFG.DT_MAX = 50;                         // clamp do dt no main loop (aba em 2º plano)

  CFG.START_LEN = 4;                       // segmentos iniciais
  CFG.START_DIR = 'RIGHT';                 // chave de Util.DIRS

  /** tickMs efetivo do nível, antes dos modificadores de power-up. */
  CFG.tickFor = function (level, baseTick) {
    var base = (baseTick === undefined || baseTick === null) ? CFG.TICK_BASE : baseTick;
    return Math.max(CFG.TICK_MIN, base - level * CFG.TICK_STEP);
  };

  /* ======================================================================
     3. PALETA (§1)
     ====================================================================== */

  CFG.PAL = {
    void:     '#04010c',
    deep:     '#0b0424',
    gridLine: '#2a1566',
    gridGlow: '#4b1fa8',
    cyan:     '#00f0ff',
    magenta:  '#ff2d95',
    lime:     '#7dff4d',
    amber:    '#ffb800',
    violet:   '#a855ff',
    danger:   '#ff2b2b',
    white:    '#eaf6ff',
    dim:      '#7a6fa8'
  };

  /** Gradiente do corpo: hue = 185 - i*1.6 (ciano -> violeta -> magenta).
      HUE_MIN existe porque cobras muito longas estourariam para hues negativos
      (verde/amarelo), quebrando a identidade cromática. */
  CFG.SNAKE = {
    HUE_HEAD: 185,
    HUE_STEP: 1.6,
    HUE_MIN: -60,                          // clamp: 185 - 1.6*i satura aqui (~i 153)
    SAT: 100,                              // SAT e LIGHT: cor da explosão da morte (game.js).
    LIGHT: 55,                             // A luminosidade dos SPRITES do corpo e da cabeça
                                           // fica em renderer.js (bakeSprites/bakeHead).
    HUE_SPRITES: 36,                       // nº de sprites pré-renderizados por matiz (renderer.js)
    TRAIL_LEN: 8,                          // rastro da cabeça (§4)
    TRAIL_MS: 16,                          // intervalo de amostragem do rastro em ms.
                                           // Por TEMPO e não por frame: senão o
                                           // rastro encolhe num monitor de 144Hz.
    TRAIL_ALPHA: 0.45                      // alpha do 1º rastro, decresce até 0 (renderer.js)
  };

  /* ======================================================================
     4. COMBO (§3.1)
     ====================================================================== */

  CFG.COMBO_MS = 2500;                     // janela para encadear
  CFG.COMBO_MAX_MULT = 8;                  // teto do multiplicador
  CFG.COMBO_STEP = 0.5;                    // mult = 1 + combo*0.5
  CFG.COMBO_SEMITONE_CAP = 18;             // teto do pitch do som de comer (audio.js)

  /** mult = min(8, 1 + combo*0.5). */
  CFG.multFor = function (combo) {
    return Math.min(CFG.COMBO_MAX_MULT, 1 + combo * CFG.COMBO_STEP);
  };

  /* ======================================================================
     5. COMIDAS (§3.2)
     ttl 0 = eterna. blink = janela final em que pisca.
     ====================================================================== */

  CFG.FOOD = {
    normal:  { pts: 10, grow: 1, ttl: 0,    chance: 0.83, cor: CFG.PAL.magenta, blink: 0 },
    gold:    { pts: 50, grow: 2, ttl: 6000, chance: 0.12, cor: CFG.PAL.amber,   blink: 2000 },
    crystal: { pts: 25, grow: 1, ttl: 9000, chance: 0.05, cor: CFG.PAL.violet,  blink: 2000 }
  };

  /** Ordem de sorteio (roleta acumulada). Manter alinhada com as chances acima. */
  CFG.FOOD_ROLL = ['gold', 'crystal', 'normal'];

  /** Sorteia um tipo de comida respeitando as chances de §3.2. */
  CFG.rollFoodType = function () {
    var r = Math.random();
    var acc = 0;
    for (var i = 0; i < CFG.FOOD_ROLL.length; i++) {
      var id = CFG.FOOD_ROLL[i];
      acc += CFG.FOOD[id].chance;
      if (r < acc) return id;
    }
    return 'normal';                        // rede de segurança se as chances não somarem 1
  };

  /* ======================================================================
     6. POWER-UPS (§3.3)
     ====================================================================== */

  // `icone` NÃO É USADO: o chip de power-up do HUD mostra só o nome.
  CFG.POWER = {
    ghost:  { ms: 8000,  nome: 'FANTASMA',    icone: '👻', cor: CFG.PAL.cyan,
              desc: 'atravessa o corpo e as bordas' },
    magnet: { ms: 10000, nome: 'ÍMÃ',         icone: '🧲', cor: CFG.PAL.lime,
              desc: 'a comida vem até você' },
    slow:   { ms: 6000,  nome: 'TEMPO LENTO', icone: '⏳', cor: CFG.PAL.violet,
              desc: 'tudo desacelera, pontos x2' },
    shield: { ms: 0,     nome: 'ESCUDO',      icone: '🛡️', cor: CFG.PAL.cyan,
              desc: 'sobrevive a uma colisão' },   // ms 0 = dura até levar 1 hit
    fury:   { ms: 7000,  nome: 'FÚRIA',       icone: '🔥', cor: CFG.PAL.danger,
              desc: 'rápido, pontos x3, destrói tudo' }
  };

  CFG.POWER_IDS = ['ghost', 'magnet', 'slow', 'shield', 'fury'];
  CFG.POWER_BLINK_MS = 2000;               // ícone pisca nos últimos 2s

  CFG.SLOW_TICK_MULT = 1.8;                // tickMs x 1.8
  CFG.SLOW_PTS_MULT = 2;
  CFG.FURY_TICK_MULT = 0.6;                // tickMs x 0.6
  CFG.FURY_PTS_MULT = 3;
  CFG.MAGNET_RANGE = 6;                    // células de alcance (Manhattan)
  CFG.MAGNET_EVERY_TICKS = 2;              // a comida anda 1 célula a cada 2 ticks

  /* ======================================================================
     7. SETORES (§3.4)
     ====================================================================== */

  CFG.SECTOR_PTS = 500;                    // pontos por setor
  CFG.SECTOR_BANNER_MS = 1800;

  // A cor da grade de cada setor NÃO mora aqui: vem da tabela SECTOR_HUE de
  // js/render/background.js (6 matizes; do SETOR 06 em diante é sempre a
  // última). Os campos gridLine/gridGlow/pulsa que existiam aqui nunca foram
  // lidos e tinham cores diferentes das da tela — removidos em 19/09/2026.
  // O pulso da grade segue a intensidade musical (intensityFor).
  CFG.SECTORS = [
    { nome: 'SETOR 01 :: BOOT',        pontos: 0,    muros: false, densidade: 0,    cacadores: 0, portais: false },
    { nome: 'SETOR 02 :: FIREWALL',    pontos: 500,  muros: true,  densidade: 0.03, cacadores: 0, portais: false },
    { nome: 'SETOR 03 :: CAÇADA',      pontos: 1000, muros: true,  densidade: 0.04, cacadores: 1, portais: false },
    { nome: 'SETOR 04 :: DOBRA',       pontos: 1500, muros: true,  densidade: 0.05, cacadores: 1, portais: true },
    { nome: 'SETOR 05 :: SOBRECARGA',  pontos: 2000, muros: true,  densidade: 0.06, cacadores: 2, portais: true },
    { nome: 'SETOR 06 :: CAOS',        pontos: 2500, muros: true,  densidade: 0.07, cacadores: 3, portais: true }
  ];

  CFG.SECTOR_HUNTER_CAP = 5;               // cap de caçadores simultâneos (§3.4)
  CFG.SECTOR_DENSITY_CAP = 0.12;           // teto de muros: acima disso a arena estrangula
  CFG.SECTOR_DENSITY_STEP = 0.01;

  /** Índice do setor a partir dos pontos. Sem cap: o setor cresce para sempre. */
  CFG.sectorFor = function (score) {
    var i = Math.floor((score || 0) / CFG.SECTOR_PTS);
    return i < 0 ? 0 : i;
  };

  /** Cache dos setores gerados: sectorInfo é chamado no HUD (todo frame) e
      não pode alocar um objeto novo por chamada. */
  var genCache = {};

  /** Descrição do setor i. Para i >= SECTORS.length gera proceduralmente:
      +1 caçador por setor (cap 5) e muros progressivamente mais densos. */
  CFG.sectorInfo = function (i) {
    if (i < 0) i = 0;
    if (i < CFG.SECTORS.length) return CFG.SECTORS[i];
    if (genCache[i]) return genCache[i];

    var Util = COBRA.Util;                 // lido só aqui dentro (ordem de carga)
    var extra = i - (CFG.SECTORS.length - 1);   // quantos setores além do último fixo
    var last = CFG.SECTORS[CFG.SECTORS.length - 1];
    var num = Util ? Util.pad2(i + 1) : (i + 1);

    var info = {
      nome: 'SETOR ' + num + ' :: CAOS',
      pontos: i * CFG.SECTOR_PTS,
      muros: true,
      densidade: Math.min(CFG.SECTOR_DENSITY_CAP, last.densidade + extra * CFG.SECTOR_DENSITY_STEP),
      cacadores: Math.min(CFG.SECTOR_HUNTER_CAP, last.cacadores + extra),
      portais: true,
      gerado: true
    };
    genCache[i] = info;
    return info;
  };

  /** Intensidade musical (0..3) derivada do setor (§5). */
  CFG.intensityFor = function (sector) {
    return Math.max(0, Math.min(3, sector | 0));
  };

  /* ======================================================================
     8. CAÇADOR (§3.5)
     ====================================================================== */

  CFG.HUNTER = {
    MOVE_EVERY_TICKS: 2,                   // move a cada 2 ticks
    MOVE_EVERY_TICKS_SLOW: 3,              // ...3 se TEMPO LENTO ativo
    SPAWN_MS: 1200,                        // materialização (intangível, piscando)
    SPAWN_MIN_DIST: 10,                    // distância mínima da cabeça ao nascer
    KILL_PTS: 100,                         // pontos por destruir com FÚRIA
    BLINK_HZ: 8,                           // piscadas por segundo durante o spawn
    MAX: 5
  };

  /* ======================================================================
     9. PORTAIS (§3.6)
     ====================================================================== */

  CFG.PORTAL = {
    PAIRS: 2,
    COOLDOWN_TICKS: 2,                     // evita loop infinito entre as pontas
    COR: CFG.PAL.violet,                   // cor do portal (renderer.js)
    RING_SPEED: 1.6,                       // rad/s do anel girando
    MARGIN: 2                              // não nascem colados na borda
  };

  /* ======================================================================
     10. MORTE E INVULNERABILIDADE (§2)
     ====================================================================== */

  CFG.SHIELD_IFRAMES_MS = 800;             // após quebrar o escudo
  // Não existe "recuo em células": a colisão salva (escudo, ZEN, i-frames)
  // rebobina a cobra INTEIRA um tick (game.js, rewind). O antigo
  // SHIELD_PUSHBACK nunca foi lido e foi removido em 19/09/2026.
  CFG.ZEN_IFRAMES_MS = 1000;
  CFG.ZEN_PENALTY = 3;                     // segmentos perdidos ao colidir no ZEN
  CFG.MIN_LEN = 3;                         // a cobra nunca encolhe abaixo disso
                                           // (piso visual: 2 vira um ponto na tela)

  // A aberração cromática da morte é JUICE.death.chroma (o DEATH.CHROMA_MS que
  // existia aqui repetia o valor e nunca foi lido; removido em 19/09/2026).
  CFG.DEATH = {
    SEG_DELAY_MS: 18,                      // atraso da explosão por segmento
    SLOWMO_FROM: 0.25,                     // timeScale inicial
    SLOWMO_MS: 900,                        // tempo até voltar a 1
    ANIM_MS: 1400                          // duração total de Game.deathAnim (0..1)
  };

  /** Manchetes de game over por causa (§6). */
  CFG.DEATH_TITLES = {
    parede:   'VOCÊ VIROU CONCRETO',
    muro:     'VOCÊ VIROU CONCRETO',       // alias: muro interno usa a mesma manchete
    corpo:    'VOCÊ SE MORDEU, GÊNIO',
    cacador:  'O CAÇADOR TE PEGOU',
    perfeito: 'VOCÊ COMEU A REDE INTEIRA'
  };
  CFG.DEATH_TITLE_DEFAULT = 'CONEXÃO PERDIDA';

  CFG.deathTitle = function (cause) {
    return CFG.DEATH_TITLES[cause] || CFG.DEATH_TITLE_DEFAULT;
  };

  /* ======================================================================
     11. MODOS (§3.7)
     ====================================================================== */

  CFG.MODES = {
    classico: {
      id: 'classico',
      nome: 'CLÁSSICO',
      tickBase: 130,
      startSector: 0,
      hunters: null,                       // null = usa o do setor
      ptsMult: 1,
      morre: true,
      muros: true,
      cacadores: true,
      progressao: true
    },
    caos: {
      id: 'caos',
      nome: 'CAÔS',
      tickBase: 105,
      startSector: 3,                      // começa direto no setor 3 (DOBRA)
      hunters: 2,
      ptsMult: 1.5,
      morre: true,
      muros: true,
      cacadores: true,
      progressao: true
    },
    zen: {
      id: 'zen',
      nome: 'ZEN',
      tickBase: 130,
      startSector: 0,
      hunters: 0,
      ptsMult: 1,
      morre: false,                        // colidir custa 3 segmentos
      muros: false,
      cacadores: false,
      progressao: true
    }
  };

  CFG.MODE_IDS = ['classico', 'caos', 'zen'];   // referência: o jogo não lê (o menu está no index.html)
  CFG.DEFAULT_MODE = 'classico';

  /* ======================================================================
     12. JUICE (§4)
     Tabela evento -> feedback. FX/Game leem daqui em vez de repetir números.
     ====================================================================== */

  // Tamanho dos pools do FX (js/core/fx.js), alocados uma vez no primeiro uso.
  CFG.MAX_PARTICLES = 900;                 // limite duro; pool pré-alocado, recicla os mais velhos
  CFG.MAX_RINGS = 48;                      // anéis de choque simultâneos
  CFG.MAX_TEXTS = 32;                      // textos flutuantes simultâneos (estava 24 aqui, mas
                                           // o FX sempre usou 32: o config passou a dizer a verdade)

  CFG.SHAKE = {                            // lido por FX.shake e FX.update
    DECAY: 1.6,                            // trauma -= dt*1.6 (em segundos)
    MAX_PX: 14,                            // deslocamento = trauma² * 14px
    DIVISOR: 25                            // FX.shake(n): trauma += n/25
  };

  CFG.JUICE = {
    eat:        { hitstop: 45,  shake: 4,  particles: 18, flash: 0.06, cor: CFG.PAL.magenta },
    gold:       { hitstop: 90,  shake: 9,  particles: 40, flash: 0.14, cor: CFG.PAL.amber },
    crystal:    { hitstop: 120, shake: 11, particles: 46, flash: 0.18, cor: CFG.PAL.violet },
    levelUp:    { hitstop: 60,  shake: 5,  particles: 0,  flash: 0.10, cor: CFG.PAL.lime },
    sector:     { hitstop: 140, shake: 14, particles: 80, flash: 0.25, cor: CFG.PAL.cyan },
    shieldBreak:{ hitstop: 160, shake: 16, particles: 60, flash: 0.30, cor: CFG.PAL.cyan, chroma: 400 },
    hunterKill: { hitstop: 80,  shake: 10, particles: 50, flash: 0.12, cor: CFG.PAL.danger },
    death:      { hitstop: 260, shake: 24, particles: 0,  flash: 0.5,  cor: CFG.PAL.danger, chroma: 800 },
    portal:     { hitstop: 0,   shake: 3,  particles: 14, flash: 0,    cor: CFG.PAL.violet }
  };

  /** Onda de engolida (§4): escala = 1 + 0.45 * max(0, 1 - |wave - i|/2). */
  CFG.WAVE = {
    SPEED: 22,                             // segmentos por segundo
    AMP: 0.45,
    WIDTH: 2
  };

  /* Duração do fade do flash de tela, lida pelo FX (js/core/fx.js) em
     FX.reset(). O 180 de lá é só reserva para o caso de o CFG não carregar. */
  CFG.FLASH_FADE_MS = 180;                 // quanto tempo o flash leva para sumir

  /* ======================================================================
     13. ÁUDIO (§5)
     ====================================================================== */

  CFG.AUDIO = {
    SFX_BUS: 0.55,
    MUSIC_BUS: 0.35,
    LOOKAHEAD_MS: 100,                     // scheduler de semicolcheias
    BPM_BASE: 112,
    BPM_PER_LEVEL: 2,
    BPM_MAX: 164,
    SCALE: [110.00, 130.81, 146.83, 164.81, 196.00],   // A2 C3 D3 E3 G3 (pentatônica menor)
    ROOT: 110.00,                          // A2
    CROSSFADE_MS: 400,                     // Audio.music.setIntensity
    STEPS: 16                              // NÃO USADO: o scheduler tem 16 passos fixos
  };
  // ROOT também NÃO É USADO (a tônica sai de SCALE[0]).
  // BPM = min(BPM_MAX, BPM_BASE + nivel*BPM_PER_LEVEL): a conta é feita em
  // audio.js (Music.setLevel) com os três números acima. O CFG.bpmFor que
  // repetia a conta aqui nunca foi chamado e foi removido em 19/09/2026.

  /* ======================================================================
     14. INPUT (§2, §7)
     ====================================================================== */

  /* Lidos pelo Input (js/core/input.js) a cada uso; os números de lá são só
     reserva para o caso de o CFG não carregar. Até 19/09/2026 o input.js
     ignorava estes dois e usava os próprios — agora mexer aqui muda o jogo. */
  CFG.INPUT_QUEUE_MAX = 2;                 // fila de até 2 direções (§7)
  CFG.SWIPE_THRESHOLD = 24;                // px para um toque virar swipe (§7)

  /* ======================================================================
     15. STORAGE (§6)
     ====================================================================== */

  CFG.STORAGE_KEY = 'cobrona.recordes.v1'; // top 5 (contrato §6)
  CFG.STORAGE_BEST = 'cobrona.recorde.v1';
  CFG.STORAGE_MUTE = 'cobrona.mudo.v1';
  CFG.STORAGE_MODE = 'cobrona.modo.v1';    // último modo escolhido no menu
  CFG.SCORES_MAX = 5;

  /* ======================================================================
     16. TEXTOS DA UI (§6)
     O ui.js lê daqui: pontos, tamanhoMax, comboMax, setorAlcancado, tempo
     (tela de fim) e prefixoRecorde (menu). Os demais (recorde, tamanho,
     setor, pausado, novoRecorde e as três dicas) NÃO SÃO LIDOS: o mesmo texto
     está escrito no index.html, e é de lá que ele aparece na tela. Mudou um
     deles? Mude no index.html.
     ====================================================================== */

  CFG.TXT = {
    pontos: 'PONTOS',
    recorde: 'RECORDE',
    tamanho: 'TAMANHO',
    setor: 'SETOR',
    pausado: 'PAUSADO',
    novoRecorde: 'NOVO RECORDE!',
    tamanhoMax: 'TAMANHO MÁXIMO',
    comboMax: 'COMBO MÁXIMO',
    setorAlcancado: 'SETOR ALCANÇADO',
    tempo: 'TEMPO',
    dicaMenu: '↑↓ escolhe · ESPAÇO começa · M muta',
    dicaPausa: 'ESPAÇO continua · ESC sai',
    dicaOver: 'ENTER joga de novo · ESC menu',
    prefixoRecorde: 'RECORDE: '
  };

  COBRA.CFG = CFG;
})();
