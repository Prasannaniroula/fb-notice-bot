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
function cleanText(str) {
  return str.toLowerCase().replace(/[^a-z0-9\s\u0900-\u097F]/g, ' ');
}

function shouldPost(title) {
  const keywords = ['notice','exam','result','सूचना','नतिजा','फाराम'];
  return keywords.some(k => title.toLowerCase().includes(k));
}

// ================= IMAGE NOTICE HANDLER =================
async function extractImageNotice(page, noticeId) {
  const imgHandle = await page.$('img');

  if (!imgHandle) return null;

  const src = await imgHandle.evaluate(img => img.src || '');
  if (!src.match(/\.(jpg|jpeg|png|webp)$/i)) return null;

  const out = `/tmp/${noticeId}-image.png`;
  await imgHandle.screenshot({ path: out });

  const fixed = `/tmp/${noticeId}-image.fixed.png`;
  await sharp(out).resize(960, 1280, { fit: 'inside' }).toFile(fixed);
  fs.unlinkSync(out);

  console.log('🖼 Image notice detected');
  return [fixed];
}

// ================= REAL PDF LINK =================
async function getRealPdfLink(page) {
  return await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('a,button'));
    for (const el of els) {
      const t = el.innerText?.toLowerCase() || '';
      if (t.includes('download') || t.includes('pdf') || el.href?.endsWith('.pdf')) {
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
}

// ================= PDF → IMAGES =================
async function pdfToImages(pdfUrl, noticeId, page) {
  const res = await fetch(pdfUrl, {
    agent: parsed => parsed.protocol === 'https:' ? insecureAgent : null
  });
  const buffer = Buffer.from(await res.arrayBuffer());

  const pdfPath = `/tmp/${noticeId}.pdf`;
  fs.writeFileSync(pdfPath, buffer);

  const pdfDoc = await PDFDocument.load(buffer);
  const pages = Math.min(pdfDoc.getPageCount(), 10);

  const images = [];

  for (let i = 1; i <= pages; i++) {
    const base = `${noticeId}-${i}`;
    const converter = fromPath(pdfPath, {
      density: 150,
      savePath: '/tmp',
      saveFilename: base,
      format: 'png',
      width: 1200,
      height: 1600
    });

    await converter(i);
    const img = `/tmp/${base}.png`;

    if (fs.existsSync(img)) {
      const fixed = `/tmp/${base}.fixed.png`;
      await sharp(img).resize(960, 1280, { fit: 'inside' }).toFile(fixed);
      fs.unlinkSync(img);
      images.push(fixed);
    }
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

  const res = await fetch(`https://graph.facebook.com/v18.0/${PAGE_ID}/photos`, {
    method: 'POST',
    body: form
  });

  const data = await res.json();
  return data?.id;
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
  media.forEach((m, i) =>
    body.append(`attached_media[${i}]`, JSON.stringify(m))
  );

  await fetch(`https://graph.facebook.com/v18.0/${PAGE_ID}/feed`, {
    method: 'POST',
    body
  });

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
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  for (const url of [IOE_URL, TU_URL]) {
    const notices = await scrapeNotices(page, url);

    for (const n of notices) {
      const id = crypto.createHash('sha256').update(n.title + n.link).digest('hex');
      if (posted.includes(id)) continue;
      if (!shouldPost(n.title)) continue;

      console.log('🆕 Notice:', n.title);
      await page.goto(n.link, { waitUntil: 'domcontentloaded', timeout: 0 });
      await page.waitForTimeout(2000);

      // 1️⃣ IMAGE NOTICE
      let images = await extractImageNotice(page, id);

      // 2️⃣ PDF NOTICE
      if (!images) {
        const pdf = await getRealPdfLink(page);
        if (pdf) images = await pdfToImages(pdf, id, page);
      }

      if (!images || !images.length) {
        console.warn('⚠️ No media found, posting text only');
        images = [];
      }

      await postToFB(`${n.title}\n${n.link}`, images);

      posted.push(id);
      posted = posted.slice(-MAX_POSTED);
      fs.writeFileSync(POSTED_FILE, JSON.stringify(posted, null, 2));

      await new Promise(r => setTimeout(r, POST_GAP_MS));
    }
  }

  await browser.close();
  console.log('✅ Done');
})();
