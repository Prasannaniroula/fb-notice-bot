const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const FormData = require('form-data');
const puppeteer = require('puppeteer');
const https = require('https');
const { fromPath } = require('pdf2pic');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');

const PAGE_ID = process.env.PAGE_ID;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

// ================= CONFIG =================
const POSTED_FILE = path.join(__dirname, 'notice', 'posted.json');
const MAX_POSTED = 12;
const POST_GAP_MS = 60_000;

const IOE_URL = 'https://iost.tu.edu.np/notices';
const TU_URL  = 'https://ioe.tu.edu.np/notices';

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

fs.mkdirSync(path.dirname(POSTED_FILE), { recursive: true });

let posted = [];
if (fs.existsSync(POSTED_FILE)) {
  try { posted = JSON.parse(fs.readFileSync(POSTED_FILE)); } catch {}
}
posted = posted.slice(-MAX_POSTED);

// ================= UTILS =================
function shouldPost(title) {
  const t = title.toLowerCase();
  const keywords = [
    'notice','exam','result','routine','entrance',
    'सूचना','नतिजा','फाराम','परीक्षा'
  ];
  return keywords.some(k => t.includes(k));
}

// ================= MEDIA DETECTION =================

// --- Extract visible embedded image ---
async function extractImageNotice(page, noticeId) {
  await page.waitForTimeout(1500);

  const imgs = await page.$$('img');

  for (const img of imgs) {
    try {
      const info = await img.evaluate(el => {
        const r = el.getBoundingClientRect();
        return { src: el.src || '', w: r.width, h: r.height };
      });

      // Skip invisible / tiny / irrelevant images
      if (info.w < 200 || info.h < 200) continue;
      if (!info.src.match(/\.(jpg|jpeg|png|webp)$/i)) continue;

      await img.evaluate(el =>
        el.scrollIntoView({ block: 'center', behavior: 'instant' })
      );
      await page.waitForTimeout(500);

      const raw = `/tmp/${noticeId}-img.png`;
      await img.screenshot({ path: raw });

      const fixed = `/tmp/${noticeId}-img.fixed.png`;
      await sharp(raw)
        .resize(960, 1280, { fit: 'inside' })
        .toFile(fixed);

      fs.unlinkSync(raw);
      console.log('🖼 Image notice detected');
      return [fixed];

    } catch {
      continue;
    }
  }

  return null; // no image found
}

// --- Detect PDF download / iframe ---
async function extractPdfNotice(page, noticeId) {
  await page.waitForTimeout(1500);

  // Check iframe
  const iframeSrc = await page.evaluate(() => {
    const ifr = document.querySelector('iframe');
    if (ifr?.src?.toLowerCase().includes('.pdf')) return ifr.src;
    return null;
  });
  if (iframeSrc) return await pdfToImages(iframeSrc, noticeId);

  // Check download / view buttons
  const downloadHref = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('a,button'));
    for (const el of els) {
      const t = el.innerText?.toLowerCase() || '';
      if (t.includes('download') || t.includes('view') || t.includes('pdf')) {
        if (el.href) return el.href;
        const oc = el.getAttribute('onclick');
        if (oc) {
          const m = oc.match(/'(https?:\/\/[^']+)'/);
          if (m) return m[1];
        }
      }
    }
    return null;
  });

  if (downloadHref) return await pdfToImages(downloadHref, noticeId);
  return null; // no PDF found
}

// ================= PDF → IMAGES =================
async function pdfToImages(pdfUrl, noticeId) {
  const res = await fetch(pdfUrl, {
    agent: parsed => parsed.protocol === 'https:' ? insecureAgent : null,
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://iost.tu.edu.np/' }
  });

  if (!res.ok) return [];
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('pdf')) return [];

  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.slice(0, 5).toString().startsWith('%PDF')) return [];

  const pdfPath = `/tmp/${noticeId}.pdf`;
  fs.writeFileSync(pdfPath, buffer);

  let pdfDoc;
  try { pdfDoc = await PDFDocument.load(buffer); } catch { fs.unlinkSync(pdfPath); return []; }

  const pages = Math.min(pdfDoc.getPageCount(), 10);
  console.log('📄 PDF pages:', pages);

  const images = [];
  for (let i = 1; i <= pages; i++) {
    const base = `${noticeId}-${i}`;
    const convert = fromPath(pdfPath, {
      density: 150, savePath: '/tmp', saveFilename: base,
      format: 'png', width: 1200, height: 1600
    });
    await convert(i);

    const img = `/tmp/${base}.png`;
    if (!fs.existsSync(img)) continue;

    const fixed = `/tmp/${base}.fixed.png`;
    await sharp(img).resize(960, 1280, { fit: 'inside' }).toFile(fixed);
    fs.unlinkSync(img);
    images.push(fixed);
  }

  fs.unlinkSync(pdfPath);
  return images;
}

// ================= FACEBOOK =================
async function uploadImage(img) {
  const form = new FormData();
  form.append('source', fs.createReadStream(img));
  form.append('published', 'false');
  form.append('access_token', PAGE_ACCESS_TOKEN);

  const res = await fetch(`https://graph.facebook.com/v18.0/${PAGE_ID}/photos`, { method: 'POST', body: form });
  const data = await res.json();
  return data?.id || null;
}

async function postToFB(message, images) {
  const media = [];
  for (const img of images) {
    const id = await uploadImage(img);
    if (id) media.push({ media_fbid: id });
  }

  const body = new URLSearchParams();
  body.append('message', message);
  body.append('access_token', PAGE_ACCESS_TOKEN);
  media.forEach((m, i) => body.append(`attached_media[${i}]`, JSON.stringify(m)));

  await fetch(`https://graph.facebook.com/v18.0/${PAGE_ID}/feed`, { method: 'POST', body });
  images.forEach(f => fs.existsSync(f) && fs.unlinkSync(f));
}

// ================= SCRAPE =================
async function scrapeNotices(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 0 });
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('a'))
      .map(a => ({ title: a.innerText?.trim(), link: a.href }))
      .filter(n => n.title && n.link)
  );
}

// ================= MAIN =================
(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu']
  });

  const page = await browser.newPage();

  for (const url of [IOE_URL, TU_URL]) {
    console.log('🔍 Scraping:', url);
    const notices = await scrapeNotices(page, url);

    for (const n of notices) {
      if (!shouldPost(n.title)) continue;

      const id = crypto.createHash('sha256').update(n.title + n.link).digest('hex');
      if (posted.includes(id)) continue;

      console.log('🆕 Notice:', n.title);
      await page.goto(n.link, { waitUntil: 'domcontentloaded', timeout: 0 });
      await page.waitForTimeout(1500);

      // --- decide media type ---
      let images = await extractPdfNotice(page, id);
      let type = 'PDF';
      if (!images) {
        images = await extractImageNotice(page, id);
        type = 'IMAGE';
      }

      if (!images || !images.length) {
        console.error('❌ Media not found for notice:', n.title);
        continue; // skip, do NOT post text
      }

      console.log(`✅ Posting ${type} notice`);
      await postToFB(`${n.title}\n${n.link}`, images);

      posted.push(id);
      posted = posted.slice(-MAX_POSTED);
      fs.writeFileSync(POSTED_FILE, JSON.stringify(posted, null, 2));

      console.log('⏳ Waiting 1 minute...');
      await new Promise(r => setTimeout(r, POST_GAP_MS));
    }
  }

  await browser.close();
  console.log('✅ All done');
})();
