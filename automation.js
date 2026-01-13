// automation.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch'); // v2
const FormData = require('form-data');
const puppeteer = require('puppeteer');
const https = require('https');
const { fromPath } = require('pdf2pic');
const { PDFDocument } = require('pdf-lib');

const PAGE_ID = process.env.PAGE_ID;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

// ================= CONFIG =================
const POSTED_FILE = path.join(__dirname, 'notice', 'posted.json');
const MAX_POSTED = 12;
const POST_GAP_MS = 60_000; // 1 minute gap between FB posts

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
  } catch {
    posted = [];
  }
}
posted = posted.slice(-MAX_POSTED);

// ================= FACEBOOK =================
async function uploadImageWithRetry(imgPath, retries = 3) {
  let delay = 1000;
  for (let i = 0; i < retries; i++) {
    try {
      if (!fs.existsSync(imgPath)) {
        console.warn('⚠️ File not found:', imgPath);
        return null;
      }
      const form = new FormData();
      form.append('source', fs.createReadStream(imgPath));
      form.append('published', 'false'); // Unpublished
      form.append('access_token', PAGE_ACCESS_TOKEN);

      const res = await fetch(`https://graph.facebook.com/v18.0/${PAGE_ID}/photos`, {
        method: 'POST',
        body: form
      });
      const data = await res.json();
      if (data?.id) {
        console.log('✅ Uploaded image:', imgPath);
        return data.id;
      } else {
        console.warn('⚠️ Upload failed, retrying...', data);
      }
    } catch (err) {
      console.warn('⚠️ Upload error, retrying...', err.message);
    }
    await new Promise(r => setTimeout(r, delay));
    delay *= 2; // exponential backoff
  }
  console.warn('❌ Failed to upload image after retries:', imgPath);
  return null;
}

async function postToFBSinglePost(message, imagePaths) {
  const mediaIds = [];

  for (const img of imagePaths) {
    const id = await uploadImageWithRetry(img);
    if (id) mediaIds.push(id);
    await new Promise(r => setTimeout(r, 1500));
  }

  const body = new URLSearchParams();
  body.append('message', message);
  body.append('access_token', PAGE_ACCESS_TOKEN);

  if (mediaIds.length) {
    mediaIds.forEach((id, i) => {
      body.append(`attached_media[${i}]`, JSON.stringify({ media_fbid: id }));
    });
  } else if (imagePaths.length) {
    console.warn('⚠️ Images failed → posting text-only');
  }

  try {
    const res = await fetch(`https://graph.facebook.com/v18.0/${PAGE_ID}/feed`, {
      method: 'POST',
      body
    });
    const data = await res.json();
    if (!data?.id) {
      console.error('❌ FB post failed:', data);
      return false;
    } else {
      console.log(
        mediaIds.length
          ? '🎉 FB post created with images'
          : '📝 FB post created (text-only)',
        data.id
      );
      return mediaIds.length > 0 ? 'image' : 'text';
    }
  } catch (err) {
    console.error('❌ FB post request error:', err.message);
    return false;
  } finally {
    // Cleanup files AFTER posting
    imagePaths.forEach(f => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });
  }
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

// ================= PDF → IMAGES (REDIRECT-SAFE TLS FIX) =================
async function pdfToImages(pdfUrl, noticeId) {
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

  const images = [];
  const pagesToProcess = Math.min(totalPages, 10); // FB max 10 images

  for (let i = 1; i <= pagesToProcess; i++) {
    const name = `${noticeId}-page-${i}-${Date.now()}`;
    const converter = fromPath(pdfPath, {
      density: 96,
      savePath: '/tmp',
      saveFilename: name,
      format: 'png',
      width: 960,
      height: 1280,
      quality: 75,
      graphicsMagick: false
    });

    await converter(i);
    const imgPath = path.join('/tmp', `${name}.png`);

    if (fs.existsSync(imgPath)) images.push(imgPath);
    await new Promise(r => setTimeout(r, 300));
  }

  fs.unlinkSync(pdfPath);
  return images;
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

  // ===== SUMMARY COUNTERS =====
  let totalNotices = 0;
  let postedWithImages = 0;
  let postedTextOnly = 0;
  let failedPosts = 0;

  for (const url of [IOE_URL, TU_URL]) {
    console.log('🔍 Scraping:', url);
    const notices = await scrapeNotices(page, url);

    for (const notice of notices) {
      const id = crypto.createHash('sha256').update(notice.title + notice.link).digest('hex');
      if (posted.includes(id)) continue;
      if (!shouldPost(notice.title)) continue;

      console.log('🆕 Posting:', notice.title);

      const pdf = await getDeepPdfLink(page, notice.link);
      let images = [];
      if (pdf) {
        images = await pdfToImages(pdf, id);
      }

      const result = await postToFBSinglePost(`${notice.title}\n${notice.link}`, images);

      if (result === 'image') postedWithImages++;
      else if (result === 'text') postedTextOnly++;
      else failedPosts++;

      totalNotices++;
      posted.push(id);
      posted = posted.slice(-MAX_POSTED);
      fs.writeFileSync(POSTED_FILE, JSON.stringify(posted, null, 2));

      console.log('⏳ Waiting 1 minute before next post...');
      await new Promise(r => setTimeout(r, POST_GAP_MS));
    }
  }

  await browser.close();

  console.log('✅ Done | Stored last 12 notices');
  console.log('📊 SUMMARY:');
  console.log('Total notices processed:', totalNotices);
  console.log('Posted with images:', postedWithImages);
  console.log('Posted text-only:', postedTextOnly);
  console.log('Failed posts:', failedPosts);
})();
