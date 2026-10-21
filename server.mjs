import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, stat, copyFile, rename, readdir, realpath } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.env.PORT || 4000);
const PUBLIC_DIR = process.env.PUBLIC_DIR || join(process.cwd(), '../frontend');
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
const SEED_FILE = join(process.cwd(), 'data/seed-data.json');
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
  const tempFile = DB_FILE + '.' + randomBytes(8).toString('hex') + '.tmp';
  await writeFile(tempFile, JSON.stringify(data, null, 2), 'utf-8');
  await rename(tempFile, DB_FILE);
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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

let storagePauseUntil = 0;
const sessions = new Map();
const loginAttempts = new Map();
const allowedOrigins = new Set(['https://www.gynaeq.com', 'https://gynaeq.com']);
if (process.env.DEV_ORIGIN) allowedOrigins.add(process.env.DEV_ORIGIN);
function authenticated(req) {
  const token = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('gynaeq_session='))?.slice(15);
  const expiry = sessions.get(token);
  if (!expiry || expiry < Date.now()) { sessions.delete(token); return false; }
  return true;
}
function equalSecret(a, b) {
  const hash = v => createHash('sha256').update(String(v)).digest();
  return timingSafeEqual(hash(a), hash(b));
}
function sessionCookie(token, age) {
  return `gynaeq_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=${age}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  if (pathname.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  if (origin && !allowedOrigins.has(origin) && !['GET', 'HEAD'].includes(req.method)) {
    return sendJson(res, 403, { error: 'Origin not allowed' });
  }

  // Handle CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // ─── API ROUTES ───────────────────────────────────────────────────────────
  if (pathname.startsWith('/api/')) {
    try {
      if (pathname === '/api/auth/login' && req.method === 'POST') {
        if (!process.env.ADMIN_PASSWORD) return sendJson(res, 503, { error: 'Administrator password has not been configured in hosting yet.' });
        const key = req.socket.remoteAddress;
        const now = Date.now();
        let attempt = loginAttempts.get(key);
        if (!attempt || attempt.until < now) { attempt = { count: 0, until: now + 900000 }; loginAttempts.set(key, attempt); }
        if (++attempt.count > 10) return sendJson(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
        const body = await parseJsonBody(req);
        if (!equalSecret(String(body.email || '').trim().toLowerCase(), (process.env.ADMIN_EMAIL || 'fastonmed@gmail.com').toLowerCase()) || !equalSecret(body.password || '', process.env.ADMIN_PASSWORD)) {
          return sendJson(res, 401, { error: 'Incorrect email or password.' });
        }
        const token = randomBytes(32).toString('hex');
        for (const [key, expiry] of sessions) if (expiry < now) sessions.delete(key);
        sessions.set(token, now + 28800000);
        loginAttempts.delete(key);
        res.setHeader('Set-Cookie', sessionCookie(token, 28800));
        return sendJson(res, 200, { success: true });
      }
      if (pathname === '/api/auth/me' && req.method === 'GET') {
        return sendJson(res, authenticated(req) ? 200 : 401, { authenticated: authenticated(req) });
      }
      if (pathname === '/api/auth/logout' && req.method === 'POST') {
        const token = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('gynaeq_session='))?.slice(15);
        sessions.delete(token);
        res.setHeader('Set-Cookie', sessionCookie('', 0));
        return sendJson(res, 200, { success: true });
      }
      const isAdmin = authenticated(req);
      if (Date.now() < storagePauseUntil && !['GET', 'HEAD'].includes(req.method) && pathname !== '/api/admin/storage/prepare') return sendJson(res, 503, { error: 'Storage maintenance is in progress. Please retry shortly.' });
      if (!['GET', 'HEAD'].includes(req.method) && !(req.method === 'POST' && pathname === '/api/enquiries') && !isAdmin) {
        return sendJson(res, 401, { error: 'Sign in as administrator to make changes.' });
      }
      // Uploaded image files are public; the upload operation itself is administrator-only.
      if (req.method === 'GET' && /^\/api\/media\/[a-f0-9]{24}\.(png|jpg|webp|gif)$/.test(pathname)) {
        const name = pathname.split('/').pop();
        try {
          const content = await readFile(join(DATA_DIR, 'uploads', name));
          res.writeHead(200, { 'Content-Type': MIME_TYPES[extname(name)] || (name.endsWith('.gif') ? 'image/gif' : 'application/octet-stream'), 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
          return res.end(content);
        } catch { return sendJson(res, 404, { error: 'Image not found.' }); }
      }
      // Website console resources. All administrative reads and writes require a session.
      if (pathname.startsWith('/api/admin/')) {
        if (!isAdmin) return sendJson(res, 401, { error: 'Administrator sign-in required.' });
        if (pathname === '/api/admin/storage/prepare' && req.method === 'POST') {
          const destination = '/home/u538435311/domains/api.gynaeq.com/gynaeq-data';
          // Copy only this application's data to its permanent private directory. Never overwrite a different database.
          storagePauseUntil = Date.now() + 300000;
          try {
            mkdirSync(destination, { recursive: true });
            const resolved = await realpath(destination);
            if (resolved !== destination) throw new Error('Storage directory must not be a symlink.');
            const probe = join(destination, '.write-probe-' + randomBytes(6).toString('hex'));
            await writeFile(probe, 'GYNAEQ storage validation', { flag: 'wx' });
            await (await import('node:fs/promises')).unlink(probe);
            const source = await readFile(DB_FILE);
            const hash = buffer => createHash('sha256').update(buffer).digest('hex');
            const targetFile = join(destination, 'gynaeq-db.json');
            if (existsSync(targetFile)) {
              if (hash(await readFile(targetFile)) !== hash(source)) throw new Error('Destination contains a different database. No files were replaced.');
            } else await writeFile(targetFile, source, { flag: 'wx', mode: 0o600 });
            let files = 0;
            if (existsSync(join(DATA_DIR, 'uploads'))) {
              mkdirSync(join(destination, 'uploads'), { recursive: true });
              for (const name of await readdir(join(DATA_DIR, 'uploads'))) {
                if (!/^[a-f0-9]{24}\.(png|jpg|webp|gif)$/.test(name)) continue;
                const image = await readFile(join(DATA_DIR, 'uploads', name));
                const target = join(destination, 'uploads', name);
                if (!existsSync(target)) await writeFile(target, image, { flag: 'wx' });
                if (hash(await readFile(target)) !== hash(image)) throw new Error('Uploaded image checksum mismatch.');
                files++;
              }
            }
            if (hash(await readFile(targetFile)) !== hash(source)) throw new Error('Database checksum mismatch.');
            return sendJson(res, 200, { ready: true, directory: resolved, writable: true, databaseChecksum: hash(source), products: JSON.parse(source).products?.length || 0, uploadsVerified: files, writesPausedSeconds: 300 });
          } catch (error) { storagePauseUntil = 0; throw error; }
        }
        if (pathname === '/api/admin/backup') {
          if (req.method === 'GET') return sendJson(res, 200, await readDb());
          if (req.method === 'POST') {
            const backup = await parseJsonBody(req);
            if (!backup || typeof backup !== 'object' || !Array.isArray(backup.products) || !Array.isArray(backup.categories) || !Array.isArray(backup.brands)) return sendJson(res, 400, { error: 'Invalid GYNAEQ backup file.' });
            const allowed = ['company','products','categories','brands','traderCompanies','organisations','enquiries','quotations','amcContracts','posts','postCategories','pages','media','faqs','reviews','siteChrome','settings','seo'];
            const restored = Object.fromEntries(allowed.filter(key => backup[key] !== undefined).map(key => [key, backup[key]]));
            if (allowed.some(key => key !== 'company' && restored[key] !== undefined && !Array.isArray(restored[key]))) return sendJson(res, 400, { error: 'Backup collections must be arrays.' });
            await writeDb(restored);
            return sendJson(res, 200, { success: true });
          }
          return sendJson(res, 405, { error: 'Method not allowed' });
        }
        const match = pathname.match(/^\/api\/admin\/resources\/(categories|brands|media|posts|postCategories|pages|faqs|reviews|siteChrome|settings|seo)(?:\/([^/]+))?$/);
        if (!match) return sendJson(res, 404, { error: 'Resource not found' });
        const [, collection, encodedId] = match;
        const id = encodedId ? decodeURIComponent(encodedId) : null;
        const db = await readDb();
        const items = db[collection] || [];
        if (req.method === 'GET') return sendJson(res, 200, { data: items });
        if (req.method === 'DELETE' && id) {
          if (['categories', 'brands'].includes(collection) && (db.products || []).some(p => collection === 'categories' ? p.categoryId === id : p.brandId === id)) {
            return sendJson(res, 409, { error: 'Move products to another category or brand before deleting it.' });
          }
          db[collection] = items.filter(item => item.id !== id);
          await writeDb(db);
          return sendJson(res, 200, { success: true });
        }
        if (!['POST', 'PUT'].includes(req.method)) return sendJson(res, 405, { error: 'Method not allowed' });
        const body = await parseJsonBody(req);
        const fields = {
          categories: ['name','slug','description','image','icon','color'],
          postCategories: ['name','slug','description'],
          brands: ['name','slug','description','image'],
          media: ['name','url','alt','type'],
          posts: ['title','slug','excerpt','content','category','tags','status','featuredImage','seoTitle','seoDescription','author','publishedAt'],
          pages: ['title','slug','excerpt','content','status','featuredImage','seoTitle','seoDescription','targetPath'],
          faqs: ['question','answer','status'], reviews: ['name','quote','rating','status'],
          siteChrome: ['logo','phone','email','footerText','navigation'],
          settings: ['name','email','phone','address','currency'],
          seo: ['title','description','path']
        }[collection];
        const clean = Object.fromEntries(fields.filter(key => body[key] !== undefined).map(key => [key, body[key]]));
        if (['posts','pages'].includes(collection)) {
          if (!String(clean.title || '').trim()) return sendJson(res, 400, { error: 'A title is required.' });
          clean.slug = String(clean.slug || clean.title).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
          if (!clean.slug) return sendJson(res, 400, { error: 'Enter a valid URL slug.' });
          if (items.some(item => item.slug === clean.slug && item.id !== id)) return sendJson(res, 409, { error: 'This URL slug is already in use.' });
          if (!['draft','published'].includes(clean.status)) clean.status = 'draft';
          if (clean.status === 'published') clean.publishedAt = clean.publishedAt || new Date().toISOString();
        }
        if (['categories','brands','media','postCategories'].includes(collection) && !String(clean.name || '').trim()) return sendJson(res, 400, { error: 'A name is required.' });
        if (collection === 'media' && !/^(https:\/\/|\/(?!\/)|data:image\/(png|jpeg|webp|gif);base64,)/i.test(String(clean.url || ''))) return sendJson(res, 400, { error: 'Upload an image or use an HTTPS image URL.' });
        if (collection === 'pages' && clean.targetPath && !['/about','/contact','/packages'].includes(clean.targetPath)) return sendJson(res, 400, { error: 'Select a supported core page.' });
        if (collection === 'pages' && clean.targetPath && items.some(item => item.targetPath === clean.targetPath && item.id !== id)) return sendJson(res, 409, { error: 'This core page already has a managed entry. Edit that entry instead.' });
        if (collection === 'media' && String(clean.url).startsWith('data:image/')) {
          const image = clean.url.match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
          if (!image) return sendJson(res, 400, { error: 'Invalid image upload.' });
          const bytes = Buffer.from(image[2], 'base64');
          if (!bytes.length || bytes.length > 1572864) return sendJson(res, 400, { error: 'Images must be under 1.5 MB.' });
          const valid = image[1] === 'png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : image[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 : image[1] === 'webp' ? bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP' : bytes.toString('ascii',0,3) === 'GIF';
          if (!valid) return sendJson(res, 400, { error: 'The file is not a valid supported image.' });
          const file = randomBytes(12).toString('hex') + '.' + (image[1] === 'jpeg' ? 'jpg' : image[1]);
          mkdirSync(join(DATA_DIR, 'uploads'), { recursive: true });
          await writeFile(join(DATA_DIR, 'uploads', file), bytes);
          const origin = String(req.headers.host).includes('gynaeq.com') ? 'https://api.gynaeq.com' : `http://${req.headers.host}`;
          clean.url = origin + '/api/media/' + file;
        }
        if (id && !items.some(item => item.id === id)) return sendJson(res, 404, { error: 'Record not found.' });
        const record = { ...(items.find(item => item.id === id) || {}), ...clean, id: id || randomBytes(12).toString('hex'), updatedAt: new Date().toISOString() };
        db[collection] = id ? items.map(item => item.id === id ? record : item) : [...items, record];
        if (collection === 'categories' && clean.description !== undefined) record.shortDesc = clean.description;
        if (collection === 'settings') db.company = { ...(db.company || {}), ...clean };
        // Keep product labels and filters aligned when a category or brand is renamed.
        if (id && collection === 'categories') db.products = (db.products || []).map(p => p.categoryId === id ? { ...p, category: record.name, categoryName: record.name } : p);
        if (id && collection === 'brands') db.products = (db.products || []).map(p => p.brandId === id ? { ...p, brand: record.name } : p);
        await writeDb(db);
        return sendJson(res, id ? 200 : 201, { success: true, record });
      }
      if (req.method === 'GET' && pathname === '/api/content') {
        const db = await readDb();
        return sendJson(res, 200, {
          posts: (db.posts || []).filter(p => p.status === 'published'),
          pages: (db.pages || []).filter(p => p.status === 'published'),
          faqs: (db.faqs || []).filter(p => p.status === 'published'),
          reviews: (db.reviews || []).filter(p => p.status === 'published'),
          siteChrome: db.siteChrome || [], settings: db.settings || [], seo: db.seo || []
        });
      }
      // GET /api/data
      if (req.method === 'GET' && pathname === '/api/data') {
        const db = await readDb();
        if (isAdmin) return sendJson(res, 200, db);
        const products = (db.products || []).filter(p => !p.status || p.status === 'published').map(product => {
          const { purchaseCost, traderPriceMin, traderPriceMax, margin, profitMargin, ...publicProduct } = product;
          return publicProduct;
        });
        return sendJson(res, 200, { company: db.company, categories: db.categories || [], brands: db.brands || [], products });
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
        if (!String(body.name || body.title || '').trim()) return sendJson(res, 400, { error: 'Product name is required.' });
        const title = body.name || body.title;
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
          id: `gnq-${randomBytes(10).toString('hex')}`,
          status: ['draft','published'].includes(body.status) ? body.status : 'published',
          slug: body.slug || '',
          seoTitle: body.seoTitle || '', seoDescription: body.seoDescription || '',
          galleryImages: Array.isArray(body.galleryImages) ? body.galleryImages : [],
          imageAlt: body.imageAlt || title,
          sku: sku,
          title: title,
          name: title,
          brand: brand,
          brandId: body.brandId || brand.toLowerCase().replace(/[^a-z0-9]/g, '-'),
          model: model,
          categoryId: body.categoryId || categoryName.toLowerCase().replace(/[^a-z0-9]/g, '-'),
          categoryName: categoryName,
          category: categoryName,
          price: price,
          sellingPrice: price,
          purchaseCost: purchaseCost,
          vatStatus: body.vatStatus || '5% Standard Rate (UAE VAT)',
          currency: 'AED',
          callForPrice: Boolean(body.callForPrice),
          inStock: Number(body.inStock) > 0 || body.inStock === true || body.inStock === undefined,
          inStockCount: body.inStockCount !== undefined ? Math.max(0, Number(body.inStockCount) || 0) : (Number(body.inStock) || (body.inStock === false ? 0 : 5)),
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
