# COBRONA :: PROTOCOLO NEON — Design Doc + Contrato Técnico

> Este documento é **normativo**. Todo implementador deve segui-lo à risca.
> Nomes de arquivos, nomes de funções, assinaturas, IDs de DOM e nomes de campos
> definidos aqui são **contrato**. Não invente nomes alternativos. Não renomeie.

---

## 0. RESTRIÇÕES INEGOCIÁVEIS

- HTML + CSS + JavaScript **vanilla**. Zero dependências, zero build, zero rede.
- Deve rodar abrindo `index.html` com duplo-clique (**protocolo `file://`**). Portanto:
  - **NADA de `<script type="module">`**, `import`, `export`. Só `<script src>` clássico.
  - **NADA de `fetch`/`XHR`**, nada de fontes/imagens/sons externos.
  - Fontes: só system/web-safe (`ui-monospace, "JetBrains Mono", "Fira Code", Consolas, monospace`).
- Todo áudio é **sintetizado** com Web Audio API. Todo gráfico é **Canvas 2D** ou CSS.
- `localStorage` **pode lançar exceção** em `file://` (Chrome bloqueia). **Sempre** dentro de
  `try/catch` com fallback em memória. Ver `Util.store`.
- Alvo: **60fps** em notebook Linux modesto no Firefox.
- Todo texto visível ao jogador em **português brasileiro**.
- Sem `console.log` no código final (exceto atrás de `CFG.DEBUG`).

---

## 1. IDENTIDADE

**COBRONA :: PROTOCOLO NEON** — synthwave cyberpunk. Você é um verme de dados invadindo
um mainframe. Cada maçã é um pacote roubado, cada nível é um setor mais hostil da rede.
A fantasia central: **velocidade, luz e caos crescente** — começa hipnótico, termina em pânico glorioso.

### Paleta (hex, definida em `CFG.PAL`)

| nome | hex | uso |
|---|---|---|
| `void` | `#04010c` | fundo do espaço |
| `deep` | `#0b0424` | fundo do grid |
| `gridLine` | `#2a1566` | linhas do grid |
| `gridGlow` | `#4b1fa8` | linhas destacadas do grid |
| `cyan` | `#00f0ff` | cabeça da cobra, HUD primário |
| `magenta` | `#ff2d95` | comida normal, acentos |
| `lime` | `#7dff4d` | combo, positivo |
| `amber` | `#ffb800` | comida dourada |
| `violet` | `#a855ff` | cristal, portais |
| `danger` | `#ff2b2b` | caçador, morte, perigo |
| `white` | `#eaf6ff` | texto |
| `dim` | `#7a6fa8` | texto secundário |

Corpo da cobra: gradiente de matiz ao longo do comprimento, `hue = 185 - i * 1.6` (cyan → violeta → magenta),
saturação 100%, luminosidade 55%. Cabeça sempre `cyan` puro com brilho maior.

---

## 2. LOOP CENTRAL

- Grade: **30 × 20** células. Célula: **32px**. Canvas lógico: **960 × 640**.
- Tick base: **130 ms**. Curva: `tickMs = max(58, 130 - nivel * 5)`.
- Nível sobe a cada **5** comidas. `nivel` começa em 0.
- Crescimento: +1 segmento (normal), +2 (dourada), +1 (cristal).
- Cobra inicial: 4 segmentos, centro da arena, direção `RIGHT`.
- Morte: colisão com parede da borda, com muro interno, com o próprio corpo, ou com um Caçador.
  - Exceção: `FANTASMA` ativo → atravessa corpo e faz *wrap* nas bordas.
  - Exceção: `ESCUDO` ativo → consome o escudo, empurra a cabeça de volta 1 célula, i-frames de 800ms.
  - Exceção: modo `ZEN` → nunca morre; perde 3 segmentos + i-frames de 1000ms.

### MOVIMENTO INTERPOLADO (assinatura do jogo — obrigatório)

A lógica é por tick discreto, mas o **render é contínuo**. Cada entidade guarda a posição
anterior (`px, py`) e a atual (`x, y`). O renderer desenha em
`lerp(px, x, tickProgress)` onde `tickProgress = tickAcc / tickMs` (0..1).
Isso é o que separa este jogo de um clone travado. **Não pule isso.**
Cuidado: quando há *wrap* ou teleporte por portal, a interpolação deve ser **suprimida**
naquele tick (desenhar direto na posição nova), senão a cobra "voa" pela tela.

