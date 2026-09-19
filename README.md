# 🐍 COBRONA :: PROTOCOLO NEON

Um jogo da cobrinha synthwave. HTML + Canvas 2D + Web Audio, **zero dependências, zero build, zero rede**.

## Como jogar

Dê **duplo-clique no `index.html`**. É isso. Funciona offline, direto do `file://`.

Se preferir servir por HTTP (opcional):

```powershell
python -m http.server 8777
# abre http://localhost:8777
```

## Controles

| tecla | ação |
|---|---|
| `←↑→↓` ou `WASD` | direção |
| `Espaço` | começar · pausar · continuar |
| `Enter` | começar (no menu) · jogar de novo (na tela de fim) |
| `Esc` | voltar ao menu |
| `P` | pausar |
| `M` | mudo |
| swipe | direção (celular) |
| tap | começar · continuar |

## Modos

- **CLÁSSICO** — a progressão completa, do setor calmo ao caos.
- **CAÔS** — começa já no SETOR 04 (DOBRA, com muros e portais), mais rápido, dois caçadores, pontos ×1,5.
- **ZEN** — não morre. Bater custa 3 segmentos. Para desligar o cérebro.

## O que torna a partida interessante

**Combo.** Comer dentro de 2,5 s encadeia. O multiplicador vai até ×8 e o som de comer sobe um
semitom por elo — dá pra *ouvir* o combo crescendo.

**Comidas.** Normal (10 pts), dourada (50 pts, expira em 6 s) e cristal (25 pts, expira em 9 s), que solta um power-up.

**Power-ups.** `FANTASMA` atravessa o próprio corpo e as paredes · `ÍMÃ` puxa a comida ·
`TEMPO LENTO` desacelera e dobra os pontos · `ESCUDO` absorve uma morte · `FÚRIA` acelera,
triplica os pontos e destrói muros e caçadores no caminho.

**Setores.** A cada 500 pontos a arena é reconstruída e algo novo entra: muros, depois o
**Caçador** (um drone que te persegue), depois portais, depois mais caçadores. Do setor 6 em
diante é caos procedural.

**Caçador.** Persegue sua cabeça. Materializa em 1,2 s piscando em vermelho — nesse tempo é
intangível, então dá pra escapar. Morre na `FÚRIA`, e vale 100 pontos.

## Detalhes de implementação que fazem diferença

- **Movimento interpolado.** A lógica é por tick discreto, mas o desenho interpola entre a posição
  anterior e a atual. É o que separa isso de um clone travadinho. No wrap e no portal a
  interpolação é suprimida no tick, senão a cobra atravessaria a tela voando.
- **Buffer de input.** Até 2 direções na fila, uma consumida por tick, e o inverso é descartado
  comparando com a *última da fila* — mata a morte clássica por "virei duas vezes rápido demais".
- **Sprites pré-renderizados.** Todo o brilho (`shadowBlur`) é assado uma vez em canvas offscreen
  no boot: 36 matizes de corpo, cabeça, comidas, muro, caçador, portal, scanlines, vinheta.
  No loop só tem `drawImage` com blend aditivo. Por isso roda a 60fps.
- **Partículas em pool fixo.** 900 objetos pré-alocados, reciclados. Zero alocação por frame.
- **Áudio 100% sintetizado.** Nenhum arquivo de som. A trilha tem 4 camadas (baixo, chimbal,
  arpejo, bumbo+lead) que entram conforme o setor, com BPM subindo com o nível, agendadas por um
  scheduler com lookahead de 100 ms.
- **Arena com conectividade garantida.** Depois de gerar os muros, um flood-fill confere que toda
  célula livre é alcançável; se particionou, derruba muros até reconectar. Sem isso a comida podia
  nascer numa região isolada e te matar sem culpa sua.

## Estrutura

```
index.html              markup + ordem dos scripts
css/style.css           HUD, menus, telas, CRT
js/core/util.js         matemática, RNG, storage à prova de exceção
js/core/audio.js        síntese de SFX + trilha adaptativa
js/core/input.js        teclado, toque, gamepad, fila de direções
js/core/fx.js           partículas, screenshake, hitstop, flash
js/game/config.js       TODAS as constantes e a paleta
js/game/arena.js        muros, portais, setores, flood-fill
js/game/entities.js     Snake, Food, Hunter
js/game/game.js         máquina de estados e regra do jogo
js/render/background.js starfield, grid, nebulosa
js/render/renderer.js   sprites e desenho do mundo
js/ui/ui.js             DOM: HUD, menus, recordes
js/main.js              boot e loop principal
testes/                 testes da lógica no Node (node --test)
ARCHITECTURE.md         o design doc + contrato de API
CLAUDE.md               estado real do projeto, armadilhas e divergências do doc
```

## Testes

Na pasta do projeto:

```powershell
node --test
```

Sem dependência nenhuma (o runner vem com o Node). Tem que terminar com `ℹ fail 0`
(121 testes em 19/09/2026). Detalhes no `CLAUDE.md`.

## Mexer no jogo

Quase tudo que importa é constante em [`js/game/config.js`](js/game/config.js): velocidade
(`TICK_BASE`, `TICK_MIN`), tamanho da grade, paleta, tabelas de comida, power-up e setor, e a
tabela de juice (screenshake, hitstop, contagem de partículas por evento), tremor, flash, fila de
input e limiar do swipe. Dá pra mudar a cara e o ritmo do jogo sem tocar em lógica.

Desde 19/09/2026 todo valor do `config.js` ou é lido pelo jogo ou está marcado no comentário como
"NÃO USADO" — antes alguns (fila de input, swipe, tremor, flash) eram ignorados. Duas coisas que
**não** estão lá: a cor da grade de cada setor (tabela `SECTOR_HUE` em `js/render/background.js`)
e os textos fixos da tela, como título e dicas (no `index.html`).

Corrigido na mesma data: no modo ZEN, o aviso de troca de setor anunciava muros, portais e caçador
que o modo não tem (agora diz "ARENA LIMPA"), e a lista de recordes passou a achar o nome do modo
pelo id gravado, em vez de acertar por acaso.

Os recordes ficam em `localStorage` na chave `cobrona.recordes.v1`.
