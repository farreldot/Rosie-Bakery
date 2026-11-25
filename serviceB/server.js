const express = require('express')
const Database = require('better-sqlite3')
const path = require('path')
const os = require('os')

const PORT = process.env.PORT || 4000
const SERVICE_A_URL = process.env.SERVICE_A_URL
const API_KEY = process.env.SERVICE_API_KEY

let db = null

// Di serverless Vercel, filesystem bersifat read-only kecuali direktori /tmp.
// Gunakan path /tmp saat di Vercel agar tidak memicu error EROFS atau FUNCTION_INVOCATION_FAILED.
function getDb() {
    if (db) return db
    try {
        const dbPath = process.env.VERCEL
            ? path.join(os.tmpdir(), 'reports.db')
            : path.join(__dirname, 'reports.db')

        db = new Database(dbPath)
        db.exec(`
          CREATE TABLE IF NOT EXISTS reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            period_type TEXT NOT NULL CHECK (period_type IN ('daily','monthly')),
            period_label TEXT NOT NULL,
            total_orders INTEGER NOT NULL,
            total_revenue INTEGER NOT NULL,
            top_products TEXT NOT NULL,
            notes TEXT DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `)
        return db
    } catch (err) {
        console.error('Gagal inisialisasi SQLite database:', err)
        return null
    }
}

// Inisialisasi awal database
getDb()

const app = express()
app.use(express.json())

// Panggilan ke Service A
async function callA(pathStr) {
    const res = await fetch(SERVICE_A_URL + pathStr, { headers: { 'x-api-key': API_KEY } })
    if (!res.ok) throw new Error(`Service A membalas ${res.status}`)
    return res.json()
}

const parse = (r) => (r ? { ...r, top_products: JSON.parse(r.top_products) } : r)

// GET / - Endpoint utama domain untuk health check & verifikasi deployment Vercel
app.get('/', (req, res) => {
    res.status(200).json({
        status: 'ok',
        service: 'rosie-report-service',
        message: 'Rosie Bakery Report Service (Service B) is running',
    })
})

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'rosie-report-service' }))

// POST /reports/generate  { period_type, period_label }
app.post('/reports/generate', async (req, res) => {
    const { period_type, period_label } = req.body || {}
    const valid =
        (period_type === 'daily' && /^\d{4}-\d{2}-\d{2}$/.test(period_label)) ||
        (period_type === 'monthly' && /^\d{4}-\d{2}$/.test(period_label))
    if (!valid) {
        return res.status(400).json({ error: 'period_type daily (YYYY-MM-DD) atau monthly (YYYY-MM)' })
    }

    const database = getDb()
    if (!database) return res.status(500).json({ error: 'Database tidak tersedia di lingkungan ini' })

    try {
        const { orders } = await callA('/api/orders')
        const inPeriod = orders.filter(
            (o) => o.status !== 'dibatalkan' && (o.created_date || '').startsWith(period_label),
        )

        const totalRevenue = inPeriod.reduce((s, o) => s + o.total, 0)
        const sold = {}
        for (const o of inPeriod) for (const it of o.items) sold[it.name] = (sold[it.name] || 0) + it.qty
        const top = Object.entries(sold)
            .map(([name, qty]) => ({ name, qty }))
            .sort((a, b) => b.qty - a.qty)
            .slice(0, 5)

        const title = `Laporan ${period_type === 'daily' ? 'Harian' : 'Bulanan'} ${period_label}`
        const info = database
            .prepare(`INSERT INTO reports (title, period_type, period_label, total_orders, total_revenue, top_products)
                VALUES (?, ?, ?, ?, ?, ?)`)
            .run(title, period_type, period_label, inPeriod.length, totalRevenue, JSON.stringify(top))

        const row = database.prepare('SELECT * FROM reports WHERE id = ?').get(info.lastInsertRowid)
        res.status(201).json(parse(row))
    } catch (e) {
        res.status(502).json({ error: 'Gagal menghubungi Service A', detail: e.message })
    }
})

// GET /reports/low-stock  (harus di atas /reports/:id)
app.get('/reports/low-stock', async (req, res) => {
    try {
        const { products } = await callA('/api/products')
        res.json({ threshold: 5, products: products.filter((p) => p.stock <= 5) })
    } catch (e) {
        res.status(502).json({ error: 'Gagal menghubungi Service A', detail: e.message })
    }
})

// GET /reports?period_type=
app.get('/reports', (req, res) => {
    const database = getDb()
    if (!database) return res.status(500).json({ error: 'Database tidak tersedia di lingkungan ini' })

    const { period_type } = req.query
    const rows = period_type
        ? database.prepare('SELECT * FROM reports WHERE period_type = ? ORDER BY id DESC').all(period_type)
        : database.prepare('SELECT * FROM reports ORDER BY id DESC').all()
    res.json({ reports: rows.map(parse) })
})

app.get('/reports/:id', (req, res) => {
    const database = getDb()
    if (!database) return res.status(500).json({ error: 'Database tidak tersedia di lingkungan ini' })

    const row = database.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id)
    if (!row) return res.status(404).json({ error: 'Laporan tidak ditemukan' })
    res.json(parse(row))
})

// PUT /reports/:id  { title, notes }
app.put('/reports/:id', (req, res) => {
    const database = getDb()
    if (!database) return res.status(500).json({ error: 'Database tidak tersedia di lingkungan ini' })

    const { title, notes } = req.body || {}
    if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title wajib diisi' })
    const info = database.prepare('UPDATE reports SET title = ?, notes = ? WHERE id = ?').run(title, notes ?? '', req.params.id)
    if (info.changes === 0) return res.status(404).json({ error: 'Laporan tidak ditemukan' })
    res.json(parse(database.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id)))
})

app.delete('/reports/:id', (req, res) => {
    const database = getDb()
    if (!database) return res.status(500).json({ error: 'Database tidak tersedia di lingkungan ini' })

    const info = database.prepare('DELETE FROM reports WHERE id = ?').run(req.params.id)
    if (info.changes === 0) return res.status(404).json({ error: 'Laporan tidak ditemukan' })
    res.json({ ok: true })
})

// Jika dijalankan langsung via node server.js di lokal
if (require.main === module) {
    app.listen(PORT, () => console.log(`Service B jalan di http://localhost:${PORT}`))
}

// Ekspor instance Express untuk serverless runtime Vercel
module.exports = app
