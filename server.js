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
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const WALLET_RENNER = process.env.WALLET_RENNER || '';
const connection = new Connection(SOLANA_RPC, 'confirmed');

// Preços em SOL por combinação tipo × plano
const PRECOS = {
  pessoa:  { mensal: parseFloat(process.env.PRECO_PESSOA_MES    || '0.002'), anual: parseFloat(process.env.PRECO_PESSOA_ANUAL || '0.01'), permanente: parseFloat(process.env.PRECO_PESSOA_PERM  || '1'  ) },
  empresa: { mensal: parseFloat(process.env.PRECO_EMPRESA_MES   || '0.02' ), anual: parseFloat(process.env.PRECO_EMPRESA_ANUAL|| '0.1' ), permanente: parseFloat(process.env.PRECO_EMPRESA_PERM || '10' ) }
};
const ROYALTY_PERC = parseFloat(process.env.ROYALTY_PERC || '0.10'); // 10% sobre revendas

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS registros (
      id         SERIAL PRIMARY KEY,
      carteira   TEXT UNIQUE NOT NULL,
      coord_x    BIGINT NOT NULL,
      coord_y    BIGINT NOT NULL,
      coord_z    BIGINT NOT NULL,
      publico    BOOLEAN DEFAULT true,
      nome       TEXT,
      tipo       TEXT DEFAULT 'pessoa',
      plano      TEXT DEFAULT 'permanente',
      valido_ate TIMESTAMPTZ,
      criado_em  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE registros ADD COLUMN IF NOT EXISTS tipo        TEXT DEFAULT 'pessoa'`);
  await pool.query(`ALTER TABLE registros ADD COLUMN IF NOT EXISTS plano       TEXT DEFAULT 'permanente'`);
  await pool.query(`ALTER TABLE registros ADD COLUMN IF NOT EXISTS valido_ate  TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE registros ADD COLUMN IF NOT EXISTS url_conteudo TEXT`);
  await pool.query(`ALTER TABLE registros ADD COLUMN IF NOT EXISTS url_3d      TEXT`);

  // Garantir que nenhuma coordenada seja alocada duas vezes
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS registros_coord_unique
    ON registros (coord_x, coord_y, coord_z)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pagamentos (
      id         SERIAL PRIMARY KEY,
      referencia TEXT UNIQUE NOT NULL,
      carteira   TEXT NOT NULL,
      tipo       TEXT DEFAULT 'pessoa',
      plano      TEXT DEFAULT 'permanente',
      nome       TEXT,
      status     TEXT DEFAULT 'pendente',
      criado_em  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE pagamentos ADD COLUMN IF NOT EXISTS tipo  TEXT DEFAULT 'pessoa'`);
  await pool.query(`ALTER TABLE pagamentos ADD COLUMN IF NOT EXISTS plano TEXT DEFAULT 'permanente'`);
  await pool.query(`ALTER TABLE pagamentos ADD COLUMN IF NOT EXISTS nome  TEXT`);

  // Tabela de marketplace (revendas futuras)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketplace (
      id          SERIAL PRIMARY KEY,
      registro_id INT REFERENCES registros(id),
      vendedor    TEXT NOT NULL,
      preco_sol   NUMERIC NOT NULL,
      ativo       BOOLEAN DEFAULT true,
      criado_em   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('DB pronto');
}

// ─── Alocação de coordenadas ─────────────────────────────────
const GAP = 1_000_000;

// Esfera de Fibonacci — distribui em todas as direções (X, Y, Z)
function alocarCoordenada(totalPessoas) {
  const i     = totalPessoas;
  const phi   = Math.acos(1 - 2 * (i + 0.5) / 10000);
  const theta = i * 2.39996322972;
  const r     = GAP * Math.sqrt(i + 1);
  return {
    x: Math.round(r * Math.sin(phi) * Math.cos(theta)),
    y: Math.round(r * Math.cos(phi)),
    z: Math.round(r * Math.sin(phi) * Math.sin(theta))
  };
}