### BUFFER DE INPUT

`Input` mantém uma fila de até **2** direções. O `Game` consome **uma por tick**.
Uma direção que seja o inverso exato da direção atual é **descartada na entrada da fila**
(comparada contra a última direção da fila, não contra a direção atual). Isso elimina
a morte clássica por "virei duas vezes rápido demais".

---

## 3. SISTEMAS DE GAMEPLAY

### 3.1 Combo
- Comer dentro de **2500 ms** da comida anterior: `combo++`. Senão `combo = 0`.
- `multiplicador = min(8, 1 + combo * 0.5)`.
- Pontos = `basePts * multiplicador * (slowAtivo ? 2 : 1) * (furiaAtiva ? 3 : 1)`, arredondado.
- HUD mostra barra de combo drenando de 100% → 0% em 2500ms.
- Som de comer sobe **1 semitom por nível de combo** (cap em +18).

### 3.2 Comidas
| tipo | cor | chance | pontos base | cresce | TTL |
|---|---|---|---|---|---|
| `normal` | magenta | 83% | 10 | +1 | ∞ |
| `gold` | amber | 12% | 50 | +2 | 6000 ms (pisca nos últimos 2000) |
| `crystal` | violet | 5% | 25 | +1 | 9000 ms — concede power-up aleatório |

Sempre exatamente **1** comida no mapa (spawn imediato após consumo/expiração).
Spawn nunca sobre a cobra, muro, portal ou caçador. Se não houver célula livre, vitória técnica → fim de jogo com causa `'perfeito'`.

### 3.3 Power-ups (do cristal)
| id | nome PT | duração | efeito |
|---|---|---|---|
| `ghost` | `FANTASMA` | 8000 ms | atravessa o próprio corpo; bordas fazem *wrap* |
| `magnet` | `ÍMÃ` | 10000 ms | comida anda 1 célula na direção da cabeça a cada 2 ticks se dist ≤ 6 |
| `slow` | `TEMPO LENTO` | 6000 ms | `tickMs × 1.8`, pontos × 2 |
| `shield` | `ESCUDO` | até 1 hit | sobrevive a uma colisão |
| `fury` | `FÚRIA` | 7000 ms | `tickMs × 0.6`, pontos × 3, destrói muros e caçadores no caminho |

Múltiplos power-ups podem estar ativos ao mesmo tempo. Nos últimos 2000 ms o ícone pisca.

### 3.4 Setores (progressão de arena)
A cada **500** pontos sobe um setor. Transição: hitstop 120ms, flash, texto grande, som,
paleta de grid muda, arena é reconstruída (a cobra **nunca** é morta pela reconstrução —
células ocupadas pela cobra jamais viram muro).

| setor | pontos | nome | novidade |
|---|---|---|---|
| 0 | 0 | `SETOR 01 :: BOOT` | arena limpa |
| 1 | 500 | `SETOR 02 :: FIREWALL` | muros internos |
| 2 | 1000 | `SETOR 03 :: CAÇADA` | + 1 Caçador |
| 3 | 1500 | `SETOR 04 :: DOBRA` | + portais |
| 4 | 2000 | `SETOR 05 :: SOBRECARGA` | + 2º Caçador, grid pulsa |
| 5+ | 2500+ | `SETOR 0N :: CAOS` | +1 Caçador a cada setor (cap 5), muros densos |

### 3.5 Caçador
Drone hostil de 1 célula. Move a cada **2 ticks** (a cada 3 ticks se `slow` ativo).
Passo: escolhe entre os 4 vizinhos o que minimiza a distância de Manhattan até a cabeça,
ignorando células de muro; empata → mantém direção anterior. Nunca entra em portal.
Nasce sempre a ≥ 10 células da cabeça, com animação de materialização de 1200 ms
(**intangível** durante ela, pisca em vermelho).
Colisão com a cabeça = morte. `FÚRIA` o destrói em contato (explosão + 100 pts).

### 3.6 Portais
2 pares. Entrar em um sai no par. Cooldown de 2 ticks por portal para não fazer loop.
Cor `violet`, com anel girando.

