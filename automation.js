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
async function postToFBSinglePost(message, imagePaths) {
  const mediaIds = [];

  for (const img of imagePaths) {
    const form = new FormData();
    form.append('source', fs.createReadStream(img));
    form.append('access_token', PAGE_ACCESS_TOKEN);

    const res = await fetch(`https://graph.facebook.com/${PAGE_ID}/photos`, {
      method: 'POST',
      body: form
    });

    const text = await res.text();
    if (!text) {
      console.warn('⚠️ FB empty response for image:', img);
      continue;
    }

    const data = JSON.parse(text);
    if (data.id) {
      mediaIds.push({ media_fbid: data.id });
      console.log('✅ Uploaded image:', img);
    }

    // small delay between image uploads
    await new Promise(r => setTimeout(r, 2000));
  }

  if (!mediaIds.length) {
    console.warn('⚠️ No images uploaded, skipping FB post');
    return;
  }

  const postForm = new FormData();
  postForm.append('message', message);
  postForm.append('attached_media', JSON.stringify(mediaIds));
  postForm.append('access_token', PAGE_ACCESS_TOKEN);

  const postRes = await fetch(`https://graph.facebook.com/${PAGE_ID}/feed`, {
    method: 'POST',
    body: postForm
  });

  const postText = await postRes.text();
  if (postText) {
    console.log('📸 FB Post:', JSON.parse(postText));
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
    agent: parsedURL => {
      if (parsedURL.protocol === 'https:') {
        return insecureAgent;
      }
      return null;
    }
  });

  if (!res.ok) {
    throw new Error(`Failed to download PDF: ${res.status}`);
  }

  const buffer = await res.arrayBuffer();
  const pdfPath = path.join('/tmp', `${noticeId}.pdf`);
  fs.writeFileSync(pdfPath, Buffer.from(buffer));

  const pdfDoc = await PDFDocument.load(Buffer.from(buffer));
  const totalPages = pdfDoc.getPageCount();

  const images = [];

  for (let i = 1; i <= totalPages; i++) {
    const name = `${noticeId}-page-${i}-${Date.now()}`;

    const converter = fromPath(pdfPath, {
      density: 96,        // FB-safe size
      savePath: '/tmp',
      saveFilename: name,
      format: 'png',
      width: 960,
      height: 1280,
      quality: 75,
      graphicsMagick: false
    });

    await converter(i);
    images.push(path.join('/tmp', `${name}.png`));

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

      const images = await pdfToImages(pdf, id);

      await postToFBSinglePost(
        `${notice.title}\n${notice.link}`,
        images
      );

      images.forEach(f => fs.unlinkSync(f));

      posted.push(id);
      posted = posted.slice(-MAX_POSTED);
      fs.writeFileSync(POSTED_FILE, JSON.stringify(posted, null, 2));

      console.log('⏳ Waiting 1 minute before next post...');
      await new Promise(r => setTimeout(r, POST_GAP_MS));
    }
  }

  await browser.close();
  console.log('✅ Done | Stored last 12 notices');
})();