// Prefixo exclusivo no eixo X — para empresas
// Empresa 0 → 1.000.000 : 0 : 0
// Empresa 1 → 2.000.000 : 0 : 0  etc.
const BLOCO_EMPRESA = 1_000_000;
function alocarCoordenadaEmpresa(totalEmpresas) {
  return {
    x: (totalEmpresas + 1) * BLOCO_EMPRESA,
    y: 0,
    z: 0
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

// Aloca a próxima coordenada disponível dentro de uma transação já aberta.
// O advisory lock 42 serializa todas as alocações — sem race condition.
async function alocarProximaCoord(client, tipo) {
  await client.query('SELECT pg_advisory_xact_lock(42)');
  if (tipo === 'empresa') {
    const { rows } = await client.query("SELECT COUNT(*) AS total FROM registros WHERE tipo='empresa'");
    return alocarCoordenadaEmpresa(parseInt(rows[0].total));
  } else {
    const { rows } = await client.query("SELECT COUNT(*) AS total FROM registros WHERE tipo='pessoa' AND plano <> 'beta'");
    return alocarCoordenada(parseInt(rows[0].total));
  }
}

// Registrar coordenada para uma carteira
// Body: { carteira, tipo: 'pessoa'|'empresa', nome }
app.post('/api/registrar', async (req, res) => {
  const client = await pool.connect();
  try {
    const { carteira, tipo = 'pessoa', plano = 'permanente', nome = null } = req.body;
    if (!carteira) return res.status(400).json({ erro: 'carteira obrigatoria' });

    await client.query('BEGIN');

    const existente = await client.query('SELECT * FROM registros WHERE carteira = $1', [carteira]);
    if (existente.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.json({ coordenada: existente.rows[0], nova: false });
    }

    const coord = await alocarProximaCoord(client, tipo);
    const validoAte = plano === 'anual'
      ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      : null;

    const { rows } = await client.query(
      `INSERT INTO registros (carteira, coord_x, coord_y, coord_z, nome, tipo, plano, valido_ate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [carteira, coord.x, coord.y, coord.z, nome, tipo, plano, validoAte]
    );
    await client.query('COMMIT');
    res.json({ coordenada: rows[0], nova: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ erro: e.message });
  } finally {
    client.release();
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
      `SELECT carteira, coord_x, coord_y, coord_z, nome, tipo, url_conteudo, url_3d
       FROM registros WHERE publico = true ORDER BY id`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Definir URL de conteúdo para uma coordenada
// Body: { carteira, url }
app.patch('/api/url', async (req, res) => {
  try {
    const { carteira, url } = req.body;
    if (!carteira) return res.status(400).json({ erro: 'carteira obrigatoria' });
    await pool.query(
      'UPDATE registros SET url_conteudo = $1 WHERE carteira = $2',
      [url || null, carteira]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── Beta Developers — 10 vagas permanentes e gratuitas ─────
const BETA_COORDS = [
  {x:       0, y: 2000000, z:       0},
  {x:  500000, y: 2000000, z:       0},
  {x: -500000, y: 2000000, z:       0},
  {x:  250000, y: 2000000, z:  433000},
  {x: -250000, y: 2000000, z:  433000},
  {x:  250000, y: 2000000, z: -433000},
  {x: -250000, y: 2000000, z: -433000},
  {x:  500000, y: 2500000, z:  500000},
  {x: -500000, y: 2500000, z:  500000},
  {x:       0, y: 2500000, z:  500000},
];

// Lista os 10 slots com status livre/ocupado
app.get('/api/beta', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT coord_x, coord_y, coord_z, nome FROM registros WHERE plano = 'beta'`
    );
    const slots = BETA_COORDS.map((c, i) => {
      const ocp = rows.find(r => r.coord_x === c.x && r.coord_y === c.y && r.coord_z === c.z);
      return { slot: i + 1, x: c.x, y: c.y, z: c.z, ocupado: !!ocp, nome: ocp?.nome || null };
    });
    res.json(slots);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Reivindicar um slot beta
// Body: { carteira, slot (1-10), nome, url, url_3d }
app.post('/api/beta/claim', async (req, res) => {
  try {
    const { carteira, slot, nome, url, url_3d } = req.body;
    if (!carteira || !slot) return res.status(400).json({ erro: 'carteira e slot obrigatorios' });
    const idx = parseInt(slot) - 1;
    if (idx < 0 || idx >= BETA_COORDS.length) return res.status(400).json({ erro: 'slot invalido' });
    const coord = BETA_COORDS[idx];
    const { rows: taken } = await pool.query(
      `SELECT id FROM registros WHERE coord_x=$1 AND coord_y=$2 AND coord_z=$3`,
      [coord.x, coord.y, coord.z]
    );
    if (taken.length > 0) return res.status(409).json({ erro: 'slot ja ocupado' });
    const { rows: exist } = await pool.query(
      `SELECT id FROM registros WHERE carteira=$1`, [carteira]
    );
    if (exist.length > 0) return res.status(409).json({ erro: 'carteira ja registrada' });
    const { rows } = await pool.query(
      `INSERT INTO registros (carteira, coord_x, coord_y, coord_z, nome, tipo, plano, url_conteudo, url_3d)
       VALUES ($1,$2,$3,$4,$5,'pessoa','beta',$6,$7) RETURNING *`,
      [carteira, coord.x, coord.y, coord.z, nome || null, url || null, url_3d || null]
    );
    res.json({ ok: true, coordenada: rows[0] });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Definir objeto 3D nativo (.glb) para uma coordenada
// Body: { carteira, url }
app.patch('/api/url3d', async (req, res) => {
  try {
    const { carteira, url } = req.body;
    if (!carteira) return res.status(400).json({ erro: 'carteira obrigatoria' });
    await pool.query(
      'UPDATE registros SET url_3d = $1 WHERE carteira = $2',
      [url || null, carteira]
    );
    res.json({ ok: true });
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
    const { carteira, tipo = 'pessoa', plano = 'permanente', nome = null } = req.body;
    if (!carteira) return res.status(400).json({ erro: 'carteira obrigatoria' });
    if (!WALLET_RENNER) return res.status(500).json({ erro: 'WALLET_RENNER nao configurado no servidor' });

    const existente = await pool.query('SELECT * FROM registros WHERE carteira = $1', [carteira]);
    if (existente.rows.length > 0) return res.json({ ja_registrado: true, coordenada: existente.rows[0] });

    const preco = PRECOS[tipo]?.[plano] ?? 0.01;
    const referencia = Keypair.generate().publicKey.toBase58();

    await pool.query(
      'INSERT INTO pagamentos (referencia, carteira, tipo, plano, nome) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (referencia) DO NOTHING',
      [referencia, carteira, tipo, plano, nome]
    );

    const label = tipo === 'empresa' ? 'COSM+Empresa' : 'COSM';
    const msg   = `Registro+${tipo}+${plano}+COSM`;
    const url   = `solana:${WALLET_RENNER}?amount=${preco}&reference=${referencia}&label=${label}&message=${msg}`;

    const qr = await QRCode.toDataURL(url, {
      width: 220, margin: 2,
      color: { dark: '#ffffff', light: '#00000000' }
    });

    res.json({ referencia, url, qr, preco });
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
      const { carteira, tipo = 'pessoa', plano = 'permanente', nome = null } = pag.rows[0];

      // Verificar se já foi registrado (polling pode chamar múltiplas vezes)
      const jaReg = await pool.query('SELECT * FROM registros WHERE carteira = $1', [carteira]);
      if (jaReg.rows.length > 0) {
        await pool.query('UPDATE pagamentos SET status=$1 WHERE referencia=$2', ['confirmado', referencia]);
        return res.json({ status: 'confirmado', coordenada: jaReg.rows[0] });
      }

      // Alocar coordenada com lock para evitar duplicatas
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE pagamentos SET status=$1 WHERE referencia=$2', ['confirmado', referencia]);

        const coord = await alocarProximaCoord(client, tipo);
        const validoAte = plano === 'mensal'
          ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          : plano === 'anual'
          ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
          : null;

        const { rows } = await client.query(
          `INSERT INTO registros (carteira, coord_x, coord_y, coord_z, nome, tipo, plano, valido_ate)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (carteira) DO NOTHING
           RETURNING *`,
          [carteira, coord.x, coord.y, coord.z, nome, tipo, plano, validoAte]
        );
        await client.query('COMMIT');

        // Se ON CONFLICT suprimiu o insert, buscar o registro existente
        const coordenada = rows[0] || (await pool.query('SELECT * FROM registros WHERE carteira=$1', [carteira])).rows[0];
        return res.json({ status: 'confirmado', coordenada });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
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

// ─── Liberar coordenadas expiradas ───────────────────────────
async function liberarExpirados() {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM registros
       WHERE plano IN ('mensal','anual')
         AND valido_ate IS NOT NULL
         AND valido_ate < NOW()`
    );
    if (rowCount > 0) console.log(`${rowCount} coordenada(s) expirada(s) liberada(s)`);
  } catch (e) {
    console.error('Erro ao liberar expirados:', e.message);
  }
}

// ─── Start ───────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`COSM backend na porta ${PORT}`));
  liberarExpirados(); // roda uma vez ao iniciar
  setInterval(liberarExpirados, 6 * 60 * 60 * 1000); // e a cada 6 horas
});
