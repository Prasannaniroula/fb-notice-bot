// automation.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch'); // v2
const FormData = require('form-data');
const puppeteer = require('puppeteer');
const https = require('https');
const sharp = require('sharp');
const { fromPath } = require('pdf2pic');
const { PDFDocument } = require('pdf-lib');

const PAGE_ID = process.env.PAGE_ID;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

// ================= CONFIG =================
const POSTED_FILE = path.join(__dirname, 'notice', 'posted.json');
const MAX_POSTED = 12;
const POST_GAP_MS = 60_000;

const IOE_URL = 'https://iost.tu.edu.np/notices';
const TU_URL = 'https://ioe.tu.edu.np/notices';

const allowedPrograms = ['csit', 'bit', 'bba', 'engineering', 'bca'];

const importantKeywords = [
  'सूचना','जरुरी','अत्यन्त','परिक्षा','नतिजा','फर्म','सूची',
  'notice','result','exam','routine','model','course','published','request','entrance'
];

const notAllowedProgram = [
  'degree','phd','msc','m.sc','scholarship','cas',
  'स्नातकोत्तर','विद्यावारिधि','प्रमुख छनौट','बोलपत्र'
];
// =========================================

// 🔐 Insecure agent ONLY for broken TU TLS
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

// Ensure notice dir
fs.mkdirSync(path.dirname(POSTED_FILE), { recursive: true });

// Load posted IDs
let posted = [];
if (fs.existsSync(POSTED_FILE)) {
  try {
    posted = JSON.parse(fs.readFileSync(POSTED_FILE, 'utf-8'));
    if (!Array.isArray(posted)) posted = [];
  } catch {
    posted = [];
  }
}
posted = posted.slice(-MAX_POSTED);

// ================= IMAGE HELPERS =================
async function resizeImageIfNeeded(imgPath) {
  const resized = imgPath.replace('.png', '-resized.png');

  await sharp(imgPath)
    .resize({ width: 1200 })
    .png({ quality: 80 })
    .toFile(resized);

  return resized;
}

// ================= FACEBOOK =================
async function uploadImageWithRetry(imgPath, maxRetries = 3) {
  let attempt = 0;
  let currentImage = imgPath;

  while (attempt < maxRetries) {
    try {
      if (!fs.existsSync(currentImage)) return null;

      const form = new FormData();
      form.append('source', fs.createReadStream(currentImage));
      form.append('published', 'false'); // ⭐ REQUIRED
      form.append('access_token', PAGE_ACCESS_TOKEN);

      const res = await fetch(
        `https://graph.facebook.com/v18.0/${PAGE_ID}/photos`,
        { method: 'POST', body: form }
      );

      const data = await res.json();

      if (data?.id) {
        console.log(`✅ Uploaded image (attempt ${attempt + 1})`);
        return data.id;
      }

      throw new Error('FB rejected image');

    } catch (err) {
      attempt++;
      console.warn(`⚠️ Upload failed (attempt ${attempt})`);

      if (attempt === 1) {
        console.warn('🔄 Trying resized image...');
        currentImage = await resizeImageIfNeeded(imgPath);
      }

      const delay = Math.pow(2, attempt) * 1000;
      await new Promise(r => setTimeout(r, delay));
    }
  }

  console.error('❌ Image upload permanently failed:', imgPath);
  return null;
}

async function postToFBSinglePost(message, imagePaths) {
  const mediaIds = [];

  for (const img of imagePaths) {
    const id = await uploadImageWithRetry(img);
    if (id) mediaIds.push(id);
    await new Promise(r => setTimeout(r, 1500));
  }

  if (!mediaIds.length && imagePaths.length) {
    console.warn('⚠️ No images uploaded, skipping FB post');
    return;
  }

  const body = new URLSearchParams();
  body.append('message', message);
  body.append('access_token', PAGE_ACCESS_TOKEN);

  mediaIds.forEach((id, i) => {
    body.append(
      `attached_media[${i}]`,
      JSON.stringify({ media_fbid: id })
    );
  });

  const res = await fetch(
    `https://graph.facebook.com/v18.0/${PAGE_ID}/feed`,
    { method: 'POST', body }
  );

  const data = await res.json();

  if (!data?.id) {
    console.error('❌ FB post failed:', data);
    return;
  }

  console.log('🎉 FB post created:', data.id);
}

