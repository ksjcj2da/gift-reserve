import { neon } from '@neondatabase/serverless';

const BRANCHES = ['본점', '동부점', '서부지점'];
const PRODUCTS = ['한우 세트', '과일 세트', '쌀 세트'];

let sql = null;
let tableReady = null;

function getSql() {
  if (!process.env.DATABASE_URL) {
    const err = new Error('DATABASE_URL 환경 변수가 설정되지 않았습니다.');
    err.code = 'NO_DB_URL';
    throw err;
  }
  if (!sql) sql = neon(process.env.DATABASE_URL);
  return sql;
}

function ensureTable(db) {
  if (!tableReady) {
    tableReady = (async () => {
      await db`
        CREATE TABLE IF NOT EXISTS reservations (
          id           SERIAL PRIMARY KEY,
          name         TEXT        NOT NULL,
          branch       TEXT        NOT NULL,
          product      TEXT        NOT NULL,
          quantity     INTEGER     NOT NULL CHECK (quantity > 0),
          pickup_date  DATE        NOT NULL,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;

    })().catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

function todayKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  return body && typeof body === 'object' ? body : null;
}

function validate(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';

  const branch = body.branch;
  const product = body.product;
  const quantity = Number(body.quantity);
  const pickupDate = body.pickupDate;

  if (!name) return { error: '이름을 입력해 주세요.' };
  if (name.length > 30) return { error: '이름은 30자 이내로 입력해 주세요.' };
  if (!BRANCHES.includes(branch)) return { error: '받을 지점이 올바르지 않습니다.' };
  if (!PRODUCTS.includes(product)) return { error: '상품이 올바르지 않습니다.' };
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    return { error: '수량은 1에서 99 사이로 입력해 주세요.' };
  }
  if (!isValidDate(pickupDate)) return { error: '받을 날짜가 올바르지 않습니다.' };
  if (pickupDate < todayKST()) return { error: '받을 날짜는 오늘 이후로 선택해 주세요.' };

  return { value: { name, branch, product, quantity, pickupDate } };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: '허용되지 않은 요청입니다.' });
  }

  try {
    const db = getSql();
    await ensureTable(db);

    if (req.method === 'POST') {
      const body = parseBody(req);

      if (!body) return res.status(400).json({ error: '요청 형식이 올바르지 않습니다.' });

      const { error, value } = validate(body);
      if (error) return res.status(400).json({ error });

      const rows = await db`
        INSERT INTO reservations (name, branch, product, quantity, pickup_date)
        VALUES (${value.name}, ${value.branch}, ${value.product}, ${value.quantity}, ${value.pickupDate})
        RETURNING
          id,
          name,
          branch,
          product,
          quantity,
          to_char(pickup_date, 'YYYY-MM-DD') AS "pickupDate",
          to_char(created_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS "createdAt"
      `;

      return res.status(201).json({ reservation: rows[0] });
    }

    const rows = await db`
      SELECT
        id,
        name,
        branch,
        product,
        quantity,
        to_char(pickup_date, 'YYYY-MM-DD') AS "pickupDate",
        to_char(created_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS "createdAt"
      FROM reservations
      ORDER BY id DESC

      LIMIT 50
    `;

    return res.status(200).json({ reservations: rows });
  } catch (err) {
    console.error('[api/reserve]', err);
    if (err.code === 'NO_DB_URL') {
      return res.status(500).json({ error: '서버 설정 오류: 데이터베이스 주소가 없습니다.' });
    }
    return res.status(500).json({ error: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
}