### 3.7 Modos
- `classico` — progressão normal descrita acima.
- `caos` — começa direto no setor 3, tick base 105ms, 2 Caçadores, tudo liberado. Pontos × 1.5.
- `zen` — sem morte, sem caçadores, sem muros. Colidir custa 3 segmentos. Para relaxar.

---

## 4. JUICE (tabela evento → feedback)

| evento | hitstop | shake | partículas | flash | som | extra |
|---|---|---|---|---|---|---|
| comer normal | 45 ms | 4 | 18 radiais magenta | 0.06 | `eat(combo)` | texto flutuante `+10 x2`, anel expandindo, onda de engolida |
| comer dourada | 90 ms | 9 | 40 âmbar | 0.14 | `gold()` | texto grande dourado |
| pegar cristal | 120 ms | 11 | 46 violeta | 0.18 | `powerup()` | nome do power-up no centro, anel duplo |
| subir de nível | 60 ms | 5 | anel de choque | 0.10 | `levelUp()` | — |
| trocar de setor | 140 ms | 14 | 80 partículas | 0.25 | `sector()` | banner grande 1800 ms |
| escudo quebra | 160 ms | 16 | 60 ciano | 0.30 | `shield()` | aberração cromática 400 ms |
| caçador destruído | 80 ms | 10 | 50 vermelhas | 0.12 | `kill()` | `+100` |
| morte | 260 ms | 24 | corpo explode segmento a segmento (delay 18ms por segmento) | 0.5 vermelho | `death()` | slow-motion (timeScale 0.25 → 1 em 900ms), aberração 800ms |

- **Onda de engolida:** ao comer, um pulso viaja da cabeça até a cauda. Segmento `i` escala
  `1 + 0.45 * max(0, 1 - |wavePos - i| / 2)`. Velocidade: 22 segmentos/s. Some ao chegar na cauda.
- **Rastro da cabeça:** últimas 8 posições da cabeça desenhadas aditivamente com alpha decrescente.
- **Trauma-based shake:** `trauma` 0..1, decai `trauma -= dt*1.6`, deslocamento `= trauma² * 14px`
  com ruído. `FX.shake(n)` faz `trauma = min(1, trauma + n/25)`.
- **Limite duro: 900 partículas.** Ao estourar, as mais velhas são recicladas. Pool pré-alocado.

---

## 5. ÁUDIO PROCEDURAL

Grafo: `osc/noise → gain(env) → filtro → busGain → compressor → destination`.
Dois buses: `sfxBus` (0.55) e `musicBus` (0.35).

### SFX
| som | receita |
|---|---|
| `eat(combo)` | triangle, `f = 440 * 2^(min(combo,18)/12)`, env A2ms D90ms, + click de square 30ms uma oitava acima |
| `gold()` | dois triangles em quinta (784/1175 Hz), D260ms, leve vibrato |
| `powerup()` | sawtooth sweep 220→1400 Hz em 320ms, lowpass 400→6000, D420ms |
| `levelUp()` | arpejo 3 notas square (523,659,880) 70ms cada |
| `sector()` | sub sine 55Hz 600ms + sweep de ruído (highpass 200→8000) |
| `shield()` | square 900Hz + ruído metálico, bitcrush por distortion curve, 250ms |
| `kill()` | ruído branco, lowpass 3000→200 em 220ms |
| `death()` | ruído + sawtooth, pitch 300→40 Hz em 900ms, lowpass 4000→150, reverb curto por feedback delay |
| `portal()` | sine sweep 1200→300, 180ms, pan alternado |
| `hunterAlert()` | duas square 180Hz staccato, 2× |
| `uiMove()` / `uiConfirm()` | blips curtos square 660 / 880+1320 Hz |

### Música adaptativa
Scheduler com *lookahead* de 100 ms rodando em `Audio.update()`, agendando semicolcheias.
`BPM = min(164, 112 + nivel * 2)`. Escala: **Lá menor pentatônica** (`A2 C3 D3 E3 G3`).

