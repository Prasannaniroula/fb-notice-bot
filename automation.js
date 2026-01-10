const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch'); // v2
const FormData = require('form-data');
const puppeteer = require('puppeteer');
const { fromPath } = require('pdf2pic');
const { PDFDocument } = require('pdf-lib');

const PAGE_ID = process.env.PAGE_ID;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

/* ================= CONFIG ================= */
const POSTED_FILE = path.join(__dirname, 'notice', 'posted.json');
const MAX_POSTED = 12;

const IOE_URL = 'https://iost.tu.edu.np/notices';
const TU_URL  = 'https://ioe.tu.edu.np/notices';

const allowedPrograms = ['csit','bit','bba','engineering','bca'];

const importantKeywords = [
  'सूचना','जरुरी','अत्यन्त','परिक्षा','नतिजा','फर्म','सूची',
  'notice','result','exam','routine','model','course','published','request','entrance'
];

const notAllowedProgram = [
  'degree','phd','msc','m.sc','scholarship','cas',
  'स्नातकोत्तर','विद्यावारिधि','प्रमुख छनौट','बोलपत्र'
];
/* ========================================= */

fs.mkdirSync(path.dirname(POSTED_FILE), { recursive: true });

let posted = [];
if (fs.existsSync(POSTED_FILE)) {
  try {
    posted = JSON.parse(fs.readFileSync(POSTED_FILE, 'utf8'));
    if (!Array.isArray(posted)) posted = [];
  } catch {
    posted = [];
  }
}
posted = posted.slice(-MAX_POSTED);

/* ================= FACEBOOK ================= */
async function postToFBSinglePost(message, imagePaths) {
  const mediaIds = [];

  for (const img of imagePaths) {
    let uploaded = false;

    for (let attempt = 1; attempt <= 3 && !uploaded; attempt++) {
      const form = new FormData();
      form.append('source', fs.createReadStream(img));
      form.append('published', 'false');
      form.append('access_token', PAGE_ACCESS_TOKEN);

      try {
        const res = await fetch(
          `https://graph.facebook.com/v19.0/${PAGE_ID}/photos`,
          { method: 'POST', body: form }
        );

        const text = await res.text();

        if (!text) {
          console.warn(`⚠️ Empty FB response (${attempt}) for ${img}`);
          await delay(2000);
          continue;
        }

        const data = JSON.parse(text);

        if (data.id) {
          mediaIds.push({ media_fbid: data.id });
          uploaded = true;
          console.log('✅ Uploaded:', path.basename(img));
        } else {
          console.error('❌ FB upload error:', data);
          await delay(2000);
        }

      } catch (err) {
        console.error('❌ Upload failed:', err.message);
        await delay(2000);
      }
    }

    // Delay between image uploads
    await delay(2500);
  }

  if (!mediaIds.length) {
    console.warn('⚠️ No images uploaded, skipping post');
    return;
  }

  const postForm = new FormData();
  postForm.append('message', message);
  postForm.append('attached_media', JSON.stringify(mediaIds));
  postForm.append('access_token', PAGE_ACCESS_TOKEN);

  try {
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${PAGE_ID}/feed`,
      { method: 'POST', body: postForm }
    );

    const text = await res.text();
    if (!text) {
      console.warn('⚠️ Empty response when creating post');
      return;
    }

    console.log('📸 FB POST:', JSON.parse(text));
  } catch (err) {
    console.error('❌ Post creation failed:', err.message);
  }
}

/* ================= SCRAPER ================= */
async function scrapeNotices(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 0 });
  await delay(2000);

  return page.evaluate(() =>
    Array.from(document.querySelectorAll('div.recent-post-wrapper, li.recent-post-wrapper'))
      .map(el => {
        const a = el.querySelector('a');
        return {
          title: a?.innerText.trim() || '',
          link: a?.href || ''
        };
      })
      .filter(n => n.title && n.link)
  );
}

/* ================= PDF LINK ================= */
async function getDeepPdfLink(page, noticeUrl) {
  await page.goto(noticeUrl, { waitUntil: 'networkidle2', timeout: 0 });
  await delay(2000);

  return page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('a'))
      .find(x => x.href && x.href.toLowerCase().endsWith('.pdf'));
    return a ? a.href : null;
  });
}

/* ================= PDF → IMAGES ================= */
async function pdfToImages(pdfUrl, noticeId) {
  const res = await fetch(pdfUrl);
  const buffer = await res.arrayBuffer();

  const pdfPath = `/tmp/${noticeId}.pdf`;
  fs.writeFileSync(pdfPath, Buffer.from(buffer));

  const pdfDoc = await PDFDocument.load(buffer);
  const pages = pdfDoc.getPageCount();

  const images = [];

  for (let i = 1; i <= pages; i++) {
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
    images.push(`/tmp/${name}.png`);
    await delay(500);
  }

  fs.unlinkSync(pdfPath);
  return images.slice(0, 10); // FB limit
}

/* ================= SCREENSHOT ================= */
async function screenshotNotice(page, url, noticeId) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 0 });
  await delay(2000);

  const img = `/tmp/${noticeId}-screenshot.png`;
  await page.screenshot({ path: img, fullPage: true });
  return img;
}

/* ================= FILTER ================= */
function shouldPost(title) {
  const t = title.toLowerCase();
  if (notAllowedProgram.some(x => t.includes(x))) return false;
  return (
    importantKeywords.some(k => t.includes(k)) ||
    allowedPrograms.some(p => t.includes(p))
  );
}

/* ================= UTILS ================= */
const delay = ms => new Promise(r => setTimeout(r, ms));

/* ================= MAIN ================= */
(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

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
      let images = pdf
        ? await pdfToImages(pdf, id)
        : [await screenshotNotice(page, notice.link, id)];

      await postToFBSinglePost(`${notice.title}\n${notice.link}`, images);

      images.forEach(img => fs.existsSync(img) && fs.unlinkSync(img));

      posted.push(id);
      posted = posted.slice(-MAX_POSTED);
      fs.writeFileSync(POSTED_FILE, JSON.stringify(posted, null, 2));

      console.log('⏳ Waiting 1 minute...');
      await delay(60_000);
    }
  }

  await browser.close();
  console.log('✅ DONE');
})();
