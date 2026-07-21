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

async function fetchProductList() {
  if (CONFIG.fullSync) {
    console.log('[sync-websac] Buscando lista completa (/produto/listar)...');
    return websacGet('/produto/listar');
  }
  console.log('[sync-websac] Buscando apenas produtos alterados (/produto/alterados)...');
  try {
    return await websacGet('/produto/alterados');
  } catch (err) {
    console.warn('[sync-websac] /produto/alterados falhou, caindo para /produto/listar completo.', err.message);
    return websacGet('/produto/listar');
  }
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
  const codigo = String(raw.codigo ?? raw.id ?? '');
  const ean = String(raw.codean ?? raw.ean ?? '');
  const descricao = raw.descricao ?? raw.nome ?? '';
  const marca = raw.marca ?? raw.fabricante ?? '';
  const linha = raw.linha ?? raw.colecao ?? '';
  const preco = Number(raw.preco ?? raw.precoVenda ?? 0);
  const precoBase = Number(raw.precoBase ?? preco);
  const estoque = Number(raw.estoque ?? raw.quantidadeEstoque ?? 0);
  const estoquePlus = estoque >= 500;
  const disponibilidade = raw.disponibilidade ?? (estoque > 0 ? 'Pronta Entrega' : '90 dias');
  const tipoItem = raw.tipoItem ?? raw.categoria ?? 'Outros';
  const imagem = raw.fotoUrl || `${CONFIG.baseUrl}/produto/${raw.id ?? codigo}/foto`;

  return {
    marca,
    linha,
    codigo,
    ean,
    descricao,
    estoque,
    estoque_plus: estoquePlus,
    preco,
    preco_base: precoBase,
    disponibilidade,
    imagem,
    faixa_preco: computeFaixaPreco(preco),
    faixa_estoque: computeFaixaEstoque(estoque, estoquePlus),
    tipo_item: tipoItem,
  };
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

  const rawList = await fetchProductList();
  const rawArray = Array.isArray(rawList) ? rawList : rawList.produtos || rawList.data || [];
  console.log(`[sync-websac] ${rawArray.length} produto(s) recebido(s) do WebSac.`);

  console.log('--- EXEMPLO DE PRODUTO CRU DO WEBSAC ---');
  console.log(JSON.stringify(rawArray[0], null, 2));
  
  const mapped = rawArray.map(mapWebsacProduct);

  const existing = CONFIG.fullSync ? [] : readExistingProducts();
  const finalList = CONFIG.fullSync ? mapped : mergeProducts(existing, mapped);

  writeProductsAtomic(finalList);

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