Camadas ligadas por `intensity` (0..3, derivada do setor):
0. `bass` — sawtooth + lowpass 400Hz, colcheias na tônica, com slide.
1. `+ hats` — noise 8ms por highpass 7kHz, em todas as semicolcheias, acento nos 4º.
2. `+ arp` — square plucky (A2ms D110ms), sobe/desce a pentatônica, 16 passos.
3. `+ kick & lead` — kick sine 150→45Hz em 90ms nos tempos 1 e 3; lead com delay pingue-pongue.

`Audio.music.setIntensity(n)` faz *crossfade* de 400ms nas camadas.

---

## 6. UI E TELAS (textos exatos)

- **Menu:** título `COBRONA` com subtítulo `:: PROTOCOLO NEON ::`.
  Modos: `CLÁSSICO` / `CAÔS` / `ZEN`. Rodapé: `↑↓ escolhe · ESPAÇO começa · M muta`.
  Mostra `RECORDE: N`.
- **HUD:** `PONTOS`, `RECORDE`, `TAMANHO`, `SETOR`, barra de combo com `x2.5`, ícones de power-up ativos.
- **Pausa:** `PAUSADO` · `ESPAÇO continua · ESC sai`.
- **Game over:** manchete conforme causa da morte:
  - `parede` → `VOCÊ VIROU CONCRETO`
  - `corpo` → `VOCÊ SE MORDEU, GÊNIO`
  - `cacador` → `O CAÇADOR TE PEGOU`
  - `perfeito` → `VOCÊ COMEU A REDE INTEIRA`
  Stats: `PONTOS`, `TAMANHO MÁXIMO`, `COMBO MÁXIMO`, `SETOR ALCANÇADO`, `TEMPO`.
  `NOVO RECORDE!` pulsando quando aplicável. Rodapé: `ENTER joga de novo · ESC menu`.
- **Recordes:** top 5 em `localStorage` (chave `cobrona.recordes.v1`), com modo e data.

---

## 7. CONTROLES

| tecla | ação |
|---|---|
| `←↑→↓` / `WASD` | direção |
| `Espaço` | começar / pausar / continuar |
| `Enter` | reiniciar (no game over) |
| `Esc` | voltar ao menu |
| `M` | mudo |
| `P` | pausar |
| toque: swipe | direção (limiar 24px) |
| toque: tap | começar / continuar |

---

## 8. ARQUIVOS E ORDEM DE CARGA

`index.html` carrega **nesta ordem exata**:

```
css/style.css
js/core/util.js          -> COBRA.Util
js/game/config.js        -> COBRA.CFG
js/core/audio.js         -> COBRA.Audio
js/core/input.js         -> COBRA.Input
js/core/fx.js            -> COBRA.FX
js/game/arena.js         -> COBRA.Arena
js/game/entities.js      -> COBRA.Snake, COBRA.Food, COBRA.Hunter
js/game/game.js          -> COBRA.Game
js/render/background.js  -> COBRA.BG
js/render/renderer.js    -> COBRA.Renderer
js/ui/ui.js              -> COBRA.UI
js/main.js               -> bootstrap
```

**Regra de ouro:** todo arquivo começa com `window.COBRA = window.COBRA || {};` e
**nunca** lê `COBRA.CFG` ou outro módulo no escopo de topo do arquivo — só dentro de
funções/`init()`. Isso torna a ordem de carga robusta.

---

## 9. CONTRATO DE API (assinaturas — seguir literalmente)

### 9.1 `COBRA.Util`
```js
Util.clamp(v, a, b)
Util.lerp(a, b, t)
Util.invLerp(a, b, v)
Util.easeOutCubic(t) / easeInCubic(t) / easeOutBack(t) / easeOutElastic(t) / easeInOutSine(t)
Util.rand(a, b)          // float
Util.randInt(a, b)       // inteiro inclusivo
Util.pick(arr)
Util.chance(p)           // p em 0..1
Util.hsla(h, s, l, a)    // -> "hsla(...)"
Util.key(x, y)           // -> "x,y"
Util.manhattan(ax, ay, bx, by)
Util.formatTime(ms)      // -> "1:07"
Util.store.get(key, fallback)   // JSON, try/catch, fallback em memória
Util.store.set(key, value)      // JSON, try/catch silencioso
Util.DIRS = { UP:{x:0,y:-1}, DOWN:{x:0,y:1}, LEFT:{x:-1,y:0}, RIGHT:{x:1,y:0} }
```

