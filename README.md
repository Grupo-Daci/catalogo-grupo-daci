# Catálogo Grupo DACI — integração com WebSac

## O que é

Vitrine de produtos (`catalogo_grupo_daci.html`) que se atualiza sozinha com dados reais
de estoque e preço do WebSac, sem precisar de planilha nem de trabalho manual.

## Como funciona

```
[GitHub Actions, a cada 30 min]
        │
        ▼
  sync-websac.js  ──chama──>  API do WebSac (cnpj + token, só aqui, nunca no navegador)
        │
        ▼
  products.json  (só é reescrito quando o WebSac reporta uma mudança real)
        │
        ▼
catalogo_grupo_daci.html  ──fetch('products.json')──>  renderiza a vitrine
```

Pontos importantes:
- **O token do WebSac nunca aparece no navegador** — só o script `sync-websac.js`,
  rodando no GitHub Actions, conhece as credenciais.
- **Só atualiza quando há mudança de verdade**: o script guarda a data da última
  sincronização (`sync-state.json`) e pergunta ao WebSac "o que mudou desde então?".
  Se a resposta vier vazia, nada é reescrito — sem commits ou publicações à toa.
- **Produtos esgotados não aparecem** na vitrine.
- **Visão em lista** (compacta, pensada para representantes conferindo preço/estoque
  rapidamente), com ordenação por Maior/Menor Preço e Maior/Menor Estoque.

## Arquivos deste projeto

- **`catalogo_grupo_daci.html`** — a interface. Busca `products.json` (com um
  "quebra-cache" para nunca mostrar uma versão antiga por engano) e re-renderiza a
  cada 10 minutos sozinha.
- **`sync-websac.js`** — script Node que roda no GitHub Actions, consulta o WebSac e
  gera o `products.json`. Mapeamento de campos já confirmado contra a resposta real
  da API (ver comentários no código).
- **`sync-websac.yml`** — vai em `.github/workflows/sync-websac.yml`. Agenda a
  execução do `sync-websac.js` a cada 30 minutos.
- **`.env.example`** — modelo de configuração para rodar o script localmente (copiar
  para `.env` e preencher com os dados reais; nunca commitar o `.env` de verdade).
- **`package.json`** — metadados do projeto Node.

## Pendências conhecidas (não travam o funcionamento, mas vale revisitar)

1. **Nome do parâmetro de data em `/produto/alterados`**: usamos
   `dataHoraReferencia` como palpite (baseado na mensagem de erro que a própria API
   retorna). Se um dia parar de funcionar com esse erro de "data e hora inválida",
   confirme o nome certo com o suporte do WebSac e ajuste em `fetchChangedProducts()`.
2. **Campo `tipo_item`** (Mochila, Bolsa, Garrafa...): não existe um campo exato
   equivalente no WebSac; usamos departamento/grupo como aproximação. Pode não bater
   100% com os filtros da interface — revisar com calma quando fizer sentido.
3. **Fotos dos produtos**: buscamos via `/produto/{id}/foto` e embutimos como base64.
   Isso deixa a sincronização mais lenta. Se quiser desligar temporariamente, defina
   a variável de ambiente `FETCH_PHOTOS=false` no workflow.

## Configuração necessária no GitHub

**Secrets** (Settings → Secrets and variables → Actions):
- `WEBSAC_BASE_URL`
- `WEBSAC_CNPJ`
- `WEBSAC_TOKEN`

**Permissões do Actions** (Settings → Actions → General → Workflow permissions):
- "Read and write permissions" habilitado (necessário para o robô conseguir
  commitar o `products.json` atualizado de volta no repositório).

**GitHub Pages** (Settings → Pages):
- Source: Deploy from a branch → `main` → `/ (root)`.
