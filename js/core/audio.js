/* ==========================================================================
   COBRONA :: PROTOCOLO NEON
   js/core/audio.js  ->  COBRA.Audio

   Todo o som do jogo é SINTETIZADO em tempo real (§5). Não existe um único
   byte de sample importado: nem poderia, o jogo roda em file://.

   PRINCÍPIOS DESTE ARQUIVO
   1. Áudio NUNCA pode derrubar o jogo. Se o navegador não tiver AudioContext,
      ou se qualquer nó falhar, todos os métodos públicos viram no-op silencioso.
      Por isso cada método público é um envelope try/catch.
   2. AudioContext é criado sob demanda e de forma idempotente. Criar antes do
      primeiro gesto do usuário é legal (nasce 'suspended'); Audio.unlock() o
      acorda no input. A retomada é PERMANENTE, não uma trava de primeiro
      gesto: no celular o contexto é suspenso de novo a cada ligação, troca de
      app ou tela bloqueada (ver "retomada do contexto" mais abaixo).
   3. Nada de setInterval para a música. O scheduler é chamado por
      Audio.update() a cada frame, com lookahead de 100ms, e agenda
      semicolcheias no relógio de amostragem (ctx.currentTime) — o único
      relógio preciso o suficiente para ritmo. requestAnimationFrame jitters,
      o clock de áudio não.
   4. TODA envelope termina em 0.0001 e não em 0: exponentialRampToValueAtTime
      é indefinido para 0 e o navegador simplesmente ignora a rampa, deixando
      um corte seco (clique). O piso 0.0001 é -80dB, inaudível.
   5. Todo oscilador/fonte recebe stop() explícito. Sem isso os nós ficam vivos
      para sempre e o grafo cresce até engasgar.

   GRAFO
     osc/noise -> gain(env) -> filtro -> sfxBus (0.55)  ┐
                                        musicBus (0.35) ┴-> compressor -> master -> destination

   O master fica DEPOIS do compressor de propósito: mudo é um corte de volume
   final, não deve mudar a forma como o compressor reage à mistura.
   ========================================================================== */
