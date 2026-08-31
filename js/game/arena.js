/* ==========================================================================
   COBRONA :: PROTOCOLO NEON
   js/game/arena.js  ->  COBRA.Arena

   Responsável por §3.4 (muros dos setores) e §3.6 (portais).

   Três invariantes que este arquivo trata como lei, porque violá-las produz
   morte injusta (o pior bug possível num jogo de reflexo):

     1. Nenhuma célula de `protectedCells` (a cobra + margem à frente da
        cabeça) vira muro ou portal. NUNCA. Se o padrão escolhido passa por
        cima dela, aquele bloco é simplesmente descartado.
     2. Toda célula livre é alcançável a partir de qualquer outra. Depois de
        montar os muros roda um flood-fill; se sobrar região ilhada, muros são
        derrubados ao longo do caminho mais curto até reconectar. Se nem assim,
        cai para arena limpa.
     3. Densidade jamais passa de CFG.SECTOR_DENSITY_CAP (12%) das células.

   Os padrões são simétricos por construção: tudo é desenhado num quadrante e
   espelhado nos outros três (`q()`). Simetria não é enfeite — é o que faz o
   jogador ler a arena inteira com um olhar só, em vez de decorar ruído.

   Nada de COBRA.CFG / COBRA.Util no escopo de topo: só dentro de funções.
   ========================================================================== */