### 9.2 `COBRA.CFG`
Objeto plano com **todas** as constantes deste documento. Campos obrigatórios:
```js
CFG.DEBUG = false
CFG.GRID_W = 30, CFG.GRID_H = 20, CFG.CELL = 32, CFG.W = 960, CFG.H = 640
CFG.TICK_BASE = 130, CFG.TICK_MIN = 58, CFG.TICK_STEP = 5
CFG.FOODS_PER_LEVEL = 5
CFG.COMBO_MS = 2500, CFG.COMBO_MAX_MULT = 8
CFG.PAL = { void:'#04010c', deep:'#0b0424', gridLine:'#2a1566', gridGlow:'#4b1fa8',
            cyan:'#00f0ff', magenta:'#ff2d95', lime:'#7dff4d', amber:'#ffb800',
            violet:'#a855ff', danger:'#ff2b2b', white:'#eaf6ff', dim:'#7a6fa8' }
CFG.FOOD = { normal:{pts:10,grow:1,ttl:0,chance:0.83}, gold:{...}, crystal:{...} }
CFG.POWER = { ghost:{ms:8000,nome:'FANTASMA'}, magnet:{...}, slow:{...}, shield:{...}, fury:{...} }
CFG.SECTORS = [ {nome:'SETOR 01 :: BOOT', pontos:0, muros:false, cacadores:0, portais:false}, ... ]
CFG.MODES = { classico:{...}, caos:{...}, zen:{...} }
CFG.MAX_PARTICLES = 900
CFG.STORAGE_KEY = 'cobrona.recordes.v1'
```

### 9.3 `COBRA.Audio`
```js
Audio.init()                    // cria AudioContext (idempotente); seguro chamar antes de gesto
Audio.unlock()                  // ctx.resume(); chamar no 1º input do usuário
Audio.setMuted(bool) / Audio.isMuted() / Audio.toggleMute()
Audio.update()                  // chamado todo frame; roda o scheduler da música
Audio.sfx.eat(combo) | gold() | powerup() | levelUp() | sector() | shield()
        | kill() | death() | portal() | hunterAlert() | uiMove() | uiConfirm()
Audio.music.start() / stop() / setIntensity(0..3) / setLevel(n)
```
Nunca deixar exceção escapar: se `AudioContext` não existir, todos os métodos viram no-op.

### 9.4 `COBRA.Input`
```js
Input.init(targetEl)             // recebe #app, NÃO o canvas: `.screen.on` tem
                                 // pointer-events:auto e cobre o canvas inteiro,
                                 // então o toque nunca chegaria com menu aberto
Input.pushDir(dir)              // usado pelo touch
Input.nextDir(currentDir)       // desenfileira 1 direção válida ou retorna null
Input.pressed(action)           // one-shot: 'start','pause','restart','menu','mute','up','down','left','right','confirm'
Input.endFrame()                // limpa os one-shots — main.js chama no fim de cada frame
Input.clearQueue()
```
`preventDefault` nas setas e no espaço para a página não rolar.

### 9.5 `COBRA.FX`
```js
FX.init()
FX.reset()
FX.update(dt)                   // sempre chamado, mesmo em hitstop
FX.burst(x, y, opts)            // opts: {count,color,speed,size,life,spread,angle,gravity,additive}
FX.ring(x, y, opts)             // {color,r0,r1,life,width}
FX.floatText(x, y, texto, opts) // {color,size,life,vy,bold}
FX.shake(n)                     // n em unidades de trauma (ver §4)
FX.flash(alpha, color)
FX.chroma(ms)                   // aberração cromática
FX.hitstop(ms)
FX.blocked()                    // true se hitstop ativo
FX.shakeOffset()                // -> {x,y}
FX.drawWorld(ctx)               // partículas e anéis, em coordenadas de mundo
FX.drawOverlay(ctx, w, h)       // flash, textos flutuantes, vinheta de chroma
FX.count()                      // nº de partículas vivas (debug)
```
Coordenadas de `burst`/`ring`/`floatText` são em **pixels de mundo** (célula × 32 + 16).

