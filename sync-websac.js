const fs = require('fs');
const path = require('path');

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf-8');
  content.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  });
}
loadEnvFile();

const CONFIG = {
  baseUrl: process.env.WEBSAC_BASE_URL || '',
  cnpj: process.env.WEBSAC_CNPJ || '',
  token: process.env.WEBSAC_TOKEN || '',
  outputPath: process.env.OUTPUT_PATH || path.join(__dirname, 'output', 'products.json'),
  fullSync: process.env.FULL_SYNC === 'true',
  fetchPhotos: process.env.FETCH_PHOTOS !== 'false',
};

function assertConfig() {
  const missing = ['baseUrl', 'cnpj', 'token'].filter((k) => !CONFIG[k]);
  if (missing.length) {
    console.error(
      `[sync-websac] Configuração incompleta. Faltando: ${missing.join(', ')}.\n` +
      `Preencha o arquivo .env (veja .env.example) ou defina as variáveis de ambiente.`
    );
    process.exit(1);
  }
}

function websacHeaders() {
  return {
    cnpj: CONFIG.cnpj,
    token: CONFIG.token,
    'Content-Type': 'application/json',
  };
}

async function websacGet(pathname) {
  const url = `${CONFIG.baseUrl.replace(/\/$/, '')}${pathname}`;
  const res = await fetch(url, { headers: websacHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`WebSac GET ${pathname} falhou: HTTP ${res.status} ${body}`);
  }
  return res.json();
}

