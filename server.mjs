import http from 'node:http';
import { readFile, writeFile, stat, copyFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.env.PORT || 4000);
const PUBLIC_DIR = process.env.PUBLIC_DIR || join(process.cwd(), '../frontend/public');
const DATA_DIR = join(process.cwd(), 'data');
const SEED_FILE = join(DATA_DIR, 'seed-data.json');
const DB_FILE = join(DATA_DIR, 'gynaeq-db.json');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf'
};

// Ensure data folder and db file exist
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(PUBLIC_DIR, { recursive: true });

async function initDb() {
  if (!existsSync(DB_FILE)) {
    if (existsSync(SEED_FILE)) {
      await copyFile(SEED_FILE, DB_FILE);
      console.log('Database initialized from seed data.');
    } else {
      await writeFile(DB_FILE, JSON.stringify({ products: [], enquiries: [], quotations: [] }, null, 2));
    }
  }
}

await initDb();

async function readDb() {
  try {
    const raw = await readFile(DB_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading DB:', err);
    if (existsSync(SEED_FILE)) {
      const raw = await readFile(SEED_FILE, 'utf-8');
      return JSON.parse(raw);
    }
    return {};
  }
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) { // 5MB limit
        req.destroy();
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // Handle CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // ─── API ROUTES ───────────────────────────────────────────────────────────
  if (pathname.startsWith('/api/')) {
    try {
      // GET /api/data
      if (req.method === 'GET' && pathname === '/api/data') {
        const db = await readDb();
        return sendJson(res, 200, db);
      }

      // POST /api/enquiries (New RFQ from website or admin)
      if (req.method === 'POST' && pathname === '/api/enquiries') {
        const body = await parseJsonBody(req);
        const db = await readDb();
        const refNum = `RFQ-${new Date().getFullYear()}-${String(Math.floor(1000 + Math.random() * 9000))}`;
        const newEnquiry = {
          id: `enq-${Date.now()}`,
          ref: body.ref || refNum,
          facilityName: body.facilityName || 'Private Medical Facility',
          contactName: body.contactName || 'Healthcare Professional',
          role: body.role || 'Doctor / Clinician',
          email: body.email || '',
          phone: body.phone || '',
          city: body.city || 'Dubai',
          country: body.country || 'UAE',
          productRequested: body.productRequested || 'Medical Equipment Inquiry',
          productId: body.productId || null,
          quantity: Number(body.quantity) || 1,
          estimatedBudget: Number(body.estimatedBudget) || 0,
          urgency: body.urgency || 'Standard',
          status: body.status || 'New',
          priority: body.priority || 'High',
          notes: body.notes || '',
          assignedTo: body.assignedTo || 'Fuhad (Super Admin)',
          createdAt: new Date().toISOString()
        };
        db.enquiries = [newEnquiry, ...(db.enquiries || [])];
        await writeDb(db);
        return sendJson(res, 201, { success: true, enquiry: newEnquiry });
      }

      // PATCH/PUT /api/enquiries/:id
      if ((req.method === 'PATCH' || req.method === 'PUT') && pathname.startsWith('/api/enquiries/')) {
        const id = pathname.replace('/api/enquiries/', '');
        const body = await parseJsonBody(req);
        const db = await readDb();
        const index = (db.enquiries || []).findIndex(e => e.id === id);
        if (index === -1) {
          return sendJson(res, 404, { error: 'Enquiry not found' });
        }
        db.enquiries[index] = { ...db.enquiries[index], ...body, updatedAt: new Date().toISOString() };
        await writeDb(db);
        return sendJson(res, 200, { success: true, enquiry: db.enquiries[index] });
      }

      // POST /api/products (Supports both FastonMed format and GYNAEQ format)
      if (req.method === 'POST' && pathname === '/api/products') {
        const body = await parseJsonBody(req);
        const db = await readDb();
        const title = body.name || body.title || 'Medical Equipment Machine';
        const price = Number(body.sellingPrice !== undefined ? body.sellingPrice : body.price) || 0;
        const purchaseCost = Number(body.purchaseCost) || Math.round(price * 0.75);
        const categoryName = body.category || body.categoryName || 'Ultrasound & Fetal Imaging';
        const brand = body.brand || body.traderCompanyName || 'GYNAEQ Partner';
        const model = body.model || body.sku || 'Model Pro';
        const sku = body.sku || (model ? `GNQ-${model.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8)}` : `GNQ-EQ-${Math.floor(100 + Math.random() * 900)}`);
        const leadTime = body.deliveryLeadTime || body.leadTime || '3 - 5 Days (UAE Stock)';
        const warranty = body.warrantyPeriod || body.warranty || '2 Years Official Warranty';
        const description = body.description || body.shortDesc || `High-performance medical equipment by ${brand}.`;

        const newProduct = {
          id: body.id || `gnq-${Date.now()}`,
          sku: sku,
          title: title,
          name: title,
          brand: brand,
          brandId: brand.toLowerCase().replace(/[^a-z0-9]/g, '-'),
          model: model,
          categoryId: (body.categoryId || categoryName.toLowerCase().replace(/[^a-z0-9]/g, '-')).slice(0, 24),
          categoryName: categoryName,
          category: categoryName,
          price: price,
          sellingPrice: price,
          purchaseCost: purchaseCost,
          vatStatus: body.vatStatus || '5% Standard Rate (UAE VAT)',
          currency: 'AED',
          callForPrice: Boolean(body.callForPrice),
          inStock: Number(body.inStock) > 0 || body.inStock === true || body.inStock === undefined,
          inStockCount: Number(body.inStock) || (body.inStock === false ? 0 : 5),
          stockStatus: Number(body.inStock) > 0 || body.inStock !== false ? 'In Stock (Dubai Warehouse)' : 'Out of Stock',
          traderCompanyId: body.traderCompanyId || 'trader-ge-healthcare',
          traderCompanyName: body.traderCompanyName || brand || 'GE Healthcare UAE',
          deliveryLeadTime: leadTime,
          leadTime: leadTime,
          traderPriceMin: Number(body.traderPriceMin) || purchaseCost,
          traderPriceMax: Number(body.traderPriceMax) || price,
          warranty: warranty,
          warrantyPeriod: warranty,
          certifications: body.certifications || ['CE Mark', 'MoHAP Registered', 'ISO 13485'],
          image: body.image || '/assets/ultrasound.jpg',
          badge: body.badge || 'New Medical Equipment',
          rating: 5.0,
          reviewsCount: 1,
          shortDesc: description,
          description: description,
          specifications: body.specifications || {
            'Category': categoryName,
            'Brand / Manufacturer': brand,
            'Model': model,
            'Lead Time': leadTime,
            'Warranty': warranty
          },
          features: body.features || [
            'DHA / MoHAP Registered & Approved',
            'Factory calibrated for UAE clinical compliance',
            'Full biomedical commissioning & user training included'
          ],
          createdAt: new Date().toISOString()
        };
        db.products = [newProduct, ...(db.products || [])];
        await writeDb(db);
        return sendJson(res, 201, { success: true, product: newProduct });
      }

      // PUT /api/products/:id
      if (req.method === 'PUT' && pathname.startsWith('/api/products/')) {
        const id = pathname.replace('/api/products/', '');
        const body = await parseJsonBody(req);
        const db = await readDb();
        const index = (db.products || []).findIndex(p => p.id === id);
        if (index === -1) {
          return sendJson(res, 404, { error: 'Product not found' });
        }
        const existing = db.products[index];
        const title = body.name || body.title || existing.title || existing.name;
        const price = Number(body.sellingPrice !== undefined ? body.sellingPrice : (body.price !== undefined ? body.price : existing.price));
        const purchaseCost = Number(body.purchaseCost !== undefined ? body.purchaseCost : existing.purchaseCost);

        db.products[index] = {
          ...existing,
          ...body,
          title: title,
          name: title,
          price: price,
          sellingPrice: price,
          purchaseCost: purchaseCost,
          categoryName: body.category || body.categoryName || existing.categoryName,
          category: body.category || body.categoryName || existing.category,
          updatedAt: new Date().toISOString()
        };
        await writeDb(db);
        return sendJson(res, 200, { success: true, product: db.products[index] });
      }

      // DELETE /api/products/:id or /api/products?id=...
      if (req.method === 'DELETE' && (pathname.startsWith('/api/products/') || pathname === '/api/products')) {
        const id = pathname.startsWith('/api/products/') ? pathname.replace('/api/products/', '') : url.searchParams.get('id');
        const db = await readDb();
        db.products = (db.products || []).filter(p => p.id !== id);
        await writeDb(db);
        return sendJson(res, 200, { success: true });
      }

      // POST /api/quotations
      if (req.method === 'POST' && pathname === '/api/quotations') {
        const body = await parseJsonBody(req);
        const db = await readDb();
        const quoteNum = `GNQ-QT-${new Date().getFullYear()}-${String(Math.floor(100 + Math.random() * 900))}`;
        const newQuote = {
          id: `qt-${Date.now()}`,
          quoteNumber: body.quoteNumber || quoteNum,
          clientId: body.clientId || 'org-custom',
          clientName: body.clientName || 'Healthcare Facility',
          contactPerson: body.contactPerson || 'Procurement In-Charge',
          email: body.email || '',
          phone: body.phone || '',
          city: body.city || 'Dubai, UAE',
          date: body.date || new Date().toISOString().split('T')[0],
          validUntil: body.validUntil || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
          items: body.items || [],
          subtotal: Number(body.subtotal) || 0,
          vatRate: 0.05,
          vatAmount: Number(body.vatAmount) || 0,
          total: Number(body.total) || 0,
          currency: 'AED',
          paymentTerms: body.paymentTerms || '30% Advance with LPO, 70% upon delivery & commissioning',
          deliveryLeadTime: body.deliveryLeadTime || '14 Working Days from official purchase order',
          warrantyTerms: body.warrantyTerms || '24 Months Comprehensive Parts & Biomedical Labor Warranty',
          status: body.status || 'Drafted',
          preparedBy: body.preparedBy || 'Fuhad (Super Admin)'
        };
        db.quotations = [newQuote, ...(db.quotations || [])];
        await writeDb(db);
        return sendJson(res, 201, { success: true, quotation: newQuote });
      }

      // POST /api/amcs
      if (req.method === 'POST' && pathname === '/api/amcs') {
        const body = await parseJsonBody(req);
        const db = await readDb();
        const contractNum = `GNQ-AMC-${new Date().getFullYear()}-${String(Math.floor(100 + Math.random() * 900))}`;
        const newAmc = {
          id: `amc-${Date.now()}`,
          contractNumber: body.contractNumber || contractNum,
          clientId: body.clientId,
          clientName: body.clientName,
          equipment: body.equipment,
          type: body.type || 'Comprehensive Platinum AMC',
          startDate: body.startDate || new Date().toISOString().split('T')[0],
          endDate: body.endDate || new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0],
          status: 'Active',
          lastInspection: new Date().toISOString().split('T')[0],
          nextDue: body.nextDue || new Date(Date.now() + 90 * 86400000).toISOString().split('T')[0],
          assignedEngineer: body.assignedEngineer || 'Hashim',
          annualFee: Number(body.annualFee) || 20000,
          currency: 'AED'
        };
        db.amcContracts = [newAmc, ...(db.amcContracts || [])];
        await writeDb(db);
        return sendJson(res, 201, { success: true, contract: newAmc });
      }

      // POST /api/reset
      if (req.method === 'POST' && pathname === '/api/reset') {
        if (existsSync(SEED_FILE)) {
          await copyFile(SEED_FILE, DB_FILE);
          const db = await readDb();
          return sendJson(res, 200, { success: true, message: 'Database reset to seed data', data: db });
        }
      }

      return sendJson(res, 404, { error: 'API route not found' });
    } catch (apiErr) {
      console.error('API Error:', apiErr);
      return sendJson(res, 500, { error: apiErr.message });
    }
  }

  // ─── STATIC FILE SERVING ──────────────────────────────────────────────────
  try {
    let filePath;
    const cleanPath = normalize(pathname).replace(/^(\.\.[\/\\])+/, '').replace(/^\//, '');

    if (pathname === '/' || pathname === '/index.html') {
      filePath = join(PUBLIC_DIR, 'index.html');
    } else if (pathname === '/admin' || pathname === '/admin.html') {
      filePath = join(PUBLIC_DIR, 'admin.html');
    } else if (pathname === '/shop' || pathname === '/shop.html') {
      filePath = join(PUBLIC_DIR, 'shop.html');
    } else if (pathname === '/product' || pathname.startsWith('/product/') || pathname === '/product.html') {
      filePath = join(PUBLIC_DIR, 'product.html');
    } else if (pathname === '/category' || pathname.startsWith('/category/') || pathname === '/category.html') {
      filePath = join(PUBLIC_DIR, 'category.html');
    } else if (pathname === '/about' || pathname === '/about.html') {
      filePath = join(PUBLIC_DIR, 'about.html');
    } else if (pathname === '/contact' || pathname === '/contact.html') {
      filePath = join(PUBLIC_DIR, 'contact.html');
    } else if (pathname === '/packages' || pathname === '/packages.html') {
      filePath = join(PUBLIC_DIR, 'packages.html');
    } else if (pathname === '/compare' || pathname === '/compare.html') {
      filePath = join(PUBLIC_DIR, 'compare.html');
    } else {
      filePath = join(PUBLIC_DIR, cleanPath);
      if (!existsSync(filePath) && existsSync(filePath + '.html')) {
        filePath = filePath + '.html';
      }
    }

    try {
      const stats = await stat(filePath);
      if (stats.isDirectory()) {
        filePath = join(filePath, 'index.html');
      }
    } catch {
      // Fallback
      if (!extname(filePath)) {
        filePath = join(PUBLIC_DIR, 'index.html');
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404 Not Found');
      }
    }

    const content = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end(content);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 Internal Server Error');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`✨ GYNAEQ Healthcare Technologies Server Live!`);
  console.log(`🌐 Public Storefront: http://localhost:${PORT}/`);
  console.log(`🛡️  Admin CRM Portal:  http://localhost:${PORT}/admin`);
  console.log(`======================================================\n`);
});
