const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch'); // v2
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
const TU_URL = 'https://ioe.tu.edu.np/notices';

const allowedPrograms = ['csit','bit','bba','engineering','bca'];
const importantKeywords = [
  'सूचना','जरुरी','अत्यन्त','परिक्षा','नतिजा','फर्म','सूची',
  'notice','result','exam','routine','model','course','published','request','entrance'
];
const notAllowedProgram = [
  'degree','phd','msc','m.sc','scholarship','cas',
  'स्नातकोत्तर','विद्यावारिधि','प्रमुख','छनौट','बोलपत्र'
];
// =========================================

// 🔐 Scoped insecure agent ONLY for broken TU PDFs
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

// Ensure notice directory exists
fs.mkdirSync(path.dirname(POSTED_FILE), { recursive: true });

// Load posted notices
let posted = [];
if (fs.existsSync(POSTED_FILE)) {
  try {
    posted = JSON.parse(fs.readFileSync(POSTED_FILE, 'utf-8'));
    if (!Array.isArray(posted)) posted = [];
  } catch { posted = []; }
}
posted = posted.slice(-MAX_POSTED);

// ================= UTILS =================
function cleanText(str) {
  return str.toLowerCase().replace(/[^a-z0-9\s\u0900-\u097F]/g, ' ');
}

function shouldPost(title) {
  const t = cleanText(title);
  const words = t.split(/\s+/);
  if (notAllowedProgram.some(x => words.includes(x.toLowerCase()))) return false;
  const allowed = allowedPrograms.some(x => words.includes(x.toLowerCase()));
  const keyword = importantKeywords.some(k => t.includes(k.toLowerCase()));
  return allowed || keyword;
}

// ================= PUPPETEER PDF RENDER =================
async function renderPdfWithPuppeteer(page, pdfUrl, outputPath) {
  await page.setContent(`
    <html>
      <body style="margin:0; background:white">
        <embed src="${pdfUrl}" type="application/pdf" width="100%" height="100%" />
      </body>
    </html>
  `, { waitUntil: 'domcontentloaded' });

  await page.setViewport({ width: 1200, height: 1600 });
  await page.waitForTimeout(2000);

  await page.screenshot({
    path: outputPath,
    fullPage: true
  });
}

// ================= PDF → IMAGES =================
async function pdfToImages(pdfUrl, noticeId, page) {
  const res = await fetch(pdfUrl, {
    redirect: 'follow',
    follow: 5,
    agent: parsedURL => parsedURL.protocol === 'https:' ? insecureAgent : null
  });

  if (!res.ok) throw new Error(`Failed to download PDF: ${res.status}`);

  const buffer = await res.arrayBuffer();
  const pdfPath = path.join('/tmp', `${noticeId}.pdf`);
  fs.writeFileSync(pdfPath, Buffer.from(buffer));

  const pdfDoc = await PDFDocument.load(Buffer.from(buffer));
  const totalPages = pdfDoc.getPageCount();
  console.log('📄 PDF total pages:', totalPages);

  const images = [];
  const pagesToProcess = Math.min(totalPages, 10);

  for (let i = 1; i <= pagesToProcess; i++) {
    const name = `${noticeId}-page-${i}-${Date.now()}`;
    const converter = fromPath(pdfPath, {
      density: 150,
      savePath: '/tmp',
      saveFilename: name,
      format: 'png',
      width: 1200,
      height: 1600,
      quality: 100,
      graphicsMagick: false
    });

    await converter(i);

    const imgPath = path.join('/tmp', `${name}.png`);

    // ---------- FALLBACK FIX ----------
    if (!fs.existsSync(imgPath) || fs.statSync(imgPath).size === 0) {
      console.warn('⚠️ PNG not created, using Puppeteer HTML wrapper fallback');

      const screenshotPath = path.join('/tmp', `${name}-screenshot.png`);
      try {
        await renderPdfWithPuppeteer(page, pdfUrl, screenshotPath);
        if (fs.existsSync(screenshotPath)) {
          images.push(screenshotPath);
          console.log('✅ Puppeteer image ready:', screenshotPath);
        }
      } catch (err) {
        console.error('❌ Puppeteer render failed:', err.message);
      }
      continue;
    }

    const resizedPath = path.join('/tmp', `${name}.fixed.png`);
    await sharp(imgPath).resize(960, 1280, { fit: 'inside' }).toFile(resizedPath);
    fs.unlinkSync(imgPath);
    images.push(resizedPath);
    console.log('✅ Image ready:', resizedPath);

    await new Promise(r => setTimeout(r, 300));
  }

  fs.unlinkSync(pdfPath);
  return images;
}

// ================= FACEBOOK =================
async function uploadImageToFB(imgPath) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (!fs.existsSync(imgPath) || fs.statSync(imgPath).size === 0) return null;

      const form = new FormData();
      form.append('source', fs.createReadStream(imgPath));
      form.append('published', 'false');
      form.append('access_token', PAGE_ACCESS_TOKEN);

      const res = await fetch(`https://graph.facebook.com/v18.0/${PAGE_ID}/photos`, {
        method: 'POST',
        body: form
      });

      const data = await res.json();
      if (data?.id) return data.id;
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  return null;
}

async function postToFBSinglePost(message, imagePaths) {
  const mediaIds = [];
  for (const img of imagePaths) {
    const id = await uploadImageToFB(img);
    if (id) mediaIds.push({ media_fbid: id });
  }

  const body = new URLSearchParams();
  body.append('message', message);
  body.append('access_token', PAGE_ACCESS_TOKEN);
  mediaIds.forEach((m, i) =>
    body.append(`attached_media[${i}]`, JSON.stringify(m))
  );

  const res = await fetch(`https://graph.facebook.com/v18.0/${PAGE_ID}/feed`, {
    method: 'POST',
    body
  });

  const data = await res.json();
  imagePaths.forEach(f => fs.existsSync(f) && fs.unlinkSync(f));
  return data?.id ? true : false;
}

// ================= SCRAPER =================
async function scrapeNotices(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 0 });
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('div.recent-post-wrapper, li.recent-post-wrapper'))
      .map(el => {
        const a = el.querySelector('a');
        return { title: a?.innerText.trim(), link: a?.href };
      })
      .filter(n => n.title && n.link)
  );
}

async function getDeepPdfLink(page, noticeUrl) {
  await page.goto(noticeUrl, { waitUntil: 'networkidle2', timeout: 0 });
  return page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('a'));
    const pdf = a.find(x => x.href?.toLowerCase().includes('.pdf'));
    return pdf?.href || null;
  });
}

// ================= MAIN =================
(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 2200 });

  for (const url of [IOE_URL, TU_URL]) {
    console.log('🔍 Scraping:', url);
    const notices = await scrapeNotices(page, url);

    for (const notice of notices) {
      const id = crypto.createHash('sha256')
        .update(notice.title + notice.link)
        .digest('hex');

      if (posted.includes(id)) continue;
      if (!shouldPost(notice.title)) continue;

      console.log('🆕 Posting:', notice.title);

      const pdf = await getDeepPdfLink(page, notice.link);
      const images = pdf ? await pdfToImages(pdf, id, page) : [];

      await postToFBSinglePost(`${notice.title}\n${notice.link}`, images);

      posted.push(id);
      posted = posted.slice(-MAX_POSTED);
      fs.writeFileSync(POSTED_FILE, JSON.stringify(posted, null, 2));

      console.log('⏳ Waiting 1 minute...');
      await new Promise(r => setTimeout(r, POST_GAP_MS));
    }
  }

  await browser.close();
  console.log('✅ Done');
})();
