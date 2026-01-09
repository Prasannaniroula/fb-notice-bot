// automation.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch'); // v2
const FormData = require('form-data');
const puppeteer = require('puppeteer');
const { fromPath } = require('pdf2pic');

const PAGE_ID = process.env.PAGE_ID;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

// ================= CONFIG =================
const POSTED_FILE = path.join(__dirname, 'notice', 'posted.json');
const MAX_POSTED = 12;

const IOE_URL = 'https://iost.tu.edu.np/notices';
const TU_URL = 'https://ioe.tu.edu.np/notices';

const allowedPrograms = ['csit', 'bit', 'bba', 'engineering', 'bca'];

const importantKeywords = [
  'सूचना','जरुरी','अत्यन्त','परिक्षा','नतिजा','फर्म','सूची',
  'notice','result','exam','routine','model','course','published','request','entrance'
];

const notAllowedProgram = [
  'degree','master','phd','msc','m.sc','cas','scholarship',
  'स्नातकोत्तर','विद्यावारिधि','प्रमुख छनौट','बोलपत्र'
];
// =========================================

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
async function postToFB(message, imagePath) {
  const form = new FormData();
  form.append('source', fs.createReadStream(imagePath));
  form.append('caption', message);
  form.append('access_token', PAGE_ACCESS_TOKEN);

  const res = await fetch(`https://graph.facebook.com/${PAGE_ID}/photos`, {
    method: 'POST',
    body: form
  });

  console.log('📸 FB:', await res.json());
}

// ================= SCRAPER =================
async function scrapeNotices(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 0 });
  await page.waitForTimeout(2000);

  return await page.evaluate(() => {
    return Array.from(
      document.querySelectorAll('div.recent-post-wrapper, li.recent-post-wrapper')
    ).map(el => {
      const linkEl = el.querySelector('div.detail a, a');
      const titleEl = linkEl?.querySelector('h5') || linkEl;
      const dateEl = el.querySelector('div.date span.nep_date');

      return {
        title: titleEl?.innerText.trim() || '',
        link: linkEl?.href || '',
        date: dateEl?.innerText.trim() || ''
      };
    }).filter(n => n.title && n.link);
  });
}

// ================= DEEP PDF DETECTOR =================
async function getDeepPdfLink(page, noticeUrl) {
  await page.goto(noticeUrl, { waitUntil: 'networkidle2', timeout: 0 });
  await page.waitForTimeout(2000);

  return await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    const pdf = links.find(a => a.href && a.href.toLowerCase().includes('.pdf'));
    return pdf ? pdf.href : null;
  });
}

// ================= PDF → IMAGE =================
async function pdfToImage(pdfUrl, noticeId) {
  const res = await fetch(pdfUrl);
  const buffer = await res.arrayBuffer();

  const pdfPath = path.join('/tmp', `${noticeId}.pdf`);
  fs.writeFileSync(pdfPath, Buffer.from(buffer));

  const converter = fromPath(pdfPath, {
    density: 150,
    savePath: '/tmp',
    format: 'png',
    width: 1200,
    height: 1600
  });

  const output = await converter(1); // FIRST PAGE ONLY
  fs.unlinkSync(pdfPath);
  return output.path;
}

// ================= SCREENSHOT NOTICE =================
async function screenshotNotice(page, noticeUrl, noticeId) {
  await page.goto(noticeUrl, { waitUntil: 'networkidle2', timeout: 0 });
  await page.waitForTimeout(2000);

  // FORCE NEPALI FONT RENDERING
  await page.addStyleTag({
    content: `
      * {
        font-family: 'Noto Sans Devanagari', 'Kalimati', 'Mangal', sans-serif !important;
      }
    `
  });

  const imagePath = path.join('/tmp', `${noticeId}.png`);

  const selectors = [
    'div.single-post',
    'div.post-content',
    'article',
    'div.col-md-8',
    'div.col-lg-8'
  ];

  for (const selector of selectors) {
    const el = await page.$(selector);
    if (el) {
      await el.evaluate(e => e.scrollIntoView());
      await page.waitForTimeout(500);
      await el.screenshot({ path: imagePath });
      return imagePath;
    }
  }

  await page.screenshot({ path: imagePath, fullPage: true });
  return imagePath;
}

// ================= FILTER =================
function shouldPost(title) {
  const t = title.toLowerCase();

  if (notAllowedProgram.some(q => t.includes(q))) return false;

  return (
    importantKeywords.some(k => t.includes(k)) ||
    allowedPrograms.some(p => t.includes(p))
  );
}

// ================= MAIN =================
(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  page.setViewport({ width: 1280, height: 2200 });

  const urls = [IOE_URL, TU_URL];

  for (const url of urls) {
    console.log('🔍 Scraping:', url);
    const notices = await scrapeNotices(page, url);

    for (const notice of notices) {
      const noticeId = crypto
        .createHash('sha256')
        .update(notice.title + notice.link)
        .digest('hex');

      if (posted.includes(noticeId)) {
        console.log('🔁 Skipped:', notice.title);
        continue;
      }

      if (!shouldPost(notice.title)) {
        console.log('🚫 Filtered:', notice.title);
        continue;
      }

      console.log('🆕 Posting:', notice.title);

      let img;
      const deepPdf = await getDeepPdfLink(page, notice.link);

      if (deepPdf) {
        console.log('📄 PDF found:', deepPdf);
        img = await pdfToImage(deepPdf, noticeId);
      } else {
        img = await screenshotNotice(page, notice.link, noticeId);
      }

      await postToFB(`${notice.title}\n${notice.link}`, img);
      fs.unlinkSync(img);

      posted.push(noticeId);
      posted = posted.slice(-MAX_POSTED);
      fs.writeFileSync(POSTED_FILE, JSON.stringify(posted, null, 2));
    }
  }

  await browser.close();
  console.log('✅ Done | Stored last 12 notices');
})();