(function () {
  'use strict';

  window.COBRA = window.COBRA || {};

  /* ======================================================================
     ESTADO DO MÓDULO
     Nada aqui lê COBRA.CFG no escopo de topo — só dentro de funções.
     ====================================================================== */

  var ctx = null;             // AudioContext (null = nunca inicializado)
  var supported = null;       // null = ainda não testado, false = sem Web Audio
  var master = null;          // gain final (mudo age aqui)
  var comp = null;            // DynamicsCompressorNode
  var sfxBus = null;
  var musicBus = null;

  var noiseBuf = null;        // UM buffer de ruído branco de 2s, reusado por tudo
  var distCurve = null;       // curva de distorção (som metálico do escudo)

  var muted = false;          // guardado mesmo sem contexto: aplicado no init
  var portalSide = 1;         // alterna o pan de portal() a cada chamada

  var CFG = null;             // cache preguiçoso de COBRA.CFG (lido só em ensure())

  /* Fallbacks locais: se config.js não tiver carregado ainda (ou tiver sido
     enxugado), o áudio continua tocando com os números normativos de §5. */
  var DEF = {
    SFX_BUS: 0.55,
    MUSIC_BUS: 0.35,
    LOOKAHEAD_MS: 100,
    BPM_BASE: 112,
    BPM_PER_LEVEL: 2,
    BPM_MAX: 164,
    SCALE: [110.00, 130.81, 146.83, 164.81, 196.00],  // A2 C3 D3 E3 G3
    CROSSFADE_MS: 400,
    STEPS: 16
  };

  function cfgAudio() {
    if (!CFG) CFG = window.COBRA.CFG || null;
    return (CFG && CFG.AUDIO) ? CFG.AUDIO : DEF;
  }

  function debugOn() {
    if (!CFG) CFG = window.COBRA.CFG || null;
    return !!(CFG && CFG.DEBUG);
  }

  /* ======================================================================
     INFRAESTRUTURA
     ====================================================================== */

  /** Cria o grafo uma única vez. Retorna false se não há Web Audio. */
  function ensure() {
    if (supported === false) return false;
    if (ctx) return true;

    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { supported = false; return false; }
      ctx = new AC();

      // Antes de qualquer nó: arma as defesas contra o contexto ser suspenso
      // no meio da sessão (ligação recebida, troca de app, tela bloqueada).
      installResumeGuards();

      var A = cfgAudio();

      master = ctx.createGain();
      master.gain.value = muted ? 0.0001 : 1;

      comp = ctx.createDynamicsCompressor();
      // Cola a mistura: com 4 camadas de música + SFX simultâneos o pico
      // estoura fácil, e clipping digital em síntese soa como lixo.
      setParam(comp.threshold, -14);
      setParam(comp.knee, 20);
      setParam(comp.ratio, 6);
      setParam(comp.attack, 0.003);
      setParam(comp.release, 0.25);

      sfxBus = ctx.createGain();
      sfxBus.gain.value = A.SFX_BUS !== undefined ? A.SFX_BUS : DEF.SFX_BUS;

      musicBus = ctx.createGain();
      musicBus.gain.value = A.MUSIC_BUS !== undefined ? A.MUSIC_BUS : DEF.MUSIC_BUS;

      sfxBus.connect(comp);
      musicBus.connect(comp);
      comp.connect(master);
      master.connect(ctx.destination);

      buildNoise();
      distCurve = makeDistCurve(28);

      supported = true;
      return true;
    } catch (e) {
      supported = false;
      ctx = null;
      return false;
    }
  }

  /* --- retomada do contexto (celular) ------------------------------------

     O AudioContext NÃO é suspenso só uma vez, na carga da página. No celular
     ele é interrompido TODA vez que o jogador atende uma ligação, troca de
     app ou bloqueia a tela (o state vira 'suspended' — no iOS às vezes
     'interrupted'). Tratar isso como "destrava uma vez e pronto" é o que
     deixava o jogo mudo pelo resto da sessão: o único resume() que o Safari
     aceita é o que roda DENTRO de um gesto do usuário, e o resume de live()
     acontece no requestAnimationFrame, fora de gesto.

     Por isso a retomada mora aqui dentro, e não na disciplina dos chamadores:
     listeners de gesto PERMANENTES, armados junto com o contexto e nunca
     removidos. Custam um `if` por toque quando o áudio já está rodando. */

  var resumeGuardsOn = false;

  /* Objeto de opções criado UMA vez (não por evento). Navegadores antigos que
     não entendem o objeto o coagem para `true` (= capture), o que continua
     correto — nenhum destes handlers chama preventDefault. */
  var GESTURE_OPTS = { capture: true, passive: true };

  /** Tenta acordar o contexto. Sai fora imediatamente quando já está rodando,
      então é barato o suficiente para ser chamado em todo gesto e em todo SFX.
      A promise PRECISA ser tratada: sem o .catch, cada tentativa recusada pelo
      navegador (Safari recusa fora de gesto) vira uma rejeição não-tratada, e
      durante a partida são ~10 por segundo enchendo o console. */
  function tryResume() {
    if (!ctx) return;
    var st = ctx.state;
    if (st === 'running' || st === 'closed') return;
    try {
      var p = ctx.resume && ctx.resume();
      // Navegadores antigos devolvem undefined em vez de Promise.
      if (p && typeof p.catch === 'function') p.catch(swallow);
    } catch (e) { /* ignorado de propósito */ }
  }

  function swallow() { /* rejeição de resume() é esperada fora de gesto */ }

  /** Arma (uma vez só) o statechange e os listeners de gesto persistentes. */
  function installResumeGuards() {
    if (resumeGuardsOn || !ctx) return;
    resumeGuardsOn = true;

    // Voltou do segundo plano: em Chrome/Android o resume automático funciona.
    // Se o navegador exigir gesto, os listeners abaixo cobrem no próximo toque.
    try {
      if (ctx.addEventListener) ctx.addEventListener('statechange', onCtxState);
      else ctx.onstatechange = onCtxState;
    } catch (e) { /* no-op */ }

    // NÃO remover depois do primeiro uso: a suspensão se repete na sessão.
    try {
      window.addEventListener('pointerdown', tryResume, GESTURE_OPTS);
      window.addEventListener('touchstart', tryResume, GESTURE_OPTS);
      window.addEventListener('mousedown', tryResume, GESTURE_OPTS);
      window.addEventListener('keydown', tryResume, GESTURE_OPTS);
    } catch (e) { /* no-op */ }

    // Voltar a aba/app para frente é o momento natural de tentar de novo, e
    // dispara raramente (nada a ver com o loop de frame).
    try {
      if (window.document && window.document.addEventListener) {
        window.document.addEventListener('visibilitychange', onVisible, false);
      }
    } catch (e) { /* no-op */ }
  }

  function onVisible() {
    if (!window.document.hidden) tryResume();
  }

  function onCtxState() {
    if (ctx && ctx.state !== 'running') tryResume();
  }

  /** Alguns navegadores antigos expõem number em vez de AudioParam. */
  function setParam(p, v) {
    if (p && typeof p === 'object' && 'value' in p) p.value = v;
  }

  /** true se dá para agendar som AGORA (contexto vivo e rodando).
      Se estiver suspenso, tenta acordar e desiste deste som: agendar em
      contexto suspenso empilha tudo para disparar junto no resume. */
  function live() {
    if (!ensure()) return false;
    if (ctx.state === 'running') return true;
    tryResume();
    return false;
  }

  /** 2 segundos de ruído branco. Um buffer só, reusado por hats, kill, death,
      sector e shield — alocar Float32Array a cada chiado seria absurdo. */
  function buildNoise() {
    var sr = ctx.sampleRate;
    var len = Math.floor(sr * 2);
    noiseBuf = ctx.createBuffer(1, len, sr);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  /** Curva de saturação clássica (waveshaper). Quanto maior `k`, mais áspero.
      É o que dá o timbre "metálico/bitcrushed" do escudo. */
  function makeDistCurve(k) {
    var n = 1024;
    var curve = new Float32Array(n);
    var deg = Math.PI / 180;
    for (var i = 0; i < n; i++) {
      var x = (i * 2) / n - 1;
      curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  /* --- helpers de nós ---------------------------------------------------- */

  /** Handler compartilhado de onended: usa `this` para não alocar um closure
      por nota (o scheduler cria dezenas de vozes por segundo). Desconectar
      libera o ramo inteiro para o GC. */
  function releaseSelf() {
    try { this.disconnect(); } catch (e) { /* ignorado de propósito */ }
  }

  function osc(type, freq, t) {
    var o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.onended = releaseSelf;
    return o;
  }

  /** Fonte de ruído. Reusa SEMPRE o mesmo buffer de 2s (gerar ruído por som
      alocaria um Float32Array de ~88k amostras a cada chiado). Em loop porque
      death() dura quase 1s e hats disparam de 100 em 100ms — o buffer nunca
      pode acabar no meio de uma nota. */
  function noise() {
    var s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.loop = true;
    s.onended = releaseSelf;
    return s;
  }

  function gain(v) {
    var g = ctx.createGain();
    g.gain.value = v;
    return g;
  }

  function filt(type, freq, q) {
    var f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (q !== undefined) f.Q.value = q;
    return f;
  }

  /** Pan opcional: StereoPannerNode não existe em navegadores antigos.
      Retorna null quando indisponível (o chamador liga direto no bus). */
  function pan(v) {
    try {
      if (!ctx.createStereoPanner) return null;
      var p = ctx.createStereoPanner();
      p.pan.value = v;
      return p;
    } catch (e) {
      return null;
    }
  }

  /** Envelope AD padrão do jogo. Attack e decay em SEGUNDOS.
      Sempre começa e termina em 0.0001 (ver princípio 4 no cabeçalho). */
  function env(g, t, peak, attack, decay) {
    var p = g.gain;
    p.cancelScheduledValues(t);
    p.setValueAtTime(0.0001, t);
    p.exponentialRampToValueAtTime(peak, t + attack);
    p.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    return t + attack + decay;
  }

  /** Liga uma cadeia de nós em sequência e devolve o último. */
  function chain(nodes) {
    for (var i = 0; i < nodes.length - 1; i++) {
      if (nodes[i] && nodes[i + 1]) nodes[i].connect(nodes[i + 1]);
    }
    return nodes[nodes.length - 1];
  }

  /* ======================================================================
     SFX (§5)
     Cada função: cria os nós, agenda tudo a partir de ctx.currentTime,
     e chama stop() no fim exato do envelope. Nada fica pendurado.
     ====================================================================== */

  var SFX = {};

  /** Comer: triangle com pitch subindo 1 semitom por nível de combo (cap 18),
      mais um "click" de square uma oitava acima que dá a percussividade. */
  SFX.eat = function (combo) {
    try {
      if (!live()) return;
      var t = ctx.currentTime;
      var n = Math.min(Math.max(combo | 0, 0), 18);
      var f = 440 * Math.pow(2, n / 12);

      var o = osc('triangle', f, t);
      var g = gain(0.0001);
      chain([o, g, sfxBus]);
      env(g, t, 0.5, 0.002, 0.09);          // A2ms D90ms
      o.start(t);
      o.stop(t + 0.12);

      var c = osc('square', f * 2, t);
      var cg = gain(0.0001);
      var cf = filt('highpass', 900);
      chain([c, cg, cf, sfxBus]);
      env(cg, t, 0.16, 0.001, 0.03);        // click de 30ms
      c.start(t);
      c.stop(t + 0.05);
    } catch (e) { /* áudio nunca derruba o jogo */ }
  };

  /** Dourada: dois triangles em quinta com vibrato leve — soa "premiado". */
  SFX.gold = function () {
    try {
      if (!live()) return;
      var t = ctx.currentTime;
      var freqs = [784, 1175];

      // Um LFO só modulando os dois osciladores: mais barato e mantém as
      // duas vozes ondulando em fase (soa como um instrumento, não dois).
      var lfo = osc('sine', 6, t);
      var lfoAmp = gain(7);                  // ±7 Hz de desvio
      lfo.connect(lfoAmp);

      for (var i = 0; i < 2; i++) {
        var o = osc('triangle', freqs[i], t);
        var g = gain(0.0001);
        chain([o, g, sfxBus]);
        lfoAmp.connect(o.frequency);
        env(g, t, i === 0 ? 0.38 : 0.26, 0.006, 0.26);   // D260ms
        o.start(t);
        o.stop(t + 0.3);
      }
      lfo.start(t);
      lfo.stop(t + 0.3);
    } catch (e) { /* no-op */ }
  };

  /** Power-up: sweep de sawtooth 220->1400 com o lowpass abrindo junto.
      Filtro e pitch subindo ao mesmo tempo é o clichê de "carregando poder"
      — e clichê que funciona é vocabulário, não preguiça. */
  SFX.powerup = function () {
    try {
      if (!live()) return;
      var t = ctx.currentTime;
      var o = osc('sawtooth', 220, t);
      var lp = filt('lowpass', 400, 6);
      var g = gain(0.0001);
      chain([o, lp, g, sfxBus]);

      o.frequency.exponentialRampToValueAtTime(1400, t + 0.32);
      lp.frequency.setValueAtTime(400, t);
      lp.frequency.exponentialRampToValueAtTime(6000, t + 0.32);
      env(g, t, 0.34, 0.01, 0.42);           // D420ms
      o.start(t);
      o.stop(t + 0.45);
    } catch (e) { /* no-op */ }
  };

  /** Subir de nível: arpejo maior de 3 notas, 70ms cada. */
  SFX.levelUp = function () {
    try {
      if (!live()) return;
      var t = ctx.currentTime;
      var notes = [523, 659, 880];
      for (var i = 0; i < 3; i++) {
        var st = t + i * 0.07;
        var o = osc('square', notes[i], st);
        var g = gain(0.0001);
        var lp = filt('lowpass', 4200);
        chain([o, g, lp, sfxBus]);
        env(g, st, 0.22, 0.003, 0.075);
        o.start(st);
        o.stop(st + 0.1);
      }
    } catch (e) { /* no-op */ }
  };

  /** Troca de setor: sub grave de 55Hz (o "impacto no peito") + sweep de
      ruído com highpass subindo (o "ar" da transição). */
  SFX.sector = function () {
    try {
      if (!live()) return;
      var t = ctx.currentTime;

      var sub = osc('sine', 55, t);
      var sg = gain(0.0001);
      chain([sub, sg, sfxBus]);
      sub.frequency.setValueAtTime(80, t);
      sub.frequency.exponentialRampToValueAtTime(45, t + 0.6);
      env(sg, t, 0.75, 0.02, 0.6);           // 600ms
      sub.start(t);
      sub.stop(t + 0.65);

      var nz = noise();
      var hp = filt('highpass', 200, 1);
      var ng = gain(0.0001);
      chain([nz, hp, ng, sfxBus]);
      hp.frequency.setValueAtTime(200, t);
      hp.frequency.exponentialRampToValueAtTime(8000, t + 0.6);
      env(ng, t, 0.3, 0.08, 0.5);
      nz.start(t);
      nz.stop(t + 0.62);
    } catch (e) { /* no-op */ }
  };

  /** Escudo quebrando: square + ruído passando por waveshaper. A distorção
      gera harmônicos ímpares que o ouvido lê como "metal rachando". */
  SFX.shield = function () {
    try {
      if (!live()) return;
      var t = ctx.currentTime;

      var shaper = ctx.createWaveShaper();
      shaper.curve = distCurve;
      shaper.oversample = '2x';
      var out = gain(0.0001);
      chain([shaper, out, sfxBus]);
      env(out, t, 0.42, 0.004, 0.25);        // 250ms

      var o = osc('square', 900, t);
      var og = gain(0.5);
      chain([o, og, shaper]);
      o.frequency.setValueAtTime(900, t);
      o.frequency.exponentialRampToValueAtTime(300, t + 0.25);
      o.start(t);
      o.stop(t + 0.27);

      var nz = noise();
      var bp = filt('bandpass', 2600, 3);
      var ng = gain(0.6);
      chain([nz, bp, ng, shaper]);
      nz.start(t);
      nz.stop(t + 0.27);
    } catch (e) { /* no-op */ }
  };

  /** Caçador destruído: ruído branco com o lowpass despencando 3000->200. */
  SFX.kill = function () {
    try {
      if (!live()) return;
      var t = ctx.currentTime;
      var nz = noise();
      var lp = filt('lowpass', 3000, 2);
      var g = gain(0.0001);
      chain([nz, lp, g, sfxBus]);
      lp.frequency.setValueAtTime(3000, t);
      lp.frequency.exponentialRampToValueAtTime(200, t + 0.22);
      env(g, t, 0.55, 0.004, 0.22);
      nz.start(t);
      nz.stop(t + 0.25);
    } catch (e) { /* no-op */ }
  };

  /** Morte: 900ms de pitch despencando 300->40 com ruído por cima, tudo
      passando por um delay realimentado que faz as vezes de reverb curto.
      É o som mais longo do jogo e casa com o slow-motion de §4. */
  SFX.death = function () {
    try {
      if (!live()) return;
      var t = ctx.currentTime;

      var lp = filt('lowpass', 4000, 3);
      var out = gain(0.0001);
      chain([lp, out, sfxBus]);
      lp.frequency.setValueAtTime(4000, t);
      lp.frequency.exponentialRampToValueAtTime(150, t + 0.9);
      env(out, t, 0.6, 0.01, 0.9);

      // Reverb pobre: delay curto realimentado. Um ConvolverNode exigiria
      // gerar impulso, custa CPU e não acrescenta nada num som já sujo.
      var dly = ctx.createDelay(0.5);
      dly.delayTime.value = 0.11;
      var fb = gain(0.42);
      var wet = gain(0.35);
      out.connect(dly);
      dly.connect(fb);
      fb.connect(dly);
      dly.connect(wet);
      wet.connect(sfxBus);

      var o = osc('sawtooth', 300, t);
      var og = gain(0.7);
      chain([o, og, lp]);
      o.frequency.setValueAtTime(300, t);
      o.frequency.exponentialRampToValueAtTime(40, t + 0.9);
      o.start(t);
      o.stop(t + 0.95);

      var nz = noise();
      var ng = gain(0.35);
      chain([nz, ng, lp]);
      nz.start(t);
      nz.stop(t + 0.95);
    } catch (e) { /* no-op */ }
  };

  /** Portal: sine descendo 1200->300 em 180ms, panorâmica alternando a cada
      uso — entrar e sair do portal soam em lados opostos. */
  SFX.portal = function () {
    try {
      if (!live()) return;
      var t = ctx.currentTime;
      portalSide = -portalSide;

      var o = osc('sine', 1200, t);
      var g = gain(0.0001);
      var p = pan(0.7 * portalSide);
      chain([o, g, p || sfxBus]);
      if (p) p.connect(sfxBus);
      o.frequency.setValueAtTime(1200, t);
      o.frequency.exponentialRampToValueAtTime(300, t + 0.18);
      env(g, t, 0.32, 0.004, 0.18);
      o.start(t);
      o.stop(t + 0.2);
    } catch (e) { /* no-op */ }
  };

  /** Alerta de caçador: duas square staccato em 180Hz, repetidas 2×. */
  SFX.hunterAlert = function () {
    try {
      if (!live()) return;
      var t = ctx.currentTime;
      for (var i = 0; i < 4; i++) {
        // 0,1 = primeiro par; 2,3 = repetição depois de uma pausa maior
        var st = t + (i < 2 ? i * 0.09 : 0.30 + (i - 2) * 0.09);
        var o = osc('square', 180, st);
        var g = gain(0.0001);
        var lp = filt('lowpass', 1400);
        chain([o, g, lp, sfxBus]);
        env(g, st, 0.3, 0.003, 0.06);
        o.start(st);
        o.stop(st + 0.08);
      }
    } catch (e) { /* no-op */ }
  };

  /** Blip de navegação do menu. */
  SFX.uiMove = function () {
    try {
      if (!live()) return;
      var t = ctx.currentTime;
      var o = osc('square', 660, t);
      var g = gain(0.0001);
      var lp = filt('lowpass', 3000);
      chain([o, g, lp, sfxBus]);
      env(g, t, 0.16, 0.002, 0.05);
      o.start(t);
      o.stop(t + 0.07);
    } catch (e) { /* no-op */ }
  };

  /** Confirmação: duas notas simultâneas (880 + 1320 = quinta justa). */
  SFX.uiConfirm = function () {
    try {
      if (!live()) return;
      var t = ctx.currentTime;
      var freqs = [880, 1320];
      for (var i = 0; i < 2; i++) {
        var o = osc('square', freqs[i], t);
        var g = gain(0.0001);
        var lp = filt('lowpass', 4000);
        chain([o, g, lp, sfxBus]);
        env(g, t, i === 0 ? 0.2 : 0.13, 0.002, 0.09);
        o.start(t);
        o.stop(t + 0.12);
      }
    } catch (e) { /* no-op */ }
  };

  /* ======================================================================
     MÚSICA ADAPTATIVA (§5)

     Scheduler de lookahead: a cada frame olhamos 100ms à frente e agendamos
     todas as semicolcheias que caem nessa janela. O rAF pode atrasar 30ms
     sem que uma nota saia do lugar, porque o agendamento é no relógio de
     áudio, não no relógio de vídeo.
     ====================================================================== */

  var mus = {
    playing: false,
    built: false,
    nextNoteTime: 0,      // tempo (no relógio do ctx) da próxima semicolcheia
    step: 0,              // 0..15 dentro do compasso
    bpm: 112,
    level: 0,
    intensity: 0,
    layers: null,         // [bass, hats, arp, lead] -> GainNode
    lastBassFreq: 0
  };

  // Volume "ligado" de cada camada. Bass domina, hats ficam discretos.
  var LAYER_VOL = [0.9, 0.30, 0.45, 0.75];

  /* Padrões escritos como ÍNDICES DE ESCALA, não como frequências: mudar a
     escala (ou transpor) vira uma linha só. -1 = silêncio.
     freqAt() resolve o índice: >=5 sobe uma oitava por grupo de 5. */
  var P_BASS = [0, -1, 0, -1, 0, -1, 3, -1, 0, -1, 0, -1, 2, -1, 4, -1];
  var P_ARP  = [0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0, 2, 4, 5, 4, 2];
  var P_LEAD = [5, -1, -1, 4, -1, 7, -1, -1, 9, -1, 5, -1, -1, 4, -1, -1];
  var P_KICK = [0, 8];                       // tempos 1 e 3 (semicolcheias 0 e 8)

  /** Índice de escala -> Hz. A pentatônica de Lá menor tem 5 graus; a cada 5
      índices sobe uma oitava. Assim o arpejo "sobe" sem tabela extra. */
  function freqAt(i) {
    var A = cfgAudio();
    var sc = A.SCALE || DEF.SCALE;
    var oct = Math.floor(i / sc.length);
    var deg = i - oct * sc.length;
    return sc[deg] * Math.pow(2, oct);
  }

  function sixteenth() {
    return 60 / mus.bpm / 4;
  }

  /** Cria as 4 camadas e o delay pingue-pongue do lead. Uma vez só. */
  function buildMusic() {
    if (mus.built) return;

    mus.layers = [];
    for (var i = 0; i < 4; i++) {
      var g = gain(0.0001);
      g.connect(musicBus);
      mus.layers.push(g);
    }

    // Delay pingue-pongue do lead: L -> R -> L com realimentação. Dá largura
    // estéreo sem precisar de reverb (que custaria muito mais CPU).
    mus.leadIn = gain(1);
    mus.leadIn.connect(mus.layers[3]);

    var dl = ctx.createDelay(1.5);
    var dr = ctx.createDelay(1.5);
    var fb = gain(0.34);
    var pl = pan(-0.85);
    var pr = pan(0.85);

    mus.leadIn.connect(dl);
    dl.connect(dr);
    dr.connect(fb);
    fb.connect(dl);
    dl.connect(pl || mus.layers[3]);
    dr.connect(pr || mus.layers[3]);
    if (pl) pl.connect(mus.layers[3]);
    if (pr) pr.connect(mus.layers[3]);

    mus.delayL = dl;
    mus.delayR = dr;
    updateDelayTime();

    mus.built = true;
  }

  /** O delay acompanha o andamento: 3 semicolcheias (tresillo curto) de um
      lado, 3 do outro. Se ficasse fixo em segundos, desafinaria do ritmo
      assim que o BPM subisse com o nível. */
  function updateDelayTime() {
    if (!mus.delayL) return;
    var d = sixteenth() * 3;
    var t = ctx.currentTime;
    try {
      mus.delayL.delayTime.setTargetAtTime(d, t, 0.05);
      mus.delayR.delayTime.setTargetAtTime(d, t, 0.05);
    } catch (e) { /* no-op */ }
  }

  /** Crossfade das camadas para a intensidade atual. Linear (e não
      exponencial) porque aqui é mixagem, não envelope: 400ms de rampa longa
      não produz clique e chegar exatamente a 0 é desejável. */
  function applyIntensity(ms) {
    if (!mus.layers) return;
    var A = cfgAudio();
    var fade = (ms === undefined ? (A.CROSSFADE_MS || DEF.CROSSFADE_MS) : ms) / 1000;
    var t = ctx.currentTime;
    for (var i = 0; i < mus.layers.length; i++) {
      var target = (mus.playing && i <= mus.intensity) ? LAYER_VOL[i] : 0;
      var p = mus.layers[i].gain;
      try {
        p.cancelScheduledValues(t);
        p.setValueAtTime(p.value, t);
        p.linearRampToValueAtTime(target, t + fade);
      } catch (e) { /* no-op */ }
    }
  }

  /* --- vozes da música --------------------------------------------------- */

  /** Baixo: sawtooth grave com lowpass fechado e SLIDE entre as notas
      (portamento de 40ms) — é o slide que faz soar synthwave e não chiptune. */
  function voiceBass(t, dur, f) {
    var o = osc('sawtooth', f, t);
    // Q 5: ressonância suficiente para o lowpass "cantar" no corte de 400Hz
    // (o timbre synthwave), sem virar apito quando o baixo sobe para G3.
    var lp = filt('lowpass', 400, 5);
    var g = gain(0.0001);
    chain([o, lp, g, mus.layers[0]]);

    if (mus.lastBassFreq > 0) {
      o.frequency.setValueAtTime(mus.lastBassFreq, t);
      o.frequency.exponentialRampToValueAtTime(f, t + 0.04);
    }
    mus.lastBassFreq = f;

    env(g, t, 0.5, 0.008, dur * 0.9);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** Hat: 8ms de ruído por highpass 7kHz. Acento nos tempos (semicolcheias
      múltiplas de 4) para o ouvido achar o pulso. */
  function voiceHat(t, accent) {
    var nz = noise();
    var hp = filt('highpass', 7000, 1);
    var g = gain(0.0001);
    chain([nz, hp, g, mus.layers[1]]);
    env(g, t, accent ? 0.5 : 0.22, 0.001, 0.008);
    nz.start(t);
    nz.stop(t + 0.03);
  }

  /** Arpejo plucky: square com A2ms/D110ms. */
  function voiceArp(t, f) {
    var o = osc('square', f, t);
    var lp = filt('lowpass', 3200, 4);
    var g = gain(0.0001);
    chain([o, lp, g, mus.layers[2]]);
    env(g, t, 0.3, 0.002, 0.11);
    o.start(t);
    o.stop(t + 0.14);
  }

  /** Kick: sine 150->45Hz em 90ms. Todo o "soco" está na queda de pitch. */
  function voiceKick(t) {
    var o = osc('sine', 150, t);
    var g = gain(0.0001);
    chain([o, g, mus.layers[3]]);
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.09);
    env(g, t, 0.9, 0.002, 0.1);
    o.start(t);
    o.stop(t + 0.13);
  }

  /** Lead: triangle curto entrando no delay pingue-pongue. */
  function voiceLead(t, f) {
    var o = osc('triangle', f, t);
    var g = gain(0.0001);
    chain([o, g, mus.leadIn]);
    env(g, t, 0.24, 0.004, 0.16);
    o.start(t);
    o.stop(t + 0.2);
  }

  /** Agenda TODAS as vozes da semicolcheia `step` no instante `t`. */
  function scheduleStep(step, t) {
    var sixt = sixteenth();

    // 0. baixo — colcheias (só nos passos pares do padrão)
    if (mus.intensity >= 0) {
      var b = P_BASS[step];
      if (b >= 0) voiceBass(t, sixt * 2, freqAt(b));
    }
    // 1. hats — todas as semicolcheias, acento no tempo
    if (mus.intensity >= 1) {
      voiceHat(t, step % 4 === 0);
    }
    // 2. arpejo — sobe e desce a pentatônica, 2 oitavas acima do baixo
    if (mus.intensity >= 2) {
      var a = P_ARP[step];
      if (a >= 0) voiceArp(t, freqAt(a + 5));
    }
    // 3. kick + lead
    if (mus.intensity >= 3) {
      if (step === P_KICK[0] || step === P_KICK[1]) voiceKick(t);
      var l = P_LEAD[step];
      if (l >= 0) voiceLead(t, freqAt(l + 10));
    }
  }

  /** Roda o lookahead. Chamado por Audio.update() a cada frame. */
  function tickScheduler() {
    if (!mus.playing || !mus.built) return;
    if (ctx.state !== 'running') return;

    var A = cfgAudio();
    var look = (A.LOOKAHEAD_MS || DEF.LOOKAHEAD_MS) / 1000;
    var now = ctx.currentTime;

    // Aba em segundo plano: o relógio de áudio andou muito além do último
    // agendamento. Sem este ressincronismo o while abaixo dispararia
    // centenas de notas de uma vez ao voltar o foco.
    if (mus.nextNoteTime < now - 0.25) mus.nextNoteTime = now + 0.02;

    var guard = 0;
    while (mus.nextNoteTime < now + look && guard++ < 64) {
      scheduleStep(mus.step, mus.nextNoteTime);
      mus.nextNoteTime += sixteenth();
      mus.step = (mus.step + 1) % 16;
    }
  }

  var Music = {
    start: function () {
      try {
        if (!ensure()) return;
        buildMusic();
        if (mus.playing) return;             // idempotente
        mus.playing = true;
        mus.step = 0;
        mus.lastBassFreq = 0;
        // Pequena folga: agendar exatamente em currentTime chega atrasado.
        mus.nextNoteTime = ctx.currentTime + 0.06;
        updateDelayTime();
        applyIntensity(120);                 // fade-in mais rápido que o crossfade
      } catch (e) { /* no-op */ }
    },

    stop: function () {
      try {
        mus.playing = false;

        // Parar é voltar ao estado inicial da trilha, não só calar as camadas.
        // Sem este reset a intensidade da partida anterior sobrevivia: o menu
        // voltava com bumbo e lead (Music.start religa TUDO que estiver em
        // mus.intensity) e a partida seguinte ENCOLHIA a trilha ao mandar
        // intensityFor(0) — o inverso da progressão prometida em §5.
        // mus.level também tem que zerar: setLevel tem guarda
        // `if (n === mus.level) return;`, então sem isto o setLevel(0) do
        // início da próxima partida sairia fora e o BPM base nunca seria
        // reaplicado, deixando a partida nova no andamento da anterior.
        mus.intensity = 0;
        mus.level = 0;
        var A = cfgAudio();
        mus.bpm = A.BPM_BASE !== undefined ? A.BPM_BASE : DEF.BPM_BASE;

        if (!ctx || !mus.built) return;
        // Com mus.playing já false os alvos aqui são todos 0 de qualquer
        // jeito, então zerar a intensidade acima não altera este fade-out.
        applyIntensity(180);                 // baixa as camadas sem cortar seco
      } catch (e) { mus.playing = false; }
    },

    /** 0..3 — crossfade de 400ms (§5). */
    setIntensity: function (n) {
      try {
        n = n | 0;
        if (n < 0) n = 0;
        if (n > 3) n = 3;
        if (n === mus.intensity) return;
        mus.intensity = n;
        if (!ctx || !mus.built) return;
        applyIntensity();
      } catch (e) { /* no-op */ }
    },

    /** BPM = min(164, 112 + nivel*2). */
    setLevel: function (n) {
      try {
        n = n | 0;
        if (n < 0) n = 0;
        if (n === mus.level) return;
        mus.level = n;
        var A = cfgAudio();
        var base = A.BPM_BASE !== undefined ? A.BPM_BASE : DEF.BPM_BASE;
        var per = A.BPM_PER_LEVEL !== undefined ? A.BPM_PER_LEVEL : DEF.BPM_PER_LEVEL;
        var max = A.BPM_MAX !== undefined ? A.BPM_MAX : DEF.BPM_MAX;
        mus.bpm = Math.min(max, base + n * per);
        if (ctx && mus.built) updateDelayTime();
      } catch (e) { /* no-op */ }
    },

    /** Helpers extras (não fazem parte do contrato, mas são úteis ao debug). */
    isPlaying: function () { return !!mus.playing; },
    getBpm: function () { return mus.bpm; },
    getIntensity: function () { return mus.intensity; }
  };

  /* ======================================================================
     API PÚBLICA (§9.3)
     ====================================================================== */

  var Audio = {};

  /** Cria o AudioContext. Idempotente e seguro antes de qualquer gesto. */
  Audio.init = function () {
    try { ensure(); } catch (e) { /* no-op */ }
  };

  /** Chamar em TODO input do usuário (não só no primeiro): navegadores só
      deixam o contexto sair de 'suspended' dentro de um gesto, e a suspensão
      pode voltar a acontecer a qualquer momento no celular. Quando já está
      rodando a chamada custa uma comparação de string. */
  Audio.unlock = function () {
    try {
      if (!ensure()) return;
      tryResume();
    } catch (e) { /* no-op */ }
  };

  /** Mudo é um corte no gain do master: o scheduler continua rodando, então
      voltar do mudo cai no compasso certo em vez de recomeçar a música. */
  Audio.setMuted = function (v) {
    try {
      muted = !!v;
      if (!ctx || !master) return;           // será aplicado quando o ctx nascer
      var t = ctx.currentTime;
      var p = master.gain;
      p.cancelScheduledValues(t);
      p.setValueAtTime(p.value, t);
      p.linearRampToValueAtTime(muted ? 0.0001 : 1, t + 0.08);
    } catch (e) { /* no-op */ }
  };

  Audio.isMuted = function () {
    return muted;
  };

  Audio.toggleMute = function () {
    Audio.setMuted(!muted);
    return muted;
  };

  /** Chamado todo frame por main.js. Só roda o scheduler da música. */
  Audio.update = function () {
    try {
      if (supported === false || !ctx) return;
      tickScheduler();
    } catch (e) {
      // Se o scheduler quebrar, cala a música e segue o jogo.
      mus.playing = false;
      if (debugOn() && window.console) window.console.warn('[Audio] scheduler:', e);
    }
  };

  Audio.sfx = SFX;
  Audio.music = Music;

  /** Extras fora do contrato — só diagnóstico, ninguém precisa chamar. */
  Audio.isSupported = function () {
    ensure();
    return supported === true;
  };
  Audio.state = function () {
    return ctx ? ctx.state : 'none';
  };

  COBRA.Audio = Audio;
})();
