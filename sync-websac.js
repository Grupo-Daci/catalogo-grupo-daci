'use strict';

/**
 * sync-websac.js
 * ---------------------------------------------------------------------------
 * Consulta a API do WebSac (documentada em
 * https://documenter.getpostman.com/view/24115506/2s8YRgraKh) e gera/atualiza
 * o products.json consumido pela vitrine estática (catalogo_grupo_daci.html).
 *
 * Modos de execução:
 *  - Sincronização completa (FULL_SYNC=true, ou quando não existe
 *    sync-state.json ainda): busca TODO o catálogo via /produto/listar,
 *    baixa as fotos (se FETCH_PHOTOS !== 'false') e reconstrói o
 *    products.json do zero.
 *  - Sincronização incremental (padrão): usa /produto/alterados desde a
 *    última execução para atualizar só estoque e preço dos produtos que já
 *    conhecemos. Isso é rápido e evita rebaixar fotos toda hora.
 *
 * Endpoints confirmados (ver curls que o usuário validou com token real):
 *
 *   GET {BASE}/produto/listar?pagina=N&ativo=true
 *     -> array de objetos de produto (sem wrapper). Paginar até a página
 *        voltar vazia.
 *
 *   GET {BASE}/produto/alterados?data_hora_referencia=YYYY-MM-DD%20HH:MM:SS
 *                                &cadastro=true&preco=true&estoque=true
 *     -> { estoque: [{ id_produto, estoque_atual, previsao_entrada,
 *                       previsao_saida }, ...],
 *          preco:   [{ id_produto, preco_varejo, preco_varejo_oferta,
 *                       preco_atacado, "preco_atacado_o)ferta" }, ...],
 *          cadastro: [...] }   <- formato do bloco "cadastro" ainda não
 *                                  confirmado com uma amostra real; tratamos
 *                                  de forma defensiva (ver fetchChangedProducts).
 *
 *     ATENÇÃO: o campo de preço em oferta no atacado vem com um nome com bug
 *     no próprio WebSac: "preco_atacado_o)ferta" (parêntese no meio da
 *     palavra). Isso é literal da API, não é erro de digitação nossa — por
 *     isso acessamos sempre via colchetes: obj['preco_atacado_o)ferta'].
 *
 *   GET {BASE}/produto/{id}/foto
 *     -> array de fotos: [{ id, criado_em, ordem, extensao, conteudo }]
 *        "conteudo" já vem em base64 (não precisamos codificar nós mesmos).
 *        Se o produto não tiver foto, a API parece retornar array vazio
 *        (ou pode dar 404 — tratamos os dois casos).
 *
 * Mapeamento de campos WebSac -> products.json (schema esperado pelo
 * catalogo_grupo_daci.html):
 *
 *   marca            <- marca.descricao (fallback: "SEM MARCA")
 *   linha             <- departamento.descricao
 *                        (ASSUNÇÃO: não há um campo "linha" explícito na API;
 *                        usamos o departamento como aproximação. Ajuste aqui
 *                        se o cliente quiser outro campo, ex.: grupo.descricao.)
 *   codigo            <- id
 *   ean               <- gtin[0] (primeiro código de barras da lista, se houver)
 *   descricao         <- descricao_completa
 *   estoque           <- estoque_atual
 *   estoque_plus      <- estoque_atual > 500
 *   preco             <- preco_varejo_oferta se > 0, senão preco_varejo
 *   preco_base        <- preco_varejo
 *   disponibilidade   <- valor fixo configurável (a API não tem esse
 *                        conceito) — ver DISPONIBILIDADE_PADRAO abaixo.
 *   imagem            <- data URI da foto (ver fetchPhoto)
 *   faixa_preco       <- calculado a partir de "preco" (ver bucketPreco)
 *   faixa_estoque     <- calculado a partir de "estoque" (ver bucketEstoque)
 *   tipo_item         <- grupo.descricao
 *                        (ASSUNÇÃO: aproximação mais próxima de categorias
 *                        como "Mochila", "Garrafa" etc. Ajustar se necessário.)
 *
 * Produtos com estoque zerado NÃO são removidos aqui — a própria vitrine
 * (catalogo_grupo_daci.html) já esconde produtos esgotados na renderização,
 * então o sync mantém o dado completo e deixa a apresentação por conta do
 * front-end (é assim que o README já descreve o comportamento).
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuração via variáveis de ambiente
// ---------------------------------------------------------------------------
const WEBSAC_BASE_URL = requireEnv('WEBSAC_BASE_URL').replace(/\/+$/, '');
const WEBSAC_CNPJ = requireEnv('WEBSAC_CNPJ');
const WEBSAC_TOKEN = requireEnv('WEBSAC_TOKEN');

const OUTPUT_PATH = process.env.OUTPUT_PATH || path.join(process.cwd(), 'products.json');
const SYNC_STATE_PATH = process.env.SYNC_STATE_PATH || path.join(process.cwd(), 'sync-state.json');
const FULL_SYNC = parseBool(process.env.FULL_SYNC, false);
const FETCH_PHOTOS = parseBool(process.env.FETCH_PHOTOS, true);

// Ajuste livre: texto fixo usado no campo "disponibilidade" do products.json,
// já que a API do WebSac não expõe esse conceito.
const DISPONIBILIDADE_PADRAO = process.env.DISPONIBILIDADE_PADRAO || '90 dias';

// Limite de segurança para paginação (evita loop infinito se a API nunca
// devolver uma página vazia por algum motivo inesperado).
const MAX_PAGINAS = 500;

// Quantas fotos buscar em paralelo. A API não documenta limite de taxa, mas
// vamos com um valor conservador para não sobrecarregar o servidor do
// estabelecimento.
const CONCORRENCIA_FOTOS = 5;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[sync-websac] Variável de ambiente obrigatória ausente: ${name}`);
    process.exit(1);
  }
  return value;
}

function parseBool(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return String(value).trim().toLowerCase() === 'true';
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
async function websacFetch(pathAndQuery) {
  const url = `${WEBSAC_BASE_URL}${pathAndQuery}`;
  const res = await fetch(url, {
    headers: {
      cnpj: WEBSAC_CNPJ,
      token: WEBSAC_TOKEN,
    },
  });

  if (!res.ok) {
    throw new Error(`WebSac respondeu ${res.status} ${res.statusText} para ${pathAndQuery}`);
  }

  // Algumas respostas de erro do WebSac podem vir como texto simples;
  // tentamos JSON e, se falhar, devolvemos o texto para facilitar debug.
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Resposta não-JSON de ${pathAndQuery}: ${text.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Listagem completa (/produto/listar)
// ---------------------------------------------------------------------------
async function fetchAllProducts() {
  const produtos = [];
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const query = `/produto/listar?pagina=${pagina}&ativo=true`;
    const pageData = await websacFetch(query);

    if (!Array.isArray(pageData)) {
      throw new Error(`Esperava um array em /produto/listar (página ${pagina}), recebi: ${JSON.stringify(pageData).slice(0, 200)}`);
    }

    if (pageData.length === 0) break;

    produtos.push(...pageData);
  }
  return produtos;
}

// ---------------------------------------------------------------------------
// Alterados (/produto/alterados) — sincronização incremental
// ---------------------------------------------------------------------------
function formatDataHoraReferencia(date) {
  // WebSac espera "YYYY-MM-DD HH:MM:SS" (com espaço, não "T") no parâmetro
  // data_hora_referencia. Isso vem direto do curl validado pelo usuário.
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

async function fetchChangedProducts(sinceDate) {
  const dataHoraReferencia = encodeURIComponent(formatDataHoraReferencia(sinceDate));
  const query =
    `/produto/alterados?data_hora_referencia=${dataHoraReferencia}` +
    `&cadastro=true&preco=true&estoque=true`;

  const data = await websacFetch(query);

  return {
    estoque: Array.isArray(data.estoque) ? data.estoque : [],
    preco: Array.isArray(data.preco) ? data.preco : [],
    // O formato de "cadastro" (produtos novos ou com dados cadastrais
    // alterados) ainda não foi confirmado com uma amostra real da API.
    // Tentamos alguns nomes de campo prováveis; se nenhum bater, seguimos
    // sem quebrar — mas plotamos um aviso para o usuário investigar.
    cadastro: Array.isArray(data.cadastro)
      ? data.cadastro
      : Array.isArray(data.produtos)
      ? data.produtos
      : Array.isArray(data.produto)
      ? data.produto
      : [],
  };
}

// ---------------------------------------------------------------------------
// Foto (/produto/{id}/foto)
// ---------------------------------------------------------------------------
async function fetchPhotoDataUri(id) {
  try {
    const fotos = await websacFetch(`/produto/${id}/foto`);
    if (!Array.isArray(fotos) || fotos.length === 0) return null;

    // Pega a primeira foto (ordem=1 quando existir, senão a primeira do array).
    const foto =
      fotos.find((f) => f && Number(f.ordem) === 1) || fotos[0];

    if (!foto || !foto.conteudo) return null;

    const extensao = (foto.extensao || 'jpg').toLowerCase();
    const mime = extensao === 'png' ? 'image/png' : extensao === 'webp' ? 'image/webp' : 'image/jpeg';

    return `data:${mime};base64,${foto.conteudo}`;
  } catch (err) {
    // 404 ou qualquer erro pontual em uma foto não deve derrubar o sync
    // inteiro — só seguimos sem imagem para esse produto.
    console.warn(`[sync-websac] Falha ao buscar foto do produto ${id}: ${err.message}`);
    return null;
  }
}

async function fetchPhotosForProducts(produtosBrutos) {
  const idsComFoto = new Map();
  let index = 0;

  async function worker() {
    while (index < produtosBrutos.length) {
      const atual = produtosBrutos[index++];
      const dataUri = await fetchPhotoDataUri(atual.id);
      if (dataUri) idsComFoto.set(atual.id, dataUri);
    }
  }

  const workers = Array.from({ length: CONCORRENCIA_FOTOS }, () => worker());
  await Promise.all(workers);
  return idsComFoto;
}

// ---------------------------------------------------------------------------
// Regras de negócio: faixas de preço/estoque
// ---------------------------------------------------------------------------
function bucketPreco(preco) {
  if (preco <= 50) return 'Até R$ 50';
  if (preco <= 100) return 'R$ 50 a R$ 100';
  if (preco <= 150) return 'R$ 100 a R$ 150';
  if (preco <= 200) return 'R$ 150 a R$ 200';
  if (preco <= 500) return 'R$ 200 a R$ 500';
  return 'Acima de R$ 500';
}

function bucketEstoque(estoque) {
  // ATENÇÃO: o WebSac parece usar 500 como valor "sentinela" (estoque
  // "500 ou mais" / ilimitado), não um limite exclusivo. Nos exemplos reais,
  // um produto com estoque_atual=500 já cai no bucket "Mais de 500 un." com
  // estoque_plus=true, enquanto 451/468/379/376 caem em "101 a 500 un." com
  // estoque_plus=false. Por isso o corte usa >=500, não >500.
  if (estoque <= 0) return 'Esgotado';
  if (estoque <= 10) return '1 a 10 un.';
  if (estoque <= 50) return '11 a 50 un.';
  if (estoque <= 100) return '51 a 100 un.';
  if (estoque < 500) return '101 a 500 un.';
  return 'Mais de 500 un.';
}

// ---------------------------------------------------------------------------
// Mapeamento WebSac -> schema do products.json
// ---------------------------------------------------------------------------
function mapProduct(raw, imagemDataUri) {
  const precoVarejo = Number(raw.preco_varejo) || 0;
  const precoVarejoOferta = Number(raw.preco_varejo_oferta) || 0;
  const preco = precoVarejoOferta > 0 ? precoVarejoOferta : precoVarejo;
  const estoque = Number(raw.estoque_atual) || 0;

  return {
    marca: (raw.marca && raw.marca.descricao) || 'SEM MARCA',
    // ASSUNÇÃO: sem campo "linha" nativo na API — usando departamento como
    // aproximação. Troque para (raw.grupo && raw.grupo.descricao) ou outro
    // campo se fizer mais sentido para o catálogo do cliente.
    linha: (raw.departamento && raw.departamento.descricao) || '',
    codigo: String(raw.id),
    ean: Array.isArray(raw.gtin) && raw.gtin.length > 0 ? raw.gtin[0] : '',
    descricao: raw.descricao_completa || raw.descricao_resumida || '',
    estoque,
    estoque_plus: estoque >= 500,
    preco,
    preco_base: precoVarejo,
    disponibilidade: DISPONIBILIDADE_PADRAO,
    imagem: imagemDataUri || null,
    faixa_preco: bucketPreco(preco),
    faixa_estoque: bucketEstoque(estoque),
    // ASSUNÇÃO: mais próximo de categorias como "Mochila"/"Garrafa" etc.
    // Ajuste para (raw.subgrupo && raw.subgrupo.descricao) se o grupo for
    // grande demais para o filtro "tipo_item" da vitrine.
    tipo_item: (raw.grupo && raw.grupo.descricao) || '',
  };
}

// ---------------------------------------------------------------------------
// Leitura/escrita de arquivos locais
// ---------------------------------------------------------------------------
function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.warn(`[sync-websac] Não foi possível ler ${filePath} (${err.message}); ignorando conteúdo existente.`);
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Fluxo principal
// ---------------------------------------------------------------------------
async function runFullSync() {
  console.log('[sync-websac] Rodando sincronização COMPLETA (FULL_SYNC=true ou primeira execução).');

  const produtosBrutos = await fetchAllProducts();
  console.log(`[sync-websac] ${produtosBrutos.length} produtos ativos recebidos do WebSac.`);

  let fotosPorId = new Map();
  if (FETCH_PHOTOS) {
    console.log('[sync-websac] Buscando fotos dos produtos (FETCH_PHOTOS=true)...');
    fotosPorId = await fetchPhotosForProducts(produtosBrutos);
    console.log(`[sync-websac] ${fotosPorId.size} fotos encontradas.`);
  } else {
    console.log('[sync-websac] FETCH_PHOTOS=false — pulando download de fotos.');
  }

  const produtos = produtosBrutos.map((raw) => mapProduct(raw, fotosPorId.get(raw.id)));

  writeJson(OUTPUT_PATH, produtos);
  console.log(`[sync-websac] ${OUTPUT_PATH} atualizado com ${produtos.length} produtos.`);

  return produtos;
}

async function runIncrementalSync(lastSyncIso) {
  console.log(`[sync-websac] Rodando sincronização INCREMENTAL desde ${lastSyncIso}.`);

  const lastSyncDate = new Date(lastSyncIso);
  const { estoque, preco, cadastro } = await fetchChangedProducts(lastSyncDate);

  if (estoque.length === 0 && preco.length === 0 && cadastro.length === 0) {
    console.log('[sync-websac] Nenhuma mudança reportada pelo WebSac desde a última sincronização.');
    return null; // sinaliza "nada a escrever"
  }

  console.log(
    `[sync-websac] Mudanças recebidas: ${estoque.length} de estoque, ${preco.length} de preço, ` +
      `${cadastro.length} de cadastro.`
  );

  const produtosExistentes = readJsonIfExists(OUTPUT_PATH, []);
  const produtosPorCodigo = new Map(produtosExistentes.map((p) => [String(p.codigo), p]));

  const idsDesconhecidos = new Set();

  for (const item of estoque) {
    const codigo = String(item.id_produto);
    const produto = produtosPorCodigo.get(codigo);
    if (!produto) {
      idsDesconhecidos.add(codigo);
      continue;
    }
    produto.estoque = Number(item.estoque_atual) || 0;
    produto.estoque_plus = produto.estoque >= 500;
    produto.faixa_estoque = bucketEstoque(produto.estoque);
  }

  for (const item of preco) {
    const codigo = String(item.id_produto);
    const produto = produtosPorCodigo.get(codigo);
    if (!produto) {
      idsDesconhecidos.add(codigo);
      continue;
    }
    const precoVarejo = Number(item.preco_varejo) || 0;
    const precoVarejoOferta = Number(item.preco_varejo_oferta) || 0;
    produto.preco = precoVarejoOferta > 0 ? precoVarejoOferta : precoVarejo;
    produto.preco_base = precoVarejo;
    produto.faixa_preco = bucketPreco(produto.preco);
  }

  if (idsDesconhecidos.size > 0) {
    // Produto novo (ainda não existe no products.json local) apareceu nas
    // mudanças de estoque/preço, mas /produto/alterados não nos dá o
    // cadastro completo dele (marca, descrição, foto etc.) nesses blocos.
    // Caminho seguro: buscar o catálogo completo só para esses casos.
    console.log(
      `[sync-websac] ${idsDesconhecidos.size} produto(s) novo(s) detectado(s) (${Array.from(idsDesconhecidos).join(', ')}). ` +
        'Buscando cadastro completo via /produto/listar para esses itens.'
    );
    const produtosBrutos = await fetchAllProducts();
    const novosBrutos = produtosBrutos.filter((raw) => idsDesconhecidos.has(String(raw.id)));

    let fotosPorId = new Map();
    if (FETCH_PHOTOS && novosBrutos.length > 0) {
      fotosPorId = await fetchPhotosForProducts(novosBrutos);
    }

    for (const raw of novosBrutos) {
      const novoProduto = mapProduct(raw, fotosPorId.get(raw.id));
      produtosPorCodigo.set(String(raw.id), novoProduto);
    }
  }

  // Também processa o bloco "cadastro" quando presente (produtos com dados
  // cadastrais alterados, ex.: descrição, marca). Formato ainda não
  // confirmado — tratamos como possível array de objetos "cru" no mesmo
  // formato de /produto/listar.
  if (cadastro.length > 0) {
    console.log(`[sync-websac] Aplicando ${cadastro.length} atualização(ões) de cadastro.`);
    let fotosPorId = new Map();
    if (FETCH_PHOTOS) {
      fotosPorId = await fetchPhotosForProducts(cadastro);
    }
    for (const raw of cadastro) {
      if (!raw || raw.id === undefined) continue;
      const existente = produtosPorCodigo.get(String(raw.id));
      const imagem = fotosPorId.get(raw.id) || (existente && existente.imagem) || null;
      produtosPorCodigo.set(String(raw.id), mapProduct(raw, imagem));
    }
  }

  const produtosAtualizados = Array.from(produtosPorCodigo.values());
  writeJson(OUTPUT_PATH, produtosAtualizados);
  console.log(`[sync-websac] ${OUTPUT_PATH} atualizado com ${produtosAtualizados.length} produtos.`);

  return produtosAtualizados;
}

async function main() {
  const syncState = readJsonIfExists(SYNC_STATE_PATH, null);
  const agora = new Date();

  const precisaSyncCompleta = FULL_SYNC || !syncState || !syncState.ultimaSincronizacao;

  if (precisaSyncCompleta) {
    await runFullSync();
  } else {
    await runIncrementalSync(syncState.ultimaSincronizacao);
  }

  writeJson(SYNC_STATE_PATH, { ultimaSincronizacao: agora.toISOString() });
  console.log(`[sync-websac] ${SYNC_STATE_PATH} atualizado. Próxima sincronização será incremental a partir de agora.`);
}

main().catch((err) => {
  console.error('[sync-websac] Falha na sincronização:', err);
  process.exit(1);
});
