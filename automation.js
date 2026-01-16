// ==================== automation.js ====================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch'); // v2
const FormData = require('form-data');
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const { fromPath } = require('pdf2pic');
const https = require('https');

const PAGE_ID = process.env.PAGE_ID;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

const POSTED_FILE = path.join(__dirname, 'notice', 'posted.json');
const MAX_POSTED = 12;
const POST_GAP_MS = 60_000;

const IOE_URL = 'https://iost.tu.edu.np/notices';
const TU_URL = 'https://ioe.tu.edu.np/notices';
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

fs.mkdirSync(path.dirname(POSTED_FILE), { recursive: true });

let posted = [];
if (fs.existsSync(POSTED_FILE)) {
  try { posted = JSON.parse(fs.readFileSync(POSTED_FILE)); } catch {}
}
posted = posted.slice(-MAX_POSTED);

// ==================== UTILS ====================
function shouldPost(title) {
  const t = title.toLowerCase();
  const keywords = [
    'notice','exam','result','routine','entrance',
    'सूचना','नतिजा','फाराम','परीक्षा'
  ];
  return keywords.some(k => t.includes(k));
}

// -------------------- FETCH PDF BUFFER WITH RETRY --------------------
async function fetchPdfBuffer(pdfUrl, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(pdfUrl, { agent: parsed => parsed.protocol === 'https:' ? insecureAgent : null });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      if (!buffer.slice(0, 5).toString().startsWith('%PDF')) throw new Error('Not a PDF');
      return buffer;
    } catch (err) {
      if (i === retries - 1) throw err;
      console.warn(`Retrying PDF fetch (${i+1}) for ${pdfUrl}...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// -------------------- PDF → IMAGES --------------------
async function pdfToImages(pdfUrl, noticeId) {
  let buffer;
  try { buffer = await fetchPdfBuffer(pdfUrl); } catch(err) {
    console.error('❌ Failed to fetch PDF:', pdfUrl, err.message);
    return [];
  }

  const pdfPath = `/tmp/${noticeId}.pdf`;
  fs.writeFileSync(pdfPath, buffer);

  let pdfDoc;
  try { pdfDoc = await PDFDocument.load(buffer); } catch { fs.unlinkSync(pdfPath); return []; }

  const pages = Math.min(pdfDoc.getPageCount(), 10);
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

// -------------------- EXTRACT MEDIA --------------------
async function extractNoticeMedia(page, noticeId) {
  await page.waitForTimeout(1500);

  // 1️⃣ Check for PDF in iframe
  const iframePdf = await page.evaluate(() => {
    const ifr = document.querySelector('iframe');
    if (ifr?.src?.toLowerCase().includes('.pdf')) return ifr.src;
    return null;
  });
  if (iframePdf) {
    console.log('📄 PDF found in iframe');
    return await pdfToImages(iframePdf, noticeId);
  }

  // 2️⃣ Check for PDF download / view button
  const downloadPdf = await page.evaluate(() => {
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
  if (downloadPdf) {
    console.log('📄 PDF found via download/view button');
    return await pdfToImages(downloadPdf, noticeId);
  }

  // 3️⃣ Check for embedded images (largest visible block)
  const imgHandles = await page.$$('img');
  let maxArea = 0, chosenImg = null;

  for (const img of imgHandles) {
    try {
      const info = await img.evaluate(el => {
        const rect = el.getBoundingClientRect();
        return { w: rect.width, h: rect.height, src: el.src || '' };
      });
      const area = info.w * info.h;
      if (area > maxArea && info.w > 200 && info.h > 200 && info.src.match(/\.(jpg|jpeg|png|webp)/i)) {
        maxArea = area;
        chosenImg = img;
      }
    } catch { continue; }
  }

  if (chosenImg) {
    await chosenImg.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.waitForTimeout(500);

    const raw = `/tmp/${noticeId}-img.png`;
    await chosenImg.screenshot({ path: raw });

    const fixed = `/tmp/${noticeId}-img.fixed.png`;
    await sharp(raw).resize(960, 1280, { fit: 'inside' }).toFile(fixed);
    fs.unlinkSync(raw);

    console.log('🖼 Embedded image detected');
    return [fixed];
  }

  console.error('❌ Media not found for notice:', noticeId);
  return null; // must have either PDF or image
}

// -------------------- FACEBOOK --------------------
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

// -------------------- SCRAPER --------------------
async function scrapeNotices(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 0 });
  await page.waitForTimeout(1500);

  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('div.recent-post-wrapper, li.recent-post-wrapper, a'));
    return nodes
      .map(n => {
        const a = n.querySelector('a') || n;
        return { title: a.innerText?.trim(), link: a.href };
      })
      .filter(n => n.title && n.link);
  });
}

// -------------------- MAIN --------------------
(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
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

      try {
        await page.goto(n.link, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1500);

        const media = await extractNoticeMedia(page, id);
        if (!media || media.length === 0) continue; // skip if no media

        console.log(`✅ Posting notice with ${media.length} image(s)`);
        await postToFB(`${n.title}\n${n.link}`, media);

        posted.push(id);
        posted = posted.slice(-MAX_POSTED);
        fs.writeFileSync(POSTED_FILE, JSON.stringify(posted, null, 2));

        console.log('⏳ Waiting 1 minute before next post...');
        await new Promise(r => setTimeout(r, POST_GAP_MS));

      } catch (err) {
        console.error('❌ Failed to process notice:', n.title, err.message);
        continue;
      }
    }
  }

  await browser.close();
  console.log('✅ All done');
})();