// ================= SCRAPER =================
async function scrapeNotices(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 0 });
  await page.waitForTimeout(2000);

  return page.evaluate(() =>
    Array.from(document.querySelectorAll('div.recent-post-wrapper, li.recent-post-wrapper'))
      .map(el => {
        const linkEl = el.querySelector('div.detail a, a');
        return {
          title: linkEl?.innerText.trim() || '',
          link: linkEl?.href || ''
        };
      })
      .filter(n => n.title && n.link)
  );
}

// ================= PDF LINK =================
async function getDeepPdfLink(page, noticeUrl) {
  await page.goto(noticeUrl, { waitUntil: 'networkidle2', timeout: 0 });
  await page.waitForTimeout(2000);

  return page.evaluate(() => {
    const a = [...document.querySelectorAll('a')]
      .find(a => a.href && a.href.toLowerCase().includes('.pdf'));
    return a ? a.href : null;
  });
}

// ================= PDF → IMAGES =================
async function pdfToImages(pdfUrl, noticeId) {
  const res = await fetch(pdfUrl, {
    redirect: 'follow',
    follow: 5,
    agent: p => p.protocol === 'https:' ? insecureAgent : null
  });

  if (!res.ok) throw new Error(`Failed to download PDF: ${res.status}`);

  const buffer = await res.arrayBuffer();
  const pdfPath = path.join('/tmp', `${noticeId}.pdf`);
  fs.writeFileSync(pdfPath, Buffer.from(buffer));

  const pdfDoc = await PDFDocument.load(Buffer.from(buffer));
  const totalPages = pdfDoc.getPageCount();

  if (totalPages > 10) {
    console.warn(`⚠️ PDF has ${totalPages} pages → skipping images`);
    fs.unlinkSync(pdfPath);
    return { skipImages: true, images: [] };
  }

  const images = [];

  for (let i = 1; i <= totalPages; i++) {
    const name = `${noticeId}-page-${i}-${Date.now()}`;

    const converter = fromPath(pdfPath, {
      density: 96,
      savePath: '/tmp',
      saveFilename: name,
      format: 'png',
      width: 960,
      height: 1280,
      quality: 75
    });

    await converter(i);
    images.push(path.join('/tmp', `${name}.png`));
    await new Promise(r => setTimeout(r, 300));
  }

  fs.unlinkSync(pdfPath);
  return { skipImages: false, images };
}

// ================= FILTER =================
function shouldPost(title) {
  const t = title.toLowerCase();
  if (notAllowedProgram.some(x => t.includes(x))) return false;
  return (
    importantKeywords.some(x => t.includes(x)) ||
    allowedPrograms.some(x => t.includes(x))
  );
}

// ================= MAIN =================
(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 2200 });

  for (const url of [IOE_URL, TU_URL]) {
    console.log('🔍 Scraping:', url);
    const notices = await scrapeNotices(page, url);

    for (const notice of notices) {
      const id = crypto
        .createHash('sha256')
        .update(notice.title + notice.link)
        .digest('hex');

      if (posted.includes(id)) continue;
      if (!shouldPost(notice.title)) continue;

      console.log('🆕 Posting:', notice.title);

      const pdf = await getDeepPdfLink(page, notice.link);
      if (!pdf) continue;

      const { skipImages, images } = await pdfToImages(pdf, id);

      await postToFBSinglePost(
        `${notice.title}\n${notice.link}`,
        skipImages ? [] : images
      );

      images.forEach(f => {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      });

      posted.push(id);
      posted = posted.slice(-MAX_POSTED);
      fs.writeFileSync(POSTED_FILE, JSON.stringify(posted, null, 2));

      console.log('⏳ Waiting 1 minute...');
      await new Promise(r => setTimeout(r, POST_GAP_MS));
    }
  }

  await browser.close();
  console.log('✅ Done | Stored last 12 notices');
})();