### 9.6 `COBRA.Arena`
```js
Arena.build(sectorIndex, protectedCells, opts)  // protectedCells: array de {x,y} que nunca viram muro
                                // opts (opcional): ajustes de geração
Arena.reset()
Arena.isWall(x, y)              // -> bool (inclui bordas? NÃO — bordas são checadas pelo Game)
Arena.walls                     // Set de "x,y"
Arena.wallList                  // array de {x,y} para render
Arena.portals                   // array de {x,y,pair:{x,y},id}
Arena.portalAt(x, y)            // -> {x,y} destino, ou null
Arena.isBlocked(x, y)           // muro OU portal (para spawn de comida)
```

### 9.7 `COBRA.Snake` / `COBRA.Food` / `COBRA.Hunter`
```js
const s = new COBRA.Snake(x, y, dir)
s.cells          // array [{x,y}], índice 0 = cabeça
s.prev           // array [{x,y}] posições do tick anterior (mesmo tamanho)
s.dir            // {x,y}
s.pendingGrow    // int
s.waves          // array de {pos} — ondas de engolida
s.noInterp       // bool — true quando houve wrap/portal neste tick
s.step(dir, ctx) // ctx: {wrap:bool, arena:Arena} -> {portal:bool, wrapped:bool}
s.grow(n)
s.hits(x, y, ignoreTail)   // -> bool
s.shrink(n)
s.head()         // -> {x,y}
s.updateWaves(dt)
s.pushTrail(px, py, dt)   // rastro amostrado por TEMPO, não por frame

new COBRA.Food(x, y, type, bornAt)   // .x .y .type .born .ttl .expired(now)
                             // .px/.py = posição do TICK anterior (interpolação):
                             // quem NÃO move a comida no tick deve chamar .settle()
new COBRA.Hunter(x, y)       // .x .y .px .py .alive .spawning .spawnT .dir
h.update(tick, headX, headY, arena, everyTicks)   // move segundo §3.5
h.isTangible()               // false durante materialização
```

### 9.8 `COBRA.Game`
```js
Game.init()
Game.start(mode)   // 'classico' | 'caos' | 'zen'
Game.update(dt)    // dt em ms, já com timeScale aplicado por main.js
Game.pause() / Game.resume() / Game.togglePause() / Game.toMenu() / Game.restart()

// estado lido pelo Renderer e pela UI (nomes são contrato):
Game.state         // 'menu' | 'playing' | 'paused' | 'gameover'
Game.mode
Game.score, Game.best, Game.level, Game.sector
Game.combo, Game.comboMs, Game.mult
Game.snake, Game.food, Game.hunters   // food é UM objeto (ou null)
Game.power         // { ghost:ms, magnet:ms, slow:ms, fury:ms, shield:bool }
Game.tickMs, Game.tickAcc
Game.tickProgress  // 0..1 -> tickAcc / tickMs   (o Renderer usa isto para interpolar)
Game.timeScale     // 1 normalmente; 0.25→1 durante a morte
Game.invulnMs
Game.tick          // contador de ticks da partida (o Renderer usa para saber
                   //   em qual tick a comida do ÍMÃ realmente andou)
Game.stats         // { maxLen, maxCombo, timeMs, sector, cause,
                   //   score, mode, level, isRecord }
Game.deathAnim     // 0..1 progresso da animação de morte
```
`Game` chama diretamente `COBRA.FX.*`, `COBRA.Audio.*` e `COBRA.UI.*` — acoplamento aceito.

### 9.9 `COBRA.BG`
```js
BG.init(w, h)
BG.update(dt, intensity)   // intensity 0..3
BG.draw(ctx, w, h, sector) // starfield + grid em perspectiva + nebulosa
```

### 9.10 `COBRA.Renderer`
```js
Renderer.init(canvasEl)
Renderer.resize()          // devicePixelRatio + letterbox via CSS
Renderer.render(game, dt)  // desenha o frame inteiro
```
**Obrigatório por performance:** pré-renderizar sprites em canvas offscreen no `init()`
(corpo por matiz — 36 matizes, cabeça, comidas, muro, caçador, portal, scanlines, vinheta)
e desenhar com `drawImage`. **Proibido** usar `ctx.shadowBlur` dentro do loop de render por
segmento — só na geração dos sprites. Brilho no loop = `globalCompositeOperation = 'lighter'`.

