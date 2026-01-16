// automation.js
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // v2
const FormData = require('form-data');
const puppeteer = require('puppeteer');
const { PDFDocument } = require('pdf-lib');
const { fromPath } = require('pdf2pic');

const PAGE_ID = process.env.PAGE_ID;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

// Temporary file to store posted notice IDs
const postedFile = path.join(__dirname, 'notice', 'posted.json');
let postedNotices = {};
if (fs.existsSync(postedFile)) postedNotices = JSON.parse(fs.readFileSync(postedFile));

// Helper: Save posted notice IDs
function savePosted() {
  fs.writeFileSync(postedFile, JSON.stringify(postedNotices, null, 2));
}

// Convert PDF to images (1 per page)
async function pdfToImages(pdfBuffer, noticeId) {
  const tmpDir = path.join('/tmp', noticeId);
  fs.mkdirSync(tmpDir, { recursive: true });
  const tempPdfPath = path.join(tmpDir, 'temp.pdf');
  fs.writeFileSync(tempPdfPath, pdfBuffer);

  const convert = fromPath(tempPdfPath, {
    density: 150,
    saveFilename: noticeId,
    savePath: tmpDir,
    format: 'png',
    width: 1200
  });

  const pages = await convert(1); // first page only
  return pages.map(p => p.path ? [p.path] : []);
}

// Post images to Facebook
async function postToFacebook(message, images) {
  if (!images || images.length === 0) return;
  for (const imgPath of images) {
    const form = new FormData();
    form.append('source', fs.createReadStream(imgPath));
    form.append('caption', message);
    form.append('access_token', PAGE_ACCESS_TOKEN);

    await fetch(`https://graph.facebook.com/v17.0/${PAGE_ID}/photos`, {
      method: 'POST',
      body: form
    });
  }
}

// Fetch PDF via node-fetch
async function fetchPDF(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch PDF');
  return Buffer.from(await res.arrayBuffer());
}

// Scrape IOST notices
async function scrapeIOST(page) {
  await page.goto('https://iost.tu.edu.np/notices', { waitUntil: 'networkidle2', timeout: 60000 });
  const notices = await page.$$eval('.views-row', rows => {
    return rows.map(row => {
      const title = row.querySelector('.views-field-title a')?.textContent.trim();
      const link = row.querySelector('.views-field-title a')?.getAttribute('href');
      const onclick = row.querySelector('a.button.download')?.getAttribute('onclick');
      const img = row.querySelector('img')?.getAttribute('src');
      return { title, link, onclick, img };
    });
  });

  for (const notice of notices) {
    const id = notice.link || notice.title;
    if (postedNotices[id]) continue;

    let images = [];

    try {
      if (notice.onclick) {
        // Extract PDF URL from onclick, e.g., openPDF('downloads/123.pdf')
        const match = notice.onclick.match(/['"](.+\.pdf)['"]/);
        if (match) {
          const pdfUrl = `https://iost.tu.edu.np/${match[1]}`;
          const pdfBuffer = await fetchPDF(pdfUrl);
          images = (await pdfToImages(pdfBuffer, id)).flat();
        }
      } else if (notice.img) {
        images = [`https://iost.tu.edu.np${notice.img}`];
      }

      if (images.length > 0) {
        await postToFacebook(notice.title, images);
        postedNotices[id] = true;
        savePosted();
        console.log(`✅ Posted: ${notice.title}`);
      } else {
        console.log(`❌ No media found for notice: ${id}`);
      }

    } catch (err) {
      console.log(`❌ Failed to process notice: ${notice.title}`, err.message);
    }
  }
}

// Scrape IOE notices
async function scrapeIOE(page) {
  await page.goto('https://ioe.tu.edu.np/notices', { waitUntil: 'networkidle2', timeout: 60000 });
  const notices = await page.$$eval('.views-row', rows => {
    return rows.map(row => {
      const title = row.querySelector('.views-field-title a')?.textContent.trim();
      const link = row.querySelector('.views-field-title a')?.href;
      const img = row.querySelector('img')?.src;
      return { title, link, img };
    });
  });

  for (const notice of notices) {
    const id = notice.link || notice.title;
    if (postedNotices[id]) continue;

    let images = [];

    try {
      if (notice.link && notice.link.endsWith('.pdf')) {
        const pdfBuffer = await fetchPDF(notice.link);
        images = (await pdfToImages(pdfBuffer, id)).flat();
      } else if (notice.img) {
        images = [notice.img];
      }

      if (images.length > 0) {
        await postToFacebook(notice.title, images);
        postedNotices[id] = true;
        savePosted();
        console.log(`✅ Posted: ${notice.title}`);
      } else {
        console.log(`❌ No media found for notice: ${id}`);
      }
    } catch (err) {
      console.log(`❌ Failed to process notice: ${notice.title}`, err.message);
    }
  }
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();

  console.log('🔍 Scraping: https://iost.tu.edu.np/notices');
  await scrapeIOST(page);

  console.log('🔍 Scraping: https://ioe.tu.edu.np/notices');
  await scrapeIOE(page);

  await browser.close();
  console.log('✅ All done');
})();
