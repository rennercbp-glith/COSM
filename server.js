const express        = require('express');
const { Pool }       = require('pg');
const path           = require('path');
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const QRCode         = require('qrcode');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Banco de dados ──────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ─── Solana ──────────────────────────────────────────────────
const SOLANA_RPC    = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const WALLET_RENNER = process.env.WALLET_RENNER || '';
const PRECO_SOL     = parseFloat(process.env.PRECO_SOL || '0.1');
const connection    = new Connection(SOLANA_RPC, 'confirmed');

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS registros (
      id        SERIAL PRIMARY KEY,
      carteira  TEXT UNIQUE NOT NULL,
      coord_x   BIGINT NOT NULL,
      coord_y   BIGINT NOT NULL,
      coord_z   BIGINT NOT NULL,
      publico   BOOLEAN DEFAULT true,
      nome      TEXT,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pagamentos (
      id         SERIAL PRIMARY KEY,
      referencia TEXT UNIQUE NOT NULL,
      carteira   TEXT NOT NULL,
      status     TEXT DEFAULT 'pendente',
      criado_em  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('DB pronto');
}

// ─── Alocação de coordenadas ─────────────────────────────────
// Espiral áurea no plano XZ — máxima separação entre vizinhos.
// Cada espaço fica ~10 milhões de unidades do anterior.
const GAP = 10_000_000;

function alocarCoordenada(totalExistentes) {
  const theta = totalExistentes * 2.39996322972; // ângulo áureo
  const r     = GAP * Math.sqrt(totalExistentes + 1);
  return {
    x: Math.round(r * Math.cos(theta)),
    y: 0,
    z: Math.round(r * Math.sin(theta))
  };
}

// ─── Middleware ──────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ─── Rotas ───────────────────────────────────────────────────

// Preview: qual seria a próxima coordenada alocada
app.get('/api/proxima', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT COUNT(*) AS total FROM registros');
    const coord = alocarCoordenada(parseInt(rows[0].total));
    res.json(coord);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Registrar coordenada para uma carteira
// Body: { carteira: "...", tx_id: "..." (opcional por enquanto) }
app.post('/api/registrar', async (req, res) => {
  try {
    const { carteira } = req.body;
    if (!carteira) return res.status(400).json({ erro: 'carteira obrigatoria' });

    // Já tem coordenada? Devolve a existente
    const existente = await pool.query(
      'SELECT * FROM registros WHERE carteira = $1',
      [carteira]
    );
    if (existente.rows.length > 0) {
      return res.json({ coordenada: existente.rows[0], nova: false });
    }

    // Aloca próxima coordenada disponível
    const { rows: contagem } = await pool.query('SELECT COUNT(*) AS total FROM registros');
    const coord = alocarCoordenada(parseInt(contagem[0].total));

    const { rows } = await pool.query(
      `INSERT INTO registros (carteira, coord_x, coord_y, coord_z)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [carteira, coord.x, coord.y, coord.z]
    );
    res.json({ coordenada: rows[0], nova: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Buscar coordenada de uma carteira
app.get('/api/coordenada/:carteira', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM registros WHERE carteira = $1',
      [req.params.carteira]
    );
    if (!rows.length) return res.status(404).json({ erro: 'nao registrado' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Listar todas as coordenadas públicas (para exibir no mapa espacial)
app.get('/api/coordenadas', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT carteira, coord_x, coord_y, coord_z, nome
       FROM registros WHERE publico = true ORDER BY id`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Alternar visibilidade (público/privado)
app.patch('/api/privacidade', async (req, res) => {
  try {
    const { carteira, publico } = req.body;
    await pool.query(
      'UPDATE registros SET publico = $1 WHERE carteira = $2',
      [publico, carteira]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Atualizar nome do espaço
app.patch('/api/nome', async (req, res) => {
  try {
    const { carteira, nome } = req.body;
    await pool.query(
      'UPDATE registros SET nome = $1 WHERE carteira = $2',
      [nome, carteira]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── Pagamento Solana Pay ─────────────────────────────────────

// Iniciar pagamento — gera QR code e referência única
app.post('/api/pagamento/iniciar', async (req, res) => {
  try {
    const { carteira } = req.body;
    if (!carteira) return res.status(400).json({ erro: 'carteira obrigatoria' });
    if (!WALLET_RENNER) return res.status(500).json({ erro: 'WALLET_RENNER nao configurado no servidor' });

    // Já tem coordenada registrada?
    const existente = await pool.query('SELECT * FROM registros WHERE carteira = $1', [carteira]);
    if (existente.rows.length > 0) {
      return res.json({ ja_registrado: true, coordenada: existente.rows[0] });
    }

    // Gerar chave de referência única para rastrear o pagamento
    const referencia = Keypair.generate().publicKey.toBase58();

    await pool.query(
      'INSERT INTO pagamentos (referencia, carteira) VALUES ($1, $2) ON CONFLICT (referencia) DO NOTHING',
      [referencia, carteira]
    );

    // URL padrão Solana Pay
    const url = `solana:${WALLET_RENNER}?amount=${PRECO_SOL}&reference=${referencia}&label=COSM&message=Registro+de+Coordenada+COSM`;

    // QR code transparente (fundo preto, texto branco — combina com o tema)
    const qr = await QRCode.toDataURL(url, {
      width: 220, margin: 2,
      color: { dark: '#ffffff', light: '#00000000' }
    });

    res.json({ referencia, url, qr, preco: PRECO_SOL });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Verificar pagamento — consulta blockchain e registra coordenada ao confirmar
app.get('/api/pagamento/verificar/:referencia', async (req, res) => {
  try {
    const { referencia } = req.params;
    const pag = await pool.query('SELECT * FROM pagamentos WHERE referencia = $1', [referencia]);
    if (!pag.rows.length) return res.status(404).json({ erro: 'referencia nao encontrada' });

    // Já confirmado anteriormente?
    if (pag.rows[0].status === 'confirmado') {
      const reg = await pool.query('SELECT * FROM registros WHERE carteira = $1', [pag.rows[0].carteira]);
      return res.json({ status: 'confirmado', coordenada: reg.rows[0] });
    }

    // Verificar na blockchain Solana
    const refPubkey = new PublicKey(referencia);
    const sigs = await connection.getSignaturesForAddress(refPubkey, { limit: 1 });

    if (sigs.length > 0) {
      // Pagamento encontrado — registrar coordenada
      await pool.query('UPDATE pagamentos SET status = $1 WHERE referencia = $2', ['confirmado', referencia]);

      const carteira = pag.rows[0].carteira;
      const { rows: contagem } = await pool.query('SELECT COUNT(*) AS total FROM registros');
      const coord = alocarCoordenada(parseInt(contagem[0].total));

      const { rows } = await pool.query(
        `INSERT INTO registros (carteira, coord_x, coord_y, coord_z)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (carteira) DO UPDATE SET carteira = EXCLUDED.carteira
         RETURNING *`,
        [carteira, coord.x, coord.y, coord.z]
      );
      return res.json({ status: 'confirmado', coordenada: rows[0] });
    }

    // Expirado após 30 minutos?
    if (Date.now() - new Date(pag.rows[0].criado_em).getTime() > 30 * 60 * 1000) {
      await pool.query('UPDATE pagamentos SET status = $1 WHERE referencia = $2', ['expirado', referencia]);
      return res.json({ status: 'expirado' });
    }

    res.json({ status: 'pendente' });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── Start ───────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`COSM backend na porta ${PORT}`));
});