async function fetchProductPhoto(id) {
  try {
    const url = `${CONFIG.baseUrl.replace(/\/$/, '')}/produto/${id}/foto`;
    const res = await fetch(url, { headers: websacHeaders() });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

async function fetchPhotosInBatches(ids, batchSize = 8) {
  const photoById = new Map();
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const results = await Promise.all(batch.map((id) => fetchProductPhoto(id)));
    batch.forEach((id, idx) => photoById.set(id, results[idx]));
  }
  return photoById;
}

const SYNC_STATE_PATH = process.env.SYNC_STATE_PATH || path.join(__dirname, 'sync-state.json');

function readSyncState() {
  if (!fs.existsSync(SYNC_STATE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(SYNC_STATE_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function writeSyncState(state) {
  fs.writeFileSync(SYNC_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

function normalizeList(rawList) {
  return Array.isArray(rawList) ? rawList : rawList.produtos || rawList.data || [];
}

async function fetchChangedProducts(referenceDateIso) {
  const qs = new URLSearchParams({ dataHoraReferencia: referenceDateIso });
  return websacGet(`/produto/alterados?${qs.toString()}`);
}

function computeFaixaEstoque(estoque, estoquePlus) {
  if (estoquePlus || estoque > 500) return 'Mais de 500 un.';
  if (estoque === 0) return 'Esgotado';
  if (estoque <= 10) return '1 a 10 un.';
  if (estoque <= 50) return '11 a 50 un.';
  if (estoque <= 100) return '51 a 100 un.';
  return '101 a 500 un.';
}

function computeFaixaPreco(preco) {
  if (preco <= 50) return 'Até R$ 50';
  if (preco <= 100) return 'R$ 50 a R$ 100';
  if (preco <= 150) return 'R$ 100 a R$ 150';
  if (preco <= 250) return 'R$ 150 a R$ 250';
  return 'Acima de R$ 250';
}

function mapWebsacProduct(raw) {
  const codigo = String(raw.id ?? '');
  const ean = Array.isArray(raw.gtin) && raw.gtin.length ? String(raw.gtin[0]) : '';
  const descricao = raw.descricao_completa || raw.descricao_resumida || '';
  const marca = (raw.marca && raw.marca.descricao) || '';
  const tipoItem = (raw.departamento && raw.departamento.descricao)
    || (raw.grupo && raw.grupo.descricao)
    || 'Outros';

  const precoVarejo = Number(raw.preco_varejo || 0);
  const precoOferta = Number(raw.preco_varejo_oferta || 0);
  const preco = precoOferta > 0 ? precoOferta : precoVarejo;
  const precoBase = precoVarejo;

  const estoque = Number(raw.estoque_atual ?? 0);
  const estoquePlus = estoque >= 500;
  const disponibilidade = raw.ativo === false
    ? '90 dias'
    : (estoque > 0 ? 'Pronta Entrega' : '90 dias');

  return {
    marca,
    linha: '',
    codigo,
    ean,
    descricao,
    estoque,
    estoque_plus: estoquePlus,
    preco,
    preco_base: precoBase,
    disponibilidade,
    imagem: '',
    faixa_preco: computeFaixaPreco(preco),
    faixa_estoque: computeFaixaEstoque(estoque, estoquePlus),
    tipo_item: tipoItem,
    _id: raw.id,
  };
}

async function anexarFotos(products) {
  if (!CONFIG.fetchPhotos) {
    console.log('[sync-websac] FETCH_PHOTOS=false — pulando busca de fotos.');
    return products.map(({ _id, ...rest }) => rest);
  }
  console.log(`[sync-websac] Buscando fotos de ${products.length} produto(s)...`);
  const ids = products.map((p) => p._id);
  const photoById = await fetchPhotosInBatches(ids);
  let comFoto = 0;
  const result = products.map((p) => {
    const foto = photoById.get(p._id);
    if (foto) comFoto++;
    const { _id, ...rest } = p;
    return { ...rest, imagem: foto || '' };
  });
  console.log(`[sync-websac] ${comFoto}/${products.length} produto(s) com foto encontrada.`);
  return result;
}

function readExistingProducts() {
  if (!fs.existsSync(CONFIG.outputPath)) return [];
  try {
    const content = fs.readFileSync(CONFIG.outputPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return [];
  }
}

function mergeProducts(existing, updated) {
  const byCode = new Map(existing.map((p) => [p.codigo, p]));
  for (const p of updated) {
    byCode.set(p.codigo, p);
  }
  return Array.from(byCode.values());
}

function writeProductsAtomic(products) {
  const dir = path.dirname(CONFIG.outputPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${CONFIG.outputPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(products, null, 2), 'utf-8');
  fs.renameSync(tmpPath, CONFIG.outputPath);
}

async function main() {
  assertConfig();
  const startedAt = Date.now();
  console.log(`[sync-websac] Iniciando sincronização (${new Date().toISOString()})`);

  const hasExisting = fs.existsSync(CONFIG.outputPath);
  const syncState = readSyncState();
  const nowIso = new Date().toISOString();

  let rawArray;
  let isBootstrap = false;

  if (CONFIG.fullSync || !hasExisting || !syncState) {
    console.log('[sync-websac] Primeira execução (ou FULL_SYNC=true) — buscando lista completa.');
    rawArray = normalizeList(await websacGet('/produto/listar'));
    isBootstrap = true;
  } else {
    try {
      rawArray = normalizeList(await fetchChangedProducts(syncState.lastSync));
    } catch (err) {
      console.warn('[sync-websac] Não foi possível checar alterações agora — mantendo o products.json como está.', err.message);
      console.log('[sync-websac] Nada a fazer nesta execução.');
      return;
    }
  }

  console.log(`[sync-websac] ${rawArray.length} produto(s) recebido(s) do WebSac.`);

  if (!isBootstrap && rawArray.length === 0) {
    console.log('[sync-websac] Nenhuma mudança de estoque/preço reportada pelo WebSac. Nada a fazer.');
    writeSyncState({ lastSync: nowIso });
    return;
  }

  let mapped = rawArray.map(mapWebsacProduct);
  mapped = await anexarFotos(mapped);

  const existing = isBootstrap ? [] : readExistingProducts();
  const finalList = isBootstrap ? mapped : mergeProducts(existing, mapped);

  writeProductsAtomic(finalList);
  writeSyncState({ lastSync: nowIso });

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[sync-websac] Concluído em ${elapsedSec}s. ` +
    `${finalList.length} produto(s) no total gravado(s) em ${CONFIG.outputPath}.`
  );
}

main().catch((err) => {
  console.error('[sync-websac] Erro fatal:', err);
  process.exit(1);
});