### 9.11 `COBRA.UI`
```js
UI.init()
UI.show(screen)            // 'menu' | 'game' | 'pause' | 'gameover'
UI.syncHUD(game)           // atualiza pontos/recorde/tamanho/setor/combo/power-ups
UI.banner(texto, sub, ms)  // banner grande centralizado (troca de setor, power-up)
UI.showGameOver(stats, isRecord)
UI.menuMove(delta) / UI.menuSelect()  // -> retorna o modo escolhido
UI.setMuted(bool)
UI.renderScores()
```
UI manipula **apenas** o DOM (nunca o canvas).

---

## 10. CONTRATO DE DOM (`index.html`)

IDs exatos que `ui.js` vai consultar:

```html
<div id="app">
  <canvas id="game"></canvas>

  <div id="hud" class="layer">
    <div class="hud-left">
      <div class="stat"><span class="lbl">PONTOS</span><span id="hud-score">0</span></div>
      <div class="stat"><span class="lbl">RECORDE</span><span id="hud-best">0</span></div>
    </div>
    <div class="hud-right">
      <div class="stat"><span class="lbl">SETOR</span><span id="hud-sector">01</span></div>
      <div class="stat"><span class="lbl">TAMANHO</span><span id="hud-len">4</span></div>
    </div>
    <div id="combo-wrap"><div id="combo-bar"></div><span id="combo-mult">x1</span></div>
    <div id="powerups"></div>
  </div>

  <div id="banner" class="layer"><div id="banner-main"></div><div id="banner-sub"></div></div>

  <div id="screen-menu" class="layer screen">
    <h1 id="title">COBRONA</h1>
    <p id="subtitle">:: PROTOCOLO NEON ::</p>
    <ul id="modes">
      <li data-mode="classico" class="sel">CLÁSSICO</li>
      <li data-mode="caos">CAÔS</li>
      <li data-mode="zen">ZEN</li>
    </ul>
    <p id="menu-best">RECORDE: 0</p>
    <ol id="scorelist"></ol>
    <p class="hint">↑↓ escolhe · ESPAÇO começa · M muta</p>
  </div>

  <div id="screen-pause" class="layer screen">
    <h2>PAUSADO</h2><p class="hint">ESPAÇO continua · ESC sai</p>
  </div>

  <div id="screen-over" class="layer screen">
    <h2 id="over-title">VOCÊ VIROU CONCRETO</h2>
    <p id="over-record">NOVO RECORDE!</p>
    <dl id="over-stats"></dl>
    <p class="hint">ENTER joga de novo · ESC menu</p>
  </div>

  <div id="mute-ind">🔇</div>
</div>
```
Telas são mostradas/ocultadas via classe `.on` (`display:none` quando ausente).

> **Regra dura:** nenhuma tela pode depender de animação/transição para ficar visível.
> Um fade partindo de `opacity: 0` deixa a tela **presa em invisível** quando o relógio de
> animação não avança (compositor suspenso, render por software, aba oculta, captura headless).
> Isso aconteceu de verdade aqui e deixou o menu inteiro invisível. O estado de repouso
> de `.screen.on` é opaco, ponto.

---

## 11. LOOP PRINCIPAL (`js/main.js`)

```js
let last = performance.now();
function frame(now) {
  let dt = Math.min(50, now - last); last = now;
  COBRA.Audio.update();
  COBRA.FX.update(dt);
  if (!COBRA.FX.blocked()) COBRA.Game.update(dt * COBRA.Game.timeScale);
  COBRA.Renderer.render(COBRA.Game, dt);
  COBRA.UI.syncHUD(COBRA.Game);
  COBRA.Input.endFrame();
  requestAnimationFrame(frame);
}
```
`dt` é clampado em 50ms para a aba em segundo plano não teleportar a cobra.
`main.js` também trata as transições de estado globais lendo `Input.pressed(...)`.

---

## 12. O QUE FICOU DE FORA (cortes conscientes)
- WebGL / shaders — sai do escopo vanilla-file://.
- Multiplayer, leaderboard online — exige rede.
- Cobra rival com IA completa — o Caçador entrega a mesma tensão por 1/5 do custo.
- Sprites/áudio importados — quebra o requisito de arquivo único distribuível.
