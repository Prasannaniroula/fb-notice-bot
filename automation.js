// ==================== automation.js ====================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const { fromBuffer } = require('pdf2pic');
const FormData = require('form-data');
const fetch = require('node-fetch');

const PAGE_ID = process.env.PAGE_ID;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

const POSTED_FILE = path.join(__dirname, 'notice', 'posted.json');
const MAX_POSTED = 12;
const POST_GAP_MS = 60_000;

const IOE_URL = 'https://ioe.tu.edu.np/notices';
const IOST_URL = 'https://iost.tu.edu.np/notices';

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

// -------------------- PDF → IMAGES --------------------
async function pdfBufferToImages(buffer, noticeId) {
  const pdfDoc = await PDFDocument.load(buffer);
  const pages = Math.min(pdfDoc.getPageCount(), 10);
  const images = [];

  for (let i = 1; i <= pages; i++) {
    const base = `${noticeId}-${i}`;
    const converter = fromBuffer(buffer, {
      density: 150,
      format: 'png',
      width: 1200,
      height: 1600
    });
    const outPath = `/tmp/${base}.png`;
    await converter(i, { savePath: '/tmp', saveFilename: base });
    const fixed = `/tmp/${base}.fixed.png`;
    await sharp(outPath).resize(960, 1280, { fit: 'inside' }).toFile(fixed);
    fs.unlinkSync(outPath);
    images.push(fixed);
  }
  return images;
}

// -------------------- EXTRACT NOTICE MEDIA --------------------
async function extractNoticeMedia(page, noticeId) {
  await page.waitForTimeout(1500);

  // 1️⃣ Check for PDF links first
  const pdfLinks = await page.$$eval('a', links =>
    links
      .map(a => a.href)
      .filter(href => href.toLowerCase().endsWith('.pdf'))
  );

  for (const pdfUrl of pdfLinks) {
    try {
      console.log(`📄 PDF detected: ${pdfUrl}`);
      const res = await fetch(pdfUrl);
      const buffer = await res.buffer();
      if (buffer.length > 1000) { // sanity check
        return await pdfBufferToImages(buffer, noticeId);
      }
    } catch (err) {
      console.warn(`⚠️ Failed to fetch PDF ${pdfUrl}: ${err.message}`);
      continue;
    }
  }

  // 2️⃣ Fallback: Check for embedded images
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

  console.error('❌ No media found for notice:', noticeId);
  return null;
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

  if (media.length === 0) return;

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
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
  });
  const page = await browser.newPage();

  for (const url of [IOST_URL, IOE_URL]) {
    console.log('🔍 Scraping:', url);
    let notices = [];
    try {
      notices = await scrapeNotices(page, url);
    } catch(err) {
      console.error('❌ Failed to scrape notices from', url, err.message);
      continue;
    }

    for (const n of notices) {
      if (!shouldPost(n.title)) continue;

      const id = crypto.createHash('sha256').update(n.title + n.link).digest('hex');
      if (posted.includes(id)) continue;

      console.log('🆕 Notice:', n.title);

      try {
        await page.goto(n.link, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1500);

        const media = await extractNoticeMedia(page, id);
        if (!media || media.length === 0) continue;

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