(function () {
  'use strict';

  window.COBRA = window.COBRA || {};

  var TAU = Math.PI * 2;

  /* ======================================================================
     ESTADO INTERNO
     Todos os buffers são alocados UMA vez (no primeiro build) e reusados.
     build() roda em troca de setor — raro — mas o flood-fill percorre 600
     células várias vezes, e nada disso precisa gerar lixo para o GC.
     ====================================================================== */

  var W = 0, H = 0, N = 0;      // dimensões da grade em cache

  var occ = null;               // Uint8Array: 1 = muro
  var prot = null;              // Uint8Array: 1 = célula protegida (cobra)
  var reach = null;             // Uint8Array: marca do flood-fill principal
  var seen = null;              // Uint8Array: marca do BFS de escavação
  var parent = null;            // Int32Array: pais do BFS de escavação
  var queue = null;             // Int32Array: fila dos BFS (cabe a grade toda)
  var pdest = null;             // Int32Array: índice do portal destino, ou -1

  var wallCount = 0;            // muros vivos em occ (espelha wallList.length)

  var wallPool = [];            // objetos {x,y,phase,nb} reusados pelo wallList
  var portalPool = [];          // objetos de portal reusados

  // Retângulo onde é PERMITIDO colocar muro (margem interna, ver marginFor).
  var rx0 = 0, ry0 = 0, rx1 = 0, ry1 = 0;

  // Traços do padrão em construção. Cada traço é um array PLANO [x,y,x,y,...]
  // — números crus em vez de {x,y} para não alocar um objeto por célula.
  var strokes = [];
  var strokeN = 0;

  var patExtra = 0;             // alongamento dos padrões nos setores densos
  var patThick = false;         // barras de espessura 2 nos setores densos

  var nameBuf = ['', ''];       // buffer do par de padrões escolhido

  /* ======================================================================
     API PÚBLICA (§9.6)
     ====================================================================== */

  var Arena = {
    walls: new Set(),           // Set de "x,y" (Util.key) — contrato
    wallList: [],               // array de {x,y,phase,nb} para o renderer
    portals: [],                // array de {x,y,pair:{x,y},id,end,phase}
    sector: 0,
    margin: 2                   // distância mínima de muro até a borda externa
  };

  /* ======================================================================
     INFRAESTRUTURA
     ====================================================================== */

  /** Aloca (ou realoca) os buffers conforme a grade do CFG. */
  function ensureBuffers() {
    var CFG = COBRA.CFG;
    if (!CFG) return false;
    if (CFG.GRID_W === W && CFG.GRID_H === H && occ) return true;

    W = CFG.GRID_W;
    H = CFG.GRID_H;
    N = W * H;

    occ = new Uint8Array(N);
    prot = new Uint8Array(N);
    reach = new Uint8Array(N);
    seen = new Uint8Array(N);
    parent = new Int32Array(N);
    queue = new Int32Array(N);
    pdest = new Int32Array(N);
    return true;
  }

  function inBounds(x, y) {
    return x >= 0 && x < W && y >= 0 && y < H;
  }

  /** Margem livre entre os muros e a borda externa. Setores iniciais ganham
      2 células de "pista" no perímetro para dar espaço de manobra; do setor 4
      em diante a pista encolhe para 1 e a arena aperta de propósito. */
  function marginFor(sector) {
    return sector >= 4 ? 1 : 2;
  }

  /* ======================================================================
     CONSTRUÇÃO DOS TRAÇOS (padrões simétricos)
     ====================================================================== */

  function beginPattern() {
    strokeN = 0;
  }

  /** Abre um novo traço (reaproveitando o array do pool de traços). */
  function S() {
    var s = strokes[strokeN];
    if (!s) { s = []; strokes[strokeN] = s; }
    s.length = 0;
    strokeN++;
    return s;
  }

  /** Acrescenta uma célula ao traço, filtrando o que é proibido. */
  function put(s, x, y) {
    if (x < rx0 || x > rx1 || y < ry0 || y > ry1) return;   // fora da área útil
    var i = y * W + x;
    if (prot[i]) return;                                     // garantia dura §1
    for (var k = 0; k < s.length; k += 2) {
      if (s[k] === x && s[k + 1] === y) return;              // já está no traço
    }
    s.push(x, y);
  }

  /** Adiciona a célula e seus 3 espelhos (horizontal, vertical e ambos).
      Espelhar no ato é o que garante simetria mesmo quando o traço é cortado
      pelo orçamento de densidade — o corte nunca deixa a arena torta. */
  function q(s, x, y) {
    var mx = W - 1 - x;
    var my = H - 1 - y;
    put(s, x, y);
    put(s, mx, y);
    put(s, x, my);
    put(s, mx, my);
  }

  /** Grava o traço em occ se ele couber no orçamento. -> coube? */
  function commitStroke(s, maxCells) {
    var k, i, add = 0;
    for (k = 0; k < s.length; k += 2) {
      i = s[k + 1] * W + s[k];
      if (!occ[i]) add++;
    }
    if (add === 0) return true;                    // traço redundante
    if (wallCount + add > maxCells) return false;  // estouraria a densidade
    for (k = 0; k < s.length; k += 2) {
      i = s[k + 1] * W + s[k];
      if (!occ[i]) { occ[i] = 1; wallCount++; }
    }
    return true;
  }

  /* ======================================================================
     BIBLIOTECA DE PADRÕES
     Cada função desenha APENAS o quadrante superior-esquerdo; q() espelha.
     A ordem em que os traços são emitidos importa: o orçamento corta do fim
     para o começo, então o que define a silhueta do padrão vem primeiro.
     ====================================================================== */

  var PATTERNS = {

    /** Quatro blocos em L nos cantos. Emitido em ziguezague (um passo do braço
        horizontal, um do vertical) para que um corte precoce ainda entregue
        quatro Ls proporcionais, e não quatro traços soltos. */
    cantosL: function () {
      var ox = rx0 + 1, oy = ry0 + 1;
      var lx = 4 + patExtra, ly = 3 + patExtra;
      var n = lx > ly ? lx : ly;
      for (var i = 0; i < n; i++) {
        if (i < lx) q(S(), ox + i, oy);
        if (i > 0 && i < ly) q(S(), ox, oy + i);
      }
    },

    /** Cruz central com vãos: quatro barras que apontam para o centro mas
        param antes dele, deixando um miolo aberto e quatro entradas. */
    cruz: function () {
      var cx = (W >> 1) - 1, cy = (H >> 1) - 1;
      var yTop = cy - 2, xLeft = cx - 2;
      var passos = Math.max(yTop - ry0, xLeft - rx0);
      for (var i = 0; i < passos; i++) {
        var y = yTop - i;
        if (y > ry0) q(S(), cx, y);
        var x = xLeft - i;
        if (x > rx0) q(S(), x, cy);
      }
    },

    /** Duas barras verticais com corredor central. O vão no meio de cada barra
        evita que ela vire um beco sem saída para quem entra pelo lado errado. */
    barrasV: function () {
      var bx = rx0 + 4, cy = (H >> 1) - 1;
      for (var y = cy - 2; y > ry0; y--) {
        var s = S();
        q(s, bx, y);
        if (patThick) q(s, bx + 1, y);
      }
    },

    /** Duas faixas horizontais com corredor central — o "irmão deitado" de
        barrasV; alterná-los quebra a monotonia entre setores vizinhos. */
    faixasH: function () {
      var by = ry0 + 3, cx = (W >> 1) - 1;
      for (var x = cx - 3; x > rx0; x--) {
        var s = S();
        q(s, x, by);
        if (patThick) q(s, x, by + 1);
      }
    },

    /** Losango aberto. Uma diagonal traçada por DDA do lado esquerdo até o
        topo; as pontas são aparadas (trim) para abrir oito passagens — sem
        isso a escada diagonal seria uma parede fechada para movimento
        ortogonal e trancaria o miolo. */
    losango: function () {
      var cx = (W >> 1) - 1, cy = (H >> 1) - 1;
      var a = Math.min(9 + patExtra, cx - rx0 - 1);
      var b = Math.min(6 + patExtra, cy - ry0 - 1);
      if (a < 4 || b < 3) return;
      var trim = 2;
      for (var j = trim; j <= a - trim; j++) {
        q(S(), cx - a + j, cy - Math.round(b * (j / a)));
      }
    },

    /** Pilares 2x2. Cada bloco é UM traço inteiro: meio pilar nunca aparece,
        o orçamento ou aceita o bloco todo ou nenhum. */
    pilares: function () {
      var spots = [rx0 + 3, ry0 + 2, rx0 + 8, ry0 + 5, rx0 + 6, ry0 + 3];
      var max = patExtra > 0 ? 6 : 4;
      for (var k = 0; k < max; k += 2) {
        var x = spots[k], y = spots[k + 1];
        var s = S();
        q(s, x, y); q(s, x + 1, y); q(s, x, y + 1); q(s, x + 1, y + 1);
      }
    },

    /** Quatro diagonais apontando dos cantos para o centro. Deixa o perímetro
        totalmente livre, então é o padrão mais "seguro" dos densos. */
    chevrons: function () {
      var n = 5 + patExtra * 2;
      for (var i = 0; i < n; i++) {
        q(S(), rx0 + 1 + i, ry0 + i);
      }
    },

    /** Moldura interna quebrada: um retângulo a 2 células da área útil, com
        um vão no meio de cada lado. Emitida a partir dos cantos, alternando
        lado horizontal e vertical, para o corte manter a forma de moldura. */
    moldura: function () {
      var fx = rx0 + 2, fy = ry0 + 2;
      var cx = (W >> 1) - 1, cy = (H >> 1) - 1;
      var nx = cx - 3 - fx + 1;
      var ny = cy - 2 - fy;
      var n = nx > ny ? nx : ny;
      for (var i = 0; i < n; i++) {
        if (i < nx) q(S(), fx + i, fy);
        if (i < ny) q(S(), fx, fy + 1 + i);
      }
    }
  };

  // Rotação de padrões. O passo 3 sobre 8 (coprimos) faz o índice base
  // percorrer a lista inteira sem repetir antes da volta completa: setores
  // vizinhos nunca caem no mesmo padrão. O sorteio de 0..2 dá a cada setor
  // três caras possíveis — variação entre partidas sem perder a identidade
  // "cada setor tem a sua arena". O secundário (usado só quando o primário
  // não preenche a densidade) fica a 3..5 de distância para nunca colidir
  // com o primário nem virar um par sempre igual.
  var ORDER = ['cantosL', 'pilares', 'barrasV', 'losango',
               'cruz', 'faixasH', 'chevrons', 'moldura'];

  function chooseNames(sector) {
    var Util = COBRA.Util;
    var n = ORDER.length;
    var r = Util ? Util.randInt(0, 2) : 0;
    var i = ((sector * 3 + r) % n + n) % n;
    nameBuf[0] = ORDER[i];
    nameBuf[1] = ORDER[(i + 3 + (Util ? Util.randInt(0, 2) : 0)) % n];
    return nameBuf;
  }

  /* ======================================================================
     CONECTIVIDADE
     ====================================================================== */

  /** Flood-fill a partir da primeira célula livre.
      -> índice de uma célula livre INALCANÇÁVEL, ou -1 se tudo se conecta. */
  function floodMain() {
    var i, seed = -1;
    for (i = 0; i < N; i++) {
      reach[i] = 0;
      if (seed < 0 && !occ[i]) seed = i;
    }
    if (seed < 0) return -1;

    var head = 0, tail = 0, c, x, y, n;
    queue[tail++] = seed;
    reach[seed] = 1;
    while (head < tail) {
      c = queue[head++];
      x = c % W;
      y = (c / W) | 0;
      if (x > 0)     { n = c - 1; if (!occ[n] && !reach[n]) { reach[n] = 1; queue[tail++] = n; } }
      if (x < W - 1) { n = c + 1; if (!occ[n] && !reach[n]) { reach[n] = 1; queue[tail++] = n; } }
      if (y > 0)     { n = c - W; if (!occ[n] && !reach[n]) { reach[n] = 1; queue[tail++] = n; } }
      if (y < H - 1) { n = c + W; if (!occ[n] && !reach[n]) { reach[n] = 1; queue[tail++] = n; } }
    }

    for (i = 0; i < N; i++) if (!occ[i] && !reach[i]) return i;
    return -1;
  }

  /** BFS a partir da célula órfã ATRAVESSANDO muros até tocar a região
      principal; volta pelos pais derrubando os muros do caminho. Como o BFS
      minimiza o número de passos, ele fura a parede pelo ponto mais fino. */
  function carve(from) {
    var i;
    for (i = 0; i < N; i++) { seen[i] = 0; parent[i] = -1; }

    var head = 0, tail = 0, target = -1, c, x, y, n, k;
    queue[tail++] = from;
    seen[from] = 1;

    while (head < tail && target < 0) {
      c = queue[head++];
      x = c % W;
      y = (c / W) | 0;
      for (k = 0; k < 4; k++) {
        if (k === 0) { if (x <= 0) continue; n = c - 1; }
        else if (k === 1) { if (x >= W - 1) continue; n = c + 1; }
        else if (k === 2) { if (y <= 0) continue; n = c - W; }
        else { if (y >= H - 1) continue; n = c + W; }
        if (seen[n]) continue;
        seen[n] = 1;
        parent[n] = c;
        if (reach[n]) { target = n; break; }
        queue[tail++] = n;
      }
    }
    if (target < 0) return false;

    var cur = target;
    while (cur >= 0 && cur !== from) {
      if (occ[cur]) { occ[cur] = 0; wallCount--; }
      cur = parent[cur];
    }
    return true;
  }

  /** Garante arena 100% conexa. -> true se conseguiu sem apagar tudo. */
  function ensureConnected() {
    var guard = 0;
    while (guard++ < 64) {
      var orphan = floodMain();
      if (orphan < 0) return true;
      if (!carve(orphan)) break;
    }
    // Último recurso: melhor um setor visualmente pobre do que um setor que
    // mata o jogador numa sala fechada.
    occ.fill(0);
    wallCount = 0;
    return false;
  }

  /* ======================================================================
     ESCAPABILIDADE

     ALCANÇÁVEL != ESCAPÁVEL. O flood-fill acima só prova que dá para CHEGAR
     em toda célula livre; ele aceita de bom grado um corredor de 1 célula com
     a ponta fechada. E beco é morte certa: a cobra não dá ré (a fila de input
     filtra a inversão), os lados são muro, e o próximo tick bate no fundo.
     Pior: a comida nasce em qualquer célula "livre" — inclusive no fundo do
     beco — e comida normal é eterna, então entrar lá não é opcional.

     A regra que usamos é a mais simples que elimina a classe inteira: toda
     célula livre precisa ter PELO MENOS DOIS vizinhos livres. Numa arena
     conexa com grau mínimo 2 não existe fundo de corredor — todo corredor de
     1 célula liga dois cruzamentos, então quem entra sempre sai pelo outro
     lado. Derrubar muro nunca fere a densidade (só diminui) nem a
     conectividade (só funde regiões), então esta passada é segura por
     construção. Roda só em troca de setor — nunca em loop quente.
     ====================================================================== */

  function dropWall(x, y) {
    if (!inBounds(x, y)) return;
    var i = y * W + x;
    if (occ[i]) { occ[i] = 0; wallCount--; }
  }

  /** Derruba o muro e seus 3 espelhos. A simetria é o que faz o jogador ler a
      arena de relance; abrir um lado só deixaria o setor torto. */
  function dropWallMirrored(x, y) {
    var mx = W - 1 - x, my = H - 1 - y;
    dropWall(x, y);
    dropWall(mx, y);
    dropWall(x, my);
    dropWall(mx, my);
  }

  /** Abre um muro vizinho da célula-beco (x,y). -> abriu algum? */
  function openDeadEnd(x, y) {
    // Vizinho livre único, se houver: o muro OPOSTO a ele é o que fecha o
    // fundo do corredor. Abrir justamente ele faz o corredor seguir em frente
    // em vez de virar um cotovelo — é a abertura que respeita o desenho.
    var fx = -1, fy = -1;
    if (y > 0 && !occ[(y - 1) * W + x]) { fx = x; fy = y - 1; }
    else if (y < H - 1 && !occ[(y + 1) * W + x]) { fx = x; fy = y + 1; }
    else if (x > 0 && !occ[y * W + x - 1]) { fx = x - 1; fy = y; }
    else if (x < W - 1 && !occ[y * W + x + 1]) { fx = x + 1; fy = y; }

    if (fx >= 0) {
      var ox = x + (x - fx), oy = y + (y - fy);
      if (inBounds(ox, oy) && occ[oy * W + ox]) { dropWallMirrored(ox, oy); return true; }
    }
    // Sem oposto (ou o oposto é borda da grade): serve qualquer muro vizinho.
    if (y > 0 && occ[(y - 1) * W + x]) { dropWallMirrored(x, y - 1); return true; }
    if (y < H - 1 && occ[(y + 1) * W + x]) { dropWallMirrored(x, y + 1); return true; }
    if (x > 0 && occ[y * W + x - 1]) { dropWallMirrored(x - 1, y); return true; }
    if (x < W - 1 && occ[y * W + x + 1]) { dropWallMirrored(x + 1, y); return true; }
    return false;   // cercada só pela borda da grade: nada a fazer
  }

  /** Elimina TODO beco sem saída da arena. Repete até ponto fixo porque abrir
      um muro cria uma célula livre nova, que pode ser um beco novo. Cada
      passada derruba pelo menos um muro, então wallCount+2 passadas bastam
      (no pior caso a arena fica vazia, e arena vazia não tem beco). */
  function openDeadEnds() {
    var guard = wallCount + 2;
    while (guard-- > 0) {
      var mudou = false;
      for (var y = 0; y < H; y++) {
        for (var x = 0; x < W; x++) {
          if (occ[y * W + x]) continue;
          if (freeNeighbors(x, y) >= 2) continue;
          if (openDeadEnd(x, y)) mudou = true;
        }
      }
      if (!mudou) return;
    }
  }

  /* ----------------------------------------------------------------------
     Fuga da cobra (§3.4: "a cobra JAMAIS é morta pela reconstrução")

     prot[] impede muro EM CIMA da cobra e das 3 células à frente da cabeça,
     mas não impedia muro dos DOIS lados desse trecho com a ponta fechada: a
     invariante ficava "respeitada" e mesmo assim a cobra andava reto até a
     ponta e morria sem o jogador ter tocado em nada.

     A passada de becos acima já resolve o caso puro-muro. Falta o caso misto:
     o bolsão pode estar fechado por muro DE UM LADO e pelo próprio corpo do
     outro. Então aqui a busca em largura sai da ponta do trecho protegido
     tratando o corpo como bloqueio (corpo também mata) e exige um mínimo de
     espaço; enquanto não houver, derruba muros da fronteira do bolsão —
     começando pelo que está bem à frente da cabeça. Se o bolsão for fechado
     só por corpo/borda, paramos: aí a cobra se enrolou sozinha, não é obra da
     reconstrução, e demolir a arena inteira não consertaria nada.

     Detalhe que parece detalhe e não é: a busca NÃO parte da ponta, parte das
     três células para onde a cobra pode ir a partir dela (frente, esquerda,
     direita). Partir da ponta contaria como "espaço" o próprio corredor por
     onde ela veio — espaço que ela não pode usar, porque dar ré é justamente
     o que o filtro de input proíbe.
     ---------------------------------------------------------------------- */

  var ESCAPE_ROOM = 6;   // células livres que a cobra precisa alcançar da ponta

  /** BFS a partir das saídas da ponta (tx,ty), contando células livres, com o
      corpo bloqueado. Deixa o bolsão marcado em seen[]=1 para
      openPocketBorder(). A ponta entra como bloqueio para o caminho não voltar
      por cima dela; o corredor de trás só conta se houver volta por fora. */
  function escapeRoom(cells, tx, ty, dx, dy, need) {
    var i, bodyEnd = cells.length - 3;   // as 3 últimas são o trecho à frente
    for (i = 0; i < N; i++) seen[i] = 0;
    for (i = 0; i < bodyEnd; i++) {
      var c = cells[i];
      if (!c) continue;
      var bx = c.x | 0, by = c.y | 0;
      if (inBounds(bx, by)) seen[by * W + bx] = 2;   // 2 = corpo: bloqueia e não conta
    }
    seen[ty * W + tx] = 2;

    var head = 0, tail = 0, cnt = 0, cur, x, y, n, k;
    // Saídas legais da ponta: frente e os dois lados. Ré não é jogada.
    tail = pushSeed(tail, tx + dx, ty + dy);
    tail = pushSeed(tail, tx + dy, ty + dx);
    tail = pushSeed(tail, tx - dy, ty - dx);
    if (tail === 0) return 0;

    while (head < tail) {
      cur = queue[head++];
      cnt++;
      if (cnt >= need) return cnt;      // já tem espaço de sobra: para por aqui
      x = cur % W;
      y = (cur / W) | 0;
      for (k = 0; k < 4; k++) {
        if (k === 0) { if (x <= 0) continue; n = cur - 1; }
        else if (k === 1) { if (x >= W - 1) continue; n = cur + 1; }
        else if (k === 2) { if (y <= 0) continue; n = cur - W; }
        else { if (y >= H - 1) continue; n = cur + W; }
        if (occ[n] || seen[n]) continue;
        seen[n] = 1;
        queue[tail++] = n;
      }
    }
    return cnt;
  }

  function pushSeed(tail, x, y) {
    if (!inBounds(x, y)) return tail;
    var i = y * W + x;
    if (occ[i] || seen[i]) return tail;
    seen[i] = 1;
    queue[tail++] = i;
    return tail;
  }

  /** Derruba um muro que faz fronteira com o bolsão marcado em seen[]=1.
      Sem espelho: é correção pontual e rara, e espelhar aqui apagaria muro do
      outro lado da arena sem motivo. -> derrubou algum? */
  function openPocketBorder() {
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        if (seen[y * W + x] !== 1) continue;
        if (y > 0 && occ[(y - 1) * W + x]) { dropWall(x, y - 1); return true; }
        if (y < H - 1 && occ[(y + 1) * W + x]) { dropWall(x, y + 1); return true; }
        if (x > 0 && occ[y * W + x - 1]) { dropWall(x - 1, y); return true; }
        if (x < W - 1 && occ[y * W + x + 1]) { dropWall(x + 1, y); return true; }
      }
    }
    return false;
  }

  function ensureEscape(cells) {
    if (!cells || cells.length < 2) return;
    var n = cells.length;
    var tip = cells[n - 1], prev = cells[n - 2];
    if (!tip || !prev) return;
    var tx = tip.x | 0, ty = tip.y | 0;
    if (!inBounds(tx, ty)) return;

    // Direção da cabeça deduzida das duas últimas protegidas (são consecutivas
    // por construção) — assim não é preciso mudar a assinatura de build().
    // Normalizada porque com FANTASMA o trecho à frente dá a volta na borda.
    var dx = tx - (prev.x | 0), dy = ty - (prev.y | 0);
    if (dx > 1) dx = -1; else if (dx < -1) dx = 1;
    if (dy > 1) dy = -1; else if (dy < -1) dy = 1;

    var guard = wallCount + 2;   // cada volta derruba um muro
    while (guard-- > 0) {
      if (escapeRoom(cells, tx, ty, dx, dy, ESCAPE_ROOM) >= ESCAPE_ROOM) return;
      // Aperto: abre primeiro o muro bem à frente (o que fecha o corredor),
      // depois os dos lados da ponta, depois qualquer um na fronteira do
      // bolsão. Só muro é derrubado — se o cerco for de corpo/borda, paramos.
      if (dropIfWall(tx + dx, ty + dy)) continue;
      if (dropIfWall(tx + dy, ty + dx)) continue;
      if (dropIfWall(tx - dy, ty - dx)) continue;
      if (!openPocketBorder()) return;
    }
  }

  function dropIfWall(x, y) {
    if (!inBounds(x, y)) return false;
    if (!occ[y * W + x]) return false;
    dropWall(x, y);
    return true;
  }

  /* ======================================================================
     MUROS
     ====================================================================== */

  function buildWalls(sector, densidade) {
    var CFG = COBRA.CFG;
    var cap = Math.floor(N * CFG.SECTOR_DENSITY_CAP);
    var alvo = Math.round(N * (densidade || 0));
    if (alvo > cap) alvo = cap;
    if (alvo <= 0) return;

    patExtra = sector >= 6 ? 2 : (sector >= 3 ? 1 : 0);
    patThick = sector >= 5;

    var names = chooseNames(sector);
    for (var p = 0; p < names.length; p++) {
      if (wallCount >= alvo) break;
      var fn = PATTERNS[names[p]];
      if (!fn) continue;
      beginPattern();
      fn();
      for (var i = 0; i < strokeN; i++) {
        // Traço que não cabe é pulado (não interrompe): traços menores mais
        // adiante ainda podem preencher o orçamento restante.
        commitStroke(strokes[i], alvo);
      }
    }
  }

  /** Preenche wallList (objetos do pool) e o Set `walls` a partir de occ.
      `nb` é a máscara de vizinhos (1=cima,2=direita,4=baixo,8=esquerda) para
      o renderer emendar blocos vizinhos sem recalcular nada por frame;
      `phase` é a semente de animação (0..TAU) do brilho pulsante. */
  function publishWalls() {
    var Util = COBRA.Util;
    var list = Arena.wallList;
    list.length = 0;
    Arena.walls.clear();

    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var i = y * W + x;
        if (!occ[i]) continue;

        var k = list.length;
        var o = wallPool[k];
        if (!o) { o = { x: 0, y: 0, phase: 0, nb: 0 }; wallPool[k] = o; }
        o.x = x;
        o.y = y;
        o.phase = Math.random() * TAU;
        o.nb = neighborMask(x, y);
        list.push(o);
        Arena.walls.add(Util.key(x, y));
      }
    }
    wallCount = list.length;
  }

  function neighborMask(x, y) {
    var m = 0;
    if (y > 0 && occ[(y - 1) * W + x]) m |= 1;
    if (x < W - 1 && occ[y * W + x + 1]) m |= 2;
    if (y < H - 1 && occ[(y + 1) * W + x]) m |= 4;
    if (x > 0 && occ[y * W + x - 1]) m |= 8;
    return m;
  }

  /* ======================================================================
     PORTAIS (§3.6)
     ====================================================================== */

  var PORTAL_MIN_PAIR = 8;   // distância mínima (Manhattan) entre as pontas
  var PORTAL_MIN_SEP = 4;    // distância mínima entre portais de pares diferentes
  var cands = [];            // buffer de candidatos (índices), reusado

  function freeNeighbors(x, y) {
    var n = 0;
    if (y > 0 && !occ[(y - 1) * W + x]) n++;
    if (y < H - 1 && !occ[(y + 1) * W + x]) n++;
    if (x > 0 && !occ[y * W + x - 1]) n++;
    if (x < W - 1 && !occ[y * W + x + 1]) n++;
    return n;
  }

  /** Célula protegida ou vizinha de protegida? Sair de um portal em cima da
      cobra seria morte instantânea sem culpa do jogador. */
  function nearProtected(x, y) {
    if (prot[y * W + x]) return true;
    if (y > 0 && prot[(y - 1) * W + x]) return true;
    if (y < H - 1 && prot[(y + 1) * W + x]) return true;
    if (x > 0 && prot[y * W + x - 1]) return true;
    if (x < W - 1 && prot[y * W + x + 1]) return true;
    return false;
  }

  function collectCandidates(minFree, margin) {
    cands.length = 0;
    for (var y = margin; y < H - margin; y++) {
      for (var x = margin; x < W - margin; x++) {
        var i = y * W + x;
        if (occ[i]) continue;
        if (nearProtected(x, y)) continue;
        if (freeNeighbors(x, y) < minFree) continue;
        cands.push(i);
      }
    }
    if (COBRA.Util) COBRA.Util.shuffle(cands);
    return cands.length;
  }

  function farFromPlaced(idx) {
    var x = idx % W, y = (idx / W) | 0;
    var ps = Arena.portals;
    for (var i = 0; i < ps.length; i++) {
      if (Math.abs(ps[i].x - x) + Math.abs(ps[i].y - y) < PORTAL_MIN_SEP) return false;
    }
    return true;
  }

  function makePortal(slot, idx, id, end) {
    var o = portalPool[slot];
    if (!o) { o = { x: 0, y: 0, pair: { x: 0, y: 0 }, id: 0, end: 0, phase: 0 }; portalPool[slot] = o; }
    o.x = idx % W;
    o.y = (idx / W) | 0;
    o.id = id;
    o.end = end;
    o.phase = Math.random() * TAU;
    return o;
  }

  function buildPortals() {
    var CFG = COBRA.CFG;
    var pares = CFG.PORTAL.PAIRS;
    var margem = CFG.PORTAL.MARGIN;

    // Exigimos 3 vizinhos livres (entrada, saída e uma rota de fuga). Se a
    // arena estiver apertada demais, relaxamos para 2 — nunca menos, senão o
    // portal cospe a cobra num beco.
    if (collectCandidates(3, margem) < pares * 2) collectCandidates(2, margem);

    var slot = 0;
    for (var par = 0; par < pares; par++) {
      var achou = false;
      for (var ai = 0; ai < cands.length && !achou; ai++) {
        var A = cands[ai];
        if (!farFromPlaced(A)) continue;
        var ax = A % W, ay = (A / W) | 0;
        for (var bi = ai + 1; bi < cands.length; bi++) {
          var B = cands[bi];
          var bx = B % W, by = (B / W) | 0;
          if (Math.abs(ax - bx) + Math.abs(ay - by) < PORTAL_MIN_PAIR) continue;
          if (!farFromPlaced(B)) continue;

          var pa = makePortal(slot++, A, par, 0);
          var pb = makePortal(slot++, B, par, 1);
          pa.pair.x = pb.x; pa.pair.y = pb.y;
          pb.pair.x = pa.x; pb.pair.y = pa.y;
          Arena.portals.push(pa, pb);
          pdest[A] = Arena.portals.length - 1;   // A -> pb
          pdest[B] = Arena.portals.length - 2;   // B -> pa
          achou = true;
          break;
        }
      }
      if (!achou) break;   // sem espaço decente: fica com menos pares
    }
  }

  /* ======================================================================
     API
     ====================================================================== */

  /** Zera a arena (sem muros, sem portais). Também é o estado do modo ZEN. */
  Arena.reset = function () {
    if (!ensureBuffers()) return;
    occ.fill(0);
    prot.fill(0);
    pdest.fill(-1);
    wallCount = 0;
    Arena.walls.clear();
    Arena.wallList.length = 0;
    Arena.portals.length = 0;
    Arena.sector = 0;
    Arena.margin = 2;
  };

  /**
   * Monta muros e portais do setor.
   * @param {number} sectorIndex
   * @param {Array<{x:number,y:number}>} protectedCells células intocáveis
   * @param {Object} [opts] override opcional {muros, portais, densidade}
   */
  Arena.build = function (sectorIndex, protectedCells, opts) {
    var CFG = COBRA.CFG;
    if (!CFG || !ensureBuffers()) return;

    Arena.reset();

    var sector = sectorIndex | 0;
    if (sector < 0) sector = 0;
    Arena.sector = sector;

    var info = CFG.sectorInfo(sector);
    var muros = (opts && opts.muros !== undefined) ? opts.muros : info.muros;
    var portais = (opts && opts.portais !== undefined) ? opts.portais : info.portais;
    var dens = (opts && opts.densidade !== undefined) ? opts.densidade : info.densidade;

    // Marca as células protegidas ANTES de qualquer geração: put() e os
    // candidatos a portal consultam prot[] o tempo todo.
    if (protectedCells) {
      for (var i = 0; i < protectedCells.length; i++) {
        var c = protectedCells[i];
        if (!c) continue;
        var x = c.x | 0, y = c.y | 0;
        if (inBounds(x, y)) prot[y * W + x] = 1;
      }
    }

    var m = marginFor(sector);
    Arena.margin = m;
    rx0 = m; ry0 = m; rx1 = W - 1 - m; ry1 = H - 1 - m;

    if (muros) {
      buildWalls(sector, dens);
      ensureConnected();
      // Conectado não basta: sem estas duas passadas a arena publica becos de
      // 1 célula (onde a comida nasce e mata sem escapatória) e pode emparedar
      // a cobra no trecho protegido. Só depois delas os muros vão para o ar.
      openDeadEnds();
      ensureEscape(protectedCells);
    }
    publishWalls();

    if (portais) buildPortals();

    if (CFG.DEBUG) {
      // eslint-disable-next-line no-console
      console.log('[Arena] setor', sector, 'muros', wallCount,
                  '(' + (wallCount / N * 100).toFixed(1) + '%)',
                  'portais', Arena.portals.length);
    }
  };

  /** Muro interno? NÃO inclui as bordas externas — quem checa borda é o Game. */
  Arena.isWall = function (x, y) {
    if (!occ || !inBounds(x, y)) return false;
    return occ[y * W + x] === 1;
  };

  Arena.isPortal = function (x, y) {
    if (!pdest || !inBounds(x, y)) return false;
    return pdest[y * W + x] >= 0;
  };

  /** Destino do portal em (x,y) — o objeto da ponta oposta — ou null. */
  Arena.portalAt = function (x, y) {
    if (!pdest || !inBounds(x, y)) return null;
    var d = pdest[y * W + x];
    return d < 0 ? null : Arena.portals[d];
  };

  /** Muro OU portal: usado pelo spawn de comida (§3.2). */
  Arena.isBlocked = function (x, y) {
    return Arena.isWall(x, y) || Arena.isPortal(x, y);
  };

  /** Destrói um muro (FÚRIA, §3.3). -> true se havia muro ali.
      Mantém occ, wallList, o Set e as máscaras de vizinho coerentes. */
  Arena.breakWall = function (x, y) {
    if (!occ || !inBounds(x, y)) return false;
    var i = y * W + x;
    if (!occ[i]) return false;

    occ[i] = 0;
    wallCount--;
    Arena.walls['delete'](COBRA.Util.key(x, y));

    var list = Arena.wallList;
    for (var k = 0; k < list.length; k++) {
      if (list[k].x === x && list[k].y === y) { list.splice(k, 1); break; }
    }
    // Só os 4 vizinhos precisam recalcular a máscara.
    for (k = 0; k < list.length; k++) {
      var o = list[k];
      if (Math.abs(o.x - x) + Math.abs(o.y - y) === 1) o.nb = neighborMask(o.x, o.y);
    }
    return true;
  };

  /** Nº de muros vivos (debug/HUD). */
  Arena.wallCount = function () {
    return wallCount;
  };

  COBRA.Arena = Arena;
})();
